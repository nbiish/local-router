import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Capability advertisement contract.
 *
 * A harness that offers a thinking mode decides whether to show it by reading the model's
 * advertised capabilities. StarNet gates its per-agent `reasoningEffort` selector on
 * `capabilities.reasoning` from `/v1/models`, so a false there removes the control entirely —
 * even when the upstream model reasons and bills reasoning tokens.
 *
 * Measured 2026-11-07 against ZenMux `deepseek/deepseek-v4.1-flash`, the upstream catalog says
 *   capabilities: { reasoning: true }, max_tokens: 384000, input_modalities: ["image","text"]
 * while the router advertised reasoning=false, max_output_tokens=4096, imageInput=false. The
 * discovery parser read only `wafer.*` capability paths and did not know `max_tokens` at all.
 */

// Exactly the shape ZenMux's /v1/models returns.
const ZENMUX_STYLE_MODEL = {
  id: 'deepseek/deepseek-v4.1-flash',
  object: 'model',
  display_name: 'DeepSeek: DeepSeek V4.1 Flash 1017',
  owned_by: 'deepseek',
  input_modalities: ['image', 'text'],
  output_modalities: ['text'],
  capabilities: { reasoning: true },
  context_length: 1000000,
  max_tokens: 384000
};

// Exactly the shape OpenRouter's /v1/models returns. Note there is NO boolean reasoning flag:
// capability is expressed by listing parameters, and vision by architecture.input_modalities.
const OPENROUTER_STYLE_MODEL = {
  id: 'deepseek/deepseek-v4.1-flash',
  object: 'model',
  name: 'DeepSeek: DeepSeek V4.1 Flash',
  context_length: 1048576,
  architecture: {
    modality: 'text+image->text',
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    tokenizer: 'DeepSeek',
    instruct_type: null
  },
  top_provider: { context_length: 1048576, max_completion_tokens: 393216, is_moderated: false },
  supported_parameters: [
    'frequency_penalty',
    'include_reasoning',
    'max_tokens',
    'reasoning',
    'reasoning_effort',
    'temperature',
    'tools'
  ]
};

async function bootRouter(t, { model = ZENMUX_STYLE_MODEL, providerName = 'mock-zen', staleOverrides } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'local-router-caps-'));
  const upstreams = [];

  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [model] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreams.push(upstream);
  const upstreamPort = upstream.address().port;

  const configDir = join(home, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'custom-providers.json'), JSON.stringify({
    version: 1,
    providers: [{
      name: providerName,
      displayName: 'Mock provider',
      endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
      keyEnvVar: 'MOCK_ZEN_API_KEY',
      defaultTool: 'OpenAI Compatible',
      createdAt: new Date().toISOString()
    }]
  }, null, 2));
  writeFileSync(join(configDir, 'router-settings.json'), JSON.stringify({ routes: [] }, null, 2));
  // A persisted per-provider override that predates a discovery fix. `effectiveProviderModels`
  // prefers this store over the cache, so it shadows a correct refresh unless reconciled.
  if (staleOverrides) {
    writeFileSync(join(configDir, 'provider-models.json'), JSON.stringify({
      version: 1,
      overrides: [{ provider: providerName, models: staleOverrides }]
    }, null, 2));
  }
  return bootRouterFromHome(t, { home, providerName, upstreams });
}

async function bootRouterFromHome(t, { home, providerName, upstreams }) {
  const port = String(28300 + Math.floor(Math.random() * 400));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PORT: port,
      MOCK_ZEN_API_KEY: 'test-key',
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => undefined);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    for (const server of upstreams) await new Promise((r) => server.close(r));
    rmSync(home, { recursive: true, force: true });
  });

  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${baseUrl}/api/version`)).ok) break; } catch { /* not up yet */ }
    await delay(100);
  }
  return { baseUrl, logs: () => logs, home };
}

async function discoverAndCurate(baseUrl, providerName, upstreamModelId) {
  const refresh = await fetch(`${baseUrl}/api/provider-models/${providerName}/refresh`, { method: 'POST' });
  assert.ok(refresh.ok, `refresh failed: ${refresh.status}`);
  const curate = await fetch(`${baseUrl}/api/model-curation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedKeys: [`${providerName}::${upstreamModelId}`], force: true })
  });
  assert.ok(curate.ok, `curation failed: ${curate.status} ${await curate.text().catch(() => '')}`);
}

