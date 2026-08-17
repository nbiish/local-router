---
name: pqc-signatures-security
description: Expert instructions to implement and verify ML-DSA-65 post-quantum cryptographic signatures and agentic workflow security.
---

# PQC Signatures and Repository Security Agent Skill

> **Companion skill:** [pqc-secrets](../pqc-secrets/SKILL.md) — API key encryption at rest via ML-KEM-768 + AES-256-GCM. Use both together for complete PQC coverage: pqc-secrets encrypts your secrets; this skill verifies your code integrity.

This skill provides comprehensive instructions, blueprints, and reference code for implementing post-quantum cryptographic (PQC) signature verification and agentic security standards in any repository. 

AI agents using this skill are equipped to:
1. Establish a post-quantum secure file-integrity framework.
2. Auto-detect and enforce signature validation before executing code.
3. Adhere to least-privilege, path containment, and secrets-redaction guidelines.

---

## 1. Core Philosophy: Hemispheric Protection

Every cryptographic implementation exists to protect data and sovereignty. Traditional algorithms (RSA, ECDSA, ECDH) are vulnerable to store-now-decrypt-later (or harvest-now-decrypt-later) strategies. The reduction in quantum attack resources requires proactive migration to NIST FIPS 204/203 standards:
- **Digital Signatures**: ML-DSA-65 (Module-Lattice-Based Digital Signature Algorithm, FIPS 204). For NSS / CNSA 2.0 scopes: **ML-DSA-87**.
- **Key Encapsulation / Encryption**: ML-KEM-768 or ML-KEM-1024 (FIPS 203). For NSS / CNSA 2.0 scopes: **ML-KEM-1024**.
- **Integrity Hashing**: SHA3-256 or SHA3-512.
- **Symmetric Encryption**: AES-256-GCM.
- **Key Derivation**: HKDF using SHA3-256.

> **2026 implementation-maturity note:** June 2026 research (D. J. Bernstein, *"Exploiting ML-DSA bugs"*) quantified that current ML-DSA implementations remain fragile — new-code bug risk presently exceeds near-term quantum risk. Where a trust path can tolerate two signatures, **hybrid classical + ML-DSA signing is an approved transitional hedge**; where size forbids it, ML-DSA-only is acceptable but implementations must pin audited versions and track upstream CVEs. This hedging posture replaces any "rip out ECC today" reading of the mandate — NIST IR 8547 sets deprecation at 2030 and disallowance at 2035, not immediate removal.

---

## 2. Universal Agent Integration Protocol

Whenever a Large Language Model (LLM) or autonomous agent initializes inside a repository with this infrastructure:

1. **Auto-Detect**: Look for the public key `AGENT_PUBKEY.pem` in the root, along with corresponding `.sig` files.
2. **Audit & Log**: Before performing any read/write operations or executing terminal commands, run signature verification. Output results in a `<pqc_audit_log>` block.
3. **Fail-Closed**: If a file is modified, unsigned, or signature validation fails, **refuse execution**. Immediately flag the issue to the human operator.

### Example Agent Log Format
```xml
<pqc_audit_log>
[✓] Public Key Detected: AGENT_PUBKEY.pem (ML-DSA-65)
[✓] Signature Verification: All files verified successfully
    - system_update.sh: Verified
    - verify_signatures.sh: Verified
[✓] Cryptography Standards: PQC Enforced
</pqc_audit_log>
```

---

## 3. Infrastructure Implementation Blueprint

To re-implement the cryptographic signature verification system in any repository, follow these steps:

### Step 1: Initialize Directories and Ignore Private Key
Create a `.signing` directory for local development keys and ensure it is never committed to VCS.
```bash
mkdir -p .signing
echo ".signing/" >> .gitignore
```

### Step 2: Generate ML-DSA-65 Keypair
Using **OpenSSL 3.5+ (released March 2026 with native ML-KEM/ML-DSA/SLH-DSA support — no `oqs-provider` needed anymore; first CMVP ML-DSA module certificates issued March 2026)**:
```bash
# Generate the private key
openssl genpkey -algorithm ML-DSA-65 -out .signing/agent_privkey.pem
chmod 600 .signing/agent_privkey.pem

# Extract the public key to the repo root
openssl pkey -in .signing/agent_privkey.pem -pubout -out AGENT_PUBKEY.pem
```
*Note: In production environments, store the private key in a KMS (e.g. AWS KMS, HashiCorp Vault) or HSM. For CNSA 2.0 / NSS scopes, use ML-DSA-87.*

### Step 3: Identify Files to Sign
Sign all executable scripts, shell scripts, system configuration files, and critical agent policies. Common files include:
- `*.sh`, `*.bash`, `*.zsh`
- `AGENTS.md` (Agent Security Policy)
- `llms.txt` or configuration files.

