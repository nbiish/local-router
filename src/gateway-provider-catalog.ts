/**
 * Billing tiers for OpenAI-compatible gateway providers (Cline, Kilo).
 * Every catalog row is chat-proven on its endpoint (validate-cline-kilo-catalog.mjs).
 */

export type GatewayBillingTier = 'free' | 'api-paid' | 'subscription-only';

/** Meta-routers excluded from routing (not openrouter/free — routed on OR + Kilo). */
export const GATEWAY_ROUTER_UPSTREAM_IDS: readonly string[] = [
  'kilo-auto/free'
] as const;

const GATEWAY_ROUTER_SET = new Set<string>(GATEWAY_ROUTER_UPSTREAM_IDS);

/** Cline API free models (recommended-models + chat 200; not openrouter/free). */
export const CLINE_FREE_MODEL_IDS: readonly string[] = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'minimax/minimax-m3',
  'xiaomi/mimo-v2.5',
  'deepseek/deepseek-v4-flash'
] as const;

const CLINE_FREE_SET = new Set<string>(CLINE_FREE_MODEL_IDS);

/** Paid Cline models chat-proven on Cline (no Anthropic/Gemini/OpenAI). */
export const CLINE_PAID_ROUTING_IDS: readonly string[] = [
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-chat',
  'z-ai/glm-5.1',
  'qwen/qwen3.7-max',
  'minimax/minimax-m2.7',
  'stepfun/step-3.7-flash',
  'xiaomi/mimo-v2.5-pro',
  'moonshotai/kimi-k2.6'
] as const;

/** Kilo Gateway free models (API-verified 2026-06); excludes kilo-auto/free router preset. */
export const KILO_FREE_MODEL_IDS: readonly string[] = [
  'openrouter/free',
  'stepfun/step-3.7-flash:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3.5-content-safety:free',
  'poolside/laguna-m.1:free',
  'poolside/laguna-xs.2:free'
] as const;

const KILO_FREE_SET = new Set<string>(KILO_FREE_MODEL_IDS);

/** Paid Kilo models chat-proven on Kilo (no Anthropic/Gemini/OpenAI). */
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
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  if (CLINE_FREE_SET.has(normalized)) return 'free';
  if (CLINE_PAID_SET.has(normalized)) return 'api-paid';
  return null;
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
  return CLINE_FREE_SET.has(normalized);
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

const GATEWAY_PRESENTATION_PREFIXES: Record<string, string> = {
  cline: 'cline',
  kilo: 'kilo'
};

/** Human labels aligned with Cline/Kilo client naming where known. */
const GATEWAY_UPSTREAM_FRIENDLY_LABELS: Record<string, string> = {
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron Ultra 3',
  'minimax/minimax-m3': 'MiniMax M3',
  'xiaomi/mimo-v2.5': 'MiMo V2.5',
  'deepseek/deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek/deepseek-v4-pro': 'DeepSeek V4 Pro',
  'deepseek/deepseek-chat': 'DeepSeek Chat',
  'z-ai/glm-5.1': 'GLM 5.1',
  'qwen/qwen3.7-max': 'Qwen 3.7 Max',
  'minimax/minimax-m2.7': 'MiniMax M2.7',
  'stepfun/step-3.7-flash': 'Step 3.7 Flash',
  'stepfun/step-3.7-flash:free': 'Step 3.7 Flash',
  'xiaomi/mimo-v2.5-pro': 'MiMo V2.5 Pro',
  'moonshotai/kimi-k2.6': 'Kimi K2.6',
  'openrouter/free': 'OpenRouter Free',
  'nvidia/nemotron-3-super-120b-a12b:free': 'Nemotron Super 120B',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free': 'Nemotron Nano Omni',
  'nvidia/nemotron-3.5-content-safety:free': 'Nemotron Content Safety',
  'poolside/laguna-m.1:free': 'Laguna M.1',
  'poolside/laguna-xs.2:free': 'Laguna XS.2'
};

function gatewayTierSuffix(tier: GatewayBillingTier | null): string {
  if (tier === 'free') return 'free';
  if (tier === 'api-paid') return 'paid';
  return '';
}

function gatewayModelTierForProvider(providerName: string, upstreamId: string): GatewayBillingTier | null {
  if (providerName === 'cline') return clineModelTier(upstreamId);
  if (providerName === 'kilo') return kiloModelTier(upstreamId);
  return null;
}

function segmentHasTierSuffix(segment: string, tier: GatewayBillingTier | null): boolean {
  if (tier === 'free') {
    return segment.endsWith('-free') || segment.includes('.free');
  }
  if (tier === 'api-paid') {
    return segment.endsWith('-paid');
  }
  return false;
}

/** Local-router presented ID with explicit `-free` / `-paid` tier suffix for Cline/Kilo. */
export function gatewayPresentedModelId(providerName: string, upstreamId: string): string {
  const prefix = GATEWAY_PRESENTATION_PREFIXES[providerName];
  if (!prefix) return '';
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  const segment = gatewayPresentedModelSegment(normalized);
  const tier = gatewayModelTierForProvider(providerName, normalized);
  const suffix = gatewayTierSuffix(tier);
  if (!segment) return `${prefix}-model`;
  if (!suffix || segmentHasTierSuffix(segment, tier)) {
    return `${prefix}-${segment}`;
  }
  return `${prefix}-${segment}-${suffix}`;
}

function formatGatewayFriendlyFallback(upstreamId: string): string {
  const tail = upstreamId.split('/').filter(Boolean).pop() || upstreamId;
  return tail
    .replace(/:free$/i, '')
    .split(/[-._]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Config UI / catalog display: `cline:Nemotron Ultra 3 (free)`. */
export function gatewayModelCatalogDisplay(providerName: string, upstreamId: string): string {
  const normalized = normalizeGatewayUpstreamId(upstreamId);
  const friendly = GATEWAY_UPSTREAM_FRIENDLY_LABELS[normalized]
    ?? formatGatewayFriendlyFallback(normalized);
  const tier = gatewayModelTierForProvider(providerName, normalized);
  const tierLabel = tier === 'free' ? 'free' : tier === 'api-paid' ? 'paid' : 'catalog';
  return `${providerName}:${friendly} (${tierLabel})`;
}

function buildGatewayPresentedLegacyAliases(providerName: string, upstreamIds: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const prefix = GATEWAY_PRESENTATION_PREFIXES[providerName];
  if (!prefix) return out;

  for (const upstreamId of upstreamIds) {
    const segment = gatewayPresentedModelSegment(upstreamId);
    const legacyId = `${prefix}-${segment}`;
    const nextId = gatewayPresentedModelId(providerName, upstreamId);
    if (legacyId !== nextId) {
      out[legacyId] = nextId;
    }
  }
  return out;
}

/** Maps pre-tier-suffix presented IDs to current catalog IDs (router/fallback migration). */
export const GATEWAY_PRESENTED_LEGACY_ALIASES: Readonly<Record<string, string>> = {
  ...buildGatewayPresentedLegacyAliases('cline', [...CLINE_FREE_MODEL_IDS, ...CLINE_PAID_ROUTING_IDS]),
  ...buildGatewayPresentedLegacyAliases('kilo', [...KILO_FREE_MODEL_IDS, ...KILO_PAID_ROUTING_IDS])
};

export function resolveGatewayPresentedLegacyId(modelId: string): string {
  const trimmed = String(modelId || '').trim();
  return GATEWAY_PRESENTED_LEGACY_ALIASES[trimmed] ?? trimmed;
}
