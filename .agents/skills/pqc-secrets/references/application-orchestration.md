---
name: application-orchestration
description: Embed pqc-secrets as the runtime secrets backend of a long-running application — boot-time load, UI-driven set/unset with repack, in-memory reads, cross-platform binary dispatch, and new-machine ceremonies. Battle-tested reference implementation: local-router (2026-08-17).
---

# Application Orchestration of PQC Keys

[SKILL.md](../SKILL.md) covers the CLI, MCP tools, bundle schema, and
rotation. [agent-integration.md](agent-integration.md) covers wiring
*agent tools* (Claude Code, Hermes, VS Code, shell wrappers) to
env-injected secrets. This reference covers the third integration
mode: a **hosting application** that owns the full key lifecycle at
runtime — loading at boot, reading on every request, and
setting/unsetting from its own UI — with zero plaintext on disk.

The complete, production pattern described here ships in
**local-router** (`nbiish/local-router`, branch `develop`, 2026-08-17):
a Node/Express OpenAI-compatible LLM router that stores all provider
API keys in the PQC bundle and exposes add/remove through its `/config`
web UI.

## 1. When to use this pattern

- The application is a **long-running service** (daemon, server,
  background worker), not a one-shot CLI.
- Users must be able to **add, replace, and remove secrets while the
  app runs** (e.g. a settings page) without shell access.
- Secrets are **read on every outbound request** (per-provider API
  keys), so reads must be in-memory — no subprocess per request.
- The same codebase must run on **multiple platforms** (macOS, Linux,
  WSL, Windows) with one dispatch path.

If you only need to inject secrets into a tool's environment at
launch, use the simpler `secrets-load` pattern in agent-integration.md
instead.

## 2. Architecture

```
                    ┌──────────────────────────────────────┐
   boot             │  Application process (memory only)   │
┌──────────┐        │  ┌────────────────────────────────┐  │
│ bundle   │ export │  │ keyStore: Map<name, value>     │  │
│ (disk,   ├───────►│  │ - providerHasConfiguredKey()   │  │
│ PQC-     │        │  │ - Authorization headers        │  │
│ encrypted)        │  └───────────┬────────────────────┘  │
└──────────▲┘        │              │ set / unset (UI)      │
           │ pack    │              ▼                       │
           └─────────┤  persist: merge all keys, repack     │
                     └──────────────────────────────────────┘
   disk artifacts:   ~/.config/pqc-secrets/
                     ├── recipient.pub        (ML-KEM-768, safe to commit)
                     └── secrets.bundle.json  (AES-256-GCM + ML-KEM-768)

   Plaintext exists in exactly two places: the bundle (encrypted)
   and process memory (volatile). Never in env files, config files,
   logs, task files, or git.
```

The application holds the **entire** key set in memory and rewrites
the whole bundle on every change (`pack` replaces the bundle; there
is no incremental update). Boot loads once; every request reads the
in-memory map; every mutation triggers a full repack.

## 3. Cross-platform binary dispatch

Ship a tiny dispatch wrapper as the stable entry point; keep
platform engines behind it:

```bash
#!/usr/bin/env bash
# bin/pqc-secrets — dispatch wrapper
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(uname -s)-$(uname -m)" = "Darwin-arm64" ] \
   && [ -x "$DIR/pqc-secrets.darwin-arm64" ]; then
  exec "$DIR/pqc-secrets.darwin-arm64" "$@"
fi
exec uv run "$DIR/../.agents/skills/pqc-secrets/scripts/pqc_secrets.py" "$@"
```

Application-side locator (TypeScript, from local-router
`getPqcBinPath()`):

- Windows: probe `pqc-secrets.exe`, then the extensionless name;
  executability is PATHEXT-based, so test with `F_OK`, not `X_OK`.
- POSIX: keep the `X_OK` check.
- This is the **single place** native-binary selection lives. To
  support a new OS/arch, add its candidate name there and ship the
  binary — no other code changes.

**Timeouts:** the Python engine via `uv run` can exceed 10 s on cold
start (first-run dependency resolution). Use `timeout: 30_000` on
every `execFileSync` call. Symptom if you don't: intermittent
`ETIMEDOUT` on first key operation after install.

**Bundle isolation (optional):** pass `PQC_CONFIG_DIR` in the subprocess
env to point an app at its own bundle directory instead of the shared
`~/.config/pqc-secrets/`.

