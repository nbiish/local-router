---
name: audit-log
description: Format, retention, and verification use cases for ~/.config/pqc-secrets/audit.log. The verification surface for "what did my agent do with my secrets?"
---

# Audit Log Format

## Location and permissions

- **Path:** `~/.config/pqc-secrets/audit.log`
- **Mode:** `0o600` (owner read+write only) — set at file creation
  by `O_CREAT | O_APPEND` with mode 0o600; the file's mode is
  preserved across appends.
- **Created:** on first `secrets_*` call by the betterbrowsermcp
  MCP server (v0.8.0+).
- **Lifecycle:** append-only; never edited in place. The audit
  writer is non-blocking best-effort — the secret op succeeds even
  if the log write fails. Per the availability-first design, the
  user values "I can always read my secrets" over "I have a
  complete audit trail".

## Line format (TAB-separated)

```
<ISO8601-UTC>	<actor>	<action>	name=<NAME>	mode=<MODE>	tab=<TAB>	<detail>
```

- `<ISO8601-UTC>` — UTC ISO-8601 with millisecond precision
  (e.g. `2026-06-10T15:24:49.572Z`). Sortable.
- `<actor>` — `hermes` for the betterbrowsermcp MCP server
  (reserved for multi-actor future; no other actor writes
  today).
- `<action>` — one of: `get | list | add | add_from_clipboard |
  rotate | load | unlock | lock | copy_to_page | status | fail`.
- `name=<NAME>` — the secret name, or `-` if not applicable
  (rotate, list, status, load).
- `mode=<MODE>` — `plain | redact` for `get` events; `-` for
  everything else.
- `tab=<TAB>` — the browser tab id as a string, or `-` if not
  applicable.
- `<detail>` — free-form context, key=value pairs, present on
  most events.

**Fields are tab-separated, not space-separated.** Real lines
from a verified end-to-end test:

```
2026-06-10T15:24:49.572Z	hermes	add	name=BBMCP_TEST_KEY	mode=-	tab=-	merge=true; total=14; value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:12.001Z	hermes	get	name=BBMCP_TEST_KEY	mode=plain	tab=-	value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:13.402Z	hermes	get	name=BBMCP_TEST_KEY	mode=redact	tab=-
2026-06-10T15:25:30.118Z	hermes	unlock	name=BBMCP_TEST_KEY	mode=-	tab=42	value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:35.224Z	hermes	lock	name=BBMCP_TEST_KEY	mode=-	tab=42
2026-06-10T15:27:18.033Z	hermes	rotate	name=-	mode=-	tab=-	old=sha3:61b547a65b7c806a16b102133b99afa05750d0fc76dfbfc4903351be1eac88e2; new=sha3:6de4314e19c83b7555b46353c73088b098cc273a84a26f2f7c92f3843087fdbf; count=15; backup=/Users/nbiish/.config/pqc-secrets/secrets.bundle.json.bak.2026-06-10T15-27-18-012Z
```

## The `value-fp` field — value fingerprint, never the value

Every `get`, `unlock`, `add`, `add_from_clipboard`, and
`copy_to_page` event includes `value-fp=sha3:<16-hex-chars>` —
the first 16 hex chars of `SHA3-256(value)`. The value itself
is **NEVER** written to the audit log. This is enough to verify
"yes, the same value is in the bundle" without exposing the
value to anyone reading the log.

**How to verify a value with `value-fp`:**
```bash
echo -n "sk-live-AbCd..." | shasum -a 256 - | cut -c1-16
# → 549ab3b879785c99 (matches the audit log entry)
```

**Why fingerprints, not values:** audit logs are often synced to
backup systems, read by other tooling, and grep'd by humans. If
the value leaked through the audit log, the whole PQC system is
defeated. Fingerprints let you verify without leaking.

## What each event records

