/**
 * Billing tiers for OpenAI-compatible gateway providers (Cline, Kilo).
 * Curated from CLI free lists + API probes (2026-06-04).
 */

export type GatewayBillingTier = 'free' | 'api-paid' | 'subscription-only';

/** Meta-routers — zero price but not direct models; excluded from catalog and auto-router. */
export const GATEWAY_ROUTER_UPSTREAM_IDS: readonly string[] = [
  'openrouter/free',
  'kilo-auto/free'
] as const;

const GATEWAY_ROUTER_SET = new Set<string>(GATEWAY_ROUTER_UPSTREAM_IDS);

/**
 * Cline CLI free models (API-verified where noted).
 * MiniMax M3 / MiMo V2.5 / DeepSeek V4 Flash are free in Cline CLI billing; no :free suffix on API.
 */
export const CLINE_MODEL_TIERS: Record<string, GatewayBillingTier> = {
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'free',
  'minimax/minimax-m3': 'free',
  'xiaomi/mimo-v2.5': 'free',
  'deepseek/deepseek-v4-flash': 'free'
};

/** Kilo CLI free models (zero gateway pricing); excludes Auto Free and Free Models Router. */
export const KILO_FREE_MODEL_IDS: readonly string[] = [
  'stepfun/step-3.7-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free'
] as const;

const KILO_FREE_SET = new Set<string>(KILO_FREE_MODEL_IDS);

/** Kilo auto-router / fallback free chain. */
export const DEFAULT_KILO_FREE_ROUTING_IDS = [
  'stepfun/step-3.7-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free'
] as const;

/** Cline auto-router / fallback free chain. */
export const DEFAULT_CLINE_FREE_ROUTING_IDS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'minimax/minimax-m3',
  'xiaomi/mimo-v2.5',
  'deepseek/deepseek-v4-flash'
] as const;

export function normalizeGatewayUpstreamId(modelId: string): string {
  return String(modelId || '').trim();
}

export function isGatewayRouterModel(upstreamId: string): boolean {
  return GATEWAY_ROUTER_SET.has(normalizeGatewayUpstreamId(upstreamId));
}

export function clineModelTier(upstreamId: string): GatewayBillingTier | null {
  return CLINE_MODEL_TIERS[normalizeGatewayUpstreamId(upstreamId)] ?? null;
}

export function kiloModelTier(upstreamId: string): GatewayBillingTier {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (isGatewayRouterModel(normalized)) return 'free';
  if (KILO_FREE_SET.has(normalized)) return 'free';
  return 'api-paid';
}

export function isKiloFreeModel(upstreamId: string): boolean {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (isGatewayRouterModel(normalized)) return false;
  return kiloModelTier(normalized) === 'free';
}

export function isClineFreeModel(upstreamId: string): boolean {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (isGatewayRouterModel(normalized)) return false;
  return clineModelTier(normalized) === 'free';
}

export function gatewayModelAllowedForRouter(
  providerName: string,
  upstreamId: string
): boolean {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (isGatewayRouterModel(normalized)) return false;
  if (providerName === 'kilo') {
    return isKiloFreeModel(normalized);
  }
  if (providerName === 'cline') {
    return isClineFreeModel(normalized);
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
