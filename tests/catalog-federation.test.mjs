import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Federated hide-toggles (2026-11-12, plan T4): the curated serve-list travels
// in router-settings.json beside the chain — a toggle write must preserve the
// chain (the 2026-11-10 bulk-write hazard) — and refreshed discoveries land
// UNCHECKED (plan §4.2): visible in the catalog view, invisible to tools.

const port = String(19200 + Math.floor(Math.random() * 400));
const baseUrl = `http://127.0.0.1:${port}`;
const knownModelId = 'nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4';
const novelModelId = 'nvidia/Brand-New-Model-9000';

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
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
    if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: knownModelId, object: 'model' },
          { id: novelModelId, object: 'model' }
        ]
      }));
      return;
    }
    if (req.method === 'POST' && (req.url === '/chat/completions' || req.url === '/v1/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-fed',
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

function readRouterSettings() {
  return JSON.parse(readFileSync(join(testHome, '.config', 'local-router', 'router-settings.json'), 'utf8'));
}

test.before(async () => {
  await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-federation-test-'));
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_PROVIDER_FASTINO_BASE_URL: upstreamBaseUrl,
      LOCALROUTER_FASTINO_API_KEY: 'test-key',
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

test('a curation toggle federates into router-settings.json and preserves the chain', async () => {
  // The chain goes in FIRST: a toggle write must never clobber it.
  const route = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'federation-chain',
      modelsText: 'fastino-nvidia-nemotron-3.5-super-vl-120b-a12b-nvfp4\nfastino-nemotron-3.5-lightning-finance'
    })
  });
  assert.equal(route.response.status, 200, JSON.stringify(route.body));

  const toggle = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      selectedKeys: [`fastino::${knownModelId}`],
      force: true
    })
  });
  assert.equal(toggle.response.status, 200, JSON.stringify(toggle.body));

  const settings = readRouterSettings();
  assert.ok(settings.catalogSelection, 'catalogSelection block is federated');
  assert.deepEqual(settings.catalogSelection.curatedKeys, [`fastino::${knownModelId}`]);
  assert.ok(Array.isArray(settings.routes) && settings.routes.some((r) => r.id === 'federation-chain'),
    'the chain survives the curation write (bulk-write hazard regression)');
  assert.ok(settings.fallbackModelsText !== undefined || settings.routes !== undefined, 'chain fields intact');
});

test('a refreshed discovery lands hidden: catalog view yes, tools no', async () => {
  const refresh = await requestJson('/api/provider-models/fastino/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  assert.equal(refresh.response.status, 200, JSON.stringify(refresh.body));

  const section = await requestJson('/api/provider-models/fastino');
  assert.match(JSON.stringify(section.body), /Brand-New-Model-9000/, 'discovery is visible in the catalog view');

  const served = await requestJson('/v1/models');
  assert.doesNotMatch(JSON.stringify(served.body), /brand-new-model-9000/i, 'discovery is NOT served to tools');
  assert.match(JSON.stringify(served.body), /nemotron-3\.5-super-vl/, 'a checked model is served');

  const settings = readRouterSettings();
  assert.ok(
    !(settings.catalogSelection?.curatedKeys || []).some((key) => key.includes('Brand-New-Model-9000')),
    'the federated selection is not auto-extended by discovery'
  );
});
