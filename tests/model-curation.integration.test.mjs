import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(17000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let serverLogs = '';
let skipReason = '';
let testHome = '';
let proxyEnv = {};
let configuredProvider;

function firstProviderSummary() {
  // Reuse providers.txt parsing without importing server code: find the first
  // 3-column summary row (name │ endpoint │ key env var).
  const content = readFileSync('providers.txt', 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('# │')) continue;

    const columns = line
      .replace(/^#\s*/, '')
      .split('│')
      .map((part) => part.trim())
      .filter(Boolean);

    if (columns.length !== 3) continue;
    const [name, endpoint, keyEnvVar] = columns;
    if (!name || name.toLowerCase() === 'provider') continue;
    if (!/^https?:\/\//.test(endpoint)) continue;
    if (!/^[A-Z0-9_]+_API_KEY$/.test(keyEnvVar)) continue;

    return { name, keyEnvVar };
  }

  throw new Error('Expected at least one provider summary in providers.txt');
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

async function readRequestBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    try {
      await readRequestBody(req);

      if (req.method === 'GET' && req.url === '/models') {
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
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
  });

  await new Promise((resolve, reject) => {
    upstreamServer.once('error', reject);
    upstreamServer.listen(0, '127.0.0.1', resolve);
  });

  const address = upstreamServer.address();
  return `http://127.0.0.1:${address.port}/v1`;
}

async function waitForServerReady() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess?.exitCode !== null) {
      throw new Error(`Server exited before becoming ready.\nLogs:\n${serverLogs}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until server is ready.
    }
    await delay(100);
  }

  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

async function startProxyProcess() {
  serverLogs = '';
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: proxyEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });
  serverProcess.stderr.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });

  await waitForServerReady();
}

async function stopProxyProcess() {
  if (!serverProcess || serverProcess.killed || serverProcess.exitCode !== null) return;

  serverProcess.kill('SIGTERM');
  await once(serverProcess, 'exit').catch(() => undefined);
}

async function restartProxyProcess() {
  await stopProxyProcess();
  await startProxyProcess();
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

test.before(async () => {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    skipReason = 'Sandbox network is disabled; run integration tests in a normal local shell.';
    return;
  }

  configuredProvider = firstProviderSummary();
  const upstreamBaseUrl = await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-curation-'));
  proxyEnv = {
    ...stripForeignProviderKeys(process.env, [configuredProvider.keyEnvVar]),
    HOME: testHome,
    PORT: port,
    LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
    LOCAL_ROUTER_DEV: 'true',
    [configuredProvider.keyEnvVar]: 'integration-test-provider-key',
    [providerBaseUrlEnvVar(configuredProvider.name)]: upstreamBaseUrl
  };

  try {
    await startProxyProcess();
  } catch (error) {
    if (/EPERM: operation not permitted/.test(serverLogs)) {
      skipReason = 'Sandbox blocks local socket listen (EPERM); run this integration test outside sandbox.';
      return;
    }
    throw error;
  }
});

test.after(async () => {
  await stopProxyProcess();

  if (upstreamServer) {
    await new Promise((resolve) => upstreamServer.close(resolve));
  }

  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

function pickCurationGroup(data) {
  if (!Array.isArray(data)) return null;

  const configuredGroup = data.find((group) => group?.provider === configuredProvider.name);
  if (configuredGroup?.models?.length > 0) return configuredGroup;

  const ollamaGroup = data.find((group) => group?.provider === 'ollama');
  if (ollamaGroup?.models?.length > 1) return ollamaGroup;

  const nonEmpty = data.find((group) => group?.models?.length > 1);
  return nonEmpty || null;
}

test('model curation lifecycle: port all, curate subset, filter serving, persist', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  // Rename check: provider catalog exposes `openrouter`, never `openrouter-presets`.
  const providerConfigs = await requestJson('/api/provider-configs');
  assert.equal(providerConfigs.response.status, 200);
  const providerNames = (providerConfigs.body?.data || []).map((entry) => entry.name);
  assert.ok(providerNames.includes('openrouter'), 'Expected canonical openrouter provider');
  assert.ok(!providerNames.includes('openrouter-presets'), 'Legacy openrouter-presets slug must not be a provider');

  // Legacy slug still resolves through the canonical alias.
  const legacyLookup = await requestJson('/api/provider-models/openrouter-presets');
  assert.equal(legacyLookup.response.status, 200);
  assert.equal(legacyLookup.body?.provider, 'openrouter');

  // Single-catalog regime: curation is always on and the boot migration has
  // pre-checked every legacy catalog row into the toggle store.
  const initial = await requestJson('/api/model-curation');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body?.curationEnabled, true);
  assert.ok(initial.body?.selectedCount > 0, 'Migration must pre-check legacy rows');

  // The mode switch is gone; PUT endpoints is an accepted no-op.
  const switchSource = await requestJson('/api/model-source', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'endpoints' })
  });
  assert.equal(switchSource.response.status, 200);

  const refresh = await requestJson('/api/refresh-endpoint-models', { method: 'POST' });
  assert.equal(refresh.response.status, 200);
  assert.ok(refresh.body?.count > 0, 'Expected endpoint refresh to port models');

  const ported = await requestJson('/api/model-curation');
  assert.equal(ported.response.status, 200);
  assert.ok(ported.body?.totalModels > 0, 'Expected ported endpoint models in curation catalog');
  assert.equal(ported.body?.source, 'endpoints');
  const group = pickCurationGroup(ported.body?.data);
  assert.ok(group, 'Expected at least one provider group with models');

  const keepModel = group.models[0];
  const dropModel = group.models[group.models.length - 1];
  assert.notEqual(keepModel.model, dropModel.model, 'Need two distinct models to curate between');

  // Validation rejects malformed payloads.
  const invalidPayload = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: 'yes' })
  });
  assert.equal(invalidPayload.response.status, 400);

  const invalidKeys = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedKeys: ['no-double-colon'] })
  });
  assert.equal(invalidKeys.response.status, 400);

  // Curate: serve only the checked model from this group.
  const curate = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled: true,
      selectedKeys: [`${group.provider}::${keepModel.model}`]
    })
  });
  assert.equal(curate.response.status, 200);
  assert.equal(curate.body?.curationEnabled, true);
  assert.equal(curate.body?.selectedCount, 1);

  const served = await requestJson('/v1/models');
  assert.equal(served.response.status, 200);
  const servedIds = (served.body?.data || []).map((model) => model.id);
  assert.ok(servedIds.includes(keepModel.id), 'Curated model must be served');
  assert.ok(!servedIds.includes(dropModel.id), 'Uncurated model from same provider must be hidden');

  const tags = await requestJson('/api/tags');
  assert.equal(tags.response.status, 200);
  const tagNames = (tags.body?.models || []).map((model) => model.name);
  assert.ok(tagNames.includes(keepModel.id), 'Curated model must appear in Ollama tags');
  assert.ok(!tagNames.includes(dropModel.id), 'Uncurated model must be hidden from Ollama tags');

  // Curation survives a restart (persisted model-source config + cache).
  await restartProxyProcess();

  const reloaded = await requestJson('/api/model-curation');
  assert.equal(reloaded.response.status, 200);
  assert.equal(reloaded.body?.curationEnabled, true);
  assert.equal(reloaded.body?.selectedCount, 1);
  assert.equal(reloaded.body?.totalModels, ported.body.totalModels);

  const servedAfterRestart = await requestJson('/v1/models');
  const servedAfterRestartIds = (servedAfterRestart.body?.data || []).map((model) => model.id);
  assert.ok(servedAfterRestartIds.includes(keepModel.id), 'Curated model still served after restart');
  assert.ok(!servedAfterRestartIds.includes(dropModel.id), 'Uncurated model still hidden after restart');

  // Curation can no longer be disabled (single catalog); re-selecting the
  // dropped model restores it instead.
  const disable = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disable.response.status, 200);
  assert.equal(disable.body?.curationEnabled, true, 'Curation is always on');

  const reselect = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      selectedKeys: [`${group.provider}::${keepModel.model}`, `${group.provider}::${dropModel.model}`]
    })
  });
  assert.equal(reselect.response.status, 200);

  const uncensored = await requestJson('/v1/models');
  const uncensoredIds = (uncensored.body?.data || []).map((model) => model.id);
  assert.ok(uncensoredIds.includes(dropModel.id), 'Re-toggling must restore the dropped model');
  assert.ok(uncensoredIds.includes(keepModel.id), 'Re-toggling must keep the kept model');
});

test('per-provider curation: refresh, seed catalog matches, key auto-discovery, activate gates serving', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const headers = { 'Content-Type': 'application/json' };
  const providerName = configuredProvider.name;

  // Reset selection left by the lifecycle test (curation stays on).
  const reset = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ selectedKeys: [] })
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body?.selectedCount, 0);
  assert.equal(reset.body?.curationEnabled, true);

  // Unknown providers are rejected.
  const unknown = await requestJson('/api/provider-models/no-such-provider/refresh', { method: 'POST' });
  assert.equal(unknown.response.status, 404);

  // Per-provider refresh returns a model list (live upstream when reachable,
  // static providers.txt catalog otherwise — both are valid refresh sources).
  const refresh = await requestJson(`/api/provider-models/${providerName}/refresh`, { method: 'POST' });
  assert.equal(refresh.response.status, 200);
  assert.equal(refresh.body?.provider, providerName);
  const refreshedModels = refresh.body?.data || [];
  assert.ok(refreshedModels.length >= 2, 'Expected at least two models to curate between');
  assert.equal(refresh.body?.count, refreshedModels.length);
  assert.ok(
    ['live', 'registry', 'catalog'].includes(refresh.body?.source),
    'refresh must report an honest source'
  );

  // Registry providers (no upstream /models API) return the curated registry
  // with an honest source label — never a silent static-catalog masquerade.
  const zaiRefresh = await requestJson('/api/provider-models/zai/refresh', { method: 'POST' });
  assert.equal(zaiRefresh.response.status, 200);
  assert.equal(zaiRefresh.body?.source, 'registry');
  assert.ok(zaiRefresh.body?.note?.includes('registry'), 'Registry note must be surfaced');
  const zaiIds = (zaiRefresh.body?.data || []).map((model) => model.model);
  assert.ok(zaiIds.includes('GLM-5.3'), 'zai registry must list GLM-5.3');
  assert.ok(zaiIds.includes('GLM-4.7'), 'zai registry must list GLM-4.7');
  const clineRefresh = await requestJson('/api/provider-models/cline/refresh', { method: 'POST' });
  assert.equal(clineRefresh.response.status, 200);
  assert.equal(clineRefresh.body?.source, 'registry');
  const clineIds = (clineRefresh.body?.data || []).map((model) => model.model);
  assert.ok(clineIds.includes('moonshotai/kimi-k3'), 'cline registry must list kimi-k3');
  assert.ok(clineRefresh.body?.count > 11, 'cline registry must exceed the old static rows');

  // Post-migration: legacy rows are pre-checked at boot, so first-refresh
  // seeding is a no-op and every legacy row for the provider stays selected.
  const catalogModelIds = new Set(
    readFileSync('providers.legacy-catalog.txt', 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('# │'))
      .map((line) => line.replace(/^#\s*/, '').split('│').map((part) => part.trim()).filter(Boolean))
      .filter((columns) => columns.length >= 4 && /^\d+$/.test(columns[0]))
      .filter((columns) => columns[1] === providerName)
      .map((columns) => columns[2])
  );
  const expectedSeeded = refreshedModels.filter((model) => catalogModelIds.has(model.model));
  assert.ok(expectedSeeded.length > 0, 'Expected legacy rows in the refreshed fallback');
  assert.equal(
    refresh.body?.seededCount,
    expectedSeeded.length,
    'Empty selection: first refresh re-checks every toggle-store match'
  );

  const curated = await requestJson('/api/model-curation');
  assert.equal(curated.response.status, 200);
  const providerPrefix = `${providerName}::`;
  const providerKeys = new Set(
    (curated.body?.selectedKeys || []).filter((key) => key.startsWith(providerPrefix))
  );
  for (const model of expectedSeeded) {
    assert.ok(
      providerKeys.has(`${providerName}::${model.model}`),
      `Migration must keep ${model.model} pre-checked`
    );
  }

  // Saving a key auto-discovers that provider's live models.
  const keySave = await requestJson('/api/keys', {
    method: 'POST',
    headers,
    body: JSON.stringify({ provider: providerName, apiKey: 'integration-test-provider-key-2' })
  });
  assert.equal(keySave.response.status, 200);
  assert.ok(keySave.body?.configured);
  assert.equal(keySave.body?.discovered?.count, refreshedModels.length);
  assert.equal((keySave.body?.discovered?.models || []).length, refreshedModels.length);
  assert.equal(keySave.body?.discovered?.seededCount, 0, 'existing selection must not be re-seeded');

  // activate must be a boolean.
  const badActivate = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers,
    body: JSON.stringify({ activate: 'yes' })
  });
  assert.equal(badActivate.response.status, 400);

  // Activate: switch to endpoints curation serving only the selected model.
  const keep = refreshedModels[0];
  const drop = refreshedModels[refreshedModels.length - 1];
  assert.notEqual(keep.model, drop.model, 'Need two distinct models to curate between');

  const activate = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      activate: true,
      selectedKeys: [`${providerName}::${keep.model}`]
    })
  });
  assert.equal(activate.response.status, 200);
  assert.equal(activate.body?.curationEnabled, true);
  assert.equal(activate.body?.selectedCount, 1);

  const source = await requestJson('/api/model-source');
  assert.equal(source.body?.source, 'endpoints');

  const served = await requestJson('/v1/models');
  assert.equal(served.response.status, 200);
  const servedIds = (served.body?.data || []).map((model) => model.id);
  assert.ok(servedIds.includes(keep.id), 'Activated per-provider selection must be served');
  assert.ok(!servedIds.includes(drop.id), 'Unselected model from same provider must be hidden');
});
