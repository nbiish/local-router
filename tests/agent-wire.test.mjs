/**
 * agent-wire.test.mjs — regressions for the Claude (`/v1/messages`) and Codex
 * (`/v1/responses`) wire surfaces.
 *
 * Every test here encodes a defect measured live on 2026-11-20 against the
 * running router, not a hypothesis. The client-visible symptom was:
 *
 *   API Error: The response stream was malformed. The response above may be
 *   incomplete.
 *
 * which is what Claude Code reports when a stream ends without a complete,
 * ordered Anthropic frame sequence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicMessagesToChat,
  buildFailoverPreservedBody
} from '../build/index.js';

// ---------------------------------------------------------------------------
// Anthropic → chat-completions message translation
// ---------------------------------------------------------------------------

test('anthropic translation: thinking blocks are dropped, never forwarded', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'internal reasoning', signature: 'sig-abc' },
      { type: 'text', text: 'Here is the answer.' }
    ]
  }];
  const out = anthropicMessagesToChat(messages);
  const flat = JSON.stringify(out);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.ok(!flat.includes('internal reasoning'), 'thinking text must not reach a chat upstream');
  assert.ok(!flat.includes('signature'), 'a Claude signature must not reach a chat upstream');
  assert.equal(out[0].content[0].text, 'Here is the answer.');
});

test('anthropic translation: tool_use becomes assistant.tool_calls, not a content part', () => {
  const messages = [{
    role: 'assistant',
    content: [
      { type: 'text', text: 'Reading the file.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/etc/hosts' } }
    ]
  }];
  const out = anthropicMessagesToChat(messages);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(Array.isArray(out[0].tool_calls), true, 'tool calls belong in the message-level array');
  assert.equal(out[0].tool_calls[0].id, 'toolu_1');
  assert.equal(out[0].tool_calls[0].function.name, 'Read');
  assert.deepEqual(JSON.parse(out[0].tool_calls[0].function.arguments), { file_path: '/etc/hosts' });
  // The old bug left a `{type:'tool_calls'}` part inside content.
  const parts = Array.isArray(out[0].content) ? out[0].content : [];
  assert.ok(!parts.some((p) => p.type === 'tool_calls'), 'no tool_calls content part may survive');
});

test('anthropic translation: tool_result becomes a role:tool message keyed by tool_use_id', () => {
  const messages = [{
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '127.0.0.1 localhost' },
      { type: 'text', text: 'Now summarize it.' }
    ]
  }];
  const out = anthropicMessagesToChat(messages);
  // The question must survive as the user turn (the old marker bug lost it).
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'Now summarize it.');
  const tool = out.find((m) => m.role === 'tool');
  assert.ok(tool, 'a tool result must become its own role:tool message');
  assert.equal(tool.tool_call_id, 'toolu_1');
  assert.equal(tool.content, '127.0.0.1 localhost');
});

test('anthropic translation: a multi-block tool_result is flattened to text', () => {
  const messages = [{
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_2',
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' }
      ]
    }]
  }];
  const out = anthropicMessagesToChat(messages);
  const tool = out.find((m) => m.role === 'tool');
  assert.equal(tool.content, 'line one\nline two');
});

test('anthropic translation: cache_control survives on text parts', () => {
  const messages = [{
    role: 'user',
    content: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }]
  }];
  const out = anthropicMessagesToChat(messages);
  assert.deepEqual(out[0].content[0].cache_control, { type: 'ephemeral' });
});

test('anthropic translation: an image part becomes image_url', () => {
  const messages = [{
    role: 'user',
    content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]
  }];
  const out = anthropicMessagesToChat(messages);
  assert.equal(out[0].content[0].type, 'image_url');
  assert.equal(out[0].content[0].image_url.url, 'data:image/png;base64,AAAA');
});

// ---------------------------------------------------------------------------
// Failover marker must not become the question
// ---------------------------------------------------------------------------

test('failover marker is instructions, not a new user turn', () => {
  const body = {
    model: 'claude-opus-5-5',
    messages: [
      { role: 'system', content: 'You are Claude Code.' },
      { role: 'user', content: 'read /etc/hosts' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'Now summarize it.' }
    ]
  };
  const prepared = buildFailoverPreservedBody(body, 'kilo/some-model');

  // No new turn is added: the model must not be given a fresh thing to answer.
  assert.equal(prepared.messages.length, body.messages.length);
  assert.equal(prepared.messages[prepared.messages.length - 1].role, 'user');
  assert.equal(prepared.messages[prepared.messages.length - 1].content, 'Now summarize it.');

  // The marker still travels, inside the leading system turn.
  assert.equal(prepared.messages[0].role, 'system');
  assert.ok(prepared.messages[0].content.includes('local_router.failover'));
  assert.ok(prepared.messages[0].content.includes('kilo/some-model'));
  // …and no second system message appears after a user turn (the Z.ai 1214 shape).
  const roles = prepared.messages.map((m) => m.role);
  assert.equal(roles.filter((r) => r === 'system').length, 1);
});

test('failover marker inserts a leading system turn when the caller sent none', () => {
  const prepared = buildFailoverPreservedBody(
    { model: 'm', messages: [{ role: 'user', content: 'hi' }] },
    'target/model'
  );
  assert.equal(prepared.messages[0].role, 'system');
  assert.ok(prepared.messages[0].content.includes('local_router.failover'));
  assert.equal(prepared.messages[1].role, 'user');
});

test('failover marker appends to a system message whose content is an array', () => {
  const prepared = buildFailoverPreservedBody({
    model: 'm',
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Rules.', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'go' }
    ]
  }, 'target/model');
  const parts = prepared.messages[0].content;
  assert.equal(parts.length, 1);
  assert.ok(parts[0].text.includes('Rules.'));
  assert.ok(parts[0].text.includes('local_router.failover'));
  assert.deepEqual(parts[0].cache_control, { type: 'ephemeral' });
});
