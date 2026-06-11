import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
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
let selectedProvider;

function baselineProviderModelCount(providerName) {
  const content = readFileSync('providers.txt', 'utf8');
  let count = 0;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('# │')) continue;

    const columns = line
      .replace(/^#\s*/, '')
      .split('│')
      .map((part) => part.trim())
      .filter(Boolean);

    if (columns.length < 3) continue;
    if (!/^\d+$/.test(columns[0])) continue;
    if (columns[1] === providerName) count += 1;
  }

  return count;
}

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

  selectedProvider = firstProviderSummary();
  await startFakeUpstream();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-test-'));
  proxyEnv = {
    ...stripForeignProviderKeys(process.env, [selectedProvider.keyEnvVar]),
    HOME: testHome,
    PORT: port,
    LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
    [selectedProvider.keyEnvVar]: 'integration-test-provider-key',
    [providerBaseUrlEnvVar(selectedProvider.name)]: upstreamBaseUrl
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

  const bootstrappedFallbackRoutes = await requestJson('/api/fallback-models');
  assert.equal(bootstrappedFallbackRoutes.response.status, 200);
  assert.ok(
    bootstrappedFallbackRoutes.body?.data?.some((route) => route.routeId === 'fallback-models'),
    'Expected bootstrapped fallback-models system route on first run'
  );

  const bootstrappedRouterModels = await requestJson('/api/router-models');
  assert.equal(bootstrappedRouterModels.response.status, 200);
  assert.ok(
    bootstrappedRouterModels.body?.data?.some((route) => route.routeId === 'auto-router-main'),
    'Expected bootstrapped auto-router-main router on first run'
  );

  const autoRouter = bootstrappedRouterModels.body?.data?.find((route) => route.routeId === 'auto-router-main');
  const autoRouterCandidates = (autoRouter?.candidates || []).map((entry) => entry.model);
  assert.ok(
    autoRouterCandidates.includes('ollama-nemotron-3-ultra-cloud'),
    'auto-router-main should include Ollama Nemotron 3 Ultra cloud candidate'
  );
  assert.ok(
    autoRouterCandidates.includes('ollama-minimax-m3-cloud'),
    'auto-router-main should include Ollama MiniMax M3 cloud candidate'
  );
  assert.ok(
    autoRouterCandidates.includes('ollama-deepseek-v4-flash-cloud'),
    'auto-router-main should include Ollama DeepSeek V4 Flash cloud candidate'
  );
  const ollamaCloudCandidates = autoRouterCandidates.filter((id) => String(id).startsWith('ollama-'));
  assert.equal(
    ollamaCloudCandidates.length,
    3,
    `Expected exactly 3 Ollama cloud router candidates (shared quota), got: ${ollamaCloudCandidates.join(', ')}`
  );
  assert.equal(
    autoRouterCandidates.includes('ollama-qwen3.5-cloud'),
    false,
    'Pro-only Ollama Qwen 3.5 cloud should not be in default auto-router'
  );

  const systemFallback = bootstrappedFallbackRoutes.body?.data?.find((route) => route.routeId === 'fallback-models');
  const fallbackChain = systemFallback?.models || [];
  const expectedFallbackChain = [
    'ollama-nemotron-3-ultra-cloud',
    'nvidia-nim-minimax-m3',
    'cline-minimax-minimax-m3-free',
    'kilo-stepfun-step-3.7-flash-free',
    'opencode-zen-minimax-m3-free',
    'modal-glm-5.1-fp8',
    'antigravity-gemini-3.5-flash',
    'github-copilot-gemini-3.1-pro',
    'zai-code-pass-glm-5.1',
    'xiaomi-mimo-mimo-v2.5-pro',
    'pioneer-minimax-m3',
    'opencode-go-deepseek-v4-pro',
    'nebius-nemotron-3-ultra-550b-a55b',
    'commandcode-deepseek-v4-pro',
    'wafer-ai-deepseek-v4-flash',
    'kilo-minimax-minimax-m3-paid',
    'cline-deepseek-deepseek-v4-pro-paid',
    'zenmux-mimo-v2.5-pro',
    'openrouter-chain-of-draft',
    'openrouter-free'
  ];
  assert.deepEqual(
    fallbackChain,
    expectedFallbackChain,
    `fallback-models should match the fixed 18-step chain; got: ${fallbackChain.join(', ')}`
  );
  assert.ok(
    autoRouterCandidates.includes('openrouter-free'),
    'auto-router should include OpenRouter openrouter/free'
  );
  assert.ok(
    autoRouterCandidates.includes('cline-nvidia-nemotron-3-ultra-550b-a55b-free'),
    'auto-router should include curated Cline Nemotron Ultra free'
  );
  assert.ok(
    autoRouterCandidates.includes('cline-minimax-minimax-m3-free'),
    'auto-router should include curated Cline MiniMax M3 free'
  );
  assert.ok(
    autoRouterCandidates.includes('kilo-nvidia-nemotron-3-ultra-550b-a55b-free'),
    'auto-router should include curated Kilo Nemotron Ultra free'
  );
  assert.ok(
    autoRouterCandidates.includes('kilo-stepfun-step-3.7-flash-free'),
    'auto-router should include curated Kilo Step 3.7 Flash free'
  );
  assert.equal(
    autoRouterCandidates.includes('kilo-openrouter-free'),
    false,
    'auto-router should not include non-curated Kilo openrouter/free'
  );
  assert.equal(
    autoRouterCandidates.includes('cline-deepseek-deepseek-v4-flash-free'),
    false,
    'auto-router should not include non-curated Cline DeepSeek V4 Flash free'
  );
  assert.ok(
    autoRouterCandidates.includes('opencode-go-minimax-m3'),
    'auto-router should include OpenCode Go subscription models'
  );

  const firstRouterCandidate = autoRouterCandidates[0] || '';
  assert.ok(
    firstRouterCandidate.startsWith('ollama-'),
    'auto-router-main candidates should list Ollama tier first'
  );
  const routerKiloIdx = autoRouterCandidates.findIndex((id) => String(id).startsWith('kilo-'));
  const routerClineIdx = autoRouterCandidates.findIndex((id) => String(id).startsWith('cline-'));
  const routerOzenIdx = autoRouterCandidates.findIndex((id) => String(id).startsWith('opencode-zen-'));
  const routerOpencodeFreeIdx = autoRouterCandidates.findIndex((id) => (
    id === 'opencode-zen-minimax-m3-free'
  ));
  const routerOpencodeSubIdx = autoRouterCandidates.findIndex((id) => (
    id === 'opencode-go-deepseek-v4-pro'
  ));
  const routerZaiIdx = autoRouterCandidates.findIndex((id) => String(id).startsWith('zai-'));
  const routerXiaomiIdx = autoRouterCandidates.findIndex((id) => String(id).startsWith('xiaomi-mimo-'));
  const routerNvidiaIdx = autoRouterCandidates.findIndex((id) => String(id).startsWith('nvidia-nim-'));
  if (routerKiloIdx >= 0 && routerClineIdx >= 0) {
    assert.ok(routerKiloIdx < routerClineIdx, 'auto-router should list Kilo before Cline');
  }
  if (routerClineIdx >= 0 && routerOzenIdx >= 0) {
    assert.ok(routerClineIdx < routerOzenIdx, 'auto-router should list Cline before OpenCode Zen free');
  }
  if (routerOpencodeSubIdx >= 0 && routerOpencodeFreeIdx >= 0) {
    assert.ok(routerOpencodeSubIdx > routerOpencodeFreeIdx, 'auto-router should list OpenCode Go subscription after Zen free');
  }
  if (routerZaiIdx >= 0 && routerOpencodeSubIdx >= 0) {
    assert.ok(routerZaiIdx > routerOpencodeSubIdx, 'auto-router should list Z.ai after OpenCode Go subscription');
  }
  if (routerNvidiaIdx >= 0 && routerXiaomiIdx >= 0) {
    assert.ok(routerNvidiaIdx > routerXiaomiIdx, 'auto-router should list API-paid NVIDIA after subscription');
  }

  const providerPricing = await requestJson('/api/provider-pricing');
  assert.equal(providerPricing.response.status, 200);
  assert.ok(
    providerPricing.body?.models?.['zenmux-qwen3.7-max'],
    'Expected baseline zenmux-qwen3.7-max pricing in provider-pricing snapshot'
  );
  assert.equal(providerPricing.body.models['zenmux-qwen3.7-max'].inputPricePerM, 1.25);
  assert.equal(providerPricing.body.models['zenmux-qwen3.7-max'].outputPricePerM, 3.75);
  assert.ok(
    providerPricing.body?.models?.['openrouter-qwen3.7-max'],
    'Expected baseline openrouter-qwen3.7-max pricing in provider-pricing snapshot'
  );
  assert.equal(providerPricing.body.models['openrouter-qwen3.7-max'].inputPricePerM, 1.25);
  assert.equal(providerPricing.body.models['openrouter-qwen3.7-max'].outputPricePerM, 3.75);

  const pricingUpsert = await requestJson('/api/provider-pricing/test-promo-model', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputPricePerM: 1.11,
      outputPricePerM: 2.22,
      label: 'integration test promo'
    })
  });
  assert.equal(pricingUpsert.response.status, 200);
  assert.equal(pricingUpsert.body?.entry?.inputPricePerM, 1.11);

  const pricingAfterUpsert = await requestJson('/api/provider-pricing');
  assert.equal(
    pricingAfterUpsert.body?.models?.['test-promo-model']?.outputPricePerM,
    2.22
  );

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
  assert.equal(persistentFallbackSave.body?.model?.id, 'local-router/persistent-fallback-route');
  assert.equal(persistentFallbackSave.body?.model?.routeId, 'persistent-fallback-route');

  await restartProxyProcess();

  const persistedFallbackRoutes = await requestJson('/api/fallback-models');
  assert.equal(persistedFallbackRoutes.response.status, 200);
  assert.ok(
    persistedFallbackRoutes.body?.data?.some((route) => (
      route.id === 'local-router/persistent-fallback-route'
      && route.routeId === 'persistent-fallback-route'
    )),
    'Expected fallback route to survive proxy restart'
  );

  const persistedFallbackModelsList = await requestJson('/v1/models');
  assert.ok(
    persistedFallbackModelsList.body?.data?.some((model) => (
      model.id === 'local-router/persistent-fallback-route' && model.owned_by === 'local-router'
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

  const availability = await requestJson('/api/routing/availability?models=' + encodeURIComponent(`${presentedModel},zenmux-deepseek-v4-pro`));
  assert.equal(availability.response.status, 200);
  const readyAvailability = availability.body?.data?.find((entry) => entry.model === presentedModel);
  assert.equal(readyAvailability?.status, 'ready');
  assert.equal(readyAvailability?.keyConfigured, true);
  const missingKeyAvailability = availability.body?.data?.find((entry) => entry.model === 'zenmux-deepseek-v4-pro');
  assert.ok(missingKeyAvailability, 'Expected zenmux catalog model in availability response');
  assert.equal(missingKeyAvailability?.status, 'no_key');
  assert.equal(missingKeyAvailability?.keyConfigured, false);

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

  const providerConfigsForZeroEligible = await requestJson('/api/provider-configs');
  const unconfiguredProviderEntry = providerConfigsForZeroEligible.body?.data?.find((entry) => (
    !entry.configured && entry.modelCount > 0 && entry.name !== selectedProvider.name
  ));
  assert.ok(unconfiguredProviderEntry, 'Expected at least one unconfigured provider in catalog');

  const tagsForZeroEligible = await requestJson('/api/tags');
  const missingKeyCatalogModel = tagsForZeroEligible.body?.models?.find((model) => (
    model.details?.family === unconfiguredProviderEntry.name
    && !String(model.name).startsWith('local-router/')
  ));
  assert.ok(missingKeyCatalogModel, 'Expected catalog model from unconfigured provider');

  const zeroEligibleFallbackSave = await requestJson('/api/fallback-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'fallback-models',
      modelsText: [missingKeyCatalogModel.name, 'fallback-third-success'].join('\n')
    })
  });
  assert.equal(zeroEligibleFallbackSave.response.status, 200);

  const zeroEligibleRouterSave = await requestJson('/api/router-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 'zero-eligible-router',
      type: 'priority',
      candidatesText: missingKeyCatalogModel.name
    })
  });
  assert.equal(zeroEligibleRouterSave.response.status, 200);

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const zeroEligibleChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local-router/zero-eligible-router',
      stream: false,
      messages: [{ role: 'user', content: 'zero eligible cascade test' }]
    })
  });
  assert.equal(zeroEligibleChat.response.status, 200);
  assert.equal(zeroEligibleChat.body?.choices?.[0]?.message?.content, 'ok:success-third');
  const zeroEligibleUpstreamModels = upstreamRequests.map((entry) => entry?.body?.model).filter(Boolean);
  assert.ok(
    !zeroEligibleUpstreamModels.includes(missingKeyCatalogModel.model),
    'Unconfigured catalog model should be skipped without upstream calls'
  );
  assert.ok(zeroEligibleUpstreamModels.includes('success-third'));

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const fastSkipFallbackChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local-router/fallback-models',
      stream: false,
      messages: [{ role: 'user', content: 'fast skip fallback test' }]
    })
  });
  assert.equal(fastSkipFallbackChat.response.status, 200);
  assert.equal(fastSkipFallbackChat.body?.choices?.[0]?.message?.content, 'ok:success-third');
  const fastSkipUpstreamModels = upstreamRequests.map((entry) => entry?.body?.model).filter(Boolean);
  assert.equal(
    fastSkipUpstreamModels.filter((modelName) => modelName === missingKeyCatalogModel.model).length,
    0,
    'Fallback should fast-skip unconfigured provider without retry attempts'
  );
  assert.ok(fastSkipUpstreamModels.includes('success-third'));

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
  assert.equal(fallbackRouteSave.body?.model?.id, 'local-router/router-fallback-main');
  assert.equal(fallbackRouteSave.body?.model?.routeId, 'router-fallback-main');

  const fallbackRoutes = await requestJson('/api/fallback-models');
  assert.equal(fallbackRoutes.response.status, 200);
  assert.ok(
    fallbackRoutes.body?.data?.some((route) => (
      route.id === 'local-router/router-fallback-main'
      && route.routeId === 'router-fallback-main'
    )),
    'Expected fallback route in fallback list'
  );

  const modelsWithFallback = await requestJson('/v1/models');
  assert.ok(
    modelsWithFallback.body?.data?.some((entry) => (
      entry.id === 'local-router/router-fallback-main' && entry.owned_by === 'local-router'
    )),
    'Expected fallback route to appear in OpenAI-compatible model list'
  );

  const tagsWithFallback = await requestJson('/api/tags');
  assert.ok(
    tagsWithFallback.body?.models?.some((entry) => entry.name === 'local-router/router-fallback-main'),
    'Expected fallback route to appear in Ollama tags'
  );

  const fallbackShowPath = await requestJson('/api/show/local-router/router-fallback-main');
  assert.equal(fallbackShowPath.response.status, 200);
  assert.equal(fallbackShowPath.body?.details?.family, 'local-router');
  assert.equal(fallbackShowPath.body?.details?.parameter_size, 'local-router/router-fallback-main');
  assert.equal(fallbackShowPath.body?.model_info?.['general.basename'], 'local-router/router-fallback-main');

  const fallbackShowLatestPath = await requestJson('/api/show/local-router/router-fallback-main:latest');
  assert.equal(fallbackShowLatestPath.response.status, 200);
  assert.equal(fallbackShowLatestPath.body?.model_info?.['general.basename'], 'local-router/router-fallback-main');

  const fallbackShowLegacyPath = await requestJson('/api/show/fvs-code/router-fallback-main');
  assert.equal(fallbackShowLegacyPath.response.status, 200);
  assert.equal(fallbackShowLegacyPath.body?.model_info?.['general.basename'], 'local-router/router-fallback-main');

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const fallbackChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local-router/router-fallback-main',
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
      model: 'local-router/router-fallback-exhausted',
      stream: false,
      messages: [{ role: 'user', content: 'force fallback failure' }]
    })
  });
  assert.equal(fallbackExhausted.response.status, 503);
  assert.equal(Array.isArray(fallbackExhausted.body?.fallback?.attempts), true);
  assert.equal(fallbackExhausted.body?.fallback?.attempts?.length, 12);
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
  assert.equal(routerRouteSave.body?.model?.id, 'local-router/pareto-router-main');
  assert.equal(routerRouteSave.body?.model?.routeId, 'pareto-router-main');

  const routerRoutes = await requestJson('/api/router-models');
  assert.equal(routerRoutes.response.status, 200);
  assert.ok(
    routerRoutes.body?.data?.some((route) => (
      route.id === 'local-router/pareto-router-main'
      && route.routeId === 'pareto-router-main'
      && route.type === 'pareto-code'
    )),
    'Expected router route in router list'
  );

  const modelsWithRouter = await requestJson('/v1/models');
  assert.ok(
    modelsWithRouter.body?.data?.some((entry) => (
      entry.id === 'local-router/pareto-router-main' && entry.owned_by === 'local-router'
    )),
    'Expected router route to appear in OpenAI-compatible model list'
  );

  const routerShowPath = await requestJson('/api/show/local-router/pareto-router-main');
  assert.equal(routerShowPath.response.status, 200);
  assert.equal(routerShowPath.body?.details?.family, 'local-router');
  assert.equal(routerShowPath.body?.details?.parameter_size, 'local-router/pareto-router-main');
  assert.equal(routerShowPath.body?.model_info?.['general.basename'], 'local-router/pareto-router-main');

  const routerShowLegacyPath = await requestJson('/api/show/fvs-code/pareto-router-main');
  assert.equal(routerShowLegacyPath.response.status, 200);
  assert.equal(routerShowLegacyPath.body?.model_info?.['general.basename'], 'local-router/pareto-router-main');

  upstreamRequests = [];
  upstreamAttemptByModel = new Map();
  const routerChat = await requestJson('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local-router/pareto-router-main',
      stream: false,
      messages: [{ role: 'user', content: 'router route test' }]
    })
  });
  assert.equal(routerChat.response.status, 200);
  assert.equal(routerChat.body?.choices?.[0]?.message?.content, 'ok:success-third');
  assert.deepEqual(
    upstreamRequests.map((entry) => entry?.body?.model).filter(Boolean),
    [
      'fail-always-first',
      'fail-always-first',
      'fail-always-first',
      'fail-always-first',
      'success-third'
    ]
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
  assert.ok(routerCandidatesText.includes('local-router/pareto-router-main'));

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
  assert.ok(importBody.imported.includes('local-router/pareto-router-main'));
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
  await requestJson(`/api/provider-models/${selectedProvider.name}/models`, {
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
      model: 'local-router/cascade-router',
      stream: false,
      messages: [{ role: 'user', content: 'cascade test' }]
    })
  });
  assert.equal(cascadeChat.response.status, 200);
  // Should have succeeded via system fallback cascade — upstream model is deepseek-v4-pro
  assert.ok(cascadeChat.body?.choices?.[0]?.message?.content?.startsWith('ok:'));

  // Verify the cascade: router candidates were tried (and failed), then fallback succeeded
  const cascadeUpstreamOrder = upstreamRequests.map((entry) => entry?.body?.model).filter(Boolean);
  assert.ok(cascadeUpstreamOrder.includes('fail-always-first'));
  // Fallback model should appear after the router candidates
  const firstRouterIdx = cascadeUpstreamOrder.indexOf('fail-always-first');
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

  await requestJson('/api/thinking-level', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, global: 'none' })
  });

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
  assert.ok(JSON.stringify(forwarded?.messages).includes('reasoning_content'));
  assert.ok(JSON.stringify(forwarded?.messages).includes('redacted_thinking'));
  assert.ok(JSON.stringify(forwarded?.messages).includes('must not be replayed'));
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

  const modelSourceInitial = await requestJson('/api/model-source');
  assert.equal(modelSourceInitial.response.status, 200);
  assert.equal(modelSourceInitial.body?.source, 'custom');

  const refreshEndpoints = await requestJson('/api/refresh-endpoint-models', {
    method: 'POST'
  });
  assert.equal(refreshEndpoints.response.status, 200);
  assert.equal(refreshEndpoints.body?.success, true);
  assert.ok(refreshEndpoints.body?.count > 0, 'Expected endpoint refresh to return models');
  assert.ok(
    refreshEndpoints.body?.data?.some((model) => model.model === 'endpoint-only-model'),
    'Expected endpoint-only model from fake upstream'
  );

  const switchToEndpoints = await requestJson('/api/model-source', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'endpoints' })
  });
  assert.equal(switchToEndpoints.response.status, 200);
  assert.equal(switchToEndpoints.body?.source, 'endpoints');

  const endpointCatalog = await requestJson('/v1/models');
  assert.equal(endpointCatalog.response.status, 200);
  assert.ok(
    endpointCatalog.body?.data?.some((model) => model.id.includes('endpoint-only-model')),
    'Expected endpoint-only model in OpenAI-compatible catalog'
  );

  const endpointTags = await requestJson('/api/tags');
  assert.equal(endpointTags.response.status, 200);
  assert.ok(
    endpointTags.body?.models?.some((model) => model.name.includes('endpoint-only-model')),
    'Expected endpoint-only model in Ollama tags'
  );

  await restartProxyProcess();

  const persistedModelSource = await requestJson('/api/model-source');
  assert.equal(persistedModelSource.response.status, 200);
  assert.equal(persistedModelSource.body?.source, 'endpoints');

  const persistedEndpointCatalog = await requestJson('/v1/models');
  assert.ok(
    persistedEndpointCatalog.body?.data?.some((model) => model.id.includes('endpoint-only-model')),
    'Expected endpoint cache to survive proxy restart'
  );

  const switchToCustom = await requestJson('/api/model-source', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'custom' })
  });
  assert.equal(switchToCustom.response.status, 200);
  assert.equal(switchToCustom.body?.source, 'custom');

  const customCatalog = await requestJson('/v1/models');
  assert.equal(
    customCatalog.body?.data?.some((model) => model.id.includes('endpoint-only-model')),
    false,
    'Endpoint-only model should not appear when custom source is active'
  );

  const invalidModelSource = await requestJson('/api/model-source', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'invalid' })
  });
  assert.equal(invalidModelSource.response.status, 400);

  const providerCatalog = await requestJson(`/api/provider-models/${encodeURIComponent(selectedProvider.name)}`);
  assert.equal(providerCatalog.response.status, 200);
  const customProviderCount = (providerCatalog.body?.models || []).length;
  assert.ok(customProviderCount > 0, 'Expected custom provider catalog models');

  const filteredProviderModels = await requestJson(
    `/v1/models?provider=${encodeURIComponent(selectedProvider.name)}`
  );
  assert.equal(filteredProviderModels.response.status, 200);
  assert.equal(
    (filteredProviderModels.body?.data || []).length,
    customProviderCount,
    'Per-provider /v1/models should match custom catalog count in custom mode'
  );
  assert.equal(
    filteredProviderModels.body?.data?.some((model) => String(model.id).includes('endpoint-only-model')),
    false,
    'Endpoint-only upstream model must not leak in custom catalog mode'
  );

  const liveProviderModels = await requestJson(
    `/v1/models?provider=${encodeURIComponent(selectedProvider.name)}&live=true`
  );
  assert.equal(liveProviderModels.response.status, 200);
  assert.ok(
    liveProviderModels.body?.data?.some((model) => String(model.id).includes('endpoint-only-model')),
    'Expected live upstream model when ?live=true'
  );

  const fullCatalogModels = await requestJson('/v1/models');
  assert.equal(fullCatalogModels.response.status, 200);
  assert.equal(
    fullCatalogModels.body?.catalog_mode,
    'custom',
    'Unfiltered /v1/models should report custom catalog_mode'
  );
  assert.equal(
    fullCatalogModels.body?.data?.some((model) => String(model.id).includes('endpoint-only-model')),
    false,
    'Custom catalog mode must not expose endpoint-cache models on /v1/models'
  );

  const liveFullCatalog = await requestJson('/v1/models?live=true');
  assert.equal(liveFullCatalog.response.status, 200);
  assert.equal(
    liveFullCatalog.body?.data?.some((model) => String(model.id).includes('endpoint-only-model')),
    false,
    'Custom mode must not expand to all provider endpoints on /v1/models?live=true'
  );

  const catalogAll = await requestJson('/api/provider-models?catalog=all');
  assert.equal(catalogAll.response.status, 200);
  const allFlat = (catalogAll.body?.data || []).flatMap((entry) => entry.models || []);
  assert.equal(
    allFlat.some((model) => String(model.id).includes('endpoint-only-model')),
    false,
    'catalog=all must not union endpoint cache while custom source is active'
  );

  const catalogActive = await requestJson('/api/provider-models?catalog=active');
  assert.equal(catalogActive.response.status, 200);
  const activeFlat = (catalogActive.body?.data || []).flatMap((entry) => entry.models || []);
  assert.equal(
    activeFlat.some((model) => String(model.id).includes('endpoint-only-model')),
    false,
    'catalog=active must follow custom source, not endpoint cache'
  );

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

