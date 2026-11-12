import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// pioneer → fastino (2026-11-12): legacy pioneer-* presented ids must resolve
// to the fastino record with the right wire model, and a key the operator
// saved under PIONEER_API_KEY must keep working after the rename.

const port = String(18700 + Math.floor(Math.random() * 400));
const baseUrl = `http://127.0.0.1:${port}`;
const upstreamModelId = 'nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16';

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let upstreamRequests = [];
let serverLogs = '';
let testHome = '';

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    const body = await readRequestBody(req);
    upstreamRequests.push({ method: req.method, url: req.url, body });
    if (req.method === 'POST' && (req.url === '/chat/completions' || req.url === '/v1/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fastino',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: `ok:${body.model}` }, finish_reason: 'stop' }]
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  upstreamBaseUrl = `http://127.0.0.1:${upstreamServer.address().port}/v1`;
}

async function waitForServerReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess?.exitCode !== null) throw new Error(`Server exited early.\nLogs:\n${serverLogs}`);
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
  }
  return { response, body };
}

test.before(async () => {
  await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-fastino-test-'));
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_PROVIDER_FASTINO_BASE_URL: upstreamBaseUrl,
      // Legacy name only: proves the pioneer → fastino key migration.
      LOCALROUTER_PIONEER_API_KEY: 'test-key-from-pioneer-save',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });
  await waitForServerReady();
});

test.after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => undefined);
  }
  if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('legacy PIONEER_API_KEY enrols the fastino provider', async () => {
  const configs = await requestJson('/api/provider-configs');
  assert.equal(configs.response.status, 200);
  const fastino = configs.body.data.find((entry) => entry.name === 'fastino');
  assert.ok(fastino, 'fastino appears in provider-configs');
  assert.equal(fastino.configured, true, 'legacy-named key counts as configured');
  const pioneer = configs.body.data.find((entry) => entry.name === 'pioneer');
  assert.ok(!pioneer, 'the pioneer provider name is retired');
});

test('legacy pioneer-* presented id resolves to the fastino wire model', async () => {
  upstreamRequests = [];
  const chat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'pioneer-nvidia-nemotron-3.5-lightning-30b-a3b-bf16',
      messages: [{ role: 'user', content: 'ping' }]
    })
  });
  assert.equal(chat.response.status, 200, JSON.stringify(chat.body));
  assert.match(chat.body?.choices?.[0]?.message?.content || '', /ok:nvidia\/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16/);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].body.model, upstreamModelId, 'wire model is the upstream id, not the alias');
});

test('the current fastino-* presented id resolves the same record', async () => {
  upstreamRequests = [];
  const chat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fastino-nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4',
      messages: [{ role: 'user', content: 'ping' }]
    })
  });
  assert.equal(chat.response.status, 200, JSON.stringify(chat.body));
  assert.equal(upstreamRequests[0].body.model, 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4');
});

test('the provider API accepts the legacy pioneer slug', async () => {
  const section = await requestJson('/api/provider-models/pioneer');
  assert.equal(section.response.status, 200, JSON.stringify(section.body));
  const ids = (section.body.data || section.body.models || []).map((m) => m.id || m.model);
  assert.ok(ids.length > 0, 'the pioneer slug resolves to the fastino model section');
});
