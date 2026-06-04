import test from 'node:test';
import assert from 'node:assert/strict';

test('ollama cloud catalog tiers and routing allowlist', async () => {
  const {
    DEFAULT_OLLAMA_CLOUD_FREE_ROUTING_TAGS,
    filterOllamaCloudPullTags,
    isOllamaCloudPresentedIdBlocked,
    isOllamaCloudProOnlyTag,
    ollamaCloudAllowedPresentedIds,
    ollamaCloudPresentedId
  } = await import('../build/ollama-cloud-catalog.js');

  assert.equal(isOllamaCloudProOnlyTag('deepseek-v4-pro:cloud'), true);
  assert.equal(isOllamaCloudProOnlyTag('nemotron-3-ultra:cloud'), false);
  assert.equal(isOllamaCloudProOnlyTag('minimax-m3:cloud'), false);

  const freeIds = ollamaCloudAllowedPresentedIds(false);
  assert.equal(freeIds.size, DEFAULT_OLLAMA_CLOUD_FREE_ROUTING_TAGS.length);
  assert.ok(freeIds.has('ollama-nemotron-3-ultra-cloud'));
  assert.ok(freeIds.has('ollama-minimax-m3-cloud'));
  assert.ok(freeIds.has('ollama-deepseek-v4-flash-cloud'));
  assert.equal(freeIds.has('ollama-qwen3.5-cloud'), false);

  assert.equal(
    isOllamaCloudPresentedIdBlocked(
      'ollama-qwen3.5-cloud',
      'qwen3.5:cloud',
      false
    ),
    true
  );
  assert.equal(
    isOllamaCloudPresentedIdBlocked(
      'ollama-nemotron-3-ultra-cloud',
      'nemotron-3-ultra:cloud',
      false
    ),
    false
  );

  const pullFree = filterOllamaCloudPullTags([
    'nemotron-3-ultra:cloud',
    'qwen3.5:cloud',
    'deepseek-v4-pro:cloud',
    'llama3.2'
  ], false);
  assert.deepEqual(pullFree, ['nemotron-3-ultra:cloud']);

  assert.equal(
    ollamaCloudPresentedId('deepseek-v4-flash:cloud'),
    'ollama-deepseek-v4-flash-cloud'
  );
});
