# TASK.2026-06-13.nous-portal-fallback-curate

## CoD
- worktree off develop created
- read llms.txt root PRD
- read nous-portal provider task file
- inspect routing-defaults current order
- inspect model-specs vision flags
- inspect providers.txt nous-portal rows
- identify which models stay
- identify which models removed
- place step-3.7-flash-free above antigravity
- place nous-portal-minimax-m3 below cline-pro-paid
- build updated fallback chain
- filter multimodal from updated chain
- update DEFAULT_FALLBACK_ORDERED_IDS
- update AUTO_ROUTER_EXTRA_CANDIDATE_IDS
- update CANDIDATE_DEFAULTS entries
- update PRESET_FALLBACK_ROUTES multimodal
- update provider-pricing.ts
- update providers.txt catalog rows
- update llms.txt counts
- update test expectations
- run validators
- run tsc build
- run tests
- atomic commits per logical step
####

**Goal:** Curate Nous Portal to a tight 2-model set (Step 3.7 Flash free + MiniMax M3) — drop Hermes 4 70B/405B, deepseek-v4-pro, kimi-k2.7-code, mimo-v2.5-pro, nemotron-3-ultra:free from the catalog and auto-router/fallback chains. Reorder the fallback chain so Step 3.7 Flash free sits above the subscription band (above Antigravity) and MiniMax M3 lands in the paid tail below Cline DeepSeek V4 Pro paid. Rebuild the multimodal preset route to be exactly the multimodal subset of the curated fallback.

**Changes (operator instruction 2026-06-13):**
- `providers.txt` Nous Portal section: remove rows #131 (hermes-4-70b) and #132 (hermes-4-405b); keep rows #133-138 but renumber #133→#131, #134→#132, #135→#133, #136→#134, #137→#135, #138→#136; update `Models: 8` → `Models: 6` header and notes.
- `src/routing-defaults.ts`:
  - `DEFAULT_FALLBACK_ORDERED_IDS`: remove `nous-portal-hermes-4-70b`, `nous-portal-hermes-4-405b`, `nous-portal-deepseek-v4-pro`, `nous-portal-kimi-k2.7-code`, `nous-portal-mimo-v2.5-pro`, `nous-portal-nemotron-3-ultra-free`. Reorder so `nous-portal-step-3.7-flash-free` sits just before `antigravity-gemini-3.5-flash` (above the subscription band). Move `nous-portal-minimax-m3` to the paid tail, immediately after `cline-deepseek-deepseek-v4-pro-paid`. New chain length: 23 (was 29).
  - `AUTO_ROUTER_EXTRA_CANDIDATE_IDS`: drop the 6 removed nous-portal entries; keep `nous-portal-step-3.7-flash-free` and `nous-portal-minimax-m3` (placed in their natural exhaustion bands).
  - `CANDIDATE_DEFAULTS`: drop 6 removed nous-portal entries; keep 2 (`nous-portal-step-3.7-flash-free`, `nous-portal-minimax-m3`).
  - `PRESET_FALLBACK_ROUTES.multimodal`: replace the 16 hard-coded entries with the multimodal subset of the new fallback chain (11 models — see Multimodal list below).
- `src/provider-pricing.ts`: drop the 6 removed nous-portal entries; keep the 2.
- `src/model-specs.json`: keep `hermes-4-405b` entry (used by validator stripping logic), no other changes needed.
- `llms.txt`: update Nous Portal catalog model count `8 → 6`; update fallback chain description from `29` to `23`; update `local-router/multimodal` description to list the new curated multimodal fallback; add 2026-06-13 changelog entry.
- `tests/provider-keys.integration.test.mjs`: update expected nous-portal anchor count `8 → 2`.
- `tests/routing-exhaustion-order.test.mjs`: keep `nous-portal` in `SUBSCRIPTION_PROVIDER_SUB_ORDER` (provider remains in catalog).

**Updated `DEFAULT_FALLBACK_ORDERED_IDS` (23 entries):**
```text
1.  ollama-nemotron-3-ultra-cloud                [free, ollama]
2.  nvidia-nim-minimax-m3                         [free, nvidia-nim]
3.  cline-minimax-minimax-m3-free                 [free, cline]
4.  kilo-stepfun-step-3.7-flash-free              [free, kilo]
5.  opencode-zen-minimax-m3-free                  [free, opencode-zen]
6.  modal-glm-5.1-fp8                             [paid, modal]
7.  nous-portal-step-3.7-flash-free               [free, nous-portal]   ← moved up
8.  antigravity-gemini-3.5-flash                  [sub, antigravity]
9.  github-copilot-gemini-3.1-pro                 [sub, github-copilot]
10. zai-code-pass-glm-5.1                         [sub, zai]
11. xiaomi-mimo-mimo-v2.5-pro                     [sub, xiaomi-mimo]
12. pioneer-minimax-m3                            [paid, pioneer]
13. opencode-go-deepseek-v4-pro                   [sub, opencode-go]
14. nebius-nemotron-3-ultra-550b-a55b             [paid, nebius]
15. commandcode-deepseek-v4-pro                   [sub, commandcode]
16. wafer-ai-deepseek-v4-flash                    [paid, wafer-serverless]
17. kilo-minimax-minimax-m3-paid                  [paid, kilo]
18. cline-deepseek-deepseek-v4-pro-paid           [paid, cline]
19. nous-portal-minimax-m3                        [paid, nous-portal]   ← moved here
20. zenmux-mimo-v2.5-pro                          [paid, zenmux]
21. openrouter-chain-of-draft                     [paid, openrouter-presets]
22. openrouter-kimi-k2.7-code                     [paid, openrouter-presets]
23. openrouter-free                               [free, openrouter-presets]
```

