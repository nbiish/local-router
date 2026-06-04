import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(18100 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
const customProviderId = 'test-vendor';
const customKeyEnv = 'TEST_VENDOR_API_KEY';
const presentedAlias = 'test-vendor-demo';
const upstreamModelId = 'vendor-model-1';

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let upstreamRequests = [];
let serverLogs = '';
let skipReason = '';
let testHome = '';
let proxyEnv = {};

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
    const body = await readRequestBody(req);
    upstreamRequests.push({
      method: req.method,
      url: req.url,
      body
    });

    if (req.method === 'GET' && (req.url === '/models' || req.url === '/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{ id: upstreamModelId, object: 'model' }]
      }));
      return;
    }

    if (req.method === 'POST' && (req.url === '/chat/completions' || req.url === '/v1/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-custom',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `ok:${body.model}` },
          finish_reason: 'stop'
        }]
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
  upstreamBaseUrl = `http://127.0.0.1:${address.port}/v1`;
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
      // retry
    }
    await delay(100);
  }

  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

async function startProxyProcess() {
  serverLogs = '';
  upstreamRequests = [];
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

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }
  return { response, body };
}

test.before(async () => {
  if (process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') {
    skipReason = 'Sandbox network is disabled.';
    return;
  }

  await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-custom-provider-test-'));
  proxyEnv = {
    ...process.env,
    HOME: testHome,
    PORT: port,
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0'
  };

  try {
    await startProxyProcess();
  } catch (error) {
    if (/EPERM: operation not permitted/.test(serverLogs)) {
      skipReason = 'Sandbox blocks local socket listen.';
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

test('custom provider CRUD, chat routing, and delete guards', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const proxyEndpoints = await requestJson('/api/proxy-endpoints');
  assert.equal(proxyEndpoints.response.status, 200);
  assert.ok(Array.isArray(proxyEndpoints.body?.clientEndpoints));
  assert.ok(proxyEndpoints.body?.upstreamRequirements?.baseUrl);

  const create = await requestJson('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: customProviderId,
      displayName: 'Test Vendor',
      keyEnvVar: customKeyEnv,
      endpoint: upstreamBaseUrl,
      defaultTool: 'OpenAI Compatible'
    })
  });
  assert.equal(create.response.status, 201, JSON.stringify(create.body));

  const configs = await requestJson('/api/provider-configs');
  const customEntry = configs.body?.data?.find((entry) => entry.name === customProviderId);
  assert.ok(customEntry, 'custom provider appears in provider-configs');
  assert.equal(customEntry.isCustom, true);
  assert.equal(customEntry.endpoint, upstreamBaseUrl);

  const saveKey = await requestJson('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: customProviderId, apiKey: 'custom-integration-key' })
  });
  assert.equal(saveKey.response.status, 200);

  const upsertModel = await requestJson(`/api/provider-models/${encodeURIComponent(customProviderId)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: upstreamModelId,
      id: presentedAlias,
      contextLength: 32000,
      outputTokens: 4096,
      supportsTools: true
    })
  });
  assert.equal(upsertModel.response.status, 200);

  const upsertBackup = await requestJson(`/api/provider-models/${encodeURIComponent(customProviderId)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'vendor-model-2',
      id: 'test-vendor-backup',
      contextLength: 32000,
      outputTokens: 4096,
      supportsTools: true
    })
  });
  assert.equal(upsertBackup.response.status, 200);

  upstreamRequests = [];
  const chat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: `${customProviderId}/${presentedAlias}`,
      messages: [{ role: 'user', content: 'ping' }]
    })
  });
  assert.equal(chat.response.status, 200);
  assert.match(chat.body?.choices?.[0]?.message?.content || '', /ok:vendor-model-1/);

  assert.equal(upstreamRequests.length, 1);
  assert.ok(
    upstreamRequests[0].url === '/chat/completions' || upstreamRequests[0].url === '/v1/chat/completions',
    'expected upstream chat completions path'
  );
  assert.equal(upstreamRequests[0].body.model, upstreamModelId);

  const fallbackRoute = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'uses-custom-vendor',
      modelsText: `${customProviderId}/${presentedAlias}\n${customProviderId}/test-vendor-backup`
    })
  });
  assert.equal(fallbackRoute.response.status, 200);

  const blockedDelete = await requestJson(`/api/providers/${encodeURIComponent(customProviderId)}`, {
    method: 'DELETE'
  });
  assert.equal(blockedDelete.response.status, 409);
  assert.ok(Array.isArray(blockedDelete.body?.references));

  await requestJson('/api/fallback-models', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'uses-custom-vendor' })
  });

  const deleteProvider = await requestJson(`/api/providers/${encodeURIComponent(customProviderId)}?unsetKey=true`, {
    method: 'DELETE'
  });
  assert.equal(deleteProvider.response.status, 200);

  const configsAfter = await requestJson('/api/provider-configs');
  assert.ok(
    !configsAfter.body?.data?.some((entry) => entry.name === customProviderId),
    'custom provider removed from configs'
  );

  const registryPath = join(testHome, '.config', 'local-router', 'custom-providers.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  assert.ok(!registry.providers?.some((entry) => entry.name === customProviderId));
});

test('rejects duplicate catalog slug for custom provider', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const duplicate = await requestJson('/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'zenmux',
      keyEnvVar: 'ZENMUX_CUSTOM_API_KEY',
      endpoint: upstreamBaseUrl
    })
  });
  assert.equal(duplicate.response.status, 400);
  assert.match(duplicate.body?.error || '', /providers\.txt/i);
});
