import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseResetHeaders,
  parseResetHint,
  looksLikeWindowExhaustion,
  decideCooldown
} = await import('../build/usage-policy.js');

const { usagePolicyFor, PROVIDER_USAGE_POLICIES } = await import('../build/usage-policy-table.js');

// ---------------------------------------------------------------------------
// Reset evidence: three tiers, strongest first
// ---------------------------------------------------------------------------

test('Retry-After in seconds is a published reset', () => {
  const evidence = parseResetHeaders({ 'Retry-After': '120' });
  assert.equal(evidence.seconds, 120);
  assert.equal(evidence.source, 'header');
  assert.equal(evidence.inferred, false);
});

test('Retry-After as an HTTP-date becomes a positive delta', () => {
  const when = new Date(Date.now() + 90_000).toUTCString();
  const evidence = parseResetHeaders({ 'retry-after': when });
  assert.ok(evidence.seconds >= 85 && evidence.seconds <= 95, `expected ~90s, got ${evidence.seconds}`);
  assert.equal(evidence.source, 'header');
});

test('x-ratelimit-reset accepts compact units, epochs, and bare seconds', () => {
  assert.equal(parseResetHeaders({ 'x-ratelimit-reset-requests': '1m30s' }), null,
    'compound forms are not guessed at — falls through rather than inventing a value');
  assert.equal(parseResetHeaders({ 'x-ratelimit-reset-requests': '30s' }).seconds, 30);
  assert.equal(parseResetHeaders({ 'x-ratelimit-reset-requests': '6h' }).seconds, 21600);
  assert.equal(parseResetHeaders({ 'x-ratelimit-reset': '45' }).seconds, 45);
  const epoch = Math.floor(Date.now() / 1000) + 60;
  const fromEpoch = parseResetHeaders({ 'x-ratelimit-reset': String(epoch) });
  assert.ok(fromEpoch.seconds >= 55 && fromEpoch.seconds <= 65, `epoch should become ~60s, got ${fromEpoch.seconds}`);
});

test('no rate-limit header means no header evidence', () => {
  assert.equal(parseResetHeaders({ 'content-type': 'application/json' }), null);
  assert.equal(parseResetHeaders({}), null);
});

test('a body hint is recognised and marked weaker than a header', () => {
  // The exact shape measured live on OpenRouter's free tier, 2026-11-18.
  const hint = parseResetHint('baidu/ernie-5.5-flash-preview:free is temporarily rate-limited upstream. Please retry shortly');
  assert.ok(hint, 'the real body must be recognised');
  assert.equal(hint.source, 'body-hint');
  assert.equal(hint.inferred, true, 'a vague hint is a guess and must say so');
});

test('an explicit body duration is not a guess', () => {
  const hint = parseResetHint('Rate limit exceeded. Please retry in 45 seconds.');
  assert.equal(hint.seconds, 45);
  assert.equal(hint.inferred, false, 'a stated number is evidence, not inference');
});

test('window-exhaustion wording is distinguishable from a burst limit', () => {
  assert.equal(looksLikeWindowExhaustion('You have hit your usage limit for this plan'), true);
  assert.equal(looksLikeWindowExhaustion('limit resets at 14:00'), true);
  assert.equal(looksLikeWindowExhaustion('temporarily rate-limited upstream. Please retry shortly'), false);
});

// ---------------------------------------------------------------------------
// Cooldown decisions
// ---------------------------------------------------------------------------

test('a published header always beats a plan window', () => {
  const decision = decideCooldown({
    policy: { class: 'subscription', windowMinutes: 300, note: 'glm' },
    errorType: 'upstream_http_rate_limit',
    headers: { 'Retry-After': '30' },
    bodyText: 'usage limit reached',
    defaultRetrySeconds: 300,
    defaultAuthSeconds: 1800
  });
  assert.equal(decision.seconds, 30, 'the provider told us 30s; do not park for 5 hours');
  assert.equal(decision.evidence.source, 'header');
});

