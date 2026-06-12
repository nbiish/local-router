# TASK.2026-06-12.nvidia-nim-minimax-m3-free

## CoD
- probe confirmed nim hosts minimax-m3
- operator flagged nim free
- update existing nvidia-nim-minimax-m3
- change pricing to 0/0
- update providers.txt tier
- update free-tier comment

####
NVIDIA NIM now offers minimaxai/minimax-m3 for free (operator-confirmed 2026-06-12). Updated the existing nvidia-nim-minimax-m3 presented ID from paid to free across providers.txt tier cell, src/routing-defaults.ts CANDIDATE_DEFAULTS (input/output 0/0), and src/provider-pricing.ts ($0/$0 baseline). Updated the "Free-tier MiniMax M3 lives on opencode-zen only" comment in providers.txt to reflect that NIM is now also a free provider for this model.
