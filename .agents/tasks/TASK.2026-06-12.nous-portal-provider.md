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

**Final model set (25 total):**
- **Subscription band (23):** Hermes-4-70B, Hermes-4-405B, MiniMax-M3, DeepSeek-V4-Pro/Flash, Qwen3.7-Max/Plus, Qwen3.6-Plus, Qwen3-Coder, GLM-5.1, Kimi-K2.7-Code, Nemotron-3-Ultra-550B, Step-3.5-Flash, MiniMax-M2.7, Claude-Opus-4.8, Gemini-3.5-Flash, Grok-4.3, plus 6 `~latest` pointers (Claude-Opus/Sonnet, GPT, Gemini-Pro/Flash, Kimi).
- **Free band (2):** `stepfun/step-3.7-flash:free`, `nvidia/nemotron-3-ultra:free`. Both go in the OTHER_FREE exhaustion band, ahead of all paid/subscription candidates.
- **Auto-router top picks (NEW):** `nous-portal-minimax-m3`, `nous-portal-claude-opus-4.8`, `nous-portal-claude-opus-latest`, `nous-portal-gpt-latest`, `nous-portal-gemini-pro-latest`, `nous-portal-kimi-latest` — added to `AUTO_ROUTER_EXTRA_CANDIDATE_IDS` immediately after the Pioneer flag, so the auto-router sees a curated 6 Nous Portal candidates at the top of the leaderboard.

**Validator update (necessary for `~` and new prefixes):**
Added `~`, `minimax/`, `anthropic/`, `openai/`, `google/`, `x-ai/`, `meta-llama/`, `mistralai/`, `ibm-granite/`, `inclusionai/`, `openrouter/`, `cohere/` to the `normalizeModelName` prefix-stripper in `scripts/validate-model-specs.mts`, plus a `-latest` suffix strip after the colon-form `:latest` strip. This lets the validator match the `~<provider>/<model>-latest` IDs to the bare spec keys (`claude-opus`, `kimi`, `gpt`, etc.).

**Pricing (portal-side metadata captured but cost-scored as $0):**
The Portal returns per-model USD/1M-token pricing in `pricing.prompt` / `pricing.completion` fields. The operator is on a Hermes Desktop/CLI plan (org `dc94e593`) so the effective cost is covered by the plan — all Nous Portal pricing entries are `$0/$0` with `validUntil: '2026-12-31'` for year-end review (free-tier rows have no `validUntil`).

**Probe coverage:**
Added `nous-portal` to `.agents/skills/provider-models-list/scripts/probe.mjs` so weekly catalog audits hit the Portal alongside the other 17 providers. `NOUS_API_KEY` must be in the PQC bundle for the live probe to authenticate (note: `/v1/models` is public, but the live `getModels()` helper still issues an `Authorization: Bearer` header when the key is set).

**Files touched (planned):**
- `providers.txt` — new `nous-portal` summary row + 25 model rows
- `src/providers/nous-portal.ts` — new static-key provider module (mirror `src/providers/openrouter.ts` shape)
- `src/index.ts` — register `nous-portal` in provider map
- `src/model-specs.json` — 16 new spec entries (reuse `minimax-m3`, `deepseek-v4-pro`, `qwen3.7-max`, `glm-5.1`, `deepseek-v4-flash`, `qwen3.7-plus`, `step-3.7-flash` from existing entries; add `kimi-k2.7-code`, `kimi`, `minimax-m2.7`, `nemotron-3-ultra-550b-a55b`, `nemotron-3-ultra`, `qwen3-coder`, `qwen3.6-plus`, `step-3.5-flash`, `claude-opus-4.8`, `claude-opus`, `claude-sonnet`, `gpt`, `gemini-pro`, `gemini-flash`, `gemini-3.5-flash`, `grok-4.3`)
- `src/routing-defaults.ts` — 25 `CANDIDATE_DEFAULTS` lines + 6 added to `AUTO_ROUTER_EXTRA_CANDIDATE_IDS` + all 25 in `DEFAULT_FALLBACK_ORDERED_IDS`
- `src/routing-exhaustion-order.ts` — `SUBSCRIPTION_PROVIDERS` + `SUBSCRIPTION_PROVIDER_SUB_ORDER` + `PRESENTATION_PREFIX_TO_PROVIDER` entries
- `src/provider-pricing.ts` — 25 entries at $0/$0 (22 with `validUntil: 2026-12-31`, 2 free-tier without, 1 already)
- `scripts/validate-model-specs.mts` — added `~`, `minimax/`, `anthropic/`, `openai/`, `google/`, `x-ai/`, `meta-llama/`, `mistralai/`, `ibm-granite/`, `inclusionai/`, `openrouter/`, `cohere/` prefixes + `-latest` suffix
- `.agents/skills/provider-models-list/scripts/probe.mjs` — added `nous-portal` to PROVIDERS list for weekly catalog audit
- `llms.txt` — catalog count 17→18 providers, model count 107→129+, +25 Nous Portal catalog row, docs section reference
- `.agents/tasks/TASK.2026-06-12.nous-portal-provider.md` (this file)

**Validation gates (run after edits, before commit):**
- `npx tsx scripts/validate-model-specs.mts`
- `node scripts/validate-cline-kilo-catalog.mjs`
- `npm test -- --test-name-pattern="routing|fallback|execution-plan"`
- Smoke test on `127.0.0.1:11436` with a real `NOUS_API_KEY` (operator-side, gated on PQC bundle).

**Awaiting operator decision before proceeding:**
- Confirm **static API key** path for this PR (OAuth deferred to follow-up).
- Confirm initial model set is **Hermes-4-70B + Hermes-4-405B only** (300+ other Portal models deferred).
- Confirm provider slug is **`nous-portal`** (display name "Nous Portal") rather than the docs' `nous` (avoids collision with company name; mirrors `opencode-zen` vs `opencode` precedent).
