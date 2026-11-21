---
plan_format: ainish/plan/v1
slug: unattended-durability
date: 2026-11-20
status: done
branch: fix/unattended-durability
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-unattended
task_record: .agents/tasks/2026-11-20-23-unattended-durability.md
operator: question-me
---

# Plan: Make the router survive days of unattended operation

## 1. Problem

The operator wants local-router to be the always-available power source for agentic tooling: leaving
a terminal open for minutes, hours, or days must never interrupt a working agent, and the router
must still be answering at the end of that window. Today several things degrade or stop over a long
window, and the failure is silent.

## 2. Anchor Facts

Each was established by inspection or reproduction on this host on 2026-11-20.

- **Zero process-level crash handlers.** `grep 'process.on('` on `src/index.ts` returns nothing for
  `uncaughtException` / `unhandledRejection`. Verified that Node 22 exits on both, and that
  installing the two handlers keeps the process alive. — `node crashprobe.mjs`.
- **No graceful shutdown.** No `SIGTERM` / `SIGINT` / `SIGHUP` handler exists in `src/index.ts` or
  `bin/local-router.js`. A restart drops in-flight streams with no drain.
- **No log rotation anywhere.** `proxy-11434.log` is 0.86 MB and only grows; `launchd.log` is 5.0 MB;
  `ollama-backend-11435.log` is 13.2 MB. `grep` for truncate/rotate/log-size finds nothing.
  The watchdog writes a line every 120 s, so the watchdog log alone grows ~3.5 MB/day.
- **The watchdog is a 120 s poll, not a supervisor.** `com.localrouter.daemon.plist` uses
  `StartInterval=120` with `KeepAlive={SuccessfulExit:false}`. A crashed router is therefore down for
  up to two minutes — long enough for an agent turn to fail.
- **`launchd.err` has a long history of `ensure` failures** (1.2 MB, last written Nov 9). The exact
  command now succeeds when run by hand, so the current entrypoint works; the historical failures are
  not today's fault. The 120 s gap remains the real supervision defect.
- **Detached spawn is correct.** `cmdStart` uses `detached: true` + `child.unref()` with stdio to a
  file, so closing the terminal does not kill the daemon. — `bin/local-router.js:367`.
- **Several intervals are unref'd but not all are.** `setInterval` count in `src/index.ts` is 4;
  only one `unref` is adjacent. `startCatalogAutoRefresh` and the backend probe do unref; the new idle
  watchdog and the ollama poll need checking.
- **Catalog auto-refresh is already failure-tolerant** (per-provider try/catch, unref'd timers).
- **OAuth refresh is already well-built**: concurrent refreshes are deduped through a shared
  in-flight promise and bounded by a timeout, which matters because Google rotates refresh tokens.
- **State files are bounded in the important places**: trajectories compact at 2000 records,
  expert logs cap at 1000 entries. `sessions.json` is tiny (279 B) and not a growth risk.
- **`/api/version` is a real endpoint and `HEAD /api/version` answers 200**, so there is a working
  health probe a supervisor can use.

## 3. Plan

### Goals

- An unhandled rejection or sync throw anywhere in a request path is logged and **does not stop the
  router**.
- A restart (manual or by the watchdog) drains in-flight requests for a bounded time before exiting.
- A crashed router is restarted in seconds, not up to two minutes.
- Logs cannot grow without bound over weeks.
- The operator can tell, in one command, whether the router is healthy, how long it has been up, and
  what it has survived.

### Non-goals

- Changing the fallback chain or provider selection (operator decisions).
- Adding a metrics stack or an external scraper.
- Fixing the Nov 9 historical `launchd.err` entries; they are not reproducible today.

### Constraints and invariants

- A crash handler must **not** swallow a failure silently: it logs, records, and keeps serving. A
  process that keeps answering while its state is corrupt is worse than one that stops.
- Log rotation must never delete the file a supervisor is writing to (rotate by copy+truncate, not
  rename-and-recreate, so the open file descriptor keeps working).
- Nothing irreversible: rotation keeps a configurable number of compressed generations.
- No secrets in logs; existing redaction stays authoritative.

### Proposed architecture

```
process
  ├── uncaughtException   -> log + record + keep serving (fatal only if boot)
  ├── unhandledRejection  -> log + record + keep serving
  └── SIGTERM/SIGINT      -> stop accepting, drain in-flight (bounded), exit 0

supervisor (launchd)
  └── KeepAlive { SuccessfulExit: false, Crashed: true } + 15 s throttle
      (replaces StartInterval 120 as the crash-recovery mechanism)

logs
  └── boot + hourly rotation: copy to .1, truncate in place, keep N generations
```

### Interfaces and data

- `src/index.ts` — process-level handlers installed before `app.listen`, plus a shutdown routine.
- `src/index.ts` — a small `inflight` counter exposed so shutdown can wait, and so `/api/health` can
  report it.
- New `GET /api/health` — uptime, in-flight count, last crash time and reason, member/quarantine
  summary, config paths. Distinct from `/api/version` so existing probes are untouched.
- `bin/local-router.js` — plist template: `KeepAlive` becomes `{ SuccessfulExit: false, Crashed: true }`
  with `ThrottleInterval` 15, and `StartInterval` is dropped or raised to a long drift-correction tick.
- `bin/local-router.js` — log rotation before opening the append fd, and a rotation helper the server
  also calls on a timer.

## 4. Verification

- Unit: handlers keep the process alive; shutdown drains and exits 0; rotation keeps N files and the
  open fd keeps writing.
- Live: kill -TERM during a stream, confirm the client gets a complete frame sequence and the process
  exits 0.
- Live: `kill -9` the router with the watchdog loaded, confirm it is back within ~15 s.
- Live: `/api/health` reports uptime and in-flight count truthfully.
- Soak: a loop of requests for several minutes with the idle watchdog armed, confirming no leak in
  heap or fd count.

## 5. Todos

- [x] T1  Install `uncaughtException` / `unhandledRejection` handlers that log, record, and survive.
- [x] T2  Add graceful shutdown on SIGTERM/SIGINT that drains in-flight work.
- [x] T3  Tighten the launchd supervisor: `KeepAlive.Crashed` + `ThrottleInterval` ~15 s.
- [x] T4  Add bounded log rotation for the proxy, launchd, and backend logs.
- [x] T5  Add `GET /api/health` with uptime, in-flight, last crash, and state paths.
- [x] T6  Tests + live verification (SIGTERM drain, kill -9 recovery, soak), then merge and journal.

## 6. Threats

The worst realistic outcome: a crash handler masks a corrupt-state condition and the router serves
wrong answers instead of restarting. Mitigated by recording every caught event with a timestamp and
reason, exposing it on `/api/health`, and counting repeats so a flapping condition is visible. The
watchdog change's worst outcome is a restart loop; `ThrottleInterval` bounds it to one attempt per 15 s
and `launchd` stops respawning after repeated failures.

## 7. History

- 2026-11-20T23:30Z — plan written from an audit of crash handlers, supervision, log growth, timers,
  OAuth refresh, state-file bounds, and the health surface.
