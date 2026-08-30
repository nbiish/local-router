# TASK 2026-08-30: v1.1.0 Release, CI Hardening, PQC Docs

## Draft
- resumed: merge landed, unpushed
- cleanup: prune worktree, delete branch
- suite green; one port flake rerun
- v1.0.0 tag exists; bump 1.1.0
- push blocked: push protection
- GOCSPX- secret in oauth-providers.ts
- base64-obfuscated, repo public
- user confirmed: public client credential
- bypass: placeholder_id, false_positive
- release re-cut three times
- lockfile missing tauri CLI entries
- fix: npm install --package-lock-only
- Windows CI: PowerShell no glob
- fix: enumerate integration tests
- desktop workflow: no contents write
- fix: permissions contents write
- Linux: libappindicator conflicts ayatana
- fix: drop conflicting package
- macOS: universal-apple-darwin not rustup
- fix: both real arch targets
- final run 33291713276: 3/3 green
- draft release: exe, msi, dmg, AppImage
- deleted legacy develop, local + remote
- moved user downloads out of repo
- reviewed ainish-coder Rust engine
- findings: SHA3 KDF vs HKDF doc
- findings: keychain-only export
- findings: bundle perms umask
- docs: RELEASING.md, SETUP.md refresh
- docs: ainish implementation guide

####

## Output

### Release v1.1.0 (tag `v1.1.0` @ `c6e5b41`…`6bfd0fa` lineage, run 33291713276)
- All three desktop platforms green; draft release holds:
  `Local.Router_1.1.0_x64-setup.exe`, `Local.Router_1.1.0_x64_en-US.msi`,
  `Local.Router_1.1.0_universal.dmg`, `Local.Router_universal.app.tar.gz`,
  AppImage/`.deb`/`.rpm`. Publish is a manual operator step.
- CI/CD Pipeline + Security Audit green on every push since lockfile fix.

### Push-protection incident (documented in RELEASING.md)
- Google OAuth client secret (`GOCSPX-`, base64-obfuscated) embedded as
  Antigravity default in `src/oauth-providers.ts:84` across 5 unpushed commits.
- Operator decision: well-known PUBLIC desktop client credential (same class
  as VS Code Copilot's embedded client), not an operator secret → bypass via
  `POST /repos/{owner}/{repo}/secret-scanning/push-protection-bypasses`
  `{placeholder_id, reason:"false_positive"}`. Operator keys still never
  touch git (PQC bundle only).

### CI fixes merged (each own worktree, all cleaned up)
- `fix/npm-lockfile-tauri-cli` — `npm ci` hard-failed; lockfile synced.
- `fix/ci-test-glob-windows` — PowerShell never expands globs; explicit list.
- `fix/desktop-release-ci` — contents write, Linux dep conflict, rustup refresh.
- `fix/macos-rust-targets` — `universal-apple-darwin` is a Tauri convention,
  not a rustup target; install aarch64 + x86_64.

### Rust engine review (ainish-coder `src/pqc-secrets`, v1.0.0, 433 lines)
- Sound: FIPS 203 double envelope, AAD domain separation, zeroization,
  version/alg checks, sorted shell-quoted export, keychain-only DK.
- Findings (review only; owner is the concurrent PQC agent):
  1. `derive_kek` = plain SHA3-256(secret‖info); SKILL.md §3 claims
     HKDF-SHA3-256 — doc/impl mismatch.
  2. `export` reads DK from macOS Keychain only; no `machine.kek` file-store
     fallback — consistent with darwin-only fast-path, worth stating in CLI help.
  3. Bundle written without explicit 0600 (umask-dependent); ciphertext so low
     risk, but posture mismatch with docs.
  4. SKILL.md §2 "Format Incompatibility" warning is stale: both engines write
     the identical double-envelope layout since 2026-08-20.

### Docs shipped (this branch)
- `RELEASING.md` — release process + push-protection policy.
- `SETUP.md` — dead `develop` refs corrected to main-only reality.
- `llms.txt` — v1.1.0 lineage row.
- ainish-coder: `references/implementation-guide.md` + SKILL.md parity fix.
