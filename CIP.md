# Continuous Improvement Pipeline & Community Routing Exchange

## Overview

Local Router's routing intelligence comes from two interconnected systems:

1. **Continuous Improvement Pipeline (CIP)** — A daily research pipeline that AI agents run to gather new information from academic publications, provider announcements, benchmark results, and industry standards. It produces structured proposals for router improvements.

2. **Community Routing Exchange (CRX)** — A GitHub-based system where users share router configurations, model evaluations, and anonymized telemetry. The community collectively builds the best routing intelligence through open contribution.

Together, these create a **continuous improvement, continuous deployment system** where:
- AI agents run daily research to find what's changed in the world
- Users contribute real-world performance data
- Both streams feed into concrete router configuration improvements
- Improvements ship through the normal git workflow (PR → review → merge → deploy)

## Architecture

```
                    ┌──────────────────────────────┐
                    │     Daily CIP Research        │
                    │  (AI agents / GitHub Actions) │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │      Research Findings        │
                    │   data/research-log.csv       │
                    │   data/proposals-CIP-*.json   │
                    └──────────────┬───────────────┘
                                   │
    ┌──────────────────────────────┼──────────────────────────────┐
    │                              │                              │
    ▼                              ▼                              ▼
┌───────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│  Community    │    │  Provider Watch      │    │  Academic Research   │
│  Contributions│    │  New models, pricing │    │  Papers, benchmarks  │
│  (CRX)        │    │  capability changes  │    │  algorithms, SOTA    │
└───────┬───────┘    └──────────┬───────────┘    └──────────┬───────────┘
        │                       │                           │
        └───────────────────────┼───────────────────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Proposal Aggregation    │
                    │   scripts/cip-apply-      │
                    │   findings.mts            │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Router Config Updates   │
                    │   router-models.json      │
                    │   ROUTER.md defaults      │
                    │   providers.txt metadata  │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Git PR → Review → Merge │
                    │   → Deploy                │
                    └──────────────────────────┘
```

## Part 1: Continuous Improvement Pipeline (CIP)

### Purpose

The CIP is an offline research pipeline that runs daily. It does NOT make real-time routing decisions. Instead, it:

1. Checks configured sources for new information
2. Parses findings into structured improvement candidates
3. Generates concrete proposals for router configuration changes
4. Records everything for audit

AI agents are the intended primary operators of the CIP. They read the gather manifest, check each source for new information, and feed findings back into the pipeline.

### Daily Research Workflow

```
GATHER ──→ ANALYZE ──→ PROPOSE ──→ RECORD
  │            │            │           │
  │   Check    │   Parse    │   Generate │   Write
  │   sources  │   findings │   proposals│   logs
  │            │            │            │
  └────────────┴────────────┴────────────┘
              │
              ▼
         APPLY (manual/agent review gate)
              │
              ▼
         PR → Review → Merge → Deploy
```

### Phase 1: GATHER

**What happens:** The CIP identifies all sources that need checking and produces a manifest for AI agents.

**Sources checked daily:**

| Category | Sources | What to look for |
|---|---|---|
| Arxiv | cs.AI, cs.CL, cs.LG, stat.ML | New papers on LLM routing, model selection, bandit algorithms, cost optimization |
| Arxiv searches | 5 curated search queries | Targeted paper discovery ("LLM routing model selection", "multi-armed bandit LLM", etc.) |
| GitHub repos | OpenRouter, DSPy, Mahoraga, RouterBench, Chatbot Arena | New releases, commits, features, benchmarks |
| Provider announcements | OpenRouter, DeepSeek, Anthropic, Google AI | New model releases, pricing changes, capability updates, deprecations |
| Conferences | ICLR, NeurIPS, ICML, ACL, EMNLP | New proceedings with routing-relevant papers |
| Benchmark registries | LiveBench, Chatbot Arena, OpenRouter models, Artificial Analysis | Updated model scores, new evaluation categories |
| Industry blogs | OpenRouter, Not Diamond, vLLM, Martian | Routing features, best practices, industry developments |

