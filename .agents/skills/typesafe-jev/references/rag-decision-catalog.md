# ainish-rag decision catalog

Every judgment the engine asks Jev, with the code decision that consumes it. Anchors are to the
current tree; when you change a question, change this file in the same commit and re-probe live.

Implementation anchors:

- Rust client, builders, parser: `src/rag/src/decision.rs`
- Python parity: `src/rag/rag.py` (`DecisionEngine`)
- Command surfaces: `src/rag/src/main.rs` (`route`, `rerank`, `decide`, `eval`, `orient`, `secrets`)
- Retrieval blend: `store.rs` (`search_vector`) → `decision.rs` (`rerank`)

Shared policy: noul bands **≥ 0.70 yes / ≤ 0.30 no / between unsettled**; decisions in code, never
in the question.

## Transport priority

Both upstream transports are attempted before any local heuristic:

1. **OpenRouter Decisions API** (`https://openrouter.ai/api/alpha/decisions`, latest
   `typesafe/jev-1.14`).
2. **Local Router** (`http://127.0.0.1:11434`, override `JEV_LOCAL_ROUTER_URL`), discovered via
   `GET /api/decisions/status` (zero-token fast path: `ready`, `routes`, `advertised_models`) and
   then `/v1/models` + a minimal typed probe of `/api/alpha/decisions`, `/v1/decisions`,
   `/decisions`. A chat-only entry is reported, never substituted.
3. Calibrated local heuristic only when both transports fail.

`JEV_TRANSPORT_PRIORITY=local-router,openrouter` flips 1 and 2 (the local router then receives the
keyed request first; the OpenRouter key is still never sent to loopback). `source` always names the
transport that answered: `openrouter:<dated-model>`, `local-router:<url>:<model>`, or
`local-calibrated`.

## route — `ainish-rag route "<request>"`

Five judgments in one request; state is the request text.

| id | type | question | criteria |
| :--- | :--- | :--- | :--- |
| `needs_retrieval` | noul | Does answering this request require retrieving this repository's code, architecture wiki, or coordination context instead of relying on general knowledge? | true — the answer depends on files, symbols, documentation, or task history in this repository; false — the request is self-contained or answerable from general knowledge |
| `domain_target` | choice | Which part of this repository's context would best answer the request? | `codebase_symbols` source/symbols/APIs · `architectural_wiki` architecture/data flow/design · `security_governance` policy/PQC/secrets/audit · `technical_debt` gaps/TODOs/drift · `general_knowledge` language/tooling |
| `context_freshness` | noul | Does the request concern recent changes, the current branch, or today's work rather than long-lived architecture? | true — recent edits, uncommitted work, current branch, today's activity; false — stable architecture or long-lived behaviour |
| `query_specificity` | choice | How specific is the lookup required by this request? | `exact_symbol` names a function/struct/file/flag/error · `conceptual_flow` asks how a subsystem works · `broad_audit` multi-file audit or repo-wide scan |
| `modality_preference` | choice | Which artefact modality should retrieval prioritize first? | `code_first` · `docs_first` · `balanced` |

Code decision (`derive_retrieval_strategy`):

| Calibrated signal | Strategy | Pool | Context budget |
| :--- | :--- | :--- | :--- |
| `needs_retrieval = no` or `general_knowledge` | `skip_retrieval` | 0 | 0 |
| `context_freshness ≥ 0.70` | `fresh_orient_first` | 12 | 2600 |
| `query_specificity = exact_symbol` | `symbol_anchored` | 10 | 1200 |
| `query_specificity = broad_audit` | `multi_hop_expand` | 16 | 3600 |
| `conceptual_flow` + `code_first` | `symbol_anchored` | 12 | 1200 |
| otherwise | `hybrid_rerank` | 12 | 2000 |

- `target_domain` and `route_confidence` are reported, not acted on blindly.
- `context_freshness` drives source choice: high → `ainish-rag orient --inject` + index; low → wiki
  and stable docs first.