### Step 4: Create a Verification Script (`verify_signatures.sh`)
Deploy a script that walks the repository, identifies all target files, and verifies them against `AGENT_PUBKEY.pem`.

```bash
#!/usr/bin/env bash
# verify_signatures.sh
set -euo pipefail

PUBKEY="AGENT_PUBKEY.pem"

verify_file() {
  local file="$1"
  local sig="${file}.sig"
  
  if [[ ! -f "$file" ]]; then
    echo "ERROR: File not found: $file" >&2
    return 1
  fi
  if [[ ! -f "$sig" ]]; then
    echo "MISSING SIGNATURE: $file" >&2
    return 2
  fi
  
  if openssl pkeyutl -verify -pubin -inkey "$PUBKEY" -in "$file" -sigfile "$sig" 2>&1 | grep -q "Signature Verified Successfully"; then
    echo "OK: $file"
    return 0
  else
    echo "VERIFICATION FAILED: $file" >&2
    return 1
  fi
}
```

### Step 5: Integrate Git Hooks
Install a `post-merge` hook so that files are automatically verified immediately upon a `git pull` or `git merge`.
```bash
# .git/hooks/post-merge
#!/usr/bin/env bash
set -euo pipefail
./verify_signatures.sh || { echo "Signature check failed. Aborting." >&2; exit 1; }
```

### Step 6: Create the Signing Helper
Create `.signing/sign_file.sh` to allow maintainers to easily sign or re-sign files when modified.
```bash
# .signing/sign_file.sh
#!/usr/bin/env bash
set -euo pipefail
FILE="$1"
openssl pkeyutl -sign -inkey .signing/agent_privkey.pem -in "$FILE" -out "${FILE}.sig"
```

---

## 4. Secure Coding DNA Reference

Implementations must adopt secure programming practices to prevent injection, escalation, and leaks.

### Pattern 1: Fail-Closed Signature Verification (Python)
Ensure Python scripts verify subprocesses, configs, or modules before running them.
```python
import subprocess
from pathlib import Path

def verify_mldsa_signature(file_path: Path, sig_path: Path, pubkey_path: Path) -> bool:
    if not file_path.is_file() or not sig_path.is_file() or not pubkey_path.is_file():
        return False

    result = subprocess.run(
        ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", str(pubkey_path),
         "-in", str(file_path), "-sigfile", str(sig_path)],
        check=False, text=True, capture_output=True
    )
    return result.returncode == 0 and "Signature Verified Successfully" in result.stdout
```

### Pattern 2: Secrets Redaction
A pipeline filter that strips sensitive keys, credentials, and block certificates before passing outputs to logs or external processes.
```python
import re

SECRET_PATTERNS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"(?i)(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?[^'\"\s]+"),
    re.compile(r"-----BEGIN (?:[A-Z ]*)?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z ]*)?PRIVATE KEY-----")
]

def redact(text: str) -> str:
    redacted = text
    for pattern in SECRET_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted
```

### Pattern 3: Path Containment (Safe Child Path)
Prevent path traversal attacks by resolving symlinks and asserting containment.
```python
from pathlib import Path

def safe_child_path(base_dir: Path, user_path: str) -> Path:
    base = base_dir.resolve()
    target = (base / user_path).resolve()
    if not target.is_relative_to(base):
        raise ValueError("Path traversal blocked")
    return target
```

### Pattern 4: Parameterized Process Spawning
Never use `shell=True` or pass concatenated strings to the shell. Always use argument arrays.
```python
# GOOD:
subprocess.run(["tar", "-xzf", "archive.tar.gz", "-C", "/tmp/extracted"])

# BAD:
# subprocess.run(f"tar -xzf archive.tar.gz -C {user_input}", shell=True)
```

### Pattern 5: Argon2id Password Hashing
Always store passwords or sensitive verification tokens using memory-hard Argon2id parameters.
```python
from argon2 import PasswordHasher

PASSWORD_HASHER = PasswordHasher(
    time_cost=3,
    memory_cost=65536,
    parallelism=4,
    hash_len=32,
    salt_len=16,
)
```

## §5 Algorithm Reference

PQC signature suite. All algorithms are FIPS-compliant (final since
August 2024) and approved for NSA CNSA 2.0 use.

