# Driver models — generative chat for agent tooling

Status: requirement record + verified constraints, **implemented in `ainish-rag` 2026-11-07**
Companion to [`decisions.md`](./decisions.md), which covers **typed decisions**. This file covers
the **generative** tier — plain chat/completions used to drive an agent tool.

The two tiers are separate on purpose:

- **Decisions** (`/api/alpha/decisions`, `/v1/decisions`, `/decisions`) → calibrated
  `noul`/`choice`/`score` answers. Consumed by retrieval ranking, routing, and gating.
- **Driver** (`/v1/chat/completions`) → free-form text. Consumed by anything that must *write*:
  summarizers, critics, context synthesizers, and the Elephant/Goldfish injectors in `ainish-rag`.

## Shipped driver order

`ainish-rag`'s `DRIVER_CHAIN` implements this order. The operator's four router steps run first;
direct-provider steps follow so a dead router degrades to a live model; the local model is the floor.
Every row was probed live on 2026-11-07 against Local Router 0.33.3 and answered `DRIVER_OK` with
`model_verified: true`.

| # | Transport | Model id (as sent) | Reported back | Measured |
|---|---|---|---|---|
| 1 | local-router | `local-router/fallback-models` | `mimo-v2.6-pro` (whatever the chain picks) | 4.1 s |
| 2 | local-router | `zai-glm-5.3-flash` | `glm-5.3-flash` | 1.9 s |
| 3 | local-router | `xiaomi-mimo-mimo-v2.6-pro` | `mimo-v2.6-pro` | 1.2 s |
| 4 | local-router | `openrouter-deepseek-v4.1-flash-1017` | `deepseek/deepseek-v4.1-flash-1017` | 0.8 s |
| 5 | nous-portal | `deepseek/deepseek-v4.1-flash-1017` | identity | 0.5 s |
| 6 | nebius | `deepseek-ai/DeepSeek-V4.1-Flash` | identity | 1.2 s |
| 7 | openrouter | `deepseek/deepseek-v4.1-flash-1017` | identity | 0.8 s |
| 8 | zenmux | `deepseek/deepseek-v4.1-flash` | identity | 2.5 s |
| 9 | zai | `glm-5.3-flash` | identity | 1.9 s |
| 10 | xiaomi-mimo | `mimo-v2.6-pro` | identity | 3.2 s |
| — | local-model | discovered, not assumed | — | local floor |

Step 1 deliberately sets `expect_any`: its whole purpose is the shared generic chain, so whatever
that chain selects is correct for that step. Steps 2–10 are pinned ids, so a mismatch there is a
real signal.

The driver model remains **`deepseek-v4.1-flash`** (DeepSeek V4.1 Flash) for the DeepSeek steps; the
GLM and MiMo steps sit ahead of it because the operator asked for that ordering.

## Model ids: a wrong id does not error

The provider-facing ids differ per tier, and **a wrong id silently falls through to the fallback
chain.** Verified 2026-11-06: requesting `deepseek-v4.1-flash-latest`,
`openrouter-deepseek-v4.1-flash-latest`, and `zenmux-deepseek-v4.1-flash-latest` all returned HTTP
200 with **`routed=auto`** — the generic `local-router/fallback-models` chain, not the requested
model. A typo in a driver id therefore produces a *different model* rather than a failure, and the
only signal is the `model` field of the response.

OpenRouter stamps a snapshot suffix (`-1017`); ZenMux presents the unsuffixed family name. There is
**no working `latest` alias** for this model on either provider — the `~`-prefixed rows in
`provider-model-registries.ts` (e.g. `~deepseek/deepseek-v4-flash-latest`) are display-marker alias
rows stripped by `normalizeModelAlias`, and they are not callable driver ids. Use the snapshot id
and bump it deliberately.

**Callers must verify `response.model`.** Because unknown ids resolve through the fallback chain
instead of failing, a driver that only checks for HTTP 200 will happily run on whatever model the
chain picked. Compare the returned `model` against the requested id, and treat a mismatch as a
degraded call. Two measured examples of why this matters: Z.AI answers a request for `glm-4.6` with
`glm-5.3-flash`, and the router answers a `-latest` alias with whatever the generic chain picked.

## Verified constraints

### `deepseek-v4.1-flash` is a REASONING model — this constrains every caller

