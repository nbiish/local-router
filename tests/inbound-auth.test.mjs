import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCESS_KEY_ENV_VAR,
  INFERENCE_PATH_ALLOWLIST,
  classifyRequest,
  effectiveRouterPort,
  evaluateInboundAccess,
  getConfiguredAccessKey,
  inboundUpgradeRejectionResponse,
  isLoopbackAddress,
  isInferenceAllowlistPath,
  isSuspiciousPath,
  loopbackAllowedOrigins,
  noteVaultAccessKey,
  timingSafeKeyMatch
} from '../build/inbound-auth.js';

// Unit suite for the inbound access-control module: classification, the
// public-request path allowlist, the timing-safe key compare, the gate
// verdict table, and the CORS origin allowlist. The full HTTP behavior is
// covered by tests/inbound-auth.integration.test.mjs against a live server.

function reqOf({ cf = null, addr = '127.0.0.1', path = '/', method = 'GET', headers = {} } = {}) {
  const h = { ...headers };
  if (cf) h['cf-connecting-ip'] = cf;
  return { method, headers: h, socket: { remoteAddress: addr }, path };
}

test('loopback address classification', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.9']) {
    assert.equal(isLoopbackAddress(addr), true, addr);
    assert.equal(classifyRequest(reqOf({ addr })), 'loopback', addr);
  }
  for (const addr of ['', null, undefined, '10.0.0.5', '::ffff:10.0.0.5', 'fe80::1', '203.0.113.9']) {
    assert.equal(isLoopbackAddress(addr), false, String(addr));
    // `undefined` must not fall into reqOf's default — hand-build that stub so
    // the module really sees a socket without a remote address.
    const stub = addr === undefined ? { headers: {}, socket: {} } : reqOf({ addr });
    assert.equal(classifyRequest(stub), 'public', String(addr));
  }
});

test('cf-connecting-ip presence forces public classification even on a loopback socket', () => {
  assert.equal(classifyRequest(reqOf({ addr: '127.0.0.1', cf: '203.0.113.9' })), 'public');
  assert.equal(classifyRequest(reqOf({ addr: '::1', cf: '2606:4700::1' })), 'public');
});

test('inference path allowlist accepts exactly the documented client surface', () => {
  const allowed = [
    '/v1',
    '/v1/chat/completions',
    '/v1/completions',
    '/v1/embeddings',
    '/v1/models',
    '/v1/models?provider=zai',
    '/v1/messages',
    '/v1/responses',
    '/v1/decisions',
    '/api/chat',
    '/api/generate',
    '/api/tags',
    '/api/show',
    '/api/show/mistral:7b',
    '/api/ps',
    '/api/embed',
    '/api/embeddings',
    '/api/version'
  ];
  for (const p of allowed) {
    assert.equal(isInferenceAllowlistPath(p), true, p);
  }
});

test('inference path allowlist denies admin/config/unknown and prefix collisions', () => {
  const denied = [
    '',
    '/',
    '/config',
    '/config/providers',
    '/api',
    '/api/router-settings',
    '/api/fallback-models',
    '/api/pqc/resync',
    '/api/keys',
    '/api/health',
    '/decisions',
    '/api/alpha/decisions',
    '/v1x',
    '/v1xx/chat',
    '/api/chatty',
    '/api/tag',
    '/API/tags',
    '/api/generate-download'
  ];
  for (const p of denied) {
    assert.equal(isInferenceAllowlistPath(p), false, p);
  }
});

test('allowlist is a single exported const array with per-entry comments in source', async () => {
  assert.ok(Array.isArray(INFERENCE_PATH_ALLOWLIST));
  assert.ok(INFERENCE_PATH_ALLOWLIST.length >= 9);
  assert.ok(INFERENCE_PATH_ALLOWLIST.includes('/v1'));
  // The deliberate-decision rule: every entry must carry an explanatory
  // comment line directly above it in the source.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/inbound-auth.ts', import.meta.url), 'utf8');
  for (const entry of INFERENCE_PATH_ALLOWLIST) {
    const line = new RegExp(`^\\s+'${entry.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}',?\\s*(\\/\\/.*)?$`, 'm');
    assert.match(source, line, `allowlist entry ${entry} present in source`);
  }
});

