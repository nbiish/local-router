# HANDOFF — Remove providers.txt + factual per-provider registry (Release 2026-08-20h)

> **Purpose:** Self-contained handoff for a fresh AI agent to resume this task exactly
> where the previous agent stopped. Read this whole file before acting.
> **Date:** 2026-08-21 · **Status:** committed + tsc-clean, **3 tests failing** (diagnosed),
> root cause of 2 of them still being narrowed. No merge done yet; production untouched.

---

## 1. The goal (user's request)

1. **Remove `providers.txt` completely** from the project now that the toggle model system exists.
2. **Pull in and document the factual query info for every provider's available models** — *everything
   from paid to free* — so the user always has the choice to toggle each model on/off.
3. Once the work is done: **merge to `main`, restart the production server**, then the user will
   **add API keys** to test the newly-discovered providers.

---

## 2. Exact current state (verified)

| Thing | Value |
|---|---|
| Worktree | `~/worktrees/lr-registry` |
| Branch | `feat/catalog-provider-registry` (off `develop`) |
| Last commit | `0426e8a` — `feat(catalog): remove providers.txt; factual per-provider registry` |
| Working tree | clean (everything committed) |
| `develop` | `7b4b2f2` (unchanged; still has old providers.txt) |
| `main` (production) | `d6cf1a3` = Release 20g r1 — **still running, NOT restarted** |
| `tsc` | clean |
| Fresh-HOME smoke | seed v2 works: `[catalog] Registry seed v2: 1387 new model(s) unioned, all pre-checked` |
| Full test suite | **114 tests → 111 pass / 3 fail** (see §5) |

---

## 3. What is already done (committed in `0426e8a`)

- **Deleted** `providers.txt`, `providers.legacy-catalog.txt`, and the crx community-proposal pipeline
  (`scripts/crx-validate.mts`, `scripts/crx-aggregate.mts`, `.github/workflows/crx-validate.yml`).
- **Provider summary table moved in-code** to `src/provider-registry.ts` (20 providers). `commandcode`
  endpoint corrected to `https://api.commandcode.ai/provider/v1` (live-verified; old `/alpha/generate` was wrong).
- **`src/provider-model-registries.ts` is now the authoritative factual catalog**: ~1,380 models across
  18 providers, compiled 2026-08-20/21 from live `/models` captures (kilo 368, nous 373, zenmux 164,
  pioneer 89, commandcode 58, nvidia 102, opencode zen/go, wafer) + official docs (moonshot, xiaomi,
  nebius, github-copilot, gemini, modal, zai). Every entry has `tier` (`free`|`paid`|`subscription`) +
  provenance `note`.
- **zai is now a live-API provider** (its `/models` was verified live); `PROVIDERS_WITHOUT_LIVE_MODEL_LIST`
  is now only `['cline']`.
- **Boot seed bumped to migration v2** (`seedRegistryCatalogIfNeeded` in `src/index.ts`): unions the
  registry into the toggle store, **pre-checks only never-seen models** (user untoggles survive).
  No-key / failed refreshes return the enriched registry∪cache view.
- Tier + sourceUrl plumbed through `ProviderModel` → UI; **toggle rows show tier badges**
  (`src/ui/pages/layout.ts`).
- Tests/scripts/probe rewired to read compiled registry modules (`import('../build/...')`) instead of txt.
- `.agents/skills/{model-add,model-remove,provider-models-list}/` stale providers.txt references updated.
- `llms.txt` — added the 20h release row.

---

## 4. Key files

| File | Role |
|---|---|
| `src/provider-registry.ts` | NEW — in-code 20-provider table |
| `src/provider-model-registries.ts` | NEW content — full factual catalog (~1,600 lines) |
| `src/index.ts` | seed v2, registry summaries, tier plumbing, enriched fallbacks |
| `src/ui/pages/layout.ts` | tier badges |
| `src/provider-pricing.ts`, `src/routes/config-api.ts`, `src/oauth-providers.ts`, `src/gateway-provider-catalog.ts`, `src/model-specs.json` | stale-reference sweeps |
| `scripts/validate-model-specs.mts`, `scripts/validate-cline-kilo-catalog.mjs` | read registry not txt |
| `tests/*` | 5 integration tests rewired to `build/` imports |
| `llms.txt` | 20h release row added |

---

## 5. The 3 failing tests (all diagnosed)

### Failure 1 — `tests/model-curation.integration.test.mjs:383` (stale assertion)
`assert.equal(zaiRefresh.body?.source, 'registry')` → actual `'catalog'`.
- **Cause:** zai is now a live-API provider; a no-key refresh returns `source: 'catalog'` (registry∪cache),
  not `'registry'`. The test also asserts uppercase `GLM-5.3` / `GLM-4.7`, but the registry now uses
  lowercase live ids `glm-5.3` / `glm-4.7`.
- **Fix:** update this block to treat **zai as live-API** (only `cline` is registry-only now) and use
  lowercase ids.

### Failure 2 — `tests/provider-keys.integration.test.mjs:313` (root cause still being narrowed)
`assert.ok(... some(route.routeId === 'auto-router-main'))` fails — **auto-router-main is never bootstrapped**
on a fresh HOME.
- `buildDefaultAutoLocalRouterModel()` (`src/index.ts:~2875`) calls `validateRouterReferences(parsed.model)`
  **STRICT**; any unresolved candidate → returns `null`.
