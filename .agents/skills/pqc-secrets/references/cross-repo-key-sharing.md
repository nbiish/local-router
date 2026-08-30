---
name: cross-repo-key-sharing
description: How one PQC secrets bundle serves as the single source of truth for API keys across many repos and projects on a machine. How to add, update, and consume keys; the per-machine security model; and how to onboard a new repo.
---

# Cross-Repo Key Sharing — One Bundle, Many Repos

The PQC secrets bundle is a **per-machine single source of truth**. One
encrypted bundle at `~/.config/pqc-secrets/secrets.bundle.json` holds every
API key for every project on that machine. Repos and projects do **not** keep
their own keys — they all read from (and pack into) the same bundle through
the same `pqc-secrets` CLI.

This keeps keys as secure as possible: one encrypted store, one ML-KEM-768
keypair, one stable wrapping key, and zero plaintext on disk.

## The one-system principle

```
                     ~/.config/pqc-secrets/
                     ┌─────────────────────┐
   repo A ──pack/export──▶  secrets.bundle.json  ──export──▶ repo B
   repo C ──pack/export──▶  (ML-KEM-768 + AES-256-GCM)        ──export──▶ repo D
                     └─────────────────────┘
                              ▲          ▲
                              │   machine.kek (stable, persisted)
                              │   private.key.enc (KEK-wrapped)
                              │   recipient.pub (safe to commit)
```

- **One bundle per machine** (really, per OS user account). It is the only
  place keys live at rest.
- **Every repo ships the same CLI** (`bin/pqc-secrets`) and reads/writes the
  same bundle. The Rust native binary (macOS arm64) and the Python fallback
  engine (Linux/WSL/other) read and pack the identical bundle JSON layout, so
  bundles and public keys are portable across engines on the same machine.
- **No per-repo keys.** A key added once is immediately available to every
  repo, project, and shell session that reads the bundle.

## How keys are shared across repos

Because all repos point at one bundle, a key added through any of them is
visible to all the others with no copy step:

| Repo / project | Adds a key via | Reads keys via |
|---|---|---|
| `local-router` | `/config` UI → `POST /api/keys`, or `localrouter keys set` | `loadPqcSecrets()` at startup |
| `ainish-coder` | `pqc-secrets pack` | `pqc-secrets export` / `secrets-load` |
| any new repo | `pqc-secrets pack` | `eval "$(pqc-secrets export)"` |

There is no "push to other repos" step. The bundle is the single shared
state; repos are stateless readers/writers of it.

## Add or update a key (works for every repo at once)

### Option A — re-pack the whole bundle (canonical)

```bash
# 1. Dump current keys to memory (never to disk)
eval "$(pqc-secrets export)"

# 2. Add/overwrite the key you need
export NEW_PROVIDER_API_KEY="<value>"

# 3. Re-encrypt the full set back into the bundle
pqc-secrets pack <<EOF
$(env | grep -E '^[A-Z_]+_API_KEY=' | sed 's/^/export /')
EOF
```

> The `pack` step reads `KEY=VALUE` lines from stdin and writes a fresh
> bundle encrypted to `recipient.pub`. Always include the **entire** current
> key set — `pack` replaces the bundle, it does not merge.

### Option B — via a consuming app's config UI

For `local-router` specifically, open `http://localhost:11434/config` and add
the key in the UI, or:

```bash
localrouter keys set <provider> --env <ENV_VAR>   # sets the key in memory + persists to the bundle
```

The key lands in the same bundle and is immediately usable by every other
repo that reads it.

### Verify

```bash
pqc-secrets verify          # lists key names (no values) — confirms the bundle decrypts
pqc-secrets export | grep NEW_PROVIDER_API_KEY   # smoke-test one value
```

## How a repo consumes keys (onboarding a new project)

A new repo/project joins the system by reading the shared bundle — it never
gets its own keys:

```bash
# In a shell wrapper or pre-launch task:
eval "$(pqc-secrets export)"     # loads every KEY=VALUE into the current shell
my-tool --api-key "$NEW_PROVIDER_API_KEY"
```

For app-level startup (the `local-router` pattern), call `pqc-secrets export`
once at boot, parse the `export KEY=VALUE` lines, and inject them into the
process environment. Keys exist only in memory and are gone when the process
exits.

## Security model

- **Per-machine, per-user.** The bundle is encrypted to that machine's
  ML-KEM-768 keypair. `machine.kek` (stable, persisted) wraps the private key
  so it survives reboots and kernel updates — see `kek-persistence.md`.
- **No sync, no copy.** Do **not** copy `secrets.bundle.json`,
  `private.key.enc`, or `machine.kek` between machines — a bundle packed on
  machine A will not decrypt on machine B (different keypair). Each machine
  packs its own bundle from its own plaintext entry of keys.
- **Safe to commit:** `recipient.pub` (the ML-KEM-768 public key only).
- **Never commit, never sync, never `.env`:** `machine.kek`,
  `private.key.enc`, and `secrets.bundle.json`. These live under
  `~/.config/pqc-secrets/` (0600/0700) and stay on the machine.
- **Zero plaintext on disk.** Keys are injected into process memory at
  runtime only. No `.env`, no settings files with `env` blocks containing
  values.

## Recovery / disaster notes

- If `pqc-secrets export` ever fails with `Failed to decrypt private key from
  local store`, the wrapping KEK has drifted (the legacy failure mode). The
  hardened engine persists a stable `machine.kek` to prevent this; if a store
  is already lost, re-run `pqc-secrets keygen` and re-pack keys from their
  plaintext entry points. See `kek-persistence.md` and `rotation-procedure.md`.
- Back up `machine.kek` the same way you would back up a keychain entry.
  Losing `machine.kek` **and** the OS keychain means the private key is
  unrecoverable (no-escrow contract).

## See also

- `references/kek-persistence.md` — the stable per-machine wrapping key
- `references/rotation-procedure.md` — key rotation & DR runbook
- `references/pqc-secrets-cli.md` — CLI reference
- `references/agent-integration.md` — wiring into Claude Code, Hermes, etc.
- `SKILL.md` §2 Infrastructure Architecture
