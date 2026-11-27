# Task: Built-In Per-Machine PQC Bridge Access Key (Zero External `pqc-secrets` Setup)

- lane: now
- branch: `feat/internal-pqc-bridge-key`
- worktree: `/Volumes/1tb-sandisk/code-external/local-router-worktrees/internal-pqc-bridge-key`
- status: done
- plan: `.agents/plans/2026-11-27-20-internal-pqc-bridge-key.md`

## What Changed

- `src/pqc-entitlement.ts`: added `bridgeKeyEpoch` on `DevicePqcIdentity`, `bridgeKeyFingerprint()`, `deriveMachineBridgeAccessKey()` (`lrk_<64-hex>` derived in memory via `SHA3-256` from the machine's local `ML-KEM-768` private identity + `deviceId` + `devicePubHash` + `epoch`, zero plaintext bridge key on disk), and `rotateMachineBridgeAccessKey()`.
- `src/inbound-auth.ts` + `src/index.ts`: added `noteMachineAccessKey()`, `getConfiguredAccessKeySource()`, and `getConfiguredAccessKeyFingerprint()` with 3-tier precedence (`env` > `pqc-vault` > `machine-pqc`, fail-closed `503` when `LOCAL_ROUTER_SKIP_PQC_LOAD=true` or unset in unit tests).
- `src/routes/config-api.ts`: added loopback-only (`403` remotely) `/api/bridge-key/status`, `POST /api/bridge-key/reveal` (`Cache-Control: no-store`), and `POST /api/bridge-key/rotate`.
- `bin/localrouter.js`: added `localrouter bridge-key [--copy] [--raw] [--rotate] [--json]` (zero-echo clipboard copy on macOS/Windows/WSL/Linux).
- `src/ui/pages/agents.ts`: added the **Remote Bridge Access Key (Built-in PQC)** card on `/config/agents` with **Copy Bridge Key**, **Show/Hide Key**, and **Rotate Machine Key** buttons.
- `tests/pqc-entitlement.test.mjs`: added coverage for deterministic in-memory derivation, zero plaintext on disk, epoch rotation invalidating old keys, and 3-tier precedence.

## Verification

- `npm run build` (`tsc`) clean.
- `node scripts/check-english-only.mjs` clean.
- `node --test tests/pqc-entitlement.test.mjs tests/inbound-auth.test.mjs tests/inbound-auth.integration.test.mjs tests/ui-page-scripts-parse.test.mjs`: **34/34 passing**.
- CLI smoke (`localrouter bridge-key --json` + `--rotate --json`): verified epoch increment & fingerprint change with zero secret output.