test('provider-models catalog query supports custom and all modes', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const custom = await requestJson('/api/provider-models?catalog=custom');
  assert.equal(custom.response.status, 200);
  assert.equal(custom.body?.catalog, 'custom');
  const customCount = (custom.body?.data || []).reduce(
    (sum, entry) => sum + (entry.models?.length || 0),
    0
  );
  assert.ok(customCount > 0, 'Expected custom catalog models');

  const all = await requestJson('/api/provider-models?catalog=all');
  assert.equal(all.response.status, 200);
  assert.equal(all.body?.catalog, 'all');
  const allCount = (all.body?.data || []).reduce(
    (sum, entry) => sum + (entry.models?.length || 0),
    0
  );
  assert.ok(allCount >= customCount, 'All catalog should include custom models');

  const active = await requestJson('/api/provider-models?catalog=active');
  assert.equal(active.response.status, 200);
  assert.equal(active.body?.catalog, 'active');
});

test('gateway providers custom catalog stays on providers.txt baseline', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const modelSource = await requestJson('/api/model-source');
  assert.equal(modelSource.response.status, 200);
  assert.equal(modelSource.body?.source, 'custom');

  const configs = await requestJson('/api/provider-configs');
  assert.equal(configs.response.status, 200);

  for (const providerName of ['kilo', 'cline']) {
    const baselineCount = baselineProviderModelCount(providerName);
    assert.ok(baselineCount > 0, `Expected ${providerName} models in providers.txt`);

    const provider = configs.body?.data?.find((entry) => entry?.name === providerName);
    assert.ok(provider, `Expected ${providerName} in provider configs`);
    assert.equal(
      provider.modelCount,
      baselineCount,
      `${providerName} custom catalog must not merge live upstream models`
    );
  }

  const kiloModels = await requestJson('/api/provider-models/kilo');
  assert.equal(kiloModels.response.status, 200);
  assert.equal(
    (kiloModels.body?.models || []).length,
    baselineProviderModelCount('kilo'),
    'GET /api/provider-models/kilo must list providers.txt only in custom mode'
  );
});

