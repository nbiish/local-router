# Fallback routes by purpose: embedding and decision

Status: implemented 2026-11-06. Companion to [`decisions.md`](./decisions.md) and
[`driver-models.md`](./driver-models.md).

Local Router ships three fallback routes. They are not interchangeable, because each one carries a
different request shape:

| Route | Serves | Step grammar |
|---|---|---|
| `local-router/fallback-models` | Chat completions | Chat models; ordered by quality and cost |
| `local-router/fallback-embedding` | `POST /v1/embeddings` | **One model**, many providers |
| `local-router/fallback-decision` | Typed decisions | The current Jev build |

Tools call one stable id instead of a provider, which is what lets the routing move underneath them.

## Why the embedding chain is one model across providers

This is the single most important rule in this document, and it is the one that is easy to get
wrong.

An embedding vector is only meaningful relative to the model that produced it. Two vectors from
different models are not comparable at any width, and a retrieval index **cannot detect** that it
has been given a foreign vector: it accepts the width it is handed and then ranks neighbours from a
different space. The symptom is not an error, it is quietly worse retrieval.

Measured 2026-11-06, same input, `dimensions: 768`, cosine similarity against
`openai/text-embedding-3-small`:

| Provider | Model | Cosine |
|---|---|---|
| zenmux | `openai/text-embedding-3-small` | **1.000000** |
| openrouter | `openai/text-embedding-3-small` | **1.000000** |
| nous-portal | `openai/text-embedding-3-small` | **1.000000** |
| nous-portal | `qwen/qwen3-embedding-8b` | 0.036898 |
| openrouter | `openai/text-embedding-3-large` | 0.006612 |

So the fallback axis is the **provider**, never the model. The seeded chain is
`text-embedding-3-small` on openrouter → zenmux → nous-portal, which are bit-identical, so a
fallback step is invisible to the caller.

### Provider order is pinned: OpenRouter before ZenMux

OpenRouter leads and ZenMux follows. Both bill $0.020/1M for `text-embedding-3-small`, so this is
not a cost ordering — it is a configured rule, which is why it cannot be derived and has to be
enforced.

Enforcement exists because seeding is one-shot. A chain written before this rule, or reordered in
the `/config/fallback` editor to put ZenMux first, would otherwise keep the wrong order forever. The
rule is therefore applied at every boundary that can write the route:

| Boundary | Why |
|---|---|
| Boot (`enforceEmbeddingProviderOrder`) | Older stores and edits made while the router was stopped |
| `POST /api/fallback-models` | Save / UI auto-save of the whole chain |
| `POST /api/fallback-chain/reorder` | Drag-and-drop ordering |
| `POST /api/fallback-chain/toggle`, `PUT /api/router-settings` | Step added or removed, which can complete or break the pair |
| `router-settings.json` file watcher | A hand-edited file |

Three properties keep the pin from doing damage:

- It only acts when the chain carries an **enabled** ZenMux step. No ZenMux step means no pair to
  order, so a chain an operator built from other providers is untouched.
- A missing OpenRouter step is derived from the ZenMux step's own upstream model, so the vector
  space is identical by construction. It is only inserted when OpenRouter is a configured provider;
  if it is not, the pin logs that it could not take effect and leaves the chain alone rather than
  inserting a step that would fail every request.
- An explicitly **disabled** step is never re-enabled. Disable is a separate axis from order, so
  silently switching it back on would overrule an intentional edit; the pin skips and says so.

`LOCAL_ROUTER_ROUTES_CONFIG` suppresses the pin: an explicit routes file declares the route set and
its order, and the router must not rewrite it.

The cheaper model (`qwen3-embedding-8b` at $0.010/1M versus $0.020) and the higher-quality model
(`text-embedding-3-large`) are both deliberately excluded. They belong in their own route, not in a
fallback line. The router logs a warning at boot if `fallback-embedding` ever mixes models.

### Width pinning

Providers disagree on default width for the same model (1536 for `-small`, 3072 for `-large` and
`gemini-embedding-2`). All of them honour `dimensions`, so a chain is held to the caller's pinned
width: a step that returns a different width is rejected as `embedding_dimension_mismatch` and the
next step answers. Without a `dimensions` value there is nothing to hold the chain to, so the
request passes through unchanged.

**Callers that maintain an index must pin `dimensions` to the width the index was built with.**

## Why the decision route is a stable name

`typesafe/jev-1.14` is the only typed decision model that exists. The decisions API serves the
`jev-1.13`/`jev-1.14` aliases and nothing else, and OpenRouter's catalog carries a single TypeSafe
entry. There is no cheaper decision model to fall back to, so the chain is not a cost ladder.