**Output:** `data/gather-manifest-CIP-*.json` — A list of sources with URLs and instructions for AI agents.

### Phase 2: ANALYZE

**What happens:** Raw findings are categorized and structured.

**Finding categories:**
- `new_model` — New model announced or discovered
- `model_deprecated` — Model removed or deprecated
- `pricing_change` — Input/output/cache pricing changed
- `capability_change` — Model gained/lost tool support, vision, caching, etc.
- `new_paper` — Academic paper relevant to routing
- `new_algorithm` — Novel routing algorithm or technique
- `new_benchmark` — New evaluation dataset or framework
- `benchmark_result` — Updated scores on existing benchmarks
- `industry_standard` — Emerging standard or convention
- `best_practice` — Documented best practice or pattern
- `community_insight` — High-confidence finding from CRX data
- `provider_announcement` — Official provider communication
- `security_advisory` — Security-relevant finding
- `routing_technique` — New or improved routing approach

### Phase 3: PROPOSE

**What happens:** Analyzed findings are converted into concrete, actionable proposals.

**Proposal types:**

| Type | Example | Auto-apply? |
|---|---|---|
| `add_candidate` | New model "deepseek-v5" discovered → add as candidate | High confidence only |
| `remove_candidate` | Model deprecated by provider → remove from defaults | High confidence only |
| `update_coding_score` | New benchmark shows 0.82 → 0.86 for a model | High confidence only |
| `update_cost` | Pricing change announced → update cost estimate | After review |
| `update_latency` | Community data shows latency changed → update | After review |
| `update_weight` | Research suggests better cost/quality tradeoff → adjust | Manual only |
| `add_router_config` | New optimal config discovered → propose as community config | Manual only |
| `new_router_type` | Novel algorithm published → propose implementation | Manual only |
| `add_telemetry_column` | Research shows value in tracking new metric | Manual only |

**Confidence levels:**
- **High** — Multiple corroborating sources, official announcement, or clear benchmark data. Eligible for auto-apply.
- **Medium** — Single source, new paper without replication, or community data below sample threshold. Needs human review.
- **Low** — Speculative, unverified, or single-anecdote. Recorded for reference only.

### Phase 4: RECORD

**What happens:** All findings are written to structured logs for audit and future reference.

**Log files:**
- `data/research-log.csv` — Append-only log of all findings across all runs
- `data/model-catalog-changes.csv` — Track every model metadata change
- `data/proposals-CIP-*.json` — Per-run proposal files
- `data/cip-report-CIP-*.json` — Per-run summary report

### How AI Agents Use the CIP

The CIP is designed for AI agents as the primary operator. Here's the daily workflow:

```
1. Agent runs: npx ts-node scripts/cip-daily-research.mts --phase=gather
   → Gets a manifest of sources to check

2. Agent checks each source:
   a. WebFetch arxiv listing pages, scan for relevant papers
   b. Check GitHub releases/commits for watched repos
   c. Check provider announcement pages for new models
   d. Check benchmark sites for updated scores

3. For each finding, agent calls recordFinding() with structured data:
   {
     phase: 'gather',
     sourceType: 'arxiv',
     sourceName: 'arxiv:cs.AI',
     finding: 'Paper title: "Improved LinUCB for LLM Routing" ...',
     category: 'new_paper',
     confidence: 'high',
     url: 'https://arxiv.org/abs/...'
   }

4. Agent runs: npx ts-node scripts/cip-daily-research.mts --phase=analyze
   → Categorizes all findings

5. Agent runs: npx ts-node scripts/cip-daily-research.mts --phase=propose
   → Generates concrete change proposals

6. Agent reviews proposals, applies high-confidence ones:
   npx ts-node scripts/cip-apply-findings.mts data/proposals-CIP-*.json

7. Agent runs: npx ts-node scripts/cip-daily-research.mts --phase=record
   → Persists everything

8. Agent opens PR with proposed changes, or commits directly if all auto-apply
```

