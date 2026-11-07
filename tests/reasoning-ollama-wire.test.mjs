import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

/**
 * The OLLAMA wire contract for reasoning.
 *
 * A client that reaches the router as an Ollama endpoint (StarNet's `nativeOllama` profile is one)
 * never reads /v1/models. It decides "can I adjust reasoning?" from /api/show's `capabilities`
 * array, and it reads the reasoning text from `message.thinking`. All three of those were missing,
 * so a reasoning model showed "This model has no adjustable reasoning" even though the OpenAI wire
 * advertised the dial correctly.
 *
 * These read a LIVE router, so they ship as `npm run verify:dials` rather than the CI gate, and
 * skip when nothing answers.
 */

const ROUTER = process.env.LOCAL_ROUTER_TEST_URL || 'http://127.0.0.1:11434';
const MODEL = process.env.LOCAL_ROUTER_TEST_MODEL || 'zenmux-deepseek-v4.1-flash';

function reachable() {
  const probe = spawnSync(process.execPath, ['-e', `
    fetch('${ROUTER}/api/version').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
  `], { timeout: 5000 });
  return probe.status === 0;
}

async function show(model) {
  const res = await fetch(`${ROUTER}/api/show`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model })
  });
  assert.ok(res.ok, `/api/show ${model} -> ${res.status}`);
  return res.json();
}

async function chat(body) {
  const res = await fetch(`${ROUTER}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test('/api/show advertises the thinking capability for a reasoning model', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const s = await show(MODEL);
  assert.ok(Array.isArray(s.capabilities), `/api/show must return a capabilities array: ${JSON.stringify(s).slice(0, 200)}`);
  // This single string is what the Ollama-wire client gates its whole reasoning UI on.
  assert.ok(s.capabilities.includes('thinking'),
    `"thinking" must be present or the client shows "no adjustable reasoning": ${s.capabilities}`);
});

test('/api/show does not claim thinking for the embedding route', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const s = await show('local-router/fallback-embedding');
  const caps = s.capabilities || [];
  assert.ok(!caps.includes('thinking'),
    `an embeddings route must not advertise a reasoning capability: ${caps}`);
});

test('/api/chat returns message.thinking and honours think:false', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const prompt = 'A train leaves 14:37 at 83km/h, another 41 min later at 97km/h. When does it catch up? Show reasoning.';

  const on = await chat({ model: MODEL, stream: false, think: true, messages: [{ role: 'user', content: prompt }] });
  assert.equal(on.status, 200, JSON.stringify(on.body).slice(0, 300));
  const onThinking = String(on.body?.message?.thinking || '');
  assert.ok(onThinking.length > 0,
    `think:true must return the reasoning under message.thinking, which is the key this wire reads: ${JSON.stringify(on.body).slice(0, 300)}`);

  const off = await chat({ model: MODEL, stream: false, think: false, messages: [{ role: 'user', content: prompt }] });
  assert.equal(off.status, 200, JSON.stringify(off.body).slice(0, 300));
  const offThinking = String(off.body?.message?.thinking || '');
  // `think:false` used to be translated to enable_thinking:false, which ZenMux ignores — so "off"
  // silently still reasoned. Asserting emptiness is what makes the toggle real.
  assert.equal(offThinking.length, 0,
    `think:false must actually disable reasoning: ${offThinking.length} chars leaked`);
});

test('/api/chat stream carries thinking on the delta', async (t) => {
  if (!reachable()) return t.skip(`no router at ${ROUTER}`);

  const res = await fetch(`${ROUTER}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      think: true,
      messages: [{ role: 'user', content: 'A train leaves 14:37 at 83km/h, another 41 min later at 97km/h. When does it catch up?' }]
    })
  });
  assert.equal(res.status, 200);

  const text = await res.text();
  let chunks = 0;
  let withThinking = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    chunks += 1;
    if (obj?.message?.thinking) withThinking += 1;
  }
  assert.ok(chunks > 0, 'the stream produced no NDJSON chunks');
  assert.ok(withThinking > 0,
    `streaming must expose delta thinking (${withThinking}/${chunks} chunks); it used to be dropped entirely`);
});
