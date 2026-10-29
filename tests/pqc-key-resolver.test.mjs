import test from 'node:test';
import assert from 'node:assert/strict';

import {
  providerKeyAliases,
  resolveProvidersForKey,
  stripToolPrefix,
  suggestKeyName,
  unquoteSecretValue
} from '../build/pqc-key-resolver.js';

const providers = [
  { name: 'zai', keyEnvVar: 'ZAI_API_KEY' },
  { name: 'xiaomi-mimo', keyEnvVar: 'XIAOMI_MIMO_API_KEY' },
  { name: 'wafer-serverless', keyEnvVar: 'WAFER_API_KEY' },
  { name: 'openrouter', keyEnvVar: 'OPENROUTER_API_KEY' },
  { name: 'opencode-go', keyEnvVar: 'OPENCODE_API_KEY' },
  { name: 'opencode-zen', keyEnvVar: 'OPENCODE_ZEN_API_KEY' },
  { name: 'modal-proxy', keyEnvVar: 'MODAL_PROXY_API_KEY' }
];

test('stripToolPrefix accepts both documented tool prefixes and bare names', () => {
  assert.equal(stripToolPrefix('LOCALROUTER_ZAI_API_KEY'), 'ZAI_API_KEY');
  assert.equal(stripToolPrefix('LOCAL_ROUTER_ZAI_API_KEY'), 'ZAI_API_KEY');
  assert.equal(stripToolPrefix('LOCAL-ROUTER_ZAI_API_KEY'), 'ZAI_API_KEY');
  assert.equal(stripToolPrefix('ZAI_API_KEY'), 'ZAI_API_KEY');
});

test('canonical and slug key names both resolve to their provider', () => {
  for (const name of [
    'LOCALROUTER_ZAI_API_KEY',
    'LOCAL_ROUTER_ZAI_API_KEY',
    'LOCALROUTER_ZAI',
    'ZAI_API_KEY',
    'LOCALROUTER_Z_AI_API_KEY'
  ]) {
    assert.deepEqual(resolveProvidersForKey(name, providers).map((p) => p.name), ['zai'], name);
  }

  for (const name of ['LOCALROUTER_XIAOMI_MIMO_API_KEY', 'LOCALROUTER_XIAOMI_MIMO', 'XIAOMI_MIMO_KEY']) {
    assert.deepEqual(resolveProvidersForKey(name, providers).map((p) => p.name), ['xiaomi-mimo'], name);
  }

  assert.deepEqual(
    resolveProvidersForKey('LOCALROUTER_WAFER_API_KEY', providers).map((p) => p.name),
    ['wafer-serverless']
  );
});

test('a shared env var intentionally maps to every sibling provider', () => {
  assert.deepEqual(
    resolveProvidersForKey('LOCALROUTER_OPENCODE_API_KEY', providers).map((p) => p.name).sort(),
    ['opencode-go']
  );
  assert.deepEqual(
    resolveProvidersForKey('LOCALROUTER_OPENCODE_ZEN_API_KEY', providers).map((p) => p.name),
    ['opencode-zen']
  );
});

test('unrelated secret names never resolve', () => {
  assert.deepEqual(resolveProvidersForKey('LOCAL_ROUTER_DOT_COM_ADMIN_TOKEN', providers), []);
  assert.deepEqual(resolveProvidersForKey('LOCALROUTER_TEST_VENDOR_API_KEY', providers), []);
  assert.deepEqual(resolveProvidersForKey('GITHUB_TOKEN', providers), []);
});

test('a registered custom provider resolves by slug', () => {
  const withCustom = [...providers, { name: 'test-vendor', keyEnvVar: 'TEST_VENDOR_API_KEY' }];
  assert.deepEqual(
    resolveProvidersForKey('LOCALROUTER_TEST_VENDOR_API_KEY', withCustom).map((p) => p.name),
    ['test-vendor']
  );
});

test('providerKeyAliases includes canonical and slug forms', () => {
  const aliases = providerKeyAliases({ name: 'xiaomi-mimo', keyEnvVar: 'XIAOMI_MIMO_API_KEY' });
  assert.ok(aliases.includes('XIAOMI_MIMO_API_KEY'));
  assert.ok(aliases.includes('XIAOMI_MIMO'));
  assert.ok(aliases.includes('XIAOMI_MIMO'));
  assert.ok(aliases.includes('XIAOMI_MIMO_API_KEY'));
});

test('suggestKeyName points an unmapped name at the right canonical key', () => {
  assert.equal(suggestKeyName('ZAI_KEY', providers), 'LOCALROUTER_ZAI_API_KEY');
  assert.equal(suggestKeyName('XIAOMI_MIMO_TOKEN', providers), 'LOCALROUTER_XIAOMI_MIMO_API_KEY');
  assert.equal(suggestKeyName('LOCAL_ROUTER_DOT_COM_ADMIN_TOKEN', providers), null);
});


test('unquoteSecretValue strips export quoting so pack never stores quote characters', () => {
  assert.equal(unquoteSecretValue("'sk-abc'"), 'sk-abc');
  assert.equal(unquoteSecretValue('"sk-abc"'), 'sk-abc');
  assert.equal(unquoteSecretValue('  sk-abc  '), 'sk-abc');
  assert.equal(unquoteSecretValue(''), '');
});
