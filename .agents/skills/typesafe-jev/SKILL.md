---
name: typesafe-jev
description: >
  TypeSafe Jev (System One) decision models over OpenRouter's Decisions API, integrated into
  ainish-rag for calibrated retrieval routing, two-stage reranking, context freshness, and
  faithfulness evaluation, plus opt-in TypeSafe image and Box prototypes. Use when a judgment about code, documentation, or task state needs a
  calibrated probability instead of a keyword heuristic, when tuning or debugging the route,
  rerank, orient, gate, decide, or eval behaviour of ainish-rag, or when authoring typed noul,
  choice, and score questions with explicit criteria for any repository that ran
  ainish-coder --rules.
---

# TypeSafe Jev decision craft for ainish-rag

This pack is the operating manual for the decision layer that every `ainish-coder --rules`
target inherits: **Jev supplies calibrated judgments about state; code owns the decision.**
It documents the live contract we call, the exact questions this repository asks, the
thresholds code applies, and the workflow agents should follow so context from the wiki, the
vector index, the memories, and the coordination ledger coheres into one answer instead of
four competing ones.

## Quick surface

| Need | Command |
| :--- | :--- |
| Route a request (retrieval? domain? freshness? specificity? strategy?) | `ainish-rag route "<request>" --json` |
| Ask one calibrated yes/no | `ainish-rag decide "<state>" --question "<question>" --json` |
| Ask a typed batch (noul + choice + score) | `ainish-rag decide "<state>" --questions '<json>' --json` |
| Rerank retrieved chunks with judgments | `ainish-rag query "<request>"` (rerank is on by default) or `ainish-rag rerank "<request>"` |
| Check an answer against evidence | `ainish-rag eval --context "<evidence>" --output "<answer>" --json` |
| Probe the live model | `python .agents/skills/typesafe-jev/scripts/jev_probe.py --questions '<json>' --state "<state>"` |
| Probe TypeSafe image/Box support | `python .agents/skills/typesafe-jev/scripts/jev_probe.py --api-url https://api.typesafe.ai/v1/systemone --typesafe-key-name TYPESAFE_API_KEY --images --questions '@questions.json' --state-file state.json` |

The default transport order is **Local Router**, **OpenRouter**, configured direct **Jev/TypeSafe**,
then configured **local-model** (`JEV_LOCAL_MODEL_URL`). Set `JEV_TRANSPORT_PRIORITY` to reorder
these four stages. Every command degrades to a calibrated local heuristic only when all configured
stages fail, and says so in `source` (`local-router:<url>:<model>`, `openrouter:typesafe/jev-1.14-20261014`,
`jev:typesafe/jev-1.14`, `local-model:<url>`, or `local-calibrated`).
**A failed Jev call is an error, not a "no"** — read `source` before trusting an answer.

## Image and Box capabilities (danger zone)

The upstream TypeSafe skill is installed here as this repository's `typesafe-jev` pack and is
kept aligned with the upstream MIT skill guidance. Jev 1.13 and 1.14 accept image references in
`state`, question `instructions`, and question `criteria`; Jev 1.14 adds the `box` primitive for
normalized `{top, bottom, left, right}` bounding boxes. Send each image once in the top-level
`assets` map, reference it with a collision-resistant key, and send
`TypeSafe-Danger-Zone-Images: true` on every request containing an image or Box question.

These features are explicitly **dreamer-ready**, not production-ready: request syntax, limits,
accuracy, and answers may change. A Box always returns a box, even when the target is absent, so
pair it with a Noul presence check and ignore the box when the Noul is below the application's
threshold. Use confidence only as an application-controlled review signal; TypeSafe publishes no
recommended Box threshold. Keep image questions narrow, decompose multimodal judgments, crop
large images before locating small targets, and never let an image answer authorize a destructive
action without deterministic validation or human review.

See [image-capabilities.md](references/image-capabilities.md) for the current synopsis, request
shape, and project-specific adoption map. The dependency-free probe supports `--images` and
explicit `--api-url`; it resolves keys from the environment or PQC store without printing them.

## The judgment/decision split

Do not ask Jev to decide. Ask it for the inputs a decision needs, then write the decision in code.

- Bad: "Should this context be included in the agent's prompt?"
- Good: "Does this excerpt state the symbol the query names?" + "How directly does it answer the
  query?" → code combines the two with a threshold it owns.
- Bad: "Is this codebase secure?"
- Good: "Is a SQL query built here by string concatenation?" (one judgment per question).

This split is why `ainish-rag` keeps questions, weights, and thresholds in the engine rather
than in a model prompt: they are auditable, testable, and stable across model upgrades.

## Contract essentials

The engine calls OpenRouter's Decisions API (`https://openrouter.ai/api/alpha/decisions`) with
the OpenRouter key resolved in memory from the environment or the PQC store. The full request and
response schema, including the failure modes that silently produce defaults, is in
[references/api-contract.md](references/api-contract.md). The essentials:

