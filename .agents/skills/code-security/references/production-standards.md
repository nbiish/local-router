# Code Security — Production-Grade Engineering Standards

> Deploy with: `ainish-coder --secure <target-dir>`  
> Owning skill: `../SKILL.md`  
> Governance: `../../production-security/SKILL.md`

---

## Determinism & Containment

The code that runs the agent must be absolutely reliable. It is the cage that contains the AI.

- **No reflection, metaprogramming, or dynamic dispatch in critical paths.**
- **Pure functions** for core logic. I/O at edges only.
- **Time and randomness injected as dependencies**, never accessed directly.
- **Cyclomatic complexity ≤ 10 per function.**

---

## Input Validation (Non-Negotiable)

Every input is hostile until proven otherwise.

### Path Traversal (CWE-22)

```
Blocked: open(user_path)                          — no containment check
Blocked: os.path.join(base, user_path)             — join alone does not prevent traversal
Use:     safe_path(user_path, allowed_root)         — resolves + checks is_relative_to
```

```python
from pathlib import Path

def safe_path(filename: str, root: Path = Path("/workspace").resolve()) -> Path:
    target = (root / filename).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"Path traversal blocked: {filename}")
    return target
```

### SQL Injection (CWE-89)

```
Blocked: f"SELECT * FROM t WHERE id = {user_input}"     — string interpolation
Blocked: cursor.execute("SELECT * FROM t WHERE id = %s" % user_input)
Use:     session.execute(text("... WHERE id = :id"), {"id": user_input})
```

### Command Injection (CWE-78)

```
Blocked: subprocess.run(f"cat {filename}", shell=True)   — shell=True + user data
Blocked: os.system(user_input)                           — always unsafe
Use:     subprocess.run(["cat", filename], shell=False, check=True)
```

### Cross-Site Scripting (CWE-79)

```
Blocked: innerHTML = user_content                        — raw HTML injection
Blocked: document.write(user_content)
Use:     textContent = user_content                      — browser handles escaping
Use:     DOMPurify.sanitize(user_content)                — allow safe HTML subset
```

### SSRF (CWE-918) & URL Validation

```
Blocked: requests.get(user_url)                          — no validation
Use:     validate_url() → allowlist check → then fetch
```

```python
from urllib.parse import urlparse
from ipaddress import ip_address

BLOCKED_PREFIXES = ("127.", "10.", "192.168.", "172.16.", "0.", "169.254.")
ALLOWED_SCHEMES = ("https",)

def validate_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in ALLOWED_SCHEMES:
        return False
    host = parsed.hostname
    if host is None:
        return False
    if host in ("localhost", "0.0.0.0", "[::1]"):
        return False
    try:
        ip = ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local:
            return False
    except ValueError:
        pass
    return True
```

---

## Secrets Management

```
Blocked: API_KEY = "sk-abc123..."                     — hardcoded in source
Blocked: config.json with apiKey: ***                — plaintext in repo
Blocked: .env files with live keys, even gitignored    — PQC mandate: nothing plaintext on disk
Use:     PQC secrets bundle + OS-keychain custody
         (~/.config/pqc-secrets/secrets.bundle.json,
          ML-KEM-768 + AES-256-GCM) loaded at runtime
          via `bin/pqc-secrets export` → env vars
Use:     `secrets-load` shell function / `security find-generic-password`
```

- Secrets loaded at runtime only — never in config files, never in git, never in `.env`. **2026 OWASP Agentic guidance:** short-lived, task-scoped credentials by default; rotate per task or per >90d whichever comes first (data-key rotation is implicit in every `pqc-secrets pack` call).
- For NSS / CNSA 2.0 scopes, wrap with ML-KEM-1024 + sign with ML-DSA-87.
- `.env.example` templates only. `gitleaks`/`detect-secrets` pre-commit.
- Use least-privilege API keys scoped to specific functions.

---

## Cryptography

### Never Use (Classical — Banned for Secrets Ops; Deprecation Clock per NIST IR 8547)

RSA, DSA, ECDSA, ECDH, Ed25519 (secrets/signing), MD5, SHA-1, DES, 3DES, Blowfish, AES-CBC, AES-ECB. Deprecated for all new systems after 2030; disallowed after 2035.

