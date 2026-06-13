# TASK.2026-06-13.multimodal-zai-commandcode-unavailable

## CoD
- read multimodal route
- find zai/commandcode Unavailable
- trace to candidateAvailability
- findProviderModel returns undefined
- inspect providers.txt 64a/72a rows
- regex /^\d+$/ rejects letter suffix
- silently skip rows
- catalog has no entries
- zai model name zai-org/GLM-4.6v
- segment yields zai-glm-4.6v
- not zai-code-pass-glm-4.6v
- presented ID mismatch
- renumber 64a to 80
- fix zai model to code-pass-glm-4.6v
- renumber 72a to 137
- build ts
- run validators
- unit tests pass 52/52
- smoke test 11436
- /api/routing/availability
- zai-code-pass-glm-4.6v ready
- commandcode-minimax-m3 ready
- all 15 anchors loaded
- atomic commit
- merge to develop
- verify develop
- user confirms
- merge to main
####

**Goal:** Make the two new `local-router/multimodal` entries — `zai-code-pass-glm-4.6v` and `commandcode-minimax-m3` — show as **Ready** instead of **Unavailable** in the models page. The two anchor IDs were already wired into `src/routing-defaults.ts` (multimodal route) on 2026-06-13, but the corresponding catalog rows in `providers.txt` could not be loaded by `readProviderModels()` because their row numbers used a letter suffix that the parser rejected.

**Root cause:**

1. `src/index.ts:3421` and the test files use `if (!/^\d+$/.test(rowNumber)) continue;` to skip rows. The two new rows used `64a` and `72a` (intended as a "variant of row 64/72" notation), so they were silently dropped and never entered the catalog.
2. The zai row also used the upstream namespace `zai-org/GLM-4.6v` as the model name. After `modelAliasSegment()` normalization, this would have produced the presented ID `zai-glm-4.6v` — not `zai-code-pass-glm-4.6v` that the multimodal route and pricing entry expect.

**Fix (minimal, in `providers.txt` only):**

- Row `64a│ zai │ zai-org/GLM-4.6v │ zai:code-pass-glm-4.6v │ …` → `80│ zai │ code-pass-glm-4.6v │ zai:code-pass-glm-4.6v │ …` (renumber to a free integer; switch the model to `code-pass-glm-4.6v` so `modelAliasSegment` yields `code-pass-glm-4.6v` and the presented ID is `zai-code-pass-glm-4.6v`).
- Row `72a│ commandcode │ minimax/minimax-m3 │ cmdc:minimax-m3 │ …` → `137│ commandcode │ minimax/minimax-m3 │ cmdc:minimax-m3 │ …` (renumber to a free integer; model name already produced the correct presented ID `commandcode-minimax-m3`).

**Files touched:**
- `providers.txt` — renumber `64a` → `80` and `72a` → `137`; switch zai model to `code-pass-glm-4.6v`.

**Validation gates (must pass before commit):**
- `node --import tsx scripts/validate-model-specs.mts` — 0 errors. Result: **0 errors, 1 warning (unrelated nous-portal/xiaomi), 13 unmatched (all gateway/oauth)**, 117 rows parsed (up from 115).
- `npx tsc --noEmit` — clean.
- 8 in-scope unit test files (`routing-exhaustion-order`, `gateway-provider-catalog`, `ollama-cloud-catalog`, `cline-kilo-catalog-validation`, `ollama-cloud`, `gateway-response`, `execution-plan`, `fallback-disabled-models`, `fallback-disabled-execution-plan`, `fallback-content-classifier`, `router-disabled-candidates`, `prompt-caching`) — **52/52 pass**.
- Smoke test on `127.0.0.1:11436` — `GET /api/routing/availability?models=zai-code-pass-glm-4.6v,commandcode-minimax-m3` returns both with `resolved: true, keyConfigured: true, status: "ready"`. Full 15-anchor availability dump: 13 ready (zai/commandcode/xiaomi/nvidia-nim/cline/kilo/ozen/nous-portal/wafer/pioneer/openrouter), 2 no_key (antigravity + github-copilot — OAuth subscription, user must sign in).

**Commit plan (atomic, single file):**
1. `fix(catalog): renumber zai 64a→80 and commandcode 72a→137 so catalog parser accepts them` — providers.txt only.

**Persisted state sync:**
- `~/.config/local-router/fallback-models.json` `multimodal` route is already 15 entries (bootstrapped on next restart from updated `PRESET_FALLBACK_ROUTES.multimodal`).
