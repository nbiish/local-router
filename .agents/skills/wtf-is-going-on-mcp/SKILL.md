---
name: wtf-is-going-on-mcp
description: Coordinate AI coding agents across machines with wtf-is-going-on-mcp. Herdr owns agent sessions; wtf records who is doing what and carries messages between machines. Use when starting or resuming work on a machine, checking what agents elsewhere are doing, asking another machine's agent a question, handing a task to a peer, or reporting progress/blockers. Covers start-the-hub-if-needed, MCP wiring, agent-to-agent chat, and cross-machine status.
whenToUse: Use when an operator or agent needs cross-machine awareness (who is working on what, right now), a peer agent's answer on another machine, a task handoff, or a progress/blocker report that other machines must see. Use Herdr for the agent session itself; use wtf for the shared record and the cross-machine link.
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
wtf enroll --url http://HUB:47820 --name <name> --token T   # on the new machine
wtf join user@host                                         # or over ssh, self-serve
```

Keys print once. They live in `$WTF_HOME` (default `~/.config/wtf-mcp`).

## 2. Wire the MCP server

```json
{ "mcpServers": { "wtf": { "command": "/abs/path/target/release/wtf", "args": ["agent"] } } }
```

Credentials resolve from `$WTF_HOME/bridge.json`, or `WTF_HUB_URL` /
`WTF_DEVICE_NAME` / `WTF_DEVICE_KEY`.

## 3. Tools (18)

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
session_send  {"session": "<id>", "message": "take the retry fix on windows; hub is :47820"}
# peer: session_list → session_join → session_read
```

Never leave `working` open without `check_in done` or `blocked`. A stale lane is
worse than none.

## 6. No MCP? Signed curl

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

## 7. Rules

- **Never** log, echo, or commit device keys or the capability token.
- **Never** port-forward plain HTTP to the internet. TLS, WireGuard, or Tailscale.
- Secrets cross machines only via encrypted sessions — the event feed is public.
- `wtf` never spawns `local-router`, `fcc-server`, or any agent harness.
- Dashboard lives at one unguessable path, `/w/<64-hex>`. Wrong path = 404.
- Default port `47820`, auto-falling back up to `+100` if busy.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `connection refused` | `wtf serve` on the hub machine. |
| 401 on signed call | Key revoked/wrong, clock off >300s, or signature input mismatch. |
| 404 on `/` or `/w/...` | Capability token wrong — run `wtf dashboard-url` on the hub. |
| `chat` fails, router offline | Start the router yourself. wtf never will. |
| Port busy | wtf auto-falls back within `47820`–`47920`. |
| Agent not visible in Herdr | It isn't in a Herdr pane. Launch it with `herdr agent start`. |
| Peer machine silent | `env_probe` — is it enrolled and reporting? |
