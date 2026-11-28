# Plan: In-App Account Connections Setup & Seamless Delete/Re-link UX (`local-router`)

- **Date (UTC):** 2026-11-28 15:44Z
- **Repo:** `nbiish/local-router`
- **Branch:** `feat/account-connections-and-relink`
- **Worktree:** `/Volumes/1tb-sandisk/code-external/local-router-worktrees/lr-account-relink`

## Threat Model

- **Assets protected:** Loopback-only account/connection UI, per-machine PQC bridge key confidentiality, and seamless re-linking without losing local router settings.
- **Adversaries:** Remote callers probing `/config/account` (`403` enforced); XSS via device labels or connection strings.
- **Worst realistic outcome if wrong:** User stuck unable to re-link a machine after deleting it remotely from `local-router.com/dashboard`.

## Design

1. **`src/ui/pages/account.ts`:**
   - Add a **Connections & Remote Bridge** card directly on `/config/account` showing `http://localhost:11434` (always open-source), the machine's PQC bridge key fingerprint, Cloudflared status, and 1-click **Copy Bridge Key**, **Copy Team / Harness Config**, **Rotate Machine Key**, and **Start/Stop Bridge** controls.
   - Automatically detect when the current machine was deleted/revoked remotely (not in active `/api/account/devices` list or `403 device_revoked`) and immediately reveal the **Re-link This Machine** pairing card with clear guidance, plus a **Re-link / Switch Account** button.

## Verification

- `npm run build`, `node scripts/check-english-only.mjs`, `node --test tests/ui-page-scripts-parse.test.mjs tests/pqc-entitlement.test.mjs tests/bridge-tunnel.test.mjs`.
- Live `browser-use` visual inspection of `http://127.0.0.1:11434/config/account`.
