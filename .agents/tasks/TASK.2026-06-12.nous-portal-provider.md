# TASK.2026-06-12.nous-portal-provider

## CoD
- worktree off develop created
- Nous Portal API endpoint confirmed
- bearer NOUS_API_KEY auth pattern verified
- decision: static-key vs OAuth needed
- Hermes 4 70B/405B as initial models
- providers.txt summary table row added
- src/providers/nous-portal.ts stub created
- src/oauth-providers.ts gated on user choice
- src/model-specs.json hermes-4 entries updated
- src/routing-defaults.ts candidate lines added
- src/routing-exhaustion-order.ts sub-order added
- src/provider-pricing.ts portal pricing added
- llms.txt catalog row + count updated
- validators and smoke test run
- 25 models curated initially
- user trimmed to 8 models
- 17 entries pruned from CANDIDATE_DEFAULTS
- 17 entries pruned from provider-pricing
- 17 entries pruned from model-specs
- AUTO_ROUTER_EXTRA_CANDIDATE_IDS updated
- DEFAULT_FALLBACK_ORDERED_IDS expanded 21->29
- openrouter-kimi-k2.7-code added
- wafer-ai-deepseek-v4-pro pricing updated
- cacheReadPricePerM field added
- model-specs nemotron override removed
- 12/12 unit tests pass
- model-specs validator 0 errors
- PQC bundle restored after recovery
- NOUS_API_KEY + OPENCODE_ZEN + PIONEER repacked
- BBMCP_TEST_* keys cleaned
- develop -> main merged (942d171)
- worktrees + feat branch removed

####

**Goal:** Onboard Nous Research's "Nous Portal" (`https://portal.nousresearch.com`) as a new provider in local-router so that Hermes Desktop/CLI plan credits can be used through the existing `127.0.0.1:11434` proxy.

**Endpoint research (complete):**
- **Base URL:** `https://inference-api.nousresearch.com/v1` (OpenAI-compatible wire format). `GET /v1/models` is **publicly accessible** (HTTP 200, no auth required) and returns 265 models with rich metadata (`canonical_slug`, `hugging_face_id`, `context_length`, `pricing`, `architecture.modality`, `supported_parameters`).
- **Auth — both paths exist:**
  1. **Static API key** (used here): `Authorization: Bearer $NOUS_API_KEY` header. Issued from the portal dashboard, format `sk-nous-...`. Confirmed live via the operator's curl on `stepfun/step-3.7-flash:free`.
  2. **OAuth subscription** (deferred): browser PKCE via `hermes setup --portal`.
- **The `~` prefix** is a Nous Portal feature: model IDs like `~anthropic/claude-opus-latest`, `~moonshotai/kimi-latest`, `~openai/gpt-latest` are "latest snapshot" pointer aliases that always resolve to the most recent revision of that family. Passed through unchanged by local-router; the validator strips the `~` for spec lookup. Twelve such pointers are available (Claude opus/sonnet/haiku/fable, GPT latest/mini, Gemini pro/flash, Moonshot Kimi, etc.).

**Live catalog discovery (complete):**
The Portal exposes 265 models. Cross-referenced against the local-router preferred set (Wafer, ZenMux, NVIDIA NIM, Moonshot, Kilo/Cline, OpenCode Go, Pioneer, OpenRouter presets) — **all** flagships and 1M-context models are present, including 6 of the `~latest` pointer families. Selected 22 additional preferred models (plus the original 3) for a 25-row Nous Portal catalog covering every local-router preferred family.

**Final model set (8 — user-curated after onboarding):**
- **Subscription band (6):** `hermes-4-70b`, `hermes-4-405b`, `minimax-m3`, `deepseek-v4-pro`, `kimi-k2.7-code` (Nous naming), `mimo-v2.5-pro`.
- **Free band (2):** `step-3.7-flash:free`, `nemotron-3-ultra:free`. Both in OTHER_FREE exhaustion band, ahead of paid/subscription candidates.
- 17 originally-provisioned models removed (claude-opus-4.8, claude-opus-latest, claude-sonnet-latest, gpt-latest, gemini-pro-latest, gemini-flash-latest, gemini-3.5-flash, grok-4.3, kimi-latest, nemotron-3-ultra-550b-a55b, step-3.5-flash, minimax-m2.7, deepseek-v4-flash, qwen3.7-max, qwen3.7-plus, qwen3.6-plus, qwen3-coder, glm-5.1).

**Validator update (necessary for `~` and new prefixes):**
Added `~`, `minimax/`, `anthropic/`, `openai/`, `google/`, `x-ai/`, `meta-llama/`, `mistralai/`, `ibm-granite/`, `inclusionai/`, `openrouter/`, `cohere/` to the `normalizeModelName` prefix-stripper in `scripts/validate-model-specs.mts`, plus a `-latest` suffix strip after the colon-form `:latest` strip. This lets the validator match the `~<provider>/<model>-latest` IDs to the bare spec keys (`claude-opus`, `kimi`, `gpt`, etc.).

**Pricing (portal-side metadata captured but cost-scored as $0):**
The Portal returns per-model USD/1M-token pricing in `pricing.prompt` / `pricing.completion` fields. The operator is on a Hermes Desktop/CLI plan (org `dc94e593`) so the effective cost is covered by the plan — all Nous Portal pricing entries are `$0/$0` with `validUntil: '2026-12-31'` for year-end review (free-tier rows have no `validUntil`).