| Event | Records | Why |
|---|---|---|
| `get mode=plain` | name, value-fp | "I read this value at this time" |
| `get mode=redact` | name | "I confirmed a value exists, didn't read it" |
| `list` | (none beyond fixed fields) | "I enumerated the bundle at this time" |
| `add` | name, merge, total, value-fp | "I added/updated this value" |
| `add_from_clipboard` | name, value-fp | "I captured this value from the clipboard" |
| `unlock` | name, tab, value-fp | "I cached this value in process memory for tab N" |
| `lock` | name (or "all") + tab | "I cleared the cache" |
| `copy_to_page` | name, tab, value-fp, ref | "I pasted this value into form field ref" |
| `rotate` | old bundle fp, new bundle fp, count, backup path | "I re-keyed the bundle" |
| `load` | names loaded | "I pushed these into window.__bbmcpSecrets__" |
| `status` | (none beyond fixed fields) | "I checked bundle health" |

## Example grep recipes

```bash
# Last 20 reads of STRIPE_SECRET
grep 'name=STRIPE_SECRET' ~/.config/pqc-secrets/audit.log | tail -20

# All adds in 2026-06
grep -E '^[0-9-]+ hermes add' ~/.config/pqc-secrets/audit.log | grep 2026-06

# Last rotate
grep ' hermes rotate' ~/.config/pqc-secrets/audit.log | tail -1

# All copy_to_page events for tab 42 in the last hour
grep 'tab=42' ~/.config/pqc-secrets/audit.log | grep copy_to_page | tail -10

# Did anyone read ANTHROPIC_API_KEY today?
grep 'name=ANTHROPIC_API_KEY' ~/.config/pqc-secrets/audit.log | grep $(date -u +%Y-%m-%d)
```

## Retention

- Keep forever in the current file (`audit.log`) by default.
- Monthly archive to `audit.log.YYYY-MM` when file size exceeds
  10 MB (~125,000 events at ~80 bytes/line). See the
  `verify-bundle.py` companion script's `archive()` function
  for a reference implementation.
- The audit log is local. The user controls the retention
  policy — the system does NOT auto-delete.

## Implementation reference

The audit writer is in
`betterbrowsermcp/src/audit.ts` and exposes a single function:

```ts
import { logAuditEvent, valueFingerprint } from "../audit";
logAuditEvent({
  action: "get",
  mode: "plain",
  name: "STRIPE_SECRET",
  detail: `value-fp=${valueFingerprint(value)}`,
});
```

Wired into: `secretsGet`, `secretsAdd`, `secretsUnlockAgent`,
`secretsLockAgent`, `secretsCopyToPage` (success + failure),
`secretsRotate`. See `references/mcp-tool-surface.md` for the
full per-tool reference.

## Field meanings

| Field | When | Meaning |
|---|---|---|
| `actor` | always | `hermes` (the betterbrowsermcp MCP server). |
| `action` | always | The operation performed (see action table above). |
| `name=<n>` | per-secret ops | Name of the secret touched, or `-` if N/A. |
| `mode=<plain\|redact>` | get | Mode of the get operation, or `-`. |
| `tab=<id>` | tab-initiated | Bound tab id (string), or `-`. |
| `value-fp=<sha3:16hex>` | get, add, unlock, copy_to_page | SHA3-256 fingerprint (first 16 hex chars), NEVER the value. |
| `merge=<true\|false>` | add | Whether the add merged into the existing bundle. |
| `total=<n>` | add | Resulting total secret count. |
| `old=<sha3:...>; new=<sha3:...>` | rotate | Bundle fingerprints before and after the rotation. |
| `count=<n>` | rotate | Number of secrets re-encrypted. |
| `backup=<path>` | rotate | Path to the backup of the pre-rotation bundle. |
| `ref=<eN>` | copy_to_page | Snapshot ref of the target form field. |
| `error=<text>` | copy_to_page (failure) | Error message (truncated to 200 chars). |
| `detail=<text>` | lock (all) | `all-unlocked-cleared` when wiping the whole tab cache. |

## Verification use cases

### Did my agent read STRIPE_SECRET in the last hour?

