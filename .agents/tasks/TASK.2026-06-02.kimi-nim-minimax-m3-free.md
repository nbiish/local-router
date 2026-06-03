# TASK.2026-06-02.kimi-nim-minimax-m3-free.md

## Date: 2026-06-02
## Branch: feature/kimi-nim-minimax-m3-free
## Base: develop @ 38c82d9

####
CoD reasoning (≤5 words/step):
- Task adds two new model entries.
- providers.txt is source of truth.
- Existing catalog has 78 models, 12 providers.
- Need to add NVIDIA NIM K2.6.
- Need to add opencode minimax-m3-free.
- Update llms.txt to reflect additions.
- Update auto-router defaults optionally.
- Build, test, commit, ask user.

####
####
Step 1: Read PRD anchor.
- llms.txt: lines 209-217 list providers.
- llms.txt: line 240 lists nvidia-nim models.
- llms.txt: line 292 lists NVIDIA NIM K2.6 doc ref.
- llms.txt: line 247 lists opencode-zen minimax-m3-free.
- providers.txt: lines 227-240 nvidia-nim section.
- providers.txt: lines 277-299 opencode section.
- providers.txt: line 76 opencode-zen minimax-m3-free exists.

####
Step 2: Verify endpoint availability.
- NVIDIA NIM: docs.api.nvidia.com/nim/reference/moonshotai-kimi-k2-6
- Model ID format: moonshotai/kimi-k2.6
- 256K context, 32,768 output per nebius reference.
- Tools YES, Vision YES, Cache YES.
- Reasoning NO* (VS Code compatibility).
- Opencode Zen/Go: minimax-m3-free on Zen endpoint.
- Adding to opencode (Zen/Go) provider for opc: prefix.

####
Step 3: Add providers.txt rows.
- Row #79: nvidia-nim moonshotai/kimi-k2.6
- nvnm:kimi-k2.6 presentation
- 256,000 context, 32,768 output
- Tools YES, Vision YES, Cache YES
- Reasoning NO* (VS Code compat)
- Row #80: opencode minimax-m3-free
- opc:minimax-m3-free presentation
- 512,000 context, 512,000 output
- Tools YES, Vision YES, Cache YES
- Reasoning YES* (native, stripped for VS Code)

####
Step 4: Update providers.txt header.
- nvidia-nim: 3 → 4 models
- opencode: 19 → 20 models
- Master model spec: 78 → 80 rows
- Cross-tool matrix unchanged
- nvidia-nim/opencode already YES for all tools

####
Step 5: Update llms.txt.
- Provider Catalog: nvidia-nim 5 models
- Add nvidia-nim moonshotai/kimi-k2.6 to Notable specs
- Add opencode provider minimax-m3-free
- Add kimi-k2.6 to Prompt Caching table (implicit)
- Update active providers: 12 providers, 80 models
- Update model count 78 → 80 in TL;DR
- Add to Key Model Metadata section

####
Step 6: Update auto-router defaults.
- Add nvidia-nim-kimi-k2.6 candidate
- coding=0.86, input=0.6, output=2.5, latency=850
- notes: NVIDIA NIM Kimi K2.6 256K ctx coding
- Add opencode-minimax-m3-free candidate
- coding=0.80, input=0, output=0 (free), latency=900
- notes: OpenCode MiniMax M3 free tier 512K ctx
- Total candidates: 14 → 16

####
Step 7: Build and test.
- npm run build: must pass clean
- npm test: must pass 1/1
- Verify providers.txt parses correctly
- Confirm model counts

####
Step 8: Commit on feature branch.
- Atomic commit with all changes
- Update llms.txt with task reference
- Ask user for merge to develop

####
####

## Files Modified

1. `providers.txt` — Add rows #79-80, update header counts
2. `llms.txt` — Update catalog, metadata, caching, model count
3. `src/index.ts` — Add 2 candidates to DEFAULT_ROUTER_CANDIDATES_TEXT
4. `.agents/tasks/TASK.2026-06-02.kimi-nim-minimax-m3-free.md` — this file

## Out of Scope

- No code changes to provider modules
- No API endpoint additions
- No router framework changes
- No new PQC or signature work

## Security Audit

- No API keys in providers.txt
- No banned crypto (no crypto changes)
- No .env modifications
- No secrets in tasks
- All PQC keys already loaded at startup
