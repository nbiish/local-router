# Model Intelligence Framework — Auto-Router Research Plan

## Goal

Build a data-driven, community-maintained system for evaluating LLM model
performance and configuring optimal routing parameters for agentic coding
tasks across chat agents, IDEs, CLIs, and scripting workflows.

---

## 1. Performance Data Collection

### 1.1 Structured Benchmark Registry

Create `community/model-evals/` with canonical benchmark schemas:

| Benchmark | What it measures | Source |
|-----------|-----------------|--------|
| SWE-bench Verified | Real GitHub issue resolution | swebench.com |
| HumanEval+ / MBPP+ | Functional correctness | EvalPlus |
| LiveCodeBench | Fresh competitive coding | livecodebench.github.io |
| Aider Polyglot | Multi-language code editing | aider.chat |
| Berkeley Function Calling | Tool use accuracy | gorilla.cs.berkeley.edu |
| MMLU-Pro / GPQA | Reasoning depth | various |
| CRUXEval | Code reasoning/understanding | meta |

Each model entry:
```yaml
model: deepseek/deepseek-v4-pro
provider: zenmux
benchmarks:
  swebench_verified: 0.72
  humaneval_plus: 0.91
  aider_polyglot: 0.86  # weighted avg across languages
  tool_use_accuracy: 0.89
  reasoning_gpqa: 0.78
pricing:
  input_per_1m: 1.00
  output_per_1m: 2.00
latency_p50_ms: 900
context_window: 1000000
capabilities: [tools, cache, streaming]
notes: "Top-tier coding model, strong tool use"
```

### 1.2 Telemetry Pipeline (Opt-In)

The local router already collects per-request telemetry in `ROUTER_EVENTS_PATH`.
Extend it with:

- **Outcome signals**: user acceptance rate, retry rate, error patterns
- **Latency distribution**: p50, p95, p99 per model
- **Token efficiency**: output tokens per task completion
- **Cost tracking**: cumulative spend per model/provider

All telemetry stays local by default. Community sharing via
`community/telemetry-shares/` with anonymized, aggregated reports.

### 1.3 Community Evaluation Protocol

`community/model-evals/coding/` contains:
- Standardized prompt sets for coding tasks
- Evaluation rubrics (correctness, style, instruction following)
- Comparison scripts that run N models against the same prompt
- CSV output format compatible with `router-candidates.csv`

---

## 2. Routing Parameter Calibration

### 2.1 Current Parameters (per candidate)

| Parameter | Type | Description |
|-----------|------|-------------|
| `codingScore` | 0-1 | Agentic coding quality estimate |
| `inputPrice` | $/1M tokens | Input token cost |
| `outputPrice` | $/1M tokens | Output token cost |
| `latencyMs` | ms | Expected first-token latency |
| `notes` | string | Human-readable description |

### 2.2 Proposed Additional Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `toolUseScore` | 0-1 | Tool calling accuracy |
| `reasoningScore` | 0-1 | Complex reasoning capability |
| `multilingualScore` | 0-1 | Non-English performance |
| `contextUtilization` | 0-1 | Quality at high context lengths |
| `visionScore` | 0-1 | Image/document understanding |
| `reliability` | 0-1 | Uptime/consistency score |
| `maxOutputTokens` | int | Maximum output tokens |
| `strengths` | string[] | ["coding", "reasoning", "tool-use"] |
| `weaknesses` | string[] | ["high_latency", "expensive"] |

### 2.3 Router Type Specializations

| Router Type | Primary Metric | Use Case |
|------------|----------------|----------|
| `pareto-code` | codingScore × cost | Best coding per dollar |
| `auto-local` | Weighted multi-metric | General purpose with tuning |
| `priority` | Explicit order | User-controlled failover |
| `bandit-local` | Learned from telemetry | Self-optimizing over time |

### 2.4 Dynamic Scoring Formula

```
finalScore = Σ(weight_i × normalized_i) - penalties

Where:
- qualityWeight = costQualityTradeoff / 10
- costWeight = (10 - costQualityTradeoff) / 10
- latencyWeight = 0.1 (auto-local) / 0.3 (default)

Extended formula (proposed):
finalScore = (qualityWeight × codingScore)
           + (toolWeight × toolUseScore)       # new
           + (reasoningWeight × reasoningScore) # new
           - (costWeight × normalizedCost)
           - (latencyWeight × normalizedLatency)
           - contextPenalty                     # if near context limit
           - indexPenalty                       # position bias
```

---

## 3. Evaluation Workflow

### 3.1 Automated Evaluation Pipeline

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Benchmarks  │────▶│ Model Router │────▶│ Results CSV  │
│ (prompts)   │     │ (all models) │     │ (scores)     │
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ Calibration  │
                                         │ Script       │
                                         └──────┬───────┘
                                                │
                                                ▼
                                         ┌──────────────┐
                                         │ Updated      │
                                         │ Candidates   │
                                         └──────────────┘
