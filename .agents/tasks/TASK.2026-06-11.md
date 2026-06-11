# TASK.2026-06-11.md

## CoD
1. Add pioneer provider.
2. Add pioneer model specifications.
3. Configure Pioneer's Minimax M3.
4. Set cache TTL.
5. Set cache retention.
6. Verify and pass tests.

####
We integrated Pioneer as a new provider, added Pioneer's Minimax M3 model as the primary fallback and AutoRouter candidate, and optimized prompt caching across all supported models and providers.

### Summary of Changes

1. **Integrated Pioneer Provider**:
   - Endpoint: `https://api.pioneer.ai/v1`
   - Key: `PIONEER_API_KEY`
   - Models Added:
     - `minimax/minimax-m3` (1M context, 512k output, support tools, image, cache, reasoning)
     - `Qwen/Qwen3-8B` (32.7k context, 8k output, support tools, cache)
     - `fastino/gliner2-base-v1` (8k context, 2k output, support tools)

2. **Router Config Updates**:
   - Modified `src/routing-defaults.ts` to place `pioneer-minimax-m3` as the primary model in the fallback router (`DEFAULT_FALLBACK_ORDERED_IDS`) and at the top of the AutoRouter (`AUTO_ROUTER_EXTRA_CANDIDATE_IDS`).
   - Retained Gemini and GPT models for GitHub Copilot only.
   - Retained Gemini and Sonnet models for Antigravity.
   - Removed all other Claude and GPT models from the router candidates.

3. **Optimized Prompt Caching**:
   - Enabled prompt caching for Pioneer across ALL models (e.g. Minimax M3, Qwen3-8B, gliner2) by injecting `cache_control` with `ttl: "1h"` to maximize cache hits.
   - For all other providers (ZenMux, Cline, Kilo, OpenRouter, OpenCode, Xiaomi-Mimo, Wafer-Serverless), prompt caching via `cache_control` is injected to the system prompt and conversation history on all non-OpenAI models.
   - Enabled OpenRouter edge response caching by injecting `'X-OpenRouter-Cache': 'true'` to the headers of all OpenRouter and OpenRouter-presets requests.
   - For Z.ai models, set `clear_thinking: false` to keep reasoning KV warm and maximize prefix cache hits.

4. **Verification**:
   - Updated `tests/prompt-caching.test.mjs` verifying caching logic for Pioneer Minimax M3, ZenMux Minimax M3, and Pioneer DeepSeek.
   - Verified that all unit tests pass cleanly.
