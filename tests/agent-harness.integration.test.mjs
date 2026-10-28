import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// End-to-end contract for the Agents page system:
//   PUT /api/agents-proxy  → env.sh + ~/.codex provider/profile wiring
//   GET /api/agents-proxy/status → readiness for both harnesses
//   POST /api/agents-proxy/verify → real round-trip through each wire shape
// A fake upstream stands in for the provider so every request is local.

const port = String(19100 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let upstreamRequests = [];
let serverLogs = '';
let testHome = '';
let selectedProvider;

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
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    try {
      const body = await readRequestBody(req);
      const upstreamModel = typeof body?.model === 'string' ? body.model : '';
      upstreamRequests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      if (body?.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-harness',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { content: 'HARNESS-CLAUDE-OK' }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-harness',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
        })}\n\n`);
        res.end('data: [DONE]\n\n');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-harness',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `ok:${upstreamModel}` },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
      }));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });

  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  upstreamBaseUrl = `http://127.0.0.1:${upstreamServer.address().port}/v1`;
}

async function startProxyProcess() {
  serverProcess = spawn('node', ['build/index.js'], {
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_SKIP_OS_ENV: '1',
      LOCAL_ROUTER_DEV: 'true',
      [`LOCALROUTER_${selectedProvider.keyEnvVar}`]: 'integration-test-provider-key',
      [providerBaseUrlEnvVar(selectedProvider.name)]: upstreamBaseUrl
    }
  });
  serverProcess.stdout.on('data', (data) => { serverLogs += data.toString(); });
  serverProcess.stderr.on('data', (data) => { serverLogs += data.toString(); });
  await delay(6000);
}

async function stopProxyProcess() {
  if (serverProcess) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
}

const agentModel = () => `${selectedProvider.name}/deepseek-v4-pro`;
const envPath = () => join(testHome, '.config', 'local-router', 'env.sh');
const codexHome = () => join(testHome, '.codex');

test.before(async () => {
  selectedProvider = firstProviderSummary();
  testHome = mkdtempSync(join(tmpdir(), 'local-router-agents-'));
  mkdirSync(codexHome(), { recursive: true });
  writeFileSync(join(codexHome(), 'config.toml'), 'model = "gpt-5.3-codex"\n', 'utf8');

  await startFakeUpstream();
  await startProxyProcess();
});

