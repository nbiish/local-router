---
name: mcp-tool-surface
description: The 10 browser_secrets_* MCP tools exposed by @nbiish/betterbrowsermcp v0.7.0+. Parameters, return shapes, audit log events, and availability-first design notes. The canonical reference for the MCP surface.
---

# betterbrowsermcp — `browser_secrets_*` Tool Surface

The `@nbiish/betterbrowsermcp` MCP server (v0.7.0+) wraps the
`pqc-secrets` Rust CLI and exposes 10 tools to any MCP client
(Hermes, Claude Code, Cursor, etc.). This is the canonical
reference for the tool surface — when tools are added or
parameters change, update this file.

**Server invocation:**
```bash
BROWSER_MCP_AGENT_ID=hermes \
BROWSER_MCP_PORT=9109 \
BROWSER_MCP_PQC_SECRETS_BIN=/Users/nbiish/code/ainish-coder/bin/pqc-secrets \
node /path/to/betterbrowsermcp/dist/index.js
```

- `BROWSER_MCP_AGENT_ID` (required) — unique per agent. Server
  listens on `/ws/<agent-id>` on `BROWSER_MCP_PORT`.
- `BROWSER_MCP_PORT` (required) — per-agent WebSocket port.
- `BROWSER_MCP_PQC_SECRETS_BIN` (optional) — full path to the
  `pqc-secrets` binary. Defaults to
  `~/code/ainish-coder/bin/pqc-secrets`. Set this when the MCP
  server runs in a context with a stripped `PATH` (Claude Code,
  Cursor, MCP launched from Dock/Finder).

**Bundle location:** `~/.config/pqc-secrets/secrets.bundle.json`
**ML-KEM-768 private key:** macOS Keychain,
`service=pqc-secrets, account=pqc-secrets-key` (override with
`PQC_KEYCHAIN_ACCOUNT` env var).

---

## The 10 tools

### 1. `browser_secrets_status`

```jsonc
// request
{ "name": "browser_secrets_status", "arguments": {} }

// response
{
  "keychainOk": true,        // macOS Keychain reachable?
  "recipientFp": "sha3:...",  // first 16 hex of ML-KEM-768 pubkey SHA3-256
  "nKeys": 13,
  "createdUtc": "2026-06-08T00:42:22Z"
}
```

**Audit event:** `status` (one line per call).

---

### 2. `browser_secrets_list`

```jsonc
// response (text content)
"Found 13 secret(s) in the PQC bundle:\n  - CLINE_API_KEY\n  - MODAL_API_KEY\n  ..."
```

**Audit event:** `list` (one line per call).

---

### 3. `browser_secrets_get`

```jsonc
// arguments
{
  "name": "STRIPE_SECRET",       // required
  "mode": "plain"                // optional: "plain" (default) | "redact"
}

// mode=plain response
"STRIPE_SECRET = sk-live-AbCd...\n\n(Returned as plain text. Do not
echo this value to logs or commit it. For ongoing use across many
tool calls in this session, prefer `browser_secrets_unlock_agent`
so the value lives in the server's process memory rather than the
conversation history.)"

// mode=redact response
"<redacted: STRIPE_SECRET length=107>\n\n(Redacted mode: value is
not returned. Use mode='plain' to retrieve the actual value.)"
```

**Audit event:** `get mode=plain name=X value-fp=sha3:...` (or
`mode=redact` without the value-fp).

---

### 4. `browser_secrets_load`

Loads all (or named) secrets into the page's `window.__bbmcpSecrets__`
scope as a frozen read-only object, then fires
`bbmcp:secrets-loaded` CustomEvent. Does NOT trigger any paste.

```jsonc
// arguments
{ "names": ["STRIPE_SECRET", "GH_TOKEN"] }  // optional, all if omitted
```

**Audit event:** `load` with the names loaded.

---

### 5. `browser_secrets_add`

```jsonc
// arguments
{
  "name": "STRIPE_SECRET",        // required
  "value": "sk-live-...",         // required
  "merge": true,                  // optional, default true
  "dry_run": false                // optional, default false
}

// dry_run=true response
"DRY RUN — no changes written.\nAction: Added new \"STRIPE_SECRET\"
(length 32)\nDiff: +1 added, ~0 modified, =0 unchanged\nResulting
bundle would have 14 secret(s).\n\nRe-run with dry_run=false (or
omit it) to actually write."

// dry_run=false response (success)
"Added secret \"STRIPE_SECRET\" to the PQC bundle (14 total now).\n
Bundle re-encrypted at /Users/nbiish/.config/pqc-secrets/secrets.bundle.json."
```

**Audit event:** `add name=X merge=true; total=N; value-fp=sha3:...`
(or `merge=false` if replacing the entire bundle).

---

### 6. `browser_secrets_add_from_clipboard`

