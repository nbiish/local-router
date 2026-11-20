import test from 'node:test';
import assert from 'node:assert/strict';

const { clampOutputTokens } = await import('../build/index.js');
const { dropUnsupportedRequestFields } = await import('../build/provider-policy.js');

test('clampOutputTokens: lowers an impossible client budget to the model ceiling', () => {
  // Measured live 2026-11-20: 30 failures were the router forwarding
  // max_completion_tokens 943718 to a model that supports 131072.
  const result = clampOutputTokens({ model: 'm', max_completion_tokens: 943718 }, 131072);
  assert.equal(result.body.max_completion_tokens, 131072);
  assert.deepEqual(result.clamped, { requested: 943718, clamped: 131072 });
});

test('clampOutputTokens: never raises a smaller caller budget', () => {
  // Growing a caller's request would change latency and cost behind their back.
  const result = clampOutputTokens({ model: 'm', max_tokens: 256 }, 131072);
  assert.equal(result.body.max_tokens, 256);
  assert.equal(result.clamped, undefined);
});

test('clampOutputTokens: leaves a body with no output budget untouched', () => {
  const body = { model: 'm', messages: [] };
  const result = clampOutputTokens(body, 4096);
  assert.equal(result.body, body);
  assert.equal(result.clamped, undefined);
});

test('clampOutputTokens: prefers max_completion_tokens when both are present', () => {
  const result = clampOutputTokens({ max_completion_tokens: 999999, max_tokens: 128 }, 4096);
  assert.equal(result.body.max_completion_tokens, 4096);
  // The untouched sibling keeps its own (already acceptable) value.
  assert.equal(result.body.max_tokens, 128);
  assert.deepEqual(result.clamped, { requested: 999999, clamped: 4096 });
});

test('dropUnsupportedRequestFields: a strict surface loses fields it would 400 on', () => {
  // Antigravity (Google AI Studio OpenAI-compat) answers 400 for unknown names:
  // "Invalid JSON payload received. Unknown name \"store\"" / "prompt_cache_key".
  const result = dropUnsupportedRequestFields(
    { model: 'gemini-3.7-flash', messages: [], store: false, prompt_cache_key: 'k', temperature: 0.2 },
    'antigravity',
    'gemini-3.7-flash'
  );
  assert.deepEqual(result.dropped.sort(), ['prompt_cache_key', 'store']);
  assert.deepEqual(Object.keys(result.body).sort(), ['messages', 'model', 'temperature']);
});

test('dropUnsupportedRequestFields: a lenient surface keeps today\'s passthrough', () => {
  const result = dropUnsupportedRequestFields(
    { model: 'x/y', messages: [], store: false, prompt_cache_key: 'k' },
    'openrouter',
    'anthropic/claude-fable-5.2'
  );
  assert.deepEqual(result.dropped, []);
  assert.equal(result.body.store, false);
  assert.equal(result.body.prompt_cache_key, 'k');
});

test('dropUnsupportedRequestFields: a strict surface keeps the standard chat core', () => {
  const body = {
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    max_tokens: 1024,
    temperature: 0.5,
    tools: [],
    tool_choice: 'auto',
    reasoning_effort: 'high'
  };
  const result = dropUnsupportedRequestFields(body, 'antigravity', 'gemini-3.7-flash');
  assert.deepEqual(result.dropped, []);
  assert.deepEqual(Object.keys(result.body).sort(), Object.keys(body).sort());
});
