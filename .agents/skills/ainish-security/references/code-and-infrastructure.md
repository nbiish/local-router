# Code and infrastructure security — detailed reference

Depth for `../../SKILL.md` §1, §2, §3, §6, §7. Load when writing or reviewing
production code, containers, infrastructure-as-code, authentication, or
cryptographic call sites.

---

## 1. Input validation by vulnerability type

### SQL injection (CWE-89)

```python
# BLOCKED — string interpolation
session.execute(text(f"SELECT * FROM users WHERE id = {user_input}"))

# SAFE — parameterised
session.execute(text("SELECT * FROM users WHERE id = :id"), {"id": user_input})

# SAFE — ORM
session.query(User).filter(User.id == user_input).all()
```

```typescript
// SAFE — Drizzle, parameterised
const result = await db.select().from(users).where(eq(users.id, userInput));

// SAFE — raw with bind parameters
await db.execute(sql`SELECT * FROM users WHERE id = ${userInput}`);
```

```rust
// SAFE — SQLx, compile-time checked
let user = query!("SELECT * FROM users WHERE id = $1", user_input)
    .fetch_one(&pool).await?;
```

### XSS (CWE-79) — defence in depth

```typescript
// Layer 1 — framework auto-escaping
<div>{userInput}</div>

// Layer 2 — sanitise when HTML is genuinely required
import DOMPurify from 'dompurify';
const clean = DOMPurify.sanitize(untrustedHTML, {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a'],
  ALLOWED_ATTR: ['href'],
  ALLOW_DATA_ATTR: false,
});
<div dangerouslySetInnerHTML={{ __html: clean }} />

// Layer 3 — Trusted Types, browser-enforced
const policy = trustedTypes.createPolicy('sanitize-policy', {
  createHTML: (input) => DOMPurify.sanitize(input),
});
element.innerHTML = policy.createHTML(untrustedInput);

// Layer 4 — CSP
const CSP_HEADER = [
  "default-src 'none'",
  "script-src 'self' 'strict-dynamic'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
].join('; ');
```

`unsafe-inline` in `style-src` is a deliberate carve-out for CSS-in-JS; never
allow it in `script-src`.

### Command injection (CWE-78, CWE-77)

```python
import re, subprocess

# BLOCKED
subprocess.call(f"cat {user_input}", shell=True)   # "f.txt; rm -rf /"
os.system(user_input)                              # always unsafe

# SAFE — argument array, no shell
subprocess.run(["cat", user_input], shell=False, check=True, timeout=10)

# SAFE — allowlisted binary + validated arguments
ALLOWED = {"ls": "/bin/ls", "cat": "/bin/cat", "grep": "/bin/grep"}

def run_safe(cmd: str, args: list[str]) -> subprocess.CompletedProcess:
    if cmd not in ALLOWED:
        raise ValueError(f"Command '{cmd}' not in allowlist")
    for arg in args:
        if not re.match(r"^[a-zA-Z0-9._/-]+$", arg):
            raise ValueError(f"Invalid argument: {arg}")
    return subprocess.run([ALLOWED[cmd], *args], shell=False, check=True,
                          capture_output=True, timeout=10)
```

`shlex.quote` is a last resort for a genuinely unavoidable shell, not a licence to
build command strings.

### Path traversal (CWE-22)

```python
from pathlib import Path
import re

ALLOWED_BASE = Path("/data").resolve()

def safe_path(filename: str) -> Path:
    target = (ALLOWED_BASE / filename).resolve()   # resolves symlinks too
    if not target.is_relative_to(ALLOWED_BASE):
        raise ValueError(f"Path traversal detected: {filename}")
    return target

def validate_filename(name: str) -> str:
    if not re.match(r"^[a-zA-Z0-9._-]+$", name):
        raise ValueError(f"Invalid filename: {name}")
    if name.startswith("."):
        raise ValueError(f"Hidden files not allowed: {name}")
    return name
```

`os.path.join` and `Path.__truediv__` alone do **not** prevent traversal — they
gladly accept `../`. Containment is the check that matters, and it must run after
resolution.

