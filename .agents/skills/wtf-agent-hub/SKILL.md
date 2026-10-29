---
name: wtf-agent-hub
description: Mastered, concise operating manual for connecting any AI agent harness (Claude Desktop, Cursor, Warp, Codex, OpenCode, Aider, Cline, Pi, CI bots, custom harnesses, OMP, dsh) to the wtf federated observability hub, shell, and compute mesh. Covers zero-config join, singular capability plane (/w/<cap>), PQC key generation (FIPS 203 ML-KEM-768) and single-use burn-on-handshake lifecycle (wtf enroll-token / wtf enroll --psk), paired Federated Multi-Machine Shell (~/ virtual cluster root with LKGL persistence), universal agent CLI catalog (auto, fleet, dsh, claude, omp, hermes, codex, opencode, aider, cline, pi) via loopback proxy local-router:11434, private ML-KEM-768 sealed sessions/chats, structured COMMS ledger, and distributed compute task execution (chat_run).
---

# wtf-agent-hub — Master Operating Instruction Set

`wtf` is a zero-dependency Rust observability hub (`wtf serve`) and MCP stdio bridge (`wtf agent`). It acts as the singular source of truth across all connected machines: agent presence, chain-of-draft event streams, persistent paste-bins, encrypted agent-to-agent session channels, the SWE-bench Coding Fleet executor, and the paired Federated Multi-Machine Shell (`~/` virtual cluster root).

Any MCP-compliant harness — Claude Desktop, Cursor, Warp, Codex, OpenCode, Aider, Cline, Pi, OMP, dsh, or custom agents — connects autonomously.

```
+-----------------------------------------------------------------------------------+
|                            WTF FEDERATED MESH CORE                                |
|                                                                                   |
|  +--------------------+     +---------------------+     +----------------------+  |
|  |  Singular Access   |     |    PQC Auth Gate    |     |   Federated Shell    |  |
|  |   /w/<capability>  |     |  ML-KEM-768 / Burn  |     |   ~/ Virtual Root    |  |
|  +---------+----------+     +----------+----------+     +----------+-----------+  |
|            |                           |                           |              |
|  +---------+----------+     +----------+----------+     +----------+-----------+  |
|  |  11-Agent Catalog  |     |   ML-KEM-768 Chats  |     |  Distributed Compute |  |
|  | local-router:11434 |     |    COMMS Ledger     |     | chat_run(machine=X)  |  |
|  +--------------------+     +---------------------+     +----------------------+  |
+-----------------------------------------------------------------------------------+
```

### Non-Negotiable Invariants
1. **PQC Secret Delivery:** API keys and device credentials travel strictly through post-quantum mechanisms (FIPS 203 ML-KEM-768 / FIPS 204 ML-DSA-65). Never touch disk in plaintext.
2. **Ephemeral Handshake Burn:** One-time enrollment tokens and pairing keys burn immediately upon handshake completion. Replays fail closed (uniform 403).
3. **Singular Capability Plane:** Operator access is gated strictly via the unguessable 64-hex capability endpoint `/w/<capability>` (or `?cap=<capability>`). Legacy `?k=` is retired; invalid requests return uniform `404 Not Found`.
4. **Zero Public HTTP:** Hubs never expose unencrypted HTTP to the public internet. Use WireGuard, Tailscale, or TLS-terminating reverse proxies.
5. **Chain-of-Draft Reporting:** Public events and status checks are terse fragments (<=5 words per item). No prose in public feeds.

---

## 1. Binary Acquisition & Zero-Config Join

### Compile & Discover
```bash
command -v wtf                                                # Check PATH
cargo build --release --manifest-path /path/to/wtf-is-going-on-mcp/Cargo.toml
# Release binary: /path/to/wtf-is-going-on-mcp/target/release/wtf
```
Zero external dependencies: builds offline with pure `rustc` / `cargo`.