### Source Configuration

All sources are configured in `data/sources.json`. AI agents can add new sources by editing this file. The format:

```json
{
  "arxiv_categories": [{ "id": "cs.AI", "keywords": ["LLM routing", ...] }],
  "arxiv_searches": [{ "query": "LLM routing ...", "max_results": 20 }],
  "github_repos": [{ "owner": "org", "repo": "name", "watch": ["releases"] }],
  "provider_announcements": [{ "name": "Provider", "url": "...", "check_for": [...] }],
  "benchmark_registries": [{ "name": "Benchmark", "url": "...", "description": "..." }]
}
```

### Provider Model Watch

The CIP monitors provider endpoints for model catalog changes. Configured in `data/provider-watch.json`. When a provider adds/removes/updates a model, the CIP detects the change and produces an `add_candidate` or `update_candidate_metadata` proposal.

Tracked changes:
- New model IDs appearing in provider listings
- Context window changes
- Output token limit changes
- Pricing changes (input, output, cache read, cache write)
- Capability changes (tools, vision, caching, reasoning)

### GitHub Actions Automation

The `.github/workflows/cip-daily.yml` workflow:
- Runs daily at 09:57 UTC
- Executes all four CIP phases
- Counts high-confidence proposals
- If high-confidence proposals exist: opens a PR labeled `auto-improvement`
- If no proposals: completes silently (artifacts available for manual review)

**The workflow never auto-merges.** Every change goes through PR review.

---

## Part 2: Community Routing Exchange (CRX)

### Purpose

The CRX is a GitHub-native system for collective improvement of Local Router's routing intelligence. Users contribute:

1. **Router configurations** — Tuned router setups that work well for specific use cases
2. **Model evaluations** — Benchmark results for specific models
3. **Telemetry shares** — Anonymized aggregate performance data
4. **Proposals** — Ideas for routing improvements

All contributions are validated, aggregated, and fed back into the routing system.

### Directory Structure

```
community/
├── CONTRIBUTING.md          # How to contribute
├── SCHEMA.md                # Data format specifications
├── AGGREGATE.md             # Auto-generated consensus summary
├── router-configs/
│   ├── coding/              # Coding-focused routers
│   ├── general/             # General-purpose routers
│   ├── budget/              # Cost-optimized routers
│   └── experimental/        # Novel routing approaches
├── model-evals/
│   ├── coding/              # Coding benchmarks (HumanEval, MBPP, SWE-bench)
│   ├── reasoning/           # Reasoning/logic benchmarks
│   ├── tool-use/            # Tool/function calling evaluations
│   └── multimodal/          # Vision/multimodal benchmarks
├── telemetry-shares/        # Anonymized aggregate telemetry
└── proposals/               # RFC-style improvement proposals
```

### Contribution Flow

```
User forks repo
     │
     ▼
User adds data to community/
     │
     ▼
User runs: npx ts-node scripts/crx-validate.mts
     │
     ▼
User opens PR
     │
     ▼
GitHub Actions: crx-validate.yml runs
  ├── Schema validation
  ├── Security scan (no secrets/PII)
  ├── Model reference check
  └── Consistency check
     │
     ▼
PR reviewed & merged
     │
     ▼
GitHub Actions: crx-validate.yml aggregator runs
  ├── Scans all community/ data
  ├── Computes consensus values
  ├── Updates community/AGGREGATE.md
  └── Updates data/community-consensus.json
     │
     ▼
CIP picks up consensus data as "community_insight" findings
     │
     ▼
Router defaults may be updated based on community consensus
```

### Contribution Types

#### Router Configurations

Users share their working router configs. Each config includes:
- The router type and parameters
- The candidate model list with metadata
- A description of what the router is optimized for
- The contributor's GitHub username