test('timing-safe key match accepts equal keys and rejects near-misses', () => {
  assert.equal(timingSafeKeyMatch('correct-key-AAAA', 'correct-key-AAAA'), true);
  // Same length, differs only in the last byte: still rejected.
  assert.equal(timingSafeKeyMatch('correct-key-AAAB', 'correct-key-AAAA'), false);
  assert.equal(timingSafeKeyMatch('correct-key-AAAA ', 'correct-key-AAAA'), true); // trimmed
  assert.equal(timingSafeKeyMatch('correct-key-AAAA', 'correct-key-AAAA-extra'), false);
  assert.equal(timingSafeKeyMatch('', 'correct-key-AAAA'), false);
  assert.equal(timingSafeKeyMatch('correct-key-AAAA', ''), false);
  assert.equal(timingSafeKeyMatch(undefined, 'correct-key-AAAA'), false);
  assert.equal(timingSafeKeyMatch('correct-key-AAAA', null), false);
});

test('vault entry naming: only prefixed ACCESS_KEY names resolve, bare names never do', async () => {
  // The vault on the operator's machine uses the LOCALROUTER_ prefix (e.g.
  // LOCALROUTER_OPENROUTER_API_KEY); the access key entry is
  // LOCALROUTER_ACCESS_KEY. Accept the documented prefix variants and reject
  // generic look-alikes so another tool's secret can never front the router.
  const { isInboundAccessKeyName } = await import('../build/pqc-key-resolver.js');
  for (const accepted of ['LOCALROUTER_ACCESS_KEY', 'LOCAL_ROUTER_ACCESS_KEY', 'LOCAL-ROUTER_ACCESS_KEY']) {
    assert.equal(isInboundAccessKeyName(accepted), true, accepted);
  }
  for (const rejected of ['', 'ACCESS_KEY', 'LOCALROUTER_ACCESS_KEY_OLD', 'LOCALROUTER_OPENROUTER_API_KEY', 'LOCALROUTER_ZAI_API_KEY', 'ROUTER_ACCESS_KEY', 'localrouter_access_key_value']) {
    assert.equal(isInboundAccessKeyName(rejected), false, rejected);
  }
});

test('gate verdict table with a configured env key', () => {
  const KEY = 'unit-test-access-key-0001';
  process.env[ACCESS_KEY_ENV_VAR] = KEY;
  try {
    // Loopback: never gated, key or not.
    assert.deepEqual(evaluateInboundAccess(reqOf({ path: '/api/router-settings' })), { allow: true });
    assert.deepEqual(evaluateInboundAccess(reqOf({ path: '/', headers: {} })), { allow: true });

    // Public + admin/config path: 403 regardless of key validity.
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/api/router-settings', headers: { authorization: `Bearer ${KEY}` } })),
      { allow: false, status: 403, body: 'local access only' }
    );
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/unknown-path', headers: { authorization: `Bearer ${KEY}` } })),
      { allow: false, status: 403, body: 'local access only' }
    );

    // Public + inference path: key required.
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/chat/completions' })),
      { allow: false, status: 401, body: 'invalid or missing access key' }
    );
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: 'Bearer wrong-key-0002' } })),
      { allow: false, status: 401, body: 'invalid or missing access key' }
    );
    // Same length, last byte differs — timing-safe compare still rejects.
    const lastByteWrong = KEY.slice(0, -1) + (KEY.endsWith('1') ? '2' : '1');
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: `Bearer ${lastByteWrong}` } })),
      { allow: false, status: 401, body: 'invalid or missing access key' }
    );

    // Both credential header styles authorize.
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: `Bearer ${KEY}` } })),
      { allow: true }
    );
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { 'x-api-key': KEY } })),
      { allow: true }
    );
    // Non-Bearer Authorization yields no candidate and no fallback confusion.
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: `Basic ${KEY}` } })),
      { allow: false, status: 401, body: 'invalid or missing access key' }
    );
  } finally {
    delete process.env[ACCESS_KEY_ENV_VAR];
  }
});

test('key resolution precedence: env wins over vault, vault alone suffices, none fails closed', () => {
  const ENV_KEY = 'env-key-aaaa';
  const VAULT_KEY = 'vault-key-bbbb';
  const probe = () => evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: `Bearer ${ENV_KEY}` } }));

  process.env[ACCESS_KEY_ENV_VAR] = ENV_KEY;
  try {
    assert.equal(probe().allow, true, 'env key authorizes');
    // Env wins even when a vault key is also present.
    noteVaultAccessKey(VAULT_KEY);
    assert.equal(probe().allow, true, 'env key still authorizes with vault key present');
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: `Bearer ${VAULT_KEY}` } })),
      { allow: false, status: 401, body: 'invalid or missing access key' },
      'vault key must NOT authorize while env key takes precedence'
    );

    // Env removed: the vault-noted key takes over.
    delete process.env[ACCESS_KEY_ENV_VAR];
    assert.equal(getConfiguredAccessKey(), VAULT_KEY);
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: `Bearer ${VAULT_KEY}` } })),
      { allow: true }
    );

    // Vault entry cleared: fail closed with 503.
    noteVaultAccessKey('');
    assert.deepEqual(
      evaluateInboundAccess(reqOf({ cf: '1', path: '/v1/models', headers: { authorization: `Bearer ${VAULT_KEY}` } })),
      { allow: false, status: 503, body: 'access key not configured' }
    );
    // Loopback remains open even with no key configured at all.
    assert.deepEqual(evaluateInboundAccess(reqOf({ path: '/v1/models' })), { allow: true });
  } finally {
    noteVaultAccessKey('');
    delete process.env[ACCESS_KEY_ENV_VAR];
  }
});

