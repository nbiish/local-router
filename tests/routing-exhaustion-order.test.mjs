import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTING_EXHAUSTION_BAND,
  ROUTING_PAID_PROVIDER_SUB_ORDER,
  routingExhaustionBandForModel,
  stableSortModelIdsByRoutingExhaustion
} from '../build/routing-exhaustion-order.js';

test('free → subscription → paid ordering', () => {
  const catalog = new Map([
    ['cline-minimax-minimax-m3', { provider: 'cline', model: 'minimax/minimax-m3' }],
    ['kilo-stepfun-step-3.7-flash-free', { provider: 'kilo', model: 'stepfun/step-3.7-flash:free' }],
    ['opencode-code-minimax-m3-free', { provider: 'opencode-code', model: 'minimax-m3-free' }],
    ['opencode-code-minimax-m3', { provider: 'opencode-code', model: 'minimax-m3' }]
  ]);
  const ids = [
    'openrouter-minimax-m3',
    'opencode-code-minimax-m3',
    'nvidia-nim-step-3.7-flash',
    'opencode-code-minimax-m3-free',
    'cline-minimax-minimax-m3',
    'kilo-stepfun-step-3.7-flash-free',
    'ollama-nemotron-3-ultra-cloud',
    'zai-code-pass-glm-5.1',
    'xiaomi-mimo-mimo-v2.5'
  ];
  const sorted = stableSortModelIdsByRoutingExhaustion(ids, (id) => catalog.get(id));
  assert.deepEqual(sorted, [
    'ollama-nemotron-3-ultra-cloud',
    'kilo-stepfun-step-3.7-flash-free',
    'cline-minimax-minimax-m3',
    'opencode-code-minimax-m3-free',
    'opencode-code-minimax-m3',
    'zai-code-pass-glm-5.1',
    'xiaomi-mimo-mimo-v2.5',
    'openrouter-minimax-m3',
    'nvidia-nim-step-3.7-flash'
  ]);
});

test('subscription band for OpenCode Go, Z.ai, Xiaomi (not OpenCode Zen paid)', () => {
  assert.equal(
    routingExhaustionBandForModel('opencode-code-minimax-m3'),
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
  assert.equal(
    routingExhaustionBandForModel('opencode-zen-deepseek-v4-flash'),
    ROUTING_EXHAUSTION_BAND.PAID
  );
});

test('paid provider order: wafer → zenmux → openrouter → cline → kilo → opencode-zen → nvidia', () => {
  const catalog = new Map([
    ['opencode-zen-claude-sonnet-4-6', { provider: 'opencode-zen', model: 'claude-sonnet-4-6' }],
    ['kilo-deepseek-deepseek-v4-flash', { provider: 'kilo', model: 'deepseek/deepseek-v4-flash' }],
    ['cline-deepseek-deepseek-v4-flash', { provider: 'cline', model: 'deepseek/deepseek-v4-flash' }],
    ['openrouter-minimax-m3', { provider: 'openrouter-presets', model: 'minimax/minimax-m3' }],
    ['zenmux-minimax-m3', { provider: 'zenmux', model: 'minimax/minimax-m3' }],
    ['wafer-ai-minimax-m3', { provider: 'wafer-serverless', model: 'MiniMax-M3' }],
    ['nvidia-nim-step-3.7-flash', { provider: 'nvidia-nim', model: 'stepfun-ai/step-3.7-flash' }],
    ['zai-code-pass-glm-5.1', { provider: 'zai', model: 'code-pass-glm-5.1' }]
  ]);
  const sorted = stableSortModelIdsByRoutingExhaustion(
    [
      'nvidia-nim-step-3.7-flash',
      'opencode-zen-claude-sonnet-4-6',
      'kilo-deepseek-deepseek-v4-flash',
      'cline-deepseek-deepseek-v4-flash',
      'openrouter-minimax-m3',
      'zenmux-minimax-m3',
      'wafer-ai-minimax-m3',
      'zai-code-pass-glm-5.1'
    ],
    (id) => catalog.get(id)
  );
  assert.deepEqual(sorted, [
    'zai-code-pass-glm-5.1',
    'wafer-ai-minimax-m3',
    'zenmux-minimax-m3',
    'openrouter-minimax-m3',
    'cline-deepseek-deepseek-v4-flash',
    'kilo-deepseek-deepseek-v4-flash',
    'opencode-zen-claude-sonnet-4-6',
    'nvidia-nim-step-3.7-flash'
  ]);
  assert.deepEqual(ROUTING_PAID_PROVIDER_SUB_ORDER.slice(0, 6), [
    'wafer-serverless',
    'zenmux',
    'openrouter-presets',
    'cline',
    'kilo',
    'opencode-zen'
  ]);
});

test('subscription OpenCode Go before Kilo paid, after OpenCode free', () => {
  const catalog = new Map([
    ['kilo-paid-model', { provider: 'kilo', model: 'anthropic/claude-sonnet-4' }],
    ['opencode-code-minimax-m3-free', { provider: 'opencode-code', model: 'minimax-m3-free' }],
    ['opencode-code-minimax-m3', { provider: 'opencode-code', model: 'minimax-m3' }]
  ]);
  const sorted = stableSortModelIdsByRoutingExhaustion(
    ['opencode-code-minimax-m3', 'kilo-paid-model', 'opencode-code-minimax-m3-free'],
    (id) => catalog.get(id)
  );
  assert.deepEqual(sorted, [
    'opencode-code-minimax-m3-free',
    'opencode-code-minimax-m3',
    'kilo-paid-model'
  ]);
});
