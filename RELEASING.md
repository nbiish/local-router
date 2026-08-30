# Releasing Local Router

Release flow: worktree → verify → merge to `main` → tag → CI builds → publish
draft. `main` is the only permanent branch; never commit to it directly.

---

## 1. Version bump (4 files)

| File | Field |
|---|---|
| `package.json` | `version` |
| `src-tauri/tauri.conf.json` | `version` (drives installer + tag name in CI) |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/Cargo.lock` | `local-router` package entry (must match Cargo.toml) |

Rules:
- Tags are immutable once on origin — check `git ls-remote --tags origin`
  before choosing one. Moving a tag requires deleting it on origin first and
  is only acceptable while the release is still an unpublished draft.
- `tauri.conf.json`'s version is what `desktop-release.yml`'s
  `tagName: v__VERSION__` resolves to; the git tag must match it.

## 2. Gates before tag

```bash
npm ci            # must work with NO fallback — Security Audit runs it plain
npm test          # 112 tests, serial
npm run build     # tsc
```

- `package-lock.json` must be in sync with `package.json`. CI workflows use
  `npm ci || npm install` fallbacks, but `security-audit.yml` does not — a
  stale lockfile fails the audit. Sync with `npm install --package-lock-only`.
- Never rely on shell globs in npm scripts: PowerShell (windows-latest CI legs)
  does not expand `tests/*.integration.test.mjs`. Enumerate test files
  explicitly in `test:integration`.

## 3. Tag → CI → draft release

```bash
git tag -a vX.Y.Z -m "Local Router vX.Y.Z — <summary>"
git push origin main vX.Y.Z
```

Pushing a `v*` tag triggers `.github/workflows/desktop-release.yml`:

| Platform | Runner | Artifacts |
|---|---|---|
| Windows x64 | windows-latest | NSIS `-setup.exe`, `.msi` |
| macOS universal | macos-latest | `.dmg`, `.app.tar.gz` |
| Linux x64 | ubuntu-22.04 | AppImage, `.deb`, `.rpm` |

Everything lands in a **draft** GitHub release; nothing is public until an
operator publishes it.

Platform gotchas (all three bit us on v1.1.0):
- The workflow needs `permissions: contents: write` or tauri-action cannot
  create the release (`Resource not accessible by integration`) — *after* a
  successful multi-minute build.
- `libappindicator3-dev` conflicts with `libayatana-appindicator3-dev` on
  ubuntu-22.04; install only the ayatana package.
- `universal-apple-darwin` is a Tauri fat-binary convention, **not** a rustup
  target. Install `aarch64-apple-darwin` + `x86_64-apple-darwin`; tauri
  builds both and merges with lipo.

## 4. Push protection & secrets policy

Two different classes of credential; never conflate them:

1. **Operator secrets** (provider API keys, tokens) live **only** in the PQC
   bundle (`~/.config/pqc-secrets/secrets.bundle.json`, ML-KEM-768 +
   AES-256-GCM). They never appear in git, `.env`, or config files. If push
   protection blocks on one of these, the fix is to REMOVE it — purge from
   history and rotate the value. Do not bypass.
2. **Well-known public client credentials** (e.g. Google's publicly
   distributed Antigravity desktop client ID/secret; the VS Code Copilot
   client) are public-by-design inputs to native OAuth flows. Embedding them
   as defaults is acceptable and is how drop-in login works. GitHub's scanner
   still flags the patterns; resolve via the documented bypass:

   ```bash
   gh api -X POST repos/nbiish/local-router/secret-scanning/push-protection-bypasses \
     -f placeholder_id="<id from the unblock URL>" -f reason="false_positive"
   ```

   The bypass expires (~24h). Base64-obfuscation does NOT evade the scanner
   (it decodes), so don't bother.

Incident history: v1.1.0 (2026-08-30) — Antigravity client secret blocked
`main` + tag across 5 commits; bypassed as false positive per operator
decision. See `.agents/tasks/TASK.2026-08-30.v1.1.0-release-and-pqc-docs.md`.

## 5. Publish

Draft → review assets (exe, msi, dmg, AppImage, deb, rpm all present) → hit
**Publish release** on GitHub. Then announce/change-log as needed.
