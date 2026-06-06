import { isOllamaCloudModelName } from './ollama-cloud';

export type OllamaCloudBillingTier = 'free' | 'pro-only';

/** Verified Ollama Cloud billing tier per upstream tag (May 2026). */
export const OLLAMA_CLOUD_TAG_TIERS: Record<string, OllamaCloudBillingTier> = {
  'nemotron-3-ultra:cloud': 'free',
  'minimax-m3:cloud': 'free',
  'deepseek-v4-flash:cloud': 'free',
  'deepseek-v4-pro:cloud': 'pro-only',
  'kimi-k2.6:cloud': 'pro-only',
  'glm-5.1:cloud': 'pro-only',
  'qwen3.5:cloud': 'pro-only'
};

/** Default Ollama router/fallback chain on free tier (shared quota — keep narrow). */
export const DEFAULT_OLLAMA_CLOUD_FREE_ROUTING_TAGS = [
  'nemotron-3-ultra:cloud',
  'minimax-m3:cloud',
  'deepseek-v4-flash:cloud'
] as const;

/** Optional when operator configures a real ollama.com API key (Pro). */
export const DEFAULT_OLLAMA_CLOUD_PRO_ROUTING_TAGS = [
  'deepseek-v4-pro:cloud',
  'kimi-k2.6:cloud',
  'glm-5.1:cloud'
] as const;

export function normalizeOllamaCloudTag(tag: string): string {
  return String(tag || '').trim().toLowerCase();
}

export function ollamaCloudTagTier(tag: string): OllamaCloudBillingTier | null {
  const normalized = normalizeOllamaCloudTag(tag);
  if (!normalized || !isOllamaCloudModelName(normalized)) return null;
  return OLLAMA_CLOUD_TAG_TIERS[normalized] ?? null;
}

export function isOllamaCloudProOnlyTag(tag: string): boolean {
  return ollamaCloudTagTier(tag) === 'pro-only';
}

export function ollamaCloudPresentedId(tag: string): string {
  const segment = normalizeOllamaCloudTag(tag)
    .replace(/^@/, '')
    .replace(/[^a-z0-9._+-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `ollama-${segment || 'model'}`;
}

export function ollamaCloudTagsForRouting(allowsProTier: boolean): string[] {
  const tags: string[] = [...DEFAULT_OLLAMA_CLOUD_FREE_ROUTING_TAGS];
  if (allowsProTier) {
    tags.push(...DEFAULT_OLLAMA_CLOUD_PRO_ROUTING_TAGS);
  }
  return tags;
}

export function ollamaCloudAllowedPresentedIds(allowsProTier: boolean): Set<string> {
  return new Set(ollamaCloudTagsForRouting(allowsProTier).map((tag) => ollamaCloudPresentedId(tag)));
}

export function filterOllamaCloudPullTags(modelTags: string[], allowsProTier: boolean): string[] {
  const allowedRouting = new Set(ollamaCloudTagsForRouting(allowsProTier));
  return modelTags.filter((tag) => {
    const normalized = normalizeOllamaCloudTag(tag);
    if (!isOllamaCloudModelName(normalized)) return false;
    const tier = ollamaCloudTagTier(normalized);
    if (!tier) return allowedRouting.has(normalized);
    if (tier === 'pro-only' && !allowsProTier) return false;
    return allowedRouting.has(normalized);
  });
}

export function isOllamaCloudPresentedIdBlocked(
  presentedId: string,
  upstreamTag: string | null | undefined,
  allowsProTier: boolean
): boolean {
  const tag = normalizeOllamaCloudTag(upstreamTag || '');
  if (!tag || !isOllamaCloudModelName(tag)) return false;

  const allowed = ollamaCloudAllowedPresentedIds(allowsProTier);
  const normalizedPresented = String(presentedId || '').trim();
  if (!allowed.has(normalizedPresented)) {
    return true;
  }

  const tier = ollamaCloudTagTier(tag);
  if (tier === 'pro-only' && !allowsProTier) {
    return true;
  }

  return false;
}
