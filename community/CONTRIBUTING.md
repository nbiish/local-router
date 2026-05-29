# Contributing to the Community Routing Exchange

The Community Routing Exchange (CRX) is how we collectively build the best open-source LLM routing system. Your router configs, model evaluations, and anonymized telemetry help everyone make better routing decisions.

## Ways to Contribute

### 1. Share a Router Configuration

You've tuned your router and it works well. Share it.

1. Export your router from the Local Router UI (`/config` > Router Models > Export) or copy from `~/.config/local-router/router-models.json`.
2. Remove any personal notes or identifying information from candidate `notes` fields.
3. Add a `description` explaining what your router is optimized for.
4. Place it in the right category:
   - `router-configs/coding/` — Coding-focused routers (high coding score threshold)
   - `router-configs/general/` — General-purpose routers
   - `router-configs/budget/` — Cost-optimized routers
   - `router-configs/experimental/` — Novel routing approaches (bandit, ML-based, etc.)
5. Run `npx ts-node scripts/crx-validate.mts --file=<your-file>` to validate.
6. Open a PR.

### 2. Share Model Evaluations

You've benchmarked models and have scores. Share them.

1. Use the CSV format described in [SCHEMA.md](SCHEMA.md).
2. Any benchmark is valid: HumanEval, MBPP, SWE-bench, LiveCodeBench, custom coding tasks, tool-calling tests, etc.
3. Scores should be in 0.0–1.0 range when possible. Include the benchmark name so others can interpret the score.
4. Place it in the right category:
   - `model-evals/coding/` — Coding benchmarks
   - `model-evals/reasoning/` — Reasoning/logic benchmarks
   - `model-evals/tool-use/` — Tool/function calling evaluations
   - `model-evals/multimodal/` — Vision/multimodal benchmarks
5. Run the validator and open a PR.

### 3. Share Anonymized Telemetry

You've been running a router and have performance data. Share it.

1. Export your router events: `GET /api/router-events.csv`.
2. Verify no sensitive columns are present (see SCHEMA.md forbidden columns).
3. Aggregate: combine per-model stats (success rate, latency, tool accuracy, sample count).
4. Place in `telemetry-shares/`.
5. Run the validator and open a PR.

### 4. Propose a Routing Improvement

You have an idea for how routing should work better.

1. Write a proposal in `proposals/<slug>.md` following the template in SCHEMA.md.
2. Link to papers, benchmarks, or community data supporting your proposal.
3. Open a PR for discussion.

## Validation & Quality Standards

All PRs touching `community/` run through `scripts/crx-validate.mts`:

- **Schema check** — Your data matches the expected format
- **Security scan** — No API keys, tokens, passwords, or PII
- **Range check** — Scores and values are in valid ranges
- **Model reference check** — Model IDs exist in `providers.txt`

## After Your PR is Merged

1. The aggregator (`scripts/crx-aggregate.mts`) runs and updates `community/AGGREGATE.md`.
2. Your data contributes to community consensus values for model coding scores, latencies, and success rates.
3. The Continuous Improvement Pipeline (CIP) may pick up your data as a signal for default router configuration updates.

## Privacy & Security

- **Never include API keys, tokens, or credentials.** The validator rejects them.
- **Never include prompts or responses.** Telemetry shares must be aggregate statistics only.
- **Never include PII.** No usernames, emails, IPs, or file paths.
- **Your `evaluator`/`contributor` field** can be your GitHub username — this is the only identifying field allowed.

## Data Use

By contributing, you agree that your data can be:
- Included in the aggregated community consensus
- Used to improve default router configurations
- Cited in research findings by the CIP
- Made available under the same license as this repository

Your raw data remains in the `community/` directory. Individual contributions are traceable via git history. The aggregator produces anonymized consensus values.

## Questions?

Open an issue tagged `community` or `question`.
