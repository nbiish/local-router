---
name: wtf-is-going-on-mcp
description: Coordinate AI coding agents across machines with wtf-is-going-on-mcp. Herdr owns agent sessions; wtf records who is doing what, carries messages between machines, and dispatches addressable work to a paired machine's own agent. Use when starting or resuming work on a machine, checking what agents elsewhere are doing, asking another machine's agent a question, designating a task for a peer machine and reading the result back, or reporting progress/blockers. Covers start-the-hub-if-needed, MCP wiring, agent-to-agent chat, federated task dispatch, and cross-machine status.
whenToUse: Use when an operator or agent needs cross-machine awareness (who is working on what, right now), a peer agent's answer on another machine, work delegated to another machine's tooling/keys/checkout, or a progress/blocker report that other machines must see. Use Herdr for the agent session itself; use wtf for the shared record, the cross-machine link, and the task board.
---

# wtf-is-going-on-mcp

**Herdr runs agents. wtf records and connects them.**

`wtf` is a zero-dependency Rust hub (`wtf serve`) plus an MCP stdio bridge
(`wtf agent`). It answers one question — *what is going on, across all my
machines* — and carries encrypted messages between agents that aren't on the
same box. It does not run agents, spawn harnesses, manage terminals, or shuttle
files. Herdr does that.

| Need | Tool |
|---|---|
| Run, watch, or steer an agent session | **Herdr** (`herdr`) |
| See who is doing what on every machine | **wtf** `wtf_is_going_on` |
| Ask an agent on another machine; get an answer back | **wtf** `session_*` / `comms_*` |
| **Designate work for another machine and get the result back** | **wtf** `task_*` |
| Move a file, run a remote command | `ssh` / `scp` |
| Anything binary, pastebin-like, or scratch | Write it to a file and `scp` it |

## 1. Start what you need

The hub is a normal background service — start it if it isn't running. Never
start Herdr from inside an agent: if `HERDR_ENV=1`, you are already in it.

```bash
wtf status || (wtf serve --no-open &)     # hub up? if not, start it
cargo build --release --manifest-path /path/to/wtf-is-going-on-mcp/Cargo.toml   # if wtf is missing
wtf dashboard-url                          # the one link the operator opens
```

Enroll a new machine once — it persists across restarts:

```bash
wtf enroll-token <name>                                    # on the hub: single-use token
wtf enroll --url http://HUB:7800 --name <name> --token T   # on the new machine
wtf join user@host                                         # or over ssh, self-serve
```

Keys print once. They live in `$WTF_HOME` (default `~/.config/wtf-mcp`).

## 2. Wire the MCP server

```json
{ "mcpServers": { "wtf": { "command": "/abs/path/target/release/wtf", "args": ["agent"] } } }
```

Credentials resolve from `$WTF_HOME/bridge.json`, or `WTF_HUB_URL` /
`WTF_DEVICE_NAME` / `WTF_DEVICE_KEY`.

## 3. Tools (23)

**Presence & record**

| Tool | Args | Use |
|---|---|---|
| `wtf_is_going_on` | `agent?` | Start here. Who is doing what, every machine. |
| `check_in` | `status`, `task`, `details?`, `agent?`, `repo?` | Claim/extend your lane: `working`/`blocked`/`done`/`idle`. |
| `log_event` | `message`, `level?`, `agent?`, `repo?` | Milestones, decisions, failures. |
| `hub_info` | — | Hub URL + this device. No secrets. |
| `ping` | — | Unsigned `/healthz`. |
| `env_report` / `env_probe` | — | Register / read each machine's os, arch, version. |

**Talking to agents on other machines**

| Tool | Args | Use |
|---|---|---|
| `session_create` | `name`, `repo?` | Open a lane. Pairing key prints once. |
| `session_list` / `session_join` | `repo?` / `session`, `pairing` | Find and join. |
| `session_send` / `session_read` | `session`, `message` / `session`, `after?` | Encrypted messaging. |
| `session_seal` | `session`, `device` | Share the lane key ML-KEM-768-sealed. |
| `comms_post` / `comms_read` | `session`, `event`, `note`, `scope?` | Structured ledger: checkin, update, intent-merge, checkout, handoff. |

