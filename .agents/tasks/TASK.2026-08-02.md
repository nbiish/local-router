# TASK.2026-08-02 — Security Hardening (Phase 1) + Windows Readiness (Phase 2)

Two parallel feature branches integrated into `develop` on 2026-08-02.

---

## Phase 1 — Security Hardening

Branch: `feat/security-harden-2026-08` (worktree `../security-harden`, off `develop`).
Scope: SSRF egress guard, loopback bind, middleware, at-rest perms + log redaction,
OAuth hygiene + PQC TODO, banned-crypto audit, supply-chain hooks.

### Chain-of-Draft

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
- bind ********* default
- BIND_ALL env opens *******
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

Deliverable: hardened develop branch, validated tsc + tests. Commit `9b3f269`.

---

## Phase 2 — Windows Cross-Architecture Readiness

Branch: `feat/windows-readiness` (worktree `../windows-readiness`, off `develop`).
Goal: Boot local-router on Windows from same PQC bundle. Replace POSIX-only
subprocess/port/path code with platform-aware equivalents. No native builds executed blindly.

### Chain-of-Draft

- Audit POSIX-only runtime code.
- found: lsof, sh -lc, /tmp fallback.
- bin CLI: findPidsOnPort, killProcessTree, whichAll.
- Windows: netstat -ano, taskkill /T, where.
- index.ts: PQC child PATH hardcoded.
- defaultChildPathEnv(): env.PATH || platform dirs.
- getPqcBinPath(): .exe + F_OK on win32.
- ollama-backend whichAll: where on win32.
- shim is POSIX-only: guard cmdRouteSet.
- sessions.ts: HOME||USERPROFILE||/tmp.
- /tmp absent on Windows -> os.homedir().
- expert-logs /tmp regex: heuristic only, keep.
- tsc --noEmit: exit 0.
- build: exit 0.
- logic tests: 22/22 pass, 0 fail.
- integration hang: pre-existing (server-on-import).
- POSIX branches unchanged; win32 guarded.

#### Deliverables

- `bin/local-router.js`: IS_WIN guard; `findPidsOnPort` netstat branch; `killProcessTree(pid,force)` taskkill branch; `whichAll` where branch; `routeStatusSummary` via whichAll; `cmdRouteSet` Windows guard; status label fix.
- `src/index.ts`: `defaultChildPathEnv()` (platform-aware child PATH); `getPqcBinPath()` platform-aware (.exe/F_OK on Windows); 3 call sites updated.
- `src/ollama-backend.ts`: `whichAll` Windows `where` branch; POSIX-only shim note.
- `src/sessions.ts`: `os.homedir()` replacing HOME/USERPROFILE/tmp fallback.
- No native pqc-secrets binary built or executed.

### Validation (macOS)
- `npx tsc --noEmit` -> exit 0
- `npm run build` -> exit 0
- node --test (pure subset) -> 22 ok, 0 not-ok
- Pre-existing hang (build/index.js server-on-import + ollama pull loop) unaffected; not caused by this change.

### Windows boot checklist (operator runs on Windows)
1. `node --version` (>= 20 for built-in fetch/AbortSignal.timeout)
2. `git clone` repo -> `npm ci` -> `npm run build`
3. Place `bin\pqc-secrets.exe` (Windows build) in `bin\`; or rely on PQC fallback.
4. Ensure PQC bundle at `%USERPROFILE%\.config\pqc-secrets\secrets.bundle.json`.
5. Set `LOCAL_ROUTER_SKIP_OLLAMA_ENSURE=true` if no local ollama.
6. `npm start` -> expect `[PQC] Loaded N provider key(s)` + `running on http://localhost:11434`.
7. `curl http://localhost:11434/v1/models` -> JSON model list.
8. `local-router route status` -> shim disabled (POSIX feature), `ollama path` resolved via `where`.
9. `local-router stop` -> kills via taskkill tree.

Commit `6d44f62`.
