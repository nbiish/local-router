import test from 'node:test';
import assert from 'node:assert/strict';

test('isOllamaCloudModelName matches cloud tag conventions', async () => {
  const { isOllamaCloudModelName, filterOllamaCloudTags } = await import('../build/ollama-cloud.js');

  assert.equal(isOllamaCloudModelName('glm-5.1:cloud'), true);
  assert.equal(isOllamaCloudModelName('gpt-oss:120b-cloud'), true);
  assert.equal(isOllamaCloudModelName('llama3.2'), false);
  assert.equal(isOllamaCloudModelName('deepseek-v4-flash'), false);

  const filtered = filterOllamaCloudTags([
    { name: 'minimax-m3:cloud' },
    { name: 'llama3.2' },
    { name: 'qwen3.5:cloud' }
  ]);
  assert.deepEqual(filtered, ['minimax-m3:cloud', 'qwen3.5:cloud']);
});

test('ollama API key placeholders and defaults', async () => {
  const {
    DEFAULT_OLLAMA_API_KEY,
    ensureDefaultOllamaApiKey,
    isOllamaPlaceholderKey,
    isRealOllamaComApiKey,
    resolveOllamaApiKey
  } = await import('../build/ollama-keys.js');

  assert.equal(DEFAULT_OLLAMA_API_KEY, 'local-router-ollama');
  assert.equal(isOllamaPlaceholderKey('local-router-ollama'), true);
  assert.equal(isOllamaPlaceholderKey('ollama-local'), true);
  assert.equal(isOllamaPlaceholderKey(''), true);
  assert.equal(isRealOllamaComApiKey('local-router-ollama'), false);
  assert.equal(isRealOllamaComApiKey('sk-ollama-real-key-example'), true);

  const store = {};
  const previous = process.env.OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  ensureDefaultOllamaApiKey(store);
  assert.equal(store.ollama, 'local-router-ollama');
  assert.equal(process.env.OLLAMA_API_KEY, 'local-router-ollama');
  assert.equal(resolveOllamaApiKey(), 'local-router-ollama');

  if (previous === undefined) {
    delete process.env.OLLAMA_API_KEY;
  } else {
    process.env.OLLAMA_API_KEY = previous;
  }
});
