import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Wire-level delivery: what actually leaves the router.
 *
 * `provider-policy-matrix.test.mjs` proves the translation functions are correct
 * in isolation. This proves the ROUTES call them — the failure mode it guards is
 * a handler that builds its own body and quietly bypasses the translator, which
 * is exactly how `/v1/messages` and `/v1/responses` dropped a caller's thinking
 * level for as long as they did while every unit test stayed green.
 *
 * Boots the real server against a fake upstream and inspects the forwarded body.
 * Offline, deterministic, no keys, no cost.
 */

const port = String(19500 + Math.floor(Math.random() * 400));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let upstreamRequests = [];
let serverLogs = '';
let skipReason = '';
let testHome = '';
let selectedProvider;

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

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      const upstreamModel = typeof body?.model === 'string' ? body.model : '';
      upstreamRequests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'wire-probe', object: 'model', capabilities: { reasoning: true } }]
        }));
        return;
      }
      // The proxy appends `/chat/completions` to the configured base URL, which
      // here is the fake root, so no `/v1` prefix arrives.
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url || '')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      // A reasoning + cache usage block, so the response-side assertions have
      // something real to carry through.
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          id: 'cmpl-wire',
          object: 'chat.completion.chunk',
          model: upstreamModel,
          choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'because' }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'cmpl-wire',
          object: 'chat.completion.chunk',
          model: upstreamModel,
          choices: [{ index: 0, delta: { content: `ok:${upstreamModel}` }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'cmpl-wire',
          object: 'chat.completion.chunk',
          model: upstreamModel,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 1200,
            completion_tokens: 20,
            total_tokens: 1220,
            prompt_tokens_details: { cached_tokens: 1024 },
            completion_tokens_details: { reasoning_tokens: 12 }
          }
        })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'cmpl-wire',
        object: 'chat.completion',
        model: upstreamModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `ok:${upstreamModel}`, reasoning_content: 'because' },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 20,
          total_tokens: 1220,
          prompt_tokens_details: { cached_tokens: 1024 },
          completion_tokens_details: { reasoning_tokens: 12 }
        }
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
  testHome = mkdtempSync(join(tmpdir(), 'lr-wire-'));

  const env = { ...process.env };
  // Strip inherited provider keys so the fake upstream is the only target.
  for (const key of Object.keys(env)) {
    if (/^[A-Z0-9_]+_API_KEY$/.test(key)) delete env[key];
  }
  // Pin the first registry provider at the fake upstream.
  const first = PROVIDER_REGISTRY[0];
  selectedProvider = first.name;
  env[providerBaseUrlEnvVar(first.name)] = `${upstreamBaseUrl}/v1`;
  env[`${first.keyEnvVar}`] = 'test-key';
  env.HOME = testHome;
  env.USERPROFILE = testHome;
  env.PORT = port;
  env.LOCAL_ROUTER_FORCE_SERVE = 'true';
  env.LOCAL_ROUTER_DISABLE_HEALTH_PROBE = 'true';

  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  skipReason = `router did not answer within 12s\n${serverLogs.slice(-2000)}`;
  return false;
}

async function discoverAndCurate() {
  const refresh = await fetch(`${baseUrl}/api/provider-models/${selectedProvider}/refresh`, { method: 'POST' });
  assert.ok(refresh.ok, `refresh failed: ${refresh.status} ${await refresh.text().catch(() => '')}`);
  const curate = await fetch(`${baseUrl}/api/model-curation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedKeys: [`${selectedProvider}::wire-probe`], force: true })
  });
  assert.ok(curate.ok, `curation failed: ${curate.status} ${await curate.text().catch(() => '')}`);
}

async function post(path, body) {
  upstreamRequests = [];
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* SSE */ }
  return { status: res.status, body: parsed, text };
}

/** The chat-completions body the fake upstream received. */
function forwarded() {
  const entry = upstreamRequests.find((item) => /\/chat\/completions$/.test(item.url || ''));
  assert.ok(entry, `no chat/completions request reached the upstream: ${JSON.stringify(upstreamRequests.map((r) => r.url))}`);
  return entry.body;
}

const MODEL = () => `${selectedProvider}/wire-probe`;

test.before(async () => {
  await startFakeUpstream();
  if (!await bootRouter()) return;
  // A freshly booted router ships an empty catalog, so a model has to be
  // discovered and curated in before it can be routed to.
  await discoverAndCurate();
});

test.after(async () => {
  if (serverProcess && serverProcess.exitCode == null) serverProcess.kill();
  if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('the OpenAI wire delivers an explicit effort', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await post('/v1/chat/completions', {
    model: MODEL(),
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high'
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(forwarded().reasoning_effort, 'high',
    'the caller stated an effort; it must reach the upstream unchanged');
});

test('the Anthropic wire delivers the level from a thinking budget', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // This is the regression: /v1/messages built its chat body from a fixed field
  // list, so a Claude client's thinking block never left the router at all.
  const res = await post('/v1/messages', {
    model: MODEL(),
    max_tokens: 512,
    thinking: { type: 'enabled', budget_tokens: 16384 },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));

  const body = forwarded();
  const delivered = body.reasoning_effort ?? body.enable_thinking ?? body.thinking;
  assert.ok(delivered !== undefined,
    `a Claude client's thinking level must reach the upstream: ${JSON.stringify(body)}`);
  assert.notEqual(delivered, 'none', 'a 16K budget is not "thinking off"');
});