- `context_budget_tokens` is the context-engineering ceiling for the turn: `orient --inject` sizes
  its sections to it (`default_lines.min(budget / 12 / sections)`, floor 3), and `next_action` is the
  one-line harness action that leads the primer.
- `orient --inject` injects the routing hint and domain-weights wiki sections from `target_domain`.
- Fallback: `route_local` keyword/calibration; `source: local-calibrated`.

Output (JSON): `needs_retrieval`, `retrieval_probability`, `target_domain`, `route_confidence`,
`context_freshness`, `query_specificity`, `modality_preference`, `retrieval_strategy`,
`candidate_pool_size`, `context_budget_tokens`, `next_action`, `source`.

## rerank — `ainish-rag query` / `rerank`

One request, up to 12 candidates (or the route's pool size). State carries the query and the task;
each question carries that candidate's own excerpt (questions cannot see each other).

| id pattern | type | question | criteria |
| :--- | :--- | :--- | :--- |
| `answers_directly_{i}` | noul | Does this excerpt provide the specific fact, symbol, or implementation the query needs? | true — states the definition/behaviour/symbol asked for; false — topically related or answers a different question |
| `names_query_symbols_{i}` | noul | Does this excerpt contain any symbol, file, or API named in the query? | true — at least one named symbol/API appears; false — none appear |
| `utility_{i}` | score 5 | How useful is this excerpt for answering the query? | unrelated → tangential background → related but incomplete → directly useful evidence → canonical implementation/reference |
| `chunk_role_{i}` | choice | What kind of artefact is this excerpt from? | `implementation`, `documentation`, `test`, `generated` |

Code decision (CRAG-aware blend):

```
decision = 0.45*direct + 0.25*symbol_support + 0.30*(utility/4)
bonus    = +0.04 when role == implementation and direct >= 0.70 and symbol_support >= 0.50
penalty  = 0.08 if role == "generated" else 0.03 if role == "test" else 0
adjusted = clamp(decision + bonus - penalty - distractor_penalty, 0, 1)

distractor_penalty = 0.12 when direct <= 0.30 and utility < 2   # CRAG hard negative
combined = (adjusted*0.80 + min(vector,0.45)*0.20) when hard negative
         = (adjusted*0.65 + vector*0.35) when direct is unsettled
         = (adjusted*0.70 + vector*0.30) otherwise
keep     = combined >= --min-relevance
```

- `direct >= 0.5` sets `decision_relevance`; `noul_band` records the calibrated band.
- Sorting is by `combined`; `decision_score` is the pre-vector decision value.
- `rationale` records direct band, symbol support, utility, role, and vector score so an agent can
  explain why a chunk was chosen.
- `context_sufficiency` is computed across the top results:
  `sufficient` (settled primary `yes` with utility ≥ 2.4 or top ≥ 0.62),
  `insufficient` (empty, all `no`, or top < 0.42),
  `partial_unsettled` otherwise. `partial_unsettled`/`insufficient` triggers **one** CRAG corrective
  pass: high-signal symbols/file stems from the top candidates expand the query, new candidates are
  merged, and the batch is reranked once more.
- Fallback: RRF hybrid fusion in `rerank_local` (`source: local-calibrated-rrf`).

Output fields added per hit: `decision_score`, `decision_relevance`, `decision_probability`,
`decision_utility`, `decision_role`, `symbol_support`, `noul_band`, `rerank_source`, `rationale`.

## eval — `ainish-rag eval --context … --output …`

| id | type | question | criteria |
| :--- | :--- | :--- | :--- |
| `is_faithful` | noul | Is the output grounded in the provided context, without claims the context does not support? | true — every claim is supported; false — adds claims or specifics the context does not contain |
| `faithfulness_score` | score 5 | How completely does the output stay within the provided context? | contradicts → mostly unsupported → partly grounded → grounded with minor gaps → fully grounded |
| `contradicts_context` | noul | Does the output state any claim, rule, or detail that directly contradicts or inverts the provided context? | true — at least one claim conflicts/inverts the context; false — no contradiction |
| `completeness_score` | score 5 | How completely does the output cover the key facts, symbols, and constraints in the provided context? | omits almost all → minor part → main point with omissions → nearly all → comprehensive |

Code decision:

```
faithfulness = 0.6*noul + 0.4*(score/4)
if contradicts >= 0.70: faithfulness = min(faithfulness, 1 - contradicts)
is_faithful  = not contradiction and noul >= 0.5 and score_norm >= 0.4

verdict_band = contradiction_detected  when contradicts >= 0.70
             = grounded                when noul >= 0.70 and score_norm >= 0.60
             = unsupported             when noul <= 0.30 or score_norm < 0.40
             = unsettled_grounding     otherwise
```

`completeness_score` is normalized to `[0,1]` and reported alongside `contradiction_probability` and
`hallucination_risk`. Fallback: lexical grounding heuristic (`evaluation_source: local-heuristic`).

## decide — arbitrary typed batches

`ainish-rag decide "<state>" --questions '<json>'` sends any noul/choice/score batch using the same
builders and returns:

```json
{
  "state": "...",
  "model": "typesafe/jev-1.14-20261014",
  "source": "openrouter:typesafe/jev-1.14-20261014",
  "answers": [ { "id": "...", "type": "noul", "noul": 0.93, "choice": null, "score": null } ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "cost": 0 }
}
```

Use it for plan assumptions, risk triage, and any judgment that does not warrant a new engine
surface. `--question` is a shortcut for a single noul with generic criteria; prefer `--questions`
with explicit criteria when precision matters.

## Thresholds and weights

| Constant | Value | Where |
| :--- | :--- | :--- |
| noul yes / no bands | 0.70 / 0.30 | `JEV_NOUL_YES` / `JEV_NOUL_NO` |
| rerank blend | decision 70% / vector 30% (65/35 unsettled, 80/20 hard negative) | `rerank_via_jev` |
| decision mix | 45% direct / 25% symbols / 30% utility | `rerank_via_jev` |
| role penalty | generated 0.08, test 0.03 | `rerank_via_jev` |
| primary bonus | +0.04 (implementation, direct ≥ 0.70, symbols ≥ 0.50) | `rerank_via_jev` |
| CRAG hard-negative penalty | 0.12 (direct ≤ 0.30, utility < 2) | `rerank_via_jev` |
| sufficiency | sufficient ≥ 0.62 or settled primary; insufficient < 0.42 or all `no` | `evaluate_context_sufficiency` |
| corrective pass | one expansion round, max 6 anchors | `extract_corrective_expansion_terms` |
| faithfulness mix | 60% noul / 40% score, contradiction veto | `evaluate_faithfulness` |
| candidate cap | 12 per request | `rerank_via_jev` |
| request timeout | 8 s (`AINISH_RAG_TIMEOUT`) | `DecisionEngine::new` |

Changing any of these is a behaviour change: probe on cases you did not tune on, update this
catalog, and keep the fallback intact.

## Degradation policy

- Transport order: OpenRouter Decisions (latest `typesafe/jev-1.14`) ↔ Local Router decisions route
  (order from `JEV_TRANSPORT_PRIORITY`, default OpenRouter first) → the calibrated local heuristic
  (`source: local-calibrated`). There is no downgrade to older Jev models.
- No key or unreachable APIs → `source` names the local fallback; the command still answers.
- API error (400/401/5xx) during rerank → that rerank falls back locally; the command continues.
- API error during `decide --questions` → the command exits with an error (no invented answer).
- A local-router that only serves Jev over chat completions is reported by `ainish-rag secrets`
  and is never used for typed decisions.
- Never treat a transport failure as a negative judgment.
