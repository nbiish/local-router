import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Regression coverage for the "logout does nothing" bug: deleting the stored
// OAuth credential used to be instantly undone by host-session re-detection
// (the Cursor IDE state DB is re-read by getOAuthState's fallback), so the UI
// flipped straight back to "Logged in". Logout must stick until the host
// presents a genuinely different session.

const port = String(29000 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let testHome = '';
let serverLogs = '';
let oldToken = '';

function jwtLikeToken(payload) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

function writeCursorDb({ accessToken, email, membership }) {
  const dbDir = join(testHome, '.config', 'Cursor', 'User', 'globalStorage');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'state.vscdb');
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)');
  const insert = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  insert.run('cursorAuth/accessToken', accessToken);
  insert.run('cursorAuth/refreshToken', 'rt-test');
  insert.run('cursorAuth/cachedEmail', email);
  insert.run('cursorAuth/stripeMembershipType', membership);
  db.close();
}

function readJson(pathname, options) {
  return fetch(`${baseUrl}${pathname}`, options).then(async (response) => {
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = { parseError: true, raw: text }; }
    }
    return { response, body };
  });
}

const getJson = (pathname) => readJson(pathname);
const postJson = (pathname, payload) => readJson(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
const deleteJson = (pathname) => readJson(pathname, { method: 'DELETE' });

async function startServer(extraEnv = {}) {
  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS: '0',
      LOCAL_ROUTER_DEV: 'true',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });

  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  testHome = mkdtempSync(join(tmpdir(), 'local-router-oauth-logout-'));
  oldToken = jwtLikeToken({ exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600, email: 'old@cursor.test' });
  writeCursorDb({ accessToken: oldToken, email: 'old@cursor.test', membership: 'pro' });
  await startServer();
});

test.after(async () => {
  await stopServer();
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('logout survives host-session re-detection until a fresh login appears', async () => {
  // Boot: the fake Cursor IDE DB is detected and adopted.
  const before = await getJson('/api/oauth/status/cursor');
  assert.equal(before.response.status, 200);
  assert.equal(before.body.configured, true);
  assert.equal(before.body.accountLabel, 'old@cursor.test (pro)');

  // Logout: reports success AND that the host IDE itself is still signed in.
  const out = await deleteJson('/api/oauth/credentials/cursor');
  assert.equal(out.response.status, 200);
  assert.equal(out.body.success, true);
  assert.equal(out.body.configured, false);
  assert.equal(out.body.hostSessionRetained, true);
  assert.equal(out.body.accountLabel, 'old@cursor.test (pro)');

  // THE regression: status must NOT flip back to logged-in.
  const after = await getJson('/api/oauth/status/cursor');
  assert.equal(after.body.configured, false, 'logout must survive host-session re-detection');

  // The stored credential is gone; the marker holds only a fingerprint.
  const markersPath = join(testHome, '.config', 'local-router', 'oauth-logout-markers.json');
  const markersRaw = readFileSync(markersPath, 'utf8');
  const markers = JSON.parse(markersRaw);
  assert.ok(markers.cursor, 'logout marker must be recorded');
  assert.equal(markers.cursor.fingerprint, createHash('sha256').update(oldToken, 'utf8').digest('hex').slice(0, 16));
  assert.equal(markersRaw.includes('eyJ'), false, 'marker must not contain token material');
  assert.equal(markers.cursor.accountLabel, 'old@cursor.test (pro)');

  // Login attempt while suppressed: guided message, still not configured.
  const login = await postJson('/api/oauth/login/cursor', {});
  assert.equal(login.response.status, 200);
  assert.equal(login.body.configured, false);
  assert.match(login.body.message, /ignored|logged out/i);

  // Fresh host login (different account/token): adopted, marker dropped.
  const newToken = jwtLikeToken({ exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600, email: 'new@cursor.test' });
  writeCursorDb({ accessToken: newToken, email: 'new@cursor.test', membership: 'free' });
  const relogin = await getJson('/api/oauth/status/cursor');
  assert.equal(relogin.body.configured, true, 'fresh host session must be adopted after logout');
  assert.equal(relogin.body.accountLabel, 'new@cursor.test (free)');
  const markersAfter = JSON.parse(readFileSync(markersPath, 'utf8'));
  assert.equal('cursor' in markersAfter, false, 'fresh login must clear the logout marker');
  const storeAfter = JSON.parse(readFileSync(join(testHome, '.config', 'local-router', 'oauth-credentials.json'), 'utf8'));
  assert.ok(storeAfter.cursor, 'fresh host session must be persisted to the store');
  assert.equal(storeAfter.cursor.fingerprint, undefined);
});

test('explicit env-var credentials are never suppressed by logout', async () => {
  await stopServer();
  serverLogs = '';
  // Fresh slate: no stored session / markers, as if the operator had only
  // wired CURSOR_TOKEN. The store from the previous test would otherwise
  // (correctly) shadow host detection.
  rmSync(join(testHome, '.config', 'local-router', 'oauth-credentials.json'), { force: true });
  rmSync(join(testHome, '.config', 'local-router', 'oauth-logout-markers.json'), { force: true });
  await startServer({ CURSOR_TOKEN: 'env-token-for-cursor-tests' });

  const before = await getJson('/api/oauth/status/cursor');
  assert.equal(before.body.configured, true);
  assert.equal(before.body.accountLabel, 'Cursor (Environment Variable)');

  const out = await deleteJson('/api/oauth/credentials/cursor');
  assert.equal(out.response.status, 200);
  assert.equal(out.body.hostSessionRetained, false, 'env wiring is operator-owned, not a suppressible host session');

  const after = await getJson('/api/oauth/status/cursor');
  assert.equal(after.body.configured, true, 'env-var credentials stay active after UI logout');
});
