---
name: provider-models-list
description: "Lists every model advertised on every local-router provider's live /v1/models endpoint. Filters by regex, free-tier heuristic, or minimum context window. Invoke to discover new models, audit free-for-limited-time offers, or verify a model is actually live upstream before adding or removing it."
---

# Provider Models List

Probes the live `/v1/models` endpoint of every configured local-router provider and emits a unified table. Use this to discover new models before onboarding them with [model-add](../model-add/SKILL.md), or to verify a model is really gone before removing it with [model-remove](../model-remove/SKILL.md).

> **Companion skills:** [model-add](../model-add/SKILL.md) — onboard after discovery. [model-remove](../model-remove/SKILL.md) — retire after verification. [pqc-secrets](../../pqc-secrets/SKILL.md) — load API keys into the shell before running this probe.

---

## 1. Quick Start

```bash
# Load provider keys from the PQC bundle (required for live probes)
secrets-load

# Probe every provider; emit a table
node .agents/skills/provider-models-list/scripts/probe.mjs

# Probe a single provider
node .agents/skills/provider-models-list/scripts/probe.mjs zenmux

# Filter by regex
node .agents/skills/provider-models-list/scripts/probe.mjs --filter "step|kimi"

# Only free-tier candidates
node .agents/skills/provider-models-list/scripts/probe.mjs --free

# Only 1M+ context models
node .agents/skills/provider-models-list/scripts/probe.mjs --context 1000000


# Audit model drift: compare live provider API models against the factual registry
node .agents/skills/provider-models-list/scripts/probe.mjs --compare

# Machine-readable output
node .agents/skills/provider-models-list/scripts/probe.mjs --json > models.json

The probe fires all requests in parallel with a 10 s timeout per provider. Missing keys surface as `no key (<ENV_VAR> not in env)` in the status column — they do not abort the run.

---

## 2. Output Shape

### Table (default)

```text
PROVIDER               | MODEL ID                                                | CTX        | PRICE/M in     | STATUS
-----------------------+--------------------------------------------------------+------------+----------------+----------------
zenmux                 | stepfun/step-3.7-flash:free                            | 256,000    | in 0 / out 0   | FREE
zenmux                 | moonshotai/kimi-k2.7-code-free                          | 131,072    | in 0 / out 0   | FREE
zenmux                 | minimax/minimax-m3                                      | 1,000,000  | in 0.3 / out 1.2 | paid
openrouter             | stepfun/step-3.7-flash                                  | 256,000    | in 0.1 / out 0.3 | paid
…
```

### JSON (`--json`)

```json
[
  {
    "provider": "zenmux",
    "ok": true,
    "reason": null,
    "models": [
      {
        "id": "stepfun/step-3.7-flash:free",
        "context": 256000,
        "pricing": { "prompt": "0", "completion": "0" },
        "raw": { "id": "stepfun/step-3.7-flash:free", "context_length": 256000, ... }
      }
    ]
  }
]
```

The `raw` field preserves the upstream response for downstream tooling (validation, drift detection, telemetry). The top-level fields are normalized so consumers don't have to special-case provider quirks.

---

## 3. What the Probe Covers

| Provider | Slug | Endpoint | Auth |
|---|---|---|---|
| Wafer Serverless | `wafer-serverless` | `https://pass.wafer.ai/v1/models` | `WAFER_SERVERLESS_API_KEY` |
| ZenMux | `zenmux` | `https://zenmux.ai/api/v1/models` | `ZENMUX_API_KEY` |
| Nebius | `nebius` | `https://api.tokenfactory.nebius.com/v1/models` | `NEBIUS_API_KEY` |
| Moonshot | `moonshot` | `https://api.moonshot.ai/v1/models` | `MOONSHOT_API_KEY` |
| NVIDIA NIM | `nvidia-nim` | `https://integrate.api.nvidia.com/v1/models` | `NVIDIA_NIM_API_KEY` |
| Modal | `modal` | `https://api.us-west-2.modal.direct/v1/models` | `MODAL_API_KEY` |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1/models` | `OPENROUTER_API_KEY` |
| Xiaomi MiMo | `xiaomi-mimo` | `https://token-plan-sgp.xiaomimimo.com/v1/models` | `XIAOMI_MIMO_API_KEY` |
| OpenCode Go | `opencode-go` | `https://opencode.ai/zen/go/v1/models` | `OPENCODE_API_KEY` |
| OpenCode Zen | `opencode-zen` | `https://opencode.ai/zen/v1/models` | `OPENCODE_ZEN_API_KEY` |
| Z.ai | `zai` | `https://api.z.ai/api/coding/paas/v4/models` | `ZAI_API_KEY` |
| Ollama | `ollama` | `http://127.0.0.1:11435/v1/models` | `OLLAMA_API_KEY` (or `ollama signin` session) |
| Cline | `cline` | `https://api.cline.bot/api/v1/models` | `CLINE_API_KEY` |
| Kilo | `kilo` | `https://api.kilo.ai/api/gateway/models` | `KILO_API_KEY` |
| CommandCode | `commandcode` | `https://api.commandcode.ai/provider/v1/models` (public, no auth) | `COMMANDCODE_API_KEY` |
| Pioneer | `pioneer` | `https://api.pioneer.ai/v1/models` | `PIONEER_API_KEY` |
| **Antigravity** | `antigravity` | OAuth — use `localrouter oauth status antigravity` | OAuth token |
| **GitHub Copilot** | `github-copilot` | OAuth — use `localrouter oauth status github-copilot` | OAuth token |

