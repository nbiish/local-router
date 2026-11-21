# TASK.2026-11-20-22 — Claude/Codex wire: make streams complete, honest, crash-free

- **status:** done
- **plan:** `.agents/plans/2026-11-20-22-anthropic-codex-wire.plan.md`
- **branch:** `fix/agent-wire` → merged into `main` as `63886cd`
- **worktree:** `/Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-agent-wire` (removed)
- **trigger:** operator reported `API Error: The response stream was malformed. The response above may
  be incomplete.` from Claude Code with local-router in all five model slots, opus at ultracode/xhigh
  thinking.

## What was wrong

Six independent defects, each reproduced live before being changed:

1. **Absolute 15 s stream deadline.** `AbortSignal.timeout(stream ? 15000 : 30000)` bounds the whole
   response, not time-to-first-byte. A 2500-word opus request delivered 14 771 bytes over 180 s and
   then stalled with no `message_stop`. A 20 s fake SSE upstream was aborted at 15 006 ms after 14
   frames. This is the operator's symptom.
2. **Upstream death was invisible to the client.** The pipe chain attached error *loggers* and no
   teardown, so a reset upstream left the response open with no `end` and no `error`. Reproduced: a
   client hung >12 s on a destroyed upstream socket.
3. **Teardown crashed the router.** Destroying the response with an error and no listener emitted an
   unhandled `'error'`, killing the process after the client had been served.
4. **`peekStreamForErrorFrame` returned a locked body.** It took `getReader()` on the original
   response and, on a read failure, returned that same response. `Readable.fromWeb()` then threw
   `ERR_INVALID_STATE: Invalid state: ReadableStream is locked`, surfaced to the client as a 500. This
   is the `[error-handler]` line that had been appearing in the production log.
5. **Streamed usage was always 0/0.** Finalisation fired on `finish_reason`; the usage chunk arrives
   *after* it, so `outputTokens` was still 0 when `message_delta` was written.
6. **Invalid block sequence with parallel tools.** One `toolBlockStarted` boolean tracked N blocks:
   thinking + two tools closed index 1 twice and never closed index 2.

Additionally, an Anthropic conversation was forwarded to chat-completions upstreams with
`thinking`/`tool_result`/`tool_calls` content parts that no such upstream accepts, and the failover
marker was appended as a trailing `user` turn — so the model answered the routing note instead of the
question ("That block is just a failover event from a local router … I can't treat it as a directive").

## What changed

`src/index.ts`:
- `STREAM_FIRST_BYTE_TIMEOUT_MS` (30 s, env `LOCAL_ROUTER_STREAM_FIRST_BYTE_MS`) replaces the absolute
  streaming deadline; `NON_STREAM_TIMEOUT_MS` is 120 s; `STREAM_IDLE_TIMEOUT_MS` (120 s, env
  `LOCAL_ROUTER_STREAM_IDLE_MS`) is an idle watchdog refreshed by every chunk.
- `sendSuccessfulProxyResponse` tears the destination down on upstream error/reset/idle and records
  `upstream_stream_error` / `upstream_stream_reset` / `upstream_stream_idle`, with an error listener so
  the process survives.
- `peekStreamForErrorFrame` rebuilds a new `Response` over a replaying stream on **every** path.
- `anthropicMessagesToChat` (exported) translates thinking (dropped), `tool_use` →
  `assistant.tool_calls[]`, `tool_result` → its own `role:'tool'` message.
- The `/v1/messages` stream tracks open blocks in a `Set<number>` keyed by Anthropic index, opens and
  closes each exactly once, defers finalisation so real usage is emitted, and emits a complete closing
  sequence from the fake response's `destroy`.
- `buildFailoverPreservedBody` puts the marker in the leading system turn and adds no turn.
- Boot warns when `LOCAL_ROUTER_TRAJECTORY_DIR` / `LOCAL_ROUTER_HEALTH_STATE` point at a temp dir.

Tests: `tests/agent-wire.test.mjs` (9 unit) and `tests/anthropic-stream.integration.test.mjs` (4
integration, boots the real router against a controllable fake upstream).
`tests/fallback-content-classifier.test.mjs` updated: its two `buildFailoverPreservedBody` tests
asserted the marker-as-trailing-user-turn behaviour that caused the hijack.

## Verification

Live, against the rebuilt production router on `:11434`:

- `POST /v1/messages`, opus slot, `thinking:{budget_tokens:4000}`, streaming: **valid sequence**
  (1 `message_start`, 2 opens / 2 closes, 1 `message_delta` with `stop_reason: end_turn`, 1
  `message_stop`), 414 words, **usage `input_tokens: 101 / output_tokens: 952`** (was 0/0), 7.7 s.
- A 24 s stream completed validly on the worktree build — past the old 15 s wall.
- Multi-turn tool conversation: outbound body has **no** raw `thinking` or `tool_result` part, has a
  `role:'tool'` message and an `assistant.tool_calls[]` array; the model answered the actual question.
- Thinking + two parallel tools: 4 opens / 4 closes, each index exactly once.
- Codex: streaming text `response.completed`; tool replay answered `2` for two files with
  `input_tokens: 187 / output_tokens: 5`; non-stream returned `input_tokens: 76 / output_tokens: 37`.
- Trajectories are back on the durable path: `~/.config/local-router/trajectories/trajectories.jsonl`
  received the production record.

Test suite: **434 / 450 pass**, 12 skipped, 4 fail — 2 of those were my intentional behaviour change
(updated) and the remaining 2 (`detectLocalCursorSession auto-detects host installation`, `wafer
live probe`) **also fail on `main` before this branch**, verified directly.

## Deliberately not done

- **No Claude model is ever reached.** All 19 chain targets are non-Claude; `github-copilot-auto` and
  `cursor-auto` are excluded as `context_window_too_small` at 150k–159k required context, and
  `openrouter-ling-3.2-flash-free` 429s and quarantines. The router now reports this honestly, but
  making a real Claude answer is a chain-capability decision for the operator.
- **`/v1/messages/count_tokens` returns 404.** Claude Code calls it on some paths. Recorded as a
  suggestion; implementing it needs a tokenizer choice, not a guess.
- **The daemon was restarted by the operator's choice** with the stale
  `LOCAL_ROUTER_TRAJECTORY_DIR=/tmp/lr-verify/traj` / `LOCAL_ROUTER_HEALTH_STATE=/tmp/lr-verify/quarantine.json`
  removed. Those values were never in the repo; they came from whatever launched the old process.

## First failure to expect if this is wrong

A provider that sends its usage **only** in the first chunk (before any content) would make
`message_delta.usage.output_tokens` read 0 again, because finalisation is deferred and the last usage
chunk wins. The trajectory's `result.usage` would still be correct, so the discrepancy would show as a
client-side zero beside a healthy server-side count.

## Threat model

Asset: the operator's live gateway and its request log. Adversary: a misbehaving or hostile upstream
that dies, stalls, or streams garbage. Worst realistic outcome of this change: the idle watchdog ends a
response that upstream would eventually have completed. Mitigated by defaulting the idle window to 120 s
and refreshing it on every chunk, so only genuine silence trips it; it is operator-tunable via
`LOCAL_ROUTER_STREAM_IDLE_MS`. No secret material touched; no remote or credential surface changed.
