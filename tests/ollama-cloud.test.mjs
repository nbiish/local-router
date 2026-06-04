import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
