# Plan — pi + hermes default to local-router/fallback-models via the Ollama shim

- Date: 2026-11-12
- Machine: mac (darwin arm64), this checkout `/Volumes/1tb-sandisk/code-external/local-router`
- Branch: `main` — no repo code changes; only `.agents/` coordination records (carve-out).
  Mutation surface is machine config outside the repo: `~/.pi/agent/`, `~/.hermes/config.yaml`.

## Goal

At startup, `pi` (pi-coding-agent 1.5.2) and `hermes` (Hermes Agent v0.23.1) default to
the operator's localhost:11434 endpoint (local-router is an Ollama shim/proxy) using the
model `local-router/fallback-models`.

## Evidence gathered

- Router live at `http://127.0.0.1:11434`; `/v1/models` serves `local-router/fallback-models`
  (context 1,050,000; max output 943,718; toolCalling, imageInput, reasoning none→high).
- pi has **no built-in Ollama provider**; its docs (`docs/models.md` "Configure a compatible
  endpoint") prescribe exactly this case: `providers.ollama` in `~/.pi/agent/models.json` with
  `baseUrl http://localhost:11434/v1`, `api openai-completions`, dummy `apiKey`, explicit model list.
  Startup defaults live in `~/.pi/agent/settings.json` (`defaultProvider`, `defaultModel`,
  `enabledModels` scoped by `provider/id` patterns).
- hermes `cli-config.yaml.example`: `model.provider: "ollama"` is a documented alias of
  `"custom"` (any OpenAI-compatible endpoint) with `base_url`; `model.default` is the model id.
  Current config points at zenmux (`model.provider: zenmux`) — drifted from the 2026-09-01
  singular-model-system repoint (`TASK.2026-09-01b`).

## Changes

1. `~/.pi/agent/models.json` — add provider `ollama`:
   `{ baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama",
      models: [{ id: "local-router/fallback-models", name: "local-router/fallback-models",
      reasoning: true, input: ["text","image"], contextWindow: 1050000, maxTokens: 943718 }] }`
   Metadata mirrors the shim's live `/v1/models` entry. Existing providers untouched.
2. `~/.pi/agent/settings.json` — `defaultProvider: "ollama"`,
   `defaultModel: "local-router/fallback-models"`; append `ollama/local-router/fallback-models`
   to `enabledModels` (startup selection and cycling scope).
3. `~/.hermes/config.yaml` — backup first (`.bak.pre-ollama-repoint.<ts>`), then
   `model.provider: ollama`, `model.base_url: http://localhost:11434/v1`,
   `model.default: local-router/fallback-models` via `hermes config set`. Keep
   `api_mode: chat_completions`, `max_tokens`, `system_prompt` unchanged.

## Verification

- pi: `pi --list-models` lists `ollama/local-router/fallback-models`; one-shot print-mode run
  (`pi --print`) at defaults completes through the shim (new session record shows the model).
- hermes: `hermes config get model.*` resolves the three keys; one-shot smoke through the shim.
- Both smokes must return real completion content; fail closed otherwise.

## Clarifications (2026-11-12, during execution)

- hermes `model.provider` must be `local-router`, not `ollama`: hermes resolves named
  `providers.<name>` blocks before the documented `ollama→custom` alias, and the named
  `providers.ollama` block targets the operator's real Ollama on 127.0.0.1:11435 (`:cloud`
  models). The named `providers.local-router` block (api `http://localhost:11434/v1`, 110 models
  incl. `local-router/fallback-models`) is the shim's hermes identity — the 2026-09-01 precedent.
  `model.base_url`/`model.api_mode` are auto-cleared on provider switch to a named block.

## Risks / notes

- pi model id contains a slash (`local-router/fallback-models`); `provider/id` patterns match on
  first slash. If startup selection fails to resolve it, fall back to `--model` verification and
  record the limitation.
- hermes `context_length` auto-detect reads the shim's `/v1/models` — leave unset.
- No repo code change, no tests to update; `~/.pi/agent/models.json` contains a live key —
  edits must not echo it.