### Zero-Config Autonomous Join
An operator provides the agent harness with this skill file and ONE credential:
- **Ephemeral Token:** `wtf enroll --url http://HUB:7800 --name <name> --token <token>`
- **Signed PSK:** `wtf enroll --url http://HUB:7800 --name <name> --psk <site-secret>`
- **PQC Bundle:** `eval "$(pqc-secrets export | grep WTF_<NAME>_SECRET)"`

The agent autonomously enrolls, writes its local `bridge.json` (0600), validates via unsigned `/healthz` and signed `/api/v1/checkin`, and begins executing without human intervention.

### Distribute Skill Everywhere
```bash
wtf skill install --dir /path/to/target/project   # Writes .agents/skills/wtf-agent-hub/SKILL.md
wtf skill print                                # Outputs raw markdown to stdout
```

---

## 2. PQC Security, Key Generation & Ephemeral Handshake Burn

### PQC Key Architecture (FIPS 203 / 204 / 205)
- **FIPS 203 ML-KEM-768:** Key encapsulation for delivering device secrets and session keys.
- **FIPS 204 ML-DSA-65:** High-assurance signatures for agent verification.
- **FIPS 197 AES-256-GCM:** Authenticated symmetric encryption for channel messages with sequence-bound AAD.

### Enrollment Modes & Key-Burn Lifecycle

```
[Hub: wtf enroll-token] ---> (Token: SHA-256 hashed at rest, TTL)
                                     |
                                     v
[Agent: wtf enroll --token] -> [Hub verifies & BURNS token] -> [Device Key stored 0600]
                                     |
                                     v (Token destroyed: replay attempts return 403)
```

#### Mode A: Ephemeral Single-Use Token (`wtf enroll-token` — Burn on Use)
1. **Hub mints token:**
   ```bash
   wtf enroll-token <device-name> [--ttl 600]
   # Generates one-time token; persists only SHA-256(token) in $WTF_HOME/enroll_tokens.json (0600).
   ```
2. **Agent redeems token:**
   ```bash
   wtf enroll --url http://HUB:7800 --name <device-name> --token <token>
   ```
3. **Immediate Burn:** Upon successful enrollment, the hub **burns the token immediately** (`used: true`, purged from available pool). Any subsequent attempt with the same token fails with uniform `403 Forbidden`.

#### Mode B: Signed PSK Handshake (`wtf enroll --psk` — Zero-Exposure)
1. **Hub exposes site secret:**
   ```bash
   wtf enroll-secret
   # Prints 256-bit site PSK. Rotate anytime with: wtf enroll-secret --rotate
   ```
2. **Agent completes zero-exposure handshake:**
   ```bash
   wtf enroll --url http://HUB:7800 --name <device-name> --psk <site-secret>
   ```
   - Agent generates local ML-KEM-768 keypair.
   - Proves possession of PSK via HMAC-SHA256 over `(name, ek, timestamp, nonce)`. The secret never crosses the wire.
   - Hub verifies HMAC and returns the 64-hex device key **ML-KEM-768 sealed** to the agent's encapsulation key (`ek`).
   - Agent decapsulates the key directly into memory and writes local `bridge.json` (0600).
   - Rotating the secret (`wtf enroll-secret --rotate`) instantly invalidates all outstanding copies.

#### Mode C: PQC Secrets Lane (`pqc-secrets issue wtf`)
Automates secure bundle packaging:
```bash
pqc-secrets issue wtf <device-name>
# Mints CSPRNG device key, packs into ML-KEM-768 encrypted bundle as WTF_<NAME>_SECRET.
eval "$(pqc-secrets export | grep '^export WTF_<NAME>_SECRET=')"
```
Credentials load directly into runtime memory (`WTF_DEVICE_KEY`), bypassing plaintext disk storage.

### Hub Identity Persistence (`identities.json` 0600)
Device ML-KEM-768 public encapsulation keys persist in `$WTF_HOME/identities.json` (0600) and automatically rehydrate across hub restarts. Agents maintain cryptographic identity across reboot, sleep, and upgrades without re-enrollment churn.

