import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * End-to-end proof that a `/config/providers` key save reaches the PQC bundle
 * in a form the same server can load again, without touching other tools'
 * entries. This is the regression that matters for "I entered a key and it
 * vanished on restart" (2026-10-29): the save path used to preserve
 * `export NAME='value'` quoting, which `pack` refuses, so every write after
 * the first silently failed.
 *
 * Runs fully sandboxed: PQC_CONFIG_DIR + USERPROFILE point at a throwaway temp
 * tree, and LOCAL_ROUTER_PQC_SCAN_WSL=0 keeps the Windows→WSL store scan out
 * of the test. Skips when the pqc engine's `uv` runtime is unavailable.
 */

const repoRoot = join(import.meta.dirname, '..');
const enginePath = join(repoRoot, '.agents', 'skills', 'pqc-secrets', 'scripts', 'pqc_secrets.py');
const serverEntry = join(repoRoot, 'build', 'index.js');

const uvAvailable = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;
const engineAvailable = existsSync(enginePath) && existsSync(serverEntry);

function engine(args, { configDir, stdin } = {}) {
  const result = spawnSync('uv', ['run', enginePath, ...args], {
    encoding: 'utf8',
    timeout: 120000,
    input: stdin,
    env: {
      ...process.env,
      PQC_CONFIG_DIR: configDir,
      PQC_USE_KEYCHAIN: 'false',
      PQC_STORE_ISOLATED: '1'
    }
  });
  return result;
}

async function waitForReady(baseUrl, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/version`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await delay(300);
  }
  throw new Error('server did not become ready in time');
}

test('a saved provider key persists canonically and leaves other tools\' entries alone', { skip: !uvAvailable || !engineAvailable ? 'uv or pqc engine unavailable' : false }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lr-pqc-persist-'));
  const store = join(root, 'store');
  const home = join(root, 'home');
  const port = String(19000 + Math.floor(Math.random() * 500));
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  try {
    const keygen = engine(['keygen'], { configDir: store });
    assert.equal(keygen.status, 0, `keygen failed: ${keygen.stderr}`);
    const seed = engine(['set', 'OTHER_TOOL_KEY=dummy-other-tool'], { configDir: store });
    assert.equal(seed.status, 0, `set failed: ${seed.stderr}`);

    // Strip ambient provider keys so only the test store can supply one.
    const childEnv = { ...process.env };
    for (const name of Object.keys(childEnv)) {
      if (/^[A-Z0-9_]+_API_KEY$/.test(name) || /^LOCAL[_-]?ROUTER_/i.test(name)) delete childEnv[name];
    }
    Object.assign(childEnv, {
      PQC_CONFIG_DIR: store,
      PQC_USE_KEYCHAIN: 'false',
      PQC_STORE_ISOLATED: '1',
      LOCAL_ROUTER_PQC_SCAN_WSL: '0',
      USERPROFILE: home,
      PORT: port
    });

    server = spawn(process.execPath, [serverEntry], { cwd: root, env: childEnv, stdio: 'ignore' });
    await waitForReady(baseUrl);

    const saveRes = await fetch(`${baseUrl}/api/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'zai', apiKey: 'sk-e2e-fake-zai-key-0001' })
    });
    assert.equal(saveRes.status, 200);
    const save = await saveRes.json();
    assert.equal(save.persisted, true, `save did not persist: ${JSON.stringify(save)}`);

    const listed = engine(['list', '--json'], { configDir: store });
    assert.equal(listed.status, 0, `list failed: ${listed.stderr}`);
    const names = JSON.parse(listed.stdout).names;
    assert.ok(names.includes('LOCALROUTER_ZAI_API_KEY'), `canonical name missing: ${names}`);
    assert.ok(names.includes('OTHER_TOOL_KEY'), `foreign entry was dropped: ${names}`);
    assert.ok(!names.includes('ZAI_API_KEY'), `legacy alias was not reconciled: ${names}`);

    const status = await (await fetch(`${baseUrl}/api/pqc/status`)).json();
    assert.equal(status.bundleLoaded, true);
    assert.ok(
      status.loadedProviders.some((entry) => entry.provider === 'zai'),
      `zai not loaded from the bundle: ${JSON.stringify(status.loadedProviders)}`
    );
  } finally {
    if (server && !server.killed) server.kill('SIGKILL');
    await delay(200);
    rmSync(root, { recursive: true, force: true });
  }
});