### Always Use (Post-Quantum)

| When You Need | Use | Standard |
|---------------|-----|----------|
| Key exchange | ML-KEM-768 (civilian) / ML-KEM-1024 (CNSA 2.0 / NSS) | FIPS 203 |
| Signing | ML-DSA-65 (civilian) / ML-DSA-87 (CNSA 2.0 / NSS) | FIPS 204 |
| Hash-only sign (backup) | SLH-DSA-SHA2-128s (not CNSA 2.0) | FIPS 205 |
| Symmetric | AES-256-GCM / ChaCha20-Poly1305 | SP 800-38D |
| Password hashing | Argon2id (t=3, m=65536, p=4, len=32) | OWASP 2025 |
| Migration (TLS) | X25519 + ML-KEM-768, SP 800-227 combiner | RFC 9794-era |
| Signing during transition | Hybrid classical + ML-DSA acceptable | DJB June 2026 |

---

## Compiler Integrity (Source ≠ Binary)

The source you audit is not the binary you ship. Spec-compliant optimizers legally delete security scaffolding (Domas, Black Hat 2026 — see `../SKILL.md` §2).

```
Blocked: plain memset() to wipe secrets                  — deleted as dead store; secrets linger in heap
Use:     memset_s() / explicit_bzero() / volatile-loop   — barriers the optimizer must honor

Blocked: trusting snapshot-check-use as TOCTOU-proof     — optimizer may delete the snapshot and re-read the
                                                           untrusted original (spec-legal transformation)
Watch:   register pressure, struct field order, data size mod 16, compiler version — all flip the outcome

Blocked: security-testing a debug build, shipping an optimized build untested
Use:     run the security suite against the exact optimized binary you release
```

- Compile with `-Wall -Wextra -Werror`; run ASan/UBSan in CI.
- Pin the compiler version. A toolchain upgrade or downgrade is a **security event**: re-verify security-sensitive binaries afterward — same flags do not mean same security.
- No compiler flag or binary analyzer detects optimizer-emitted TOCTOU yet. Before release of security-critical C/C++, run an LLM pattern audit for `snapshot-check-use` (see `../../llm-security/references/production-standards.md` → AI as Security Analyzer).

---

## Dependencies & Supply Chain

- Pin dependencies by hash (not version range).
- Generate SBOMs (CycloneDX or SPDX) per the **CISA/NSA 2026 Minimum Elements** (July 2026, supersedes NTIA 2021); for AI systems, also the **SBOM-for-AI Minimum Elements** (May 2026). Track cryptography per the **CBOM guidance** mandated by the June 2026 PQC Executive Order.
- Audit: `pip-audit`, `npm audit`, `cargo audit` on every build.
- Sign artifacts (ML-DSA-65 via Sigstore/cosign; hybrid classical+PQC during transition).
- Verify SLSA provenance (≥ Level 2 target, Level 3 for security-critical)
  before deployment.

---

## Container & Runtime Security

- Run as non-root user (`USER 1000:1000`).
- Read-only root filesystem when possible (`--read-only`).
- No new privileges (`--security-opt=no-new-privileges`).
- Drop all capabilities, add back only what's needed.
- Resource limits (CPU, memory) on every container.
- Scan images before deploy (`trivy`, `grype`, `snyk`).

---

## Logging & Observability

- Structured logging (JSON). Include: timestamp, level, correlation_id, action, result.
- Never log secrets, PII, or full request bodies.
- Redact credentials before log emission (see AGENTS.md `redact_stream`).
- Audit trail must be append-only and immutable.

---

## Pre-Commit Gates

```bash
detect-secrets scan --all-files
gitleaks detect --source . --uncommitted
```

Mark exceptions with `# nosec` or `# no-gate` plus a justification comment.

---

*Compiled reference for `.agents/skills/code-security/SKILL.md` and `.agents/skills/production-security/SKILL.md`. These docs are versioned and improve with every iteration. Load `../SKILL.md` for full context, procedural checklists, and language-specific implementations.*