A first probe with `max_tokens: 16` returned **empty content** with
`completion_tokens_details.reasoning_tokens: 16`. The model spent the entire budget reasoning and
never emitted an answer. With `max_tokens: 512` the same request returned `DRIVER_OK` and reported
27 reasoning tokens.

**Rule for callers:** the driver budget must cover reasoning *plus* the answer. A small
`max_tokens` silently yields `content: ""` — which looks like a transport failure but is not. Any
caller that treats empty content as an error will mis-diagnose this. `ainish-rag` defaults to 900 and
reports the reasoning-token count when it sees this.

### Typed-decision priority

`GET /api/decisions/status` reports (live, 2026-11-07):

```json
"order": ["typesafe", "openrouter", "zenmux"],
"latest_model": "typesafe/jev-1.14"
```

TypeSafe now leads as the source provider, with OpenRouter and ZenMux as resold fallbacks. This
ordering is the router's and is **independent of the driver chain above** — do not read one as
evidence about the other.

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

1. `unsloth-nvidia-nemotron-3.5-lightning-30b-a3b-gguf-mxfp4_moe` — **the operator's chosen local
   tier.** MoE-only MXFP4, the closest format to the original request and the only 4-bit MoE option
   present.
2. `unsloth-nvidia-nemotron-3.5-lightning-30b-a3b-gguf-ud-q8_k_xl` — 8-bit; higher fidelity, larger,
   slower. Fallback only.
3. `unsloth-nvidia-nemotron-3.5-lightning-30b-a3b-gguf` — default quant (full precision download).

**No local NVFP4 weights are present** on this machine either (searched the Hugging Face / Unsloth
caches). So even with a capable build, the local floor would need a fresh download.

### The local floor: what is actually serving

`127.0.0.1:8888` (Unsloth Studio) **is reachable** and advertises 31 models, but a chat request is
refused with `No model is loaded, and keyless API access cannot load '<id>' by request`. Two separate
reasons, both operator-side:

- No model is loaded in Studio.
- Studio authenticates **every** call including `GET /v1/models` with `Authorization: Bearer
  sk-unsloth-…`, and this machine's PQC store holds **no** `UNSLOTH` key (checked 2026-11-07), so
  `ainish-rag` cannot present one.

