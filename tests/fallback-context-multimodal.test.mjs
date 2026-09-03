import test from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateRequestContext,
  requestRequiresMultimodal,
  filterEligibleFallbackModels,
  fallbackExecutionPlan
} from '../build/index.js';
import {
  buildMultiPassExecutionPlan,
  DEFAULT_FALLBACK_ROUNDS
} from '../build/execution-plan.js';

test('estimateRequestContext: calculates conservative token requirement from messages and output headroom', () => {
  const shortBody = {
    messages: [
      { role: 'user', content: 'Hello world' }
    ]
  };
  const shortTokens = estimateRequestContext(shortBody);
  // Hello world = 11 chars -> ~4 tokens + 4096 default output headroom
  assert.ok(shortTokens >= 4096);
  assert.ok(shortTokens < 5000);

  // Large prompt
  const largeText = 'a'.repeat(320000); // 320k chars -> ~100k tokens
  const largeBody = {
    messages: [
      { role: 'user', content: largeText }
    ],
    max_tokens: 8192
  };
  const largeTokens = estimateRequestContext(largeBody);
  assert.ok(largeTokens >= 100000 + 8192);
});

test('estimateRequestContext: accounts for visual image tokens', () => {
  const multimodalBody = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Analyze this image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,xxxx' } }
        ]
      }
    ]
  };
  const tokens = estimateRequestContext(multimodalBody);
  // ~1200 image tokens + text tokens + output headroom (4096)
  assert.ok(tokens >= 4096 + 1200);
});

test('requestRequiresMultimodal: detects OpenAI, Anthropic, and Ollama image formats', () => {
  // 1. Text only
  assert.equal(requestRequiresMultimodal({ messages: [{ role: 'user', content: 'hello' }] }), false);

  // 2. OpenAI content array with image_url
  assert.equal(
    requestRequiresMultimodal({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: 'https://example.com/test.png' } }
          ]
        }
      ]
    }),
    true
  );

  // 3. Anthropic image type
  assert.equal(
    requestRequiresMultimodal({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', data: 'abc' } }
          ]
        }
      ]
    }),
    true
  );

  // 4. Ollama images array on message
  assert.equal(
    requestRequiresMultimodal({
      messages: [
        { role: 'user', content: 'check', images: ['base64data'] }
      ]
    }),
    true
  );

  // 5. Ollama root images array
  assert.equal(
    requestRequiresMultimodal({
      prompt: 'check',
      images: ['base64data']
    }),
    true
  );
});

test('filterEligibleFallbackModels: dynamically skips small-context models for large requests', () => {
  const activeModels = ['model-64k', 'model-1m', 'model-128k', 'model-2m'];
  const mockSpecs = {
    'model-64k': { contextLength: 64000, supportsImages: true },
    'model-1m': { contextLength: 1000000, supportsImages: false },
    'model-128k': { contextLength: 131072, supportsImages: true },
    'model-2m': { contextLength: 2000000, supportsImages: false }
  };

  // Request needing ~250,000 tokens (800k chars)
  const body = {
    messages: [{ role: 'user', content: 'x'.repeat(800000) }]
  };

  const result = filterEligibleFallbackModels(activeModels, body, (id) => mockSpecs[id]);
  assert.equal(result.requiresMultimodal, false);
  assert.ok(result.requiredContext > 200000);

  // model-64k and model-128k must be skipped because contextLength < requiredContext
  assert.deepEqual(result.eligible, ['model-1m', 'model-2m']);
  assert.equal(result.skipped.length, 2);
  assert.equal(result.skipped[0].model, 'model-64k');
  assert.equal(result.skipped[0].reason, 'context_window_too_small');
  assert.equal(result.skipped[1].model, 'model-128k');
  assert.equal(result.skipped[1].reason, 'context_window_too_small');
});

test('filterEligibleFallbackModels: dynamically skips non-multimodal models for image requests', () => {
  const activeModels = ['text-only-1m', 'vision-64k', 'vision-1m', 'text-only-2m'];
  const mockSpecs = {
    'text-only-1m': { contextLength: 1000000, supportsImages: false },
    'vision-64k': { contextLength: 64000, supportsImages: true },
    'vision-1m': { contextLength: 1000000, supportsImages: true },
    'text-only-2m': { contextLength: 2000000, supportsImages: false }
  };

  // Multimodal request needing ~100k context (320k chars + image)
  const body = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(320000) },
          { type: 'image_url', image_url: { url: 'data:...' } }
        ]
      }
    ]
  };

  const result = filterEligibleFallbackModels(activeModels, body, (id) => mockSpecs[id]);
  assert.equal(result.requiresMultimodal, true);

  // 'text-only-1m' and 'text-only-2m' lack multimodal support
  // 'vision-64k' has vision but 64k < ~105k context
  // Only 'vision-1m' has BOTH multimodal support AND context window >= 105k
  assert.deepEqual(result.eligible, ['vision-1m']);
  assert.ok(result.skipped.some((s) => s.model === 'text-only-1m' && s.reason === 'no_multimodal_support'));
  assert.ok(result.skipped.some((s) => s.model === 'vision-64k' && s.reason === 'context_window_too_small'));
});

test('buildMultiPassExecutionPlan: generates 3 full rounds across eligible candidates', () => {
  const eligible = ['candidate-A', 'candidate-B'];
  const plan = buildMultiPassExecutionPlan(eligible, DEFAULT_FALLBACK_ROUNDS);

  assert.equal(DEFAULT_FALLBACK_ROUNDS, 3);
  assert.equal(plan.length, 6); // 2 models * 3 passes = 6 stages

  assert.equal(plan[0].model, 'candidate-A');
  assert.equal(plan[0].pass, 1);
  assert.equal(plan[1].model, 'candidate-B');
  assert.equal(plan[1].pass, 1);

  assert.equal(plan[2].model, 'candidate-A');
  assert.equal(plan[2].pass, 2);
  assert.equal(plan[3].model, 'candidate-B');
  assert.equal(plan[3].pass, 2);

  assert.equal(plan[4].model, 'candidate-A');
  assert.equal(plan[4].pass, 3);
  assert.equal(plan[5].model, 'candidate-B');
  assert.equal(plan[5].pass, 3);
});
