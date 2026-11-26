# Suggestion: `/api/update-status` reports the checkout, not the running code

- date: 2026-11-26
- status: open
- found during: v1.2.1 release verification (`.agents/tasks/2026-11-26-17-release-promotion-chain.md`)

`GET /api/update-status` returns `currentCommit` from the checkout's git HEAD. The server actually
loads `build/index.js` at boot, so after a `git pull` without a rebuild and restart the endpoint
claims the service is current while it serves code a day old — which is exactly what happened on
macOS between 2026-11-25 12:57Z and 2026-11-26 14:31Z (the live process predated five pulls and a
rebuild). The web UI's "Check for updates" control inherits the misleading answer.

Suggested resolution: record a build stamp at boot — the hash or mtime of `build/index.js`, or a
value emitted by `tsc` — and return it beside `currentCommit`, plus a `restartRequired` flag when
the loaded build differs from the checkout's HEAD. Then the UI can say "rebuild and restart needed"
instead of "Source up to date".
