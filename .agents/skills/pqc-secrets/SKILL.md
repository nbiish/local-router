---
name: pqc-secrets
description: Post-quantum cryptography secrets management system for protecting API keys, tokens, and private data. Includes the 10 browser_secrets_* MCP tools (betterbrowsermcp v0.7.0+ rotates v0.8.0+), the append-only audit log at ~/.config/pqc-secrets/audit.log, and the PQC Rust binary (ML-KEM-768 + AES-256-GCM).
---

# PQC Secrets Management Agent Skill

> **Companion skill:** [pqc-signatures-security](../pqc-signatures-security/SKILL.md) — ML-DSA-65 code signing, integrity verification, and secure coding patterns. Use both together for complete PQC coverage: this skill encrypts secrets at rest; pqc-signatures-security verifies code hasn't been tampered with.

> **New in v0.8.0 (betterbrowsermcp):** `browser_secrets_rotate` tool
> (data-key rotation, identity key stays), `secrets_get mode=plain|redact`,
> `secrets_add dry_run`. **New module:** `src/audit.ts` — append-only audit
> log at `~/.config/pqc-secrets/audit.log` mode 0o600 with SHA3-256 value
> fingerprints (first 16 hex chars, never the value). **Bug fix:**
> `browser_secrets_add` was broken since v0.7.0 (dead execFile call
> removed). See `references/mcp-tool-surface.md` for the full per-tool
> reference.

> **Availability-first design:** these tools are designed to be called
> freely by agents with no human-in-the-loop gatekeeping. No auth
> tokens, no redaction default, no required `tabId` for
> non-browser-context operations. The verification surface is the
> audit log + `browser_secrets_rotate`'s auto-backup.

This skill provides comprehensive instructions, policies, and blueprints for managing repository and application secrets (API keys, credentials, private user data) using post-quantum cryptographic (PQC) algorithms.

AI agents using this skill are equipped to:
1. Protect credentials at rest and in memory using FIPS-compliant algorithms.
2. Integrate with the platform's native keychain and standard runtime environments.
3. Validate environments and ensure zero plaintext credentials are written to disk.

---

## 1. Core Philosophy: Zero Plaintext on Disk

Traditional secrets management relies heavily on plaintext `.env` files or insecure environment variables. Under the PQC mandate:
- **Always** protect API keys and private data with FIPS 203 (ML-KEM-768) key encapsulation and AES-256-GCM symmetric encryption.
- **Never** store raw API keys, secrets, or tokens in git repositories, task files, logs, or local unencrypted files.
- **Always** load secrets on-demand directly into the shell environment from an encrypted bundle, and ensure they never persist to disk.

### 1.1 ⚠️ Common Agent Trap: Settings Files with `env` Blocks

Many CLI tools (Claude Code, VS Code, Docker, etc.) use JSON/YAML settings files with an `env` block. **Agents will naturally want to put API keys directly in these files. This is a PQC violation.**

**NEVER do this:**
```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-ss-v1-abc123...",
    "ANTHROPIC_API_KEY": "sk-ant-..."
  }
}
```

```yaml
env:
  API_KEY: "sk-..."
```

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-proj-..."
  }
}
```

**Why this is wrong:** The settings file is a regular file on disk. Anyone with file read access (backup tools, cloud sync, other processes, disk imaging) can extract the key. It will also be committed to git if the file is tracked, and it shows up in file search/grep results.

**ALWAYS do this instead — inject at runtime from the OS keychain:**
```bash
# Shell wrapper reads from Keychain and passes via env var
my-tool() {
    local api_key
    api_key="$(security find-generic-password -s "my-tool" -a "api-key" -w 2>/dev/null)"
    if [[ -z "$api_key" ]]; then
        echo "Error: API key not found in Keychain." >&2
        return 1
    fi
    ANTHROPIC_AUTH_TOKEN="$api_key" command my-tool "$@"
}
```

The settings file keeps everything **except** the secret value:
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://zenmux.ai/api/anthropic",
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek/deepseek-v4-flash"
  }
}
```

**The key exists only in two places: the OS keychain (encrypted at rest) and process memory (volatile). Never on disk in any config file.**

---

## 2. Infrastructure Architecture

The PQC secrets system consists of a dual-implementation architecture to ensure maximum performance and cross-platform compatibility:

1. **Rust Native (Primary):** The compiled binary at `bin/pqc-secrets` (source in `src/pqc-secrets/`) uses the NIST FIPS 203 compliant `fips203` crate. It implements a secure **double-envelope** structure:
   - **ML-KEM-768** encapsulates a Key Encapsulating Key (KEK).
   - The KEK wraps a Data Encryption Key (DEK) via AES-256-GCM keywrap.
   - The DEK encrypts the secret payload via AES-256-GCM.
   - Stores metadata including Additional Authenticated Data (`aad`) in `secrets.bundle.json`.
**Engine parity & freshness (verified 2026-08-22):**

| Surface | Engine | Coverage | Status |
|---|---|---|---|
| Linux / WSL / generic (Windows: Ubuntu/WSL terminal) | **Python** (`pyca/cryptography>=45`, native ML-KEM-768, FIPS 203 seed form) via `uv run` | keygen, pack, export, verify, **list**, **rename**, migrate, setup, version | **Canonical** — resolves to the newest `cryptography` on first run |
| darwin/arm64 | **Python** (same engine, same path) | all commands | Canonical |
| darwin/arm64 | Rust `bin/pqc-secrets.darwin-arm64` | keygen, pack, export only | **Legacy fast-path**, frozen v1.0.0 (2026-06 command set) |

The dispatcher (`bin/pqc-secrets`) routes `keygen|pack|export` to the Rust binary on darwin
when present (speed); **every other command — `list`, `rename`, `migrate`, `verify`,
`setup`, `version` — runs through the canonical Python engine** and requires `uv`
(install via the pinned, sha256-verified `./bin/pqc-secrets setup`). `pqc-secrets version`
prints the exact engine identity, build date, crypto suite, and command coverage. If the
Rust crate is ever refreshed, it regains its fast-path only for the commands it actually
implements; the Python engine stays the freshness standard.

**Platform support:** architecture-agnostic — macOS, Linux, and Windows (Ubuntu terminal
via WSL). Every command is shell-generic POSIX; the canonical Python engine runs on all
platforms, and the Rust binary is an optional darwin/arm64 fast-path, never required.
OS keystore opt-ins: macOS Keychain, Linux Secret Service.

2. **Python Fallback (Secondary):** A script at `.agents/skills/pqc-secrets/scripts/pqc_secrets.py` uses the **native ML-KEM-768** from `pyca/cryptography>=45` (`cryptography.hazmat.primitives.asymmetric.mlkem`) and writes the same **double-envelope** bundle JSON as the Rust engine (keywrap layer + AAD). Since 2026-08-20 new keygens store the private key in FIPS 203 **seed form** (64 bytes `d‖z`); older stores holding the 2400-byte expanded form remain readable via the retained `kyber-py` decapsulation fallback, which prints a rotation hint.

