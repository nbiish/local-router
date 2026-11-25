---
plan_format: ainish/plan/v1
slug: inbound-access-control
date: 2026-11-25
status: done
branch: fix/inbound-access-control
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/inbound-access-control
task_record: .agents/tasks/TASK.2026-11-25-12-inbound-access-control.md
operator: question-me
---

# Plan: fix/inbound-access-control — key-gated public inference, loopback-only admin

Date: 2026-11-25 (12 UTC)
Status: in progress
Worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/inbound-access-control
Branch: fix/inbound-access-control (off origin/main @ baf9e7d)

## Threat model

Assets: the operator's paid provider keys held by the router, the router's
config/admin API (`/config*`, `/api/router-settings`, `/api/config/*`, `/api/pqc/*`),
and the dashboard UI. Exposure verified by the operator through the Cloudflare
Tunnel at `https://inference.local-router.com` → `127.0.0.1:11434`: an
unauthenticated stranger could read the full fallback configuration, list every
provider/model, and run **paid inference on the operator's keys**. Worst realistic
outcome: key theft by reading admin config, and financial drain via unauthenticated
completions; second-order: a malicious webpage reading loopback admin JSON from the
operator's own browser (`Access-Control-Allow-Origin: *` + no inbound auth).
Mitigation: deny-by-default inbound gate classified by transport (`cf-connecting-ip`
or non-loopback socket ⇒ public), explicit inference-only path allowlist,
timing-safe key compare, fail-closed when no key is configured, strict CORS
(loopback-allowlist origins only, no CORS headers on public responses), same gate
on the `/v1/responses` WebSocket upgrade. Loopback clients (desktop app, CLI tools)
stay ungated with zero config. No secrets in code/tests/logs — the key arrives at
runtime via `LOCAL_ROUTER_ACCESS_KEY` or the pqc-secrets vault.

## Design

1. **New module `src/inbound-auth.ts`** (no imports from `src/index.ts` — no cycle):
   - `classifyRequest(req)`: public when `cf-connecting-ip` header present OR
     `req.socket.remoteAddress` is not loopback (127.0.0.0/8, ::1, ::ffff: forms;
     `::ffff:` stripped). XFF and friends are never trusted for classification
     (spoofable); `cf-connecting-ip` presence is itself the public signal because
     Cloudflare always sets it and a spoof only *restricts* the spoofer.
   - `INFERENCE_PATH_ALLOWLIST`: single exported const array, commented per entry:
     `/v1` (OpenAI/Anthropic/decisions client surface) + ollama-style exact routes
     (`/api/chat`, `/api/generate`, `/api/tags`, `/api/show`, `/api/ps`, `/api/embed`,
     `/api/embeddings`, `/api/version`). Match = equal or `entry + '/'` prefix
     (no `/api/chatty` collisions). Everything else from a public request → 403
     `{error:'local access only'}` regardless of key validity.
   - Key resolution precedence: `process.env.LOCAL_ROUTER_ACCESS_KEY` → vault value
     noted by `noteVaultAccessKey()` (fed from the PQC bundle sync). No key at all →
     503 `{error:'access key not configured'}` for public inference (fail closed).
   - `timingSafeKeyMatch(presented, configured)`: sha256 both sides, then
     `crypto.timingSafeEqual` — constant-time, length-safe.
   - `evaluateInboundAccess(req)`: pure decision → null (pass) | 401/403/503 with the
     fixed JSON bodies; rejections carry `Cache-Control: no-store`, never echo the
     presented key. Reused by the Express middleware AND `handleHttpUpgrade` so the
     `/v1/responses` WS path cannot bypass the gate.
   - `inboundCors(req,res,next)`: replaces `app.use(cors())`. Public requests get NO
     CORS headers (server-side AI clients don't need them; wildcard only helped
     abusive pages). Loopback: `Vary: Origin` always; ACAO reflects the origin only
     when it is `http://127.0.0.1:{PORT}` / `http://localhost:{PORT}` /
     `http://[::1]:{PORT}` (devUrl is the router's own origin per tauri.conf.json, so
     no extra origins); no credentials; preflight OPTIONS answered directly (204,
     `Access-Control-Allow-Methods/Headers`) for allowlisted origins, else 204 with
     no CORS headers (browser blocks).
