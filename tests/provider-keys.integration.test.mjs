import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(18000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let upstreamRequests = [];
let upstreamAttemptByModel = new Map();
let serverLogs = '';
let skipReason = '';
let testHome = '';
let proxyEnv = {};

function firstProviderSummary() {
  const content = readFileSync('providers.txt', 'utf8');

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('# │')) continue;

    const columns = line
      .replace(/^#\s*/, '')
      .split('│')
      .map((part) => part.trim())
      .filter(Boolean);

    if (columns.length !== 4) continue;

    const [name, endpoint, keyEnvVar] = columns;
    if (!name || name.toLowerCase() === 'provider') continue;
    if (!/^https?:\/\//.test(endpoint)) continue;
    if (!/^[A-Z0-9_]+_API_KEY$/.test(keyEnvVar)) continue;

    return { name, keyEnvVar };
  }

  throw new Error('Expected at least one provider summary in providers.txt');
}

function providerBaseUrlEnvVar(providerName) {
  return `FVS_PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
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
      const body = await readRequestBody(req);
      const upstreamModel = typeof body?.model === 'string' ? body.model : '';
      const attemptCount = (upstreamAttemptByModel.get(upstreamModel) || 0) + 1;
      upstreamAttemptByModel.set(upstreamModel, attemptCount);

      upstreamRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
        attemptCount
      });

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (upstreamModel.includes('fail-always')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: 'upstream unavailable',
          model: upstreamModel,
          attempt: attemptCount
        }));
        return;
      }

      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"choices":[{"delta":{"reasoning_content":"hidden-stream"}}]}\n\n');
        res.write(`data: {"choices":[{"delta":{"content":"stream-ok:${upstreamModel}"},"finish_reason":null}]}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      const message = {
        role: 'assistant',
        content: `ok:${upstreamModel}`,
        reasoning_content: 'hidden-response'
      };
      if (Array.isArray(body.tools)) {
        message.tool_calls = [{
          id: 'call_test',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"README.md"}'
          }
        }];
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message,
          finish_reason: 'stop'
        }]
      }));
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
  if (!address || typeof address === 'string') {
    throw new Error('Expected fake upstream to listen on a TCP port');
  }

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

  const firstProvider = firstProviderSummary();
  await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'fvs-code-test-'));
  proxyEnv = {
    ...process.env,
    HOME: testHome,
    PORT: port,
    FVS_FALLBACK_BASE_RETRY_SECONDS: '0',
    [firstProvider.keyEnvVar]: 'integration-test-provider-key',
    [providerBaseUrlEnvVar(firstProvider.name)]: upstreamBaseUrl
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

test('provider key save/reset lifecycle exposes configured source', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const heartbeat = await fetch(`${baseUrl}/`);
  assert.equal(heartbeat.status, 200);
  assert.equal(await heartbeat.text(), 'Ollama is running');

  const versionHead = await fetch(`${baseUrl}/api/version`, { method: 'HEAD' });
  assert.equal(versionHead.status, 200);

  const tags = await requestJson('/api/tags');
  assert.equal(tags.response.status, 200);
  assert.ok(Array.isArray(tags.body?.models), 'Expected Ollama tags model list');
  assert.ok(tags.body.models.length > 0, 'Expected at least one Ollama tag');
  assert.equal(typeof tags.body.models[0].name, 'string');
  assert.equal(typeof tags.body.models[0].model, 'string');
  assert.equal(typeof tags.body.models[0].details?.family, 'string');
  assert.ok(tags.body.models[0].details?.context_length > 0);
  assert.ok(tags.body.models[0].max_output_tokens > 0);

  const ps = await requestJson('/api/ps');
  assert.equal(ps.response.status, 200);
  assert.deepEqual(ps.body, { models: [] });

  const show = await requestJson('/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: tags.body.models[0].name })
  });
  assert.equal(show.response.status, 200);
  assert.equal(show.body?.details?.family, tags.body.models[0].details.family);
  assert.equal(show.body?.details?.parameter_size, tags.body.models[0].name);
  assert.equal(show.body?.model_info?.['general.basename'], tags.body.models[0].name);
  assert.equal(show.body?.model_info?.['general.name'], tags.body.models[0].name);
  assert.equal(show.body?.capabilities?.[0], 'completion');
  assert.equal(typeof show.body?.model_info?.context_length, 'number');

  const persistentFallbackModels = tags.body.models.slice(0, 2).map((model) => model.name);
  assert.equal(persistentFallbackModels.length, 2);

  const persistentFallbackSave = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'persistent-fallback-route',
      models: persistentFallbackModels
    })
  });
  assert.equal(persistentFallbackSave.response.status, 200);
  assert.equal(persistentFallbackSave.body?.success, true);
  assert.equal(persistentFallbackSave.body?.persisted, true);
  assert.equal(persistentFallbackSave.body?.model?.id, 'fvs-code/persistent-fallback-route');
  assert.equal(persistentFallbackSave.body?.model?.routeId, 'persistent-fallback-route');

  await restartProxyProcess();

  const persistedFallbackRoutes = await requestJson('/api/fallback-models');
  assert.equal(persistedFallbackRoutes.response.status, 200);
  assert.ok(
    persistedFallbackRoutes.body?.data?.some((route) => (
      route.id === 'fvs-code/persistent-fallback-route'
      && route.routeId === 'persistent-fallback-route'
    )),
    'Expected fallback route to survive proxy restart'
  );

  const persistedFallbackModelsList = await requestJson('/v1/models');
  assert.ok(
    persistedFallbackModelsList.body?.data?.some((model) => (
      model.id === 'fvs-code/persistent-fallback-route' && model.owned_by === 'fvs-code'
    )),
    'Expected persisted fallback route in OpenAI-compatible models after restart'
  );

  const initial = await requestJson('/api/provider-configs');
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body?.object, 'list');
  assert.ok(Array.isArray(initial.body?.data), 'Expected provider list');
  assert.ok(initial.body.data.length > 0, 'Expected at least one provider from providers.txt');

  const provider = initial.body.data[0];
  assert.equal(typeof provider.name, 'string');
  assert.equal(typeof provider.keyEnvVar, 'string');
  assert.equal(typeof provider.configured, 'boolean');
  assert.ok(['memory', 'env', 'none'].includes(provider.configuredSource));
  assert.equal(provider.modelSource, 'baseline');
  assert.ok(provider.modelCount > 0);

  const diagnosticsInitial = await requestJson('/api/diagnostics');
  assert.equal(diagnosticsInitial.response.status, 200);
  assert.equal(diagnosticsInitial.body?.enabled, false);

  const diagnosticsEnable = await requestJson('/api/diagnostics', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true })
  });
  assert.equal(diagnosticsEnable.response.status, 200);
  assert.equal(diagnosticsEnable.body?.enabled, true);

  const modelSave = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelsText: 'deepseek-v4-pro:custom-presented-1, upstream/provider-required-2:friendly/custom-two, prefixed/provider-required-3:provider/custom-three'
    })
  });
  assert.equal(modelSave.response.status, 200);
  assert.equal(modelSave.body?.success, true);
  assert.equal(modelSave.body?.source, 'memory');
  assert.equal(modelSave.body?.models?.length, 3);
  assert.equal(modelSave.body?.models?.[0]?.model, 'deepseek-v4-pro');
  assert.equal(modelSave.body?.models?.[0]?.id, 'custom-presented-1');
  assert.equal(modelSave.body?.models?.[0]?.contextLength, 64000);
  assert.equal(modelSave.body?.models?.[0]?.outputTokens, 4096);

  const afterModelSave = await requestJson('/api/provider-configs');
  const modelConfiguredProvider = afterModelSave.body?.data?.find((item) => item.name === provider.name);
  assert.equal(modelConfiguredProvider?.modelSource, 'memory');
  assert.equal(modelConfiguredProvider?.modelCount, 3);

  const singleModelSave = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'vision/provider-required-4',
      id: 'vision-presented-4',
      contextLength: 123456,
      outputTokens: 7890,
      supportsTools: true,
      supportsImages: true,
      supportsCache: false,
      supportsReasoning: false
    })
  });
  assert.equal(singleModelSave.response.status, 200);
  assert.equal(singleModelSave.body?.success, true);
  assert.equal(singleModelSave.body?.model?.id, 'vision-presented-4');
  assert.equal(singleModelSave.body?.model?.supportsImages, true);

  const tagsWithVisionModel = await requestJson('/api/tags');
  const addedVisionModel = tagsWithVisionModel.body?.models?.find((model) => model?.name === 'vision-presented-4');
  assert.ok(addedVisionModel, 'Expected one-at-a-time added model in Ollama tags');
  assert.equal(addedVisionModel?.context_length, 123456);
  assert.equal(addedVisionModel?.max_output_tokens, 7890);
  assert.ok(Array.isArray(addedVisionModel?.capabilities));
  assert.ok(addedVisionModel.capabilities.includes('vision'));

  const singleModelDelete = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}/models/${encodeURIComponent('vision-presented-4')}`, {
    method: 'DELETE'
  });
  assert.equal(singleModelDelete.response.status, 200);
  assert.equal(singleModelDelete.body?.success, true);
  assert.equal(singleModelDelete.body?.removed, 'vision-presented-4');

  const tagsAfterModelSave = await requestJson('/api/tags');
  const presentedModel = 'custom-presented-1';
  const presentedModelDisplayAlias = modelSave.body?.models?.[0]?.display;
  assert.ok(
    tagsAfterModelSave.body?.models?.some((model) => model.name === presentedModel),
    'Expected custom provider model to appear in Ollama tags'
  );

  const openAiModelsAfterSave = await requestJson('/v1/models');
  assert.ok(
    openAiModelsAfterSave.body?.data?.some((model) => model.id === presentedModel),
    'Expected custom provider model to appear in OpenAI-compatible models'
  );

  const customShow = await requestJson('/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: presentedModel })
  });
  assert.equal(customShow.response.status, 200);
  assert.equal(customShow.body?.details?.family, provider.name);
  assert.equal(customShow.body?.details?.context_length, 64000);
  assert.equal(customShow.body?.details?.parameter_size, presentedModel);
  assert.equal(customShow.body?.model_info?.['general.basename'], presentedModel);
  assert.equal(customShow.body?.model_info?.['general.upstream_model'], 'deepseek-v4-pro');
  assert.ok(customShow.body?.capabilities?.includes('tools'));

  const customShowDisplayAlias = await requestJson('/api/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: presentedModelDisplayAlias })
  });
  assert.equal(customShowDisplayAlias.response.status, 200);
  assert.equal(customShowDisplayAlias.body?.model_info?.['general.basename'], presentedModel);

  const fallbackPrimaryA = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fail-always-first',
      id: 'fallback-first-fail',
      contextLength: 64000,
      outputTokens: 4096,
      supportsTools: true,
      supportsImages: false,
      supportsCache: false,
      supportsReasoning: false
    })
  });
  assert.equal(fallbackPrimaryA.response.status, 200);

  const fallbackPrimaryB = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fail-always-second',
      id: 'fallback-second-fail',
      contextLength: 64000,
      outputTokens: 4096,
      supportsTools: true,
      supportsImages: false,
      supportsCache: false,
      supportsReasoning: false
    })
  });
  assert.equal(fallbackPrimaryB.response.status, 200);

  const fallbackPrimaryC = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'success-third',
      id: 'fallback-third-success',
      contextLength: 64000,
      outputTokens: 4096,
      supportsTools: true,
      supportsImages: false,
      supportsCache: false,
      supportsReasoning: false
    })
  });
  assert.equal(fallbackPrimaryC.response.status, 200);

  const fallbackRouteSave = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'router-fallback-main',
      models: ['fallback-first-fail', 'fallback-second-fail', 'fallback-third-success']
    })
  });
  assert.equal(fallbackRouteSave.response.status, 200);
  assert.equal(fallbackRouteSave.body?.success, true);
  assert.equal(fallbackRouteSave.body?.model?.id, 'fvs-code/router-fallback-main');
  assert.equal(fallbackRouteSave.body?.model?.routeId, 'router-fallback-main');

  const fallbackRoutes = await requestJson('/api/fallback-models');
  assert.equal(fallbackRoutes.response.status, 200);
  assert.ok(
    fallbackRoutes.body?.data?.some((route) => (
      route.id === 'fvs-code/router-fallback-main'
      && route.routeId === 'router-fallback-main'
    )),
    'Expected fallback route in fallback list'
  );

  const modelsWithFallback = await requestJson('/v1/models');
  assert.ok(
    modelsWithFallback.body?.data?.some((entry) => (
      entry.id === 'fvs-code/router-fallback-main' && entry.owned_by === 'fvs-code'
    )),
    'Expected fallback route to appear in OpenAI-compatible model list'
  );

  const tagsWithFallback = await requestJson('/api/tags');
  assert.ok(
    tagsWithFallback.body?.models?.some((entry) => entry.name === 'fvs-code/router-fallback-main'),
    'Expected fallback route to appear in Ollama tags'
  );

  const fallbackShowPath = await requestJson('/api/show/fvs-code/router-fallback-main');
  assert.equal(fallbackShowPath.response.status, 200);
  assert.equal(fallbackShowPath.body?.details?.family, 'fvs-code');
  assert.equal(fallbackShowPath.body?.details?.parameter_size, 'fvs-code/router-fallback-main');
  assert.equal(fallbackShowPath.body?.model_info?.['general.basename'], 'fvs-code/router-fallback-main');

  const fallbackShowLatestPath = await requestJson('/api/show/fvs-code/router-fallback-main:latest');
  assert.equal(fallbackShowLatestPath.response.status, 200);
  assert.equal(fallbackShowLatestPath.body?.model_info?.['general.basename'], 'fvs-code/router-fallback-main');

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const fallbackChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fvs-code/router-fallback-main',
      stream: false,
      messages: [{ role: 'user', content: 'fallback route test' }]
    })
  });
  assert.equal(fallbackChat.response.status, 200);
  assert.equal(fallbackChat.body?.choices?.[0]?.message?.content, 'ok:success-third');

  const fallbackUpstreamOrder = upstreamRequests.map((entry) => entry?.body?.model).filter(Boolean);
  assert.deepEqual(fallbackUpstreamOrder, [
    'fail-always-first',
    'fail-always-first',
    'fail-always-first',
    'fail-always-second',
    'fail-always-second',
    'fail-always-second',
    'fail-always-first',
    'fail-always-second',
    'success-third'
  ]);

  const fallbackFailThird = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fail-always-third',
      id: 'fallback-third-fail',
      contextLength: 64000,
      outputTokens: 4096,
      supportsTools: true,
      supportsImages: false,
      supportsCache: false,
      supportsReasoning: false
    })
  });
  assert.equal(fallbackFailThird.response.status, 200);

  const fallbackExhaustedRoute = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'router-fallback-exhausted',
      models: ['fallback-first-fail', 'fallback-second-fail', 'fallback-third-fail']
    })
  });
  assert.equal(fallbackExhaustedRoute.response.status, 200);

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const fallbackExhausted = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fvs-code/router-fallback-exhausted',
      stream: false,
      messages: [{ role: 'user', content: 'force fallback failure' }]
    })
  });
  assert.equal(fallbackExhausted.response.status, 503);
  assert.equal(Array.isArray(fallbackExhausted.body?.fallback?.attempts), true);
  assert.equal(fallbackExhausted.body?.fallback?.attempts?.length, 11);
  assert.ok(
    fallbackExhausted.body?.fallback?.attempts?.some((attempt) => Object.hasOwn(attempt, 'waitBeforeRetrySeconds')),
    'Expected retry wait info in fallback failure payload'
  );
  assert.ok(
    fallbackExhausted.body?.fallback?.attempts?.some((attempt) => String(attempt?.providerErrorPreview || '').includes('upstream unavailable')),
    'Expected provider error preview in fallback failure payload'
  );

  const routerRouteSave = await requestJson('/api/router-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'pareto-router-main',
      type: 'pareto-code',
      minCodingScore: 0.66,
      candidatesText: [
        'fallback-first-fail, coding=0.70, input=1, output=2, latency=2000',
        'fallback-third-success, coding=0.92, input=3, output=6, latency=1500'
      ].join('\n')
    })
  });
  assert.equal(routerRouteSave.response.status, 200);
  assert.equal(routerRouteSave.body?.success, true);
  assert.equal(routerRouteSave.body?.persisted, true);
  assert.equal(routerRouteSave.body?.model?.id, 'fvs-code/pareto-router-main');
  assert.equal(routerRouteSave.body?.model?.routeId, 'pareto-router-main');

  const routerRoutes = await requestJson('/api/router-models');
  assert.equal(routerRoutes.response.status, 200);
  assert.ok(
    routerRoutes.body?.data?.some((route) => (
      route.id === 'fvs-code/pareto-router-main'
      && route.routeId === 'pareto-router-main'
      && route.type === 'pareto-code'
    )),
    'Expected router route in router list'
  );

  const modelsWithRouter = await requestJson('/v1/models');
  assert.ok(
    modelsWithRouter.body?.data?.some((entry) => (
      entry.id === 'fvs-code/pareto-router-main' && entry.owned_by === 'fvs-code'
    )),
    'Expected router route to appear in OpenAI-compatible model list'
  );

  const routerShowPath = await requestJson('/api/show/fvs-code/pareto-router-main');
  assert.equal(routerShowPath.response.status, 200);
  assert.equal(routerShowPath.body?.details?.family, 'fvs-code');
  assert.equal(routerShowPath.body?.details?.parameter_size, 'fvs-code/pareto-router-main');
  assert.equal(routerShowPath.body?.model_info?.['general.basename'], 'fvs-code/pareto-router-main');

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const routerChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fvs-code/pareto-router-main',
      stream: false,
      messages: [{ role: 'user', content: 'router route test' }]
    })
  });
  assert.equal(routerChat.response.status, 200);
  assert.equal(routerChat.body?.choices?.[0]?.message?.content, 'ok:success-third');
  assert.deepEqual(
    upstreamRequests.map((entry) => entry?.body?.model).filter(Boolean),
    ['success-third']
  );

  const routerEvents = await fetch(`${baseUrl}/api/router-events.csv`);
  assert.equal(routerEvents.status, 200);
  const routerEventsText = await routerEvents.text();
  assert.ok(routerEventsText.includes('pareto-router-main'));
  assert.ok(routerEventsText.includes('fallback-third-success'));
  assert.equal(routerEventsText.includes('router route test'), false);

  const routerCandidates = await fetch(`${baseUrl}/api/router-candidates.csv`);
  assert.equal(routerCandidates.status, 200);
  const routerCandidatesText = await routerCandidates.text();
  assert.ok(routerCandidatesText.includes('router_id,presented_model,router_type,candidate_model'));
  assert.ok(routerCandidatesText.includes('fvs-code/pareto-router-main'));

  // Router recompute pipeline
  const recomputeRes = await fetch(`${baseUrl}/api/router-models/pareto-router-main/recompute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  assert.equal(recomputeRes.status, 200);
  const recomputeBody = await recomputeRes.json();
  assert.ok(typeof recomputeBody.totalSampleCount === 'number');
  assert.ok(Array.isArray(recomputeBody.proposals));
  assert.ok(typeof recomputeBody.recommendation === 'string');
  assert.equal(recomputeBody.router.routeId, 'pareto-router-main');
  // At least one proposal should reference the candidate models
  const proposalModels = recomputeBody.proposals.map((p) => p.model);
  assert.ok(proposalModels.includes('fallback-first-fail') || proposalModels.includes('fallback-third-success'));

  // Router import/export round-trip
  const routerExportRes = await fetch(`${baseUrl}/api/router-models`);
  assert.equal(routerExportRes.status, 200);
  const routerExportBody = await routerExportRes.json();
  const routersForImport = (routerExportBody.data || []).filter((r) => r.routeId === 'pareto-router-main');
  assert.equal(routersForImport.length, 1);

  const importRes = await fetch(`${baseUrl}/api/router-models/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ routers: routersForImport, overwrite: true })
  });
  assert.equal(importRes.status, 200);
  const importBody = await importRes.json();
  assert.equal(importBody.success, true);
  assert.ok(importBody.imported.includes('fvs-code/pareto-router-main'));
  assert.equal(importBody.errors.length, 0);

  // Remove the existing persistent-fallback-route so findSystemFallback picks up ours
  await requestJson('/api/fallback-models', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'persistent-fallback-route' })
  });

  // System fallback cascade: router exhausts → cascades to fallback
  const cascadeRouterSave = await requestJson('/api/router-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'cascade-router',
      type: 'priority',
      candidatesText: 'fallback-first-fail\nfallback-second-fail'
    })
  });
  assert.equal(cascadeRouterSave.response.status, 200);

  // Add a second model to the test provider for the fallback cascade
  await requestJson(`/api/provider-models/${firstProvider.name}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'second-cascade-model',
      id: 'cascade-fallback-target',
      contextLength: 64000,
      outputTokens: 4096,
      supportsTools: true,
      supportsImages: false,
      supportsCache: false,
      supportsReasoning: false
    })
  });

  const cascadeFallbackSave = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'fallback-models',
      modelsText: ['custom-presented-1', 'cascade-fallback-target'].join('\n')
    })
  });
  assert.equal(cascadeFallbackSave.response.status, 200);

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const cascadeChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fvs-code/cascade-router',
      stream: false,
      messages: [{ role: 'user', content: 'cascade test' }]
    })
  });
  assert.equal(cascadeChat.response.status, 200);
  // Should have succeeded via system fallback cascade — upstream model is deepseek-v4-pro
  assert.ok(cascadeChat.body?.choices?.[0]?.message?.content?.startsWith('ok:'));

  // Verify the cascade: router candidates were tried (and failed), then fallback succeeded
  const cascadeUpstreamOrder = upstreamRequests.map((entry) => entry?.body?.model).filter(Boolean);
  assert.ok(cascadeUpstreamOrder.includes('fallback-first-fail'));
  // Fallback model should appear after the router candidates
  const firstRouterIdx = cascadeUpstreamOrder.indexOf('fallback-first-fail');
  const fallbackSuccessIdx = cascadeUpstreamOrder.findIndex((m) => !m.includes('fail-always') && !m.startsWith('fallback-'));
  assert.ok(fallbackSuccessIdx >= 0, 'System fallback candidate should appear in upstream order');
  assert.ok(fallbackSuccessIdx > firstRouterIdx, 'System fallback should be tried after router candidates fail');

  // Clean up cascade test routes
  await requestJson('/api/router-models', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'cascade-router' })
  });
  await requestJson('/api/fallback-models', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'fallback-models' })
  });

  const fallbackRouteDelete = await requestJson('/api/fallback-models', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'router-fallback-exhausted' })
  });
  assert.equal(fallbackRouteDelete.response.status, 200);
  assert.equal(fallbackRouteDelete.body?.success, true);

  upstreamRequests = [];
  const sanitizedChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: presentedModel,
      stream: false,
      messages: [
        { role: 'user', content: 'first' },
        {
          role: 'assistant',
          content: 'prior',
          reasoning_content: 'must not be replayed',
          redacted_thinking: 'must not be replayed'
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'next' },
            { type: 'thinking', thinking: 'must not be replayed' }
          ]
        }
      ],
      thinking: { type: 'enabled', budget_tokens: 2048 },
      reasoning_effort: 'high',
      enable_thinking: true,
      extra_body: {
        chat_template_kwargs: {
          thinking: true,
          enable_thinking: true,
          reasoning_budget: 2048
        }
      }
    })
  });
  assert.equal(sanitizedChat.response.status, 200);
  assert.equal(sanitizedChat.body?.choices?.[0]?.message?.content, 'ok:deepseek-v4-pro');
  assert.ok(!JSON.stringify(sanitizedChat.body).includes('reasoning_content'));

  const forwarded = upstreamRequests.at(-1)?.body;
  assert.equal(forwarded?.model, 'deepseek-v4-pro');
  assert.deepEqual(forwarded?.thinking, { type: 'disabled' });
  assert.equal(forwarded?.reasoning_effort, 'none');
  assert.equal(forwarded?.enable_thinking, false);
  assert.ok(!JSON.stringify(forwarded?.messages).includes('reasoning_content'));
  assert.ok(!JSON.stringify(forwarded?.messages).includes('redacted_thinking'));
  assert.ok(!JSON.stringify(forwarded?.messages).includes('must not be replayed'));
  assert.equal(forwarded?.extra_body?.chat_template_kwargs?.thinking, false);
  assert.equal(forwarded?.extra_body?.chat_template_kwargs?.enable_thinking, false);
  assert.equal(
    Object.hasOwn(forwarded?.extra_body?.chat_template_kwargs || {}, 'reasoning_budget'),
    false
  );

  const diagnosticsAfterChat = await requestJson('/api/diagnostics');
  assert.equal(diagnosticsAfterChat.response.status, 200);
  assert.equal(diagnosticsAfterChat.body?.enabled, true);
  const diagnosticRequestEntry = diagnosticsAfterChat.body?.entries?.find((entry) => (
    entry?.event === 'proxy_request' && entry?.presentedModel === presentedModel
  ));
  assert.ok(diagnosticRequestEntry, 'Expected proxy_request diagnostic entry');
  assert.equal(typeof diagnosticRequestEntry?.data?.request?.messageSummary?.count, 'number');
  const diagnosticsSerialized = JSON.stringify(diagnosticsAfterChat.body);
  assert.equal(diagnosticsSerialized.includes('must not be replayed'), false);
  assert.equal(diagnosticsSerialized.includes('integration-test-key'), false);
  assert.equal(diagnosticsSerialized.includes('hidden-response'), false);

  const streamResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: presentedModel,
      stream: true,
      messages: [{ role: 'user', content: 'stream test' }]
    })
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.ok(streamText.includes('stream-ok'));
  assert.ok(!streamText.includes('reasoning_content'));
  assert.ok(!streamText.includes('hidden-stream'));

  upstreamRequests = [];
  const ollamaChat = await requestJson('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: presentedModel,
      stream: false,
      messages: [{
        role: 'user',
        content: 'describe',
        images: ['aW1hZ2UtYnl0ZXM=']
      }],
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' }
            }
          }
        }
      }],
      format: 'json',
      options: {
        num_predict: 128,
        temperature: 0.2
      }
    })
  });
  assert.equal(ollamaChat.response.status, 200);
  assert.equal(ollamaChat.body?.message?.tool_calls?.[0]?.function?.name, 'read_file');
  assert.equal(ollamaChat.body?.message?.tool_calls?.[0]?.function?.arguments?.path, 'README.md');

  const forwardedOllama = upstreamRequests.at(-1)?.body;
  assert.equal(forwardedOllama?.model, 'deepseek-v4-pro');
  assert.equal(forwardedOllama?.max_tokens, 128);
  assert.equal(forwardedOllama?.temperature, 0.2);
  assert.equal(forwardedOllama?.response_format?.type, 'json_object');
  assert.ok(Array.isArray(forwardedOllama?.tools));
  assert.equal(forwardedOllama?.messages?.[0]?.content?.[1]?.type, 'image_url');
  assert.ok(forwardedOllama?.messages?.[0]?.content?.[1]?.image_url?.url.startsWith('data:image/png;base64,'));

  const invalidModels = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelsText: 'invalid model with spaces' })
  });
  assert.equal(invalidModels.response.status, 400);

  const oldPipeModels = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelsText: 'deepseek-v4-pro | old-pipe-format' })
  });
  assert.equal(oldPipeModels.response.status, 400);

  const modelReset = await requestJson(`/api/provider-models/${encodeURIComponent(provider.name)}`, {
    method: 'DELETE'
  });
  assert.equal(modelReset.response.status, 200);
  assert.equal(modelReset.body?.success, true);
  assert.equal(modelReset.body?.source, 'baseline');

  const invalidSave = await requestJson('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 123, apiKey: 'x' })
  });
  assert.equal(invalidSave.response.status, 400);

  const save = await requestJson('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: provider.name, apiKey: 'integration-test-key' })
  });
  assert.equal(save.response.status, 200);
  assert.equal(save.body?.success, true);
  assert.equal(save.body?.provider, provider.name);
  assert.equal(save.body?.configured, true);
  assert.equal(save.body?.configuredSource, 'memory');

  const afterSave = await requestJson('/api/provider-configs');
  assert.equal(afterSave.response.status, 200);
  const savedProvider = afterSave.body?.data?.find((item) => item.name === provider.name);
  assert.ok(savedProvider, 'Expected saved provider to remain listed');
  assert.equal(savedProvider.configured, true);
  assert.equal(savedProvider.configuredSource, 'memory');

  const reset = await requestJson(`/api/keys/${encodeURIComponent(provider.name)}`, {
    method: 'DELETE'
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body?.success, true);
  assert.equal(reset.body?.configured, false);
  assert.equal(reset.body?.configuredSource, 'none');

  const afterReset = await requestJson('/api/provider-configs');
  assert.equal(afterReset.response.status, 200);
  const resetProvider = afterReset.body?.data?.find((item) => item.name === provider.name);
  assert.ok(resetProvider, 'Expected provider after reset');
  assert.equal(resetProvider.configured, false);
  assert.equal(resetProvider.configuredSource, 'none');

  const unknown = await requestJson('/api/keys/__missing_provider__', {
    method: 'DELETE'
  });
  assert.equal(unknown.response.status, 404);

  const diagnosticsDisable = await requestJson('/api/diagnostics', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false })
  });
  assert.equal(diagnosticsDisable.response.status, 200);
  assert.equal(diagnosticsDisable.body?.enabled, false);
});
