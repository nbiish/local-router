# Plan: Packaged Cloudflared + PQC Hardware-Machine Hash Bridge (`local-router`)

- **Date (UTC):** 2026-11-27 23:14Z
- **Repo:** `nbiish/local-router`
- **Branch:** `feat/pqc-cloudflared-bridge`
- **Worktree:** `/Volumes/1tb-sandisk/code-external/local-router-worktrees/pqc-cloudflared-bridge`

## Threat Model

- **Assets protected:** Remote HTTPS tunnel exposure (`cloudflared`), paid-tier entitlement enforcement, per-machine PQC bridge keys, and hardware identity privacy.
- **Adversaries:** Free-tier users cycling accounts or wiping `~/.config/local-router` to bypass caps; attackers cloning a paid `account-lease.json` onto another host; tunnel token leakage via process `argv` or logs; remote callers invoking loopback bridge controls.
- **Worst realistic outcome if wrong:** Unauthenticated or unlicensed remote tunnel exposure, raw hardware UUIDs leaking into logs/control plane, or tunnel tokens exposed in `ps aux`.

## Design

1. **Cross-Platform Hardware + App PQC Hashing (`src/pqc-entitlement.ts`):**
   - `getHardwareMachineIdHash()`: reads OS hardware UUID (`IOPlatformUUID` on macOS, `MachineGuid` on Windows, `/etc/machine-id` on Linux/WSL) and immediately hashes via `SHA3-256("lr-hw-machine-v1|" || rawId)` — raw UUID is never stored or transmitted.
   - `computeAppMachineHash({ appId, machineIdHash, devicePubHash })` → `app3:<sha3-256 hex>` matching `local-router-dot-com/lib/pqc.js`.
   - Bind `machineIdHash` & `appMachineHash` into `pairWithControlPlane`, `refreshLeaseFromControlPlane`, and offline `verifyAppLease` (fails closed with `machine_hash_mismatch` if cloned to another host).
2. **Packaged Cloudflared Bridge Manager (`src/bridge-tunnel.ts`):**
   - Cross-platform `cloudflared` detection, `0600` token-file management (`~/.config/local-router/cloudflared-bridge.token` — token NEVER passed in argv), deterministic tier gate (`canStartRemoteBridge()`), and start/stop/status lifecycle.
3. **Loopback API, CLI, and Dashboard UI (`src/routes/config-api.ts`, `bin/localrouter.js`, `src/ui/pages/agents.ts`):**
   - Loopback-only `/api/bridge/{status,token,start,stop}` (`403` remotely).
   - CLI `localrouter bridge <status|start|stop|set-token|copy-key>` + `localrouter bridge-key --inject-pqc` (pipes key to `pqc-secrets set --stdin`, zero argv/echo).
   - Upgraded `/config/agents` card showing `Machine Hash`, `App Hash`, `cloudflared` status, Start/Stop controls, and tunnel token setup.

## Verification

- `npm run build` (`tsc`), `node scripts/check-english-only.mjs`.
- `node --test tests/pqc-entitlement.test.mjs tests/bridge-tunnel.test.mjs tests/inbound-auth.test.mjs tests/inbound-auth.integration.test.mjs tests/ui-page-scripts-parse.test.mjs`.
- Live verification on both Mac and Windows (native PowerShell + WSL) + `browser-use` visual inspection.
