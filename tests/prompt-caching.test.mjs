import test from 'node:test';
import assert from 'node:assert/strict';
import { injectPromptCaching, getPromptCacheKey, extractMessageText, stripCacheControl } from '../build/index.js';

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
    model: 'openrouter/moonshotai/kimi-k2.7',
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

test('Tools definition caching: last tool gets cache_control for explicit providers', () => {
  const body = {
    model: 'openrouter/anthropic/claude-3.5-sonnet',
    messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Use tools.' }
    ],
    tools: [
      { type: 'function', function: { name: 'tool_one', description: 'first tool' } },
      { type: 'function', function: { name: 'tool_two', description: 'second tool' } }
    ]
  };

  const result = injectPromptCaching(body, 'openrouter');
  assert.equal(result.tools.length, 2);
  assert.equal(result.tools[0].cache_control, undefined);
  assert.deepEqual(result.tools[1].cache_control, { type: 'ephemeral', ttl: '1h' });
});

test('Tools definition caching: cache_control stripped from tools for OpenAI-family', () => {
  const body = {
    model: 'pioneer/gpt-4o',
    messages: [
      { role: 'system', content: 'You are an agent.' },
      { role: 'user', content: 'Use tools.' }
    ],
    tools: [
      { type: 'function', function: { name: 'tool_one' }, cache_control: { type: 'ephemeral', ttl: '1h' } }
    ]
  };

  const result = injectPromptCaching(body, 'pioneer');
  assert.equal(result.tools[0].cache_control, undefined);
  assert.equal(result.prompt_cache_retention, '24h');
});

test('Hash stability: getPromptCacheKey returns identical hash for string vs array/multimodal content', () => {
  const stringMessages = [
    { role: 'system', content: 'You are an expert system.' },
    { role: 'user', content: 'Help me debug this issue.' }
  ];
  const arrayMessages = [
    { role: 'system', content: [{ type: 'text', text: 'You are an expert system.' }] },
    { role: 'user', content: [{ type: 'text', text: 'Help me debug this issue.' }] }
  ];

  const keyFromString = getPromptCacheKey(stringMessages);
  const keyFromArray = getPromptCacheKey(arrayMessages);

  assert.ok(keyFromString && keyFromString.startsWith('lr_'));
  assert.equal(keyFromString, keyFromArray);
});

test('OpenRouter sticky routing: session_id and prompt_cache_key set for Claude, DeepSeek, and all models', () => {
  const body = {
    model: 'openrouter/anthropic/claude-3.7-sonnet',
    messages: [
      { role: 'system', content: 'You are Claude.' },
      { role: 'user', content: 'Write a poem.' }
    ]
  };

  const result = injectPromptCaching(body, 'openrouter');
  assert.ok(result.session_id && result.session_id.startsWith('lr_'));
  assert.equal(result.session_id, result.prompt_cache_key);
});

test('Z.ai GLM models: clear_thinking is set to false and prompt_cache_key is populated', () => {
  const body = {
    model: 'zai/glm-5.3-flash',
    messages: [
      { role: 'system', content: 'Coding assistant.' },
      { role: 'user', content: 'Write code.' }
    ]
  };

  const result = injectPromptCaching(body, 'zai');
  assert.equal(result.clear_thinking, false);
  assert.ok(result.prompt_cache_key && result.prompt_cache_key.startsWith('lr_'));
});

test('Ollama: keep_alive defaults to 24h to keep KV cache resident in memory', () => {
  const body = {
    model: 'ollama/deepseek-v4-flash:cloud',
    messages: [
      { role: 'system', content: [
        { type: 'text', text: 'Local Ollama assistant', cache_control: { type: 'ephemeral' } }
      ]},
      { role: 'user', content: 'Hello' }
    ]
  };

  const result = injectPromptCaching(body, 'ollama');
  assert.equal(result.keep_alive, '24h');
  // Confirm cache_control is stripped
  assert.equal(typeof result.messages[0].content, 'string');
  assert.equal(result.messages[0].content, 'Local Ollama assistant');
});

test('Multi-turn conversation breakpoint: placed before the latest user message', () => {
  const body = {
    model: 'zenmux/claude-3.5-sonnet',
    messages: [
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'Turn 1 user' },
      { role: 'assistant', content: 'Turn 1 assistant' },
      { role: 'user', content: 'Turn 2 user (latest)' }
    ]
  };

  const result = injectPromptCaching(body, 'zenmux');
  // System prompt has cache_control
  assert.deepEqual(result.messages[0].content, [
    { type: 'text', text: 'System prompt.', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
  // Turn 1 assistant (turn preceding latest user) has cache_control
  assert.deepEqual(result.messages[2].content, [
    { type: 'text', text: 'Turn 1 assistant', cache_control: { type: 'ephemeral', ttl: '1h' } }
  ]);
  // Turn 2 user does NOT have cache_control (it is the active turn)
  assert.equal(typeof result.messages[3].content, 'string');
});
