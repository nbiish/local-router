# TASK.2026-11-12 — pi + hermes default to `local-router/fallback-models` via the Ollama shim

- Machine: mac (darwin arm64), checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `main` (coordination carve-out only; no repo code changed — mutation surface is
  machine config `~/.pi/agent/` and `~/.hermes/config.yaml`)
- Plan: `.agents/plans/2026-11-12-pi-hermes-ollama-default.plan.md`
- Status: done

## Objective

At startup, `pi` (pi-coding-agent 1.5.2) and `hermes` (Hermes Agent v0.23.1) use the operator's
localhost:11434 endpoint (local-router is an Ollama shim/proxy) with the model
`local-router/fallback-models`.

## Changes

1. `~/.pi/agent/models.json` — new provider `ollama` (pi's own docs prescribe this exact shape for
   a compatible endpoint): `baseUrl http://localhost:11434/v1`, `api openai-completions`, dummy
   `apiKey "ollama"`, one model `local-router/fallback-models` (contextWindow 1,050,000,
   maxTokens 943,718, reasoning true, input text+image, thinkingLevelMap off→"none" … high→"high",
   xhigh/max null) — metadata mirrors the shim's live `/v1/models` entry.
2. `~/.pi/agent/settings.json` — `defaultProvider: "ollama"`, `defaultModel: "local-router/fallback-models"`;
   `ollama/local-router/fallback-models` appended to `enabledModels` (startup + cycling scope).
3. `~/.hermes/config.yaml` — backup `config.yaml.bak.pre-ollama-repoint.20261112T185727Z`, then via
   `hermes config set`: `model.provider: local-router`, `model.base_url: http://localhost:11434/v1`,
   `model.default: local-router/fallback-models`; stale `model.key_env` (zenmux leftover) unset.

## Findings during verification

- hermes `model.provider: "ollama"` does NOT hit the router. Hermes resolves **named**
  `providers.<name>` blocks before the documented `ollama→custom` alias, and the named
  `providers.ollama` block targets the operator's real Ollama process on **127.0.0.1:11435**
  (`api: http://localhost:11435/v1`, `:cloud` models). Both smoke runs returned
  `HTTP 404: model 'local-router/fallback-models' not found` from that Ollama, never the router.
  A wire-logging relay on :11435 could not even bind — the port is occupied by `ollama` (PID 17444).
- `hermes config set model.provider <name>` switching to a named provider CLEARS
  `model.base_url`/`model.api_mode` ("that route belonged to ollama… local-router's endpoint
  resolves automatically") — the named block's `api` URL wins. Re-setting `model.base_url` to the
  same URL kept the 2026-09-01 three-key shape.
- The correct hermes wiring already existed in the config: named `providers.local-router`
  (`api: http://localhost:11434/v1`, 110 models incl. `local-router/fallback-models`) — matching
  the 2026-09-01 singular-model-system precedent (TASK.2026-09-01b).

## Evidence

- pi: `pi --list-models local-router` → `ollama local-router/fallback-models 1.1M 943.7K yes yes`;
  print-mode smoke at defaults answered `OK`; session record
  `~/.pi/agent/sessions/--private-tmp--/2026-11-12T18-57-54-…jsonl` shows
  `provider=ollama modelId=local-router/fallback-models`.
- hermes: `hermes config get` → `local-router / http://localhost:11434/v1 / local-router/fallback-models`;
  `hermes -z "Reply with exactly: OK"` → `OK` (10.3s).
- Router `/v1/models` serves `local-router/fallback-models` (16-step chain; curl
  `/v1/chat/completions` with the id returns real completions, stream and non-stream).

## Files touched

- `~/.pi/agent/models.json`, `~/.pi/agent/settings.json`
- `~/.hermes/config.yaml` (+ backup `config.yaml.bak.pre-ollama-repoint.20261112T185727Z`)
- `.agents/plans/2026-11-12-pi-hermes-ollama-default.plan.md`, `.agents/comms/2026-11-12-team.txt`,
  `.agents/memories/MEMORY.md` (records)

## Not changed / out of scope

- `providers.ollama` (Ollama Cloud via :11435) and all other hermes provider blocks untouched.
- pi's existing 9 custom providers and the previous zenmux default are preserved (available via
  `/model` cycling); only the startup default moved.
