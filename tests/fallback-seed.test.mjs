import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FALLBACK_FREE_IDS,
  DEFAULT_FALLBACK_ORDERED_IDS,
  DEFAULT_FALLBACK_PAID_IDS,
  DEFAULT_FALLBACK_SUBSCRIPTION_IDS,
  OBSOLETE_PRESET_ROUTE_IDS,
  PRESET_FALLBACK_ROUTES,
  buildDefaultFallbackModelIds
} from '../build/routing-defaults.js';
import { costBandFor } from '../build/fallback-topology.js';
import { PROVIDER_MODEL_REGISTRY } from '../build/provider-model-registries.js';

/**
 * Tier facts for the seeded ids, resolved from the curated registry the same way
 * the router does at boot. `routing-defaults.ts` lists presented ids, while the
 * registry is keyed by upstream id, so matching is suffix-based exactly as
 * `pickBaselineModel`/`providerModelAliases` do it.
 */
const FALLBACK_TIER_FIXTURE = (() => {
  const facts = {};
  for (const entries of Object.values(PROVIDER_MODEL_REGISTRY)) {
    for (const entry of entries || []) {
      const segment = String(entry.id).toLowerCase().replace(/[^a-z0-9._+-]+/g, '-');
      if (!entry.tier) continue;
      facts[entry.id] = facts[entry.id] || entry.tier;
      facts[segment] = facts[segment] || entry.tier;
    }
  }
  return new Proxy(facts, {
    get(target, key) {
      const id = String(key).toLowerCase();
      if (target[id]) return target[id];
      // Presented ids carry a provider prefix; the registry id is the suffix.
      for (const [registryId, tier] of Object.entries(target)) {
        if (id.endsWith(registryId) || id.endsWith(registryId.replace(/[^a-z0-9._+-]+/g, '-'))) return tier;
      }
      return undefined;
    }
  });
})();

/**
 * The default seed has to be a chain a fresh install can actually walk.
 *
 * Measured on 2026-11-09, before this was pinned: 23 of 25 ids in the
 * hand-written seed and 47 of 54 across the presets were absent from the live
 * catalog. A stale id is not harmless — the executor skips it at run time, so the
 * chain looked long while most of its steps were dead, and the operator had no
 * way to see that from the id list alone.
 *
 * These assertions are offline: they cannot check that an id is live (that needs
 * the router), so `scripts/seed-fallback-chain.mjs` does that half against a
 * running instance and fails when a configured provider has no step. What is
 * pinned here is the SHAPE — the parts that must hold regardless of what happens
 * to be served today.
 */

test('the seed concatenates its bands in cost order', () => {
  // The order a request walks must equal the cost order; a band boundary that
  // lands in the wrong place is a subscription step billed before a free one.
  const expected = [
    ...DEFAULT_FALLBACK_FREE_IDS,
    ...DEFAULT_FALLBACK_SUBSCRIPTION_IDS,
    ...DEFAULT_FALLBACK_PAID_IDS
  ];
  assert.deepEqual([...DEFAULT_FALLBACK_ORDERED_IDS], expected);
});

test('every free step is in the free band', () => {
  // The tier FACT decides, not the id text: `ollama-deepseek-v4-flash-cloud` is a
  // documented free-tier cloud model whose id does not contain "free", and the
  // id heuristic alone would misclassify it. `fallback-seed` relies on the
  // registry tier here, which is why the seed is generated rather than typed.
  const tierOf = (id) => FALLBACK_TIER_FIXTURE[id];
  for (const id of DEFAULT_FALLBACK_FREE_IDS) {
    const band = costBandFor(tierOf(id), id);
    assert.equal(band, 'free',
      `${id} is in the free band but resolves to ${band} (tier=${tierOf(id) ?? 'none'})`);
  }
});

test('no subscription step is a metered model', () => {
  // A subscription band entry that is actually metered would spend money while
  // the operator believed it was covered by a plan.
  for (const id of DEFAULT_FALLBACK_SUBSCRIPTION_IDS) {
    assert.notEqual(costBandFor('paid', id, 'key'), 'subscription',
      `${id} is listed as subscription but is metered`);
  }
});