> [!WARNING]
> **Format Incompatibility & Mismatch Errors:**
> Because the Rust binary and Python script use different envelope structures, their serialized bundles are incompatible. Running the Rust binary on a Python-packed bundle results in:
> `Error: missing field aad at line X column Y`
>
> If this occurs, you must perform a one-time migration:
> ```bash
> # 1. Export plaintext secrets using the Python fallback
> SECRETS_TXT=$(uv run .agents/skills/pqc-secrets/scripts/pqc_secrets.py export)
> 
> # 2. Generate a new keypair using the Rust binary
> ./bin/pqc-secrets keygen
> 
> # 3. Pack the secrets back into the Rust-compatible bundle
> echo "$SECRETS_TXT" | ./bin/pqc-secrets pack
> ```

The local secrets infrastructure lives at `~/.config/pqc-secrets/`:

System Keychain / File                 ~/.config/pqc-secrets/
┌─────────────────────────┐          ┌──────────────────────────────┐
│ macOS Keychain,         │          │ machine.kek (0600, stable)    │
│ Linux Secret Service,   │  uses    │ recipient.pub                │
│ or machine.kek (0600)  │────────▶ │ (ML-KEM-768 public key)      │
│ ─── the private-key     │          │ (safe to commit)             │
│     wrapping key (KEK)  │          └──────────────┬───────────────┘
└─────────────────────────┘                         │
            │ decrypt (AES-256-GCM)                │ encaps (ML-KEM-768)
            ▼                                       ▼
┌──────────────────────────────────────────────────────────────┐
│                    secrets.bundle.json                       │
│  ┌─────────────────┐  ┌──────────────────────────────────┐   │
│  │ kem.ciphertext  │  │ data.ciphertext (AES-256-GCM)    │   │
│  │ (ML-KEM-768)    │  │ 24+ API keys encrypted at rest   │   │
│  └─────────────────┘  └──────────────┬───────────────────┘   │
└──────────────────────────────────────┼───────────────────────┘
                                       │ decrypt
                                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Exported environment variables (never touch disk)           │
│  ANTHROPIC_AUTH_TOKEN  ZENMUX_API_KEY  NEBIUS_API_KEY        │
│  OPENROUTER_API_KEY    WAFER_API_KEY    ... (in-memory only) │
└──────────────────────────────────────────────────────────────┘

---

## 3. Cryptographic Standards (verified 2026-08-08)

For all secrets operations, only NIST-approved post-quantum algorithms are permitted. Traditional classical algorithms are strictly forbidden for protecting key material:

| Use Case | Permitted Algorithms (FIPS) | Forbidden Algorithms |
|---|---|---|
| Key Encapsulation (KEM) | ML-KEM-768, ML-KEM-1024 (FIPS 203) | RSA key transport, DH, ECDH, DSA |
| Symmetric Encryption | AES-256-GCM (SP 800-38D) | AES-CBC, AES-ECB, DES, 3DES, Blowfish, RC4 |
| Digital Signatures | ML-DSA-65/87 (FIPS 204), SLH-DSA-SHA2-128s (FIPS 205) | RSA-PSS, ECDSA, Ed25519, EdDSA, DSA, MD5, SHA-1 |
| Hash / Fingerprint | SHA3-256, SHA3-512 | MD5, SHA-1 |
| Key Derivation | HKDF-SHA3-256, Argon2id (passphrases) | PBKDF2 < 600k iterations, plain SHA-256 of password |

**Status boundary (as of 2026-08-08 — do not overstate):**

| Item | Status | Production? |
|---|---|---|
| FIPS 203 (ML-KEM), FIPS 204 (ML-DSA), FIPS 205 (SLH-DSA) | **Final** (Aug 13, 2024) | ✅ baseline |
| SP 800-227 (KEM recommendations, hybrids) | **Final** (Sept 18, 2025) | ✅ use approved key combiners for any hybrid KEM |
| FIPS 206 (FN-DSA, ex-FALCON) | **Draft** — submitted for NIST/DoC clearance Aug 28, 2025; final expected late 2026–2027 | ⚠️ track only; NOT approved for production baseline; **not in CNSA 2.0** |
| HQC (code-based backup KEM) | Selected Mar 11, 2025 (NIST IR 8545); draft FIPS expected ~2026, final ~2027 | ⚠️ crypto-agility reserve only; **not in CNSA 2.0** |

**CNSA 2.0 (NSS / military-contract work):** NSA mandates **ML-KEM-1024** for key establishment and **ML-DSA-87** for signatures in National Security Systems (with AES-256, SHA-384/512). SLH-DSA is **not** approved for NSS, and NSA has stated FN-DSA and HQC will **not** be added. All new NSS acquisitions must be CNSA 2.0 compliant starting **Jan 1, 2027**; full enforcement Dec 31, 2031 (DoW PQC Strategy, June 23, 2026; CNSSP 15).

**Classical deprecation (NIST IR 8547 + EO 14412 + OMB M-26-15, 2026):** classical public-key algorithms at 112-bit security (RSA-2048, ECDSA P-256, ECDH P-256, EdDSA) are **deprecated after 2030** and all RSA/ECC is **disallowed after 2035**. Federal HVAs must complete PQC key-establishment transition by **Dec 31, 2030**. This ML-KEM-768 default satisfies the civilian Level-3 baseline; for anything touching defense/NSS scopes, step up to ML-KEM-1024.

---

## 4. Lifecycle Commands

Use the primary native Rust binary `bin/pqc-secrets` (or run the Python fallback via `uv run .agents/skills/pqc-secrets/scripts/pqc_secrets.py`):

| Step | Rust Command | Python Fallback Command | Description |
|---|---|---|---|
| **Keygen** | `bin/pqc-secrets keygen` | `uv run .agents/skills/pqc-secrets/scripts/pqc_secrets.py keygen` | Generates a new ML-KEM-768 keypair. Stores the private key in local encrypted file in FIPS 203 seed form, 64 bytes (system keychain if opted-in via `PQC_USE_KEYCHAIN=true`). Public key → `~/.config/pqc-secrets/recipient.pub`. |
| **Pack** | `bin/pqc-secrets pack` | `uv run .agents/skills/pqc-secrets/scripts/pqc_secrets.py pack` | Reads `KEY=VAL` lines from stdin, encrypts via AES-256-GCM + ML-KEM-768, writes `secrets.bundle.json`. |
| **Load** | `bin/pqc-secrets export` | `uv run .agents/skills/pqc-secrets/scripts/pqc_secrets.py export` | Decrypts bundle in-memory, outputs `export KEY=VALUE` lines. Use `secrets-load` shell function. |
| **Verify** | `bin/pqc-secrets verify` | `uv run .agents/skills/pqc-secrets/scripts/pqc_secrets.py verify` | Verifies bundle can be decrypted, lists key names. |
| **List** | `bin/pqc-secrets list` | `uv run ... pqc_secrets.py list` | Lists every secret **name** (never values), sorted — the inspection surface for what is set, what belongs to which tool prefix, and what needs renaming. |
| **Rename** | `bin/pqc-secrets rename OLD NEW` | `uv run ... pqc_secrets.py rename OLD NEW` | Renames one secret **name** keeping its value; the previous bundle is backed up to `secrets.bundle.json.bak.<UTC>` first. Refuses to overwrite an existing name. |
| **Rotate** | `bin/pqc-secrets keygen && bin/pqc-secrets pack` | `keygen && pack` | Generates new keypair and re-packs secrets under new public key. |
| **Rewrap** | `bin/pqc-secrets rewrap --new-pub <path> --out <path>` | — | Re-encrypts bundle under a different public key without exposing plaintext. |
| **Migrate** | `bin/pqc-secrets migrate` | `uv run ... pqc_secrets.py migrate` | Migrates keychain entry from old account name to new. |

