# Task — `ainish-rag` driver order vs `local-router/fallback-models` (they are different orders)

- **Branch:** `main` (coordination carve-out: `.agents/{comms,tasks,memories,suggestions}`)
- **Worktree:** `D:/Code/local-router`
- **Lane:** later
- **Status:** new
- **Opened from:** `ainish-coder` chat, 2026-11-06 (Phase 0/4a context,
  `D:/Code/ainish-coder/docs/rag-context-system-plan.md`)
- compat: Documentation-first. Any future code change here is additive; no app interface, schema,
  flag, or dependency change is proposed by this task.
- concurrency: shared-state writes are appends to dated files.
- budget: no model, retrieval, or CI spend. Verification is read-only `curl`.

## The distinction this task exists to protect

`ainish-rag`'s fallback ladder and `local-router/fallback-models` are **two different orders** that
happen to share a word. Conflating them is the specific error this file corrects — an earlier draft
of this task asserted the router "needs no change" on the strength of tier-1 router aliases, which
told us nothing about the two tiers below it.

| | `ainish-rag` driver order | `local-router/fallback-models` |
|---|---|---|
| **What it is** | A 4-tier ladder owned by `ainish-rag` | A generic chain owned by the router |
| **Who consumes it** | `ainish-rag` only (Elephant/Goldfish, summaries, critiques) | VS Code, Claude Code, Cline, scripts, anything talking to the router |
| **How it is expressed** | Explicit per-tier model ids + endpoints in `ainish-rag` code | A model list inside `router-settings.json` |
| **Tiers** | 1 router → 2 OpenRouter direct → 3 ZenMux direct → 4 local | N ordered steps, all resolved *inside* the router |
| **Current state** | **Not implemented** — no `chat/completions` call in either engine | **Configured but EMPTY** (see below) |

### The four driver tiers, precisely

1. **local-router** — `http://127.0.0.1:11434/v1/chat/completions`, preferring the OpenRouter-backed
   variant of the driver model via the router's own alias.
2. **OpenRouter direct** — `https://openrouter.ai/api/v1`, authenticated with its own key. **Does not
   pass through the router.**
3. **ZenMux direct** — `https://zenmux.ai/api/v1`, authenticated with its own key. **Does not pass
   through the router.**
4. **local model** — llama.cpp / Unsloth on this machine (`mxfp4_moe` Lightning).

Tiers 2 and 3 are **direct provider calls**. They must not be issued as router aliases, or the call
silently goes back through tier 1 and the fallback separation disappears.

## Finding: `fallback-models` is currently empty

Measured on 2026-11-06:

```json
{
  "fallbackModelsText": "",
  "routes": [
    { "id": "fallback-models", "models": [] }
  ]
}
```

`~/.config/local-router/router-settings.json` defines the route but populates it with **zero
models**. `docs/driver-models.md` describes a "20 steps, headed by `zai-glm-5.3-flashx`" chain; that
description no longer matches the file on disk. Two consequences:

- Any client relying on `local-router/fallback-models` as its generic chain currently falls through
  to the router's `routed=auto` behaviour with no curated order behind it.
- The doc is stale, which is how a reader would also mis-learn the driver order. Fixing the doc is
  in scope here; repopulating the chain is an operator decision and **not** this task.

This is **not** a blocker for the driver ladder, and the driver ladder must not be implemented by
populating it. Repointing the shared chain to suit one tool would change model behaviour for every
other consumer.

## What the router does already handle (verified live, 2026-11-06)

Tier 1 works today, so this repo is not in the critical path for Phase 4a:

| Check | Result |
|---|---|
| `/api/decisions/status` order | `["openrouter","zenmux"]`, both `key_configured: true` |
| Tier-1 OpenRouter alias `openrouter-deepseek-v4.1-flash-1017` | routed to `deepseek/deepseek-v4.1-flash-1017`, `DRIVER_OK` |
| Tier-1 ZenMux alias `zenmux-deepseek-v4.1-flash` | routed to `deepseek/deepseek-v4.1-flash`, `DRIVER_OK` |
| Tier-4 id advertised in `/v1/models` | `unsloth-nvidia-nemotron-3.5-lightning-30b-a3b-gguf-mxfp4_moe` present among 76 |
| Tier-4 backends serving | **down** — ports 8888 and 8080 both closed (expected) |
| Tier-2/3 direct hosts reachable | `openrouter.ai` 200, `zenmux.ai` 200 |
| Tier-2/3 keys present in the PQC store | `OPENROUTER_API_KEY`, `ZENMUX_API_KEY` (plus `LOCALROUTER_*` variants) |

