# Local Router Improvement Guide

This document is the working guide for AI agents and maintainers improving Local Router logic. Keep it current when changing router scoring, defaults, telemetry, exports, or UI behavior.

## Router Goals

- Present local router models as `local-router/<router-name>`.
- Select only from explicit user-configured candidate models.
- Fail closed when no candidate is eligible.
- Keep request-time routing lightweight and deterministic by default.
- Store only non-secret configuration and redacted telemetry.
- Keep implementation in TypeScript/Node unless there is a clear project-wide reason to add another runtime.

## Current Files

- `src/index.ts`: router API, persistence, scoring, execution, UI, metadata presentation, CSV exports.
- `~/.config/local-router/router-models.json`: persisted router definitions, non-secret, `0600`.
- `~/.config/local-router/router-events.csv`: redacted decision telemetry, non-secret, `0600`.
- `GET /api/router-candidates.csv`: exportable candidate metadata.
- `GET /api/router-events.csv`: exportable decision telemetry.

## Default Auto Router Profile

Use these defaults when creating a new router and when resetting the router form:

- Type: `auto-local`
- Minimum coding score: `0.66`
- Cost/quality tradeoff: `7`
- Candidate list:

```text
openrouter-1-million-chain-of-draft, coding=0.88, input=1, output=2, latency=1200, notes=DeepSeek V4 Pro + DeepSeek V4 Flash + Xiaomi MiMo-V2.5-Pro
openrouter-chain-of-draft, coding=0.86, input=1, output=2, latency=1300, notes=DeepSeek V4 Pro + MoonshotAI Kimi K2.6 + Xiaomi MiMo-V2.5-Pro
openrouter-openrouter-personal-router, coding=0.84, input=1, output=2, latency=1100, notes=DeepSeek V4 Pro + MoonshotAI Kimi Latest + Xiaomi MiMo-V2.5-Pro
openrouter-1-million-main, coding=0.82, input=1, output=2, latency=1000, notes=DeepSeek V4 Pro + DeepSeek V4 Flash + Xiaomi MiMo-V2.5-Pro
openrouter-free-chain-of-draft, coding=0.72, input=0, output=1, latency=1500, notes=Composition unconfirmed
```

Rationale:

- OpenRouter Auto Router uses model capability, prompt complexity, price, latency, and availability signals, with an industry-style cost/quality tradeoff default of `7`.
- Pareto Code Router uses `min_coding_score` and tiered coding quality. A `0.66` floor maps to a high-quality coding default while still allowing users to lower the floor for cheaper/faster routes.
- Not Diamond-style routing is strongest when the candidate set is explicitly caller controlled and backed by evaluation data. Local Router should keep that explicit-candidate contract.
- The reset/clear form action should restore a complete usable auto-router profile, including candidate models, so users can tinker and then return to a known-good default.

## OpenRouter Preset Composition

Operator-provided preset composition as of 2026-05-27:

- `openrouter-1-million-main`: DeepSeek V4 Pro, DeepSeek V4 Flash, Xiaomi MiMo-V2.5-Pro.
- `openrouter-1-million-chain-of-draft`: DeepSeek V4 Pro, DeepSeek V4 Flash, Xiaomi MiMo-V2.5-Pro.
- `openrouter-chain-of-draft`: DeepSeek V4 Pro, MoonshotAI Kimi K2.6, Xiaomi MiMo-V2.5-Pro.
- `openrouter-openrouter-personal-router`: DeepSeek V4 Pro, MoonshotAI Kimi Latest, Xiaomi MiMo-V2.5-Pro.
- `openrouter-free-chain-of-draft`: composition not yet confirmed.

Use this information for candidate notes and Pareto-style scoring. Do not infer unconfirmed preset composition from naming alone.

## Router Types

`auto-local`

- Default for normal users.
- Filters candidates by request requirements, then scores by inferred quality, optional coding score, cost, latency, and cost/quality tradeoff.
- Best for "pick a good model from my allowed list" workflows.

`pareto-code`

- Best for coding-heavy routes.
- Uses `minCodingScore` as a quality floor.
- Scores eligible candidates using coding score, cost estimate, latency, and explicit order as a tie-breaker.

