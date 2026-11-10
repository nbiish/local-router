# Local Router

One localhost port. Every model.

Local Router is a local Ollama-compatible and OpenAI-compatible model router for VS Code, Copilot Chat, Continue, Cline, Roo Code, and any AI tool that can point at `localhost`.

It runs on Ollama's default port, exposes OpenAI-compatible and Ollama-compatible endpoints, and routes requests to your configured provider models or fallback chains.

## Vision

Local Router is an Ollama-compatible drop-in replacement proxy with open routing logic. The goal is not to copy Ollama's code or brand; the goal is to keep the same local-first ease: point tools at `http://127.0.0.1:11434`, keep your workflows, and let Local Router route across explicit provider models, fallback chains, and transparent local router policies.

The project identity should grow around an original cool, cutesy cyberpunk Anishinaabe character and visual language. The app still needs to stay practical and readable, but the project should have personality: memorable docs, friendly local setup, and routing tools that feel open enough for anyone to inspect, tune, and improve.

## Why

Most AI coding tools already know how to talk to Ollama or an OpenAI-compatible API. Local Router uses that compatibility layer as a universal local gateway:

- Replace an Ollama endpoint without replacing your tools.
- Route one tool surface across many hosted providers.
- Present readable model aliases instead of raw provider model IDs.
- Create `local-router/<name>` fallback chains and re-shape them live from the config UI.
- Keep provider keys in memory through the local config UI.
- Inspect and improve routing behavior through open local logic instead of opaque hosted router defaults.

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

## Decision Models (System One / Jev)

Local Router also proxies **typed decision models** — calibrated, structured
answers instead of generated prose. Three equivalent paths accept the TypeSafe
System One contract (`{model, state, questions}`) and answer `{model, answers,
usage}`:

```text
POST http://127.0.0.1:11434/api/alpha/decisions
POST http://127.0.0.1:11434/v1/decisions
POST http://127.0.0.1:11434/decisions
```

```bash
curl -s http://127.0.0.1:11434/api/alpha/decisions \
  -H 'Content-Type: application/json' \
  -d '{"model":"typesafe/jev-1.14","state":"file src/router.ts binds port 11434",
       "questions":{"needs_port":{"type":"noul","instructions":"Does this state bind a network port?",
       "criteria":{"true":"it binds a port","false":"no network binding"}}}}'
```

Decision-capable providers are resolved from your configured keys and tried in
order: **OpenRouter** (`/api/alpha/decisions`, full noul/choice/score) then
**ZenMux** (`/api/v1/decisions`, choice/score, with noul carried as a calibrated
two-option choice). Availability failures fail over between providers; contract
errors do not. Every response carries `provider`, `dialect`, and a
`local_router` provenance block with the attempt trail.

- `GET /api/decisions/status` — readiness, providers, advertised models, recent requests; `?probe=true` (or `POST /api/decisions/probe`) runs a live typed probe.
- `/v1/models` and `/api/tags` advertise `openrouter/jev-1.14` / `zenmux/jev-1.14` with `capabilities.decisions: true`. They are **pinned**: available whenever the provider key is set, no matter how the catalog is toggled, and their ids cannot be shadowed by a provider model. `openrouter-jev-router` remains a chat alias.
- Chat requests for a decision model return `400` pointing at the decisions route instead of answering with general-model prose.

Verify the whole transport in one command (exit code 0 = pass, 1 = fail):

```bash
npm run verify:decisions -- --json --out .agents/audit/decisions-verify.json
# live RAG integration (needs ainish-rag + an index):
npm run verify:decisions -- --rerank --out .agents/audit/decisions-verify.json
```

It checks discovery, pinned model advertising, a live typed probe, a
noul+choice+score batch (ranges, legend, normalized probabilities), the chat
guard, and provider-pinned failover — then writes a JSON receipt you can sign
with `ainish-rag audit sign`.

Full contract, dialect details, failover table, and configuration:
[docs/decisions.md](docs/decisions.md).

## Agent Harnesses (Claude Code & Codex CLI)

`/config/agents` is the single place that wires the two terminal agent harnesses to Local Router and proves the wiring:

- **Claude Code** — `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` plus five model slots remapped on `POST /v1/messages`.
- **Codex CLI** — a managed `[model_providers.local-router]` table in `~/.codex/config.toml` and a `local-router` profile in `~/.codex/local-router.config.toml`; `bin/codex` selects it with `--profile local-router`.

`GET /api/agents-proxy/status` reports CLI discovery, interception state, env freshness, and Codex provider/profile state without spending tokens. `POST /api/agents-proxy/verify` (`{"harness":"claude"|"codex"}`) sends one 16-token request through the matching wire shape, so the page shows a measured round-trip instead of claiming success.

### Install the harnesses

Install both CLIs with npm on any supported OS (Windows, macOS, Linux, WSL):