test.after(async () => {
  await stopProxyProcess();
  if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test('PUT /api/agents-proxy wires env, Codex provider, and Codex profile', async () => {
  const response = await fetch(`${baseUrl}/api/agents-proxy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claudeCode: {
        enabled: true,
        models: {
          default: agentModel(),
          opus1m: agentModel(),
          sonnet: agentModel(),
          sonnet5_1m: agentModel(),
          haiku: agentModel()
        }
      },
      codex: { enabled: true, model: agentModel() }
    })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.config.codex.enabled, true);
  assert.equal(payload.config.codex.model, agentModel());

  const env = readFileSync(envPath(), 'utf8');
  assert.match(env, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:/);
  assert.match(env, /export ANTHROPIC_AUTH_TOKEN="local-router"/);
  assert.match(env, new RegExp(`export OPENAI_BASE_URL="http:\\/\\/127\\.0\\.0\\.1:${port}\\/v1"`));
  assert.match(env, /export OPENAI_API_KEY="local-router"/);

  const codexConfig = readFileSync(join(codexHome(), 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[model_providers\.local-router\]/);
  assert.match(codexConfig, new RegExp(`base_url = "http:\\/\\/127\\.0\\.0\\.1:${port}\\/v1"`));
  assert.match(codexConfig, /wire_api = "responses"/);
  assert.match(codexConfig, /model = "gpt-5\.3-codex"/, 'operator config must survive the managed block');

  const profile = readFileSync(join(codexHome(), 'local-router.config.toml'), 'utf8');
  assert.match(profile, /model_provider = "local-router"/);
  assert.ok(profile.includes(`model = "${agentModel()}"`));
});

test('GET /api/agents-proxy/status reports readiness for both harnesses', async () => {
  const response = await fetch(`${baseUrl}/api/agents-proxy/status`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  const status = payload.status;

  assert.equal(status.claude.interception.enabled, true);
  assert.equal(status.claude.env.applied, true);
  assert.equal(status.claude.env.observed.ANTHROPIC_BASE_URL, `http://127.0.0.1:${port}`);
  assert.equal(status.codex.interception.enabled, true);
  assert.equal(status.codex.config.providerBlock, 'present');
  assert.equal(status.codex.config.profile, 'present');
  assert.equal(status.codex.config.profileModel, agentModel());
  assert.equal(status.codex.launchCommand, 'codex --profile local-router');
});

test('POST /api/agents-proxy/verify proves the Anthropic Messages path', async () => {
  upstreamRequests = [];
  const response = await fetch(`${baseUrl}/api/agents-proxy/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'claude' })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.result.status, 200);

  const forwarded = upstreamRequests.at(-1)?.body;
  // The provider prefix is stripped before forwarding, but the bare id proves
  // the Claude slot replaced the incoming `claude-3-5-haiku-20241022`.
  assert.equal(forwarded?.model, 'deepseek-v4-pro', 'Claude slot must be remapped before the upstream call');
});

test('POST /v1/messages streaming emits well-formed Anthropic frames', async () => {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-local-router-client': 'claude' },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'ping' }]
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const raw = await response.text();
  assert.ok(raw.includes('HARNESS-CLAUDE-OK'));
  assert.doesNotMatch(raw, /\}event:/, 'SSE frames must be newline-terminated, never concatenated');

  const frames = raw
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      assert.ok(eventLine, `frame missing event line: ${block}`);
      assert.ok(dataLine, `frame missing data line: ${block}`);
      const parsed = JSON.parse(dataLine.slice(6));
      assert.equal(parsed.type, eventLine.slice(7), 'event name and payload type must agree');
      return parsed;
    });

  const count = (type) => frames.filter((frame) => frame.type === type).length;
  assert.equal(count('message_start'), 1);
  assert.equal(count('content_block_start'), 1);
  assert.equal(count('content_block_stop'), 1);
  assert.equal(count('message_delta'), 1);
  assert.equal(count('message_stop'), 1);

  const types = frames.map((frame) => frame.type);
  assert.ok(types.indexOf('content_block_stop') < types.indexOf('message_delta'), 'content must close before finish');
  const delta = frames.find((frame) => frame.type === 'message_delta');
  assert.equal(delta.usage.output_tokens, 3, 'usage must survive the translation');
  assert.equal(delta.delta.stop_reason, 'end_turn');
});

test('POST /v1/responses streaming carries the answer into the terminal frames', async () => {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-local-router-client': 'codex' },
    body: JSON.stringify({
      model: agentModel(),
      input: 'ping',
      max_output_tokens: 32,
      stream: true
    })
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const raw = await response.text();

  const frames = raw
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      assert.ok(dataLine, `frame missing data line: ${block}`);
      return JSON.parse(dataLine.slice(6));
    });

  const textDone = frames.find((frame) => frame.type === 'response.output_text.done');
  assert.ok(textDone, 'stream must close the text item');
  assert.equal(textDone.text, 'HARNESS-CLAUDE-OK');

  const itemDone = frames.find((frame) => frame.type === 'response.output_item.done');
  assert.equal(itemDone.item.content[0].text, 'HARNESS-CLAUDE-OK');

  const completed = frames.find((frame) => frame.type === 'response.completed');
  const message = completed.response.output.find((item) => item.type === 'message');
  assert.equal(message.content[0].text, 'HARNESS-CLAUDE-OK', 'terminal content must not be empty for Codex');
  assert.equal(completed.response.usage.output_tokens, 3);
  assert.equal(completed.response.status, 'completed');
});

test('POST /api/agents-proxy/verify proves the OpenAI Responses path', async () => {
  upstreamRequests = [];
  const response = await fetch(`${baseUrl}/api/agents-proxy/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'codex' })
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true, JSON.stringify(payload));
  assert.equal(payload.result.requestedModel, agentModel());

  const forwarded = upstreamRequests.at(-1)?.body;
  assert.equal(forwarded?.model, 'deepseek-v4-pro');
});

test('GET /config/agents serves the harness readiness and Codex controls', async () => {
  const response = await fetch(`${baseUrl}/config/agents`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="harnessStatusStamp"/);
  assert.match(html, /id="codexProxyToggle"/);
  assert.match(html, /id="codexModelSelect"/);
  assert.match(html, /codex --profile local-router/);
});

test('re-sync is idempotent and disabling Codex removes only the managed wiring', async () => {
  const before = readFileSync(envPath(), 'utf8');
  const resync = await fetch(`${baseUrl}/api/agents-proxy/sync-env`, { method: 'POST' });
  assert.equal(resync.status, 200);
  assert.equal(readFileSync(envPath(), 'utf8'), before, 'env.sh must be stable across re-syncs');

  const disable = await fetch(`${baseUrl}/api/agents-proxy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codex: { enabled: false } })
  });
  assert.equal(disable.status, 200);

  assert.equal(existsSync(join(codexHome(), 'local-router.config.toml')), false);
  const restored = readFileSync(join(codexHome(), 'config.toml'), 'utf8');
  assert.doesNotMatch(restored, /model_providers\.local-router/);
  assert.match(restored, /model = "gpt-5\.3-codex"/);
});

test('PUT /api/agents-proxy rejects malformed Codex models', async () => {
  const response = await fetch(`${baseUrl}/api/agents-proxy`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codex: { enabled: true, model: 'bad\nmodel' } })
  });
  assert.equal(response.status, 400);
});
