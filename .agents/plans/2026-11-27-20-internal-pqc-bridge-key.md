# Plan: Built-In Per-Machine PQC Bridge Access Key (Zero External `pqc-secrets` Setup)

- **Date (UTC):** 2026-11-27 20:21Z
- **Repo:** `nbiish/local-router`
- **Branch:** `feat/internal-pqc-bridge-key`
- **Worktree:** `/Volumes/1tb-sandisk/code-external/local-router-worktrees/internal-pqc-bridge-key`

## Threat Model

- **Assets protected:** Remote HTTPS bridge access (`inbound-auth.ts`) and per-machine cryptographic identity (`device-pqc-identity.json`, mode `0600`).
- **Adversaries:** Unauthenticated internet callers probing a user's tunneled endpoint; cross-origin webpages attempting to read local loopback APIs; plaintext key leakage into logs, git, or shell history.
- **Worst realistic outcome if wrong:** Plaintext bridge key written to disk or leaked to public callers; breaking existing fail-closed `503` semantics when `LOCAL_ROUTER_SKIP_PQC_LOAD=true` or in unit tests.

## Design

1. **Per-Machine PQC Key Derivation (`src/pqc-entitlement.ts`):**
   - Extend `DevicePqcIdentity` (`~/.config/local-router/device-pqc-identity.json`, mode `0600`) with `bridgeKeyEpoch` (default `1`).
   - `deriveMachineBridgeAccessKey(identity?)`: derives `"lrk_" + sha3-256("lr-machine-bridge-key-v1|" || mlKem768SecretKey || "|" || deviceId || "|" || devicePubHash || "|" || epoch)` strictly in memory — zero plaintext bridge key written to disk, zero external `pqc-secrets` CLI required for new users.
   - `rotateMachineBridgeAccessKey()`: increments `bridgeKeyEpoch`, saves updated identity (`0600`), and returns the new key + `sha3:<16-hex>` fingerprint.
2. **3-Tier Precedence (`src/inbound-auth.ts` + `src/index.ts`):**
   - `env` (`LOCAL_ROUTER_ACCESS_KEY`) → `pqc-vault` (`noteVaultAccessKey`) → `machine-pqc` (`noteMachineAccessKey`, loaded at boot in `src/index.ts` when `LOCAL_ROUTER_SKIP_PQC_LOAD !== 'true'`).
   - Preserves fail-closed `503` when no key is noted (`tests/inbound-auth.test.mjs` and `tests/inbound-auth.integration.test.mjs` Server B).
3. **Loopback-Only Pull & Rotate Surface (`403 local access only` over public tunnels):**
   - HTTP API (`src/routes/config-api.ts`):
     - `GET /api/bridge-key/status`: returns `{ configured, source, deviceId, epoch, fingerprint, devicePubHash }` (never returns secret).
     - `POST /api/bridge-key/reveal`: loopback-only, `Cache-Control: no-store`, returns active `{ accessKey, source, deviceId, epoch, fingerprint }`.
     - `POST /api/bridge-key/rotate`: increments `bridgeKeyEpoch`, live-updates `noteMachineAccessKey`, returns new metadata.
   - CLI (`bin/localrouter.js`):
     - `localrouter bridge-key [--copy] [--raw] [--rotate] [--json]` — zero-echo `--copy` copies active key straight to macOS/Windows/Linux clipboard; default prints safe metadata + SHA3 fingerprint only.
   - Local Dashboard UI (`src/ui/pages/agents.ts`):
     - Adds a "Remote Bridge Access Key (Built-in PQC)" card at `/config/agents` with **Copy Bridge Key**, **Show/Hide**, and **Rotate Machine Key** buttons.

## Verification

- `npm run build` (`tsc`) clean.
- `node scripts/check-english-only.mjs` clean.
- `node --test tests/pqc-entitlement.test.mjs tests/inbound-auth.test.mjs tests/inbound-auth.integration.test.mjs tests/ui-page-scripts-parse.test.mjs` passes 100%.
- Live smoke test of `/api/bridge-key/status`, `/api/bridge-key/reveal` (200 on loopback, 403 with `CF-Connecting-IP`), `/api/bridge-key/rotate`, and `localrouter bridge-key --json`.
