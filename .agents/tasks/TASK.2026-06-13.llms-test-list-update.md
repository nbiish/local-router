# TASK.2026-06-13.llms-test-list-update

## CoD
- read llms.txt test list
- find 3 missing tests
- fallback-content-classifier
- prompt-caching
- router-disabled-candidates
- count cases per file
- 16 files / 82 cases
- update count 56→82
- update files 13→16
- add 3 missing entries
- write descriptions
- doc-only diff
- +4/-1
- atomic commit
- merge to develop
- verify
- user confirms
- merge to main
- cleanup
####

**Goal:** Close out the test-list stale data noted in [`.agents/tasks/TASK.2026-06-13.llms-snapshot-multimodal-fix.md`](.agents/tasks/TASK.2026-06-13.llms-snapshot-multimodal-fix.md) as out-of-scope follow-up. The root `llms.txt` "Testing Setup & Suite Execution" block claimed 56 cases / 13 files and listed 13 of the 16 on-disk test files. Three test files were added since the snapshot was last refreshed (fallback-content-classifier 2026-06-09, prompt-caching 2026-06-10-ish, router-disabled-candidates 2026-06-09-ish) but never reflected in the PRD.

**Files touched (1 doc + 1 task record):**
- `llms.txt` — test count + 3 new test list entries
- `.agents/tasks/TASK.2026-06-13.llms-test-list-update.md` — CoD task record

**Changes (+4/-1, 1 file):**

1. `### Testing Setup & Suite Execution` (line 634) — count updated from `(56 cases, 13 files)` → `(82 cases, 16 files)`. Per-file case counts (verified by `grep -cE "^\s*(test|it)\s*\(" tests/*.test.mjs`):

| File | Cases |
|---|---|
| `ollama-cloud.test.mjs` | 2 |
| `ollama-cloud-catalog.test.mjs` | 1 |
| `gateway-provider-catalog.test.mjs` | 6 |
| `cline-kilo-catalog-validation.test.mjs` | 1 |
| `routing-exhaustion-order.test.mjs` | 5 |
| `execution-plan.test.mjs` | 2 |
| `fallback-disabled-models.test.mjs` | 15 |
| `fallback-disabled-execution-plan.test.mjs` | 5 |
| `fallback-content-classifier.test.mjs` | **13 (new)** |
| `gateway-response.test.mjs` | 2 |
| `prompt-caching.test.mjs` | **12 (new)** |
| `router-disabled-candidates.test.mjs` | **1 (new)** |
| `custom-providers.integration.test.mjs` | 2 |
| `provider-keys.integration.test.mjs` | 7 |
| `responses-http-stream.integration.test.mjs` | 5 |
| `responses-websocket-anthropic.integration.test.mjs` | 3 |
| **Total** | **82 cases / 16 files** |

2. `#### Current Test Matrix Coverage` (lines 651-653) — added the 3 missing test entries with brief 1-line descriptions matching the existing bullet style.

**Out of scope (intentionally not changed):**
- The aspirational `tests/oauth-providers.test.mjs` mention at `llms.txt:866` is inside the "Provider Integration Research" section — a research/plan doc, not a current state claim. The OAuth implementation landed via different test coverage; the research doc remains as a historical plan artifact.
- Test count provenance: 82 was measured via static `grep -c` on `test(`/`it(` calls. A real `node --test` run might report a slightly different number if any test is conditional on env or skipped — the static count is the most stable number for the PRD.

**Verification gates (no code changes; doc-only worktree):**
- `git diff --stat llms.txt` — 5 lines changed (4+/1-), single file
- `git diff llms.txt` — diff is bounded to 2 hunks in the testing-setup region; no other regions touched
- No `tsc` / `validate-model-specs` / test run needed (this is a doc-only change; doc changes are not exercised by the build or test suite)

**Commit plan (atomic, single file):**
1. `docs(llms): update test matrix to 16 files / 82 cases (add fallback-content-classifier, prompt-caching, router-disabled-candidates)` — llms.txt only.

**Merge path:** `chore/llms-test-list-update` → `develop` → `main` (user-confirmed at each hop).
