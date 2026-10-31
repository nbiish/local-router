import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Pinned decision models: `openrouter/jev-1.14` must be served whenever the
 * OpenRouter key is configured — no curation toggle, catalog edit, or shadowing
 * provider-model row may remove it. The mirror case (no key) must stay
 * unadvertised so discovery never points at a transport that cannot serve.
 */

const worktreeRoot = fileURLToPath(new URL('..', import.meta.url));
const keyedPort = String(18600 + Math.floor(Math.random() * 200));
const unkeyedPort = String(18800 + Math.floor(Math.random() * 200));
const keyedBase = `http://127.0.0.1:${keyedPort}`;
const unkeyedBase = `http://127.0.0.1:${unkeyedPort}`;

const servers = [];
let keyedHome = '';
let unkeyedHome = '';

function seedHome(home, options = {}) {
  const configDir = join(home, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(home, 'pqc'), { recursive: true });

  if (options.shadowCatalogRow) {
    writeFileSync(
      join(configDir, 'endpoint-models-cache.json'),
      JSON.stringify([
        {
          id: 'openrouter/jev-1.14',
          provider: 'openrouter',
          model: 'jev-1.14',
          display: 'Shadow chat row',
          contextLength: 8192,
          outputTokens: 1024,
          supportsTools: true,
          supportsImages: false,
          supportsCache: false,
          supportsReasoning: false
        }
      ])
    );
    writeFileSync(
      join(configDir, 'model-source-config.json'),
      JSON.stringify({
        source: 'endpoints',
        filterConfigured: true,
        curationEnabled: true,
        curatedEndpointModelKeys: ['openrouter::jev-1.14'],
        operatorClearedProviders: []
      })
    );
  }
}

function baseEnv(home, port) {
  const env = {
    ...process.env,
    PORT: port,
    HOME: home,
    USERPROFILE: home,
    // Keep every write inside the temp store: these tests must never touch the
    // operator's real PQC bundle.
    PQC_STORE_ISOLATED: '1',
    PQC_CONFIG_DIR: join(home, 'pqc'),
    PQC_SECRETS_DIR: join(home, 'pqc'),
    LOCAL_ROUTER_PQC_SCAN_WSL: '0'
  };
  for (const key of [
    'OPENROUTER_API_KEY',
    'ZENMUX_API_KEY',
    'LOCALROUTER_OPENROUTER_API_KEY',
    'LOCALROUTER_ZENMUX_API_KEY',
    'LOCAL_ROUTER_OPENROUTER_API_KEY',
    'LOCAL_ROUTER_ZENMUX_API_KEY'
  ]) {
    delete env[key];
  }
  return env;
}

