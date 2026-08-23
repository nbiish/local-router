# Local Router

One localhost port. Every model.

Local Router is a local Ollama-compatible and OpenAI-compatible model router for VS Code, Copilot Chat, Continue, Cline, Roo Code, and any AI tool that can point at `localhost`.

It runs on Ollama's default port, exposes OpenAI-compatible and Ollama-compatible endpoints, and routes requests to your configured provider models, fallback chains, or local router models.

## Vision

Local Router is an Ollama-compatible drop-in replacement proxy with open routing logic. The goal is not to copy Ollama's code or brand; the goal is to keep the same local-first ease: point tools at `http://127.0.0.1:11434`, keep your workflows, and let Local Router route across explicit provider models, fallback chains, and transparent local router policies.

The project identity should grow around an original cool, cutesy cyberpunk Anishinaabe character and visual language. The app still needs to stay practical and readable, but the project should have personality: memorable docs, friendly local setup, and routing tools that feel open enough for anyone to inspect, tune, and improve.

## Why

Most AI coding tools already know how to talk to Ollama or an OpenAI-compatible API. Local Router uses that compatibility layer as a universal local gateway:

- Replace an Ollama endpoint without replacing your tools.
- Route one tool surface across many hosted providers.
- Present readable model aliases instead of raw provider model IDs.
- Create `local-router/<name>` fallback routes and router models.
- Keep provider keys in memory through the local config UI.
- Export redacted router telemetry without storing prompts, responses, or secrets.
- Inspect, dry-run, and improve routing behavior through open local logic instead of opaque hosted router defaults.

## Endpoints

Default base URL:

```text
http://127.0.0.1:11434
```

OpenAI-compatible clients:

```text
http://127.0.0.1:11434/v1
```

Ollama-compatible clients:

```text
http://127.0.0.1:11434
```

Configuration UI:

```text
http://127.0.0.1:11434/config
```

## Platforms

Local Router is architecture-agnostic: the same Node.js code runs on **macOS**, **Linux**, and **Windows** (use an **Ubuntu terminal via WSL**). Every command in this README is shell-generic — run it as-is in zsh (macOS default), bash (Linux), or your WSL/Ubuntu shell (Windows). The only requirements are Node.js and npm.

## Install And Run

```bash
npm install
npm run build
npm run cli -- start
```

Direct CLI usage after package linking or install:

```bash
local-router start
local-router status
local-router stop
```

Operator CLI (Ollama-parity, headless-friendly):

```bash
localrouter list --custom
localrouter list --all
localrouter keys list
localrouter keys set zenmux --env ZENMUX_API_KEY
localrouter router check
localrouter verify --json
localrouter config --open
```

Optional Ollama shim:

```bash
local-router route set
local-router route status
local-router route unset
```

Custom local route:

```bash
local-router route custom localhost:11500
```

Custom route targets are restricted to `localhost` or `127.0.0.1`, ports `1024-65535`, and cannot use `11434` in custom mode.

## Model Names

Provider models use their configured presented aliases from `providers.txt`.

Local Router routes use:

```text
local-router/<route-name>
```

Legacy `fvs-code/<route-name>` and `fallback/<route-name>` inputs still resolve as compatibility aliases, but new docs and APIs present `local-router/<route-name>`.

## Choosing a Router Type

Open `http://localhost:11434/config` → **Router Models**. Each type selects from your explicit candidate list only:

| Type | When to use |
|---|---|
| `auto-local` | **Recommended default.** Balances coding quality, cost, and latency. Adjust Cost/Quality (0–10). |
| `pareto-code` | Coding-first workflows. Drops models below Min Coding Score. |
| `priority` | Predictable top-to-bottom order after capability checks. |
| `bandit-local` | Learns from your usage over time (dLinUCB). Needs ~10 samples per candidate. |

**Out-of-box recommendation:** use `local-router/auto-router-main` or `local-router/nanoboozhoo` as your model. The system fallback chain `local-router/fallback-models` is bootstrapped automatically and catches failures when providers are missing or upstream calls fail.

### Preset Routes (built-in)
4 built-in preset routes are auto-bootstrapped on first startup:
- `local-router/multimodal` — fallback chain of 16 vision-capable models (NIM Kimi K2.6 → Antigravity → Copilot → Pioneer → ZenMux → Wafer).
- `local-router/performance` — auto-local router, 15 top-quality candidates (text + multimodal union, deduped), `minCodingScore=0.88`, max quality (`costQualityTradeoff=10`).
- `local-router/low-cost` — auto-local router, 7 free candidates (one from each provider with free models), `minCodingScore=0.75`, cost-optimized (`costQualityTradeoff=2`).
- `local-router/nanoboozhoo` — auto-local SOTA router, 64 candidates (full candidate pool), quality=10, `minCodingScore=0.86`. Implements reasoning-aware routing principles from NeurIPS/ACL 2025 SOTA papers (broad candidate pool + aggressive quality gating to guarantee the best selection at runtime).

### Universal Prompt Caching Policy
Local Router enforces maximum caching and savings across all providers and models automatically, preventing any IDE/client tool from disabling it:
- **Universal Caching:** Active across all providers and models, with no input/output token length restrictions.
- **Max Caching Length:** Non-OpenAI models use max TTL (`cache_control: { type: "ephemeral", ttl: "1h" }`) injected on the system message and conversation history.
- **Max Caching Retention:** OpenAI family models use max retention (`prompt_cache_retention: "24h"`).
- **Sticky Routing Keys:** Automatically injects conversation-specific hashes as `prompt_cache_key` for Kimi/Moonshot and OpenAI models to pin traffic to the same cache servers.
- **Cache Safeguards:** Automatically strips cache-disabling flags (`cache: false`, `use_cache: false`, etc.) sent by client IDEs, and removes `provider.order` for OpenRouter requests to preserve sticky routing.

