import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const worktreeRoot = fileURLToPath(new URL('..', import.meta.url));

const port = String(18400 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}`;

const openrouterKey = 'test-openrouter-key';
const zenmuxKey = 'test-zenmux-key';

let serverProcess;
let serverLogs = '';
let testHome = '';
let openrouterServer;
let zenmuxServer;
let openrouterUrl = '';
let zenmuxUrl = '';

// Mutable per-upstream behaviour, driven per test.
const openrouterState = { mode: 'ok', requests: [] };
const zenmuxState = { mode: 'ok', requests: [] };

const decisionBody = {
  model: 'typesafe/jev-1.14',
  state: 'file src/router.ts binds port 11434',
  questions: {
    needs_port: {
      type: 'noul',
      instructions: 'Does this state bind a network port?',
      criteria: { true: 'it binds a port', false: 'no network binding' }
    }
  }
};

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

/** OpenRouter-shaped decisions upstream (the canonical dialect). */
async function startOpenrouterUpstream() {
  openrouterServer = createServer(async (req, res) => {
    const body = await readJson(req);
    openrouterState.requests.push({ url: req.url, headers: req.headers, body });

    if (openrouterState.mode === 'not_supported') {
      return json(res, 404, {
        error: { code: 404, type: 'model_not_supported', message: 'Requested model is not supported' }
      });
    }
    if (openrouterState.mode === 'server_error') {
      return json(res, 503, { error: { message: 'upstream unavailable' } });
    }
    if (openrouterState.mode === 'malformed') {
      return json(res, 200, { model: 'typesafe/jev-1.14', usage: {} });
    }
    if (openrouterState.mode === 'contract') {
      return json(res, 400, { error: { message: 'expected record, criteria missing' } });
    }

    const answers = {};
    for (const [id, question] of Object.entries(body.questions || {})) {
      if (question.type === 'noul') answers[id] = { type: 'noul', noul: 0.92 };
      else if (question.type === 'choice') {
        const first = Object.keys(question.criteria || {})[0];
        answers[id] = { type: 'choice', choice: first, confidence: 0.8, probabilities: { [first]: 0.8 } };
      } else {
        answers[id] = { type: 'score', score: 1.5, confidence: 0.6, legend: { 0: 'a', 1: 'b' }, probabilities: { 0: 0.5, 1: 0.5 } };
      }
    }
    json(res, 200, {
      model: 'typesafe/jev-1.14-20261014',
      answers,
      usage: { input_tokens: 120, output_tokens: 8 },
      id: 'gen-dec-test',
      provider: 'TypeSafe'
    });
  });
  openrouterUrl = await listen(openrouterServer);
}

/** ZenMux-shaped decisions upstream: strict array body, `answers` keyed by name. */
async function startZenmuxUpstream() {
  zenmuxServer = createServer(async (req, res) => {
    const body = await readJson(req);
    zenmuxState.requests.push({ url: req.url, headers: req.headers, body });

    if (zenmuxState.mode === 'server_error') {
      return json(res, 500, { error: { message: 'zenmux unavailable' } });
    }
    if (zenmuxState.mode === 'not_supported') {
      return json(res, 404, { error: { code: '404', type: 'model_not_supported', message: 'not supported by /v1/decisions' } });
    }
    if (zenmuxState.mode === 'contract') {
      return json(res, 422, { error: { message: 'Invalid Decisions parameter questions.0.type' } });
    }

    const answers = {};
    for (const question of body.questions || []) {
      if (question.type === 'choice') {
        const probabilities = {};
        for (const choice of question.choices || []) {
          probabilities[choice.value] = choice.value === 'true' ? 0.81 : 0.19;
        }
        answers[question.name] = {
          type: 'choice',
          choice: question.choices?.[0]?.value,
          confidence: 0.62,
          probabilities
        };
      } else {
        const probabilities = {};
        (question.levels || []).forEach((level, index) => {
          probabilities[String(index)] = 1 / (question.levels || []).length;
        });
        answers[question.name] = {
          type: 'score',
          score: 1.2,
          confidence: 0.55,
          legend: Object.fromEntries((question.levels || []).map((level, index) => [String(index), level.label])),
          probabilities
        };
      }
    }
    json(res, 200, {
      model: 'typesafe/jev-1.14',
      answers,
      usage: { input_tokens: 90, output_tokens: 5 }
    });
  });
  zenmuxUrl = await listen(zenmuxServer);
}

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverProcess?.exitCode !== null && serverProcess?.exitCode !== undefined) {
      throw new Error(`server exited early (code ${serverProcess.exitCode})\n${serverLogs}`);
    }
    try {
      const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await delay(200);
  }
  throw new Error(`server did not become ready\n${serverLogs}`);
}

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'lr-decisions-'));
  await startOpenrouterUpstream();
  await startZenmuxUpstream();

  const env = {
    ...process.env,
    PORT: port,
    HOME: testHome,
    USERPROFILE: testHome,
    LOCAL_ROUTER_PQC_SCAN_WSL: '0',
    OPENROUTER_API_KEY: openrouterKey,
    ZENMUX_API_KEY: zenmuxKey,
    // The router reads its namespaced env names (PQC sync writes these).
    LOCAL_ROUTER_OPENROUTER_API_KEY: openrouterKey,
    LOCAL_ROUTER_ZENMUX_API_KEY: zenmuxKey,
    LOCAL_ROUTER_DECISION_OPENROUTER_URL: `${openrouterUrl}/decisions`,
    LOCAL_ROUTER_DECISION_ZENMUX_URL: `${zenmuxUrl}/decisions`,
    LOCAL_ROUTER_PROVIDER_OPENROUTER_BASE_URL: `${openrouterUrl}/v1`,
    LOCAL_ROUTER_PROVIDER_ZENMUX_BASE_URL: `${zenmuxUrl}/v1`
  };
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY']) delete env[key];

  serverProcess = spawn(process.execPath, ['build/index.js'], {
    cwd: worktreeRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => { serverLogs += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverLogs += chunk.toString(); });
  await waitForServer();
});

test.after(async () => {
  serverProcess?.kill();
  await new Promise((resolve) => openrouterServer?.close(resolve) ?? resolve());
  await new Promise((resolve) => zenmuxServer?.close(resolve) ?? resolve());
  if (testHome) rmSync(testHome, { recursive: true, force: true });
});

test.beforeEach(() => {
  openrouterState.mode = 'ok';
  zenmuxState.mode = 'ok';
  openrouterState.requests.length = 0;
  zenmuxState.requests.length = 0;
});

// ── Routes ──────────────────────────────────────────────────────

for (const route of ['/api/alpha/decisions', '/v1/decisions', '/decisions']) {
  test(`${route} answers a typed noul batch through OpenRouter`, async () => {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(decisionBody)
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.provider, 'openrouter');
    assert.equal(body.dialect, 'typesafe');
    assert.equal(body.model, 'typesafe/jev-1.14-20261014');
    assert.equal(body.answers.needs_port.type, 'noul');
    assert.equal(body.answers.needs_port.noul, 0.92);
    assert.equal(body.local_router.canonical_model, 'typesafe/jev-1.14');
    assert.equal(response.headers.get('x-localrouter-decision-provider'), 'openrouter');

    assert.equal(openrouterState.requests.length, 1);
    assert.equal(openrouterState.requests[0].body.model, 'typesafe/jev-1.14');
    assert.equal(openrouterState.requests[0].headers.authorization, `Bearer ${openrouterKey}`);
  });
}

test('discovery advertises decision models with a decisions capability', async () => {
  const response = await fetch(`${baseUrl}/v1/models`);
  const body = await response.json();
  const ids = body.data.map((model) => model.id);
  assert.ok(ids.includes('openrouter/jev-1.14'), `missing openrouter decision model in ${ids.join(',')}`);
  assert.ok(ids.includes('zenmux/jev-1.14'), 'missing zenmux decision model');
  const openrouterEntry = body.data.find((model) => model.id === 'openrouter/jev-1.14');
  assert.equal(openrouterEntry.capabilities.decisions, true);
  assert.equal(openrouterEntry.owned_by, 'openrouter');

  // The Ollama-compatible surface advertises the same rows.
  const tags = await (await fetch(`${baseUrl}/api/tags`)).json();
  assert.ok(tags.models.some((model) => model.name === 'openrouter/jev-1.14'));
});

test('chat completions refuse a decision model and point at the decisions API', async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openrouter/jev-1.14', messages: [{ role: 'user', content: 'hi' }] })
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  const text = JSON.stringify(body);
  assert.match(text, /typed decision model/i);
  assert.match(text, /\/api\/alpha\/decisions/);
  assert.equal(openrouterState.requests.length, 0);
});

test('status reports providers, readiness, and advertised models', async () => {
  const body = await (await fetch(`${baseUrl}/api/decisions/status`)).json();
  assert.equal(body.ready, true);
  assert.equal(body.latest_model, 'typesafe/jev-1.14');
  assert.deepEqual(body.routes, ['/api/alpha/decisions', '/v1/decisions', '/decisions']);
  assert.deepEqual(body.advertised_models.map((model) => model.id), ['openrouter/jev-1.14', 'zenmux/jev-1.14']);
  const openrouter = body.providers.find((provider) => provider.name === 'openrouter');
  assert.equal(openrouter.key_configured, true);
  assert.equal(openrouter.dialect, 'typesafe');
});

// ── Failover ────────────────────────────────────────────────────

test('an unavailable primary fails over to ZenMux and records both attempts', async () => {
  openrouterState.mode = 'not_supported';
  const response = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decisionBody)
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'zenmux');
  assert.equal(body.dialect, 'zenmux');
  assert.equal(body.answers.needs_port.type, 'noul');
  assert.equal(body.answers.needs_port.noul, 0.81);
  assert.equal(body.answers.needs_port.translated_from, 'choice');
  assert.deepEqual(body.local_router.translations, ['noul->choice(needs_port)']);
  assert.deepEqual(
    body.local_router.attempts.map((attempt) => `${attempt.provider}:${attempt.outcome}`),
    ['openrouter:retryable_error', 'zenmux:answered']
  );

  // ZenMux receives its own dialect: `input` + array questions + `choices`.
  const sent = zenmuxState.requests[0].body;
  assert.equal(sent.input, decisionBody.state);
  assert.ok(Array.isArray(sent.questions));
  assert.equal(sent.questions[0].name, 'needs_port');
  assert.equal(sent.questions[0].type, 'choice');
  assert.equal(zenmuxState.requests[0].headers.authorization, `Bearer ${zenmuxKey}`);
});

test('a malformed primary response fails over instead of returning empty answers', async () => {
  openrouterState.mode = 'malformed';
  const response = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decisionBody)
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'zenmux');
  assert.deepEqual(
    body.local_router.attempts.map((attempt) => `${attempt.provider}:${attempt.outcome}`),
    ['openrouter:malformed_response', 'zenmux:answered']
  );
});

test('all providers failing returns 502 with the attempt trail', async () => {
  openrouterState.mode = 'not_supported';
  zenmuxState.mode = 'server_error';
  const response = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decisionBody)
  });
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.type, 'decision_transport_error');
  assert.equal(body.error.attempts.length, 2);
  assert.deepEqual(body.error.attempts.map((attempt) => attempt.provider), ['openrouter', 'zenmux']);
});

test('a request every provider rejects as a contract violation returns 400', async () => {
  openrouterState.mode = 'contract';
  zenmuxState.mode = 'contract';
  const response = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(decisionBody)
  });
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.type, 'invalid_decision_request');
  assert.match(body.error.message, /criteria missing/);
});

// ── Contract errors are local, before any upstream call ────────

test('an unsupported question type is rejected before contacting a provider', async () => {
  const response = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'typesafe/jev-1.14',
      state: 's',
      questions: { q: { type: 'vibe', instructions: 'How does it feel?' } }
    })
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.type, 'invalid_decision_request');
  assert.equal(openrouterState.requests.length, 0);
  assert.equal(zenmuxState.requests.length, 0);
});

test('an unknown decision model is rejected with a 404 that names the supported id', async () => {
  const response = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...decisionBody, model: 'typesafe/jev-router' })
  });
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.type, 'unknown_decision_model');
  assert.match(body.error.message, /typesafe\/jev-1\.14/);
});

test('a pinned provider is preferred and reported as the answering provider', async () => {
  const response = await fetch(`${baseUrl}/api/alpha/decisions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...decisionBody, model: 'zenmux/jev-1.14' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.provider, 'zenmux');
  assert.equal(openrouterState.requests.length, 0);
});

// ── Probe ───────────────────────────────────────────────────────

test('the probe endpoint exercises every configured decision provider', async () => {
  const body = await (await fetch(`${baseUrl}/api/decisions/probe`, { method: 'POST' })).json();
  assert.equal(body.results.length, 2);
  assert.deepEqual(body.results.map((result) => result.provider), ['openrouter', 'zenmux']);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].model, 'typesafe/jev-1.14-20261014');
  assert.equal(typeof body.results[0].ms, 'number');
});