### SSRF (CWE-918)

```python
import ipaddress, socket
from urllib.parse import urlparse

BLOCKED_NETWORKS = [
    ipaddress.ip_network(n) for n in (
        "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
        "127.0.0.0/8", "169.254.0.0/16",   # 169.254.169.254 = cloud metadata
        "0.0.0.0/8", "::1/128", "fc00::/7",
    )
]
ALLOWED_DOMAINS = {"api.example.com", "cdn.example.com"}

def validate_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise ValueError(f"Scheme '{parsed.scheme}' not allowed")
    if parsed.hostname not in ALLOWED_DOMAINS:
        raise ValueError(f"Domain '{parsed.hostname}' not in allowlist")
    resolved = socket.getaddrinfo(parsed.hostname, None)[0][4][0]
    ip = ipaddress.ip_address(resolved)
    if any(ip in net for net in BLOCKED_NETWORKS):
        raise ValueError(f"Resolved IP {ip} is in a blocked range")
    return url
```

Resolution must be re-checked on redirects and after any DNS re-resolution —
otherwise DNS rebinding defeats the initial check.

### CSRF (CWE-352)

```python
import secrets
from fastapi import Request, HTTPException

async def verify_csrf(request: Request):
    cookie = request.cookies.get("csrf_token")
    header = request.headers.get("x-csrf-token")
    if not cookie or not header:
        raise HTTPException(403, "Missing CSRF token")
    if not secrets.compare_digest(cookie, header):
        raise HTTPException(403, "CSRF token mismatch")
```

Cookie attributes: `httponly=True, secure=True, samesite="strict"`.

---

## 2. Authentication and authorisation

### Token validation with ML-DSA-65

```python
import time
# pyca/cryptography >= 47 is REQUIRED: `asymmetric.mldsa` / `asymmetric.mlkem` ship from 47.0.
# Verified 2026-11-07 — 45.0.7 and 46.0.5 raise ImportError on this import while 47.0+ works, so a
# floor of ">=45" resolves to a wheel that fails at module load. The pqc-secrets engine hit exactly
# this and had to raise its own floor.
from cryptography.hazmat.primitives.asymmetric import mldsa
from pydantic import BaseModel, Field

class TokenClaims(BaseModel):
    iss: str
    aud: str
    sub: str
    exp: int
    iat: int
    scope: list[str] = Field(default_factory=list)

class MLDSATokenService:
    """Signed claims with ML-DSA-65. Bounded age, not just expiry."""
    MAX_AGE_SECONDS = 900

    def validate(self, token: dict) -> TokenClaims:
        if token.get("alg") != "ML-DSA-65":          # allowlist, never trust `alg`
            raise ValueError(f"Unexpected alg: {token.get('alg')}")
        claims = TokenClaims(**token["claims"])
        payload = claims.model_dump_json().encode()
        if claims.iss != self.issuer or claims.aud != self.audience:
            raise ValueError("iss/aud mismatch")
        now = int(time.time())
        if now > claims.exp:
            raise ValueError("Token expired")
        if claims.iat < now - self.MAX_AGE_SECONDS:  # bounded age catches replay
            raise ValueError("Token too old")
        self._verify_key.verify(bytes.fromhex(token["sig"]), payload)
        return claims
```

**Why not RS256:** RSA is banned for new signing paths (NIST IR 8547). Interaction
with externally-issued RS256/ES256 identity tokens is normal transport interop —
isolate those verification paths and annotate them; do not use them for anything
this codebase signs.

### RBAC — deny by default

```python
from enum import Enum
from functools import wraps
from fastapi import HTTPException

class Role(str, Enum):
    ADMIN, EDITOR, VIEWER = "admin", "editor", "viewer"

class Permission(str, Enum):
    READ, WRITE, DELETE, ADMIN = "read", "write", "delete", "admin"

ROLE_PERMISSIONS = {
    Role.ADMIN: {Permission.READ, Permission.WRITE, Permission.DELETE, Permission.ADMIN},
    Role.EDITOR: {Permission.READ, Permission.WRITE},
    Role.VIEWER: {Permission.READ},
}

def require_permission(*required: Permission):
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, current_user: dict = None, **kwargs):
            if current_user is None:
                raise HTTPException(401, "Authentication required")
            perms = ROLE_PERMISSIONS[Role(current_user["role"])]
            if any(p not in perms for p in required):
                raise HTTPException(403, "Insufficient permissions")
            return await func(*args, current_user=current_user, **kwargs)
        return wrapper
    return decorator
```

