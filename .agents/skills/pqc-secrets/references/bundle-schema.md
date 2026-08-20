---
name: bundle-schema
description: JSON schema for the PQC secrets bundle file at ~/.config/pqc-secrets/secrets.bundle.json. Field reference with verified names from the live bundle.
---

# Bundle JSON Schema

The bundle file at `~/.config/pqc-secrets/secrets.bundle.json` is the
canonical encrypted store. **Safe to commit** — every value is
AES-256-GCM ciphertext wrapped by ML-KEM-768.

> **Schema verified 2026-06-09 against the live bundle at
> `~/.config/pqc-secrets/secrets.bundle.json` (engine:
> `rust-fips203`).** Field names below are the actual production
> names. Earlier drafts of this document used different names
> (`kem.ciphertext`, `data.iv`, `data.tag`, `recipient.fingerprint`,
> `recipient.public_key`); those are **wrong**. Use the names below.

## Top-level structure

```json
{
  "version": 1,
  "alg": "ML-KEM-768",
  "engine": "rust-fips203",
  "created_utc": "2026-06-07T18:47:58.715239Z",
  "recipient": { ... },
  "kem": { ... },
  "keywrap": { ... },
  "data": { ... }
}
```

## Top-level fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | Bundle format version. Currently `1`. |
| `alg` | string | yes | Algorithm descriptor. `ML-KEM-768` for v1. |
| `engine` | string | yes | Producing engine: `rust-fips203` (macOS Rust binary), `py-native-mlkem` (Python native `cryptography>=45`, since 2026-08-20), or `kyber-py` (historical, pre-migration bundles). All engines interoperate — the JSON layout is identical. |
| `created_utc` | string | yes | ISO 8601 UTC timestamp with microseconds. |
| `recipient` | object | yes | Public key fingerprint (see below). |
| `kem` | object | yes | ML-KEM-768 encapsulation of the wrapped key. |
| `keywrap` | object | yes | AES-256-GCM-wrapped data key, derived via SHA3-256 KDF. |
| `data` | object | yes | AES-256-GCM ciphertext of the secret bundle, with AAD. |

**Field name conventions:**

- `alg` — single string, NOT `algorithm`
- `created_utc` — NOT `createdAt`
- `recipient`, `kem`, `keywrap`, `data` — all lowercase, no separators
- Sub-fields use `_b64` suffix for base64-encoded values
- Sub-fields use `_sha3_256` suffix for SHA3-256 hex digests

## `recipient` object

```json
{
  "public_key_sha3_256": "19df3b3f86de13a983abe68801f3b6512e21310cfda70cf89b5b3dcc68b1a433"
}
```

| Field | Type | Meaning |
|---|---|---|
| `public_key_sha3_256` | string | SHA3-256 hex of the public key (64 hex chars = 32 B digest). NOT the public key bytes themselves. |

The `recipient` block does NOT contain the public key — only its
SHA3-256 fingerprint. The actual public key lives on disk at
`~/.config/pqc-secrets/recipient.pub`. The fingerprint in the bundle
lets the verifier check that the on-disk `recipient.pub` matches the
bundle's intent (defense-in-depth against `recipient.pub`
substitution).

## `kem` object

```json
{
  "ciphertext_b64": "b14Q16NAByG+rLOib05Mwj2N9NMFeZcX..."
}
```

| Field | Type | Meaning |
|---|---|---|
| `ciphertext_b64` | string | Base64-encoded ML-KEM-768 KEM ciphertext (1088 B raw, ~1452 B encoded). |

The KEM encapsulates a KDF input (the SHA3-256 KDF in `keywrap.kdf`
turns the KEM shared secret into a 32-byte AES-256 data key).

## `keywrap` object

```json
{
  "kdf": "SHA3-256",
  "aad": "pqc-secrets:v1:keywrap",
  "nonce_b64": "i1WOwoxZRKzr/sw2",
  "ciphertext_b64": "j0KPhYjZz9TwTHYgIMxvI+4VeNIkR9qOkTnqrSwlBrx8BKOXWUQWK97OiQG+dLms"
}
```

