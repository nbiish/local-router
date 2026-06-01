---
name: pqc-secrets-node-integration
description: Integrate ML-KEM-768 + AES-256-GCM key persistence into a Node.js server via a Python UV inline script
source: auto-skill
extracted_at: '2026-05-30T00:47:23.478Z'
---

# PQC Secrets Integration for Node.js Servers

Integrate ML-KEM-768 + AES-256-GCM API key persistence into a Node.js/Express server using a companion Python UV inline script.

## Architecture

```
macOS Keychain              ~/.config/pqc-secrets/
(ML-KEM-768 private key)    secrets.bundle.json (AES-256-GCM encrypted)
        │                           │
        ▼                           ▼
  pqc_secrets.py (UV script)  ←──  bin/pqc-secrets (shell wrapper)
        │
        ▼
  Node.js server: loadPqcSecrets() / persistPqcSecrets()
```

## Step 1: Create the Python UV Script

Create `scripts/pqc_secrets.py` with inline dependency metadata:

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "kyber-py>=0.2.0",
#     "cryptography>=44.0",
# ]
# ///
```

**Critical API gotcha:** `ML_KEM_768` is a **singleton instance**, not a class. Use `ML_KEM_768.keygen()` not `ML_KEM_768().keygen()`.

**Encaps return order:** `encaps(pk)` returns `(shared_secret, ciphertext)` — shared_secret is 32 bytes (the AES key), ciphertext is 1088 bytes (the wrapped key to store). Do NOT swap these — decaps will fail with "Expected 1088 bytes and obtained 32".

**Key commands to implement:**
- `keygen` — generate keypair, store private key in macOS Keychain via `security add-generic-password`
- `pack` — read `KEY=VALUE` lines from stdin, encaps shared_secret via ML-KEM-768, encrypt with AES-256-GCM, write `secrets.bundle.json`
- `export` — decaps via Keychain, decrypt, output `export KEY=VALUE` lines
- `verify` — same as export but only print key names, no values

**Bundle format:**
```json
{
  "version": 1,
  "kem": { "algorithm": "ML-KEM-768", "ciphertext": "<1088-byte hex>" },
  "data": { "algorithm": "AES-256-GCM", "nonce": "<12-byte hex>", "ciphertext": "<hex>" }
}
```

## Step 2: Create the Shell Wrapper

`bin/pqc-secrets` resolves the script relative to the project root and delegates via `uv run`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PQC_SCRIPT="${PROJECT_ROOT}/.agents/skills/pqc-secrets/scripts/pqc_secrets.py"
exec uv run "$PQC_SCRIPT" "$@"
```

## Step 3: Integrate into Node.js Server

### 3a. Resolve the binary path

Use `process.cwd()` and `__dirname` as fallback candidates. Check `X_OK` with `fs.accessSync`:

```typescript
function getPqcBinPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'bin', 'pqc-secrets'),
    path.resolve(process.cwd(), 'bin', 'pqc-secrets'),
  ];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    catch (_) { /* not found */ }
  }
  return '';
}
```

### 3b. Load secrets at startup

Call `execFileSync` with the `export` command, parse `export KEY=VALUE` lines, map env vars back to provider names:

```typescript
function loadPqcSecrets(): void {
  const bin = getPqcBinPath();
  if (!bin) return;
  const output = execFileSync(bin, ['export'], { encoding: 'utf8', timeout: 10000 });
  for (const line of output.split('\n')) {
    const match = line.match(/^export\s+(\w+)=(.+)$/);
    if (!match) continue;
    process.env[match[1]] = match[2];
    const provider = findProviderByEnvVar(match[1]);
    if (provider) keyStore[provider.name] = match[2];
  }
}
```

### 3c. Persist on save/delete

Collect all in-memory keys, pipe as `KEY=VALUE\n` lines to `pack` via `execFileSync` with `input`:

```typescript
function persistPqcSecrets(): void {
  const bin = getPqcBinPath();
  if (!bin) return;
  const lines = Object.entries(keyStore)
    .filter(([_, v]) => v)
    .map(([name, val]) => `${getProviderSummary(name)!.keyEnvVar}=${val}`);
  if (!lines.length) return;
  execFileSync(bin, ['pack'], { input: lines.join('\n') + '\n', encoding: 'utf8', timeout: 10000 });
}
```

### 3d. Wire into routes

- Call `loadPqcSecrets()` before `app.listen()` (after other in-memory stores load)
- Call `persistPqcSecrets()` after `keyStore[providerName] = keyValue` in `POST /api/keys`
- Call `persistPqcSecrets()` after `delete keyStore[providerName]` in `DELETE /api/keys/:provider`

## Environment

- `uv` must be installed (`pip install uv` or Homebrew)
- `kyber-py` and `cryptography` auto-resolved by `uv run` from inline metadata
- macOS Keychain used for private key storage (T2/M-series hardware-backed)
- Graceful degradation: if `bin/pqc-secrets` not found or bundle doesn't exist, server still works with in-memory-only keys
- Set `LOCAL_ROUTER_DEV=true` for diagnostic log lines