### Singular Capability Access Plane (`/w/<capability>`)
- Hub mints an unguessable 64-hex capability in `$WTF_HOME/dashboard_capability` (0600).
- Canonical URL: `http://<host>:7800/w/<64-hex-capability>`.
- **Zero-Trust Security:** Requests missing valid capability or authorization header return uniform `404 Not Found` (eliminates auth oracles and timing leaks). Legacy `?k=` is retired.

---

## 3. Paired Federated Multi-Machine Shell & Distributed Compute

The hub pairs the **Chat Studio** side-by-side with the **Federated Multi-Machine Shell** (`src/fed_shell.rs`).

```
Operator / Agent
       |
       v
+-------------------------------------------------------------------------+
|                  FEDERATED MULTI-MACHINE SHELL ENGINE                   |
|                                                                         |
| Virtual Root: ~/                                                        |
|   ├── ~/mac         (LKGL: /Users/.../workspaces/project)               |
|   ├── ~/windows     (LKGL: D:/Code/project)                             |
|   └── ~/creeper-pi  (LKGL: /home/pi/sensor-node)                        |
|                                                                         |
| Compound Pipeline:                                                      |
|   cd ~/mac/frontend && npm test && cd ~/windows/backend && cargo test   |
+-------------------------------------------------------------------------+
```

### 1. Virtual Cluster Root (`~/`)
- Top-level virtual directory containing all enrolled cluster machines: `~/mac`, `~/windows`, `~/creeper-pi`, `~/linux`.
- Automatically normalizes path navigation across mixed POSIX and Windows hosts.

### 2. Architecture LKGL (Last Known Good Location)
- Persisted in `$WTF_HOME/lkgl.json` per machine architecture.
- Whenever a command runs in a machine directory, its native workspace path is remembered. Future commands automatically anchor execution to that machine's native project root.

### 3. Cross-Architecture Compound Pipelines
Execute chained multi-machine pipelines in a single compound command:
```bash
cd ~/mac/frontend && npm test && cd ~/windows/backend && cargo test
```
The shell engine parses compound operators (`&&`), switches execution contexts to the target machines, and interleaves color-coded output chips (`[mac]`, `[windows]`) into the unified stream.

### 4. Intelligent Distributed Compute Offloading
- `chat_run` accepts `machine: "<target-node>"`.
- Low-power edge nodes (e.g., Raspberry Pi walk-and-talk harness) can dispatch heavy compilation, testing, or model inference workloads to cluster heavyweights (e.g., workstation or Mac Studio), streaming logs back in real time.
- Synchronized federated OMP config (`$WTF_HOME/fed_omp_config.json`) maintains unified model parameters and fallback settings across the entire mesh.

---

## 4. Universal 11-Agent CLI Catalog & Local-Router Loopback

Headless tasks dispatched via the dashboard or MCP `chat_run` execute inside persistent, attachable tmux sessions (`wtf-chat-<slug>`).

### Agent CLI Catalog
1. **`auto`**: Intelligent cascade fallback (`dsh` -> `claude`/`fcc` -> `omp` -> `hermes` -> `codex` -> `opencode` -> `aider` -> `cline` -> `pi`).
2. **`fleet`**: DeepSeek Harness master-persona pipeline. Dispatches `dsh --profile headless` scoped tasks (structural edits, TDD reproduction, audits), chaining follow-up dispatches with discovered targets under orchestrate-subagent-masters.
3. **`claude` / `free-claude-code` (`fcc`)**: Claude Code headless execution.
4. **`omp`**: OhMyPy Python & generalist refactoring CLI (`omp "<prompt>"`).
5. **`hermes`**: Hermes autonomous agent CLI.
6. **`dsh`**: DeepSeek Harness one-shot engine (`dsh --profile headless "<task>"`), running the operator's dash-web configuration; `dsh --profile acp` serves persistent ACP sessions.
7. **`codex`**: OpenAI Codex CLI.
8. **`opencode`**: OpenCode multi-provider CLI.
9. **`aider`**: Aider git-integrated coding agent.
10. **`cline`**: Cline CLI harness.
11. **`pi`**: Edge low-power agent node.

