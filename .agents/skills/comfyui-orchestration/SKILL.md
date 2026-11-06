---
name: comfyui-orchestration
description: >
  Operate the LOCAL ComfyUI install on this machine agentically — the Windows
  Comfy Desktop instance at D:\Comfy-Desktop\ComfyUI-Installs\yesy\ComfyUI
  (ComfyUI 0.44.0, ROCm torch, 251 GB shared model store, live on
  http://127.0.0.1:8188) — through two surfaces: comfy-cli 1.19+ JSON-envelope
  commands and the comfy-mcp MCP server (39 tools). Covers host topology and
  why the WSL stub is a trap, workspace/model-path resolution, the
  launch/stop/restart/update lifecycle, node and model install, workflow
  validation and slot edits, job submit/watch/cancel, VRAM gating, and the
  exact environment repairs (httpx/cffi/sniffio, COMFY_BIN) required for the
  MCP server to start. Use when driving, debugging, or wiring up ComfyUI on
  this system, when comfy or comfy-mcp fails to start, or when an agent needs
  to submit and collect a generation locally.
---

# ComfyUI Orchestration — this machine

Everything here describes the install that actually exists on this box. Read
§1 before any command; the default resolution is wrong and will waste a run.

## 0. Which skill to use

This skill is the **machine + operations** layer. It deliberately does not
duplicate the media-authoring guidance — reach for the sibling packs:

| Need | Skill |
|---|---|
| CLI surface, envelopes, workflow authoring, recipes | `comfy` |
| A failed job: error code → fix | `comfy-debug` |
| Show an image/clip in chat, never leave it in /tmp | `comfy-relay` |
| Multi-shot narrative video, story/continuity/conform | `comfy-director` |
| Build a custom environment on the developer platform | `comfy-build` |
| **This machine**: install layout, MCP wiring, lifecycle, env repair | `comfyui-orchestration` |

## 1. Host topology — read this first

**Two ComfyUI trees exist. Only one runs.** Confusing them is the single most
expensive mistake available.

| Tree | Path | State |
|---|---|---|
| **The real one** | `D:\Comfy-Desktop\ComfyUI-Installs\yesy\ComfyUI` → `/mnt/d/...` | ComfyUI **0.44.0**, ROCm torch 2.9, 979 nodes, live on :8188 |
| WSL stub | `~/ComfyUI` | 0.34.0, **CPU-only** torch, 156 KB of models — not the runtime |

```
Comfy Desktop (Windows app)
└── D:\Comfy-Desktop\
    ├── ComfyUI-Installs\yesy\
    │   ├── ComfyUI\              # ← the server tree (v0.44.0)
    │   ├── standalone-env\       # ← python.exe 3.13.12 + ROCm torch
    │   ├── logs\comfyui.log      # ← the log that matters
    │   └── manifest.json         # ← pins comfyui_ref, torch, ROCm versions
    └── ComfyUI-Shared\
        ├── models\               # ← 251 GB, the only model store that counts
        ├── input\  output\       # ← where files actually live
```

**The desktop app owns the process.** The server is started by Comfy Desktop
on Windows, not by `comfy launch`. Consequences that bite:

- `ss -tlnp` on WSL **cannot see** the Windows listener. Do not conclude "no
  server" from a missing socket — probe it with `curl` (§2).
- `~/.config/comfy-cli/config.ini` still points `default_workspace` at
  `/mnt/d/Comfy-Desktop/ComfyUI-Installs/ComfyUI/ComfyUI`, which **does not
  exist**. That stale path is why `comfy which` lies (§3).
- The shared model store is injected at launch via
  `--extra-model-paths-config C:\Users\kenwa\AppData\Roaming\Comfy Desktop\instance-model-paths\inst-*.yaml`.
  That YAML is Desktop-generated — **never hand-edit it**.

## 2. Is it up? (do this before anything else)

```bash
# The authoritative probe. 200 = up.
curl -s -m 5 -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/system_stats

# What version, which python, which argv:
curl -s http://127.0.0.1:8188/system_stats | python3 -c \
  'import sys,json; s=json.load(sys.stdin)["system"]; print(s["comfyui_version"], s["pytorch_version"]); print("\n".join(s["argv"]))'
```

`comfy --json env` also reports `server.running`, and unlike a raw socket
check it understands the Windows listener. Prefer it once the CLI is healthy.

**Never trust `ss`/`netstat` for this.** WSL's network namespace does not see
the Windows process even when the port is fully reachable.

## 3. Workspace resolution — fix the lie before you trust it

```bash
comfy --json which     # → /home/nanoboozhoo/comfy/ComfyUI   ← DOES NOT EXIST
```

That is the `default_workspace`/`recent_workspace` config talking. Commands
that mutate the local tree — `install`, `launch`, `node install`,
`node save-snapshot` — act on this phantom path. Two fixes:

```bash
# A. Point the CLI at the real tree (persists):
comfy set-default "/mnt/d/Comfy-Desktop/ComfyUI-Installs/yesy/ComfyUI"
comfy --json which          # verify before proceeding

# B. Or point at the server over HTTP, which needs no tree at all:
export COMFY_LOCAL_URL=http://127.0.0.1:8188
```

Precedence: `--host`/`--port` → `COMFY_LOCAL_URL` → comfy-cli's background
server → `127.0.0.1:8188`.

**Read-only discovery does not need the workspace fixed.** `comfy nodes ls`,
`nodes show`, `templates ls`, `workflow slots`, and — importantly —
`comfy models list-folders` / `models list-folder` all resolve against the
**live server over HTTP** (`data.url` is literally
`http://127.0.0.1:8188/models/checkpoints`). Verified working with the
workspace still pointing at the phantom path:

```bash
comfy --json nodes ls --limit 1        # → total: 979
comfy --json discover                  # → 48 commands
comfy --json models list-folder checkpoints   # → data.url = live :8188
```

That HTTP resolution is also why the model list can be trusted: it reports
what the server actually sees through the Desktop-injected
`--extra-model-paths-config`, not what any local directory walk would guess.

## 4. The two surfaces

**`comfy-cli`** — every command emits one JSON envelope:

```json
{"schema":"envelope/1","ok":true,"command":"...","version":"1.19.0",
 "where":"local|null","data":{},"error":null}
```

When `error` is set, **act on `error.hint`** and branch on `error.code` —
never scrape prose. Non-zero exit codes are truthful: `ok:false` is exit 1.

**`comfy-mcp`** — 39 tools over stdio, wrapping the same CLI:

| Group | Tools |
|---|---|
| Server lifecycle | `server_info` `launch_comfyui` `stop_comfyui` `restart_comfyui` `update_comfyui` `switch_comfyui_version` `install_node` `get_logs` |
| Health / memory | `system_stats` `free_memory` |
| Jobs | `run_workflow` `job` `fetch_outputs` |
| Generation | `generate_image` `run_template` `partner_generate` `emit_partner_workflow` `list_partner_models` `partner_model_schema` |
| Discovery | `discover` `which` `nodes` `node_dependencies` `workflow_deps` `search_templates` `get_template` `fetch_template` `search_models` |
| Workflows | `validate_workflow` `list_workflow_slots` `list_workflow_notes` `set_workflow_slot` `vary_workflow` |
| Files / models | `download_model` `download` `upload_file` `project` |
| Auth | `auth_status` `auth_login` |

`job` actions: `status` (default) · `error` (normalized `error_code`) · `wait`
· `watch` · `cancel`. `nodes` actions mirror `nodes ls/show/upstream/...`.
Every spend-capable tool takes `confirm_spend` and **fails closed** without it.

## 5. Repairing the MCP server (it was broken; keep it fixed)

`comfy-mcp` failed to start at all — `ModuleNotFoundError: No module named
'_cffi_backend'` — because `cryptography` needs `cffi`, and installing
`comfy-mcp` did not pull it in. `comfy skills` and `comfy env` independently
died on a missing `httpx`. All three are now installed.

```bash
# Diagnose in one shot — any traceback here is a real dependency break:
comfy-mcp --help          # must exit 0 and print nothing alarming
comfy skills --help       # must render usage, not a traceback

# Repair:
pip install httpx cffi sniffio
```

`sniffio` matters beyond httpx: `openai` 2.54.0 requires it and pip only
warns about the conflict, so a later import fails far from the cause.

**`COMFY_BIN` must name a binary that exists.**

```json
{"mcpServers":{"comfy-mcp":{"command":"comfy-mcp","env":{}}}}
```

The old config set `COMFY_BIN=C:\\Users\\kenwa\\.local\\bin\\comfy.exe` — that
file does not exist, and the MCP server raises a curated missing-binary error
against it. **Omit `COMFY_BIN` entirely** and let it resolve `comfy` from
`PATH` (`~/miniforge3/bin/comfy`). The server prepends the resolved binary's
directory to the child `PATH` so `comfy launch --background` re-invocation
still works.

Register it globally (recommended — this machine is shared by every workspace)
at `~/.cursor/mcp.json`:

```json
{"mcpServers":{"comfy-mcp":{"command":"comfy-mcp","args":[],"env":{}}}}
```

The same server is referenced by the `comfyui-orchestration` project repo in
its `.mcp.json`, which is the file carrying the dead `COMFY_BIN` above — fix
both if you want the MCP reachable from every workspace *and* that project.

Verify: `agent mcp list` should show `comfy-mcp` connected, then
`agent mcp list-tools comfy-mcp`.

## 6. Lifecycle — who starts what

**Do not reflexively `comfy launch`.** The desktop app owns the process; a
second launch fails on the port ("a second launch fails on the port" —
`launch_comfyui` says so itself). Call `server_info` first.

| Situation | Action |
|---|---|
| Desktop app is running the server | **Nothing.** It is managed; leave it. |
| Server down, desktop app present | Start it from the **desktop app**, not the CLI. |
| No desktop app / headless intent | `comfy launch --background` (needs §3 fixed first) |
| Restart needed | `comfy stop` then launch — never `kill` a Windows PID from WSL |
| Version switch | `switch_comfyui_version` — destroys the env; pin in `manifest.json` first |

Logs live at `D:\Comfy-Desktop\ComfyUI-Installs\yesy\logs\comfyui.log`.
`get_logs(tail=N)` is the MCP path; read the file directly from WSL when the
server is too wedged to answer.

**Memory gating — read before any heavy run.** These are MCP tool calls, not
shell commands (there is no `comfy-mcp <tool>` CLI form):

- `system_stats()` → per-device `vram_free` / `vram_total`
- `free_memory()` → unload models, reclaim VRAM
- CLI equivalents: `comfy system-stats` and `comfy free`

`system_stats` reports VRAM for **whichever ComfyUI comfy-cli targets**, and
it is *not* diverted by `COMFYUI_URL`/`COMFYUI_HOST`. If a
`comfy_target_note` comes back, settle whether that host is this machine
before gating a run on the numbers.

## 7. Day-to-day operations

```bash
# Discovery (no workspace needed — reads live object_info)
comfy --json nodes search "checkpoint loader"
comfy --json nodes show KSampler
comfy --json nodes ls --produces VIDEO --limit 10
comfy --json nodes path MODEL IMAGE

# Models — the 251 GB store, not the WSL stub
comfy --json models list-folders
comfy --json models list-folder checkpoints
comfy --json models search --text "flux" --limit 10

# Templates
comfy --json templates ls --type video --limit 10
comfy templates fetch <name> --out ref.json

# Workflows — validate, inspect, edit
comfy --json workflow validate --workflow api.json
comfy --json workflow slots wf.json
comfy workflow set-slot wf.json 6.text="a cat"
comfy workflow vary wf.json --slot '3.seed=[1,2,3]' --out-dir ./variants

# Submit and collect — async by default. (`jq` is absent here; python3 parses.)
RES=$(comfy --json run --workflow wf.json)
PROMPT_ID=$(echo "$RES" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["prompt_id"])')
comfy --json jobs watch "$PROMPT_ID"      # exits 0 only on completion
comfy --json download "$PROMPT_ID"
```

`comfy run` never blocks: it returns a `prompt_id` in milliseconds. Do real
work while it cooks, collect when you need the result. `--wait` is for
single-shot synchronous runs only.

**Auth state on this machine:** `cloud whoami` reports `signed_in: false`.
Everything local works; cloud/partner routes will fail until someone runs
`comfy cloud login`. Do not "fix" that by setting an API key preemptively.

## 8. Failure map — what actually breaks here

| Symptom | Cause | Fix |
|---|---|---|
| `ModuleNotFoundError: httpx` | dep missing after install | `pip install httpx` |
| `ModuleNotFoundError: _cffi_backend` | `cffi` missing, `cryptography` needs it | `pip install cffi` |
| `sniffio` import error deep in a trace | `openai` needs it, pip only warned | `pip install sniffio` |
| `COMFY_BIN not found on PATH` | config names a nonexistent `.exe` | delete `COMFY_BIN`; let PATH resolve |
| `comfy which` → `~/comfy/ComfyUI` | stale `default_workspace` | `comfy set-default <real path>` |
| `server_not_running` but port 200s | WSL can't see the Windows socket | trust `curl`/`comfy env`, not `ss` |
| `comfy launch` fails on port in use | desktop app already owns it | don't launch; use the app |
| `models list-folder` empty or wrong | server down, or `--where cloud` | check `curl` first; confirm `data.url` points at :8188 |
| Node missing at submit | absent from the 979-node live set | `nodes search` → `install_node` (needs §3) |
| Job OOM / `server_died` | VRAM exhausted | `job(action="error")` → `get_logs` → `free_memory` |

## 9. Verifying health end-to-end

A quick, honest smoke test — run it after any repair. **`jq` is not installed
on this machine**, so these use `python3`:

```bash
curl -s -m 5 -o /dev/null -w "server:%{http_code}\n" http://127.0.0.1:8188/system_stats
comfy-mcp --help >/dev/null 2>&1 && echo "mcp:starts"
comfy --json nodes ls --limit 1 | python3 -c 'import sys,json;print("nodes:",json.load(sys.stdin)["data"]["total"])'
comfy --json models list-folders | python3 -c 'import sys,json;print("modelfolders:",len(json.load(sys.stdin)["data"]["folders"]))'
```

Expect `server:200`, `mcp:starts`, `nodes:979`, and `modelfolders:29`.
Anything else is the table in §8.

## 10. Don't do this

- **Don't build anything against `~/ComfyUI`.** It is a CPU stub with no models.
- **Don't hand-edit `instance-model-paths\inst-*.yaml`** — Desktop regenerates it.
- **Don't set `COMFY_BIN` to a path you have not `ls`-ed.**
- **Don't `kill` ComfyUI from WSL** — it is a Windows process the app tracks.
- **Don't trust `ss`/`netstat`** for whether the server is up (§2).
- **Don't add `--allow-spend` / `confirm_spend`** to make a gate error go away;
  it means a human has not approved the spend yet.
- **Don't write outputs to `/tmp`.** Use `D:\Comfy-Desktop\ComfyUI-Shared\output`
  (or the governing project's `outputs/`) and surface the artifact in chat.
