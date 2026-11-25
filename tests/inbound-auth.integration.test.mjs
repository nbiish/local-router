import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scrubbedEnv } from './test-env.mjs';

// Integration suite for inbound access control: a real router process behind
// the same gate a Cloudflare Tunnel hits. Loopback clients stay ungated;
// public clients (cf-connecting-ip, like cloudflared presents) must carry the
// access key on the inference allowlist and can never reach the dashboard or
// admin API. A second server without any configured key proves the fail-closed
// 503. Scrubbed env (test-env.mjs): the only credential these servers ever see
// is the test access key set explicitly below.

const BASE_ENV = scrubbedEnv(); // snapshot before any key is set

const ACCESS_KEY = 'integration-access-key-0123456789abcdef-end';
// Same length, differs only in the final byte — the near-miss a timing-unsafe
// compare might accept.
const NEAR_MISS_KEY = ACCESS_KEY.slice(0, -1) + (ACCESS_KEY.endsWith('d') ? 'e' : 'd');
const PUBLIC_IP = '203.0.113.9';

const portA = String(19400 + Math.floor(Math.random() * 300));
const portB = String(19700 + Math.floor(Math.random() * 300));
const baseA = `http://127.0.0.1:${portA}`;
const baseB = `http://127.0.0.1:${portB}`;

let homeA = '';
let homeB = '';
let serverA;
let serverB;
let logsA = '';

function childEnvFor(home, port, withKey) {
  const env = {
    ...BASE_ENV,
    HOME: home,
    USERPROFILE: home,
    PORT: port,
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
    LOCAL_ROUTER_SKIP_OS_ENV: '1',
    LOCAL_ROUTER_DEV: 'true'
  };
  if (withKey) env.LOCAL_ROUTER_ACCESS_KEY = ACCESS_KEY;
  return env;
}

async function waitForServer(baseUrl, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready within 20s`);
}

test.before(async () => {
  homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'local-router-inbound-a-'));
  homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'local-router-inbound-b-'));

  serverA = spawn('node', ['build/index.js'], { env: childEnvFor(homeA, portA, true) });
  serverA.stdout.on('data', (d) => { logsA += d.toString(); });
  serverA.stderr.on('data', (d) => { logsA += d.toString(); });
  serverB = spawn('node', ['build/index.js'], { env: childEnvFor(homeB, portB, false) });
  serverB.stdout.on('data', () => {});
  serverB.stderr.on('data', () => {});
  await Promise.all([
    waitForServer(baseA, 'keyed server (A)'),
    waitForServer(baseB, 'keyless server (B)')
  ]);
});

test.after(async () => {
  for (const proc of [serverA, serverB]) {
    if (proc) {
      proc.kill();
      await once(proc, 'exit').catch(() => {});
    }
  }
  for (const home of [homeA, homeB]) {
    if (home) fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── Server A: access key configured ─────────────────────────────────────────

test('loopback dashboard/admin stays open with no credentials (server A)', async () => {
  const settings = await fetch(`${baseA}/api/router-settings`);
  assert.equal(settings.status, 200);
  const body = await settings.json();
  assert.ok(body && typeof body === 'object', 'router-settings returns JSON config');

  const config = await fetch(`${baseA}/config`);
  assert.ok([200, 302].includes(config.status), `dashboard reachable, got ${config.status}`);
});

test('loopback inference is not gated (server A)', async () => {
  const models = await fetch(`${baseA}/v1/models`);
  assert.equal(models.status, 200);
  const body = await models.json();
  assert.ok(Array.isArray(body.data), '/v1/models returns the OpenAI-shaped list');
});

test('public inference without a key is rejected 401 with no-store (server A)', async () => {
  const res = await fetch(`${baseA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': PUBLIC_IP },
    body: JSON.stringify({ model: 'zai:glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { error: 'invalid or missing access key' });
});

test('public inference with a same-length, last-byte-different key is rejected 401 (server A)', async () => {
  const res = await fetch(`${baseA}/v1/models`, {
    headers: { 'cf-connecting-ip': PUBLIC_IP, authorization: `Bearer ${NEAR_MISS_KEY}` }
  });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'invalid or missing access key' });
});

test('public inference with the right key passes the gate (server A)', async () => {
  const models = await fetch(`${baseA}/v1/models`, {
    headers: { 'cf-connecting-ip': PUBLIC_IP, authorization: `Bearer ${ACCESS_KEY}` }
  });
  assert.equal(models.status, 200, 'keyed public request reaches the inference route');
  const body = await models.json();
  assert.ok(Array.isArray(body.data));

  // Anthropic-style clients use x-api-key instead of Bearer.
  const viaXApiKey = await fetch(`${baseA}/v1/models`, {
    headers: { 'cf-connecting-ip': PUBLIC_IP, 'x-api-key': ACCESS_KEY }
  });
  assert.equal(viaXApiKey.status, 200, 'x-api-key authorizes like Bearer');
});

