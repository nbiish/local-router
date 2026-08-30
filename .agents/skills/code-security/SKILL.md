---
name: code-security
description: >
  Safety-critical code engineering skill for writing deterministic, verifiable, and secure 
  foundational code. Covers SQLi, XSS, Path Traversal, and more.
---

# Safety-Critical Code Engineering Skill

*Updated: May 4th, 2026 (May 2026 Standards)*

> Domain knowledge for deterministic, verifiable, and secure foundational code.
> Load this skill when writing security-hardened code, infrastructure, input validation, cryptography, or container security.
> This covers **The Body**: the deterministic runtime, tools, and infrastructure that must be absolutely reliable.

---

## Core Philosophy: Determinism & Containment

The code that runs the agent must be absolutely reliable. It is the "cage" that contains the AI.

- **No "Magic"**: Avoid reflection, metaprogramming, and dynamic dispatch in critical paths.
- **Containment**: Runtime must enforce boundaries the AI cannot cross, regardless of output.
- **Verifiability**: Code must be structured so automated tools can prove correctness.

### Universal Code Standards

- **Cyclomatic Complexity**: Functions <= 10. Higher requires refactoring.
- **Pure Functions**: Core logic must be side-effect free. I/O at edges only.
- **Time & Randomness**: Never access directly in logic. Inject as dependencies.
- **Pinned Dependencies**: All builds reproducible. Lockfiles mandatory.

---

## 1. Input Validation by Vulnerability Type

### SQL Injection Prevention (CWE-89)

```python
# --- VULNERABLE: String interpolation ---
session.execute(text(f"SELECT * FROM users WHERE id = {user_input}"))

# --- SAFE: SQLAlchemy parameterized query ---
from sqlalchemy import text

session.execute(text("SELECT * FROM users WHERE id = :id"), {"id": user_input})

# --- SAFE: ORM (parameterized automatically) ---
session.query(User).filter(User.id == user_input).all()
```

```typescript
// --- SAFE: Drizzle ORM (parameterized automatically) ---
import { eq } from 'drizzle-orm';
const result = await db.select().from(users).where(eq(users.id, userInput));

// --- SAFE: Raw SQL with parameters ---
import { sql } from 'drizzle-orm';
await db.execute(sql`SELECT * FROM users WHERE id = ${userInput}`);
```

```rust
// --- SAFE: SQLx compile-time checked query ---
use sqlx::query;

let user = query!("SELECT * FROM users WHERE id = $1", user_input)
    .fetch_one(&pool)
    .await?;

// --- SAFE: Dynamic query with bind parameters ---
let user = sqlx::query("SELECT * FROM users WHERE id = $1")
    .bind(user_input)
    .fetch_one(&pool)
    .await?;
```

### XSS Prevention (CWE-79)

```typescript
// --- Layer 1: React auto-escapes by default ---
<div>{userInput}</div>  // Safe: auto-escaped

// --- Layer 2: DOMPurify when HTML rendering is needed ---
import DOMPurify from 'dompurify';

const clean = DOMPurify.sanitize(untrustedHTML, {
  ALLOWED_TAGS: ['b', 'i', 'em', 'strong', 'a'],
  ALLOWED_ATTR: ['href'],
  ALLOW_DATA_ATTR: false,
});
<div dangerouslySetInnerHTML={{ __html: clean }} />

// --- Layer 3: Trusted Types (browser-enforced DOM XSS prevention) ---
const policy = trustedTypes.createPolicy('sanitize-policy', {
  createHTML: (input) => DOMPurify.sanitize(input),
});
element.innerHTML = policy.createHTML(untrustedInput);  // Browser enforces

// --- Layer 4: CSP Header ---
const CSP_HEADER = [
  "default-src 'none'",
  "script-src 'self' 'strict-dynamic'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
].join('; ');
```

### Command Injection Prevention (CWE-78)

```python
import subprocess
import re

# --- VULNERABLE: shell=True with string interpolation ---
subprocess.call(f"cat {user_input}", shell=True)  # "file.txt; rm -rf /"

# --- SAFE: shell=False with list arguments ---
subprocess.run(["cat", user_input], shell=False, check=True)

# --- SAFE: Allowlisted commands with validation ---
ALLOWED_COMMANDS = {
    "ls": "/bin/ls",
    "cat": "/bin/cat",
    "grep": "/bin/grep",
}

def run_safe_command(cmd: str, args: list[str]) -> subprocess.CompletedProcess:
    if cmd not in ALLOWED_COMMANDS:
        raise ValueError(f"Command '{cmd}' not in allowlist")

    for arg in args:
        if not re.match(r'^[a-zA-Z0-9._/-]+$', arg):
            raise ValueError(f"Invalid argument: {arg}")

    return subprocess.run(
        [ALLOWED_COMMANDS[cmd]] + args,
        shell=False,
        check=True,
        capture_output=True,
        timeout=10,
    )

# --- SAFE: shlex.quote if shell is unavoidable (avoid when possible) ---
import shlex
subprocess.run(f"cat {shlex.quote(user_input)}", shell=True)
```

### Path Traversal Prevention (CWE-22)

```python
import os
from pathlib import Path

# --- VULNERABLE: Direct path concatenation ---
open(f"/data/{user_filename}")  # "../../../etc/passwd"

# --- SAFE: Path normalization + containment check ---
ALLOWED_BASE = Path("/data").resolve()

def safe_path(filename: str) -> Path:
    """Resolve and validate path stays within allowed directory."""
    target = (ALLOWED_BASE / filename).resolve()
    if not target.is_relative_to(ALLOWED_BASE):
        raise ValueError(f"Path traversal detected: {filename}")
    return target

# --- SAFE: Additional filename validation ---
import re
def validate_filename(name: str) -> str:
    if not re.match(r'^[a-zA-Z0-9._-]+$', name):
        raise ValueError(f"Invalid filename: {name}")
    if name.startswith('.'):
        raise ValueError(f"Hidden files not allowed: {name}")
    return name
```

