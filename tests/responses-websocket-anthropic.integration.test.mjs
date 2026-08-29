import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';

const port = String(19000 + Math.floor(Math.random() * 1000));
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

function firstProviderSummary() {
  const first = PROVIDER_REGISTRY[0];
  if (!first) throw new Error('Expected at least one provider in the registry');
  return { name: first.name, keyEnvVar: first.keyEnvVar };
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
        }]
      }));
    } catch (err) {
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstreamServer.address().port;
  upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
}

async function waitForServerReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Server exited before becoming ready.\nLogs:\n${serverLogs}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until server is ready.
    }
    await delay(100);
  }

  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

async function startProxyProcess() {
  const pEnv = {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    PORT: port,
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    [`LOCALROUTER_${selectedProvider.keyEnvVar}`]: 'integration-test-provider-key',
    [providerBaseUrlEnvVar(selectedProvider.name)]: upstreamBaseUrl
  };

  serverProcess = spawn('node', ['build/index.js'], { env: pEnv });
  serverProcess.stdout.on('data', (data) => {
    serverLogs += data.toString();
  });
  serverProcess.stderr.on('data', (data) => {
    serverLogs += data.toString();
  });

  await waitForServerReady();
}

async function stopProxyProcess() {
  if (serverProcess) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
}

test.before(async () => {
  selectedProvider = firstProviderSummary();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-test-ws-'));

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

test('Responses WebSocket server upgrade and streaming', async (t) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/responses`);

  const events = [];
  ws.on('message', (data) => {
    events.push(JSON.parse(data.toString()));
  });

  await once(ws, 'open');

  ws.send(JSON.stringify({
    type: 'response.create',
    response: {
      model: `${selectedProvider.name}/deepseek-v4-pro`,
      input: [
        { role: 'user', content: 'hello' }
      ]
    }
  }));

  await delay(1500);
  ws.close();

  assert.ok(events.length > 0, 'Expected to receive WebSocket events');
  assert.equal(events[0]?.type, 'response.created');
  assert.equal(events[1]?.type, 'response.output_item.added');
  
  const textDeltas = events.filter((e) => e.type === 'response.output_text.delta');
  assert.ok(textDeltas.length > 0, 'Expected text delta events');
  assert.ok(textDeltas[0].delta.includes('stream-ok:'));

  const completed = events.find((e) => e.type === 'response.completed');
  assert.ok(completed, 'Expected response.completed event');
});

test('Anthropic Messages API non-streaming translation', async (t) => {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `${selectedProvider.name}/deepseek-v4-pro`,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      stream: false
    })
  });

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.type, 'message');
  assert.equal(data.role, 'assistant');
  assert.equal(data.content[0]?.type, 'text');
  assert.ok(data.content[0]?.text.includes('ok:'));
});

test('Anthropic Messages API streaming translation', async (t) => {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `${selectedProvider.name}/deepseek-v4-pro`,
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      stream: true
    })
  });

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(text.includes('event: message_start'));
  assert.ok(text.includes('event: content_block_start'));
  assert.ok(text.includes('event: content_block_delta'));
  assert.ok(text.includes('event: message_stop'));
});