Reads the system clipboard as the value. Useful for capturing a
key from a dashboard (Stripe, GitHub, OpenAI, etc.) without
echoing it through the conversation.

```jsonc
// arguments
{ "name": "STRIPE_SECRET" }  // required
```

**Audit event:** `add_from_clipboard name=X value-fp=sha3:...`.

---

### 7. `browser_secrets_unlock_agent`

Caches a secret's value in the MCP server's process memory for a
specific tab. Subsequent `browser_secrets_copy_to_page` calls for
the same tab use the cached value (avoids re-decrypting through
the conversation history).

```jsonc
// arguments
{
  "name": "STRIPE_SECRET",  // required
  "tabId": 12345            // required, number
}
```

**Audit event:** `unlock name=X tab=N value-fp=sha3:...`.

---

### 8. `browser_secrets_lock_agent`

```jsonc
// arguments
{
  "tabId": 12345,            // required
  "name": "STRIPE_SECRET"    // optional: lock one, omit to lock all
}
```

**Audit event:** `lock name=X tab=N` (or `lock tab=N detail=all-unlocked-cleared`).

---

### 9. `browser_secrets_copy_to_page`

Atomic: read a secret (from unlocked cache or bundle) and paste it
into a form field on the page. Server-side straight to the content
script — value never passes through conversation history.

```jsonc
// arguments
{
  "name": "STRIPE_SECRET",     // required
  "ref": "@e42",               // optional
  "element": "API key field",  // optional, required if ref set
  "tabId": 12345               // required
}
```

**Audit event:** `copy_to_page name=X tab=N value-fp=sha3:... ref=...`
on success, or `copy_to_page name=X tab=N error=...` on failure.

---

### 10. `browser_secrets_rotate` (v0.8.0+)

Re-encrypts the entire bundle with a fresh data key + KEM shared
secret. The identity ML-KEM-768 keypair in the keychain stays.
The previous bundle is preserved as
`secrets.bundle.json.bak.<UTC>` for a 7-day grace period.

```jsonc
// arguments
{}  // no parameters

// response
"Rotated PQC bundle.\nOld fingerprint: sha3:...\nNew fingerprint:
sha3:...\nPrevious bundle backed up to
/Users/nbiish/.config/pqc-secrets/secrets.bundle.json.bak.2026-06-10T...
(retain for 7 days, then delete with: rm <path>).\n13 secret(s)
re-encrypted with a fresh data key and a fresh ML-KEM-768
shared secret. The identity keypair in the keychain is unchanged."
```

**Audit event:** `rotate name=- tab=- old=sha3:...; new=sha3:...;
count=N; backup=<path>`.

**Note:** this rotates the data key + KEM shared secret. For a
**full identity rotation** (re-keygen the ML-KEM-768 keypair,
re-encrypt under the new pubkey), use the out-of-band ceremony
in `references/rotation-procedure.md` §6.2.

---

## Design directive: availability first

These tools are designed to be called freely by agents with **no
human-in-the-loop gatekeeping**. Specifically:

- **No auth tokens.** The LLM is trusted to read its user's
  secrets. The audit log captures every read.
- **No redaction-by-default.** `mode='plain'` is the default.
  `mode='redact'` is a helper for LLM summary work, not a
  security gate.
- **No required `tabId` for non-browser-context operations.**
  `add`, `rotate`, `list`, `get`, `status` can be called from
  any context (cron job, setup script, MCP server boot) without
  a tabId.
- **Per-tab operations require `tabId`** because it's the **cache
  key** (unlock/lock) or the **paste target** (copy_to_page), not
  a gate.

The **safety surface** is the audit log + `browser_secrets_rotate`'s
auto-backup, not a human-in-the-loop prompt.

---

## What changed in v0.8.0

- **New tool:** `browser_secrets_rotate` (10th tool)
- **New module:** `src/audit.ts` — append-only audit log at
  `~/.config/pqc-secrets/audit.log` mode 0o600
- **New params:** `secrets_get.mode=plain|redact`,
  `secrets_add.dry_run`
- **Bug fix:** `secrets_add` was broken since v0.7.0 due to a
  dead `execFile("pack")` call (no stdin → "No secrets found"
  → throws). Removed; the spawn block does the real work.
- **New env var:** `BROWSER_MCP_PQC_SECRETS_BIN` for the binary path.
- **Documentation:** this file, plus the audit log format
  reference at `references/audit-log.md`.

## What changed in v0.7.0

- 9 `browser_secrets_*` tools shipped (status, list, get, load,
  add, add_from_clipboard, unlock_agent, lock_agent, copy_to_page).
- The `pqc-secrets` Rust CLI was integrated (FIPS 203 ML-KEM-768
  + AES-256-GCM).
- `secrets_load` content-script handler on the extension side:
  pushes frozen `window.__bbmcpSecrets__` + fires
  `bbmcp:secrets-loaded` CustomEvent.
