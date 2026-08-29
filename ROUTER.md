# Local Router Fallback Chains — Maintainer Guide

This document is the working guide for agents and maintainers improving Local Router's fallback-chain system. Keep it current when changing chain defaults, the toggle/reorder API, or the fallback-builder UI.

> **2026-08-23:** The auto-router system (scored router models `auto-local` / `pareto-code` / `priority` / `bandit-local`, `router-models.json`, `router-events.csv`/`router-candidates.csv` telemetry, bandit/tier tooling, and the `/config` Router Models page) was removed. Routing is now exactly two shapes: a **direct provider model** or an **explicit fallback chain**. All auto-routing research notes were retired with the system.

## How Routing Works (User Summary)

Local Router exposes two request paths:

1. **Direct model** — e.g. `zenmux-deepseek-v4-pro`. One upstream call. On failure, cascades to the system fallback chain (`fallback-models`) when configured.
2. **Fallback chain** — `local-router/<chain-id>`. Ordered retry chain with backoff. `local-router/fallback-models` is the system safety net; when a non-system chain exhausts, the request cascades into the system chain.

Recommended out-of-box chain: `local-router/performance` (subscriptions/credits first) or `local-router/free` (no-cost models only). The system chain `local-router/fallback-models` catches everything below them.

Candidates/steps availability in `/config` shows **Ready** (key configured), **No key**, or **Unavailable**. Chain steps without configured keys are skipped immediately (no retry backoff).

## Fallback Chain Design

- A chain is a plain ordered list of provider model ids, persisted in `~/.config/local-router/fallback-models.json` (`{ "version": 1, "models": [{ id, models: string[], disabledModels?: string[] }] }`).
- Steps may carry per-step enable flags (`disabledModels`) — a disabled step stays in the chain but is skipped at request time.
- Chain ids must not reference other `local-router/*` routes (no cycles).
- Steps resolve against the live provider catalog; unknown or unconfigured steps are skipped deterministically.

## Built-in Chains (src/routing-defaults.ts)

Bootstrapped on first run when missing (`ensureDefaultFallback()` + `ensurePresetRoutes()`). Order is **fixed** at bootstrap; users re-shape it live afterwards.

| Chain | Steps | Purpose |
|---|---|---|
| `fallback-models` (system) | 24 | Global safety net: Ollama Cloud → NIM → Cline/Kilo free → Zen free → Modal → Nous free → OAuth subscriptions → Z.ai/Xiaomi → Pioneer → Go/CommandCode → Nebius/Wafer → Kilo/Cline paid → ZenMux/OpenRouter paid → OpenRouter free |
| `free` | 21 | Every no-cost model across providers, quality-first; maximizes free-tier usage before any paid hop |
| `performance` | 18 | Subscription + prepaid-credit models, quality-first; spends already-paid capacity before metered billing |
| `multimodal` | 15 | Vision-capable curated chain |

Ensure-preset deletes persisted chains whose id is in `OBSOLETE_PRESET_ROUTE_IDS` — add ids there when retiring a preset (never remove entries; older deployments may still carry them).

## Live Chain Configuration

### UI

- **Providers & Models page** — every catalog model row has a *fallback* checkbox bound to the chain chosen in the **Fallback Chains** panel selector (`fallback-models` by default). Ticking appends the model to the selected chain; unticking removes it. The panel's list is drag-reorderable and autosaves. Removing refreshes across live model-list refreshes, so newly discovered models are toggleable immediately.
- **Fallback Routes page** — multi-chain authoring: text/bulk editing, per-step enable/disable, drag-reorder, import/export, delete.

### API

- `GET /api/fallback-models` — list all chains (`{ id, routeId, models, disabledModels, display }`).
- `POST /api/fallback-models` — create/replace a chain (`{ id, modelsText | models }`).
- `DELETE /api/fallback-models` — delete a chain (`{ id }`).
- `POST /api/fallback-chain/toggle` — `{ modelId, enabled, routeId? }`: append/remove one model in the selected chain. `routeId` defaults to `fallback-models`; the unknown-model case is 400, the unknown-chain case is 404 (non-system chains must exist first).
- `POST /api/fallback-chain/reorder` — `{ orderedIds, routeId? }`: replace step ordering; `orderedIds` must match the chain's current model set exactly (409 on mismatch).
- `GET /api/routing/availability?models=a,b` — per-model Ready/No key/Unavailable (used by the UI badges).

## Request-Time Behavior

- Chains execute in stored order with retry backoff; `disabledModels` steps and steps without configured keys are skipped immediately.
- On full exhaustion, a non-system chain cascades into the system `fallback-models` chain; the system chain failing returns the upstream error.
- Fallback stages strip/forward everything like direct calls (caching injection, thinking levels, and reasoning-content rules apply equally).

## Improvement Loop

1. Edit chains in `/config` or via the API (toggles, reorder, or full-route POST).
2. Inspect behavior in expert logs (GET /api/expert-logs) and console output.
3. Run the fallback tests: `tests/fallback-*.test.mjs`, `tests/fallback-chain-toggle.test.mjs`, `tests/execution-plan.test.mjs`.
4. Update `llms.txt` and this document when default chains or the API shape changes.

## Safety Checklist

- No hidden model pools — chains are explicit, persisted, user-visible JSON.
- No external routing service by default.
- No prompt/response persistence.
- No secrets in JSON exports or chain metadata.
- No local path leakage in logs.
- No classical cryptography additions.
- No merge to main without user approval.
