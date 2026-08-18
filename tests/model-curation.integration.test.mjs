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

  // Curation defaults to disabled with an empty selection.
  const initial = await requestJson('/api/model-curation');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body?.curationEnabled, false);
  assert.equal(initial.body?.selectedCount, 0);

  // Switch to endpoint models and port everything.
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

  // Disabling curation restores the full ported catalog.
  const disable = await requestJson('/api/model-curation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(disable.response.status, 200);
  assert.equal(disable.body?.curationEnabled, false);

  const uncensored = await requestJson('/v1/models');
  const uncensoredIds = (uncensored.body?.data || []).map((model) => model.id);
  assert.ok(uncensoredIds.includes(dropModel.id), 'Disabling curation must restore uncurated model');
});
