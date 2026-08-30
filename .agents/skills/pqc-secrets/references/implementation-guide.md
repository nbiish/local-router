---
name: implementation-guide
description: Step-by-step guide to implementing the PQC secrets system in a new repo, CLI, or application — adoption checklist, engine selection, consumption patterns in every language, namespace discipline, boot-load integration, and verification receipts. Reference implementation local-router.
---

# Implementing the PQC Secrets System

How to adopt this system in a **new repo, CLI tool, daemon, or GUI app**.
Read this top-to-bottom once; afterwards the sibling references are the
deep-dive material. The reference production implementation is
**local-router** (Express/TypeScript proxy + Tauri desktop app), which
exercises every pattern in this guide.

---

## 0. The one-paragraph model

One encrypted bundle per machine at `~/.config/pqc-secrets/secrets.bundle.json`
(ML-KEM-768 key encapsulation + AES-256-GCM payload, FIPS 203/SP 800-38D) is
the **single source of truth** for every API key of every project on that
machine. The private key is wrapped by a stable per-machine KEK and never
leaves the machine. Applications never see plaintext at rest — they load keys
into process memory at boot (or lazily) by running `pqc-secrets export` and
reading environment variables. Nothing plaintext ever hits disk: no `.env`,
no settings `env` blocks, no committed values.

Deep dives: `cross-repo-key-sharing.md` (one bundle, many repos),
`kek-persistence.md` (why the wrapping key survives reboots),
`application-orchestration.md` (app-owned key lifecycle),
`bundle-schema.md` (wire format), `rotation-procedure.md` (DR runbook).

---

## 1. Adoption checklist (six steps)

1. **Ship the CLI entry point.** Copy or symlink `bin/pqc-secrets` into your
   repo (it dispatches to the canonical Python engine and, on darwin/arm64,
   the Rust fast-path binary). Apps that cannot shell out read the bundle
   format directly (see §4) — but the CLI is the universal interface.
2. **Keygen once per machine** (`pqc-secrets keygen`). Produces
   `recipient.pub` (commit-safe) and the KEK-wrapped private key. Do this at
   setup/install time; see `agent-integration.md` for the bootstrap UX
   (`uv` missing → one-liner install; no bundle → keygen → pack → list).
3. **Consume, don't store.** At boot or first use: `eval "$(pqc-secrets
   export)"` (shell) or spawn-and-parse (app, §4). Your tool reads
   `process.env` / `os.environ` / `std::env::var` — nothing else.
4. **Namespace your keys.** Use a strict prefix: `<TOOL>_<KEY_ENV_VAR>`
   (local-router uses `LOCALROUTER_`). A strict namespace lets your tool
   share one bundle with every other tool without colliding, and makes
   bundle listings auditable at a glance (`pqc-secrets list` prints names
   only).
5. **Enforce the zero-plaintext invariants** (§6). CI-check them if you can:
   `gitleaks`/`detect-secrets` in the pipeline, and never generate `.env`
   files in code.
6. **Verify.** Ship a verify path: `pqc-secrets verify` (bundle decrypts,
   names only) plus a tool-level check (local-router prints
   `[PQC] Loaded N provider key(s) from bundle` at boot and reports
   `configuredSource: 'pqc'` per key in its provider API).

---

## 2. Engine selection

| Engine | Path | Commands | When |
|---|---|---|---|
| **Python (canonical)** | `uv run .agents/skills/pqc-secrets/scripts/pqc_secrets.py` | keygen, pack, export, verify, list, rename, migrate, setup, version | Default everywhere; newest `cryptography>=45` native ML-KEM-768; FIPS 203 seed-form keygens; vault read-side parity (ML-KEM identity) |
| **Rust fast-path** | `bin/pqc-secrets.darwin-arm64` (source `src/pqc-secrets/`, RustCrypto `ml-kem`/`ml-dsa`) | keygen, pack, export, issue, envelope, vault | darwin/arm64 speed path; v1.2.0 (2026-08-30) — vault-first issuance + tamper evidence |

