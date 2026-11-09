/**
 * fallback-topology.ts — how a fallback chain is ORDERED, and which steps may
 * serve a given request.
 *
 * Two defects this module exists to fix, both measured on a live router
 * (2026-11-09):
 *
 * 1. Ordering was fiction. `normalizeRoutingTierOrder` logged "Reordered
 *    fallback route by provider tier" while only de-duplicating — it never
 *    compared tiers. The chain's order was therefore whatever the operator had
 *    clicked, with subscription-billed models ahead of free ones in the default
 *    seed.
 *
 * 2. Eligibility ignored capability. `filterEligibleFallbackModels` checked
 *    context window and vision only; `supportsReasoning` was declared in its
 *    spec type and never read. A request that needs a reasoning level could be
 *    routed to a model that reasons at one fixed depth, silently, with HTTP 200.
 *
 * Ordering is COST-FIRST (operator decision 2026-11-09): free tier, then
 * subscription/OAuth capacity that is already paid for, then metered paid —
 * and inside a band, the more capable model first. Tier comes from the curated
 * registry because price cannot: only 7 of 147 live models resolved a price
 * entry, while the registry carries a tier fact for almost every row.
 */

import { getProviderPricingEntry } from './provider-pricing';

/** Cost bands, cheapest first. `unknown` sorts last: never assume a model is free. */
export type CostBand = 'free' | 'subscription' | 'paid' | 'unknown';

export const COST_BAND_ORDER: readonly CostBand[] = ['free', 'subscription', 'paid', 'unknown'];

/** Rank for a band; lower is tried first. */
export function costBandRank(band: CostBand): number {
  const index = COST_BAND_ORDER.indexOf(band);
  return index === -1 ? COST_BAND_ORDER.length : index;
}

/**
 * Map a provider/model tier fact onto a cost band.
 *
 * `tier` is the curated registry's factual field ('free' | 'paid' |
 * 'subscription'). Anything else — including a provider with no curated row —
 * is `unknown`, which sorts last so an unpriced model can never jump ahead of a
 * known-free one. A model id that *says* it is free is trusted even without a
 * registry row, because that suffix is how these providers themselves advertise
 * a no-cost tier.
 *
 * `accessPath` is the second half of the fact, and it is what the tier label
 * alone gets wrong. `antigravity` models carry tier 'paid' because that is how
 * Google labels the upstream model (free tier vs paid billing on AI Studio),
 * yet the router reaches them through an OAuth subscription that is already
 * paid for. Ordering those as metered would put a subscription the operator
 * already owns behind models that bill per token. Any OAuth provider is
 * therefore subscription capacity, whatever its models' upstream tier says.
 */
export function costBandFor(
  tier: string | undefined,
  modelId?: string,
  accessPath?: 'oauth' | 'key' | 'local'
): CostBand {
  // Access path outranks the model's own tier label: already-paid capacity is
  // not metered spend.
  if (accessPath === 'oauth' || accessPath === 'local') return 'subscription';

  const normalized = String(tier || '').trim().toLowerCase();
  if (normalized === 'free' || normalized === 'subscription' || normalized === 'paid') {
    return normalized;
  }
  const id = String(modelId || '').toLowerCase();
  if (/(^|[-:])free($|[-:])|:free$|\/free$|(^|-)free-/.test(id)) return 'free';
  return 'unknown';
}

/**
 * The price signal, for ordering inside the paid band.
 *
 * Returns a comparable number (USD per 1M input tokens, blended with output so a
 * cheap-input/expensive-output model does not look free). A model with no price
 * entry sorts after a priced one: an unpriced model cannot be proven cheaper.
 */
export function blendedPrice(modelId: string): number {
  const pricing = getProviderPricingEntry(modelId);
  if (!pricing) return Number.POSITIVE_INFINITY;
  const input = Number(pricing.inputPricePerM) || 0;
  const output = Number(pricing.outputPricePerM) || 0;
  // Output dominates real agent traffic, so weight it accordingly.
  return input * 0.3 + output * 0.7;
}

export type TopologyCandidate = {
  id: string;
  /** Curated tier fact, when the provider publishes one. */
  tier?: string;
  /**
   * How the router reaches this model. OAuth and local backends are already-paid
   * capacity, so their upstream `paid` label must not sort them as metered spend.
   */
  accessPath?: 'oauth' | 'key' | 'local';
  contextLength: number;
  outputTokens: number;
  supportsVision: boolean;
  supportsTools: boolean;
  /** Number of selectable reasoning levels (0 = no request dial). */
  reasoningLevelCount: number;
  /** Whether a cache exists at all, for the capability tiebreak. */
  caches: boolean;
};

export type OrderingOptions = {
  /**
   * Preserve the operator's own order. Set when the chain was authored by hand:
   * an operator's sequence is an intent we must not silently reshuffle, and the
   * UI lets them reorder explicitly.
   */
  respectAuthoredOrder?: boolean;
};

/**
 * Capability score inside a cost band. Bigger context wins first because it is
 * the only capability that can make a step outright unusable; reasoning depth,
 * vision and caching are tiebreaks.
 */
