# 2026-11-23-17 — app-dnd-and-streaming: desktop DnD reorder + SSE idle keepalive

- Machine: mac (darwin arm64), worktree `/Volumes/1tb-sandisk/code-external/local-router-worktrees/prod-fixes`
- Branch: `fix/app-dnd-and-streaming` (off `origin/main` @ efc374e)
- Plan: `.agents/plans/2026-11-23-17-app-dnd-and-streaming.plan.md`
- Status: DONE (verified locally; PR open)

## Objective

Two user-reported production bugs: (1) model reorder by drag works in the browser
but not in the Tauri desktop app's webview; (2) streaming chat completions through
the HTTPS bridge (inference.local-router.com → cloudflared → :11434) die mid-stream
during upstream silence.

## Root causes (verified)

1. **Desktop DnD:** Tauri v2 `WindowConfig.drag_drop_enabled` defaults to `true`
   (tauri-utils-2.9.3 `src/config.rs:2301`). Enabled, tauri-runtime-wry-2.11.4
   (`src/lib.rs:4862`) installs wry's native drag-drop handler whose callback
   returns `true` (consumed) for every drag event; on macOS wry's `WryWebView`
   implements `NSDraggingDestination` (wry-0.55.1 `class/wry_web_view.rs:80-106`)
   and `drag_drop.rs:38-43` shows the `super` call — WebKit's own drag handling,
   which drives HTML5 DnD — is skipped whenever the handler consumes. In-page DOM
   drags are eaten as file drops. Fix: `"dragDropEnabled": false` in
   `src-tauri/tauri.conf.json` app.windows[0] (+ `dataTransfer.setData` in
   `candidateDragStart` for engines that require payload to start a drag).
   Cost: OS file drops into the window are disabled (the app accepts none today).

2. **Stream kills:** no keepalive existed on any SSE relay. The router's idle
   watchdog allows 120 s of upstream silence (`STREAM_IDLE_TIMEOUT_MS`) but the
   tunnel's read timeout is ~100 s, so healthy-by-router streams were killed by
   the proxy during tool-run / silent-reasoning pauses. Parent's live
   measurements (2026-11-23): a 200.4 s continuous stream completes — no
   total-duration cap; deaths correlate with idle gaps. Audit of the relay chain
   (`sendSuccessfulProxyResponse`, index.ts): true pass-through —
   `Readable.fromWeb` → errorObserver → stripTransform → res, all line-buffered
   pass-throughs; no compression middleware (helmet is headers-only); no body
   buffering. Only missing piece: idle keepalive.

## Implementation

- `src/sse-keepalive.ts`: `attachSseKeepalive(res, intervalMs)` injects
  `: ping\n\n` (legal SSE comment) after `LOCAL_ROUTER_SSE_KEEPALIVE_MS` (default
  15000) of no response bytes, ONLY at a verified event boundary (byte-level
  state machine; mid-frame silence is never interrupted). Idempotent per
  response; disposes on close/finish. `markNonTerminal(res)` keeps translator
  fakes (Anthropic Writable, Responses fakeRes) out of injection.
- `src/index.ts`: attached at the three `text/event-stream` surfaces (OpenAI
  passthrough relay, `/v1/messages`, `/v1/responses`); NDJSON (ollama wire)
  outputs exempt — `: ping` would break JSON-per-line parsers. Added
  `X-Accel-Buffering: no` to streaming headers.

## Evidence

- `node --test tests/sse-keepalive.test.mjs tests/tauri-dnd-config.test.mjs` — 8/8 pass.
- `node --test tests/sse-keepalive-stream.integration.test.mjs` — 3/3 pass
  (keepalive bytes observed during a 700 ms simulated silence; fast streams
  unmodified; non-stream unaffected).
- Related suites: responses-http-stream, responses-websocket-anthropic,
  anthropic-stream, ui-page-scripts-parse, token-efficiency-page — 18/18 pass;
  responses-codex-shapes + agent-wire — 13/13 pass.
- `npm run build` (tsc) clean; `cargo check` clean (25 s, exit 0).
- Manual receipt (built router on :11499, isolated HOME, slow mock upstream,
  `LOCAL_ROUTER_SSE_KEEPALIVE_MS=1500`): client received `: ping\n\n` at
  +1499/+3001/+4505 ms during a 5 s upstream silence, then intact frames at
  +4999 ms.

## Not verified / limits

- The desktop fix is verified at the source level and by config regression test;
  an actual drag inside the packaged app needs a human (no GUI in CI).
- CI (run 45234710922, after 99d6d74 de-flake): all 11 tests from this change
  pass on macos/ubuntu/windows. Remaining red matches the pre-existing main
  baseline (run 45087757534 @ efc374e): `custom-providers.integration.test.mjs`
  `upstreamRequests.length 2 !== 1` (ubuntu/windows) and ENOTEMPTY temp-dir
  cleanup races in decisions*/ollama-version-config-ui teardown (macos) — none
  of which this branch touches.
- Full local `npm run test:integration` not run locally; CI ran the full suite.
- Non-stream responses cannot carry keepalives: an upstream stalling >100 s
  before first byte still dies at the tunnel (router's NON_STREAM_TIMEOUT_MS
  backstop). Documented in the PR.