Both write the **identical double-envelope bundle JSON** (verified parity
2026-08-30): ML-KEM-768 encapsulates a shared secret → SHA3-derived KEK
wraps a random 32-byte data key (AES-256-GCM keywrap, AAD
`pqc-secrets:v1:keywrap`) → the data key encrypts the payload (AAD
`pqc-secrets:v1:data`). Pre-parity bundles error with
`missing field aad`; migrate once (export → keygen → pack).

Engine status (Rust v1.2.0, 2026-08-30):
- **Vault-first by default.** With `~/.config/pqc-secrets/vault.pqc` present,
  `export`/`issue`/`envelope` run through the vault identity (Argon2id-wrapped
  ML-KEM-768 + ML-DSA-65 seeds, 0600) — the OS keychain is not touched.
  `--use-keychain` (or no vault) keeps the legacy keychain paths. `keygen`
  refuses when a vault exists; `vault init` is the one-time setup.
- **Atomic, mode-safe writes.** Vault-path bundle writes are tmp + fsync +
  rename at mode 0600 (no umask dependence); every vault-identity operation
  appends a hash-chained ML-DSA-65-signed audit record, and issuance signs the
  exact on-disk bytes into a `<bundle>.sig` sidecar. Agents review integrity
  via `vault verify` / `vault audit-verify` — fingerprints and digests only,
  never values.
- KDF is plain `SHA3-256(shared_secret ‖ info)`, not HKDF — acceptable for a
  single-recipient KEM secret (uniform, domain-separated) but update SKILL.md
  §3 if you tighten this to HKDF-SHA3-256.
- The Rust binary remains darwin/arm64-only; the canonical Python engine
  covers every platform (macOS, Linux, WSL/Windows) with vault read-side
  parity.

---

## 3. Consumption patterns

### Shell (CLI tools, wrappers, scripts)

```bash
# on-demand, into the current shell only
eval "$(pqc-secrets export)"
my-tool --api-key "$MYTOOL_API_KEY"
```

Wrap tools so keys never persist (`SKILL.md` §5 Pattern 4 for the
temp-config + trap variant).

### Node.js / TypeScript (boot load)

```ts
import { execFileSync } from "node:child_process";

export function loadKeysFromEnvironment(): void {
  // Direct binary invocation (uv run pqc_secrets.py export) avoids
  // Windows spawnSync EINVAL issues with shell wrappers; parse both
  // LF and CRLF export lines.
  const out = execFileSync(uvPath, ["run", ENGINE, "export"], {
    timeout: 30_000, windowsHide: true,
  }).toString();
  for (const line of out.split(/\r?\n/)) {
    const m = /^export (\w+)=(.*)$/.exec(line);
    if (m) process.env[m[1]] = m[2]; // memory only, never written
  }
}
```

This is (a close cousin of) local-router's `loadPqcSecrets()` /
`execPqcBin()` path — see §4.

### Python

```python
import os, subprocess
out = subprocess.run(
    ["uv", "run", ".agents/skills/pqc-secrets/scripts/pqc_secrets.py", "export"],
    capture_output=True, text=True, timeout=30, shell=False, check=True,
).stdout
for line in out.splitlines():
    if line.startswith("export "):
        k, _, v = line[7:].partition("=")
        os.environ[k] = v.strip("'")  # prefer shlex for full quoting
```

### Rust

```rust
let out = std::process::Command::new("uv")
    .args(["run", ".agents/skills/pqc-secrets/scripts/pqc_secrets.py", "export"])
    .output()?;
for line in String::from_utf8_lossy(&out.stdout).lines() {
    if let Some(rest) = line.strip_prefix("export ") {
        if let Some((k, v)) = rest.split_once('=') {
            std::env::set_var(k, v.trim_matches('\''));
        }
    }
}
```

---

## 4. When the app owns the key lifecycle (local-router pattern)

For apps with a settings UI (GUI/TUI) where users paste keys, go beyond
read-only consumption:

