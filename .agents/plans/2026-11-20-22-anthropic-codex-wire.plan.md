---
plan_format: ainish/plan/v1
slug: anthropic-codex-wire
date: 2026-11-20
status: done
branch: fix/agent-wire
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-agent-wire
task_record: .agents/tasks/TASK.2026-11-20-22-anthropic-codex-wire.md
operator: question-me
---

# Plan: Make the Claude and Codex wire surfaces actually complete

## 1. Problem

Using Claude Code with local-router in all five model slots (opus 1M among them) at
`--effort=xhigh` returns:

```
API Error: The response stream was malformed. The response above may be incomplete.
```

The same class of failure is reachable from Codex. The operator asked for an extensive
verification of both surfaces, not a one-line patch, because repeated single-symptom fixes
have not held.

## 2. Anchor Facts

Each fact below was established live on 2026-11-20 against the running router
(pid 95218, `build/index.js`, port 11434), not read from a doc.

- **The router aborts every streaming upstream at 15 s absolute.** `src/index.ts:7868` uses
  `signal: AbortSignal.timeout(stream ? 15000 : 30000)`. `AbortSignal.timeout` is a whole-response
  deadline, not a time-to-first-byte deadline, so it kills the body mid-generation. — proved with
  `tests`-style repro: a 20 s SSE upstream aborted at **15006 ms after receiving 14 frames**, with no
  `[DONE]`.
- **An aborted or reset upstream leaves the client hanging forever.** `sendSuccessfulProxyResponse`
  (`src/index.ts:8046-8097`) pipes `Readable.fromWeb(body) → errorObserver → strip → res` with error
  *loggers* but no destroy/end propagation. — proved with a repro that destroys the upstream socket
  mid-body: the downstream client was **still hanging after 12 s**, with no `end` and no `error`.
- **The production symptom reproduces end-to-end.** A real `POST /v1/messages` (`opus`, streaming,
  `budget_tokens: 15000`, "write a 2500-word essay") stalled: curl received **14 771 bytes in 180 s,
  no `message_stop`**, and the router logged `[proxy] nodeStream error: The operation was aborted due
  to timeout`. A truncated stream that never ends is exactly what Claude Code reports as "the response
  stream was malformed".
- **Streamed usage is always zero.** Every non-stalled live request emitted
  `message_delta.usage.output_tokens: 0` and `message_start.message.usage.input_tokens: 0`. — observed
  on all `/tmp/lr-repro` captures. `outputTokens` is only assigned from a chunk carrying
  `data.usage.completion_tokens`, which with `stream_options.include_usage` arrives *after*
  `finish_reason` has already fired `finishMessage`.
- **Multiple tool calls produce an invalid block sequence.** With thinking + two parallel tools the
  stream emitted `content_block_stop index 1`, then `content_block_start index 2`, then
  `content_block_stop index 0`, then `content_block_stop index 1` again — **block 2 was never closed
  and block 1 was closed twice**. — live capture. `closeOpenBlocks` knows one `textIndex` and one
  `toolBlockStarted` boolean, so it cannot track N open tool blocks.
- **Anthropic-only content parts are forwarded verbatim to chat-completions upstreams.** The spilled
  outbound body for a multi-turn request contained `{"type":"thinking","thinking":…,"signature":…}`,
  `{"type":"tool_result","tool_use_id":…}` inside a `user` message, and a `{"type":"tool_calls"}`
  *content part* instead of an `assistant.tool_calls[]` array. — read from the `outbound` spill.
  None of these three is legal chat-completions.
- **The failover marker hijacks the conversation.** A multi-turn request whose last user turn was
  "Now summarize it." was answered with "That block is just a failover event from a local router…
  I can't treat it as a directive." — live capture. `buildFailoverPreservedBody` appends the marker as
  a `user` message on the stage that answers.
- **No Claude model is ever reached.** All 19 configured targets are non-Claude; the two Claude-capable
  OAuth slots (`github-copilot-auto`, `cursor-auto`) are excluded as `context_window_too_small` at
  150k-159k required context, and `openrouter-ling-3.2-flash-free` 429s and is quarantined. — from
  the production trajectory records.
- **The live router logs to a scratch directory.** pid 95218 carries
  `LOCAL_ROUTER_TRAJECTORY_DIR=/tmp/lr-verify/traj` and
  `LOCAL_ROUTER_HEALTH_STATE=/tmp/lr-verify/quarantine.json`, so `/api/trajectories` and the
  trajectories page report a log that is not the operator's durable one. — from `ps eww 95218`.
- `POST /v1/messages/count_tokens` returns **404**; Claude Code calls it on some paths. — `curl`.
- The Codex `/v1/responses` shim works for single-turn text and for a replayed
  `function_call`/`function_call_output` pair; non-streaming returns correct
  `input_tokens`/`output_tokens`/`reasoning_tokens`. Its defects are the shared ones (D1/D2/D3,
  marker injection), not a separate translation bug. — live captures.