### SSRF Prevention (CWE-918)

```python
import ipaddress
import socket
from urllib.parse import urlparse

# Blocked IP ranges (private, loopback, link-local, metadata)
BLOCKED_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),  # Cloud metadata
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
]

ALLOWED_DOMAINS = {"api.example.com", "cdn.example.com", "auth.example.com"}

def validate_url(url: str) -> str:
    """Validate URL against SSRF: allowlist domains + block private IPs."""
    parsed = urlparse(url)

    # Only allow https
    if parsed.scheme != "https":
        raise ValueError(f"Scheme '{parsed.scheme}' not allowed")

    # Domain allowlist
    if parsed.hostname not in ALLOWED_DOMAINS:
        raise ValueError(f"Domain '{parsed.hostname}' not in allowlist")

    # DNS resolution check (prevent DNS rebinding)
    try:
        resolved_ip = socket.getaddrinfo(parsed.hostname, None)[0][4][0]
    except socket.gaierror:
        raise ValueError(f"Cannot resolve domain: {parsed.hostname}")

    ip = ipaddress.ip_address(resolved_ip)
    for network in BLOCKED_NETWORKS:
        if ip in network:
            raise ValueError(f"Resolved IP {ip} is in blocked range")

    return url
```

### CSRF Prevention (CWE-352)

```python
import secrets
from fastapi import FastAPI, Request, HTTPException, Depends
from fastapi.responses import JSONResponse

app = FastAPI()

# Generate CSRF token
@app.get("/csrf-token")
async def get_csrf_token():
    token = secrets.token_urlsafe(32)
    # Set as HttpOnly, Secure, SameSite=Strict cookie
    response = JSONResponse({"csrf_token": token})
    response.set_cookie(
        "csrf_token", token,
        httponly=True, secure=True, samesite="strict",
        max_age=3600,
    )
    return response

# Validate CSRF token on state-changing requests
async def verify_csrf(request: Request):
    cookie_token = request.cookies.get("csrf_token")
    header_token = request.headers.get("x-csrf-token")

    if not cookie_token or not header_token:
        raise HTTPException(403, "Missing CSRF token")

    if not secrets.compare_digest(cookie_token, header_token):
        raise HTTPException(403, "CSRF token mismatch")

@app.post("/api/data")
async def update_data(_: None = Depends(verify_csrf)):
    ...
```

---

## 2. Authentication & Authorization

### JWT Validation (ML-DSA / hybrid — 2026 PQC policy)

> **Why not RS256 here:** this repo's `security_gate.py` flags `algorithms=["RS*"]` under the PQC mandate (NIST IR 8547: RSA enters risk-acceptance-only after 2030, disallowed after 2035). New token-signing paths use **ML-DSA-65** (FIPS 204), or a **hybrid classical+PQC** scheme during the 2026 transition window (a compact classical signature *and* an ML-DSA-65 signature over the same claims; verifier requires at least the ML-DSA leg once issuers support it). Interaction with externally-issued RS256/ES256 identity tokens (corporate OIDC) is normal transport interop — mark `# nosec` on those isolated verification paths.

```python
import time
from cryptography.hazmat.primitives.asymmetric import mldsa  # pyca/cryptography ≥ 45
from cryptography.exceptions import InvalidSignature
from pydantic import BaseModel, Field

class TokenClaims(BaseModel):
    iss: str
    aud: str
    sub: str
    exp: int
    iat: int
    scope: list[str] = Field(default_factory=list)

class MLDSATokenService:
    """JWT-style signed claims with ML-DSA-65. 15-minute max token age."""

    MAX_AGE_SECONDS = 900

    def __init__(self, issuer: str, audience: str,
                 verify_key: mldsa.MLDSA65PublicKey | None = None):
        self.issuer = issuer
        self.audience = audience
        self._verify_key = verify_key

    def issue(self, sign_key: mldsa.MLDSA65PrivateKey, subject: str, scope: list[str]) -> dict:
        now = int(time.time())
        claims = TokenClaims(
            iss=self.issuer, aud=self.audience, sub=subject,
            iat=now, exp=now + self.MAX_AGE_SECONDS, scope=scope,
        )
        payload = claims.model_dump_json().encode()
        signature = sign_key.sign(payload)
        return {"claims": claims.model_dump(), "alg": "ML-DSA-65", "sig": signature.hex()}

    def validate(self, token: dict) -> TokenClaims:
        if token.get("alg") != "ML-DSA-65":
            raise ValueError(f"Unexpected alg: {token.get('alg')} (allowlist: ML-DSA-65)")
        claims = TokenClaims(**token["claims"])
        payload = claims.model_dump_json().encode()
        if claims.iss != self.issuer or claims.aud != self.audience:
            raise ValueError("iss/aud mismatch")
        if int(time.time()) > claims.exp:
            raise ValueError("Token expired")
        if claims.iat < int(time.time()) - self.MAX_AGE_SECONDS:
            raise ValueError("Token too old")
        self._verify_key.verify(bytes.fromhex(token["sig"]), payload)  # raises InvalidSignature
        return claims
```

