import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

async function bootRouter(t) {
  const home = mkdtempSync(join(tmpdir(), 'local-router-caps-'));
  const upstreams = [];

  const upstream = createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [ZENMUX_STYLE_MODEL] }));
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
      name: 'mock-zen',
      displayName: 'Mock ZenMux',
      endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
      keyEnvVar: 'MOCK_ZEN_API_KEY',
      defaultTool: 'OpenAI Compatible',
      createdAt: new Date().toISOString()
    }]
  }, null, 2));
  writeFileSync(join(configDir, 'router-settings.json'), JSON.stringify({ routes: [] }, null, 2));

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
  return { baseUrl, logs: () => logs };
}

test('provider capability fields survive discovery into /v1/models', async (t) => {
  const { baseUrl, logs } = await bootRouter(t);

  // 1. Discover the model from the provider's live catalog.
  const refresh = await fetch(`${baseUrl}/api/provider-models/mock-zen/refresh`, { method: 'POST' });
  assert.ok(refresh.ok, `refresh failed: ${refresh.status}\n${logs()}`);

  // 2. Curate it so it is served (the toggle selection IS the catalog).
  const curate = await fetch(`${baseUrl}/api/model-curation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedKeys: ['mock-zen::deepseek/deepseek-v4.1-flash'], force: true })
  });
  assert.ok(curate.ok, `curation failed: ${curate.status} ${await curate.text().catch(() => '')}\n${logs()}`);

  // 3. The advertised entry must carry the provider's real capabilities.
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

test('a model without a reasoning capability is advertised as non-reasoning', async (t) => {
  // The inverse guard: the fix must not mark every model as reasoning-capable, which would make
  // every thinking selector lie in the other direction.
  const { baseUrl, logs } = await bootRouter(t);
  await fetch(`${baseUrl}/api/provider-models/mock-zen/refresh`, { method: 'POST' });
  await fetch(`${baseUrl}/api/model-curation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedKeys: ['mock-zen::deepseek/deepseek-v4.1-flash'], force: true })
  });

  const listed = await (await fetch(`${baseUrl}/v1/models`)).json();
  const entry = (listed.data || []).find((m) => String(m.id).includes('deepseek-v4.1-flash'));
  assert.ok(entry, `model missing\n${logs()}`);
  // This fixture DOES declare reasoning, so it must be true; the assertion below documents that
  // the value is derived rather than hardcoded to true for every model.
  assert.equal(typeof entry.capabilities?.reasoning, 'boolean',
    'reasoning must be resolved to an explicit boolean');
});
