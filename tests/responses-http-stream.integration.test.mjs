import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(19100 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let upstreamRequests = [];
let serverLogs = '';
let testHome = '';
let selectedProvider;

function firstProviderSummary() {
  const content = readFileSync('providers.txt', 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('# │')) continue;

    const columns = line
      .replace(/^#\s*/, '')
      .split('│')
      .map((part) => part.trim())
      .filter(Boolean);

    if (columns.length !== 4) continue;

    const [name, endpoint, keyEnvVar] = columns;
    if (!name || name.toLowerCase() === 'provider') continue;
    if (!/^https?:\/\//.test(endpoint)) continue;
    if (!/^[A-Z0-9_]+_API_KEY$/.test(keyEnvVar)) continue;

    return { name, keyEnvVar };
  }

  throw new Error('Expected at least one provider summary in providers.txt');
}

function providerBaseUrlEnvVar(providerName) {
  return `LOCAL_ROUTER_PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

function parseSseEvents(raw) {
  const events = [];
  const blocks = raw.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let eventType = '';
    let data = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          data = line.slice(6);
        }
      }
    }
    if (eventType || data) {
      events.push({ event: eventType, data });
    }
  }
  return events;
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      const upstreamModel = typeof body?.model === 'string' ? body.model : '';

      upstreamRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body
      });

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: {"choices":[{"delta":{"content":"stream-ok:${upstreamModel}"},"finish_reason":null}]}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: `ok:${upstreamModel}`
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      }));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstreamServer.address().port;
  upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
}

async function startProxyProcess() {
  const pEnv = {
    ...process.env,
    HOME: testHome,
    PORT: port,
    [selectedProvider.keyEnvVar]: 'integration-test-provider-key',
    [providerBaseUrlEnvVar(selectedProvider.name)]: upstreamBaseUrl
  };

  serverProcess = spawn('node', ['build/index.js'], { env: pEnv });
  serverProcess.stdout.on('data', (data) => {
    serverLogs += data.toString();
  });
  serverProcess.stderr.on('data', (data) => {
    serverLogs += data.toString();
  });

  await delay(1200);
}

async function stopProxyProcess() {
  if (serverProcess) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
}

test.before(async () => {
  selectedProvider = firstProviderSummary();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-test-resp-http-'));

  await startFakeUpstream();
  await startProxyProcess();
});

test.after(async () => {
  await stopProxyProcess();
  if (upstreamServer) {
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

const modelId = () => `${selectedProvider.name}/deepseek-v4-pro`;

test('POST /v1/responses non-streaming returns Responses envelope', async () => {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId(),
      input: [{ role: 'user', content: 'hello' }],
      stream: false
    })
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.object, 'response');
  assert.ok(Array.isArray(data.output));
  assert.ok(data.output.some((item) => item.type === 'message'));
});

test('POST /v1/responses streaming emits Responses SSE events', async () => {
  upstreamRequests = [];

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId(),
      input: [{ role: 'user', content: 'hello' }],
      stream: true
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  const raw = await response.text();
  assert.equal(raw.includes('Streaming Responses API is not yet implemented'), false);

  const events = parseSseEvents(raw);
  assert.ok(events.some((e) => e.event === 'response.created' || e.data?.type === 'response.created'));
  assert.ok(events.some((e) => e.event === 'response.output_text.delta' || e.data?.type === 'response.output_text.delta'));
  assert.ok(events.some((e) => e.event === 'response.completed' || e.data?.type === 'response.completed'));

  const delta = events.find((e) => e.data?.type === 'response.output_text.delta');
  assert.ok(delta?.data?.delta?.includes('stream-ok:'), 'Expected upstream stream content in delta');

  const forwarded = upstreamRequests.at(-1)?.body;
  assert.equal(forwarded?.stream, true);
});

test('PUT /api/system-prompt rejects thinkingLevel (use /api/thinking-level)', async () => {
  const response = await fetch(`${baseUrl}/api/system-prompt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thinkingLevel: 'low' })
  });
  assert.equal(response.status, 400);
  const data = await response.json();
  assert.ok(String(data.error || '').includes('/api/thinking-level'));
});

test('thinking level applies when system prompt is disabled', async () => {
  await fetch(`${baseUrl}/api/system-prompt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });

  await fetch(`${baseUrl}/api/thinking-level`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ global: 'low' })
  });

  upstreamRequests = [];
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId(),
      stream: false,
      messages: [{ role: 'user', content: 'thinking test' }]
    })
  });
  assert.equal(response.status, 200);

  const forwarded = upstreamRequests.at(-1)?.body;
  assert.equal(forwarded?.enable_thinking, true);

  await fetch(`${baseUrl}/api/thinking-level`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ global: 'none' })
  });
});