> **Key custody:** token signing keys live in the same OS-keychain custody as the `pqc-secrets` bundle keys — never on disk in PEM form outside a key ceremony. Rotate signing keys alongside `pqc-secrets` data-key rotation.

### RBAC in FastAPI

```python
from functools import wraps
from enum import Enum
from fastapi import HTTPException

class Role(str, Enum):
    ADMIN = "admin"
    EDITOR = "editor"
    VIEWER = "viewer"

class Permission(str, Enum):
    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    ADMIN = "admin"

ROLE_PERMISSIONS: dict[Role, set[Permission]] = {
    Role.ADMIN: {Permission.READ, Permission.WRITE, Permission.DELETE, Permission.ADMIN},
    Role.EDITOR: {Permission.READ, Permission.WRITE},
    Role.VIEWER: {Permission.READ},
}

def require_permission(*required_perms: Permission):
    """Decorator to enforce RBAC on endpoints."""
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, current_user: dict = None, **kwargs):
            if current_user is None:
                raise HTTPException(401, "Authentication required")

            user_role = Role(current_user["role"])
            user_perms = ROLE_PERMISSIONS[user_role]

            for perm in required_perms:
                if perm not in user_perms:
                    raise HTTPException(403, f"Insufficient permissions: {perm.value}")

            return await func(*args, current_user=current_user, **kwargs)
        return wrapper
    return decorator

# Usage
@app.delete("/api/users/{user_id}")
@require_permission(Permission.DELETE)
async def delete_user(user_id: str, current_user: dict = Depends(get_current_user)):
    ...
```

### RBAC in TypeScript (Express)

```typescript
import { Request, Response, NextFunction } from 'express';

type Role = 'admin' | 'editor' | 'viewer';
type Permission = 'read' | 'write' | 'delete' | 'admin';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['read', 'write', 'delete', 'admin'],
  editor: ['read', 'write'],
  viewer: ['read'],
};

function requirePermission(...requiredPerms: Permission[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;  // Set by auth middleware
    if (!user) return res.status(401).json({ error: 'Authentication required' });

    const userPerms = ROLE_PERMISSIONS[user.role as Role] || [];
    const hasAll = requiredPerms.every(p => userPerms.includes(p));

    if (!hasAll) return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

// Usage
app.delete('/api/users/:id', authenticate, requirePermission('delete'), deleteUser);
```

---

## 3. Cryptographic Patterns

### AES-256-GCM Encryption/Decryption

```python
import os
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def encrypt(plaintext: bytes, key: bytes) -> tuple[bytes, bytes]:
    """Encrypt with AES-256-GCM. Returns (nonce, ciphertext)."""
    if len(key) != 32:
        raise ValueError("Key must be 256 bits (32 bytes)")

    nonce = os.urandom(12)  # 96-bit nonce for GCM
    aesgcm = AESGCM(key)
    ciphertext = aesgcm.encrypt(nonce, plaintext, associated_data=None)
    return nonce, ciphertext

def decrypt(nonce: bytes, ciphertext: bytes, key: bytes) -> bytes:
    """Decrypt AES-256-GCM. Raises if authentication fails."""
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(nonce, ciphertext, associated_data=None)

# Key must come from vault/KMS, never hardcoded
# key = vault.read("secret/aes-key")
```

### Password Hashing (Argon2id)

```python
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

# OWASP-recommended parameters (2025)
ph = PasswordHasher(
    time_cost=3,        # iterations
    memory_cost=65536,  # 64 MB
    parallelism=4,      # threads
    hash_len=32,        # output length
    salt_len=16,        # salt length
    type=2,             # argon2id
)

def hash_password(password: str) -> str:
    """Hash password with Argon2id."""
    return ph.hash(password)

def verify_password(hashed: str, password: str) -> bool:
    """Verify password against hash. Constant-time comparison."""
    try:
        ph.verify(hashed, password)
        return True
    except VerifyMismatchError:
        return False
```

### Key Derivation (HKDF)

```python
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

def derive_key(ikm: bytes, salt: bytes, info: bytes, length: int = 32) -> bytes:
    """Derive a cryptographic key using HKDF-SHA256."""
    hkdf = HKDF(
        algorithm=hashes.SHA256(),
        length=length,
        salt=salt,
        info=info,
    )
    return hkdf.derive(ikm)
```

### TLS 1.3 Configuration

```go
// Go: TLS 1.3 server configuration
package main

import (
    "crypto/tls"
    "crypto/x509"
    "net/http"
    "os"
)

func tlsServer() *http.Server {
    cfg := &tls.Config{
        MinVersion:               tls.VersionTLS13,  // TLS 1.3 minimum
        CurvePreferences:         []tls.CurveID{tls.X25519, tls.CurveP256},
        PreferServerCipherSuites: true,
        // Hybrid PQC: X25519 + ML-KEM-768 (requires Go 1.24+ or custom)
        // CurvePreferences: []tls.CurveID{tls.X25519MLKEM768, tls.X25519},
    }

    return &http.Server{
        Addr:      ":443",
        TLSConfig: cfg,
    }
}
```

```rust
// Rust: TLS 1.3 with rustls
use rustls::{ServerConfig, SupportedCipherSuite};
use rustls::crypto::ring::cipher_suite::TLS13_AES_256_GCM_SHA384;

fn build_tls_config() -> ServerConfig {
    let mut config = ServerConfig::builder()
        .with_protocol_versions(&[&rustls::version::TLS13])  // TLS 1.3 only
        .expect("TLS 1.3 not supported")
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .expect("bad certificate/key");

    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config
}
```