### Singular Loopback Proxy Contract (`127.0.0.1:11434`)
- **Single Source of Inference:** ALL agent CLIs route through the local router proxy on port 11434:
  - OpenAI-compatible: `http://127.0.0.1:11434/v1`
  - Ollama / Anthropic: `http://127.0.0.1:11434`
  - Model: `local-router/fallback-models`
- Router manages context window limits, multimodal vision inputs, and seamless fallback routing across 3 attempts before terminal failure.

### Cross-Platform Execution Backend
The executor (`src/executor.rs`) auto-detects host capabilities:
- **`NativeTmux`**: Native POSIX tmux execution.
- **`WslTmux`**: Automatically converts Windows workspace paths (`D:\Code\...` -> `/mnt/d/Code/...`) and invokes execution inside WSL Ubuntu tmux.
- **`Direct`**: Subprocess fallback when tmux is unavailable.

### Dynamic Discovery
Probe locally available agents at runtime:
```bash
curl -sS "http://HUB:7800/api/v1/agents/available?cap=<capability>"
# Returns: {"ok":true,"agents":[{"id":"omp","name":"OhMyPy CLI","available":true},...]}
```

---

## 5. MCP Registration (Any Agent Harness)

Configure the stdio MCP bridge in any client configuration (`claude_desktop_config.json`, Cursor, Warp, etc.):

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

### 21 MCP Tools Surface (v0.15.2+)

| Tool | Key Arguments | Purpose & Execution Trigger |
|---|---|---|
| `check_in` | `status`, `task`, `details?`, `agent?`, `repo?` | Lifecycle boundaries: `working` (start), `blocked` (help needed), `done` (completed). |
| `log_event` | `message`, `level?`, `agent?`, `repo?` | Notable milestones, decisions, failures. Chain-of-draft format. |
| `wtf_is_going_on` | `agent?` | Orientation: inspect active peer tasks and states across all machines before starting. |
| `read_bin` | `bin` (1-3) | Pull clipboard content when instructed to "work from bin N". |
| `write_bin` | `bin` (1-3), `content` | Publish findings, specs, deliverables, or handoff context for peers. |
| `list_bins` | — | Inspect sizes, timestamps, and last writer across all three bins. |
| `hub_info` | — | Query hub URL, active device name, and version without secret exposure. |
| `env_report` | — | Inspect local toolchains and publish hardware/CLI profile to the hub. |
| `env_probe` | — | Inspect toolchain and hardware profiles of all connected cluster devices. |
| `session_create` | `name`, `repo?` | Initialize private ML-KEM-768 sealed channel; mints ephemeral pairing key. |
| `session_list` | `repo?` | List active encrypted chat lanes filtered by repository. |
| `session_join` | `session`, `pairing` | Join private channel using pairing key; auto-exchanges ML-KEM-768 identity. |
| `session_seal` | `session`, `member` | Explicitly seal session key package to a peer device identity. |
| `session_send` | `session`, `message` | Transmit AES-256-GCM encrypted message into private channel. |
| `session_read` | `session`, `after?` | Decrypt and retrieve private messages from channel. |
| `comms_post` | `session`, `event`, `note`, `scope?` | Append structured envelope (`checkin`, `update`, `intent-merge`, `checkout`, `handoff`). |
| `comms_read` | `session`, `after?`, `event?` | Read and format decrypted COMMS ledger entries. |
| `chat_run` | `prompt`, `agent?`, `repo?`, `workdir?`, `machine?` | Dispatch headless coding task to `wtf-chat-<slug>` tmux session. Supports remote execution. |
| `chat_sessions` | — | List active local executor tmux sessions. |
| `chat_session_lifecycle` | `session`, `action` | Manage executor panes (`open`, `close`, `reconnect`, `delete`). |
| `ping` | — | Unauthenticated connectivity probe against `/healthz`. |

