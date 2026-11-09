import test from 'node:test';
import assert from 'node:assert/strict';

import {
  candidateCanServe,
  capabilityScore,
  costBandFor,
  costBandRank,
  COST_BAND_ORDER,
  orderChainByCostThenCapability,
  providerCoverageGaps
} from '../build/fallback-topology.js';
import {
  filterEligibleFallbackModels,
  requestRequiresReasoningDial
} from '../build/routing-capabilities.js';

/**
 * Fallback topology: how a chain is ORDERED, and which steps may serve a request.
 *
 * Two defects motivated this, both measured on a live router on 2026-11-09:
 *
 *  - `normalizeRoutingTierOrder` logged "Reordered fallback route by provider
 *    tier" while only de-duplicating. Nothing compared tiers, so a chain could
 *    put a subscription-billed step ahead of a free one and never correct itself.
 *  - `filterEligibleFallbackModels` checked context and vision only.
 *    `supportsReasoning` was in its spec type and never read, so a request that
 *    asked for a thinking level could be routed to a model with no request dial
 *    and still answer 200 — the caller's setting appeared to work.
 *
 * These pin the invariants rather than examples: cost ordering is total and
 * stable, and a requirement can only ever REMOVE candidates.
 */

// ── Cost bands ─────────────────────────────────────────────────────────────

test('a registry tier maps to its cost band', () => {
  assert.equal(costBandFor('free'), 'free');
  assert.equal(costBandFor('subscription'), 'subscription');
  assert.equal(costBandFor('paid'), 'paid');
  assert.equal(costBandFor('PAID'), 'paid', 'the registry field is free-form; case must not matter');
});

test('an id that advertises a free tier is trusted without a registry row', () => {
  // These providers signal a no-cost tier in the id itself. Treating such a model
  // as unknown would push it behind metered ones in the paid band.
  assert.equal(costBandFor(undefined, 'zenmux-glm-5.3-free'), 'free');
  assert.equal(costBandFor(undefined, 'openrouter-free'), 'free');
  assert.equal(costBandFor(undefined, 'cline-deepseek-deepseek-v4-flash-free'), 'free');
  assert.equal(costBandFor(undefined, 'nous-portal-step-3.7-flash:free'), 'free');
  assert.equal(costBandFor(undefined, 'some/model/free'), 'free');
});

test('an unknown tier sorts last, never as free', () => {
  // "Unknown" must never be assumed free: an unpriced model jumping ahead of a
  // known-free one is how a chain starts spending money on its first attempt.
  assert.equal(costBandFor(undefined, 'some-gateway-mystery-model'), 'unknown');
  assert.equal(costBandFor('', 'x'), 'unknown');
  assert.ok(costBandRank('unknown') > costBandRank('paid'));
  assert.deepEqual([...COST_BAND_ORDER], ['free', 'subscription', 'paid', 'unknown']);
});

test('an OAuth subscription outranks its models\' upstream tier label', () => {
  // Measured 2026-11-09: every `antigravity` row carries tier 'paid', because
  // that is how Google labels the upstream AI Studio model (free tier vs paid
  // billing). The router reaches those models through an OAuth subscription that
  // is already paid for, so ordering them as metered would put a subscription the
  // operator already owns behind per-token billing.
  assert.equal(costBandFor('paid', 'antigravity-gemini-3.7-flash', 'oauth'), 'subscription');
  // The same label without OAuth really is metered.
  assert.equal(costBandFor('paid', 'pioneer-moonshotai-kimi-k3', 'key'), 'paid');
  // A local backend is already-paid capacity too.
  assert.equal(costBandFor(undefined, 'llama-local/qwen', 'local'), 'subscription');
});

test('an OAuth subscription sorts ahead of metered paid models', () => {
  const ordered = orderChainByCostThenCapability([
    candidate({ id: 'metered', tier: 'paid', accessPath: 'key', contextLength: 1000000 }),
    candidate({ id: 'oauth', tier: 'paid', accessPath: 'oauth', contextLength: 200000 })
  ]);
  assert.deepEqual(ordered.map((c) => c.id), ['oauth', 'metered'],
    'already-paid capacity must be tried before per-token spend, even with a smaller window');
});

