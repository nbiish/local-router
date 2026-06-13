import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

test('Headroom Context Compression + Wafer ZDR Integration', async (t) => {
  const routerPort = String(20100 + Math.floor(Math.random() * 1000));
  const headroomPort = String(21100 + Math.floor(Math.random() * 1000));
  const waferPort = String(22100 + Math.floor(Math.random() * 1000));

  const headroomRequests = [];
  const waferRequests = [];

  // 1. Start Mock Headroom Proxy Server
  const headroomServer = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      headroomRequests.push({ url: req.url, method: req.method, body: parsed });

      // Mock response: compress by converting message content to uppercase
      // and returning a fake savings metric.
      const compressedMessages = (parsed.messages || []).map(m => ({
        ...m,
        content: typeof m.content === 'string' ? m.content.toUpperCase() : m.content
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        compressed: true,
        messages: compressedMessages,
        tokens_before: 100,
        tokens_after: 50,
        tokens_saved: 50,
        compression_ratio: 0.5,
        transforms_applied: [],
        ccr_hashes: []
      }));
    });
  });
  headroomServer.listen(headroomPort);

  // 2. Start Mock Wafer Serverless Provider
  const waferServer = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      waferRequests.push({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: parsed
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: { role: 'assistant', content: 'Mock response from wafer' }
        }]
      }));
    });
  });
  waferServer.listen(waferPort);

  // 3. Set up temporary HOME directory for local-router configs
  const testHome = mkdtempSync(join(tmpdir(), 'local-router-headroom-test-'));
  const configDir = join(testHome, '.config', 'local-router');
  const ensureDir = (dir) => {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  };
  ensureDir(configDir);

  // Pre-seed headroom-config.json with our mock port
  const headroomConfig = {
    enabled: true,
    proxyUrl: `http://localhost:${headroomPort}`
  };
  writeFileSync(join(configDir, 'headroom-config.json'), JSON.stringify(headroomConfig, null, 2));

  // 4. Spawn Local Router Server process
  const env = {
    ...process.env,
    HOME: testHome,
    PORT: routerPort,
    LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
    LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
    LOCAL_ROUTER_PROVIDER_WAFER_SERVERLESS_BASE_URL: `http://127.0.0.1:${waferPort}`,
    WAFER_SERVERLESS_API_KEY: 'mock-wafer-key'
  };

  const child = spawn('node', ['build/index.js'], { env });
  child.stdout.on('data', (d) => {
    console.log('[Router stdout]:', d.toString());
  });
  child.stderr.on('data', (d) => {
    console.error('[Router stderr]:', d.toString());
  });

  // Wait for Local Router to start listening
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await delay(150);
    try {
      const ping = await fetch(`http://127.0.0.1:${routerPort}/api/headroom-config`);
      if (ping.ok) {
        ready = true;
        break;
      }
    } catch {
      // keep trying
    }
  }
  assert.ok(ready, 'Local Router should start and be healthy');

  // 5. Send chat completions request via Local Router
  const payload = {
    model: 'wafer-ai-deepseek-v4-pro',
    messages: [
      { role: 'system', content: 'you are an assistant' },
      { role: 'user', content: 'hello world' }
    ]
  };

  const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  assert.equal(response.status, 200);
  const responseData = await response.json();
  assert.equal(responseData.choices[0].message.content, 'Mock response from wafer');

  // 6. Verification:
  // (a) Headroom compression proxy was invoked with the messages
  assert.equal(headroomRequests.length, 1);
  assert.equal(headroomRequests[0].method, 'POST');
  assert.deepEqual(headroomRequests[0].body.messages, [
    { role: 'system', content: 'you are an assistant' },
    { role: 'user', content: 'hello world' }
  ]);
  assert.equal(headroomRequests[0].body.model, 'deepseek-v4-pro');
  // (b) Upstream provider received the compressed uppercase content
  assert.equal(waferRequests.length, 1);
  const waferReq = waferRequests[0];
  assert.equal(waferReq.method, 'POST');
  
  const messagesSentToUpstream = waferReq.body.messages;
  assert.equal(messagesSentToUpstream[0].role, 'system');
  assert.equal(messagesSentToUpstream[0].content[0].text, 'YOU ARE AN ASSISTANT');
  assert.equal(messagesSentToUpstream[1].role, 'user');
  assert.equal(messagesSentToUpstream[1].content, 'HELLO WORLD');

  // (c) Wafer ZDR header is present
  assert.equal(waferReq.headers['wafer-zdr'], 'required');

  // (d) Prompt Caching cache_control was injected on the system message
  assert.deepEqual(messagesSentToUpstream[0].content[0].cache_control, { type: 'ephemeral', ttl: '1h' });

  // Clean up
  child.kill();
  await once(child, 'exit');
  headroomServer.close();
  waferServer.close();
  rmSync(testHome, { recursive: true, force: true });
});
