# Trajectories — reading the router's fallback-chain log

Every model call through Local Router appends one inspectable record to a JSONL log. This is the
observability surface of record for the fallback chain: it answers **"which chain member stopped
working, which is being silently skipped, and why"** after the fact, from the log, without a live
repro. If you are an agent reviewing a failure, start here.

- **On disk:** `~/.config/local-router/trajectories/trajectories.jsonl` (append-only, newest last).
- **Spill:** any payload larger than the 400-char inline preview goes to
  `trajectories/spill/<sha256>.txt`, referenced by a `sha:` handle. Every such payload is
  retrievable — a receipt is either fully inline or fully spilled, never neither.
- **Disable:** `LOCAL_ROUTER_TRAJECTORY_LOG=0`.
- **Redirect:** `LOCAL_ROUTER_TRAJECTORY_DIR=<dir>` (tests and verification runs use this).
- **Code:** `src/trajectories.ts`. **Page:** `/config/trajectories`.

## The one thing readers get wrong

`local-router/fallback-models` is an **alias**, not a model. It sheds to one concrete chain member per
request. A record showing the alias answering as `xiaomi-mimo/mimo-v2.6-pro` is a **successful shed**,
not an outage and not a misconfiguration.

Schema v2 records this as its own field so you never have to infer it:

```jsonc
"shedding": {
  "from": "local-router/fallback-models",
  "to": "xiaomi-mimo/mimo-v2.6-pro",
  "attemptsBeforeAnswer": 2,   // failed attempts before the winner answered
  "excludedCount": 1           // members excluded before the plan was even built
}
```

- `shedding` **present** — an alias answered via a concrete member.
- `shedding` **absent** — either a direct model call answered as requested, or the chain failed with
  no winner. Check `result.answeredBy`: `null` means nothing answered.

Never treat an absent `shedding` as "shed to nothing".

## Record shape (schema 3)

| Field | Meaning |
|---|---|
| `schema_version` | `1`, `2`, or `3`. v2 added `shedding`, `clientSource`, `userAgent`; v3 added the outbound-body receipt, `clampedTokens`, `droppedFields`, `degradedTargets`, and the tier-2 downgrade flags. Older records stay readable. |
| `client` | Who called. Resolved from `x-local-router-client`, else the User-Agent (`pi/1.5.2 …` → `pi`). |
| `clientSource` | `header`, `user-agent`, or `unknown` — **how** the name was derived. |
| `userAgent` | Raw UA, kept so attribution can be improved retroactively. |
| `presentedModel` | The model id the client asked for (often the alias). |
| `routeKind` | `direct`, `fallback`, or `direct+cascade` (direct failed, chain carried it). |
| `chain` | Snapshot of intent: configured targets, eligible targets, `degradedTargets` (tier 2), excluded targets **with reasons**. |
| `stages` | Ordered timeline — every attempt, skip, and reason — plus what the router SENT. |
| `result` | Status, winner, error type, usage (incl. cached tokens), cost. |
| `receipts` | `sha:` handles for request/response/thinking/toolCalls payloads. |

`shedding` is present only on a successful alias shed.

### What the router sent (`stages[i]` in v3)

The client-request summary cannot explain a router-authored failure. These fields exist so a
400 can be diagnosed from the log alone:

| Field | Meaning |
|---|---|
| `outbound` | `sha:` receipt for the exact JSON body sent upstream. Spilled whenever it exceeds the inline preview, so it always round-trips. |
| `clampedTokens` | `{requested, clamped}` when the client's output budget exceeded the target model's ceiling and the router lowered it. |
| `droppedFields` | Field names removed because the target's schema validates and would have rejected them. |
| `reasoningDialDowngraded` | The model has no request-level thinking dial, so the caller's level did not reach it. |
| `requestedLevel` | The level the caller asked for, recorded beside the downgrade. |

Read the outbound body for a failed stage:

```bash
# Through the API (works whether or not the payload was spilled):
curl -s 'localhost:11434/api/trajectories/<id>?part=outbound&stage=0'

# Or straight off disk when it was spilled:
curl -s localhost:11434/api/trajectories/<id> \
  | jq -r '.stages[] | select(.outcome=="failed") | .outbound.sha' \
  | sed 's/^sha://' \
  | xargs -I{} cat ~/.config/local-router/trajectories/spill/{}.txt
```

### Tier-2: a thinking request served without a dial

