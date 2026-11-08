---
task: reasoning-cache-policy
branch: feat/reasoning-cache-policy
worktree: D:\Code\lr-reasoning-policy
started: 2026-11-08T16:45:00Z
status: done
parent: none
scope: src/provider-policy.ts (new), src/reasoning.ts, src/index.ts, src/responses-stream.ts, src/routes/config-api.ts, src/ui/pages/{thinking,layout}.ts, tests/*, docs/caching/*, package.json
---

# Provider reasoning + cache policy

## Objective

Verify — with a gate that fails if it stops being true — that every
`{provider}-{model}` pairing the router can serve receives the reasoning level the
caller asked for, on every inbound wire, and that each upstream is sent the
maximum prompt-caching configuration its own contract allows.

## What was actually broken (measured 2026-11-08 before the change)

Not theory: each of these was read out of the running code and, where possible,
out of a live router on `:11434`.

| Defect | Evidence |
|---|---|
| `/v1/messages` dropped thinking entirely | `chatBody` was built from `model/max_tokens/temperature/top_p/stream/stop` only. A Claude client's `thinking:{type:'enabled',budget_tokens}` never left the router. |
| `/v1/responses` dropped `reasoning` | `translateResponsesRequestToChatBody` never read `body.reasoning`, so every Codex session ran on the provider's own default. |
| Dialect translator was dead code | `getThinkingRequestParams` / `shouldDisableNativeThinking` had zero call sites; the `enable_thinking` vs `reasoning_effort` split was never applied. |
| Advertisement was one hardcoded list | 40 models advertised `capabilities.reasoning:true`, 30 advertised a dial. 10 `cursor-*` rows advertised reasoning with **no** dial. `ollama-*-cloud`, `antigravity-*`, `kilo-*`, `nous-portal-*`, `pioneer-*`, `zai-*` reasoning models read as having no adjustable reasoning. |
| `xhigh` accepted but unreachable | The API and UI accepted it; no provider ever received it. |
| Cache breakpoints injected blind | `cache_control` stamped on tools + system + N−1 with no count of markers the client already sent. Claude Code ships 4; Anthropic caps at 4 → a 400, not a cache hit. |
| `prompt_cache_retention:'24h'` sent by name-prefix | Any model id starting with `gpt-` got it, including models that never accepted the field. |
| `capabilities.caching` was `true` for 4 of 146 live models | Read a per-model registry boolean that was false almost everywhere, while the upstreams were caching anyway. |
| Streamed usage invisible | No `stream_options.include_usage` was ever sent, so streamed responses often carried no `usage` at all; `cachedTokens` stayed 0 and `src/expert-logs.ts` then reported `cold_start_or_eviction` for a warm cache. |
| Hardcoded `0` counters on the Responses stream | Both `cached_tokens` and `reasoning_tokens` were literals in `src/responses-stream.ts`. |
| Anthropic wire overstated the bill | `input_tokens` reported the whole prompt and no cache counters, so a cache hit was indistinguishable from a full-price request. |
| Ollama wire dropped its own usage fields | No `prompt_eval_count` / `eval_count`, so an Ollama-native harness saw every completion as free. |
| Operator thinking toggle was inert | `PUT /api/thinking-level` persisted a level nothing read; turning it on changed no request. |

## What was built

1. **`src/provider-policy.ts`** — one declarative table, 22 provider rows plus the
   3 loopback rows, each naming the doc it was transcribed from. Two resolvers
   (`resolveReasoningPolicy`, `resolveCachingPolicy`) layer model-family overrides
   on the provider row, so `moonshotai/*` on a gateway gets the boolean dialect
   while `anthropic/*` on the same gateway gets an effort dial.
2. **`src/reasoning.ts`** — the dead regex helpers are gone; `sanitizeProviderRequestBody`
   now delegates to the policy. The additive contract is explicit: nothing is
   invented, a correct value is left byte-identical, and a value this upstream
   cannot express (`xhigh`, or a level outside its set) is translated rather than
   forwarded into a 400.
3. **All four wires** feed the translator: OpenAI, Anthropic (`thinking` budget →
   level), Responses (`reasoning.effort` → level), Ollama (`think` → the dialect
   of the endpoint the proxy actually posts to).
4. **`injectPromptCaching`** is policy-driven: budgeted breakpoints (a client that
   already used the cap is not pushed over it), per-provider TTL, retention only
   where documented, sticky key in the field each upstream reads, markers stripped
   where they are rejected, and `stream_options.include_usage` so cache hits are
   observable at all.
5. **Advertisement** comes from the same table: `reasoningEfforts`, `effort.supported_levels`,
   `defaultReasoningLevel`, `capabilities.caching`, and `/api/show`'s
   `capabilities` + `reasoning_efforts`. Both wires now report the same list.

## Verification

Three layers, all in `npm test`:

| Suite | What it proves |
|---|---|
| `tests/provider-policy-matrix.test.mjs` (20 tests) | Enumerates every curated-registry pairing (1432 rows), crosses it with every advertised level × 4 wires, and asserts the level reaches the dialect field the upstream reads. Plus: no invented level, opt-out always wins, breakpoint cap respected, markers stripped where rejected, retention only where documented, sticky key present, usage chunk requested. |
| `tests/provider-wire-delivery.integration.test.mjs` (11 tests) | Boots the real server against a fake upstream and inspects what actually leaves for each of the 4 wires — the guard against a handler bypassing the translator, which is exactly how the two dropped fields survived. Also asserts both advertisement wires agree and the operator toggle moves a real request. |
| `tests/provider-policy-docs.test.mjs` (5 tests) | Registered provider → policy row → doc that cites it. A provider added without research now fails CI. |

`prompt-caching.test.mjs` (19) and the three live probe suites were pulled into the
gate. The live suites are now **opt-in** (`LOCAL_ROUTER_TEST_URL`): on this host the
default port serves an older deployed router, and a gate that silently tests a stale
deploy is worse than no gate.

Gate result: **313 tests, 299 pass, 12 skipped (live probes), 2 fail.** Both failures
are pre-existing and reproduce identically on `main` before this branch:
`detectLocalCursorSession` (no Cursor install on this host) and
`custom provider CRUD` (`ok:test-vendor-demo` vs `ok:vendor-model-1`). Nothing in
this change touches either path.

`npm run validate:model-specs` is unchanged at its documented baseline (101
pre-existing errors, 1151 unmatched) — this change adds no new drift.

## Blocker / not done

- **`/v1/messages` still posts to `/chat/completions`.** The `anthropic-thinking`
  dialect exists in the table and has budgets, but no configured provider is reached
  on its native `/messages` surface, so no row uses it. Emitting `thinking:{...}` at
  a chat endpoint is what upstreams 400 on. Reaching an Anthropic-native endpoint is
  a transport change, not a policy one, and is out of scope here.
- **No live billed probes.** Offline contract verification was the chosen gate.
  `npm run verify:dials` / `verify:wires` remain available for a billed live check
  against a chosen URL.
- `main` carries unrelated pre-existing operator edits (`src/index.ts`,
  `src/responses-stream.ts`, `bin/lib/*-runner.js`, `AGENTS.md`, `.agents/skills`
  deletions). They were neither touched nor folded in; this work sits on
  `feat/reasoning-cache-policy`.
