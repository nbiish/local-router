# Task: Add ZenMux Kimi K2.7 Free Model

## Chain-of-Draft
- Create task file.
- Inspect provider configurations.
- Add Kimi row to specs.
- Insert Kimi row to providers.
- Add Kimi to low-cost candidates.
- Update docs and README.
- Verify tests build cleanly.

####
- Added `kimi-k2.7` to `src/model-specs.json` with appropriate context window (262,144 tokens) and output limits.
- Added `moonshotai/kimi-k2.7-code-free` under the `zenmux` provider in `providers.txt`.
- Added default configuration metadata for `zenmux-kimi-k2.7-code-free` under `CANDIDATE_DEFAULTS` in `src/routing-defaults.ts` (coding=0.87, input=0, output=0).
- Added `zenmux-kimi-k2.7-code-free` to `AUTO_ROUTER_EXTRA_CANDIDATE_IDS` and the `low-cost` candidate list.
- Updated candidate count for `low-cost` from 6 to 7 in `llms.txt` and `README.md`.
