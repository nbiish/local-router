/**
 * tests/sse-keepalive-stream.integration.test.mjs — end-to-end proof that the
 * streaming relay survives upstream silence (the HTTPS-bridge failure mode).
 *
 * A spawned router (build/index.js, scrubbed env, random port) relays a mock
 * upstream that sends one SSE frame and then goes silent past the keepalive
 * interval before finishing. The client must observe keepalive comment bytes
 * DURING the silence (before the next upstream frame), and a normal fast stream
 * must arrive unmodified.
 *
 * Why this exists: streams through inference.local-router.com (cloudflared
 * tunnel) died mid-stream with "connection reset by peer" during agent tool-run
 * / silent-reasoning pauses — Cloudflare's ~100 s read idle timeout kills a
 * connection the router still considers healthy. Keepalive comments during
 * upstream silence are the fix (measured 2026-11-23: a 200 s continuous stream
 * completes; idle gaps kill).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { scrubbedEnv } from './test-env.mjs';

const port = String(19100 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;
// Fast keepalive so the test observes it without a 15 s wait. The production
// default (15 s) is verified in the unit tests' interval math and the module's
// exported constant.
const KEEPALIVE_MS = '200';
// Upstream silence longer than the keepalive interval.
const UPSTREAM_SILENCE_MS = 700;

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let serverLogs = '';
let testHome = '';
let selectedProvider;
// Set by the slow-stream test's upstream handler; lets the client record when
// the upstream actually went silent.
let upstreamSilenceStartedAt = 0;

const { PROVIDER_REGISTRY } = await import('../build/provider-registry.js');

function firstProviderSummary() {
  const first = PROVIDER_REGISTRY[0];
  if (!first) throw new Error('Expected at least one provider in the registry');
  return { name: first.name, keyEnvVar: first.keyEnvVar };
}

function providerBaseUrlEnvVar(providerName) {
  return `LOCAL_ROUTER_PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
}

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
        }));
        return;
      }

      const slow = body.messages?.some((m) => String(m.content || '').includes('slow-request'));
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"part-one"},"finish_reason":null}]}\n\n');
      if (slow) {
        upstreamSilenceStartedAt = Date.now();
        await delay(UPSTREAM_SILENCE_MS);
      }
      res.write('data: {"choices":[{"delta":{"content":"part-two"},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
      res.end('data: [DONE]\n\n');
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstreamServer.address().port;
  upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}/v1`;
}

async function startProxyProcess() {
  const pEnv = {
    ...scrubbedEnv(),
    HOME: testHome,
    USERPROFILE: testHome,
    PORT: port,
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
    LOCAL_ROUTER_DEV: 'true',
    LOCAL_ROUTER_SSE_KEEPALIVE_MS: KEEPALIVE_MS,
    [`LOCALROUTER_${selectedProvider.keyEnvVar}`]: 'integration-test-provider-key',
    [providerBaseUrlEnvVar(selectedProvider.name)]: upstreamBaseUrl
  };

  serverProcess = spawn('node', ['build/index.js'], { env: pEnv });
  serverProcess.stdout.on('data', (data) => {
    serverLogs += data.toString();
  });
  serverProcess.stderr.on('data', (data) => {
    serverLogs += data.toString();
  });

  await delay(6000);
}

async function stopProxyProcess() {
  if (serverProcess) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
}

/** Read a streaming body chunk by chunk, recording arrival timestamps. */
async function readStreamWithTimestamps(response) {
  const chunks = [];
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ text: new TextDecoder().decode(value), at: Date.now() });
  }
  return chunks;
}

test.before(async () => {
  selectedProvider = firstProviderSummary();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-test-sse-keepalive-'));
  await startFakeUpstream();
  await startProxyProcess();
});

test.after(async () => {
  await stopProxyProcess();
  if (upstreamServer) {
    await new Promise((resolve) => upstreamServer.close(resolve));
  }
  if (testHome) {
    rmSync(testHome, { recursive: true, force: true });
  }
});

const modelId = () => `${selectedProvider.name}/deepseek-v4-pro`;

test('slow upstream: client receives keepalive comments during the silent gap', async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId(),
      stream: true,
      messages: [{ role: 'user', content: 'slow-request' }]
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');

  const chunks = await readStreamWithTimestamps(response);
  const raw = chunks.map((c) => c.text).join('');

  // The data frames pass through intact and in order.
  const one = raw.indexOf('part-one');
  const two = raw.indexOf('part-two');
  assert.ok(one >= 0, 'first upstream frame must reach the client');
  assert.ok(two > one, 'second upstream frame must arrive after the first');
  assert.ok(raw.includes('data: [DONE]'), 'stream must finish normally');

  // Keepalive bytes were delivered DURING the upstream silence: at least one
  // `: ping` chunk must arrive after the upstream went silent and before the
  // second upstream frame reached the client.
  const pingChunks = chunks.filter((c) => c.text.includes(': ping'));
  assert.ok(pingChunks.length >= 1, `expected keepalive bytes during silence; got none. logs:\n${serverLogs.slice(-2000)}`);
  const firstPing = pingChunks[0];
  const secondFrameChunk = chunks.find((c) => c.text.includes('part-two'));
  assert.ok(secondFrameChunk, 'second frame chunk must be observed');
  assert.ok(firstPing.at >= upstreamSilenceStartedAt - 50,
    'keepalive must arrive after the upstream went silent');
  assert.ok(firstPing.at < secondFrameChunk.at,
    'keepalive must arrive before the next upstream frame — i.e. during the gap');

  // Order in the byte stream: pings sit strictly between the frames.
  assert.ok(raw.indexOf(': ping') > one && raw.indexOf(': ping') < two,
    'keepalive bytes must appear between the two frames, never inside one');

  // Comments are legal SSE: stripping them leaves well-formed frames.
  const stripped = raw.split(': ping\n\n').join('');
  assert.ok(!stripped.includes('ping'), 'keepalive bytes are exactly ": ping" comment blocks');
});

test('normal fast stream: events pass through unmodified', async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId(),
      stream: true,
      messages: [{ role: 'user', content: 'fast-request' }]
    })
  });

  assert.equal(response.status, 200);
  const chunks = await readStreamWithTimestamps(response);
  const raw = chunks.map((c) => c.text).join('');

  // Every event frame intact and in order.
  assert.ok(raw.includes('"content":"part-one"'));
  assert.ok(raw.includes('"content":"part-two"'));
  assert.ok(raw.includes('data: [DONE]'));
  const one = raw.indexOf('"content":"part-one"');
  const two = raw.indexOf('"content":"part-two"');
  assert.ok(two > one, 'frame order preserved');

  // No gap in this stream reaches the keepalive interval, so after removing any
  // boundary-safe comments the frames are exactly the upstream's bytes.
  const stripped = raw.split(': ping\n\n').join('');
  assert.ok(stripped.split('data:').length - 1 >= 3, 'expected several frames');
  const frames = stripped.split(/\n\n+/).filter(Boolean);
  for (const frame of frames) {
    assert.match(frame, /^data: /, `frame must be pure SSE data: ${JSON.stringify(frame)}`);
  }
});

test('non-streaming responses are unaffected', async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId(),
      stream: false,
      messages: [{ role: 'user', content: 'hello' }]
    })
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.choices[0].message.content, 'ok');
});
