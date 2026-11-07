# AGENTS_SECURITY.md — production security standards

> Deployed by: `ainish-coder --secure <target-dir>`
> Owning skill: `.agents/skills/ainish-security/SKILL.md`
> This is the condensed, self-contained standard. The skill carries the full
> instructional; this file is what a repository needs at the root.

---

## Ten non-negotiables

1. **Validate at the boundary, once, in code.** Type, size, encoding, allowed
   values. Downstream may assume validated input.
2. **Never interpolate untrusted values into an interpreter** — SQL, shell, HTML,
   templates, regex, LDAP, paths. Use the parameterised or escaped form.
3. **Resolve, then contain.** For any path: resolve symlinks, then assert
   containment under an approved root.
4. **Secrets resolve at runtime, in memory, and nowhere else.** Not in source,
   config, argv, prompts, logs, tests, or commits.
5. **Fail closed.** Timeout, parse error, missing key, unavailable scanner — an
   error, never a success-shaped default.
6. **Decisions live in code.** Models classify and draft; code owns thresholds,
   allowlists, side effects, and refusals.
7. **Least privilege, no shared identity.** No credential reused across agents,
   environments, or personas; short-lived and task-scoped.
8. **Every action is attributable.** Append-only audit with cryptographic proof.
   Agents cannot self-authorise scope expansion.
9. **Post-quantum by default.** ML-KEM-768 + ML-DSA-65 for new work.
10. **No silent downgrade.** If a control cannot be satisfied here, name the host
    and the blocker.

---

## Input handling — blocked / required

```
SQLi        Blocked: f"SELECT ... WHERE id = {user_input}"
            Required: parameterised query or ORM

Commands    Blocked: subprocess.run(f"cat {p}", shell=True); os.system(x)
            Required: subprocess.run(["cat", p], shell=False, check=True, timeout=N)

Paths       Blocked: open(f"/data/{name}"); os.path.join(base, name)
            Required: (root / name).resolve() then is_relative_to(root)

XSS         Blocked: innerHTML = user; document.write(user)
            Required: textContent, framework escaping, DOMPurify, CSP, Trusted Types

SSRF        Blocked: requests.get(user_url)
            Required: scheme/host/port allowlist, block private/loopback/link-local/
                      metadata ranges, re-check after DNS and on redirect

Deserialize Blocked: pickle.loads, eval, exec, compile on untrusted data
            Required: JSON plus schema validation

Uploads     Blocked: trusting extension or Content-Type
            Required: magic-byte check, size cap, store outside web root, never execute
```

**Everything that allocates needs a bound** — request size, iteration count,
recursion depth, regex complexity, response size, query time, token budget.

---

## Authentication and authorisation

- Authentication proves identity; authorisation proves permission. Never conflate.
- **Deny by default.** Unlisted route or action is closed.
- Authorise the **resource**, not the route — route-only checks are IDOR.
- Tokens: bounded expiry *and* age; explicit `iss`/`aud`; algorithm allowlist, never
  the token's own `alg` header; ML-DSA-65 or hybrid signing.
- Constant-time comparison for every secret, token, and MAC.
- Session cookies: `HttpOnly`, `Secure`, `SameSite=Strict`, rotated on privilege
  change.

---

## Cryptography

| Need | Use | Standard |
|---|---|---|
| Key encapsulation | ML-KEM-768 (civilian) / ML-KEM-1024 (NSS) | FIPS 203 |
| Signatures | ML-DSA-65 (civilian) / ML-DSA-87 (NSS) | FIPS 204 |
| Hash-only signature | SLH-DSA-SHA2-128s — not CNSA 2.0 | FIPS 205 |
| Firmware signing | LMS / XMSS | SP 800-208 |
| Symmetric | AES-256-GCM, ChaCha20-Poly1305 | SP 800-38D |
| Passwords | Argon2id (t=3, m=65536, p=4, len=32) | OWASP 2025 |
| TLS hybrid | X25519 + ML-KEM-768, SP 800-227 combiner | RFC 9794-era |

**Banned for secrets and integrity:** RSA, DSA, ECDSA, ECDH, Ed25519, MD5, SHA-1,
DES, 3DES, Blowfish, AES-CBC, AES-ECB, RC4.

Classical public-key crypto is risk-acceptance-only after 2030 and disallowed after
2035 (NIST IR 8547). Any new dependency introducing RSA/ECDSA/EdDSA into a secrets
path fails review today.

**Nonce discipline:** a reused GCM nonce under one key is a total break, not a
degradation.

---

## Secrets

