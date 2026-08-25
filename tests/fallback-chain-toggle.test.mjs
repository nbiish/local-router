import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(26000 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let testHome = '';
let serverLogs = '';
let skipReason = '';
let selectedProvider;

const { PROVIDER_REGISTRY } = await import('../build/provider-registry.js');

function firstProviderSummary() {
  const first = PROVIDER_REGISTRY[0];
  if (!first) throw new Error('Expected at least one provider in the registry');
  return { name: first.name, keyEnvVar: first.keyEnvVar };
}

function providerBaseUrlEnvVar(providerName) {
  return `LOCAL_ROUTER_PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
}

function stripForeignProviderKeys(env, keepKeyEnvVars = []) {
  const keep = new Set(keepKeyEnvVars);
  const cleaned = { ...env };
  for (const key of Object.keys(cleaned)) {
    if (/^[A-Z0-9_]+_API_KEY$/.test(key) && !keep.has(key)) {
      delete cleaned[key];
    }
  }
  return cleaned;
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-v4-pro', object: 'model' },
          { id: 'endpoint-only-model', object: 'model' }
        ]
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

  const address = upstreamServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected fake upstream to listen on a TCP port');
  }
  return `http://127.0.0.1:${address.port}/v1`;
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
      // Keep polling until server is ready.
    }
    await delay(100);
  }
  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { parseError: true, raw: text };
    }
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

test.before(async () => {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    skipReason = 'Sandbox network is disabled; run integration tests in a normal local shell.';
    return;
  }

  selectedProvider = firstProviderSummary();
  const upstreamBaseUrl = await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-fallback-chain-test-'));
  const proxyEnv = {
    ...stripForeignProviderKeys(process.env, [`LOCALROUTER_${selectedProvider.keyEnvVar}`]),
    HOME: testHome,
    PORT: port,
    LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
    LOCAL_ROUTER_DEV: 'true',
    // Strict namespace (2026-08-22): keys live under the LOCALROUTER_ prefix.
    [`LOCALROUTER_${selectedProvider.keyEnvVar}`]: 'fallback-chain-test-provider-key',
    [providerBaseUrlEnvVar(selectedProvider.name)]: upstreamBaseUrl
  };

  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: proxyEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  try {
    await waitForServerReady();
  } catch (error) {
    if (/EPERM: operation not permitted/.test(serverLogs)) {
      skipReason = 'Sandbox blocks local socket listen (EPERM); run this integration test outside sandbox.';
      return;
    }
    throw error;
  }
});

test.after(async () => {
  if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => undefined);
  }
  if (upstreamServer) {
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

test('fallback-chain toggle + reorder manage the system fallback route', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const findRoute = (routes, routeId) => (routes?.data || []).find((route) => (
    route.routeId === routeId
    || route.id === routeId
    || route.id === `local-router/${routeId}`
  ));
  const findSystemRoute = (routes) => findRoute(routes, 'fallback-models');

  const initialRoutes = await requestJson('/api/fallback-models');
  assert.equal(initialRoutes.response.status, 200);
  // Empty by default (2026-08-24): no chains bootstrap; the system route is
  // auto-created on the first successful toggle.
  assert.deepEqual(initialRoutes.body?.data, []);

  // Toggle on an unknown model → 400.
  const unknown = await postJson('/api/fallback-chain/toggle', {
    modelId: 'no-such-provider-model-zzz',
    enabled: true
  });
  assert.equal(unknown.response.status, 400);

  // Pick two served catalog models that are not already in any chain.
  const catalog = await requestJson('/api/provider-models?catalog=active');
  assert.equal(catalog.response.status, 200);
  const chainSet = new Set(
    (initialRoutes.body?.data || []).flatMap((route) => route.models || [])
  );
  const toggleable = (catalog.body?.data || [])
    .flatMap((entry) => entry.models || [])
    .map((model) => model.id)
    .filter((id) => typeof id === 'string' && id && !chainSet.has(id));
  assert.ok(
    toggleable.length >= 2,
    `Expected at least 2 toggleable catalog models, got: ${toggleable.join(', ')}`
  );
  const [modelA, modelB] = toggleable;

  // Non-system routes are managed via /api/fallback-models, not toggle:
  // referencing an absent chain id → 404.
  const unknownChainToggle = await postJson('/api/fallback-chain/toggle', {
    modelId: modelA,
    enabled: true,
    routeId: 'no-such-chain'
  });
  assert.equal(unknownChainToggle.response.status, 404);
  const unknownChainReorder = await postJson('/api/fallback-chain/reorder', {
    orderedIds: [modelA],
    routeId: 'no-such-chain'
  });
  assert.equal(unknownChainReorder.response.status, 404);

  // Toggle A on → auto-creates the system chain with A as the first step.
  const toggleA = await postJson('/api/fallback-chain/toggle', { modelId: modelA, enabled: true });
  assert.equal(toggleA.response.status, 200);
  assert.equal(toggleA.body?.success, true);
  assert.equal(toggleA.body?.route?.models?.length, 1);
  assert.equal(toggleA.body.route.models.at(-1), modelA);

  // Toggle B on → appended after A (order preserved).
  const toggleB = await postJson('/api/fallback-chain/toggle', { modelId: modelB, enabled: true });
  assert.equal(toggleB.response.status, 200);
  assert.equal(toggleB.body?.route?.models?.length, 2);
  assert.equal(toggleB.body.route.models.at(-1), modelB);
  assert.equal(toggleB.body.route.models.at(-2), modelA);

  const currentChain = toggleB.body.route.models;

  // Reorder with a stale (incomplete) model set → 409.
  const stale = await postJson('/api/fallback-chain/reorder', {
    orderedIds: currentChain.slice(0, -1)
  });
  assert.equal(stale.response.status, 409);

  // Reorder with the full set, A and B swapped at the tail → 200.
  const reordered = [...currentChain.slice(0, -2), modelB, modelA];
  const reorder = await postJson('/api/fallback-chain/reorder', { orderedIds: reordered });
  assert.equal(reorder.response.status, 200);
  assert.equal(reorder.body?.success, true);
  assert.deepEqual(reorder.body?.route?.models, reordered);

  // GET reflects the new order.
  const afterReorder = await requestJson('/api/fallback-models');
  assert.equal(afterReorder.response.status, 200);
  const routeAfterReorder = findSystemRoute(afterReorder.body);
  assert.deepEqual(routeAfterReorder?.models, reordered);

  // Toggle B off → removed from models and disabledModels.
  const toggleOff = await postJson('/api/fallback-chain/toggle', { modelId: modelB, enabled: false });
  assert.equal(toggleOff.response.status, 200);
  assert.equal(toggleOff.body?.success, true);
  assert.equal((toggleOff.body?.route?.models || []).includes(modelB), false);
  assert.equal((toggleOff.body?.route?.disabledModels || []).includes(modelB), false);

  const finalRoutes = await requestJson('/api/fallback-models');
  const routeFinal = findSystemRoute(finalRoutes.body);
  assert.equal((routeFinal?.models || []).includes(modelB), false);
  assert.equal((routeFinal?.models || []).includes(modelA), true);
});

