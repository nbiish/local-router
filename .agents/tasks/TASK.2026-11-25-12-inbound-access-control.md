# TASK.2026-11-25-12 — Inbound access control for tunnel/public exposure

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router` (worktree `/Volumes/1tb-sandisk/code-external/local-router-worktrees/inbound-access-control`)
- Branch: `fix/inbound-access-control` (off `origin/main` @ baf9e7d, pushed as 54f79be)
- Plan: `.agents/plans/2026-11-25-12-inbound-access-control.plan.md`
- Status: DONE — PR #22 MERGED 2026-11-25 → origin/main `d805943` (subagent commit 54f79be + operator hardening 4d78e8e), merged by the operator with full merge authority granted for this close-out. Deployed to the Mac daemon (launchd `com.localrouter.daemon`, hardened build) and proven live — see Close-out.

## Objective

A Cloudflare Tunnel (or any non-loopback client) may use only the inference API
and only with a valid access key; the dashboard/admin/config surface is never
reachable from beyond loopback. Verified exposure before this change (operator's
production probe through `https://inference.local-router.com` → 127.0.0.1:11434):
`GET /api/router-settings` 200 (full fallback config), `GET /config` 302,
`GET /v1/models` 200 (78 KB provider/model list), `POST /v1/chat/completions`
unauthenticated paid inference. The router had NO inbound auth (all `apiKey`
references in src were outbound provider keys).

## Threat model

Assets: operator's paid provider keys, admin config, dashboard UI. Worst
realistic outcomes: key/config theft via public admin reads; financial drain via
unauthenticated completions; second-order, a malicious webpage reading loopback
admin JSON through the old `cors()` wildcard from the operator's own browser.
Mitigations: deny-by-default transport classification (`cf-connecting-ip` present
or non-loopback socket ⇒ public), explicit commented inference allowlist,
timing-safe key compare (sha256 digests + `timingSafeEqual`), fail-closed 503
when no key is configured, 403-regardless-of-key for all non-inference paths,
WS-upgrade gate (Express middleware never sees WebSocket upgrades), strict CORS
(loopback-origin reflection only, no CORS headers on public responses, no
credentials ever). No secrets in code/tests/logs; key arrives at runtime via
`LOCAL_ROUTER_ACCESS_KEY` env (wins) or the `LOCALROUTER_ACCESS_KEY` vault entry
resolved through the same `pqc-secrets export` bundle sync that loads
`LOCALROUTER_*_API_KEY` provider keys (the vault-holder-backed flow).

## Delivered

1. `src/inbound-auth.ts` (new): classification, allowlist, timing-safe compare,
   evaluator, Express gate + CORS middleware, raw upgrade rejection response.
2. `src/index.ts`: `cors()` replaced by `inboundCors`; `inboundAccessControl`
   inserted before `express.json` and all routes/limiters; PQC export loop notes
   vault `LOCALROUTER_ACCESS_KEY` via `noteVaultAccessKey` (env wins, never
   stored in the provider keyStore); `handleHttpUpgrade` consults the evaluator.
3. `src/pqc-key-resolver.ts`: `isInboundAccessKeyName` — prefix-required
   (`LOCALROUTER_`/`LOCAL_ROUTER_`/`LOCAL-ROUTER_`) + `ACCESS_KEY` stem; bare
   `ACCESS_KEY` deliberately rejected.
4. `src-tauri/src/daemon.rs`: `pass_inbound_access_key` forwards the operator's
   env value to the spawned daemon (nothing hardcoded).
5. Tests: `tests/inbound-auth.test.mjs` (11 unit), `tests/inbound-auth.integration.test.mjs`
   (13 integration, two spawned servers — keyed + keyless fail-closed); both
   registered in `package.json` `test:integration`.
6. Docs: README "Public exposure (tunnel) access control" section (incl.
   provisioning: `pqc-secrets gen --env LOCALROUTER_ACCESS_KEY | pqc-secrets set --stdin`);
   `llms.txt` decision row 2026-11-25 + superseded "no inbound auth" claim.