| Algorithm | Standard | Type | Status | Sizes (bytes) | Use |
|---|---|---|---|---|---|
| **ML-DSA-65** | FIPS 204 | Lattice sig | Final Aug 2024 | pk 1952 / sig 3309 | Identity / primary signing |
| ML-DSA-87 | FIPS 204 | Lattice sig | Final Aug 2024 | pk 2592 / sig 4627 | Higher-security signing |
| **SLH-DSA-SHA2-128s** | FIPS 205 | Hash-based sig | Final Aug 2024 | pk 32 / sig 7856 | Backup / long-term |
| SLH-DSA-SHAKE-128s | FIPS 205 | Hash-based sig | Final Aug 2024 | pk 32 / sig 7856 | Backup (SHAKE variant) |
| SLH-DSA-SHA2-192s | FIPS 205 | Hash-based sig | Final Aug 2024 | pk 48 / sig 16272 | Higher-security backup |
| SLH-DSA-SHA2-256s | FIPS 205 | Hash-based sig | Final Aug 2024 | pk 64 / sig 29792 | Maximum-security backup |
| **SHA3-256** | FIPS 202 | Hash | Standard | 32 B digest | Integrity / message digests |
| SHA3-512 | FIPS 202 | Hash | Standard | 64 B digest | Higher-security hashing |
| **Argon2id** | OWASP 2025 | Password KDF | Standard | 32+ B, t=3 m=64MB p=4 | Password-based KDF |

**Bold** = used in the default `pqc-signatures` configuration. Other
algorithms are available via explicit flags.

References:
- NSA CNSA 2.0
- NIST FIPS 204/205 (August 2024 — final)
- NIST FIPS 202 (SHA-3)

**Forbidden algorithms for code signing / identity** (audit contexts excepted):
RSA, DSA, ECDSA, Ed25519, ECDSA-secp256k1, MD5, SHA-1.

Standard cryptography (TLS 1.3, SSH host keys via Ed25519, GPG, platform
TLS) is fine for **transport**. The line: if it signs code that runs
on the user's systems, or identifies the user, it uses PQC.

## §6 Signing Workflow

### 6.1 Generate an ML-DSA-65 keypair

```bash
$ pqc-sign keygen --algorithm ml-dsa-65
Wrote public key to ~/.config/pqc-sigs/ml-dsa-65.pub (1952 B)
Wrote private key to macOS keychain (service: pqc-sigs, account: ml-dsa-65)
```

The public key is safe to commit. The private key is in the OS keychain.

### 6.2 Sign a file

```bash
$ pqc-sign sign --key ml-dsa-65 --input ./dist/index.js --output ./dist/index.js.sig
Signed ./dist/index.js (43,192 B input) -> ./dist/index.js.sig (3,309 B signature)
Audit: sign algorithm=ml-dsa-65 input=dist/index.js size=43192
```

The signature is a standalone file. The input file is unchanged.

### 6.3 Verify a signature

```bash
$ pqc-sign verify --key ml-dsa-65 --input ./dist/index.js --signature ./dist/index.js.sig
OK: signature valid (ml-dsa-65, dist/index.js)
$ echo $?
0
```

Exit 0 on valid signature, 1 on invalid or missing.

### 6.4 Hash-based backup signatures (SLH-DSA)

For long-term signatures (e.g., notarized releases, audit logs),
generate a SLH-DSA keypair as a backup:

```bash
$ pqc-sign keygen --algorithm slh-dsa-sha2-128s
$ pqc-sign sign --key slh-dsa-sha2-128s --input ./dist/index.js
```