export function capabilityScore(candidate: TopologyCandidate): number {
  // Context dominates: 1M tokens -> ~1000 points, 64K -> ~64 points.
  const contextPoints = Math.min(candidate.contextLength, 2_000_000) / 1000;
  const reasoningPoints = candidate.reasoningLevelCount * 5;
  const visionPoints = candidate.supportsVision ? 3 : 0;
  const toolsPoints = candidate.supportsTools ? 2 : 0;
  const cachePoints = candidate.caches ? 1 : 0;
  return contextPoints + reasoningPoints + visionPoints + toolsPoints + cachePoints;
}

/**
 * Sort a chain cost-first.
 *
 * Stable by construction: a candidate with identical cost band and identical
 * capability score keeps its relative position, so an operator's hand-ordering
 * survives where it is not contradicted by a fact.
 */
export function orderChainByCostThenCapability(
  candidates: readonly TopologyCandidate[]
): TopologyCandidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const bandDelta = costBandRank(costBandFor(a.candidate.tier, a.candidate.id, a.candidate.accessPath))
        - costBandRank(costBandFor(b.candidate.tier, b.candidate.id, b.candidate.accessPath));
      if (bandDelta !== 0) return bandDelta;

      const band = costBandFor(a.candidate.tier, a.candidate.id, a.candidate.accessPath);
      if (band === 'paid') {
        // Inside the paid band, cheaper first — that is the whole point of the band.
        const priceDelta = blendedPrice(a.candidate.id) - blendedPrice(b.candidate.id);
        if (priceDelta !== 0 && Number.isFinite(priceDelta)) return priceDelta;
      }

      const capabilityDelta = capabilityScore(b.candidate) - capabilityScore(a.candidate);
      if (capabilityDelta !== 0) return capabilityDelta;

      // Stable: preserve authored order.
      return a.index - b.index;
    })
    .map((entry) => entry.candidate);
}

// ── Eligibility ────────────────────────────────────────────────────────────

/**
 * What a request needs from a candidate. `undefined` means "no requirement",
 * which is the common case: a plain chat turn needs neither reasoning control
 * nor vision.
 */
export type RequestRequirements = {
  requiresVision: boolean;
  /**
   * True when the caller expressed a thinking intent (any level, including
   * "off"). A model with no request dial cannot honour a chosen level, so it is
   * not eligible — silently running at a fixed depth is the failure this exists
   * to prevent.
   */
  requiresReasoningDial: boolean;
  /** Smallest acceptable context window, in tokens. */
  minContext: number;
};

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: 'no_multimodal_support' | 'no_reasoning_dial' | 'context_window_too_small' };

/**
 * Can this candidate serve this request?
 *
 * The three checks are ordered most-disqualifying first so the reported reason
 * is the one a caller can act on.
 */
export function candidateCanServe(
  candidate: Pick<TopologyCandidate, 'contextLength' | 'supportsVision' | 'reasoningLevelCount'>,
  requirements: RequestRequirements
): EligibilityResult {
  if (requirements.requiresVision && !candidate.supportsVision) {
    return { eligible: false, reason: 'no_multimodal_support' };
  }
  if (requirements.requiresReasoningDial && candidate.reasoningLevelCount === 0) {
    return { eligible: false, reason: 'no_reasoning_dial' };
  }
  if (candidate.contextLength < requirements.minContext) {
    return { eligible: false, reason: 'context_window_too_small' };
  }
  return { eligible: true };
}

// ── Provider coverage ──────────────────────────────────────────────────────

export type CoverageGap = {
  /** Configured providers with no step in the chain at all. */
  providersAbsentFromChain: string[];
  /** Chain steps whose provider holds no key, so they can never serve. */
  unconfiguredProviders: string[];
  /** Providers reached by exactly one step: a single failure loses the provider. */
  singleStepProviders: string[];
};

/**
 * Report how the chain covers the providers the operator has configured.
 *
 * The measured problem (2026-11-09): 15 providers were configured and 12
 * appeared in the chain, with `antigravity` — a whole OAuth subscription —
 * absent, while `typesafe` (decisions only) and `ollama` correctly were not.
 * This function does not change the chain; it makes the gap visible so the
 * operator (or the seed builder) can close it deliberately.
 */
export function providerCoverageGaps(options: {
  configuredProviders: readonly string[];
  /** Providers that cannot serve chat, so their absence is correct. */
  nonChatProviders?: readonly string[];
  chainProviders: readonly string[];
}): CoverageGap {
  const nonChat = new Set((options.nonChatProviders || []).map((p) => p.toLowerCase()));
  const inChain = new Map<string, number>();
  for (const provider of options.chainProviders) {
    const key = provider.toLowerCase();
    inChain.set(key, (inChain.get(key) || 0) + 1);
  }

  const providersAbsentFromChain = options.configuredProviders
    .filter((provider) => !nonChat.has(provider.toLowerCase()))
    .filter((provider) => !inChain.has(provider.toLowerCase()));

  const singleStepProviders = [...inChain.entries()]
    .filter(([, count]) => count === 1)
    .map(([provider]) => provider);

  const configured = new Set(options.configuredProviders.map((p) => p.toLowerCase()));
  const unconfiguredProviders = [...inChain.keys()].filter((provider) => !configured.has(provider));

  return { providersAbsentFromChain, unconfiguredProviders, singleStepProviders };
}
