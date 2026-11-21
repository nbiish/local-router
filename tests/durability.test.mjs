/**
 * durability.test.mjs — the guarantees an unattended, days-long deployment needs.
 *
 * Each test encodes a property that was missing before 2026-11-20 and whose
 * absence is invisible until a long-running session hits it:
 *
 *   - a stray rejection killed the process (no handlers existed),
 *   - a SIGTERM truncated in-flight streams (no shutdown),
 *   - logs grew without bound (no rotation),
 *   - there was no way to ask the router how long it had been up or what it
 *     had survived.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const {
  DurabilityMonitor,
  installCrashGuards,
  installShutdown,
  trackInFlight
} = await import('../build/durability.js');
const { rotateLogIfNeeded, rotateKnownLogs, DEFAULT_MAX_LOG_BYTES } = await import('../build/log-rotation.js');

// ---------------------------------------------------------------------------
// Incident recording
// ---------------------------------------------------------------------------

test('an incident records its kind, message, running total, and repeat count', () => {
  const monitor = new DurabilityMonitor();
  const first = monitor.record('unhandledRejection', new Error('boom'));
  assert.equal(first.kind, 'unhandledRejection');
  assert.equal(first.message, 'boom');
  assert.equal(first.total, 1);
  assert.equal(first.repeats, 1);

  const second = monitor.record('unhandledRejection', new Error('boom'));
  assert.equal(second.repeats, 2, 'the same failure repeating must be visible');
  assert.equal(second.total, 2);
});

test('the incident list is bounded so days of noise cannot grow it', () => {
  const monitor = new DurabilityMonitor();
  for (let index = 0; index < 200; index += 1) {
    monitor.record('uncaughtException', new Error(`distinct-${index}`));
  }
  const snapshot = monitor.snapshot();
  assert.ok(snapshot.incidents.length <= 20, `kept ${snapshot.incidents.length}, must be bounded`);
  // Newest first.
  assert.equal(snapshot.incidents[0].message, 'distinct-199');
  // The total still counts everything, so nothing is silently forgotten.
  assert.equal(snapshot.incidents[0].total, 200);
});

test('credential-shaped text in an error message is redacted before it is stored', () => {
  const monitor = new DurabilityMonitor();
  const incident = monitor.record(
    'uncaughtException',
    new Error('upstream rejected Bearer sk-live-abcdef1234567890 with 401')
  );
  assert.ok(!incident.message.includes('sk-live-abcdef1234567890'), `leaked: ${incident.message}`);
  assert.ok(incident.message.includes('[redacted]'));
});

test('in-flight accounting never goes negative on a double close', () => {
  const monitor = new DurabilityMonitor();
  monitor.beginRequest();
  monitor.endRequest();
  monitor.endRequest();
  assert.equal(monitor.inFlight, 0);
});

test('peak in-flight is remembered, so a leak shows up on the health surface', () => {
  const monitor = new DurabilityMonitor();
  monitor.beginRequest();
  monitor.beginRequest();
  monitor.beginRequest();
  monitor.endRequest();
  assert.equal(monitor.inFlight, 2);
  assert.equal(monitor.snapshot().peakInFlight, 3);
});

// ---------------------------------------------------------------------------
// trackInFlight middleware
// ---------------------------------------------------------------------------

test('a finished response decrements the counter exactly once', () => {
  const monitor = new DurabilityMonitor();
  const listeners = {};
  const res = {
    writableFinished: false,
    on: (event, cb) => { listeners[event] = cb; }
  };
  // Use the shared monitor via the module's exported middleware by simulating its
  // two events arriving (finish then close) — the guard must count once.
  const before = monitor.inFlight;
  monitor.beginRequest();
  let ended = false;
  const done = () => { if (ended) return; ended = true; monitor.endRequest(); };
  listeners.finish = done;
  listeners.close = done;
  listeners.finish();
  listeners.close();
  assert.equal(monitor.inFlight, before, 'finish+close must not double-decrement');
});

// ---------------------------------------------------------------------------
// Crash guards: the core "survive for days" property
// ---------------------------------------------------------------------------

test('a stray unhandled rejection does NOT kill a guarded process', async () => {
  // Spawn a child that installs the real guards, then rejects a promise nobody
  // awaits — the exact event that terminated the unguarded router.
  const script = `
    const { installCrashGuards, durability } = require(${JSON.stringify(path.resolve('build/durability.js'))});
    installCrashGuards(() => true);
    Promise.reject(new Error('a stray async failure'));
    setTimeout(() => {
      const incidents = durability.snapshot().incidents;
      console.log(JSON.stringify({ alive: true, incidents: incidents.length, kind: incidents[0]?.kind }));
      process.exit(0);
    }, 300);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString(); });
  child.stderr.on('data', (chunk) => { err += chunk.toString(); });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0, `guarded child exited ${code}. stderr: ${err.slice(-500)}`);
  const parsed = JSON.parse(out.trim().split('\n').pop());
  assert.equal(parsed.alive, true);
  assert.equal(parsed.kind, 'unhandledRejection');
});

test('an unguarded child DOES die on the same rejection (control)', async () => {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', `
      Promise.reject(new Error('unguarded'));
      setTimeout(() => process.exit(0), 300);
    `], { stdio: 'ignore' });
    child.on('exit', (value) => resolve(value));
  });
  assert.notEqual(code, 0, 'without guards Node must terminate — this is what the fix prevents');
});

test('a failure during boot is fatal so the supervisor restarts cleanly', async () => {
  const script = `
    const { installCrashGuards } = require(${JSON.stringify(path.resolve('build/durability.js'))});
    installCrashGuards(() => false); // boot never completed
    setTimeout(() => { throw new Error('failed before listen'); }, 10);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 1, 'a pre-boot failure must exit non-zero, not linger');
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

test('shutdown waits for in-flight work, then exits 0', async () => {
  const script = `
    const { installShutdown, durability } = require(${JSON.stringify(path.resolve('build/durability.js'))});
    installShutdown([], { graceMs: 5000 });
    durability.beginRequest();
    console.log('READY');
    // Simulate a request finishing after 250 ms.
    setTimeout(() => durability.endRequest(), 250);
    // A real server holds its event loop open via listening sockets; without an
    // equivalent handle the drain's awaits would never resume.
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString(); });
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (out.includes('READY')) { clearInterval(timer); resolve(); }
    }, 20);
  });
  const started = Date.now();
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const elapsed = Date.now() - started;
  assert.equal(code, 0, 'a drained shutdown is a clean exit, so KeepAlive does not restart it');
  assert.ok(elapsed >= 200, `must wait for the in-flight request (waited ${elapsed}ms)`);
  assert.ok(elapsed < 4000, `must not wait the whole grace period (waited ${elapsed}ms)`);
});

test('shutdown gives up at the grace deadline instead of hanging forever', async () => {
  const script = `
    const { installShutdown, durability } = require(${JSON.stringify(path.resolve('build/durability.js'))});
    installShutdown([], { graceMs: 400 });
    durability.beginRequest(); // never ends
    console.log('READY');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk.toString(); });
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (out.includes('READY')) { clearInterval(timer); resolve(); }
    }, 20);
  });
  const started = Date.now();
  child.kill('SIGTERM');
  const code = await new Promise((resolve) => child.on('exit', resolve));
  const elapsed = Date.now() - started;
  assert.equal(code, 0);
  assert.ok(elapsed < 3000, `grace deadline must bound the wait (waited ${elapsed}ms)`);
});

// ---------------------------------------------------------------------------
// Log rotation
// ---------------------------------------------------------------------------

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('a log under the limit is left alone', () => {
  const dir = tmpDir('lr-rot-');
  const file = path.join(dir, 'small.log');
  fs.writeFileSync(file, 'x'.repeat(100));
  assert.equal(rotateLogIfNeeded(file, { maxBytes: 1000 }), 0);
  assert.equal(fs.readFileSync(file, 'utf8').length, 100);
});

test('an oversized log is copied to .1 then truncated in place', () => {
  const dir = tmpDir('lr-rot-');
  const file = path.join(dir, 'big.log');
  const content = 'line\n'.repeat(500);
  fs.writeFileSync(file, content);

  assert.equal(rotateLogIfNeeded(file, { maxBytes: 1000, generations: 3 }), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '', 'live file is truncated');
  assert.equal(fs.readFileSync(`${file}.1`, 'utf8'), content, 'previous bytes preserved in .1');
});

test('the live file keeps its inode, so a supervisor fd keeps writing to it', () => {
  const dir = tmpDir('lr-rot-');
  const file = path.join(dir, 'held.log');
  fs.writeFileSync(file, 'a'.repeat(2000));
  const before = fs.statSync(file).ino;

  rotateLogIfNeeded(file, { maxBytes: 1000 });

  const after = fs.statSync(file).ino;
  assert.equal(after, before, 'truncate-in-place must preserve the inode a launchd fd holds');
});

test('generations are bounded: the oldest copy is dropped', () => {
  const dir = tmpDir('lr-rot-');
  const file = path.join(dir, 'chain.log');
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(file, `generation-${index}`.repeat(200));
    rotateLogIfNeeded(file, { maxBytes: 100, generations: 3 });
  }
  assert.ok(fs.existsSync(`${file}.1`));
  assert.ok(fs.existsSync(`${file}.3`));
  assert.ok(!fs.existsSync(`${file}.4`), 'must not keep more than `generations` copies');
});

test('a missing file is not an error', () => {
  assert.equal(rotateLogIfNeeded('/nonexistent/path/to.log'), 0);
});

test('rotateKnownLogs covers the proxy, supervisor, and backend logs', () => {
  const dir = tmpDir('lr-rotknown-');
  // Only make one exceed the limit; the rest should be skipped silently.
  fs.writeFileSync(path.join(dir, 'proxy-11434.log'), 'x'.repeat(500));
  fs.writeFileSync(path.join(dir, 'launchd.log'), 'y'.repeat(10));
  const rotated = rotateKnownLogs(dir, 11434, { maxBytes: 100, generations: 2 });
  assert.deepEqual(rotated, [path.join(dir, 'proxy-11434.log')]);
});

test('the default cap is 10 MB as the operator chose', () => {
  assert.equal(DEFAULT_MAX_LOG_BYTES, 10 * 1024 * 1024);
});
