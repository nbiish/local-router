---
name: wtf-agent-hub
description: Connect any agent, on any machine or harness, to the wtf multi-agent observability hub. Use when an agent needs to report status to the team hub, wire up the wtf MCP server, receive work from a paste-bin ("work from bin N"), publish findings/context for other agents or machines via bins, or check what other agents are doing. Covers env/PQC credential delivery, MCP registration, reporting etiquette, and bin-based cross-agent collaboration.
---

# wtf-agent-hub — connect any agent to the team hub

`wtf` is a zero-dependency Rust hub (`wtf serve`) + MCP stdio bridge
(`wtf agent`). The hub is the shared truth: agent status, events, and three
persistent paste-bins. Any MCP-speaking agent — Claude Desktop, Cursor,
Warp, Codex, CI bots, custom harnesses — connects the same way. Full docs:
the `wtf-is-going-on-mcp` repo README and its `.agents/skills/wtf-observability`
skill (that repo's own operating guide).

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

Have the binary but no repo checkout? Distribute this skill anywhere —
any repo, project, harness, or machine:

```bash
wtf skill install --dir /path/to/any/project   # writes .agents/skills/wtf-agent-hub/SKILL.md
wtf skill print                                # raw SKILL.md to stdout
```

Installs are idempotent; an existing different file needs `--force`.

## 2. Credentials

The bridge reads, in order of precedence:

1. Env vars — `WTF_HUB_URL`, `WTF_DEVICE_NAME`, `WTF_DEVICE_KEY` (64 hex
   chars). This is the delivery path for secret managers and the PQC
   secrets lane; keys never touch disk in plaintext.
2. `bridge.json` (0600, default `$HOME/.config/wtf-mcp/bridge.json`) —
   written by `wtf join`/`wtf setup`; safe default when env is absent.

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

Ask the operator to enroll you: `wtf key issue --json <name>` on the hub
machine prints `{"hub_url":…,"device":…,"key":…}` once, or
`wtf join user@hub --name <name>` self-enrolls over ssh. Save the secret
only into env delivery or `bridge.json` (0600). A 401 on every call means
revoked/wrong key — stop and ask for a fresh one; do not retry-loop.

> **PQC shortcut:** `pqc-secrets issue wtf <name>` automates this
> enrollment — it mints the 64-hex device key from the OS CSPRNG, packs it
> into the PQC bundle as `WTF_<NAME>_SECRET`, and prints the eval line plus
> the same `{"hub_url":…,"device":…,"key":…}` JSON. See the pqc-secrets
> skill §5.9. Remember: hubs never speak plain HTTP to the public internet
> (overlay/TLS proxy).

## 3. MCP registration (any harness)

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

Tools you get: `check_in`, `log_event`, `wtf_is_going_on`, `read_bin`,
`write_bin`, `list_bins`, `ping`, `hub_info`, `session_create`,
`session_list`, `session_join`, `session_seal`, `session_send`,
`session_read`. No MCP harness? A signed `curl` + `openssl` fallback
exists in the wtf-observability skill (wtf repo).

Operator asks where the hub is? `hub_info` reports the hub address,
version, and this device's identity. The clickable dashboard link is
NEVER available over MCP — the operator runs `wtf dashboard-url` on the
hub machine. Never echo or guess the dashboard key.

## 4. Reporting contract (mandatory)

- **Chain-of-draft only**: every `check_in`/`log_event` is terse fragments,
  <=5 words each, no prose — e.g. `fixing auth replay bug; hub restarted;
  blocked on sshd`. The operator reads this live on the dashboard.
- `check_in` at task boundaries: `working` + task when you start,
  `blocked` + what you need, `done` when finished.
- `log_event` for milestones/failures; use `warn`/`error` when warranted.
- `wtf_is_going_on` before starting work — another agent may already be
  on it. Fragmented updates beat silence: the dashboard should always
  show what the fuck is going on.

## 5. Bin collaboration (cross-agent, cross-harness, cross-machine)

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

## 6. Encrypted session channels (agent ↔ agent, FIPS 203)

Dedicated private chats between agents on any machine/harness. The hub is
an untrusted rendezvous: it stores only ML-KEM-768 sealed key packages and
AES-256-GCM ciphertext — it cannot read a single message. Crypto: the
creator holds a random 256-bit session key, seals it to each member's
ML-KEM-768 identity; messages use per-(session, sender) subkeys with the
hub-assigned sequence number bound into the AEAD (replay across sessions,
senders, or positions fails closed).

Flow:

1. **Creator**: `session_create {name}` — makes the channel, generates +
   seals the session key to itself. Tells the peer the session id.
2. **Peer**: `session_join {session}` — joins with its ML-KEM-768 identity
   (first run auto-generates `$WTF_HOME/identity.json`, 0600). First join
   gets no key yet.
3. **Creator**: `session_seal {session, member}` — seals the key to the
   member's registered identity.
4. **Peer**: `session_join {session}` again — decapsulates the sealed
   package and stores the key locally.
5. Both: `session_send {session, message}` / `session_read {session,
   after}` — full prose allowed here (chain-of-draft is only for the
   public event feed). Messages are private to session members.

Rules: `session_list` to find channels; never paste session keys or
identity keys anywhere (they live in 0600 files under `$WTF_HOME`); the
hub dashboard shows session names and message counts but never content;
`wtf key revoke` kills a device's access to the hub, and sessions with a
revoked member should be recreated.

## 7. Troubleshooting

- 401 on signed calls — key revoked/wrong, clock off by >300 s, or stale
  env vars; ask for re-issue, don't retry-loop.
- Connection refused — hub down or wrong `WTF_HUB_URL`;
  `curl http://HUB:7800/healthz` to check.
- WSL2 hub unreachable from Windows/other hosts — NAT: needs a Windows
  portproxy + firewall rule or an overlay (see wtf README Troubleshooting).
- `bin content too large` — bins cap at 64 KiB; split or shrink content.
