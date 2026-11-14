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
| FIPS 206 | FN-DSA (FALCON) | **No public draft** (checked 2026-11-10) — NIST lists it as "under development"; **not CNSA 2.0** | Compact ML-DSA | ~666 B sig; tracking only. "Draft" was the 2026-08 state and was already optimistic |
| — (IR 8545) | HQC | **Selected** 2025-03-11; **no draft yet**; final planned 2027, slipping; **not CNSA 2.0** | — code-based KEM hedge | Crypto-agility reserve, unusable until a FIPS exists |
| SP 800-208 | LMS / XMSS | **Final**; CNSA 2.0-approved | — stateful hash | Firmware / sw signing |
| SP 800-227 | — | Final (2025-09-18) | — key combiner guidance | Concatenate-then-KDF; never bespoke XOR |
| IR 8547 | — | **Final (2026-10-27)** | — transition schedule | Names **ML-KEM-768** the recommended default |
| RFC 10024 | X25519MLKEM768, SecP256r1MLKEM768, SecP384r1MLKEM1024 | **Proposed Standard (2026-08)** | — PQ/T hybrid for TLS 1.3 | Supersedes the "hybrid is coming" framing; RFC 9954 is the framework, RFC 9846 obsoletes RFC 8446 |

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
# OpenSSL 3.5.0 (2025-04-08) added native ML-KEM/ML-DSA/SLH-DSA; 4.1.0 (2026-10-23) added
# ML-DSA-MU and AVX-512 optimisations. The oqs-provider fork is legacy. NOTE: the OpenSSL FIPS
# provider has NO validated PQC module — 3.5.8 is still in CMVP review, so native != validated.
openssl genpkey -algorithm mlkem768 -out mlkem768.pem
openssl pkeyutl -encapsulate -inkey mlkem768.pem -out ct.bin -secret ss.bin
openssl genpkey -algorithm mldsa65 -out mldsa65.pem
openssl pkeyutl -sign -inkey mldsa65.pem -in msg.bin -out sig.bin -rawin
openssl s_server -cert cert.pem -key key.pem -groups x25519_mlkem768
```

**Validated-module reality (2026-11-10):** CMVP #5497 (Crypto4A QASM HSM, validated 2026-08) is
the first certificate listing ML-KEM, ML-DSA and SLH-DSA. The "ML-DSA certificate, March 2026"
claim that circulated earlier does not check out — do not cite it. ACVP vectors for FIPS 203/204/205
are published in ACVP-Server, so testing is possible well before validation lands.

---

## 3. Deprecation clock

| Date | Event |
|---|---|
| 2026-10-22 | M-26-15 migration plans were due (120 days from the 2026-06-24 memo) |
| 2027-01-01 | New NSS acquisitions must be CNSA 2.0-compliant |
| 2030 | Classical 112-bit public-key crypto becomes risk-acceptance-only (IR 8547 final) |
| 2030-01-02 | TLS 1.3 support required everywhere (EO 14306 / M-26-15) |
| 2030-12-31 | Federal high-value assets complete PQC **key establishment** (EO 14412) |
| 2030-12-31 | Non-CNSA-2.0-capable NSS equipment and services phased out |
| 2031-12-31 | Federal HVA **signatures** complete (EO 14412); CNSA 2.0 exclusive use for NSS |
| 2035 | Classical public-key crypto disallowed in standards (EO 14412 / IR 8547) |

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
| AI RMF 1.0 (AI 100-1) | Final (Jan 2023) — **still the current text**; revision under way per the White House AI Action Plan, no date |
| GenAI Profile (AI 600-1) | Final (Jul 2024) — no revision found (as of 2026-11-10) |
| Cyber AI Profile (NISTIR 8596) | **Draft** (IPRD 2025-12-16, comments closed 2026-01-30); no second draft published |
| AI 100-2e2025 (adversarial ML taxonomy) | Final (Dec 2025) |
| SP 800-218A (secure SDLC for generative AI) | Published |
| NIST **CAISSI** (ex-CAISI) | Renamed under **EO 14434** (2026-09-29; 91 FR 63129) — "Super Intelligence"; the AI Agent Standards Initiative continues under the new name; NSA's AISC is now **SISC** |

### EU AI Act (Regulation EU 2024/1689)

| Date | Obligation |
|---|---|
| 2025-02-02 | Prohibited practices (Art. 5); AI literacy (Art. 4) |
| 2025-08-02 | GPAI model obligations (Arts. 51–56) |
| **2026-08-02** | Art. 50 transparency + Commission and national enforcement over GPAI. **High-risk did NOT start** — see the next row |
| 2026-12-02 | Grace ends for machine-readable marking of systems already on the market |
| 2027-08-02 | Legacy GPAI full compliance |
| **2027-12-02** | Annex III stand-alone high-risk (fixed by **Reg (EU) 2026/1744**, OJ 2026-07-24) |
| **2028-08-02** | Annex I product-embedded high-risk — medical devices, machinery |

Penalties: €35M / 7% for prohibited practices; **€15M / 3% for other obligations** (Art. 50 and
high-risk included); €7.5M / 1% for misleading information; GPAI fines up to €15M / 3%,
enforceable from 2026-08-02. Systemic-risk threshold: ≥10²⁵ FLOPs training compute.

**Standards are the bottleneck, not the text.** **EN 18286:2026** (AI quality management, Art. 17)
is the *only* harmonised standard carrying presumption of conformity, cited by Implementing
Decision (EU) 2026/2274 on 2026-10-14. The risk-management standard `prEN 18228` went to *Under
Approval* after a **negative** enquiry vote, and the M/613 mandate expires 2027-02-28 — so a
high-risk provider should assume it must evidence Art. 9 itself rather than wait for a standard.

### ISO/IEC 42001

AI Management System: 10 Annex SL clauses plus 12 Annex A control areas; third-party certifiable;
covers AI policy, risk assessment, data quality, transparency, human oversight, monitoring.

**ISO/IEC 42001:2023 remains the current edition** (no amendment found as of 2026-11-10).
Certification bodies are additionally bound by **ISO/IEC 42006:2025** (published 2025-07-07) on
auditor competence, audit time and impartiality — accreditation is per body, so certificates are
not equally rigorous. It is **not harmonised** under the AI Act: EN 18286:2026 is the only AI
management standard with presumption of conformity, and adoption is not harmonisation.

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

**ASVS 5.0.0 (2025-05-30) is current** (checked 2026-11-10); the next release is a patch, 5.0.1,
not 5.1. L1 baseline → L2 standard → L3 high assurance (full verification plus formal methods
where warranted). Map the target's level before claiming compliance.

---

## 6. AIVSS — AI vulnerability scoring

**v0.8 (2026-03-19) is the current release**; v1.0 is in review with publication "before the end
of 2026" — treat it as pending until the project site updates. No regulator mandates AIVSS.
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
install. SP 800-207 and SP 800-207A are unchanged (2020 / 2023-09-13); CISA's ZTMM is still v2.0.

The only 2026 movement is **agent identity, and it is pre-standard**: the NCCoE concept paper
(2026-02-05) collected 600+ comments and its practice guide is not published. The pattern that
works today is SPIFFE/SPIRE SVIDs for agent workload identity, RFC 8693 token exchange for
delegation, and **permission intersection** — an agent may narrow a caller's rights, never widen
them.

---

## 8. SBOM and CBOM

- **SBOM** per **2026 Minimum Elements v2.1 (2026-07-29)** — CISA + NSA + FBI + 15 international
  partners, superseding NTIA 2021. It replaced *Depth* with *Coverage*, replaced *Known Unknowns*
  with *Explicitly Identifying Unknown Information*, dropped the Access Controls element, and added
  SBOM signature, format name/version, generation context, tool name/version, SBOM version, and
  component hash value/algorithm. **Format-agnostic** — a declared format is a required field, not
  a mandated schema (CycloneDX 1.7 final, SPDX 3.0.1 final, SPDX 3.1 still RC as of 2026-11-10).
- **SBOM-for-AI** per the May 2026 minimum elements when the artefact contains models or training
  data.
- **CBOM: no federal minimum elements exist yet.** EO 14412 gave CISA/NIST 270 days (~2027-03-19),
  so in 2026 a CBOM is CycloneDX crypto properties plus your own inventory. Track every algorithm,
  key size, protocol, certificate and the migration target for each. Say "per EO 14412 directive"
  rather than citing a baseline that has not been published.
- Generate in CycloneDX or SPDX; sign with ML-DSA-65 (or a hybrid) and store with the release.

A CBOM is how you answer "what breaks in 2030" without a six-month audit.
