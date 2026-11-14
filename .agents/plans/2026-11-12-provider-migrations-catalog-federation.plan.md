---
plan_format: ainish/plan/v1
slug: provider-migrations-and-catalog-federation
date: 2026-11-12
status: done
branch: feat/provider-migrations-catalog-federation
worktree: /Volumes/1tb-sandisk/code-external/local-router-provider-migrations
task_record: .agents/tasks/TASK.2026-11-12.provider-migrations-catalog-federation.md
operator: question-me
---

# Plan: Provider migrations (pioneer→fastino, opencode new API) + catalog auto-refresh and federated hide-toggles

## 1. Problem

Three operator asks (2026-11-12):
1. The `pioneer` provider is now **fastino** (`https://api.fastino.ai/v1`, `FASTINO_API_KEY`;
   example: `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4`) — migrate the provider and
   keep old `pioneer-*` references working.
2. **opencode** changed its API (Console inference at `https://opencode.ai/inference`) and
   revoked the old keys — the `opencode-go` / `opencode-zen` providers must move to the new
   API and re-key.
3. Providers with a valid key should **fetch their latest models every 3 hours** and show all
   available models, while a per-model **hide toggle** keeps unwanted models out of what tools
   see via `/v1/models` — and that toggle state must **federate across machines** like the
   fallback chain does (`router-settings.json`), so every machine serves the same selection.

## 2. Anchor facts (verified in-repo and against upstream docs, 2026-11-12)

- `pioneer` lives at `src/provider-registry.ts` (`endpoint: https://api.pioneer.ai/v1`,
  `keyEnvVar: PIONEER_API_KEY`); its registry block `PROVIDER_MODEL_REGISTRY['pioneer']`
  (`src/provider-model-registries.ts:1236`, header line 15: "live, 166; public") already carries
  `fastino/Fastino-Nemotron-3.5-Lightning-*` and `nvidia/NVIDIA-Nemotron-3.5-*` upstream ids.
- fastino wire (operator-provided): `POST https://api.fastino.ai/v1/chat/completions`,
  `Authorization: Bearer $FASTINO_API_KEY`, model ids keep slash form
  (`nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4`).
- opencode today: `opencode-go` (`https://opencode.ai/zen/go/v1`, `OPENCODE_API_KEY`) and
  `opencode-zen` (`https://opencode.ai/zen/v1`, `OPENCODE_ZEN_API_KEY`) — `src/provider-registry.ts:49-50`.
- opencode new Console inference API (`https://opencode.ai/docs/console/api/inference`):
  base `https://opencode.ai/inference`; OpenAI chat at `/inference/openai/v1/chat/completions`,
  OpenAI Responses at `/inference/openai/v1/responses`, Anthropic Messages at
  `/inference/anthropic/v1/messages`, Gemini at `/inference/google/v1beta/models/<model>:…`;
  live model list at `/inference/v1/models`; keys are `oc_sk_…`; **free-tier models answer 403
  to non-OpenCode clients** — paid models or a Go subscription are required from the router.
- The router's only upstream wire is `<provider.baseUrl>/chat/completions`
  (`src/index.ts`, `proxyModelAttempt`); there is no per-family upstream dispatch today — the
  docs/caching/opencode-*.txt protocol families describe upstream reality, not a router
  transport. `providerBaseUrl()` honours `LOCAL_ROUTER_PROVIDER_<NAME>_BASE_URL` overrides.
