# TypeSafe Jev — live API contract

Source of truth: OpenRouter's Decisions API, exercised and verified against the live service on
2026-10-30. Re-verify with `scripts/jev_probe.py` when models or fields change.

## Endpoint and authentication

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <OPENROUTER KEY>
Content-Type: application/json
HTTP-Referer: https://github.com/nbiish/ainish-coder
X-Title: ainish-rag-decisions
```

The key is resolved in memory only, in this order:

1. environment — `OPENROUTER_API_KEY`, `ROUTER_API_KEY`, `OPENROUTER_EMBED_API_KEY`,
   `LOCALROUTER_OPENROUTER_API_KEY`, `LOCALROUTER_OPENROUTER_EMBED_API_KEY`,
   `AINISHCODER_OPENROUTER_API_KEY`;
2. the PQC store through `pqc-secrets export --json` (the store commonly holds the
   consumer-prefixed `LOCALROUTER_OPENROUTER_API_KEY`);
3. otherwise the calibrated local fallback.

Never write the key to disk, argv, logs, or a task record. `ainish-rag secrets` reports resolution
status without the value.

## Models

| Model id | Status |
| :--- | :--- |
| `typesafe/jev-1.14` | latest decision model; responses report `typesafe/jev-1.14-20261014` |
| `typesafe/jev-1.13` | previous decision model; only used when explicitly pinned |
| `typesafe/jev-router` | chat router model, **not** accepted by the Decisions API |

The engine always targets the latest decision model. It does **not** downgrade to an older Jev id:
`JEV_DECISION_MODEL` is a diagnostic pin that `ainish-rag secrets` surfaces (`model_pinned`), and
when OpenRouter answers `Model ... does not exist` the call fails with that reason, after which the
command falls back to the calibrated local router rather than silently using older judgments.

## Additional transport — Local Router

The loopback Local Router (`http://127.0.0.1:11434`, or `JEV_LOCAL_ROUTER_URL`) is an additional
*typed* transport, discovered in this order:

1. `GET {base}/api/decisions/status` — zero-token fast path (Local Router 1.1.0+). A `ready: true`
   response supplies `routes` (first route becomes the decisions URL) and `advertised_models`
   (`openrouter/jev-1.14`, `zenmux/jev-1.14`).
2. `GET {base}/v1/models` — any id containing `jev` marks a Jev candidate. A decisions-capable
   router advertises pinned ids with `capabilities.decisions: true`, alongside the chat-only
   `openrouter-jev-router` alias.
3. `POST {base}/api/alpha/decisions`, then `/v1/decisions`, then `/decisions` — the first route that
   answers a minimal typed probe is usable.

Both transports are attempted before any heuristic. Default order is OpenRouter then Local Router;
`JEV_TRANSPORT_PRIORITY=local-router,openrouter` flips it. The probe **never** sends the OpenRouter
key to loopback. A router that only exposes Jev over chat completions is reported by
`ainish-rag secrets` as `Decisions Route: none (chat-only entry)` and is never substituted for
typed, calibrated decisions — chat Jev routes can resolve to general models and carry no
calibrated semantics.

Verified 2026-10-31 against Local Router 1.1.0 (`main` @ `471d3f6`, production `:11434`):

- All three routes answer the canonical body; responses add `provider`, `dialect`, and a
  `local_router` provenance block (`attempts`, `translations`, `elapsed_ms`).
- `/v1/models` exposes `openrouter/jev-1.14` and `zenmux/jev-1.14` with
  `capabilities.decisions: true`. Both are pinned: served while the provider key is configured,
  regardless of catalog curation (decision ids are also reserved, so a chat model cannot shadow
  them).
- Failover is availability-only: `401/403/404/429/5xx`, a timeout, or a malformed/partial answer is
  recorded and the next keyed provider answers. If every provider rejects the contract
  (`400/422`), the caller gets that error — never a silent default.
- ZenMux speaks the `zenmux` dialect (strict array body: `{model, input, questions:[{name, type,
  choices|levels}]}`) and has **no noul primitive**; the router carries a noul as a calibrated
  two-way choice and converts back, marking the answer `translated_from: "choice"`. On 2026-10-31
  its route still answered `404 model_not_supported` for `typesafe/jev-1.14`, so a
  `zenmux/jev-1.14` request was served by OpenRouter with both attempts in provenance.
