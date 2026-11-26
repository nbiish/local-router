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
  upstreamServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
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
  testHome = mkdtempSync(join(tmpdir(), 'local-router-floor-limits-test-'));
  const proxyEnv = {
    ...stripForeignProviderKeys(process.env, [`LOCALROUTER_${selectedProvider.keyEnvVar}`]),
    HOME: testHome,
    USERPROFILE: testHome,
    PORT: port,
    LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
    LOCAL_ROUTER_DEV: 'true',
    [`LOCALROUTER_${selectedProvider.keyEnvVar}`]: 'floor-limits-test-provider-key',
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

async function addMember(entry) {
  const { response, body } = await postJson(
    `/api/provider-models/${selectedProvider.name}/models`,
    entry
  );
  assert.equal(response.status, 200, `adding member failed: ${JSON.stringify(body)}`);
}

async function createRoute(routeId, members) {
  const { response, body } = await postJson('/api/fallback-models', { id: routeId, models: members });
  assert.equal(response.status, 200, `creating route failed: ${JSON.stringify(body)}`);
}

async function presentedEntry(routeId) {
  const { body: models } = await requestJson('/v1/models');
  const entry = (models.data || []).find((model) => model.id === `local-router/${routeId}`);
  assert.ok(entry, `expected local-router/${routeId} in /v1/models`);
  return entry;
}

test('a fallback route advertises the chain minimum on both wire surfaces', async (t) => {
  if (skipReason) return t.skip(skipReason);

  await addMember({ model: 'floor-big', id: 'floor-model-big', contextLength: 128000, outputTokens: 8192 });
  await addMember({ model: 'floor-small', id: 'floor-model-small', contextLength: 33000, outputTokens: 2048 });
  await createRoute('floor-test', ['floor-model-big', 'floor-model-small']);

  const entry = await presentedEntry('floor-test');
  assert.equal(entry.context_length, 33000, 'advertised context must be the chain minimum');
  assert.equal(entry.max_input_tokens, 33000, 'max_input_tokens must follow the context floor');
  assert.equal(entry.max_output_tokens, 2048, 'advertised output must be the chain minimum');
  assert.notEqual(entry.context_length, 128000, 'the ceiling aggregation must not return');

  const { body: tags } = await requestJson('/api/tags');
  const tag = (tags.models || []).find((model) => model.name === 'local-router/floor-test');
  assert.ok(tag, 'expected the route on the Ollama surface too');
  assert.equal(tag.details.context_length, 33000, 'Ollama surface must agree with the OpenAI surface');
});

test('a member with unknown specs does not lower the floor below the planner default', async (t) => {
  if (skipReason) return t.skip(skipReason);

  await addMember({ model: 'floor-unknown', id: 'floor-model-unknown' });
  await addMember({ model: 'floor-unknown-2', id: 'floor-model-unknown-2' });
  await createRoute('floor-test-unknown', ['floor-model-unknown', 'floor-model-unknown-2']);
  const unknownOnly = await presentedEntry('floor-test-unknown');
  assert.equal(unknownOnly.context_length, 64000, 'unknown specs mean the planner default (64000)');
  assert.equal(unknownOnly.max_output_tokens, 4096, 'unknown output means the default (4096)');

  await createRoute('floor-test-mixed', ['floor-model-big', 'floor-model-unknown']);
  const mixed = await presentedEntry('floor-test-mixed');
  assert.equal(mixed.context_length, 64000, 'a 128000 member and an unknown member floor at 64000');
  assert.equal(mixed.max_output_tokens, 4096);
});

test('disabling the small member raises the floor to the next smallest', async (t) => {
  if (skipReason) return t.skip(skipReason);

  await addMember({ model: 'floor-mid', id: 'floor-model-mid', contextLength: 90000, outputTokens: 5000 });
  await createRoute('floor-test-disabled', ['floor-model-big', 'floor-model-small', 'floor-model-mid']);
  const before = await presentedEntry('floor-test-disabled');
  assert.equal(before.context_length, 33000);

  await postJson('/api/fallback-models', {
    id: 'floor-test-disabled',
    models: ['floor-model-big', 'floor-model-small', 'floor-model-mid'],
    disabledModels: ['floor-model-small']
  });
  const after = await presentedEntry('floor-test-disabled');
  assert.equal(after.context_length, 90000, 'an operator-disabled member cannot serve, so it must not constrain');
  assert.equal(after.max_output_tokens, 5000);
});
