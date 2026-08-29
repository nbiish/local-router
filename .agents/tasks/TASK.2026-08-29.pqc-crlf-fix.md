---
date: 2026-08-29
type: fix
scope: pqc-crlf-line-parsing
slug: fix-pqc-crlf-export-line-parsing
---

1. Fix CRLF line splitting in PQC export.
2. Strip carriage returns on Windows.
3. Clean Authorization Bearer prefix.
4. Auto-load 15 keys on boot.
5. All 112 tests passing.
####
Deliverable: Ensure all 15 PQC keys load automatically on boot across all platforms and survive all server restarts.