- Forcing the fallback transport is reproducible: export a deliberately invalid
  `OPENROUTER_API_KEY`, then `ainish-rag decide` reports
  `source: local-router:http://127.0.0.1:11434/api/alpha/decisions:typesafe/jev-1.14-20261014`.
  The router's own diagnostics are `GET /api/decisions/status[?probe=true]`.

## Request body

```json
{
  "model": "typesafe/jev-1.14",
  "state": "file src/rag/src/provider.rs resolves embedding credentials...",
  "questions": {
    "needs_retrieval": {
      "type": "noul",
      "instructions": "Does answering this require repository context?",
      "criteria": {
        "true": "the answer depends on files or history in this repository",
        "false": "the request is answerable from general knowledge"
      }
    },
    "component": {
      "type": "choice",
      "instructions": "Which component does this state describe?",
      "options": ["provider_resolver", "http_server"],
      "criteria": {
        "provider_resolver": "resolves keys from env or the PQC store",
        "http_server": "binds a port and serves HTTP"
      }
    },
    "utility": {
      "type": "score",
      "instructions": "How directly does this state answer the question?",
      "levels": [1, 2, 3, 4, 5],
      "criteria": [
        "no relevant fact",
        "mentions the topic only",
        "partial evidence",
        "names the exact resolver",
        "a complete, quotable answer"
      ]
    }
  }
}
```

Rules that the service enforces:

- `questions` is an object keyed by id; ids are echoed back and are **not** sent to the model.
- `criteria` is mandatory for `noul`, `choice`, and `score`. A missing `criteria` returns
  `400 invalid_type` and no answers.
- `choice.criteria` is an **object** keyed by option name; `score.criteria` is an **array** with
  one entry per level; `noul.criteria` is an object with `true` and `false`.
- `score.levels` is `[1..n]`; the answer is continuous in `[0, n-1]`.
- Questions are answered independently and in parallel; they cannot see one another or each
  other's answers. Context needed by one question belongs in its `instructions`.

## Response body

```json
{
  "model": "typesafe/jev-1.14-20261014",
  "answers": {
    "needs_retrieval": { "type": "noul", "noul": 0.95 },
    "component": {
      "type": "choice",
      "choice": "provider_resolver",
      "probabilities": { "provider_resolver": 1, "http_server": 0 },
      "confidence": 1
    },
    "utility": {
      "type": "score",
      "score": 3.61,
      "legend": { "0": "no relevant fact", "1": "mentions the topic only" },
      "probabilities": { "0": 0, "1": 0.01, "2": 0.02, "3": 0.33, "4": 0.64 },
      "confidence": 0.67
    }
  },
  "usage": { "input_tokens": 484, "output_tokens": 76, "cost": 0 },
  "id": "gen-dec-...",
  "provider": "TypeSafe"
}
```

- `answers` is the container. Older integrations that read `decisions` or `value`/`probability`
  are parsing a shape this endpoint no longer returns; `decision.rs` and `rag.py` accept both, but
  new code must target `answers`.
- `noul` is a probability, not a boolean. Apply bands in code (≥ 0.70 yes, ≤ 0.30 no, between
  unsettled).
- `confidence` is distribution concentration, not correctness.
- `usage.cost` is returned per call; decisions are inexpensive but not free — batch questions per
  state rather than calling once per question.

## Error semantics

| Status | Meaning | Handling |
| :--- | :--- | :--- |
| `400` with `expected record ... criteria` | contract violation in the request | fix the question builder; do not retry |
| `400` with `Model ... does not exist` | retired or wrong model id | retry the next known decision model |
| `401`/`403` | key invalid or unauthorized | surface the error and keep the local fallback; do not silently downgrade |
| `429` | rate limited | back off and retry once; rerank batches should degrade to local |
| `5xx` | upstream failure | treat as an error, not as an answer |

A transport failure must never be interpreted as `false`, `no`, or "not relevant" in code.

## Minimal curl probe

```bash
# Key stays in the environment; never inline it in a recorded command.
export OPENROUTER_API_KEY="$(pqc-secrets export --json \
  | python -c 'import json,sys;print(json.load(sys.stdin)["secrets"].get("LOCALROUTER_OPENROUTER_API_KEY",""))')"

curl -sS https://openrouter.ai/api/alpha/decisions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"typesafe/jev-1.14","state":"file src/rag/src/store.rs uses lancedb",
       "questions":{"q":{"type":"noul","instructions":"Does this file use a vector database?",
       "criteria":{"true":"it connects to LanceDB","false":"it does not touch a vector store"}}}}'
```

The dependency-free equivalent is `scripts/jev_probe.py`.
