import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTING_EXHAUSTION_BAND,
  routingExhaustionBandForModel,
  stableSortModelIdsByRoutingExhaustion
} from '../build/routing-exhaustion-order.js';

test('free → subscription → paid ordering', () => {
  const ids = [
    'openrouter-minimax-m3',
    'opencode-minimax-m3',
    'nvidia-nim-step-3.7-flash',
    'opencode-minimax-m3-free',
    'cline-minimax-minimax-m3',
    'kilo-stepfun-step-3.7-flash-free',
    'ollama-nemotron-3-ultra-cloud',
    'zai-code-pass-glm-5.1',
    'xiaomi-mimo-mimo-v2.5'
  ];
  const sorted = stableSortModelIdsByRoutingExhaustion(ids, () => undefined);
  assert.deepEqual(sorted, [
    'ollama-nemotron-3-ultra-cloud',
    'kilo-stepfun-step-3.7-flash-free',
    'cline-minimax-minimax-m3',
    'opencode-minimax-m3-free',
    'opencode-minimax-m3',
    'zai-code-pass-glm-5.1',
    'xiaomi-mimo-mimo-v2.5',
    'nvidia-nim-step-3.7-flash',
    'openrouter-minimax-m3'
  ]);
});

test('subscription band for OpenCode paid and Z.ai', () => {
  assert.equal(
    routingExhaustionBandForModel('opencode-minimax-m3'),
    ROUTING_EXHAUSTION_BAND.SUBSCRIPTION
  );
  assert.equal(
    routingExhaustionBandForModel('zai-code-pass-glm-5.1'),
    ROUTING_EXHAUSTION_BAND.SUBSCRIPTION
  );
  assert.equal(
    routingExhaustionBandForModel('xiaomi-mimo-mimo-v2.5-pro'),
    ROUTING_EXHAUSTION_BAND.SUBSCRIPTION
  );
});

test('subscription OpenCode before Kilo paid, after OpenCode free', () => {
  const catalog = new Map([
    ['kilo-paid-model', { provider: 'kilo', model: 'anthropic/claude-sonnet-4' }],
    ['opencode-minimax-m3-free', { provider: 'opencode', model: 'minimax-m3-free' }],
    ['opencode-minimax-m3', { provider: 'opencode', model: 'minimax-m3' }]
  ]);
  const sorted = stableSortModelIdsByRoutingExhaustion(
    ['opencode-minimax-m3', 'kilo-paid-model', 'opencode-minimax-m3-free'],
    (id) => catalog.get(id)
  );
  assert.deepEqual(sorted, [
    'opencode-minimax-m3-free',
    'opencode-minimax-m3',
    'kilo-paid-model'
  ]);
  assert.equal(
    routingExhaustionBandForModel('opencode-minimax-m3', catalog.get('opencode-minimax-m3')),
    ROUTING_EXHAUSTION_BAND.SUBSCRIPTION
  );
});
