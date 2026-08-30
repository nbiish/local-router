---
name: agent-integration
description: How to wire pqc-secrets into Claude Code, Hermes MCP, VS Code, Cursor, and shell wrappers. With the right and wrong ways to inject secrets.
---

# Agent Integration

How to wire PQC secrets into the agent tools and IDEs you use every
day. **The pattern is always the same:** the agent's config file
references the env var by name but does NOT contain the value; the
value is injected at process start from the encrypted bundle.

## §1 Hermes MCP (betterbrowsermcp)

The `@nbiish/betterbrowsermcp` MCP server (v0.7.0+ rotates v0.8.0+)
exposes 10 PQC tools directly to any Hermes agent. No shell
wrapper required. See `references/mcp-tool-surface.md` for the
full per-tool reference (parameters, responses, audit events).

### Setup

`~/.hermes/config.yaml`:

```yaml
mcp_servers:
  betterbrowsermcp:
    command: node
    args:
      - /path/to/betterbrowsermcp/dist/index.js
    env:
      BROWSER_MCP_AGENT_ID: hermes
      BROWSER_MCP_PORT: '9109'
      # Optional: full path to the pqc-secrets binary. The MCP
      # server spawns this binary to read/write the bundle.
      # Defaults to ~/code/ainish-coder/bin/pqc-secrets. Set
      # this when the MCP server runs in a context with a
      # stripped PATH (Claude Code, Cursor, MCP launched from
      # Dock/Finder).
      BROWSER_MCP_PQC_SECRETS_BIN: /Users/nbiish/code/ainish-coder/bin/pqc-secrets
      # Optional: macOS Keychain account name. Defaults to
      # 'pqc-secrets-key' (the standard name from
      # pqc-secrets keygen). Override only if your keychain
      # entry uses a different name.
      PQC_KEYCHAIN_ACCOUNT: pqc-secrets-key
```

Add `betterbrowsermcp` to `platform_toolsets.cli` in the same file
(or to `telegram` if you also use the Telegram channel). Then in
Hermes: `/reload-mcp` (in the TUI input box — NOT a terminal) to
restart the MCP children.

### Tool surface (10 tools)

| Tool | Purpose |
|---|---|
| `browser_secrets_status` | Check keychain + bundle health. Returns JSON. |
| `browser_secrets_list` | List secret **names** (no values). |
| `browser_secrets_get` | Read one secret value. Optional `mode: 'plain'\|'redact'`. |
| `browser_secrets_load` | Bulk-export bundle into the page's `window.__bbmcpSecrets__` scope. |
| `browser_secrets_add` | Add a new secret. Optional `dry_run: true`. |
| `browser_secrets_add_from_clipboard` | Pull a value from the system clipboard. |
| `browser_secrets_unlock_agent` | Cache one secret value in agent memory for fast reads. |
| `browser_secrets_lock_agent` | Clear a cached secret (or wipe all). |
| `browser_secrets_copy_to_page` | Paste a secret into a focused form field. |
| `browser_secrets_rotate` | Re-encrypt the bundle with a fresh data key + KEM shared secret. Identity key in keychain stays. |

### Usage example

```
LLM: "Check if the bundle is healthy."
→ browser_secrets_status
← {"keychainOk":true,"recipientFp":"sha3:19df3b3f86de13a9...","nKeys":15,"createdUtc":"2026-06-10T..."}

LLM: "What API keys do I have?"
→ browser_secrets_list
← "Found 15 secret(s) in the PQC bundle:\n  - CLINE_API_KEY\n  - COMMANDCODE_API_KEY\n  - KILO_API_KEY\n  ..."

LLM: "Show me the Stripe secret."
→ browser_secrets_get(name="STRIPE_SECRET", mode="plain")
← "STRIPE_SECRET = sk-live-AbCd..."
```

### Audit trail

Every call is recorded in `~/.config/pqc-secrets/audit.log` (see
`references/audit-log.md`). The user can verify "did my agent read
X at Y time?" by `grep`-ing the log. The value is NEVER logged
— only the SHA3-256 fingerprint (first 16 hex chars).

### Design directive: availability first

These tools are designed to be called freely by agents with **no
human-in-the-loop gatekeeping**:
- No auth tokens
- No redaction-by-default
- No required `tabId` for non-browser-context operations
- Per-tab operations require `tabId` because it's the cache key
  or paste target, not a gate

See `references/mcp-tool-surface.md` §"Design directive" for the
full rationale.

## §2 Claude Code

Claude Code reads `~/.claude/settings.json` and per-project
`~/.claude/projects/*/settings.json`. These files are JSON, often
committed to dotfiles repos. **They must not contain secret values.**

