import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFallbackModel,
  cloneFallbackModel,
  isFallbackStageEnabled,
  activeFallbackModels
} from '../build/index.js';

test('parseFallbackModel: inline disabled directive on string entry', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    modelsText: 'kilo-stepfun-step-3.7-flash-free\nopenrouter-free disabled\nopencode-go-deepseek-v4-pro'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.model.models, [
    'kilo-stepfun-step-3.7-flash-free',
    'openrouter-free',
    'opencode-go-deepseek-v4-pro'
  ]);
  assert.deepEqual(result.model.disabledModels, ['openrouter-free']);
});

test('parseFallbackModel: object form with enabled=false', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    models: [
      { model: 'kilo-stepfun-step-3.7-flash-free', enabled: true },
      { model: 'openrouter-free', enabled: false },
      'opencode-go-deepseek-v4-pro'
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.model.models, [
    'kilo-stepfun-step-3.7-flash-free',
    'openrouter-free',
    'opencode-go-deepseek-v4-pro'
  ]);
  assert.deepEqual(result.model.disabledModels, ['openrouter-free']);
});

test('parseFallbackModel: top-level disabledModels field (array)', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    models: ['kilo-stepfun-step-3.7-flash-free', 'openrouter-free', 'opencode-go-deepseek-v4-pro'],
    disabledModels: ['opencode-go-deepseek-v4-pro']
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.model.disabledModels, ['opencode-go-deepseek-v4-pro']);
});

test('parseFallbackModel: top-level disabledModels field (string)', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    models: ['kilo-stepfun-step-3.7-flash-free', 'openrouter-free', 'opencode-go-deepseek-v4-pro'],
    disabledModels: 'openrouter-free opencode-go-deepseek-v4-pro'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.model.disabledModels, [
    'openrouter-free',
    'opencode-go-deepseek-v4-pro'
  ]);
});

test('parseFallbackModel: disabledModels restricted to known models only', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    models: ['kilo-stepfun-step-3.7-flash-free', 'openrouter-free'],
    disabledModels: ['unknown-model', 'openrouter-free']
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.model.disabledModels, ['openrouter-free']);
});

test('parseFallbackModel: omits disabledModels when empty', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    models: ['kilo-stepfun-step-3.7-flash-free', 'openrouter-free']
  });
  assert.equal(result.ok, true);
  assert.equal(result.model.disabledModels, undefined);
});

test('parseFallbackModel: dedupes repeated disabled entries', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    models: [
      'kilo-stepfun-step-3.7-flash-free',
      'openrouter-free',
      { model: 'openrouter-free', enabled: false }
    ]
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.model.disabledModels, ['openrouter-free']);
});

test('parseFallbackModel: rejects route with fewer than two unique models', () => {
  const result = parseFallbackModel({
    id: 'fallback-models',
    modelsText: 'kilo-stepfun-step-3.7-flash-free'
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /at least two unique model entries/);
});

test('cloneFallbackModel: preserves disabledModels as a new array', () => {
  const original = {
    id: 'fallback-models',
    models: ['a', 'b', 'c'],
    disabledModels: ['b']
  };
  const cloned = cloneFallbackModel(original);
  assert.deepEqual(cloned.models, ['a', 'b', 'c']);
  assert.deepEqual(cloned.disabledModels, ['b']);
  assert.notEqual(cloned.models, original.models);
  assert.notEqual(cloned.disabledModels, original.disabledModels);
  cloned.disabledModels.push('c');
  assert.deepEqual(original.disabledModels, ['b']);
});

test('cloneFallbackModel: omits disabledModels when source has empty array', () => {
  const cloned = cloneFallbackModel({
    id: 'fallback-models',
    models: ['a', 'b'],
    disabledModels: []
  });
  assert.equal(cloned.disabledModels, undefined);
});

test('isFallbackStageEnabled: true when disabledModels absent', () => {
  assert.equal(
    isFallbackStageEnabled({ id: 'x', models: ['a', 'b'] }, 'a'),
    true
  );
});

test('isFallbackStageEnabled: false for disabled model', () => {
  assert.equal(
    isFallbackStageEnabled(
      { id: 'x', models: ['a', 'b'], disabledModels: ['a'] },
      'a'
    ),
    false
  );
});

test('isFallbackStageEnabled: true for non-disabled model', () => {
  assert.equal(
    isFallbackStageEnabled(
      { id: 'x', models: ['a', 'b'], disabledModels: ['a'] },
      'b'
    ),
    true
  );
});

test('activeFallbackModels: returns full list when no disabledModels', () => {
  assert.deepEqual(
    activeFallbackModels({ id: 'x', models: ['a', 'b', 'c'] }),
    ['a', 'b', 'c']
  );
});

test('activeFallbackModels: filters out disabled models in original order', () => {
  assert.deepEqual(
    activeFallbackModels({
      id: 'x',
      models: ['a', 'b', 'c', 'd'],
      disabledModels: ['b', 'd']
    }),
    ['a', 'c']
  );
});
