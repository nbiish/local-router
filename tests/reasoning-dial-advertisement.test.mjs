import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Reasoning dial contract for /v1/models.
 *
 * A boolean `capabilities.reasoning` is not enough for a harness to build a thinking-mode
 * selector. StarNet (and clients following the same convention) reads a DECLARED list —
 * top-level `reasoningEfforts`, a vendor `effort.supported_levels` block, or
 * `capabilities.reasoning_effort` — and only then offers the levels. Given just a boolean it
 * renders a selector whose only option is "none": present but useless, which is exactly the
 * reported symptom ("I don't get to select a thinking mode").
 *
 * Verified live against a running router on 2026-11-07; this file pins the advertisement so a
 * refactor cannot silently drop back to the boolean-only shape.
 *
 * NOTE: these assertions read a LIVE router, so they are not part of the CI gate
 * (`npm test`). Run them after deploying:
 *     npm run verify:dials          # against 127.0.0.1:11434
 *     LOCAL_ROUTER_TEST_URL=... npm run verify:dials
 * They skip rather than fail when no router answers, so a stale deploy cannot masquerade as a
 * passing test.
 */

const ROUTER = process.env.LOCAL_ROUTER_TEST_URL || 'http://127.0.0.1:11434';

async function fetchModels() {
  const res = await fetch(`${ROUTER}/v1/models`);
  assert.ok(res.ok, `router not reachable at ${ROUTER}`);
  const body = await res.json();
  return { byId: new Map((body.data || []).map((m) => [m.id, m])), all: body.data || [] };
}

function reachable() {
  const probe = spawnSync(process.execPath, ['-e', `
    fetch('${ROUTER}/api/version').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  `], { timeout: 5000 });
  return probe.status === 0;
}

test('a reasoning model declares the levels, not just a boolean', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const { byId } = await fetchModels();
  const entry = byId.get('zenmux-deepseek-v4.1-flash');
  assert.ok(entry, 'zenmux-deepseek-v4.1-flash must be advertised');

  assert.equal(entry.capabilities?.reasoning, true, 'the boolean must still be there');

  const levels = entry.reasoningEfforts || entry.effort?.supported_levels || entry.capabilities?.reasoning_effort;
  assert.ok(Array.isArray(levels) && levels.length > 0,
    `a declared dial is required for a selector: ${JSON.stringify(entry).slice(0, 300)}`);
  assert.ok(levels.includes('none'), `"none" must be offered so a caller can switch thinking off: ${levels}`);
  // The levels the provider actually honours. Measured on ZenMux by billed reasoning_tokens.
  for (const level of ['minimal', 'low', 'medium', 'high']) {
    assert.ok(levels.includes(level), `${level} must be selectable: ${levels}`);
  }
  assert.equal(entry.defaultReasoningLevel, 'medium',
    'a default lets a harness preselect rather than guess');
});

test('the fallback route advertises a dial when a member can take one', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const { byId } = await fetchModels();
  const route = byId.get('local-router/fallback-models');
  assert.ok(route, 'the chat fallback route must be advertised');

  const levels = route.reasoningEfforts || route.effort?.supported_levels || route.capabilities?.reasoning_effort;
  assert.ok(Array.isArray(levels) && levels.length > 0,
    `selecting the route must offer a thinking selector too: ${JSON.stringify(route).slice(0, 300)}`);
  assert.ok(levels.includes('high'), `route levels: ${levels}`);
});

test('an embedding route declares no reasoning dial', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const { byId } = await fetchModels();
  const route = byId.get('local-router/fallback-embedding');
  assert.ok(route, 'the embedding route must be advertised');
  // Offering a thinking dial on an embeddings endpoint would be a lie the UI renders.
  assert.equal(route.capabilities?.reasoning, false);
  assert.ok(!route.reasoningEfforts, 'no dial may be advertised for embeddings');
  assert.ok(!route.effort, 'no vendor effort block may be advertised for embeddings');
});

test('every advertised dial is a non-empty list of known levels', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const { all } = await fetchModels();
  const known = new Set(['none', 'minimal', 'low', 'medium', 'high']);
  for (const entry of all) {
    if (!entry.reasoningEfforts) continue;
    assert.ok(Array.isArray(entry.reasoningEfforts) && entry.reasoningEfforts.length > 0,
      `${entry.id}: an empty dial is read as "declared off" by clients, so it must be omitted instead`);
    for (const level of entry.reasoningEfforts) {
      assert.ok(known.has(level), `${entry.id}: unknown level ${level}`);
    }
  }
});