Limited-time provider promos (ZenMux matched Qwen pricing, Wafer MiniMax-M3 weekly rates, etc.) are editable under `/config` → **Model Pricing Overrides** and persist to `~/.config/local-router/provider-pricing.json`.

## Configuration Storage

Local Router writes non-secret route and telemetry files under your POSIX home directory:

```text
~/.config/local-router
```

(`~` is your macOS/Linux home directory, or your Ubuntu/WSL home on Windows.) It reads legacy `~/.config/fvs-code` files when the new files do not exist yet. Provider API keys are not written to these JSON or CSV files.

## Security Notes

- **Recommended:** Store all API keys in the PQC-encrypted secrets bundle (`~/.config/pqc-secrets/secrets.bundle.json`) using ML-KEM-768 + AES-256-GCM. Keys load automatically at server startup. Use `bin/pqc-secrets pack` to add keys — see `AGENTS.md` for the full lifecycle.

### PQC secrets bootstrap (fresh machine)

The bundle and keypair are **machine-local** — a clone brings neither (by design: **keys are never transported, pushed, or synced between machines**). One command after pulling the repo, run in any POSIX shell (Terminal on macOS, any shell on Linux, or the Ubuntu/WSL terminal on Windows):

```bash
./bin/pqc-secrets setup
```

`setup` installs `uv` (pinned version, sha256-verified download — never curl-to-bash) when missing, runs `keygen` when no keypair exists on this machine, and prints the key-packing sequence:

```bash
# Pack keys Local Router will use — LOCALROUTER_ namespace only:
printf 'LOCALROUTER_KILO_API_KEY=...\nLOCALROUTER_ZAI_API_KEY=...\n' | ./bin/pqc-secrets pack

# Inspect what is set (names only — values are never printed):
./bin/pqc-secrets list

# Rename an existing name instead of re-packing (value kept, bundle backed up):
./bin/pqc-secrets rename KILO_API_KEY LOCALROUTER_KILO_API_KEY

# Optional: inject the bundle into the current shell for other LOCAL tools:
eval "$(./bin/pqc-secrets export)"
```

Local Router reads **only** `LOCALROUTER_<KEY_ENV_VAR>` names for provider keys — plainly-named ambient variables for other tools are invisible to it by design; see `llms.txt` § PQC Key Management. There is deliberately no export-to-file, sync, or push path anywhere in this tooling.

- Provider keys are process-local unless supplied by the environment.
- Router telemetry is redacted and does not store prompt text, responses, API keys, auth headers, local paths, or provider secrets.
- Route definitions store model IDs and routing metadata only.
- New environment variables use `LOCAL_ROUTER_*`; legacy `FVS_*` names are accepted only as compatibility fallback.

## Development

### Quick Start

```bash
npm install
npm run dev
```

**Windows drives via WSL (or other filesystems without symlink support):** npm cannot
create `node_modules/.bin` symlinks there and a plain `npm install` fails with
`EPERM: operation not permitted, symlink`. Use:

```bash
npm install --no-bin-links
```

The `postinstall` hook (`scripts/setup-bin-shims.mjs`) then writes executable
`.bin` shims so `npm run` scripts work normally.

`npm run dev` starts the server with **hot reload** via `tsx watch` — edit TypeScript files and the server restarts automatically.

### Dev Server (Hot Reload)

For contributor convenience, set `LOCAL_ROUTER_DEV=true` in your environment. The server will log a `[DEV]` banner on startup with helpful URLs:

```bash
# Run the dev server with hot reload on the default port
LOCAL_ROUTER_DEV=true npm run dev

# Or run alongside production Ollama on a different port
LOCAL_ROUTER_DEV=true PORT=11435 npm run dev
```

The `LOCAL_ROUTER_DEV` flag enables:
- `[DEV]` startup banner with config UI URL and port hints
- Full hot reload via `tsx watch` (file changes trigger automatic restart)

### Dev Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (`tsx watch`) |
| `npm run dev:once` | Start dev server without watch (`tsx src/index.ts`) |
| `npm run build` | Compile TypeScript to `build/` |
| `npm run build:watch` | Watch TypeScript files and recompile on change |
| `npm run test:integration` | Run integration test suite |
| `npm run test` | Alias for test:integration |
| `npm run cli -- start` | Start the built server via CLI |

### Running Alongside Production Ollama

If Ollama is already running on port `11434`, start the dev server on an alternate port:

```bash
PORT=11435 LOCAL_ROUTER_DEV=true npm run dev
```

VS Code and other tools can then point at `http://127.0.0.1:11435/v1`.

## Branch Model

Two long-lived branches with mandatory two-hop promotion:

- **`develop` — integration & verification.** All worktree branches merge here first. Cross-feature integration, build gates, smoke tests, and operator verification run on `develop` before any release promotion.
- **`main` — release.** Production-facing canonical state. Receives only verified, integrated work from `develop`.

Promotion path:

```text
feature worktree → develop (integrate + verify) → main (release)
```

No feature work ships to `main` without passing through `develop`. `staging` and `production` are not used.

Primary implementation files:

- `src/index.ts`: server, routing, config UI, persistence, and compatibility surfaces.
- `bin/local-router.js`: CLI lifecycle and Ollama route shim.
- `providers.txt`: provider and model metadata source.
- `ROUTER.md`: router design notes and future routing improvements.
- `BRAND.md`: product identity and character brief for the original cyberpunk Anishinaabe guide concept.