**Companion updates in this release:**
- **`openrouter-kimi-k2.7-code`** added (paid anchor, $0.95/$4 per 1M) — OpenRouter's specific kimi-k2.7 variant.
- **Wafer `deepseek-v4-pro`** pricing updated to $1.20/$2.40 per 1M with $0.10 per 1M cache read (ZDR enhanced inference tier). New `cacheReadPricePerM?: number` field on `ProviderPricingEntry` type, wired through `loadProviderPricingStore` + `upsertProviderPricingEntry`.

**Probe coverage:**
Added `nous-portal` to `.agents/skills/provider-models-list/scripts/probe.mjs` so weekly catalog audits hit the Portal alongside the other 17 providers. `NOUS_API_KEY` must be in the PQC bundle for the live probe to authenticate (note: `/v1/models` is public, but the live `getModels()` helper still issues an `Authorization: Bearer` header when the key is set).

**Files touched:**
- `providers.txt` — `nous-portal` summary row + 8 model rows; `openrouter-presets` kimi-k2.7-code row
- `src/providers/nous-portal.ts` — new static-key provider module (48 lines, mirror `src/providers/openrouter.ts` shape)
- `src/index.ts` — register `nous-portal` in provider map
- `src/model-specs.json` — kept `hermes-4-70b`, `hermes-4-405b`, `kimi-k2.7-code`, `nemotron-3-ultra`; removed 13 portal-only entries; dropped stale `nemotron-3-ultra` Nous override
- `src/routing-defaults.ts` — 8 Nous Portal `CANDIDATE_DEFAULTS` + 1 `openrouter-kimi-k2.7-code` + 8 Nous Portal + 1 openrouter kimi in `DEFAULT_FALLBACK_ORDERED_IDS` (21→29 total) + 10 nous-portal/openrouter entries in `AUTO_ROUTER_EXTRA_CANDIDATE_IDS`
- `src/routing-exhaustion-order.ts` — `SUBSCRIPTION_PROVIDERS` + `SUBSCRIPTION_PROVIDER_SUB_ORDER` (added `nous-portal` as 7th) + `PRESENTATION_PREFIX_TO_PROVIDER` entries
- `src/provider-pricing.ts` — 8 Nous Portal entries ($0/$0), 1 openrouter-kimi-k2.7-code ($0.95/$4), 1 wafer-deepseek-v4-pro (ZDR pricing with cache); added `cacheReadPricePerM?: number` to type
- `scripts/validate-model-specs.mts` — added `~`, `minimax/`, `anthropic/`, `openai/`, `google/`, `x-ai/`, `meta-llama/`, `mistralai/`, `ibm-granite/`, `inclusionai/`, `openrouter/`, `cohere/` prefixes + `-latest` suffix
- `.agents/skills/provider-models-list/scripts/probe.mjs` — added `nous-portal` to PROVIDERS list for weekly catalog audit
- `llms.txt` — catalog count 17→18 providers, model count 129→112, +8 Nous Portal catalog row, fallback chain 19→29, +2026-06-12→13 changelog entry
- `.agents/tasks/TASK.2026-06-12.nous-portal-provider.md` (this file)
- `tests/provider-keys.integration.test.mjs` — expected anchors trimmed to 8 nous-portal + 1 openrouter kimi
- `tests/routing-exhaustion-order.test.mjs` — `SUBSCRIPTION_PROVIDER_SUB_ORDER` test updated to include `nous-portal`

**Validation gates (all green):**
- `npx tsx scripts/validate-model-specs.mts` — 0 errors
- `node --test --test-timeout=30000 tests/routing-exhaustion-order.test.mjs tests/gateway-provider-catalog.test.mjs tests/ollama-cloud-catalog.test.mjs` — 12/12 pass
- `node --test --test-timeout=20000 tests/fallback-disabled-models.test.mjs tests/fallback-disabled-execution-plan.test.mjs tests/fallback-content-classifier.test.mjs tests/ollama-cloud.test.mjs` — 35 pass
- `node --test --test-timeout=15000 tests/gateway-response.test.mjs` — pass
- `tsc` build clean
- Smoke test on `127.0.0.1:11436` — PQC bundle loaded 16/16 keys, NOUS API live (HTTP 200, 265+ models), 8 nous-portal entries in catalog, fallback chain 29 entries

**PQC recovery incident (resolved):**
- Root cause: a test `pqc-secrets pack` call hit the live bundle instead of an isolated fixture, replacing 15 production keys with a single test key.
- Recovery: exported from `secrets.bundle.json.bak.2026-06-10T15-27-18-012Z`, reformatted with python regex, re-packed with the new `NOUS_API_KEY` plus user-recovered `OPENCODE_ZEN_API_KEY` and `PIONEER_API_KEY`.
- Cleanup: removed two `BBMCP_TEST_*` leftover keys from the recovery backup.
- Final PQC bundle: 16 provider keys, no plaintext, no `.env`, ML-KEM-768-wrapped AES-256-GCM ciphertext.

**Release flow:**
- Worktree `feat/provider-nous-hermes` → merged to `develop` (`0cffe14`) → fixup `d92d7e0` (nemotron-3-ultra presented ID alignment) → `develop` (final `856e609`) → `main` (release `942d171`).
- Worktrees removed: `prompt-caching-deep-research` (develop), `provider-nous-hermes` (feature).
- Branch removed: `feat/provider-nous-hermes` (fully merged).
- Branches kept: `develop` (integration, future work), `main` (release), `docs/prompt-caching-research` (unrelated, preserved).