test('loopback origin allowlist follows the effective port', () => {
  assert.deepEqual(loopbackAllowedOrigins(11434), [
    'http://127.0.0.1:11434',
    'http://localhost:11434',
    'http://[::1]:11434'
  ]);
  assert.deepEqual(loopbackAllowedOrigins(5173), [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://[::1]:5173'
  ]);
  assert.ok(!loopbackAllowedOrigins(11434).includes('http://evil.example'));
  const previousPort = process.env.PORT;
  try {
    delete process.env.PORT;
    assert.equal(effectiveRouterPort(), 11434);
    process.env.PORT = 'not-a-port';
    assert.equal(effectiveRouterPort(), 11434);
    process.env.PORT = '5173';
    assert.equal(effectiveRouterPort(), 5173);
    process.env.PORT = '99999';
    assert.equal(effectiveRouterPort(), 11434);
  } finally {
    if (previousPort === undefined) delete process.env.PORT; else process.env.PORT = previousPort;
  }
});

test('upgrade rejection response is a fixed, non-reflective HTTP/1.1 document', () => {
  const raw = inboundUpgradeRejectionResponse(401, 'invalid or missing access key');
  assert.ok(raw.startsWith('HTTP/1.1 401 Unauthorized\r\n'));
  assert.ok(raw.includes('Cache-Control: no-store'));
  assert.ok(raw.includes('Connection: close'));
  assert.ok(raw.endsWith('{"error":"invalid or missing access key"}'));
  const raw403 = inboundUpgradeRejectionResponse(403, 'local access only');
  assert.ok(raw403.startsWith('HTTP/1.1 403 Forbidden\r\n'));
  const raw503 = inboundUpgradeRejectionResponse(503, 'access key not configured');
  assert.ok(raw503.startsWith('HTTP/1.1 503 Service Unavailable\r\n'));
});

// Defense in depth (reviewer hardening, 2026-11-25): the allowlist matches the
// raw path, so traversal-shaped and encoded-separator paths must be refused
// outright for public requests instead of relying on Express routing and
// Cloudflare normalization to make them harmless.
test('dot-segment, encoded-separator, and malformed paths are refused for public requests', () => {
  const key = 'correct horse battery staple';
  process.env[ACCESS_KEY_ENV_VAR] = key;
  try {
    const refused = [
      '/v1/../api/router-settings',
      '/v1/./models',
      '/api/show/../../router-settings',
      '/v1//models',
      '//v1/models',
      '/v1/%2e%2e/api/router-settings',
      '/v1/%2E%2E/api/router-settings',
      '/v1%2f..%2fapi%2frouter-settings',
      '/v1/models%00',
      '/v1\\..\\api\\router-settings',
      '/v1/%5c..%5capi%5crouter-settings'
    ];
    for (const p of refused) {
      assert.equal(isSuspiciousPath(p), true, `suspicious: ${p}`);
      assert.equal(isInferenceAllowlistPath(p), false, `allowlist: ${p}`);
      const verdict = evaluateInboundAccess(
        reqOf({ cf: '203.0.113.9', path: p, headers: { authorization: `Bearer ${key}` } })
      );
      assert.deepEqual(verdict, { allow: false, status: 403, body: 'local access only' }, `verdict: ${p}`);
    }
    // A traversal-shaped path is still fine from loopback: loopback is never gated.
    assert.equal(evaluateInboundAccess(reqOf({ path: '/v1/../api/router-settings' })).allow, true);
    // Ordinary inference paths are untouched by the hardening.
    for (const p of ['/v1/chat/completions', '/v1/models?provider=zai', '/api/show/mistral:7b', '/v1/messages']) {
      assert.equal(isSuspiciousPath(p), false, `clean: ${p}`);
      assert.equal(isInferenceAllowlistPath(p), true, `clean allowlist: ${p}`);
    }
  } finally {
    delete process.env[ACCESS_KEY_ENV_VAR];
  }
});