| Field | Type | Meaning |
|---|---|---|
| `kdf` | string | KDF used to derive the data key from the KEM shared secret. `SHA3-256` for v1. |
| `aad` | string | Additional authenticated data. `pqc-secrets:v1:keywrap` for v1. |
| `nonce_b64` | string | Base64-encoded 96-bit AES-GCM nonce (12 B raw, ~16 B encoded). |
| `ciphertext_b64` | string | Base64-encoded wrapped data key ciphertext WITH the 16-byte GCM auth tag appended. |

The `keywrap` block is an AES-256-GCM layer that wraps the data
key. The plaintext is 32 bytes (the AES-256 data key); the
ciphertext is 32 + 16 = 48 bytes (data + GCM tag); the AAD binds
this layer to the bundle version.

## `data` object

```json
{
  "aad": "pqc-secrets:v1:data",
  "nonce_b64": "zoq1...",
  "ciphertext_b64": "..."
}
```

| Field | Type | Meaning |
|---|---|---|
| `aad` | string | Additional authenticated data. `pqc-secrets:v1:data` for v1. |
| `nonce_b64` | string | Base64-encoded 96-bit AES-GCM nonce (12 B raw). |
| `ciphertext_b64` | string | Base64-encoded encrypted secret bundle WITH the 16-byte GCM auth tag appended. |

The `data` block holds the actual encrypted secret bundle
(`KEY=VAL\n` lines, concatenated). The GCM auth tag is **appended**
to the ciphertext, not stored in a separate `tag` field. To extract:

```python
ct = base64.b64decode(data["ciphertext_b64"])
tag = ct[-16:]
ct = ct[:-16]
```

## Size reference (approximate)

| Field | Encoded size (B) | Raw size (B) |
|---|---|---|
| `recipient.public_key_sha3_256` | 64 | 32 (digest) |
| `kem.ciphertext_b64` | ~1452 | 1088 |
| `keywrap.ciphertext_b64` | ~64 | 48 (32 data + 16 tag) |
| `keywrap.nonce_b64` | ~16 | 12 |
| `data.ciphertext_b64` | variable | N×~100 + 16 |
| `data.nonce_b64` | ~16 | 12 |

A bundle with ~12 keys of ~100 B each typically weighs ~4 KB on disk.
The live bundle is 4,097 B with ~15 keys.

## Versioning

`version: 1` is the only supported version as of 2026-06. Future
versions will be additive (new optional fields) and the verifier
will accept any v1.x bundle.

## Validation

```bash
$ python3 .agents/skills/pqc-secrets/scripts/verify-bundle.py
OK: bundle validates, recipient.fp=sha3:19df3b3f..., ~15 keys, 0 plaintext leaks
$ echo $?
0
```

The verifier checks:

- All required top-level fields present
- `recipient` has `public_key_sha3_256` (64 hex chars, valid hex)
- `kem` has `ciphertext_b64` (decoded length == 1088 B for ML-KEM-768)
- `keywrap` has `kdf`, `aad`, `nonce_b64`, `ciphertext_b64`
- `data` has `aad`, `nonce_b64`, `ciphertext_b64`
- `data.nonce_b64` decoded length == 12 B (AES-256-GCM nonce)
- `data.ciphertext_b64` decoded length >= 16 B (GCM tag present)
- No plaintext secret patterns in the bundle (`sk-live`, `sk-test`,
  `whsec_`, `AKIA`, `ghp_`)

## Anti-patterns in code that parses bundles

- DO NOT use `kem.ciphertext`, `data.iv`, `data.tag`, or
  `recipient.fingerprint` — these are not the live field names.
  Use `kem.ciphertext_b64`, `data.nonce_b64`, and
  `recipient.public_key_sha3_256`.
- DO NOT trust the `version` field blindly — always re-check field
  presence for the version you support.
- DO NOT modify the bundle by hand. Use `pqc-secrets pack` /
  `rotate` / `export | grep | pack` flows.
- DO NOT assume the GCM tag is in a separate field. It's appended to
  `data.ciphertext_b64` (and to `keywrap.ciphertext_b64`).
- DO NOT commit a bundle whose `data.ciphertext_b64` decoded length
  is < 16 B (would mean no GCM tag — corrupt or zero-key).

## See also

- `references/pqc-secrets-cli.md` — CLI reference
- `references/audit-log.md` — audit log format
- `SKILL.md` §6 — same schema, in the main skill document
