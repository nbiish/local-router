# TASK.2026-06-13.multimodal-expansion

## CoD
- read live API for zai/commandcode/xiaomi/wafer
- zai only has glm-5.1 img=False
- commandcode only has deepseek-v4-pro img=False
- xiaomi-mimo-mimo-v2.5 img=True
- wafer-ai-minimax-m3 img=True
- user wants 2 new + 2 existing in multimodal
- create worktree feat/multimodal-expansion
- add glm-4.6v to providers.txt zai
- add minimax-m3 to providers.txt commandcode
- add glm-4.6v spec to model-specs.json
- add pricing entries for both new models
- update multimodal route 11 to 15
- update test anchors
- update llms.txt multimodal description
- update persisted fallback-models.json
- run validators + tests
- run tsc build
- smoke test
- atomic commits
- merge to develop
- re-verify
- user confirms
- merge to main
####

**Goal:** Expand `local-router/multimodal` to cover additional providers' vision-capable models. Add 2 new catalog entries (`zai-code-pass-glm-4.6v` and `commandcode-minimax-m3`) and 2 existing entries (`xiaomi-mimo-mimo-v2.5`, `wafer-ai-minimax-m3`) to the multimodal preset route. Position the new entries in the runtime-sorted route between `github-copilot-gemini-3.1-pro` (subscription) and `pioneer-minimax-m3` (paid) for the 3 subscription-band models, and `wafer-ai-minimax-m3` in the paid band just before `openrouter-chain-of-draft`.

**Operator instruction 2026-06-13:** "the local-router/multimodal should also have the zai (glm-4.6v), xiaomi (mimo-v2.5), and commandcode (minimax-m3) all in front of the 8th model and wafer ai minimax-m3 in front of openrouter-chain-of-draft."

**Files touched:**
- `providers.txt` — add 2 new rows:
  - `# │ 64a │ zai            │ code-pass-glm-4.6v       │ zai:code-pass-glm-4.6v │ 200,000 │ 128,000 │ YES │ YES │ YES │ NO*  sub │` (img=YES, vision variant of glm-5.1; subscription via Z.ai coding plan)
  - `# │ 72a │ commandcode   │ minimax/minimax-m3       │ cmdc:minimax-m3        │1,000,000 │ 512,000 │ YES │ YES │ YES │ NO*  sub │` (subscription on the 4x-deal CommandCode plan)
- `src/model-specs.json` — add `glm-4.6v` spec entry (vision: true, reasoning: true, context 200K, output 128K; family: glm)
- `src/provider-pricing.ts` — add `zai-code-pass-glm-4.6v` (input/output: 0/0, subscription-billed via Z.ai coding plan, validUntil 2026-12-31) and `commandcode-minimax-m3` (input/output: 0/0, subscription-billed via CommandCode deal, validUntil 2026-12-31)
- `src/routing-defaults.ts` — `PRESET_FALLBACK_ROUTES.multimodal` (11 → 15 entries):
  1. nvidia-nim-minimax-m3
  2. cline-minimax-minimax-m3-free
  3. kilo-stepfun-step-3.7-flash-free
  4. opencode-zen-minimax-m3-free
  5. nous-portal-step-3.7-flash-free
  6. antigravity-gemini-3.5-flash
  7. github-copilot-gemini-3.1-pro
  8. **zai-code-pass-glm-4.6v** (new — subscription, in front of 8th = pioneer)
  9. **xiaomi-mimo-mimo-v2.5** (new — subscription, in front of 8th = pioneer)
  10. **commandcode-minimax-m3** (new — subscription, in front of 8th = pioneer)
  11. pioneer-minimax-m3
  12. **wafer-ai-minimax-m3** (new — paid, in front of openrouter-chain-of-draft)
  13. kilo-minimax-minimax-m3-paid
  14. openrouter-chain-of-draft
  15. openrouter-kimi-k2.7-code
- `tests/provider-keys.integration.test.mjs` — add 4 new entries to `expectedMultimodalAnchors`
- `llms.txt` — update multimodal description to list 15 entries and add 2026-06-13 changelog entry
- `~/.config/local-router/fallback-models.json` — update persisted `multimodal` route to 15 entries (operator live state, mirrors defaults)
- `.agents/tasks/TASK.2026-06-13.multimodal-expansion.md` (this file)

**Validation gates (must pass before commit):**
- `node --import tsx scripts/validate-model-specs.mts` — 0 errors
- `npx tsc --noEmit` — clean
- 12 in-scope test files (routing-exhaustion-order, gateway-provider-catalog, ollama-cloud-catalog, fallback-disabled-*, fallback-content-classifier, ollama-cloud, gateway-response, cline-kilo-catalog-validation, execution-plan, router-disabled-candidates, prompt-caching) — 0 fail
- `node --test --test-timeout=30000 tests/provider-keys.integration.test.mjs` — multimodal anchor deepEqual passes; pre-existing nvidia-nim- ordering failure is unrelated
- Smoke test on `127.0.0.1:11436` — multimodal route returns 15 entries, no errors in log

**Commit plan (atomic, in order):**
1. `feat(providers): add zai-code-pass-glm-4.6v and commandcode-minimax-m3 catalog rows`
2. `feat(specs): add glm-4.6v to model-specs.json` (depends on commit 1)
3. `feat(pricing): add zai-glm-4.6v + commandcode-minimax-m3 pricing entries` (depends on 1, 2)
4. `feat(routing): expand local-router/multimodal to 15 entries (zai/xiaomi/commandcode/wafer)`
5. `test(routing): update provider-keys multimodal anchor list to 15`
6. `docs(llms): update multimodal route to 15 entries + changelog`
7. `chore(tasks): record 2026-06-13 multimodal expansion task`

**Persisted state sync:**
- After merge to develop, update `~/.config/local-router/fallback-models.json` `multimodal` route (and verify the live server reflects it on restart).
