import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Boot-time regression for the metadata pipeline:
//   1. a live-discovered model must survive registry seeding (it used to be
//      dropped because seeding replaced the provider's cache section);
//   2. a cached model stuck at the 64K default must be reconciled from the
//      curated registry for providers that publish no limits.

const port = String(19200 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
let testHome = '';
let serverProcess;
let serverLogs = '';

function model(overrides) {
  return {
    supportsTools: true,
    supportsImages: false,
    supportsCache: false,
    supportsReasoning: false,
    ...overrides
  };
}

test.before(async () => {
  testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'local-router-context-'));
  const configDir = path.join(testHome, '.config', 'local-router');
  fs.mkdirSync(configDir, { recursive: true });

  const cache = [
    model({
      id: 'zai-glm-5.3-flash',
      provider: 'zai',
      model: 'glm-5.3-flash',
      display: 'zai:glm-5.3-flash',
      contextLength: 64000,
      outputTokens: 4096
    }),
    model({
      id: 'zai-glm-9-live',
      provider: 'zai',
      model: 'glm-9-live',
      display: 'zai:glm-9-live',
      contextLength: 64000,
      outputTokens: 4096
    }),
    model({
      id: 'xiaomi-mimo-mimo-v2.6-pro',
      provider: 'xiaomi-mimo',
      model: 'mimo-v2.6-pro',
      display: 'xiaomi-mimo:mimo-v2.6-pro',
      contextLength: 64000,
      outputTokens: 4096
    })
  ];
  fs.writeFileSync(path.join(configDir, 'endpoint-models-cache.json'), JSON.stringify(cache, null, 2));
  fs.writeFileSync(path.join(configDir, 'model-source-config.json'), JSON.stringify({
    source: 'endpoints',
    filterConfigured: false,
    curationEnabled: true,
    curatedEndpointModelKeys: [
      'zai::glm-5.3-flash',
      'zai::glm-9-live',
      'xiaomi-mimo::mimo-v2.6-pro'
    ],
    operatorClearedProviders: [],
    catalogMigrationVersion: 2
  }, null, 2));

  serverProcess = spawn('node', ['build/index.js'], {
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OS_ENV: '1',
      LOCAL_ROUTER_DEV: 'true'
    }
  });
  serverProcess.stdout.on('data', (data) => { serverLogs += data.toString(); });
  serverProcess.stderr.on('data', (data) => { serverLogs += data.toString(); });
  await delay(6000);
});

test.after(async () => {
  if (serverProcess) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
  if (testHome) fs.rmSync(testHome, { recursive: true, force: true });
});

test('boot preserves live-only models and reconciles default windows from the registry', async () => {
  const zai = await fetch(`${baseUrl}/v1/models?provider=zai`).then((response) => response.json());
  const byId = new Map(zai.data.map((row) => [row.id, row]));

  const flash = byId.get('zai-glm-5.3-flash');
  assert.ok(flash, 'cached zai model must still be listed after seeding');
  assert.equal(flash.context_length, 1048576, 'registry context must replace the 64K default');
  assert.equal(flash.max_output_tokens, 131072, 'registry output limit must replace the 4K default');

  assert.ok(byId.get('zai-glm-9-live'), 'live-only model must survive registry seeding');

  const xiaomi = await fetch(`${baseUrl}/v1/models?provider=xiaomi-mimo`).then((response) => response.json());
  const mimo = xiaomi.data.find((row) => row.id === 'xiaomi-mimo-mimo-v2.6-pro');
  assert.ok(mimo);
  assert.equal(mimo.context_length, 1050000);
  assert.equal(mimo.max_output_tokens, 131072);

  assert.match(serverLogs, /\[catalog\] Reconciled \d+ cached model/);
});