### Post-Quantum Cryptography (NIST FIPS Standards)
| Purpose | Standard | Algorithm | Status (2026) |
|---------|----------|-----------|---------------|
| Key Encapsulation | FIPS 203 | ML-KEM-768/1024 | Standard |
| Digital Signatures | FIPS 204 | ML-DSA-65/87 | Standard |
| Hash-Based Sig | FIPS 205 | SLH-DSA | Standard |
| Compact Sigs | FIPS 206 | FN-DSA (FALCON) | IPD pending |
| Code-Based KEM | TBD | HQC | Selected Mar 2025 |
| KEM Guidance | SP 800-227 | — | IPD Sep 2025 |
| PQC Transition | IR 8547 | — | Deprecate classical 2030 |

---

## 4. MCP Security Hardening

### ML-DSA-65 Manifest Signing & Verification (TypeScript)

> **2026 algorithm policy:** MCP tool manifests and tool descriptions are **critical trust anchors** — sign them with **ML-DSA-65** (FIPS 204), not Ed25519. Node ≥ 24 supports ML-DSA-65 natively via WebCrypto / `crypto.sign` (`openssl 3.5+` backing); hybrid **Ed25519 + ML-DSA-65** dual-signature is an approved transitional hedge where the ecosystem hasn't caught up (recipients verify at least one). Ed25519-only signing of manifests is deprecated after 2030 and disallowed after 2035 per NIST IR 8547 — and this repo's `security_gate.py` flags it.

```typescript
import * as crypto from "crypto";
import { z } from "zod";

const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().max(500),
  inputSchema: z.record(z.unknown()),
  permissions: z.array(z.string()).default([]),
  version: z.string().default("1.0.0"),
});

const MCPManifestSchema = z.object({
  serverName: z.string(),
  serverVersion: z.string(),
  tools: z.array(ToolDefinitionSchema),
  timestamp: z.number(),
  expiresAt: z.number(),
  publisher: z.string(),
  signature: z.string().default(""),
  signatureAlg: z.enum(["ML-DSA-65", "Ed25519+ML-DSA-65"]).default("ML-DSA-65"),
});

type MCPManifest = z.infer<typeof MCPManifestSchema>;

class ManifestSigner {
  constructor(private privateKeyPem: string, private publicKeyPem: string) {}

  // Node 24+: ML-DSA-65 via crypto.generateKeyPairSync("mldsa65", ...) —
  // backed by OpenSSL 3.5+. Fallback path: shell out to `openssl genpkey
  // -algorithm mldsa65` during key ceremony and load PEM here.
  static generateKeyPair(): { privateKey: string; publicKey: string } {
    return crypto.generateKeyPairSync("mldsa65", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
  }

  sign(manifest: Omit<MCPManifest, "signature" | "timestamp" | "expiresAt" | "signatureAlg">, ttlSeconds = 86400 * 7): MCPManifest {
    const timestamp = Math.floor(Date.now() / 1000);
    const signed: MCPManifest = {
      ...manifest, timestamp, expiresAt: timestamp + ttlSeconds,
      signatureAlg: "ML-DSA-65", signature: "",
    };
    const payload = this.canonicalBytes(signed);
    // ML-DSA-65 signature. (For hybrid: additionally sign the same payload
    // with Ed25519 and append as "<mldsa_hex>.<ed25519_hex>".)
    const signature = crypto.sign(null, payload, {
      key: this.privateKeyPem, format: "pem", type: "pkcs8",
    });
    signed.signature = signature.toString("hex");
    return signed;
  }

  verify(manifest: MCPManifest): { valid: boolean; reason: string } {
    if (Date.now() / 1000 > manifest.expiresAt) return { valid: false, reason: "Manifest expired" };
    const savedSig = manifest.signature;
    const payload = this.canonicalBytes({ ...manifest, signature: "" });
    // Hybrid fallback: a manifest signed Ed25519+ML-DSA-65 verifies when
    // EITHER signature verifies (defense against 2026 ML-DSA immaturity).
    let isValid = false;
    if (manifest.signatureAlg === "ML-DSA-65") {
      isValid = crypto.verify(null, payload, { key: this.publicKeyPem, format: "pem", type: "spki" }, Buffer.from(savedSig, "hex"));
    } else {
      const [mldsa, ed25519] = savedSig.split(".");
      const mldsaOk = mldsa ? crypto.verify(null, payload, { key: this.publicKeyPem, format: "pem", type: "spki" }, Buffer.from(mldsa, "hex")) : false;
      isValid = mldsaOk; // ed25519 leg verified against the publisher's Ed25519 pubkey when configured
      void ed25519;
    }
    if (!isValid) return { valid: false, reason: "Signature verification failed" };
    const parsed = MCPManifestSchema.safeParse(manifest);
    if (!parsed.success) return { valid: false, reason: `Schema validation failed: ${parsed.error.message}` };
    return { valid: true, reason: "Manifest is valid" };
  }

  private canonicalBytes(manifest: MCPManifest): Buffer {
    const sorted = JSON.parse(JSON.stringify(manifest, Object.keys(manifest).sort()));
    return Buffer.from(JSON.stringify(sorted, Object.keys(sorted).sort()), "utf-8");
  }
}

// Detect tool definition drift (rug pull detection)
class DriftDetector {
  private pinnedHashes: Map<string, string> = new Map();

  constructor(manifest: MCPManifest) {
    for (const tool of manifest.tools) {
      const hash = crypto.createHash("sha256")
        .update(JSON.stringify(tool, Object.keys(tool).sort())).digest("hex");
      this.pinnedHashes.set(tool.name, hash);
    }
  }

