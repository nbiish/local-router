# Governance, cryptography, and compliance — detailed reference

Depth for `../../SKILL.md` §3, §8, §10. Load for compliance mapping, PQC migration
planning, audit work, or risk classification.

---

## 1. Post-quantum status matrix

**Status accuracy is itself a security control.** Final, draft, selected, and
candidate are not synonyms, and presenting a draft algorithm as approved is a
defect in the documentation.

| Standard | Algorithm | Status (2026-11) | Replaces | Notes |
|---|---|---|---|---|
| FIPS 203 | ML-KEM | **Final** (Aug 2024) | RSA/ECDH key exchange | ~1.2 KB pk, ~1 KB ct |
| FIPS 204 | ML-DSA | **Final** (Aug 2024) | RSA-PSS/ECDSA | ~1.3 KB pk, ~3.3 KB sig |
| FIPS 205 | SLH-DSA | **Final**; **not CNSA 2.0** | — hash-based hedge | ~8 KB sig |
| FIPS 206 | FN-DSA (FALCON) | **DRAFT** — final expected late 2026–2027; **not CNSA 2.0** | Compact ML-DSA | ~666 B sig; tracking only |
| — (IR 8545) | HQC | **Selected** Mar 2025; standard ~2027; **not CNSA 2.0** | — code-based KEM hedge | Crypto-agility reserve |
| SP 800-208 | LMS / XMSS | **Final**; CNSA 2.0-approved | — stateful hash | Firmware / sw signing |
| SP 800-227 | — | Final (Sep 18, 2025) | — key combiner guidance | Concatenate-then-KDF; never bespoke XOR |

### Selection guide

| Scenario | Algorithm |
|---|---|
| Default, all new systems | ML-KEM-768 + ML-DSA-65 |
| CNSA 2.0 / NSS / defence | ML-KEM-1024 + ML-DSA-87; AES-256 + SHA-384/512. New acquisitions comply from **2027-01-01**; exclusive use by **2031-12-31** |
| High-security civilian | ML-KEM-1024 + ML-DSA-87 |
| Firmware / trust anchors | LMS/XMSS (SP 800-208) alongside ML-DSA. SLH-DSA is a civilian hedge only |
| IoT / bandwidth-limited | FN-DSA **once FIPS 206 finalises**; not production today |
| Migration | X25519 + ML-KEM-768 hybrid, SP 800-227 combiner |

Hybrid is also a hedge against implementation immaturity: a single implementation
bug in one leg does not break the session.

### Mnemonic

```
ML-KEM   → key exchange     (two parties share a secret)
ML-DSA   → signatures       (prove who signed)              ← DEFAULT
SLH-DSA  → signatures       (hash-only backup)              ← civilian only, NOT CNSA 2.0
FN-DSA   → signatures       (compact)                       ← IoT, DRAFT — track only
HQC      → key exchange     (code-based backup)             ← agility reserve, standard ~2027
LMS/XMSS → signatures       (stateful hash)                 ← CNSA 2.0 firmware signing
```

---

## 2. Implementation surfaces

```python
# liboqs-python
from oqs import KeyEncapsulation, Signature

kem = KeyEncapsulation("ML-KEM-768")
pk = kem.generate_keypair()
ct, shared_a = kem.encap_secret(pk)
shared_b = kem.decap_secret(ct)
assert shared_a == shared_b

signer = Signature("ML-DSA-65")
pk = signer.generate_keypair()
sig = signer.sign(b"authorize deploy")
assert Signature("ML-DSA-65", pk).verify(b"authorize deploy", sig)
```

```python
# pyca/cryptography >= 47 — preferred where wheels must avoid the liboqs dependency
from cryptography.hazmat.primitives.asymmetric import mlkem, mldsa
```

```bash
# OpenSSL 3.5+ (March 2026) ships native PQC. The oqs-provider fork is legacy.
openssl genpkey -algorithm mlkem768 -out mlkem768.pem
openssl pkeyutl -encapsulate -inkey mlkem768.pem -out ct.bin -secret ss.bin
openssl genpkey -algorithm mldsa65 -out mldsa65.pem
openssl pkeyutl -sign -inkey mldsa65.pem -in msg.bin -out sig.bin -rawin
openssl s_server -cert cert.pem -key key.pem -groups x25519_mlkem768
```

The first CMVP certificate for an ML-DSA module was issued March 2026.

---

## 3. Deprecation clock

| Date | Event |
|---|---|
| 2030 | Classical 112-bit public-key crypto becomes risk-acceptance-only (NIST IR 8547) |
| 2030-12-31 | Federal high-value assets complete PQC key establishment (OMB M-26-15) |
| 2031-12-31 | CNSA 2.0 exclusive use for NSS |
| 2035 | Classical public-key crypto disallowed in standards (EO 14412) |

**Practical consequence:** any new dependency that introduces RSA, ECDSA, or EdDSA
into a secrets or signing path fails review today. It is not a 2030 problem — it is
a dependency you would have to remove before its first birthday plus interest.

---

## 4. Audit and evidence

- **Append-only, hash-chained.** Each record includes the previous record's digest.
  Tampering breaks the chain at a detectable point.
- **Attributable.** Who acted, what they did, when, against what, and the
  cryptographic proof. "The agent did it" is not attribution — the agent has an
  identity and a human accountable for it.