// ── Ordering ───────────────────────────────────────────────────────────────

function candidate(overrides) {
  return {
    id: 'x',
    tier: 'paid',
    contextLength: 128000,
    outputTokens: 8192,
    supportsVision: false,
    supportsTools: true,
    reasoningLevelCount: 0,
    caches: true,
    ...overrides
  };
}

test('the chain is ordered free, then subscription, then paid', () => {
  const ordered = orderChainByCostThenCapability([
    candidate({ id: 'paid-a', tier: 'paid' }),
    candidate({ id: 'free-a', tier: 'free' }),
    candidate({ id: 'sub-a', tier: 'subscription' })
  ]);
  assert.deepEqual(ordered.map((c) => c.id), ['free-a', 'sub-a', 'paid-a']);
});

test('unknown cost sorts after every known band', () => {
  const ordered = orderChainByCostThenCapability([
    candidate({ id: 'unknown-a', tier: undefined }),
    candidate({ id: 'paid-a', tier: 'paid' }),
    candidate({ id: 'free-a', tier: 'free' })
  ]);
  assert.deepEqual(ordered.map((c) => c.id), ['free-a', 'paid-a', 'unknown-a']);
});

test('inside a band, the larger context window comes first', () => {
  const ordered = orderChainByCostThenCapability([
    candidate({ id: 'small', tier: 'free', contextLength: 64000 }),
    candidate({ id: 'large', tier: 'free', contextLength: 1000000 })
  ]);
  assert.deepEqual(ordered.map((c) => c.id), ['large', 'small'],
    'context is the only capability that can make a step outright unusable');
});

test('inside a band, reasoning depth breaks a context tie', () => {
  const ordered = orderChainByCostThenCapability([
    candidate({ id: 'fixed-depth', tier: 'subscription', reasoningLevelCount: 0 }),
    candidate({ id: 'five-levels', tier: 'subscription', reasoningLevelCount: 5 })
  ]);
  assert.deepEqual(ordered.map((c) => c.id), ['five-levels', 'fixed-depth']);
});

test('identical cost and capability keeps the authored order (stable)', () => {
  // An operator's hand-ordering must survive wherever no fact contradicts it.
  const ordered = orderChainByCostThenCapability([
    candidate({ id: 'first', tier: 'paid' }),
    candidate({ id: 'second', tier: 'paid' }),
    candidate({ id: 'third', tier: 'paid' })
  ]);
  assert.deepEqual(ordered.map((c) => c.id), ['first', 'second', 'third']);
});

test('every candidate survives ordering — it only reorders', () => {
  const input = [
    candidate({ id: 'a', tier: 'paid' }),
    candidate({ id: 'b', tier: 'free' }),
    candidate({ id: 'c', tier: undefined }),
    candidate({ id: 'd', tier: 'subscription' })
  ];
  const ordered = orderChainByCostThenCapability(input);
  assert.equal(ordered.length, input.length);
  assert.deepEqual(new Set(ordered.map((c) => c.id)), new Set(input.map((c) => c.id)));
});

test('capability score rewards each axis, context dominant', () => {
  const base = candidate({ contextLength: 100000, reasoningLevelCount: 0 });
  assert.ok(capabilityScore(candidate({ contextLength: 1000000 })) > capabilityScore(base));
  assert.ok(capabilityScore(candidate({ reasoningLevelCount: 4 })) > capabilityScore(base));
  assert.ok(capabilityScore(candidate({ supportsVision: true })) > capabilityScore(base));
  // A big-context model must beat a small-context model that wins on tiebreaks.
  const big = capabilityScore(candidate({ contextLength: 1000000, reasoningLevelCount: 0, supportsVision: false }));
  const small = capabilityScore(candidate({ contextLength: 64000, reasoningLevelCount: 5, supportsVision: true }));
  assert.ok(big > small);
});

