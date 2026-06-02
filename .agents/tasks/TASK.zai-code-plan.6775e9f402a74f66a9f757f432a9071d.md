# ZAI-CODE-PLAN 6775e9f402a74f66a9f757f432a9071d

- Plan ID: 6775e9f402a74f66a9f757f432a9071d.Zqm16yGPcWwNIwt4
- Active Objective: Review and fix PQC signature helper (pqc_helper.py) bugs
- Status: Completed
- PQC Flag: Pass (fixing PQC implementation only; no classical crypto introduced)

## Review Findings

### Bug 1: verify_file dead code path (Critical) — FIXED
- Location: `.agents/skills/pqc-signatures-security/scripts/pqc_helper.py`, `verify_file()` function
- Issue: `run_command()` used `check=True`, so OpenSSL verification failure (exit code 1) raised `CalledProcessError` BEFORE the stdout check
- Fix: Changed to `check=False` and inspect `result.returncode` directly; distinguish exit code 1 (signature mismatch) from other errors

### Bug 2: Misleading error message (Medium) — FIXED
- Location: `verify_file()` except block
- Issue: Said "Verification FAILED (Command Error)" for BOTH genuine verification failures AND command execution errors
- Fix: Three distinct paths: (1) signature mismatch (exit=1), (2) unexpected error (exit≠0,1), (3) command not found

### Issue 3: External SKILL.md symlink (Medium) — FIXED
- Location: `.agents/skills/pqc-signatures-security/SKILL.md`
- Issue: Symlinked to `/Users/nbiish/code/ainish-coder/...` — breaks in worktrees or other machines
- Fix: Replaced symlink with actual file content

### Issue 4: No subprocess timeout (Low) — FIXED
- Location: `run_command()`
- Issue: No timeout on subprocess calls; hung openssl could block indefinitely
- Fix: Added `timeout` parameter with DEFAULT_TIMEOUT=30s; catches `TimeoutExpired`

## Verification Results

All seven test paths passed:
1. keygen: ✓
2. sign: ✓
3. verify (valid): ✓ Verified
4. verify (tampered): ✗ Verification FAILED: signature mismatch (was: "Command Error")
5. verify (missing file): ERROR: Target file not found
6. verify (missing sig): ERROR: Signature file not found
7. verify (missing pubkey): ERROR: Public key not found
