# TASK 2026-09-01b — singular model system + cross-machine port (mac side)

Branch: main-coordination (config changes are operator-machine-local; repo code untouched)

## Operator directive
All models and agent harnesses point at the local router fallback chain
(`local-router/fallback-models` via the Ollama proxy endpoint :11434) so there is one
iterable model system across machines, driven through the wtf federated chat.

## Mac side — DONE, verified end-to-end
- Router: main @ f136bd6 running (PID 49808, v0.31.1), fallback chain = 21 steps,
  first hop modal-proxy-glm-5.3-flash (reasoning model — needs max_tokens ≥ ~500).
- omp: `local-router` provider in `~/.omp/agent/models.yml` (baseUrl 127.0.0.1:11434/v1,
  openai-completions, reasoningContentField compat) + all six `modelRoles` repointed in
  `~/.omp/agent/config.yml` (backup: config.yml.bak.pre-fallback-repoint). Smoke: OMP-ROUTER-OK.
- hermes: `model.{provider,base_url,default}` → local-router / http://localhost:11434/v1 /
  local-router/fallback-models via `hermes config set` (backup: config.yaml.bak.pre-fallback-repoint).
  Smoke: HERMES-ROUTER-OK.
- fcc-server: MODEL=ollama/local-router/fallback-models (operator-set), verified through the
  Anthropic shim POST /v1/messages (Bearer freecc, port 8082). Smoke: FCC-ROUTER-OK.
- MCP wiring: wtf bridge registered user-level (`~/.omp/agent/mcp.json`) and repo-level
  (`.mcp.json` in local-router, uncommitted).

## Federated ops — in flight
- Created encrypted session `local-router ops` (828d334113c772c7a8b8cb34db637698, repo
  local-router) on hub-799c0c4c; pairing key delivered to windows-1 via the existing
  `wtf-is-going-on-mcp` chat (seq 21-22, E2E).
- BIN 1: Windows import work order (join chat → publish recipient.pub → import envelope →
  mirror configs → repoint harnesses → smoke).
- BIN 2: config payload (base64 tar.gz of 9 router config JSONs, no secrets).
- /tmp/router-port/keys.env: 17 keys (LOCALROUTER_* ×15, MODAL_* ×3 filtered) staged 0600
  awaiting Windows recipient.pub to seal the envelope (`pqc-secrets envelope export`).

## Secrets handling
- No secret values ever in bins, chat, or ledger — envelope is ML-KEM-768 + ML-DSA-65 sealed;
  Windows verifies-before-decapsulate (fail closed). Plaintext staging file is 0600 in /tmp
  and deleted after envelope export.

## Classification: Confidential. No secrets in this file.
