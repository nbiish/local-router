import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeModelAlias,
  pickBaselineModel,
  readContextHint,
  readOutputHint,
  reconcileModelMetadata
} from '../build/model-metadata.js';
import { PROVIDER_MODEL_REGISTRY } from '../build/provider-model-registries.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('readContextHint covers every provider shape the router proxies', () => {
  // OpenAI / OpenRouter
  assert.equal(readContextHint({ context_length: 1048576 }), 1048576);
  // Gemini (Antigravity surface)
  assert.equal(readContextHint({ inputTokenLimit: 1048576, outputTokenLimit: 65536 }), 1048576);
  // GitHub Copilot model metadata
  assert.equal(readContextHint({ capabilities: { limits: { max_context_window_tokens: 128000 } } }), 128000);
  assert.equal(readContextHint({ capabilities: { limits: { max_prompt_tokens: 64000 } } }), 64000);
  // Ollama /api/show per-architecture keys
  assert.equal(readContextHint({ model_info: { 'llama.context_length': 131072 } }), 131072);
  // vLLM / llama.cpp
  assert.equal(readContextHint({ max_model_len: 32768 }), 32768);
  // Nested OpenAI-compatible limit blocks
  assert.equal(readContextHint({ limits: { context_window: 200000 } }), 200000);
  // Missing or invalid metadata is not guessed
  assert.equal(readContextHint({}), undefined);
  assert.equal(readContextHint({ context_length: 0 }), undefined);
  assert.equal(readContextHint({ context_length: -5 }), undefined);
});

test('readOutputHint covers Gemini, Copilot, OpenRouter and Ollama shapes', () => {
  assert.equal(readOutputHint({ outputTokenLimit: 65536 }), 65536);
  assert.equal(readOutputHint({ top_provider: { max_completion_tokens: 131072 } }), 131072);
  assert.equal(readOutputHint({ capabilities: { limits: { max_output_tokens: 8192 } } }), 8192);
  assert.equal(readOutputHint({ model_info: { 'llama.max_output_tokens': 4096 } }), 4096);
  assert.equal(readOutputHint({ max_completion_tokens: 128000 }), 128000);
  assert.equal(readOutputHint({}), undefined);
});

test('normalizeModelAlias reconciles plan, display and snapshot suffixes', () => {
  assert.equal(normalizeModelAlias('z-ai/GLM-5.3-Flash:batch'), 'z-ai/glm-5.3-flash');
  assert.equal(normalizeModelAlias('~anthropic/claude-opus-latest'), 'anthropic/claude-opus');
  assert.equal(normalizeModelAlias('deepseek-ai/DeepSeek-V4.1-Flash-1017'), 'deepseek-ai/deepseek-v4.1-flash');
  assert.equal(normalizeModelAlias('glm-5.3[1m]'), 'glm-5.3');
});

test('pickBaselineModel matches a dated live id to its curated family row', () => {
  const rows = [
    { model: 'deepseek-ai/DeepSeek-V4.1-Flash', contextLength: 1048576 },
    { model: 'zai-org/GLM-5.3-Flash', contextLength: 1048576 }
  ];

  assert.equal(pickBaselineModel(rows, 'deepseek-ai/DeepSeek-V4.1-Flash')?.contextLength, 1048576);
  assert.equal(pickBaselineModel(rows, 'deepseek-v4.1-flash-1017')?.contextLength, 1048576);
  assert.equal(pickBaselineModel(rows, 'glm-5.3-flash')?.contextLength, 1048576);
  assert.equal(pickBaselineModel(rows, 'unrelated-model'), undefined);
});

test('reconcileModelMetadata fills defaults from the registry and keeps live limits', () => {
  const result = reconcileModelMetadata({
    models: [
      { model: 'glm-5.3-flash', contextLength: 64000, outputTokens: 4096 },
      { model: 'glm-5.3', contextLength: 1000000, outputTokens: 131072 },
      { model: 'deepseek-ai/DeepSeek-V4.1-Flash', contextLength: 64000, outputTokens: 384000 }
    ],
    registryRows: [
      { model: 'glm-5.3-flash', contextLength: 1048576, outputTokens: 131072 },
      { model: 'glm-5.3', contextLength: 1000000, outputTokens: 131072 },
      { model: 'deepseek-ai/DeepSeek-V4.1-Flash', contextLength: 1048576, outputTokens: 384000 }
    ],
    defaultContextLength: 64000,
    defaultOutputTokens: 4096
  });

  assert.equal(result.changed, 2);
  assert.equal(result.models[0].contextLength, 1048576);
  assert.equal(result.models[0].outputTokens, 131072);
  assert.equal(result.models[1].contextLength, 1000000, 'real provider limit must not be overwritten');
  assert.equal(result.models[1].outputTokens, 131072);
  assert.equal(result.models[2].contextLength, 1048576);
});

test('registry carries correct context windows for the reported models', () => {
  const zai = PROVIDER_MODEL_REGISTRY.zai;
  for (const id of ['glm-5.3-flash', 'glm-5.3-flashx']) {
    const row = zai.find((entry) => entry.id === id);
    assert.ok(row, `zai/${id} must be registered`);
    assert.equal(row.contextLength, 1048576, `${id} context`);
    assert.equal(row.outputTokens, 131072, `${id} output`);
  }

  const xiaomi = PROVIDER_MODEL_REGISTRY['xiaomi-mimo'];
  for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash']) {
    const row = xiaomi.find((entry) => entry.id === id);
    assert.ok(row, `xiaomi-mimo/${id} must be registered`);
    assert.equal(row.contextLength, 1050000, `${id} context`);
    assert.equal(row.outputTokens, 131072, `${id} output`);
    assert.equal(row.supportsImages, true, `${id} is multimodal`);
  }
});

test('model-specs.json documents the corrected context windows', () => {
  const specs = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'model-specs.json'), 'utf8'));
  for (const [id, context] of [
    ['glm-5.3-flash', 1048576],
    ['glm-5.3-flashx', 1048576],
    ['mimo-v2.6-pro', 1050000],
    ['mimo-v2.6-flash', 1050000]
  ]) {
    assert.ok(specs.models[id], `model-specs.json must contain ${id}`);
    assert.equal(specs.models[id].context, context, `${id} spec context`);
  }
});