Both direct tiers are therefore viable without touching the router.

## Work items

### 1. Correct `docs/driver-models.md` so the two orders cannot be confused (this repo)

The doc already has a "Two separate fallback orders" section, but it describes the shared chain as a
populated 20-step list and does not say plainly that **tiers 2 and 3 are direct, not router
aliases**. Add:

- an explicit statement that tiers 2 and 3 bypass the router and carry their own base URL and key;
- a warning that the router alias ids (`openrouter-*`, `zenmux-*`) are **tier-1-only** and must not
  be reused as tier-2/3 ids, because that would route back through tier 1;
- a correction to the `fallback-models` description, which currently claims 20 steps headed by
  `zai-glm-5.3-flashx` while the file holds an empty list.

### 2. Resolve the 18 uncommitted paths (blocking any work here)

A rules refresh appears to be uncommitted: `.agents/ainish-deploy.json` + `.sig` re-stamped to
`fab34e1`, `.agents/skills/.ainish-source` modified, `production-security` pack **deleted**,
`typesafe-jev/*` updated, `AGENTS.md` 342 lines changed, and four skill directories untracked.
Commit it as a rules sync with the retired pack called out, or discard and re-deploy. Do not leave it
dirty.

### 3. Deploy manifest records host-specific absolute paths (defect, owned by `ainish-coder`)

```
- "source_repo": "/d/Code/ainish-coder",      # written from Windows Git Bash
+ "source_repo": "/mnt/d/Code/ainish-coder",  # written from WSL
```

Every deploy from the other host dirties every target's manifest **and invalidates its signature**,
so a clean tree is impossible in a mixed Windows/WSL/macOS/Linux fleet. Same bug class as
`.ainish-source` (fixed in `ainish-coder` at `01e120a` by translating at read time), but here the
churn lands in a **signed** artifact. Fix belongs to the writer in `ainish-coder`; a reader accepting
all three forms during the window keeps existing targets working.

### 4. Baseline this repo for Phase 0 (blocked on item 2)

The driver ladder is `ainish-rag`'s, so this repo's only Phase 0 obligation is being the second
corpus:

```
ainish-rag bench --save-baseline
```

Must run on a host that resolves the embedding key — the Windows PQC store is empty while the WSL
store holds the keys. Requires the same targeted `.gitignore` exception used in `ainish-coder`
(`.agents/rag/*` plus `!.agents/rag/bench-baseline.json`).

## Verification

```bash
# tier 1 only: router aliases
curl -s http://127.0.0.1:11434/api/decisions/status | python3 -m json.tool
curl -s http://127.0.0.1:11434/v1/models | grep -E 'deepseek-v4.1-flash|mxfp4_moe'
curl -s http://127.0.0.1:11434/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"openrouter-deepseek-v4.1-flash-1017","messages":[{"role":"user","content":"Reply exactly: DRIVER_OK"}],"max_tokens":512,"temperature":0}'

# tiers 2 and 3 are DIRECT: their own host, their own key. Never the router.
curl -s -o /dev/null -w '%{http_code}\n' https://openrouter.ai/api/v1/models
curl -s -o /dev/null -w '%{http_code}\n' https://zenmux.ai/api/v1/models
```

`max_tokens` must stay ≥512 — the driver model is a reasoning model and returns empty content with a
small budget, which reads like a transport failure but is not.

## Note on operator key entry: not required

An earlier assumption that keys would need to be typed into local-router was wrong. The 13 keys
already exist in the WSL PQC store and are now discovered from both Windows and WSL after the
`pqc_secrets.py` encoding fix in `ainish-coder` (`fd9a3f2`). The reason the two tools appeared to
disagree is that the router has its own discovery (`getPqcConfigDirCandidates`), which scans both
`~/config` and `~/.config` and, under WSL, also Windows user dirs; the CLI's discovery was failing
for a different reason (UTF-16 vs UTF-8 decode of `wsl.exe` output). Both now agree.

If a *new* provider key is ever needed, add it to the store the fleet treats as canonical (currently
the WSL store, reached over interop) rather than to a per-host store.

## Risks / follow-ups

- An empty `fallback-models` chain is a live configuration state affecting other clients. Out of
  scope here, but it should not stay empty silently and should not be filled in to serve `ainish-rag`.
- Tier 4 being offline means the local-then-remote degradation path is untested until a local backend
  runs; tiers 1–3 carry all traffic today.
