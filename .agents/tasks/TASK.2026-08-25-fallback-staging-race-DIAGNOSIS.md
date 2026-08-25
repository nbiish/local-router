# TASK 2026-08-25 ＋ Fallback staging race — DIAGNOSED, NOT FIXED

Confidential. No secrets. Logged from the psionics chat by mistake-routing;
fix belongs here. Work was reverted before any commit landed.

- Bug: ＋ Fallback shows nothing anywhere
- Root cause: safeInit fire-and-forget race
- Fix designed, never committed
- Revert verified clean

####

## Symptom (operator report, VSCode/extension config UI)

Press ＋ Fallback on a catalog model → model appears neither in the chain
dropdown nor in the Fallback Order drag/click list.

## Root cause (layout.ts)

Init block fires every initializer concurrently:

    safeInit('loadFallbackRoutes', loadFallbackRoutes);   // async fetch
    ...
    safeInit('stageModelFromQuery', stageModelFromQuery); // reads state NOW

stageModelFromQuery reads global fallbackRoutes[] while loadFallbackRoutes'
fetch is still in flight → sees [] → targetRoute undefined → takes the
"chain not found" branch → stages model into throwaway NEW-chain editor
(brief error toast) → late populateFallbackRouteSelect() then re-selects the
real chain and selectFallbackRouteToEdit → hydrateFallbackForm(route)
REPLACES fallbackCandidateStore wholesale → staged model wiped.

Net: nothing in dropdown, nothing in order list. Matches report exactly.

## Designed fix (two layers, ~15 lines, uncommitted when reverted)

1. stageModelFromQuery: first await loadFallbackRoutes() (idempotent GET)
   before reading fallbackRoutes[] — self-sufficient regardless of init order.
2. Init sequencing:
     safeInit('loadFallbackRoutes', loadFallbackRoutes).then(function() {
       return safeInit('stageModelFromQuery', stageModelFromQuery);
     });
   replacing the two standalone lines.

## Revert record

Worktree ../local-router-fallback-race + branch fix/ui-fallback-stage-race
removed; branch pointed at eba6ab9 (zero unique commits); develop untouched.
node_modules copy aborted mid-flight, no residue outside removed worktree.

## Next steps (for this repo's chat)

1. Apply fix above in a fresh fix/* worktree from develop.
2. Gates: npm run build + tests/fallback-chain-toggle.test.mjs +
   fallback-default-bootstrap.test.mjs + ollama-version-config-ui.test.mjs.
3. Manual verify: catalog → ＋ Fallback → lands in local-router/fallback-models,
   visible in dropdown + Fallback Order immediately after navigation.
4. Merge --no-ff per repo convention; release hop per Develop-Complete Gate.
