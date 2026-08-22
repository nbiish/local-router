/**
 * In-code provider registry — the factual successor to the providers.txt
 * summary table (retired 2026-08-20). One row per upstream provider the
 * router knows how to reach: slug, OpenAI-compatible base endpoint, and the
 * PQC-bundle/env key variable that authenticates it.
 *
 * Model lists live in src/provider-model-registries.ts (factual per-provider
 * catalogs for discovery); this file is providers only. Adding a provider is
 * a code edit here (plus registry models, pricing, routing defaults).
 */

export interface ProviderRegistryEntry {
  name: string;
  endpoint: string;
  keyEnvVar: string;
  /** Short factual note shown in docs/PRD where useful. */
  note?: string;
}

export const PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = [
  {
    name: 'wafer-serverless',
    endpoint: 'https://pass.wafer.ai/v1',
    keyEnvVar: 'WAFER_SERVERLESS_API_KEY',
    note: 'Wafer serverless pass (replaced deprecated wafer-pass 2026-05-26)'
  },
  { name: 'zenmux', endpoint: 'https://zenmux.ai/api/v1', keyEnvVar: 'ZENMUX_API_KEY' },
  { name: 'nebius', endpoint: 'https://api.tokenfactory.nebius.com/v1', keyEnvVar: 'NEBIUS_API_KEY' },
  { name: 'moonshot', endpoint: 'https://api.moonshot.ai/v1', keyEnvVar: 'MOONSHOT_API_KEY' },
  { name: 'nvidia-nim', endpoint: 'https://integrate.api.nvidia.com/v1', keyEnvVar: 'NVIDIA_NIM_API_KEY' },
  { name: 'modal', endpoint: 'https://api.us-west-2.modal.direct/v1', keyEnvVar: 'MODAL_API_KEY' },
  {
    name: 'modal-proxy',
    endpoint: 'https://nbiish--ep-kimi-k3-nbiish-server.us-west.modal.direct/v1',
    keyEnvVar: 'MODAL_PROXY_API_KEY',
    note: 'Nbiish Kimi-K3 own deployment'
  },
  { name: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', keyEnvVar: 'OPENROUTER_API_KEY' },
  { name: 'xiaomi-mimo', endpoint: 'https://token-plan-sgp.xiaomimimo.com/v1', keyEnvVar: 'XIAOMI_MIMO_API_KEY' },
  { name: 'opencode-go', endpoint: 'https://opencode.ai/zen/go/v1', keyEnvVar: 'OPENCODE_API_KEY' },
  { name: 'opencode-zen', endpoint: 'https://opencode.ai/zen/v1', keyEnvVar: 'OPENCODE_ZEN_API_KEY' },
  { name: 'zai', endpoint: 'https://api.z.ai/api/coding/paas/v4', keyEnvVar: 'ZAI_API_KEY', note: 'GLM Coding Plan; anthropic base at /api/anthropic' },
  { name: 'ollama', endpoint: 'http://127.0.0.1:11435/v1', keyEnvVar: 'OLLAMA_API_KEY', note: 'Local backend; cloud tags served via ollama signin session' },
  { name: 'cline', endpoint: 'https://api.cline.bot/api/v1', keyEnvVar: 'CLINE_API_KEY' },
  { name: 'kilo', endpoint: 'https://api.kilo.ai/api/gateway', keyEnvVar: 'KILO_API_KEY' },
  { name: 'commandcode', endpoint: 'https://api.commandcode.ai/provider/v1', keyEnvVar: 'COMMANDCODE_API_KEY', note: 'Provider API base; /alpha/generate retired' },
  { name: 'antigravity', endpoint: 'https://generativelanguage.googleapis.com/v1beta', keyEnvVar: 'ANTIGRAVITY_API_KEY', note: 'Google AI Studio (Gemini API) surface' },
  { name: 'github-copilot', endpoint: 'https://api.githubcopilot.com', keyEnvVar: 'GITHUB_COPILOT_API_KEY' },
  { name: 'pioneer', endpoint: 'https://api.pioneer.ai/v1', keyEnvVar: 'PIONEER_API_KEY' },
  { name: 'nous-portal', endpoint: 'https://inference-api.nousresearch.com/v1', keyEnvVar: 'NOUS_API_KEY' }
] as const;

/** Cached summary shape consumed by the router (mirrors the old parser output). */
export interface CatalogProviderSummary {
  name: string;
  endpoint: string;
  keyEnvVar: string;
  defaultTool: string;
  source: 'catalog';
}

let summaryCache: CatalogProviderSummary[] | null = null;

/** Provider summaries in stable registry order. */
export function catalogProviderSummaries(): CatalogProviderSummary[] {
  if (summaryCache) return summaryCache;
  summaryCache = PROVIDER_REGISTRY.map((entry) => ({
    name: entry.name,
    endpoint: entry.endpoint,
    keyEnvVar: entry.keyEnvVar,
    defaultTool: '',
    source: 'catalog' as const
  }));
  return summaryCache;
}
