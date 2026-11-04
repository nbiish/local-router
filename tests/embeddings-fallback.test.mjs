import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(27900 + Math.floor(Math.random() * 50));
const baseUrl = `http://127.0.0.1:${port}`;
let home;
let router;
let upstream;

test('embeddings proxy cascades through the configured fallback route', async () => {
  home = mkdtempSync(join(tmpdir(), 'local-router-embeddings-'));
  upstream = createServer((req, res) => {
    if (req.url !== '/v1/embeddings') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        model: request.model,
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 1, total_tokens: 1 }
      }));
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const configDir = join(home, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'custom-providers.json'), JSON.stringify({
    version: 1,
    providers: [{
      name: 'embedding-test',
      displayName: 'Embedding test',
      endpoint: `http://127.0.0.1:${upstreamPort}/v1`,
      keyEnvVar: 'EMBEDDING_TEST_API_KEY',
      defaultTool: 'OpenAI Compatible',
      createdAt: new Date().toISOString(),
      models: ['embedding-model']
    }]
  }, null, 2));
  writeFileSync(join(configDir, 'router-settings.json'), JSON.stringify({
    routes: [{ id: 'fallback-models', models: ['embedding-test/embedding-model'] }]
  }, null, 2));

  router = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PORT: port,
      EMBEDDING_TEST_API_KEY: 'test-key',
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  router.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  router.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/version`)).ok) break;
    } catch {}
    await delay(100);
  }

  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'local-router/fallback-models', input: 'critical image test' })
  });
  const body = await response.json();
  assert.equal(response.status, 200, `${JSON.stringify(body)}\n${logs}`);
  assert.deepEqual(body.data[0].embedding, [0.1, 0.2, 0.3]);
  assert.equal(body.model, 'embedding-model');
});

test.after(async () => {
  if (router && router.exitCode === null) {
    router.kill('SIGTERM');
    await once(router, 'exit').catch(() => undefined);
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
  if (home) rmSync(home, { recursive: true, force: true });
});
