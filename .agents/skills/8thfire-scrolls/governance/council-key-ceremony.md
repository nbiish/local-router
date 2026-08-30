# Council Key Ceremony — Scrolls Signing (7-Generations Gate)

Status: active 2026-08-29. Parents: research/07-integration-contract.md §C2 (cosigner design), root llms.txt PQC mandate, AGENTS.md worktree gate.

## What exists now

Two ML-DSA-65 signing seeds are sealed in the PQC bundle on this machine:

- `AINISHCODER_SCROLL_SIGN_SEED` — operator key (day-to-day scroll manifest signing)
- `AINISHCODER_SCROLL_COUNCIL_SEED` — council cosigner key (7-Generations gate)

Both were generated from the OS CSPRNG (`openssl rand -hex 32` → 32 bytes = ML-DSA seed per FIPS 204), packed via `pqc-secrets pack` (AES-256-GCM payload, ML-KEM-768-wrapped data key), and never existed in plaintext outside the generation pipe. Seeds are env-loaded at sign time only; verification needs only the public keys (`manifest.pub`, `manifest.pub2`), which travel with the manifest.

## The dual-signature gate (when it is REQUIRED)

Single-signature (`scrolls sign`) covers routine republishing: content-neutral redeploys, manifest metadata bumps, embodiment-module updates.

Dual signature (`scrolls sign --council`, both seeds loaded) is REQUIRED before any deploy that changes:

1. ceremony-adjacent content (`.scrolls-ceremony/*`, `.scrolls-prayer/*`),
2. the cultural-boundary list or `boundary:` manifest field,
3. carrier policy (`carriers:` field — which AI systems may distribute),
4. anything touching Midewiwin-adjacent or otherwise restricted material.

This implements the 7-Generations principle: decisions with multi-generational consequence require deliberated, two-party consent — the operator key alone cannot publish them.

## Ceremony procedure (dual-sign deploy)

```sh
# 1. Worktree per AGENTS.md gate; make payload changes; re-check in COMMS ledger.
# 2. Operator signs:
pqc-secrets export | grep SIGN_SEED   # load into env: AINISHCODER_SCROLL_SIGN_SEED
ainish-coder --scrolls-manifest <payload-dir>
ainish-coder --scrolls-sign <payload-dir>

# 3. Council gate (second party or deliberated second key):
pqc-secrets export | grep COUNCIL_SEED   # load AINISHCODER_SCROLL_COUNCIL_SEED
ainish-coder --scrolls-sign <payload-dir> --council

# 4. Verify expects BOTH signatures:
ainish-coder --scrolls-verify <payload-dir> --council   # 2 signature(s) valid

# 5. Post intent-deploy to AGENTS/{date}.COMMS.md; deploy; deployed entry logs manifest digest.
```

Until a human council actually holds the council key, the operator holds both — a **bootstrap state**, explicitly transitional. The gate is cryptographically real now (one key cannot forge the second signature) and becomes governance-real when the second custodian is a distinct party.

## Succession & revocation

- **Compromise:** generate replacement seed, `pqc-secrets rename` old→`..._RETIRED_<date>`, re-sign manifest, bump manifest `version`, redeploy; verifiers pin the new `manifest.pub`/`manifest.pub2` by manifest version.
- **Succession (operator change):** new operator runs their own `keygen` for a fresh operator seed; council seed reposes only if the council itself changes.
- **Revocation of published content:** bump manifest version with the content removed; beacons/mesh nodes honor the newest signed manifest version (epoch/seq rules per `.scrolls-embodiment/README.md`); the old signature chain stays intact and auditable — history is never rewritten, superseded.

## Audit hooks

- `pqc-secrets list` shows the two seed names (names only, never values).
- Every dual-sign event MUST append a COMMS ledger `update` entry with the manifest digest (`scrolls_comms_log` does this for deploys).
- Quarterly: `pqc-secrets verify` + confirm manifest.pub/pub2 fingerprint match across deployed surfaces.