- Model refresh is manual today: `POST /api/provider-models/:provider/refresh` and
  `POST /api/refresh-endpoint-models` (`src/routes/config-api.ts:875-943`); the bulk refresh
  **auto-curates new discoveries** ("New-discovery auto-curation (2026-09-04)… a live refresh
  makes new models usable without a manual re-check pass").
- The hide toggle is the catalog curation: `toggleCatalogRow` →
  `modelSourceConfig.curatedEndpointModelKeys`, filtered at serving time by
  `applyEndpointCuration` — persisted in per-machine `~/.config/local-router/model-source-config.json`
  (`MODEL_SOURCE_CONFIG_PATH`, `src/index.ts:268`). `operatorClearedProviders` lives beside it.
- Federated config: `RouterSettings` = `{ fallbackModelsText?, routes? }` in the checkout's
  `router-settings.json` (`src/config-persistence.ts:56-60`); `config-paths.ts` resolution
  (env pin → checkout → machine) is what makes the chain travel with the repo sync.

## 3. Plan

### Goals

- `fastino` replaces `pioneer`: provider entry, registry block, presented-id prefix, key env —
  clean cutover; legacy `pioneer-*` ids keep resolving (alias map) and the chain file is
  migrated in place, like `migrateGatewayFallbackMiniMax` did.
- `opencode-go`/`opencode-zen` speak the new Console inference API and accept the new keys
  (scope per §4.1).
- Every provider with a configured key refreshes its model list automatically every 3 hours
  (and once at boot), merging all upstream models into the catalog view.
- The curated serve-list (hide toggles) moves into `router-settings.json` so a repo sync
  carries the same tool-visible selection to every machine; `model-source-config.json` is
  migrated on first load and keeps only machine-local state.

### Non-goals

- No new upstream protocol transports beyond what §4.1 selects.
- No realtime cross-machine toggle propagation — the repo sync (last writer wins) is the
  federation mechanism, same as the chain.
- No fallback-chain semantics changes.

### Constraints and invariants

- "Decisions live in code": the refresh cadence (3 h), the auto-refresh eligibility (keyed
  providers only), and the curation default (§4.2) are deterministic code/config.
- `router-settings.json` remains the single writer-per-mutation-boundary file: curation writes
  go through the same `loadRouterSettings`/`saveRouterSettings` round-trip as the chain, never a
  second writer.
- A hidden model MUST stay resolvable for chain authoring and execution (curation gates
  discovery serving only — `applyEndpointCuration` semantics unchanged).
- Legacy `pioneer-*` ids MUST NOT break: chains, agent configs, and trajectory history
  reference them.

### Proposed architecture

- `src/provider-registry.ts` + `src/provider-model-registries.ts`: `pioneer` block renamed
  `fastino`, endpoint/key env updated; `opencode-*` endpoints updated to the Console API base.
- `src/index.ts`: `PIONEER_LEGACY_MODEL_ALIASES` (built from the registry block, mirroring
  `GATEWAY_PRESENTED_LEGACY_ALIASES`) + a one-shot chain migration rewriting `pioneer-*` step
  ids to `fastino-*` in `router-settings.json`.
- `src/index.ts`: `scheduleCatalogAutoRefresh()` — 3-hour interval + boot tick over providers
  with `providerHasConfiguredKey`, calling the existing `refreshProviderEndpointModels`
  (`preserveCuration: true`).
- `src/config-persistence.ts`: `RouterSettings` gains `catalogSelection?: { curatedKeys:
  string[]; clearedProviders?: string[] }`; `src/index.ts` loads it into `modelSourceConfig`
  at boot (migrating the per-machine file once) and persists curation changes back through
  `saveRouterSettings`. `model-source-config.json` keeps `defaultCurationConfig` etc.

### Files and symbols

- `src/provider-registry.ts` — `pioneer`→`fastino` entry; `opencode-go`/`opencode-zen` endpoints.
- `src/provider-model-registries.ts` — `'pioneer'` block → `'fastino'`; add the operator's
  `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4` row (facts from a live `/models` probe
  where reachable; conservative defaults otherwise).
- `src/index.ts` — legacy alias map + chain migration; `scheduleCatalogAutoRefresh`; curation
  state load/save via `RouterSettings`; `defaultPresentedModelName` prefix.
- `src/config-persistence.ts` — `RouterSettings.catalogSelection`.
- `src/routes/config-api.ts` — toggle endpoints persist through the federated path.
- `tests/` — alias/migration tests, refresh-eligibility test, curation round-trip through
  router-settings.

### Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep `pioneer` as a provider alias pointing at fastino | Two names for one upstream forever; the operator asked for the rename, and id aliases already cover stale references |
| Move curation into its own federated file | A second shared file drifts from the chain; `router-settings.json` is the established "travels with code" boundary (one writer per file) |
| On-demand-only refresh (no timer) | The operator explicitly wants "latest models every 3 hours" without sorting a growing list by hand |

## 4. Clarifications

### 4.1 opencode transport scope

- **Question:** The new Console API serves four protocol families per model (OpenAI chat,
  OpenAI Responses, Anthropic Messages, Gemini). The router today only speaks
  `…/chat/completions` upstream. How far should the migration go?
- **Options:** 1. (Recommended) chat-completions family at `https://opencode.ai/inference/openai/v1`
  — parity with today's capability, just the new API/keys; other-family models stay hidden.
  2. Full per-family dispatch (new transport capability: upstream Anthropic Messages +
  Responses + Gemini routing per model) — larger build, touches the hot proxy path.
  3. Retire `opencode-zen`/`opencode-go` and re-key nothing until a later pass.
- **Selected:** 1 — chat-completions family at `https://opencode.ai/inference/openai/v1`. Operator confirmed 2026-11-12: parity with today's capability, new API + `oc_sk_` keys; models on other protocol families stay un-served.
- **asked:** operator
- **resolved by:** operator (2026-11-12)

### 4.2 New discoveries vs the hide toggle

- **Question:** With a 3-hour auto-refresh pulling in new upstream models, what do tools see
  by default for a model the operator has never toggled?
- **Options:** 1. (Recommended) default-hidden: the UI shows every discovered model, tools see
  only explicitly checked ones — "show only the latest of my preferred models" with no leaks.
  2. Auto-curated (today's contract): new models become tool-visible immediately and the
  operator unchecks what they don't want.
- **Selected:** 1 — default-hidden. Operator confirmed 2026-11-12. This retires the
  2026-09-04 "new-discovery auto-curation" contract for REFRESH discoveries: a model found by
  an auto/manual refresh lands in the catalog view unchecked. Explicit operator actions
  (custom-editor upserts, registered local backends) stay pre-checked — they are deliberate
  admissions, not discoveries.
- **asked:** operator
- **resolved by:** operator (2026-11-12)

## 5. Todos

- [x] **T1** `pioneer`→`fastino` cutover: provider entry, registry block (with the operator's
  Nemotron-Super-VL row), presented-id prefix, key env, legacy `pioneer-*` alias map, and the
  one-shot chain migration in `router-settings.json`.
  - verify: `node --test tests/fastino-migration.test.mjs` (new) + a live fastino call
- [x] **T2** opencode → Console inference API per §4.1, including the free-tier 403 note in
  the provider card and `oc_sk_` key guidance.
  - verify: live call through `opencode-*` with a new key
- [x] **T3** `scheduleCatalogAutoRefresh()`: 3-hour interval + boot tick, keyed providers only,
  `preserveCuration: true`, failures isolated per provider.
  - verify: unit/eligibility test + live trigger
- [x] **T4** Federated hide-toggles: `RouterSettings.catalogSelection`, boot migration from
  `model-source-config.json`, toggle writes through `saveRouterSettings`.
  - verify: `node --test tests/catalog-federation.test.mjs` (new) + live toggle round-trip
- [x] **T5** Full suite + live smoke on :11436 + page screenshot (catalog toggles + served list).

## 6. Verification

- `npm test` — full suite green.
- Live smoke: fastino model resolves and answers; `pioneer-*` id still resolves; a toggled-off
  model vanishes from `/v1/models` but stays in the UI; `router-settings.json` shows the
  selection; a refresh adds a fake upstream model that lands hidden per §4.2.

## 7. Implementation notes (2026-11-12)

Shipped as `7f964c0`, merged to `main` as `cd3fe1a`; see
`.agents/tasks/TASK.2026-11-12.provider-migrations-catalog-federation.md` for the journal.

- The fastino registry block is built from the LIVE public `https://api.fastino.ai/v1/models`
  (14 models), not a rename of the 166-row pioneer block — the old rows describe models the new
  host does not sell. GLiNER utility models arrive via refresh as hidden discoveries.
- fastino's policy row is conservative (`implicitCache` + sticky `prompt_cache_key`): the
  pioneer wire's cache_control/retention markers are unverified on the new host, and injecting
  unverified content-block shapes into a fresh OpenAI-compatible wire risks 400s on every
  request. `docs/caching/fastino.txt` keeps the historical measurements as provenance.
- Legacy continuity is four surfaces: provider entry, presented-id aliases (structural templates
  with the old name), the `canonicalProviderSlug` map, and the key env migration.
- `opencode-go` and `opencode-zen` share the single Console endpoint; a single `oc_sk_` key can
  serve both routes via their two env names.
