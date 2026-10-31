# Typed decision models — decisions transport

Local Router serves **System One decision models** (TypeSafe Jev) on the same
loopback port as chat, so agent tooling can run calibrated, typed judgments
through one local endpoint instead of reaching a provider directly.

This is the infrastructure layer: the router accepts the canonical decision
contract, resolves a decision model to a keyed provider, translates to that
provider's wire dialect, fails over between providers without lying about it,
and advertises what is actually servable.

- Edge routes: `POST /api/alpha/decisions`, `POST /v1/decisions`, `POST /decisions`
- Diagnostics: `GET /api/decisions/status` (`?probe=true`), `POST /api/decisions/probe`
- Discovery: `/v1/models` and `/api/tags` advertise decision models with
  `capabilities.decisions: true`
- Code: `src/decisions/{catalog,dialects,transport,service,routes}.ts`

## Contract

Clients speak the TypeSafe System One shape — the same body OpenRouter's
Decisions API accepts:

```json
{
  "model": "typesafe/jev-1.14",
  "state": "file src/router.ts binds port 11434",
  "questions": {
    "needs_port": {
      "type": "noul",
      "instructions": "Does this state bind a network port?",
      "criteria": { "true": "it binds a port", "false": "no network binding" }
    }
  }
}
```

The router answers in the same canonical shape, plus additive provenance:

```json
{
  "model": "typesafe/jev-1.14-20261014",
  "answers": { "needs_port": { "type": "noul", "noul": 0.95 } },
  "usage": { "input_tokens": 299, "output_tokens": 20, "cost": 0 },
  "id": "gen-dec-…",
  "provider": "openrouter",
  "dialect": "typesafe",
  "local_router": {
    "route": "/api/alpha/decisions",
    "requested_model": "typesafe/jev-1.14",
    "canonical_model": "typesafe/jev-1.14",
    "provider": "openrouter",
    "dialect": "typesafe",
    "attempts": [
      { "provider": "openrouter", "dialect": "typesafe", "outcome": "answered", "status": 200, "ms": 563, "model": "typesafe/jev-1.14-20261014" }
    ],
    "translations": [],
    "elapsed_ms": 563
  }
}
```

`local_router` is safe to ignore; clients that care about which provider
answered read `provider` / `model`. Nothing in the response is invented: an
unanswered question is an error, never a default.

### Model ids accepted

| Form | Meaning |
| :--- | :--- |
| `typesafe/jev-1.14` | Canonical id (what ainish-rag posts) |
| `jev-1.14`, `jev-latest`, `typesafe/jev-latest` | Aliases; `latest` resolves to the newest known Jev |
| `openrouter/jev-1.14` | Pinned to OpenRouter (tried first) |
| `zenmux/typesafe/jev-1.14` | Pinned to ZenMux (tried first) |
| `openrouter-jev-router` | **Chat alias, not a decision model** — deliberately not matched |

A pin is a preference, not a lock: if the pinned provider cannot serve the
request, the router either fails over (and the provenance says so) or returns a
structured error. It never quietly substitutes a chat model.

### Question primitives

| Type | Request | Answer |
| :--- | :--- | :--- |
| `noul` | `criteria: { true, false }` | `{ type: "noul", noul: 0–1 }` |
| `choice` | `options[]` and/or `criteria` object | `{ type: "choice", choice, probabilities, confidence }` |
| `score` | `criteria[]` (one description per level) | `{ type: "score", score, legend, probabilities, confidence }` |

`score` is the probability-weighted expected level in `[0, n-1]`. Apply bands
in code (e.g. ≥ 0.70 yes, ≤ 0.30 no); a probability is not a decision.

## Providers and dialects

| Provider | Endpoint | Dialect | Primitives | Status (2026-10-31) |
| :--- | :--- | :--- | :--- | :--- |
| OpenRouter | `https://openrouter.ai/api/alpha/decisions` | `typesafe` | noul, choice, score | Live — Jev 1.14 answers in 230–600 ms |
| ZenMux | `https://zenmux.ai/api/v1/decisions` | `zenmux` | choice, score | Keyed and catalogued; the route still answers `404 model_not_supported` for `typesafe/jev-1.14` (1.3 s), so a pinned request falls back to OpenRouter with both attempts recorded |

### `typesafe` dialect (OpenRouter)

The canonical body is forwarded unchanged with the provider's key. This is the
primary transport and the one that carries all three primitives natively.

### `zenmux` dialect

ZenMux's decisions route uses a **strict, array-shaped body** — unknown keys are
rejected — discovered by probing the live service:

