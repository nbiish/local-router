import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Where the chain config lives (2026-11-10).
//
// router-settings.json used to be `~/.config/local-router/router-settings.json`
// on every machine, so a repo synced between boxes carried the CODE but not the
// CHAIN: the second machine booted with its own stale chain and nothing on disk
// showed the difference. The file now lives in the checkout, which is the unit
// that syncs.
//
// Two rules are worth pinning down because both are easy to break:
//  1. A checkout copy is authoritative — reads, the disk watcher, and every write
//     go to <checkout>/router-settings.json, and the machine copy is only a seed.
//  2. An isolated HOME must still isolate. Tests, CI and sandboxes repoint HOME;
//     if that still resolved to the checkout, a test run would rewrite a real
//     chain. That is the exact failure the 2026-11-09 verification incident hit.

const modulePath = resolve(process.cwd(), 'build', 'config-paths.js');
const port = String(28400 + Math.floor(Math.random() * 300));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let serverLogs = '';

const machineHome = mkdtempSync(join(tmpdir(), 'lr-config-home-'));
const seedCheckout = mkdtempSync(join(tmpdir(), 'lr-config-seed-checkout-'));
const plainDir = mkdtempSync(join(tmpdir(), 'lr-config-plain-'));

function writeJson(pathname, payload) {
  mkdirSync(join(pathname, '..'), { recursive: true });
  writeFileSync(pathname, JSON.stringify(payload, null, 2));
}

function readJson(pathname) {
  return JSON.parse(readFileSync(pathname, 'utf8'));
}

/** Make a directory look like a checkout: package.json for this project + .git. */
function makeCheckout(dir) {
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeJson(join(dir, 'package.json'), { name: 'local-router', version: '0.0.0-test' });
  return dir;
}

/** Resolve the config location in a child process with exactly `env`. */
function resolveLocationIn(env) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('LOCAL_ROUTER_') || key === 'HOME' || key === 'USERPROFILE') delete clean[key];
  }
  const code = [
    `const m = require(${JSON.stringify(modulePath)});`,
    `process.stdout.write(JSON.stringify({`,
    `  location: m.configLocation('router-settings.json'),`,
    `  machineDir: m.machineConfigDir(),`,
    `  checkout: m.checkoutRoot()`,
    `}));`
  ].join('');
  const raw = execFileSync(process.execPath, ['-e', code], {
    env: { ...clean, ...env },
    encoding: 'utf8'
  });
  return JSON.parse(raw);
}

async function startServer(env) {
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_DEV: 'true',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try {
      ready = (await fetch(`${baseUrl}/api/version`)).ok;
    } catch {
      await delay(100);
    }
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
  const body = await (await fetch(`${baseUrl}/api/fallback-models`)).json();
  const entry = (body?.data || []).find((route) => route.routeId === 'fallback-models' || route.id === 'fallback-models');
  return Array.isArray(entry?.models) ? entry.models : null;
}

