# Trajectories — reading the router's fallback-chain log

Every model call through Local Router appends one inspectable record to a JSONL log. This is the
observability surface of record for the fallback chain: it answers **"which chain member stopped
working, which is being silently skipped, and why"** after the fact, from the log, without a live
repro. If you are an agent reviewing a failure, start here.

- **On disk:** `~/.config/local-router/trajectories/trajectories.jsonl` (append-only, newest last).
- **Spill:** payloads over 4 KB go to `trajectories/spill/<sha256>.txt`, referenced by a `sha:` handle.
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

## Record shape (schema 2)

| Field | Meaning |
|---|---|
| `schema_version` | `1` or `2`. v2 added `shedding`, `clientSource`, `userAgent`. v1 records stay readable. |
| `client` | Who called. Resolved from `x-local-router-client`, else the User-Agent (`pi/1.5.2 …` → `pi`). |
| `clientSource` | `header`, `user-agent`, or `unknown` — **how** the name was derived. |
| `userAgent` | Raw UA, kept so attribution can be improved retroactively. |
| `presentedModel` | The model id the client asked for (often the alias). |
| `routeKind` | `direct`, `fallback`, or `direct+cascade` (direct failed, chain carried it). |
| `chain` | Snapshot of intent: configured targets, eligible targets, excluded targets **with reasons**. |
| `stages` | Ordered timeline — every attempt, skip, and reason. |
| `result` | Status, winner, error type, usage (incl. cached tokens), cost. |
| `receipts` | `sha:` handles for request/response/thinking/toolCalls payloads. |

`shedding` is present only on a successful alias shed.

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
| `GET /api/trajectories/health` | Per-route chain analysis, flags, `chainHealth`. |
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