```json
{
  "model": "typesafe/jev-1.14",
  "input": "<state as a string>",
  "questions": [
    { "name": "needs_port", "type": "choice", "instructions": "…",
      "choices": [{ "value": "true", "description": "…" }, { "value": "false", "description": "…" }] },
    { "name": "utility", "type": "score", "instructions": "…",
      "levels": [{ "label": "no relevant fact" }, { "label": "partial" }] }
  ]
}
```

Translation rules:

- `state` object/array → JSON string in `input`; `questions` object → array with
  `name` = question id; `options`/`criteria` → `choices[].value`/`.description`;
  score `criteria[]` → `levels[].label`.
- ZenMux has **no noul primitive**. A noul is carried as a calibrated two-option
  choice (`true` / `false`) built from the noul criteria, then converted back:
  `noul = probabilities.true`. The answer is marked
  `translated_from: "choice"` and the provenance lists `noul->choice(<id>)`.
  Callers that need TypeSafe-calibrated noul semantics on ZenMux should treat
  the value as a choice probability.
- Score levels are 0-based per the TypeSafe rubric. If a deployment echoes
  1-based keys, the decoder shifts them **only** when the key set proves it, and
  rebuilds `legend` from the request criteria.

## Failover policy

| Condition | Behaviour |
| :--- | :--- |
| `401`/`403`/`404`/`408`/`429`/`5xx`, network error, timeout | Try the next keyed provider; record the attempt |
| Malformed or partial answer set (missing/incorrect primitive) | Try the next keyed provider; never fabricate |
| `400`/`422` from every provider | Return `400 invalid_decision_request` with each provider's message |
| `400`/`422` from one provider, another answers | The answering provider wins (dialect limits are provider-local) |
| No keyed provider for the model | `503 decision_provider_unavailable` naming each provider's key state |

Unknown models return `404 unknown_decision_model` with the supported id. The
request is validated **before** any upstream call, so contract mistakes cost
nothing.

## Discovery

`GET /v1/models` and `GET /api/tags` include one row per keyed decision
provider:

```json
{ "id": "openrouter/jev-1.14", "owned_by": "openrouter",
  "capabilities": { "decisions": true, "toolCalling": false } }
```

Clients that discover Jev by id (ainish-rag looks for any `jev` id, then probes
the decisions paths) therefore find a real decision model, not only the
`openrouter-jev-router` chat alias. Unkeyed providers are not advertised.

### Pinned rows (no toggle can remove them)

Decision rows are built from the decisions catalog, never from the toggle store,
and carry `alwaysAvailable: true` in the model layer:

- **Key is the only condition.** `openrouter/jev-1.14` is advertised exactly when
  the OpenRouter key is configured — adding or removing the key changes
  availability; curation does not.
- **Curation is bypassed.** `PUT /api/model-curation` (including clearing every
  curated key, or unchecking everything for OpenRouter) leaves the decision row
  served. `applyEndpointCuration` and `filterConfiguredModels` both honour the
  pin.
- **Ids are reserved.** `POST/PUT /api/provider-models/:provider` rejects a
  presented name that is a decision id (`400 … already exists`), so an operator
  cannot rename a chat model over the transport.
- **Duplicates collapse.** If a catalog row, override, or live discovery ever
  produces the same presented id, `withDecisionModels()` drops the shadow row
  and appends the decision row — the decisions catalog is authoritative for
  those ids, and `/v1/models` still returns exactly one.

The mirror case is deliberate: with no OpenRouter key the model is **not**
advertised and `/api/alpha/decisions` answers `503
decision_provider_unavailable`. Discovery never points at a transport that
cannot serve.

Chat completions for a decision model are refused with `400` and a message
pointing at `/api/alpha/decisions`; a decision model is never cascaded into a
chat fallback chain, and the VS Code chat picker excludes pinned rows.

## Diagnostics

`GET /api/decisions/status` → readiness, provider order, per-provider key/dialect/
endpoint, advertised model ids, last probe, and the recent request ring.

`GET /api/decisions/status?probe=true` or `POST /api/decisions/probe` performs a
live typed noul probe per provider and returns status, latency, resolved model,
or the upstream error. The probe is on-demand only — normal requests never add
probe traffic.

## Configuration

| Variable | Purpose |
| :--- | :--- |
| `LOCAL_ROUTER_DECISION_ORDER` | Comma-separated provider preference (default `openrouter,zenmux`; unknown names ignored) |
| `LOCAL_ROUTER_DECISION_<PROVIDER>_URL` | Override a provider's decisions endpoint (staging, tests) |
| `LOCAL_ROUTER_DECISION_TIMEOUT_MS` | Per-attempt timeout (default `30000`, minimum `1000`) |
| `OPENROUTER_API_KEY` / `LOCALROUTER_OPENROUTER_API_KEY` | OpenRouter key (env or PQC bundle, same resolution as chat) |
| `ZENMUX_API_KEY` / `LOCALROUTER_ZENMUX_API_KEY` | ZenMux key (env or PQC bundle) |