Authorise the **object**, not just the route: a `DELETE /users/{id}` handler that
checks "may delete users" without checking "may delete *this* user" is an IDOR.

---

## 3. Cryptographic call sites

### AES-256-GCM

```python
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def encrypt(plaintext: bytes, key: bytes) -> tuple[bytes, bytes]:
    if len(key) != 32:
        raise ValueError("Key must be 256 bits")
    nonce = os.urandom(12)                 # 96-bit nonce, never reused with a key
    return nonce, AESGCM(key).encrypt(nonce, plaintext, associated_data=None)

def decrypt(nonce: bytes, ciphertext: bytes, key: bytes) -> bytes:
    return AESGCM(key).decrypt(nonce, ciphertext, associated_data=None)
```

**Nonce reuse under one key is a total break of GCM**, not a degradation. Random
96-bit nonces are safe up to ~2^32 messages per key; beyond that, use a counter.

### Argon2id

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

ph = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4,
                    hash_len=32, salt_len=16, type=2)   # 2 = argon2id

def hash_password(pw: str) -> str:
    return ph.hash(pw)

def verify_password(hashed: str, pw: str) -> bool:
    try:
        ph.verify(hashed, pw)
        return True
    except VerifyMismatchError:
        return False
```

### HKDF

```python
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

def derive_key(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt,
                info=info).derive(ikm)
```

Never use a raw shared secret as a key — always derive with a labelled `info`.

### TLS 1.3 with hybrid PQ groups

```go
cfg := &tls.Config{
    MinVersion: tls.VersionTLS13,
    CurvePreferences: []tls.CurveID{tls.X25519MLKEM768, tls.X25519},
}
```

```bash
# OpenSSL 3.5+ ships native PQC; no provider plugin needed
openssl genpkey -algorithm mlkem768 -out mlkem768.pem
openssl genpkey -algorithm mldsa65  -out mldsa65.pem
openssl pkeyutl -sign -inkey mldsa65.pem -in msg.bin -out sig.bin -rawin
openssl s_server -cert cert.pem -key key.pem -groups x25519_mlkem768
```

Earlier guidance referencing the `oqs-provider` fork is legacy: OpenSSL 3.5.0
(March 2026) shipped ML-KEM / ML-DSA / SLH-DSA natively and received the first
CMVP certificate for an ML-DSA module.

---

## 4. Compiler integrity (CWE-367, optimiser-emitted)

```c
/* SOURCE — looks secure: snapshot, check the copy, use the copy */
T local = *shared_untrusted;
if (local.amount <= account_balance)
    transfer(local.amount);

/* BINARY — spec-legal, and the protection is gone */
if ((*shared_untrusted).amount <= account_balance)
    transfer((*shared_untrusted).amount);      /* TOCTOU is back */
```

Trigger conditions observed in research: register pressure, struct field
reordering, access size ≡ 1 (mod 16), and compiler version. There is no rule of
thumb — the transformation emerges from interacting optimiser layers, each locally
correct.

**Secret wipes:**

```c
memset(password, 0, len);                              /* deleted as a dead store */

