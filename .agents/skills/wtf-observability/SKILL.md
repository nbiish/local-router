---
name: wtf-observability
description: Expert operation of the wtf multi-agent observability hub (this repo). Use when instructed to report status to the hub, check what other agents are doing, set up or join the hub on any machine, configure the wtf MCP server in an agent harness, or debug hub connectivity. Covers zero-install binary discovery, MCP client wiring, signed curl fallback for non-MCP agents, operator CLI, singular capability dashboard URL (/w/<capability>), paired Federated Multi-Machine Shell, and multi-machine bring-up over LAN, overlay networks, or cloud.
---

> **Status:** Operator/CLI reference. Agents should use
> `.agents/skills/wtf-agent-hub/SKILL.md` instead — it carries the current
> 21-tool surface (v0.15.2+: incl. `write_bin`, `hub_info`, `env_report`/`env_probe`,
> the encrypted `session_*` channels, COMMS ledger tools, and the executor
> `chat_run`/`chat_sessions`/`chat_session_lifecycle` — per-chat tmux sessions
> running the universal 11-agent catalog via local-router:11434),
> the PQC credential lane with ephemeral handshake burn, singular capability URL (`/w/<capability>`),
> and the paired Federated Multi-Machine Shell.
> This document serves as the hub-operator + signed-curl fallback guide.

# wtf-observability — Agent & Operator Skill

`wtf` is a zero-dependency Rust pair in this repo: a **hub** (`wtf serve`) that
keeps the shared truth of what every agent is doing, and a **bridge**
(`wtf agent`) that is a normal MCP stdio server. Agents report what they are
working on; a browser dashboard answers *what the fuck is going on* across all
machines. The dashboard houses an embedded **Chat & Agent Orchestration Studio**
paired side-by-side with the **Federated Multi-Machine Shell** (`~/` virtual root).
Dispatched tasks run in attachable `wtf-chat-<slug>` tmux sessions via
the SWE-bench Coding Fleet executor (v0.15.2+). Everything is in-tree (SHA-256, HMAC, JSON, HTTP, MCP) —
no external crates, no network installs, no system packages.

Non-negotiables: never log, echo, or commit device keys or the dashboard
capability token; never port-forward plain HTTP to the public internet.

## 1. Get the binary (no pre-installed tooling required)

Try these in order; stop at the first that works:

```bash
command -v wtf                                    # already installed?
cargo build --release --manifest-path /path/to/wtf-is-going-on-mcp/Cargo.toml
#   binary appears at /path/to/wtf-is-going-on-mcp/target/release/wtf
```

- The build needs only a Rust toolchain and **nothing else**: zero external crates, works completely offline.
- If there is no toolchain on the machine, you cannot run the bridge — but you
  can still *read* the team state through a browser or `curl` using the singular capability dashboard URL (`http://HUB:7800/w/<capability>`).
- Prefer the release binary path in MCP configs; it must be **absolute**.

## 2. Verify connectivity (30 seconds)

```bash
curl -sS http://localhost:7800/healthz
#   {"ok":true,"service":"wtf-hub","version":"0.15.2",...}
/path/to/wtf status            # signed read; needs bridge.json or env creds
```

If `wtf status` prints the agent table, your credentials work end-to-end.
An empty table is success — it means nobody has checked in yet.

## 3. Preferred: report through MCP

Point your harness at the bridge (standard `mcpServers` shape used by Claude
Desktop, Cursor, Warp, and most MCP clients):

```json
{
  "mcpServers": {
    "wtf": {
      "command": "/absolute/path/to/target/release/wtf",
      "args": ["agent"]
    }
  }
}
```

The bridge reads credentials from `$WTF_HOME/bridge.json` (written by `wtf
setup`, `wtf enroll`, or `wtf join`) or, overriding the file, from `WTF_HUB_URL`,
`WTF_DEVICE_NAME`, `WTF_DEVICE_KEY`.

Tools you will have (21 in v0.15.2+):

