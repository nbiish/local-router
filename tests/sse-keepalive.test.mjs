/**
 * tests/sse-keepalive.test.mjs — unit tests for the SSE idle keepalive.
 *
 * Proves three properties of the wire-level keepalive:
 *  1. a simulated slow upstream (no bytes for N seconds) still gets keepalive
 *     bytes (`: ping\n\n`) on the client side;
 *  2. a normal, active stream passes through byte-identical — no injection ever
 *     interleaves into an active event;
 *  3. silence that begins mid-frame (inside an event) is never interrupted; the
 *     keepalive waits for the frame boundary.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';

import {
  attachSseKeepalive,
  markNonTerminal,
  SSE_KEEPALIVE_COMMENT
} from '../build/sse-keepalive.js';

/** A minimal writable sink that mimics an Express streaming response. */
function fakeRes() {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (c) => chunks.push(Buffer.from(c)));
  return { res: sink, chunks, text: () => Buffer.concat(chunks).toString('utf8') };
}

test('slow upstream: keepalive comments reach the client during silence', async () => {
  const { res, chunks, text } = fakeRes();
  const dispose = attachSseKeepalive(res, 100);
  try {
    res.write('data: {"n":1}\n\n');
    await delay(400); // 4 keepalive intervals of pure upstream silence
    const out = text();
    assert.ok(out.includes('data: {"n":1}\n\n'), 'original frame must pass through');
    const pings = out.split(': ping\n\n').length - 1;
    assert.ok(pings >= 2, `expected >=2 keepalive comments during silence, got ${pings}`);
    // every keepalive byte string is exactly the legal SSE comment
    for (const c of chunks) {
      const s = c.toString();
      if (s.includes('ping')) assert.equal(s, SSE_KEEPALIVE_COMMENT);
    }
  } finally {
    dispose();
    res.end();
  }
});

test('normal stream passes through unmodified while data flows', async () => {
  const { res, text } = fakeRes();
  const intervalMs = 250;
  const dispose = attachSseKeepalive(res, intervalMs);
  let expected = '';
  try {
    // 30 frames, one every 20 ms — no gap reaches the keepalive interval.
    for (let i = 0; i < 30; i++) {
      const frame = `data: {"n":${i}}\n\n`;
      expected += frame;
      res.write(frame);
      await delay(20);
    }
    const out = text();
    assert.equal(out, expected, 'active stream must be byte-identical pass-through');
    assert.ok(!out.includes('ping'), 'no keepalive may interleave into an active stream');
  } finally {
    dispose();
    res.end();
  }
});

test('mid-frame silence is never interrupted; keepalive waits for the boundary', async () => {
  const { res, text } = fakeRes();
  const dispose = attachSseKeepalive(res, 100);
  try {
    res.write('data: {"partial"'); // upstream stalls mid-line (active event)
    await delay(350);
    let out = text();
    assert.ok(!out.includes('ping'), 'no injection inside an active event');
    assert.ok(out.includes('data: {"partial"'));

    // the frame completes; the silence continues — now the keepalive may fire.
    res.write(':true}\n\n');
    await delay(350);
    out = text();
    const repaired = out.split(': ping\n\n').join('');
    assert.equal(repaired, 'data: {"partial":true}\n\n', 'the data frame must stay intact');
    assert.ok(out.indexOf(': ping\n\n') > out.indexOf('data: {"partial":true}\n\n'),
      'keepalive must appear after the completed frame, not inside it');
  } finally {
    dispose();
    res.end();
  }
});

test('keepalives are spaced by the interval, not a flood', async () => {
  const { res, text } = fakeRes();
  const dispose = attachSseKeepalive(res, 100);
  try {
    res.write('data: {"n":0}\n\n');
    await delay(250); // 2.5 intervals: 2-3 pings on a fast clock, >=1 under CI load
    const pings = text().split(': ping\n\n').length - 1;
    assert.ok(pings >= 1 && pings <= 3, `expected 1..3 pings in 2.5 intervals, got ${pings}`);
  } finally {
    dispose();
    res.end();
  }
});

test('dispose stops the keepalive', async () => {
  const { res, text } = fakeRes();
  const dispose = attachSseKeepalive(res, 100);
  res.write('data: {"n":0}\n\n');
  await delay(150);
  dispose();
  const before = text().split(': ping\n\n').length - 1;
  await delay(300);
  const after = text().split(': ping\n\n').length - 1;
  assert.equal(after, before, 'no keepalive after dispose');
  res.end();
});

test('markNonTerminal: translator fakes never receive keepalive injection', async () => {
  const { res, text } = fakeRes();
  markNonTerminal(res);
  const dispose = attachSseKeepalive(res, 100);
  try {
    res.write('data: {"n":1}\n\n');
    await delay(350);
    assert.ok(!text().includes('ping'), 'non-terminal destinations must not be injected');
  } finally {
    dispose();
    res.end();
  }
});

test('attach is idempotent per response', async () => {
  const { res, text } = fakeRes();
  const d1 = attachSseKeepalive(res, 100);
  const d2 = attachSseKeepalive(res, 100);
  assert.equal(d1, d2, 'second attach must return the first dispose');
  res.write('data: {"n":1}\n\n');
  await delay(250);
  const pings = text().split(': ping\n\n').length - 1;
  assert.ok(pings >= 1 && pings <= 3, `one guard only — got ${pings} pings`);
  d1();
  res.end();
});