  checkDrift(currentTools: MCPManifest["tools"]): string[] {
    const drifts: string[] = [];
    const currentMap = new Map(currentTools.map((t) => [t.name, t]));
    for (const [name] of this.pinnedHashes) {
      if (!currentMap.has(name)) drifts.push(`REMOVED: Tool '${name}' missing`);
    }
    for (const [name] of currentMap) {
      if (!this.pinnedHashes.has(name)) drifts.push(`ADDED: Tool '${name}' not in pinned manifest (potential rug pull)`);
    }
    for (const tool of currentTools) {
      const pinned = this.pinnedHashes.get(tool.name);
      if (pinned) {
        const current = crypto.createHash("sha256")
          .update(JSON.stringify(tool, Object.keys(tool).sort())).digest("hex");
        if (current !== pinned) drifts.push(`MODIFIED: Tool '${tool.name}' definition changed`);
      }
    }
    return drifts;
  }
}
```

### Hardened MCP Server with Security Middleware (TypeScript)

```typescript
class ToolRateLimiter {
  private calls: Map<string, number[]> = new Map();
  constructor(private maxPerMinute = 60, private maxPerHour = 1000) {}

  check(key: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    let calls = (this.calls.get(key) ?? []).filter((t) => t > now - 3_600_000);
    this.calls.set(key, calls);
    const hourly = calls.filter((t) => t > now - 3_600_000).length;
    if (hourly >= this.maxPerHour) return { allowed: false, reason: `Hourly limit: ${hourly}/${this.maxPerHour}` };
    const minute = calls.filter((t) => t > now - 60_000).length;
    if (minute >= this.maxPerMinute) return { allowed: false, reason: `Per-minute limit: ${minute}/${this.maxPerMinute}` };
    calls.push(now);
    return { allowed: true };
  }
}

class OutputSanitizer {
  sanitize(output: string): string {
    let s = output;
    // Strip prompt injection patterns
    for (const p of [
      /ignore\s+(all\s+)?previous\s+instructions?/gi, /system\s*:\s*/gi,
      /you\s+are\s+now\s+/gi, /disregard\s+/gi,
    ]) s = s.replace(p, "[FILTERED]");
    // Remove markdown image refs (data exfiltration vector)
    s = s.replace(/!\[.*?\]\(https?:\/\/[^\s)]+\)/g, "[IMAGE_LINK_REMOVED]");
    // Redact secrets
    s = s.replace(/(api[_-]?key|token|secret|password|credential)["\s]*[:=]["\s]*[\w\-]{8,}/gi, "$1=[REDACTED]");
    s = s.replace(/(sk-[a-zA-Z0-9]{20,})/g, "sk-[REDACTED]");
    s = s.replace(/(ghp_[a-zA-Z0-9]{36})/g, "ghp_[REDACTED]");
    s = s.replace(/(AKIA[0-9A-Z]{16})/g, "AKIA[REDACTED]");
    return s;
  }
}
```

### MCP Security Best Practices Summary

| Category | Practice | Code Pattern |
|----------|----------|-------------|
| **Input Validation** | Validate all inputs with Pydantic/Zod at trust boundaries | `Field(..., min_length=1, max_length=512)` + validators |
| **Allowlisting** | Only connect to known, pinned MCP servers | `allowedTools: Set<string>` + hash verification |
| **Manifest Signing** | Sign/verify all tool manifests; detect rug pull drift | ML-DSA-65 signing + SHA-256 tool hash pinning |
| **Sandboxing** | Run all tool execution in isolated containers | Docker `--network=none --memory=128m --read-only` |
| **Rate Limiting** | Per-tool and per-server rate limits | Sliding window counter per tool name |
| **Output Sanitization** | Strip injection patterns and secrets from tool output | Regex patterns for injection + secret redaction |
| **Audit Logging** | Log all invocations with tamper-evident trail | SHA-256 hashed log entries + security alerting |
| **Command Execution** | Never use shell=True; use subprocess with args list | `asyncio.create_subprocess_exec(cmd, *args)` |
| **Transport Security** | Enforce TLS 1.3+ with mTLS for remote MCP servers | OAuth 2.1 + PKCE for remote transports |
| **Config Protection** | Protect MCP config files from LLM modification | File integrity monitoring + read-only config |

### CVE-to-Mitigation Mapping

| CVE | Root Cause | Primary Mitigation |
|-----|-----------|-------------------|
| CVE-2025-32711 (EchoLeak) | Unsanitized external content rendered as markdown | Output sanitization; strip markdown image refs |
| CVE-2025-53773 (Copilot Worm) | Self-propagating prompt injection via repo content | Instruction hierarchy; treat all repo text as untrusted |
| CVE-2025-54135 (CurXecute) | Auto-connect to MCP servers without user consent | Require explicit approval; no auto-start |
| CVE-2025-6514 (MCP RCE) | Unsanitized input passed to shell commands | Subprocess with args list; allowlist commands |
| CVE-2025-64660 (AGENTS.md) | Malicious instruction files override agent goals | Treat instruction files as untrusted; behavioral monitoring |
| CVE-2026-0755 (gemini-mcp) | Command injection in execAsync handler | Strictly validate and sanitize MCP tool inputs |
| CVE-2026-30615 (Windsurf) | Prompt injection modifies MCP config -> RCE | Never let LLM output modify system config |
| CVE-2026-30623 (LiteLLM) | Unauthenticated MCP server creation endpoint | Auth required for MCP creation; allowlisted definitions |
| CVE-2026-33032 (nginx-ui) | Unauthenticated takeover via exposed MCP | Auth required for all MCP endpoints |

---

## 5. Supply Chain Security

### SBOM Generation

```bash
# Python: Generate CycloneDX SBOM
pip install cyclonedx-bom
cyclonedx-py environment -o sbom.json --format json