test('the seed has no duplicates', () => {
  const seen = new Set();
  for (const id of DEFAULT_FALLBACK_ORDERED_IDS) {
    assert.equal(seen.has(id), false, `${id} appears twice`);
    seen.add(id);
  }
});

test('every band is non-empty, so the ordering is actually exercised', () => {
  assert.ok(DEFAULT_FALLBACK_FREE_IDS.length > 0);
  assert.ok(DEFAULT_FALLBACK_SUBSCRIPTION_IDS.length > 0);
  assert.ok(DEFAULT_FALLBACK_PAID_IDS.length > 0);
});

test('the seed reaches more than one provider per band', () => {
  // A single provider carrying a whole band means one outage takes out that
  // entire cost tier.
  const providerOf = (id) => id.split('-')[0];
  for (const [name, band] of Object.entries({
    free: DEFAULT_FALLBACK_FREE_IDS,
    subscription: DEFAULT_FALLBACK_SUBSCRIPTION_IDS,
    paid: DEFAULT_FALLBACK_PAID_IDS
  })) {
    const providers = new Set(band.map(providerOf));
    assert.ok(providers.size >= 2,
      `the ${name} band is served by only ${[...providers].join(', ')}`);
  }
});

test('buildDefaultFallbackModelIds returns a fresh copy', () => {
  const first = buildDefaultFallbackModelIds();
  first.push('mutated');
  const second = buildDefaultFallbackModelIds();
  assert.equal(second.includes('mutated'), false,
    'a caller must not be able to mutate the exported seed');
});

test('each preset is non-empty and ordered from ids the seed knows about', () => {
  // A preset whose steps are not in the serving catalog is a chain of dead
  // steps; the measured 2026-11-09 state had 47 of 54 like that.
  const known = new Set(DEFAULT_FALLBACK_ORDERED_IDS);
  for (const preset of PRESET_FALLBACK_ROUTES) {
    assert.ok(preset.models.length > 0, `preset "${preset.id}" is empty`);
    for (const id of preset.models) {
      assert.equal(known.has(id), true,
        `preset "${preset.id}" references "${id}", which the seed does not list`);
    }
  }
});

test('the free preset contains only free steps', () => {
  const free = PRESET_FALLBACK_ROUTES.find((preset) => preset.id === 'free');
  assert.ok(free);
  for (const id of free.models) {
    const band = costBandFor(FALLBACK_TIER_FIXTURE[id], id);
    assert.equal(band, 'free', `free preset contains a billed step: ${id} (band ${band})`);
  }
});

test('the multimodal preset contains only vision-capable ids', () => {
  // The filter would discard text-only steps anyway, so a preset that lists them
  // is a chain the operator sees as longer than it is.
  const multimodal = PRESET_FALLBACK_ROUTES.find((preset) => preset.id === 'multimodal');
  assert.ok(multimodal);
  // Vision names, pinned: these providers serve a vision variant under a name
  // that names the family. Kept as an explicit list so a text-only id cannot slip
  // in unnoticed.
  const visionIds = new Set([
    'antigravity-gemini-3.7-flash',
    'xiaomi-mimo-mimo-v2.6-pro',
    'zai-glm-5.3-flash',
    'openrouter-free',
    'pioneer-moonshotai-kimi-k3',
    'kilo-moonshotai-kimi-latest-paid'
  ]);
  for (const id of multimodal.models) {
    assert.equal(visionIds.has(id), true, `multimodal preset lists a text-only id: ${id}`);
  }
});

test('the obsolete-preset migration list is append-only in spirit', () => {
  // Removing an id from this list would let an old deployment resurrect a route
  // nobody serves. The six historical ids must stay.
  for (const id of ['preferred-text', 'preferred-multimodal', 'performance-text',
    'performance-multimodal', 'low-cost-text', 'low-cost-multimodal']) {
    assert.ok(OBSOLETE_PRESET_ROUTE_IDS.includes(id), `${id} must stay in the migration list`);
  }
});
