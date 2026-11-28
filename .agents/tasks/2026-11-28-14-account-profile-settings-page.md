# Task: Account Profile Settings & Tied Machines Page

- lane: now
- branch: `feat/account-profile-settings-page`
- worktree: `/Volumes/1tb-sandisk/code-external/local-router-worktrees/lr-account-profile-settings-page`
- status: done
- plan: `.agents/plans/2026-11-28-14-account-profile-settings-page.md`

## What Changed

- `src/pqc-entitlement.ts`: added `listAccountDevices()`, `renameAccountDevice()`, and `revokeAccountDevice()` using in-memory `ML-KEM-768` credential decapsulation.
- `src/ui/pages/account.ts` & `src/ui/pages/layout.ts`: added **Account & Machines (`/config/account`)** page to the sidebar with open-source `localhost:11434` guarantee, Sign-in / Pair form, tier quota counter, and inline Rename/Delete controls for all tied machines.
- `src/routes/config-api.ts`: added loopback-only `GET /config/account`, `GET /api/account/devices`, `PATCH /api/account/devices/:id`, and `DELETE /api/account/devices/:id`.
- `tests/ui-page-scripts-parse.test.mjs` & `tests/pqc-entitlement.test.mjs`: verified page script parsing and list/rename/delete device management.
