import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FALLBACK_BUNDLE_SCHEMA,
  buildFallbackBundle,
  bundleToRouterSettings,
  describeChainChange,
  isValidModelId,
  parseFallbackBundle,
  parseChainText,
  serializeFallbackBundle
} from '../build/fallback-config-bundle.js';

const CHAIN = [
  'openrouter-ling-3.2-flash-free',
  'kilo-baidu-ernie-5.5-flash-preview-free-paid',
  'opencode-zen-hy4-flash-free',
  'xiaomi-mimo-mimo-v2.6-pro',
  'antigravity-gemini-3.7-flash',
  'zai-glm-5.3',
  'cursor-deepseek-v41-flash-1017',
  'cursor-grok-4.7',
  'github-copilot-auto',
  'cursor-auto',
  'nebius-deepseek-v4.1-flash-1017',
  'cline-moonshotai-kimi-k3',
  'commandcode-glm-5.3-flash',
  'opencode-zen-glm-5.3-flash',
  'kilo-deepseek-deepseek-v4.1-flash-1017-paid',
  'modal-nbiish-ep-deepseek-v4-1-flash-1017-server.us-west.modal.direct',
  'fastino-nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4',
  'wafer-ai-deepseek-v4.1-flash-1017',
  'openrouter-deepseek-v4.1-flash-1017-batch',
  'zenmux-deepseek-v4.1-flash'
];

const settings = () => ({
  fallbackModelsText: CHAIN.join('\n'),
  routes: [
    { id: 'fallback-models', models: [...CHAIN] },
    {
      id: 'fallback-embedding',
      models: ['openrouter-ling-3.2-flash-free', 'zai-glm-5.3'],
      disabledModels: ['zai-glm-5.3']
    }
  ],
  catalogSelection: { curatedKeys: ['should-not-travel'] }
});

test('round-trip preserves the 20-model chain and routes exactly', () => {
  const original = settings();
  const bundle = buildFallbackBundle(original);
  const parsed = parseFallbackBundle(serializeFallbackBundle(bundle));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  const restored = bundleToRouterSettings(parsed.bundle);
  assert.equal(restored.fallbackModelsText, original.fallbackModelsText);
  const byId = (a, b) => a.id.localeCompare(b.id);
  assert.deepEqual([...restored.routes].sort(byId), [...original.routes].sort(byId));
});

test('export contains only the versioned chain fields - no secrets or curation', () => {
  const bundle = buildFallbackBundle(settings());
  assert.deepEqual(Object.keys(bundle).sort(), [
    'exportedAt', 'fallbackModelsText', 'routes', 'schema'
  ]);
  assert.equal(bundle.schema, FALLBACK_BUNDLE_SCHEMA);
  const raw = serializeFallbackBundle(bundle);
  for (const needle of ['should-not-travel', 'apiKey', 'token', 'password', 'secret']) {
    assert.equal(raw.toLowerCase().includes(needle), false, `export leaked ${needle}`);
  }
});

test('disabled steps and CRLF line endings are normalised, not lost', () => {
  const parsed = parseFallbackBundle(JSON.stringify({
    schema: FALLBACK_BUNDLE_SCHEMA,
    exportedAt: '2026-11-23T01:00:00.000Z',
    fallbackModelsText: 'model-a\r\nmodel-b disabled\r\n',
    routes: []
  }));
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error);
  assert.equal(parsed.bundle.fallbackModelsText, 'model-a\nmodel-b disabled');
  assert.deepEqual(parseChainText(parsed.bundle.fallbackModelsText), [
    { model: 'model-a', enabled: true },
    { model: 'model-b', enabled: false }
  ]);
});

test('model id validation rejects whitespace, control characters and markup', () => {
  assert.equal(isValidModelId('wafer-ai-deepseek-v4.1-flash'), true);
  for (const bad of ['', 'a b', 'a\nb', 'a<script>', 'a\u0000b', 'a"b', 'x'.repeat(257)]) {
    assert.equal(isValidModelId(bad), false, `accepted ${JSON.stringify(bad)}`);
  }
});

const baseBundle = () => ({
  schema: FALLBACK_BUNDLE_SCHEMA,
  exportedAt: '2026-11-23T01:00:00.000Z',
  fallbackModelsText: 'model-a\nmodel-b',
  routes: []
});

function rejected(mutate) {
  const value = baseBundle();
  mutate(value);
  const result = parseFallbackBundle(JSON.stringify(value));
  assert.equal(result.ok, false, 'malformed bundle was accepted');
  assert.equal(typeof result.error, 'string');
  assert.equal(result.error.includes('model-a'), false, 'error echoed untrusted input');
  return result;
}

test('rejects wrong schema, unknown fields and secret smuggling', () => {
  rejected((v) => { v.schema = 'other/v9'; });
  rejected((v) => { v.apiKey = 'leak'; });
  rejected((v) => { v.LOCALROUTER_OPENROUTER_API_KEY = 'leak'; });
  rejected((v) => { delete v.routes; });
});

test('rejects malformed chain and route shapes without throwing', () => {
  rejected((v) => { v.fallbackModelsText = 'model-a\n<a onclick=1>'; });
  rejected((v) => { v.fallbackModelsText = Array(201).fill('model-a').join('\n'); });
  rejected((v) => { v.routes = [{ id: 'a', models: ['ok'], extra: 1 }]; });
  rejected((v) => { v.routes = [{ id: 'a', models: ['ok'] }, { id: 'a', models: ['ok'] }]; });
  rejected((v) => { v.routes = [{ id: 'a', models: Array(101).fill('model-a') }]; });
});

test('rejects non-JSON, non-object and oversized input', () => {
  assert.equal(parseFallbackBundle('{nope').ok, false);
  assert.equal(parseFallbackBundle('[]').ok, false);
  assert.equal(parseFallbackBundle('x'.repeat(1024 * 1024 + 1)).ok, false);
});

test('preview reports added, removed and reordered steps', () => {
  const current = { fallbackModelsText: 'a\nb\nc', routes: [{ id: 'old', models: [] }] };
  const next = bundleToRouterSettings(parseFallbackBundle(serializeFallbackBundle(
    buildFallbackBundle({ fallbackModelsText: 'a\nc\nb\nd', routes: [{ id: 'new', models: [] }] })
  )).bundle);
  const diff = describeChainChange(current, next);
  assert.deepEqual(diff.chainAdded, ['d']);
  assert.deepEqual(diff.chainRemoved, []);
  assert.equal(diff.orderChanged, false); // set differs, so order check is not asserted
  assert.deepEqual(diff.routesAdded, ['new']);
  assert.deepEqual(diff.routesRemoved, ['old']);

  const reorder = describeChainChange(current, { fallbackModelsText: 'b\na\nc', routes: [] });
  assert.equal(reorder.orderChanged, true);
});