**Why this matters:** Router configurations encode real-world knowledge about which models work well together. When multiple users independently converge on similar candidate sets, that's a strong signal for default configurations.

#### Model Evaluations

Users share benchmark results. Any benchmark type is accepted:
- Standard benchmarks (HumanEval, MBPP, SWE-bench, LiveCodeBench, BigCodeBench)
- Custom coding tasks
- Tool-calling accuracy tests
- Latency measurements
- Cost-effectiveness comparisons

**Why this matters:** Coding scores in router configs are currently operator-provided estimates. Community evaluations provide empirical grounding. When 5+ users report similar coding scores for a model, the CIP can use the community consensus instead of operator estimates.

#### Telemetry Shares

Users share anonymized aggregate statistics from their router usage:
- Per-model success rates
- Per-model tool call accuracy
- Per-model latency measurements
- Sample counts and date ranges

**What's NOT shared:** prompts, responses, API keys, user identities, IPs, file paths.

**Why this matters:** Real-world performance data is the strongest signal for routing decisions. A model might score well on benchmarks but perform poorly in practice (or vice versa). Telemetry shares capture actual usage patterns.

#### Proposals

Users propose improvements to the routing system itself:
- New router types
- Modified scoring formulas
- Additional telemetry columns
- New API endpoints
- Algorithm improvements

**Why this matters:** The routing system should evolve based on user needs, not just operator assumptions. Proposals provide structured feedback.

### Validation

The `scripts/crx-validate.mts` script enforces quality and safety:

| Check | Description | Failure is |
|---|---|---|
| Schema | Required fields present, types correct, ranges valid | Error |
| Security | No API keys, tokens, passwords, connection strings | Error |
| PII | No emails, IPs, user IDs, file paths | Error |
| Model refs | Referenced models exist in providers.txt | Warning |
| Consistency | Scores in valid ranges (0-1), dates parseable | Error |
| Duplicates | No identical entries within/across files | Warning |

### Aggregation

The `scripts/crx-aggregate.mts` script runs after community PRs are merged:

1. Scans all model evaluations and computes per-benchmark statistics (mean, median, min, max, sample count)
2. Derives consensus coding scores from coding benchmark aggregates
3. Computes consensus latency and success rates from telemetry shares
4. Identifies popular router types and candidate models
5. Writes `community/AGGREGATE.md` (human-readable) and `data/community-consensus.json` (machine-readable)

**Minimum sample threshold:** By default, 3 independent contributions are needed for a model to appear in consensus. This prevents single-data-point conclusions.

### Consensus-Driven Default Updates

When community consensus reaches sufficient sample size and contributor diversity, the CIP treats it as a `community_insight` finding with high confidence. This means:

- **Coding scores** in default router candidates can be updated from community benchmarks instead of operator estimates
- **Latency estimates** can reflect real-world measurements instead of provider claims
- **New candidate models** can be proposed based on community popularity
- **Router type defaults** can shift based on which types the community finds most effective

The flow is:
```
Community data → AGGREGATE.md → CIP "community_insight" finding
→ High confidence proposal → PR → Review → Merge → New defaults
```

---

## Part 3: Integration — How CIP and CRX Work Together

### The Full Loop

