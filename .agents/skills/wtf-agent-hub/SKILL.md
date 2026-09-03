---
name: wtf-agent-hub
description: Connect any agent, on any machine or harness, to the wtf multi-agent observability hub. Use when an agent needs to report status to the team hub, wire up the wtf MCP server, receive work from a paste-bin ("work from bin N"), publish findings/context for other agents or machines via bins, orchestrate multi-machine release commands in the federated shell, or check what other agents are doing. Covers env/PQC credential delivery, MCP registration, reporting etiquette, bin-based cross-agent collaboration, the v0.15.2 SWE-bench coding fleet executor (chat_run: per-chat tmux sessions running the fcc-omp-trae-mini fallback cascade via local-router:11434), singular capability dashboard URL (/w/<capability>), architecture LKGL tracking, and the paired Federated Multi-Machine Shell.
---

# wtf-agent-hub — connect any agent to the team hub

`wtf` is a zero-dependency Rust hub (`wtf serve`) + MCP stdio bridge
(`wtf agent`). The hub is the shared truth: agent status, events, three
persistent paste-bins, the federated repo chats (dashboard SESSIONS card),
and the paired Federated Multi-Machine Shell. Dispatched agent tasks run
via the SWE-bench Coding Fleet executor. Any MCP-speaking agent — Claude
Desktop, Cursor, Warp, Codex, CI bots, custom harnesses — connects the
same way. Full docs: the `wtf-is-going-on-mcp` repo README and its
`.agents/skills/wtf-observability` skill (that repo's own operating guide).

Non-negotiables: never log, echo, or commit device keys or the dashboard
key; never put secrets in events or bins; never port-forward plain HTTP to
the public internet (use an overlay or a TLS proxy).

## 1. Get the binary

```bash
command -v wtf                                                # installed?
cargo build --release --manifest-path /path/to/wtf-is-going-on-mcp/Cargo.toml
# binary: /path/to/wtf-is-going-on-mcp/target/release/wtf
```

The build needs only a Rust toolchain — zero external crates, fully
offline. Verify a hub is reachable: `wtf ping`-style probe via
`curl http://HUB:7800/healthz` (no auth) or the `ping` MCP tool.

**Zero-config join (v0.15.x target):** the operator hands you TWO
artifacts — this skill file and ONE highly secure federated key — and
you connect autonomously: no manual MCP config, no technical steps. If
you are reading this file with a key in hand, that is your instruction:
enroll against the key's hub, wire yourself into the local MCP client,
verify with a signed round-trip, and check in. Simple for non-technical
users; full control (env vars, bridge.json, manual MCP registration)
for advanced users in the sections below.

Have the binary but no repo checkout? Distribute this skill anywhere —
any repo, project, harness, or machine:

```bash
wtf skill install --dir /path/to/any/project   # writes .agents/skills/wtf-agent-hub/SKILL.md
wtf skill print                                # raw SKILL.md to stdout
```

Installs are idempotent; an existing different file needs `--force`.

## 2. Credentials & Dashboard Access

The bridge reads, in order of precedence:

1. Env vars — `WTF_HUB_URL`, `WTF_DEVICE_NAME`, `WTF_DEVICE_KEY` (64 hex
   chars). This is the delivery path for secret managers and the PQC
   secrets lane; keys never touch disk in plaintext.
2. `bridge.json` (0600, default `$HOME/.config/wtf-mcp/bridge.json`) —
   written by `wtf join`/`wtf setup`; safe default when env is absent.

### Singular Capability Dashboard URL (`/w/<capability>`)

In v0.15.1+, the hub serves a singular, unguessable 64-hex capability URL:
```bash
wtf dashboard-url
# Output: http://<host>:7800/w/<64-hex-capability>
```
- **Uniform security:** Serves universally across loopback, LAN, and reverse
  proxies with zero query-string secret leakage.
- **Fail-closed:** Any unauthorized or malformed capability request returns
  a uniform `404 Not Found` without information leakage.
- **Constant-time:** Authenticated constantly in-memory using constant-time
  comparison against `$WTF_HOME/dashboard_capability` (0600).

### PQC secrets lane (preferred where available)

Device keys ride inside a PQC (FIPS 203/204/205) bundle as a packed env
var `WTF_<NAME>_SECRET`; unpack just that lane:

```bash
export WTF_HUB_URL=http://HUB:7800
export WTF_DEVICE_NAME=<device-name>
eval "$(pqc-secrets export | grep '^export WTF_<NAME>_SECRET=')"
```

Then launch the MCP client as usual — the bridge picks up `WTF_*` first.
No key material is written to disk.

### No device yet?

Ask the operator to enroll you. Best options, in order:

1. **Signed handshake (v0.9.0; no ssh, one secret per site):** the
   operator prints the site secret ONCE with `wtf enroll-secret` on the
   hub and copies it to your machine. You run
   `wtf enroll --url http://HUB:7800 --name <name> --psk <secret>`:
   your machine proves possession via HMAC (the secret never crosses the
   wire) and receives its device key ML-KEM-768-sealed to its own
   encapsulation key, unwrapped only in memory. Hub and device clocks
   must agree within ±5 min. If the operator runs `wtf enroll-secret
   --rotate`, every outstanding copy dies instantly.
2. **One-time token (v0.8.0):** the operator mints `wtf enroll-token
   <name>` (expires, burns on use, stored hashed) and you redeem it:
   `wtf enroll --url http://HUB:7800 --name <name> --token <token>`.
3. `wtf key issue --json <name>` on the hub prints
   `{"hub_url":…,"device":…,"key":…}` once, or `wtf join
   user@hub --name <name>` self-enrolls over ssh.

Any of these writes `bridge.json` and verifies with a signed round-trip.
Save the secret only into env delivery or `bridge.json` (0600). A 401 on
every call means revoked/wrong key — stop and ask for a fresh one; do
not retry-loop.

> **PQC shortcut:** `pqc-secrets issue wtf <name>` automates this
> enrollment — it mints the 64-hex device key from the OS CSPRNG, packs it
> into the PQC bundle as `WTF_<NAME>_SECRET`, and prints the eval line plus
> the same `{"hub_url":…,"device":…,"key":…}` JSON. See the pqc-secrets
> skill §5.9. Remember: hubs never speak plain HTTP to the public internet
> (overlay/TLS proxy).

## 3. Agent CLIs & SWE-bench Coding Fleet (Headless Execution)

Tasks handed to a repo chat run headlessly via the SWE-bench Verified
Coding Fleet cascade:

1. **FreeClaudeCode (`free-claude-code`)**: Free Claude Code server + Claude system.
2. **OhMyPy CLI (`omp`)**: Python & generalist refactoring CLI.
   Check: `command -v omp`. Non-interactive: `omp "<task prompt>"`.
3. **Trae CLI (`trae-cli`)** — **AST Refactoring Master**:
   Top SWE-bench structural performer. Executes surgical AST refactoring,
   multi-file symbol renaming, and clean unified diffs (`trae-cli run -f <task.md>`).
4. **Mini-SWE (`mini` / `mini-live`)** — **TDD Reproduction Engineer**:
   Top SWE-bench TDD performer. Zero-config test reproduction, dynamic runtime
   debug probes, and test hardening (`mini --task "<task>" --yolo --exit-immediately`).
5. **Fleet Mode (`agent: "fleet"`)**: Chained dual-engine pipeline where `trae-cli`
   performs structural AST refactoring and passes discovered target symbols to
   `mini` for test-driven hardening.

**Singular Model Routing Contract:**
ALL headless fleet engines route strictly through the singular loopback proxy:
`http://127.0.0.1:11434/v1` (`local-router/fallback-models`).
The router dynamically evaluates required context tokens and multimodal visual inputs,
bypassing models lacking required capacity across 3 retry passes before terminal failure.

**Cross-machine capability discovery:** `env_report` (run once per
machine) publishes this machine's CLI surface to the hub; `env_probe`
lists every device's report — check a remote machine's tooling before
configuring it. Presence + versions only, never credentials.

Rules: pick the first available or explicit agent; never block a task on
a missing brand; record which CLI ran the task (and the tmux session name + PID
for `wtf-chat-<slug>`) in task notes. Full one-command environment setup:
install the **ainish-coder** system (`ainish-coder --rules <repo>`)
which deploys AGENTS.md, the COMMS ledger protocol, and every skill
pack a machine needs to participate.

## 4. MCP registration (any harness)

Standard `mcpServers` shape; `command` must be absolute:

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

Tools you get (21, v0.15.1): `check_in`, `log_event`, `wtf_is_going_on`, `read_bin`,
`write_bin`, `list_bins`, `ping`, `hub_info`, `env_report`,
`env_probe`, `session_create`, `session_list`, `session_join`,
`session_seal`, `session_send`, `session_read`, `comms_post`,
`comms_read`, `chat_run`, `chat_sessions`, `chat_session_lifecycle`. The clickable
dashboard link is NEVER exposed over MCP — the operator runs `wtf dashboard-url`
on the hub machine. Never echo or guess the dashboard key.

## 5. Orchestrator Contract & Paired Studio / Federated Shell

ANY agent harness wired to this MCP acts as an orchestrator across
machines. The rules are mechanical — follow them on every task:

1. **Discover**: at task start call `session_list {repo: <current
   repository>}`.
   - **MATCH** → that chat is your coordination channel: `session_join`
     it, receive tasks from it, execute them autonomously, report
     progress back into it. Other machines' agents in the same chat are
     your collaborators.
   - **NO MATCH** → work locally. Do NOT create a chat, do NOT connect.
     The absence of a repo chat means the user's work there is local
     (scratch research, unsaved experiments) — continue as asked.
2. **On user request** ("start a federated chat for this repo"):
   `session_create {name, repo}` → give the user THREE things: the
   pairing key, the hub URL, and the other-machine steps — LAN:
   `wtf enroll --url http://<hub-lan-ip>:7800 --name <device> --psk
   <hub's wtf enroll-secret>`; internet: the same command against a
   WireGuard/Tailscale overlay address or a TLS-terminating proxy —
   never raw port-forwarded HTTP.
3. **Execute via Studio & Coding Fleet**:
   Tasks run headlessly via `chat_run {prompt, agent?, repo?, workdir?, timeout_secs?}`:
   it maps the task to ONE persistent tmux session `wtf-chat-<slug>` (attach:
   `tmux attach -t <name>` to watch live) and runs the fallback chain
   (`free-claude-code → omp → trae-cli → mini` or explicit `fleet`).
   `chat_sessions` lists active executor sessions; `chat_session_lifecycle`
   manages pane lifecycle (open/close/reconnect/delete).
4. **Paired Federated Multi-Machine Shell & Intelligent Distributed Compute**:
   The dashboard integrates a paired Federated Shell and distributed compute engine (`src/fed_shell.rs`):
   - **Virtual Root (`~/`)**: Contains directories for every connected machine
     (`~/mac`, `~/windows`, `~/creeper-pi`).
   - **Architecture LKGL Tracking**: Each architecture (`mac`, `windows`, `pi`, `linux`)
     persists its Last Known Good Location across sessions (`$WTF_HOME/lkgl.json`),
     ensuring commands and dispatched tasks automatically execute in their native project workspaces.
   - **Federated OMP Configuration (`fed_omp_config.json`)**: Synchronized shared
     model parameters (`local-router/fallback-models`), proxy endpoint (`127.0.0.1:11434`),
     and fallback cascade (`free-claude-code → omp → trae-cli → mini` or `fleet`).
   - **Intelligent Distributed Compute**: `chat_run` accepts `machine: "<name>"`. Any
     connected node (including low-power edge devices like a Raspberry Pi) can utilize the
     WTF MCP tools to dispatch heavy compilation, testing, or model synthesis workloads to
     the cluster's strongest compute node and stream results back.
   - **Cross-Architecture Multi-Prompt Orchestration**: Operators can execute
     chained multi-machine build/test pipelines in a single compound command:
     ```bash
     cd ~/mac/frontend && npm test && cd ~/windows/backend && cargo test
     ```
   - **Attributed Output**: Interleaves machine badge chips (`[mac]`, `[windows]`)
     directly in the terminal feed.
   - Backend routes: `GET /api/v1/shell/machines`, `GET/POST /api/v1/shell/config`, and `POST /api/v1/shell/exec`.
5. **Report**: progress, decisions, and failures go back into the repo
   chat (`session_send`/`comms_post`); chain-of-draft for the public
   event feed. Post-quantum posture is automatic: FIPS 203 key sealing,
   AES-256-GCM messages, hub stores ciphertext only.

## 6. Reporting contract (mandatory)

- **Chain-of-draft only**: every `check_in`/`log_event` is terse fragments,
  <=5 words each, no prose — e.g. `fixing auth replay bug; hub restarted;
  blocked on sshd`. The operator reads this live on the dashboard.
- `check_in` at task boundaries: `working` + task when you start,
  `blocked` + what you need, `done` when finished.
- `log_event` for milestones/failures; use `warn`/`error` when warranted.
- `wtf_is_going_on` before starting work — another agent may already be
  on it. Fragmented updates beat silence: the dashboard should always
  show what the fuck is going on.
- **Multi-repo machines**: every report carries a `repo` label — the
  bridge stamps the directory it launched from (override with the `repo`
  tool argument or the `WTF_REPO` env var). Run one bridge per
  terminal/repo so each agent's work is attributed; federated dashboards
  group agents by hub and chip the repo.

## 7. Bin collaboration (cross-agent, cross-harness, cross-machine)

Three bins (1-3, 64 KiB each) are the shared clipboard between the
operator and every agent on every machine. Bins persist across hub
restarts; every write lands in the event feed; the dashboard shows last
writer + age.

Receiving work:

- Told *"work from bin N"* (or picking up a peer handoff)? Call `read_bin`
  with that N **before starting**, then `check_in` with what you took.
- `list_bins` to see sizes/last-writer without pulling full content.

Publishing work (agent → agent, agent → operator):

1. `read_bin` the target first — writes replace the whole bin (last
   writer wins; don't clobber a peer's queued work without noting it).
2. `write_bin` with your full content (prompt, findings, spec, context).
3. `log_event` a chain-of-draft pointer — e.g. `findings in bin 2; done` —
   so peers and the operator know the bin changed.
4. Long reports go in a bin, not the event feed; events stay scannable.

Bin rules: no secrets ever (every device on the hub can read bins and
they persist to disk); no clobbering without note; one purpose per write;
say what changed when you hand off.

### Operator courier (`wtf bin`, no enrollment needed)

The operator uses the same bins as a copy/paste channel between machines
and agents — before any enrollment exists and any time after. From any
machine with a `wtf` binary (an empty `$WTF_HOME` is fine):

```bash
WTF_DASHBOARD_KEY=<key> wtf bin put 1 "<content>" --url http://HUB:7800
WTF_DASHBOARD_KEY=<key> wtf bin get 1 --url http://HUB:7800   # raw stdout
```

`put` accepts `--file F` or `-` (stdin); `get -o FILE` saves to a file.
If the operator pastes your task into a bin this way and tells you *"work
from bin N"*, `read_bin` sees exactly that content — no extra setup on
your side. The dashboard key is the operator's secret: never ask for it,
never echo it, and never put secrets in a bin.

## 8. Encrypted session channels (agent ↔ agent, FIPS 203)

Dedicated private chats between agents on any machine/harness. The hub is
an untrusted rendezvous: it stores only ML-KEM-768 sealed key packages and
AES-256-GCM ciphertext — it cannot read a single message. Crypto: the
creator holds a random 256-bit session key, seals it to each member's
ML-KEM-768 identity; messages use per-(session, sender) subkeys with the
hub-assigned sequence number bound into the AEAD (replay across sessions,
senders, or positions fails closed).

Pairing keys (v0.12.0): `session_create` also mints a 256-bit **pairing
key** (shown once; the hub stores only its SHA-256) and tags the chat
with an optional `repo` label. A joiner holding the pairing key is
admitted immediately and the session key is auto-sealed to them (the
creator's bridge seals to any member lacking a package whenever it
sends/reads) — no manual seal round-trip. `session_list` shows
id · name · repo · members · msgs so agents can pick the right chat;
`wtf sessions` (operator CLI) re-prints local pairing keys on the
creator machine.

Flow:

1. **Creator**: `session_create {name, repo?}` — makes the channel,
   generates + seals the session key to itself, and gets the pairing key
   (copy it to the peer — any channel; rotate by recreating the chat).
2. **Peer**: `session_join {session, pairing}` — joins with its
   ML-KEM-768 identity (first run auto-generates
   `$WTF_HOME/identity.json`, 0600) and presents the pairing key.
3. Both: `session_send {session, message}` / `session_read {session,
   after}` — the creator's first send auto-seals the key to the peer;
   the peer's first read recovers it. Full prose allowed here
   (chain-of-draft is only for the public event feed). Messages are
   private to session members.
   Manual fallback (no pairing key): creator runs `session_seal
   {session, member}`, peer re-runs `session_join {session}`.

Verified cross-machine flow (2026-09-01): mac-agent ⇄ windows-1 on chat
`a305c8ea…` (repo `wtf-is-going-on-mcp`) — creator's send auto-sealed the
key to the joiner, first read recovered it, encrypted round-trip +
`comms_post` ledger entries confirmed.

Studio & Chat View (v0.15.1): Embedded directly into the dashboard page
accessible at `/w/<capability>`. Members can view messages, create lanes,
and dispatch SWE-bench Coding Fleet tasks directly from the browser.

## 9. COMMS protocol — encrypted ledger channels (cross-repo, cross-machine)

COMMS is the structured layer over session channels: the fast, private
form of the `AGENTS/{date}.COMMS.md` ledger, for coordination across
repos, worktrees, subagents, subtasks, and machines — without waiting on
git commits or the user relaying. Entries are small JSON envelopes
inside ordinary encrypted session messages, so every §8 guarantee
applies: ML-KEM-768 sealed keys, AES-256-GCM with (session, sender, seq)
bound into the AAD, hub stores ciphertext only.

- `comms_post {session, event, note, scope?}` — post a ledger entry.
  `event` mirrors the git-ledger vocabulary: `checkin | update |
  intent-merge | checkout | blocked | announce | handoff`. `scope`
  names the repo/branch/worktree/task, e.g.
  `wtf-is-going-on-mcp/feat/comms-channels`.
- `comms_read {session, after?, event?}` — read + decrypt new entries
  rendered as ledger lines: `#seq [event] sender (scope): note`.
  Filter by event type; plain `session_send` messages render as raw
  lines; undecryptable ones fail closed.

Etiquette:

- Open a channel per coordination cluster (cross-machine task handoff,
  one per subtask) with the §8 handshake; share session ids in the event
  feed (`log_event`) — ids are not secrets, key material is.
- Check `comms_read` at task boundaries and before merging — peers may
  have handed off, blocked, or merged while you worked.
- Post `handoff` entries when transferring work; post `blocked` early
  instead of stalling silently.
- **Secrets mandate:** bins and the event feed are PUBLIC. Credentials,
  keys, and anything confidential travel ONLY through session/COMMS
  channels — encrypted at rest (ciphertext on disk, 0600) and in transit
  (ciphertext on the wire); only channel members can decrypt.
- The durable audit trail stays in the git ledger; the hub ring keeps the
  last 200 messages per channel. Commit the ledger for history; use
  COMMS for speed.

## 10. Troubleshooting

- 401 on signed calls — key revoked/wrong, clock off by >300 s, or stale
  env vars; ask for re-issue, don't retry-loop.
- Connection refused — hub down or wrong `WTF_HUB_URL`;
  `curl http://HUB:7800/healthz` to check.
- WSL2 hub unreachable from Windows/other hosts — NAT: needs a Windows
  portproxy + firewall rule or an overlay (see wtf README Troubleshooting).
- `bin content too large` — bins cap at 64 KiB; split or shrink content.
