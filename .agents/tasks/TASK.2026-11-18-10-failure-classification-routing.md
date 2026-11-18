# TASK.2026-11-18-10 — Failure classification so the fallback chain routes on what actually failed

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `main` (docs/coordination only — classification audit and plan, no code changed)
- Plan produced: `.agents/plans/2026-11-18-10-failure-classification-routing.md` (status: designing)
- Supersedes: the routing concern of `.agents/plans/2026-11-18-09-decision-engine-choice.md`
  (which stays open for the broader classifier-quality question)
- Status: done (audit + plan); implementation is a separate go-ahead

## Objective

Operator directive: ensure the fallback system routes correctly on actual failures for every model
and logic path — code first everywhere possible, Jev only where an error is genuinely ambiguous.

## Findings

**Routing works; classification is lossy.** Every failed stage advances the chain, and quarantine
was observed working correctly end to end (23 failures → 13 cooldown skips → 12 answers for one
member). The defect is upstream of routing, in what the classifier decides failed.

### Measured failure distribution (221 live records)

| errorType | count |
|---|---|
| `upstream_http` (catch-all) | 202 |
| `upstream_http_auth` | 126 |
| `upstream_http_invalid_request` | 70 |
| `upstream_http_unavailable` | 23 |
| `upstream_http_rate_limit` | 7 |
| `proxy_runtime` | 2 |

### The catch-all hides three different causes

Of the 202 `upstream_http` failures: **93 are HTTP 404**, **59 are HTTP 200 with empty content**,
**50 are HTTP 502**. Each needs different treatment and currently gets the same one.

### Three confirmed defects

1. **404 is unclassified.** `classifyHttpFailure` handles 402/401/403/429/5xx/400/413/422 and falls
   through to `upstream_http`. A permanent "route not found" is treated as an unknown transient fault,
   retried as a transient, and quarantined on the retryable schedule. Verified by replaying the
   function over the five real 404 bodies: all return `upstream_http`.

2. **A 200 with no `choices` counts as success.** `src/index.ts:6809` returns `'generated'` when
   `choices` is missing or empty, and the `catch` also returns `'generated'` for unparseable bodies.
   So `{"id":"x"}`, `{"choices":[]}`, and `<html>502 Bad Gateway</html>` all pass as valid answers.
   Verified by replay.

3. **The stream classifier is dead code.** `classifyStreamChunkAsError` is defined at
   `src/index.ts:6842` and never called — `rg` finds exactly one occurrence, the definition. Content
   classification is additionally gated on `!isStreamRequest`, so a stream that errors mid-flight is
   forwarded to the client instead of failing over.

### A fourth, subtler issue

Empty-content failures are normalized to `upstream_http`, which is in `EVIDENCE_FAILURE_TYPES`, so a
reasoning model that burns its budget and returns nothing accrues provider-health strikes. A model
configuration problem is recorded as a provider outage.

## Why this is a code problem, not a Jev problem

Every one of the four is decidable from data already in hand: an HTTP status, the presence of a
`choices` array, and whether content or tool calls are non-empty. This is exactly the "code first"
case the operator described. Jev is therefore scoped in the plan to offline labelling of whatever
residue survives Phase 4 — and only if that residue is material and genuinely case-by-case.

## Deliberately not done

- No code changed; no chain reorder; no quarantine constant touched.
- Did not implement the four fixes — the plan carries them as F1.1-F5.1 with verification per item.
- Did not propose Jev in the live routing path: that would put a model inside a threshold decision,
  contrary to AGENTS.md non-negotiable 6.

## Verification

- Failure distribution and the 404/200/502 split come from replaying all 221 live trajectory records,
  not from inference.
- The classifier behaviour claims were verified by executing the exact function logic over the real
  captured bodies, not by reading the source alone.
- Quarantine correctness was verified from a live outcome sequence for a real member.
- Accidentally booted a second router while importing `build/index.js` for a test; detected it,
  confirmed only the legitimate PID 87694 remained, and switched to logic-only replays with no server
  import for the rest of the audit.

## First failure to expect if this is wrong

If providers emit 404 for transient reasons (e.g. a gateway that 404s while warming), classifying it
as permanent would quarantine healthy models. The evidence argues otherwise — the observed bodies are
literal "Route POST:/v1/chat/completions not found" from cursor, which is a routing/config fact, not a
warm-up state — but the live verification in F5.1 exists to catch it before this lands.
