import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTING_EXHAUSTION_BAND,
  ROUTING_PAID_PROVIDER_SUB_ORDER,
  SUBSCRIPTION_PROVIDER_SUB_ORDER,
  routingExhaustionBandForModel,
  stableSortModelIdsByRoutingExhaustion
} from '../build/routing-exhaustion-order.js';

test('free → subscription → paid ordering', () => {
  const catalog = new Map([
    ['cline-minimax-minimax-m3', { provider: 'cline', model: 'minimax/minimax-m3' }],
    ['kilo-stepfun-step-3.7-flash-free', { provider: 'kilo', model: 'stepfun/step-3.7-flash:free' }],
    ['opencode-zen-minimax-m3-free', { provider: 'opencode-zen', model: 'minimax-m3-free' }],
    ['opencode-go-minimax-m3', { provider: 'opencode-go', model: 'minimax-m3' }]
  ]);
  const ids = [
    'openrouter-minimax-m3',
    'opencode-go-minimax-m3',
    'nvidia-nim-step-3.7-flash',
    'opencode-zen-minimax-m3-free',
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
    'opencode-zen-minimax-m3-free',
    'opencode-go-minimax-m3',
    'zai-code-pass-glm-5.1',
    'xiaomi-mimo-mimo-v2.5',
    'openrouter-minimax-m3',
    'nvidia-nim-step-3.7-flash'
  ]);
});

test('subscription band for OpenCode Go, Z.ai, Xiaomi (not OpenCode Zen paid)', () => {
  assert.equal(
    routingExhaustionBandForModel('opencode-go-minimax-m3'),
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

test('subscription sub-order: opencode-go → zai → xiaomi-mimo', () => {
  assert.deepEqual(SUBSCRIPTION_PROVIDER_SUB_ORDER, [
    'opencode-go',
    'zai',
    'xiaomi-mimo'
  ]);
  const catalog = new Map([
    ['xiaomi-mimo-mimo-v2.5-pro', { provider: 'xiaomi-mimo', model: 'mimo-v2.5-pro' }],
    ['zai-code-pass-glm-5.1', { provider: 'zai', model: 'code-pass-glm-5.1' }],
    ['opencode-go-deepseek-v4-pro', { provider: 'opencode-go', model: 'deepseek-v4-pro' }]
  ]);
  const sorted = stableSortModelIdsByRoutingExhaustion(
    ['xiaomi-mimo-mimo-v2.5-pro', 'zai-code-pass-glm-5.1', 'opencode-go-deepseek-v4-pro'],
    (id) => catalog.get(id)
  );
  assert.deepEqual(sorted, [
    'opencode-go-deepseek-v4-pro',
    'zai-code-pass-glm-5.1',
    'xiaomi-mimo-mimo-v2.5-pro'
  ]);
});

test('paid provider order: wafer → zenmux → openrouter → nebius → cline → kilo', () => {
  const catalog = new Map([
    ['nebius-nemotron-3-ultra-550b-a55b', { provider: 'nebius', model: 'nvidia/Nemotron-3-Ultra-550b-a55b' }],
    ['kilo-deepseek-deepseek-v4-flash', { provider: 'kilo', model: 'deepseek/deepseek-v4-flash' }],
    ['cline-deepseek-deepseek-v4-pro', { provider: 'cline', model: 'deepseek/deepseek-v4-pro' }],
    ['openrouter-chain-of-draft', { provider: 'openrouter-presets', model: '@preset/chain-of-draft' }],
    ['zenmux-mimo-v2.5-pro', { provider: 'zenmux', model: 'xiaomi/mimo-v2.5-pro' }],
    ['wafer-ai-deepseek-v4-flash', { provider: 'wafer-serverless', model: 'deepseek-v4-flash' }],
    ['nvidia-nim-step-3.7-flash', { provider: 'nvidia-nim', model: 'stepfun-ai/step-3.7-flash' }],
    ['zai-code-pass-glm-5.1', { provider: 'zai', model: 'code-pass-glm-5.1' }]
  ]);
  const sorted = stableSortModelIdsByRoutingExhaustion(
    [
      'nvidia-nim-step-3.7-flash',
      'nebius-nemotron-3-ultra-550b-a55b',
      'kilo-deepseek-deepseek-v4-flash',
      'cline-deepseek-deepseek-v4-pro',
      'openrouter-chain-of-draft',
      'zenmux-mimo-v2.5-pro',
      'wafer-ai-deepseek-v4-flash',
      'zai-code-pass-glm-5.1'
    ],
    (id) => catalog.get(id)
  );
  assert.deepEqual(sorted, [
    'zai-code-pass-glm-5.1',
    'wafer-ai-deepseek-v4-flash',
    'zenmux-mimo-v2.5-pro',
    'openrouter-chain-of-draft',
    'nebius-nemotron-3-ultra-550b-a55b',
    'cline-deepseek-deepseek-v4-pro',
    'kilo-deepseek-deepseek-v4-flash',
    'nvidia-nim-step-3.7-flash'
  ]);
  assert.deepEqual(ROUTING_PAID_PROVIDER_SUB_ORDER.slice(0, 6), [
    'wafer-serverless',
    'zenmux',
    'openrouter-presets',
    'nebius',
    'cline',
    'kilo'
  ]);
});

test('subscription OpenCode Go before Kilo paid, after OpenCode Zen free', () => {
  const catalog = new Map([
    ['kilo-paid-model', { provider: 'kilo', model: 'anthropic/claude-sonnet-4' }],
    ['opencode-zen-minimax-m3-free', { provider: 'opencode-zen', model: 'minimax-m3-free' }],
    ['opencode-go-minimax-m3', { provider: 'opencode-go', model: 'minimax-m3' }]
  ]);
  const sorted = stableSortModelIdsByRoutingExhaustion(
    ['opencode-go-minimax-m3', 'kilo-paid-model', 'opencode-zen-minimax-m3-free'],
    (id) => catalog.get(id)
  );
  assert.deepEqual(sorted, [
    'opencode-zen-minimax-m3-free',
    'opencode-go-minimax-m3',
    'kilo-paid-model'
  ]);
});
