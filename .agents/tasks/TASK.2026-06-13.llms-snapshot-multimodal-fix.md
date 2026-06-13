# TASK.2026-06-13.llms-snapshot-multimodal-fix

## CoD
- read llms.txt fully
- find system snapshot stale
- main still 8ca614c
- current is e733527
- multimodal-expansion release missing
- catalog fix release missing
- catalog count 110+
- should be 112
- zai count 1
- should be 2
- commandcode count 1
- should be 2
- GLM-4.6v not in metadata
- session log entry missing for fix
- update system snapshot
- add lineage rows
- fix catalog count
- add GLM-4.6v spec
- add session log
- sanity tsc tests validate
- 65/65 pass
- atomic commit
- merge docs to develop
- verify develop
- user confirms
- merge to main
- cleanup
####

**Goal:** Update root `llms.txt` on the main branch to reflect the 2026-06-13 multimodal expansion (`feat/multimodal-expansion` → `d024ec0`) and the 2026-06-13 catalog fix (`fix/multimodal-zai-commandcode-unavailable` → `e733527`). The previous `feat/multimodal-expansion` commit (`9e40525 docs(llms)`) only updated the multimodal bullet list, preset routes table, and added a session log entry; it missed the system snapshot header, the release lineage table, the provider catalog model counts, and the Key Model Metadata block. The catalog fix had no `llms.txt` entry at all.

**Files touched (this worktree only):**
- `llms.txt` — system snapshot header, release lineage table rows, provider catalog model counts, Key Model Metadata GLM-4.6v spec, session log entry.

**Changes (18 insertions, 5 deletions, 1 file):**

1. `### System Snapshot & Release Lineage (June 2026)` — header bumped from `main @ 8ca614c, develop @ 8ca614c` to `main @ e733527, develop @ e733527` with summary of the Nous Portal 2-model curation, multimodal expansion to 15 entries, and the catalog parser fix.
2. Release lineage table — added rows (in reverse chronological order) for:
   - `e733527` Release 2026-06-13b
   - `90f04bc` Merge fix/multimodal-zai-commandcode-unavailable into develop
   - `5aca19f` fix(catalog): renumber zai 64a→80 and commandcode 72a→137
   - `d024ec0` Release 2026-06-13 (Nous Portal curation + multimodal expansion)
   - `e693f19` Merge feat/multimodal-expansion into develop
   - `9e40525` docs(llms): update multimodal route to 15 entries + changelog
   - `5253f72` feat(routing): expand local-router/multimodal to 15 entries
   - `f4811d6` feat(pricing): add zai-glm-4.6v and commandcode-minimax-m3 pricing entries
   - `9d852e1` feat(specs): add glm-4.6v to model-specs.json
   - `105cde9` feat(providers): add zai-code-pass-glm-4.6v and commandcode-minimax-m3 catalog rows
3. `### Provider Catalog Contracts` — catalog model count `110+` → `112` with note tying the increment to the multimodal expansion. Provider row counts: `zai 1` → `2`, `commandcode 1` → `2`.
4. `#### Key Model Metadata Specifications` — added `**GLM-4.6v:**` line (200K context, 128K output, Z.AI coding pass, vision variant of GLM-4.6 with preserved thinking — multimodal anchor `zai-code-pass-glm-4.6v`). Updated `**Z.ai:**` line to include the new presented model.
5. Session Progress Log (June 2026 logs) — added `**2026-06-13 (multimodal catalog fix):**` entry with full root cause, fix, verification, and merge lineage.

**Verification gates (no code changes; this is a doc-only worktree):**
- `npx tsc --noEmit` — clean
- `npx tsc` build — clean
- 12 unit test files (65 tests) — 65/65 pass, 0 fail, 0 cancelled
- `node --import tsx scripts/validate-model-specs.mts` — 0 errors, 117 rows parsed, 104 matched
- `git diff --stat llms.txt` — 23 lines changed (18 insertions, 5 deletions), single file

**Out of scope (intentionally not changed in this fix; could be a follow-up `chore/llms-test-list-update` task):**
- Test list at lines ~696-708 (mentions 13 tests; actually 16 on disk — 3 missing: `fallback-content-classifier`, `prompt-caching`, `router-disabled-candidates`)
- Test count "56 cases, 13 files" at line ~688
- `Provider Integration Research` section has aspirational `tests/oauth-providers.test.mjs` mention that's also stale

**Commit plan (atomic, single file):**
1. `docs(llms): sync system snapshot, release lineage, and session log to e733527` — llms.txt only.

**Merge path:** `docs/llms-snapshot-multimodal-fix` → `develop` → `main` (user-confirmed at each hop).
