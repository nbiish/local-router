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
 * Purpose-scoped fallback routes: `fallback-embedding` and `fallback-decision`.
 *
 * Two contracts are covered, both of which were broken during development and would corrupt a
 * retrieval index silently if they regressed:
 *
 *   1. A purpose-scoped route must not be run through the chat capability filter. That filter
 *      looks each step up in the chat catalog, finds no entry for an embedding model, and drops it,
 *      leaving the chain with zero candidates.
 *   2. A chain pinned via `dimensions` must reject a step that returns another width and continue,
 *      because a wrong-width vector is accepted by an index and then compared against neighbours
 *      from a different space.
 */

async function bootRouter(t, { routes, providers, env, embeddingFor }) {
  const home = mkdtempSync(join(tmpdir(), 'local-router-purpose-'));
  const calls = [];

  // One upstream per provider, so the router's provider choice is observable from the port it hit.
  const upstreams = [];
  async function startUpstream(providerName) {
    const server = createServer((req, res) => {
      if (req.url !== '/v1/embeddings') { res.writeHead(404); res.end(); return; }
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw);
        calls.push({ provider: providerName, model: body.model, dimensions: body.dimensions });
        const width = embeddingFor(body.model, body.dimensions, providerName);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          model: body.model,
          data: [{ object: 'embedding', index: 0, embedding: Array.from({ length: width }, (_, i) => (i % 5) / 5) }],
          usage: { prompt_tokens: 1, total_tokens: 1 }
        }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    upstreams.push(server);
    return server.address().port;
  }

  const endpoints = new Map();
  for (const p of providers || []) {
    if (!endpoints.has(p.name)) endpoints.set(p.name, await startUpstream(p.name));
  }

  const configDir = join(home, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });
  if (providers) {
    writeFileSync(join(configDir, 'custom-providers.json'), JSON.stringify({
      version: 1,
      providers: providers.map((p) => ({
        ...p,
        endpoint: `http://127.0.0.1:${endpoints.get(p.name)}/v1`,
        defaultTool: 'OpenAI Compatible',
        createdAt: new Date().toISOString()
      }))
    }, null, 2));
  }
  writeFileSync(join(configDir, 'router-settings.json'), JSON.stringify({ routes }, null, 2));

  const port = String(28100 + Math.floor(Math.random() * 500));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOME: home, USERPROFILE: home, PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true', LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true', LOCAL_ROUTER_DEV: 'true',
      ...env
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
    try { if ((await fetch(`${baseUrl}/api/version`)).ok) break; } catch {}
    await delay(100);
  }
  return { baseUrl, logs: () => logs, calls, home };
}

test('fallback-embedding serves through the chain instead of being filtered out', async (t) => {
  const { baseUrl, logs, calls } = await bootRouter(t, {
    providers: [{ name: 'mock-a', displayName: 'A', keyEnvVar: 'MOCK_A_API_KEY', models: ['embed-model'] }],
    routes: [{ id: 'fallback-embedding', models: ['mock-a/embed-model'] }],
    env: { MOCK_A_API_KEY: 'k' },
    embeddingFor: (_model, dimensions) => dimensions ?? 1536
  });

  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-router/fallback-embedding', input: 'probe', dimensions: 768 })
  });
  const body = await res.json();
  assert.equal(res.status, 200, `${JSON.stringify(body)}\n${logs()}`);
  assert.equal(body.data[0].embedding.length, 768);
  assert.deepEqual(calls, [{ provider: 'mock-a', model: 'embed-model', dimensions: 768 }],
    'the step must be reached with the pinned width forwarded upstream');
});

