/**
 * Default system fallback chains and preset fallback routes.
 *
 * The auto-router system was removed (2026-08-23): routing is either a
 * direct provider model or an explicit user-configured fallback chain.
 * The system chain `fallback-models` uses a fixed 24-step curated order;
 * users re-shape it live from the Providers & Models page toggles.
 * Presets `free` and `performance` seed additional curated chains that
 * exhaust into the system chain like any fallback route.
 */

// User-curated 24-step fallback chain. The order places the Nous Portal
// free Step 3.7 Flash above the subscription band (so a free model is
// always tried before any subscription bucket), keeps the OAuth /
// subscription band in the middle (Antigravity, GitHub Copilot, Z.ai,
// Xiaomi, OpenCode Go, CommandCode), and places the remaining Nous
// Portal MiniMax M3 just after the Cline DeepSeek V4 Pro paid anchor
// in the paid tail.
export const DEFAULT_FALLBACK_ORDERED_IDS: readonly string[] = [
  'ollama-nemotron-3-ultra-cloud',
  'nvidia-nim-minimax-m3',
  'cline-minimax-minimax-m3-free',
  'kilo-stepfun-step-3.7-flash-free',
  'opencode-zen-minimax-m3-free',
  'modal-glm-5.1-fp8',
  'modal-proxy-kimi-k3',
  'nous-portal-step-3.7-flash-free',
  'antigravity-gemini-3.5-flash',
  'github-copilot-gemini-3.1-pro',
  'zai-code-pass-glm-5.1',
  'xiaomi-mimo-mimo-v2.5-pro',
  'pioneer-minimax-m3',
  'opencode-go-deepseek-v4-pro',
  'nebius-nemotron-3-ultra-550b-a55b',
  'commandcode-deepseek-v4-pro',
  'wafer-ai-deepseek-v4-flash',
  'kilo-minimax-minimax-m3-paid',
  'cline-deepseek-deepseek-v4-pro-paid',
  'nous-portal-minimax-m3',
  'zenmux-mimo-v2.5-pro',
  'openrouter-chain-of-draft',
  'openrouter-kimi-k2.7-code',
  'openrouter-free'
] as const;

export function buildDefaultFallbackModelIds(): string[] {
  return [...DEFAULT_FALLBACK_ORDERED_IDS];
}

export function buildDefaultFallbackModelsText(): string {
  return buildDefaultFallbackModelIds().join('\n');
}

// ---------------------------------------------------------------------------
// Preset Route Definitions
// ---------------------------------------------------------------------------

/** A preset fallback route: fixed ordered retry chain. */
export type PresetFallbackRoute = { id: string; models: readonly string[] };

export const PRESET_FALLBACK_ROUTES: readonly PresetFallbackRoute[] = [
  {
    // Quality-first chain of every no-cost model across providers: free
    // tiers, free promotions, and the operator's own Modal deployment.
    // Maximizes free usage before the system chain starts spending.
    id: 'free',
    models: [
      'modal-proxy-kimi-k3',
      'zenmux-kimi-k2.7-code-free',
      'ollama-nemotron-3-ultra-cloud',
      'cline-nvidia-nemotron-3-ultra-550b-a55b-free',
      'kilo-nvidia-nemotron-3-ultra-550b-a55b-free',
      'nvidia-nim-minimax-m3',
      'cline-minimax-minimax-m3-free',
      'ollama-deepseek-v4-flash-cloud',
      'cline-deepseek-deepseek-v4-flash-free',
      'kilo-stepfun-step-3.7-flash-free',
      'nous-portal-step-3.7-flash-free',
      'ollama-minimax-m3-cloud',
      'kilo-nvidia-nemotron-3-super-120b-a12b-free',
      'opencode-zen-minimax-m3-free',
      'cline-xiaomi-mimo-v2.5-free',
      'kilo-nvidia-nemotron-3-nano-omni-30b-a3b-reasoning-free',
      'openrouter-free',
      'kilo-openrouter-free',
      'opencode-zen-deepseek-v4-flash-free',
      'kilo-poolside-laguna-m.1-free',
      'kilo-poolside-laguna-xs.2-free',
    ] as const,
  },
  {
    // Quality-first chain of subscription and prepaid-credit models:
    // OAuth/provider subscriptions first, then promo/paid credits.
    // Maximizes already-paid capacity before metered paid billing.
    id: 'performance',
    models: [
      'antigravity-gemini-3.5-flash',
      'antigravity-gemini-3.1-pro',
      'github-copilot-gemini-3.1-pro',
      'nous-portal-minimax-m3',
      'opencode-go-deepseek-v4-pro',
      'antigravity-claude-opus-4-6',
      'antigravity-claude-sonnet-4-6',
      'zai-code-pass-glm-5.1',
      'commandcode-deepseek-v4-pro',
      'xiaomi-mimo-mimo-v2.5-pro',
      'pioneer-minimax-m3',
      'wafer-ai-minimax-m3',
      'zenmux-minimax-m3',
      'wafer-ai-deepseek-v4-pro',
      'wafer-ai-glm-5.1',
      'kilo-minimax-minimax-m3-paid',
      'nebius-deepseek-v4-pro',
      'cline-deepseek-deepseek-v4-pro-paid',
    ] as const,
  },
  {
    id: 'multimodal',
    models: [
      'nvidia-nim-minimax-m3',
      'cline-minimax-minimax-m3-free',
      'kilo-stepfun-step-3.7-flash-free',
      'opencode-zen-minimax-m3-free',
      'nous-portal-step-3.7-flash-free',
      'antigravity-gemini-3.5-flash',
      'github-copilot-gemini-3.1-pro',
      'zai-code-pass-glm-4.6v',
      'xiaomi-mimo-mimo-v2.5',
      'commandcode-minimax-m3',
      'pioneer-minimax-m3',
      'wafer-ai-minimax-m3',
      'kilo-minimax-minimax-m3-paid',
      'openrouter-chain-of-draft',
      'openrouter-kimi-k2.7-code',
    ] as const,
  },
] as const;

/**
 * One-time migration list: preset fallback route IDs that have been
 * removed from `PRESET_FALLBACK_ROUTES`. `ensurePresetRoutes()` deletes
 * any persisted fallback route matching these IDs on startup so
 * historical configurations converge to the current preset set.
 *
 * Add a route ID here when a preset is removed or merged; do not remove
 * IDs once added (older deployments may still have them on disk).
 */
export const OBSOLETE_PRESET_ROUTE_IDS: readonly string[] = [
  'preferred-text',
  'preferred-multimodal',
  'performance-text',
  'performance-multimodal',
  'low-cost-text',
  'low-cost-multimodal',
] as const;
