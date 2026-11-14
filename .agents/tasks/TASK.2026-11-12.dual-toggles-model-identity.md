# TASK.2026-11-12 — Dual per-model toggles (serve + archive) + live-model identity fix

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branches: `feat/dual-toggles-model-identity` (worktree `../local-router-dual-toggles`) and
  follow-up `fix/known-models-view-union` (worktree `../local-router-known-models`), both off `main`
- Plan: `.agents/plans/2026-11-12-dual-toggles-and-model-identity.plan.md`
- Status: done

## Operator ask (2026-11-12)

1. Two toggles per model row on `/config/providers`: serve (the `/v1/models` membership
   checkbox) and show-in-config (new archive toggle that removes the model from the provider
   lists entirely), plus an "Archived models" restore section. (A reported "pioneer" remnant
   was the operator's misread of `fastino` — nothing was purged.)
2. "Missing models from wafer and likely others" — e.g. `DeepSeek-V4.1-Flash-1017`,
   `DeepSeek-V4-Pro`, served live by `pass.wafer.ai` but absent from the router.

## Worktree journal

- `feat/dual-toggles-model-identity` — commit `dcd33b6` (amended after a shell-backtick
  mangling of the first body), 6 files +263/−4, new `tests/model-identity-and-archive.test.mjs`;
  merged to `main` as `merge: feat/dual-toggles-model-identity …`.
- `fix/known-models-view-union` — commit `d4e172a`, 3 files +44/−6; merged to `main` as
  `merge: fix/known-models-view-union …` (the first merge attempt ran inside the worktree and
  was a no-op; redone from the main checkout).
- Both `git log main..<branch>` empty; worktrees removed (`--force` after proving their only
  deltas were old skill copies main's rules roll-forward deleted) and branches deleted.

## What changed

- **Dual toggles (T2/T3)**: every catalog row carries the serve checkbox plus a `show` checkbox;
  unchecking archives the model out of all provider lists into an "Archived models" section
  where both toggles stay live (restore + serve). Archiving is presentation state, never
  deletion — the model stays discovered, chainable and servable.
- **Federation (T2)**: `archivedKeys` (`provider::model`) live in `router-settings.json`
  `catalogSelection` beside the serve selection (same `persistModelSourceConfig`
  read-merge-write choke point); `GET/PUT /api/model-curation` carry them; the boot overlay
  federates them machine-to-machine; they survive refreshes (a re-discovered archived model
  stays archived).
- **Identity fix (T1a)**: `mapLiveRawModelsToCatalog` spread the matched baseline's `model`/
  `display` into live rows — case/alias twins (`DeepSeek-V4-Pro` vs `deepseek-v4-pro`,
  `-1017` build variants) collided on the curation key and the fetch dedupe deleted the live
  row. Baselines now lend METADATA only; identity is always the live upstream id
  (`pickBaselineModel` doc records the rule).
- **View-union fix (T1b, found during live verification)**: `knownProviderModels` returned
  ONLY the override store when one existed, shadowing cache-only discoveries from the
  "every known model" management view and the provider-card counts. It now unions cache +
  registry + overrides (overrides win per key). The provider-keys `modelCount` contract test
  moved from the shadowing semantics to view-agreement + operator-row presence.

## Verification

- Full suite twice: 367 pass, 12 skipped (sandbox-gated), 0 fail (after the contract-test
  update; the initial run caught the `modelCount` pin — updated, not deleted).
- New tests: twins survive refresh with their own identity (with an override store seeded to
  exercise the shadowing path); archive keys federate and restore losslessly; malformed
  archive entries rejected; card count agrees with the management view.
- UI round-trip on :11436 (screenshots): dual toggles per row render; archiving a model via
  the `show` checkbox moves it to "Archived models"; restore brings it back; the archived row
  keeps its independent serve toggle. Two single-click probes each changed exactly one key.
- Live (main @ the union merge, PID 71235): wafer refresh merges 21 rows;
  `DeepSeek-V4-Pro` and `DeepSeek-V4.1-Flash-1017` present in BOTH the management view and
  the catalog feed.

## Notes

- One harness observation during UI verification: a click session against a re-rendering DOM
  archived an unrelated row (coordinate misrouting after a mid-interaction rebuild). Single
  click probes reproduced clean twice (one click = one toggle); attributed to the test
  harness, not the handlers — recorded for future UI automation caution.
- Deploy gotcha (second occurrence): `lsof -ti :11434 | head -1` killed the wrong PID of a
  multi-PID port once; `for p in $(lsof -ti :11434); do kill $p; done` is the reliable form.
