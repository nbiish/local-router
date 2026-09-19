import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(28500 + Math.floor(Math.random() * 400));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let testHome = '';
let serverLogs = '';

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { parseError: true, raw: text }; }
  }
  return { response, body, text };
}

function putJson(pathname, payload) {
  return requestJson(pathname, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

function readModelSourceConfig() {
  const path = join(testHome, '.config', 'local-router', 'model-source-config.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function selectedKeysOf(body) {
  return body?.selectedKeys || [];
}

async function startServer() {
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess.exitCode !== null) {
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
  serverProcess = undefined;
}

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-merge-guard-'));
  await startServer();
});

test.after(async () => {
  await stopServer();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('curation merge guard: single-provider clear succeeds without 409, whole-catalog wipe requires force', async () => {
  // Baseline setup: 15 openrouter keys and 2 nebius keys (17 total).
  const openrouterKeys = Array.from({ length: 15 }, (_, i) => `openrouter::model-${i + 1}`);
  const nebiusKeys = ['nebius::deepseek-v4.1-flash', 'nebius::qwen-2.5-coder'];
  const allInitial = [...openrouterKeys, ...nebiusKeys];

  // Initialize curation with force
  const initRes = await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: allInitial,
    force: true
  });
  assert.equal(initRes.response.status, 200);
  assert.equal(initRes.body?.selectedCount, 17);

  // 1. Single-provider clear: remove all 15 openrouter keys (15/17 = 88.2% or let's test 19/21 = 90.5%).
  // Let's add 5 more openrouter keys to guarantee >90% drop.
  const openrouter20 = Array.from({ length: 20 }, (_, i) => `openrouter::model-${i + 1}`);
  const all22 = [...openrouter20, ...nebiusKeys];
  await putJson('/api/model-curation', { enabled: true, selectedKeys: all22, force: true });

  // Now removing 20 of 22 = 90.9% shrink, but ALL removed belong to openrouter, and nebius is preserved.
  const singleProvRes = await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: nebiusKeys
  });
  assert.equal(
    singleProvRes.response.status,
    200,
    'Single-provider deselection must NOT be blocked by the global catalog wipe guard'
  );
  assert.equal(singleProvRes.body?.selectedCount, 2);

  // Verify server persisted it
  const verifyRes = await requestJson('/api/model-curation');
  assert.equal(verifyRes.body?.selectedCount, 2);
  const remainingKeys = verifyRes.body?.selectedKeys || [];
  assert.ok(!remainingKeys.some((k) => k.startsWith('openrouter::')));
  assert.ok(remainingKeys.includes('nebius::deepseek-v4.1-flash'));

  // 2. Accidental catalog wipe: re-add 20 openrouter keys + 2 nebius keys, then drop BOTH down to 0 without force.
  await putJson('/api/model-curation', { enabled: true, selectedKeys: all22, force: true });

  const wipeWithoutForce = await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: []
  });
  assert.equal(
    wipeWithoutForce.response.status,
    409,
    'Whole-catalog wipe without force must be blocked by merge guard with HTTP 409'
  );
  assert.ok(wipeWithoutForce.body?.error?.includes('Curation merge guard'));

  // 3. Whole-catalog wipe with force: true succeeds.
  const wipeWithForce = await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: [],
    force: true
  });
  assert.equal(wipeWithForce.response.status, 200);
  assert.equal(wipeWithForce.body?.selectedCount, 0);
});