test('ollama provider is always configured with default Local Router API key', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const configs = await requestJson('/api/provider-configs');
  assert.equal(configs.response.status, 200);
  const ollama = (configs.body?.data || []).find((entry) => entry?.name === 'ollama');
  assert.ok(ollama, 'Expected ollama provider in configs');
  assert.equal(ollama.configured, true);
  assert.equal(ollama.configuredSource, 'default');

  const arbitraryKey = await requestJson('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'ollama', apiKey: 'any-test-key-value' })
  });
  assert.equal(arbitraryKey.response.status, 200);
  assert.equal(arbitraryKey.body?.configured, true);

  const resetKey = await requestJson('/api/keys/ollama', { method: 'DELETE' });
  assert.equal(resetKey.response.status, 200);
  assert.equal(resetKey.body?.configured, true);
  assert.equal(resetKey.body?.placeholder, true);
  assert.equal(resetKey.body?.defaultKey, 'local-router-ollama');

  const routerCheck = await requestJson('/api/routing/availability');
  const ollamaCandidate = (routerCheck.body?.candidates || []).find((entry) => (
    String(entry?.model || '').startsWith('ollama-')
  ));
  if (ollamaCandidate) {
    assert.equal(ollamaCandidate.status, 'ready', 'Ollama cloud candidates should be router-ready without paid API keys');
  }
});