memset_s(password, sizeof password, 0, len);           /* C11 Annex K      */
explicit_bzero(password, len);                         /* glibc / BSD      */
volatile unsigned char *w = (volatile unsigned char *)password;
for (size_t i = 0; i < len; i++) w[i] = 0;             /* volatile barrier */
```

**Checklist:**

- [ ] `-Wall -Wextra -Werror -Wconversion` (MSVC `/W4 /WX`).
- [ ] ASan + UBSan in CI; MSan on secret-handling paths.
- [ ] Security tests run against the **optimised shipping binary**.
- [ ] Toolchain pinned; upgrade or downgrade is a security event.
- [ ] `snapshot-check-use` sites audited before release of security-critical C/C++.
- [ ] Secret wipes use a barrier the optimiser must honour.

---

## 5. Supply chain

```bash
cyclonedx-py environment -o sbom.json --format json   # Python
cyclonedx-npm -o sbom.json                            # Node
syft dir:./ -o spdx-json > spdx-sbom.json             # SPDX
pip-audit; npm audit --audit-level=high; cargo audit; govulncheck ./...
```

**SLSA:** Level 2 is the floor (trusted, authenticated build). Level 3 for
security-critical work (hard-to-forge provenance, two-person review). Sign with
ML-DSA-65 via cosign; verify provenance with `slsa-verifier` before deploy.

```toml
# deny.toml — cargo-deny
[advisories]
vulnerability = "deny"
[licenses]
allow = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]
[bans]
wildcards = "deny"
```

---

## 6. Containers and orchestration

```dockerfile
FROM golang:1.24-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /app/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /app/server /server
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
USER 65532:65532
ENTRYPOINT ["/server"]
```

```yaml
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    seccompProfile: { type: RuntimeDefault }
  containers:
    - name: app
      image: app@sha256:abc123...          # digest, never a floating tag
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: { drop: ["ALL"] }
      resources:
        requests: { memory: "128Mi", cpu: "100m" }
        limits:   { memory: "256Mi", cpu: "500m" }
```

---

## 7. Sandboxing untrusted and agent-generated code

```rust
// Wasmtime with strict limits
store.set_fuel(10_000)?;                    // bounded execution steps
let limits = Limits { memory_size: 10 * 1024 * 1024, table_elements: 100,
                      instances: 1, tables: 1, memories: 1 };
```

```bash
# Firecracker microVM: no network interface by default
{ "machine-config": { "vcpu_count": 1, "mem_size_mib": 128 },
  "network-interfaces": [] }
```

WASM for pure computation; microVM when a real kernel is required. Neither is
optional for agent-generated code.

---

## 8. Language standards

**Rust** — `#![forbid(unsafe_code)]` crate-wide; `unsafe` only for FFI/hardware
with formal verification; `panic = "abort"`; `clippy`, `cargo-audit`,
`cargo-deny`, `cargo fuzz`.

**Python** — banned: `pickle`, `eval`, `exec`, `compile`, `__import__`, and
unallowlisted `subprocess`. `ruff`, `bandit`, `mypy --strict`. `PYTHONHASHSEED=0`
in tests for determinism.

**TypeScript** — `strict: true` plus all sub-flags, `noUncheckedIndexedAccess`.
Ban `any` (use `unknown` + narrowing) and bare type assertions. Every I/O boundary
goes through a runtime schema.

**Bash** — `set -euo pipefail`, `shellcheck` in CI, `trap` for cleanup, no `eval`
on user input. SSH with `BatchMode=yes`, `ConnectTimeout=10`, keys only.

**Go** — `gofmt`, `go vet`, `golangci-lint`, `govulncheck`. Wrap errors
(`fmt.Errorf("...: %w", err)`); never leak internals to clients.

---

## 9. Criticality and verification depth

| Criticality | Line | Branch | MC/DC | Property tests |
|---|---|---|---|---|
| ASIL D / SIL 4 | ≥95% | ≥95% | Required | Required |
| ASIL C / SIL 3 | ≥90% | ≥90% | Strongly recommended | Required |
| ASIL B / SIL 2 | ≥85% | ≥80% | Recommended | Recommended |
| ASIL A / SIL 1 | ≥80% | ≥70% | Optional | Optional |

**Static analysis:** C/C++ Coverity/Klocwork/Polyspace + ASan/UBSan; Rust Clippy
(Ferrocene where certified) + cargo-audit/deny/fuzz; Python mypy/bandit/ruff/
semgrep; TypeScript tsc + ESLint security plugins + semgrep; Go vet/golangci-lint/
govulncheck.

