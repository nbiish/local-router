import test from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyResponseContent,
  isContentFailoverTrigger,
  classifyHttpFailure,
  isClassifiedFailoverError,
  buildFailoverPreservedBody
} = await import('../build/index.js');

test('classifyResponseContent: HTTP error status returns instant_error', () => {
  assert.equal(classifyResponseContent('{"error":"bad"}', false, 401), 'instant_error');
  assert.equal(classifyResponseContent('quota exceeded', false, 429), 'instant_error');
  assert.equal(classifyResponseContent('server down', false, 503), 'instant_error');
});

test('classifyResponseContent: non-stream valid JSON with choices returns generated', () => {
  const body = JSON.stringify({ choices: [{ message: { content: 'Hello world' } }] });
  assert.equal(classifyResponseContent(body, false, 200), 'generated');
});

test('classifyResponseContent: non-stream JSON with error field returns instant_error', () => {
  const body = JSON.stringify({ error: { message: 'quota exceeded', type: 'insufficient_quota' } });
  assert.equal(classifyResponseContent(body, false, 200), 'instant_error');
});

test('classifyResponseContent: streaming with multiple SSE chunks returns streaming', () => {
  const chunks = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\n';
  assert.equal(classifyResponseContent(chunks, true, 200), 'streaming');
});

test('classifyResponseContent: streaming single chunk with error keywords returns instant_error', () => {
  const single = 'data: {"error":{"message":"quota exceeded"}}\n\n';
  assert.equal(classifyResponseContent(single, true, 200), 'instant_error');
});

test('classifyResponseContent: streaming single chunk without error returns streaming', () => {
  const single = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n';
  assert.equal(classifyResponseContent(single, true, 200), 'streaming');
});

test('classifyResponseContent: an empty completion is a failed turn, not a success', () => {
  // Measured live 2026-11-09: openrouter-lfm-3-1.7b-free with reasoning_effort
  // 'high' returned HTTP 200, finish_reason 'length', 900 billed reasoning
  // tokens, and content ''. That classified as 'generated', so the fallback chain
  // accepted an empty answer and the caller got nothing while being billed.
  const empty = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }]
  });
  assert.equal(classifyResponseContent(empty, false, 200), 'instant_error');

  const whitespace = JSON.stringify({ choices: [{ message: { content: '   \n ' }, finish_reason: 'stop' }] });
  assert.equal(classifyResponseContent(whitespace, false, 200), 'instant_error');

  // Reasoning text is not a reply: every thinking harness renders it separately.
  const reasoningOnly = JSON.stringify({
    choices: [{ message: { content: '', reasoning_content: 'long scratchwork' }, finish_reason: 'length' }]
  });
  assert.equal(classifyResponseContent(reasoningOnly, false, 200), 'instant_error');
});

test('classifyResponseContent: a tool-call-only turn is still a valid answer', () => {
  // An agent turn that only issues a tool call has no content by design; failing
  // it over would break every tool-using harness.
  const toolOnly = JSON.stringify({
    choices: [{
      message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{}' } }] },
      finish_reason: 'tool_calls'
    }]
  });
  assert.equal(classifyResponseContent(toolOnly, false, 200), 'generated');
});

test('classifyResponseContent: a content-block answer counts', () => {
  const blocks = JSON.stringify({
    choices: [{ message: { content: [{ type: 'text', text: 'an answer' }] }, finish_reason: 'stop' }]
  });
  assert.equal(classifyResponseContent(blocks, false, 200), 'generated');
});

test('isContentFailoverTrigger: only triggers on instant_error', () => {
  assert.equal(isContentFailoverTrigger('instant_error'), true);
  assert.equal(isContentFailoverTrigger('generated'), false);
  assert.equal(isContentFailoverTrigger('streaming'), false);
});

test('classifyHttpFailure: 401/403 maps to auth', () => {
  assert.equal(classifyHttpFailure(401, ''), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(403, ''), 'upstream_http_auth');
});

test('classifyHttpFailure: 429 maps to quota', () => {
  assert.equal(classifyHttpFailure(429, ''), 'upstream_http_quota');
});

test('classifyHttpFailure: 502/503 maps to unavailable', () => {
  assert.equal(classifyHttpFailure(502, ''), 'upstream_http_unavailable');
  assert.equal(classifyHttpFailure(503, ''), 'upstream_http_unavailable');
});

test('classifyHttpFailure: body text patterns override status', () => {
  assert.equal(classifyHttpFailure(200, 'invalid api key provided'), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(200, 'billing quota exceeded'), 'upstream_http_quota');
  assert.equal(classifyHttpFailure(200, 'subscription expired'), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(200, 'service unavailable temporarily'), 'upstream_http_unavailable');
});

test('isClassifiedFailoverError: quota and unavailable trigger, auth does not', () => {
  assert.equal(isClassifiedFailoverError('upstream_http_quota'), true);
  assert.equal(isClassifiedFailoverError('upstream_http_unavailable'), true);
  assert.equal(isClassifiedFailoverError('upstream_http_payment_required'), true);
  assert.equal(isClassifiedFailoverError('upstream_http_auth'), false);
  assert.equal(isClassifiedFailoverError('upstream_http'), false);
  assert.equal(isClassifiedFailoverError('provider_not_found'), false);
});

test('buildFailoverPreservedBody: preserves conversation context and injects failover event', () => {
  const body = {
    model: 'provider-a/model-x',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
      { role: 'user', content: 'How are you?' }
    ]
  };
  const preserved = buildFailoverPreservedBody(body, 'provider-b/model-y');
  assert.equal(preserved.model, 'provider-b/model-y');
  assert.equal(preserved.messages.length, 5);
  const lastMsg = preserved.messages[preserved.messages.length - 1];
  assert.equal(lastMsg.role, 'system');
  const event = JSON.parse(lastMsg.content);
  assert.equal(event.event, 'local_router.failover');
  assert.equal(event.data.from, 'provider-a/model-x');
  assert.equal(event.data.to, 'provider-b/model-y');
  assert.ok(event.data.timestamp);
});