### WRONG — PQC violation

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-api03-AbCd1234...",
    "OPENAI_API_KEY": "sk-proj-EfGh5678..."
  }
}
```

The keys are in plaintext on disk. They will sync to cloud backup,
get committed to a public dotfiles repo, be readable by any process
with file permissions, and persist forever in shell history.

### RIGHT — empty in settings, keychain-injected

`~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://zenmux.ai/api/anthropic",
    "ANTHROPIC_API_KEY": "",
    "OPENAI_API_KEY": ""
  }
}
```

`~/.zshrc` (sourced before `claude` is launched):

```bash
secrets-load() {
  eval "$(pqc-secrets export)"
}
```

Launch Claude Code after `secrets-load`:

```bash
$ secrets-load
$ claude
```

The values are in process memory (volatile), not in any file. The
settings file has empty strings; the real values live in the
encrypted bundle and the keychain.

### Per-project overrides

If you need a different key for a specific project (e.g., a sandbox
OpenAI key), use a project-level wrapper:

```bash
# In the project directory, a Makefile target:
.PHONY: launch-claude
launch-claude:
	secrets-load && \
	OPENAI_API_KEY=$$OPENAI_API_KEY_SANDBOX claude
```

(Where `OPENAI_API_KEY_SANDBOX` is a separate bundle key.)

## §3 VS Code / Cursor

### WRONG — `.vscode/launch.json` env block

```json
{
  "configurations": [{
    "type": "node",
    "request": "launch",
    "env": {
      "API_KEY": "sk-AbCd1234..."
    }
  }]
}
```

### RIGHT — `${env:API_KEY}` with a pre-launch task

`.vscode/launch.json`:

```json
{
  "configurations": [{
    "type": "node",
    "request": "launch",
    "preLaunchTask": "secrets-load",
    "env": {
      "API_KEY": "${env:API_KEY}"
    }
  }]
}
```

`.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [{
    "label": "secrets-load",
    "type": "shell",
    "command": "bash -c 'eval \"$(pqc-secrets export)\" && env | grep -E '^[A-Z_]+=' > /tmp/vscode-env'",
    "presentation": { "reveal": "silent" }
  }]
}
```

The env vars are in `/tmp/vscode-env` for the launch duration. Not
great, but acceptable for local dev. For higher security, use a
VS Code extension that calls `pqc-secrets export` directly and
passes the values to the debug target in memory.

## §4 Ainish-coder / generic shell wrapper

The `secrets-load` shell function (in `~/.zshrc` or `~/.bashrc`):

```bash
secrets-load() {
  local line
  while IFS= read -r line; do
    [[ "$line" =~ ^export ]] || continue
    eval "$line"
  done < <(pqc-secrets export)
}
```

Use it before launching any tool that needs secrets:

```bash
$ secrets-load
$ claude         # inherits $ANTHROPIC_API_KEY
$ cursor         # inherits $ANTHROPIC_API_KEY
$ opencode       # inherits $ANTHROPIC_API_KEY
```

The values are in process memory (volatile), not in any file. They
are gone when the shell exits.

### Wrapper for one-off commands

If you only need secrets for a single command, use a subshell:

```bash
$ (eval "$(pqc-secrets export)" && my-tool --api-key=$MY_API_KEY)
```

The secrets are loaded, the tool runs, the subshell exits, and the
secrets are gone.

## §5 GitHub Actions (CI)

GitHub Actions secrets are encrypted at rest by GitHub and injected
into the runner's env. This is **acceptable for CI** but has
limitations:

```yaml
# .github/workflows/deploy.yml
env:
  API_KEY: ${{ secrets.API_KEY }}
```

**Limitations:**
- Every developer with repo access can see and modify `secrets.API_KEY`
  in the GitHub UI.
- Secrets are visible in the Actions log if accidentally `echo`'d.

For higher-security deployments, use an external secrets manager
(HashiCorp Vault, AWS Secrets Manager) that the CI calls at runtime:

```yaml
- name: Fetch secret from Vault
  run: |
    API_KEY=$(vault kv get -field=value secret/myapp/api-key)
    echo "::add-mask::$API_KEY"
    my-tool --api-key=$API_KEY
```

`::add-mask::` prevents the secret from being printed in logs.

## §6 Docker / docker-compose

### WRONG — `env_file:`

```yaml
services:
  app:
    env_file: ./secrets.env  # plaintext on disk
```

### RIGHT — runtime injection

```bash
# Inject from pqc-secrets at runtime
docker run -e API_KEY=$(pqc-secrets export | grep API_KEY | cut -d= -f2- | tr -d '"') my-image
```

Or with docker-compose:

```bash
# In a wrapper script
docker-compose up -e API_KEY=$(eval "$(pqc-secrets export)" && echo $API_KEY)
```

For higher security, use Docker secrets (mounted volumes):

```yaml
services:
  app:
    volumes:
      - /run/secrets/api_key:/run/secrets/api_key:ro
```

```bash
# Provision the secret file from pqc-secrets
mkdir -p /run/secrets
pqc-secrets export | grep API_KEY | cut -d= -f2- | tr -d '"' > /run/secrets/api_key
chmod 600 /run/secrets/api_key
```

The file is gone when the container exits. (Or use tmpfs.)

## §7 See also

- `SKILL.md` §7 (Agent Integration Recipes) — same content, abbreviated
- `references/pqc-secrets-cli.md` — CLI reference
- `references/audit-log.md` — audit log format
- `references/rotation-procedure.md` — rotation runbook
