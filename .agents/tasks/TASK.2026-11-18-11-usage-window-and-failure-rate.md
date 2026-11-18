# TASK.2026-11-18-11 — Usage-window awareness, failure-rate memory, and auto-disable

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `main` (docs/coordination only — research and plan, no code changed)
- Plan produced: `.agents/plans/2026-11-18-11-usage-window-and-failure-rate.md` (status: designing)
- Status: done (research + plan); implementation is a separate go-ahead

## Objective

Operator directive: the chain mixes subscription capacity (rolling/five-hour windows), free tiers
with unknown allowances, and metered paid keys, and treats all three identically. Build a
comprehensive plan for handling that properly, add a failure-rate system with auto-disable after
sustained failure (default: continuously past a day), settle mid-stream failover semantics, and stop
treating local-router as offline-only — it should carry decision-model tooling for hard-to-code
provider failure states.

## Findings

**No rate-limit signal is parsed at all.** A repo-wide search for `retry-after`, `x-ratelimit`,
`ratelimit-reset`, `reset_at`, `resets_in`, `quota_reset` across `src/` returns zero matches. Backoff
is a flat function of attempt number plus a two-constant cooldown (30 min auth, 5 min retry).

**The 429 bodies carry a human hint but no machine field.** All 11 live 429 stages said
"temporarily rate-limited upstream. Please retry shortly" inside `metadata.raw` — not a header, not a
`retry_after` field. A live probe of OpenRouter returned 401 with no rate-limit headers at all, so the
header surface cannot be assumed. Any reset-aware backoff must therefore accept three tiers of
evidence: explicit header, body hint, or unknown.

**Quarantine dies on restart.** `HealthRegistry.members` is a `Map` and the file contains no
`readFile`/`writeFile`. Every restart re-walks known-dead members.

**There is no failure rate.** `MemberState` holds a consecutive-failure counter, not a rate over a
window, so a member failing 40% of the time forever never trips anything.

**A success-rate system already exists and is dead.** `src/tiers.ts` implements
`verified | insufficient | deranked` with `SUCCESS_RATE_THRESHOLD = 0.85`, `TIER_MIN_SAMPLES = 50`, and
a MAD latency rule — and nothing imports it. The operator's ask is partly built and unreachable.

**Auto-disable has no writer.** `disabledModels` is a manual, operator-authored toggle. Nothing derives
it from observed failures.

**Access paths are already classified**, which is the foundation the usage model needs:
`fallback-topology.ts` distinguishes `'oauth' | 'key' | 'local'` and maps OAuth/local to the
`subscription` band with an explicit doctrine.

**`ProviderPolicy` has no rate-limit dimension** (`{ reasoning, caching }` only), so there is nowhere to
record a window length even if it were known. `docs/caching/<provider>.txt` is the established
per-provider evidence pattern and is the right template for `docs/usage/<provider>.txt`.

## Decisions taken

- **Mid-stream failover**: no silent advance once content has reached the client. Fail over only if
  nothing was forwarded; otherwise terminate with an explicit error event and record
  `mid_stream_error`. Rationale — a spliced answer is authored by nobody and attributable to nothing,
  which breaks the trajectory's honesty contract.
- **Offline-only**: dropped. Local-router carries decision-model tooling for ambiguous failure states;
  offline inference stays with Ollama/Unsloth/llama.cpp as operator-configured.
- **Code-first preserved**: the decision model only assists what code cannot separate, and only after
  offline evaluation.

## Deliberately not done

- No code changed, no provider policy edited, no chain mutation.
- Did not guess free-tier allowances — they are undocumented and volatile, so the plan treats them as
  unknown-by-default and learns from observed behaviour.
- Did not invent subscription window lengths: only 5 hours where the operator states it.
- Did not wire `tiers.ts` in or delete it; the plan makes that an explicit either/or so no dead code
  survives implementation.

## Verification

- The "no header parsing" claim is a repo-wide search result, not an assumption.
- The 429 evidence comes from all 11 live occurrences, quoted.
- The restart-durability gap is confirmed by the absence of any fs call in the health registry.
- The dead-code claim for `tiers.ts` is confirmed by a zero-result import search.
- Host constraints and the open-procedure probe were run live, not inferred.

## First failure to expect if this is wrong

If some providers do emit reliable `x-ratelimit-*` headers that the probe simply never triggered
(because the probe failed auth first), then reset-aware backoff is easier than planned — U2.1 becomes
the primary path rather than one of three evidence tiers. The plan is written to accommodate that
outcome without change, since headers are already the strongest tier.

## Implementation status (2026-11-18)

Implemented and merged as `455f2c3` (branch `feat/usage-window-failure-rate`, worktree removed).

Delivered: usage-policy reset tiers + cooldown choice, the 26-row provider usage table, auto-disable
with the never-empty-a-chain guard, health persistence with fail-open loading, 24h failure rate,
auto-disable candidates, and a `diagnostics()` row that reports whether a cooldown was inferred.
Classifier corrections from plan 10 were folded in because they share the evidence path.

Verified: 42 new tests across four files; merged tree 441 tests / 428 pass / 1 fail / 12 skipped,
where the one failure reproduces identically on pre-merge `main` (`detectLocalCursorSession`, a
pre-existing red). Two real bugs were found by the tests themselves — see plan §8.

Not delivered: rate/disable surfacing in the HTTP API and `/config/fallback` UI (U3.2, U4.2 route),
and the `tiers.ts` wire-in-or-delete decision, which is held until the UI consumes the rates.

## Cross-machine verification (blocked)

Windows/WSL host `192.168.1.248` is reachable (`OpenSSH_for_Windows_9.5` on :22, Ubuntu on :2222,
ping 5-8 ms) but refuses all four local keys — no enrollment. Enrolling requires a password or a key
path not available to this session, so it is recorded as an operator action rather than attempted.

Second, independent blocker: the router listens on loopback only, so even with SSH working, the
Windows/WSL side could not consume this router over the LAN. `LOCAL_ROUTER_BIND_ALL=true` would make
an unauthenticated proxy reachable on the network; that is an operator security decision and was
deliberately not taken.
