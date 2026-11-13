import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 2026-11-12: live model IDENTITY survives refresh — case/alias twins are
// distinct upstream models and must not collapse into a registry baseline
// (the bug that silently dropped wafer's DeepSeek-V4-Pro and
// DeepSeek-V4.1-Flash-1017). Archive keys are federated presentation state.

const port = String(19700 + Math.floor(Math.random() * 400));
const baseUrl = `http://127.0.0.1:${port}`;
// The registry baseline for fastino is `fastino/Fastino-Nemotron-3.5-Lightning-Finance`;
// the mock serves it plus a case twin and a build variant.
const upstreamIds = [
  'fastino/Fastino-Nemotron-3.5-Lightning-Finance',
  'Fastino/Fastino-Nemotron-3.5-Lightning-Finance',
  'fastino/Fastino-Nemotron-3.5-Lightning-Finance-1017'
];

let serverProcess;
let upstreamServer;
let serverLogs = '';
let testHome = '';

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.method === 'GET' && String(req.url).includes('/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: upstreamIds.map((id) => ({ id, object: 'model' })) }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${upstreamServer.address().port}/v1`;
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
  const upstreamBaseUrl = await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-identity-test-'));
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

test('case/alias twins survive a refresh with their own identity', async () => {
  // Seed a persisted override store first — the shadowing path: a modelStore
  // entry used to make the management view return ONLY overrides.
  const upsert = await requestJson('/api/provider-models/fastino/models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'operator-added-model', id: 'fastino-operator-added', contextLength: 8192, outputTokens: 4096 })
  });
  assert.equal(upsert.response.status, 200, JSON.stringify(upsert.body));

  const refresh = await requestJson('/api/provider-models/fastino/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(refresh.response.status, 200, JSON.stringify(refresh.body));

  const section = await requestJson('/api/provider-models/fastino?mode=all');
  const models = (section.body.data || section.body.models || []).map((m) => m.model);
  for (const id of upstreamIds) {
    assert.ok(models.includes(id), `live id "${id}" survives refresh (got: ${JSON.stringify(models)})`);
  }
  assert.ok(models.includes('operator-added-model'), 'the override row still wins its own key');

  // The management view ("every known model") agrees with the catalog feed —
  // a persisted override store must not shadow cache-only discoveries.
  const curation = await requestJson('/api/model-curation');
  const group = (curation.body.data || []).find((g) => g.provider === 'fastino');
  const feedModels = ((group && group.models) || []).map((m) => m.model);
  for (const id of upstreamIds) {
    assert.ok(feedModels.includes(id), `live id "${id}" present in the catalog feed`);
  }
});

test('archived keys federate into router-settings.json and restore losslessly', async () => {
  const archived = ['fastino::Fastino/Fastino-Nemotron-3.5-Lightning-Finance'];
  const put = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedKeys: ['fastino::fastino/Fastino-Nemotron-3.5-Lightning-Finance'], archivedKeys: archived })
  });
  assert.equal(put.response.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.archivedKeys, archived);

  const settings = readRouterSettings();
  assert.deepEqual(settings.catalogSelection?.archivedKeys, archived, 'archive state travels with the checkout');
  assert.ok((settings.catalogSelection?.curatedKeys || []).length > 0, 'the serve selection is preserved');

  const restore = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivedKeys: [] })
  });
  assert.equal(restore.response.status, 200);
  assert.deepEqual(restore.body.archivedKeys, [], 'restore empties the archive');
  assert.deepEqual(readRouterSettings().catalogSelection?.archivedKeys, [], 'federated state follows the restore');
});

test('archivedKeys rejects malformed entries', async () => {
  const bad = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ archivedKeys: ['no-provider-separator'] })
  });
  assert.equal(bad.response.status, 400);
});