2. **`src/index.ts` wiring** (early, before all routes — verified none exist above
   line 570): `app.use(inboundCors)` replaces `app.use(cors())` (line 541);
   `app.use(inboundAccessControl)` right after the trackInFlight block, BEFORE
   `express.json` (rejected bodies are never parsed) and before the rate limiters;
   PQC bundle sync loop calls `isInboundAccessKeyName(name)` → `noteVaultAccessKey`
   (same export flow as provider keys); `handleHttpUpgrade` consults the evaluator;
   drop the now-unused `cors` import. No routing/fallback/keepalive changes;
   `src/sse-keepalive.ts` untouched.
3. **`src/pqc-key-resolver.ts`**: add `isInboundAccessKeyName(fullName)` — requires a
   tool prefix (`LOCALROUTER_`/`LOCAL_ROUTER_`/`LOCAL-ROUTER_`) + `ACCESS_KEY` stem
   (bare `ACCESS_KEY` is rejected as too generic).
4. **`src-tauri/src/daemon.rs`**: `pass_inbound_access_key(&mut Command)` forwards
   `LOCAL_ROUTER_ACCESS_KEY` from the app's own environment to the spawned daemon
   when present and non-blank. Nothing hardcoded; explicit passthrough documents
   intent and survives any future `env_clear`.
5. **Tests** (`node --test`, concurrency 1, scrubbed env per tests/test-env.mjs):
   - `tests/inbound-auth.test.mjs` (unit, imports `build/inbound-auth.js`):
     classification (loopback trio + `::ffff:` forms + cf-header override), allowlist
     match/deny table (incl. `/config`, `/api/router-settings`, `/v1x`, `/api/chatty`,
     case-sensitivity), timing-safe (same length, last byte differs → false),
     origin allowlist builder, evaluator verdict table with env-controlled key.
   - `tests/inbound-auth.integration.test.mjs`: spawns `build/index.js` twice on
     random ports. Keyed server: loopback `/api/router-settings` 200; loopback
     `/v1/models` 200 ungated; public no-key/wrong-last-byte-key `/v1/chat/completions`
     → 401 (+`Cache-Control: no-store`); public right key → passes middleware
     (downstream router error, never a gate status/body) and `/v1/models` → 200;
     public right key on `/api/router-settings`, `/config`, unknown path → 403
     `local access only`; CORS assertions (allowlisted ACAO echo + Vary, evil origin
     none, public none, preflight allowed headers). Keyless server: public
     `/v1/models` → 503 `access key not configured`, loopback still open.
   - Add both files to `package.json` `test:integration` (origin/main's list).
6. **Docs**: README section "Public exposure (tunnel) access control"
   (loopback-open / public-key-required / dashboard-never-public + how to set the
   key); `llms.txt` decision row (2026-11-25) + amend the stale "the router has no
   inbound auth" claim on the loopback-only line.

## Constraints honored

Deterministic decisions in code; no secrets anywhere; routing/fallback/keepalive
untouched; existing tests stay green (CI baseline flake: ENOTEMPTY temp-dir races +
custom-providers double-request — my tests use one mkdtemp per server and never
spawn custom-provider flows); delivery by PR to main, no self-merge.

## Verification gates

1. `npm run build` (tsc strict) green in the worktree.
2. `node --test` new suites green.
3. `node --test` targeted existing suites that touch the middleware region
   (pqc-key-resolver, sse-keepalive, config-location, ui-page-scripts-parse) green.
4. PR opened with What/Why/How-verified; operator reviews and merges.
