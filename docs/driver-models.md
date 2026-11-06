# Driver models — generative chat for agent tooling

Status: operator requirement record + verified constraints (2026-11-06)
Companion to [`decisions.md`](./decisions.md), which covers **typed decisions**. This file covers
the **generative** tier — plain chat/completions used to drive an agent tool.

The two tiers are separate on purpose:

- **Decisions** (`/api/alpha/decisions`, `/v1/decisions`, `/decisions`) → calibrated
  `noul`/`choice`/`score` answers. Consumed by retrieval ranking, routing, and gating.
- **Driver** (`/v1/chat/completions`) → free-form text. Consumed by anything that must *write*:
  summarizers, critics, context synthesizers, and the Elephant/Goldfish injectors in `ainish-rag`.

## Requested driver order

For `ainish-rag`'s driver calls, the intended order is:

1. **local-router** — preferring the OpenRouter-backed variant of the driver model
2. **OpenRouter** directly
3. **ZenMux**
4. **local model** on this machine

The driver model is **`deepseek-v4.1-flash`** (DeepSeek V4.1 Flash).

## Verified state of this machine (2026-11-06)

Probed live against `http://127.0.0.1:11434`. These are measurements, not assumptions.

### The driver model is reachable on every tier

| Tier | Model id | Result |
|---|---|---|
| local-router → OpenRouter | `openrouter-deepseek-v4.1-flash-1017` | `DRIVER_OK`, routed to `deepseek/deepseek-v4.1-flash-1017` |
| local-router → ZenMux | `zenmux-deepseek-v4.1-flash` | `DRIVER_OK`, routed to `deepseek/deepseek-v4.1-flash` |
| local-router fallback chain | `local-router/fallback-models` | `DRIVER_OK` |

### `deepseek-v4.1-flash` is a REASONING model — this constrains every caller

A first probe with `max_tokens: 16` returned **empty content** with
`completion_tokens_details.reasoning_tokens: 16`. The model spent the entire budget reasoning and
never emitted an answer. With `max_tokens: 512` the same request returned `DRIVER_OK` and reported
27 reasoning tokens.

**Rule for callers:** the driver budget must cover reasoning *plus* the answer. A small
`max_tokens` silently yields `content: ""` — which looks like a transport failure but is not. Any
caller that treats empty content as an error will mis-diagnose this. Allocate headroom (≥512 for short
prompts; more for long synthesized context).

### Typed-decision priority already matches the requested order

`GET /api/decisions/status` reports:

```json
"order": ["openrouter", "zenmux"],
"latest_model": "typesafe/jev-1.14"
```

Both providers advertise `typesafe/jev-1.14`, and OpenRouter is already tried first, failing over to
ZenMux only on availability errors. **No change required** — the requested "OpenRouter latest first,
ZenMux as backup" behaviour is what the router already does. Recorded here so it is not
re-litigated later.

### NVFP4 Nemotron Lightning is NOT loadable by this llama.cpp build

Requested local driver: the NVFP4 quantization of an Unsloth Nemotron Lightning model.

`llama-quantize --help` on this machine (`version: 0.8.0-dev, commit 7e2fea0`) lists these types:

```
F32 F16 BF16 Q8_0 Q6_K Q5_K_S Q5_K_M Q5_K Q4_K_S Q4_K_M Q4_K Q3_K_S Q3_K_M Q3_K_L
Q2_K_S Q2_K IQ4_XS IQ4_NL IQ3_XS IQ3_M IQ3_S IQ3_XXS IQ2_M IQ2_S IQ2_XS IQ2_XXS
Q1_M Q1_S TQ2_0 TQ1_0 Q2_0 Q1_0 MXFP4_MOE
```

**There is no NVFP4 entry.** MXFP4 exists only as `MXFP4_MOE` (mixed-expert). So an NVFP4 GGUF
cannot be loaded by the current build, regardless of whether the weights are downloaded. This is a
hardware/build limitation, not a configuration gap — NVFP4 is an NVIDIA Blackwell-class format and
this is a ROCm/gfx build.

**Available substitutes, in preference order:**

1. `unsloth-nvidia-nemotron-3.5-lightning-30b-a3b-gguf-mxfp4_moe` — MoE-only MXFP4, the closest
   format to the request and the only 4-bit MoE option present.
2. `unsloth-nvidia-nemotron-3.5-lightning-30b-a3b-gguf-ud-q8_k_xl` — 8-bit; higher fidelity, larger,
   slower.
3. `unsloth-nvidia-nemotron-3.5-lightning-30b-a3b-gguf` — default quant (full precision download).

**No local NVFP4 weights are present** on this machine either (searched the Hugging Face / Unsloth
caches). So even with a capable build, tier 4 would need a fresh download.

### The local tier is currently offline

- `127.0.0.1:8888` (Unsloth Studio) — unreachable
- `127.0.0.1:8080` (llama.cpp) — unreachable

By contract the router never starts either backend; it detects them. Unsloth is offline-tolerant, so
its last-known model ids stay advertised while Studio is closed, and requests surface the upstream
refusal rather than substituting an answer. **Tier 4 therefore fails today** — expected, and the
reason tiers 1–3 must all be real fallbacks rather than decorative.

## Do not repurpose the shared `fallback-models` chain

The live chain (20 steps) is shared by every client: VS Code, Claude Code, Cline, scripts. Its
current head is `zai-glm-5.3-flashx`, and `openrouter-deepseek-v4.1-flash-1017` sits at position 17.

Reordering it to satisfy the driver order would change model behaviour for **all** consumers, to
serve one tool's preference. Don't.

Instead, `ainish-rag` carries its own driver order (tier 1–4 above) as explicit model ids, and
treats `local-router/fallback-models` only as a last-resort generic target. This keeps the operator's
global routing intent intact and makes the driver order auditable in one place.

## Requirements this places on ainish-rag

1. Driver transport must be tiered `local-router → openrouter → zenmux → local-model` with per-tier
   timeouts and a reported `source`, mirroring the decision layer's discipline.
2. Driver `max_tokens` must budget for reasoning tokens (see above), or empty-content responses will
   be misread as transport failures.
3. Local tier must name an **MXFP4_MOE or Q8_K_XL** Lightning id — an NVFP4 id will never resolve on
   this build.
4. Tier 4 must degrade cleanly when Unsloth Studio is closed (it is, today) rather than hanging.

## Re-verification

```bash
# decision tier order
curl -s http://127.0.0.1:11434/api/decisions/status | python3 -m json.tool

# driver tier reachability (needs max_tokens headroom for reasoning)
curl -s http://127.0.0.1:11434/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"openrouter-deepseek-v4.1-flash-1017","messages":[{"role":"user","content":"Reply exactly: DRIVER_OK"}],"max_tokens":512,"temperature":0}'

# which quant types this build accepts
llama-quantize --help | grep -E '^\s*[0-9]+\s+or'

# local backends up?
curl -s -m 3 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8888/v1/models
```
