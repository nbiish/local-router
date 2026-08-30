---
name: pqc-secrets-cli
description: Per-command reference for the pqc-secrets CLI. Exit codes, arguments, examples, and stderr format for every subcommand.
---

# pqc-secrets CLI Reference

`pqc-secrets <command> [args]` — the canonical command-line interface
for the PQC secrets management system.

**Bundle path:** `~/.config/pqc-secrets/secrets.bundle.json`
**Public key:** `~/.config/pqc-secrets/recipient.pub` (safe to commit)
**Private key:** OS keychain, service `pqc-secrets`, account `pqc-secrets-key` (legacy v1 binary used `default`)
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

**Storage form (2026-08-20+):** the Python engine stores the private key in
FIPS 203 **seed form** (64 bytes `d‖z`) inside `~/.config/pqc-secrets/private.key.enc`,
AES-256-GCM-wrapped under the stable `machine.kek`. Legacy stores holding the
2400-byte expanded form remain readable (kyber-py fallback, prints a rotation
hint). The macOS Rust binary keeps its keychain store.

| | |
|---|---|
| Args | `[--recipient-out PATH]` (Rust engine) |
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

### `pqc-secrets list`

List secret **names** only — never values. Dispatched by the bin wrapper to
the Python engine on every platform.

| | |
|---|---|
| Args | none |
| Exit codes | 0 success, 1 bundle missing |
| Stdout | `N secret name(s) in <bundle path>:` followed by one indented, alphabetically sorted name per line |
| Notes | On darwin the wrapper exports `PQC_USE_KEYCHAIN=true` so the keychain-resident key is readable; falls back to the encrypted file store automatically. |

**Example:**
```bash
$ pqc-secrets list
19 secret name(s) in /Users/nbiish/.config/pqc-secrets/secrets.bundle.json:
  CLINE_API_KEY
  MODAL_API_KEY
  ...
```

### `pqc-secrets rename`

Rename one secret **name**, preserving its value.

| | |
|---|---|
| Args | `<OLD_NAME> <NEW_NAME>` — both must match `^[A-Z0-9_]+$` |
| Exit codes | 0 success (or no-op when OLD == NEW), 1 bundle missing / OLD absent / NEW already exists / invalid name |
| Writes | Fresh bundle from the decrypted entries; the previous bundle is backed up alongside as `secrets.bundle.json.bak.<YYYYMMDDTHHMMSSZ>` (mode 0600) |
| Stdout | `Renamed OLD -> NEW (backup: <path>)` |
| Safety | Refuses to overwrite an existing NEW name; values are never printed |

**Example:**
```bash
$ pqc-secrets rename KILO_API_KEY LOCALROUTER_KILO_API_KEY
Renamed KILO_API_KEY -> LOCALROUTER_KILO_API_KEY (backup: ~/.config/pqc-secrets/secrets.bundle.json.bak.20260822T185530Z)
```

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