// ── Eligibility: a requirement may only REMOVE candidates ──────────────────

test('a vision request excludes a text-only step', () => {
  const result = candidateCanServe(
    { contextLength: 200000, supportsVision: false, reasoningLevelCount: 4 },
    { requiresVision: true, requiresReasoningDial: false, minContext: 1000 }
  );
  assert.deepEqual(result, { eligible: false, reason: 'no_multimodal_support' });
});

test('a request that chose a thinking level excludes a step with no dial', () => {
  // This is the defect the filter existed without: a model can reason at one
  // fixed depth and still have no dial, so it cannot honour a chosen level.
  const result = candidateCanServe(
    { contextLength: 200000, supportsVision: true, reasoningLevelCount: 0 },
    { requiresVision: false, requiresReasoningDial: true, minContext: 1000 }
  );
  assert.deepEqual(result, { eligible: false, reason: 'no_reasoning_dial' });
});

test('a request that said nothing about thinking accepts a model with no dial', () => {
  const result = candidateCanServe(
    { contextLength: 200000, supportsVision: true, reasoningLevelCount: 0 },
    { requiresVision: false, requiresReasoningDial: false, minContext: 1000 }
  );
  assert.deepEqual(result, { eligible: true });
  assert.equal(capabilityScore(candidate({ reasoningLevelCount: 0 })) > 0, true);
});

test('vision is reported as the reason before a missing dial', () => {
  // The reported reason must be the one a caller can act on, so the more
  // disqualifying check wins.
  const result = candidateCanServe(
    { contextLength: 200000, supportsVision: false, reasoningLevelCount: 0 },
    { requiresVision: true, requiresReasoningDial: true, minContext: 1000 }
  );
  assert.equal(result.reason, 'no_multimodal_support');
});

// ── Requirement detection from the wire ────────────────────────────────────

test('every wire shape that states a level is detected as a reasoning requirement', () => {
  // Any explicit level counts, including "off": a model with no dial cannot be
  // told to stop thinking either.
  const shapes = [
    { reasoning_effort: 'high' },
    { reasoning_effort: 'none' },
    { think: true },
    { think: false },
    { enable_thinking: true },
    { thinking: { type: 'enabled', budget_tokens: 1024 } },
    { thinking: { type: 'disabled' } },
    { extra_body: { enable_thinking: true } },
    { extra_body: { reasoning_effort: 'low' } },
    { extra_body: { reasoning_budget: 2048 } }
  ];
  for (const shape of shapes) {
    assert.equal(requestRequiresReasoningDial({ model: 'x', messages: [], ...shape }), true,
      `not detected: ${JSON.stringify(shape)}`);
  }
});

test('a request that states nothing needs no dial', () => {
  assert.equal(requestRequiresReasoningDial({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }), false);
  assert.equal(requestRequiresReasoningDial({}), false);
  // An empty effort string is not a choice.
  assert.equal(requestRequiresReasoningDial({ reasoning_effort: '   ' }), false);
});

// ── The filter itself ──────────────────────────────────────────────────────

function specsById(table) {
  return (modelId) => table[modelId] || { contextLength: 64000, outputTokens: 4096, supportsImages: false, supportsTools: true };
}

