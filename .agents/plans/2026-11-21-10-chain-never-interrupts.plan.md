---
plan_format: ainish/plan/v1
slug: chain-never-interrupts
date: 2026-11-21
status: ready
branch: fix/chain-never-interrupts
worktree: /Volumes/1tb-sandisk/code-external/local-router-worktrees/fix-chain
task_record: .agents/tasks/TASK.2026-11-21-10-chain-never-interrupts.md
operator: question-me
---

# Plan: Make `local-router/fallback-models` never interrupt an agent

## 1. Problem

The operator wants to point a single agent harness (Claude or Codex) at
`local-router/fallback-models` and have it never interrupted, no matter which provider or model
fails — with local-router as the single configuration resource and sole holder of key material.
Today the chain can terminate without answering, and most of its steps have never been proven to
work.

## 2. Anchor Facts

Measured on this host on 2026-11-21 unless stated otherwise.

- **The updated Cline key is live.** `secrets.bundle.json` was written 10:19:57 local; the router
  resynced at 15:21:30Z, `bundleDrift: null`, and `cline` is in `loadedProviders`. A real
  `cline/deepseek/deepseek-v4-pro` call returned `CLINE_OK` with gateway cost metadata. —
  `/api/pqc/status` and a live call. No restart was needed.
- **Saving a new key does NOT clear an existing auth quarantine.** `POST /api/keys` sets the key
  and persists the bundle, then runs discovery; it never touches `healthRegistry`. `key_rejected`
  is an `IMMEDIATE_QUARANTINE_CLASS` with a 30-minute cooldown
  (`src/health-registry.ts:100`, `:13`). So an operator who fixes a bad key can still watch that
  provider be skipped for up to 30 minutes, and a chain whose other members are also down would
  fail with the corrected key sitting unused.
- **Only 3 of the configured chain members have ever answered.** Over 120 recorded trajectories on
  `fallback-models`: `kilo-baidu-ernie-5.5-flash-preview-free-paid` (72 answers),
  `xiaomi-mimo-mimo-v2.6-pro` (44), `openrouter-ling-3.2-flash-free` (4 answers against 31 failures
  and 47 skips, flagged `usage_limit`). Twenty members show `ans=0 fail=0 skip=0` — never reached,
  never verified. — `/api/trajectories/health`.
- **`github-copilot-auto` and `cursor-auto` are skipped on every single request** with
  `context_window_too_small` (52 skips each), because agent sessions routinely need 150k-160k
  context and those rows cannot express it. They are configured steps that cannot ever serve an
  agent turn. — trajectory `excludedTargets`.
- **The chain has a terminal path that makes no attempt at all.** `executeFallbackRoute` returns
  HTTP 502 when `eligible.length === 0` (`src/index.ts:9129`), and I hit exactly this during the
  previous session's audit. A mis-filtered request therefore fails without trying anything.
- **A terminal exhaustion returns the last status** (`src/index.ts:9484`), which for a
  401-shaped failure is a 401 to the agent — indistinguishable from "your local-router key is
  wrong" even though the router holds all keys and the agent's key is the placeholder.
- **Quarantined members do get a last-pass force-try** (`src/index.ts:9378`,
  `last-pass-N` stages) — the "a stale answer beats a 502" tail. That mechanism exists and works.
- **A 404 on a model is not auth.** `cline/deepseek/deepseek-v4-flash-free` answers
  `Provider error (404)` — the model id does not exist at that provider. That is a stale chain
  entry, not a key problem, and it had been booked as `key_rejected` earlier, which is how a
  healthy provider got quarantined for a catalog mistake.

## 3. Plan

### Goals

- Saving or resyncing a key clears that provider's auth/quota quarantine immediately, so a fixed
  key is used on the very next request.
- Every configured chain member is proven reachable, or is removed/marked so the chain never
  advertises a step that cannot serve.
- A chain that cannot answer returns a status that tells the agent the truth (the router failed, not
  the agent's credentials) and names what was tried.
- `local-router/fallback-models` answers every request an agent can make, including very large
  contexts, by having at least one member that fits the largest realistic window.

### Non-goals

- Reordering the operator's chain preferences beyond removing dead steps.
- Adding new providers.
- Changing which model is preferred when several work.

### Constraints and invariants

- Key material never leaves the vault; probes use the router's own key resolution and never print a
  key.
- A probe costs real money on paid steps, so each is one tiny request with a low output cap.
- Never auto-delete a chain step: record it and let the operator decide, except where a step is
  provably incapable (context filter) — those get a recorded flag, not silent removal.

### Proposed architecture

```
POST /api/keys  ─┬─> setProviderKeyForEnvVar
                 ├─> persistPqcSecrets
                 └─> healthRegistry.clearProvider(provider)   <-- NEW
POST /api/pqc/resync ─> healthRegistry.clearAll()              <-- NEW

chain exhaustion ─> status 503 + errorType 'chain_exhausted'   <-- was: last upstream status
                └─> body lists every stage tried with its reason
```

### Interfaces and data

- `src/health-registry.ts` — `clearProvider(provider)` and `clearAll()`; clears cooldown, failing
  counters, and permanent inference flags for keys matching `::<provider>`.
- `src/routes/config-api.ts` — call them on key save and on PQC resync.
- `src/index.ts` — terminal exhaustion responds 503 with `chain_exhausted` and a `tried[]` detail.
- A verification script under `scripts/` that probes every chain member once and prints a table.

## 4. Verification

- Save a deliberately bad key, confirm the member quarantines, save a good key, confirm the very
  next request uses it (no 30-minute wait).
- Probe all chain members; every step is either answering or recorded as failed with a reason.
- Confirm an agent request with a large context is served rather than rejected on capability.
- Confirm exhaustion produces 503 `chain_exhausted`, not a borrowed 401.

## 5. Todos

- [ ] T1  Clear a provider's quarantine when its key is saved or the bundle resyncs.
- [ ] T2  Probe every chain member and record which actually answer.
- [ ] T3  Return an honest `chain_exhausted` status instead of the last upstream status.
- [ ] T4  Ensure at least one member can serve the largest realistic agent context.
- [ ] T5  Tests + live verification, then merge and journal.

## 6. Threats

Worst realistic outcome: clearing quarantine on key save wipes legitimate health history and a
provider that is genuinely broken gets retried on every key save. Mitigated by clearing only that
provider's cooldown, keeping the success/failure history, and keeping the force-try tail so a
cleared-but-still-broken member cannot loop.

## 7. History

- 2026-11-21T10:40Z — plan written from a live audit of chain reachability, key-save behaviour, and
  terminal error paths.
