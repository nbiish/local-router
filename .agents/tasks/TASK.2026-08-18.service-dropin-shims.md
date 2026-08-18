# TASK: Multi-Service Drop-in Shims (ollama + llama-server + unsloth)

## CoD Draft
- route set installs 3 shims
- ollama: keep dedicated shim
- llama-server: always intercept
- unsloth: serve/server gated
- Self-register loopback providers
- No-key loopback refresh probe
- Escape hatch env var
####

## Goal
Anything that starts `ollama`, `llama-server`, or `unsloth` as a service ends up with Local Router running on `11434` (full preferred + provider catalog). Non-serve invocations pass through to the real binaries and hit Local Router on its port. llama.cpp and Unsloth backends become selectable providers via custom-provider self-registration.

## Changes

### `bin/local-router.js`
- `SERVICE_TARGETS` registry: `ollama` (dedicated renderer, keeps legacy `# local-router ollama shim` marker that `src/ollama-backend.ts` `resolveRealOllamaBinary()` scans for), `llama-server` (every invocation = service start; registers `llama-cpp` provider → `http://127.0.0.1:8080/v1`, `LLAMA_CPP_API_KEY`), `unsloth` (`serve`/`server` gated; registers `unsloth` provider → port 8000, `UNSLOTH_API_KEY`). Missing binaries are skipped with a note (re-run `route set` after install).
- `resolveRealServiceBinary()`: PATH walk that skips marker shims, resolves a symlink at the shim path to its target (miniforge `llama-server` case), falls back to later PATH entries.
- `renderServiceShim()` + `pushProviderRegistration()`: generic bash shim — ensures router is up (`local-router start`), parses `--port`/`--port=` from args, background subshell does POST-then-PUT `/api/providers` + `/api/refresh-endpoint-models` (sleep 3 / sleep 12, best-effort), then `exec`s the real binary. Escape hatch `LOCAL_ROUTER_NO_SHIM=1` execs the real binary directly (added to the ollama shim too).
- `installShim()`: refuses to clobber foreign regular files; replaces own marker shims and symlinks at the shim path (unlink only — link target survives).
- `cmdRouteSet('services')`: iterates all targets, records `{command, shimPath, realPath}[]` in `tool-routing.json`; `cmdRouteUnset` removes marker shims only; `route status` / `status` list per-service state.

### `src/index.ts`
- `isLocalLoopbackProvider()`: custom provider with `http:` loopback endpoint → `providerHasConfiguredKey` returns true (no auth on local services).
- `fetchLiveProviderModels()`: probes `/models` without an Authorization header for keyless loopback providers so `POST /api/refresh-endpoint-models` ports their models.

## Files Modified
- `bin/local-router.js`
- `src/index.ts`
- `llms.txt` (service shim contract, capabilities bullet, settings map, CLI cheat sheet)

## Verification
- `npm run build` clean; `npm run validate:model-specs` PASSED (1 pre-existing warning); `npm test` 83/83 (+2 new ssrf tests after the guard change, below).
- Sandbox smoke (HOME=/tmp/lr-smoke, fake `ollama` + symlinked `llama-server` replicating the miniforge layout, real router paused so the sandbox router owned 11434):
  - `route set`: ollama + llama-server shims installed (symlink replaced, real target recorded), unsloth skipped with note.
  - `llama-server --port 8180` via shim: router started on 11434, `llama-cpp` provider registered/updated (endpoint honored `--port`), refresh ported `llama-fake-7b/13b` into the endpoint cache, curation API listed them, and under `source=endpoints` both `/v1/models` and `/api/tags` served them alongside all `local-router/*` preset routes.
  - `ollama serve` via shim: fake backend on 11435 + router on 11434; `ollama list` passthrough returned the 13-tag router catalog.
  - `LOCAL_ROUTER_NO_SHIM=1` bypasses both shims (direct exec verified via fake-binary logs).
  - `route status` lists per-service state; `route unset` removed both marker shims.
- Fix discovered during smoke: `src/ssrf-guard.ts` blocked loopback HTTP outside dev mode — now loopback-HTTP URLs (literal 127.0.0.1/::1/localhost, incl. bracket-normalized IPv6) are always allowed; non-loopback HTTP unchanged (dev-only). +2 unit tests.
- Live: `local-router route set`, restart via `ollama serve`, verify catalog + provider registration + backend discovery still finds real ollama (marker intact).
