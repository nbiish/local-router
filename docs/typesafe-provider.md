# TypeSafe provider and per-provider decision models

Status: implemented 2026-11-06. Companion to [`fallback-embedding-and-decision.md`](./fallback-embedding-and-decision.md).
Provider contract verified against `https://api.typesafe.ai/openapi.json`.

## Three providers, one model

Jev is trained by TypeSafe, and OpenRouter and ZenMux resell it. All three are now decision
providers, ordered source-first:

```
local-router/fallback-decision  ->  typesafe  ->  openrouter  ->  zenmux
```

| Provider | Endpoint | Dialect | Primitives | Key |
|---|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `typesafe` | noul, choice, score | `TYPESAFE_API_KEY` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `typesafe` | noul, choice, score | `OPENROUTER_API_KEY` |
| `zenmux` | `https://zenmux.ai/api/v1/decisions` | `zenmux` | choice, score | `ZENMUX_API_KEY` |

The native request is `{ model, state, questions }` with `Authorization: Bearer <key>`, which is
exactly what the existing `typesafe` dialect encodes — the direct API needs **no new dialect**. Its
response is `{ model, answers, usage }` where `usage` is `{ input_tokens, output_tokens }`.

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

## What is verified, and what is not

Verified without a key:

- TypeSafe is the first transport and both key names resolve.
- Per-provider pins change what each provider is asked for, independently.
- A typo is ignored; a short form is accepted.
- A provider on an older build is not offered a newer request.
- Failover records both attempts and returns an honest 502 when neither can answer.

**Not yet verified:** a live call to `api.typesafe.ai/v1/systemone`. No TypeSafe key was present
when this was built, so the endpoint, auth, and response shapes come from the published OpenAPI
spec. The first authenticated call is the remaining proof, and `/api/decisions/status` will show
`typesafe.key_configured: true` once the key is stored.