test('fallback-chain toggle + reorder target a non-system preset chain', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  // Empty by default (2026-08-24): author the non-system chain first — no
  // preset chains bootstrap anymore.
  const catalog = await requestJson('/api/provider-models?catalog=active');
  assert.equal(catalog.response.status, 200);
  const catalogIds = (catalog.body?.data || [])
    .flatMap((entry) => entry.models || [])
    .map((model) => model.id)
    .filter((id) => typeof id === 'string' && id);
  assert.ok(catalogIds.length >= 3, `Expected at least 3 catalog models, got: ${catalogIds.join(', ')}`);
  const [seedA, seedB, ...restIds] = catalogIds;

  const createFree = await postJson('/api/fallback-models', {
    id: 'free',
    models: [seedA, seedB]
  });
  assert.equal(createFree.response.status, 200, `could not author free chain: ${createFree.body?.error || createFree.text}`);
  const freeChain = [seedA, seedB];
  const freeSet = new Set(freeChain);

  const candidate = restIds.find((id) => !freeSet.has(id));
  assert.ok(candidate, 'Expected a served catalog model outside the free chain');

  // Toggle the candidate onto the free chain → appended at the end.
  const toggle = await postJson('/api/fallback-chain/toggle', {
    modelId: candidate,
    enabled: true,
    routeId: 'free'
  });
  assert.equal(toggle.response.status, 200);
  assert.equal(toggle.body?.success, true);
  assert.ok(String(toggle.body?.route?.id || '').endsWith('/free') || toggle.body?.route?.id === 'free');
  assert.equal(toggle.body.route.models.at(-1), candidate);
  assert.equal(toggle.body.route.models.length, freeChain.length + 1);

  // Reorder with a stale (incomplete) set on the free chain → 409.
  const staleFree = await postJson('/api/fallback-chain/reorder', {
    orderedIds: toggle.body.route.models.slice(0, -1),
    routeId: 'free'
  });
  assert.equal(staleFree.response.status, 409);

  // Reorder the free chain: move the toggled candidate to the front.
  const reordered = [candidate, ...freeChain];
  const reorder = await postJson('/api/fallback-chain/reorder', {
    orderedIds: reordered,
    routeId: 'free'
  });
  assert.equal(reorder.response.status, 200);
  assert.deepEqual(reorder.body?.route?.models, reordered);

  const afterReorder = await requestJson('/api/fallback-models');
  const freeAfter = (afterReorder.body?.data || []).find((route) => (
    route.routeId === 'free' || route.id === 'local-router/free'
  ));
  assert.deepEqual(freeAfter?.models, reordered);

  // Toggle the candidate back off the free chain.
  const toggleOff = await postJson('/api/fallback-chain/toggle', {
    modelId: candidate,
    enabled: false,
    routeId: 'free'
  });
  assert.equal(toggleOff.response.status, 200);
  assert.equal((toggleOff.body?.route?.models || []).includes(candidate), false);
  assert.deepEqual(toggleOff.body?.route?.models, freeChain);
});