What the route buys is a name that survives model churn: a caller writes
`local-router/fallback-decision` and never has to learn which Jev build is current. Provider
failover (OpenRouter → ZenMux, with both attempts recorded) happens inside the transport and is
unchanged.

ZenMux is listed as a decision provider and is pinned in `/v1/models`, but its upstream route
still answers `404 model_not_supported` for `typesafe/jev-1.14`. A pinned ZenMux request records
that 404 and fails over. See [`decisions.md`](./decisions.md).

## Using this from ainish-rag

ainish-rag already prefers the router first in its decision transport
(`local-router → openrouter → jev → local-model`). For embeddings it resolves a remote provider
from environment variables, so pointing retrieval at this router is a configuration change:

```bash
export AINISH_EMBED_API_BASE="http://127.0.0.1:11434/v1"
export AINISH_EMBED_MODEL="local-router/fallback-embedding"
export AINISH_EMBED_DIM="768"        # must match the width the index was built with
export AINISH_EMBED_API_KEY="local-router"   # the router holds the real provider keys
```

The key is a placeholder: the router authenticates to the providers itself. `AINISH_EMBED_DIM` is
what keeps the index consistent, because it is passed through as `dimensions`.

For decisions, point the transport at the route name:

```bash
export JEV_LOCAL_ROUTER_URL="http://127.0.0.1:11434"
export JEV_TRANSPORT_PRIORITY="local-router"
# and send model "local-router/fallback-decision"
```

Do not set `OPENROUTER_API_KEY` to a dummy value to force the router. That key is also used for
remote embeddings, and an invalid value fails the query with a 401 before retrieval runs. Ordering
is controlled by `JEV_TRANSPORT_PRIORITY`.

## Reviewing and editing these routes

Both routes appear on `/config/fallback` alongside `fallback-models`, in the route list and in the
"Fallback Chain" selector, and either can be edited, reordered, disabled per step, or deleted like
any other chain. That page is also what an agent or operator reads to learn which models and
configurations back a route, so its readiness badges must match reality.

`/api/routing/availability` backs those badges. Two things it had to get right, both fixed when
these routes were added:

- A **catalogued** model is not the same as a **chat-served** model. Embedding models are
  catalogued but never curated for chat, so a check that required "served" reported every
  embedding step as `unavailable` on a route that answered fine.
- A typed decision model carries no provider in its id. The generic path read `typesafe/jev-1.14`
  as provider `typesafe` and reported `no_key`; it now reports the real decision transport
  (`openrouter`) and `ready` when any decision provider holds a key.

A wrong badge is worse than no badge: an operator who reads "Unavailable" on a working route will
either rewrite a good chain or stop trusting the page.

## Measured cost per 1M tokens (2026-11-06)

Read from the `usage` block each provider returned, not from a price page.

| Provider | Model | $/1M |
|---|---|---|
| nous-portal | `qwen/qwen3-embedding-8b` | 0.0100 |
| openrouter | `openai/text-embedding-3-small` | 0.0200 |
| zenmux | `openai/text-embedding-3-small` | 0.0200 |
| nous-portal | `openai/text-embedding-3-small` | 0.0200 |
| openrouter | `openai/text-embedding-3-large` | 0.1300 |
| nous-portal | `openai/text-embedding-3-large` | 0.1300 |
| nous-portal | `google/gemini-embedding-2` | 0.2000 |

ZenMux does not report per-call cost; its published sheet (`pricings.prompt[].value`, per 1M
tokens) gives small 0.02, large 0.13, `gemini-embedding-2` 0.20, `qwen3-vl-embedding` 0.10.

OpenRouter advertises **zero** embedding models (0 of 458 in its catalog) yet serves
`openai/text-embedding-3-*` on `/v1/embeddings` and bills correctly. Never infer embedding support
from a provider's model list; probe the route.

## Operating notes

- Routes are seeded on first boot and only when absent or empty. An operator edit is never
  overwritten. Setting `LOCAL_ROUTER_ROUTES_CONFIG` suppresses seeding entirely, because an
  explicit routes file owns the route set.
- `fallback-embedding` is a purpose route, so it bypasses the chat capability filter. That filter
  looks each step up in the chat catalog, finds no entry for an embedding model, and would drop
  every step — leaving zero candidates.
- The provider order in `fallback-embedding` is a **rule, not a default**. An operator edit that
  contradicts it is corrected on write rather than only at the next boot; see "Provider order is
  pinned" above for the boundaries that enforce it and the three exceptions.
- `/api/fallback-models` lists all three routes. Address a route by id rather than by index; the
  set now contains more than one entry.
