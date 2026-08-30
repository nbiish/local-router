---
name: kek-persistence
description: How the local encrypted private-key store derives and persists its wrapping key (KEK). Explains the stable per-machine machine.kek file, the migration from the fragile machine-identity HKDF derivation, and the failure mode this eliminates.
---

# KEK Persistence Strategy

The ML-KEM-768 private key (`private.key.enc`) is encrypted at rest with
AES-256-GCM under a **Key-Encrypting Key (KEK)** that the host persists
per machine. This document describes why the KEK must be stable, how it is
derived and stored, and how a legacy store is migrated.

## Why a stable KEK matters

`private.key.enc` holds the only copy of the ML-KEM-768 private key. The
whole `secrets.bundle.json` can be decrypted only with that private key, and
the PQC threat model intentionally does **not** escrow it — there is no
recovery path if the private key becomes unreadable.

This means the KEK that wraps `private.key.enc` must be **stable across
reboots, kernel updates, and distro re-creation**. If the KEK ever changes,
AES-GCM authentication fails and the private key is permanently lost.

## v1 (legacy, fragile): volatile machine-identity HKDF

The original derivation used a **machine-identity KEK**:

```python
parts = [
    platform.node(),      # hostname
    getpass.getuser(),    # login name
    platform.platform(),  # kernel + glibc release string
    hex(uuid.getnode()),  # virtual NIC MAC
]
hkdf = HKDF(
    algorithm=hashes.SHA256(), length=32,
    salt=b"pqc-secrets:v1:machine-salt",
    info=b"pqc-secrets:v1:machine-key",
)
kek = hkdf.derive("|".join(parts).encode())
```

**Failure mode observed (2026-08-18):** `platform.platform()` bakes in the
full WSL2 kernel/glibc version, and `uuid.getnode()` returns the virtual NIC
MAC. On WSL2 neither is stable — reboots, kernel upgrades, distro re-creation,
or a re-instantiated virtual NIC change one or both values. That rotates the
derived KEK, and `AESGCM.decrypt` fails with `InvalidTag` (surfaced as the
empty message `ERROR: Failed to decrypt private key from local store:`). The
legacy private key inside is then unrecoverable.

## v1.1+ (current): stable persisted machine.kek

Since August 2026 the KEK is generated **once** and persisted to a 0600 file
so it survives reboots, kernel upgrades, and distro re-creation:

```python
KEK_PATH = CONFIG_DIR / "machine.kek"
```

`_get_machine_kek()`:

1. If a `machine.kek` file already exists, read and return it (stable path).
2. Migration attempt: if a legacy-encrypted `private.key.enc` already exists
   and still decrypts under the **volatile** v1 derivation, adopt that KEK —
   write it to `machine.kek` so the pre-existing store is preserved and from
   then on stable. (This only helps when the identity has not yet drifted.)
3. Otherwise mint a fresh 32-byte random KEK and persist it.

`_legacy_machine_kek()` retains the old identity HKDF purely as a migration
input and is never used for new stores.

## Files and layout

```text
~/.config/pqc-secrets/
├── machine.kek           # 32-byte AES-256-GCM wrapping key (0600, stable)
├── private.key.enc       # ML-KEM-768 private key, AES-256-GCM(machine.kek)
│                         #   seed form (64 B) since 2026-08-20;
│                         #   legacy expanded form (2400 B) readable
├── recipient.pub         # ML-KEM-768 public key (safe to commit)
└── secrets.bundle.json   # encrypted API keys (DEK wrapped under ML-KEM)
```

`machine.kek` and `private.key.enc` are both `0600` and the config dir is
`0700`, so the file-bound KEK is read-only by the owning user — parity with
the OS keychain option (`PQC_USE_KEYCHAIN=true` stores the same key via macOS
Keychain or Linux Secret Service instead).

## Rotation / recovery

- Rerunning `keygen` writes a fresh private key; if a stale encrypted bundle
  is left behind it becomes unreadable (its public key no longer matches).
  Keep `recipient.pub` in step with the private key.
- Rotation is also the migration path off legacy expanded-form (2400-byte)
  stores: `keygen` + re-pack lands you on the native seed-form store. The
  decapsulation path prints a rotation hint whenever a legacy store is read.
- Losing `machine.kek` **and** the OS keychain means the private key is
  unrecoverable — the bundle is lost (no-escrow contract). Back up
  `machine.kek` the same way you would back up a keychain entry.
- Provider keys are re-entered via the consuming app's config UI or
  `pqc-secrets pack` and re-packed. See `rotation-procedure.md` for the
  full recovery flow.

## See also

- `references/rotation-procedure.md` — key rotation & DR runbook
- `references/bundle-schema.md` — encrypted bundle format
- `references/pqc-secrets-cli.md` — CLI reference
- `references/cross-repo-key-sharing.md` — one bundle across many repos
- `SKILL.md` §2 Infrastructure Architecture