## Security

- Keys resolve in memory from the key store / resolved environment (PQC bundle →
  env). They are never taken from the request, logged, or persisted by this path.
- A caller's `Authorization` header is **ignored**; each provider gets only its
  own key, so a request cannot borrow another provider's credential.
- Upstream URLs are fixed by the catalog (or the explicit override) and still go
  through the SSRF guard; loopback HTTP overrides are permitted for tests, public
  HTTP is not.
- The routes are unauthenticated like the rest of the loopback-only API; the
  server binds `127.0.0.1`/`::1` by default.
- A failed transport is never converted into "no/irrelevant": errors are errors.

## Adding a provider

1. Add a `DecisionProviderSpec` to `src/decisions/catalog.ts` (endpoint, dialect,
   model pattern, primitives, headers).
2. Implement `encode`/`decode` in `src/decisions/dialects.ts` if the wire shape
   differs; validate strictly and fail closed on partial answers.
3. Add translations to `translations` so the provenance tells the truth.
4. Extend `tests/decisions-dialects.test.mjs` (encode/decode/negative cases) and
   `tests/decisions.integration.test.mjs` (failover, malformed, all-fail).
5. Probe the live endpoint and record the observed shape in this document.

## Verification

- `node --test --test-concurrency=1 tests/decisions-dialects.test.mjs tests/decisions.integration.test.mjs tests/decisions-pinned.integration.test.mjs`
  — 34 tests: id resolution (including the chat alias), dialect encode/decode,
  one-based score normalization, fail-closed decoding, all three routes,
  discovery, chat guard, failover, malformed failover, all-fail 502, contract
  400, pinned provider preference, probe endpoint, curation-independent pinned
  rows, id reservation, and `/api/show` for a pinned row.
- Live (2026-10-31, build from branch `feat/router-decision-providers`, port 11436):
  - `POST /api/alpha/decisions` with `typesafe/jev-1.14` → `200`, `provider:
    openrouter`, `answers.q.noul` populated, 246–1014 ms including cold start.
  - `GET /api/decisions/status?probe=true` → `ready: true`; OpenRouter `200`,
    ZenMux `404 model_not_supported` reported verbatim.
  - Pinned `zenmux/jev-1.14` → ZenMux `404` recorded, OpenRouter answered, both
    attempts present in `local_router.attempts`.
  - `ainish-rag secrets` with `JEV_LOCAL_ROUTER_URL=http://127.0.0.1:11436` →
    `Decisions Route: http://127.0.0.1:11436/api/alpha/decisions (fallback transport)`.
- Production (2026-10-31, `main` @ `471d3f6`, `127.0.0.1:11434`, WSL PID 445423,
  operator-keyed OpenRouter + ZenMux):
  - Key persisted as `LOCALROUTER_OPENROUTER_API_KEY`; after a cold restart
    `bundleLoaded=true` with `loadedProviders=openrouter,zenmux,xiaomi-mimo,ollama`.
  - Discovery: `/v1/models` + `/api/tags` expose `openrouter/jev-1.14` and
    `zenmux/jev-1.14` with `capabilities.decisions: true`, next to the untouched
    chat alias `openrouter-jev-router` (`decisions: false`).
  - Probe: OpenRouter `200` / 593 ms; ZenMux `404 model_not_supported` / 1307 ms.
  - Typed batch (noul + choice + score): `200` in 294 ms; `noul 0.60`,
    `choice provider_resolver` p=1.0, `score 2.63` with legend and probabilities
    summing to 1.0; usage 461/72 tokens, cost 0.
  - Pinned `zenmux/jev-1.14` → `200` served by OpenRouter, attempts
    `zenmux:retryable_error:404 → openrouter:answered:200`.
  - Chat separation: chat for the decision id → `400` with the decisions pointer;
    the alias was served by `openai/gpt-6-luna`.
- Tooling (ainish-rag against the same instance):
  - `ainish-rag secrets` → `Decisions Route: http://127.0.0.1:11434/api/alpha/decisions (fallback transport)`.
  - `ainish-rag decide` → noul 0.87 (`openrouter:typesafe/jev-1.14-20261014`);
    `ainish-rag route` → `needs_retrieval 0.69`, `architectural_wiki`, freshness 0.07.
  - Forced fallback (invalid primary key) → `source: local-router:http://127.0.0.1:11434/api/alpha/decisions:typesafe/jev-1.14-20261014`.
  - Rerank batch through the router: `ainish-rag query` rationales read
    `Jev local-router:http://127.0.0.1:11434/api/alpha/decisions:typesafe/jev-1.14-20261014`
    with `direct 0.84 (yes), symbols 0.95, utility 3.51/4 [implementation]` in 3.5 s.
