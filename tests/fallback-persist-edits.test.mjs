import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(28000 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let testHome = '';
let serverLogs = '';

function spawnServer(extraEnv = {}) {
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
      LOCAL_ROUTER_DEV: 'true',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });
  return child;
}

async function waitForServerReady(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early.\nLogs:\n${serverLogs}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await delay(100);
  }
  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

async function stopServer() {
  if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => undefined);
  }
}

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { parseError: true, raw: text }; }
  }
  return { response, body, text };
}

function postJson(pathname, payload) {
  return requestJson(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function putJson(pathname, payload) {
  return requestJson(pathname, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-persist-edits-test-'));
  serverProcess = spawnServer();
  await waitForServerReady(serverProcess);
});

test.after(async () => {
  await stopServer();
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('fallback candidate modifications (add, toggle, remove, empty) persist across restart', async () => {
  const catalog = await requestJson('/api/provider-models?catalog=active');
  assert.equal(catalog.response.status, 200);
  const catalogIds = (catalog.body?.data || [])
    .flatMap((entry) => entry.models || [])
    .map((model) => model.id)
    .filter((id) => typeof id === 'string' && id);
  assert.ok(catalogIds.length >= 2, `Expected at least 2 catalog models, got: ${catalogIds.join(', ')}`);
  const [modelA, modelB] = catalogIds;

  // 1. Add modelA and modelB to system route fallback-models
  const save2 = await postJson('/api/fallback-models', {
    id: 'fallback-models',
    models: [modelA, modelB]
  });
  assert.equal(save2.response.status, 200);
  assert.deepEqual(save2.body?.model?.models, [modelA, modelB]);

  // 2. Toggle modelB disabled (simulate toggle checkbox auto-save)
  const toggleSave = await postJson('/api/fallback-models', {
    id: 'fallback-models',
    modelsText: `${modelA}\n${modelB} disabled`,
    allowShort: true
  });
  assert.equal(toggleSave.response.status, 200);
  assert.deepEqual(toggleSave.body?.model?.disabledModels, [modelB]);

  // 3. Remove modelB leaving 1 model (simulate ✕ remove button auto-save)
  const removeSave = await postJson('/api/fallback-models', {
    id: 'fallback-models',
    modelsText: modelA,
    allowShort: true
  });
  assert.equal(removeSave.response.status, 200);
  assert.deepEqual(removeSave.body?.model?.models, [modelA]);

  // 4. Restart server and verify 1-model chain persisted
  await stopServer();
  serverProcess = spawnServer();
  await waitForServerReady(serverProcess);

  const afterRestart = await requestJson('/api/fallback-models');
  assert.equal(afterRestart.response.status, 200);
  const sysRoute = (afterRestart.body?.data || []).find((r) => r.routeId === 'fallback-models');
  assert.ok(sysRoute, 'fallback-models route should exist');
  assert.deepEqual(sysRoute.models, [modelA], '1-model chain should persist across restart');

  // 5. Empty the chain (simulate removing all candidates)
  const emptySave = await postJson('/api/fallback-models', {
    id: 'fallback-models',
    modelsText: '',
    allowShort: true
  });
  assert.equal(emptySave.response.status, 200);
  assert.deepEqual(emptySave.body?.model?.models, []);

  // 6. Restart server and verify empty chain persisted
  await stopServer();
  serverProcess = spawnServer();
  await waitForServerReady(serverProcess);

  const afterEmptyRestart = await requestJson('/api/fallback-models');
  const sysRouteEmpty = (afterEmptyRestart.body?.data || []).find((r) => r.routeId === 'fallback-models');
  assert.ok(sysRouteEmpty, 'fallback-models route should exist');
  assert.deepEqual(sysRouteEmpty.models, [], 'empty chain should persist across restart');
});

test('router settings export/import/reset persists fallback routes and settings', async () => {
  const catalog = await requestJson('/api/provider-models?catalog=active');
  const catalogIds = (catalog.body?.data || [])
    .flatMap((entry) => entry.models || [])
    .map((model) => model.id)
    .filter((id) => typeof id === 'string' && id);
  const [modelA, modelB] = catalogIds;

  // Import router settings via PUT /api/router-settings
  const importRes = await putJson('/api/router-settings', {
    fallbackModelsText: `${modelA}\n${modelB}`
  });
  assert.equal(importRes.response.status, 200);
  assert.equal(importRes.body?.success, true);

  // Check GET /api/router-settings returns synchronized text and routes
  const exportRes = await requestJson('/api/router-settings');
  assert.equal(exportRes.response.status, 200);
  assert.match(exportRes.body?.fallbackModelsText || '', new RegExp(modelA));
  assert.ok(Array.isArray(exportRes.body?.routes));

  // Restart server and verify imported settings persisted to fallback-models.json
  await stopServer();
  serverProcess = spawnServer();
  await waitForServerReady(serverProcess);

  const routesAfterImport = await requestJson('/api/fallback-models');
  const sysRoute = (routesAfterImport.body?.data || []).find((r) => r.routeId === 'fallback-models');
  assert.deepEqual(sysRoute?.models, [modelA, modelB]);

  // Reset router settings via DELETE /api/router-settings
  const deleteRes = await requestJson('/api/router-settings', { method: 'DELETE' });
  assert.equal(deleteRes.response.status, 200);

  // Restart server and verify reset persisted
  await stopServer();
  serverProcess = spawnServer();
  await waitForServerReady(serverProcess);

  const routesAfterReset = await requestJson('/api/fallback-models');
  const sysRouteReset = (routesAfterReset.body?.data || []).find((r) => r.routeId === 'fallback-models');
  assert.deepEqual(sysRouteReset?.models, []);
});

test('stale router-settings.json does not overwrite active fallback-models.json at boot', async () => {
  const catalog = await requestJson('/api/provider-models?catalog=active');
  const catalogIds = (catalog.body?.data || [])
    .flatMap((entry) => entry.models || [])
    .map((model) => model.id)
    .filter((id) => typeof id === 'string' && id);
  const [modelA] = catalogIds;

  await stopServer();

  const configDir = join(testHome, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });

  // Active fallback-models.json has modelA
  writeFileSync(join(configDir, 'fallback-models.json'), JSON.stringify({
    version: 1,
    routes: [{ id: 'fallback-models', models: [modelA] }]
  }, null, 2));

  // Stale router-settings.json has an old obsolete chain
  writeFileSync(join(configDir, 'router-settings.json'), JSON.stringify({
    fallbackModelsText: 'stale-model-1\nstale-model-2'
  }, null, 2));

  serverProcess = spawnServer();
  await waitForServerReady(serverProcess);

  const routes = await requestJson('/api/fallback-models');
  const sysRoute = (routes.body?.data || []).find((r) => r.routeId === 'fallback-models');
  assert.deepEqual(sysRoute?.models, [modelA], 'must not overwrite active fallback-models.json with stale router-settings.json');
});