**Formal methods at ASIL D / SIL 4:** TLA+ or SPIN for concurrent protocols; Coq or
Isabelle/HOL for correctness proofs; SPARK Ada or Dafny for embedded; Kani,
Creusot, or Prusti for Rust.

**Safety standards:** DO-178C (avionics, Level A needs MC/DC), IEC 62304 (medical,
Class C full lifecycle), ISO 26262 (automotive, ASIL D <10⁻⁸ failures/hour),
IEC 61508 (industrial, SIL 4 <10⁻⁸ failures/hour), OWASP ASVS 5.0 (L1–L3).

---

## 10. Operational safety

**Circuit breaker, bulkhead, retry.** Retry with exponential backoff and jitter:

```
delay = min(base * 2^attempt, max_delay) * (0.5 + random() * 0.5)
```

Cap at 3–5 attempts. Retrying without jitter synchronises clients into a thundering
herd; retrying non-idempotent operations turns one failure into several writes.

**Zero trust (SP 800-207)** — identity (OIDC + mTLS via SPIFFE/SPIRE), device
posture, microsegmentation, runtime verification (Falco, Tetragon), encryption and
access logging at the data layer. Policy as code (OPA/Rego, Kyverno) at every
stage.

---

## 11. CWE Top 25 (2026) quick reference

| # | CWE | Fix |
|---|---|---|
| 1 | CWE-79 XSS | Output encoding, CSP, Trusted Types |
| 2 | CWE-89 SQL injection | Parameterised queries, ORM |
| 3 | CWE-352 CSRF | Tokens + `SameSite` |
| 4 | CWE-862 Missing authorisation | RBAC, explicit checks, deny by default |
| 5 | CWE-787 Out-of-bounds write | Bounds checking, memory-safe language |
| 6 | CWE-22 Path traversal | Resolve + containment |
| 7 | CWE-416 Use after free | Smart pointers, Rust |
| 8 | CWE-125 Out-of-bounds read | Bounds checking, sanitizers |
| 9 | CWE-78 OS command injection | No shell; allowlist |
| 10 | CWE-94 Code injection | Never execute untrusted/model output |
| 11 | CWE-120 Buffer overflow | Bounds checking, safe string functions |
| 12 | CWE-434 Unrestricted upload | Type validation, isolated storage |
| 13 | CWE-476 NULL dereference | `Option`/`Result` types, null checks |
| 14 | CWE-502 Unsafe deserialisation | No pickle/eval; schema-validated formats |
| 15 | CWE-918 SSRF | URL allowlist, network isolation |
| 16 | CWE-77 Command injection | Parameterise |
| 17 | CWE-770 Unbounded allocation | Rate limits, quotas |
| 18 | CWE-367 TOCTOU (incl. optimiser-emitted) | Snapshot-copy + re-verify after toolchain change + LLM pattern audit |

---

## 12. Secrets in code — the blocked/use table

```
Blocked: API_KEY = "sk-abc123..."                 — hardcoded in source
Blocked: config.json { "apiKey": "..." }          — plaintext in repo
Blocked: .env with live keys, even gitignored     — PQC mandate: nothing plaintext on disk
Use:     pqc-secrets bundle + OS keychain, ML-KEM-768 + AES-256-GCM,
         decrypted into process memory at runtime
```

- `.env.example` templates only. `gitleaks` and `detect-secrets` pre-commit.
- Least-privilege keys scoped to one function.
- Short-lived, task-scoped credentials by default; rotate per task or at 90 days,
  whichever comes first.
- NSS / CNSA 2.0 scope: ML-KEM-1024 + ML-DSA-87.

---

## 13. Deployment checklist

**Criticality** — life / mission / security / business.

**Autonomy** — HITL / HOTL / fully autonomous.

**Data** — PII-PHI / financial / confidential IP / residency.

**Compliance** — HIPAA, SOX, GDPR, ISO 27001, SOC 2, ISO 26262, IEC 62304,
DO-178C, EU AI Act.

**Before merge** — scanners green on the shipping artefact; lockfiles pinned and
committed; no secret in the diff; SBOM regenerated; audit trail append-only;
rollback path named.
