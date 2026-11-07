# TypeSafe provider and per-provider decision models

Status: implemented 2026-11-06. Companion to [`fallback-embedding-and-decision.md`](./fallback-embedding-and-decision.md).
Provider contract verified against `https://api.typesafe.ai/openapi.json`.

## Three providers, one model

Jev is trained by TypeSafe, and OpenRouter and ZenMux resell it. All three are now decision
providers, ordered source-first:

```
local-router/fallback-decision  ->  typesafe  ->  openrouter  ->  zenmux
```

| Provider | Endpoint | Dialect | Model on the wire | Key |
|---|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `typesafe` | `typesafe/jev-1.14` | `OPENROUTER_API_KEY` |
| `zenmux` | `https://zenmux.ai/api/v1/decisions` | `zenmux` | `typesafe/jev-1.14` | `ZENMUX_API_KEY` |

### Each provider speaks its own model vocabulary

This is the trap that made the direct tier silently useless. Verified live 2026-11-06:

- TypeSafe's own catalog (`GET /v1/models`, fetched with an operator key) lists exactly two models:
  **`jev-latest`** and **`jev-preview`**.
- Asked for `typesafe/jev-1.14`, TypeSafe answers
  `400 api_usage_error "Unknown model: typesafe/jev-1.14"`.

The versioned `typesafe/jev-<version>` id is the **reseller** vocabulary — OpenRouter stamps it. So
the router keeps one canonical id for callers and translates at the edge: TypeSafe receives
`jev-latest`, the resellers receive the canonical id unchanged.

Before that translation the chain looked healthy and was not: every request recorded
`typesafe: contract_error 400` and then `openrouter: answered`, so OpenRouter served 100% of
traffic while the responses looked correct. Only the attempt trail revealed it.

Because TypeSafe publishes an alias rather than a version, `jev-latest` is also the right thing to
send: it follows whatever build TypeSafe currently serves (it reported `jev-1.14.0`), which is the
"use the available named Jev version" behaviour a fallback chain wants.

The native request is `{ model, state, questions }` with `Authorization: Bearer <key>`, which is
exactly what the existing `typesafe` dialect encodes — the direct API needs **no new dialect**. Its
response is `{ model, answers, usage }` where `usage` is `{ input_tokens, output_tokens }`, and
that shape reaches the caller **untranslated**: callers must not assume the chat surface's
`prompt_tokens`/`completion_tokens`.

TypeSafe also exposes a `Box` primitive (find something in an image). The router does not model it,
so it is not advertised; a `box` question is rejected by contract validation rather than silently
downgraded.

## Configuring the model per provider

Providers do not adopt a new build on the same day: when a Jev release lands the direct API
usually has it first and a reseller follows. A single global model id would either hold the direct
path back or send a reseller an id it rejects, so each provider has its own pin:

```bash
# advance only the source API; the resellers stay on the previous build
export LOCAL_ROUTER_DECISION_TYPESAFE_MODEL="typesafe/jev-1.15"

# hold a lagging reseller back deliberately
export LOCAL_ROUTER_DECISION_ZENMUX_MODEL="typesafe/jev-1.13"
```

Rules, all enforced in code:

- The value is canonicalised, so `jev-1.15` and `typesafe/jev-1.15` are the same pin.
- An **unrecognised** value is ignored and the known build is used, so a typo cannot send a
  non-decision id to a decisions endpoint.
- `/api/decisions/status` reports `configured_model` and `model_env_var` for every provider, so the
  active build and the variable that changes it are both visible without reading code.
- `/v1/models` advertises each provider's **configured** build, so discovery never offers an id the
  provider would reject.
- A provider configured for a different build is **not** a candidate for the requested one: it
  would answer `model_not_supported`, which costs a failover round-trip and records a misleading
  attempt. An explicit request for a build the router is not pointed at still works, because then
  no provider matches exactly and the pattern-compatible ones are used.

Nothing here requires a restart to inspect: the status endpoint reads the live environment each
time it is called. A restart is only needed to apply a changed pin to in-flight traffic.

## Key resolution

Both names are accepted:

- `LOCALROUTER_TYPESAFE_API_KEY` — the router-scoped form, which wins when both are set.
- `TYPESAFE_API_KEY` — the name TypeSafe documents and the name fleet tooling already resolves.

Accepting only the prefixed form was a trap: an operator who followed the provider's own docs set a
variable that was silently ignored, and the provider reported "no key" with no hint that a value
existed under another name. This applies to every provider, not just TypeSafe.

## Adding the key

```bash
pqc-secrets set TYPESAFE_API_KEY --stdin      # read the value from stdin, never argv
pqc-secrets list --json                       # prove the name, never the value
```

The router picks it up through the PQC bundle like every other provider key, and
`/api/decisions/status` flips `typesafe.key_configured` to `true`.

## What is verified

Verified live on 2026-11-06 with an operator TypeSafe key in the PQC bundle:

- `POST /api/decisions/probe` → `typesafe ok=true status=200 model=jev-1.14.0`.
- `typesafe/jev-1.14` → answered by **typesafe** in one attempt, no failover.
- `openrouter/jev-1.14` → answered by **openrouter**.
- `zenmux/jev-1.14` → ZenMux `404`, then fails over to **typesafe** — the declared order, proven
  in the attempt trail.
- `local-router/fallback-decision` → answered by **typesafe** directly.
- Latency dropped from ~1360 ms (OpenRouter answering everything) to ~300 ms once TypeSafe served
  the request.
- Both key names resolve; per-provider pins change only their own provider; a typo is ignored; a
  short form is accepted; a provider on an older build is not offered a newer request.

Also verified: with a dead TypeSafe endpoint the chain fails over and records both attempts,
returning an honest 502 rather than hanging or reporting success.
