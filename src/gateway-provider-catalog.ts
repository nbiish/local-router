/**
 * Billing tiers for OpenAI-compatible gateway providers (Cline, Kilo).
 * Populated from live probes 2026-06-04; see .agents/research/cline-kilo-catalog-2026-06-04.json.
 */

export type GatewayBillingTier = 'free' | 'api-paid' | 'subscription-only';

/** Cline upstream model IDs (provider/model) verified via POST /chat/completions. */
export const CLINE_MODEL_TIERS: Record<string, GatewayBillingTier> = {
  'openrouter/free': 'free',
  'minimax/minimax-m2.5': 'free',
  'deepseek/deepseek-chat': 'api-paid',
  'deepseek/deepseek-v4-flash': 'api-paid',
  'google/gemini-2.5-flash': 'api-paid',
  'minimax/minimax-m2.7': 'api-paid',
  'qwen/qwen3-coder': 'api-paid'
};

/** Kilo upstream model IDs with zero gateway pricing (GET /models, auth). */
export const KILO_FREE_MODEL_IDS: readonly string[] = [
  'kilo-auto/free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'poolside/laguna-m.1:free',
  'stepfun/step-3.7-flash:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'openrouter/owl-alpha',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'poolside/laguna-xs.2:free',
  'google/lyria-3-pro-preview',
  'google/lyria-3-clip-preview',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/free'
] as const;

const KILO_FREE_SET = new Set<string>(KILO_FREE_MODEL_IDS);

/** Default Kilo router/fallback free models (coding-oriented subset). */
export const DEFAULT_KILO_FREE_ROUTING_IDS = [
  'stepfun/step-3.7-flash:free',
  'openrouter/free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'kilo-auto/free'
] as const;

/** Default Cline router free models. */
export const DEFAULT_CLINE_FREE_ROUTING_IDS = [
  'openrouter/free'
] as const;

export function normalizeGatewayUpstreamId(modelId: string): string {
  return String(modelId || '').trim();
}

export function clineModelTier(upstreamId: string): GatewayBillingTier | null {
  return CLINE_MODEL_TIERS[normalizeGatewayUpstreamId(upstreamId)] ?? null;
}

export function kiloModelTier(upstreamId: string): GatewayBillingTier {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (KILO_FREE_SET.has(normalized)) return 'free';
  if (normalized.startsWith('kilo-auto/')) return 'api-paid';
  return 'api-paid';
}

export function isKiloFreeModel(upstreamId: string): boolean {
  return kiloModelTier(upstreamId) === 'free';
}

export function isClineFreeModel(upstreamId: string): boolean {
  return clineModelTier(upstreamId) === 'free';
}

export function gatewayModelAllowedForRouter(
  providerName: string,
  upstreamId: string
): boolean {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (providerName === 'kilo') {
    return isKiloFreeModel(normalized);
  }
  if (providerName === 'cline') {
    const tier = clineModelTier(normalized);
    return tier === 'free';
  }
  return true;
}

export function gatewayRoutingUpstreamIds(providerName: string): string[] {
  if (providerName === 'kilo') return [...DEFAULT_KILO_FREE_ROUTING_IDS];
  if (providerName === 'cline') return [...DEFAULT_CLINE_FREE_ROUTING_IDS];
  return [];
}

/** Full upstream path slug for presented IDs (avoids collisions on `:free` suffix). */
export function gatewayPresentedModelSegment(modelName: string): string {
  return String(modelName || '')
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