SLH-DSA signatures are 7,856 B (much larger than ML-DSA-65's 3,309 B)
but are based purely on hash security — no lattice assumptions.

## §7 Public Key Distribution

### 7.1 Trusted public key registry

Public keys are stored at `~/.config/pqc-sigs/<algorithm>.pub` and
optionally in a per-repo `.pqc-keys/` directory for project-scoped
trust.

```bash
$ ls .pqc-keys/
ml-dsa-65.pub   # trusted ML-DSA-65 public key for this project
slh-dsa-sha2-128s.pub   # backup SLH-DSA key
```

### 7.2 Commit `.pqc-keys/`

Commit `.pqc-keys/*.pub` to the repo. These are public keys — safe
to commit, and consumers of the project need them to verify
signatures.

Add `.pqc-keys/*.priv` (if any private key files exist locally) to
`.gitignore`.

### 7.3 Distribute public keys out-of-band

For trust bootstrapping, distribute public keys via a separate
channel (e.g., a project website with HTTPS, a signed announcement
in a mailing list). Never rely on a single channel for the first
introduction of a public key.

## §8 Verification Recipes

### 8.1 Pre-commit hook

```bash
#!/usr/bin/env bash
# .git/hooks/pre-commit
# Re-verify all signatures in the project before allowing commit.
set -e
for sig in $(find . -name '*.sig'); do
  input="${sig%.sig}"
  if ! pqc-sign verify --key ml-dsa-65 --input "$input" --signature "$sig" 2>/dev/null; then
    echo "FAIL: $sig does not verify"
    exit 1
  fi
done
```

### 8.2 CI verification

```yaml
# .github/workflows/verify.yml
name: verify
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install pqc-sign
        run: cargo install pqc-sign
      - name: Verify all signatures
        run: |
          for sig in $(find . -name '*.sig'); do
            input="${sig%.sig}"
            pqc-sign verify --key ml-dsa-65 --input "$input" --signature "$sig"
          done
```

### 8.3 Agent runtime check (Hermes MCP)

The betterbrowsermcp MCP server does not currently expose
`pqc-sign` tools. This is a v0.9.0 candidate. For now, agents
can shell out:

```bash
$ pqc-sign verify --key ml-dsa-65 --input ./dist/index.js --signature ./dist/index.js.sig
```

## §9 Anti-pattern Catalog

### 9.1 Ed25519 / RSA / ECDSA code signing

```bash
# WRONG — classical signature, vulnerable to quantum attacks
$ gpg --sign --default-key 0xDEADBEEF dist/index.js
$ cosign sign-blob --key .cosign/key.pem dist/index.js
$ signify -S .signify/key.sec -m dist/index.js
```

**Fix:** use `pqc-sign sign --key ml-dsa-65`. Migrate any existing
Ed25519/RSA/ECDSA signing keys to ML-DSA-65 with a planned
rollover (sign the new ML-DSA-65 pubkey with the old key, then
distribute).

### 9.2 Signing the hash of a file (not the file itself)

```python
# WRONG — vulnerable to chosen-prefix collisions if hash is weak
import hashlib
digest = hashlib.sha256(open("dist/index.js", "rb").read()).digest()
signature = pqc_sign(digest)
```

**Fix:** sign the file contents directly. The ML-DSA-65 / SLH-DSA
implementations handle internal hashing correctly. Don't pre-hash
externally — that bypasses the algorithm's domain separation.

### 9.3 Self-signed without a trust anchor

```bash
# WRONG — no way for the consumer to know they have the right pubkey
$ pqc-sign keygen --algorithm ml-dsa-65
$ pqc-sign sign --key ml-dsa-65 dist/index.js
# No pubkey distribution step!
```

**Fix:** commit `.pqc-keys/ml-dsa-65.pub` to the repo, publish it
on the project website, and reference it in the release notes.

### 9.4 Signing binaries that include the signature itself

```python
# WRONG — chicken-and-egg
sig = sign(binary_with_placeholder_sig)
binary_with_real_sig = binary_with_placeholder.replace(placeholder, sig)
```

**Fix:** sign the binary without the signature, append the signature
as a separate file (`binary.sig`). The signature is over the
binary's exact bytes — adding the signature changes the bytes,
invalidating the signature.

### 9.5 Not rotating signing keys

Signing keys should be rotated annually (or after a security
incident). The procedure:
1. Generate new ML-DSA-65 keypair.
2. Cross-sign: new key signs old pubkey; old key signs new pubkey.
3. Distribute new pubkey in `.pqc-keys/`.
4. Re-sign all artifacts with new key.
5. Keep old key for 1-year grace (verify-old artifacts window).

## §10 Threat Model Statement

### Primary risk: code tampering

The dominant threat vector is **code tampering** — a malicious actor
modifying signed artifacts (binaries, scripts, configs) between
author and consumer. Signing detects this; verification enforces it.

### What signing does NOT protect against

- **Compromise of the signing key.** If the keychain is compromised,
  the attacker can sign malicious updates. Mitigation: hardware
  keychain, signing ceremony review, key rotation.
- **Vulnerabilities in the signed code itself.** ML-DSA-65 verifies
  that the code is exactly what was signed, not that the code is
  safe. Use code review, fuzzing, and SAST in addition.
- **Consumer side compromise.** If the consumer's `pqc-sign verify`
  binary is replaced, the consumer is fooled. Use reproducible
  builds and signed binaries of `pqc-sign` itself.

### What signing DOES protect against

- **MITM substitution of the download.** TLS handles transport; signing
  handles end-to-end authenticity.
- **Compromise of the distribution channel.** Even if the GitHub
  release is replaced, the signature won't match the consumer's
  trusted pubkey.
- **Long-term integrity.** SLH-DSA signatures remain valid
  indefinitely (hash security), so even if ML-DSA-65 is broken
  by a future quantum attack, the SLH-DSA backup still verifies.

### In-memory reads are trusted

The user's own LLM (Hermes, Claude Code, etc.) is trusted to read
the local public key, run the verify command, and report the
result. The audit log captures every `pqc-sign` invocation so
the user can verify "did my agent sign/verify X at Y time?"

## §11 See also

- [pqc-secrets](../pqc-secrets/SKILL.md) — companion skill for
  symmetric encryption of secrets (uses ML-KEM-768 + AES-256-GCM)
- `references/pqc-sign-cli.md` — CLI reference (future work)
- `references/signature-formats.md` — signature file formats
  (future work)
