---
plan_format: ainish/plan/v1
slug: app-dnd-and-streaming
date: 2026-11-23
status: done
branch: fix/app-dnd-and-streaming
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/prod-fixes
task_record: .agents/tasks/2026-11-23-17-app-dnd-and-streaming.md
operator: question-me
---

# Plan: fix/app-dnd-and-streaming — desktop DnD reorder + SSE idle keepalive

Date: 2026-11-23 (17 UTC)
Status: in progress
Worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/prod-fixes
Branch: fix/app-dnd-and-streaming (off origin/main @ efc374e)

## Threat model

Assets: the operator's running router on :11434, its PQC-backed key store, and the
public HTTPS bridge (inference.local-router.com). This change touches only (a) the
desktop window config and one inline UI drag handler, and (b) the streaming relay
byte path inside the router process. Worst realistic outcome: a keepalive injected
mid-frame corrupts an SSE event stream — mitigated by injecting only at verified
event boundaries (byte-level state machine) and by tests that prove byte-identical
pass-through while upstream data flows. No secrets in code, tests, or argv; tests
spawn isolated routers on random ports with scrubbed env (test-env.mjs rule).

## Bug 1 — model drag reorder broken in the Tauri app (works in browsers)

The UI reorder is plain HTML5 DnD (`draggable="true"` + ondragstart/over/drop/end,
`candidateDrag*` in src/ui/pages/layout.ts:1258-1300). Root cause (verified in the
cargo registry sources of the exact pinned versions):

- tauri-utils-2.9.3/src/config.rs:2301 — `drag_drop_enabled: true` is the DEFAULT;
  doc comment: "Disabling it is required to use HTML5 drag and drop on the frontend".
- tauri-runtime-2.11.3/src/webview.rs:477 — `if !config.drag_drop_enabled { builder.disable_drag_drop_handler() }`.
- tauri-runtime-wry-2.11.4/src/lib.rs:4862-4889 — when enabled, installs wry
  `with_drag_drop_handler` that returns `true` (consumed) for every drag event.
- wry-0.55.1/src/wkwebview/class/wry_web_view.rs:80-106 — WryWebView implements
  NSDraggingDestination (draggingEntered/Updated/performDragOperation/Exited)
  unconditionally; wry-0.55.1/src/wkwebview/drag_drop.rs:38-43 shows that when the
  handler returns true the `super` (WebKit's own drag-destination handling, which
  drives HTML5 DnD) is NEVER invoked — in-page DOM drags are consumed as file drops.

Fix: `"dragDropEnabled": false` in src-tauri/tauri.conf.json app.windows[0]. Cost:
OS file drops into the window are disabled — the app accepts no file drops today
(no DragDrop handlers in src-tauri/src). Belt-and-braces: call
`e.dataTransfer.setData('text/plain', ...)` in candidateDragStart (WebKit/Firefox
drag-start requirement). Regression test: tauri.conf.json keeps dragDropEnabled false.
Window config otherwise checked: csp null (permissive), no other interaction-blocking
options.

## Bug 2 — streams die mid-stream through the HTTPS bridge

Parent's live measurements (2026-11-23): a 200.4s stream completed; no total-duration
cap; deaths correlate with idle gaps (Cloudflare ~100s read timeout) during tool-run
/ silent-reasoning pauses.

Streaming audit findings:
- /v1/chat/completions relay (sendSuccessfulProxyResponse, index.ts:8139-8275):
  Readable.fromWeb → createStreamErrorObserver → createOpenAIReasoningStripTransform
  (→ createUsageSpyStream) → res. All transforms are line-buffered pass-throughs
  (callback(null, chunk)); no body buffering anywhere in the chain.
- No compression middleware (helmet is headers-only, CSP off); compression was
  deliberately decoupled from the core. express.json() is request-side only.
- Headers: text/event-stream + no-cache + Connection: keep-alive; chunked transfer
  implicit. Missing X-Accel-Buffering: no (added). Node disables Nagle already.
- Missing entirely: any keepalive during upstream silence. Router's own idle
  watchdog (STREAM_IDLE_TIMEOUT_MS=120s) outlasts Cloudflare's ~100s, so the
  tunnel kills connections the router considers healthy. THIS is the failure.

Implementation (src/sse-keepalive.ts):
- `attachSseKeepalive(res, intervalMs)` (default LOCAL_ROUTER_SSE_KEEPALIVE_MS or
  15000ms): wraps res.write to track last-write time and an SSE event-boundary
  state machine (blank line ⇒ boundary); on a timer, when silent ≥ interval AND at
  an event boundary, writes `: ping\n\n` (legal SSE comment — clients ignore it,
  no tokens). Never interleaves into an active event: mid-frame silence skips until
  the frame completes. Injections count as activity (pings spaced by interval).
  Idempotent per response (symbol marker); stops on close/finish. Only for
  text/event-stream outputs — NDJSON (ollama) outputs are untouched (comment lines
  would break JSON-per-line parsers).
- Attach points: sendSuccessfulProxyResponse stream branch (OpenAI passthrough),
  /v1/messages stream branch, /v1/responses stream branch. Translator fake-res
  objects (Anthropic Writable, createResponsesFakeResponse) are marked non-terminal
  so keepalive never feeds translator input.
- Bonus (per parent): non-stream responses cannot carry keepalives — an upstream
  that stalls >100s before first JSON byte still dies at the tunnel; documented in
  the PR (router has its own NON_STREAM_TIMEOUT_MS=120s guard).

Tests:
- tests/sse-keepalive.test.mjs (unit): silence ⇒ `: ping\n\n` on the wire; active
  stream ⇒ byte-identical pass-through; mid-frame (non-boundary) silence ⇒ no
  injection; ping cadence; disposal.
- tests/sse-keepalive-stream.integration.test.mjs: spawned router (build/index.js,
  scrubbed env, random port) + mock upstream that sends a chunk then goes silent
  past the interval: client sees keepalive comments then the rest of the stream;
  normal fast streams arrive unmodified.
- tests/tauri-dnd-config.test.mjs: dragDropEnabled stays false.

## Verification

npm install; node --test <explicit new + related test files>; tsc clean; cargo check
clean (src-tauri). Optional: run built router on an alternate port with a slow mock
upstream and curl a stream to observe keepalive bytes (never :11434, never the tunnel).

## Delivery

Conventional Commits, operator sole author (hooks), push fix/app-dnd-and-streaming,
PR to main. Close: task record + COMMS + memory in .agents/.