```bash
npm install -g @anthropic-ai/claude-code @openai/codex
npm run setup          # installs/refreshes the Local Router shims
npm run agents:doctor  # readiness, no tokens spent
npm run agents:doctor -- --verify   # + one real round trip per harness
```

Shim placement keeps the real binaries untouched:

- **Windows** — `bin\claude.cmd` / `bin\codex.cmd`, with the repo `bin` kept first on the User PATH ahead of `%APPDATA%\npm`.
- **macOS / Linux / WSL** — `~/.local/share/local-router/bin/claude|codex`, prepended to PATH from `.zshrc` / `.bashrc` / `.profile`. A native install at `~/.local/bin/claude` or `~/.local/bin/codex` is never overwritten; the shim resolves it further down PATH.

On WSL, install the CLIs inside the distro (`npm install -g …` from the WSL shell). The Windows npm launchers that WSL appends to PATH are bound to the Windows Node and are ignored by CLI detection.

The doctor works on every platform and reports `OK` / `WARN` / `FAIL` per check, so a macOS or WSL machine can be validated without opening the web UI. `--json` is available for scripted checks.

## Standalone Desktop GUI & Browser Configuration

Local Router can be run either as a **standalone desktop application** or as a **headless background daemon** managed in any web browser:

1. **Native Desktop Application (Tauri v2 / Rust)**:
   - Full GUI window opening automatically on launch for managing providers, models, fallback chains, prompt/thinking injection, and token telemetry.
   - Corner system tray controls (bottom-right notification area on Windows, top-right menu bar extra on macOS, AppIndicator on Linux).
   - Closing the window minimizes to the tray to keep local proxy routing alive for all terminal agents and IDE extensions.
   - Run in desktop mode: `npm run tauri:dev`
   - Build native release installers (`.msi`, `.exe`, `.dmg`, `.app`, `.AppImage`, `.deb`): `npm run tauri:build`

2. **Web Browser Management**:
   - Access `http://127.0.0.1:11434/config` in any web browser (Chrome, Safari, Firefox, Edge).
   - Full real-time synchronization: changes made in the desktop GUI or browser update the same underlying PQC secret bundles and `~/.config/local-router/` configuration files immediately.

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

Local Router routes use:

```text
local-router/<route-name>
```

Legacy `fvs-code/<route-name>` and `fallback/<route-name>` inputs still resolve as compatibility aliases, but new docs and APIs present `local-router/<route-name>`.

### Local backends (llama.cpp & Unsloth)

Local Router only **detects and proxies** local apps — it never starts, shims, or supervises them.

- **llama.cpp** (`llama-server`, `:8080`, `LLAMA_CPP_PORT`): models are listed while its `/v1/models` answers; an offline backend contributes no rows.
- **Unsloth** (`:8888`, `UNSLOTH_PORT`): your Unsloth Studio app stays yours. Models discovered while it is open are remembered and remain listed after you close it, and requests keep proxying to `http://127.0.0.1:8888/v1` — you get the app's own error if it is closed, never a launched substitute. Studio requires its bearer key (`sk-unsloth-…`); set it once (`LOCALROUTER_UNSLOTH_API_KEY` in the PQC store, or paste it on the provider card) and Local Router forwards it on probes and chat, leaving fields like `enable_tools`, `enabled_tools`, and `permission_mode` untouched.

## Fallback Chains

Routing is either a **direct provider model** (`zenmux-deepseek-v4-pro`) or a **fallback chain** (`local-router/<chain-id>`) — an ordered retry chain with backoff. When a chain exhausts, the request cascades into the system safety-net chain `local-router/fallback-models`.

Configure chains live: open `http://localhost:11434/config` → **Providers & Models** and tick the *fallback* checkbox on any catalog model to add it to the chain selected in the **Fallback Chains** panel, then drag the chain into the order you want — changes save immediately. The **Fallback Routes** page authors whole chains (bulk text, enable/disable steps, import/export).

**Out-of-box recommendation:** point your tools at `local-router/performance` (subscriptions and prepaid credits first) or `local-router/free` (no-cost models only). The system fallback chain `local-router/fallback-models` is bootstrapped automatically and catches failures when providers are missing or upstream calls fail.

### Preset Chains (built-in)
4 built-in preset chains are auto-bootstrapped on first startup (system chain + 3 named presets):
- `local-router/fallback-models` — system safety net, 24 curated steps spanning free → subscription → paid.
- `local-router/free` — 21 no-cost models across providers, quality-first; maximizes free-tier usage before any paid hop.
- `local-router/performance` — 18 subscription/credit models, quality-first; spends already-paid capacity before metered billing.
- `local-router/multimodal` — 15 vision-capable models.

