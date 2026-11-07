import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * Reasoning on the client wires that are NOT OpenAI- or Ollama-shaped.
 *
 * local-router is a single shim: the same provider is meant to power an Ollama-aware tool, a
 * Claude client (Anthropic /v1/messages) and a Codex client (Responses /v1/responses). Each wire
 * has its own place to put reasoning, and each one was silently dropping it:
 *
 *   Anthropic  -> a content block of type "thinking" / "thinking_delta" on the stream
 *   Responses  -> an output item of type "reasoning"
 *
 * The failure mode is nasty because the request still succeeds: the client renders an answer with
 * no reasoning attached, and the usage block reports reasoning_tokens it was never shown.
 *
 * These read a LIVE router, so they ship as `npm run verify:wires` rather than the CI gate.
 */

const ROUTER = process.env.LOCAL_ROUTER_TEST_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.LOCAL_ROUTER_TEST_MODEL || 'zenmux-deepseek-v4.1-flash';
const PROMPT = 'A train leaves 14:37 at 83km/h, another 41 minutes later at 97km/h. When does it catch up? Show your reasoning.';

function reachable() {
  const probe = spawnSync(process.execPath, ['-e', `
    fetch('${ROUTER}/api/version').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  `], { timeout: 5000 });
  return probe.status === 0;
}

test('Claude wire returns reasoning as an Anthropic thinking block', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const res = await fetch(`${ROUTER}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'local-router',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: PROMPT }]
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));

  const blocks = body.content || [];
  assert.equal(body.type, 'message');
  const thinking = blocks.find((b) => b.type === 'thinking');
  assert.ok(thinking, `a Claude client renders reasoning only from a thinking block: ${JSON.stringify(blocks).slice(0, 300)}`);
  assert.ok(String(thinking.thinking || '').length > 0, 'the thinking block must carry the reasoning text');
  // The answer must stay separate; folding reasoning into text would show scratchwork as the reply.
  assert.ok(blocks.some((b) => b.type === 'text'), 'the answer text block must still be present');
});

test('Claude wire streams thinking_delta before text', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const res = await fetch(`${ROUTER}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'local-router',
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1500,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      messages: [{ role: 'user', content: PROMPT }]
    })
  });
  assert.equal(res.status, 200);
  const text = await res.text();

  const deltas = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const ev = JSON.parse(line.slice(6));
      if (ev.type === 'content_block_delta') deltas.push(ev.delta?.type);
    } catch { /* partial frame */ }
  }
  assert.ok(deltas.length > 0, 'no content_block_delta events in the stream');
  assert.ok(deltas.includes('thinking_delta'),
    `the stream must carry thinking_delta; saw only ${[...new Set(deltas)]}`);
  // Anthropic orders blocks: reasoning must begin before the answer does.
  assert.equal(deltas[0], 'thinking_delta',
    `thinking must open the stream, saw ${deltas[0]} first`);
});

test('Codex wire returns reasoning as a Responses reasoning item', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const res = await fetch(`${ROUTER}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local-router' },
    body: JSON.stringify({
      model: MODEL,
      input: PROMPT,
      max_output_tokens: 1500,
      reasoning: { effort: 'high' }
    })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.object, 'response');

  const output = body.output || [];
  const reasoning = output.find((item) => item.type === 'reasoning');
  assert.ok(reasoning, `a Responses client reads reasoning from its own output item: ${JSON.stringify(output.map((i) => i.type))}`);
  const summaryText = (reasoning.summary || []).map((s) => s.text || '').join('');
  assert.ok(summaryText.length > 0, 'the reasoning item must carry text in its summary');

  // The usage block already claimed reasoning tokens; the item is what makes that claim visible.
  const tokens = body.usage?.output_tokens_details?.reasoning_tokens || 0;
  if (tokens > 0) {
    assert.ok(summaryText.length > 0, 'billed reasoning tokens with no reasoning item is the bug this guards');
  }
});

test('every wire agrees the model is reasoning-capable', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const models = await (await fetch(`${ROUTER}/v1/models`)).json();
  const entry = (models.data || []).find((m) => m.id === MODEL);
  assert.ok(entry, `${MODEL} must be advertised on /v1/models`);
  assert.equal(entry.capabilities?.reasoning, true, 'OpenAI wire must say reasoning');

  const show = await (await fetch(`${ROUTER}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL })
  })).json();
  assert.ok((show.capabilities || []).includes('thinking'),
    `Ollama wire must say thinking: ${show.capabilities}`);
});