- Candidates come from `AUTO_ROUTER_CANDIDATE_LINES` in `src/routing-defaults.ts`
  (`buildDefaultAutoRouterCandidateLines`, line ~270), resolved via `catalogRefForPresentedModel`
  (`src/index.ts:459`).
- Boot log shows unresolved candidates: `ollama-nemotron-3-ultra-cloud`, `openrouter-free`,
  `openrouter-chain-of-draft`, `openrouter-kimi-k2.7-code`, `github-copilot-gpt-4o/gpt-5/o3-mini`,
  `modal-glm-5.1-fp8`, `antigravity-gemini-3-flash`, etc.
- These resolved in 20g because they lived in the old catalog / fallback / ollama-cloud surfaces; my
  registry omitted them (I deliberately excluded retired copilot models gpt-4o/gpt-5/o3-mini, but
  `routing-defaults.ts` still references them).

### Failure 3 — `tests/provider-keys.integration.test.mjs:1729` (cascade of #2)
`assert.ok(targetRouter)` — router export can't find auto-router-main because it was never bootstrapped.

---

## 6. Immediate next step (what the previous agent was mid-investigation on)

Read these two functions to determine **which catalog surface the default-router candidates resolve against**:

- `catalogRefForPresentedModel` — `src/index.ts:459-471`
- `effectiveProviderModels` — used by `modelPresentationList` (`src/index.ts:3928`)

The likely fix is one of:
- **(a)** make the registry also carry the `AUTO_ROUTER_CANDIDATE_LINES` / ollama-cloud / fallback anchor
  set so all default candidates resolve; or
- **(b)** confirm the pre-change (`develop`) behavior resolved these via `effectiveProviderModels`'s
  ollama-cloud + fallback inclusion, and restore that source in the seed.

> The old 54-row proven catalog is recoverable via `git show develop:providers.legacy-catalog.txt`
> (NOT `HEAD` — deleted there). Already extracted to `/tmp/proven-full.tsv`
> (`provider \t model \t ctx \t out \t tools \t images`).

---

## 7. Reproducible artifacts (all in /tmp, still present)

- `/tmp/gen_registry.py` — **idempotent generator** that writes `src/provider-model-registries.ts` from
  live captures + hand tables + a `PROVEN` continuity union. Re-run: `python3 /tmp/gen_registry.py` then `tsc`.
- `/tmp/research/` — kilo-live.tsv (368), nous-models.json (373), pioneer-models.json (166),
  cc-models.json (58), modelsdev.json (full dump), zai/cline doc fetches.
- `/tmp/wafer-models.json`, `/tmp/zenmux-models.json` (164), `/tmp/nvidia-models.json` (102).
- `/tmp/proven-full.tsv` — the 54-row legacy proven set.

---

## 8. Build / test commands

```bash
cd ~/worktrees/lr-registry

# typecheck
./node_modules/.bin/tsc

# full suite (expect 114/114 when done)
export npm_config_cache=/tmp/npm-cache LOCAL_ROUTER_SKIP_OLLAMA_ENSURE=true
node --test --test-concurrency=1 tests/*.test.mjs tests/*.integration.test.mjs
```

> ⚠️ The full suite takes >600s. Earlier runs got SIGTERM'd at the executor's 600s cap. Run it with
> `run_in_background: true` and poll — do NOT wrap in a foreground timeout.

Smoke (fresh-HOME seed v2):

```bash
cd ~/worktrees/lr-registry
rm -rf /tmp/lr-smoke && mkdir -p /tmp/lr-smoke
HOME=/tmp/lr-smoke PORT=11441 LOCAL_ROUTER_SKIP_OLLAMA_ENSURE=true node build/index.js > /tmp/lr-smoke.log 2>&1 &
sleep 6
curl -s http://127.0.0.1:11441/api/model-curation | python3 -c "import json,sys; d=json.load(sys.stdin); print('selected', len(d.get('selectedKeys',[])))"
```

---

## 9. Remaining sequence after the 3 tests pass

1. Commit the test fixes (small follow-up commits in the same worktree/branch).
2. Re-run full suite → 114/114, `tsc` clean.
3. **Ask the user** before each merge hop (AGENTS.md: never self-approve merges).
4. Merge `feat/catalog-provider-registry` → `develop`; verify the integrated tree on `develop`.
5. Promote `develop` → `main` (finalized Release 20h).
6. **Restart production**: `local-router stop && local-router start`; verify seed v2 + `/v1/models`.
7. Cleanup: remove worktree, delete branch, confirm `git worktree list` shows only main.
8. User adds API keys to test newly-discovered providers.

---

## 10. Important cautions

- Do **not** re-add retired github-copilot models (gpt-4o/gpt-5/o3-mini) unless you also accept they
  reappear in the default router. The failure is a coupling between the registry and
  `routing-defaults.ts`'s `AUTO_ROUTER_CANDIDATE_LINES` — resolve that coupling deliberately.
- `providers.legacy-catalog.txt` is deleted from `HEAD` but still in `develop` — reference it via
  `git show develop:...`.
- Per AGENTS.md: **never work on `main`**; worktree per task; ask before merging; two-hop merge only
  (`feature → develop` verify → `main`).
- Approval prompts are DISABLED; danger-full-access is active — **never set `sandbox_permissions`**.
- The two remaining `providers.txt` mentions in `.agents/skills/model-add/SKILL.md:78` and
  `model-remove/SKILL.md:85` are intentional historical notes ("providers.txt is fully removed…").
