#!/usr/bin/env node
/**
 * Regenerate the default fallback seed from the RUNNING router's facts.
 *
 * The seed in `src/routing-defaults.ts` is not hand-maintained. Measured on
 * 2026-11-09, 23 of 25 ids in the old hand-written seed and 47 of 54 across the
 * presets were absent from the live catalog — models get renamed, retired, or
 * never curated, and a stale id is a step that silently cascades into the next
 * one. Regenerating from what the router actually serves makes that impossible.
 *
 * Contract this enforces:
 *   - every chat-capable provider with a configured key appears at least once,
 *     so one provider failure cannot remove a subscription from the chain;
 *   - ordering is cost-first (free, subscription/OAuth, paid, unknown), then the
 *     most capable model inside each band;
 *   - OAuth providers count as already-paid capacity, not metered spend.
 *
 * Usage:
 *   node scripts/seed-fallback-chain.mjs            # print the proposed seed
 *   node scripts/seed-fallback-chain.mjs --json     # machine-readable
 *   LOCAL_ROUTER_TEST_URL=... node scripts/seed-fallback-chain.mjs
 *
 * Read-only: it prints, it never writes the chain. Applying a new seed is a
 * deliberate operator action.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { costBandFor } from '../build/fallback-topology.js';
import { getProviderPricingEntry } from '../build/provider-pricing.js';
import { reasoningLevelsFor, resolveCachingPolicy } from '../build/provider-policy.js';

const ROUTER = process.env.LOCAL_ROUTER_TEST_URL || 'http://127.0.0.1:11434';

/** Providers reached by an OAuth subscription: already paid for. */
const OAUTH_PROVIDERS = new Set(['antigravity', 'github-copilot', 'cursor']);
/** Providers that cannot serve chat, so their absence is correct. */
const NON_CHAT_PROVIDERS = new Set(['typesafe']);

function readEndpointCache() {
  const cachePath = path.join(os.homedir(), '.config', 'local-router', 'endpoint-models-cache.json');
  try {
    return new Map(JSON.parse(fs.readFileSync(cachePath, 'utf8')).map((row) => [row.id, row]));
  } catch {
    return new Map();
  }
}

const [modelsResponse, configsResponse] = await Promise.all([
  fetch(`${ROUTER}/v1/models`),
  fetch(`${ROUTER}/api/provider-configs`)
]);
if (!modelsResponse.ok) {
  console.error(`Cannot read models from ${ROUTER} (${modelsResponse.status}). Is the router running?`);
  process.exit(2);
}

const models = await modelsResponse.json();
const configs = await configsResponse.json();
const cacheById = readEndpointCache();

const configured = new Set(
  (configs.data || []).filter((provider) => provider.configured).map((provider) => provider.name)
);

const capabilityScore = (row) =>
  (row.contextLength || 0) / 1000
  + row.reasoningLevels * 5
  + (row.supportsVision ? 3 : 0)
  + (row.caches ? 1 : 0);

const rows = [];
for (const model of models.data || []) {
  const provider = model.owned_by;
  if (!configured.has(provider) || NON_CHAT_PROVIDERS.has(provider)) continue;
  // Non-chat modalities are never fallback steps for a completion request.
  if (/tts|asr|embed|whisper|rerank/i.test(model.id)) continue;

  const accessPath = OAUTH_PROVIDERS.has(provider) ? 'oauth' : 'key';
  rows.push({
    id: model.id,
    provider,
    accessPath,
    tier: cacheById.get(model.id)?.tier,
    band: costBandFor(cacheById.get(model.id)?.tier, model.id, accessPath),
    contextLength: model.context_length || 0,
    supportsVision: Boolean(model.capabilities?.imageInput),
    reasoningLevels: (reasoningLevelsFor(provider, model.id) || []).length,
    caches: resolveCachingPolicy(provider, model.id).mechanism !== 'none',
    price: getProviderPricingEntry(model.id)?.inputPricePerM ?? null
  });
}

// One representative per provider per band: coverage is the goal, not a list of
// every model. The most capable model in each band reaches that provider best.
const best = new Map();
for (const row of rows) {
  const key = `${row.provider}::${row.band}`;
  const current = best.get(key);
  if (!current || capabilityScore(row) > capabilityScore(current)) best.set(key, row);
}

const bandRank = { free: 0, subscription: 1, paid: 2, unknown: 3 };
const picks = [...best.values()].sort((a, b) => {
  if (bandRank[a.band] !== bandRank[b.band]) return bandRank[a.band] - bandRank[b.band];
  if (a.band === 'paid') {
    const priceA = a.price ?? Number.POSITIVE_INFINITY;
    const priceB = b.price ?? Number.POSITIVE_INFINITY;
    if (priceA !== priceB) return priceA - priceB;
  }
  return capabilityScore(b) - capabilityScore(a);
});

const covered = new Set(picks.map((row) => row.provider));
const missing = [...configured].filter((provider) => !NON_CHAT_PROVIDERS.has(provider) && !covered.has(provider));

const bands = { free: [], subscription: [], paid: [], unknown: [] };
for (const pick of picks) bands[pick.band].push(pick.id);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    router: ROUTER,
    coveredProviders: [...covered],
    missingProviders: missing,
    bands,
    ordered: picks.map((row) => row.id)
  }, null, 2));
} else {
  console.log(`router: ${ROUTER}`);
  console.log(`providers covered: ${covered.size}  missing: ${missing.length ? missing.join(', ') : 'none'}\n`);
  for (const [band, ids] of Object.entries(bands)) {
    if (ids.length === 0) continue;
    console.log(`${band.toUpperCase()} (${ids.length})`);
    for (const id of ids) {
      const row = picks.find((pick) => pick.id === id);
      console.log(`  '${id}',${' '.repeat(Math.max(1, 46 - id.length))}// ctx ${row.contextLength}, levels ${row.reasoningLevels}`);
    }
    console.log();
  }
}

if (missing.length > 0) {
  console.error(`FAIL: ${missing.length} configured chat provider(s) have no step: ${missing.join(', ')}`);
  process.exit(1);
}