### Key Naming Convention (tool-relative prefixes)

Every key an agent packs into the bundle **must** be prefixed with the name of the tool that consumes it — never a bare provider name:

| Consuming tool | Key name |
|---|---|
| Local Router | `LOCALROUTER_KILO_API_KEY`, `LOCALROUTER_ZAI_API_KEY`, … |
| ainish-coder | `AINISHCODER_*_API_KEY` |
| any tool | `<TOOLNAME>_<WHAT>_API_KEY` |

- Prefix = the consuming tool's name, uppercase, `^[A-Z0-9_]+$` (e.g. Local Router → `LOCALROUTER_`).
- **Always** apply the prefix when wiring a key for a specific tool — even when the provider name differs from the tool name (`KILO_API_KEY` used by Local Router → `LOCALROUTER_KILO_API_KEY`).
- Plain, unprefixed names are reserved for genuinely machine-shared keys (e.g. `HF_TOKEN`).
- Bring an existing key into a tool namespace without re-entering its value: `pqc-secrets rename KILO_API_KEY LOCALROUTER_KILO_API_KEY`.
- Audit ownership with `pqc-secrets list` — every name should make its owning tool obvious.

### Migration from Legacy `default` Account

If you have an existing keychain entry with account name `default` (from older versions), migrate to `pqc-secrets-key`:

```bash
bin/pqc-secrets migrate
# Or with custom account names:
PQC_KEYCHAIN_ACCOUNT_OLD=default PQC_KEYCHAIN_ACCOUNT_NEW=pqc-secrets-key bin/pqc-secrets migrate
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
|| `PQC_KEYCHAIN_ACCOUNT` | `pqc-secrets-key` | System keychain account name for the ML-KEM-768 private key |
|| `PQC_CONFIG_DIR` | `~/.config/pqc-secrets` | Directory for bundle and public key files |
| `PQC_USE_KEYCHAIN` | `false` | Enable native platform keychain storage (defaults to the `machine.kek` file store) |

**Private-key wrapping key (KEK):** the ML-KEM-768 private key is encrypted under a stable per-machine KEK persisted to `~/.config/pqc-secrets/machine.kek` (0600). It is generated once and survives reboots, kernel upgrades, and distro re-creation; a pre-existing legacy-encrypted store is migrated automatically. See `references/kek-persistence.md` for the full strategy.

One PQC bundle at `~/.config/pqc-secrets/secrets.bundle.json` is the single source of truth for all API keys across every repo and project on a machine — repos pull keys from it; nothing is duplicated. See `references/cross-repo-key-sharing.md` for add, update, and consume workflows across many repos.

### Implementation Details

- **Rust Primary Engine:** `fips203` crate v0.4.x (pure Rust, no `unsafe`, no C FFI; implements final FIPS 203 ML-KEM-768 with ACVP KATs). Alternatives verified 2026-08: RustCrypto `ml-kem` crate (type-safe param sets, no FFI), Cryspen/libcrux `libcrux-ml-kem` (formally verified).
- **Rust Primary Dependencies:** `security-framework` (macOS Keychain), `aes-gcm`, `serde`, `serde_json`, `sha3`.
- **Python Fallback Engine (migrated 2026-08-20):** native `cryptography>=45` ML-KEM-768 (`MLKEM768PrivateKey.generate()` / `from_seed_bytes()` / `MLKEM768PublicKey.encapsulate()`) for all keygen, encapsulation, and seed-form decapsulation. `kyber-py` is imported lazily and used **only** to decapsulate legacy 2400-byte expanded-form private-key stores (written by older keygens or the Rust engine); those prints advise rotating via `keygen` + re-pack. Bundle JSON layout is unchanged and interoperable with the Rust engine.
- **Python Fallback Dependencies:** Managed inline via UV script metadata — `cryptography>=45.0` (primary engine) and `kyber-py>=0.2.0` (legacy expanded-key reads only), auto-resolved by `uv run`.

---

## 5. Application Integration Guidelines

Applications must read secrets exclusively from environment variables populated dynamically in memory. Do not store or read plaintext files inside the application context.

> **Full application-embedding reference:** [references/application-orchestration.md](references/application-orchestration.md) — for when the application itself owns the key lifecycle: boot-time bundle load, UI-driven set/unset with repack, in-memory reads for per-request use, cross-platform binary dispatch, and new-machine ceremonies. Production reference: local-router (2026-08-17).

### Pattern 1: Safe Environment Variable Consumption (Python)
```python
import os
import sys

def get_api_key(name: str) -> str:
    """Retrieve secret from environment, ensuring no fallback to disk files."""
    api_key = os.environ.get(name)
    if not api_key:
        print(f"CRITICAL ERROR: Environment variable '{name}' is not set.", file=sys.stderr)
        print("Please load secrets via 'secrets-load' before running this command.", file=sys.stderr)
        sys.exit(1)
    return api_key
