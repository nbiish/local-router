import test from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyResponseContent,
  isContentFailoverTrigger,
  classifyHttpFailure,
  normalizeHttpFailure,
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

test('classifyHttpFailure: 429 maps to rate limit; money evidence beats it', () => {
  assert.equal(classifyHttpFailure(429, ''), 'upstream_http_rate_limit');
  // OpenAI reports `insufficient_quota` as 429 — an empty balance, not a rate limit.
  assert.equal(classifyHttpFailure(429, 'insufficient_quota'), 'upstream_http_payment_required');
  assert.equal(
    classifyHttpFailure(429, 'You exceeded your current quota, please check your plan and billing details'),
    'upstream_http_payment_required'
  );
});

test('classifyHttpFailure: 402 maps to payment required (out of funds)', () => {
  assert.equal(classifyHttpFailure(402, ''), 'upstream_http_payment_required');
});

test('classifyHttpFailure: 413 is a request-shape error, not a rate limit', () => {
  assert.equal(classifyHttpFailure(413, ''), 'upstream_http_invalid_request');
});

test('classifyHttpFailure: 502/503 maps to unavailable', () => {
  assert.equal(classifyHttpFailure(502, ''), 'upstream_http_unavailable');
  assert.equal(classifyHttpFailure(503, ''), 'upstream_http_unavailable');
});

test('classifyHttpFailure: body text patterns override status', () => {
  assert.equal(classifyHttpFailure(200, 'invalid api key provided'), 'upstream_http_auth');
  // Out-of-funds evidence wins over a bare "quota" mention: a balance problem
  // is fixed by top-up, a usage limit by backoff — never the same fix.
  assert.equal(classifyHttpFailure(200, 'billing quota exceeded'), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(200, 'insufficient balance: top up your account'), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(200, 'subscription expired'), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(200, 'usage limit exceeded for this hour'), 'upstream_http_quota');
  assert.equal(classifyHttpFailure(200, 'rate limit exceeded'), 'upstream_http_quota');
  assert.equal(classifyHttpFailure(200, 'service unavailable temporarily'), 'upstream_http_unavailable');
  assert.equal(classifyHttpFailure(200, 'api_usage_error: unknown model: foo'), 'upstream_http_invalid_request');
  assert.equal(classifyHttpFailure(200, 'context_length_exceeded'), 'upstream_http_invalid_request');
});

test('classifyHttpFailure: completion prose never decides the failure class', () => {
  // Measured live 2026-11-20: 45 stages were HTTP-200 completions booked as
  // rejected keys because their reasoning text contained the word "auth" —
  // and `key_rejected` is a one-strike immediate quarantine, so each one
  // evicted a healthy provider.
  const reasoningOnly = JSON.stringify({
    id: 'x',
    choices: [{ finish_reason: 'length', index: 0, message: { content: '', role: 'assistant', reasoning_content: 'The author of this request wants me to…' } }]
  });
  assert.equal(classifyHttpFailure(200, reasoningOnly), 'upstream_http');

  const answerMentionsAuth = JSON.stringify({
    id: 'x',
    choices: [{ finish_reason: 'stop', index: 0, message: { content: 'authorized users only' } }]
  });
  assert.equal(classifyHttpFailure(200, answerMentionsAuth), 'upstream_http');

  // The bare word "auth" is no longer auth evidence even off a 2xx.
  assert.equal(classifyHttpFailure(500, 'the author of the upstream page says hello'), 'upstream_http_unavailable');
  assert.equal(classifyHttpFailure(400, 'authorship metadata rejected'), 'upstream_http_invalid_request');

  // Specific auth phrasing still classifies, including status 401/403.
  assert.equal(classifyHttpFailure(401, ''), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(403, ''), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(400, 'authentication failed'), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(400, 'invalid api key'), 'upstream_http_auth');
});

test('normalizeHttpFailure: a 2xx completion keeps its empty_completion class', () => {
  const emptyBody = JSON.stringify({
    id: 'x',
    choices: [{ finish_reason: 'length', index: 0, message: { content: '', reasoning_content: 'thinking about auth tokens…' } }]
  });
  const normalized = normalizeHttpFailure({
    errorType: 'empty_completion',
    status: 200,
    message: 'empty',
    responseText: emptyBody
  });
  assert.equal(normalized.errorType, 'empty_completion');

  // A 2xx error payload IS classifiable from its body: some surfaces use 200
  // for real failures and there is no other evidence.
  const errorBody = JSON.stringify({ error: { message: 'insufficient_quota' } });
  assert.equal(
    normalizeHttpFailure({ errorType: 'upstream_http', status: 200, message: 'x', responseText: errorBody }).errorType,
    'upstream_http_payment_required'
  );
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
  // The marker must NOT be a second system turn: gateways reject a system
  // message that is not first (Z.ai: {"code":1214,"Incorrect role information"}).
  assert.equal(lastMsg.role, 'user');
  const event = JSON.parse(lastMsg.content);
  assert.equal(event.event, 'local_router.failover');
  assert.equal(event.data.from, 'provider-a/model-x');
  assert.equal(event.data.to, 'provider-b/model-y');
  assert.ok(event.data.timestamp);
});

test('buildFailoverPreservedBody: system message stays first across a failover hop', () => {
  const body = {
    model: 'provider-a/model-x',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' }
    ]
  };
  const roles = buildFailoverPreservedBody(body, 'provider-b/model-y').messages.map((m) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'user']);
  assert.equal(roles.indexOf('system'), roles.lastIndexOf('system'));
});