`127.0.0.1:11435` (the router's own ollama backend) answers but requires auth, and `127.0.0.1:8080`
(llama.cpp) is not listening. The router detects these backends and never starts one.

So the local floor is **discovered and reported accurately, not assumed dead**: `ainish-rag` probes
8888 → 11435 → 8080, excludes non-chat artefacts (embedding, image, audio) from selection, and does
not cache a negative result, because an idle backend answers slowly on first contact. Making offline
generation work needs Studio's API key stored as `LOCALROUTER_UNSLOTH_API_KEY` **and** a model loaded
in Studio — operator actions, not code changes.

This is also why the eight remote steps above must be real fallbacks rather than decorative.


## Two separate fallback orders — do not conflate them

There are **two independent** fallback orders on this machine, and they serve different purposes:

| Order | Lives in | Purpose |
|---|---|---|
| `local-router/fallback-models` | `<checkout>/router-settings.json` (repo-local since 2026-11-10; was `~/.config/local-router/router-settings.json`) | **Generic chat routing** for every client: VS Code, Claude Code, Cline, scripts. 18 steps, currently headed by `xiaomi-mimo-mimo-v2.6-pro` then `zai-glm-5.3-flash`. |
| Driver order (10 steps) | `ainish-rag` `src/rag/rag.py` (`DRIVER_CHAIN`) | **`ainish-rag`'s driver calls only** — the chain above. |

The driver order is deliberately **not** implemented by reordering the shared chain. Repointing
`fallback-models` would change model behaviour for every other consumer to suit one tool.
`ainish-rag` carries its chain as explicit model ids, and treats `local-router/fallback-models` as
one *step* in that chain — its first step, not its source. Keeping them separate also means the
driver order is auditable in one place rather than buried in an 18-step chain.

Note the overlap is coincidental and worth watching: the shared chain's current head happens to be
Xiaomi MiMo then Z.AI GLM, the same two models `ainish-rag` pins as steps 2–3. Step 1 could
therefore answer with a model a later step would also have chosen. That is harmless — step 1 is
allowed to return anything — but it means a green step 1 does not prove steps 2–3 work. Verify them
explicitly, which is what the re-verification block below does.

## Requirements this places on ainish-rag

1. Driver transport must report a `source` per call and degrade rather than raise, mirroring the
   decision layer's discipline. **Implemented:** `DriverEngine.chat()` returns the answering step,
   records every rejection in `attempts`, and returns `source: unavailable` instead of raising.
2. Driver ids must be exact strings, and every response's `model` field must be checked — unknown
   ids resolve via the fallback chain rather than failing. **Implemented:** `driver_model_matches`
   compares the response against the requested id; router ids are matched by their
   provider-stripped tail (`xiaomi-mimo-mimo-v2.6-pro` ← `mimo-v2.6-pro`) while a snapshot suffix
   still counts as a different model.
3. Driver `max_tokens` must budget for reasoning tokens, or empty-content responses will be misread
   as transport failures. **Implemented:** defaults to 900, and an empty-content response carrying
   reasoning tokens is reported as a budget error with the number of tokens spent.
4. Local tier must degrade cleanly when no local backend is serving rather than hanging.
   **Implemented:** probes 8888 → 11435 → 8080, does not cache a negative result, and reports the
   backend's actual error.
5. Direct provider bases must be joined correctly. **Learned the hard way 2026-11-07:** bases end
   inconsistently (`/v1` versus Z.AI's `/api/coding/paas/v4`), and appending a fixed
   `/v1/chat/completions` sent every direct provider to `/api/v1/v1/...` — six healthy vendors all
   looked dead at once. `ainish-rag`'s `_chat_url` joins on the suffix the base does not supply.


## Re-verification

The router ships a CLI that covers most of this. The commands below are written in the
`node bin/localrouter.js …` form because that works from a fresh checkout; the bare `localrouter`
form is the documented operator surface once the shims are installed (`npm run setup`), and it is
**not** on PATH on this machine as of 2026-11-07 — a bare invocation fails with "command not found",
and piped it surfaces an EPIPE from the launcher rather than a clean error.

```bash
node bin/localrouter.js verify --json      # server, keys, catalog, all three fallback routes
node bin/localrouter.js embedding --json   # retrieval route end to end, answering provider
node bin/localrouter.js ps --json          # what is resident (empty models[] = nothing loaded)

# The chain step 1 calls. Members are under local_router_chain.members, not at the top level.
node bin/localrouter.js show local-router/fallback-models --json | python3 -c '
import json,sys
for m in json.load(sys.stdin)["local_router_chain"]["members"]:
    print(m["order"], m["id"], "enabled=" + str(m["enabled"]))'
```

Version strings do not currently agree, so quote the right one: `package.json` says **1.1.0**, the
`local-router.js` launcher prints **1.0.0**, the `localrouter.js` CLI prints its own constant
**0.1.0**, and the running server reports **0.33.3** via `/api/version` (that last one is what
`verify` shows, and what a compatibility claim should cite).

Manual driver probe (needs `max_tokens` headroom for reasoning):

```bash
curl -s http://127.0.0.1:11434/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"openrouter-deepseek-v4.1-flash-1017","messages":[{"role":"user","content":"Reply exactly: DRIVER_OK"}],"max_tokens":900,"temperature":0}'
```

From `ainish-rag`, the whole chain at once:

```bash
ainish-rag secrets                 # live chain with per-step reachability
ainish-rag context --task "probe" --json   # real two-driver call; provenance names each source
```

Per-transport forcing (what the 2026-11-07 verification used) — pins a single transport, because a
healthy step 1 tells you nothing about steps 2–10, and several of them share a model family:

```python
import importlib.util
spec = importlib.util.spec_from_file_location("r", "src/rag/rag.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
for tier in m.DRIVER_REMOTE_BASES:
    r = m.DriverEngine(allow_remote=True).chat(
        [{"role": "user", "content": "Reply exactly: DRIVER_OK"}], tier=tier)
    print(tier, r["source"], r["model_verified"], r["text"][:10])
```

Which quant types this build accepts (the NVFP4 limitation above still holds):

```bash
llama-quantize --help | grep -E '^\s*[0-9]+\s+or'
```
