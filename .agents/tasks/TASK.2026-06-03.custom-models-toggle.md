# Task: Custom Models Toggle & Refresh Button

## Chain of Draft
- read llms.txt PRD
- git context → worktree
- model source state → persist
- endpoint cache → query upstream
- config UI → toggle + refresh
- integration tests → pass
####

## Tasks

- [x] Add model source configuration state and persistence
- [x] Implement endpoint models caching on server
- [x] Update fallback provider model querying with fetch timeout
- [x] Add API routes for setting source and triggering refresh
- [x] Integrate toggle, refresh button, and description in `/config` UI
- [x] Verify functionality via automated and manual smoke tests

## API

- `GET /api/model-source` — `{ source: "custom" | "endpoints" }`
- `PUT /api/model-source` — set `{ source }`
- `POST /api/refresh-endpoint-models` — query configured providers, cache results

## Persistence

- `~/.config/local-router/model-source-config.json` (`0600`)
- `~/.config/local-router/endpoint-models-cache.json` (`0600`)

## UI

- Custom Models (providers.txt / edits) — default
- Endpoint Models (query upstream) — shows Refresh button
- Auto-refresh when switching to endpoints with empty cache