## Not done / notes

- The vault entry is NOT provisioned by this task (operator action by design).
- Until the operator sets the key, public inference fails closed with 503 —
  deliberately; loopback is unaffected.
- CI baseline flake (documented): ENOTEMPTY temp-dir races + custom-providers
  double-request. Compare any failure against that baseline, not as a new
  regression.

## Evidence

- `tsc` (strict) green; `cargo check` green (src-tauri).
- New suites: 11/11 unit + 13/13 integration pass.
- Full `test:integration` suite on the branch (486 tests incl. the 24 new ones):
  471 pass / 2 fail / 13 skip. Both failures reproduce identically on the
  UNMODIFIED base checkout (measured): `detectLocalCursorSession auto-detects
  host installation` (reads the host's real ~/.cursor auth state — machine
  state, documented flake) and `tauri window config keeps dragDropEnabled false`
  (base `tauri.conf.json` has no `app.windows` array — pre-existing on
  origin/main, no file in this PR touches it; suggestion filed). Not regressions.
- PR: https://github.com/nbiish/local-router/pull/22 (What/Why/How-verified in
  the description; CI state checked at open).
- CI run 45615870032 (3 OS + audit): audit pass; ubuntu/windows/macos fail ONLY
  on the pre-existing baseline family (custom-providers CRUD flake, tauri-dnd
  app.windows, ENOTEMPTY temp-dir races) — failure sets identical to main's own
  baseline run 45614925637 from minutes earlier; zero inbound-auth failures on
  any OS (24 new tests pass everywhere). Evidence table posted as a PR comment.

## Close-out (operator, 2026-11-25 ~13:10Z)

Changes on top of the subagent commit, both in PR #22:
- `src/inbound-auth.ts`: added `isSuspiciousPath()` (dot-segments, `//`, `\`, NUL, and their
  percent-encoded forms); the inference allowlist now returns false for suspicious paths.
  Reason: the allowlist matched the raw path, so `/v1/../api/router-settings` and `%2e%2e`
  forms satisfied the `/v1` prefix before Express or Cloudflare normalised anything.
- `tests/inbound-auth.test.mjs`: 11 refused paths → 25/25.

Independent verification (not the subagent's word):
- `tsc --noEmit` exit 0; inbound-auth 25/25 + integration 13/13.
- CI run 45615870032 vs main baseline 45614925637: failing set identical except one member of
  the ENOTEMPTY temp-dir race family; zero inbound-auth failures on any OS.
- Live, through `https://inference.local-router.com`, hardened build (server pid restarted):
  `/api/router-settings`, `/config`, `/api/health`, `/api/fallback-models` → 403 local access only;
  `/v1/models`, `/api/version`, WS upgrade `/v1/responses` → 503 access key not configured (no key provisioned);
  loopback `/api/router-settings` → 200; `Origin: http://evil.example` → no ACAO;
  `Origin: http://127.0.0.1:11434` → ACAO reflected.

Not done here (operator-only, by design):
- Provisioning `LOCALROUTER_ACCESS_KEY`. `bin/pqc-secrets set --stdin` requires the vault passphrase
  interactively; an automated run aborted cleanly (entry count unchanged, daemon still fail-closed).
  Until the operator provisions it the bridge answers 503 to everyone — closed, not open.
- Live 401-with-key / 200-with-key paths are covered by unit + integration tests only; no key
  exists on this machine, so they were not exercised through the tunnel.
- Live traversal probe used curl's default dot-segment normalisation; refusal of raw traversal
  forms is proven by the unit set, not by the live 403.

Restart procedure proven: `node bin/local-router.js stop && launchctl kickstart -k gui/$(id -u)/com.localrouter.daemon`
(`kickstart -k` alone replaces only the supervisor and leaves the detached server child running).
