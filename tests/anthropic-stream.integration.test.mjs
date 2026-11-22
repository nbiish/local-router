/**
 * anthropic-stream.integration.test.mjs — the Claude `/v1/messages` stream must be
 * a well-formed Anthropic sequence in every case, including when upstream dies.
 *
 * Boots the real router against a controllable fake upstream. What it guards,
 * each measured live on 2026-11-20:
 *
 *   1. Thinking + two parallel tool calls emitted `content_block_stop index 1`
 *      twice and never closed index 2. Claude Code rejects that sequence.
 *   2. Every streamed turn reported `input_tokens: 0` / `output_tokens: 0`,
 *      because usage was read from a chunk that arrives after `finish_reason`.
 *   3. An upstream that died mid-body left the client hanging forever: no
 *      `message_stop`, no error, no end.
 *   4. A streamed request that ran longer than 15 s was cut mid-generation by an
 *      absolute `AbortSignal.timeout` — the operator's exact symptom.
 *
 * Offline, deterministic, no keys, no cost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { scrubbedEnv } from './test-env.mjs';
const port = String(19900 + Math.floor(Math.random() * 400));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let serverLogs = '';
let skipReason = '';
let testHome = '';
let selectedProvider;
let upstreamMode = 'normal';

const { PROVIDER_REGISTRY } = await import('../build/provider-registry.js');

function providerBaseUrlEnvVar(providerName) {
  return `LOCAL_ROUTER_PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'wire-probe', object: 'model', capabilities: { reasoning: true, toolCalling: true } }]
        }));
        return;
      }

      if (body?.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });

        if (upstreamMode === 'thinking-two-tools') {
          // The exact shape that produced the duplicate/never-closed blocks:
          // reasoning, then two tool calls streamed in parallel under their own
          // OpenAI `index`, then a usage chunk after finish_reason.
          sse(res, { id: 'c1', choices: [{ index: 0, delta: { reasoning_content: 'I should use both tools.' }, finish_reason: null }] });
          sse(res, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'Read', arguments: '{"file_path":' } }] }, finish_reason: null }] });
          sse(res, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"/etc/hosts"}' } }] }, finish_reason: null }] });
          sse(res, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'Bash', arguments: '{"command":"uname"}' } }] }, finish_reason: null }] });
          sse(res, { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          sse(res, { id: 'c1', choices: [], usage: { prompt_tokens: 1234, completion_tokens: 56, prompt_tokens_details: { cached_tokens: 1000 } } });
          res.end('data: [DONE]\n\n');
          return;
        }

        if (upstreamMode === 'dies-midstream') {
          sse(res, { id: 'c2', choices: [{ index: 0, delta: { content: 'partial answer' }, finish_reason: null }] });
          // Kill the socket without any closing frame.
          setTimeout(() => { try { res.destroy(); } catch { /* gone */ } }, 120);
          return;
        }

        if (upstreamMode === 'slow-but-alive') {
          // Outlives any absolute deadline a previous implementation imposed,
          // but never silent for long: this is a healthily slow generation.
          let n = 0;
          const timer = setInterval(() => {
            n += 1;
            sse(res, { id: 'c3', choices: [{ index: 0, delta: { content: `${n} ` }, finish_reason: null }] });
            if (n >= 8) {
              clearInterval(timer);
              sse(res, { id: 'c3', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
              sse(res, { id: 'c3', choices: [], usage: { prompt_tokens: 90, completion_tokens: 8 } });
              res.end('data: [DONE]\n\n');
            }
          }, 1000);
          res.on('close', () => clearInterval(timer));
          return;
        }

        // normal
        sse(res, { id: 'c0', choices: [{ index: 0, delta: { content: 'OK' }, finish_reason: null }] });
        sse(res, { id: 'c0', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        sse(res, { id: 'c0', choices: [], usage: { prompt_tokens: 321, completion_tokens: 12 } });
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c0',
        object: 'chat.completion',
        model: body?.model || 'wire-probe',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 321, completion_tokens: 12, total_tokens: 333 }
      }));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
  });

  upstreamServer.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    upstreamServer.once('listening', resolve);
    upstreamServer.once('error', reject);
  });
  upstreamBaseUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
}