**Multimodal subset of updated fallback (11 models — drives `local-router/multimodal`):**
1. `nvidia-nim-minimax-m3` (Img=YES, nvidia-nim row #69)
2. `cline-minimax-minimax-m3-free` (Img=YES, cline row #92)
3. `kilo-stepfun-step-3.7-flash-free` (Img=YES, kilo row #104)
4. `opencode-zen-minimax-m3-free` (Img=YES, opencode-zen row #76)
5. `nous-portal-step-3.7-flash-free` (Img=YES, nous-portal row #133)
6. `antigravity-gemini-3.5-flash` (Img=YES, antigravity row #52)
7. `github-copilot-gemini-3.1-pro` (Img=YES per Gemini family)
8. `pioneer-minimax-m3` (Img=YES, pioneer row #126)
9. `kilo-minimax-minimax-m3-paid` (Img=YES, kilo row #120)
10. `openrouter-chain-of-draft` (Img=YES, openrouter-presets row #23)
11. `openrouter-kimi-k2.7-code` (Img=YES, openrouter-presets row #156)

**Excluded from multimodal (text-only per providers.txt Img column):**
- `ollama-nemotron-3-ultra-cloud` (Img=NO)
- `modal-glm-5.1-fp8` (Img=NO, glm-5.1)
- `zai-code-pass-glm-5.1` (Img=NO)
- `xiaomi-mimo-mimo-v2.5-pro` (Img=NO, mimo-v2.5-pro)
- `opencode-go-deepseek-v4-pro` (Img=NO)
- `nebius-nemotron-3-ultra-550b-a55b` (Img=NO)
- `commandcode-deepseek-v4-pro` (Img=NO)
- `wafer-ai-deepseek-v4-flash` (Img=NO)
- `cline-deepseek-deepseek-v4-pro-paid` (Img=NO)
- `nous-portal-minimax-m3` (Img=NO for this provider, see providers.txt #134 — keep in chain as paid text-only anchor)
- `zenmux-mimo-v2.5-pro` (Img=NO)
- `openrouter-free` (Img=NO)

**Validation gates (must pass before commit):**
- `npx tsx scripts/validate-model-specs.mts` — 0 errors
- `node --test --test-timeout=30000 tests/routing-exhaustion-order.test.mjs tests/gateway-provider-catalog.test.mjs tests/ollama-cloud-catalog.test.mjs` — pass
- `node --test --test-timeout=20000 tests/fallback-disabled-models.test.mjs tests/fallback-disabled-execution-plan.test.mjs tests/fallback-content-classifier.test.mjs tests/ollama-cloud.test.mjs` — pass
- `node --test --test-timeout=15000 tests/gateway-response.test.mjs` — pass
- `tsc` build clean
- `node --test --test-timeout=30000 tests/provider-keys.integration.test.mjs` — pass (updated anchors)

**Commit plan (atomic, in order):**
1. `chore(providers): drop Nous Portal Hermes 4 70B/405B` — providers.txt Nous Portal section, model count 8→6
2. `chore(routing): curate Nous Portal to 2 models in fallback` — routing-defaults.ts DEFAULT_FALLBACK_ORDERED_IDS, AUTO_ROUTER_EXTRA_CANDIDATE_IDS, CANDIDATE_DEFAULTS, PRESET_FALLBACK_ROUTES.multimodal
3. `chore(pricing): drop 6 removed nous-portal pricing entries` — provider-pricing.ts
4. `docs(llms): update Nous Portal curation to 2 models + multimodal route`
5. `test(routing): update provider-keys anchor expectations to 2 nous-portal entries`

**Files touched:**
- `providers.txt` (Nous Portal section, count + 2 row removals + 5 row renumbers)
- `src/routing-defaults.ts` (DEFAULT_FALLBACK_ORDERED_IDS, AUTO_ROUTER_EXTRA_CANDIDATE_IDS, CANDIDATE_DEFAULTS, PRESET_FALLBACK_ROUTES.multimodal)
- `src/provider-pricing.ts` (drop 6 entries)
- `llms.txt` (Nous Portal count 8→6, fallback 29→23, multimodal description)
- `tests/provider-keys.integration.test.mjs` (anchor update 8→2)
- `.agents/tasks/TASK.2026-06-13.nous-portal-fallback-curate.md` (this file)