async function startServer(env, baseUrl, label) {
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: worktreeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); });
  child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  servers.push(child);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${label} exited early (${child.exitCode})\n${logs}`);
    try {
      const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await delay(200);
  }
  throw new Error(`${label} did not become ready\n${logs}`);
}

async function decisionRows(baseUrl) {
  const body = await (await fetch(`${baseUrl}/v1/models`)).json();
  return body.data.filter((model) => model.id === 'openrouter/jev-1.14');
}

test.before(async () => {
  keyedHome = mkdtempSync(join(tmpdir(), 'lr-pinned-keyed-'));
  unkeyedHome = mkdtempSync(join(tmpdir(), 'lr-pinned-unkeyed-'));

  // A catalog row that shadows the decision id: dedupe must keep exactly one,
  // and it must be the decision row.
  seedHome(keyedHome, { shadowCatalogRow: true });
  seedHome(unkeyedHome);

  const keyedEnv = baseEnv(keyedHome, keyedPort);
  keyedEnv.LOCALROUTER_OPENROUTER_API_KEY = 'test-openrouter-key';
  await startServer(keyedEnv, keyedBase, 'keyed router');
  await startServer(baseEnv(unkeyedHome, unkeyedPort), unkeyedBase, 'unkeyed router');
});

test.after(async () => {
  for (const child of servers) child.kill();
  for (const home of [keyedHome, unkeyedHome]) {
    if (home) rmSync(home, { recursive: true, force: true });
  }
});

async function putJson(url, body) {
  return fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('a shadowing catalog row cannot duplicate the decision model', async () => {
  // Prove the seeded shadow row is still in the catalog, so the single result
  // below is dedupe at work rather than the row being pruned at boot.
  const curation = await (await fetch(`${keyedBase}/api/model-curation`)).json();
  assert.ok(
    curation.selectedKeys.includes('openrouter::jev-1.14'),
    `shadow row missing from catalog: ${JSON.stringify(curation.selectedKeys)}`
  );

  const rows = await decisionRows(keyedBase);
  assert.equal(rows.length, 1, `expected exactly one openrouter/jev-1.14, got ${JSON.stringify(rows.map((r) => r.id))}`);
  assert.equal(rows[0].capabilities.decisions, true);
  assert.equal(rows[0].owned_by, 'openrouter');
});

test('clearing curation keeps the decision model served', async () => {
  // Removing the only curated entry is a >=50% shrink: force it.
  const cleared = await putJson(`${keyedBase}/api/model-curation`, { selectedKeys: [], force: true });
  assert.equal(cleared.status, 200, await cleared.text());
  assert.equal((await decisionRows(keyedBase)).length, 1);

  const replaced = await putJson(`${keyedBase}/api/model-curation`, { selectedKeys: ['some-vendor::unrelated'], force: true });
  assert.equal(replaced.status, 200, await replaced.text());
  assert.equal((await decisionRows(keyedBase)).length, 1);

  const enabled = await putJson(`${keyedBase}/api/model-curation`, { enabled: true });
  assert.equal(enabled.status, 200, await enabled.text());
  assert.equal((await decisionRows(keyedBase)).length, 1);
});

test('toggling the configured-model filter does not change decision availability', async () => {
  const off = await putJson(`${keyedBase}/api/model-source`, { filterConfigured: false });
  assert.equal(off.status, 200, await off.text());
  assert.equal((await decisionRows(keyedBase)).length, 1);

  const on = await putJson(`${keyedBase}/api/model-source`, { filterConfigured: true });
  assert.equal(on.status, 200, await on.text());
  assert.equal((await decisionRows(keyedBase)).length, 1);
});

test('the Ollama-compatible surface and the provider-scoped listing agree', async () => {
  const tags = await (await fetch(`${keyedBase}/api/tags`)).json();
  assert.equal(tags.models.filter((model) => model.name === 'openrouter/jev-1.14').length, 1);

  const scoped = await (await fetch(`${keyedBase}/v1/models?provider=openrouter`)).json();
  const rows = scoped.data.filter((model) => model.id === 'openrouter/jev-1.14');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].capabilities.decisions, true);

  // /api/show must describe a model the router advertises, not 404 it.
  const show = await fetch(`${keyedBase}/api/show/openrouter/jev-1.14`);
  assert.equal(show.status, 200);
  const shown = await show.json();
  assert.equal(shown.model_info['general.provider'], 'openrouter');
  assert.equal(shown.model_info['general.upstream_model'], 'typesafe/jev-1.14');
});

test('decision ids are reserved: a provider model cannot shadow the transport', async () => {
  const response = await fetch(`${keyedBase}/api/provider-models/openrouter/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'openrouter/jev-1.14', model: 'jev-1.14' })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /already exists/);
  // And the real row survived the attempt.
  const rows = await decisionRows(keyedBase);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].capabilities.decisions, true);
});

test('with no OpenRouter key the decision model is not advertised', async () => {
  assert.equal((await decisionRows(unkeyedBase)).length, 0);

  const status = await (await fetch(`${unkeyedBase}/api/decisions/status`)).json();
  assert.equal(status.ready, false);
  assert.deepEqual(status.advertised_models, []);

  // The decisions route still fails honestly instead of pretending to answer.
  const response = await fetch(`${unkeyedBase}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'typesafe/jev-1.14',
      state: 'probe',
      questions: {
        q: { type: 'noul', instructions: 'Is this reachable?', criteria: { true: 'yes', false: 'no' } }
      }
    })
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.type, 'decision_provider_unavailable');
});