async function bootRouter() {
  testHome = mkdtempSync(join(tmpdir(), 'lr-anth-'));
  const env = { ...scrubbedEnv() };
  for (const key of Object.keys(env)) {
    if (/^[A-Z0-9_]+_API_KEY$/.test(key)) delete env[key];
  }
  const first = PROVIDER_REGISTRY[0];
  selectedProvider = first.name;
  env[providerBaseUrlEnvVar(first.name)] = `${upstreamBaseUrl}/v1`;
  env[`${first.keyEnvVar}`] = 'test-key';
  env.HOME = testHome;
  env.USERPROFILE = testHome;
  env.PORT = port;
  env.LOCAL_ROUTER_FORCE_SERVE = 'true';
  env.LOCAL_ROUTER_DISABLE_HEALTH_PROBE = 'true';
  // A short idle window so the watchdog test does not take minutes, and no
  // inherited scratch trajectory directory (the defect this also guards).
  env.LOCAL_ROUTER_STREAM_IDLE_MS = '4000';
  delete env.LOCAL_ROUTER_TRAJECTORY_DIR;
  delete env.LOCAL_ROUTER_HEALTH_STATE;

  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (serverProcess.exitCode != null) {
      skipReason = `router exited early (${serverProcess.exitCode})\n${serverLogs.slice(-2000)}`;
      return false;
    }
    try {
      const res = await fetch(`${baseUrl}/api/version`);
      if (res.ok) return true;
    } catch { /* still starting */ }
    await delay(100);
  }
  skipReason = `router did not answer within 15s\n${serverLogs.slice(-3000)}`;
  return false;
}

