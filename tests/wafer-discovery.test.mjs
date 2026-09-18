import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const { PROVIDER_MODEL_REGISTRY } = await import('../build/provider-model-registries.js');

test('wafer-serverless registry contains DeepSeek-V4.1-Flash baseline', () => {
  const waferModels = PROVIDER_MODEL_REGISTRY['wafer-serverless'] || [];
  const v41 = waferModels.find((m) => m.id === 'DeepSeek-V4.1-Flash' || m.id === 'deepseek-v4.1-flash');
  assert.ok(v41, 'DeepSeek-V4.1-Flash must exist in wafer-serverless registry');
  assert.equal(v41.contextLength, 1048576);
  assert.equal(v41.supportsImages, true);
  assert.equal(v41.supportsReasoning, true);
});

test('wafer-serverless live probe returns DeepSeek-V4.1-Flash via probe.mjs', async () => {
  const probe = spawn(process.execPath, [
    '.agents/skills/provider-models-list/scripts/probe.mjs',
    'wafer-serverless',
    '--json'
  ], {
    cwd: process.cwd(),
    env: { ...process.env, WAFER_SERVERLESS_API_KEY: 'test_wafer_persistence_key_123' }
  });

  let stdout = '';
  probe.stdout.on('data', (chunk) => { stdout += chunk; });
  const [code] = await once(probe, 'close');
  assert.equal(code, 0, 'probe.mjs must exit cleanly with code 0');

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].provider, 'wafer-serverless');
  assert.equal(parsed[0].ok, true, 'Wafer probe must succeed via public catalog fallback even with dummy key');

  const v41 = parsed[0].models.find((m) => m.id === 'DeepSeek-V4.1-Flash');
  assert.ok(v41, 'DeepSeek-V4.1-Flash must be discovered in live probe models');
  assert.equal(v41.context, 1048576);
});

test('router endpoint logic recovers from 401 on public pass catalogs and extracts Wafer metadata', async (t) => {
  const mockPort = 18000 + Math.floor(Math.random() * 1000);
  let authAttempts = 0;
  let publicAttempts = 0;

  const mockWafer = createServer((req, res) => {
    if (req.url === '/models' || req.url === '/v1/models') {
      const auth = req.headers.authorization;
      if (auth && auth.includes('test_dummy_key')) {
        authAttempts += 1;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }));
        return;
      }
      publicAttempts += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [
          {
            id: 'DeepSeek-V4.1-Flash',
            object: 'model',
            max_model_len: 1048576,
            supports_vision: true,
            wafer: {
              display_name: 'DeepSeek-V4.1-Flash',
              tier: 'serverless_only',
              context_length: 1048576,
              max_output_tokens: null,
              capabilities: {
                vision: true,
                tools: true,
                reasoning: true
              }
            }
          }
        ]
      }));
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise((resolve) => mockWafer.listen(mockPort, '127.0.0.1', resolve));

  const routerPort = mockPort + 10;
  const testHome = mkdtempSync(join(tmpdir(), 'local-router-wafer-test-'));

  const router = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: String(routerPort),
      LOCAL_ROUTER_PROVIDER_WAFER_SERVERLESS_BASE_URL: `http://127.0.0.1:${mockPort}`,
      LOCALROUTER_WAFER_SERVERLESS_API_KEY: 'test_dummy_key',
      FVS_DEV: 'true'
    }
  });

  let serverStarted = false;
  router.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('running on')) serverStarted = true;
  });

  for (let i = 0; i < 50 && !serverStarted; i += 1) {
    await delay(100);
  }
  assert.ok(serverStarted, 'Local Router should start successfully');

  try {
    const res = await fetch(`http://127.0.0.1:${routerPort}/api/provider-models/wafer-serverless/refresh`, {
      method: 'POST'
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.source, 'live', 'Must resolve to live source after unauthenticated retry');
    assert.ok(authAttempts >= 1, 'Should have attempted authenticated fetch first');
    assert.ok(publicAttempts >= 1, 'Should have retried unauthenticated on 401');

    const v41 = body.data.find((m) => m.model === 'DeepSeek-V4.1-Flash');
    assert.ok(v41, 'DeepSeek-V4.1-Flash must be in refreshed models');
    assert.equal(v41.id, 'wafer-ai-deepseek-v4.1-flash');
    assert.equal(v41.contextLength, 1048576);
    assert.equal(v41.supportsImages, true, 'Wafer vision capability must be extracted');
    assert.equal(v41.supportsReasoning, true, 'Wafer reasoning capability must be extracted');
    assert.equal(v41.supportsTools, true, 'Wafer tools capability must be extracted');
    assert.equal(v41.tier, 'paid', 'serverless_only should map to paid tier');
  } finally {
    router.kill('SIGTERM');
    mockWafer.close();
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
  }
});
