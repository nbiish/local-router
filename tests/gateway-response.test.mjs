import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGatewayChatCompletionBody } from '../build/gateway-response.js';

test('cline unwraps data envelope to OpenAI shape', () => {
  const normalized = normalizeGatewayChatCompletionBody('cline', {
    data: {
      object: 'chat.completion',
      choices: [{ message: { role: 'assistant', content: 'ok' } }]
    }
  });
  assert.equal(normalized.object, 'chat.completion');
  assert.equal(normalized.choices[0].message.content, 'ok');
});

test('kilo and other providers pass through unchanged', () => {
  const payload = { object: 'chat.completion', choices: [] };
  assert.deepEqual(normalizeGatewayChatCompletionBody('kilo', payload), payload);
  assert.deepEqual(normalizeGatewayChatCompletionBody('wafer-serverless', payload), payload);
});
