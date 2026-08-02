# TASK.2026-08-02 — Phase 1 Security Hardening

Branch: `feat/security-harden-2026-08` (worktree `../security-harden`, off `develop`).
Scope: SSRF egress guard, loopback bind, middleware, at-rest perms + log redaction,
OAuth hygiene + PQC TODO, banned-crypto audit, supply-chain hooks.

## Chain-of-Draft

- worktree off develop created
- read PRD llms.txt + oauth note
- locate fetch sites index.ts
- discovery fetch at 2090 guarded
- chat fetch at 5093 custom-only
- ssrf-guard.ts helper module
- resolve host block private ranges
- metadata IP 169.254 blocked
- loopback needs DEV mode
- redirect manual re-validate hops
- bind 127.0.0.1 default
- BIND_ALL env opens 0.0.0.0
- helmet rate-limit CORS added
- error handler hides stacks
- writeFileSync mode 0600 everywhere
- mkdirSync mode 0700 everywhere
- redact Bearer/api-key telemetry
- oauth creds already 0600
- TODO PQC bundle llms.txt:779
- audit src clean SHA256 only
- CI npm audit + secret scan
- tsc + npm test pass

####

Deliverable: hardened develop branch, validated tsc + tests.
