# Scroll v2 Integrity Layer — Build Spec (delegation brief)

Author: Main orchestrator, 2026-08-29. Parents: research/07-integration-contract.md (binding), research/05-scroll-architecture.md (v2 pipeline spec), TASK file.

## Goal
Implement contract sections C2 (integrity), C3 (manifest), C4 (pipeline states) as production shell + Python, integrated with the existing scrolls gate and COMMS ledger protocol.

## Files to create (in worktree <worktree>)
1. `scripts/scrolls/scroll_manifest.py` — Python engine (stdlib-only + `cryptography` via uv for signing ops).
   - `manifest <dir> [--out manifest.json]`: walk payload dir (default `.` = invocation dir; use `--include manifest.json` semantics: output file itself excluded from files[]), emit manifest.json per contract C3 schema: {version, author, timestamp (ISO-8601), source_commit (git rev-parse HEAD of the CWD repo; empty string if not a repo), files:[{path, sha3_256, bytes}], carriers:[], boundary:"public-teachings-only"}. Deterministic JSON (sorted keys, indent 2, trailing newline). Refuse if dir contains a `manifest.sig`/`manifest.sig2` stale sig mismatch? No — regenerate freely; sigs are regenerated at sign step.
   - `sign <dir> [--council]`: compute manifest if missing, then SHA3-256 digest of manifest.json BYTES; derive MLDSA65 key via `mldsa.MLDSA65PrivateKey.from_seed_bytes(seed32)`; sign digest (pure ML-DSA, cryptography>=46); write detached `.scrolls/manifest.sig` (base64) + public key `.scrolls/manifest.pub` (base64 raw public bytes). `--council` writes additionally `manifest.sig2` (council seed `AINISHCODER_SCROLL_COUNCIL_SEED`). Seeds: read env `AINISHCODER_SCROLL_SIGN_SEED` (hex 64 chars = 32 bytes). If unset: error with exact instruction to load from PQC bundle via `pqc-secrets export` (bin/pqc-secrets) — never generate silently.
   - `verify <dir> [--council]`: recompute per-file SHA3-256 vs manifest; then digest manifest bytes; verify 1 sig (required) + sig2 (if present or --council: required 2). Exit 0/1 with explicit per-failure reason lines. **Tamper defense: if manifest bytes changed after signing, sig verification fails — recompute digest at verify time from the manifest.json ON DISK (never trust a stored digest field).**
   - Deterministic manifest: files[] sorted by path; sha3 over file BYTES; no dict ordering drift.
   - Self-test mode: `selftest` — full sign→verify→tamper-fail→untamper-verify cycle in a temp dir (exit 0/1). Used by smoke tests.
   - Style: ruff-clean (line-length 100), type hints, no shell-outs except `git rev-parse`.
2. `src/scroll_integrity.sh` — sourced from bin/ainish-coder next to deploy_scrolls.sh. Functions:
   - `scrolls_manifest <dir>` — wraps python engine manifest cmd.
   - `scrolls_sign <dir> [--council]` — wraps sign; echoes digest.
   - `scrolls_verify <dir>` — returns 0/1; prints first failure.
   - `scrolls_comms_log <event> <detail>` — appends protocol block to AGENTS/{date}.COMMS.md (worktree path if present) AND live board AGENTS/{date}.COMMS.live.md (main repo path; gitignored; tolerate absence) with start:/end: pairs, scope=.scrolls/, manifest digest; follow AGENTS/2026-08-29.COMMS.md protocol format exactly.
3. `bin/ainish-coder` — add `--scrolls-manifest`, `--scrolls-sign [--council]`, `--scrolls-verify` subcommands (same arg pattern as --scrolls: take `target_dir`); wire into help.sh options list. Gate rules: sign/verify work non-interactive; deploy keeps its existing interactive-only gate and now runs `scrolls_verify` first; on verify fail: refuse deploy (interactive: offer re-sign prompt; non-interactive: hard exit).
4. `src/help.sh` — document new subcommands.
5. `AGENTS.md` — extend COMMS section: scroll deploy lifecycle events `intent-deploy`/`deployed`/`deploy-failed` (one line, pointing to scroll_integrity.sh as the implementation). Also add `.scrolls-embodiment/` to the worktree-gate note? NO — embodiment dir is payload-side, not workflow. Keep AGENTS.md diff minimal.
6. `research/07-integration-contract.md` — C9 gates updated only if implementation deviates (should not).

## Hard rules
- NO new crypto primitives; ML-DSA-65 pure only (verified: cryptography 50.0.1 mldsa module). No secrets in code; seeds come from env only; error messages MUST NOT echo seed values.
- Do NOT read/modify .scrolls/ payload content (metadata-only). The manifest tool hashes files it is pointed at — that is mechanical, but do NOT cat/open payload in your analysis; use the Python walker.
- Do NOT modify src/deploy_scrolls.sh copy mechanics; only gate it behind verify.
- All work in the worktree; no commits to main; no formatter/linter runs beyond `ruff check scripts/scrolls/scroll_manifest.py` + `ruff format --check` on the new file.
- Commit message prefix: `feat(integrity):` — atomic commits per file group.

## Acceptance (C9)
- `selftest` passes: sign→verify ok; tamper file → verify fail (explicit reason); untamper → pass; tamper manifest → sig fail; --council dual path ok.
- `--scrolls` deploy path refuses tampered payload (verify-first gate active); non-interactive deploy still blocked as today.
- COMMS entries appear in both ledger files with correct protocol format.
- ruff clean on new Python; shellcheck not available — keep bash strict-mode compatible (`set -euo pipefail` style consistent with sibling scripts).
