# TASK 2026-08-20 — Honest provider model discovery

## Read
- User: zai stale, cline incomplete.
- User: refresh must query ALL models.
- User: /v1/models = all toggled, prefixed.
- Probe: zai key 401 everywhere (dead).
- Probe: zai + cline have NO /models API.
- Old code: silent static-catalog fallback.
- Multi-shape parse existed only in probe.mjs.

####

## Design
- Discovery sources: live | registry | catalog.
- Live: /models fetch, data/models/array shapes.
- Registry: providers.txt rows ∪ verified extras.
- Registry-only providers: zai, cline (documented).
- zai extras: GLM-5.3, GLM-5-Turbo, GLM-4.7 (docs).
- cline extras: kimi-k3, kimi-k2.7-code, qwen3.7-plus,
  glm-5.2, nemotron paid twin (docs + models.dev).
- Every refresh reports source + human note.
- Serving gate unchanged (curation + prefix).

## Execute
- provider-model-registries.ts module.
- fetchLiveProviderModels → LiveModelsResult.
- No silent catalog fallback; notes everywhere.
- mapLiveRawModelsToCatalog honors hints.
- Refresh/keys payloads carry source + note.
- UI notes show source label.

## Verify
- tsc clean; integration tests green.
- zai refresh → registry, GLM-5.3 present.
- cline refresh → registry > 11 models.
- Toggle + activate → /v1/models prefixed.
- Page scripts parse.

## Audit
- Registries = public model ids, no secrets.
- zai key dead — user must re-enter.
- No banned crypto. Template literals clean.
