/**
 * Fallback / auto-router exhaustion order: free → subscription → paid.
 * Paid API order (after subscription): Wafer → ZenMux → OpenRouter → Nebius → Cline → Kilo → OpenCode Zen → NIM → Modal.
 */

import {
  isClineFreeModel,
  isKiloFreeModel
} from './gateway-provider-catalog';
import { isOllamaCloudPresentedIdBlocked } from './ollama-cloud-catalog';
import { getProviderPricingEntry } from './provider-pricing';

/** Lower band = tried earlier in fallback and default tier sorts. */
export const ROUTING_EXHAUSTION_BAND = {
  OLLAMA_FREE: 0,
  KILO_FREE: 1,
  CLINE_FREE: 2,
  OTHER_FREE: 3,
  SUBSCRIPTION: 4,
  PAID: 5
} as const;

/** Default fallback paid tail (six anchors; explicit fallback order is authoritative). */
export const FALLBACK_PAID_TAIL_IDS: readonly string[] = [
  'wafer-ai-deepseek-v4-flash',
  'zenmux-mimo-v2.5-pro',
  'openrouter-chain-of-draft',
  'nebius-nemotron-3-ultra-550b-a55b',
  'cline-deepseek-deepseek-v4-flash-free',
  'kilo-deepseek-deepseek-v4-flash-paid'
] as const;

/** @deprecated Use FALLBACK_PAID_TAIL_IDS */
export const DEEPSEEK_V4_FLASH_PAID_PRESENTED_IDS = FALLBACK_PAID_TAIL_IDS;

export type RoutingExhaustionBand = typeof ROUTING_EXHAUSTION_BAND[keyof typeof ROUTING_EXHAUSTION_BAND];

/** Subscription endpoints (OpenCode Go, Z.ai, Xiaomi). OpenCode Zen paid is in PAID band. */
export const SUBSCRIPTION_PROVIDERS = [
  'opencode-go',
  'zai',
  'xiaomi-mimo'
] as const;

/** Subscription try order within band 4. */
export const SUBSCRIPTION_PROVIDER_SUB_ORDER = [
  'opencode-go',
  'zai',
  'xiaomi-mimo',
  'commandcode'
] as const;

/** API-paid provider try order after subscription exhaustion band. */
export const ROUTING_PAID_PROVIDER_SUB_ORDER = [
  'wafer-serverless',
  'zenmux',
  'openrouter-presets',
  'nebius',
  'cline',
  'kilo',
  'opencode-zen',
  'nvidia-nim',
  'modal'
] as const;

/** Sub-order within free bands (Ollama → gateway free → OpenCode Zen free). */
export const ROUTING_FREE_PROVIDER_SUB_ORDER = [
  'ollama',
  'kilo',
  'cline',
  'openrouter-presets',
  'opencode-zen'
] as const;

const PRESENTATION_PREFIX_TO_PROVIDER: Record<string, string> = {
  ollama: 'ollama',
  kilo: 'kilo',
  cline: 'cline',
  'nvidia-nim': 'nvidia-nim',
  modal: 'modal',
  nebius: 'nebius',
  'opencode-zen': 'opencode-zen',
  'opencode-go': 'opencode-go',
  'opencode-code': 'opencode-go',
  opencode: 'opencode-go',
  zai: 'zai',
  'xiaomi-mimo': 'xiaomi-mimo',
  'wafer-ai': 'wafer-serverless',
  'wafer-serverless': 'wafer-serverless',
  zenmux: 'zenmux',
  openrouter: 'openrouter-presets',
  'openrouter-presets': 'openrouter-presets'
};

export type CatalogModelRef = {
  provider: string;
  model: string;
};

export function inferProviderSlugFromPresentedId(modelId: string): string | null {
  const trimmed = String(modelId || '').trim();
  if (!trimmed) return null;

  const normalized = trimmed.toLowerCase();
  const prefixes = Object.keys(PRESENTATION_PREFIX_TO_PROVIDER)
    .sort((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      return PRESENTATION_PREFIX_TO_PROVIDER[prefix];
    }
  }

  return null;
}

function paidProviderSubOrderIndex(providerSlug: string): number {
  const index = ROUTING_PAID_PROVIDER_SUB_ORDER.indexOf(
    providerSlug as typeof ROUTING_PAID_PROVIDER_SUB_ORDER[number]
  );
  return index >= 0 ? index : ROUTING_PAID_PROVIDER_SUB_ORDER.length;
}

function freeProviderSubOrderIndex(providerSlug: string): number {
  const index = ROUTING_FREE_PROVIDER_SUB_ORDER.indexOf(
    providerSlug as typeof ROUTING_FREE_PROVIDER_SUB_ORDER[number]
  );
  return index >= 0 ? index : ROUTING_FREE_PROVIDER_SUB_ORDER.length;
}