```
┌─────────────────────────────────────────────────────────────┐
│                     OUTSIDE WORLD                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────────┐ │
│  │ Arxiv    │  │ Provider │  │ Benchmark│  │ Conference  │ │
│  │ Papers   │  │ Updates  │  │ Results  │  │ Proceedings │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬──────┘ │
└───────┼──────────────┼─────────────┼───────────────┼────────┘
        │              │             │               │
        ▼              ▼             ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                   CIP DAILY RESEARCH                         │
│  scripts/cip-daily-research.mts                              │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐      │
│  │ GATHER  │─→│ ANALYZE │─→│ PROPOSE  │─→│ RECORD   │      │
│  └─────────┘  └─────────┘  └────┬─────┘  └──────────┘      │
└─────────────────────────────────┼───────────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        │                         │                         │
        ▼                         ▼                         ▼
┌───────────────┐    ┌──────────────────────┐    ┌──────────────────┐
│ Academic      │    │ Provider Changes     │    │ Community Signal │
│ New algorithm │    │ New model, pricing   │    │ from AGGREGATE.md│
└───────┬───────┘    └──────────┬───────────┘    └────────┬─────────┘
        │                       │                         │
        └───────────────────────┼─────────────────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Proposals file          │
                    │   data/proposals-CIP-*.json│
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Human / Agent Review    │
                    │   Apply or reject each    │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Updated router config   │
                    │   Updated ROUTER.md       │
                    │   Updated providers.txt   │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Git Commit → PR → Merge │
                    └───────────┬──────────────┘
                                │
                    ┌───────────▼──────────────┐
                    │   Users pull new defaults │
                    │   Better routing for all  │
                    └──────────────────────────┘
```

### Data Flow Between Systems

1. **CRX feeds CIP:** Community consensus data (`data/community-consensus.json`) is read by the CIP as a source of `community_insight` findings. When community data reaches high confidence, it can trigger automatic proposals.

2. **CIP feeds CRX:** When the CIP discovers new models, benchmarks, or routing techniques, it can create community router configs in `community/router-configs/` as examples of best practices.

3. **Both feed router defaults:** The default router configuration (`router-models.json`, `ROUTER.md` defaults) is updated by proposals from either system, after human/agent review.

### Review Gates

Every change must pass through review before affecting production routing:

| Change type | Review required | Auto-merge? |
|---|---|---|
| New coding score from community consensus (5+ samples) | Quick sanity check | Can auto-PR |
| New coding score from single benchmark paper | Full review | No |
| New model added as candidate | Verify model exists and is accessible | No |
| Model removed (deprecated) | Verify deprecation announcement | Can auto-PR |
| Pricing update from official source | Quick verification | Can auto-PR |
| Algorithm change (new router type) | Full review, implementation, tests | No |
| Weight/parameter tuning | Review with evidence | No |
| Telemetry column addition | Schema review | No |

---

## Part 4: Files Reference

### Scripts

| Script | Purpose | Run by |
|---|---|---|
| `scripts/cip-daily-research.mts` | Main CIP entry point — gather, analyze, propose, record | AI agents, GitHub Actions |
| `scripts/cip-apply-findings.mts` | Apply validated proposals to router config | AI agents, operators |
| `scripts/crx-validate.mts` | Validate community contributions before merge | GitHub Actions, contributors |
| `scripts/crx-aggregate.mts` | Aggregate community data into consensus values | GitHub Actions (on merge) |

### Data Files

| File | Purpose | Git |
|---|---|---|
| `data/sources.json` | Curated research sources for CIP | Committed |
| `data/provider-watch.json` | Provider endpoints to monitor | Committed |
| `data/research-log.csv` | Append-only log of all research findings | Committed (shareable) |
| `data/model-catalog-changes.csv` | Track every model metadata change | Committed (shareable) |
| `data/community-consensus.json` | Machine-readable aggregated community data | Auto-committed by aggregator |
| `data/proposals-CIP-*.json` | Per-run proposal files | Uploaded as artifacts, not committed |
| `data/cip-report-CIP-*.json` | Per-run summary reports | Uploaded as artifacts, not committed |

### Community Files

| File | Purpose | Updated by |
|---|---|---|
| `community/CONTRIBUTING.md` | How to contribute | Maintainers |
| `community/SCHEMA.md` | Data format specifications | Maintainers |
| `community/AGGREGATE.md` | Auto-generated consensus summary | Aggregator (on merge) |
| `community/router-configs/*/` | Shared router configurations | Community PRs |
| `community/model-evals/*/` | Model evaluation data | Community PRs |
| `community/telemetry-shares/` | Anonymized telemetry | Community PRs |
| `community/proposals/` | Improvement proposals | Community PRs |

