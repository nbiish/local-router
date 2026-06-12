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