test('a chain pinned via dimensions rejects a wrong-width step and continues', async (t) => {
  // Both steps name the SAME upstream model, so the chain stays coherent; they differ only in the
  // width they return. That is the realistic failure: the reconcile step keeps same-model chains
  // intact, and a provider that ignores `dimensions` still has to be rejected.
  const { baseUrl, calls } = await bootRouter(t, {
    providers: [
      { name: 'mock-a', displayName: 'A', keyEnvVar: 'MOCK_A_API_KEY', models: ['embed-model'] },
      { name: 'mock-b', displayName: 'B', keyEnvVar: 'MOCK_B_API_KEY', models: ['embed-model'] }
    ],
    routes: [{ id: 'fallback-embedding', models: ['mock-a/embed-model', 'mock-b/embed-model'] }],
    env: { MOCK_A_API_KEY: 'k', MOCK_B_API_KEY: 'k' },
    // The first provider ignores the pin; the second honours it.
    embeddingFor: (model, dimensions, provider) => (provider === 'mock-a' ? 1536 : (dimensions ?? 1536))
  });

  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-router/fallback-embedding', input: 'probe', dimensions: 768 })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.data[0].embedding.length, 768, 'the mismatched step must not satisfy the pinned chain');
  assert.equal(calls.length, 2, `expected both steps to be tried, saw ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.map((c) => c.provider), ['mock-a', 'mock-b'],
    'the chain must reject mock-a and then reach mock-b');
});

test('without a pinned width the chain does not reject a differing step', async (t) => {
  const { baseUrl } = await bootRouter(t, {
    providers: [
      { name: 'mock-a', displayName: 'A', keyEnvVar: 'MOCK_A_API_KEY', models: ['wrong-width'] },
      { name: 'mock-b', displayName: 'B', keyEnvVar: 'MOCK_B_API_KEY', models: ['right-width'] }
    ],
    routes: [{ id: 'fallback-embedding', models: ['mock-a/wrong-width', 'mock-b/right-width'] }],
    env: { MOCK_A_API_KEY: 'k', MOCK_B_API_KEY: 'k' },
    embeddingFor: (model, dimensions) => (model === 'wrong-width' ? 1536 : (dimensions ?? 1536))
  });

  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-router/fallback-embedding', input: 'probe' })
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  // Nothing to enforce, so the first step answers with its own width.
  assert.equal(body.data[0].embedding.length, 1536);
});

test('the routes are seeded on first boot and left alone on later boots', async (t) => {
  const { baseUrl, home } = await bootRouter(t, {
    providers: null,
    routes: [],
    env: {},
    embeddingFor: () => 768
  });

  const listed = await (await fetch(`${baseUrl}/api/fallback-models`)).json();
  const ids = (listed.data || []).map((r) => r.id);
  assert.ok(ids.includes('local-router/fallback-embedding'), `missing embedding route: ${ids.join(', ')}`);
  assert.ok(ids.includes('local-router/fallback-decision'), `missing decision route: ${ids.join(', ')}`);

  const embedding = (listed.data || []).find((r) => r.id === 'local-router/fallback-embedding');
  assert.ok(embedding.models.length >= 2, 'embedding route must have real fallback steps');

  // The seed is one model across providers: mixing models would return incomparable vectors.
  const upstreamModels = new Set(embedding.models.map((m) => m.slice(m.indexOf('/') + 1)));
  assert.equal(upstreamModels.size, 1,
    `fallback steps must share one embedding model, found: ${[...upstreamModels].join(', ')}`);

  const decision = (listed.data || []).find((r) => r.id === 'local-router/fallback-decision');
  assert.deepEqual(decision.models, ['typesafe/jev-1.14']);

  // The persisted file records both, so a restart reads them rather than reseeding.
  const persisted = JSON.parse(readFileSync(join(home, '.config', 'local-router', 'fallback-models.json'), 'utf8'));
  const persistedIds = JSON.stringify(persisted);
  assert.match(persistedIds, /fallback-embedding/);
  assert.match(persistedIds, /fallback-decision/);
});

test('a persisted chain that mixes embedding models is reconciled on boot', async (t) => {
  // Simulate a route written by an older build: two providers of the same model plus a different
  // model. Seeding is one-shot, so without an active reconcile this mixed chain would serve
  // incomparable vectors forever.
  const { baseUrl, home } = await bootRouter(t, {
    providers: null,
    routes: [{
      id: 'fallback-embedding',
      models: [
        'zenmux/openai/text-embedding-3-small',
        'nous-portal/qwen/qwen3-embedding-8b',
        'openrouter/openai/text-embedding-3-small'
      ]
    }],
    env: {},
    embeddingFor: () => 768
  });

  const listed = await (await fetch(`${baseUrl}/api/fallback-models`)).json();
  const route = (listed.data || []).find((r) => r.id === 'local-router/fallback-embedding');
  assert.ok(route, 'embedding route must exist');

  const upstreamModels = new Set(route.models.map((m) => m.slice(m.indexOf('/') + 1)));
  assert.equal(upstreamModels.size, 1,
    `a mixed chain must be narrowed to one model, found: ${[...upstreamModels].join(', ')}`);

  // Both providers of the surviving model are kept, so fallback still spans providers.
  assert.equal(route.models.length, 2, `expected both same-model steps kept, got ${route.models.join(', ')}`);

  // The removed step is disabled rather than silently deleted, so an operator can find it.
  assert.ok((route.disabledModels || []).some((m) => m.includes('qwen3-embedding-8b')),
    `the incompatible step must be recorded as disabled, saw: ${JSON.stringify(route.disabledModels)}`);

  // And the narrowing is persisted, so it does not re-run every boot.
  const persisted = JSON.parse(readFileSync(join(home, '.config', 'local-router', 'fallback-models.json'), 'utf8'));
  const saved = (persisted.routes || []).find((r) => r.id === 'fallback-embedding');
  assert.equal(new Set(saved.models.map((m) => m.slice(m.indexOf('/') + 1))).size, 1);
});

test('fallback-decision resolves to the canonical decision model', async (t) => {
  const { baseUrl, logs } = await bootRouter(t, {
    providers: null,
    routes: [{ id: 'fallback-decision', models: ['typesafe/jev-1.14'] }],
    env: {},
    embeddingFor: () => 768
  });

  const res = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'local-router/fallback-decision',
      questions: { q: { type: 'noul', instructions: 'Is this a probe?', criteria: { true: 'probe', false: 'not' } } },
      state: 'This is a probe.'
    })
  });
  const body = await res.json();

  // With no provider key the call must fail on availability, not on model resolution: a 404
  // "unknown decision model" would mean the route id was never understood.
  assert.notEqual(res.status, 404, `route id was not resolved: ${JSON.stringify(body)}\n${logs()}`);
  assert.doesNotMatch(JSON.stringify(body), /Unknown decision model/);
  assert.equal(body.error?.type, 'decision_provider_unavailable');
});