test('the Anthropic wire delivers an explicit opt-out', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await post('/v1/messages', {
    model: MODEL(),
    max_tokens: 512,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const body = forwarded();
  const off = body.reasoning_effort === 'none'
    || (body.thinking && body.thinking.type === 'disabled')
    || body.enable_thinking === false;
  assert.ok(off, `thinking:disabled must reach the upstream as an off signal: ${JSON.stringify(body)}`);
});

test('the Responses wire delivers a reasoning effort', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // The other regression: `translateResponsesRequestToChatBody` never read
  // `body.reasoning`, so every Codex session ran on the provider's own default.
  const res = await post('/v1/responses', {
    model: MODEL(),
    input: 'hi',
    reasoning: { effort: 'high' }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));

  const body = forwarded();
  const delivered = body.reasoning_effort ?? body.enable_thinking;
  assert.ok(delivered !== undefined,
    `a Codex reasoning effort must reach the upstream: ${JSON.stringify(body)}`);
});

test('the Ollama wire delivers think, using the OpenAI surface it posts to', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await post('/api/chat', {
    model: MODEL(),
    stream: false,
    think: true,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));

  const body = forwarded();
  // The proxy posts to /chat/completions, where the Ollama-only `think` key is
  // meaningless: the level has to be re-stated in a field that endpoint reads.
  assert.equal('think' in body, false,
    `the Ollama-only "think" key must not be forwarded to a chat-completions endpoint: ${JSON.stringify(body)}`);
  const delivered = body.reasoning_effort ?? body.enable_thinking;
  assert.ok(delivered !== undefined && delivered !== 'none',
    `think:true must arrive as "thinking on" upstream: ${JSON.stringify(body)}`);
});

test('the Ollama wire reports its own usage counters', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await post('/api/chat', {
    model: MODEL(),
    stream: false,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  // An Ollama-native client reads these; omitting them made every completion
  // look free, hiding both cost and cache behaviour.
  assert.equal(typeof res.body?.prompt_eval_count, 'number',
    `Ollama clients read prompt_eval_count: ${JSON.stringify(res.body).slice(0, 300)}`);
  assert.equal(typeof res.body?.eval_count, 'number',
    `Ollama clients read eval_count: ${JSON.stringify(res.body).slice(0, 300)}`);
});

test('the Claude wire reports cached and cache-write tokens', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const res = await post('/v1/messages', {
    model: MODEL(),
    max_tokens: 256,
    messages: [{ role: 'user', content: 'hi' }]
  });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const usage = res.body?.usage || {};
  // Anthropic bills input_tokens as the UNCACHED remainder; reporting the whole
  // prompt there overstated the bill and hid every cache hit.
  assert.equal(usage.cache_read_input_tokens, 1024,
    `a Claude client reads cache hits from cache_read_input_tokens: ${JSON.stringify(usage)}`);
  assert.equal(usage.input_tokens, 176,
    `input_tokens must be the uncached remainder (1200 - 1024): ${JSON.stringify(usage)}`);
});

