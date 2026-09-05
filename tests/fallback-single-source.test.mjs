import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// router-settings.json is the SINGLE SOURCE for fallback chains:
//  1. Boot precedence — it is authoritative over the derived
//     fallback-models.json cache (that drift is what previously wiped the
//     live chain down to one model while the file held 23).
//  2. Disk watcher — editing the file applies within ~2s, no restart.
//  3. Convergence — every chain write (toggle/save) syncs back into the file.

const port = String(27600 + Math.floor(Math.random() * 300));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let testHome = '';
let serverLogs = '';

const settingsPath = () => join(testHome, '.config', 'local-router', 'router-settings.json');
const cachePath = () => join(testHome, '.config', 'local-router', 'fallback-models.json');

function writeJson(pathname, payload) {
  mkdirSync(join(pathname, '..'), { recursive: true });
  writeFileSync(pathname, JSON.stringify(payload, null, 2));
}

async function startServer() {
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (c) => { serverLogs += c.toString(); });
  serverProcess.stderr.on('data', (c) => { serverLogs += c.toString(); });
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      ready = response.ok;
    } catch { await delay(100); }
  }
  assert.ok(ready, 'server must start\n' + serverLogs.slice(-2000));
}

async function stopServer() {
  if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => undefined);
  }
  serverProcess = undefined;
}

async function systemChainModels() {
  const response = await fetch(`${baseUrl}/api/fallback-models`);
  const body = await response.json();
  const entry = (body?.data || []).find((r) => r.routeId === 'fallback-models' || r.id === 'fallback-models');
  return Array.isArray(entry?.models) ? entry.models : null;
}

test('router-settings.json is authoritative at boot, on change, and convergent on writes', async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-single-source-'));

  // Stale derived cache claims a single-model chain; the settings file
  // carries the real chain. Boot must apply THE FILE.
  writeJson(cachePath(), {
    version: 1,
    routes: [{ id: 'fallback-models', models: ['stale-only-model'] }]
  });
  writeJson(settingsPath(), {
    fallbackModelsText: 'modal-proxy-a\nzai-b',
    routes: [{ id: 'fallback-models', models: ['modal-proxy-a', 'zai-b'] }]
  });
  // Catalog-known model for the toggle convergence check (toggle validates
  // against the catalog; the isolated HOME needs a known id to toggle).
  writeJson(join(testHome, '.config', 'local-router', 'endpoint-models-cache.json'), [
    {
      id: 'zenmux-minimax-m3',
      provider: 'zai',
      model: 'code-pass-glm-5.1',
      contextLength: 200000,
      outputTokens: 131072,
      tier: 'free',
      supportsTools: true,
      supportsImages: true
    }
  ]);
  writeJson(join(testHome, '.config', 'local-router', 'model-source-config.json'), {
    source: 'endpoints',
    curationEnabled: true,
    curatedEndpointModelKeys: ['zenmux::minimax/minimax-m3'],
    filterConfigured: true
  });

  await startServer();
  try {
    const booted = await systemChainModels();
    assert.deepEqual(booted, ['modal-proxy-a', 'zai-b'], 'settings file must beat the stale cache at boot');

    // Disk watcher: edit the file, no restart — the router follows.
    writeJson(settingsPath(), {
      fallbackModelsText: 'modal-proxy-a\nzai-b\nopenrouter-c',
      routes: [{ id: 'fallback-models', models: ['modal-proxy-a', 'zai-b', 'openrouter-c'] }]
    });
    let watched = null;
    for (let i = 0; i < 40 && watched === null; i++) {
      await delay(200);
      const models = await systemChainModels();
      if (models && models.length === 3) watched = models;
    }
    assert.deepEqual(watched, ['modal-proxy-a', 'zai-b', 'openrouter-c'], 'file edit must be watched and applied');

    // Convergence: an API write (toggle) syncs back into the file.
    const toggle = await fetch(`${baseUrl}/api/fallback-chain/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: 'zenmux-minimax-m3', enabled: true, routeId: 'fallback-models' })
    });
    assert.equal(toggle.status, 200, 'toggle must succeed: ' + JSON.stringify(await toggle.json().catch(() => ({}))));
    const settingsAfter = JSON.parse((await import('node:fs')).readFileSync(settingsPath(), 'utf8'));
    assert.ok(settingsAfter.fallbackModelsText.includes('zenmux-minimax-m3'), 'API writes must sync into the single source file');
  } finally {
    await stopServer();
    rmSync(testHome, { recursive: true, force: true });
  }
});
