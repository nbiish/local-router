import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * TypeSafe as the first decision transport, and per-provider model configuration.
 *
 * The provider chain is only as good as its configurability: a new Jev build reaches the direct API
 * before a reseller, so each provider needs its own model pin. These tests cover both the wiring
 * (TypeSafe resolves a key and is tried first) and the configuration contract (an override changes
 * what a provider is asked for, a typo is ignored rather than forwarded, and a provider pinned to a
 * different build is not offered a model it would reject).
 */

async function boot(t, env) {
  const home = mkdtempSync(join(tmpdir(), 'local-router-typesafe-'));
  const port = String(29100 + Math.floor(Math.random() * 400));
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
  const status = await (await fetch(`${baseUrl}/api/decisions/status`)).json();
  return { baseUrl, status, logs: () => logs };
}

function provider(status, name) {
  return (status.providers || []).find((p) => p.name === name);
}

test('TypeSafe is the first decision transport and resolves the documented key name', async (t) => {
  // TYPESAFE_API_KEY is the name TypeSafe documents and the name the fleet tooling resolves.
  const { status, logs } = await boot(t, { TYPESAFE_API_KEY: 'test-key' });

  assert.deepEqual(status.order, ['typesafe', 'openrouter', 'zenmux'],
    `the source API must be tried first: ${JSON.stringify(status.order)}\n${logs()}`);

  const ts = provider(status, 'typesafe');
  assert.ok(ts, 'typesafe must be a decision provider');
  assert.equal(ts.key_configured, true,
    'the bare provider-documented key name must be honoured, not only the LOCALROUTER_-prefixed form');
  assert.equal(ts.endpoint, 'https://api.typesafe.ai/v1/systemone');
  assert.deepEqual(ts.primitives, ['noul', 'choice', 'score'], 'the native API supports all three primitives');
});

test('the router-prefixed key name still takes precedence', async (t) => {
  const { status } = await boot(t, { LOCALROUTER_TYPESAFE_API_KEY: 'test-key' });
  assert.equal(provider(status, 'typesafe').key_configured, true);
});

test('each provider has its own model pin and reports it', async (t) => {
  const { status, logs } = await boot(t, { TYPESAFE_API_KEY: 'k', LOCALROUTER_OPENROUTER_API_KEY: 'k' });

  const ts = provider(status, 'typesafe');
  assert.equal(ts.configured_model, 'typesafe/jev-1.14');
  assert.equal(ts.model_env_var, 'LOCAL_ROUTER_DECISION_TYPESAFE_MODEL',
    'the status must name the override an operator should set');

  // Every provider exposes the same contract, so the page can show all three consistently.
  for (const p of status.providers) {
    assert.ok(p.configured_model, `${p.name} must report the build it will be asked for`);
    assert.ok(p.model_env_var, `${p.name} must report its override variable`);
  }
  assert.match(logs(), /decisions|typesafe/i);
});

test('an override advances one provider without touching the others', async (t) => {
  const { status } = await boot(t, {
    TYPESAFE_API_KEY: 'k',
    LOCALROUTER_OPENROUTER_API_KEY: 'k',
    LOCAL_ROUTER_DECISION_TYPESAFE_MODEL: 'typesafe/jev-1.15'
  });

  assert.equal(provider(status, 'typesafe').configured_model, 'typesafe/jev-1.15');
  assert.equal(provider(status, 'openrouter').configured_model, 'typesafe/jev-1.14',
    'advancing the direct API must not move the resellers');

  // The advertised id follows the configured build, so discovery never offers an id the provider
  // would reject.
  const advertised = (status.advertised_models || []).map((m) => m.id);
  assert.ok(advertised.includes('typesafe/jev-1.15'),
    `advertised ids must reflect the configured build: ${advertised.join(', ')}`);
});

test('an unrecognised model override is ignored rather than forwarded', async (t) => {
  const { status } = await boot(t, {
    TYPESAFE_API_KEY: 'k',
    LOCAL_ROUTER_DECISION_TYPESAFE_MODEL: 'definitely-not-a-decision-model'
  });

  assert.equal(provider(status, 'typesafe').configured_model, 'typesafe/jev-1.14',
    'a typo must fall back to the known build instead of sending a non-decision id upstream');
});

test('a provider pinned to an older build is not offered the newer request', async (t) => {
  const { baseUrl, status } = await boot(t, {
    TYPESAFE_API_KEY: 'k',
    LOCALROUTER_OPENROUTER_API_KEY: 'k',
    LOCAL_ROUTER_DECISION_TYPESAFE_MODEL: 'typesafe/jev-1.15'
  });

  // TypeSafe is on 1.15, the resellers are on 1.14. A 1.15 request cannot be served by a provider
  // configured for 1.14, so the chain must narrow to just TypeSafe and say so rather than send
  // OpenRouter an id it publishes as unsupported.
  const r = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'typesafe/jev-1.15',
      questions: { q: { type: 'noul', instructions: 'Is this a probe?', criteria: { true: 'probe', false: 'not' } } },
      state: 'This is a probe.'
    }),
    signal: AbortSignal.timeout(45000)
  });
  const body = await r.json();
  const attempts = body.attempts || body.error?.attempts || [];
  const tried = attempts.map((a) => a.provider);

  assert.ok(!tried.includes('openrouter'),
    `a provider on 1.14 must not be asked for 1.15: ${JSON.stringify(attempts)}`);
  assert.ok(tried.includes('typesafe'),
    `the provider configured for 1.15 must be tried: ${JSON.stringify(attempts)}`);
});
