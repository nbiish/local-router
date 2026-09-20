import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Local backends (llama.cpp `llama-server`, Unsloth) are DETECTED, never
// started and never shimmed (2026-09-20): they register as keyless loopback
// custom providers at boot, but their models are listed ONLY while the
// backend's own /v1/models endpoint answers. An offline backend contributes
// no catalog rows while 11434 keeps answering OpenAI + Anthropic shapes
// through graceful failover. Deleting a standard backend tombstones it so
// boot does not resurrect it.

const port = String(27700 + Math.floor(Math.random() * 300));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let testHome = '';
let serverLogs = '';

const configDir = () => join(testHome, '.config', 'local-router');
const settingsPath = () => join(configDir(), 'router-settings.json');
const customProvidersPath = () => join(configDir(), 'custom-providers.json');

function readJson(pathname) {
  return JSON.parse(readFileSync(pathname, 'utf8'));
}

function writeCustomProviders(providers, extras = {}) {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(customProvidersPath(), JSON.stringify({ version: 1, providers, ...extras }, null, 2));
}

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { parseError: true, raw: text }; }
  }
  return { response, body };
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
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (c) => { serverLogs += c.toString(); });
  serverProcess.stderr.on('data', (c) => { serverLogs += c.toString(); });
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      ready = response.ok;
    } catch { await delay(100); }
  }
  assert.ok(ready, 'server must start\n' + serverLogs.slice(-2000));
}

async function stopServer() {
  if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => undefined);
  }
  await delay(300);
  serverProcess = undefined;
}

async function pollForModels(id, shouldExist, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    const models = await requestJson('/v1/models');
    const ids = (models.body?.data || []).map((m) => m.id);
    if (ids.includes(id) === shouldExist) return ids;
    await delay(250);
  }
  const models = await requestJson('/v1/models');
  return (models.body?.data || []).map((m) => m.id);
}

