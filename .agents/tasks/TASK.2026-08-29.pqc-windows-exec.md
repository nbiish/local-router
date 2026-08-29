---
date: 2026-08-29
type: fix
scope: pqc-secrets-windows-exec-and-persistence
slug: fix-pqc-secrets-windows-spawn-and-persistence
---

1. Fix Windows spawnSync EINVAL error.
2. Delegate to direct uv execution.
3. Auto-bootstrap bundle on sync/save.
4. Robust key persistence across restarts.
5. All 112 tests passing.
####
Deliverable: Fix PQC secrets execution and persistence on Windows, preventing key loss and enabling permanent key sync across restarts.
