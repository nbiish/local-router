# Task: Managed Inference Endpoint Sync & Auto-Unwrapped Tunnel Tokens

- lane: now
- branch: `feat/managed-inference-bridge-sync`
- worktree: `/Volumes/1tb-sandisk/code-external/local-router-worktrees/lr-managed-bridge-sync`
- status: done
- plan: `.agents/plans/2026-11-28-01-managed-inference-bridge-sync.md`

## What Changed

- `src/pqc-entitlement.ts`: exported `bridgeKeyHash()` (non-secret 64-hex SHA3-256 matching `local-router-dot-com/lib/pqc.js`), sent `bridgeKeyHash` on `pairWithControlPlane()` & `refreshLeaseFromControlPlane()`, auto-unwrapped `ML-KEM-768` `wrappedTunnelToken` into `0600` `cloudflared-bridge.token`, and tracked `inferenceEndpoint` & `tunnelHostname`.
- `src/routes/config-api.ts`: auto-synced rotated `bridgeKeyHash` to `local-router.com` on `POST /api/bridge-key/rotate` for paired devices.
- `src/ui/pages/agents.ts`: added 1-click **Copy Team / Harness Config** button (`Base URL + Model + API Key`) for Business employee chat and agent harnesses.
- `tests/bridge-tunnel.test.mjs`: added test proving zero plaintext `lrk_` key sent on pair and `ML-KEM-768` tunnel token auto-unwrap into `0600` file.