### Workflows

| Workflow | Trigger | Action |
|---|---|---|
| `.github/workflows/cip-daily.yml` | Daily schedule (09:57 UTC), manual dispatch | Run CIP, open PR if proposals found |
| `.github/workflows/crx-validate.yml` | PR to community/, push to main/staging/develop | Validate contributions, aggregate on merge |

---

## Part 5: Getting Started

### For AI Agents

```bash
# Run the daily research pipeline
npx ts-node scripts/cip-daily-research.mts

# Check what needs researching today
npx ts-node scripts/cip-daily-research.mts --phase=gather

# Apply high-confidence proposals
npx ts-node scripts/cip-apply-findings.mts --all-auto-apply --dry-run  # preview
npx ts-node scripts/cip-apply-findings.mts --all-auto-apply            # apply
```

### For Community Contributors

```bash
# Validate your contribution before PR
npx ts-node scripts/crx-validate.mts --file=community/router-configs/coding/my-router.json

# See current community consensus
cat community/AGGREGATE.md

# Run the aggregator locally
npx ts-node scripts/crx-aggregate.mts --min-samples=2 --output=verbose
```

### For Maintainers

```bash
# After merging community PRs, aggregate
npx ts-node scripts/crx-aggregate.mts

# After CIP research, review and apply
cat data/proposals-CIP-*.json | jq '.proposals[] | select(.confidence == "high")'
npx ts-node scripts/cip-apply-findings.mts data/proposals-CIP-*.json --dry-run
npx ts-node scripts/cip-apply-findings.mts data/proposals-CIP-*.json

# Verify nothing broke
npm run build
npm test
```

---

## Part 6: Design Principles

1. **Research is offline, routing is online.** The CIP never affects real-time routing decisions. It produces proposals for human/agent review.

2. **Every change has an audit trail.** Research findings, proposals, model changes, and community contributions are all logged with timestamps and sources.

3. **Community data is validated and aggregated.** Single contributions don't change defaults. Consensus emerges from multiple independent reports.

4. **Secrets never enter the pipeline.** All CIP outputs and CRX contributions are scanned for API keys, tokens, and PII. Failures block the pipeline.

5. **Review gates are proportional to risk.** Pricing updates from official sources can auto-PR. Algorithm changes require full review.

6. **The system improves itself.** As community data grows and CIP research accumulates, the router gets better at routing — creating a virtuous cycle where better routing → more users → more community data → even better routing.

7. **Everything is local-first.** CIP and CRX improve the local router's configuration. No external service dependency at request time. The research pipeline can run anywhere.

---

## Part 7: Future Directions

### Near-term (next 1-3 months)

- **Automated benchmark runs:** `POST /api/router-benchmark` endpoint that runs a small suite of coding tasks against each candidate model and reports results. Feeds directly into CIP.
- **Provider model change detection:** Automated diffing of provider `/v1/models` responses against cached snapshots. Detects new/removed/changed models.
- **Cross-router learning:** Shared per-model quality register so learnings from one router's telemetry inform other routers using the same candidates.
- **CRX leaderboard:** Public leaderboard of community-contributed router configs ranked by reported success rate.

### Medium-term (3-6 months)

- **Bandit state sharing:** Community can share anonymized dLinUCB A/b matrices as pretrained starting points for new bandit-local routers.
- **Recompute v2:** DSPy-inspired weight optimization using community evaluation datasets as training data.
- **Automated PR merging:** For high-confidence, multi-source-corroborated proposals with no config conflicts.

### Long-term (6-12 months)

- **Federated learning for routing:** Privacy-preserving model quality estimation from distributed telemetry without centralizing data.
- **Real-time community signals:** Optional opt-in live telemetry sharing for time-sensitive routing decisions (provider outages, quality degradation).
- **Cross-project CRX:** The CRX format could become a standard for sharing LLM routing intelligence across different router implementations.