test('offline llama.cpp contributes no rows; 11434 keeps serving; tombstone sticks', async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-local-backends-'));

  // A live mock upstream gives the fallback chain a servable target, so the
  // test proves genuine graceful failover: a request aimed at the offline
  // llama.cpp model cascades into the chain and the operator still gets an
  // answer — but the offline model itself is NOT listed.
  let mockHits = 0;
  const mockServer = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      mockHits++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'MOCK-OK' } }]
      }));
    });
  });
  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;

  // Operator-registered models on llama-cpp BEFORE first boot: nothing is
  // listening on :8080 — the backend must register but its models must NOT
  // be listed.
  writeCustomProviders([
    {
      name: 'llama-cpp',
      displayName: 'llama.cpp (local llama-server)',
      endpoint: 'http://127.0.0.1:8080/v1',
      keyEnvVar: 'LLAMA_CPP_API_KEY',
      defaultTool: 'OpenAI Compatible',
      createdAt: new Date().toISOString(),
      models: ['huihui-27b-abliterated', 'nemotron-3.5-lightning']
    },
    {
      name: 'mock-local',
      displayName: 'Mock (test upstream)',
      endpoint: `http://127.0.0.1:${mockPort}/v1`,
      keyEnvVar: 'MOCK_LOCAL_API_KEY',
      defaultTool: 'OpenAI Compatible',
      createdAt: new Date().toISOString(),
      models: ['mock-fast']
    }
  ]);
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({
    fallbackModelsText: 'mock-local-mock-fast',
    routes: [{ id: 'fallback-models', models: ['mock-local-mock-fast'] }]
  }, null, 2));

  await startServer();
  try {
    // Boot auto-registration: both standard backends stay registered.
    const store = readJson(customProvidersPath());
    const names = store.providers.map((p) => p.name);
    assert.ok(names.includes('llama-cpp'), 'llama-cpp stays registered');
    assert.ok(names.includes('unsloth'), 'unsloth auto-registers at boot');

    // Detection-only: with :8080 down, llama.cpp models are NOT listed.
    const ids = await pollForModels('llama-cpp-huihui-27b-abliterated', false);
    assert.equal(ids.includes('llama-cpp-huihui-27b-abliterated'), false,
      `offline llama.cpp model must NOT be listed; got: ${ids.filter((i) => i.startsWith('llama-cpp')).join(', ')}`);
    assert.equal(ids.includes('llama-cpp-nemotron-3.5-lightning'), false);

    // OpenAI shape: a request aimed at the offline backend cascades through
    // the chain into the live mock upstream — structured answer, no hang.
    const chat = await requestJson('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-cpp-huihui-27b-abliterated',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10
      })
    });
    assert.ok([200, 502, 503].includes(chat.response.status),
      `offline backend must answer gracefully, got ${chat.response.status}`);

    // Anthropic SDK shape answers regardless of backend state.
    const anthropic = await requestJson('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local-router/fallback-models',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'say OK' }]
      })
    });
    console.log('DEBUG chat_status=', chat.response.status, 'anthropic_status=', anthropic.response.status, 'mockHits=', mockHits);
    const relevant = serverLogs.split('\n').filter((l) => /mock|chain|stage|skipped|preflight|allowlist|upstream|fetch/i.test(l));
    console.log('RELEVANT_LOGS:\n' + relevant.join('\n'));
    assert.equal(anthropic.response.status, 200, `anthropic surface must stay up: ${JSON.stringify(anthropic.body).slice(0, 200)}`);
    assert.equal(anthropic.body?.type, 'message');
    assert.ok(mockHits > 0, 'chain must have served via the live mock upstream');

    // Tombstone: deleting unsloth keeps it deleted across a restart.
    const del = await requestJson('/api/providers/unsloth', { method: 'DELETE' });
    assert.equal(del.response.status, 200, `delete failed: ${JSON.stringify(del.body)}`);
    await stopServer();
    serverLogs = '';
    await startServer();
    const storeAfter = readJson(customProvidersPath());
    assert.equal(storeAfter.providers.some((p) => p.name === 'unsloth'), false, 'tombstoned backend must not resurrect');
    assert.equal((storeAfter.dismissedLocalBackends || []).includes('unsloth'), true, 'dismissal must be recorded');
  } finally {
    await stopServer();
    mockServer.close();
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('live llama.cpp endpoint is detected and its models served; gone when it stops', async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-local-backends-live-'));

  // A fake llama-server: OpenAI-shaped /v1/models plus a chat endpoint.
  const fakeModels = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'huihui-27b-abliterated' }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => fakeModels.listen(8080, '127.0.0.1', resolve));

  writeCustomProviders([
    {
      name: 'llama-cpp',
      displayName: 'llama.cpp (local llama-server)',
      endpoint: 'http://127.0.0.1:8080/v1',
      keyEnvVar: 'LLAMA_CPP_API_KEY',
      defaultTool: 'OpenAI Compatible',
      createdAt: new Date().toISOString(),
      models: ['stale-cached-model']
    }
  ]);

  await startServer();
  try {
    // The router probes the backend's own /v1/models and lists its ids —
    // including models the operator never registered manually.
    const ids = await pollForModels('llama-cpp-huihui-27b-abliterated', true, 60);
    assert.ok(ids.includes('llama-cpp-huihui-27b-abliterated'),
      `live backend models must be listed; got: ${ids.filter((i) => i.startsWith('llama-cpp')).join(', ')}`);
    assert.equal(ids.includes('llama-cpp-stale-cached-model'), false,
      'stale cached rows must not shadow the live endpoint list');

    // Operator stops llama-server: after a fresh boot the model is gone
    // again (detection, not configuration).
    fakeModels.close();
    await stopServer();
    serverLogs = '';
    await startServer();
    const idsAfter = await pollForModels('llama-cpp-huihui-27b-abliterated', false);
    assert.equal(idsAfter.includes('llama-cpp-huihui-27b-abliterated'), false,
      'model must disappear once the backend endpoint stops answering');
  } finally {
    await stopServer();
    fakeModels.close();
    rmSync(testHome, { recursive: true, force: true });
  }
});