test('localrouter CLI lists models and inspects routers against running server', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const cliPath = fileURLToPath(new URL('../bin/localrouter.js', import.meta.url));
  const cliEnv = {
    ...process.env,
    LOCAL_ROUTER_HOST: '127.0.0.1',
    LOCAL_ROUTER_PORT: port
  };

  const list = spawnSync(process.execPath, [cliPath, 'list', '--custom', '--json'], {
    encoding: 'utf8',
    env: cliEnv
  });
  assert.equal(list.status, 0, list.stderr || list.stdout);
  const listPayload = JSON.parse(list.stdout);
  assert.equal(listPayload.catalog, 'custom');
  assert.ok(Array.isArray(listPayload.models));
  assert.ok(listPayload.models.length > 0);

  const routers = spawnSync(process.execPath, [cliPath, 'router', 'list', '--json'], {
    encoding: 'utf8',
    env: cliEnv
  });
  assert.equal(routers.status, 0, routers.stderr || routers.stdout);
  const routerPayload = JSON.parse(routers.stdout);
  assert.ok(Array.isArray(routerPayload.routers));
  assert.ok(routerPayload.routers.length > 0, 'Expected default router bootstrap');
  assert.ok(
    routerPayload.routers.some((route) => route.candidates.length > 0),
    'Expected router candidates in CLI output'
  );
});

