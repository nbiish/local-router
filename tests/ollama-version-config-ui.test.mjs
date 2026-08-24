import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(27000 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let versionUpstream;
let versionUpstreamHost = '';
let testHome = '';
let serverLogs = '';
let skipReason = '';

async function startFakeVersionUpstream() {
  versionUpstream = createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ version: '7.8.9' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
  await new Promise((resolve, reject) => {
    versionUpstream.once('error', reject);
    versionUpstream.listen(0, '127.0.0.1', resolve);
  });
  const address = versionUpstream.address();
  versionUpstreamHost = `127.0.0.1:${address.port}`;
}

function stripForeignProviderKeys(env) {
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/^[A-Z0-9_]+_API_KEY$/.test(key)) delete cleaned[key];
  }
  return cleaned;
}

async function waitForServerReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Server exited before becoming ready.\nLogs:\n${serverLogs}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) return;
    } catch {
      // poll
    }
    await delay(100);
  }
  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

test.before(async () => {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    skipReason = 'Sandbox network is disabled; run integration tests in a normal local shell.';
    return;
  }
  await startFakeVersionUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-version-ui-test-'));
  const proxyEnv = stripForeignProviderKeys(process.env);
  delete proxyEnv.OLLAMA_VERSION;
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...proxyEnv,
      HOME: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_DEV: 'true',
      OLLAMA_BACKEND_HOST: versionUpstreamHost
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });
  await waitForServerReady();
});

test.after(async () => {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill('SIGTERM');
  if (versionUpstream) versionUpstream.close();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('GET /api/version mirrors the backend ollama version', { skip: skipReason || undefined }, async () => {
  const response = await fetch(`${baseUrl}/api/version`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.version, '7.8.9');
});

test('HEAD /api/version stays a 200 probe', { skip: skipReason || undefined }, async () => {
  const response = await fetch(`${baseUrl}/api/version`, { method: 'HEAD' });
  assert.equal(response.status, 200);
});

test('GET /api/fallback-models returns per-route chainDetails', { skip: skipReason || undefined }, async () => {
  const response = await fetch(`${baseUrl}/api/fallback-models`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.data) && body.data.length > 0, 'expected fallback routes');
  const route = body.data.find((entry) => entry.routeId === 'fallback-models') || body.data[0];
  assert.ok(Array.isArray(route.chainDetails), 'chainDetails array present');
  assert.equal(route.chainDetails.length, route.models.length, 'details align with chain steps');
  for (const detail of route.chainDetails) {
    assert.ok(typeof detail.id === 'string' && detail.id, 'detail id');
    assert.ok(typeof detail.known === 'boolean', 'detail known flag');
    assert.ok(typeof detail.served === 'boolean', 'detail served flag');
    assert.ok(detail.contextLength === null || typeof detail.contextLength === 'number', 'contextLength type');
    assert.ok(['ready', 'no_key', 'unavailable'].includes(detail.status), 'status enum');
  }
});

test('POST /api/show for a local-router route exposes local_router_chain', { skip: skipReason || undefined }, async () => {
  const routes = await (await fetch(`${baseUrl}/api/fallback-models`)).json();
  const routeId = routes.data[0].id;
  const response = await fetch(`${baseUrl}/api/show`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: routeId })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.local_router_chain, 'local_router_chain present');
  assert.ok(Array.isArray(body.local_router_chain.members));
  assert.equal(body.local_router_chain.members.length, routes.data[0].models.length);
  assert.equal(body.local_router_chain.members[0].order, 1);
  assert.ok(typeof body.model_info['local-router.chain'] === 'string');
});

test('Providers page merges key configs into the providers & models card', { skip: skipReason || undefined }, async () => {
  const response = await fetch(`${baseUrl}/config/providers`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Providers, Keys &amp; Models/, 'merged card title');
  assert.doesNotMatch(html, /<h2>Available Providers &amp; Models<\/h2>/, 'old separate catalog card removed');
  assert.ok(html.includes('id="providerGrid"'), 'provider grid present');
  assert.ok(html.includes('id="catalog"'), 'catalog present');
  assert.ok(html.indexOf('id="providerGrid"') < html.indexOf('id="catalog"'), 'key grid precedes catalog');
  assert.match(html, /Unable to verify Ollama server version/, 'IDE compatibility explainer');
});