test('provider capability fields survive discovery into /v1/models', async (t) => {
  const { baseUrl, logs } = await bootRouter(t);
  await discoverAndCurate(baseUrl, 'mock-zen', 'deepseek/deepseek-v4.1-flash');

  const listed = await (await fetch(`${baseUrl}/v1/models`)).json();
  const entry = (listed.data || []).find((m) => String(m.id).includes('deepseek-v4.1-flash'));
  assert.ok(entry, `the discovered model must be advertised\n${logs()}`);

  assert.equal(entry.capabilities?.reasoning, true,
    `reasoning must come from the provider's capabilities block: ${JSON.stringify(entry.capabilities)}`);
  assert.equal(entry.capabilities?.imageInput, true,
    `input_modalities carrying "image" means vision: ${JSON.stringify(entry.capabilities)}`);
  assert.equal(entry.context_length, 1000000,
    `context_length must be read from the top level: ${entry.context_length}`);
  assert.equal(entry.max_output_tokens, 384000,
    `max_tokens is the ceiling and must not collapse to the 4096 default: ${entry.max_output_tokens}`);
});

test('OpenRouter capability fields survive discovery into /v1/models', async (t) => {
  // OpenRouter publishes no boolean reasoning flag. It expresses capability by listing
  // supported_parameters (reasoning, reasoning_effort, include_reasoning) and vision through
  // architecture.input_modalities. Reading only booleans advertised every OpenRouter reasoning
  // model as non-reasoning — and OpenRouter is what most agents default to, so that is the copy
  // of the bug users actually hit.
  const { baseUrl, logs } = await bootRouter(t, { model: OPENROUTER_STYLE_MODEL, providerName: 'mock-or' });
  await discoverAndCurate(baseUrl, 'mock-or', 'deepseek/deepseek-v4.1-flash');

  const listed = await (await fetch(`${baseUrl}/v1/models`)).json();
  const entry = (listed.data || []).find((m) => String(m.id).includes('deepseek-v4.1-flash'));
  assert.ok(entry, `the discovered model must be advertised\n${logs()}`);

  assert.equal(entry.capabilities?.reasoning, true,
    `supported_parameters listing "reasoning" means the model reasons: ${JSON.stringify(entry.capabilities)}`);
  assert.equal(entry.capabilities?.imageInput, true,
    `architecture.input_modalities carrying "image" means vision: ${JSON.stringify(entry.capabilities)}`);
  assert.equal(entry.context_length, 1048576, `context_length from the top level: ${entry.context_length}`);
  assert.equal(entry.max_output_tokens, 393216,
    `top_provider.max_completion_tokens is the ceiling: ${entry.max_output_tokens}`);
});

test('reasoning is only advertised when the provider says so', async (t) => {
  // The inverse guard: the fix must not mark every model reasoning-capable, which would make the
  // thinking selector lie in the other direction.
  const plain = {
    id: 'deepseek/deepseek-v4.1-flash',
    object: 'model',
    context_length: 128000,
    supported_parameters: ['temperature', 'max_tokens'],
    architecture: { input_modalities: ['text'] }
  };
  const { baseUrl, logs } = await bootRouter(t, { model: plain, providerName: 'mock-plain' });
  await discoverAndCurate(baseUrl, 'mock-plain', 'deepseek/deepseek-v4.1-flash');

  const listed = await (await fetch(`${baseUrl}/v1/models`)).json();
  const entry = (listed.data || []).find((m) => String(m.id).includes('deepseek-v4.1-flash'));
  assert.ok(entry, `model missing\n${logs()}`);
  assert.equal(entry.capabilities?.reasoning, false,
    `a model that lists no reasoning parameter must not claim it: ${JSON.stringify(entry.capabilities)}`);
  assert.equal(entry.capabilities?.imageInput, false,
    `text-only modalities must not claim vision: ${JSON.stringify(entry.capabilities)}`);
});

