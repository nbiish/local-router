import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const port = String(28000 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let testHome = '';
let serverLogs = '';

async function requestJson(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { parseError: true, raw: text }; }
  }
  return { response, body, text };
}

function postJson(pathname, payload) {
  return requestJson(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

function putJson(pathname, payload) {
  return requestJson(pathname, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

function deleteJson(pathname, payload) {
  return requestJson(pathname, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function startServer() {
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
      LOCAL_ROUTER_DEV: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Server exited early.\nLogs:\n${serverLogs}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/version`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await delay(100);
  }
  throw new Error(`Server failed to start on ${baseUrl}\nLogs:\n${serverLogs}`);
}

async function stopServer() {
  if (serverProcess && !serverProcess.killed && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await once(serverProcess, 'exit').catch(() => undefined);
  }
  serverProcess = undefined;
}

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-curation-configs-'));
  await startServer();
});

test.after(async () => {
  await stopServer();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('curation configs: save, list, load, default, clear default, delete, boot re-apply', async () => {
  const keys = ['nvidia-nim::minimax/minimax-m3', 'zai::code-pass-glm-5.1'];

  // Save → listed with count.
  const save = await postJson('/api/curation-configs', { name: 'smoke', selectedKeys: keys });
  assert.equal(save.response.status, 200);
  const listed = await requestJson('/api/curation-configs');
  const entry = (listed.body?.data || []).find((c) => c.name === 'smoke');
  assert.ok(entry, 'saved config must appear in list');
  assert.equal(entry.count, 2);
  assert.equal(entry.isDefault, false);

  // Load unknown → 404.
  const missing = await postJson('/api/curation-configs/load', { name: 'nope' });
  assert.equal(missing.response.status, 404);

  // Load saved config → curated selection replaced.
  const loaded = await postJson('/api/curation-configs/load', { name: 'smoke' });
  assert.equal(loaded.response.status, 200);
  assert.equal(loaded.body?.selectedCount, 2);

  // Mark as default.
  const setDefault = await putJson('/api/curation-configs/default', { name: 'smoke' });
  assert.equal(setDefault.response.status, 200);
  assert.equal(setDefault.body?.defaultCurationConfig, 'smoke');
  const listed2 = await requestJson('/api/curation-configs');
  assert.equal((listed2.body?.data || []).find((c) => c.name === 'smoke')?.isDefault, true);

  // Restart: default config must be re-applied at boot.
  await stopServer();
  await startServer();
  const afterReboot = await requestJson('/api/model-curation');
  assert.equal(afterReboot.body?.selectedCount, 2, 'default curation config not applied at boot');
  assert.deepEqual([...(afterReboot.body?.selectedKeys || [])].sort(), [...keys].sort());

  // Clear default; delete config.
  const cleared = await putJson('/api/curation-configs/default', { name: null });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.body?.defaultCurationConfig, null);
  const deleted = await deleteJson('/api/curation-configs', { name: 'smoke' });
  assert.equal(deleted.response.status, 200);
  const listed3 = await requestJson('/api/curation-configs');
  assert.equal((listed3.body?.data || []).some((c) => c.name === 'smoke'), false);
});