**OAuth providers are skipped by default.** They do not implement OpenAI-compatible `/v1/models`. Use the proxy's OAuth introspection endpoint instead:

```bash
localrouter oauth status antigravity
localrouter oauth status github-copilot
```

---

## 4. Free-Tier Heuristics

The `--free` filter uses three signals in order:

1. **ID suffix** — `:free`, `-free`, `.free` (case-insensitive substring match).
2. **OpenRouter sentinel** — `openrouter/free` is the gateway's free router preset.
3. **Pricing field** — `pricing.prompt === "0"` AND `pricing.completion === "0"` (string compare because OpenRouter ships stringified decimals).

This is a heuristic, not a contract. A provider that returns no `pricing` field at all is treated as **paid** (the conservative default — operators should verify manually if unsure).

For canonical free-tier truth on Ollama Cloud tags, use `src/ollama-cloud-catalog.ts` (`OLLAMA_CLOUD_TAG_TIERS`). For Cline/Kilo gateway tiers, use `src/gateway-provider-catalog.ts` (`CLINE_FREE_MODEL_IDS` / `KILO_FREE_MODEL_IDS`).

---

## 5. Common Workflows

### 5.1 "Is `stepfun/step-3.7-flash:free` available on every provider?"

```bash
secrets-load
node .agents/skills/provider-models-list/scripts/probe.mjs \
  --filter "step-3.7-flash" --json | jq '.[] | {provider, hits: .models | length}'
```

The output tells you which providers host the model and which don't — exactly the kind of cross-provider check operators do weekly.

### 5.2 "What 1M-context models are free anywhere?"

```bash
node .agents/skills/provider-models-list/scripts/probe.mjs --free --context 1000000
```

Useful for the weekly "best free model" rotation when a flagship drops a free tier temporarily.

### 5.3 "Audit: are any of our advertised models actually gone?"

```bash
node .agents/skills/provider-models-list/scripts/probe.mjs --json \
  | jq -r '.[] | .provider as $p | .models[].id' \
  | sort -u > /tmp/live-upstream.txt

# Cross-reference against the factual registry (src/provider-model-registries.ts)
rg -oE "id: '[^']+'" src/provider-model-registries.ts \
  | awk '{print $2}' | sort -u > /tmp/catalog.txt

diff /tmp/catalog.txt /tmp/live-upstream.txt
```

The diff is the model-drift surface — anything in catalog but not live should be queued for [model-remove](../model-remove/SKILL.md). Anything in live but not in catalog is a candidate for [model-add](../model-add/SKILL.md).

### 5.4 "Free-for-limited-time: set a calendar reminder"

When `--free` surfaces a `*:free` or `*-free` model, snapshot the expiry by hitting the upstream's model detail endpoint (OpenRouter returns `pricing` as a string; some providers omit expiry metadata). For ZenMux + OpenRouter promos, the canonical expiry lives in `src/provider-pricing.ts` `validUntil` field. Use `cip-daily-research.mts` to get a daily alert on near-expiry entries.

---

## 6. Limitations

- **OAuth providers skipped** — Antigravity and GitHub Copilot use device/PKCE flow and don't expose OpenAI-compatible `/v1/models`. Use the proxy's OAuth introspection instead.
- **Cache disabled** — the probe hits upstream every time. Don't run it in a tight loop; rate limits vary per provider (ZenMux is generous, OpenRouter 20 req/min, others stricter).
- **Pricing strings** — OpenRouter returns `pricing.prompt` as a string like `"0.0001"`. The probe passes them through verbatim. Normalize before arithmetic.
- **Static catalog fallback** — if `process.env.<KEY>` is unset, the probe does **not** fall back to the registry. Use `src/provider-model-registries.ts` when no keys are available; use the probe to discover what changed since the registry was last curated.
- **No deduplication across providers** — a model hosted on ZenMux + OpenRouter + Cline appears three times. The `--filter` regex helps narrow, but the consumer is responsible for cross-provider reconciliation.

---

## 7. Security Notes

- The probe **never** writes API keys to disk. It reads them from `process.env` (populated by `secrets-load`) and uses them in-memory for the fetch only.
- The probe **never** logs bearer tokens. Failed-auth responses are summarized as `HTTP 401` without echoing headers.
- The probe **never** persists the upstream response to disk. Use `--json > models.json` if you need an artifact, and remember the file contains upstream model IDs (not secrets) but may include pricing metadata — treat as `internal` classification per AGENTS.md.
- The probe **does not** mutate any source file in the repo. It's a read-only audit tool. Onboarding changes go through [model-add](../model-add/SKILL.md); retirement changes go through [model-remove](../model-remove/SKILL.md).

---

## 8. Extending the Provider List

To add a new provider to the probe:

1. Append an entry to `PROVIDERS` in `scripts/probe.mjs` with `{ slug, baseUrl, envVar, modelsPath }`.
2. If the provider's `/models` response uses a different field name than `data` / `models` / array, add a branch in `fetchProviderModels()`.
3. Update § 3 of this skill with the new row.
4. Update `src/provider-registry.ts` (provider table) / `src/provider-model-registries.ts` (models) and the `llms.txt` PRD table.
5. Bump the script's expected provider count in the post-probe status line (e.g. `# 17 provider(s) probed`).