test.after(() => {
  for (const dir of [machineHome, seedCheckout, plainDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LOCAL_ROUTER_CONFIG_DIR pins both roots, so tests and CI stay isolated', () => {
  const pinned = join(machineHome, 'pinned');
  const { location, machineDir } = resolveLocationIn({ LOCAL_ROUTER_CONFIG_DIR: pinned });
  assert.equal(location.source, 'env');
  assert.equal(location.path, join(pinned, 'router-settings.json'));
  assert.equal(machineDir, resolve(pinned));
});

test('a checkout root puts router-settings.json inside the repository', () => {
  const checkout = makeCheckout(mkdtempSync(join(tmpdir(), 'lr-config-checkout-')));
  try {
    const { location, checkout: detected } = resolveLocationIn({ LOCAL_ROUTER_REPO_ROOT: checkout });
    assert.equal(detected, resolve(checkout));
    assert.equal(location.source, 'checkout');
    assert.equal(location.path, join(resolve(checkout), 'router-settings.json'));
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('a directory that is only project-shaped is not a checkout', () => {
  // Same package.json but no `.git`: a packaged install must not write config
  // into its (often read-only) application directory.
  writeJson(join(plainDir, 'package.json'), { name: 'local-router', version: '0.0.0-test' });
  const { location, checkout: detected } = resolveLocationIn({ LOCAL_ROUTER_REPO_ROOT: plainDir });
  assert.equal(detected, null);
  assert.notEqual(location.source, 'checkout');
});

test('an overridden HOME keeps config inside that HOME, never in the checkout', () => {
  // This is the rule that protects a real chain file from a test run: the
  // harness repoints HOME, which states "this process is isolated".
  const isolatedHome = mkdtempSync(join(tmpdir(), 'lr-config-isolated-'));
  try {
    const { location } = resolveLocationIn({ HOME: isolatedHome, USERPROFILE: isolatedHome });
    assert.equal(location.source, 'machine');
    assert.equal(location.path, join(resolve(isolatedHome), '.config', 'local-router', 'router-settings.json'));
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

test('a real HOME in this checkout resolves to the checkout copy', () => {
  // Guarded: when the suite itself runs under an overridden HOME there is no
  // "real checkout" configuration to assert.
  const overridden = resolve(homedir()) !== resolve(userInfo().homedir);
  if (overridden) {
    assert.ok(true, 'suite runs with an isolated HOME — checkout resolution is covered by the env test');
    return;
  }
  const { location } = resolveLocationIn({});
  assert.equal(location.source, 'checkout');
  assert.equal(location.path, join(resolve(process.cwd()), 'router-settings.json'));
});

test('the checkout copy is seeded once, then authoritative for reads, the watcher, and writes', async () => {
  const checkout = makeCheckout(mkdtempSync(join(tmpdir(), 'lr-config-sync-')));
  const machineSettings = join(machineHome, '.config', 'local-router', 'router-settings.json');
  const checkoutSettings = join(checkout, 'router-settings.json');
  const seeded = {
    fallbackModelsText: 'zai-seed-one\nzenmux-seed-two',
    routes: [
      {
        id: 'fallback-embedding',
        models: ['openrouter/openai/text-embedding-3-small', 'zenmux/openai/text-embedding-3-small']
      },
      { id: 'fallback-models', models: ['zai-seed-one', 'zenmux-seed-two'] }
    ]
  };
  writeJson(machineSettings, seeded);
  assert.equal(existsSync(checkoutSettings), false, 'checkout starts without a chain file');

  await startServer({
    HOME: machineHome,
    USERPROFILE: machineHome,
    LOCAL_ROUTER_REPO_ROOT: checkout
  });

  try {
    assert.deepEqual(await systemChainModels(), ['zai-seed-one', 'zenmux-seed-two'], 'the machine copy seeds the first boot');
    assert.ok(existsSync(checkoutSettings), 'the first boot must create the checkout copy');
    // The seed is a copy, not a rewrite: the chain and every route it carried are
    // present afterwards. Boot is allowed to add its own purpose routes (the
    // decision/embedding routes the router always maintains) on top.
    const seededFile = readJson(checkoutSettings);
    assert.equal(seededFile.fallbackModelsText, seeded.fallbackModelsText, 'seeding copies the chain verbatim');
    for (const route of seeded.routes) {
      const written = (seededFile.routes || []).find((entry) => entry.id === route.id);
      assert.ok(written, `seeded route ${route.id} must survive seeding`);
      assert.deepEqual(written.models, route.models, `seeded route ${route.id} must keep its steps`);
    }
    assert.ok(existsSync(machineSettings), 'seeding copies, it never moves the machine file');

    // A chain synced in from another machine (file replaced on disk) is applied
    // by the watcher without a restart.
    const synced = {
      fallbackModelsText: 'zai-synced-one\nzenmux-synced-two\ncline-synced-three',
      routes: [
        {
          id: 'fallback-embedding',
          models: ['openrouter/openai/text-embedding-3-small', 'zenmux/openai/text-embedding-3-small']
        },
        { id: 'fallback-models', models: ['zai-synced-one', 'zenmux-synced-two', 'cline-synced-three'] }
      ]
    };
    writeJson(checkoutSettings, synced);
    let watched = null;
    for (let i = 0; i < 40 && watched === null; i++) {
      await delay(200);
      const models = await systemChainModels();
      if (models && models.length === 3) watched = models;
    }
    assert.deepEqual(watched, synced.routes[1].models, 'the checkout file is watched and applied live');

    // An API write lands in the checkout copy and leaves the machine copy alone.
    const put = await fetch(`${baseUrl}/api/router-settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fallbackModelsText: 'api-one\napi-two' })
    });
    assert.equal(put.status, 200, 'settings PUT must succeed: ' + JSON.stringify(await put.json().catch(() => ({}))));

    const written = readJson(checkoutSettings);
    assert.equal(written.fallbackModelsText, 'api-one\napi-two', 'writes go to the checkout copy');
    // The bulk-settings write used to clobber the file with `{ fallbackModelsText }`
    // alone, dropping every other route from the authoritative file.
    assert.ok(
      (written.routes || []).some((route) => route.id === 'fallback-embedding'),
      'a settings write must keep the other routes in the file: ' + JSON.stringify(written)
    );
    assert.equal(readJson(machineSettings).fallbackModelsText, seeded.fallbackModelsText, 'the machine copy is not rewritten');
  } finally {
    await stopServer();
    rmSync(checkout, { recursive: true, force: true });
  }
});

test('a step this machine cannot resolve is kept in the shared chain, not deleted', async () => {
  // Measured on the synced Mac checkout (2026-11-10): its catalog knew 14 of the
  // 17 ids, one boot rewrote the shared chain file down to those 14, and the loss
  // was only visible as a missing step. A machine that has not refreshed its
  // providers yet must not edit the fleet's chain; an unknown step is skipped at
  // request time instead.
  const checkout = makeCheckout(mkdtempSync(join(tmpdir(), 'lr-config-unknown-')));
  const home = mkdtempSync(join(tmpdir(), 'lr-config-unknown-home-'));
  const checkoutSettings = join(checkout, 'router-settings.json');
  const chain = ['zai-unresolvable-step-at-boot', 'zai-glm-5.3-flash'];
  writeJson(checkoutSettings, {
    fallbackModelsText: chain.join('\n'),
    routes: [{ id: 'fallback-models', models: chain }]
  });

  await startServer({
    HOME: home,
    USERPROFILE: home,
    LOCAL_ROUTER_REPO_ROOT: checkout
  });

  try {
    assert.deepEqual(await systemChainModels(), chain, 'the unresolved step must survive the boot in memory');
    const written = readJson(checkoutSettings);
    const writtenRoute = (written.routes || []).find((route) => route.id === 'fallback-models');
    assert.deepEqual(writtenRoute.models, chain, 'the unresolved step must survive the boot in the file');
  } finally {
    await stopServer();
    rmSync(checkout, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