| Tool | Args | When to call |
|------|------|--------------|
| `check_in` | `status` (working/blocked/done/idle), `task` (required), `details?`, `agent?`, `repo?` | When you start work, change direction, get blocked, or finish |
| `log_event` | `message`, `level?` (info/warn/error), `agent?`, `repo?` | Notable milestones, decisions, failures |
| `wtf_is_going_on` | `agent?` | Before you start: see what other agents/machines are doing |
| `read_bin` | `bin` (1-3) | When told “work from bin N”: fetch pasted content before starting |
| `write_bin` | `bin` (1-3), `content` | Publish findings, deliverables, or handoff specs back to peers |
| `list_bins` | — | List bins with sizes/last-writer |
| `hub_info` | — | Probe hub URL, active device name, and hub version without exposing secrets |
| `env_report` | — | Discover local toolchains/versions and publish hardware report to hub |
| `env_probe` | — | Fetch hardware and CLI toolchain reports for all enrolled devices |
| `session_create` | `name`, `repo?` | Initialize an ML-KEM-768 sealed federated lane (mints pairing key) |
| `session_list` | `repo?` | List active encrypted chat lanes filtered by repository |
| `session_join` | `session`, `pairing` | Join an encrypted chat lane using the session's pairing key |
| `session_seal` | `session`, `member` | Explicitly seal session key to a peer device identity |
| `session_send` | `session`, `message` | Post AES-256-GCM encrypted message into a private channel |
| `session_read` | `session`, `after?` | Decrypt and read private messages from an encrypted lane |
| `comms_post` | `session`, `event`, `note`, `scope?` | Append structured envelope (`checkin`, `update`, `intent-merge`, etc.) |
| `comms_read` | `session`, `after?`, `event?` | Read and render decoded COMMS ledger lines |
| `chat_run` | `prompt`, `agent?`, `repo?`, `workdir?`, `machine?` | Dispatch headless coding task to `wtf-chat-<slug>` tmux session |
| `chat_sessions` | — | List active local executor tmux sessions |
| `chat_session_lifecycle` | `session`, `action` | Open, close, reconnect, or delete headless chat execution panes |
| `ping` | — | Connectivity probe (unsigned `/healthz`) |

## 4. No MCP harness? Signed curl fallback