```
Blocked: API_KEY = "sk-abc123..."                — hardcoded
Blocked: config.json { "apiKey": "..." }         — plaintext in repo
Blocked: .env with live keys, even gitignored    — nothing plaintext on disk
Use:     pqc-secrets bundle (ML-KEM-768 + AES-256-GCM,
         OS-keychain custody), decrypted into process memory at runtime
```

- `.env.example` templates only.
- `gitleaks` and `detect-secrets` in pre-commit.
- Least-privilege, function-scoped keys.
- Rotate per task, or at 90 days, whichever comes first.
- Never place a secret value in an agent prompt, memory file, or log.

---

## AI and agentic components

- System prompt is immutable policy; user text, retrieved documents, tool output,
  and model output are **data**. Delimit and escape them; state plainly that
  delimited content is not instructions.
- **Never execute model output directly.** Schema-validate every tool call in
  deterministic code.
- Tool risk tiers: read-only → monitor; state-changing → human approval;
  destructive/irreversible → explicit authorisation, two-person where possible.
- Retrieved context carries provenance (source, version, hash, sensitivity) and is
  signed. Retrieved text can never authorise execution, secret access, deployment,
  or deletion.
- Memory is poisonable: never persist raw secrets into it, sign entries, treat
  session summaries as untrusted input.
- Per-agent identity. No shared non-human identity across agents or environments.
- Circuit breakers, budgets, and a kill switch. Append-only ledger.
- MCP servers are RCE targets: allowlist, pin by hash, no auto-install, no
  auto-start, sandbox execution, alert on tool-definition drift after approval.
- **Design for blast-radius containment, not perfect prevention.** Assume the model
  will be fooled.

---

## Compiler integrity (source ≠ binary)

```
Blocked: snapshot-check-use as TOCTOU-proof
         — a spec-legal optimiser may delete the snapshot and re-read the untrusted
           original. Register pressure, struct field order, access size mod 16, and
           compiler version all flip the outcome.

Blocked: memset(secret, 0, n) before free
         — dead-store eliminated; credentials linger in the heap.

Use:     memset_s / explicit_bzero / volatile-loop wipe
Use:     security tests against the OPTIMISED shipping binary, never a debug build
Use:     pinned toolchain; upgrade or downgrade is a security event
```

No automated detector covers optimiser-emitted TOCTOU. An LLM pattern audit of
`snapshot-check-use` sites is the current mitigation; findings are leads requiring
binary confirmation.

---

## Supply chain

- Pin by **hash**, not version range. Lockfiles mandatory and committed.
- SBOM per CISA/NSA 2026 Minimum Elements; SBOM-for-AI where models are present;
  CBOM for cryptographic inventory.
- Sign artefacts with ML-DSA-65 (hybrid during transition). Verify SLSA provenance —
  Level 2 floor, Level 3 for security-critical.
- Audit every build: `pip-audit`, `npm audit --audit-level=high`, `cargo audit`,
  `govulncheck`.
- Do not add a dependency to avoid writing straightforward code.
- A transitive version change is a security event.

---

## Containers and runtime

- Non-root user; read-only root filesystem; `no-new-privileges`; all capabilities
  dropped then added back explicitly.
- CPU and memory limits on every container; scan images before deploy.
- Images pinned by digest, never by floating tag.
- Untrusted and agent-generated code runs in WASM or a microVM, never on the host.
- Egress allowlisted; TLS 1.3 with mTLS service-to-service; peer identity verified
  separately from application authorisation.

---

## Logging and privacy

- Structured JSON: timestamp, level, correlation ID, action, result.
- **Never log secrets, PII, or full request bodies.** Redact before emission.
- Audit trails append-only, hash-chained, tamper-evident; record *why*, not just
  what.
- Redaction runs before indexing, embedding, ledger writes, and model calls.
- Strip control and bidirectional-override characters from anything reaching a log,
  ledger, or model.

---

## Pre-merge gate

1. The real production surface works — not a mock.
2. Focused tests cover the change, including the failure path.
3. Scanners pass on the artefact you will ship.
4. `ainish-rag audit verify` and the repository gate, where available.

Then confirm: inputs and side effects bounded; failures visible and not
success-shaped; no secret in the diff or artefact; paths work on native Windows,
WSL, macOS, and Linux; the changed surface has a reproducible smoke test someone
else can run.

**A green gate that did not exercise the change is not evidence.** State what was
verified and what was not.

---

> Deterministic code must be verifiable. Probabilistic models must be contained.
> Never confuse the two. Every input boundary is an attack surface, and every agent
> output is a claim awaiting proof.