- **Signed.** ML-DSA-65 over the record; verify with `ainish-rag audit verify`.
- **Retained per regime**, and erasable where a regime requires it. Data you cannot
  defend retaining is a liability; data you cannot erase is a violation.
- **Redacted before write**, not after.

```json
{
  "timestamp": "2026-01-15T10:30:00Z",
  "actor": "agent:build-runner",
  "action": "file_write",
  "target": "src/auth/login.py",
  "content_hash": "sha256:abc123...",
  "reason": "apply reviewed patch 4f2a",
  "approved_by": "human:operator",
  "prev_hash": "sha256:...",
  "signature": "ML-DSA-65:..."
}
```

---

## 5. Standards and frameworks

### NIST AI RMF (2026 status)

| Framework | Status |
|---|---|
| AI RMF 1.0 (AI 100-1) | Final (Jan 2023) |
| GenAI Profile (AI 600-1) | Final (Jul 2024) |
| Cyber AI Profile (NISTIR 8596) | Working sessions 2026 |
| AI 100-2e2025 (adversarial ML taxonomy) | Final (Dec 2025) |
| SP 800-218A (secure SDLC for generative AI) | Published |
| NIST CAISI | AI Agent Standards Initiative; sessions started |

### EU AI Act (Regulation EU 2024/1689)

| Date | Obligation |
|---|---|
| 2025-02-02 | Prohibited practices (Art. 5); AI literacy (Art. 4) |
| 2025-08-02 | GPAI model obligations (Arts. 51–56) |
| **2026-08-02** | **Commission enforcement powers** (fines to €15M / 3%); high-risk requirements; Art. 50 transparency |
| 2026-12-02 | Art. 50(2) synthetic-content disclosure |
| 2027-08-02 | Legacy GPAI full compliance |
| 2027-12-02 | Annex III high-risk systems |

Penalties reach €35M or 7% of global turnover. Systemic-risk threshold: ≥10²⁵ FLOPs
training compute.

### ISO/IEC 42001

AI Management System: 10 Annex SL clauses plus 12 Annex A control areas;
third-party certifiable; covers AI policy, risk assessment, data quality,
transparency, human oversight, monitoring.

### Cross-standard mapping

| Area | NIST AI RMF | EU AI Act | ISO 42001 | NIST CSF 2.0 |
|---|---|---|---|---|
| Risk management | Govern + Map | Art. 9 | Clause 6 | Govern + Identify |
| Data governance | Map | Art. 10 | Annex A.6 | Protect |
| Transparency | Map | Art. 13 | Annex A.7 | Detect |
| Human oversight | Govern | Art. 14 | Annex A.8 | Respond |
| Security testing | Measure | Art. 15 | Annex A.9 | Detect |
| Incident response | Manage | Art. 62 | Clause 8 | Respond + Recover |

### OWASP ASVS 5.0

L1 baseline → L2 standard → L3 high assurance (full verification plus formal
methods where warranted). Map the target's level before claiming compliance.

---

## 6. AIVSS — AI vulnerability scoring

Extends CVSS v4.0 with agentic amplification:

`AIVSS = min(CVSS_base × ARAF, 10.0)`, ARAF capped at 4.0.

| Factor | Low (+0.0) | Medium (+0.2) | High (+0.4) | Critical (+0.6) |
|---|---|---|---|---|
| Agent autonomy | Supervised | Semi-autonomous | Autonomous | Fully autonomous, no HITL |
| Tool scope | No tools | Read-only APIs | Read-write APIs | Code execution / shell |
| Multi-agent | Single | 2–3 | 4–10 | 10+ / swarm |
| Human oversight | Real-time HITL | Periodic review | Post-hoc audit | None |
| Blast radius | One document | One system | Multiple systems | Organisation-wide |

Worked example — CVE-2025-53773 (Copilot YOLO): CVSS 8.5, ARAF 3.2 → AIVSS 10.0.

| Factor | Level | Multiplier |
|---|---|---|
| Autonomy | Fully autonomous YOLO | +0.6 |
| Tool scope | Code exec + commit | +0.6 |
| Multi-agent | CI/CD interaction | +0.2 |
| Human oversight | No HITL | +0.4 |
| Blast radius | Org-wide + production | +0.4 |

Use alongside CVSS for prioritisation, not instead of it.

---

## 7. Zero trust (SP 800-207)

| Layer | Control |
|---|---|
| Identity | OIDC + mTLS (SPIFFE/SPIRE); per-agent identity |
| Device | Posture checks in CI/CD |
| Network | Microsegmentation (Istio, Cilium) |
| Application | Runtime verification (Falco, Tetragon) |
| Data | Encryption at rest; access logging |

Policy as code (OPA/Rego, Kyverno) at every stage. Zero trust is an architecture
where **authorisation is per request and identity-based**, not a product you
install.

---

## 8. SBOM and CBOM

- **SBOM** per CISA/NSA 2026 Minimum Elements (July 2026, supersedes NTIA 2021).
- **SBOM-for-AI** per the May 2026 minimum elements when the artefact contains
  models or training data.
- **CBOM** — cryptographic bill of materials — per the CBOM guidance mandated by
  the June 2026 PQC executive order. Track every algorithm, key size, protocol, and
  certificate, with the migration target for each.
- Generate in CycloneDX or SPDX; sign with ML-DSA-65; store with the release.

A CBOM is how you answer "what breaks in 2030" without a six-month audit.