`priority`

- Best for deterministic manual fallback.
- Preserves user candidate order after eligibility filtering.

## Candidate Metadata

Candidate rows can be entered as:

```text
wafer-ai-deepseek-v4-pro, coding=0.86, input=1, output=2, latency=1200
openrouter-chain-of-draft, coding=0.80
xiaomi-mimo-mimo-v2.5-pro, coding=0.45
```

Supported fields:

- `coding`: 0 to 1 coding capability score.
- `input`: relative input cost.
- `output`: relative output cost.
- `latency`: expected latency in milliseconds.
- `notes`: short non-secret operator note.

Do not store prompts, responses, API keys, auth headers, local paths, `.env` values, or provider secrets in candidate metadata.

## Eligibility Rules

A candidate must be rejected before scoring when:

- The model ID does not resolve to a configured provider model.
- It points to another `local-router/*` route.
- The provider key is not configured.
- The request needs tools and the model lacks tool support.
- The request has images and the model lacks vision support.
- Approximate input plus requested output exceeds model context.
- Requested output exceeds model max output.
- `pareto-code` coding score is below `minCodingScore`.

## Improvement Loop

1. Export `/api/router-events.csv` and `/api/router-candidates.csv`.
2. Review aggregate outcomes by router, selected model, status, latency, and candidate score.
3. Add or adjust candidate metadata in `/config`.
4. Run integration tests.
5. Update this document and `llms.txt` when default policy changes.

Good future TypeScript tooling:

- `scripts/router-csv.mjs` or a TypeScript script compiled by the existing build chain.
- CSV import validation for router backups.
- A local recompute script that proposes updated candidate coding/cost/latency values from redacted event telemetry.
- A dry-run API that shows candidate eligibility and scores without calling an upstream provider.

Avoid adding a new runtime for router utilities unless TypeScript cannot reasonably solve the problem.

## Research Checklist For Agents

When researching router improvements, compare against:

- OpenRouter Auto Router: candidate allowlists, cost/quality tradeoff, selected-model transparency.
- OpenRouter Pareto Code Router: `min_coding_score`, quality tiers, same-tier fallback.
- Not Diamond: explicit caller-provided candidate sets, traceable decisions, evaluation-driven custom routers.
- DSPy: offline optimization against user-defined metrics, not request-time opaque routing.

Record findings in `llms.txt` with source URLs and update this file if the implementation policy changes.

## Safety Checklist

- No hidden model pools.
- No external router service by default.
- No prompt/response persistence.
- No secrets in JSON/CSV exports.
- No local path leakage in telemetry.
- No classical cryptography additions.
- No merge to main without user approval.

---

# Router Research & Improvement Opportunities (2026-05-27)

This section summarizes external routing research and maps it to concrete Local Router improvement opportunities. Each subsection covers a technique or finding, its source, and what Local Router should adopt.

## A. OpenRouter Auto Exacto: Statistical Tier System

