# TASK 2026-08-20 — /config pages no-store

## Read
- User: browser stuck "Loading catalog...".
- Server endpoints all 200 fast.
- No Cache-Control on /config HTML.
- Browser heuristically cached stale page.

####

## Draft
- stale cache served broken page.
- XHR endpoints healthy server-side.
- fix: no-store on config pages.
- prevents stale HTML after restarts.

####

## Execute
- setHeader no-store ×6 pages.
- redirect handler covered too.

## Verify
- curl -I shows Cache-Control.
- tsc build clean.
- tests pass.

## Audit
- No security regression.
- Public API endpoints untouched.