**Optional inference**

| Tool | Args | Use |
|---|---|---|
| `chat` | `prompt`, `model?`, `system?`, `agent?` | Completion via the operator-run router at `127.0.0.1:11434`. `hermes` (OpenAI) or `pi` (Anthropic). Fails closed when the router is down — wtf never starts it. |
| `router_status` | — | Passive probe of :11434. |

**Designating work on another machine**

| Tool | Args | Use |
|---|---|---|
| `task_dispatch` | `title`, `detail?`, `target?`, `session?`, `repo?` | Queue work for a paired machine. `target` is a machine name/alias, `any`, `tier:heavy\|tier:standard\|tier:edge`, or `arch:<os>-<arch>`. Returns a task id. |
| `task_claim` | `machine?`, `tier?`, `arch?`, `task?` | **Worker side.** Take the oldest queued task this machine can serve. Empty queue is a normal answer, not an error. |
| `task_report` | `task`, `state`, `result?`, `error?` | `running` = heartbeat (extends the 15-minute lease), `done` with the deliverable in `result`, `failed`, or `blocked`. Only the claiming device may report. |
| `task_status` | `task?`, `state?` | The board, or one task's full record + result. How a dispatcher reads back what it asked for. |
| `task_run` | `task`, `runner?`, `workdir?`, `agent?`, `machine?` | **Worker side.** Start the agent that performs the task you claimed: Orca for supervised orchestration, Herdr for durable terminals. Records the runner's handle. |
| `runner_probe` | — | Which runtimes this machine can start, and which `task_run` would pick. Call before dispatching to an unfamiliar machine. |

`task_*` is **pull-based**: the hub queues the record and an agent already
running on the target machine picks it up. Nothing is spawned over `ssh` and no
remote session is driven. A task that stays `queued` means no agent on that
machine is polling — report that to the user instead of treating it as a
failure. Bind a chat with `session` so the operator watches the same work in
the dashboard; report into that chat with `comms_post` as you go.

**Runners — Orca first, Herdr as fallback.** Dispatch carries a `runner`
(`auto` by default). `auto` prefers **Orca** (`orca orchestration worker-start`,
supervised, reports completion through its own Run) and falls back to
**Herdr** (`herdr agent start`, durable terminal agents) when Orca is absent.
Naming a runner explicitly is honored exactly — if it is missing the call fails
with the install step rather than quietly using the other one.

Getting a *remote* machine ready, once:

```bash
# Orca: the target runs a headless runtime, you pair it, then address it by name.
#   on the target:  orca serve --bind 0.0.0.0
#   here:           orca environment add --name mac --pairing-code 'orca://pair?...'
#                   orca environment list            # confirm it is saved
# Herdr: needs ssh reachability, then one add.
herdr machine add user@host --label mac
```

`--on <environment>` (Orca) and `--machine <label>` (Herdr) are the only remote
targets a runner understands. **A bare LAN IP is not an Orca target** — if the
mac is only reachable by address, use Herdr or pair Orca first.

Write in chain-of-draft: five words per status line, not paragraphs. The feed is
public inside the cluster; keep prose in your own notes.

## 4. Herdr — the agent session layer

Herdr owns terminals, worktrees, panes, and agent lifecycles. Confirm you are
inside it before controlling it:

```bash
test "${HERDR_ENV:-}" = 1 || { echo "not in Herdr — use wtf only"; }
herdr --help                       # installed binary is the authority
herdr agent list                   # recognized agents + lifecycle state
herdr agent read <name>            # tail an agent's terminal
herdr agent prompt <name> "..."    # send it a prompt
herdr agent wait <name> --state done
herdr workspace list; herdr pane list
herdr machine list                 # saved SSH machines (cross-machine sessions)
```

