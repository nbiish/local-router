/**
 * Billing tiers for OpenAI-compatible gateway providers (Cline, Kilo).
 * Curated from CLI free lists + API probes (2026-06-04).
 */

export type GatewayBillingTier = 'free' | 'api-paid' | 'subscription-only';

/** Meta-routers excluded from routing (not openrouter/free — routed on OR + Kilo). */
export const GATEWAY_ROUTER_UPSTREAM_IDS: readonly string[] = [
  'kilo-auto/free'
] as const;

const GATEWAY_ROUTER_SET = new Set<string>(GATEWAY_ROUTER_UPSTREAM_IDS);

/**
 * Cline CLI free models (API-verified where noted).
 * DeepSeek V4 Flash is api-paid (fallback/auto paid tail after subscriptions).
 */
export const CLINE_MODEL_TIERS: Record<string, GatewayBillingTier> = {
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'free',
  'minimax/minimax-m3': 'free',
  'xiaomi/mimo-v2.5': 'free',
  'deepseek/deepseek-v4-flash': 'api-paid',
  'deepseek/deepseek-chat': 'api-paid',
  'google/gemini-2.5-flash': 'api-paid',
  'minimax/minimax-m2.7': 'api-paid',
  'qwen/qwen3-coder': 'api-paid'
};

/** Kilo Gateway free models (API-verified 2026-06); excludes kilo-auto/free router preset. */
export const KILO_FREE_MODEL_IDS: readonly string[] = [
  'openrouter/free',
  'openrouter/owl-alpha',
  'stepfun/step-3.7-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'poolside/laguna-m.1:free',
  'poolside/laguna-xs.2:free'
] as const;

const KILO_FREE_SET = new Set<string>(KILO_FREE_MODEL_IDS);

/** Paid Kilo models curated in providers.txt (ZenMux-parity; no Anthropic/Gemini/OpenAI). */
export const KILO_PAID_ROUTING_IDS: readonly string[] = [
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-chat',
  'z-ai/glm-5.1',
  'qwen/qwen3.7-max',
  'minimax/minimax-m3',
  'minimax/minimax-m2.7',
  'stepfun/step-3.7-flash',
  'xiaomi/mimo-v2.5-pro',
  'xiaomi/mimo-v2.5',
  'moonshotai/kimi-k2.6'
] as const;

export const CLINE_PAID_ROUTING_IDS: readonly string[] = [
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-chat',
  'google/gemini-2.5-flash',
  'minimax/minimax-m2.7',
  'qwen/qwen3-coder'
] as const;

const KILO_PAID_SET = new Set<string>(KILO_PAID_ROUTING_IDS);
const CLINE_PAID_SET = new Set<string>(CLINE_PAID_ROUTING_IDS);

/** Kilo auto-router / fallback free chain. */
export const DEFAULT_KILO_FREE_ROUTING_IDS = [
  'openrouter/free',
  'stepfun/step-3.7-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free'
] as const;

/** Cline auto-router / fallback free chain. */
export const DEFAULT_CLINE_FREE_ROUTING_IDS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'minimax/minimax-m3',
  'xiaomi/mimo-v2.5'
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
  if (KILO_PAID_SET.has(normalized)) return 'api-paid';
  return 'api-paid';
}

export function isKiloFreeModel(upstreamId: string): boolean {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (isGatewayRouterModel(normalized)) return false;
  return KILO_FREE_SET.has(normalized);
}

export function isClineFreeModel(upstreamId: string): boolean {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (isGatewayRouterModel(normalized)) return false;
  if (CLINE_PAID_SET.has(normalized)) return false;
  return clineModelTier(normalized) === 'free';
}

export function gatewayModelAllowedForRouter(
  providerName: string,
  upstreamId: string
): boolean {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (isGatewayRouterModel(normalized)) return false;
  if (providerName === 'kilo') {
    // Credits apply to the full upstream gateway; block meta-routers only.
    // Custom catalog listing stays on providers.txt — use Endpoint Models for full lists.
    return true;
  }
  if (providerName === 'cline') {
    return isClineFreeModel(normalized) || CLINE_PAID_SET.has(normalized);
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