test('separate OPENCODE_API_KEY and OPENCODE_ZEN_API_KEY apply to opencode-go and opencode-zen', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const goKey = 'opencode-go-integration-key';
  const saveGo = await requestJson('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'opencode-go', apiKey: goKey })
  });
  assert.equal(saveGo.response.status, 200);
  assert.deepEqual(
    new Set(saveGo.body?.sharedProviders || []),
    new Set(['opencode-go'])
  );

  const zenKey = 'opencode-zen-integration-key';
  const saveZen = await requestJson('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'opencode-zen', apiKey: zenKey })
  });
  assert.equal(saveZen.response.status, 200);
  assert.deepEqual(
    new Set(saveZen.body?.sharedProviders || []),
    new Set(['opencode-zen'])
  );

  const configs = await requestJson('/api/provider-configs');
  assert.equal(configs.response.status, 200);
  
  const entryGo = configs.body?.data?.find((item) => item.name === 'opencode-go');
  assert.ok(entryGo);
  assert.equal(entryGo.configured, true);

  const entryZen = configs.body?.data?.find((item) => item.name === 'opencode-zen');
  assert.ok(entryZen);
  assert.equal(entryZen.configured, true);

  const resetGo = await requestJson('/api/keys/opencode-go', { method: 'DELETE' });
  assert.equal(resetGo.response.status, 200);

  const configsAfter = await requestJson('/api/provider-configs');
  const entryGoAfter = configsAfter.body?.data?.find((item) => item.name === 'opencode-go');
  assert.equal(entryGoAfter.configured, false);

  const entryZenAfter = configsAfter.body?.data?.find((item) => item.name === 'opencode-zen');
  assert.equal(entryZenAfter.configured, true);

  await requestJson('/api/keys/opencode-zen', { method: 'DELETE' });
});

