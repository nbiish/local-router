import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

/**
 * Embeddings proxy regression coverage.
 *
 * Each test owns its router, its upstream, and its temp HOME. Sharing that state across tests
 * makes the second test fail on the first test's stale router, and leaves orphan processes behind
 * when a test aborts, so every test builds its own fixture and tears it down.
 */

/** Upstream that answers /v1/embeddings with gzip-compressed JSON, like a real provider does. */
async function startGzipUpstream(embedding) {
  const server = createServer((req, res) => {
    if (req.url !== '/v1/embeddings') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      const payload = Buffer.from(JSON.stringify({
        object: 'list',
        model: request.model,
        data: [{ object: 'embedding', index: 0, embedding }],
        usage: { prompt_tokens: 1, total_tokens: 1 }
      }));
      const gz = gzipSync(payload);
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(gz.length)
      });
      res.end(gz);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/**
 * Boots the built router against a throwaway HOME.
 * Returns the child plus handles for teardown; `t.after` is not used so the helper works from
 * any test shape.
 */
async function withRouter(t, { providers, routes, env, embedding, registryProvider }) {
  const home = mkdtempSync(join(tmpdir(), 'local-router-embeddings-'));
  const upstream = await startGzipUpstream(embedding ?? [0.1, 0.2, 0.3]);
  const upstreamPort = upstream.address().port;

  const port = String(27900 + Math.floor(Math.random() * 900));
  const baseUrl = `http://127.0.0.1:${port}`;
  const configDir = join(home, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });

  writeFileSync(join(configDir, 'custom-providers.json'), JSON.stringify({
    version: 1,
    providers: providers.map((p) => ({
      ...p,
      endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
      defaultTool: 'OpenAI Compatible',
      createdAt: new Date().toISOString()
    }))
  }, null, 2));
  if (routes) {
    writeFileSync(join(configDir, 'router-settings.json'), JSON.stringify({ routes }, null, 2));
  }

  // Pick a built-in provider that has no key in this throwaway HOME, plus one of its models.
  let registryName = '';
  let registryModel = '';
  if (registryProvider) {
    const { PROVIDER_REGISTRY } = await import('../build/provider-registry.js');
    const { PROVIDER_MODEL_REGISTRY } = await import('../build/provider-model-registries.js');
    for (const summary of PROVIDER_REGISTRY) {
      const models = PROVIDER_MODEL_REGISTRY[summary.name];
      if (Array.isArray(models) && models.length > 0) {
        registryName = summary.name;
        registryModel = models[0].id;
        break;
      }
    }
  }

  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_DEV: 'true',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });

  const cleanup = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => undefined);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(home, { recursive: true, force: true });
  };
  t.after(cleanup);

  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/version`)).ok) break;
    } catch {}
    await delay(100);
  }

  return { baseUrl, logs: () => logs, registryName, registryModel };
}

test('the proxied body never claims a content-encoding it does not have', async (t) => {
  const { baseUrl, logs } = await withRouter(t, {
    providers: [{ name: 'gzip-test', displayName: 'Gzip', keyEnvVar: 'GZIP_TEST_API_KEY', models: ['gzip-embedding-model'] }],
    env: { GZIP_TEST_API_KEY: 'test-key' },
    embedding: [0.4, 0.5, 0.6]
  });

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip, deflate, br' },
    body: JSON.stringify({ model: 'gzip-test/gzip-embedding-model', input: 'probe' })
  });

  assert.equal(response.status, 200, logs());
  // The router decodes the upstream body, so it must not forward the upstream encoding.
  assert.equal(response.headers.get('content-encoding'), null,
    'the router must not forward content-encoding after decoding the body');
  const body = await response.json();
  assert.deepEqual(body.data[0].embedding, [0.4, 0.5, 0.6]);
});

test('embeddings proxy cascades through the configured fallback route', async (t) => {
  const { baseUrl, logs } = await withRouter(t, {
    providers: [{ name: 'embedding-test', displayName: 'Embedding test', keyEnvVar: 'EMBEDDING_TEST_API_KEY', models: ['embedding-model'] }],
    routes: [{ id: 'fallback-models', models: ['embedding-test/embedding-model'] }],
    env: { EMBEDDING_TEST_API_KEY: 'test-key' }
  });

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-router/fallback-models', input: 'critical image test' })
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${JSON.stringify(body)}\n${logs()}`);
  assert.deepEqual(body.data[0].embedding, [0.1, 0.2, 0.3]);
  assert.equal(body.model, 'embedding-model');
});

test('an unkeyed provider sharing a model id does not shadow a keyed one', async (t) => {
  const { baseUrl, logs } = await withRouter(t, {
    // Two providers advertise the SAME model id. The first has no key; the second does.
    providers: [
      { name: 'aaa-unkeyed', displayName: 'Unkeyed', keyEnvVar: 'AAA_UNKEYED_API_KEY', models: ['shared-embedding'] },
      { name: 'zzz-keyed', displayName: 'Keyed', keyEnvVar: 'ZZZ_KEYED_API_KEY', models: ['shared-embedding'] }
    ],
    env: { ZZZ_KEYED_API_KEY: 'test-key' },
    embedding: [0.7, 0.8, 0.9]
  });

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'shared-embedding', input: 'probe' })
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${JSON.stringify(body)}\n${logs()}`);
  assert.deepEqual(body.data[0].embedding, [0.7, 0.8, 0.9]);
});

test('an only-unkeyed model fails with an actionable message, not a bare 502', async (t) => {
  // Use a built-in registry provider with no key rather than a custom one: custom providers are
  // always callable, so they cannot reproduce the configuration failure this test is about.
  const { baseUrl, registryName, registryModel } = await withRouter(t, {
    providers: [],
    env: {},
    registryProvider: true
  });

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: `${registryName}/${registryModel}`, input: 'probe' })
  });
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.match(String(body.error), /No keyed provider can serve/,
    'the error must name the configuration problem instead of looking like an outage');
  assert.match(String(body.error), new RegExp(registryName));
});
