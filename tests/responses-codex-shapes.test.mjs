import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Codex CLI speaks the Responses API exclusively (0.135+ dropped wire_api=chat).
// Every case here is a defect that made a real `codex exec` turn hang or loop
// against the shim: flat tool declarations, typed turn items, tool calls in the
// stream. The assertions are on what the upstream actually received, so they
// fail if translation silently degrades rather than only if the route 500s.

const port = String(20100 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let upstreamServer;
let upstreamBaseUrl = '';
let upstreamRequests = [];
let testHome = '';

const { PROVIDER_REGISTRY } = await import('../build/provider-registry.js');
const firstProvider = PROVIDER_REGISTRY[0];
const modelId = `${firstProvider.name}/deepseek-v4-pro`;
const providerBaseUrlEnvVar = `LOCAL_ROUTER_PROVIDER_${firstProvider.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : null;
}

async function startFakeUpstream() {
  upstreamServer = createServer(async (req, res) => {
    const body = await readRequestBody(req);
    upstreamRequests.push({ url: req.url, body });

    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }

    if (body?.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // First fragment carries the id and name, the second only arguments —
      // the shape real providers use for tool calls.
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"exec_command","arguments":"{\\"cmd\\":"}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"echo hi\\"}"}}]},"finish_reason":null}]}\n\n');
      res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_abc',
            type: 'function',
            function: { name: 'exec_command', arguments: '{"cmd":"echo hi"}' }
          }]
        },
        finish_reason: 'tool_calls'
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
    }));
  });

  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve));
  upstreamBaseUrl = `http://127.0.0.1:${upstreamServer.address().port}/v1`;
}

async function startProxy() {
  serverProcess = spawn('node', ['build/index.js'], {
    env: {
      ...process.env,
      HOME: testHome,
      USERPROFILE: testHome,
      PORT: port,
      LOCAL_ROUTER_SKIP_OLLAMA_ENSURE: 'true',
      LOCAL_ROUTER_SKIP_PQC_LOAD: 'true',
      LOCAL_ROUTER_DEV: 'true',
      [`LOCALROUTER_${firstProvider.keyEnvVar}`]: 'integration-test-provider-key',
      [providerBaseUrlEnvVar]: upstreamBaseUrl
    }
  });
  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', () => {});
  await delay(6000);
}

function parseSse(raw) {
  const events = [];
  for (const block of raw.split(/\n\n+/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    let name = '';
    let data = null;
    for (const line of lines) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) {
        try {
          data = JSON.parse(line.slice(6));
        } catch {
          data = null;
        }
      }
    }
    if (name || data) events.push({ event: name, data });
  }
  return events;
}

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'local-router-codex-shapes-'));
  await startFakeUpstream();
  await startProxy();
});

test.after(async () => {
  if (serverProcess) {
    serverProcess.kill();
    await once(serverProcess, 'exit').catch(() => {});
  }
  if (upstreamServer) await new Promise((resolve) => upstreamServer.close(resolve));
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  upstreamRequests = [];
});

test('flat Responses tools reach upstream nested, non-function tools are dropped', async () => {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: false,
      tools: [
        { type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } },
        { type: 'web_search', external_web_access: false }
      ]
    })
  });

  assert.equal(response.status, 200);
  const sent = upstreamRequests.find((r) => r.url === '/v1/chat/completions')?.body;
  assert.ok(sent, 'upstream should have been called');
  assert.equal(sent.tools.length, 1);
  assert.equal(sent.tools[0].type, 'function');
  assert.deepEqual(sent.tools[0].function, {
    name: 'exec_command',
    description: 'run',
    parameters: { type: 'object', properties: {} }
  });
});

test('namespace-grouped tools are flattened rather than dropped', async () => {
  await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: false,
      tools: [{
        type: 'namespace',
        name: 'multi_agent_v1',
        tools: [{ type: 'function', name: 'close_agent', parameters: { type: 'object', properties: {} } }]
      }]
    })
  });

  const sent = upstreamRequests.find((r) => r.url === '/v1/chat/completions')?.body;
  assert.equal(sent.tools.length, 1);
  assert.equal(sent.tools[0].function.name, 'multi_agent_v1__close_agent');
});

test('replayed function_call and function_call_output become tool messages', async () => {
  await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      stream: false,
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] },
        { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'exec_command', arguments: '{"cmd":"echo hi"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'hi' }
      ]
    })
  });

  const messages = upstreamRequests.find((r) => r.url === '/v1/chat/completions')?.body?.messages;
  assert.ok(messages, 'upstream should have been called');
  const assistant = messages[1];
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.tool_calls, [{
    id: 'call_1',
    type: 'function',
    function: { name: 'exec_command', arguments: '{"cmd":"echo hi"}' }
  }]);
  assert.deepEqual(messages[2], { role: 'tool', tool_call_id: 'call_1', content: 'hi' });
});

test('streamed tool calls emit function_call items and balanced output_item events', async () => {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      stream: true
    })
  });

  const events = parseSse(await response.text());
  const names = events.map((e) => e.event);

  // The invented event name Codex does not parse must be gone.
  assert.equal(names.includes('response.output_tool_call.arguments.delta'), false);

  const call = events.find((e) => e.event === 'response.output_item.done'
    && e.data?.item?.type === 'function_call');
  assert.ok(call, 'a function_call item must be emitted');
  assert.equal(call.data.item.call_id, 'call_abc');
  assert.equal(call.data.item.name, 'exec_command');
  assert.equal(call.data.item.arguments, '{"cmd":"echo hi"}');

  // Every announced item must be completed, or the client waits forever.
  const added = events.filter((e) => e.event === 'response.output_item.added').length;
  const done = events.filter((e) => e.event === 'response.output_item.done').length;
  assert.equal(added, done);

  const completed = events.find((e) => e.event === 'response.completed');
  assert.ok(completed, 'response.completed is terminal');
  assert.ok(
    completed.data.response.output.some((item) => item.type === 'function_call'),
    'the terminal response must carry the tool call'
  );
});