---

## 6. Cross-System Agent Sessions & COMMS Ledger

### Orchestrator Protocol
Every agent harness connected to the MCP bridge adheres to the 5-phase coordination contract:

1. **Reconnaissance & Discovery:**
   - Call `session_list {repo: "<current-repo>"}` at task initiation.
   - **MATCH:** Join the existing channel via `session_join`, pull queued tasks, coordinate with peer agents, and report progress into the channel.
   - **NO MATCH:** Proceed locally. Do NOT invent or auto-create channels unless explicitly instructed by the operator.
2. **Channel Creation & Peer Pairing:**
   - When requested to start a cross-machine channel: `session_create {name, repo}`.
   - Surface the pairing key and hub URL to the operator.
   - Peer runs `session_join {session: "<id>", pairing: "<key>"}`.
   - Session keys are automatically sealed via ML-KEM-768 and recovered on first read.
3. **Structured COMMS Ledger (`comms_post` / `comms_read`):**
   - Enables fast, distributed coordination across worktrees and machines without waiting for git sync.
   - Envelope format: `wtf-comms-v1` JSON `{event, scope, note, ts}`.
   - Events: `checkin` -> `update` -> `intent-merge` -> `checkout` (plus `blocked`, `announce`, `handoff`).
4. **Confidentiality:**
   - Bins and events are PUBLIC to all enrolled cluster devices.
   - API keys, credentials, and sensitive customer data travel EXCLUSIVELY through ML-KEM-768 sealed session channels. Hub stores only ciphertext.

---

## 7. Shared Paste-Bins (Cross-Machine Courier)

Three persistent bins (1-3, 64 KiB each) act as the shared clipboard across human operators and agents:

- **Receiving Tasks:** Call `read_bin(bin=N)` before beginning work, then `check_in(status="working", task="...")`.
- **Publishing Deliverables:** `write_bin(bin=N, content="...")`, followed by `log_event("deliverable in bin N; ready")`.
- **Operator Courier (`wtf bin`, No Enrollment Needed):**
  ```bash
  WTF_CAPABILITY=<cap> wtf bin put 1 "<content>" --url http://HUB:7800
  WTF_CAPABILITY=<cap> wtf bin get 1 --url http://HUB:7800
  ```

---

## 8. Troubleshooting & Verification Runbook

| Symptom | Probable Root Cause | Resolution |
|---|---|---|
| HTTP 401 Unauthorized | Revoked/invalid device key, or clock skew >300s. | Check system clock (`date`). Re-issue device credentials via `wtf enroll-token` or `wtf enroll --psk`. |
| HTTP 404 Not Found | Accessing `/` or malformed capability link. | Use singular capability URL from `wtf dashboard-url` (`/w/<64-hex>`). |
| Connection Refused | Hub daemon inactive or listening on wrong interface. | Verify hub: `curl -sS http://localhost:7800/healthz`. Start: `tmux new -d -s wtf-hub 'wtf serve --no-open'`. |
| WSL2 Hub Unreachable from LAN | WSL2 NAT isolation. | Add Windows portproxy: `netsh interface portproxy add v4tov4 listenport=7800 listenaddress=0.0.0.0 connectport=7800 connectaddress=<wsl-ip>`. |
| `bin content too large` | Payload exceeds 64 KiB ceiling. | Compress or segment payload across multiple bins. |
| Agent Execution Fails | Requested CLI engine missing or proxy offline. | Check `GET /api/v1/agents/available`. Ensure local router is active on port 11434. |

### End-to-End Verification Health Check
```bash
curl -sS http://localhost:7800/healthz
wtf status
wtf dashboard-url
```
All checks green confirms the node is fully enrolled, synchronized, and operational across the federated mesh.
