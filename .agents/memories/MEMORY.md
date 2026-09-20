# MEMORY — local-router (curated digest)

One entry per durable fact. Format: \- [YYYY-MM-DD] <fact> *(source: <server/tool>)*\ — newest first per section. Contracts live in the \llms.txt\ chain, never duplicated here. Exports beside this file are machine snapshots; this file is the curated layer agents iterate on.

## Facts
- [2026-09-20] pqc-secrets sync v1.3.0 (ainish-coder 5eb880f, deployed byte-identical): `pqc-secrets sync --from <dir> --to <dir>... [--dry-run] [--force]` re-packs one store's secrets into other stores under EACH target's own identity; merge preserves target-only keys; ssh lane `sync --stdout | ssh host 'pqc-secrets sync --stdin --to <dir>'`. Store dirs are self-contained identities — copying bundle files across machines never works. *(source: obs)*
- [2026-09-20] Loopback-only posture (2026-09-19 operator directive, merged aed099d): TLS/HTTPS listener (11443), cloudflared exposure, and strict-tooling URLs removed; HTTP 11434 (dual-stack loopback, 0.0.0.0 under LOCAL_ROUTER_BIND_ALL=true) is the sole serving surface. *(source: operator, obs)*

- [2026-09-10] Thinking level defaults to medium (DEFAULT_THINKING_LEVEL in src/reasoning.ts). Resolution order: (1) explicit opt-out disables unconditionally, (2) explicit opt-in passes through normalized, (3) configured global/per-provider level applies. *(source: memorix, obs:4)*
- [2026-09-10] SSRF Guard routes all outbound custom-provider or live-discovered requests through safeFetch in src/ssrf-guard.ts, rejecting private/loopback/cloud-metadata IPv4 prefixes. *(source: engram, obs:6)*

## Decisions
- [2026-09-20] No-https-policy: tools refusing http://localhost base URLs are unsupported by policy; cross-boundary (Windows->WSL) access is a deployment concern solved by netsh portproxy or mirrored networking, NEVER a public tunnel (router has no inbound auth). *(source: operator directive 2026-09-19)*

- [2026-09-10] Graceful Cascade on Preflight Failures: Preflight failures (unknown model, no provider, no key/credits, allowlist reject) log skipped: true, stageAttempts: 0 and advance immediately to next fallback stage with zero retries; chain fails only on total exhaustion. *(source: memorix reasoning #5, engram obs:7)*

## Gotchas
- [2026-09-20] Router cross-store visibility: boot log prints `[PQC] sync: <dir>: N secret(s), M provider-mapped` per candidate store (ambient PQC_CONFIG_DIR, ~/.config/pqc-secrets, WSL /mnt/*/Users interop, LOCAL_ROUTER_PQC_EXTRA_DIRS `:`/`;`-separated). Zero-provider-keys warning fires when stores hold no provider-mapped keys. *(source: obs)*
- [2026-09-20] loadPqcSecrets spawns `uv run --script pqc_secrets.py export` synchronously BEFORE app.listen: cold uv cache + sandbox HOME (mktemp) stalls boot indefinitely — server never binds, node --test aborts at custom-providers.integration. Use LOCAL_ROUTER_SKIP_PQC_LOAD=true for local suite runs. *(source: obs)*
- [2026-09-20] Provider keys live in /mnt/c/Users/kenwa/.config/pqc-secrets (WSL-interop candidate): a Windows-side rewrite (2026-09-19 21:14 local) stripped all provider keys — every boot since exhausts the fallback chain until keys are re-packed (home bundle holds only LOCAL_ROUTER_DOT_COM_ADMIN_TOKEN). *(source: obs)*
- [2026-09-20] WSL2 localhost forwarding is dead on this host (networkingMode=NAT): Windows browsers/orca reach WSL services only via netsh portproxy (0.0.0.0:11434 and 0.0.0.0:7800 -> 172.30.170.141). Rules go stale when the WSL IP changes on reboot. *(source: obs)*
- [2026-09-20] tests/wafer-discovery.test.mjs is network-bound and hangs/401-flakes locally (passes its registry/live-probe cases, then stalls on endpoint 401 recovery); run the gated suite excluding it. *(source: obs)*

- [2026-09-10] Non-loopback upstreams strictly require HTTPS; loopback HTTP is allowed only for registered local service backends (llama-server, unsloth); other HTTP is dev-mode only (LOCAL_ROUTER_DEV=true). *(source: memorix, obs:3)*