### Universal Prompt Caching Policy
Local Router enforces maximum caching and savings across all providers and models automatically, preventing any IDE/client tool from disabling it:
- **Universal Caching:** Active across all providers and models, with no input/output token length restrictions.
- **Max Caching Length:** Non-OpenAI models use max TTL (`cache_control: { type: "ephemeral", ttl: "1h" }`) injected on the system message and conversation history.
- **Max Caching Retention:** OpenAI family models use max retention (`prompt_cache_retention: "24h"`).
- **Sticky Routing Keys:** Automatically injects conversation-specific hashes as `prompt_cache_key` for Kimi/Moonshot and OpenAI models to pin traffic to the same cache servers.
- **Cache Safeguards:** Automatically strips cache-disabling flags (`cache: false`, `use_cache: false`, etc.) sent by client IDEs, and removes `provider.order` for OpenRouter requests to preserve sticky routing.

## Configuration Storage

Local Router splits its files by lifetime:

```text
<checkout>/router-settings.json      fallback chains — travels with the repository
~/.config/local-router               credentials, catalogs, logs, health, backups — per machine
```

The chain file lives in the checkout because that is the unit people sync (git clone, rsync, a
desktop-to-laptop copy): after a sync both machines read the same chain instead of booting with
their own. It is gitignored, so a chain save never dirties the worktree or blocks `git pull`. The
machine directory holds everything that is genuinely this box's state — provider API keys are never
written to either JSON file.

(`~` is your macOS/Linux home directory, or your Ubuntu/WSL home on Windows.) It reads legacy
`~/.config/fvs-code` files when the new files do not exist yet. Resolution order: a
`LOCAL_ROUTER_CONFIG_DIR` pin (tests, CI, isolated installs) → a checkout root (a `.git` directory
next to this project's `package.json`) → `~/.config/local-router`. An overridden `HOME`/`USERPROFILE`
is treated as an isolated environment and keeps config inside that home, and a packaged build with no
`.git` uses `~/.config/local-router`. The first boot of a build that knows about the checkout copy
seeds it from the old machine file, so an existing chain is never dropped by the move.

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
- No prompts, responses, API keys, auth headers, local paths, or provider secrets are persisted.
- Chain definitions store model IDs and ordering metadata only.
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
| `npm run review:build` | Regenerate the work-review site data (`build/review-site/`) |
| `npm run review:site` | Generate and serve the work-review site at `http://127.0.0.1:8777/` |
| `npm run cli -- start` | Start the built server via CLI |

### Running Alongside Production Ollama

If Ollama is already running on port `11434`, start the dev server on an alternate port:

```bash
PORT=11435 LOCAL_ROUTER_DEV=true npm run dev
```

VS Code and other tools can then point at `http://127.0.0.1:11435/v1`.

### Port Contract (11434 = Local Router, 11435 = Ollama)

Local Router owns `11434` and keeps real Ollama available as its backend on `11435`. Enforce the contract anywhere with:

```bash
local-router ensure
```

`ensure` is idempotent and safe to call repeatedly (boot services, shell profiles, shims):

- Router already on `11434` → no-op (backend on `11435` is also verified/revived).
- Foreign **ollama** server squatting `11434` → its process tree is stopped
  supervisor-first (so Ollama.app cannot instantly respawn it), then Local
  Router starts and spawns the ollama backend on `11435` automatically.
- Any other kind of server on `11434` → left untouched (refuses to evict
  non-ollama processes). Pass `--no-evict` to report without evicting.

`local-router route set` installs the contract machinery for the current
platform:

| Platform | Enforcement |
|---|---|
| macOS | `com.localrouter.daemon` LaunchAgent runs `ensure` at load and every 2 min; `com.localrouter.ollama-host` LaunchAgent re-asserts `OLLAMA_HOST=127.0.0.1:11435` at every GUI login (persistent, survives reboot); `launchctl setenv` covers the live session |
| Windows | `OLLAMA_HOST=127.0.0.1:11435` User env var (Ollama desktop app binds 11435); Startup-folder VBS runs `ensure` at logon; `LocalRouterEnsure` scheduled task re-enforces every 5 min |
| Linux / WSL | `~/.config/environment.d/ollama.conf`; systemd user timer `local-router-ensure.timer` (boot + every 5 min); XDG autostart fallback for non-systemd WSL |

Ollama remains fully usable throughout: `ollama list/run/pull` (via the
installed shim) talk to Local Router on `11434`, `ollama serve` runs the real
binary as the router's backend on `11435`, and `LOCAL_ROUTER_NO_SHIM=1`
bypasses the routing entirely.

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

- `src/index.ts`: server, routing, persistence, and compatibility surfaces.
- `src/routes/config-api.ts` + `src/ui/pages/`: configuration API and UI.
- `bin/local-router.js`: CLI lifecycle and Ollama route shim.
- `ROUTER.md`: fallback-chain design notes and maintainer guide.
- `BRAND.md`: product identity and character brief for the original cyberpunk Anishinaabe guide concept.