- **Boot:** load the bundle into process env (§3). Log the count, not names'
  values: `[PQC] Loaded N provider key(s) from bundle`.
- **Save:** when the user adds/edits a key, export current values → merge →
  `pqc-secrets pack` **merge-safe**: refresh only your namespace's entries
  and preserve every other name in the bundle (other tools' keys live there
  too — never drop them).
- **Key resolution order:** PQC bundle → environment variables → in-memory
  (saved this session). Document it; make every lookup's source visible
  (`configuredSource: 'pqc'` in local-router's provider API).
- **Resync endpoint:** provide a way to re-run bundle sync without restart
  (local-router: `POST /api/pqc-resync` `{force:boolean}`, throttled) so keys
  packed by other tools appear live.
- **Windows:** invoke the engine as `uv run pqc_secrets.py` directly
  (`execFileSync`-style), never through `.cmd`/`.bat` wrappers (spawnSync
  EINVAL), and parse CRLF-tolerantly.
- Full walk-through: `application-orchestration.md`. Production code:
  local-router `src/` (`loadPqcSecrets`, `persistPqcSecrets`,
  `getPqcConfigDir`, `reportMissingProviders`).

---

## 5. Namespace & bundle hygiene

- Prefix every key your tool owns: `LOCALROUTER_WAFER_SERVERLESS_API_KEY`,
  not `WAFER_SERVERLESS_API_KEY`. Plain names are invisible to a
  namespace-strict tool — and that is by design: shared bundles stay safe
  when every consumer filters by its own prefix.
- `pqc-secrets rename OLD NEW` fixes naming mistakes in place (value kept,
  bundle backed up first).
- `pack` **replaces** the whole bundle. Always merge in memory first
  (`export` → mutate → `pack`), or use a namespace-scoped writer.
- Device keys: prefer `pqc-secrets issue wtf <name>` — vault-first issuance is
  the merge-safe writer (opens the existing bundle in memory, preserves every
  unrelated entry, refuses key collisions without `--force`, and leaves a
  signed sidecar + audit record).
- `recipient.pub` is the only bundle-related file that may be committed.

---

## 6. Invariants (what must never happen)

1. No plaintext key on disk — no `.env`, no settings `env` blocks, no logs,
   no task files. (SKILL.md §1.1 has the agent-trap examples.)
2. No operator secret in git — ever. Push protection blocking a commit with
   a real operator key means REMOVE + ROTATE, not bypass. (Public-by-design
   OAuth client credentials are a separate class — see local-router
   `RELEASING.md` §4 for the policy and the bypass procedure.)
3. No cross-machine copying of `secrets.bundle.json` / `private.key.enc` /
   `machine.kek` — bundles are machine-local by keypair. New machine =
   fresh `keygen` + re-pack from each key's origin.
4. No plaintext through subprocess argv where avoidable — pass via stdin
   (`pack`) and read via stdout (`export`).
5. Never log exported values; fingerprint at most (SHA3-256 first 16 hex,
   like the audit log does).

---

## 7. Verification receipts

Prove the integration works, every time:

```bash
pqc-secrets verify          # bundle decrypts; prints names only
pqc-secrets list | grep '^MYTOOL_'   # your namespace, no values
eval "$(pqc-secrets export)" && [ -n "$MYTOOL_API_KEY" ] && echo ok
```

App-level: boot log shows the loaded-key count; a health/verify subcommand
reports bundle-backed sources. local-router: `localrouter verify --json` →
`ok: true` plus the `[PQC] Loaded N provider key(s)` boot line.

---

## 8. Reference implementations

| Project | What it demonstrates |
|---|---|
| **local-router** | Full app-owned lifecycle: boot load, strict namespace, UI save→merge-safe pack, resync API, Windows direct-uv dispatch, cross-platform install wiring |
| **ainish-coder** | This skill; the CLI; the Rust fast-path engine (`src/pqc-secrets`) |
| **betterbrowsermcp** | MCP tool surface over the same bundle (`references/mcp-tool-surface.md`), audit log (`references/audit-log.md`) |
