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

## Configuration Storage

Local Router writes non-secret route and telemetry files under:

```text
~/.config/local-router
```

It reads legacy `~/.config/fvs-code` files when the new files do not exist yet. Provider API keys are not written to these JSON or CSV files.

## Security Notes

- Provider keys are process-local unless supplied by the environment.
- Router telemetry is redacted and does not store prompt text, responses, API keys, auth headers, local paths, or provider secrets.
- Route definitions store model IDs and routing metadata only.
- New environment variables use `LOCAL_ROUTER_*`; legacy `FVS_*` names are accepted only as compatibility fallback.

## Development

```bash
npm run dev
npm run build
npm run test:integration
```

Primary implementation files:

- `src/index.ts`: server, routing, config UI, persistence, and compatibility surfaces.
- `bin/local-router.js`: CLI lifecycle and Ollama route shim.
- `providers.txt`: provider and model metadata source.
- `ROUTER.md`: router design notes and future routing improvements.
