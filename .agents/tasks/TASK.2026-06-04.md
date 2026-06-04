# TASK 2026-06-04 — Thinking decouple + Responses HTTP SSE

Branch: feat/routing-thinking-streaming
Base: develop @ 19f95b0

- read plan
- worktree created
- decouple UI cards
- persist prompt only
- responses-stream module
- HTTP SSE stream=true
- WS uses shared sink
- integration tests
- llms.txt sync

####

Decouple thinking from system prompt in `/config` and APIs. Implement `POST /v1/responses` HTTP SSE streaming via shared translator with WebSocket path.