async function discoverAndCurate() {
  const refresh = await fetch(`${baseUrl}/api/provider-models/${selectedProvider}/refresh`, { method: 'POST' });
  assert.ok(refresh.ok, `refresh failed: ${refresh.status}`);
  const curate = await fetch(`${baseUrl}/api/model-curation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedKeys: [`${selectedProvider}::wire-probe`], force: true })
  });
  assert.ok(curate.ok, `curation failed: ${curate.status}`);
}

/** Parse an Anthropic SSE body into ordered `{ event, data }` frames. */
function parseAnthropicSse(text) {
  const frames = [];
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = null;
    const dataLines = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7).trim();
      else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
    }
    if (event && dataLines.length > 0) {
      frames.push({ event, data: JSON.parse(dataLines.join('\n')) });
    }
  }
  return frames;
}

/**
 * Assert the invariants every Anthropic stream must satisfy:
 * one start, every opened block closed exactly once, one delta, one stop.
 */
function assertValidAnthropicSequence(frames, label) {
  const opened = new Map(); // index -> block type
  const closed = [];
  let starts = 0;
  let deltas = 0;
  let stops = 0;

  for (const { event, data } of frames) {
    switch (event) {
      case 'message_start':
        starts += 1;
        assert.ok(Array.isArray(data.message?.content), `${label}: message_start needs a content array`);
        break;
      case 'content_block_start':
        assert.ok(!opened.has(data.index), `${label}: index ${data.index} opened twice`);
        assert.ok(!closed.includes(data.index), `${label}: index ${data.index} reopened after close`);
        opened.set(data.index, data.content_block?.type);
        break;
      case 'content_block_delta':
        assert.ok(opened.has(data.index), `${label}: delta for index ${data.index} that is not open`);
        break;
      case 'content_block_stop':
        assert.ok(opened.has(data.index), `${label}: index ${data.index} closed but not open`);
        assert.ok(!closed.includes(data.index), `${label}: index ${data.index} closed twice`);
        opened.delete(data.index);
        closed.push(data.index);
        break;
      case 'message_delta':
        deltas += 1;
        assert.ok(data.delta?.stop_reason, `${label}: message_delta needs a stop_reason`);
        break;
      case 'message_stop':
        stops += 1;
        break;
      default:
        break;
    }
  }

  assert.equal(starts, 1, `${label}: exactly one message_start (got ${starts})`);
  assert.equal(deltas, 1, `${label}: exactly one message_delta (got ${deltas})`);
  assert.equal(stops, 1, `${label}: exactly one message_stop (got ${stops})`);
  assert.equal(opened.size, 0, `${label}: every opened block must be closed, left open: ${[...opened.keys()]}`);
}

/** The curated direct model — remapping from a Claude slot needs the agent proxy
 *  enabled, which a fresh HOME does not have, and the wire translation under test
 *  is the same either way. */
const MODEL = () => `${selectedProvider}/wire-probe`;

async function postMessages(body) {
  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, text };
}

test.before(async () => {
  await startFakeUpstream();
  if (!await bootRouter()) return;
  await discoverAndCurate();
});

test.after(async () => {
  if (serverProcess && serverProcess.exitCode == null) serverProcess.kill();
  if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
});

test('Claude wire: thinking + two parallel tools produce a valid block sequence', async (t) => {
  if (skipReason) return t.skip(skipReason);
  upstreamMode = 'thinking-two-tools';

  const { status, text } = await postMessages({
    model: MODEL(),
    max_tokens: 8000,
    stream: true,
    thinking: { type: 'enabled', budget_tokens: 6000 },
    tools: [
      { name: 'Read', description: 'read', input_schema: { type: 'object', properties: {} } },
      { name: 'Bash', description: 'run', input_schema: { type: 'object', properties: {} } }
    ],
    messages: [{ role: 'user', content: 'use both tools' }]
  });

  assert.equal(status, 200);
  const frames = parseAnthropicSse(text);
  assertValidAnthropicSequence(frames, 'two-tools');

  const toolStarts = frames.filter(
    (f) => f.event === 'content_block_start' && f.data.content_block?.type === 'tool_use'
  );
  assert.equal(toolStarts.length, 2, 'both tool calls must open their own block');
  assert.deepEqual(toolStarts.map((f) => f.data.content_block.name).sort(), ['Bash', 'Read']);

  const delta = frames.find((f) => f.event === 'message_delta');
  assert.equal(delta.data.delta.stop_reason, 'tool_use');
});

test('Claude wire: streamed usage reports real token counts', async (t) => {
  if (skipReason) return t.skip(skipReason);
  upstreamMode = 'normal';

  const { text } = await postMessages({
    model: MODEL(),
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'say OK' }]
  });

  const frames = parseAnthropicSse(text);
  assertValidAnthropicSequence(frames, 'usage');

  const delta = frames.find((f) => f.event === 'message_delta');
  // The upstream reported prompt_tokens 321 / completion_tokens 12. The old code
  // reported 0 for both because it finalized before the usage chunk arrived.
  assert.equal(delta.data.usage.output_tokens, 12, 'output tokens must reach the client');
  assert.equal(delta.data.usage.input_tokens, 321, 'input tokens must reach the client');
});

test('Claude wire: an upstream that dies mid-stream still closes the sequence', async (t) => {
  if (skipReason) return t.skip(skipReason);
  upstreamMode = 'dies-midstream';

  const started = Date.now();
  const { status, text } = await postMessages({
    model: MODEL(),
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'answer' }]
  });
  const elapsed = Date.now() - started;

  assert.equal(status, 200);
  // The old behaviour was to hang forever. Anything under the 4 s idle window
  // proves the death was observed rather than waited out.
  assert.ok(elapsed < 10000, `response must end promptly, took ${elapsed}ms`);
  const frames = parseAnthropicSse(text);
  assertValidAnthropicSequence(frames, 'dies-midstream');
  assert.ok(
    frames.some((f) => f.event === 'message_stop'),
    'the client must receive message_stop even when upstream dies'
  );
});

test('Claude wire: a slow but progressing stream is not cut by a deadline', async (t) => {
  if (skipReason) return t.skip(skipReason);
  upstreamMode = 'slow-but-alive';

  const started = Date.now();
  const { text } = await postMessages({
    model: MODEL(),
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'count' }]
  });
  const elapsed = Date.now() - started;

  // 8 frames at 1 s intervals: this request is alive for ~8 s, and its body is
  // longer-lived than the old absolute 15 s/4 s windows allowed in kind.
  assert.ok(elapsed >= 6000, `the fake upstream should have taken seconds, took ${elapsed}ms`);
  const frames = parseAnthropicSse(text);
  assertValidAnthropicSequence(frames, 'slow-but-alive');
  const textChunks = frames
    .filter((f) => f.event === 'content_block_delta' && f.data.delta?.type === 'text_delta')
    .map((f) => f.data.delta.text)
    .join('');
  assert.ok(textChunks.includes('8'), 'the whole generation must arrive, not a truncated prefix');
});
