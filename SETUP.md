# Local Router — Final Environment Setup

Date: 2026-08-26
Repo: `local-router`
Branch (doc source of truth): `develop` @ `961b1a1`
Daemon: running on `http://localhost:11434` (Ollama backend `:11435`, dual-stack loopback)

This document records the machine-local configuration required to run Local
Router with full provider coverage, plus the verification smoke test. **No
secret values are stored here** — keys are referenced by name only and live
encrypted in the PQC bundle.

> All config described below is **machine-local and intentionally untracked**. It
> lives under `~/.config/pqc-secrets/` (and optionally `~/config/`). None of it
> belongs in git; keys are never committed.

---

## 1. Runtime state (verified)

- Branch: `develop`, commit `961b1a1`
- Build: `npm install && npm run build` (`tsc`) — clean
- Daemon PID `29826` via `local-router start`
- PQC load (server log): `[PQC] Loaded 16 provider key(s) from bundle`
  - cline, commandcode, kilo, modal, moonshot, nebius, nous-portal, nvidia-nim,
    opencode-go, opencode-zen, openrouter, pioneer, wafer-serverless,
    xiaomi-mimo, zai, zenmux
- `modal-proxy` is the only provider without a key (expects
  `LOCALROUTER_MODAL_PROXY_API_KEY`, not present in the bundle).

## 2. PQC secrets layout

Live store at `~/.config/pqc-secrets/` (all 0600):

| File | Purpose |
|---|---|
| `secrets.bundle.json` | Encrypted API keys (AES-256-GCM payload wrapped with ML-KEM-768) |
| `recipient.pub` | ML-KEM-768 public key |
| `private.key.enc` | ML-KEM-768 private key, AES-256-GCM encrypted under `machine.kek` |
| `machine.kek` | 0600 per-machine key-encryption key (stable across reboots) |

`pqc-secrets list` returns 19 names: 16 `LOCALROUTER_*` provider keys plus three
`MODAL_PROXY_TOKEN*` entries that belong to a separate tool and are correctly
ignored by the router.

## 3. Key namespace requirement

Local Router reads **only** `LOCALROUTER_<KEY_ENV_VAR>` names in the bundle,
in-process env, and UI saves (strict namespace, documented in `llms.txt`).
Plainly-named entries are invisible to it.

The 16 provider keys were renamed from plain names (e.g. `KILO_API_KEY`) to the
`LOCALROUTER_` prefix with `bin/pqc-secrets rename <OLD> <NEW>` (value kept,
bundle auto-backed up per rename).

## 4. PQC load-path fix (root cause)

The server spawns the bundle export with the **file-store backend**, not the OS
keychain. The default store at `~/.config/pqc-secrets` must therefore contain
both a decryptable `private.key.enc` and its `machine.kek`. Two issues were hit:

1. **Private key only in macOS Keychain.** The key lived solely in the Keychain
   (`PQC_USE_KEYCHAIN=true`); the server forces `false`, so export failed with
   *"Private key not found in keychain or file"*. Fix: mirrored the existing
   Keychain key into the default file store via the engine's own audited
   functions (`machine.kek` + `private.key.enc`), leaving the bundle untouched.
   No plaintext was ever written to disk.
2. **Stale legacy config dir shadowing the live store.** The server's
   legacy-compat resolution prefers `~/config/pqc-secrets` (no dot) over
   `~/.config/pqc-secrets`. A stale June 9 store there (with a mismatched,
   unrecoverable private key) caused `Failed to decrypt private key from local
   store`. Fix: moved it to `~/config/pqc-secrets.stale-20260826` so resolution
   falls through to the live store. This is reversible; the old key is
   cryptographically unrecoverable and was not repaired.

## 5. Verified smoke test

All against `http://localhost:11434`:

- `GET /` → `Ollama is running`
- `GET /api/version` → `0.31.1`
- `GET /api/ps` → `{"models":[]}`
- `GET /v1/models` → 783 served models
- `localrouter verify --json` → `ok: true`
  - version `0.31.1`; catalog-custom `1511 models`; catalog-all `1511 models`
    (cache `1855`); fallback-routes `1 route(s)`
- End-to-end routing: `POST /v1/chat/completions` on
  `local-router/fallback-models` → `finish=stop`, `content="PONGO"` (resolved
  to `nemotron-3-ultra` via the fallback chain)

`catalog-custom` (1511) being lower than `catalog-all` cache (1855) is expected:
curation is active, so the served catalog reflects the toggled-on serving set.

## 6. Notes / follow-ups

- `git status` is clean. The configuration changes are non-repo (PQC bundle,
  `machine.kek`, `private.key.enc`, stale-dir move) and remain untracked by
  design.
- The engine prints a cosmetic `legacy expanded-form ML-KEM private key` hint;
  the key reads fine via the kyber-py fallback. Rotating to native seed form
  would require re-packing all values and is not required.
- To re-read keys after packing outside Local Router: `POST /api/pqc-resync`
  (`{force:true}`) or restart.
