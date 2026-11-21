# TASK.2026-11-20-23 — Unattended durability: survive days of operation

- **status:** done
- **plan:** `.agents/plans/2026-11-20-23-unattended-durability.plan.md`
- **branch:** `fix/unattended-durability` → merged into `main` as `d034b75`
- **worktree:** `/Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-unattended` (removed)
- **trigger:** operator asked that leaving a terminal open for minutes, hours, or days never interrupt
  agentic tooling, and that the router be reliable enough to *power* agent runs continuously.

## What was wrong

Four defects, each only visible after a long uptime, each reproduced rather than reasoned about.

1. **No crash handlers at all.** `grep 'process.on('` found no `uncaughtException` or
   `unhandledRejection` handler. Verified on Node 22 with a control pair: an unguarded child dies on a
   stray rejection; a guarded one survives and records it. Any single rejected promise in any request
   path took down the router and every in-flight agent with it.
2. **No graceful shutdown.** No SIGTERM/SIGINT/SIGHUP handler existed. A restart cut streams mid-body.
   Measured: `curl` reported `transfer closed with outstanding read data remaining`.
3. **The watchdog could not supervise.** The LaunchAgent ran `ensure`, which is a **one-shot**: it
   confirms the router is up and exits 0. `launchctl print` after `kill -9` showed
   `state = not running, runs = 1, last exit code = 0` and the router **stayed dead** — `KeepAlive`
   had no process to keep alive. The only recovery was the `StartInterval` tick; the installed plist
   had it at 120 s, so a crash meant up to two minutes of downtime.
4. **No log rotation anywhere.** `grep` for truncate/rotate found nothing. On this host
   `ollama-backend-11435.log` was 13.2 MB, `launchd.log` 5.0 MB, both append-only forever.

Confirmed already sound, and left alone: `detached: true` + `unref()` (terminal close does not kill the
daemon), OAuth refresh (deduped through a shared in-flight promise, bounded — important because Google
rotates refresh tokens), catalog auto-refresh (per-provider try/catch, unref'd timers), trajectory
compaction (2000 records) and expert-log capping (1000 entries).

## What changed

- **`src/durability.ts`** (new) — `DurabilityMonitor` (bounded incident list with repeat counts,
  in-flight and peak-in-flight accounting, credential-shaped text redacted from messages),
  `installCrashGuards` (survive and record; still fatal before boot completes),
  `installShutdown` (drain, flush, exit 0; a second signal exits at once), `trackInFlight` middleware.
- **`src/log-rotation.ts`** (new) — copy-then-truncate rotation, 10 MB × 5 generations. Truncate-in-place
  preserves the inode a launchd stdout fd holds; a rename would silently orphan that descriptor and the
  log would stop growing where the operator looks.
- **`src/index.ts`** — guards installed before anything that can fail; in-flight middleware first;
  shutdown wired at listen with a 10-minute grace; hourly rotation plus one pass at boot.
- **`src/routes/config-api.ts`** — `GET /api/health`: uptime, in-flight/peak, incidents with repeats,
  quarantine count, real state paths, effective limits. `/api/version` untouched (static probe).
- **`bin/local-router.js`** — new `supervise` command. Default writes and reloads the LaunchAgent;
  `supervise --run` is the long-lived loop the plist invokes: probes `/api/version` every 5 s,
  re-ensures after 3 consecutive failures. Plist now uses `KeepAlive{Crashed:true,
  SuccessfulExit:false}`, `ThrottleInterval 15`, `StartInterval 600`. Launcher rotates logs before
  opening the append fd.

## Verification

- **Crash recovery, production**: `kill -9` the live router on `:11434` → **recovered in 16 s**
  (new pid, `/api/health` back to `serving`). Previously up to 120 s, and in practice never without a
  manual start.
- **Crash survival, unit**: guarded child survives a stray rejection and records `unhandledRejection`;
  unguarded control child still dies. Pre-boot failure still exits 1.
- **Graceful drain, production**: SIGTERM mid-stream → client received a complete frame sequence,
  `curl exit 0`, server exited 0. A request longer than the old 15 s grace confirmed why the default
  is now 10 minutes.
- **Soak**: 40 sequential requests → 0 incidents, fds 26 → 28, in-flight back to 0, no counter leak.
- **Both wires still healthy after all of it**: Claude stream valid (1 start / 2 open / 2 close /
  1 delta / 1 stop, `end_turn`); Codex non-stream `completed` with 89 in / 26 out.
- **Suite**: 437 / 451 pass, 12 skipped, 2 fail (`detectLocalCursorSession`, live wafer probe) — both
  fail on `main` before this branch, verified directly.

## Deliberately not done

- **Windows Scheduled Task was not re-verified on this host.** `supervise` states plainly that Windows
  has no launchd equivalent and points at `route set`. Untested change beats a false claim.
- **The 10-minute drain grace is a judgement call.** It bounds a wedged request without making the
  process unkillable, but a generation longer than 10 minutes would still be cut on SIGTERM. Tunable
  via `LOCAL_ROUTER_SHUTDOWN_GRACE_MS`.
- **`launchd.err` history (1.2 MB, last written Nov 9) was not investigated.** The exact `ensure`
  command succeeds today; the historical failures are a different era's entrypoint, not today's defect.

## First failure to expect if this is wrong

The supervisor's `ensureRunning` calls `cmdEnsure` with `noEvict: true`. If a foreign process is
holding 11434, the supervisor will log an ensure failure every three probes rather than evicting it —
correct (it must not fight an operator's server) but it means a permanently squatted port shows as
repeated supervisor noise rather than a single clear error.

## Threat model

Asset: continuous availability of the operator's gateway, and the integrity of what it reports about
itself. Adversary: a fault in any request path, or an operator action (restart, terminal close, reboot).
Worst realistic outcome: a crash handler masks corrupt state and the router serves wrong answers
instead of restarting. Mitigated by recording every incident with a reason and repeat count, exposing
them on `/api/health`, and keeping pre-boot failures fatal — so a process that never became healthy
still restarts. No secrets touched; the redaction test proves a `Bearer`-shaped value cannot land in the
incident log. Authority exercised: writes inside this repo, plus one LaunchAgent registration for the
operator's own router (old plist backed up to `com.localrouter.daemon.plist.bak-pre-durability-*`).
