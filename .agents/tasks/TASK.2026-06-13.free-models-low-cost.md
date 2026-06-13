# Task: Configure Free Models on low-cost Router

## Chain-of-Draft
- Create task file.
- Inspect current low-cost configuration.
- Filter candidates to free.
- Select one per provider.
- Update presets configurations.
- Update docs and README.
- Verify tests build cleanly.

####
- Modified `src/routing-defaults.ts` to restrict the `low-cost` preset router candidates list to exactly one free model per configured provider:
  1. `ollama-nemotron-3-ultra-cloud`
  2. `nvidia-nim-minimax-m3`
  3. `cline-nvidia-nemotron-3-ultra-550b-a55b-free`
  4. `kilo-nvidia-nemotron-3-ultra-550b-a55b-free`
  5. `opencode-zen-minimax-m3-free`
  6. `openrouter-free`
- Updated `llms.txt` to reflect the new count (6 candidates instead of 16) and description.
- Updated `README.md` to document the 4 consolidated built-in preset routes and their correct candidate count.
