# TASK.2026-06-12.model-lifecycle-skills

## CoD
- read llms.txt PRD
- worktree from develop
- locate files touched on add/remove
- design 3 skills
- model-add covers providers.txt/model-specs
- model-remove covers reverse mapping
- provider-models-list covers /v1/models
- validate path structure

####
Three skills authored under .agents/skills/ for the long-term model lifecycle: model-add, model-remove, provider-models-list. They cover catalog (`providers.txt`), canonical specs (`src/model-specs.json`), routing (`src/routing-defaults.ts`, `src/routing-exhaustion-order.ts`, `src/gateway-provider-catalog.ts`, `src/ollama-cloud-catalog.ts`), pricing (`src/provider-pricing.ts`), and live upstream `/v1/models` discovery for all 17 providers.