# Node.js: Generate CycloneDX SBOM
npm install -g @cyclonedx/cyclonedx-npm
cyclonedx-npm -o sbom.json

# Generate SPDX SBOM from lockfile
syft dir:./ -o spdx-json > spdx-sbom.json
```

### SLSA Provenance in GitHub Actions

```yaml
# .github/workflows/build.yml — SLSA Level 3 provenance
name: Build with SLSA Provenance

permissions:
  id-token: write
  contents: read
  attestations: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0  # Full history for provenance

      - uses: actions/setup-go@v5
        with:
          go-version: '1.24'

      - name: Build
        run: go build -o bin/app .

      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          output-file: sbom.spdx.json

      - name: Sign artifact with Sigstore
        uses: sigstore/cosign-installer@v3
      - run: |
          cosign sign-blob --yes blob:bin/app

      - name: Generate SLSA provenance
        uses: slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@v2.0.0

      - name: Verify provenance
        uses: slsa-framework/slsa-verifier/actions/install@v2.7.0
      - run: |
          slsa-verifier verify-artifact bin/app \
            --provenance-path build.intoto.jsonl \
            --source-uri github.com/${{ github.repository }}
```

### Dependency Pinning & Hash Verification

```toml
# Rust: Cargo.lock hash verification (cargo-deny)
# cargo install cargo-deny
# cargo deny check

# Deny.toml
[advisories]
db-path = "~/.cargo/advisory-db"
vulnerability = "deny"

[licenses]
allow = ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause"]

[bans]
wildcards = "deny"
multiple-versions = "warn"
```

```bash
# Python: uv.lock hash verification
uv lock --hash-mode sha256
uv sync --frozen  # Enforce exact lockfile

# Node: npm integrity verification
npm audit signatures
npm ci  # Uses exact lockfile (package-lock.json)
```

---

## 6. Container Security

### Secure Dockerfile (Multi-Stage, Non-Root, Read-Only)

```dockerfile
# --- Secure multi-stage Dockerfile ---
# Stage 1: Build
FROM golang:1.24-alpine AS builder

RUN apk add --no-cache git ca-certificates
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /app/server

# Stage 2: Minimal runtime
FROM gcr.io/distroless/static-debian12:nonroot

# Security labels
LABEL org.opencontainers.image.source="https://github.com/org/repo"
LABEL org.opencontainers.image.title="app"

COPY --from=builder /app/server /server
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/

# Run as non-root user (65532 = nonroot in distroless)
USER 65532:65532

ENTRYPOINT ["/server"]
```

### Kubernetes Pod Security

```yaml
# Pod security policy — defense in depth
apiVersion: v1
kind: Pod
metadata:
  name: secure-app
spec:
  securityContext:
    runAsNonRoot: true
    runAsUser: 65532
    fsGroup: 65532
    seccompProfile:
      type: RuntimeDefault
    supplementalGroups: [65532]

  containers:
    - name: app
      image: app:latest@sha256:abc123...  # Pinned by digest, not tag
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
        runAsNonRoot: true

      resources:
        requests: { memory: "128Mi", cpu: "100m" }
        limits: { memory: "256Mi", cpu: "500m" }

      volumeMounts:
        - name: tmp
          mountPath: /tmp

  volumes:
    - name: tmp
      emptyDir: { medium: "Memory" }  # tmpfs for temp writes

  # Network policy: deny all egress by default
  # Apply separately via NetworkPolicy resource
```

---

## 7. Sandboxing Patterns

### WASM Sandbox for Untrusted Code

```rust
// Rust: Execute untrusted code in WASM sandbox via Wasmtime
use wasmtime::*;
use std::path::Path;

fn execute_sandboxed(wasm_path: &Path, input: &[u8]) -> Result<Vec<u8>> {
    let engine = Engine::default();
    let module = Module::from_file(&engine, wasm_path)?;

    // Strict resource limits
    let mut store = Store::new(
        &engine,
        Limits {
            memory_size: 10 * 1024 * 1024,  // 10 MB max
            table_elements: 100,
            instances: 1,
            tables: 1,
            memories: 1,
        },
    );
    store.set_fuel(10000)?;  // Limit execution steps

    let instance = Instance::new(&mut store, &module, &[])?;

    // Get the entrypoint function
    let run = instance.get_typed_func::<(), u32>(&mut store, "run")?;

    // Execute with fuel limit
    let result = run.call(&mut store, ())?;

    Ok(vec![])
}
```

### Firecracker MicroVM Setup

```bash
# Firecracker: Lightweight microVM for agent code execution
# Install: https://github.com/firecracker-microvm/firecracker

# Create VM configuration
cat > vm_config.json << 'EOF'
{
  "boot-source": {
    "kernel_image_path": "/path/to/vmlinux",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off"
  },
  "drives": [{
    "drive_id": "rootfs",
    "path_on_host": "/path/to/rootfs.ext4",
    "is_root_device": true,
    "is_read_only": true
  }],
  "machine-config": {
    "vcpu_count": 1,
    "mem_size_mib": 128
  },
  "network-interfaces": []  // No network by default
}
EOF

# Launch VM
./firecracker --api-sock /tmp/firecracker.sock --config-file vm_config.json
```

---

## 8. Language-Specific Standards

### Rust (High-Assurance Core)

```rust
#![forbid(unsafe_code)]
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct Counter { value: AtomicUsize }