```

### Pattern 2: Safe Environment Variable Consumption (Node.js)
```javascript
function getApiKey(name) {
    const apiKey = process.env[name];
    if (!apiKey) {
        console.error(`CRITICAL ERROR: Environment variable '${name}' is not set.`);
        console.error("Please load secrets via 'secrets-load' before running this application.");
        process.exit(1);
    }
    return apiKey;
}
```

### Pattern 3: Safe Environment Variable Consumption (Rust)
```rust
fn get_api_key(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| {
        eprintln!("CRITICAL ERROR: Environment variable '{}' is not set.", name);
        eprintln!("Please load secrets via 'secrets-load' before running this command.");
        std::process::exit(1);
    })
}
```

### Pattern 4: Shell Wrapper Integration
When wrapping command-line tools or other agents, pass env variables down rather than writing to disk config files. If a configuration file is strictly required by the tool (e.g. `auth.json` or `.env` file), write it dynamically to a secure directory (or temporary RAM disk if supported) and delete it immediately upon tool exit via traps.

```bash
# Example wrapper with exit trap for temporary configs
run_tool_with_secrets() {
  local temp_env
  temp_env=$(mktemp /tmp/tool-env.XXXXXX)
  trap 'rm -f "$temp_env"' EXIT
  
  # Populate temp config from environment variables loaded via secrets-load
  cat > "$temp_env" <<EOF
API_KEY="${ZENMUX_API_KEY}"
EOF

  command-tool --config "$temp_env" "$@"
}
```

### Pattern 5: Headless & CI/CD Pipelines
In headless environments where macOS Keychain is unavailable, use standard platform secrets injection (e.g., GitHub Secrets, Kubernetes Secrets, or Docker environment flags) passed dynamically from standard input.
```bash
# Injecting secrets directly via stdin to avoid write-to-disk
docker run -e ZENMUX_API_KEY=$(bin/pqc-secrets export | grep ZENMUX_API_KEY | cut -d= -f2) my-image
```

## §4 Algorithm Reference

PQC algorithm suite for secrets and signing operations. All algorithms
are FIPS-compliant (final since August 2024) and approved for NSA CNSA
2.0 use. Audit any code that uses a different algorithm for
secrets/signatures — it is a PQC violation.

| Algorithm | Standard | Type | Status | Sizes (bytes) | Use |
|---|---|---|---|---|---|
| **ML-KEM-768** | FIPS 203 | KEM | Final Aug 2024 | pk 1184 / sk 2400 / ct 1088 | Primary bundle wrap |
| ML-KEM-1024 | FIPS 203 | KEM | Final Aug 2024 | pk 1568 / sk 3168 / ct 1568 | Higher-security wrap |
| **ML-DSA-65** | FIPS 204 | Signature | Final Aug 2024 | pk 1952 / sig 3309 | Identity / signing |
| ML-DSA-87 | FIPS 204 | Signature | Final Aug 2024 | pk 2592 / sig 4627 | Higher-security signing |
| **SLH-DSA-SHA2-128s** | FIPS 205 | Hash-based sig | Final Aug 2024 | pk 32 / sig 7856 | Backup / long-term |
| **AES-256-GCM** | SP 800-38D | Symmetric | Standard | key 32 / IV 12 / tag 16 | Bundle data at rest |
| Argon2id | OWASP 2025 | KDF | Standard | 32+ output, t=3 m=64MB p=4 | Password-based KDF |

**Bold** = used in the default `pqc-secrets` configuration. Other
algorithms are available via explicit flags for higher-security
deployments.

References:
- NSA CNSA 2.0 (Commercial National Security Algorithm Suite 2.0)
- NIST FIPS 203/204/205 (August 2024 — final)
- NIST SP 800-38D (AES-GCM)

**Forbidden algorithms for secrets/signatures** (audit contexts excepted):
RSA, DSA, ECDSA, ECDH, Ed25519, MD5, SHA-1, DES, 3DES, Blowfish,
AES-CBC, AES-ECB, RC4, `pycrypto`, unauthenticated `openssl` use.

Standard cryptography (TLS 1.3, SSH, GPG, platform TLS) is fine for
**transport** and non-secrets operations. The line is simple: if it
protects an API key or private user datum, it uses PQC.

---

## §5 CLI Command Reference

`pqc-secrets <command> [args]` — exit codes, arguments, and examples
for every command.

### 5.1 `pqc-secrets keygen`

Generate an ML-KEM-768 keypair.

**Synopsis:** `pqc-secrets keygen [--recipient-out PATH]`

**Behavior:**
- Generates a fresh ML-KEM-768 keypair.
- Private key written to the OS keychain (service: `pqc-secrets`,
  account: `ml-kem-768`).
- Public key written to `~/.config/pqc-secrets/recipient.pub`
  (1.8 KB, safe to commit).

**Exit codes:**
- `0` — success
- `1` — keychain unreachable
- `2` — recipient.pub already exists (refuses to overwrite; use
  `--force` to overwrite)

> **Keypair-overwrite guard (Python engine, 2026-08-29):** the canonical
> Python `keygen` now **refuses to run** (exit `1`) when
> `private.key.enc` or `recipient.pub` already exists. Rotating a
> keypair without re-packing makes every existing bundle
> undecryptable. To rotate deliberately: `pqc-secrets keygen --force`
> — the previous key material is backed up beside the live files as
> `*.rotated-<UTC>` first. Never bypass this guard on a machine whose
> bundle you cannot re-pack from originals.

**Example:**
```bash
$ pqc-secrets keygen
Wrote public key to /Users/nbiish/.config/pqc-secrets/recipient.pub
Wrote private key to macOS keychain (service: pqc-secrets)
```

### 5.2 `pqc-secrets pack`

Encrypt `KEY=VAL` lines and write a fresh bundle.

**Synopsis:** `pqc-secrets pack [--in PATH] [--bundle PATH]`

**Behavior:**
- Reads `KEY=VAL` lines from stdin (or `--in PATH`).
- Generates a fresh 256-bit AES data key, encrypts the plaintext via
  AES-256-GCM.
- Encapsulates the data key against `recipient.pub` using ML-KEM-768.
- Writes the bundle to `~/.config/pqc-secrets/secrets.bundle.json`
  (or `--bundle PATH`).

**Exit codes:**
- `0` — success
- `1` — bundle write failed
- `2` — recipient.pub missing (run `keygen` first)

**Example:**
```bash
$ pqc-secrets pack --in <(printf 'STRIPE_SECRET=sk-live-...\nGH_TOKEN=ghp_...\n')
Wrote 2 keys to /Users/nbiish/.config/pqc-secrets/secrets.bundle.json (4 KB)
```

### 5.3 `pqc-secrets export`

Decrypt the bundle and emit shell `export` lines to stdout.

**Synopsis:** `pqc-secrets export [--bundle PATH]`

**Behavior:**
- Reads the bundle, decapsulates the data key using the keychain
  private key, decrypts the data via AES-256-GCM.
- Emits `export KEY=VALUE` lines to stdout. Values are quoted with
  double-quote escaping; multiline values are base64-encoded and
  prefixed with a warning comment.

**Exit codes:**
- `0` — success
- `1` — bundle corrupt
- `2` — keychain entry missing (cannot decapsulate)

**Example:**
```bash
$ eval "$(pqc-secrets export)"
$ echo "$STRIPE_SECRET" | head -c 12
sk-live-AbCd...
```

### 5.4 `pqc-secrets list` / `pqc-secrets rename`

Names-only bundle inspection + per-name maintenance (2026-08-22). Use these to
audit naming conventions across tools — e.g. a dedicated-provider key like
`LOCALROUTER_KILO_API_KEY` for the Local Router app vs plainly-named shared keys.

**`list` synopsis:** `pqc-secrets list`

- Decrypts the bundle and prints every secret **name** (never a value),
  sorted, with a count header.
- Exit `0`; `1` when the bundle is missing/corrupt.

**`rename` synopsis:** `pqc-secrets rename <OLD_NAME> <NEW_NAME>`

- Names must match `^[A-Z0-9_]+$` (env variable names).
- Refuses with exit `1` when OLD is absent or NEW already exists
  (no overwrite hazards).
- Backs up the prior bundle to `secrets.bundle.json.bak.<UTC>` before
  rewriting; the secret **value** is moved, never printed.

```bash
$ pqc-secrets list
3 secret name(s) in /home/user/.config/pqc-secrets/secrets.bundle.json:
  HF_TOKEN
  KILO_API_KEY
  ZAI_API_KEY
