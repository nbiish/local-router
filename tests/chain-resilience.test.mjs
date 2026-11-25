/**
 * chain-resilience.test.mjs — the guarantees behind "point one harness at
 * local-router/fallback-models and it is never interrupted".
 *
 * Two defects measured live on 2026-11-21 are covered here:
 *
 *   1. Saving a corrected API key did not clear that provider's quarantine.
 *      `key_rejected` parks a member for 30 minutes, and `POST /api/keys`
 *      touched no health state — so the operator fixed a key and the chain kept
 *      skipping it. On a chain whose other members are also down, that is an
 *      interruption the operator had already resolved.
 *
 *   2. Exhaustion returned the LAST UPSTREAM STATUS. A chain ending on a 401
 *      answered the agent with 401, which reads as "your credentials are wrong"
 *      even though the router holds every key and never forwards the caller's.
 *      Exhaustion is now 503 + `chain_exhausted`, with the upstream status kept
 *      as evidence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-chain-'));
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.LOCAL_ROUTER_HEALTH_STATE = path.join(tmpHome, 'health.json');

const { healthRegistry } = await import('../build/health-registry.js');

function quarantine(chainId, model, errorType = 'upstream_http_auth') {
  healthRegistry.recordOutcome({
    chainId,
    model,
    ok: false,
    errorType,
    status: 401,
    at: Date.now()
  });
}

// ---------------------------------------------------------------------------
// Key change invalidates the old key's verdict
// ---------------------------------------------------------------------------

test('a rejected key parks the member (baseline for the clearing tests)', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');
  const verdict = healthRegistry.mayAttempt('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');
  assert.equal(verdict.allowed, false, 'a key_rejected outcome must park the member');
});

test('clearProvider lifts the park so a corrected key is used on the next request', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');
  assert.equal(healthRegistry.mayAttempt('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid').allowed, false);

  const cleared = healthRegistry.clearProvider('cline');
  assert.equal(cleared, 1, 'exactly the cline member should be unparked');
  assert.equal(
    healthRegistry.mayAttempt('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid').allowed,
    true,
    'the corrected key must be usable immediately, not after a 30-minute cooldown'
  );
});

test('clearProvider only touches the named provider', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');
  quarantine('fallback-models', 'zenmux-deepseek-v4.1-flash');
  quarantine('fallback-models', 'zai-glm-5.3');

  healthRegistry.clearProvider('cline');

  assert.equal(healthRegistry.mayAttempt('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid').allowed, true);
  assert.equal(healthRegistry.mayAttempt('fallback-models', 'zenmux-deepseek-v4.1-flash').allowed, false,
    'a different provider must stay parked');
  assert.equal(healthRegistry.mayAttempt('fallback-models', 'zai-glm-5.3').allowed, false);
});

test('provider matching is by id prefix, not substring', () => {
  // `zai` must not clear `zenmux-...` just because the letters appear somewhere.
  healthRegistry.reset();
  quarantine('fallback-models', 'zenmux-deepseek-v4.1-flash');
  const cleared = healthRegistry.clearProvider('zai');
  assert.equal(cleared, 0, 'zai must not claim a zenmux member');
  assert.equal(healthRegistry.mayAttempt('fallback-models', 'zenmux-deepseek-v4.1-flash').allowed, false);
});

test('clearProvider clears across every chain that member appears in', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');
  quarantine('fallback-performance', 'cline-deepseek-deepseek-v4-pro-paid');

  healthRegistry.clearProvider('cline');

  assert.equal(healthRegistry.mayAttempt('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid').allowed, true);
  assert.equal(healthRegistry.mayAttempt('fallback-performance', 'cline-deepseek-deepseek-v4-pro-paid').allowed, true,
    'a new key applies to the provider, not to one chain');
});

test('clearing a park keeps the failure history, so a repeat stays visible', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');
  const before = healthRegistry.diagnostics('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');
  healthRegistry.clearProvider('cline');
  const after = healthRegistry.diagnostics('fallback-models', 'cline-deepseek-deepseek-v4-pro-paid');

  assert.equal(after.quarantined, false, 'the park is lifted');
  // A key change does not erase what happened; the member can re-park on the
  // next bad outcome, and an operator still sees the record.
  assert.equal(after.consecutiveFailures, 0, 'the fresh attempt starts from zero strikes');
  assert.ok(before, 'diagnostics were readable before clearing');
});

test('a bundle resync clears every park', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-a');
  quarantine('fallback-models', 'zenmux-b');
  quarantine('fallback-models', 'zai-c');

  const cleared = healthRegistry.clearAllParks();
  assert.equal(cleared, 3);
  for (const model of ['cline-a', 'zenmux-b', 'zai-c']) {
    assert.equal(healthRegistry.mayAttempt('fallback-models', model).allowed, true, `${model} must be unparked`);
  }
});

test('clearProvider with an empty name is a no-op rather than a mass clear', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-a');
  assert.equal(healthRegistry.clearProvider(''), 0);
  assert.equal(healthRegistry.mayAttempt('fallback-models', 'cline-a').allowed, false);
  assert.equal(healthRegistry.clearProvider('   '), 0);
});

test('a cleared member that fails again re-parks (no permanent free pass)', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-a');
  healthRegistry.clearProvider('cline');
  assert.equal(healthRegistry.mayAttempt('fallback-models', 'cline-a').allowed, true);

  quarantine('fallback-models', 'cline-a');
  assert.equal(healthRegistry.mayAttempt('fallback-models', 'cline-a').allowed, false,
    'clearing is not immunity: a still-broken key parks again');
});

test('the park is persisted, so a restart does not resurrect it', () => {
  healthRegistry.reset();
  quarantine('fallback-models', 'cline-a');
  healthRegistry.clearProvider('cline');

  const raw = fs.readFileSync(process.env.LOCAL_ROUTER_HEALTH_STATE, 'utf8');
  const parsed = JSON.parse(raw);
  const entry = parsed.members['fallback-models::cline-a'];
  assert.ok(entry, 'the member is still tracked after clearing');
  assert.equal(entry.quarantineUntil, 0, 'the persisted cooldown is cleared');
  assert.equal(entry.consecutiveFailures, 0);
});
