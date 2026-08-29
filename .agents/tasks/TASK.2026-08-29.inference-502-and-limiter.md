---
date: 2026-08-29
type: fix
scope: inference-502-oauth-and-config-limiter
slug: fix-copilot-token-exchange-and-config-limiter
---

1. Copilot quota exceeded triggered fallback.
2. Fix detectLocalCopilotSession token exchange.
3. Fix Antigravity OpenAI baseUrl.
4. Raise configMutationLimiter to 5000.
5. All 112 tests passing.
####
Deliverable: Fix Copilot token exchange, Antigravity OpenAI compatibility endpoint, pqc-secrets.cmd batch wrapper on Windows, and eliminate config mutation rate limit locks.