## 4. Boot: load keys (read path)

On startup, before serving traffic:

1. If `recipient.pub` is missing, optionally bootstrap with `keygen`
   (local-router's `ensurePqcKeypair()` runs it once, then loads).
2. Run `pqc-secrets export`, capture stdout via `stdio: 'pipe'`
   (**never `'inherit'`** — export output is plaintext).
3. Parse `export KEY="VALUE"` lines into the in-memory map.
4. Log **names and counts only**:

```
[PQC] Loaded 6 provider key(s) from bundle: modal-proxy, openrouter-presets, wafer-serverless, xiaomi-mimo, zai, zenmux
[PQC] Providers without keys: nebius, moonshot, nvidia-nim, ...
```

5. Missing/corrupt bundle ⇒ degrade gracefully: empty map + one
   warning line, then serve. A secrets problem must not prevent an
   otherwise-healthy app from booting.

TypeScript sketch (mirrors local-router `loadPqcSecrets()`):

```ts
const out = execFileSync(bin, ['export'], {
  encoding: 'utf8',
  timeout: 30_000,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, PQC_CONFIG_DIR: getPqcConfigDir() }
});
for (const line of out.split('\n')) {
  const m = line.match(/^export ([A-Z0-9_]+)="(.*)"$/);
  if (m) keyStore.set(m[1], m[2]);
}
console.log(`[PQC] Loaded ${keyStore.size} provider key(s) from bundle: ${[...keyStore.keys()].join(', ')}`);
```

## 5. Runtime: reading for usage

- Gate per-feature: `providerHasConfiguredKey(name)` → enable
  provider routing, model listing, etc.
- Attach the value **at the moment of the outbound call**
  (`Authorization: Bearer ${keyStore.get(envVar)}`); do not copy it
  into long-lived config objects, caches, or request logs.
- **Logging rules:** log key names, counts, and lengths — never
  values. Redact accidental captures (`********`). Central error
  handlers must not echo upstream auth headers.
- The "Providers without keys" diagnostic line doubles as operator
  UX: it tells the user exactly which settings-page entries are
  still empty.

## 6. Set / unset from the application

Mutation flow (settings UI → bundle):

1. User submits a key in the UI (value arrives over the local
   loopback UI; hold it only in the request handler).
2. Update the in-memory map (`set` for add/replace; `delete` for
   unset).
3. Immediately repack the **entire** map (local-router
   `persistPqcSecrets()`):

```ts
const lines = [...keyStore].map(([k, v]) => `${k}=${v}`);
execFileSync(bin, ['pack'], {
  input: lines.join('\n') + '\n',
  encoding: 'utf8',
  timeout: 30_000,
  stdio: ['pipe', 'ignore', 'pipe'],
  env: { ...process.env, PQC_CONFIG_DIR: getPqcConfigDir() }
});
```

4. On pack failure: keep serving with the in-memory value, log the
   error, surface it in the UI — the next successful pack reconciles
   disk with memory.
5. Unset = `delete` from map + same repack. There is no separate
   "remove" CLI op; the bundle always reflects the full current set.

Because pack is whole-bundle, concurrency rule: **serialize
mutations** (single async mutex or synchronous execFileSync is
enough) so two rapid UI saves can't interleave stale key sets.

## 7. New-machine / first-run ceremony

The 2026-08-17 local-router migration (macOS → Windows/WSL) is the
worked example:

1. `bin/pqc-secrets keygen` → creates `recipient.pub` + private key
   in the config dir.
2. Pack the initial keys **without leaving a plaintext file**:

```bash
# Preferred: no file at all
bin/pqc-secrets pack < <(printf '%s\n' 'MODAL_PROXY_API_KEY=wk-...')

# Acceptable: tmpfs-backed file, removed immediately
printf '%s\n' 'MODAL_PROXY_API_KEY=wk-...' > /tmp/pack.txt
bin/pqc-secrets pack < /tmp/pack.txt && rm /tmp/pack.txt
```

3. `bin/pqc-secrets verify` → "Bundle valid: N keys".
4. Boot the app and confirm the `[PQC] Loaded N ...` line.
5. Smoke-test one real authenticated request end-to-end (local-router
   does a chat completion through the provider) — a valid bundle that
   decrypts does not prove the *value* is correct; only a live 200
   does.

The token may transit chat/clipboard once (unavoidable at
acquisition); from then on it lives only in the bundle + memory.

### 7.1 Machine-bound KEK fragility (WSL) — 2026-08-18 incident

The Python file backend encrypts the ML-KEM private key
(`private.key.enc`) with a machine-bound KEK: HKDF-SHA256 over
`platform.node() | getpass.getuser() | platform.platform() | uuid.getnode()`.
Two of those inputs are **volatile on WSL2**:

- `platform.platform()` embeds the WSL2 kernel version — changes with
  Windows/WSL kernel updates.
- `uuid.getnode()` returns the vNIC MAC — can change across
  `wsl --shutdown` / distro restarts.

When either changes, every decrypt fails GCM authentication with
`ERROR: Failed to decrypt private key from local store` — the app logs
`[PQC] Failed to load bundle ... Falling back to environment variables`
and serves with zero provider keys. The old private key (and the bundle
encrypted to it) is **unrecoverable by design**; only a keypair
regeneration + repack restores service.

**Recovery runbook (executed 2026-08-18, local-router):**

1. Stop the app. Back up the dead artifacts (never delete — a future
   machine-tuple reconstruction could still unlock them):
   `private.key.enc.broken-<date>`, `secrets.bundle.json.undecryptable-<date>`.
2. `pqc-secrets keygen` — new keypair under the *current* machine tuple.
3. Repack every key whose value you hold (password manager), tmpfs-only:
   `printf 'KEY=val' > /tmp/pack.txt && pqc-secrets pack < /tmp/pack.txt && rm /tmp/pack.txt`.
4. `pqc-secrets verify` — confirm names.
5. Restart the app; confirm `[PQC] Loaded N ...` and the live smoke test.
6. Re-enter remaining keys via the app UI (settings page) — they repack
   on save.

**Mitigations:** on WSL, prefer `PQC_USE_KEYCHAIN=true` with a Secret
Service (gnome-keyring + secret-tool) so the private key is not
machine-tuple-bound; otherwise expect this failure after OS/kernel
updates and keep all key values in a password manager for repack.

## 8. Hygiene rules for application integrators

- **No `env:` blocks, `.env` files, or settings JSON with values** —
  see SKILL.md §1.1; the app is now the keychain front-end, so it
  must not regress to plaintext persistence "for convenience".
- Export/pack subprocess I/O: always `stdio: 'pipe'`; never log the
  captured buffer.
- Key values never appear in: app logs, crash dumps, diagnostics
  endpoints, task files, commit messages, or test fixtures. Tests
  assert names/counts, not values.
- The bundle and `recipient.pub` are safe to commit; the config dir's
  private key material is not. Keep the config dir out of backups
  that are not themselves encrypted.
- Rate-free local reads are fine (single-user threat model, SKILL.md
  §11); the audit surface for app integrations is the boot/mutation
  log lines + `pqc-secrets audit` for out-of-band events.

## 9. Testing the integration

- **Boot test:** fresh `HOME` (empty config dir) ⇒ app boots, logs
  the degrade warning, serves requests unauthenticated.
- **Load test:** fixture bundle ⇒ assert the `[PQC] Loaded N` names
  line and that gating logic enables exactly those providers.
- **Persistence test (integration):** set key via the app's API/UI →
  restart process → key still loaded (bundle round-trip). Assert the
  anchor key *names* are present in the fallback/model expectations.
- **Live smoke:** one authenticated round-trip per new provider
  (HTTP 200 + expected model in response body).

## 10. Reference implementation

`nbiish/local-router` @ `develop` (merge `9d275af`, 2026-08-17):

| Concern | Location |
|---|---|
| Dispatch wrapper | `bin/pqc-secrets` (+ `bin/pqc-secrets.darwin-arm64`) |
| Binary locator | `src/index.ts` → `getPqcBinPath()` |
| Keygen bootstrap | `src/index.ts` → `ensurePqcKeypair()` |
| Boot load | `src/index.ts` → `loadPqcSecrets()` |
| UI set/unset repack | `src/index.ts` → `persistPqcSecrets()` |
| Read gating | `src/index.ts` → `providerHasConfiguredKey()` |
| Worked task record | `.agents/tasks/TASK.2026-08-17.modal-kimi-k3.md` |

The task file records the full ceremony of §7 as executed (keygen →
tmpfs pack → verify → boot log → live chat completion), including the
WSL-specific dispatch decision (uv engine) that motivated §3.