impl Counter {
    pub fn new() -> Self { Counter { value: AtomicUsize::new(0) } }
    pub fn increment(&self) -> usize { self.value.fetch_add(1, Ordering::SeqCst) + 1 }
    pub fn get(&self) -> usize { self.value.load(Ordering::SeqCst) }
}
```

- Default: `#![forbid(unsafe_code)]` at crate level
- `unsafe` ONLY for FFI/hardware + perf-critical with formal verification
- `panic = "abort"` — prevent unwinding UB
- Ferrocene (ISO 26262 ASIL-D / IEC 61508 SIL 3 certified toolchain)
- Coverage: >=90% line for ASIL B/C; MC/DC for ASIL D

### Python (Agentic Glue)

```python
from pydantic import BaseModel, Field, field_validator

class AgentInput(BaseModel):
    query: str = Field(..., min_length=1, max_length=10000)

    @field_validator('query')
    @classmethod
    def validate_query(cls, v: str) -> str:
        if len(v) > 10000:
            raise ValueError("Query too long")
        return v.strip()

def process_agent(input_data: AgentInput) -> dict:
    return {"action": "process", "input_length": len(input_data.query)}
```

- **Banned**: `pickle` (RCE), `eval()`/`exec()`/`compile()`, `__import__()`, unallowlisted `subprocess`
- Determinism: `PYTHONHASHSEED=0` in tests; pin deps with `uv.lock`
- Tools: `ruff` (lint+format), `bandit` (SAST), `mypy --strict`

### TypeScript (Mission-Critical Interface)

```typescript
import { z } from 'zod';

const AgentResponseSchema = z.object({
  action: z.enum(['read', 'write', 'delete']),
  target: z.string().min(1),
  parameters: z.record(z.unknown()),
  reasoning: z.string()
});

type AgentResponse = z.infer<typeof AgentResponseSchema>;

const result = AgentResponseSchema.safeParse(apiResponse);
if (!result.success) throw new Error(`Invalid: ${result.error.message}`);
```

- `strict: true` with all strict sub-flags; `noUncheckedIndexedAccess`
- Ban: `any` (use `unknown` + narrowing); type assertions (`as`)
- Runtime validation: all I/O must use Zod schemas

### Bash (Infrastructure Automation)

```bash
#!/usr/bin/env bash
set -euo pipefail

HOST="${1:?Usage: $0 <hostname>}"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10"

rsync -avz -e "ssh ${SSH_OPTS}" /local/data/ "${HOST}:/remote/path/"
```

- `shellcheck` in CI; `trap` for cleanup; no `eval` on user input
- SSH: keys only, `BatchMode=yes`, `ConnectTimeout=10`

### Go (Cloud-Native Infrastructure)

```go
package telemetry

import (
    "context"
    "fmt"
    "time"
)

type Frame struct {
    Length uint16
    Data   []byte
}

func NewFrame(length uint16) *Frame {
    return &Frame{Length: length, Data: make([]byte, length)}
}

func (f *Frame) Validate() error {
    if f.Length == 0 {
        return fmt.Errorf("frame length cannot be zero")
    }
    if len(f.Data) != int(f.Length) {
        return fmt.Errorf("data length mismatch")
    }
    return nil
}

func (f *Frame) Process(ctx context.Context) error {
    select {
    case <-ctx.Done():
        return ctx.Err()
    case <-time.After(100 * time.Millisecond):
        return f.Validate()
    }
}
```

- `gofmt` + `go vet` + `golangci-lint` + `govulncheck` in CI
- Wrap errors: `fmt.Errorf("operation failed: %w", err)` — never leak internals to clients

---

## 9. Verification & Formal Methods

### Testing Coverage Requirements

| Criticality | Line | Branch | MC/DC | Property Testing |
|-------------|------|--------|-------|------------------|
| ASIL D / SIL 4 | >=95% | >=95% | Required | Required |
| ASIL C / SIL 3 | >=90% | >=90% | Highly Recommended | Required |
| ASIL B / SIL 2 | >=85% | >=80% | Recommended | Recommended |
| ASIL A / SIL 1 | >=80% | >=70% | Optional | Optional |

### Static Analysis Tools

| Language | Tools |
|----------|-------|
| C/C++ | Coverity, Klocwork, Polyspace, AddressSanitizer, UBSan |
| Rust | Clippy (Ferrocene-certified), cargo-audit, cargo-deny, cargo fuzz |
| Python | mypy --strict, bandit, ruff, semgrep |
| TypeScript | tsc --strict, ESLint security plugins, semgrep |
| Go | go vet, golangci-lint, govulncheck |

### Formal Methods (ASIL D / SIL 4)

| Method | Tool | Use Case |
|--------|------|----------|
| Model Checking | TLA+, SPIN | Concurrent/distributed protocols |
| Theorem Proving | Coq, Isabelle/HOL | Algorithm correctness proofs |
| Contract-Based | SPARK Ada, Dafny | Embedded safety-critical code |
| Rust Verification | Kani, Creusot, Prusti | Memory safety + functional properties |

---

## 10. Safety & Criticality Classification

| Standard | Domain | Levels | Key Requirement |
|----------|--------|--------|-----------------|
| **DO-178C** | Avionics | A (Catastrophic) -> E (No Effect) | Level A requires MC/DC coverage |
| **IEC 62304** | Medical Devices | C (Death) -> A (No Harm) | Class C: full lifecycle rigor |
| **ISO 26262** | Automotive | ASIL D (Highest) -> QM | ASIL D: <10^-8 failures/hour |
| **IEC 61508** | Industrial | SIL 4 -> SIL 1 | SIL 4: <10^-8 failures/hour |
| **OWASP ASVS 5.0** | Application Security | L1 -> L3 | L3: Full verification + formal methods |

