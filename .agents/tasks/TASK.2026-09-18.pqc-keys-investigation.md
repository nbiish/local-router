# TASK.2026-09-18.pqc-keys-investigation.md

- **Scope:** Investigate and resolve PQC keys detection in local-router under WSL by implementing cross-platform WSL interop for PQC bundles.
- **Branch:** `fix/security-pqc-keys`
- **Worktree:** `d:\Code\local-router` (branch `fix/security-pqc-keys`)
- **Triage:** `now`
- **Status:** `completed`
- **Root Cause:**
  - PQC keys were safely packed in Windows at `C:\Users\kenwa\.config\pqc-secrets\secrets.bundle.json` (15 keys).
  - The live local-router instance was running inside WSL (Ubuntu), where `getPqcConfigDir()` resolved only to `/home/nanoboozhoo/.config/pqc-secrets/` which had zero provider keys.
- **Resolution:**
  - Implemented `getPqcConfigDirCandidates()` to probe Windows host `/mnt/<drive>/Users/<user>/.config/pqc-secrets` when running under WSL.
  - Updated `syncKeysFromPqcBundle()` to scan and aggregate keys from all candidate bundles so both native and host-managed keys load seamlessly.
  - Rebuilt and restarted router in WSL; verified all 15 PQC keys are loaded and report `configuredSource: pqc`.
