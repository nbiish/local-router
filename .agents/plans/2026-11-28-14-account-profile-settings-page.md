# Plan: Account Profile Settings & Tied Machines Page (`local-router`)

- **Date (UTC):** 2026-11-28 14:23Z
- **Repo:** `nbiish/local-router`
- **Branch:** `feat/account-profile-settings-page`
- **Worktree:** `/Volumes/1tb-sandisk/code-external/local-router-worktrees/lr-account-profile-page`

## Threat Model

- **Assets protected:** Open-source `localhost:11434` availability (always open without sign-up), ML-KEM-768 wrapped renew credentials, and loopback-only account/device controls.
- **Adversaries:** Remote callers over a Cloudflare Tunnel attempting to reach `/config/account` or `/api/account/devices*`; XSS via machine names/labels; plaintext renew secrets written to disk.
- **Worst realistic outcome if wrong:** Remote attacker viewing/deleting tied machines, localhost inference blocked for unsigned-up free users, or XSS in the local dashboard.

## Design

1. **`src/pqc-entitlement.ts`:** Add `listAccountDevices()`, `renameAccountDevice(deviceId, label)`, and `revokeAccountDevice(deviceId)` — decapsulating `wrappedAccessSecret` strictly in memory for HTTPS calls to `local-router.com/api/v1/devices`.
2. **`src/ui/pages/account.ts` & `src/ui/pages/layout.ts`:** Add **Account & Machines (`/config/account`)** to the sidebar with:
   - Open-source `http://localhost:11434` guarantee banner (works with zero sign-up).
   - Sign in / Pair card (link to `local-router.com/dashboard`, pairing code input, optional machine label, tier & PQC hash display, Refresh / Upgrade / Unpair buttons).
   - Tied Machines table with tier quota counter (`X / 3 Free`, `X / 10 Pro`, `X / 50 Business`), inline **Rename**, and **Delete / Revoke** (DOM-only `textContent`, zero `innerHTML`).
3. **`src/routes/config-api.ts`:** Register loopback-only `GET /config/account`, `GET /api/account/devices`, `PATCH /api/account/devices/:id`, and `DELETE /api/account/devices/:id` (`403 local access only` remotely via `inbound-auth.ts`).

## Verification

- `npm run build` (`tsc`), `node scripts/check-english-only.mjs`, full focused tests including `ui-page-scripts-parse.test.mjs` covering `account` page.
- Live `browser-use` visual inspection of `http://127.0.0.1:11434/config/account`.