**Source:** [OpenRouter Auto Exacto announcement (March 2025)](https://openrouter.ai/announcements/auto-exacto)

### What it does

Auto Exacto replaced static hand-curated provider lists with a dynamic, automated system that re-evaluates providers roughly every 5 minutes across three signals:

1. **Throughput** — tokens-per-second generation speed from production traffic.
2. **Tool-call telemetry** — JSON validity, schema conformance, and tool name accuracy (billions of calls since August 2025).
3. **Benchmark scores** — TauBench Airline (agentic tool-calling eval) and GPQA-Diamond (knowledge/reasoning), run on a recurring schedule.

### Statistical Method

Uses **median and median absolute deviation (MAD)** per model across all providers. A provider is flagged only if it is a statistical outlier relative to its peers on that specific model. Three tiers:

- **Verified good** — sufficient data, nothing abnormal.
- **Insufficient data** — not enough traffic to judge (placed in the middle, not penalized).
- **Deranked** — statistical outliers pushed to the back.

Within each tier, original price/latency ordering is preserved. No composite score — just push low performers back. Full audit trail persisted per recomputation.

### Results

- GLM-5: 88% drop in tool call error rate (~8% → ~1%).
- DeepSeek V3.2: 16% drop in error rate; TauBench scores 69% → 74%.
- Per-model provider tool call accuracy exposed in a public performance tab.

### Local Router Adoption Opportunities

1. **Tool-call success tracking in telemetry** — The current `router-events.csv` captures status and error_type but does not track tool-call correctness. Add `tool_calls_requested`, `tool_calls_valid_json`, `tool_calls_schema_ok`, and `tool_calls_name_match` columns. These can be derived from upstream responses when diagnostics are enabled without storing full tool call payloads.

2. **Statistical outlier detection for candidate quality** — When router events accumulate enough data per candidate model (e.g., 50+ requests), compute median and MAD for success rate and latency. Flag candidates that are statistical outliers in the `/config` UI and in `router-candidates.csv` exports. This gives users data-driven signals about which candidates are underperforming.

3. **Tier-based candidate ordering within existing router types** — Add an optional `enableAutoTiers` flag to router models. When enabled and sufficient telemetry exists, eligible candidates are grouped into verified/insufficient/deranked tiers before within-tier scoring. This preserves the existing scoring policy while pushing unreliable candidates to the back.

4. **Recurring benchmark runs (future)** — A TypeScript script that sends standardized coding prompts to each candidate model and records success/failure, latency, and output quality. This is a heavier lift but would provide the benchmark signal that Auto Exacto uses. Start with a small benchmark suite (5-10 coding tasks) run on demand via a new API endpoint.

## B. RouteLLM: Learned Scoring Architectures

**Source:** [RouteLLM: Learning to Route LLMs with Preference Data (LMSys, arXiv 2406.18665, revised Feb 2025)](https://arxiv.org/abs/2406.18665)

### What it does

RouteLLM trains a binary router (strong vs weak model) using human preference data from Chatbot Arena. Four router architectures, ordered by complexity:

| Architecture | Throughput | Cost/million reqs | APGR (MT Bench) | Training |
|---|---|---|---|---|
| SW Ranking (Bradley-Terry + cosine similarity) | 2.9 req/s | $39.26 | 0.746 | None (inference-time) |
| Matrix Factorization (bilinear scoring) | 155 req/s | $3.32 | **0.802** | 10 epochs, 8GB GPU |
| BERT Classifier (BERT_BASE + logistic head) | 69 req/s | $3.19 | 0.723 | 2000 steps, 2×L4 |
| Causal LLM (Llama 3 8B) | 42 req/s | $5.23 | 0.699 | 2000 steps, 8×A100 |

### Key Metrics

- **PGR (Performance Gap Recovered):** `(r(M_router) − r(M_weak)) / (r(M_strong) − r(M_weak))` — how much of the quality gap the router recovers.
- **APGR (Average PGR):** Integrated across cost thresholds 0%–100% strong-model calls — the area under the performance-vs-cost curve.
- **CPT(x%):** Minimum percentage of strong-model calls needed to achieve x% PGR.

### Key Findings

- Matrix factorization is the sweet spot: 155 req/s, best APGR, cheap to run.
- Routers transfer across model pairs (GPT-4/Mixtral → Claude Opus/Sonnet) without retraining.
- Up to 3.66× cost reduction at 95% of GPT-4 quality on MT Bench.
- Routing overhead is <0.4% of GPT-4 generation cost.

### Local Router Adoption Opportunities

1. **APGR-style telemetry metric** — Compute an Local Router analogue: for each router, measure what fraction of the quality gap between the best and worst eligible candidate was recovered. This gives users a single number for "how well is my router doing."

2. **Embedding-similarity candidate scoring (the SW Ranking approach)** — The current `inferredCodingScore` uses regex on model names. A better approach: compute a lightweight query embedding (e.g., TF-IDF over code keywords in the prompt) and compare cosine similarity against per-candidate historical success patterns. This would make `auto-local` routing context-aware without adding an external API call.

3. **Matrix factorization for candidate scoring (future)** — If enough redacted telemetry accumulates, train a small matrix factorization model (pure TypeScript, no GPU needed at this scale) that learns per-candidate and per-request-feature embeddings. The bilinear product predicts success probability. This replaces the current heuristic score formula with a learned one. Storage: a few KB of floats in `router-models.json`.

4. **Cost-threshold routing parameter** — Add a `costThreshold` parameter (0-1) to router models, inspired by RouteLLM's α. At low thresholds, the router favors cheaper models; at high thresholds, it favors quality. This is more intuitive than the current `costQualityTradeoff` (0-10) integer and maps directly to "route X% of requests to cheaper models."

## C. Bandit-Based Routing: Contextual Multi-Armed Bandits

**Sources:**
- [MAR: Multi-Armed Router (ICLR 2025)](https://openreview.net/pdf?id=AfA3qNY0Fq) — neural UCB for per-query LLM selection.
- [PILOT: Preference-Prior Informed LinUCB (EMNLP 2025)](https://www.emergentmind.com/topics/preference-prior-informed-linucb-pilot) — LinUCB with human preference priors. 93% of GPT-4 quality at 25% cost.
- [ParetoBandit (March 2026)](https://www.opentrain.ai/tools/hf-eval-papers/paper/ad9748f5-9cb3-4bc7-b071-d09ac1617e95/) — budget-pacing + geometric forgetting, 9.8ms routing latency.
- [LLM Bandit (ICLR 2025, arXiv 2502.02743)](https://arxiv.org/abs/2502.02743) — IRT embeddings for cold-start model onboarding.
- [Mahoraga (GitHub)](https://github.com/pockanoodles/Mahoraga) — open-source LinUCB orchestrator with 9-dim context vector.

### What they do

Contextual multi-armed bandits treat each candidate model as an "arm." For each request, the router observes a context vector (request features), predicts expected reward for each arm, and selects the arm with the highest upper confidence bound. After receiving the response, the router updates its model of each arm's reward distribution.

**Key algorithms:**

- **LinUCB** — Assumes linear relationship between context and reward. Computationally cheap, sublinear regret. Used by PILOT and Mahoraga.
- **Neural UCB** — Uses a small MLP per arm for non-linear reward prediction. Used by MAR.
- **dLinUCB** — Discounted LinUCB with geometric forgetting for non-stationary environments.

**Critical design decisions:**

| Decision | Best Practice | Why |
|---|---|---|
| Exploration strategy | UCB (upper confidence bound) | Sublinear regret; ε-greedy and Thompson Sampling show worse regret in LLM routing |
| Context vector | 5-10 features sufficient | Word count, code density, tool count, image count, approx input tokens, requested output tokens |
| Non-stationarity handling | Geometric forgetting (γ=0.98) or sliding window | Model quality and pricing change over time |
| Cold-start | Forced exploration phase (50-150 steps) + IRT priors | New models need bounded exploration before UCB can estimate their quality |
| Budget enforcement | Primal-dual pacing or knapsack policy | Keeps per-request cost within target without manual penalty tuning |

### Local Router Adoption Opportunities

1. **Implement `bandit-local` router type** — This is the highest-impact improvement. Use **dLinUCB** (discounted LinUCB with UCB) because:
   - It is computationally trivial (ridge regression, no GPU needed).
   - It has proven sublinear regret in LLM routing benchmarks.
   - It handles non-stationarity via geometric forgetting.
   - It is fully local — no external service, no data leaving the proxy.

   **Implementation sketch:**
   - Context vector (~6 dims): `[approxInputTokens/100000, requestedOutputTokens/100000, hasTools, hasImages, toolCount/10, messageCount/20]`
   - Per-candidate: `A` matrix (d×d), `b` vector (d×1), updated via online ridge regression after each request.
   - UCB: `score = θ^T·x + α·√(x^T·A⁻¹·x)` where α controls exploration width.
   - Reward signal: binary success (1) or failure (0) from upstream HTTP status.
   - Geometric forgetting: `A ← γ·A + x·x^T`, `b ← γ·b + reward·x` with γ=0.98.
   - Persist A and b matrices to `router-models.json` so learning survives restarts.

2. **Exploration budget parameter** — Add `explorationBudget` (0-1, default 0.05) to router models. This maps to the UCB exploration coefficient α. Higher values explore more (useful for new routers); lower values exploit more (useful for mature routers).

3. **Cold-start mode for new candidates** — When a candidate is added to an existing `bandit-local` router, force a minimum number of requests (e.g., 20) through that candidate before UCB selection kicks in. This ensures new candidates get enough data for reliable reward estimation.

4. **Reward signal enrichment** — Beyond binary success/failure, capture richer reward signals in telemetry:
   - `latency_ok`: whether latency was below the candidate's declared latency.
   - `tool_calls_ok`: whether tool calls were valid (if tools were requested).
   - Composite reward: `0.5 * success + 0.2 * latency_ok + 0.3 * tool_calls_ok`.

## D. Not Diamond: Custom Router Training & Prompt Adaptation

**Source:** [Not Diamond Docs (updated 2026)](https://docs.notdiamond.ai/docs/router-training-quickstart)

### What it does

Not Diamond trains custom routers from evaluation CSVs containing prompts, per-model responses, and numeric scores. It also offers "Prompt Adaptation" — an agentic system that automatically rewrites prompts for different target models, reporting 5-60% accuracy improvements for RAG, data extraction, and text-to-SQL.

### Key Numbers

- Minimum samples: 25 (recommended 50-100+).
- Training time: 5-15 minutes.
- Tradeoff modes: quality (default), cost, latency.
- Arena Mode: end-users vote on outputs for continuous personalization.

### Local Router Adoption Opportunities

1. **Import evaluation CSV for auto-local weight tuning** — Add `POST /api/router-models/:id/recompute` that reads `router-events.csv` for the given router, computes per-candidate success rates and latency distributions, and proposes updated candidate metadata (coding score, cost, latency) in the response. The user reviews and applies the changes. This is a TypeScript script, not a new runtime.

2. **Per-candidate latency tracking** — The current `router-events.csv` captures `duration_ms` for the whole request but does not break it down by candidate. Add a `candidate_latency_ms` column so users can see per-candidate timing and inform latency metadata.

3. **Prompt adaptation hint in router models** — Add an optional `promptHint` field to router candidates (e.g., "prefer short system prompts" or "needs explicit instruction format"). This is purely documentary for now but sets the stage for future automatic prompt rewriting when the proxy can safely modify prompt structure per candidate.

## E. DSPy: Offline Router Program Optimization

**Source:** DSPy 3.0 ([GitHub](https://github.com/stanfordnlp/dspy/releases/tag/3.0.0)) and the multi-use-case study (July 2025, arXiv 2507.03620).

### What it does

DSPy optimizers tune LLM programs against user-defined metrics:

- **MIPROv2** — Joint instruction + few-shot optimization via Bayesian search. Router accuracy improved from 85% → 90%.
- **GEPA** — Genetic-Pareto tree; builds a Pareto frontier of prompts via natural language reflection.
- **GRPO** — RL-based optimization for compound AI systems.
- **BetterTogether** — Meta-optimizer chaining prompt optimization + weight fine-tuning.

### Local Router Adoption Opportunities

1. **Router weight optimization as a DSPy-inspired recompute script** — The `POST /api/router-models/:id/recompute` endpoint can use a DSPy-inspired approach:
   - Define a metric: composite success score from telemetry.
   - Propose candidate weight adjustments (coding scores, cost estimates, latency) using a simple Bayesian or grid search.
   - Emit a ranked list of suggested parameter changes with expected improvement.
   - User approves or rejects each change.
   - This keeps optimization offline and under user control, matching DSPy's compile-then-deploy pattern.

2. **Router evaluation dataset generation** — Add `POST /api/router-evals/generate` that takes a router ID and produces a `router-evals.csv` from existing telemetry: redacted prompt hashes, candidate model IDs, observed status/latency, and a derived numeric score. This export is the DSPy-style evaluation dataset that could be used with external tooling if the user wants to train a custom router outside Local Router.

3. **Multi-metric optimization** — Current scoring uses a single linear combination. A DSPy-inspired improvement: support multiple named metrics (success_rate, latency_p50, cost_estimate, tool_call_accuracy) and let the user specify per-metric weights or a Pareto frontier view in the UI.

## F. Context-Aware Routing Improvements

**Sources:**
- [LLMRank (arXiv 2510.01234)](https://ar5iv.labs.arxiv.org/html/2510.01234) — understanding LLM strengths for routing.
- [BERT-Based Difficulty Prediction (IEEE 2025)](https://ieeexplore.ieee.org/document/11294975) — cost-efficient routing via prompt difficulty classification.
- [Cost-Aware Contrastive Routing (arXiv 2508.12491)](https://arxiv.org/html/2508.12491v1) — contrastive learning for routing.

### What they do

Context-aware routers classify requests by complexity or domain before selecting a model. BERT-based difficulty prediction can route simple queries to cheap models and complex queries to expensive ones. LLMRank builds per-model strength profiles across task categories.

### Local Router Adoption Opportunities

1. **Request complexity features in the context vector** — The current `requestFeatureSummary` already extracts `approxInputTokens`, `requestedOutputTokens`, `requiresTools`, and `requiresImages`. Add:
   - `codeDensity`: ratio of code-like tokens (braces, keywords, indentation) to natural language tokens.
   - `languageCount`: number of distinct programming languages detected in the prompt.
   - `multiTurnDepth`: number of distinct roles or conversation turns.
   - `instructionLength`: character count of the first user message (the task description).
   - These features feed the `bandit-local` context vector and make `auto-local` scoring more informed.

2. **Per-candidate strength profiles** — When telemetry accumulates, compute per-candidate success rates broken down by request features (with tools, without tools, with images, small context, large context). Expose these in `router-candidates.csv` and the `/config` UI so users can see which candidates excel at which types of requests.

3. **Coding vs. general-purpose task detection** — Add a lightweight heuristic classifier that detects whether a request is coding-related (presence of code blocks, file paths, function signatures, error traces). The `pareto-code` router type can use this to apply stricter coding score requirements for coding tasks while relaxing them for general queries.

## G. Scoring Formula Improvements

### Current Formula (src/index.ts:3226)

```
score = (codingScore * 100 * qualityWeight) - (cost * costWeight) - (latencyMs / 10000) - index / 1000
```

Issues:
- Coding score dominates (×100) while latency is negligible (/10000).
- No normalization — scores are not comparable across routers.
- Cost estimate is a rough heuristic (1-4 range from regex on model name).
- The index tie-breaker (/1000) is too small to matter.

### Proposed Improvements

1. **Normalize all terms to [0, 1]** before combining:
   ```
   score = w_quality * codingScore
           - w_cost * (costEstimate / maxCostInCandidates)
           - w_latency * (latencyMs / maxLatencyInCandidates)
           - w_index * (index / candidates.length)
   ```

2. **Derive weights from costQualityTradeoff** (currently 0-10, default 7):
   ```
   w_quality = 1.0
   w_cost = costQualityTradeoff / 5       // 0 to 2.0
   w_latency = (10 - costQualityTradeoff) / 5  // 2.0 to 0
   w_index = 0.001  // minimal tie-breaker
   ```

3. **Better cost estimation** — The current `candidateCostEstimate` uses regex on model names. When user-supplied `inputPrice`/`outputPrice` are available, use them directly. When missing, estimate from model metadata:
   - 1M-context models: cost_estimate = 3
   - 128K-256K models: cost_estimate = 2
   - <128K models: cost_estimate = 1
   - Apply ×2 multiplier for known expensive providers.

4. **Add `temperature` consideration** — Low-temperature requests (0-0.3) favor precise models; high-temperature requests (>1.0) favor creative models. This can be a small weight adjustment in auto-local scoring.

## H. New Router Model Fields

Based on the research above, the `RouterModel` type should gain these optional fields:

```typescript
type RouterModel = {
  id: string;
  type: RouterType;  // 'priority' | 'pareto-code' | 'auto-local' | 'bandit-local' (new)
  candidates: RouterCandidate[];
  minCodingScore?: number;
  costQualityTradeoff?: number;

  // New fields:
  explorationBudget?: number;       // 0-1, for bandit-local UCB α (default 0.05)
  enableAutoTiers?: boolean;        // statistical outlier tiering (default false)
  costThreshold?: number;           // 0-1, RouteLLM-style cost/quality threshold
  metricWeights?: {                 // per-metric weights for multi-objective scoring
    successRate?: number;           // default 1.0
    latencyP50?: number;            // default 0.3
    costEstimate?: number;          // default 0.5
    toolCallAccuracy?: number;      // default 0.2
  };
  banditState?: {                  // persisted dLinUCB state per candidate
    [candidateModel: string]: {
      A: number[][];               // d×d covariance matrix
      b: number[];                 // d×1 reward vector
      gamma: number;               // forgetting factor
    };
  };
};
```

New `RouterCandidate` fields:

```typescript
type RouterCandidate = {
  model: string;
  codingScore?: number;
  inputPrice?: number;
  outputPrice?: number;
  latencyMs?: number;
  notes?: string;

  // New fields:
  tier?: 'verified' | 'insufficient' | 'deranked';  // statistical tier
  toolCallAccuracy?: number;      // 0-1, from telemetry
  successRate?: number;           // 0-1, from telemetry
  sampleCount?: number;           // number of requests observed
  lastObservedAt?: string;        // ISO timestamp
  promptHint?: string;            // per-model prompt adaptation hint
};
```

## I. New API Endpoints

Based on research findings, these endpoints would support the improvement loop:

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/router-models/:id/recompute` | POST | Run TypeScript recompute from telemetry; propose weight/candidate updates |
| `/api/router-models/:id/dry-run` | POST | Score candidates for a given request body without calling upstream |
| `/api/router-evals/generate` | POST | Export DSPy-style evaluation CSV from telemetry for a router |
| `/api/router-events/import` | POST | Import router events CSV (for backup/restore/migration) |
| `/api/router-models/:id/bandit-state` | GET | Export dLinUCB state for inspection/debugging |
| `/api/router-models/:id/reset-bandit` | POST | Reset bandit learning state (keep candidate config) |
| `/api/router-benchmark` | POST | Run a small benchmark suite against candidate models |

## J. Telemetry Enrichment

### New `router-events.csv` columns

| Column | Type | Description |
|---|---|---|
| `candidate_latency_ms` | number | Per-candidate upstream latency |
| `tool_calls_requested` | number | Number of tool calls in the request |
| `tool_calls_valid` | boolean | Whether upstream returned valid tool call JSON |
| `reward_signal` | number | Composite reward (0-1) for bandit learning |
| `prompt_hash` | string | SHA3-256 of redacted prompt (for dedup, not reconstruction) |
| `coding_task` | boolean | Whether the request was classified as a coding task |
| `approx_tokens_out` | number | Approximate tokens in response (from content length / 4) |
| `candidate_tier` | string | Statistical tier at time of routing |

### New `router-candidates.csv` columns

| Column | Type | Description |
|---|---|---|
| `success_rate` | number | Aggregate success rate from telemetry |
| `tool_call_accuracy` | number | Aggregate tool call accuracy |
| `latency_p50_ms` | number | Median latency |
| `latency_p95_ms` | number | P95 latency |
| `sample_count` | number | Number of observations |
| `last_observed_at` | string | ISO timestamp of last request |
| `tier` | string | Current statistical tier |
| `reward_mean` | number | Mean bandit reward |
| `reward_std` | number | Std dev of bandit reward |

## K. Implementation Priority

Recommended implementation order, highest impact first:

1. **Normalized scoring formula** — Fix the current formula so terms are comparable. Low risk, immediate improvement.
2. **Request complexity features** — Add `codeDensity`, `languageCount`, `multiTurnDepth` to the context vector. Enables all downstream improvements.
3. **`bandit-local` router type with dLinUCB** — Highest-impact new feature. Sublinear regret, handles non-stationarity, fully local. ~200 lines of TypeScript.
4. **Per-candidate telemetry columns** — `candidate_latency_ms`, `tool_calls_valid`, `reward_signal`. Small schema change, big diagnostic value.
5. **Statistical tiering for candidate quality** — Auto Exacto-style outlier detection from accumulated telemetry. Requires 50+ samples per candidate to activate.
6. **`POST /api/router-models/:id/dry-run`** — Let users test router behavior without making real calls. Low implementation cost, high UX value.
7. **`POST /api/router-models/:id/recompute`** — TypeScript weight optimization from telemetry. DSPy-inspired offline tuning.
8. **Per-candidate strength profiles** — Success rate breakdowns by request features. Exposed in UI and CSV exports.

## L. Known Router Limitations (Current Implementation)

1. **Single-attempt per candidate** — Router execution tries each candidate once in score order. Unlike fallback routes, there is no retry logic within a single candidate. If the top-scored candidate fails transiently, the router moves to the next candidate. Adding a small retry budget (1-2 retries with backoff) per candidate would improve reliability at the cost of latency.

2. **No streaming-aware scoring** — The current scoring treats streaming and non-streaming requests identically, but latency sensitivity differs. Streaming users care about time-to-first-token; non-streaming users care about total time. A small scoring adjustment for stream vs. non-stream could improve perceived performance.

3. **No cache-awareness in scoring** — Models that support prompt caching (DeepSeek auto-cache, ZenMux explicit cache) could be preferred for multi-turn conversations where cache hits are likely. The current router has no awareness of whether a request is part of a multi-turn conversation.

4. **Candidate metadata is purely advisory** — The `coding`, `input`, `output`, and `latency` fields on candidates influence scoring but are not validated against observed behavior. Over time, observed values should feed back into candidate metadata (the recompute loop).

5. **No cross-router learning** — Each router's telemetry is independent. If two routers share candidate models, learnings from one router's telemetry could inform the other's scoring. A shared per-model quality register would enable this.

## M. Sources

- [OpenRouter Auto Exacto Announcement (March 2025)](https://openrouter.ai/announcements/auto-exacto)
- [OpenRouter January Release Spotlight (2026)](https://openrouter.ai/announcements/january-release-spotlight)
- [OpenRouter Changelog](https://openrouter.ai/docs/changelog)
- [OpenRouter Auto Router Docs](https://openrouter.ai/docs/guides/routing/routers/auto-router)
- [OpenRouter Pareto Code Router](https://openrouter.ai/openrouter/pareto-code/router)
- [RouteLLM Paper (arXiv 2406.18665, revised Feb 2025)](https://arxiv.org/abs/2406.18665)
- [Not Diamond Router Training Quickstart](https://docs.notdiamond.ai/docs/router-training-quickstart)
- [Not Diamond Key Concepts](https://docs.notdiamond.ai/docs/key-concepts)
- [Not Diamond Custom Models](https://docs.notdiamond.ai/docs/routing-between-custom-models)
- [MAR: Multi-Armed Router (ICLR 2025)](https://openreview.net/pdf?id=AfA3qNY0Fq)
- [PILOT: Preference-Prior Informed LinUCB (EMNLP 2025)](https://www.emergentmind.com/topics/preference-prior-informed-linucb-pilot)
- [ParetoBandit (March 2026)](https://www.opentrain.ai/tools/hf-eval-papers/paper/ad9748f5-9cb3-4bc7-b071-d09ac1617e95/)
- [LLM Bandit (ICLR 2025, arXiv 2502.02743)](https://arxiv.org/abs/2502.02743)
- [Mahoraga: LinUCB LLM Orchestrator (GitHub)](https://github.com/pockanoodles/Mahoraga)
- [DSPy 3.0 Release (GitHub)](https://github.com/stanfordnlp/dspy/releases/tag/3.0.0)
- [DSPy Program Optimization (DeepWiki)](https://deepwiki.com/stanfordnlp/dspy/4-program-optimization)
- [DSPy Multi-Use Case Study (arXiv 2507.03620, July 2025)](https://arxiv.org/html/2507.03620)
- [LLMRank (arXiv 2510.01234, 2025)](https://ar5iv.labs.arxiv.org/html/2510.01234)
- [Cost-Aware Contrastive Routing (arXiv 2508.12491, 2025)](https://arxiv.org/html/2508.12491v1)
- [BERT-Based Difficulty Prediction for LLM Routing (IEEE 2025)](https://ieeexplore.ieee.org/document/11294975)
- [Signal-Decision Architecture for Semantic Routing (vLLM Blog, 2025)](https://blog.vllm.com.cn/2025/11/19/signal-decision.html)
- [Martian Router Platform](https://barndoor.ai/ai-tools/martian/)
- [RouterBench (GitHub)](https://github.com/withmartian/routerbench)
