# Releasing Local Router

Release flow: worktree → verify → merge to `main` → tag → CI builds, publishes, verifies the
updater manifest and promotes it to `production`. `main` is the only permanent branch; never commit to it directly.

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

## 3. Tag → CI → published release → production

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

The release is **published** by the workflow (`releaseDraft: false`). After the last platform
uploads, the `promote` job checks the release's `latest.json`: its version equals the tag, and
`darwin-aarch64`, `darwin-x86_64`, `windows-x86_64` and `linux-x86_64` each name an asset on that
release with a signature. It then calls `promote-website-release.yml`, which fast-forwards
`production` to the tagged commit and dispatches `nbiish/local-router-dot-com` to republish
`https://local-router.com/updates/latest.json`. An incomplete manifest fails the job before anything
is promoted.

The `release: published` trigger on `promote-website-release.yml` never fires for these releases:
GitHub does not start a workflow from an event raised by a workflow's own `GITHUB_TOKEN`. If a run
stops before promotion, repeat it by hand:

```sh
gh workflow run promote-website-release.yml -f tag=vX.Y.Z
```

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

## 5. After the release

Publishing is automatic. Review the published release: every installer and its `.sig` present,
`production` at the tagged commit, and `https://local-router.com/updates/latest.json` reporting
the new version. Then announce/change-log as needed.

## 6. Self-update manifest (desktop app auto-update)

The updater consumes a *signed archive*, not the raw `.app`. `tauri build` emits the
`.app.tar.gz` + `.sig` only when ALL of these hold (learned on v1.2.0's first cut —
without item 1 the build ships with no update artifacts at all):

1. `bundle.createUpdaterArtifacts: true` in `src-tauri/tauri.conf.json`.
2. `plugins.updater.endpoints` + `plugins.updater.pubkey` (minisign pubkey, base64).
3. Signing env at build time: `TAURI_SIGNING_PRIVATE_KEY` = the key FILE CONTENTS
   (e.g. `export TAURI_SIGNING_PRIVATE_KEY=*** ~/.config/local-router/tauri-updater.key)"`)
   and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (may be empty). Note: the CLI reads
   `TAURI_SIGNING_PRIVATE_KEY` — there is no `_PATH` variant; a wrong name fails with
   "A public key has been found, but no private key" AFTER the archive is built.

The desktop app checks `https://local-router.com/updates/latest.json` on startup
(20s delay), from the tray **Check for Updates** item and from the dashboard's **Check for
updates** control. Updates are minisign-verified against the public key embedded in
`src-tauri/tauri.conf.json` (`plugins.updater.pubkey`) — unsigned or tampered updates are rejected.

The dashboard is served by the router (`http://127.0.0.1:11434`), which is a remote origin for
IPC. It may call the app's updater commands only because
`src-tauri/capabilities/dashboard-updater.json` grants `allow-check-updates`,
`allow-update-status` and `allow-install-update` to that origin, and `src-tauri/build.rs` declares
those commands so the permissions are generated. A new command the dashboard should reach needs
both; without them its button fails with "Update check failed."

Release steps:

1. **Sign the updater artifacts** — CI does this on every tag: `desktop-release.yml` runs
   `tauri build` with `TAURI_SIGNING_PRIVATE_KEY` (the key contents; there is no `_PATH`
   variant) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (the key has no passphrase, so empty is
   correct). The private key is operator-owned and must be injected from the pqc-secrets vault
   at build time; never commit it, never paste it into chat. If the key is ever lost, updates
   must ship with a new keypair (bump `pubkey`, document it).

2. **Build the manifest** — `tauri-action` merges each platform into the release's
   `latest.json` and uploads it with the `.sig` files. To rebuild one by hand:

   ```sh
   node scripts/make-update-manifest.mjs \
     --version 1.2.1 --notes "<changelog>" \
     --platform darwin-aarch64=<url-of-.app.tar.gz>=<path-to-.sig> \
     --platform windows-x86_64=<url-of-installer>=<sig> \
     --out latest.json
   ```

3. **Publish the manifest** — promotion copies the release's `latest.json` asset into the
   `local-router-dot-com` repo at `public/updates/latest.json` and deploys its `production`
   branch. By hand: `gh workflow run promote-website-release.yml -f tag=vX.Y.Z`.

4. **Verify** — `node scripts/verify-updater-manifest.mjs vX.Y.Z` passes against the release and
   `https://local-router.com/updates/latest.json` reports the new version. Then launch the
   previous version's app: the tray item or the dashboard control offers the update; install it;
   the app restarts on the new version (window title / `--version` reflects the bump).