test('public chat completions with the right key reaches the routing logic (server A)', async () => {
  // The gate must let it through; whatever the router answers afterwards is a
  // ROUTER answer (no providers configured in the test home), never a gate
  // rejection. Assert on the discriminator bodies, not just the status.
  const res = await fetch(`${baseA}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': PUBLIC_IP, authorization: `Bearer ${ACCESS_KEY}` },
    body: JSON.stringify({ model: 'zai:glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.ok(res.status !== 401 && res.status !== 403, `gate must pass the request, got ${res.status}`);
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* streaming or non-JSON router error is fine */ }
  assert.ok(body.error !== 'invalid or missing access key');
  assert.ok(body.error !== 'local access only');
  assert.ok(body.error !== 'access key not configured');
});

test('public admin/config/unknown paths are 403 local-access-only even with the right key (server A)', async () => {
  const cases = [
    `${baseA}/api/router-settings`,
    `${baseA}/config`,
    `${baseA}/config/providers`,
    `${baseA}/api/fallback-models`,
    `${baseA}/api/health`,
    `${baseA}/definitely-not-a-route`
  ];
  for (const url of cases) {
    const res = await fetch(url, {
      headers: { 'cf-connecting-ip': PUBLIC_IP, authorization: `Bearer ${ACCESS_KEY}` }
    });
    assert.equal(res.status, 403, url);
    assert.equal(res.headers.get('cache-control'), 'no-store', url);
    assert.deepEqual(await res.json(), { error: 'local access only' }, url);
  }
});

test('a loopback client presenting cf-connecting-ip is classified public and gated (server A)', () => {
  // The test process IS a loopback client; the header alone moves it into the
  // public class, exactly like cloudflared's connection looks.
  return fetch(`${baseA}/v1/models`, { headers: { 'cf-connecting-ip': PUBLIC_IP } }).then((res) => {
    assert.equal(res.status, 401);
    return res.json();
  }).then((body) => {
    assert.deepEqual(body, { error: 'invalid or missing access key' });
  });
});

// ── CORS hardening (server A) ───────────────────────────────────────────────

test('loopback allowlisted origin is reflected; non-allowlisted origin gets no ACAO', async () => {
  const allowlisted = await fetch(`${baseA}/v1/models`, {
    headers: { origin: `http://127.0.0.1:${portA}` }
  });
  assert.equal(allowlisted.status, 200);
  assert.equal(allowlisted.headers.get('access-control-allow-origin'), `http://127.0.0.1:${portA}`);
  assert.ok((allowlisted.headers.get('vary') || '').includes('Origin'));
  assert.equal(allowlisted.headers.get('access-control-allow-credentials'), null, 'no credentials, ever');

  const evil = await fetch(`${baseA}/v1/models`, { headers: { origin: 'http://evil.example' } });
  assert.equal(evil.status, 200, 'request itself still served for non-browser clients');
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'evil origin never reflected');
});

test('loopback preflight is answered for allowlisted origins only', async () => {
  const allowed = await fetch(`${baseA}/api/router-settings`, {
    method: 'OPTIONS',
    headers: {
      origin: `http://localhost:${portA}`,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization, content-type'
    }
  });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), `http://localhost:${portA}`);
  const headers = (allowed.headers.get('access-control-allow-headers') || '').toLowerCase();
  assert.ok(headers.includes('authorization'), 'preflight allows Authorization');
  assert.ok(headers.includes('x-api-key'), 'preflight allows X-Api-Key');
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);

  const evil = await fetch(`${baseA}/api/router-settings`, {
    method: 'OPTIONS',
    headers: {
      origin: 'http://evil.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization'
    }
  });
  assert.equal(evil.status, 204);
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'evil preflight gets no CORS headers');
});

test('public responses carry no CORS headers at all (server A)', async () => {
  const res = await fetch(`${baseA}/v1/models`, {
    headers: { 'cf-connecting-ip': PUBLIC_IP, origin: `http://127.0.0.1:${portA}`, authorization: `Bearer ${ACCESS_KEY}` }
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no wildcard or reflected origin for public clients');
});

// ── Server B: no access key configured ──────────────────────────────────────

test('keyless server fails closed for public inference with 503 (server B)', async () => {
  const res = await fetch(`${baseB}/v1/models`, { headers: { 'cf-connecting-ip': PUBLIC_IP } });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await res.json(), { error: 'access key not configured' });
});

test('keyless server keeps loopback fully open (server B)', async () => {
  const models = await fetch(`${baseB}/v1/models`);
  assert.equal(models.status, 200);
  const dashboard = await fetch(`${baseB}/api/router-settings`);
  assert.equal(dashboard.status, 200);
});
