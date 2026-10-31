import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * `scripts/verify-decisions.mjs` is the one-command proof the decisions
 * transport is alive. This test runs it against a real router on a temp home
 * with a fake OpenRouter (answers) and a fake ZenMux (404), and asserts both
 * the pass path and the fail path (including usage errors).
 */

const worktreeRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = join(worktreeRoot, 'scripts', 'verify-decisions.mjs');
const port = String(18900 + Math.floor(Math.random() * 300));
const baseUrl = `http://127.0.0.1:${port}`;

let serverProcess;
let serverLogs = '';
let testHome = '';
let receiptDir = '';
let openrouterServer;
let zenmuxServer;
let openrouterUrl = '';
let zenmuxUrl = '';

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

function answerFor(question) {
  if (question.type === 'noul') return { type: 'noul', noul: 0.88 };
  if (question.type === 'choice') {
    const options = question.options || Object.keys(question.criteria || {});
    const chosen = options[0];
    const probabilities = Object.fromEntries(options.map((option) => [option, option === chosen ? 0.9 : 0.1 / Math.max(1, options.length - 1)]));
    return { type: 'choice', choice: chosen, confidence: 0.9, probabilities };
  }
  const levels = question.criteria.length;
  const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), 1 / levels]));
  return {
    type: 'score',
    score: 2.4,
    confidence: 0.5,
    legend: Object.fromEntries(Array.from({ length: levels }, (_, index) => [String(index), String(question.criteria[index])])),
    probabilities
  };
}

async function startUpstreams() {
  openrouterServer = createServer(async (req, res) => {
    try {
      const body = await readJson(req);
      const answers = {};
      for (const [id, question] of Object.entries(body.questions || {})) {
        answers[id] = answerFor(question);
      }
      json(res, 200, {
        model: 'typesafe/jev-1.14-20261014',
        answers,
        usage: { input_tokens: 100, output_tokens: 10 },
        id: 'gen-dec-verify-test'
      });
    } catch (error) {
      console.error('[fake-openrouter] handler error:', error);
      json(res, 500, { error: { message: String(error?.message || error) } });
    }
  });
  openrouterUrl = await listen(openrouterServer);

  zenmuxServer = createServer(async (req, res) => {
    await readJson(req);
    json(res, 404, {
      error: { code: '404', type: 'model_not_supported', message: 'Requested model is not supported by /v1/decisions' }
    });
  });
  zenmuxUrl = await listen(zenmuxServer);
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) throw new Error(`server exited (${serverProcess.exitCode})\n${serverLogs}`);
    try {
      const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
    } catch {
      /* starting */
    }
    await delay(200);
  }
  throw new Error(`server did not become ready\n${serverLogs}`);
}

function runVerifier(args) {
  // Must be asynchronous: the fake upstreams live in this process, so a
  // spawnSync would block the event loop and the router's calls would time out.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: worktreeRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test.before(async () => {
  testHome = mkdtempSync(join(tmpdir(), 'lr-verify-decisions-'));
  receiptDir = mkdtempSync(join(tmpdir(), 'lr-verify-receipt-'));
  await startUpstreams();

  const env = {
    ...process.env,
    PORT: port,
    HOME: testHome,
    USERPROFILE: testHome,
    PQC_STORE_ISOLATED: '1',
    PQC_CONFIG_DIR: join(testHome, 'pqc'),
    PQC_SECRETS_DIR: join(testHome, 'pqc'),
    LOCAL_ROUTER_PQC_SCAN_WSL: '0',
    LOCALROUTER_OPENROUTER_API_KEY: 'test-openrouter-key',
    LOCALROUTER_ZENMUX_API_KEY: 'test-zenmux-key',
    LOCAL_ROUTER_DECISION_OPENROUTER_URL: `${openrouterUrl}/decisions`,
    LOCAL_ROUTER_DECISION_ZENMUX_URL: `${zenmuxUrl}/decisions`,
    LOCAL_ROUTER_PROVIDER_OPENROUTER_BASE_URL: `${openrouterUrl}/v1`,
    LOCAL_ROUTER_PROVIDER_ZENMUX_BASE_URL: `${zenmuxUrl}/v1`
  };

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
  for (const dir of [testHome, receiptDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test('the verifier passes and writes a receipt with both failover modes', async () => {
  const receiptPath = join(receiptDir, 'decisions-verify.json');
  const result = await runVerifier(['--base-url', baseUrl, '--json', '--out', receiptPath]);
  assert.equal(result.status, 0, `verifier failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nrouter logs:\n${serverLogs}`);

  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schema, 'local-router/decisions-verify/v1');
  assert.equal(receipt.overall, 'pass');
  assert.equal(receipt.base_url, baseUrl);

  const checks = Object.fromEntries(receipt.checks.map((check) => [check.name, check.status]));
  assert.deepEqual(checks, {
    discovery: 'pass',
    models: 'pass',
    probe: 'pass',
    batch: 'pass',
    'chat guard': 'pass',
    failover: 'pass',
    rerank: 'skipped'
  });

  // OpenRouter answers directly; ZenMux 404s and OpenRouter answers the pin.
  const modes = Object.fromEntries(receipt.failover.map((row) => [row.model, row.mode]));
  assert.equal(modes['openrouter/jev-1.14'], 'direct');
  assert.equal(modes['zenmux/jev-1.14'], 'failover');

  assert.ok(existsSync(receiptPath), 'receipt file was not written');
  const written = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(written.overall, 'pass');
  assert.equal(written.receipt_path, undefined, 'receipt file must not embed its own path');
});

test('the verifier fails against an unreachable router', async () => {
  const result = await runVerifier(['--base-url', 'http://127.0.0.1:1', '--json']);
  assert.equal(result.status, 1);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.overall, 'fail');
  assert.equal(receipt.checks[0].status, 'fail');
});

test('unknown arguments are a usage error', async () => {
  const result = await runVerifier(['--nope']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument/);
});

test('--skip-failover records the check as skipped', async () => {
  const result = await runVerifier(['--base-url', baseUrl, '--json', '--skip-failover']);
  assert.equal(result.status, 0);
  const receipt = JSON.parse(result.stdout);
  const failover = receipt.checks.find((check) => check.name === 'failover');
  assert.equal(failover.status, 'skipped');
  assert.match(failover.detail, /--skip-failover/);
});
