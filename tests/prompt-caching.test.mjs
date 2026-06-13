import test from 'node:test';
import assert from 'node:assert/strict';
import { injectPromptCaching } from '../build/index.js';

test('Minimax M3 model on Pioneer gets cache_control with ttl: "1h"', () => {
  const body = {
    model: 'pioneer/minimax-m3',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'a'.repeat(900) }
    ]
  };
  
  const result = injectPromptCaching(body, 'pioneer');
  assert.equal(result.prompt_cache_retention, undefined);
  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
});

test('Minimax M3 model on ZenMux gets cache_control with custom ttl: "1h"', () => {
  const body = {
    model: 'zenmux/minimax-m3',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'a'.repeat(900) }
    ]
  };
  
  const result = injectPromptCaching(body, 'zenmux');
  assert.equal(result.prompt_cache_retention, undefined);
  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
});

test('GPT model on Pioneer gets prompt_cache_retention: "24h" and no cache_control', () => {
  const body = {
    model: 'pioneer/gpt-4o',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'a'.repeat(900) }
    ]
  };
  
  const result = injectPromptCaching(body, 'pioneer');
  assert.equal(result.prompt_cache_retention, '24h');
  assert.equal(typeof result.messages[0].content, 'string');
});

test('DeepSeek model on Pioneer gets cache_control with ttl: "1h"', () => {
  const body = {
    model: 'pioneer/deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'a'.repeat(900) }
    ]
  };
  
  const result = injectPromptCaching(body, 'pioneer');
  assert.equal(result.prompt_cache_retention, undefined);
  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
});

test('Tiny prompts are modified under new protocol', () => {
  const body = {
    model: 'pioneer/minimax-m3',
    messages: [
      { role: 'system', content: 'Short prompt' },
      { role: 'user', content: 'Short' }
    ]
  };
  
  const result = injectPromptCaching(body, 'pioneer');
  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'Short prompt', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
});

test('Leftover cache_control is stripped and simplified when falling back to OpenAI-family models', () => {
  const body = {
    model: 'pioneer/gpt-4o',
    messages: [
      { role: 'system', content: [
        { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } }
      ]},
      { role: 'user', content: 'hello' }
    ]
  };

  const result = injectPromptCaching(body, 'pioneer');
  assert.equal(result.prompt_cache_retention, '24h');
  assert.equal(result.messages[0].content, 'You are a helpful assistant.');
  assert.equal(typeof result.messages[0].content, 'string');
});

test('Leftover cache_control is stripped and simplified when falling back to unsupported providers (e.g. Nebius)', () => {
  const body = {
    model: 'nebius/deepseek-v4-pro',
    messages: [
      { role: 'system', content: [
        { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } }
      ]},
      { role: 'user', content: 'hello' }
    ]
  };

  const result = injectPromptCaching(body, 'nebius');
  assert.equal(result.prompt_cache_retention, undefined);
  assert.equal(result.messages[0].content, 'You are a helpful assistant.');
  assert.equal(typeof result.messages[0].content, 'string');
});

test('Cache_control is preserved and updated when falling back to supported providers (e.g. ZenMux)', () => {
  const body = {
    model: 'zenmux/deepseek-v4-pro',
    messages: [
      { role: 'system', content: [
        { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '5m' } }
      ]},
      { role: 'user', content: 'hello' }
    ]
  };

  const result = injectPromptCaching(body, 'zenmux');
  assert.equal(result.prompt_cache_retention, undefined);
  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'You are a helpful assistant.', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
});

test('OpenAI model gets prompt_cache_key parameter for sticky routing', () => {
  const body = {
    model: 'pioneer/gpt-4o',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Explain prompt caching.' }
    ]
  };

  const result = injectPromptCaching(body, 'pioneer');
  assert.equal(result.prompt_cache_retention, '24h');
  assert.ok(result.prompt_cache_key.startsWith('lr_'));
  
  // Verify stability (same prompt must yield same cache key)
  const result2 = injectPromptCaching(body, 'pioneer');
  assert.equal(result2.prompt_cache_key, result.prompt_cache_key);
});

test('Kimi model gets prompt_cache_key parameter for sticky routing', () => {
  const body = {
    model: 'openrouter/moonshotai/kimi-k2.6',
    messages: [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Explain prompt caching.' }
    ]
  };

  const result = injectPromptCaching(body, 'openrouter');
  assert.ok(result.prompt_cache_key.startsWith('lr_'));
  
  // Verify stability
  const result2 = injectPromptCaching(body, 'openrouter');
  assert.equal(result2.prompt_cache_key, result.prompt_cache_key);
});

test('Cache-disabling flags are stripped from request body', () => {
  const body = {
    model: 'pioneer/minimax-m3',
    cache: false,
    use_cache: false,
    no_cache: true,
    bypass_cache: true,
    messages: [
      { role: 'system', content: 'You are a coding assistant.' }
    ]
  };

  const result = injectPromptCaching(body, 'pioneer');
  assert.equal(result.cache, undefined);
  assert.equal(result.use_cache, undefined);
  assert.equal(result.no_cache, undefined);
  assert.equal(result.bypass_cache, undefined);
});

test('provider.order is stripped for OpenRouter models to protect sticky caching', () => {
  const body = {
    model: 'openrouter/anthropic/claude-3.5-sonnet',
    provider: {
      order: ['Anthropic'],
      data_collection: 'deny'
    },
    messages: [
      { role: 'system', content: 'You are a coding assistant.' }
    ]
  };

  const result = injectPromptCaching(body, 'openrouter');
  assert.equal(result.provider.order, undefined);
  assert.equal(result.provider.data_collection, 'deny');
});