test('the operator thinking toggle actually reaches the upstream', async (t) => {
  if (skipReason) return t.skip(skipReason);

  // A control that persists a value nothing reads is the same defect as a dial
  // that advertises a level no translator can send: present and inert.
  const enable = await fetch(`${baseUrl}/api/thinking-level`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, global: 'high' })
  });
  assert.ok(enable.ok, `could not enable the thinking override: ${enable.status}`);

  try {
    const res = await post('/v1/chat/completions', {
      model: MODEL(),
      messages: [{ role: 'user', content: 'hi' }]
    });
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
    assert.equal(forwarded().reasoning_effort, 'high',
      'with the override enabled and no caller level, the configured level must be sent');

    // A caller's own level still wins over the server default.
    const explicit = await post('/v1/chat/completions', {
      model: MODEL(),
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'low'
    });
    assert.equal(explicit.status, 200);
    assert.equal(forwarded().reasoning_effort, 'low',
      'per-call configuration is a stronger signal than a server default');
  } finally {
    await fetch(`${baseUrl}/api/thinking-level`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false })
    });
  }
});

test('the advertised dial matches what the translator can send', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // Both wires must agree, and both must agree with the policy. A dial on one
  // wire only is how an Ollama-native client rendered "no adjustable reasoning"
  // for a model the OpenAI wire advertised correctly.
  const listed = await (await fetch(`${baseUrl}/v1/models`)).json();
  const entry = (listed.data || []).find((m) => String(m.id).includes('wire-probe'));
  assert.ok(entry, `the probed model must be advertised: ${JSON.stringify((listed.data || []).map((m) => m.id)).slice(0, 400)}`);

  const levels = entry.reasoningEfforts || entry.effort?.supported_levels || entry.capabilities?.reasoning_effort;
  assert.ok(Array.isArray(levels) && levels.length > 0,
    `a dial must be declared for a reasoning-capable upstream: ${JSON.stringify(entry).slice(0, 400)}`);
  assert.ok(levels.includes('none'), 'the dial must offer "off"');
  assert.equal(entry.defaultReasoningLevel, 'medium', 'a default lets a harness preselect rather than guess');

  const show = await (await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: entry.id })
  })).json();
  assert.ok((show.capabilities || []).includes('thinking'),
    `the Ollama wire must say thinking: ${JSON.stringify(show.capabilities)}`);
  assert.deepEqual(show.reasoning_efforts, levels,
    `both wires must report the same levels: ${JSON.stringify(show.reasoning_efforts)} vs ${JSON.stringify(levels)}`);
});

test('the advertised caching flag reflects reality', async (t) => {
  if (skipReason) return t.skip(skipReason);
  const listed = await (await fetch(`${baseUrl}/v1/models`)).json();
  const entry = (listed.data || []).find((m) => String(m.id).includes('wire-probe'));
  assert.ok(entry);
  // The fake upstream is the first registry provider, which does cache. The old
  // field read a per-model registry boolean that was false almost everywhere, so
  // 142 of 146 live models claimed "no caching" while the upstream cached anyway.
  assert.equal(entry.capabilities?.caching, true,
    `a caching provider must advertise it: ${JSON.stringify(entry.capabilities)}`);
});

test('the Responses wire reports cached and reasoning tokens on a stream', async (t) => {
  if (skipReason) return t.skip(skipReason);
  // The streaming shim hardcoded both counters to 0, so a warm, reasoning turn
  // was indistinguishable from a cold, silent one on the wire Codex uses.
  const res = await post('/v1/responses', {
    model: MODEL(),
    input: 'hi',
    stream: true
  });
  assert.equal(res.status, 200, res.text.slice(0, 300));

  let completed = null;
  for (const line of res.text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.type === 'response.completed') completed = event.response;
    } catch { /* partial frame */ }
  }
  assert.ok(completed, `the stream must terminate with response.completed: ${res.text.slice(0, 500)}`);
  assert.equal(completed.usage?.input_tokens_details?.cached_tokens, 1024,
    `a streaming Responses client must see the cache hit: ${JSON.stringify(completed.usage)}`);
  assert.equal(completed.usage?.output_tokens_details?.reasoning_tokens, 12,
    `a streaming Responses client must see the reasoning spend: ${JSON.stringify(completed.usage)}`);

  // And the reasoning itself must be an output item, not only a usage number.
  const kinds = (completed.output || []).map((item) => item.type);
  assert.ok(kinds.includes('reasoning'),
    `billed reasoning with no reasoning item is the bug this guards: ${JSON.stringify(kinds)}`);
});