test('router export and import via CLI', async (t) => {
  if (skipReason) {
    t.skip(skipReason);
    return;
  }

  const cliPath = fileURLToPath(new URL('../bin/localrouter.js', import.meta.url));
  const cliEnv = {
    ...process.env,
    LOCAL_ROUTER_HOST: '127.0.0.1',
    LOCAL_ROUTER_PORT: port
  };

  // 1. Test CLI export
  const exportRes = spawnSync(process.execPath, [cliPath, 'router', 'export', '--json'], {
    encoding: 'utf8',
    env: cliEnv
  });
  assert.equal(exportRes.status, 0, exportRes.stderr || exportRes.stdout);
  const exportedRouters = JSON.parse(exportRes.stdout);
  assert.ok(Array.isArray(exportedRouters));
  assert.ok(exportedRouters.length > 0);

  // Find auto-router-main
  const targetRouter = exportedRouters.find((r) => r.routeId === 'auto-router-main' || r.id === 'local-router/auto-router-main');
  assert.ok(targetRouter);

  // 2. Modify exported router id and candidates to import it as a new router
  const importedRouterId = 'imported-test-router';
  const importedRouter = {
    ...targetRouter,
    id: importedRouterId,
    routeId: importedRouterId,
    candidatesText: 'wafer-serverless/GLM-5.1'
  };

  const tempFile = join(tmpdir(), 'imported-test-router.json');
  writeFileSync(tempFile, JSON.stringify([importedRouter]));

  // 3. Test CLI import
  const importRes = spawnSync(process.execPath, [cliPath, 'router', 'import', tempFile, '--json'], {
    encoding: 'utf8',
    env: cliEnv
  });
  assert.equal(importRes.status, 0, importRes.stderr || importRes.stdout);
  const importPayload = JSON.parse(importRes.stdout);
  assert.equal(importPayload.success, true);
  assert.ok(importPayload.imported.includes(`local-router/${importedRouterId}`));

  // 4. Verify via GET /api/router-models
  const routerList = await requestJson('/api/router-models');
  assert.equal(routerList.response.status, 200);
  const found = routerList.body?.data?.find((r) => r.routeId === importedRouterId);
  assert.ok(found);

  // Cleanup
  try {
    unlinkSync(tempFile);
  } catch (err) {}
  await requestJson('/api/router-models', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: importedRouterId })
  });
});

