# Task: Add Kimi K2.7 Non-Free & Remove Old Kimi Models

## Chain-of-Draft
- Create task file.
- Inspect Kimi models across providers.
- Probe live provider API models.
- Determine upgraded providers.
- Upgrade zenmux, moonshot, opencode, kilo.
- Keep k2.6 for nebius, nim, ollama, cline, pioneer.
- Map presented IDs correctly.
- Verify tests build cleanly.

####
- Probed live provider `/v1/models` endpoints to identify which providers have added the new Kimi K2.7 model:
  - Upgraded to `kimi-k2.7-code` or `moonshotai/kimi-k2.7-code`: `moonshot`, `opencode-go`, `zenmux`, and `kilo`.
  - Retained `kimi-k2.6` / `Kimi-K2.6`: `nebius`, `nvidia-nim`, `ollama`, `cline`, and `pioneer`.
- Updated `providers.txt` to replace Kimi K2.6 with `kimi-k2.7-code` for `moonshot`, `opencode-go`, `zenmux`, and `kilo` (while restoring Kimi K2.6 for the other providers).
- Configured presented model IDs for the Kimi K2.7-code models:
  - `opencode-go` -> `opencode-go-kimi-k2.7-code`
  - `kilo` -> `kilo-moonshotai-kimi-k2.7-code-paid`
- Registered these new presented IDs in `src/routing-defaults.ts` (`CANDIDATE_DEFAULTS`, `AUTO_ROUTER_EXTRA_CANDIDATE_IDS`) and `src/provider-pricing.ts`.
- Mapped client aliases in `src/index.ts` (`UPSTREAM_MODEL_ID_ALIASES`) for Kimi K2.7-code.
- Restored `cline-moonshotai-kimi-k2.6-paid` and `nvidia-nim-kimi-k2.6` in `routing-defaults.ts` for Cline, Nvidia NIM, and the `multimodal` preset route.
- Restored `kimi-k2.6:cloud` in `src/ollama-cloud-catalog.ts`.
