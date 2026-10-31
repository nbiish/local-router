# Task — pin the OpenRouter Jev decision model

- **Branch:** `fix/decisions-always-available`
- **Worktree:** `D:/Code/lr-decisions-pinned`
- **Lane:** now (claimed 2026-10-31T01:00-04:00 / 05:00Z)
- **Status:** merging

## Objective

`openrouter/jev-1.14` must be served whenever the OpenRouter API key is
configured — no curation toggle, catalog edit, `filterConfigured` flip, or
shadowing provider-model row may remove it.

## Recon

- Decision rows are appended after curation today, so a fresh key-only install
  already survives `PUT /api/model-curation {selectedKeys: []}` (reproduced on
  an isolated temp store before changing code).
- Real gaps: no explicit pin (a future catalog change could drop the row), no
  dedupe if a same-id catalog/override row exists, and nothing stops an operator
  from authoring a provider model named `openrouter/jev-1.14` (which would
  shadow the id in `presentedModelList`/picker paths).

## Change

- `ProviderModel.alwaysAvailable` flag; `decisionModelEntries()` sets it.
- `applyEndpointCuration` and `filterConfiguredModels` honour the pin.
- `withDecisionModels()` collapses a same-id catalog row and appends the
  authoritative decision row; used by `/v1/models`, `/api/tags` (via
  `discoveryModelList`), and the provider-scoped listing.
- `findPresentedNameConflict` reserves decision ids (400 on authoring).
- VS Code chat picker excludes pinned rows.
- Availability still gated on the provider key: no key → not advertised,
  decisions route answers 503.

## Verification

- `tests/decisions-pinned.integration.test.mjs` (6 tests): shadow-row dedupe
  (asserts the shadow row is really in curated keys), curation clear/replace/
  enable, `filterConfigured` both ways, `/api/tags` + `?provider=` agreement,
  reserved-id authoring rejection, and the unkeyed mirror case.
- Full suite: 217 tests, 215 pass, 2 fail — the same pre-existing failures
  (`antigravity-auth-platform-detect` host session, `custom-providers`
  upstream request count) that fail on `main`.

## Risks

- ZenMux's row is pinned the same way but still gated on the ZenMux key; its
  decisions route remains not-yet-open for `typesafe/jev-1.14`, which the probe
  reports honestly.
