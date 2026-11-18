import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-persist-'));
process.env.LOCAL_ROUTER_HEALTH_STATE = path.join(tmpDir, 'health.json');
process.env.LOCAL_ROUTER_HEALTH_DISABLE = '0';

const { healthRegistry } = await import('../build/health-registry.js');

const HOUR = 3_600_000;

test('a quarantined member survives a save/load cycle', () => {
  healthRegistry.reset();
  healthRegistry.recordOutcome({
    chainId: 'chain-a',
    model: 'dead-model',
    outcome: 'failed',
    errorType: 'upstream_http_auth'
  });
  assert.equal(healthRegistry.mayAttempt('chain-a', 'dead-model').allowed, false);

  assert.equal(healthRegistry.save(), true);

  // Simulate a restart: wipe memory, reload from disk.
  healthRegistry.reset();
  assert.equal(healthRegistry.mayAttempt('chain-a', 'dead-model').allowed, true, 'clean state before load');
  assert.equal(healthRegistry.load(), 'loaded');
  assert.equal(healthRegistry.mayAttempt('chain-a', 'dead-model').allowed, false,
    'restart must not forget a quarantined member');
});

test('an expired cooldown is restored as usable, not as still-parked', () => {
  healthRegistry.reset();
  const past = Date.now() - 2 * HOUR;
  healthRegistry.recordOutcome({
    chainId: 'chain-b',
    model: 'recovered',
    outcome: 'failed',
    errorType: 'upstream_http_auth',
    at: past
  });
  healthRegistry.save();
  healthRegistry.reset();
  healthRegistry.load();
  assert.equal(healthRegistry.mayAttempt('chain-b', 'recovered').allowed, true,
    'a park from two hours ago must not still block traffic');
});

test('a corrupt state file fails OPEN with a clean registry', () => {
  healthRegistry.reset();
  fs.writeFileSync(process.env.LOCAL_ROUTER_HEALTH_STATE, '{ this is not json', 'utf8');
  assert.equal(healthRegistry.load(), 'corrupt', 'corruption must be reported');
  assert.equal(healthRegistry.mayAttempt('any', 'any').allowed, true,
    'a bad file must never quarantine everything');
});

test('an unexpected shape fails open rather than throwing', () => {
  healthRegistry.reset();
  fs.writeFileSync(process.env.LOCAL_ROUTER_HEALTH_STATE, JSON.stringify({ schema: 'x', members: null }), 'utf8');
  assert.equal(healthRegistry.load(), 'corrupt');
  assert.equal(healthRegistry.mayAttempt('any', 'any').allowed, true);
});

test('a missing file reports missing and starts clean', () => {
  healthRegistry.reset();
  fs.rmSync(process.env.LOCAL_ROUTER_HEALTH_STATE, { force: true });
  assert.equal(healthRegistry.load(), 'missing');
});

test('failure rate is computed over the window and is null without evidence', () => {
  healthRegistry.reset();
  assert.equal(healthRegistry.failureRate('chain-c', 'never-seen'), null,
    'absence of evidence is not a failure rate');

  const now = Date.now();
  for (let i = 0; i < 4; i += 1) {
    healthRegistry.recordOutcome({ chainId: 'chain-c', model: 'mixed', outcome: 'answered', at: now - 1000 * i });
  }
  for (let i = 0; i < 6; i += 1) {
    healthRegistry.recordOutcome({
      chainId: 'chain-c', model: 'mixed', outcome: 'failed',
      errorType: 'upstream_http_unavailable', at: now - 2000 * i
    });
  }
  const rate = healthRegistry.failureRate('chain-c', 'mixed', now);
  assert.ok(rate > 0.5 && rate < 0.7, `expected ~0.6, got ${rate}`);
});

test('auto-disable candidates require the whole span to be failure-free of success', () => {
  healthRegistry.reset();
  const now = Date.now();
  // 25 hours of continuous failure: qualifies.
  healthRegistry.recordOutcome({
    chainId: 'chain-d', model: 'down', outcome: 'failed',
    errorType: 'upstream_http_unavailable', at: now - 25 * HOUR
  });
  healthRegistry.recordOutcome({
    chainId: 'chain-d', model: 'down', outcome: 'failed',
    errorType: 'upstream_http_unavailable', at: now
  });
  // 25 hours of failure but a success 2 hours ago: does NOT qualify.
  healthRegistry.recordOutcome({
    chainId: 'chain-d', model: 'flaky', outcome: 'failed',
    errorType: 'upstream_http_unavailable', at: now - 25 * HOUR
  });
  healthRegistry.recordOutcome({ chainId: 'chain-d', model: 'flaky', outcome: 'answered', at: now - 2 * HOUR });

  const candidates = healthRegistry.autoDisableCandidates(now);
  const models = candidates.map((c) => c.model);
  assert.ok(models.includes('down'), 'a full day of failure must qualify');
  assert.ok(!models.includes('flaky'), 'a recent success must reset the clock');
});