```bash
$ grep 'name=STRIPE_SECRET' ~/.config/pqc-secrets/audit.log | tail -20
2026-06-10T15:25:12.001Z	hermes	get	name=STRIPE_SECRET	mode=plain	tab=-	value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:13.402Z	hermes	get	name=STRIPE_SECRET	mode=redact	tab=-
```

### What keys were added today?

```bash
$ grep -E '^[0-9-]+	hermes	add' ~/.config/pqc-secrets/audit.log | grep $(date -u +%Y-%m-%d)
2026-06-10T15:24:49.572Z	hermes	add	name=BBMCP_TEST_KEY	mode=-	tab=-	merge=true; total=14; value-fp=sha3:549ab3b879785c99
```

### When was the last rotation?

```bash
$ grep '	hermes	rotate	' ~/.config/pqc-secrets/audit.log | tail -1
2026-06-10T15:27:18.033Z	hermes	rotate	name=-	mode=-	tab=-	old=sha3:61b5...; new=sha3:6de4...; count=15; backup=/Users/nbiish/.config/pqc-secrets/secrets.bundle.json.bak.2026-06-10T15-27-18-012Z
```

### Are there any reads from an unfamiliar agent?

```bash
$ awk -F'\t' '{print $2}' ~/.config/pqc-secrets/audit.log | sort -u
hermes
```

A new agent name that you didn't expect = investigate. Today
only `hermes` writes (via the betterbrowsermcp MCP server). If
you see anything else, the bundle may have been touched by a
non-PQC tool.

### Cross-tab activity for a specific tab

```bash
$ grep '	tab=12345	' ~/.config/pqc-secrets/audit.log
2026-06-10T15:25:30.118Z	hermes	unlock	name=BBMCP_TEST_KEY	mode=-	tab=12345	value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:31.502Z	hermes	copy_to_page	name=BBMCP_TEST_KEY	mode=-	tab=12345	value-fp=sha3:549ab3b879785c99; ref=@e42
2026-06-10T15:25:35.224Z	hermes	lock	name=BBMCP_TEST_KEY	mode=-	tab=12345
```

### Verify a value matches what's in the bundle

```bash
$ grep 'name=STRIPE_SECRET' ~/.config/pqc-secrets/audit.log | tail -1
... value-fp=sha3:549ab3b879785c99 ...

$ echo -n 'sk-live-AbCdEf...' | shasum -a 256 - | cut -c1-16
549ab3b879785c99
# ↑ matches. The value in the bundle at that audit time is the
# value you have now.
```

## Threat model

The audit log is the **verification surface** for "what did my agent
do with my secrets?" It is intentionally not encrypted — the user
needs to read it without ceremony. The 0o600 mode prevents other
users on the system from reading it.

**The log does NOT log secret values.** Even a `mode=plain` `get`
event records `value-fp=sha3:...` but never the value. The user
verifies *that* a read happened and *which value fingerprint* was
in the bundle at that time, not *what* the value was.

If an attacker has read access to the log, they know which secret
names exist and when they're accessed — but not the values. This is
the same information an attacker with keychain access would have
anyway (they can run `pqc-secrets status`).

The `value-fp` field is the verification primitive: by computing
`SHA3-256(value)[:16]` of a candidate value and comparing against
the audit log, you can prove the value is consistent with the
bundle at that point in time. This is useful for:

- "Did my agent paste the right key into the form?" (compare
  the value-fp on the `copy_to_page` event with the value-fp of
  the key in the dashboard)
- "Has the key been rotated since I added it?" (compare
  the `add` value-fp with a later `get` value-fp)
- "Which version of the key is in the bundle right now?" (the
  most recent `add` or `get` value-fp for that name)

## See also

- `references/pqc-secrets-cli.md` — CLI reference
- `references/bundle-schema.md` — bundle file format
- `references/agent-integration.md` — how to wire PQC secrets
  into Claude Code, Hermes, VS Code, Cursor
- `references/mcp-tool-surface.md` — the 10 `browser_secrets_*`
  tools (parameters, responses, audit events)
- `references/rotation-procedure.md` — routine data-key rotation
  + out-of-band identity-rotation ceremony
- `references/rotation-procedure.md` — rotation runbook
