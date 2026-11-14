# TASK.2026-11-12 — Provider migrations (pioneer→fastino, opencode Console API) + catalog auto-refresh and federated hide-toggles

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `feat/provider-migrations-catalog-federation` (worktree `../local-router-provider-migrations`, off `main` @ 056e13d)
- Plan: `.agents/plans/2026-11-12-provider-migrations-catalog-federation.plan.md` (§4.1/§4.2 resolved by operator 2026-11-12)
- Status: done

## Operator decisions (2026-11-12)

- §4.1 opencode: chat-completions family only at `https://opencode.ai/inference/openai/v1` (parity
  with today's capability; other protocol families stay un-served).
- §4.2 discoveries: default-UNCHECKED. Refresh shows every model in the catalog view; tools see
  only toggled-on models. This retires the 2026-09-04 "new-discovery auto-curation" contract.

## Worktree journal

- Branch cut 2026-11-12 from `main` @ 056e13d; commit `7f964c0` (author
  `Nanoboozhoo - embodies by omp <nanoboozhoo@local>` per AGENTS.md rule 4).
- Diffstat: 13 files, +559/−242; new `tests/fastino-migration.test.mjs`,
  `tests/catalog-federation.test.mjs`; `docs/caching/pioneer.txt` renamed `fastino.txt` (80%).
- Merge commit `cd3fe1a` `merge: feat/provider-migrations-catalog-federation — fastino/opencode
  migrations + catalog refresh & federated toggles` into `main`.
- Landing proof: `git log main..feat/provider-migrations-catalog-federation` empty; diffstat
  matches; worktree removed (`--force` after proving its untracked `.agents` state was a
  rules-template deployment with zero unique entries) and branch deleted (was 7f964c0).

## What changed

- **pioneer → fastino** (`src/provider-registry.ts`, `src/provider-model-registries.ts`):
  `api.fastino.ai/v1` + `FASTINO_API_KEY`; registry block rebuilt from the LIVE PUBLIC
  `https://api.fastino.ai/v1/models` (14 models — 4 Nemotron chat rows with live specs; the
  GLiNER utility family arrives via refresh as hidden discoveries). The 166-model pioneer
  reseller block is deleted (facts of a retired wire).
  Legacy continuity: `pioneer-*` presented ids resolve via structural aliases in
  `providerModelAliases` (same templates, old provider name); `canonicalProviderSlug` maps the
  `pioneer` slug; `loadKeysFromEnvironment` migrates `PIONEER_API_KEY` → `FASTINO_API_KEY`.
  Chain/default cleanup: `pioneer-moonshotai-kimi-k3` dropped from `DEFAULT_FALLBACK_PAID_IDS`
  and the multimodal preset (Kimi is not in fastino's catalog; the step was dead).
- **opencode → Console inference API**: `opencode-go`/`opencode-zen` endpoints now
  `https://opencode.ai/inference/openai/v1`; provider notes carry the `oc_sk_` key format and
  the free-tier 403-outside-OpenCode rule. Chain ref `opencode-zen-glm-5.3-flash` unchanged.
- **Policy honesty** (`src/provider-policy.ts`): the fastino row is conservative
  `implicitCache` + sticky `prompt_cache_key` — the pioneer wire's cache_control/retention
  markers are NOT re-verified on the new host (docs/caching/fastino.txt keeps the historical
  measurements and says so). Old pioneer marker tests deleted (engine coverage lives in the
  zenmux cases); the sticky-key and tiny-prompt tests pin the new conservative contract.
- **3-hour auto-refresh** (`scheduleCatalogAutoRefresh` in `src/index.ts`): keyed/OAuth
  providers only, `preserveCuration: true`, per-provider failure isolation, boot tick at +60s,
  `LOCAL_ROUTER_CATALOG_REFRESH_HOURS` (0 disables).
- **Discoveries hidden (§4.2)**: `refreshProviderEndpointModels` and `/api/refresh-endpoint-models`
  no longer auto-curate new models; explicit admissions (custom-editor upserts, registered local
  backends, fallback-healer re-curates for chain references) still self-check.
- **Federated hide-toggles (T4)**: `RouterSettings.catalogSelection { curatedKeys,
  clearedProviders }` in the checkout's `router-settings.json`; `persistModelSourceConfig` is the
  single choke point that read-merge-writes it beside the chain (2026-11-10 bulk-write hazard
  avoided — routes survive curation writes); boot overlay makes the federated file win, and a
  pre-federation machine publishes its local selection once.

## Verification

- Full suite: 378 tests, 366 pass, 12 skipped (sandbox-gated), 0 fail. Retired-contract tests
  rewritten (auto-curation → hidden; pioneer markers → fastino conservative); policy-docs
  bijection restored via the renamed `docs/caching/fastino.txt`.
- Live smoke on :11436 (11/11): legacy `pioneer-*` id answers with the exact fastino wire model;
  refresh discovery hidden from `/v1/models` but visible in the catalog view; toggled-on model
  serves; toggle-off drops it from served rows while `router-settings.json` carries
  `catalogSelection` AND the chain intact.
- Browser screenshot of `/config/providers`: fastino card "5 · 2 served, Key configured
  FASTINO_API_KEY" with discovered models and per-model toggles.
- Live deploy: `main` @ cd3fe1a rebuilt, daemon restarted (old PID SIGTERMed first), provider
  configs confirm `fastino` configured via the migrated key, `pioneer` retired, opencode on the
  Console endpoint (`opencode-zen` configured).

## Operator follow-ups

- `opencode-go` reports NOT configured — if a single `oc_sk_` key should serve both routes, put
  it in `OPENCODE_API_KEY` too (or leave go unused).
- The old opencode keys are revoked upstream: create `oc_sk_…` keys in the Console and save them
  on the provider cards. Free-tier models will 403 from the router — paid balance or Go needed.
- Fastino caching semantics are deliberately unverified (`docs/caching/fastino.txt`): if the
  wire accepts cache_control markers, the measured pioneer policy can be restored with evidence.