$ pqc-secrets rename KILO_API_KEY LOCALROUTER_KILO_API_KEY
Renamed KILO_API_KEY -> LOCALROUTER_KILO_API_KEY (backup: .../secrets.bundle.json.bak.20260822T182904Z)
```

### 5.5 `pqc-secrets rotate`

Re-encapsulate the bundle against a fresh ephemeral ML-KEM keypair.
**Data-key only** — the long-term identity key in the keychain is
NOT changed. See §10.2 for full identity rotation.

**Synopsis:** `pqc-secrets rotate [--bundle PATH]`

**Behavior:**
1. Decapsulates the existing data key using the current keychain entry.
2. Generates a fresh **ephemeral** ML-KEM keypair in a temp directory
   (not the keychain).
3. Re-encapsulates the data key against the new pubkey.
4. Backs up the old bundle to `secrets.bundle.json.bak.<UTC>`.
5. Atomically renames the new bundle over the old.
6. Emits a single audit log event: `rotate keysAffected=N`.

**Exit codes:**
- `0` — success
- `1` — bundle corrupt or write failed
- `2` — keychain entry missing

**Example:**
```bash
$ pqc-secrets rotate
Backed up to secrets.bundle.json.bak.2026-06-09T15-00-00Z
Re-encapsulated 12 keys against fresh ephemeral KEM keypair
Wrote secrets.bundle.json (4 KB)
Audit: rotate keysAffected=12
```

### 5.6 `pqc-secrets status`

Output machine-readable JSON describing the bundle state.

**Synopsis:** `pqc-secrets status`

**Output (stdout, JSON):**
```json
{
  "keychainOk": true,
  "recipientFp": "sha3:19df3b3f86de13a983abe68801f3b6512e21310cfda70cf89b5b3dcc68b1a433",
  "bundleFp": "sha3:...",
  "nKeys": 15,
  "createdUtc": "2026-06-07T18:47:58.715239Z"
}
```

**Exit codes:** `0` always (status never fails the call — use the
fields to detect problems).

### 5.7 `pqc-secrets audit`

Append a custom event to the audit log.

**Synopsis:** `pqc-secrets audit --event <name> [--key k=v]...`

**Behavior:** Emits one line to `~/.config/pqc-secrets/audit.log`
(mode 0o600). Useful for non-MCP callers (shell scripts, CI) to
record secret operations.

**Example:**
```bash
$ pqc-secrets audit --event shell_export --key user=$USER --key n_keys=12
Audit: shell_export user=nbiish n_keys=12
```

### 5.8 `pqc-secrets gen` — SOTA secret generation (2026-08-29)

Generate new high-entropy secrets (API keys, device secrets, tokens)
from the OS CSPRNG. Python engine only (stdlib `secrets` → `getrandom(2)`
on Linux, `BCryptGenRandom` on Windows, `SecRandomCopyBytes` on macOS).
Never uses the `random` module.

**Synopsis:**
```
pqc-secrets gen [--bits N | --bytes N] [--format b64|hex|b85]
                [--words N] [--sep S] [--count N] [--env NAME]
                [--quiet] [--allow-weak]
```

**Policy (design basis, Aug 2026):**
- **Entropy floor:** 256 bits minimum (enforced; `--allow-weak`
  overrides). Default is **512 bits** (64 bytes) — sized for
  long-term machine secrets, far above the NIST SP 800-63B-4
  verifier minimums. Max 8192 bits.
- **Uniformity:** `secrets.choice` / `token_*` use rejection
  sampling internally — no modulo bias in any mode.
- **Passphrase mode:** EFF large wordlist (7,776 words ≈ 12.925
  bits/word), SHA-256-pinned at `scripts/eff_large_wordlist.txt`
  and verified at load; generation **refuses** a tampered list.
  Floor: 6 words (~77.5 bits); default 8 words (~103.4 bits).
- **Hygiene:** the secret goes to **stdout only**; all metadata
  (bits, format, char count) goes to **stderr**. The value is never
  logged, echoed, or written to disk by the command. `--quiet`
  silences stderr.

**Modes:**
- Byte mode (default): `--bits N` / `--bytes N`, format `b64`
  (base64url, default — shell/URL/JSON-safe), `hex`, or `b85`
  (RFC 1924, densest).
- Word mode: `--words N` (diceware from the pinned EFF list),
  `--sep S` separator (default `-`).
- `--count N` — N independent secrets, one per line (1–64).
- `--env NAME` — emit `NAME=<secret>` lines, pipe-ready for `pack`.

**Examples:**
```bash
# Default: 512-bit base64url secret (86 chars), metadata on stderr
$ pqc-secrets gen

# wtf-hub device secret shape (256-bit hex, 64 chars)
$ pqc-secrets gen --format hex --bits 256 --quiet | wtf key issue <name>

# Generate + pack into the PQC bundle without the value ever hitting
# a disk file or the screen:
$ pqc-secrets gen --env WTF_WINDOWS_AGENT_SECRET --quiet | pqc-secrets pack

# Memorable but strong vault passphrase (~103 bits)
$ pqc-secrets gen --words 8