Lifecycle states mean: `idle`/`done` = ready for input (the server distinguishes
them by seen-state), `blocked` = approval or question waiting, `unknown` = present
but unclassified — never assume that means finished.

Use Herdr for everything that is a *session*: starting agents, splitting panes,
reading trajectories, worktrees, and cross-machine sessions via `machine add` +
`--machine`. Use wtf for everything that is a *record*: who is on what, and the
messages that have to survive the session.

## 5. The loop

```bash
wtf_is_going_on                      # 1. orient — who is on what
check_in working "audit federation retry"    # 2. claim your lane
# ... do the work in Herdr ...
log_event "federation retry audited"         # 3. record milestones
check_in done "federation retry audited"     # 4. close, so the next agent sees truth
```

Handing off to a peer machine:

```bash
session_create {"name": "hand-off-audit"}
session_send  {"session": "<id>", "message": "take the retry fix on windows; hub is :7800"}
# peer: session_list → session_join → session_read
```

**Designating work on a peer machine (the task lane).** Use this instead of
ad-hoc `ssh` when the work belongs to another machine's own tooling, keys, or
repo checkout:

```bash
# dispatcher (any machine):
task_dispatch {"title": "reindex the vector store",
               "detail": "run the indexer, report chunk count",
               "target": "tier:heavy",
               "session": "<chat id>"}          # → task id
task_status   {"task": "<task id>"}             # read the result when it lands

# worker (an agent already running ON the target machine):
task_claim  {"machine": "mac", "tier": "heavy", "arch": "darwin-arm64"}
# → the claimed task + its `detail` = the instructions
task_run    {"task": "<task id>"}               # start the agent: Orca, else Herdr
# ... the agent runs it with local tooling ...
task_report {"task": "<task id>", "state": "running"}        # heartbeat, long jobs
task_report {"task": "<task id>", "state": "done", "result": "48,120 chunks"}
```

`wtf tasks` prints the same board from any machine. Claims expire after 15
minutes of silence, so a crashed worker returns its task to the queue rather
than stranding it; only the claiming device may finish a task, and only the
dispatcher may cancel one.

Never leave `working` open without `check_in done` or `blocked`. A stale lane is
worse than none.

## 6. Transport - the SSH link between the machines

wtf carries the record and the messages; it deliberately does not move files or
run remote commands. That is plain OpenSSH, already wired and verified.

| From | Command | Lands on |
|---|---|---|
| Mac | `ssh windows '<cmd>'` (alias of `psh`) | Windows PowerShell 5.1, user `kenwa` |
| Mac | `ssh wsl '<cmd>'` | WSL Ubuntu 26.04, user `nanoboozhoo` |
| Windows / WSL | `ssh mac '<cmd>'` | macOS, user `nbiish` |
| any | `run-on <alias> '<cmd>'` | same targets, BatchMode + timeouts pinned |

- **Names, not addresses.** Targets resolve by name (`peopleofthedawn.local`,
  `mac.attlocal.net`); the `*-ip` aliases (`psh-ip`, `wsl-ip`, `mac-ip`) carry
  the last-known DHCP address. Prefer names in anything long-lived.
- **No prompts, ever.** Key-only auth - `PasswordAuthentication no` and
  `AuthenticationMethods publickey` on both servers - so `BatchMode=yes`
  succeeds. A code path that needs interactive auth is broken by definition.
- **Exit status is the remote program's.** `255` means the SSH layer failed;
  anything else is the command's own result.
- **Keys are `restrict,pty`.** No agent forwarding, no `-L`/`-R`/`-W` tunnels,
  no X11. Do not build a feature on tunnelling.
- **Files:** `scp`, `sftp`, and `rsync -e ssh` work through the same aliases.
  Windows paths need the drive form (`psh:D:/Workspace/...` or
  `psh:/D:/Workspace/...`), and Win32-OpenSSH cannot traverse a junction - a
  path through one fails with `dest open ...: Failure`, so use the real path or
  the WSL view (`wsl:/mnt/d/Workspace/...`).
