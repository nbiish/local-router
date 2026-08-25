import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// 2026-08-24 empty-by-default: chains are NOT seeded at boot; users author
// their own (config UI) or declare them via LOCAL_ROUTER_ROUTES_CONFIG /
// `local-router start --config <file>`. This file covers the empty boot, the
// toggle/save inventory scope (registry-known models without serving
// curation), config-file application, and fail-closed invalid configs.

const port = String(27000 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let testHome = '';
let serverLogs = '';

const CACHE_MODELS = [
  {
    id: 'nvidia-nim-minimax-m3',
    provider: 'nvidia-nim',
    model: 'minimax/minimax-m3',
    contextLength: 1000000,
    outputTokens: 131072,
    tier: 'free',
    supportsTools: true,
    supportsImages: true
  },
  {
    id: 'zai-code-pass-glm-5.1',
    provider: 'zai',
    model: 'code-pass-glm-5.1',
    contextLength: 200000,
    outputTokens: 128000,
    tier: 'subscription',
    supportsTools: true
  },
  {
    id: 'wafer-ai-deepseek-v4-flash',
    provider: 'wafer-serverless',
    model: 'deepseek-v4-flash',
    contextLength: 1000000,
    outputTokens: 128000,
    tier: 'paid',
    supportsTools: true
  }
];

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { parseError: true, raw: text }; }
  }
  return { response, body, text };
}

function spawnServer(extraEnv) {
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
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

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-empty-default-'));
  const configDir = join(testHome, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'endpoint-models-cache.json'), JSON.stringify(CACHE_MODELS, null, 2));
  writeFileSync(join(configDir, 'model-source-config.json'), JSON.stringify({
    source: 'endpoints',
    curationEnabled: true,
    curatedEndpointModelKeys: [],
    filterConfigured: true
  }, null, 2));
  // Boot without LOCAL_ROUTER_ROUTES_CONFIG — the empty-by-default boot.
  serverProcess = spawnServer({});
  await waitForServerReady(serverProcess);
});

test.after(async () => {
  if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => undefined);
  }
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('boot ships exactly the always-present empty system chain', async () => {
  const routes = await requestJson('/api/fallback-models');
  assert.equal(routes.response.status, 200);
  const data = routes.body?.data || [];
  assert.equal(data.length, 1, 'only the system chain should exist');
  assert.equal(data[0].routeId, 'fallback-models');
  assert.deepEqual(data[0].models, [], 'system chain starts empty (no curated steps)');
  const models = await requestJson('/v1/models');
  const localRouterEntries = (models.body?.data || []).filter((entry) => String(entry.id).startsWith('local-router/'));
  assert.deepEqual(localRouterEntries.map((entry) => entry.id), ['local-router/fallback-models']);
});

test('toggle appends to the always-present empty system chain', async () => {
  const toggle = await requestJson('/api/fallback-chain/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'zenmux-minimax-m3', enabled: true })
  });
  assert.equal(toggle.response.status, 200);
  assert.equal(toggle.body?.route?.id, 'fallback-models');
  assert.deepEqual(toggle.body?.route?.models, ['zenmux-minimax-m3']);
});

test('save accepts registry/cache-known models without serving curation', async () => {
  const save = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'my-chain',
      models: ['nvidia-nim-minimax-m3', 'zai-code-pass-glm-4.6v', 'openrouter-chain-of-draft']
    })
  });
  assert.equal(save.response.status, 200, `chain save failed: ${save.body?.error || save.text}`);
});

test('toggle accepts cache-known-but-unserved models', async () => {
  const toggle = await requestJson('/api/fallback-chain/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'wafer-ai-deepseek-v4-flash', enabled: true, routeId: 'fallback-models' })
  });
  assert.equal(toggle.response.status, 200);
  assert.equal(toggle.body?.success, true);
  const chain = toggle.body?.route?.models || [];
  assert.equal(chain.at(-1), 'wafer-ai-deepseek-v4-flash');
});

test('LOCAL_ROUTER_ROUTES_CONFIG applies declared chains + curation at boot', async () => {
  serverProcess.kill('SIGTERM');
  await once(serverProcess, 'exit').catch(() => undefined);
  const configDir = join(testHome, '.config', 'local-router');
  const configPath = join(testHome, 'routes.json');
  writeFileSync(configPath, JSON.stringify({
    fallbackModels: {
      'local-router/free-from-file': {
        models: ['nvidia-nim-minimax-m3', 'wafer-ai-deepseek-v4-flash'],
        disabledModels: ['wafer-ai-deepseek-v4-flash']
      },
      'file-backup-chain': ['nvidia-nim-minimax-m3', 'zai-code-pass-glm-5.1']
    },
    curation: { enabled: true, selectedKeys: ['nvidia-nim::minimax/minimax-m3'] },
    filterConfigured: false
  }));
  serverProcess = spawnServer({ LOCAL_ROUTER_ROUTES_CONFIG: configPath });
  await waitForServerReady(serverProcess);

  const routes = await requestJson('/api/fallback-models');
  const ids = (routes.body?.data || []).map((route) => route.routeId).sort();
  assert.deepEqual(ids, ['fallback-models', 'file-backup-chain', 'free-from-file'],
    'config file replaces local chains; the always-present empty system chain co-exists');
  const fromFile = routes.body.data.find((route) => route.routeId === 'free-from-file');
  assert.deepEqual(fromFile.disabledModels, ['wafer-ai-deepseek-v4-flash']);

  const source = await requestJson('/api/model-source');
  assert.deepEqual(source.body?.curatedEndpointModelKeys, ['nvidia-nim::minimax/minimax-m3']);
  assert.equal(source.body?.filterConfigured, false);

  const persisted = JSON.parse((await import('node:fs')).readFileSync(join(configDir, 'fallback-models.json'), 'utf8'));
  assert.ok(
    (persisted.routes || []).some((route) => route.id === 'free-from-file'),
    'config-declared chains persist to fallback-models.json'
  );
});

test('missing config file fails closed (non-zero boot exit)', async () => {
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      PORT: String(Number(port) + 7),
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_ROUTES_CONFIG: join(testHome, 'does-not-exist.json')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0, 'server must refuse to boot with a missing config file');
  assert.match(logs, /Routes config file not found/);
});