test('the filter drops no-dial steps and reports why', () => {
  const table = {
    'dial-model': { contextLength: 1000000, outputTokens: 8192, supportsImages: false, supportsTools: true, reasoningLevelCount: 4 },
    'fixed-model': { contextLength: 1000000, outputTokens: 8192, supportsImages: false, supportsTools: true, reasoningLevelCount: 0 }
  };
  const result = filterEligibleFallbackModels(
    ['dial-model', 'fixed-model'],
    { model: 'route', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
    specsById(table)
  );
  assert.deepEqual(result.eligible, ['dial-model']);
  assert.deepEqual(result.skipped.map((s) => s.reason), ['no_reasoning_dial']);
  assert.equal(result.requiresReasoningDial, true);
});

test('the filter keeps every step when the caller stated no level', () => {
  const table = {
    'dial-model': { contextLength: 1000000, outputTokens: 8192, supportsImages: false, supportsTools: true, reasoningLevelCount: 4 },
    'fixed-model': { contextLength: 1000000, outputTokens: 8192, supportsImages: false, supportsTools: true, reasoningLevelCount: 0 }
  };
  const result = filterEligibleFallbackModels(
    ['dial-model', 'fixed-model'],
    { model: 'route', messages: [{ role: 'user', content: 'hi' }] },
    specsById(table)
  );
  assert.deepEqual(result.eligible, ['dial-model', 'fixed-model']);
  assert.equal(result.requiresReasoningDial, false);
});

test('a chain with no eligible dial fails loudly instead of degrading silently', () => {
  const table = {
    'fixed-model': { contextLength: 1000000, outputTokens: 8192, supportsImages: false, supportsTools: true, reasoningLevelCount: 0 }
  };
  const result = filterEligibleFallbackModels(
    ['fixed-model'],
    { model: 'route', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'high' },
    specsById(table)
  );
  assert.deepEqual(result.eligible, []);
  assert.equal(result.error, 'no_reasoning_models');
});

test('the largest-context fallback cannot reintroduce a filtered step', () => {
  // When nothing fits the context window the filter retries the biggest model.
  // That rescue must operate on the already-narrowed set, or a request that
  // required a dial would silently land on a model without one.
  const table = {
    'big-no-dial': { contextLength: 2000000, outputTokens: 8192, supportsImages: false, supportsTools: true, reasoningLevelCount: 0 },
    'small-with-dial': { contextLength: 32000, outputTokens: 8192, supportsImages: false, supportsTools: true, reasoningLevelCount: 4 }
  };
  const result = filterEligibleFallbackModels(
    ['big-no-dial', 'small-with-dial'],
    // A prompt large enough that neither model has room.
    { model: 'route', reasoning_effort: 'high', messages: [{ role: 'user', content: 'x'.repeat(4000000) }] },
    specsById(table)
  );
  assert.ok(result.eligible.includes('small-with-dial') || result.eligible.length === 0);
  assert.equal(result.eligible.includes('big-no-dial'), false,
    'the context rescue must not bypass the reasoning-dial gate');
});

// ── Provider coverage ──────────────────────────────────────────────────────

test('coverage reports a configured provider missing from the chain', () => {
  // Measured 2026-11-09: 15 providers configured, antigravity (a whole OAuth
  // subscription) absent from the chain entirely.
  const gaps = providerCoverageGaps({
    configuredProviders: ['zenmux', 'openrouter', 'antigravity', 'typesafe'],
    nonChatProviders: ['typesafe'],
    chainProviders: ['zenmux', 'openrouter']
  });
  assert.deepEqual(gaps.providersAbsentFromChain, ['antigravity']);
});

test('a decisions-only provider is not reported as a coverage gap', () => {
  const gaps = providerCoverageGaps({
    configuredProviders: ['typesafe', 'zenmux'],
    nonChatProviders: ['typesafe'],
    chainProviders: ['zenmux']
  });
  assert.deepEqual(gaps.providersAbsentFromChain, []);
});

test('coverage flags a provider reached by only one step', () => {
  const gaps = providerCoverageGaps({
    configuredProviders: ['zenmux', 'pioneer'],
    chainProviders: ['zenmux', 'zenmux', 'pioneer']
  });
  assert.deepEqual(gaps.singleStepProviders, ['pioneer']);
  assert.equal(gaps.singleStepProviders.includes('zenmux'), false);
});

test('coverage flags a chain step whose provider has no key', () => {
  const gaps = providerCoverageGaps({
    configuredProviders: ['zenmux'],
    chainProviders: ['zenmux', 'nebius']
  });
  assert.deepEqual(gaps.unconfiguredProviders, ['nebius']);
});
