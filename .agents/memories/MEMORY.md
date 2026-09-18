# MEMORY — local-router (curated digest)

One entry per durable fact. Format: \- [YYYY-MM-DD] <fact> *(source: <server/tool>)*\ — newest first per section. Contracts live in the \llms.txt\ chain, never duplicated here. Exports beside this file are machine snapshots; this file is the curated layer agents iterate on.

## Facts

- [2026-09-10] Thinking level defaults to medium (DEFAULT_THINKING_LEVEL in src/reasoning.ts). Resolution order: (1) explicit opt-out disables unconditionally, (2) explicit opt-in passes through normalized, (3) configured global/per-provider level applies. *(source: memorix, obs:4)*
- [2026-09-10] SSRF Guard routes all outbound custom-provider or live-discovered requests through safeFetch in src/ssrf-guard.ts, rejecting private/loopback/cloud-metadata IPv4 prefixes. *(source: engram, obs:6)*

## Decisions

- [2026-09-10] Graceful Cascade on Preflight Failures: Preflight failures (unknown model, no provider, no key/credits, allowlist reject) log skipped: true, stageAttempts: 0 and advance immediately to next fallback stage with zero retries; chain fails only on total exhaustion. *(source: memorix reasoning #5, engram obs:7)*

## Gotchas

- [2026-09-10] Non-loopback upstreams strictly require HTTPS; loopback HTTP is allowed only for registered local service backends (llama-server, unsloth); other HTTP is dev-mode only (LOCAL_ROUTER_DEV=true). *(source: memorix, obs:3)*