```

### 3.2 Scripts to Create

| Script | Purpose |
|--------|---------|
| `scripts/eval-runner.mts` | Run benchmark suite against all configured models |
| `scripts/calibrate-params.mts` | Generate routing params from eval results |
| `scripts/compare-providers.mts` | Same model across providers → latency/cost comparison |
| `scripts/cost-projection.mts` | Estimate monthly spend for given usage patterns |
| `scripts/crawl-model-catalogs.mts` | Fetch latest model lists from all providers |
| `scripts/detect-new-models.mts` | Diff current providers.txt vs upstream catalogs |

### 3.3 Periodic Research Cycle

1. **Weekly**: Run `crawl-model-catalogs.mts` → detect new models
2. **Biweekly**: Run `eval-runner.mts` on new/high-priority models
3. **Monthly**: Run `calibrate-params.mts` → update router defaults
4. **Quarterly**: Full community eval report → `community/AGGREGATE.md`

---

## 4. Provider Diversity Strategy

### 4.1 Multi-Provider Redundancy

For critical models, maintain entries across multiple providers:

| Model | Providers | Why |
|-------|-----------|-----|
| DeepSeek V4 Pro | wafer, zenmux, opencode, nebius, openrouter | Highest quality, needs fallback |
| DeepSeek V4 Flash | wafer, zenmux, opencode | Fast/cheap, high volume |
| GLM-5.1 | wafer, zenmux, modal, opencode, zai | Good coding, diverse access |
| MiniMax M2.7 | zenmux, opencode, nvidia-nim | Reasoning, cost-effective |
| Step 3.7 Flash | zenmux, openrouter, nvidia-nim | Fast reasoning |

### 4.2 Geo/Load Distribution

Router candidates from different providers automatically distribute load:
- If Wafer is slow → auto-router scores ZenMux/OpenCode higher
- If user only has OpenRouter key → only OpenRouter candidates eligible
- Graceful degradation: skip unconfigured providers, configure what you have

### 4.3 Model Family Coverage

| Role | Primary Models | Backup |
|------|---------------|--------|
| Flagship coding | DeepSeek V4 Pro | GLM-5.1, Qwen3.7-Max |
| Fast coding | DeepSeek V4 Flash | Step 3.7 Flash |
| Reasoning | Cosmos3 Super Reasoner | MiniMax M2.7 |
| Multimodal | MiMo V2.5, Kimi K2.6 | Nemotron Nano Omni |
| Free/cheap | OpenRouter free presets | Nemotron Nano Omni |

---

## 5. Community Contributions

### 5.1 How to Contribute Model Evals

1. Fork the repo
2. Add eval results to `community/model-evals/<category>/`
3. Follow `community/SCHEMA.md` for format
4. Update `community/AGGREGATE.md` with summary
5. Submit PR with results

### 5.2 Router Configuration Sharing

`community/router-configs/` contains community-tested configurations:
- `coding/` — Optimized for agentic coding (IDE, CLI)
- `general/` — Balanced for diverse tasks
- `budget/` — Cost-optimized configs
- `experimental/` — Bleeding-edge model testing

Users can import configurations via the `/config` page or API.

### 5.3 Model Proposal Process

1. Open issue with model details (provider, ID, capabilities, pricing)
2. Community evaluates via standardized benchmarks
3. If passing quality threshold → added to providers.txt defaults
4. Router candidates updated in next calibration cycle

---

## 6. Implementation Priority

| Phase | Deliverable | Status |
|-------|-------------|--------|
| P0 | Default 20-candidate router with all providers | ✅ Done |
| P0 | Graceful skip for unconfigured providers | ✅ Done |
| P0 | providers.txt with 65+ models / 11 providers | ✅ Done |
| P1 | `calibrate-params.mts` script | 🔲 TODO |
| P1 | `crawl-model-catalogs.mts` script | 🔲 TODO |
| P1 | Extended candidate parameters (toolUseScore, etc.) | 🔲 TODO |
| P2 | Automated eval pipeline | 🔲 TODO |
| P2 | Telemetry outcome tracking | 🔲 TODO |
| P2 | Community eval report template | 🔲 TODO |
| P3 | Bandit-local router with learned scoring | 🔲 TODO |
| P3 | Cost projection dashboard | 🔲 TODO |

---

## 7. Research Sources

| Source | URL | What |
|--------|-----|------|
| LMSys Chatbot Arena | chat.lmsys.org | Crowdsourced model rankings |
| OpenRouter Stats | openrouter.ai/rankings | Usage and price rankings |
| Artificial Analysis | artificialanalysis.ai | Model speed/quality comparison |
| EvalPlus Leaderboard | evalplus.github.io | Code benchmark leaderboards |
| Aider LLM Leaderboard | aider.chat/docs/leaderboards | Code editing benchmarks |
| HuggingFace Open LLM | huggingface.co/spaces/open-llm-leaderboard | Open model rankings |
| LiveCodeBench | livecodebench.github.io | Fresh coding benchmarks |