- **Pick the right lane.** `ssh`/`scp` for one-off transport and anything you
  drive yourself; the **task lane** (`task_*`) when the work belongs to the
  other machine's own agent, keys, or repo checkout.

Full topology, keys, fingerprints, rollback, and the failure table:
`INTER_MACHINE_SSH_RUNBOOK.md` in `system-care-and-updates`.

## 7. No MCP? Signed curl

HMAC-SHA256 over `wtf-hmac-v1\nMETHOD\npath-and-query\nTS\nNONCE\nsha256hex(body)`,
key = the device secret's raw 32 bytes.

```bash
wtf_call() { local m=$1 p=$2 b=${3:-}; local ts n bh sig
  ts=$(date +%s); n=$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  bh=$(printf '%s' "$b" | openssl dgst -sha256 -hex | awk '{print $NF}')
  sig=$(printf 'wtf-hmac-v1\n%s\n%s\n%s\n%s\n%s' "$m" "$p" "$ts" "$n" "$bh" \
        | openssl dgst -sha256 -mac hmac -macopt "hexkey:$WTF_DEVICE_KEY" -hex | awk '{print $NF}')
  curl -sS -X "$m" "$WTF_HUB_URL$p" ${b:+-H "Content-Type: application/json" --data "$b"} \
    -H "X-Wtf-Device: $WTF_DEVICE_NAME" -H "X-Wtf-Timestamp: $ts" \
    -H "X-Wtf-Nonce: $n" -H "X-Wtf-Signature: $sig"; }
```

## 8. Rules

- **Never** log, echo, or commit device keys or the capability token.
- **Never** port-forward plain HTTP to the internet. TLS, WireGuard, or Tailscale.
- Secrets cross machines only via encrypted sessions — the event feed is public.
- `wtf` never spawns `local-router`, `fcc-server`, or any agent harness.
- Dashboard lives at one unguessable path, `/w/<64-hex>`. Wrong path = 404.
- Default port `7800` (set in `wtf serve --bind IP:PORT` or `config.json`).

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| `connection refused` | `wtf serve` on the hub machine. |
| 401 on signed call | Key revoked/wrong, clock off >300s, or signature input mismatch. |
| 404 on `/` or `/w/...` | Capability token wrong — run `wtf dashboard-url` on the hub. |
| `chat` fails, router offline | Start the router yourself. wtf never will. |
| Task stays `queued` | No agent on the target machine is calling `task_claim`. Start one there, or dispatch to a machine that has one. |
| `task_claim` says nothing matched | The selector is exact: check the machine name vs `target`, and pass `tier`/`arch` so `tier:`/`arch:` targets can match. |
| `finish failed: … claimed by …` | Another device holds the claim. Let its lease expire (15 min) or ask the dispatcher to cancel and re-dispatch. |
| `task_run`: `agent_unconfigured` | Orca's `worker-start` needs `--agent`. Pass `agent:"claude"` (or another id) — the default is `codex`. |
| `task_run`: `agent-hooks-review-prompt` | Orca is waiting on an agent-hooks approval in that Orca UI. Approve it there (`orca agent hooks on`), then re-run — the task is still claimed. |
| `task_run`: no runner | `runner_probe` to see what is missing. Install Orca or Herdr on the target machine; the hub never installs anything. |
| Remote runner unreachable | Orca needs a paired environment (`orca environment add`), Herdr needs `herdr machine add`. A raw LAN address is neither. |
| Port busy | Pick another port: `wtf serve --bind 127.0.0.1:7801`. There is no auto-fallback. |
| Agent not visible in Herdr | It isn't in a Herdr pane. Launch it with `herdr agent start`. |
| Peer machine silent | `env_probe` — is it enrolled and reporting? |
