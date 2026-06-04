/**
 * Fallback / auto-router exhaustion order: free → subscription → paid.
 * Kilo/Cline free after Ollama; subscription (OpenCode, Z.ai, Xiaomi MiMo) before API-paid tiers.
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
  PAID_GENERAL: 5,
  KILO_PAID: 6,
  CLINE_PAID: 7,
  PAID_TAIL: 8
} as const;

export type RoutingExhaustionBand = typeof ROUTING_EXHAUSTION_BAND[keyof typeof ROUTING_EXHAUSTION_BAND];

/** Subscription-backed providers (OpenCode Zen/Go, Z.ai Code Pass, Xiaomi MiMo plan). */
export const SUBSCRIPTION_PROVIDERS = [
  'opencode-zen',
  'opencode',
  'zai',
  'xiaomi-mimo'
] as const;

/** API-paid providers before Kilo/Cline paid gateway slots. */
export const PAID_BEFORE_GATEWAY_PAID_PROVIDERS = [
  'nvidia-nim',
  'modal',
  'nebius'
] as const;

/** API-paid providers after Kilo/Cline paid. */
export const PAID_AFTER_GATEWAY_PAID_PROVIDERS = [
  'wafer-serverless',
  'zenmux',
  'openrouter-presets'
] as const;

/** Sub-order within a band. */
export const ROUTING_PROVIDER_SUB_ORDER = [
  'ollama',
  'kilo',
  'cline',
  'opencode-zen',
  'opencode',
  'zai',
  'xiaomi-mimo',
  'nvidia-nim',
  'modal',
  'nebius',
  'wafer-serverless',
  'zenmux',
  'openrouter-presets'
] as const;

const PRESENTATION_PREFIX_TO_PROVIDER: Record<string, string> = {
  ollama: 'ollama',
  kilo: 'kilo',
  cline: 'cline',
  'nvidia-nim': 'nvidia-nim',
  modal: 'modal',
  nebius: 'nebius',
  'opencode-zen': 'opencode-zen',
  opencode: 'opencode',
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

function providerSubOrderIndex(providerSlug: string): number {
  const index = ROUTING_PROVIDER_SUB_ORDER.indexOf(providerSlug as typeof ROUTING_PROVIDER_SUB_ORDER[number]);
  return index >= 0 ? index : ROUTING_PROVIDER_SUB_ORDER.length;
}

function isPresentedFreeSlug(modelId: string): boolean {
  const normalized = String(modelId || '').trim().toLowerCase();
  return normalized.endsWith('-free') || normalized.includes(':free');
}

function isOpencodeFamilyFree(provider: string | null, modelId: string, upstream: string): boolean {
  if (provider !== 'opencode-zen' && provider !== 'opencode') return false;
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
    return ROUTING_EXHAUSTION_BAND.KILO_PAID;
  }
  if (provider === 'cline') {
    if (isClineFreeModel(upstream) || isZeroBaselinePricing(modelId)) {
      return ROUTING_EXHAUSTION_BAND.CLINE_FREE;
    }
    return ROUTING_EXHAUSTION_BAND.CLINE_PAID;
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
  if (provider && (PAID_BEFORE_GATEWAY_PAID_PROVIDERS as readonly string[]).includes(provider)) {
    return ROUTING_EXHAUSTION_BAND.PAID_GENERAL;
  }
  if (provider && (PAID_AFTER_GATEWAY_PAID_PROVIDERS as readonly string[]).includes(provider)) {
    return ROUTING_EXHAUSTION_BAND.PAID_TAIL;
  }

  return ROUTING_EXHAUSTION_BAND.PAID_GENERAL;
}

export function routingExhaustionSortKey(
  modelId: string,
  originalIndex: number,
  catalog?: CatalogModelRef | null
): number {
  const provider = catalog?.provider ?? inferProviderSlugFromPresentedId(modelId) ?? '';
  const band = routingExhaustionBandForModel(modelId, catalog);
  const sub = providerSubOrderIndex(provider);
  return band * 100_000 + sub * 100 + originalIndex;
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