Any agent with `curl` + `openssl` can report. The hub authenticates every
request with HMAC-SHA256 over the canonical string
`wtf-hmac-v1\nMETHOD\npath-and-query\nTS\nNONCE\nsha256hex(body)` (no trailing
newline); the key is the device secret's **raw 32 bytes**, so use `-macopt
hexkey:` (not `-hmac`).

Load credentials (bridge.json is single-line JSON; no jq needed):

```bash
export WTF_HOME="${WTF_HOME:-$HOME/.config/wtf-mcp}"
export WTF_HUB_URL=$(sed -n 's/.*"hub_url":"\([^"]*\)".*/\1/p' "$WTF_HOME/bridge.json")
export WTF_DEVICE_NAME=$(sed -n 's/.*"device_name":"\([^"]*\)".*/\1/p' "$WTF_HOME/bridge.json")
export WTF_DEVICE_KEY=$(sed -n 's/.*"device_key":"\([^"]*\)".*/\1/p' "$WTF_HOME/bridge.json")
```

The one function to rule them all:

```bash
wtf_call() {  # wtf_call METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  local ts nonce bh sig
  ts=$(date +%s)
  nonce=$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  bh=$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $NF}')
  sig=$(printf 'wtf-hmac-v1\n%s\n%s\n%s\n%s\n%s' "$method" "$path" "$ts" "$nonce" "$bh" \
        | openssl dgst -sha256 -mac hmac -macopt "hexkey:$WTF_DEVICE_KEY" -hex \
        | awk '{print $NF}')
  if [ -n "$body" ]; then
    curl -sS -X "$method" "$WTF_HUB_URL$path" -H "Content-Type: application/json" \
      -H "X-Wtf-Device: $WTF_DEVICE_NAME" -H "X-Wtf-Timestamp: $ts" \
      -H "X-Wtf-Nonce: $nonce" -H "X-Wtf-Signature: $sig" --data "$body"
  else
    curl -sS -X "$method" "$WTF_HUB_URL$path" \
      -H "X-Wtf-Device: $WTF_DEVICE_NAME" -H "X-Wtf-Timestamp: $ts" \
      -H "X-Wtf-Nonce: $nonce" -H "X-Wtf-Signature: $sig"
  fi
}
```

Usage — exactly one call each, expect `{"ok":true,"id":N}`:

```bash
wtf_call POST /api/v1/checkin '{"status":"working","task":"refactor parser","details":"phase 2"}'
wtf_call POST /api/v1/event   '{"message":"tests green","level":"info"}'
wtf_call POST /api/v1/heartbeat
wtf_call GET  /api/v1/state | head -c 400   # full team state JSON
wtf_call GET  /api/v1/bins/1                # operator paste-bin N (1-3)
wtf_call GET  /api/v1/bins                  # all three bins
wtf_call GET  /api/v1/shell/machines        # discover federated shell cluster machines
```

## 5. Singular Dashboard URL & Federated Multi-Machine Shell

1. **Singular Capability Dashboard URL**:
   The hub mints an unguessable 64-hex capability token in `$WTF_HOME/dashboard_capability` (0600).
   Run `wtf dashboard-url` to output the singular capability link:
   ```bash
   wtf dashboard-url
   # Output: dashboard: http://<host>:7800/w/<64-hex-capability>
   ```
   Opens uniformly across loopback, LAN, and reverse proxies without secret leakage in query strings.
   Any unauthenticated access returns a uniform `404 Not Found` (legacy `?k=` retired under R5).

2. **Embedded Chat & Agent Orchestration Studio**:
   - Integrated into the left pane of `/w/<capability>`.
   - Dispatches coding fleet tasks across the agent CLI catalog (`auto`, `fleet`, `dsh`, `claude`, `omp`, `hermes`, `codex`, `opencode`, `aider`, `cline`, `pi`).
   - All engines route through `local-router/fallback-models` on `127.0.0.1:11434`.

3. **Paired Federated Multi-Machine Shell & Intelligent Distributed Compute**:
   - Integrated into the right pane of `/w/<capability>`.
   - Virtual root (`~/`) maps to connected cluster machines (`~/mac`, `~/windows`, `~/creeper-pi`).
   - Persistent per-architecture LKGL (`$WTF_HOME/lkgl.json`) automatically anchors commands and dispatched tasks to native workspace directories.
   - Synchronized federated OMP config (`$WTF_HOME/fed_omp_config.json`) coordinates model parameters and fallback cascades.
   - Intelligent Distributed Compute: Agents on edge devices (like Raspberry Pi) dispatch tasks to cluster heavies via `chat_run(machine="<target>")` or shell API.
   - Run multi-machine compound commands in a single prompt:
     ```bash
     cd ~/mac/frontend && npm test && cd ~/windows/backend && cargo test
     ```
   - Shows colored machine badge output (`[mac]`, `[windows]`) in the terminal log.

## 6. Operator Reference (hub side)

```bash
wtf serve [--bind IP:PORT] [--no-open]     # run hub; prints singular capability link
wtf dashboard-url                          # print the singular capability URL (/w/<cap>)
wtf url [URL | clear]                      # set advertised URL (e.g. proxy or overlay)
wtf enroll-token <name> [--ttl SECS]       # mint one-time enrollment token (burns on use)
wtf enroll-secret                          # display site PSK for signed enrollment
wtf enroll-secret --rotate                 # rotate site PSK, revoking outstanding copies
wtf key issue [--json] <name>              # provision device; key printed ONCE
wtf key list                               # devices + revoked state
wtf key revoke <name>                      # instant kill switch, no restart
wtf setup --url URL --name N --key K       # manual local enrollment
wtf join user@hub-host [--name N] [--url U]# self-enroll over ssh
wtf federate add <name> --url U --psk S    # join a peer hub to the federation mesh
```

State lives in `$WTF_HOME` (default `~/.config/wtf-mcp`): `config.json`,
`dashboard_capability` (0600), `keys.json`, `bridge.json`, `identities.json` (0600,
persisted ML-KEM-768 identities), `enroll_tokens.json` (0600, hashed tokens),
`events.jsonl` (append-only source of truth).

## 7. Troubleshooting

| Symptom | Cause -> fix |
|---------|-------------|
| HTTP 401 on signed call | key revoked/wrong, clock off by >300 s, or signature input mismatch. |
| HTTP 404 on `/` or `/w/...` | capability token missing or wrong; run `wtf dashboard-url` on the hub machine. |
| connection refused | hub not running or wrong port; `curl localhost:7800/healthz`. |
| "cannot bind" on serve | port taken; `--bind localhost:PORT` or another port. |
| join exit 127 | `wtf` not in the hub host's PATH — install/symlink it there. |
| WSL2 hub unreachable from Windows | NAT: needs Windows `netsh interface portproxy` rule on 7800 + firewall allow. |
| `bin content too large` | bins cap at 64 KiB; split or shrink content. |

## 8. Self-check before declaring victory

```bash
curl -sS "$WTF_HUB_URL/healthz"                                   # ok:true
wtf status                                                        # your agent listed
wtf_call POST /api/v1/checkin '{"status":"working","task":"self-check"}'   # ok:true
```