# Batch of 5 hex tokens at 384 bits each
$ pqc-secrets gen --format hex --bits 384 --count 5 --quiet
```

**Naming:** apply the tool-prefix convention from §4 —
`WTF_*`, `AINISHCODER_*`, `<TOOLNAME>_<WHAT>_API_KEY` — when using
`--env`; `gen` accepts any valid identifier but the bundle audit
(`pqc-secrets list`) should always make the owning tool obvious.

---

## §6 Bundle JSON Schema

The bundle at `~/.config/pqc-secrets/secrets.bundle.json` is the
canonical encrypted store. **Safe to commit** — every value is
AES-256-GCM ciphertext wrapped by ML-KEM-768.

> **Schema verified 2026-06-09 against the live bundle at
> `~/.config/pqc-secrets/secrets.bundle.json` (engine:
> `rust-fips203`).** Field names are the actual production names,
> not the long-form names used in earlier drafts. Code that parses
> bundles must use these exact names.

### 6.1 Top-level structure

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

| Field | Type | Required | Meaning |
|---|---|---|---|
| `version` | integer | yes | Bundle format version. Currently `1`. |
| `alg` | string | yes | Algorithm descriptor. `ML-KEM-768` (top-level — also see `keywrap.kdf` and `data.aad`). |
| `engine` | string | yes | Engine version, e.g. `rust-fips203`. |
| `created_utc` | string | yes | ISO 8601 UTC timestamp with microseconds. |
| `recipient` | object | yes | Public key fingerprint (see below). |
| `kem` | object | yes | ML-KEM-768 encapsulation of the wrapped key. |
| `keywrap` | object | yes | AES-256-GCM-wrapped data key, derived via SHA3-256 KDF. |
| `data` | object | yes | AES-256-GCM ciphertext of the secret bundle, with AAD. |

**Field name conventions** (verified against the live bundle):
- `alg` — single string, NOT `algorithm`
- `created_utc` — NOT `createdAt`
- `recipient`, `kem`, `keywrap`, `data` — all lowercase, no separators
- Sub-fields use `_b64` suffix for base64-encoded values

### 6.2 `recipient` object

```json
{
  "public_key_sha3_256": "19df3b3f86de13a983abe68801f3b6512e21310cfda70cf89b5b3dcc68b1a433"
}
```

| Field | Type | Meaning |
|---|---|---|
| `public_key_sha3_256` | string | SHA3-256 hex of the public key (64 hex chars = 32 B digest). NOT the public key bytes themselves. |

> The `recipient` block does NOT contain the public key — only its
> SHA3-256 fingerprint. To recover the public key, look at
> `~/.config/pqc-secrets/recipient.pub` on disk. The fingerprint in
> the bundle lets the verifier check that the on-disk `recipient.pub`
> matches the bundle's intent (defense-in-depth against
> `recipient.pub` substitution).

### 6.3 `kem` object

```json
{
  "ciphertext_b64": "b14Q16NAByG+rLOib05Mwj2N9NMFeZcX..."
}
```

| Field | Type | Meaning |
|---|---|---|
| `ciphertext_b64` | string | Base64-encoded ML-KEM-768 KEM ciphertext (1088 B raw, ~1452 B encoded). |

### 6.4 `keywrap` object

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
| `ciphertext_b64` | string | Base64-encoded wrapped data key ciphertext WITH the 16-byte GCM auth tag appended (no separate `tag` field). |

### 6.5 `data` object

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
| `ciphertext_b64` | string | Base64-encoded encrypted secret bundle WITH the 16-byte GCM auth tag appended (no separate `tag` field). |

> The GCM auth tag is **appended** to the ciphertext, not stored in
> a separate `tag` field. To extract: `tag = ciphertext[-16:]`,
> `ciphertext = ciphertext[:-16]`.

### 6.6 Complete example (with realistic sizes)

```json
{
  "version": 1,
  "alg": "ML-KEM-768",
  "engine": "rust-fips203",
  "created_utc": "2026-06-07T18:47:58.715239Z",
  "recipient": {
    "public_key_sha3_256": "19df3b3f86de13a983abe68801f3b6512e21310cfda70cf89b5b3dcc68b1a433"
  },
  "kem": {
    "ciphertext_b64": "b14Q16NAByG+rLOib05Mwj2N9NMFeZcX..."
  },
  "keywrap": {
    "kdf": "SHA3-256",
    "aad": "pqc-secrets:v1:keywrap",
    "nonce_b64": "i1WOwoxZRKzr/sw2",
    "ciphertext_b64": "j0KPhYjZz9TwTHYgIMxvI+4VeNIkR9qOkTnqrSwlBrx8BKOXWUQWK97OiQG+dLms"
  },
  "data": {
    "aad": "pqc-secrets:v1:data",
    "nonce_b64": "zoq1...",
    "ciphertext_b64": "..."
  }
}
```

### 6.7 Size reference (approximate)

| Field | Encoded size (B) | Raw size (B) |
|---|---|---|
| `recipient.public_key_sha3_256` | 64 | 32 (digest) |
| `kem.ciphertext_b64` | ~1452 | 1088 |
| `keywrap.ciphertext_b64` | ~64 | 48 (32 data + 16 tag) |
| `keywrap.nonce_b64` | ~16 | 12 |
| `data.ciphertext_b64` | variable | N×~100 + 16 |
| `data.nonce_b64` | ~16 | 12 |

A bundle with ~12 keys of ~100 B each typically weighs ~4 KB on disk
(verified: live bundle is 4,097 B with ~15 keys).

### 6.8 Validation

Run the bundle verifier to confirm structural integrity:

```bash
$ python3 .agents/skills/pqc-secrets/scripts/verify-bundle.py
OK: bundle validates, recipient.fp=sha3:19df3b3f..., ~15 keys, 0 plaintext leaks
$ echo $?
0
```

The verifier checks: required fields (top-level + per-block),
`kem.ciphertext_b64` length == 1088 B (raw, ML-KEM-768),
`data.nonce_b64` length == 12 B (raw, AES-GCM),
`data.ciphertext_b64` length >= 16 B (GCM tag present),
`recipient.public_key_sha3_256` is 64 hex chars of valid hex, and
scans for plaintext secret patterns (`sk-live`, `sk-test`,
`whsec_`, `AKIA`, `ghp_`).

---

## §7 Agent Integration Recipes

### 7.1 Hermes MCP (betterbrowsermcp)

The `@nbiish/betterbrowsermcp` MCP server exposes 9 PQC secrets tools
to any Hermes agent:

| Tool | Purpose |
|---|---|
| `browser_secrets_status` | Check keychain + bundle health. Returns JSON. |
| `browser_secrets_list` | List secret **names** (no values). |
| `browser_secrets_get` | Read one secret value. Optional `mode: 'plain'\|'redact'`. |
| `browser_secrets_load` | Bulk-export bundle into the agent's process env. |
| `browser_secrets_add` | Add a new secret. Optional `dry_run: true`. |
| `browser_secrets_add_from_clipboard` | Pull a value from the page's clipboard write. |
| `browser_secrets_unlock_agent` | Cache one secret value in agent memory for fast reads. |
| `browser_secrets_lock_agent` | Clear a cached secret (or wipe all). |
| `browser_secrets_copy_to_page` | Paste a secret into a focused form field. |

**Hermes config (`~/.hermes/config.yaml`):**

```yaml
mcp_servers:
  betterbrowsermcp:
    command: node
    args:
      - /path/to/betterbrowsermcp/dist/index.js
    env:
      BROWSER_MCP_AGENT_ID: hermes
      BROWSER_MCP_PORT: '9109'
