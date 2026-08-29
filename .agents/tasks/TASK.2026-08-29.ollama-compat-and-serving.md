---
date: 2026-08-29
type: feat
scope: ollama-compat-and-serving
slug: ollama-version-floor-and-universal-checked-serving
---

1. VS Code Copilot checks Ollama.
2. Ensure >=0.6.4 semver version floor.
3. Serve checked models across surfaces.
4. Failover preserves session context across errors.
5. All 112 tests passing.
####
Deliverable: Compliant Ollama version floor (>= 0.6.4), verified checked-model serving across /api/tags, /api/show, /v1/models, and reliable fallback failovers.
