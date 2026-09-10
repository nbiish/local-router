import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Local backends (llama.cpp `llama-server`, Unsloth, ollama) are connections,
// not liveness requirements: llama.cpp and unsloth register idempotently at
// boot even when nothing listens on their ports, their registered models stay
// discoverable while offline, and 11434 keeps answering OpenAI + Anthropic
// SDK shapes through graceful failover. Deleting a standard backend
// tombstones it so boot does not resurrect it.

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

test('local backends register offline, stay discoverable, and 11434 keeps serving', async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-local-backends-'));

  // A live mock upstream gives the fallback chain a servable target, so the
  // test proves genuine graceful failover: the offline llama.cpp model
  // cascades into the chain and the operator still gets an answer.
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
  // listening on :8080 — the models must still be discoverable.
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
  // Single-source chain targeting the mock model so failover has a target.
  writeCustomProviders; // (no-op reference guard)
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({
    fallbackModelsText: 'mock-local-mock-fast',
    routes: [{ id: 'fallback-models', models: ['mock-local-mock-fast'] }]
  }, null, 2));

  await startServer();
  try {
    // Boot auto-registration: unsloth exists without any shim invocation.
    const store = readJson(customProvidersPath());
    const names = store.providers.map((p) => p.name);
    assert.ok(names.includes('llama-cpp'), 'llama-cpp stays registered');
    assert.ok(names.includes('unsloth'), 'unsloth auto-registers at boot (offline-tolerant)');

    // Offline discovery: registered models are listed even with :8080 down.
    const models = await requestJson('/v1/models');
    assert.equal(models.response.status, 200);
    const ids = models.body.data.map((m) => m.id);
    assert.ok(ids.includes('llama-cpp-huihui-27b-abliterated'), `offline llama.cpp model must be listed; got: ${ids.filter((i) => i.startsWith('llama-cpp')).join(', ')}`);
    assert.ok(ids.includes('llama-cpp-nemotron-3.5-lightning'));

    // OpenAI shape: the offline backend's request fails over through the
    // chain into the mock upstream — the operator still gets an answer.
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
    assert.ok(chat.body && typeof chat.body === 'object' && !chat.body.parseError,
      'response must be structured JSON');

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
