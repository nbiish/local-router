# Plan: Managed Inference Endpoint Sync & Auto-Unwrapped Tunnel Tokens (`local-router`)

- **Date (UTC):** 2026-11-28 01:20Z
- **Repo:** `nbiish/local-router`
- **Branch:** `feat/managed-inference-bridge-sync`
- **Worktree:** `/Volumes/1tb-sandisk/code-external/local-router-worktrees/lr-managed-bridge-sync`

## Threat Model

- **Assets protected:** Per-machine PQC bridge key (`lrk_...`), managed Cloudflare Tunnel token (`cloudflared-bridge.token`, mode `0600`), and Business/Pro shared inference routing.
- **Adversaries:** Network eavesdroppers intercepting tunnel tokens during pairing; stale rotated keys lingering on `inference.local-router.com`.
- **Worst realistic outcome if wrong:** Plaintext `lrk_` key sent to control plane, plaintext tunnel token written with world-readable perms, or rotated Business key still accepted by the gateway.

## Design

1. **`src/pqc-entitlement.ts`:**
   - Export `bridgeKeyHash(accessKey)` (`SHA3-256("lr-bridge-fp-v1:" + key)`, non-secret 64-hex matching `local-router-dot-com/lib/pqc.js`).
   - Send `bridgeKeyHash` on `pairWithControlPlane()` and `refreshLeaseFromControlPlane()` — NEVER the plaintext key.
   - Auto-unwrap `wrappedTunnelToken` via `ML-KEM-768` in memory and write mode `0600` to `cloudflared-bridge.token`.
   - Persist and expose `inferenceEndpoint` and `tunnelHostname` in `AccountLeaseStatus`.
2. **`src/routes/config-api.ts` & `src/ui/pages/agents.ts`:**
   - On `POST /api/bridge-key/rotate`, automatically refresh the paired lease with the new `bridgeKeyHash` so `inference.local-router.com` switches immediately.
   - Add **Copy Team / Harness Config** button on `/config/agents` for 1-click sharing in Business employee chat or agentic harnesses.

## Verification

- `npm run build` (`tsc`), `node scripts/check-english-only.mjs`.
- `node --test tests/pqc-entitlement.test.mjs tests/bridge-tunnel.test.mjs tests/inbound-auth.test.mjs tests/inbound-auth.integration.test.mjs tests/ui-page-scripts-parse.test.mjs`.