function subscriptionProviderSubOrderIndex(providerSlug: string): number {
  const index = SUBSCRIPTION_PROVIDER_SUB_ORDER.indexOf(
    providerSlug as typeof SUBSCRIPTION_PROVIDER_SUB_ORDER[number]
  );
  return index >= 0 ? index : SUBSCRIPTION_PROVIDER_SUB_ORDER.length;
}

function isPresentedFreeSlug(modelId: string): boolean {
  const normalized = String(modelId || '').trim().toLowerCase();
  return normalized.endsWith('-free') || normalized.includes(':free');
}

function isOpencodeFamilyFree(provider: string | null, modelId: string, upstream: string): boolean {
  if (provider !== 'opencode-zen' && provider !== 'opencode-go') return false;
  const normalizedUpstream = String(upstream || '').trim().toLowerCase();
  return isPresentedFreeSlug(modelId)
    || normalizedUpstream.endsWith('-free')
    || normalizedUpstream.includes(':free');
}

function isZeroBaselinePricing(modelId: string): boolean {
  const entry = getProviderPricingEntry(modelId);
  if (!entry) return false;
  return entry.inputPricePerM === 0 && entry.outputPricePerM === 0;
}

function isOllamaFreeRoutingModel(modelId: string, upstream: string): boolean {
  return !isOllamaCloudPresentedIdBlocked(modelId, upstream, false);
}

function isSubscriptionProvider(provider: string | null): boolean {
  return Boolean(provider && (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(provider));
}

function isPaidProvider(provider: string | null): boolean {
  if (!provider) return false;
  if (isSubscriptionProvider(provider)) return false;
  if (provider === 'ollama') return false;
  return (ROUTING_PAID_PROVIDER_SUB_ORDER as readonly string[]).includes(provider)
    || provider === 'kilo'
    || provider === 'cline';
}

export function routingExhaustionBandForModel(
  modelId: string,
  catalog?: CatalogModelRef | null
): RoutingExhaustionBand {
  const provider = catalog?.provider ?? inferProviderSlugFromPresentedId(modelId);
  const upstream = catalog?.model ?? '';

  if (provider === 'ollama' && isOllamaFreeRoutingModel(modelId, upstream)) {
    return ROUTING_EXHAUSTION_BAND.OLLAMA_FREE;
  }
  if (provider === 'kilo') {
    if (isKiloFreeModel(upstream) || isPresentedFreeSlug(modelId) || isZeroBaselinePricing(modelId)) {
      return ROUTING_EXHAUSTION_BAND.KILO_FREE;
    }
    return ROUTING_EXHAUSTION_BAND.PAID;
  }
  if (provider === 'cline') {
    if (isClineFreeModel(upstream)) {
      return ROUTING_EXHAUSTION_BAND.CLINE_FREE;
    }
    return ROUTING_EXHAUSTION_BAND.PAID;
  }
  if (isOpencodeFamilyFree(provider, modelId, upstream)) {
    return ROUTING_EXHAUSTION_BAND.OTHER_FREE;
  }
  if (provider && provider !== 'ollama' && provider !== 'kilo' && provider !== 'cline') {
    if (isPresentedFreeSlug(modelId) || isZeroBaselinePricing(modelId)) {
      return ROUTING_EXHAUSTION_BAND.OTHER_FREE;
    }
  }

  if (isSubscriptionProvider(provider)) {
    return ROUTING_EXHAUSTION_BAND.SUBSCRIPTION;
  }
  if (isPaidProvider(provider)) {
    return ROUTING_EXHAUSTION_BAND.PAID;
  }

  return ROUTING_EXHAUSTION_BAND.PAID;
}

export function routingExhaustionSortKey(
  modelId: string,
  originalIndex: number,
  catalog?: CatalogModelRef | null
): number {
  const provider = catalog?.provider ?? inferProviderSlugFromPresentedId(modelId) ?? '';
  const band = routingExhaustionBandForModel(modelId, catalog);

  if (band === ROUTING_EXHAUSTION_BAND.PAID) {
    return band * 100_000 + paidProviderSubOrderIndex(provider) * 100 + originalIndex;
  }
  if (
    band === ROUTING_EXHAUSTION_BAND.KILO_FREE
    || band === ROUTING_EXHAUSTION_BAND.CLINE_FREE
    || band === ROUTING_EXHAUSTION_BAND.OTHER_FREE
  ) {
    return band * 100_000 + freeProviderSubOrderIndex(provider) * 100 + originalIndex;
  }
  if (band === ROUTING_EXHAUSTION_BAND.SUBSCRIPTION) {
    return band * 100_000 + subscriptionProviderSubOrderIndex(provider) * 100 + originalIndex;
  }

  return band * 100_000 + originalIndex;
}

export function stableSortModelIdsByRoutingExhaustion<
  TFind extends (id: string) => CatalogModelRef | undefined
>(modelIds: string[], findModel: TFind): string[] {
  return modelIds
    .map((id, index) => ({
      id,
      index,
      key: routingExhaustionSortKey(id, index, findModel(id))
    }))
    .sort((left, right) => left.key - right.key || left.index - right.index)
    .map((entry) => entry.id);
}
