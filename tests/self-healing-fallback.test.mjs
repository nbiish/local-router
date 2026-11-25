import test from 'node:test';
import assert from 'node:assert/strict';

const { healthRegistry, selectForcedLastPassMembers } = await import('../build/health-registry.js');

const CHAIN = 'fallback-models';

test('upstream_http_quota quarantines immediately on strike 1 so multi-turn agents route around it', () => {
  healthRegistry.reset();
  const now = Date.now();
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'zai-glm-5.4',
    outcome: 'failed',
    errorType: 'upstream_http_quota',
    provider: 'zai',
    bodyText: 'usage limit exceeded for this billing window',
    at: now
  });
  const verdict = healthRegistry.mayAttempt(CHAIN, 'zai-glm-5.4');
  assert.equal(verdict.allowed, false, 'quota exhaustion must quarantine immediately on strike 1');
  assert.equal(verdict.reason, 'cooldown:upstream_http_quota');
  assert.ok(verdict.until > now);
});

test('upstream_http_rate_limit with published Retry-After header quarantines on strike 1 for published duration', () => {
  healthRegistry.reset();
  const now = Date.now();
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'openrouter-step-3.7',
    outcome: 'failed',
    errorType: 'upstream_http_rate_limit',
    headers: { 'Retry-After': '90' },
    at: now
  });
  const verdict = healthRegistry.mayAttempt(CHAIN, 'openrouter-step-3.7');
  assert.equal(verdict.allowed, false, 'published Retry-After must park immediately');
  assert.equal(verdict.until, now + 90_000);
});

test('upstream_http_rate_limit with subscription window exhaustion parks on strike 1 for window', () => {
  healthRegistry.reset();
  const now = Date.now();
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'xiaomi-mimo-v2.6-pro',
    outcome: 'failed',
    errorType: 'upstream_http_rate_limit',
    policy: { class: 'subscription', windowMinutes: 300, note: 'test-sub' },
    bodyText: 'Your daily limit / usage limit has been reached',
    at: now
  });
  const verdict = healthRegistry.mayAttempt(CHAIN, 'xiaomi-mimo-v2.6-pro');
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.until, now + 300 * 60_000);
});

test('bare transient rate-limit without header or window hint keeps 3-strike tolerance', () => {
  healthRegistry.reset();
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'transient-model',
    outcome: 'failed',
    errorType: 'upstream_http_rate_limit',
    bodyText: 'temporarily rate-limited upstream. Please retry shortly'
  });
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'transient-model').allowed, true, '1st transient burst stays runnable');
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'transient-model',
    outcome: 'failed',
    errorType: 'upstream_http_rate_limit',
    bodyText: 'temporarily rate-limited upstream. Please retry shortly'
  });
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'transient-model').allowed, true, '2nd transient burst stays runnable');
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'transient-model',
    outcome: 'failed',
    errorType: 'upstream_http_rate_limit',
    bodyText: 'temporarily rate-limited upstream. Please retry shortly'
  });
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'transient-model').allowed, false, '3rd strike parks');
});

test('selectForcedLastPassMembers excludes disabled/ineligible/attempted models and orders earliest-expiring first', () => {
  const now = Date.now();
  const quarantined = [
    { model: 'disabled-model', errorType: 'upstream_http_quota', until: now + 10_000 },
    { model: 'already-tried', errorType: 'upstream_http_rate_limit', until: now + 5_000 },
    { model: 'long-park', errorType: 'upstream_http_auth', until: now + 1_800_000 },
    { model: 'soonest-heal', errorType: 'upstream_http_quota', until: now + 30_000 },
    { model: 'tie-second', errorType: 'upstream_http_quota', until: now + 30_000 },
  ];
  const eligibleActive = ['tie-second', 'soonest-heal', 'long-park', 'already-tried'];
  const attempted = new Set(['already-tried']);

  const picked = selectForcedLastPassMembers(quarantined, eligibleActive, attempted);
  assert.deepEqual(
    picked.map((m) => m.model),
    ['tie-second', 'soonest-heal', 'long-park'],
    'excludes disabled/attempted, sorts by earliest until, tie-breaks by chain order'
  );
});

test('successful answer during recovery immediately self-heals a quarantined member', () => {
  healthRegistry.reset();
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'zai-glm-5.4',
    outcome: 'failed',
    errorType: 'upstream_http_quota',
    bodyText: 'quota exceeded'
  });
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'zai-glm-5.4').allowed, false);
  healthRegistry.recordOutcome({
    chainId: CHAIN,
    model: 'zai-glm-5.4',
    outcome: 'answered'
  });
  assert.equal(healthRegistry.mayAttempt(CHAIN, 'zai-glm-5.4').allowed, true, 'recovery answer restores member immediately');
});