## 3. Plan

### Goals

- A streaming Claude turn that takes minutes completes with a well-formed frame sequence.
- A stream that upstream kills is **terminated** for the client, and recorded as a failure, never left
  hanging.
- `input_tokens` / `output_tokens` are real on the streamed Anthropic wire.
- Thinking + N parallel tool calls emit a valid, ordered, exactly-once block sequence.
- Anthropic `thinking` / `tool_use` / `tool_result` are translated into legal chat-completions
  messages, or dropped, never forwarded raw.
- Codex keeps working for text and tool replay, with the same fixes applied on the shared path.
- The live router writes trajectories to the durable config directory.

### Non-goals

- Adding a Claude subscription provider or changing the fallback chain order. The chain is the
  operator's; this plan only makes the observation honest.
- Emitting Anthropic-native `thinking` back to a client from a thinking-less upstream. Out of scope;
  a downgrade is already recorded in the trajectory.
- Implementing `/v1/messages/count_tokens` beyond a shape-valid approximation. Recorded as a
  suggestion instead.

### Constraints and invariants

- `AbortSignal.timeout` must not be the streaming body's lifetime. Use a first-byte / idle deadline.
- Fail closed: a mid-stream death must end the client's response, and must set a failure on the log.
- One `message_delta` and one `message_stop` per stream; one `content_block_start` and one matching
  `content_block_stop` per index.
- No raw Anthropic content part may reach a chat-completions upstream.
- Never co-author a commit. Work in the worktree; merge to `main` only after verification.

### Proposed architecture

```
                    ┌─ first-byte deadline (connect + first frame) ─┐
client ──► route ───┤                                               ├──► upstream
                    └─ NO absolute body deadline; idle watchdog ────┘
                                      │
                          on abort/reset/destroy
                                      ▼
                     finishMessage(stop_reason)  ──►  res.end()
                     logTracker.onFailure('mid_stream_timeout'|'upstream_stream_reset')
```

Translation becomes a single explicit function so both the streaming and non-streaming paths share
one definition of a legal chat-completions message list.

### Interfaces and data

- `src/index.ts` — `attemptModel` fetch init: replace `AbortSignal.timeout(stream ? 15000 : 30000)`
  with a controller whose timer is cleared once headers arrive (first-byte deadline), plus an idle
  watchdog that only fires when no bytes have moved.
- `src/index.ts` — `sendSuccessfulProxyResponse`: teardown handler on `nodeStream`/pipeline error
  that writes the closing Anthropic frames (or destroys the response for the OpenAI/Ollama wires) and
  calls `logTracker.onFailure`.
- `src/index.ts` — the `/v1/messages` translate block: extract to `anthropicMessagesToChat(...)`,
  producing `role: 'tool'` messages for `tool_result`, `assistant.tool_calls[]` for `tool_use`, and
  no `thinking` parts.
- `src/index.ts` — `/v1/messages` stream state: replace the single `toolBlockStarted` boolean with a
  `Map<number, 'thinking'|'text'|'tool_use'>` of open blocks; close every open index on finish.
- `src/index.ts` — `buildFailoverPreservedBody`: only annotate when the client's own last turn is not
  in progress, and never as a separate `user` turn the model will answer. Prefer a trailing text part
  on the preserved last message, or a system-prefix; never a new user message.
- `src/config-paths.ts` / launcher: do not let a verification run's env leak into the daemon.

## 4. Verification

- Unit/integration tests added under `tests/`: block-sequence validity, usage propagation,
  tool translation, marker non-hijack, mid-stream teardown.
- Live: the 2500-word essay request must reach `message_stop`, and the trajectory must show one
  answered stage with non-zero usage.
- Live: thinking + two tools must emit 4 `content_block_start` / 4 matching `content_block_stop`
  with no duplicates.
- Codex: `/v1/responses` text and tool replay still pass.

## 5. Todos

- [x] T1  Replace the absolute stream timeout with a first-byte deadline + idle watchdog.
- [x] T2  Propagate upstream stream death to the client and to the log.
- [x] T3  Emit real usage on the Anthropic stream.
- [x] T4  Track open content blocks by index; close each exactly once.
- [x] T5  Translate Anthropic thinking/tool_use/tool_result into legal chat messages.
- [x] T6  Stop the failover marker from becoming an answerable user turn.
- [x] T7  Keep the daemon on the durable trajectory directory.
- [x] T8  Tests + live verification, then merge and journal.

## 6. Threats

The worst realistic outcome of T2 is ending a response that upstream would have completed; the idle
watchdog must be generous (and configurable) so it only fires on genuine silence. The worst outcome of
T5 is dropping a field a lenient upstream wanted; the translation must preserve every non-Anthropic
part verbatim.

## 7. History

- 2026-11-20T22:00Z — plan written from a live audit; twelve facts established by reproduction.
