# Task: Packaged Cloudflared + PQC Hardware-Machine Hash Bridge

- lane: now
- branch: `feat/pqc-cloudflared-bridge`
- worktree: `/Volumes/1tb-sandisk/code-external/local-router-worktrees/pqc-cloudflared-bridge`
- status: done
- plan: `.agents/plans/2026-11-27-23-pqc-cloudflared-bridge.md`

## What Changed

- `src/pqc-entitlement.ts`: added `getHardwareMachineIdHash()` (one-way SHA3-256 over macOS `IOPlatformUUID` / Windows `MachineGuid` / Linux `/etc/machine-id`), `computeAppMachineHash()` (`app3:<sha3-256>`), hardware+app hash transmission on `pairWithControlPlane` / `refreshLeaseFromControlPlane`, and offline clone rejection (`machine_hash_mismatch` / `app_machine_hash_mismatch`).
- `src/bridge-tunnel.ts`: packaged `cloudflared` detection, `0600` token-file custody (token never in argv), deterministic PQC + tier gate (`canStartRemoteBridge()` refusing free-tier/cloned leases fail-closed), and start/stop/status lifecycle.
- `src/routes/config-api.ts`: added loopback-only `/api/bridge/{status,token,start,stop}` (`403` remotely) and exposed `machineIdHash` + `appMachineHash` on `/api/bridge-key/status`.
- `bin/localrouter.js`: added `localrouter bridge <status|start|stop|set-token|clear-token|copy-key>` and `localrouter bridge-key --inject-pqc` (stdin-only injection into `pqc-secrets`, zero argv/echo).
- `src/ui/pages/agents.ts`: upgraded `/config/agents` card with Machine Hash, App Hash, Cloudflared Bridge status, Start/Stop controls, and `0600` tunnel token setup.
- `tests/bridge-tunnel.test.mjs`: added unit tests for hardware/app hashing, free-tier bridge refusal, paid-tier allowance, lease cloning rejection, and `0600` token validation.

## Verification

- `npm run build` (`tsc`) clean, `node scripts/check-english-only.mjs` clean.
- `node --test tests/pqc-entitlement.test.mjs tests/bridge-tunnel.test.mjs tests/inbound-auth.test.mjs tests/inbound-auth.integration.test.mjs tests/ui-page-scripts-parse.test.mjs`: **36/36 passing**.