```

Add `betterbrowsermcp` to `platform_toolsets.cli` and `/reload-mcp`.
The LLM uses `mcp_betterbrowsermcp_browser_secrets_*` tools directly.
The audit log at `~/.config/pqc-secrets/audit.log` records every call.

### 7.2 Claude Code (settings.json env-block trap)

Claude Code reads `~/.claude/settings.json` and `~/.claude/projects/*/settings.json`.
These files are committed-friendly JSON, **not encrypted**.

**WRONG — violates PQC:**
```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "OPENAI_API_KEY": "sk-proj-..."
  }
}
```

The key sits in a plaintext file that may sync to cloud backup, get
committed to a public dotfiles repo, or be read by any process with
file permissions.

**RIGHT — empty in settings, injected at runtime:**
```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://zenmux.ai/api/anthropic",
    "ANTHROPIC_API_KEY": "",
    "OPENAI_API_KEY": ""
  }
}
```

Then in `~/.zshrc` (sourced before `claude` is launched):
```bash
secrets-load() {
  eval "$(pqc-secrets export)"
}
```

`secrets-load` injects the values into the current shell's env, which
`claude` inherits. The settings file has empty strings; the real
values live in the encrypted bundle and the keychain.

### 7.3 VS Code / Cursor

Same trap in `.vscode/settings.json` and `.vscode/launch.json`:

```json
// .vscode/launch.json — WRONG
{
  "configurations": [{
    "env": {
      "API_KEY": "sk-..."  // NEVER do this
    }
  }]
}
```

Use a launch-time shell substitution or a task that calls
`pqc-secrets export` and sources the result before launching the
debug target.

### 7.4 Ainish-coder / generic shell wrapper

The `secrets-load` shell function (in `~/.zshrc`):

```bash
# Load PQC secrets into the current shell's environment
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
$ claude    # inherits $ANTHROPIC_API_KEY
$ cursor    # inherits $ANTHROPIC_API_KEY
```

The values are in process memory (volatile), not in any file.

---

## §8 Anti-pattern Catalog

Concrete violations found in real codebases, with their fixes.

### 8.1 `.env` files in repo

```gitignore
# .env (NEVER commit)
STRIPE_SECRET=sk-live-AbCd1234
```

**Fix:** Delete the `.env`. Add `secrets.bundle.json` reference to
the project README's "Setup" section. Add a `pqc-secrets pack` step
to the setup script.

### 8.2 `settings.json` env blocks

```json
{"env": {"API_KEY": "sk-..."}}
```

**Fix:** empty string in settings, keychain-injected at launch (see
§7.2).

### 8.3 `.vscode/launch.json` env blocks

Same trap. Use `${env:API_KEY}` with a launch task that runs
`secrets-load` first.

### 8.4 `env_file:` in docker-compose

```yaml
services:
  app:
    env_file: ./secrets.env  # plaintext on disk
```

**Fix:** use Docker secrets (mounted from a PQC-backed volume) or
pass at runtime via `docker run -e KEY=$(...)`.

### 8.5 Hardcoded API keys in source

```typescript
// src/config.ts
export const STRIPE_KEY = "sk-live-AbCd1234";
```

**Fix:** `export const STRIPE_KEY = process.env.STRIPE_KEY!;` and
ensure `process.env.STRIPE_KEY` is populated by `secrets-load` before
the process starts.

### 8.6 Logging secrets

```typescript
console.log("Got API key:", apiKey);
```

**Fix:** never log secret values. Log metadata only:
`console.log("Loaded API key, length:", apiKey.length);`

### 8.7 `printenv > .env` debug

```bash
printenv | grep -i key > .env   # NEVER
```

**Fix:** use `printenv | grep -i key` to stdout (visible) but never
redirect to a file. Or use `pqc-secrets status` to inspect the bundle
state without revealing values.

### 8.8 GitHub Actions plaintext secrets

```yaml
# .github/workflows/deploy.yml — acceptable for CI
env:
  API_KEY: ${{ secrets.API_KEY }}
```

**Acceptable** for CI runtimes — GitHub Actions secrets are
encrypted at rest by GitHub. **But:** every developer with repo
access can see and modify `secrets.API_KEY` in the GitHub UI.
For higher-security deployments, use an external secrets manager
(HashiCorp Vault, AWS Secrets Manager) that the CI calls at runtime.

### 8.9 Screen recordings / terminal scrollback

If you record your terminal (e.g., for a tutorial), redact the
output of `pqc-secrets export` before recording. Or use
`pqc-secrets status` (no values) for demos.

---

## §9 Audit Log Format

### 9.1 Spec

The audit log is an append-only file at
`~/.config/pqc-secrets/audit.log`, mode `0o600` (owner read+write
only). One event per line:

```
<ISO8601-UTC with millisecond precision> TAB <actor> TAB <action> TAB name=<NAME> TAB mode=<MODE> TAB tab=<TAB> TAB <detail>
```

- **ISO8601-UTC** — e.g. `2026-06-10T15:24:49.572Z` (with
  millisecond precision, UTC)
- **actor** — `hermes` (the betterbrowsermcp MCP server). Reserved
  for multi-actor future; no other actor writes today.
- **action** — one of: `get | list | add | add_from_clipboard |
  rotate | load | unlock | lock | copy_to_page | status | fail`
  (note: real action names are `unlock` and `lock`, not the
  longer `unlock_agent` / `lock_agent` that the v0.7.0 specs
  used)
- **name/mode/tab** — see Field meanings table
- **detail** — free-form `key=value` pairs, semicolon-separated
  for compound values

### 9.2 Example lines (TAB-separated, real audit.log output)

```
2026-06-10T15:24:49.572Z	hermes	add	name=BBMCP_TEST_KEY	mode=-	tab=-	merge=true; total=14; value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:12.001Z	hermes	get	name=BBMCP_TEST_KEY	mode=plain	tab=-	value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:13.402Z	hermes	get	name=BBMCP_TEST_KEY	mode=redact	tab=-
2026-06-10T15:25:30.118Z	hermes	unlock	name=BBMCP_TEST_KEY	mode=-	tab=42	value-fp=sha3:549ab3b879785c99
2026-06-10T15:25:35.224Z	hermes	lock	name=BBMCP_TEST_KEY	mode=-	tab=42
2026-06-10T15:27:18.033Z	hermes	rotate	name=-	mode=-	tab=-	old=sha3:61b547a65b7c806a...; new=sha3:6de4314e19c83b75...; count=15; backup=/Users/nbiish/.config/pqc-secrets/secrets.bundle.json.bak.2026-06-10T15-27-18-012Z
```

**Field separator is TAB, not space.** Always use `-F'\t'` with
awk or `grep -P '\t'` for tab-aware parsing. Plain `grep` and
`awk '{print $2}'` work because fields contain no spaces within
themselves, but tab-aware parsing is more correct.

### 9.3 Field meanings

- `actor` — `hermes` (the betterbrowsermcp MCP server). Reserved
  for multi-actor future; no other actor writes today.
- `action` — the operation (see §9.1)
- `name=<secret_name>` — name of the secret touched, or `-`
- `mode=plain|redact` — only on `get` events, or `-`
- `tab=<id>` — bound tab id (as string), or `-`
- `value-fp=sha3:<16hex>` — SHA3-256 fingerprint, first 16 hex
  chars, NEVER the value. Present on get, add, unlock, copy_to_page.
- `merge=true|false`, `total=<n>` — bundle diff stats on `add`
- `old=<sha3:...>; new=<sha3:...>; count=<n>; backup=<path>` —
  rotate event
- `ref=<eN>` — snapshot ref on `copy_to_page` events
- `error=<text>` — present on `copy_to_page` failures
- `detail=<text>` — present on `lock` (all) as
  `all-unlocked-cleared`

### 9.4 Retention

- Keep forever in the current file (`audit.log`).
- Monthly archive to `audit.log.YYYY-MM` when file size exceeds
  10 MB. Archive is a `mv` (no rewrite).
- Total retention is unlimited. Audit log is small per event
  (~80 bytes); 10 MB holds ~125,000 events.
- The user controls retention. The system does NOT auto-delete.

### 9.5 Verification use cases

- "Did my agent read STRIPE_SECRET in the last hour?"
  → `grep 'name=STRIPE_SECRET' ~/.config/pqc-secrets/audit.log | tail -20`
- "What keys were added today?"
  → `grep -E '^[0-9-]+\thermes\tadd' ~/.config/pqc-secrets/audit.log | grep $(date -u +%Y-%m-%d)`
- "When was the last rotation?"
  → `grep '\thermes\trotate\t' ~/.config/pqc-secrets/audit.log | tail -1`
- "Did anyone read ANTHROPIC_API_KEY today?"
  → `grep 'name=ANTHROPIC_API_KEY' ~/.config/pqc-secrets/audit.log | grep $(date -u +%Y-%m-%d)`
- "Verify a value matches what's in the bundle"
  → `echo -n '<value>' | shasum -a 256 - | cut -c1-16` and
  compare against `value-fp=sha3:...` in the log entry.

### 9.6 Implementation reference

The audit writer lives in
`betterbrowsermcp/src/audit.ts` and exposes two functions:

```ts
import { logAuditEvent, valueFingerprint } from "../audit";

// Append one event (non-blocking, best-effort).
logAuditEvent({
  action: "get",
  mode: "plain",
  name: "STRIPE_SECRET",
  detail: `value-fp=${valueFingerprint(value)}`,
});

// Compute a SHA3-256 fingerprint, first 16 hex chars.
const fp = valueFingerprint("sk-live-AbCd...");
console.log(fp);  // → sha3:549ab3b879785c99
```

---

## §10 Rotation Runbook

### §10.1 Routine data-key rotation (default — via `browser_secrets_rotate` MCP tool)

This is the **recommended path** for agents and humans alike. The
`browser_secrets_rotate` tool (betterbrowsermcp v0.8.0+) does the
full rotate op atomically: backup → re-encrypt → report.

**The recommended path (MCP):**
```
LLM: "Rotate the PQC bundle."
→ browser_secrets_rotate
← "Rotated PQC bundle.
   Old fingerprint: sha3:4d96075ada91fa0b...
   New fingerprint: sha3:0ae9fa5052c82b65...
   Previous bundle backed up to
   /Users/nbiish/.config/pqc-secrets/secrets.bundle.json.bak.<UTC>
   (retain for 7 days, then delete with: rm <path>).
   N secret(s) re-encrypted with a fresh data key and a
   fresh ML-KEM-768 shared secret. The identity keypair in
   the keychain is unchanged."
```

**Audit log entry** (one event, real format):
```
2026-06-10T15:27:18.033Z	hermes	rotate	name=-	mode=-	tab=-	old=sha3:61b5...; new=sha3:6de4...; count=15; backup=...
```

**The manual path (CLI, for non-MCP contexts):**

This is the routine operation. Re-encapsulates the AES data key
against a fresh ephemeral KEM keypair. The long-term identity key
in the keychain is unchanged.

**Steps:**
1. **Backup** current bundle:
   ```bash
   cp ~/.config/pqc-secrets/secrets.bundle.json \
      ~/.config/pqc-secrets/secrets.bundle.json.bak.$(date -u +%Y%m%dT%H%M%SZ)
   ```
2. **Decapsulate** the data key using the existing keychain entry.
   Every key is read once (audit log emits one `get` event per key
   with `mode=plain` — this is internal to the rotate op).
3. **Generate fresh ephemeral ML-KEM keypair** in a temp directory
   (e.g. `/tmp/pqc-rotate-XXXXXX`). Not stored in keychain.
4. **Re-encapsulate** the data key against the new pubkey.
5. **Re-pack**: write new bundle with new `kem.ciphertext` to the
   temp directory.
6. **Atomic rename** over the old bundle (`fs.rename` after `fsync`).
7. **Verify** with `verify-bundle.py` (`.agents/skills/pqc-secrets/scripts/`):
   ```bash
   python3 .agents/skills/pqc-secrets/scripts/verify-bundle.py
   ```
   Expect exit 0.
8. **Audit log** emits a single `rotate keysAffected=N` event.

Frequency: monthly for high-value deployments, quarterly for typical.

### §10.2 Full identity rotation (out-of-band ceremony)

Required when the long-term ML-KEM-768 key in the keychain is
**compromised** or **scheduled** for rotation (annually, after a
security incident, or when an employee with keychain access leaves).

**Steps:**
1. **Generate new keypair** (do NOT overwrite the existing one yet):
   ```bash
   pqc-secrets keygen --recipient-out /tmp/pqc-new-recipient.pub
   ```
2. **Decapsulate** the existing bundle using the current keychain
   entry (one `get mode=plain` per key in the audit log).
3. **Write the new keypair to the keychain** (overwriting the
   current entry):
   ```bash
   pqc-secrets keygen --in-place   # writes to keychain, recipient.pub
   ```
4. **Re-pack** with the new recipient:
   ```bash
   pqc-secrets pack --bundle ~/.config/pqc-secrets/secrets.bundle.json
   ```
5. **Distribute** `recipient.pub` to **every consumer** (every agent
   config that points at this bundle — Hermes MCP, shell wrappers,
   CI runners, etc.).
6. **Verify** with `verify-bundle.py`.
7. **Old keychain entry** is kept for a **7-day grace period** in
   case distribution is partial (some consumers still need it). After
   7 days, delete:
   ```bash
   security delete-generic-password -s pqc-secrets -a ml-kem-768
   ```
8. **Audit log** emits two events: `rotate_identity keysAffected=N`
   and `revoke_old_key grace_until=<UTC+7d>`.

### §10.3 Disaster recovery — Lost keychain entry

If the keychain is wiped (Time Machine restore failure, accidental
`security delete-generic-password`, etc.), the data in
`secrets.bundle.json` is **unrecoverable**. PQC keys are not
escrowed; this is intentional.

**Recovery requires:**
- A working keychain entry (the only one)
- OR a backup of the bundle's **plaintext** (which should never
  exist on disk per the threat model)

**Mitigations:**
- Keep the keychain entry on a Time Machine backup volume. Verify
  monthly that the backup includes the `pqc-secrets` service.
- Maintain N=5 generations of bundle backups (the rotate op
  naturally produces one; copy older generations from your existing
  bundle history).
- **Critical:** never write the bundle plaintext to disk. If you
  must export a value for a one-time use, pipe it directly:
  `pqc-secrets export | grep STRIPE_SECRET | cut -d= -f2- | tr -d '"' | my-tool`
  (no intermediate file).

---

## §11 Threat Model Statement

### Primary risk: plaintext on disk

The dominant threat vector is **plaintext on disk** — secrets ending
up in:

- `.env` files (committed or uncommitted)
- `env:` blocks in `settings.json`, `launch.json`, etc.
- Hardcoded API keys in source code
- Accidental `print()` / `console.log()` of secret values
- Debug log files
- Terminal scrollback / history
- Screen recordings
- Backups (unencrypted Time Machine volumes, cloud sync of
  unencrypted dotfiles)
- `printenv > .env` debugging

Every one of these is a PQC violation — the secret is in plaintext,
not in the bundle, not protected by ML-KEM-768 + AES-256-GCM.

### In-memory reads are trusted

Reads by the user's own LLM (or shell, or CI runner) are **not
gated**. The LLM is operating on the user's behalf, with the user's
authority, on the user's machine. The audit log captures every
read so the user can verify "did I really read X at Y time?"

This maximizes availability and usability for the single-user
local agent. We do not add an auth gate, token check, or rate limit
on `secrets_get` — those would slow down the user's workflow
without adding real security (the LLM has the same access the user
has).

### Cross-tab leakage prevention

Cross-tab leakage is prevented structurally: destructive tools
(`secrets_copy_to_page`, `secrets_add_from_clipboard`,
`secrets_unlock_agent`, `secrets_add`) require an explicit `tabId`.
The MCP server refuses to dispatch a paste to "the active tab" —
the LLM must name the bound tab. This prevents an attacker who
controls one tab from triggering a paste into a different tab.

### The audit log is the verification surface

The audit log answers: **"What did my agent do with my secrets?"**

It is append-only (no in-place edits), mode 0o600 (only the user
can read it), and structured (one event per line, machine-parseable).
A user who suspects unauthorized access can `grep` the log for
unfamiliar agent IDs, unexpected tab IDs, or operations at unusual
hours.

### Out of scope

- **Multi-user secrets** — single-user model. Per-user bundles live
  at `~/.config/pqc-secrets/`. Multi-user deployments need
  per-user bundles and a shared unlock key (TBD).
- **Hardware-bound key attestation** beyond the OS keychain —
  T2/M-series Macs have hardware-backed keychain, but we don't
  verify this attestation at decrypt time.
- **Network-exposed secrets** — everything is local-only. The
  bundle is on disk; the keychain is local; the audit log is local.
  There is no remote API.
- **Classical crypto fallback** — if ML-KEM-768 is unavailable, the
  bundle cannot be read. There is no fallback to RSA, ECDH, or any
  classical KEM.
