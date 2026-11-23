import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { scrubbedEnv } from './test-env.mjs';

const port = String(29000 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;
let serverProcess;
let testHome = '';
let serverLogs = '';

function spawnServer() {
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...scrubbedEnv(),
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_CONFIG_DIR: testHome,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });
  return child;
}

async function waitForServerReady(child) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Server exited early.\nLogs:\n${serverLogs}`);
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) return;
    } catch { /* keep polling */ }
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

async function request(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function postImport(config, dryRun) {
  return request('/api/config/fallback/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config, dryRun })
  });
}

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-fallback-config-api-'));
  serverProcess = spawnServer();
  await waitForServerReady(serverProcess);
});

test.after(async () => {
  await stopServer();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('export returns a versioned, credential-free bundle', async () => {
  const { response, body } = await request('/api/config/fallback/export');
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.match(body.filename, /^local-router-fallback-\d{4}-\d{2}-\d{2}\.json$/);
  const bundle = JSON.parse(body.config);
  assert.equal(bundle.schema, 'local-router-fallback/v1');
  assert.ok(typeof bundle.fallbackModelsText === 'string');
  assert.ok(Array.isArray(bundle.routes));
  assert.deepEqual(Object.keys(bundle).sort(), ['exportedAt', 'fallbackModelsText', 'routes', 'schema']);
  for (const needle of ['apikey', 'token', 'password', 'secret']) {
    assert.equal(body.config.toLowerCase().includes(needle), false, `export leaked ${needle}`);
  }
});

test('dry-run import reports a diff and does not write the chain', async () => {
  const before = await request('/api/router-settings');
  const config = JSON.stringify({
    schema: 'local-router-fallback/v1',
    exportedAt: '2026-11-23T01:00:00.000Z',
    fallbackModelsText: 'portable-model-a\nportable-model-b disabled',
    routes: []
  });
  const { response, body } = await postImport(config, true);
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.dryRun, true);
  assert.ok(body.diff.chainAdded.includes('portable-model-a'));
  assert.ok(body.diff.chainAdded.includes('portable-model-b'));
  assert.ok(typeof body.previousConfig === 'string');

  const after = await request('/api/router-settings');
  assert.equal(after.body.fallbackModelsText, before.body.fallbackModelsText);
});

test('invalid bundles are rejected without touching the chain', async () => {
  const before = await request('/api/router-settings');
  const bad = await postImport('{}', false);
  assert.equal(bad.response.status, 400);
  assert.equal(bad.body.success, false);
  const smuggled = await postImport(JSON.stringify({
    schema: 'local-router-fallback/v1',
    exportedAt: '2026-11-23T01:00:00.000Z',
    fallbackModelsText: 'portable-model-a',
    routes: [],
    LOCALROUTER_OPENROUTER_API_KEY: 'leak'
  }), false);
  assert.equal(smuggled.response.status, 400);

  const after = await request('/api/router-settings');
  assert.equal(after.body.fallbackModelsText, before.body.fallbackModelsText);
});

test('apply writes the chain and a fresh export matches it', async () => {
  const config = JSON.stringify({
    schema: 'local-router-fallback/v1',
    exportedAt: '2026-11-23T01:00:00.000Z',
    fallbackModelsText: 'portable-model-a\nportable-model-b disabled',
    routes: []
  });
  const { response, body } = await postImport(config, false);
  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.dryRun, false);

  const settings = await request('/api/router-settings');
  assert.equal(settings.body.fallbackModelsText, 'portable-model-a\nportable-model-b disabled');

  const exported = await request('/api/config/fallback/export');
  const bundle = JSON.parse(exported.body.config);
  assert.equal(bundle.fallbackModelsText, 'portable-model-a\nportable-model-b disabled');
});