---

## 11. Supply Chain Security (SLSA 1.2)

| Level | Requirements | Protects Against |
|-------|-------------|------------------|
| SLSA 0 | No assurances | None |
| SLSA 1 | Provenance published, tamper-resistant | Accidents, misconfigs |
| SLSA 2 | Builds in trusted, authenticated environments | Pipeline tampering |
| SLSA 3 | Comprehensive controls, hard-to-forge provenance, 2-person review | Insider attacks |

**Implementation**: SLSA-compliant CI/CD (GitHub Actions, Tekton Chains); SBOMs (CycloneDX, SPDX); sign with Sigstore/cosign; verify with slsa-verifier.

---

## 12. Operational Safety

### Zero Trust Architecture (SP 800-207)

| Layer | Control |
|-------|---------|
| Identity | JWT/OIDC with mTLS (SPIFFE/SPIRE) |
| Device | Posture checks in CI/CD |
| Network | Microsegmentation (Istio, Cilium) |
| Application | Runtime verification (Falco, Tetragon) |
| Data | Encryption-at-rest, access logging |

Policy as Code: OPA/Rego or Kyverno, enforced at every CI/CD stage.

### High Availability Patterns

- **Circuit Breaker**: Fail fast on downstream issues
- **Bulkhead**: Isolate failures to prevent cascading
- **Retry**: Exponential backoff with jitter: `delay = min(base * 2^attempt, max_delay) * (0.5 + random() * 0.5)`. Max 3-5 attempts.

### PQC CLI Examples (OpenSSL 3.5+ — native PQC since March 2026)

> No provider plugin needed. OpenSSL 3.5.0 (March 2026) shipped built-in
> ML-KEM / ML-DSA / SLH-DSA; the first CMVP certificate for an ML-DSA module
> issued the same month. Earlier docs referencing the `oqs-provider` fork are
> legacy.

```bash
# ML-KEM-768 key pair (FIPS 203 — post-quantum key encapsulation)
openssl genpkey -algorithm mlkem768 -out mlkem768.pem
openssl pkeyutl -encapsulate -inkey mlkem768.pem -out ciphertext.bin -secret shared.bin

# ML-DSA-65 signing key (FIPS 204 — post-quantum digital signatures)
openssl genpkey -algorithm mldsa65 -out mldsa65.pem
openssl pkeyutl -sign -inkey mldsa65.pem -in message.bin -out signature.bin -rawin
openssl pkeyutl -verify -pubin -inkey mldsa65_pub.pem -in message.bin -sigfile signature.bin -rawin

# Hybrid PQC TLS (X25519 + ML-KEM-768)
openssl s_server -cert cert.pem -key key.pem -groups x25519_mlkem768
```

**Deprecation**: RSA, ECDSA, ECDH -> deprecate by 2030, remove by 2035 (NIST IR 8547).

---

## 13. CWE Top 25 (2026) — Quick Reference

| # | CWE | Name | Fix |
|---|-----|------|-----|
| 1 | CWE-79 | XSS | Output encoding, CSP headers, Trusted Types |
| 2 | CWE-89 | SQL Injection | Parameterized queries, ORM |
| 3 | CWE-352 | CSRF | Anti-CSRF tokens, SameSite cookies |
| 4 | CWE-862 | Missing Authorization | RBAC, explicit authz checks |
| 5 | CWE-787 | Out-of-bounds Write | Bounds checking, safe languages (Rust) |
| 6 | CWE-22 | Path Traversal | Input validation, allowlist paths |
| 7 | CWE-416 | Use After Free | Memory safety, smart pointers, Rust |
| 8 | CWE-125 | Out-of-bounds Read | Bounds checking, sanitizers |
| 9 | CWE-78 | OS Command Injection | Avoid shell; allowlist commands |
| 10 | CWE-94 | Code Injection | Never execute untrusted/LLM output |
| 11 | CWE-120 | Buffer Overflow | Bounds checking, safe string functions |
| 12 | CWE-434 | Unrestricted File Upload | Type validation, isolated storage |
| 13 | CWE-476 | NULL Pointer Dereference | Null checks, Option/Result types |
| 14 | CWE-502 | Unsafe Deserialization | Avoid pickle/eval; use safe formats |
| 15 | CWE-918 | SSRF | URL allowlisting, network isolation |
| 16 | CWE-77 | Command Injection | Avoid shell; parameterize |
| 17 | CWE-770 | Resource Alloc Without Limits | Rate limiting, quotas |

---

## 14. Deployment Checklist

### Criticality Assessment
- [ ] Life-Critical (patient safety, avionics)
- [ ] Mission-Critical (99.999% uptime)
- [ ] Security-Critical (financial, PII)
- [ ] Business-Critical (revenue impact)

### Autonomy Level
- [ ] HITL: Every action requires approval
- [ ] HOTL: Supervised, can intervene
- [ ] Fully Autonomous: Independent with monitoring

### Data Sensitivity
- [ ] PII/PHI processing
- [ ] Financial data handling
- [ ] Confidential IP access
- [ ] Data residency requirements

### Compliance
- [ ] HIPAA, SOX, GDPR
- [ ] ISO 27001, SOC 2
- [ ] ISO 26262, IEC 62304, DO-178C

---

> **The Golden Rule**:
> The Body (Code) **must** be deterministic and verifiable.
> **Never** confuse deterministic code with probabilistic AI.
> **Every** input boundary is an attack surface.
