# TASK 2026-06-04 — Ollama free-tier routing

- User: narrow Ollama quota
- Keep: nemotron + minimax-m3
- Free fallback: deepseek-v4-flash
- Pro-only: gate placeholder key
- Prune: router + fallback chains
- Pull: free tags only

####

- `src/ollama-cloud-catalog.ts` — tier map + allowlists
- `DEFAULT_ROUTER_CANDIDATES_TEXT` — 3 Ollama lines
- `pruneDisallowedOllamaCloudRouting()` on migrate + PQC load
- `providers.txt` — free vs Pro annotations
