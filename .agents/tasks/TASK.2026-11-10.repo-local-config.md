---
task: repo-local-config
branch: feat/config-repo-local (merged to main, 11ff822 + 80891b9 + be9b60b)
worktree: D:\Code\lr-config-repo
started: 2026-11-10T17:17:00Z
status: done
parent: none
scope: src/config-paths.ts (new), src/config-persistence.ts, src/index.ts, src/routes/config-api.ts, src/ui/pages/fallback.ts, tests/config-location.test.mjs, llms.txt, README.md, ROUTER.md, docs/driver-models.md, .gitignore, package.json
---

# Repo-local config: the fallback chain travels with the checkout

## Objective

Make the router's chain config live inside the repository checkout so a synced repo
carries it, then put both machines (this box's WSL-hosted router and `mac-18gb`) on
the latest build with the operator's 17-model `fallback-models` chain.

## What was measured before the change

| Finding | Evidence |
|---|---|
| Config did not travel with code | The checkout at `/mnt/d/Code/local-router` served a 17-step chain from `/home/nanoboozhoo/.config/local-router`; the rsynced Mac checkout read a **1-step** chain from `/Users/nbiish/.config/local-router`. Same repo, different routing, nothing on disk comparing them. |
| The chain file is not even the one users edit | `router-settings.json` was per-machine; the repository-root copy was a stale 23-step Sep 4 seed, unused by any code path. |
| A boot on a deficient catalog deleted steps | The Mac's catalog knew 14 of 17 ids. One boot applied 17 ("applied (17 system chain step(s))"), then `normalizeRoutingTierOrder` dropped the three ids `findCatalogModel` could not resolve and persisted 14 — silently, behind a log line that reads as routine. Reproduced in a throwaway checkout: `zai-totally-bogus-xyz` + `zai-glm-5.3-flash` came back as one step. |
| A bulk settings write dropped routes | `PUT/DELETE /api/router-settings` called `persistFallbackModels()` (writes every route + chain text) and then `saveRouterSettings(settings)` with a payload carrying no `routes`, overwriting the file with `{ fallbackModelsText }` alone — so `fallback-embedding`/`fallback-decision` vanished from disk on every bulk write. |

## What was built

1. **`src/config-paths.ts`** — one resolver, two roots. MACHINE root
   (`~/.config/local-router`) keeps credentials, discovery caches, logs, health and
   backups. CHECKOUT root (`<checkout>/router-settings.json`) holds operator config
   that must be shared. Order: `LOCAL_ROUTER_CONFIG_DIR` pin → checkout root
   (`package.json` named `local-router` next to `.git`) → machine root.
2. **An overridden `HOME` disables checkout detection.** A test harness, container
   or sandbox that repoints `HOME` is stating "this process is isolated"; resolving
   that to the checkout would let a test run rewrite a real chain — the 2026-11-09
   verification incident in a new shape.
3. **Seed on first boot.** A build that knows about the checkout copy copies the old
   machine file over when the checkout has none, so moving the file cannot drop an
   existing chain. Copy, never move; the machine file stays.
4. **Watcher resolves the path on every tick** (`fs.watchFile`, stat polling, which
   also works across the WSL/Windows mount), so a chain synced in from another
   machine applies live, even when the file did not exist at boot.
5. **Unknown steps are kept.** Request-time preflight already skips a step it cannot
   resolve, with a reason; deleting it from a *shared* file is a different act. Only
   the catalog-known filter in the dedupe was removed; duplicates still collapse.
6. **Bulk settings writes persist the whole file.** The redundant
   `saveRouterSettings()` after `persistFallbackModels()` is gone, so a chain write
   no longer erases the purpose-scoped routes from the authoritative file.
7. **Docs and UI state the real path.** `/config/fallback` renders the resolved
   location per machine instead of a hardcoded home path; README/ROUTER/driver-models
   and the llms.txt PRD describe the split.

## Verification

| Layer | Result |
|---|---|
| `tests/config-location.test.mjs` (7) | env pin; checkout detection; `.git`-less directory rejected; isolated HOME; real-HOME resolution; end-to-end boot/seed/watch/write against a throwaway checkout; unknown step survives a boot. |
| Focused regression (fallback, embedding, routes, UI scripts, router-settings, topology) | 96/96 and 40/40 runs green. |
| Full suite | 366 tests, 352 pass, 12 skipped; the same 2 failures reproduce on unmodified main (`antigravity-auth-platform-detect` host Cursor session, `custom-providers` vendor id), so they are pre-existing and unrelated. |
| Live, this box | `/api/fallback-models` = 17 steps, all `ready`, 0 unkeyed; boot log `chain config: /mnt/d/Code/local-router/router-settings.json (checkout — travels with the repository)`; a real `local-router/fallback-models` completion answered `ROUTER-OK` via `glm-5.3-flash`. |
| Live, mac-18gb | Same 17 steps (its catalog now knows all 17 after provider refreshes); boot log names `/Volumes/1tb-sandisk/code-external/local-router/router-settings.json`; a real completion answered `ROUTER-OK`. |
| Fleet version | Both machines report `currentVersion 1.1.0` / `currentCommit be9b60b` / `hasUpdate false`. The Mac's eight local commits (macOS launchd fixes, CLI version, docs, desktop-app contract) were squashed onto main without the accidental 175 MB `NVPAIR-Setup-0.1.1-arm64.dmg`; installer artifacts are now gitignored. |

## Deployment

- Windows/WSL router (systemd user `local-router-ensure` + timer, running
  `/mnt/d/Code/local-router/build/index.js`) rebuilt and restarted; it reads the
  checkout file.
- mac-18gb (launchd `com.localrouter.daemon` → `bin/local-router.js ensure`) merged
  to `be9b60b`, rebuilt, chain file placed in the checkout, restarted; provider
  catalogs refreshed so its cost bands and context facts match this box's.

## Known remaining gaps (reported, not hidden)

- **Chain order differs on two adjacent steps between machines.** The cost-first
  sorter breaks ties with local capability facts (`cursor-grok-4.7` vs
  `cursor-deepseek-v41-flash-1017`), so each boot rewrites the shared file in that
  machine's order. The 17-model SET is identical and cost bands are respected; the
  exact sequence is not machine-independent. Making the order deterministic (or
  pinning the operator's sequence) is a policy decision, not a bug fix.
- **The operator's list order is not preserved verbatim.** `normalizeRoutingTierOrder`
  has re-sorted cost-first at every boot since 2026-11-09 (by operator decision), so
  the delivered order is the cost-first order of those 17 ids, not the order typed
  into the request.
- Providers with keys but no chain step remain (wafer-serverless on both; plus
  nebius/moonshot/modal-proxy/ollama/nous-portal on the Mac's larger key set) —
  `scripts/verify-fallback-chain.mjs` reports them as absent coverage and exits 1.
  That is the operator's 17-id selection, not a defect.

## Incident during the deploy: provider keys vanished from the PQC bundle

At 17:34 local the WSL store `~/.config/pqc-secrets/secrets.bundle.json` lost 12 of
its 25 names (13 `LOCALROUTER_*` → 1 provider-mapped). The router kept the vanished
keys in memory (documented drift behaviour), so the loss only became visible when
the freshly built process booted and reported **0 provider keys** and a fallback
chain that could only reach OAuth/loopback providers.

- Evidence: rotating backups show 24 → 25 names at 22:33:58Z, then 14, 13, 14, 13,
  15, 15, 14, 13 across 22:34:25–22:35:40Z, and 13 at 22:36:12Z. No `audit.log`
  exists in that store, so attribution is inference, not proof; the writes cluster
  with rules-deployment activity on this box (AGENTS.md/.gitignore/.agents/skills
  rewritten at 17:37–17:38 and 18:42).
- Recovery: backed up the 14-name file to `secrets.bundle.json.pre-restore-*`,
  restored `secrets.bundle.json.bak.20261110T223358Z` (25 names), and forced
  `POST /api/pqc/resync` → 12 providers re-keyed; a live chain completion succeeded
  immediately after.
- Not fixed, deliberately: the writer is unidentified. The store has no audit log,
  and a blind re-pack would mask the next occurrence. The operator should check
  which other session/agent was touching the shared store in those windows; the
  2026-09-19 entry in `MEMORY.md` records the same class of loss from a "Windows-side
  rewrite".
