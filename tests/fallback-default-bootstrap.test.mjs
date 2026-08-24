import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Reproduction of the 2026-08-23 production bootstrap failure: a persisted
// curated selection of ZERO keys collapses the serving catalog (ollama-only),
// and chain-authoring resolution used that serving subset — so the system
// fallback chain never seeded despite the endpoint cache holding every
// default-chain model. Chain authoring must resolve against the full
// inventory (serving ∪ endpoint cache).

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

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-bootstrap-scope-'));
  const configDir = join(testHome, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'endpoint-models-cache.json'), JSON.stringify(CACHE_MODELS, null, 2));
  writeFileSync(join(configDir, 'model-source-config.json'), JSON.stringify({
    source: 'endpoints',
    curationEnabled: true,
    curatedEndpointModelKeys: [],
    filterConfigured: true
  }, null, 2));

  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
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

test('system fallback chain bootstraps from inventory when curated selection is empty', async () => {
  const routes = await requestJson('/api/fallback-models');
  assert.equal(routes.response.status, 200);
  const systemRoute = (routes.body?.data || []).find((route) => (
    route.routeId === 'fallback-models' || route.id === 'local-router/fallback-models'
  ));
  assert.ok(systemRoute, 'system fallback chain must bootstrap despite an empty curated selection');
  assert.ok(
    systemRoute.models.includes('nvidia-nim-minimax-m3'),
    `expected nvidia-nim-minimax-m3 in chain, got: ${systemRoute.models.join(', ')}`
  );
  assert.ok(
    systemRoute.models.includes('zai-code-pass-glm-5.1'),
    'registry-known cached ids must be accepted by bootstrap resolution'
  );
});

test('toggle accepts cache-known-but-unserved models', async () => {
  const toggle = await requestJson('/api/fallback-chain/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelId: 'wafer-ai-deepseek-v4-flash', enabled: true, routeId: 'free' })
  });
  assert.equal(toggle.response.status, 200);
  assert.equal(toggle.body?.success, true);
  const chain = toggle.body?.route?.models || [];
  assert.equal(chain.at(-1), 'wafer-ai-deepseek-v4-flash');
});
