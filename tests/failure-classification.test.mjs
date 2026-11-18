import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyHttpFailure, isRetryableAgainstSameMember, isNoUsableContent } =
  await import('../build/index.js');

// ---------------------------------------------------------------------------
// 404 must be named, not swallowed by the catch-all.
// Bodies here are the real ones captured from the live router on 2026-11-18.
// ---------------------------------------------------------------------------

test('the real cursor 404 body classifies as route-not-found', () => {
  const body = '{"message":"Route POST:/v1/chat/completions not found","error":"Not Found","statusCode":404}';
  assert.equal(classifyHttpFailure(404, body), 'upstream_route_not_found');
});

test('a 404 naming a model classifies as model-not-found', () => {
  assert.equal(
    classifyHttpFailure(404, '{"error":{"message":"model not found"}}'),
    'upstream_model_not_found'
  );
  assert.equal(
    classifyHttpFailure(404, '{"error":"unknown model deepseek-v9"}'),
    'upstream_model_not_found'
  );
});

test('an ambiguous 404 still becomes permanent rather than the catch-all', () => {
  // Fail closed: unknown 404 shape is permanent, so it is not retried as a transient.
  assert.equal(classifyHttpFailure(404, '{"error":"not found"}'), 'upstream_route_not_found');
  assert.equal(classifyHttpFailure(404, ''), 'upstream_route_not_found');
});

test('the previously-correct classifications are unchanged', () => {
  assert.equal(classifyHttpFailure(402, ''), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(429, '{"error":"insufficient_quota"}'), 'upstream_http_payment_required');
  assert.equal(classifyHttpFailure(401, ''), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(403, ''), 'upstream_http_auth');
  assert.equal(classifyHttpFailure(429, ''), 'upstream_http_rate_limit');
  assert.equal(classifyHttpFailure(502, ''), 'upstream_http_unavailable');
  assert.equal(classifyHttpFailure(503, ''), 'upstream_http_unavailable');
  assert.equal(classifyHttpFailure(400, ''), 'upstream_http_invalid_request');
  assert.equal(classifyHttpFailure(413, ''), 'upstream_http_invalid_request');
  assert.equal(classifyHttpFailure(422, ''), 'upstream_http_invalid_request');
});

// ---------------------------------------------------------------------------
// Retry economics: permanent failures must not burn three attempts.
// ---------------------------------------------------------------------------

test('permanent failures are not retried against the same member', () => {
  assert.equal(isRetryableAgainstSameMember('upstream_route_not_found'), false);
  assert.equal(isRetryableAgainstSameMember('upstream_model_not_found'), false);
  assert.equal(isRetryableAgainstSameMember('upstream_http_invalid_request'), false);
  assert.equal(isRetryableAgainstSameMember('unknown_model'), false);
});

test('transient failures keep their retries', () => {
  assert.equal(isRetryableAgainstSameMember('upstream_http_unavailable'), true);
  assert.equal(isRetryableAgainstSameMember('upstream_http_rate_limit'), true);
  assert.equal(isRetryableAgainstSameMember('upstream_http'), true);
});

// ---------------------------------------------------------------------------
// A 200 with no usable content is NOT a success (also fixed 2026-11-18).
// ---------------------------------------------------------------------------

test('a 200 with no choices is an empty completion, not an answer', () => {
  assert.equal(isNoUsableContent('{"id":"x","object":"chat.completion"}', 200), false,
    'no choices at all is a provider-shape fault, not an empty completion');
  assert.equal(isNoUsableContent('{"choices":[]}', 200), false,
    'an empty choices array is a provider-shape fault too');
});

test('a 200 that answers with empty content and no tools IS an empty completion', () => {
  const body = '{"choices":[{"finish_reason":"length","message":{"content":"","reasoning_content":"thinking..."}}]}';
  assert.equal(isNoUsableContent(body, 200), true,
    'the reasoning-only case must be recognised as a model-budget outcome');
});

test('a 200 carrying real content is not an empty completion', () => {
  assert.equal(isNoUsableContent('{"choices":[{"message":{"content":"hello"}}]}', 200), false);
});

test('a 200 carrying tool calls is not an empty completion', () => {
  const body = '{"choices":[{"message":{"content":"","tool_calls":[{"id":"1","function":{"name":"f","arguments":"{}"}}]}}]}';
  assert.equal(isNoUsableContent(body, 200), false);
});

test('a body with an error is not an empty completion', () => {
  assert.equal(isNoUsableContent('{"error":{"message":"boom"}}', 200), false);
});

test('an unparseable body is not an empty completion', () => {
  assert.equal(isNoUsableContent('<html>502 Bad Gateway</html>', 200), false,
    'an HTML error page is a provider fault, not a model-budget outcome');
});
