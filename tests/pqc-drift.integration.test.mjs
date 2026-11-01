import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Shared-bundle drift regression (2026-10-31 incident): another consumer
 * rewrote the PQC store while a router was live, the router's LOCALROUTER_*
 * names vanished, and nobody noticed until a restart. A live router must
 * stat the bundle, reload it read-only, and report which providers appeared or
 * disappeared — without dropping in-memory keys and without writing the store.
 */

const repoRoot = join(import.meta.dirname, '..');
const enginePath = join(repoRoot, '.agents', 'skills', 'pqc-secrets', 'scripts', 'pqc_secrets.py');
const serverEntry = join(repoRoot, 'build', 'index.js');

const uvAvailable = spawnSync('uv', ['--version'], { encoding: 'utf8' }).status === 0;
const engineAvailable = existsSync(enginePath) && existsSync(serverEntry);
const skip = !uvAvailable || !engineAvailable ? 'uv or pqc engine unavailable' : false;

function engine(args, { configDir, stdin } = {}) {
  return spawnSync('uv', ['run', enginePath, ...args], {
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
}

async function waitForReady(baseUrl, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/version`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await delay(300);
  }
  throw new Error('server did not become ready in time');
}

test('a live router reports bundle drift when another writer changes the store', { skip }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lr-pqc-drift-'));
  const store = join(root, 'store');
  const home = join(root, 'home');
  const port = String(19500 + Math.floor(Math.random() * 400));
  const baseUrl = `http://127.0.0.1:${port}`;
  let server;

  const status = async () => (await fetch(`${baseUrl}/api/pqc/status`)).json();

  try {
    assert.equal(engine(['keygen'], { configDir: store }).status, 0, 'keygen failed');
    const seed = engine(['set', 'LOCALROUTER_OPENROUTER_API_KEY=sk-or-drift-test'], { configDir: store });
    assert.equal(seed.status, 0, `seed failed: ${seed.stderr}`);

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
      HOME: home,
      PORT: port
    });

    server = spawn(process.execPath, [serverEntry], { cwd: root, env: childEnv, stdio: 'ignore' });
    await waitForReady(baseUrl);

    const initial = await status();
    assert.deepEqual(initial.loadedProviders.map((row) => row.provider).filter((name) => name !== 'ollama'), ['openrouter']);
    assert.equal(initial.bundleDrift, null, 'no drift before the bundle changes');

    // Another consumer adds a key while the router runs.
    const add = engine(['set', 'LOCALROUTER_ZENMUX_API_KEY=sk-zm-drift-test'], { configDir: store });
    assert.equal(add.status, 0, `add failed: ${add.stderr}`);

    const afterAdd = await status();
    assert.equal(afterAdd.bundleDrift?.resyncOk, true, 'drift resync must succeed');
    assert.deepEqual(afterAdd.bundleDrift.added, ['zenmux'], 'the new provider key must be reported as added');
    assert.deepEqual(afterAdd.loadedProviders.map((row) => row.provider).filter((name) => name !== 'ollama').sort(), ['openrouter', 'zenmux']);

    // ...and then removes one: the router reports it and keeps serving memory.
    const remove = engine(['del', 'LOCALROUTER_ZENMUX_API_KEY'], { configDir: store });
    assert.equal(remove.status, 0, `del failed: ${remove.stderr}`);
    await delay(20); // ensure a distinct bundle mtime

    const afterRemove = await status();
    assert.deepEqual(afterRemove.bundleDrift.removed, ['zenmux'], 'the vanished provider key must be reported');
    assert.equal(afterRemove.bundleDrift.providersBefore, 2);
    assert.equal(afterRemove.bundleDrift.providersAfter, 1);
    assert.ok(
      afterRemove.loadedProviders.some((row) => row.provider === 'zenmux'),
      'in-memory keys are kept (reported, never silently dropped)'
    );

    // No further stat change is a no-op: the drift record is not overwritten.
    const stable = await status();
    assert.equal(stable.bundleDrift.removed.length, 1);
    assert.equal(stable.bundleDrift.detectedAt, afterRemove.bundleDrift.detectedAt);
  } finally {
    server?.kill();
    await delay(300);
    rmSync(root, { recursive: true, force: true });
  }
});