test('empty_completion never quarantines a provider', () => {
  healthRegistry.reset();
  for (let i = 0; i < 6; i += 1) {
    healthRegistry.recordOutcome({
      chainId: 'chain-e', model: 'reasoner', outcome: 'failed', errorType: 'empty_completion'
    });
  }
  assert.equal(healthRegistry.mayAttempt('chain-e', 'reasoner').allowed, true,
    'a model that answers nothing is a config outcome, not a dead provider');
});

test('a permanent 404 quarantines on ONE strike with a long park', () => {
  healthRegistry.reset();
  healthRegistry.recordOutcome({
    chainId: 'chain-f', model: 'bad-route', outcome: 'failed', errorType: 'upstream_route_not_found'
  });
  const verdict = healthRegistry.mayAttempt('chain-f', 'bad-route');
  assert.equal(verdict.allowed, false, 'a permanent misconfiguration must not need three strikes');
  assert.match(verdict.reason, /cooldown:upstream_route_not_found/);
  // It should park like an auth failure (30 min default), not the 5-min retry.
  assert.ok(verdict.until - Date.now() > 20 * 60 * 1000, 'park must be long, not the retry default');
});

test('GLM window exhaustion parks for five hours', () => {
  healthRegistry.reset();
  healthRegistry.recordOutcome({
    chainId: 'chain-g',
    model: 'zai-glm',
    provider: 'zai',
    outcome: 'failed',
    errorType: 'upstream_http_rate_limit',
    bodyText: 'You have reached your usage limit for this plan.'
  });
  // Three strikes are required for a retryable class.
  healthRegistry.recordOutcome({
    chainId: 'chain-g', model: 'zai-glm', provider: 'zai',
    outcome: 'failed', errorType: 'upstream_http_rate_limit',
    bodyText: 'You have reached your usage limit for this plan.'
  });
  healthRegistry.recordOutcome({
    chainId: 'chain-g', model: 'zai-glm', provider: 'zai',
    outcome: 'failed', errorType: 'upstream_http_rate_limit',
    bodyText: 'You have reached your usage limit for this plan.'
  });
  const verdict = healthRegistry.mayAttempt('chain-g', 'zai-glm');
  assert.equal(verdict.allowed, false);
  const hours = (verdict.until - Date.now()) / HOUR;
  assert.ok(hours > 4.5, `expected ~5h park for a window exhaustion, got ${hours.toFixed(2)}h`);
});

test('diagnostics state inference honestly', () => {
  healthRegistry.reset();
  healthRegistry.recordOutcome({
    chainId: 'chain-h', model: 'guessed', outcome: 'failed', errorType: 'upstream_http_auth'
  });
  const diag = healthRegistry.diagnostics('chain-h', 'guessed');
  assert.equal(diag.quarantined, true);
  assert.equal(diag.errorType, 'upstream_http_auth');
  assert.ok(diag.reason, 'a park must explain itself');
  assert.equal(diag.inferred, true, 'no header and no body hint means this was a class default');

  const unknown = healthRegistry.diagnostics('chain-h', 'never-seen');
  assert.equal(unknown.quarantined, false);
  assert.equal(unknown.failureRate, null);
});

test('auto-disable can be cleared for a re-enable', () => {
  healthRegistry.reset();
  healthRegistry.recordOutcome({
    chainId: 'chain-i', model: 'revived', outcome: 'failed', errorType: 'upstream_http_auth'
  });
  healthRegistry.markAutoDisabled('chain-i', 'revived', 'auto:sustained_failure');
  assert.equal(healthRegistry.diagnostics('chain-i', 'revived').autoDisabled, true);
  assert.equal(healthRegistry.clearAutoDisabled('chain-i', 'revived'), true);
  const diag = healthRegistry.diagnostics('chain-i', 'revived');
  assert.equal(diag.autoDisabled, false);
  assert.equal(diag.quarantined, false, 'a re-enable gives the member a clean start');
});

test.after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('the quarantine snapshot never collides with the operator health.json', async () => {
  // health.json is an existing snapshot (curated counts, bridges, chainHealth)
  // written by the router on a probe interval. Sharing that filename would let
  // quarantine state clobber it and let either reader misparse the other.
  const { healthStatePath } = await import('../build/health-registry.js');
  const savedPin = process.env.LOCAL_ROUTER_HEALTH_STATE;
  delete process.env.LOCAL_ROUTER_HEALTH_STATE;
  try {
    const def = healthStatePath();
    assert.notEqual(path.basename(def), 'health.json',
      'quarantine state must not share the filename with the operator health snapshot');
    assert.equal(path.basename(def), 'quarantine-state.json');
  } finally {
    if (savedPin != null) process.env.LOCAL_ROUTER_HEALTH_STATE = savedPin;
  }
});