- **Model** — always the latest decision model, `typesafe/jev-1.14` (responses report the dated
  build, e.g. `typesafe/jev-1.14-20261014`). There is **no automatic downgrade** to older Jev ids:
  `JEV_DECISION_MODEL` is a diagnostic pin that `ainish-rag secrets` reports, and a retired id
  fails the call with its reason instead of silently using an older model.
- **Transports** — Local Router is primary, followed by OpenRouter, direct Jev/TypeSafe when
  `JEV_API_URL` or `TYPESAFE_API_URL` and a `TYPESAFE_API_KEY`-family secret are configured, then
  a decisions-compatible local model at `JEV_LOCAL_MODEL_URL` (optional
  `JEV_LOCAL_MODEL_API_KEY`). Local Router
  (`http://127.0.0.1:11434`, override with `JEV_LOCAL_ROUTER_URL`) is an *additional typed
  transport*: `/api/alpha/decisions`, `/v1/decisions`, and `/decisions` accept this contract,
  advertise pinned `openrouter/jev-1.14` (and `zenmux/jev-1.14` when that key is configured) on
  `/v1/models`, and fail over between keyed providers while reporting `provider`/`dialect`/
  `attempts`. A chat-only alias (`openrouter-jev-router`) is general chat — it can be served by any
  model — and is never substituted for typed, calibrated decisions. `ainish-rag secrets` names the
  usable route. Direct Jev and local-model stages are opt-in and skipped when their endpoint is not
  configured.
- **Questions** — a JSON object keyed by question id. Every `noul`, `choice`, and `score`
  question **must** carry `criteria`; the API rejects the request without it.
  - `noul`: `criteria: { "true": "...", "false": "..." }` → answer `noul` (0–1).
  - `choice`: `options: [...]` plus `criteria: { option: description }` → answer `choice` +
    `probabilities` + `confidence`.
  - `score`: `levels: [1..n]` plus `criteria: [criterion per level]` → answer `score` in
    `[0, n-1]` (continuous), `probabilities`, `legend`.
- **Answers** live under `answers`, not `decisions`. Legacy `decisions`/`value`/`probability`
  shapes are tolerated for older stores, but new code should target the typed shape.
- **State** is shared by every question in the batch. Context that only one question needs
  belongs in that question's `instructions`, not in the state.

## How ainish-rag uses Jev

The exact question text, criteria, weights, and fallbacks are catalogued in
[references/rag-decision-catalog.md](references/rag-decision-catalog.md). Summary:

| Surface | Judgments requested | Code decision |
| :--- | :--- | :--- |
| `route` | needs_retrieval (noul), domain_target (choice over 5 domains), context_freshness (noul), query_specificity (choice), modality_preference (choice) | `needs_retrieval = p >= 0.5`; code derives `retrieval_strategy` (`skip_retrieval`/`symbol_anchored`/`hybrid_rerank`/`fresh_orient_first`/`multi_hop_expand`) and `candidate_pool_size`; `orient --inject` injects the hint |
| `rerank` | per candidate: answers_directly (noul), names_query_symbols (noul), utility (score 5), chunk_role (choice) | `0.45*direct + 0.25*symbols + 0.30*utility`, generated/test discounted, settled primaries +0.04, CRAG hard negatives suppressed (0.12, 80/20 cap), blended 70/30 (65/35 unsettled), kept above `--min-relevance`; `context_sufficiency` reports whether the set is enough and triggers one corrective pass |
| `eval` | is_faithful (noul), faithfulness_score (score 5), contradicts_context (noul), completeness_score (score 5) | `0.6*noul + 0.4*score_norm`, contradiction veto at ≥ 0.70; `verdict_band` = `grounded`/`contradiction_detected`/`unsettled_grounding`/`unsupported` |

Calibrated bands: **≥ 0.70 reads as yes, ≤ 0.30 as no, and the band between is unsettled** —
code must handle the unsettled case explicitly (usually with the vector score or by asking a
narrower question). `confidence` describes how concentrated an answer's distribution is; it is
**not** the probability that the answer is correct, so never use it as the gate.

## Authoring a new question

1. Start from the decision code that will consume the answer. If no code maps the answer to an
   action, the question is at the wrong layer.
2. Pass the human test: could a smart person answer at a glance from the state and question
   alone? If not, improve the state or split the question.
3. Ask one observable thing in plain language. Avoid "or", avoid rules lists, avoid prompt
   preambles and output-format instructions.
4. Put descriptions in `criteria`, not in the question. Name the confusing case there
   ("a question about the refund policy is not a refund request").
5. Send every question for one state in **one** request; Jev answers them in parallel and the
   state is read once.
6. Probe live on representative, hard, and negative cases before wiring a threshold. Keep the
   exact payload for each case so results are reproducible.

## Agent workflow (context coherence)

Use the decision layer to sequence work, not to replace reading:

1. **Orient** — `ainish-rag orient --inject` for the wiki primer, recent memories, and open
   ledger notes.
