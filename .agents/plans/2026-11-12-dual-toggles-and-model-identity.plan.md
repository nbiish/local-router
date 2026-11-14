---
plan_format: ainish/plan/v1
slug: dual-toggles-and-model-identity
date: 2026-11-12
status: done
branch: feat/dual-toggles-model-identity
worktree: /Volumes/1tb-sandisk/code-external/local-router-dual-toggles
task_record: .agents/tasks/TASK.2026-11-12.dual-toggles-model-identity.md
operator: direct
---

# Plan: Dual per-model toggles (serve + archive) + live-model identity fix

## 1. Problem

Two operator asks (2026-11-12, after the fastino/caching work):

1. **Two toggles per model row** on `/config/providers`: one toggles the model in the
   `localhost:11434/v1/models` list (exists — the serve/curation checkbox), the other removes
   the model from the config UI entirely (archive), so unpreferred/old models that keep
   arriving from provider `/models` refreshes stop cluttering the lists. Plus a new section
   showing archived ("toggled off") models to restore on mistake. (A reported "pioneer"
   remnant was the operator's misread of `fastino` — nothing to purge.)
2. **Missing upstream models** — wafer serves `DeepSeek-V4.1-Flash-1017` and `DeepSeek-V4-Pro`
   live, and the router drops them even after a live refresh ("and likely others").

## 2. Anchor facts (verified)

- **The drop is a merge bug, not lag**: `mapLiveRawModelsToCatalog` (src/index.ts) pushes
  `{ ...matchingBaseline, id: presentedId, … }` when `pickBaselineModel` matches — the row's
  `model` identity becomes the BASELINE's id. `pickBaselineModel` (src/model-metadata.ts) matches
  by `aliasKeys` (case/segment-insensitive), so live `DeepSeek-V4-Pro` borrows baseline
  `deepseek-v4-pro`, its `endpointModelCurationKey` (`wafer-serverless::deepseek-v4-pro`)
  collides with the real `deepseek-v4-pro` row, and `fetchProviderEndpointModels`' dedupe
  deletes it. Same for `DeepSeek-V4.1-Flash-1017` vs `DeepSeek-V4.1-Flash`. Reproduced live:
  `POST /api/provider-models/wafer-serverless/refresh` returns 17 rows and both ids still
  never reach `/api/provider-models?mode=all`.
- Catalog UI: `renderCurationCatalog()` in `src/ui/pages/layout.ts` renders per-provider
  `ul.model-list` rows (serve checkbox `data-row-key` → `toggleCatalogRow` → `curationSelectedKeys`
  → debounced `saveCuration` → `PUT /api/model-curation`). `+ Fallback` staging button per row.
- Curation state is federated: `RouterSettings.catalogSelection` in `router-settings.json`
  (`persistModelSourceConfig` read-merge-write choke point; boot overlay).
- The serve toggle and the config-visibility toggle are orthogonal by operator definition:
  archive hides from the config lists only; `/v1/models` membership stays the serve toggle's
  job.

## 3. Plan

### Goals

- Every live upstream model survives refresh into the catalog with ITS OWN identity
  (case/alias twins coexist); baselines lend metadata only.
- Each catalog row carries two toggles: serve (existing) and show-in-config (new). Unchecking
  show-in-config archives the model: hidden from every provider list, listed in a new
  "Archived models" section with a restore toggle (and its serve toggle).
- Archived state federates across machines like the serve selection (same file, same choke
  point) and survives refreshes (a re-discovered archived model stays archived).

### Non-goals

- No changes to `/v1/models` membership semantics (serve toggle remains the only authority).
- No deletion of archived models from the cache (archive is presentation state, restore must
  be lossless).
- No fallback-chain or caching changes.

### Constraints and invariants

- "Decisions live in code": archive state is a plain key set (`provider::model`), never
  inferred; `router-settings.json` keeps one writer per mutation boundary (2026-11-10 hazard).
- Identity invariant: `model`/`provider`/`display` on a catalog row always describe the live
  upstream id; `pickBaselineModel` may fill metadata ONLY.

### Files and symbols

- `src/index.ts` — `mapLiveRawModelsToCatalog` identity fix; `loadModelSourceConfig` /
  `persistModelSourceConfig` archive-key federation.
- `src/model-metadata.ts` — `pickBaselineModel` doc note (identity vs metadata).
- `src/config-persistence.ts` — `RouterSettings.catalogSelection.archivedKeys`.
- `src/routes/config-api.ts` — `GET/PUT /api/model-curation` carry `archivedKeys`.
- `src/ui/pages/layout.ts` — second per-row toggle, archive filtering, "Archived models"
  restore section.
- `tests/` — identity regression (twins survive refresh), archived-key federation + restore.

## 4. Clarifications

None pending: the two toggles' semantics and the restore section are specified by the operator.

## 5. Todos

- [x] **T1** Identity fix in `mapLiveRawModelsToCatalog` (live `model`/`display`/`provider` win;
  baselines lend metadata) + regression test: `DeepSeek-V4-Pro` and `DeepSeek-V4.1-Flash-1017`
  both survive a refresh alongside their twins.
- [x] **T2** Archived-key state: `RouterSettings.catalogSelection.archivedKeys`, boot overlay +
  federation choke point, `GET/PUT /api/model-curation` support.
- [x] **T3** UI: second per-row toggle (show-in-config), archive filtering of provider lists,
  "Archived models" restore section (restore + serve toggles), counts.
- [x] **T4** Tests + full suite + live smoke (twins served distinctly; archive hides/restores;
  federated file carries archivedKeys; live wafer section shows the two recovered models) +
  page screenshot.

## 6. Verification

- `npm test` green; new regression + federation tests.
- Live: `POST /api/provider-models/wafer-serverless/refresh` then `/api/provider-models?mode=all`
  contains `DeepSeek-V4.1-Flash-1017` and `DeepSeek-V4-Pro`.
- Screenshot `/config/providers`: two toggles per row visible; a model archived disappears from
  its provider list and appears under "Archived models"; restore brings it back.

## 7. Implementation notes (2026-11-12/13)

Shipped as `dcd33b6` + follow-up `d4e172a`, both merged to `main`; see
`.agents/tasks/TASK.2026-11-12.dual-toggles-model-identity.md` for the journal.

- T1 turned out to be TWO bugs: the identity clobber in `mapLiveRawModelsToCatalog` (baselines
  lending `model`/`display` identity) and `knownProviderModels` returning only the override
  store when one existed (shadowing cache discoveries from the management view and card
  counts). Both fixed; the card-count contract test now asserts view agreement instead of
  the old shadowing semantics.
- The reported "pioneer" remnant was the operator's misread of `fastino` — nothing to purge.
- UI verification note: clicks against a re-rendering DOM can misroute (harness artifact);
  the handlers proved deterministic in single-click probes.
