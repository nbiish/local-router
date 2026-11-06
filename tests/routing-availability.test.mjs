import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * `/api/routing/availability` backs the readiness badges on the Fallback Routes page, so a wrong
 * answer is worse than no answer: an operator reads "Unavailable" on a route that works and either
 * rewrites a good chain or stops trusting the page.
 *
 * Two defects are covered, both found by loading the page against a live router:
 *
 *   1. `resolved` required the model to be SERVED as a chat model. An embedding model is
 *      catalogued without being chat-served, so every embedding step read "unavailable".
 *   2. A typed decision model carries no provider in its id, so the generic path attributed it to
 *      a provider named "typesafe" and reported "No key" on a working decision route.
 */

async function boot(t, { routes, env }) {
  const home = mkdtempSync(join(tmpdir(), 'local-router-availability-'));
  const configDir = join(home, '.config', 'local-router');
  mkdirSync(configDir, { recursive: true });
  if (routes) {
    writeFileSync(join(configDir, 'router-settings.json'), JSON.stringify({ routes }, null, 2));
  }

  const port = String(28500 + Math.floor(Math.random() * 400));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, HOME: home, USERPROFILE: home, PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true', LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true', LOCAL_ROUTER_DEV: 'true',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c.toString(); });
  child.stderr.on('data', (c) => { logs += c.toString(); });

  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(3000)]).catch(() => undefined);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    rmSync(home, { recursive: true, force: true });
  });

  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${baseUrl}/api/version`)).ok) break; } catch {}
    await delay(100);
  }
  return { baseUrl, logs: () => logs };
}

async function availability(baseUrl, models) {
  const res = await fetch(`${baseUrl}/api/routing/availability?models=${encodeURIComponent(models.join(','))}`);
  const body = await res.json();
  const byModel = new Map((body.data || []).map((row) => [row.model, row]));
  return byModel;
}

test('a catalogued-but-not-served embedding model reads as known', async (t) => {
  // The failure case is a model that exists in the provider registry but is NOT curated/served as
  // a chat model — every embedding model. A custom provider would make the model served and mask
  // the bug, so this uses a built-in provider's registry entry with only its key present.
  const { baseUrl, logs } = await boot(t, {
    routes: [{ id: 'fallback-embedding', models: ['zenmux/openai/text-embedding-3-small'] }],
    env: { LOCALROUTER_ZENMUX_API_KEY: 'test-key' }
  });

  const rows = await availability(baseUrl, ['zenmux/openai/text-embedding-3-small']);
  const row = rows.get('zenmux/openai/text-embedding-3-small');
  assert.ok(row, `no availability row\n${logs()}`);
  assert.equal(row.keyConfigured, true, 'the key is present, so it must not be reported missing');
  assert.equal(row.resolved, true,
    `a catalogued embedding model must resolve even though it is not chat-served: ${JSON.stringify(row)}`);
  assert.equal(row.status, 'ready',
    `a keyed, catalogued embedding model must read as ready: ${JSON.stringify(row)}`);
});

test('a typed decision model reads as ready through its decision transport', async (t) => {
  const { baseUrl, logs } = await boot(t, {
    routes: [{ id: 'fallback-decision', models: ['typesafe/jev-1.14'] }],
    // The router resolves provider keys from the consumer-prefixed name, so use that form.
    env: { LOCALROUTER_OPENROUTER_API_KEY: 'test-key' }
  });

  const rows = await availability(baseUrl, ['typesafe/jev-1.14', 'local-router/fallback-decision']);
  const bare = rows.get('typesafe/jev-1.14');
  assert.ok(bare, `no availability row for the model\n${logs()}`);

  // The provider must be a real decision transport, never the "typesafe" namespace prefix.
  assert.notEqual(bare.provider, 'typesafe',
    `a decision model must not be attributed to a provider named after its id prefix: ${JSON.stringify(bare)}`);
  assert.equal(bare.status, 'ready', `a keyed decision model must read as ready: ${JSON.stringify(bare)}`);
});