test('curation seeding: a deliberately cleared provider is not re-seeded by activate', async () => {
  // Populate the endpoint cache so the seeding path has a catalog to work with.
  const refresh = await requestJson('/api/provider-models/zai/refresh', { method: 'POST' });
  assert.equal(refresh.response.status, 200);
  const zaiModels = (refresh.body?.data || []).map((model) => model.model);
  assert.ok(zaiModels.length >= 2, 'Need at least two zai models to stage a clear');

  const zaiKeys = zaiModels.slice(0, 2).map((model) => `zai::${model}`);

  // A provider refresh auto-clears picks, so select two models back to lift the
  // operator-cleared mark.
  const select = await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: zaiKeys,
    force: true
  });
  assert.equal(select.response.status, 200);
  assert.equal(select.body?.selectedCount, 2);
  assert.ok(
    !(readModelSourceConfig().operatorClearedProviders || []).includes('zai'),
    'Selecting models must clear the operator-cleared mark'
  );

  // Deliberately clear the provider.
  const clear = await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: [],
    force: true
  });
  assert.equal(clear.response.status, 200);
  assert.equal(clear.body?.selectedCount, 0);
  assert.ok(
    (readModelSourceConfig().operatorClearedProviders || []).includes('zai'),
    'Clearing a provider must record it as operator-cleared'
  );

  // activate runs ensureCurationDefaultsForCache(): it must NOT re-seed the
  // provider the operator just cleared.
  const activate = await putJson('/api/model-curation', { activate: true });
  assert.equal(activate.response.status, 200);
  assert.ok(
    !selectedKeysOf(activate.body).some((key) => key.startsWith('zai::')),
    'activate must not re-seed a provider the operator deliberately cleared'
  );

  const verify = await requestJson('/api/model-curation');
  assert.ok(
    !selectedKeysOf(verify.body).some((key) => key.startsWith('zai::')),
    'Cleared provider must stay cleared after a bootstrap seeding pass'
  );

  // Re-selecting lifts the mark so normal seeding resumes for that provider.
  const reselect = await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: [zaiKeys[0]],
    force: true
  });
  assert.equal(reselect.response.status, 200);
  assert.ok(
    !(readModelSourceConfig().operatorClearedProviders || []).includes('zai'),
    'Re-selecting a model must lift the operator-cleared mark'
  );
});

test('catalog migration: an operator-cleared provider survives a catalog version bump', async () => {
  // Stage a deliberate clear.
  const refresh = await requestJson('/api/provider-models/zai/refresh', { method: 'POST' });
  assert.equal(refresh.response.status, 200);
  const zaiModels = (refresh.body?.data || []).map((model) => model.model);
  assert.ok(zaiModels.length >= 2, 'Need at least two zai models to stage a clear');

  // Mixed baseline so clearing zai is a single-provider edit and the migration
  // still has other providers left to seed.
  const zaiKeys = zaiModels.slice(0, 2).map((model) => `zai::${model}`);
  const keepKey = 'nebius::deepseek-v4.1-flash';
  await putJson('/api/model-curation', {
    enabled: true,
    selectedKeys: [...zaiKeys, keepKey],
    force: true
  });
  await putJson('/api/model-curation', { enabled: true, selectedKeys: [keepKey], force: true });
  assert.ok(
    (readModelSourceConfig().operatorClearedProviders || []).includes('zai'),
    'Precondition: zai must be marked operator-cleared'
  );

  // Force seedRegistryCatalogIfNeeded() to run again with an empty endpoint
  // cache, so the migration has registry models to pre-check.
  const configDir = join(testHome, '.config', 'local-router');
  const configPath = join(configDir, 'model-source-config.json');
  await stopServer();
  const staged = JSON.parse(readFileSync(configPath, 'utf8'));
  staged.catalogMigrationVersion = 0;
  writeFileSync(configPath, JSON.stringify(staged, null, 2));
  writeFileSync(join(configDir, 'endpoint-models-cache.json'), '[]');
  await startServer();

  const after = await requestJson('/api/model-curation');
  const keys = selectedKeysOf(after.body);
  const clearedProviders = readModelSourceConfig().operatorClearedProviders || [];
  assert.ok(clearedProviders.length > 0, 'Precondition: at least one provider is operator-cleared');
  assert.ok(keys.length > 0, 'Migration must still seed the catalog for other providers');
  // The migration pre-checks every model it newly unions into the cache, so any
  // key belonging to a cleared provider means it repopulated one.
  const repopulated = keys.filter((key) => clearedProviders.includes(key.split('::')[0]));
  assert.deepEqual(
    repopulated,
    [],
    'Catalog migration must not repopulate operator-cleared providers'
  );
});