`chain.degradedTargets` lists members reachable only at their own fixed reasoning depth. They are
planned after every dial-capable member, so a request that chose a thinking level still gets the
best available answer instead of a 400 when the dial-capable steps fail. Accepting one of them is
stamped `reasoningDialDowngraded: true` — the downgrade is stated, not implied. A member skipped
every time is now a real fault; a member deferred to tier 2 is not.

## Reading the stage timeline

Each stage is `answered`, `failed`, or `skipped`.

```jsonc
{ "stage": "pass-1-step-2", "targetModel": "cline/deepseek-v4-pro", "provider": "cline",
  "outcome": "failed", "errorType": "upstream_http_auth", "status": 401,
  "errorMessage": "...", "waitBeforeRetrySeconds": 2, "ms": 812 }
{ "stage": "pass-1-step-3", "targetModel": "zenmux/glm-5.3-free",
  "outcome": "skipped", "skipReason": "cooldown:upstream_http_auth" }
```

- **`skipped` is not `failed`.** A skipped stage never made a network call. Its `skipReason` names the
  preflight or cooldown cause (`no_configured_key`, `disabled_toggle`, `context_window_too_small`,
  `cooldown:<errorType>`, …). A member skipped every time was **never tried** — a different bug class
  from one that fails.
- **`forced: true`** marks a last-pass force-try that ignored an active cooldown.
- **`waitBeforeRetrySeconds`** is the inter-pass / inter-attempt backoff already applied.

## Error classes

Raw `errorType` strings do not tell you what to fix. Records roll up into four stable classes
(`errorClassFor`):

| Class | Typical cause | Fix |
|---|---|---|
| `key_rejected` | `upstream_http_auth` — 401/403, key revoked | refresh the key |
| `out_of_funds` | `upstream_http_payment_required` — 402, `insufficient_quota`/`balance` | top up |
| `usage_limit` | `upstream_http_rate_limit`, `upstream_http_quota` — 429 | back off; it self-heals |
| `usage_error` | `upstream_http_invalid_request` — the request itself is wrong | change the request |
| `other` | anything unmapped (e.g. bare `upstream_http`, parse errors) | read `errorType` directly |

Only the four named classes aggregate into `errorClasses` counts and raise a member flag; `other` is
excluded from the roll-up so an unmapped string never masquerades as a known triage category.

## Health flags

`GET /api/trajectories/health` aggregates the window and flags members; the same flags render on
`/config/trajectories`:

- `never_answers` — planned repeatedly, never succeeded.
- `always_skipped` — skipped every time it was considered.
- `recent_error_spike` — failure rate recently jumped.
- `missing_from_plan` — configured in the chain but never eligible, excluded, nor executed.

`chainHealth` in the same payload reports `dead` and `degraded` members under active quarantine
(chain-scoped cooldown), so a member missing from a plan may be quarantined rather than broken.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/trajectories?limit=&route=&outcome=&since=` | Summaries (newest first). Includes `clientSource` and `shedTo`. |
| `GET /api/trajectories/:id` | Full record. |
| `GET /api/trajectories/:id?part=request\|response\|thinking\|toolCalls` | Spilled payload by part. |
| `GET /api/trajectories/:id?part=outbound&stage=0` | The exact JSON body sent upstream for that stage. |
| `GET /api/trajectories/health` | Per-route chain analysis, flags, `chainHealth`. |
| `GET /api/chain/recommendations` | Advisory auto-disable recommendations. **Never applied** — the router does not edit the chain. |
| `GET /api/trajectories/export` | Raw JSONL. |
| `DELETE /api/trajectories` | Clear the log (destructive). |

## Recipes

**Which member is dead in my chain?**

```bash
curl -s localhost:11434/api/trajectories/health \
  | jq '.routes[] | {route: .routeId, dead: [.models[] | select(.flags | index("never_answers")) | .model]}'
```

**Why did this request fail?** — take the id from the summary and read its stages:

```bash
curl -s localhost:11434/api/trajectories/<id> | jq '.stages[] | {stage, targetModel, outcome, skipReason, errorType, status}'
```

**Did the alias actually shed, or did it fail?** — an absent `result.answeredBy` is a failure; a
`shedding` block is a normal shed.

```bash
curl -s localhost:11434/api/trajectories/<id> | jq '{answeredBy: .result.answeredBy, shedding}'
```

**Who is calling?** — `clientSource: "unknown"` means the caller identified itself in no way; that is
an attribution gap, not a caller named "unknown".

```bash
grep -o '"client":"[^"]*"' ~/.config/local-router/trajectories/trajectories.jsonl | sort | uniq -c
```