test('a subscription window exhaustion parks for the window, not five minutes', () => {
  const decision = decideCooldown({
    policy: { class: 'subscription', windowMinutes: 300, note: 'glm coding plan' },
    errorType: 'upstream_http_rate_limit',
    bodyText: 'You have reached your usage limit. It resets later.',
    defaultRetrySeconds: 300,
    defaultAuthSeconds: 1800
  });
  assert.equal(decision.seconds, 18_000, '5-hour window = 18000s');
  assert.equal(decision.evidence.source, 'window');
  assert.match(decision.reason, /subscription window/i);
});

test('a burst hint on a subscription is capped at the window but stays short', () => {
  const decision = decideCooldown({
    policy: { class: 'subscription', windowMinutes: 300, note: 'glm' },
    errorType: 'upstream_http_rate_limit',
    bodyText: 'temporarily rate-limited upstream. please retry shortly',
    defaultRetrySeconds: 300,
    defaultAuthSeconds: 1800
  });
  assert.equal(decision.seconds, 60, 'a burst hint is minutes, not the whole window');
});

test('nothing known falls back to the class default and admits it was a guess', () => {
  const decision = decideCooldown({
    policy: { class: 'free', note: 'unknown allowance' },
    errorType: 'upstream_http_unavailable',
    bodyText: 'bad gateway',
    defaultRetrySeconds: 300,
    defaultAuthSeconds: 1800
  });
  assert.equal(decision.seconds, 300);
  assert.equal(decision.evidence.source, 'default');
  assert.equal(decision.evidence.inferred, true);
});

test('auth failures get the auth default, never the retry default', () => {
  const decision = decideCooldown({
    policy: { class: 'paid', note: 'metered' },
    errorType: 'upstream_http_auth',
    bodyText: 'invalid api key',
    defaultRetrySeconds: 300,
    defaultAuthSeconds: 1800
  });
  assert.equal(decision.seconds, 1800);
});

test('the same inputs always produce the same cooldown (determinism)', () => {
  const input = {
    policy: { class: 'paid', note: 'x' },
    errorType: 'upstream_http_rate_limit',
    headers: { 'Retry-After': '17' },
    defaultRetrySeconds: 300,
    defaultAuthSeconds: 1800
  };
  assert.deepEqual(decideCooldown(input), decideCooldown(input));
});

// ---------------------------------------------------------------------------
// The provider table reflects what the operator stated
// ---------------------------------------------------------------------------

test('GLM (z.ai) is the only subscription, per the operator', () => {
  const subscriptions = Object.entries(PROVIDER_USAGE_POLICIES)
    .filter(([, policy]) => policy.class === 'subscription')
    .map(([name]) => name);
  assert.deepEqual(subscriptions, ['zai'], 'the operator holds exactly one subscription');
  assert.equal(usagePolicyFor('zai').windowMinutes, 300, 'five-hour cool time');
});

test('Xiaomi is a token allowance, not a rolling window', () => {
  const policy = usagePolicyFor('xiaomi-mimo');
  assert.equal(policy.class, 'paid');
  assert.equal(policy.windowMinutes, undefined,
    'a designated token limit is a spend problem, not a window to wait out');
});

test('free tiers are recorded as unknown allowance rather than guessed', () => {
  for (const name of ['kilo', 'cline', 'opencode-zen']) {
    const policy = usagePolicyFor(name);
    assert.equal(policy.class, 'free');
    assert.equal(policy.windowMinutes, undefined);
    assert.match(policy.note, /undocumented|unknown/i, `${name} must admit the allowance is unknown`);
  }
});

test('local backends stay available so online and local usage can combine', () => {
  for (const name of ['ollama', 'unsloth', 'llama-cpp', 'llamacpp']) {
    assert.equal(usagePolicyFor(name).class, 'local', `${name} must remain a usable provider`);
  }
});

test('an unknown provider is unknown, not a silent subscription', () => {
  const policy = usagePolicyFor('brand-new-provider');
  assert.equal(policy.class, 'unknown');
  assert.match(policy.note, /no usage row/i);
});

test('provider aliases resolve to their canonical row', () => {
  assert.equal(usagePolicyFor('wafer').class, 'paid');
  assert.equal(usagePolicyFor('WAFER-SERVERLESS').class, 'paid');
  assert.equal(usagePolicyFor('xiaomi').class, 'paid');
  assert.equal(usagePolicyFor('llama_cpp').class, 'local');
});