2. **Route** — `ainish-rag route "<request>" --json`. If `needs_retrieval` is false, answer from
   general knowledge. Otherwise use `target_domain` to choose the first source (code symbols vs
   architecture wiki vs security policy vs technical debt) and `context_freshness` to choose
   between the wiki (stable) and a fresh orient/index pass (recent changes).
3. **Retrieve** — `ainish-rag query "<request>" --code` or without `--code`; reranking is on by
   default. Read `decision_score`, `decision_probability`, `decision_role`, `noul_band`,
   `context_sufficiency`, and `rationale`. Prefer `implementation` over `documentation` for
   how-it-works answers, and distrust `generated` chunks even when their vector score is high. When
   sufficiency is `partial_unsettled` or `insufficient`, the engine has already run one corrective
   expansion pass — if it is still partial, retrieve more or narrow the question.
4. **Check the plan** — for multi-step work, ask `decide --questions` whether the plan depends on
   facts you have not retrieved (one noul per assumption). An unsettled band is a signal to go
   read, not to guess.
5. **Verify** — before claiming completion, run `eval --context "<retrieved evidence>" --output
   "<your summary>"`. A `grounded` verdict is evidence-bound; a `contradiction_detected` verdict
   means rewrite, not cite; `unsettled_grounding`/`unsupported` means retrieve more.
6. **Record** — write durable facts to `.agents/memories/{date}-memory.txt` and coordination
   events to the COMMS ledger, so the next session's orient primer inherits them.

For a deeper treatment of multi-agent coherence, question design, and when to escalate to a
reasoning model, see [references/agent-coherence.md](references/agent-coherence.md).

## Reading answers without fooling yourself

- Report and act on the **probability**, not just the top option. A choice at 0.55 is a coin
  flip; a noul at 0.5 means the state does not settle the question.
- Look at `probabilities` for scores; a two-peaked distribution is not a confident middle.
- Do not tune thresholds to individual test cases. 0.7/0.3 are starting bands, not laws.
- Treat a failed request, a 400, or an empty `answers` object as an error. Never let a transport
  failure become an implicit "false" in code.

## Failure modes and recovery

| Symptom | Cause | Fix |
| :--- | :--- | :--- |
| `Jev API 400 ... expected record ... criteria` | question sent without `criteria` | use the builders in `src/rag/src/decision.rs` / `DecisionEngine.*_question` |
| `Model ... does not exist` | pinned model retired | unset `JEV_DECISION_MODEL` (the latest is `typesafe/jev-1.14`); the engine never downgrades on its own |
| `source: local-calibrated` when a key exists | key name mismatch | store `LOCALROUTER_OPENROUTER_API_KEY` (consumer prefix), `PSIONICS_OPENROUTER_API_KEY`, or `OPENROUTER_API_KEY`; any `<CONSUMER>_OPENROUTER_[EMBED_]API_KEY` suffix now resolves; check `ainish-rag secrets` |
| `source: openrouter` but the local router should be used | transport order is OpenRouter-first by default | set `JEV_TRANSPORT_PRIORITY=local-router,openrouter` |
| `secrets` shows a local-router with `Decisions Route: none` | the router advertises Jev but exposes no decisions route | check `GET /api/decisions/status` (routes, providers, `?probe=true`); the engine prefers that zero-token fast path before `/v1/models`; a chat-only `openrouter-jev-router` entry is general chat and stays unusable for typed decisions |
| answers all defaults | response parsed from the wrong shape | read `answers`, then `noul`/`choice`/`score` |
| slow rerank | one request per candidate | send the batch once; the engine already bundles up to 12 candidates |

## Probing and calibration

`scripts/jev_probe.py` sends a typed batch with the same contract and prints the raw answers,
without ever printing the key. Use it to validate wording, criteria, and representative cases
before changing engine thresholds. See
[references/calibration-and-testing.md](references/calibration-and-testing.md) for the probing
protocol, negative cases, and yellow flags (prompt gymnastics, per-case thresholds, tests that
assert exact probabilities).

## References

- [references/api-contract.md](references/api-contract.md) — endpoint, auth, request/response
  schema, model ids, error semantics.
- [references/rag-decision-catalog.md](references/rag-decision-catalog.md) — every question,
  criterion, weight, and threshold the engine uses, with file anchors.
- [references/agent-coherence.md](references/agent-coherence.md) — workflow for routing context,
  composing judgments into decisions, and keeping multi-agent work consistent.
- [references/calibration-and-testing.md](references/calibration-and-testing.md) — live probing,
  threshold calibration, and anti-patterns.
- [references/image-capabilities.md](references/image-capabilities.md) — TypeSafe image/Box
  synopsis, Jev 1.14 changes, and safe adoption ideas for existing projects.
- Upstream guidance — `https://docs.typesafe.ai/llms.txt` and the TypeSafe skill at
  `https://github.com/typesafe-ai/skills`.
