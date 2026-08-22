# TASK 2026-08-22 — PQC bundle sync + LOCALROUTER_ namespace

## Read
- User: bundle keys not shown configured.
- User: keys must carry LOCALROUTER_
  prefix to split from ambient names.
- Root failure: uv cold-cache download >
  30s spawn timeout (ETIMEDOUT, cryptography
  4.5MiB) — matches prod decrypt failure.

####

## Execute
- syncKeysFromPqcBundle refactor: 120s
  timeout, cooldown 30s, stderr surfaced.
- pqcBundleProviders + uiSavedProviderKeys
  split; configuredSource precedence
  memory>pqc>env>oauth.
- POST /api/pqc-resync {force}; UI button +
  silent fire-and-rerender sync.
- localRouterEnvVarName helper; providerEnv
  KeyValue prefers namespaced; set/clear/
  fetch/gate/delete all rewired; delete
  never scorches ambient plain names.
- llms.txt: namespace + resync endpoint.

## Verify
- Cold-uv repro: ETIMEDOUT -> fixed 120s.
- External bundle (CLI-packed kilo/zai):
  boot logs Loaded 2, badges source=pqc.
- Namespaced ambient: LOCALROUTER_ZENMUX_
  API_KEY -> configured env. Suite 114/114.

## Audit
- No values logged; names/badges only.
