import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyHttpFailure } = await import('../build/index.js');
const { errorClassFor } = await import('../build/trajectories.js');
const { healthRegistry } = await import('../build/health-registry.js');

const CHAIN = 'chain-h';

function withEnv(overrides, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fail(model, errorType, at) {
  healthRegistry.recordOutcome({ chainId: CHAIN, model, outcome: 'failed', errorType, at });
}

function answer(model, at) {
  healthRegistry.recordOutcome({ chainId: CHAIN, model, outcome: 'answered', at });
}

test('errorClassFor maps failure types to the four triage classes', () => {
  assert.equal(errorClassFor('upstream_http_auth'), 'key_rejected');
  assert.equal(errorClassFor('upstream_http_payment_required'), 'out_of_funds');
  assert.equal(errorClassFor('upstream_http_quota'), 'usage_limit');
  assert.equal(errorClassFor('upstream_http_rate_limit'), 'usage_limit');
  assert.equal(errorClassFor('upstream_http_invalid_request'), 'usage_error');
  assert.equal(errorClassFor('upstream_http_unavailable'), 'other');
  assert.equal(errorClassFor('provider_config'), 'other');
  assert.equal(errorClassFor(null), 'other');
});

test('classifyHttpFailure separates out-of-funds from usage limits', () => {
  // The four §4.3 classes must be distinguishable from status + body alone.
  assert.equal(classifyHttpFailure(402, ''), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(429, 'insufficient_quota'), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(429, ''), 'upstream_http_rate_limit');
  assert.equal(classifyHttpFailure(401, 'invalid api key'), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(400, 'api_usage_error: unknown model'), 'upstream_http_invalid_request');
});

test('key_rejected quarantines after one failure (retrying cannot heal)', () => {
  healthRegistry.reset();
  withEnv({ LOCAL_ROUTER_HEALTH_COOLDOWN_AUTH_MIN: '30' }, () => {
    fail('m-auth', 'upstream_http_auth');
    const verdict = healthRegistry.mayAttempt(CHAIN, 'm-auth');
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'cooldown:upstream_http_auth');
    assert.ok(verdict.until > Date.now());
  });
});

test('out_of_funds quarantines after one failure', () => {
  healthRegistry.reset();
  fail('m-funds', 'upstream_http_payment_required');
  const verdict = healthRegistry.mayAttempt(CHAIN, 'm-funds');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'cooldown:upstream_http_payment_required');
});

test('retryable classes quarantine after three consecutive strikes, not before', () => {
  healthRegistry.reset();
  fail('m-limit', 'upstream_http_rate_limit');
  fail('m-limit', 'upstream_http_rate_limit');
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-limit').allowed, true, 'two strikes still run');
  fail('m-limit', 'upstream_http_rate_limit');
  const verdict = healthRegistry.mayAttempt(CHAIN, 'm-limit');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'cooldown:upstream_http_rate_limit');
});

test('a success resets the strike window and clears quarantine', () => {
  healthRegistry.reset();
  fail('m-reset', 'upstream_http_unavailable');
  fail('m-reset', 'upstream_http_unavailable');
  answer('m-reset');
  fail('m-reset', 'upstream_http_unavailable');
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-reset').allowed, true, 'streak restarted at one');
  fail('m-quarantine', 'upstream_http_payment_required');
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-quarantine').allowed, false);
  answer('m-quarantine');
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-quarantine').allowed, true, 'success clears the cooldown');
});

test('config and request-shape failures are not evidence against a member', () => {
  healthRegistry.reset();
  fail('m-config', 'provider_config');
  fail('m-config', 'provider_config');
  fail('m-config', 'embedding_dimension_mismatch');
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-config').allowed, true);
});

test('cooldown expires back to allowed', () => {
  healthRegistry.reset();
  withEnv({ LOCAL_ROUTER_HEALTH_COOLDOWN_AUTH_MIN: '0' }, () => {
    fail('m-expiry', 'upstream_http_auth');
    assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-expiry').allowed, true);
  });
});

test('quarantine is chain-scoped', () => {
  healthRegistry.reset();
  fail('m-scope', 'upstream_http_auth');
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-scope').allowed, false);
  assert.equal(healthRegistry.mayAttempt('other-chain', 'm-scope').allowed, true);
});

test('snapshot reports dead vs degraded members per chain', () => {
  healthRegistry.reset();
  fail('m-dead', 'upstream_http_auth');
  fail('m-degraded', 'upstream_http_unavailable');
  fail('m-degraded', 'upstream_http_unavailable');
  fail('m-degraded', 'upstream_http_unavailable');
  const snapshot = healthRegistry.snapshot()[CHAIN];
  assert.deepEqual(snapshot.dead.map((m) => m.model), ['m-dead']);
  assert.deepEqual(snapshot.degraded.map((m) => m.model), ['m-degraded']);
  assert.deepEqual(healthRegistry.quarantined(CHAIN).map((m) => m.model).sort(), ['m-dead', 'm-degraded']);
});

test('LOCAL_ROUTER_HEALTH_DISABLE=1 turns the registry into a no-op', () => {
  healthRegistry.reset();
  withEnv({ LOCAL_ROUTER_HEALTH_DISABLE: '1' }, () => {
    fail('m-off', 'upstream_http_auth');
    assert.equal(healthRegistry.mayAttempt(CHAIN, 'm-off').allowed, true);
    assert.deepEqual(healthRegistry.snapshot(), {});
  });
});
