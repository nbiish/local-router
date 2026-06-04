# TASK 2026-06-04 — auto-router-main + pricing overrides

## Chain-of-Draft

- Rename default router id
- ZenMux qwen matched rates
- Wafer MiniMax-M3 promo
- Persist provider-pricing.json
- /config pricing panel
- providers.txt factual USD/M
- Tests green (6/6)

####

## Deliverables

- `local-router/auto-router-main` (alias `auto-local-main`)
- `src/provider-pricing.ts` + `GET/PUT/DELETE /api/provider-pricing`
- `/config` → Model Pricing Overrides
- Baseline: zenmux-qwen3.7-max 2.5/7.5, wafer-ai-minimax-m3 0.33/1.32
