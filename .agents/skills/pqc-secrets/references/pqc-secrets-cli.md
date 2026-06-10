---
name: pqc-secrets-cli
description: Per-command reference for the pqc-secrets CLI. Exit codes, arguments, examples, and stderr format for every subcommand.
---

# pqc-secrets CLI Reference

`pqc-secrets <command> [args]` — the canonical command-line interface
for the PQC secrets management system.

**Bundle path:** `~/.config/pqc-secrets/secrets.bundle.json`
**Public key:** `~/.config/pqc-secrets/recipient.pub` (safe to commit)
**Private key:** OS keychain, service `pqc-secrets`, account `ml-kem-768`
**Audit log:** `~/.config/pqc-secrets/audit.log` (mode 0o600)

## Global flags

| Flag | Purpose |
|---|---|
| `--bundle PATH` | Override the default bundle location. |
| `--recipient-out PATH` | Override the default recipient.pub location (keygen). |
| `--quiet` | Suppress non-error output. |
| `--json` | Emit machine-readable JSON for status/list/export (where applicable). |

## Exit code conventions

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Bundle corrupt or I/O error |
| 2 | Missing dependency (recipient.pub, keychain entry) |
| 3 | Invalid arguments |
| 4 | Permission denied (e.g., bundle owned by another user) |
| 5 | Internal error (panic, unexpected) |

## Commands

### `pqc-secrets keygen`

Generate a fresh ML-KEM-768 keypair.

| | |
|---|---|
| Args | `[--recipient-out PATH]` |
| Exit codes | 0 success, 1 keychain unreachable, 2 recipient.pub exists (use `--force` to overwrite) |
| Writes | `recipient.pub` (1.8 KB), keychain entry |
| Idempotent | No — refuses to overwrite existing recipient.pub unless `--force` |

**Example:**
```bash
$ pqc-secrets keygen
Wrote public key to /Users/nbiish/.config/pqc-secrets/recipient.pub
Wrote private key to macOS keychain (service: pqc-secrets, account: ml-kem-768)
```

**Stderr format:** human-readable, one line per side effect.

### `pqc-secrets pack`

Encrypt `KEY=VAL` lines and write a fresh bundle.

| | |
|---|---|
| Args | `[--in PATH] [--bundle PATH]` |
| Stdin | `KEY=VAL` lines, one per secret (stdin default if `--in` omitted) |
| Exit codes | 0 success, 1 bundle write failed, 2 recipient.pub missing |
| Writes | Bundle, `audit.log` (event: not emitted — pack is silent) |

**Example:**
```bash
$ pqc-secrets pack --in <(printf 'STRIPE_SECRET=sk-live-AbCd\nGH_TOKEN=ghp_EfGh\n')
Wrote 2 keys to /Users/nbiish/.config/pqc-secrets/secrets.bundle.json (4 KB)
```

**Stderr format:** single line `Wrote N keys to <path> (<size>)`.

### `pqc-secrets export`

Decrypt bundle and emit shell `export` lines to stdout.

| | |
|---|---|
| Args | `[--bundle PATH]` |
| Exit codes | 0 success, 1 bundle corrupt, 2 keychain entry missing |
| Stdout | `export KEY="VALUE"` lines, double-quote escaped |
| Writes | `audit.log` (event: `export`) |

**Example:**
```bash
$ eval "$(pqc-secrets export)"
$ echo "$STRIPE_SECRET" | head -c 12
sk-live-AbCd...
```

**Stderr format:** silent on success; bundle corruption produces a
one-line error to stderr.

### `pqc-secrets rotate`

Re-encapsulate bundle against a fresh ephemeral KEM keypair
(**data-key only** — long-term identity key in keychain is NOT changed).

| | |
|---|---|
| Args | `[--bundle PATH]` |
| Exit codes | 0 success, 1 corrupt/write failed, 2 keychain missing |
| Writes | New bundle (atomic rename), `secrets.bundle.json.bak.<UTC>`, `audit.log` (`rotate keysAffected=N`) |
| Time | ~25 s on first call (ML-KEM-768 init), ~2 s subsequent |

**Example:**
```bash
$ pqc-secrets rotate
Backed up to secrets.bundle.json.bak.2026-06-09T15-00-00Z
Re-encapsulated 12 keys against fresh ephemeral KEM keypair
Wrote secrets.bundle.json (4 KB)
Audit: rotate keysAffected=12
```

### `pqc-secrets status`

Output machine-readable JSON describing the bundle state.

| | |
|---|---|
| Args | none |
| Exit codes | 0 always (status never fails) |
| Stdout | JSON: `{ keychainOk, pubKeyFp, bundleFp, nKeys, createdUtc }` |

**Example:**
```bash
$ pqc-secrets status
{"keychainOk":true,"pubKeyFp":"sha256:9f86...","bundleFp":"sha256:e3b0...","nKeys":12,"createdUtc":"2026-06-07T14:47:12Z"}
```

### `pqc-secrets audit`

Append a custom event to the audit log.

| | |
|---|---|
| Args | `--event <name> [--key k=v]...` |
| Exit codes | 0 success, 3 invalid arguments |
| Writes | `audit.log` (one line) |

**Example:**
```bash
$ pqc-secrets audit --event shell_export --key user=$USER --key n_keys=12
Audit: shell_export user=nbiish n_keys=12
```

## Stderr conventions

- **One line per side effect** (file written, keychain entry created, etc.)
- **No progress bars** — the CLI is meant to be scripted.
- **No color** unless `NO_COLOR` is unset AND stdout is a TTY.
- **Errors go to stderr**, success messages to stderr too (stdout is
  reserved for the actual data, e.g. `export` lines or `status` JSON).

## See also

- `references/bundle-schema.md` — bundle file format
- `references/audit-log.md` — audit log line format
- `references/rotation-procedure.md` — full rotation runbook
- `references/agent-integration.md` — wiring into Claude Code, Hermes, etc.
