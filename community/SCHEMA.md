# Community Routing Exchange — Data Schemas

This document defines the standard formats for community-contributed data. All PRs touching `community/` are validated against these schemas.

## Router Configuration (`.json`)

Files go in `community/router-configs/<category>/<name>.json`.

```json
{
  "id": "my-coding-router",
  "type": "auto-local",
  "description": "A coding-focused router optimized for TypeScript projects.",
  "contributor": "github-username",
  "minCodingScore": 0.70,
  "costQualityTradeoff": 6,
  "explorationBudget": 0.05,
  "candidates": [
    {
      "model": "openrouter-1-million-chain-of-draft",
      "codingScore": 0.88,
      "inputPrice": 1,
      "outputPrice": 2,
      "latencyMs": 1200,
      "notes": "DeepSeek V4 Pro + DeepSeek V4 Flash + Xiaomi MiMo-V2.5-Pro"
    }
  ]
}
```

### Required fields

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique router identifier. Use kebab-case. |
| `type` | string | One of: `priority`, `pareto-code`, `auto-local`, `bandit-local` |
| `candidates` | array | Non-empty array of candidate model objects |

### Candidate fields

| Field | Type | Required | Range | Description |
|---|---|---|---|---|
| `model` | string | **Yes** | — | Model ID from providers.txt |
| `codingScore` | number | No | 0.0–1.0 | Coding capability estimate |
| `inputPrice` | number | No | ≥0 | Relative input cost |
| `outputPrice` | number | No | ≥0 | Relative output cost |
| `latencyMs` | number | No | ≥0 | Expected latency in milliseconds |
| `notes` | string | No | — | Non-secret operator note |

### Optional router fields

| Field | Type | Range | Description |
|---|---|---|---|
| `minCodingScore` | number | 0.0–1.0 | Minimum coding score threshold for pareto-code |
| `costQualityTradeoff` | number | 0–10 | Cost/quality balance (0=cheapest, 10=best quality) |
| `explorationBudget` | number | 0.0–1.0 | UCB exploration coefficient for bandit-local |
| `description` | string | — | Human-readable description of the router's purpose |
| `contributor` | string | — | GitHub username or handle |

## Model Evaluation (`.csv`)

Files go in `community/model-evals/<category>/<name>.csv`.

```csv
model_id,benchmark,score,evaluator,date,notes
openrouter-1-million-chain-of-draft,human-eval-typescript,0.92,github-user,2026-05-28,Pass@1
zenmux/deepseek/deepseek-v4-pro,mbpp,0.88,github-user,2026-05-28,
```

### Required columns

| Column | Type | Description |
|---|---|---|
| `model_id` | string | Model ID matching providers.txt |
| `benchmark` | string | Benchmark name (e.g., HumanEval, MBPP, SWE-bench, LiveCodeBench) |
| `score` | number | Numeric score (0.0–1.0 range preferred) |
| `evaluator` | string | GitHub username or handle |

### Optional columns

| Column | Type | Description |
|---|---|---|
| `date` | string | ISO date (YYYY-MM-DD) |
| `notes` | string | Any relevant context (model variant, temperature, prompt config) |

## Telemetry Share (`.csv`)

Files go in `community/telemetry-shares/<name>.csv`.

**Important:** Telemetry shares must be fully anonymized. No prompts, responses, API keys, auth headers, local paths, or personally identifiable information.

```csv
model_id,success_rate,tool_call_accuracy,latency_ms,sample_count,date
openrouter-1-million-chain-of-draft,0.94,0.89,1350,150,2026-05-28
wafer-ai-deepseek-v4-pro,0.97,0.92,980,200,2026-05-28
```

### Allowed columns

| Column | Type | Description |
|---|---|---|
| `model_id` | string | **Required.** Model ID matching providers.txt. |
| `success_rate` | number | Proportion of successful requests (0.0–1.0) |
| `tool_call_accuracy` | number | Proportion of valid tool call responses (0.0–1.0) |
| `latency_ms` | number | Median or mean latency in milliseconds |
| `sample_count` | number | Number of requests this data is based on |
| `date` | string | ISO date (YYYY-MM-DD) |
| `router_type` | string | Router type used (priority, pareto-code, auto-local, bandit-local) |

### Forbidden columns

These must **never** appear in telemetry shares:

- `prompt`, `response`, `messages`, `input`, `output`
- `api_key`, `auth_token`, `token`, `secret`, `password`
- `user_id`, `email`, `ip_address`, `name`
- Any field containing file paths or system details

## Routing Improvement Proposal (`.md`)

Files go in `community/proposals/<slug>.md`.

Proposals use a free-form markdown format. A good proposal includes:

```markdown
# Proposal: <Short Title>

## Summary
<1-3 sentences describing the proposed improvement>

## Motivation
<Why this change improves routing. Link to benchmarks, papers, or data.>

## Proposed Change
<Concrete description of what changes: router types, scoring formulas,
 candidate metadata, telemetry columns, API endpoints, etc.>

## Evidence
<Data, benchmarks, papers, or community evaluations supporting the change>

## Alternatives Considered
<Other approaches you considered and why they were rejected>
```

## Validation Rules

All contributions are validated by `scripts/crx-validate.mts`:

1. **Schema** — Required fields present, types correct, ranges valid
2. **Security** — No API keys, tokens, passwords, PII
3. **References** — Model IDs resolvable against providers.txt
4. **Consistency** — Scores in valid ranges, dates parseable
5. **No duplicates** — No identical entries within/across files