test('a stale persisted override ends up reconciled after a refresh', async (t) => {
  // The defect that made earlier capability fixes invisible in production: the override store
  // (provider-models.json) is preferred over the endpoint cache, so a row persisted before the
  // discovery fix kept advertising reasoning=false. Refreshing only wrote the cache, so the stale
  // override outlived every correction. Reproduced live on 2026-11-07 against a 538-row OpenRouter
  // override block.
  //
  // Scope note: this asserts the END STATE (a refresh leaves the catalog correct), not which of the
  // two correctors did it — the served view is recomputed from the cache while the override file is
  // reconciled separately, so removing either one alone still yields the right answer here. The
  // durable half is checked by reading provider-models.json directly, which IS specific to
  // reconcileOverrideMetadataFromCache and fails if that call is removed.
  const stale = [{
    id: 'mock-or-deepseek-v4.1-flash',
    provider: 'mock-or',
    model: 'deepseek/deepseek-v4.1-flash',
    display: 'mock-or:deepseek/deepseek-v4.1-flash',
    contextLength: 64000,
    outputTokens: 4096,
    supportsTools: true,
    supportsImages: false,
    supportsCache: false,
    supportsReasoning: false
  }];

  const { baseUrl, home, logs } = await bootRouter(t, {
    model: OPENROUTER_STYLE_MODEL,
    providerName: 'mock-or',
    staleOverrides: stale
  });

  // Before any refresh the stale override is what the catalog reports — this proves the fixture
  // actually reproduces the shadowing, so the assertions after the refresh mean something.
  const before = (await (await fetch(`${baseUrl}/v1/models`)).json()).data
    .find((m) => String(m.id).includes('deepseek-v4.1-flash'));
  assert.equal(before?.capabilities?.reasoning, false,
    `fixture must reproduce the stale-override shadow: ${JSON.stringify(before?.capabilities)}`);

  await discoverAndCurate(baseUrl, 'mock-or', 'deepseek/deepseek-v4.1-flash');

  const after = (await (await fetch(`${baseUrl}/v1/models`)).json()).data
    .find((m) => String(m.id).includes('deepseek-v4.1-flash'));
  assert.ok(after, `model missing after refresh\n${logs()}`);
  assert.equal(after.capabilities?.reasoning, true,
    `a refresh must correct a stale override: ${JSON.stringify(after.capabilities)}`);
  assert.equal(after.capabilities?.imageInput, true,
    `vision must be corrected too: ${JSON.stringify(after.capabilities)}`);
  assert.equal(after.max_output_tokens, 393216,
    `the live ceiling must replace the stale 4096: ${after.max_output_tokens}`);
  assert.equal(after.context_length, 1048576,
    `the live context must replace the stale 64000: ${after.context_length}`);

  // The durable assertion: the persisted override must be corrected too, so a restart cannot
  // resurrect the stale booleans. This is the half that only reconcileOverrideMetadataFromCache does.
  const persisted = JSON.parse(readFileSync(join(home, '.config', 'local-router', 'provider-models.json'), 'utf8'));
  const row = (persisted.overrides || [])
    .find((entry) => entry.provider === 'mock-or')
    ?.models?.find((m) => m.model === 'deepseek/deepseek-v4.1-flash');
  assert.ok(row, 'the override row must still exist');
  assert.equal(row.supportsReasoning, true,
    'the persisted override must not keep the stale reasoning=false across a restart');
  assert.equal(row.supportsImages, true, 'the persisted override must pick up vision');
  assert.equal(row.outputTokens, 393216, 'the persisted override must pick up the live ceiling');
});
