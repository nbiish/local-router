# Task: `glm-5.4` 1M Context & Sourced `docs/providers.txt` Reference

- lane: now
- branch: `feat/glm54-context-and-providers-doc`
- worktree: `C:/Users/kenwa/code-external/local-router-worktrees/feat-glm54-providers-doc`
- status: done
- plan: `.agents/plans/2026-11-25-13-glm54-context-and-providers-doc.md`
- scope: `.gitignore`, `src/model-specs.json`, `src/model-metadata.ts`, `src/provider-model-registries.ts`, `docs/caching/zai.txt`, `docs/providers.txt`, `scripts/generate-providers-doc.mts`, `package.json`, `llms.txt`, `tests/model-context-metadata.test.mjs`
- objective: Investigate `glm-5.4` 1M context/output/modality/reasoning specs live, fix `model-metadata` reconciliation (including `-legal` and `[1m]` aliases), audit all providers against live `/models` + docs, and generate sourced `docs/providers.txt`.
- findings:
  - Live `:11434` WSL systemd (`local-router-ensure.service`) restarted onto merged `D:\Workspace\local-router` (`5f6a606`); `agents-doctor.js` exited `0` (`Hermes 6/6 ctx profiles`, `pi models.json`).
  - Root cause of `zai-glm-5.4` and `zai-glm-5.3-flashx-legal` caching at `64000`/`4096`: Z.ai `/models` omits token limits, `glm-5.4` was absent from `src/model-specs.json` and `src/provider-model-registries.ts`, and `normalizeModelAlias()` did not strip `-legal`.
  - `docs.z.ai` + live `:11434` probe (`zai/glm-5.4` HTTP `200`, `reasoning_tokens: 1`): `glm-5.4` supports `1,000,000` (1M) context, `131,072` (128K) max output, text/image/video/file inputs, and Loop Transformer thinking (`thinking.type` / `reasoning_effort` low/high/max); Coding Plan rollout (`glm-5.4`, `glm-5.4[1m]`, `1.5x` weekly quota vs GLM-5.3; standalone PAYG API rate not yet published).
  - Live `/models` sweep across 23 `PROVIDER_REGISTRY` entries: 12 public/keyless endpoints returned HTTP `200` (`glm54=[]`); 11 auth-gated endpoints returned `400`/`401`/`403`/`404` when unkeyed.
- verification:
  - `npm run build` (`tsc`): passed (exit `0`).
  - `npm run docs:providers`: generated deterministic `docs/providers.txt` (`140547 bytes`), SHA-256 matched across back-to-back runs (`PROVIDERS_HASH_MATCH=True`).
  - `npm run validate:model-specs`: `262/1349 rows matched` (`zai/glm-5.4` matched with zero errors/warnings); exited `1` solely due to pre-existing baseline (`90 errors, 35 warnings` on unrelated rows such as `kimi-k3`, `mimo-v2.5`, `step-3.7-flash`).
  - `node --test --test-concurrency=1 tests/model-context-metadata.test.mjs tests/model-context-boot.integration.test.mjs tests/provider-policy-matrix.test.mjs tests/provider-policy-docs.test.mjs tests/agent-hermes-pi-config.test.mjs`: `44/44` passed (`0` failed).
  - Live `:11434` `/v1/models` read-back of `zai-glm-5.4` at `1000000` remains pending until this PR merges and `D:\Workspace\local-router` is pulled/built/restarted.
