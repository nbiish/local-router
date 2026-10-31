#!/usr/bin/env node
/**
 * Local Router — decision transport verification.
 *
 * One command that proves the typed decision layer end to end and emits a
 * machine-readable receipt:
 *
 *   npm run verify:decisions -- --json --out .agents/audit/decisions-verify.json
 *
 * Checks, in order:
 *   discovery  — /api/decisions/status reports the three routes, providers, models
 *   models     — /v1/models and /api/tags advertise each pinned decision model
 *                exactly once with capabilities.decisions=true
 *   probe      — a live typed probe answers on at least one keyed provider
 *   batch      — a noul + choice + score batch returns well-formed, in-range,
 *                normalized answers (probabilities sum to ~1, legend intact)
 *   chat guard — a chat request for a decision model is refused with the
 *                decisions-route pointer instead of being answered with prose
 *   failover   — a provider-pinned request either answers directly or fails
 *                over with the attempt trail preserved (skippable)
 *   rerank     — optional: ainish-rag rerank consumes this router as its
 *                decisions transport (requires ainish-rag + an index)
 *
 * Exit codes: 0 pass, 1 fail, 2 usage error. No third-party dependencies.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'typesafe/jev-1.14';
const REQUIRED_ROUTES = ['/api/alpha/decisions', '/v1/decisions', '/decisions'];
const RECEIPT_SCHEMA = 'local-router/decisions-verify/v1';
const PROBABILITY_TOLERANCE = 0.02;

const USAGE = `Usage: node scripts/verify-decisions.mjs [options]

  --base-url <url>   Router base URL (default ${DEFAULT_BASE_URL})
  --model <id>       Canonical decision model (default ${DEFAULT_MODEL})
  --timeout <ms>     Per-request timeout (default 30000; probe floors at 60000)
  --out <file>       Write the JSON receipt to this path
  --json             Print only the JSON receipt
  --skip-failover    Skip the provider-pinned failover check
  --rerank           Also prove ainish-rag rerank uses this router (needs an index)
  --help             Show this help

Exit codes: 0 pass · 1 fail · 2 usage error`;

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    timeoutMs: 30_000,
    out: '',
    json: false,
    skipFailover: false,
    rerank: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case '--base-url':
        options.baseUrl = next().replace(/\/+$/, '');
        break;
      case '--model':
        options.model = next();
        break;
      case '--timeout': {
        const parsed = Number.parseInt(next(), 10);
        if (!Number.isFinite(parsed) || parsed < 1000) throw new Error('--timeout must be >= 1000');
        options.timeoutMs = parsed;
        break;
      }
      case '--out':
        options.out = next();
        break;
      case '--json':
        options.json = true;
        break;
      case '--skip-failover':
        options.skipFailover = true;
        break;
      case '--rerank':
        options.rerank = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function request(baseUrl, timeoutMs) {
  return async (pathname, init = {}) => {
    const started = Date.now();
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: response.status, ok: response.ok, json, text, ms: Date.now() - started };
  };
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function nearOne(values) {
  if (values.length === 0) return false;
  return Math.abs(sum(values) - 1) <= PROBABILITY_TOLERANCE;
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/** A check result is always recorded, even when the transport throws. */
class SkipCheck extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipCheck';
    this.skip = true;
  }
}

async function runCheck(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    return {
      name,
      status: 'pass',
      ms: Date.now() - started,
      ...(detail ? { detail } : {})
    };
  } catch (error) {
    if (error instanceof SkipCheck || error?.skip === true) {
      return { name, status: 'skipped', ms: Date.now() - started, detail: error.message };
    }
    return {
      name,
      status: 'fail',
      ms: Date.now() - started,
      detail: describeError(error)
    };
  }
}

function skippedCheck(name, reason) {
  return { name, status: 'skipped', ms: 0, detail: reason };
}

const BATCH_QUESTIONS = {
  needs_transport: {
    type: 'noul',
    instructions: 'Does this state describe routing typed decision requests?',
    criteria: {
      true: 'it describes routing or proxying decision requests',
      false: 'it does not describe decision routing'
    }
  },
  component: {
    type: 'choice',
    instructions: 'Which component does this state describe?',
    options: ['decision_transport', 'chat_proxy'],
    criteria: {
      decision_transport: 'routes typed noul/choice/score questions to a provider',
      chat_proxy: 'proxies chat completions'
    }
  },
  utility: {
    type: 'score',
    instructions: 'How completely does this state answer what the decisions transport does?',
    criteria: [
      'no relevant fact',
      'mentions routing only',
      'partial evidence',
      'names the transport behaviour',
      'a complete, quotable answer'
    ]
  }
};

const BATCH_STATE =
  'Local Router serves typed decision models: /api/alpha/decisions proxies OpenRouter and ZenMux with per-provider dialects, fails over between keyed providers, and returns provenance with every answer.';

function validateAnswer(id, question, answer) {
  if (!isObject(answer)) throw new Error(`answer "${id}" missing`);
  if (answer.type !== question.type) {
    throw new Error(`answer "${id}" type ${JSON.stringify(answer.type)} != ${question.type}`);
  }
  if (question.type === 'noul') {
    if (!isFiniteNumber(answer.noul) || answer.noul < 0 || answer.noul > 1) {
      throw new Error(`answer "${id}" noul out of range: ${answer.noul}`);
    }
    return;
  }
  if (question.type === 'choice') {
    if (typeof answer.choice !== 'string' || !question.options.includes(answer.choice)) {
      throw new Error(`answer "${id}" choice ${JSON.stringify(answer.choice)} not in options`);
    }
    if (answer.probabilities !== undefined) {
      if (!isObject(answer.probabilities)) throw new Error(`answer "${id}" probabilities not an object`);
      const probabilities = Object.values(answer.probabilities);
      if (!probabilities.every(isFiniteNumber)) throw new Error(`answer "${id}" probability not numeric`);
      if (!nearOne(probabilities)) {
        throw new Error(`answer "${id}" probabilities sum to ${sum(probabilities).toFixed(3)}`);
      }
      if (answer.probabilities[answer.choice] === undefined) {
        throw new Error(`answer "${id}" probabilities omit the selected choice`);
      }
    }
    if (answer.confidence !== undefined && (!isFiniteNumber(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) {
      throw new Error(`answer "${id}" confidence out of range`);
    }
    return;
  }
  const levelCount = question.criteria.length;
  if (!isFiniteNumber(answer.score) || answer.score < 0 || answer.score > levelCount - 1) {
    throw new Error(`answer "${id}" score ${answer.score} outside [0, ${levelCount - 1}]`);
  }
  if (!isObject(answer.legend)) throw new Error(`answer "${id}" legend missing`);
  const expectedKeys = Array.from({ length: levelCount }, (_, index) => String(index));
  for (const key of expectedKeys) {
    if (typeof answer.legend[key] !== 'string') throw new Error(`answer "${id}" legend missing level ${key}`);
  }
  if (answer.probabilities !== undefined) {
    if (!isObject(answer.probabilities)) throw new Error(`answer "${id}" probabilities not an object`);
    const probabilities = Object.values(answer.probabilities);
    if (!probabilities.every(isFiniteNumber)) throw new Error(`answer "${id}" probability not numeric`);
    if (!nearOne(probabilities)) {
      throw new Error(`answer "${id}" probabilities sum to ${sum(probabilities).toFixed(3)}`);
    }
  }
}

function resolvePinnedModels(status) {
  const advertised = Array.isArray(status?.advertised_models) ? status.advertised_models : [];
  return advertised
    .map((row) => ({
      id: typeof row?.id === 'string' ? row.id : '',
      provider: typeof row?.provider === 'string' ? row.provider : '',
      model: typeof row?.model === 'string' ? row.model : ''
    }))
    .filter((row) => row.id.includes('/'));
}

async function checkDiscovery(call, receipt) {
  const response = await call('/api/decisions/status');
  if (response.status !== 200 || !isObject(response.json)) {
    throw new Error(`/api/decisions/status returned ${response.status}`);
  }
  const status = response.json;
  const routes = Array.isArray(status.routes) ? status.routes : [];
  const missing = REQUIRED_ROUTES.filter((route) => !routes.includes(route));
  if (missing.length > 0) throw new Error(`status omits routes: ${missing.join(', ')}`);
  if (typeof status.latest_model !== 'string' || !status.latest_model) {
    throw new Error('status has no latest_model');
  }
  const providers = Array.isArray(status.providers) ? status.providers.filter((row) => row?.key_configured) : [];
  if (providers.length === 0) throw new Error('no decision provider is keyed');
  if (status.ready !== true) throw new Error('status.ready is false');

  const pinned = resolvePinnedModels(status);
  if (pinned.length === 0) throw new Error('no decision model is advertised');

  receipt.status = status;
  receipt.pinned = pinned;
  return `${routes.length} routes · ${providers.map((row) => `${row.name}:${row.dialect}`).join(', ')} · pinned ${pinned
    .map((row) => row.id)
    .join(', ')}`;
}

async function checkModels(call, receipt) {
  const pinned = Array.isArray(receipt.pinned) ? receipt.pinned : [];
  if (pinned.length === 0) throw new SkipCheck('discovery did not advertise a decision model');
  const models = await call('/v1/models');
  if (models.status !== 200 || !isObject(models.json) || !Array.isArray(models.json.data)) {
    throw new Error(`/v1/models returned ${models.status}`);
  }
  const rows = models.json.data;
  for (const pinned of receipt.pinned) {
    const matches = rows.filter((row) => row?.id === pinned.id);
    if (matches.length !== 1) {
      throw new Error(`/v1/models has ${matches.length} rows for ${pinned.id} (expected exactly 1)`);
    }
    if (matches[0]?.capabilities?.decisions !== true) {
      throw new Error(`${pinned.id} is not marked capabilities.decisions=true`);
    }
    if (matches[0]?.owned_by !== pinned.provider) {
      throw new Error(`${pinned.id} owned_by ${matches[0]?.owned_by} != ${pinned.provider}`);
    }
  }

  const tags = await call('/api/tags');
  if (tags.status !== 200 || !isObject(tags.json) || !Array.isArray(tags.json.models)) {
    throw new Error(`/api/tags returned ${tags.status}`);
  }
  const names = new Set(tags.json.models.map((row) => row?.name));
  for (const pinned of receipt.pinned) {
    if (!names.has(pinned.id)) throw new Error(`/api/tags omits ${pinned.id}`);
  }

  receipt.models = {
    count: rows.length,
    pinned: receipt.pinned.map((row) => row.id)
  };
  return `${rows.length} models · pinned ${receipt.pinned.map((row) => row.id).join(', ')}`;
}

async function checkProbe(_call, receipt, timeoutMs) {
  const probeTimeout = Math.max(timeoutMs, 60_000);
  const response = await request(receipt.baseUrl, probeTimeout)('/api/decisions/status?probe=true');
  if (response.status !== 200 || !isObject(response.json)) {
    throw new Error(`probe returned ${response.status}`);
  }
  const results = response.json?.last_probe?.results;
  if (!Array.isArray(results) || results.length === 0) throw new Error('probe returned no results');
  const answered = results.filter((row) => row?.ok === true);
  if (answered.length === 0) throw new Error('no provider answered the typed probe');
  receipt.probe = results;
  return results
    .map((row) => `${row.provider}:${row.ok ? 'ok' : 'fail'}${row.ok ? ` ${row.ms}ms` : ` ${row.error || row.status}`}`)
    .join(' · ');
}

async function checkBatch(call, receipt) {
  const response = await call('/api/alpha/decisions', {
    method: 'POST',
    body: JSON.stringify({
      model: receipt.options.model,
      state: BATCH_STATE,
      questions: BATCH_QUESTIONS
    })
  });
  if (response.status !== 200 || !isObject(response.json)) {
    throw new Error(`decision batch returned ${response.status}: ${String(response.text).slice(0, 200)}`);
  }
  const body = response.json;
  for (const field of ['model', 'provider', 'dialect']) {
    if (typeof body[field] !== 'string' || !body[field]) throw new Error(`batch response missing ${field}`);
  }
  if (!isObject(body.answers)) throw new Error('batch response missing answers');
  for (const [id, question] of Object.entries(BATCH_QUESTIONS)) {
    validateAnswer(id, question, body.answers[id]);
  }
  if (body.usage !== undefined && !isObject(body.usage)) throw new Error('batch usage is not an object');

  receipt.batch = {
    provider: body.provider,
    dialect: body.dialect,
    model: body.model,
    answers: body.answers,
    usage: body.usage ?? null,
    latency_ms: response.ms
  };
  return `${body.provider}/${body.dialect} · ${body.model} · ${response.ms} ms`;
}

async function checkChatGuard(call, receipt) {
  const pinned = receipt.pinned[0];
  const response = await call('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: pinned.id,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 8
    })
  });
  if (response.status !== 400) {
    throw new Error(`chat for ${pinned.id} returned ${response.status} (expected 400)`);
  }
  const text = String(response.json?.error ?? response.text ?? '');
  if (!text.includes('/api/alpha/decisions')) {
    throw new Error('chat refusal does not point at /api/alpha/decisions');
  }
  return `${pinned.id} refused ${response.status} with the decisions pointer`;
}

async function checkFailover(call, receipt, timeoutMs) {
  const callLong = request(receipt.baseUrl, Math.max(timeoutMs, 60_000));
  const outcomes = [];
  for (const pinned of receipt.pinned) {
    const response = await callLong('/api/alpha/decisions', {
      method: 'POST',
      body: JSON.stringify({
        model: pinned.id,
        state: 'verify failover path',
        questions: {
          reachable: {
            type: 'noul',
            instructions: 'Is this a reachability check?',
            criteria: { true: 'the state says reachability', false: 'the state says something else' }
          }
        }
      })
    });
    if (response.status !== 200 || !isObject(response.json)) {
      throw new Error(`${pinned.id} returned ${response.status}: ${String(response.text).slice(0, 160)}`);
    }
    const body = response.json;
    const attempts = Array.isArray(body?.local_router?.attempts) ? body.local_router.attempts : [];
    if (attempts.length === 0) throw new Error(`${pinned.id} returned no attempt trail`);
    const last = attempts[attempts.length - 1];
    if (last?.outcome !== 'answered') {
      throw new Error(`${pinned.id} attempt trail does not end in an answer`);
    }
    if (body.provider !== last.provider) {
      throw new Error(`${pinned.id} response provider ${body.provider} != answering attempt ${last.provider}`);
    }

    let mode;
    if (attempts.length === 1) {
      if (last.provider !== pinned.provider) {
        throw new Error(`${pinned.id} answered directly by unexpected provider ${last.provider}`);
      }
      mode = 'direct';
    } else {
      const failedFirst = attempts.slice(0, -1).some((attempt) =>
        attempt?.outcome === 'retryable_error' || attempt?.outcome === 'malformed_response'
      );
      if (!failedFirst) throw new Error(`${pinned.id} has ${attempts.length} attempts but none are recorded failures`);
      if (last.provider === pinned.provider) {
        throw new Error(`${pinned.id} recorded failures but was still answered by ${pinned.provider}`);
      }
      mode = 'failover';
    }
    outcomes.push({
      model: pinned.id,
      pinned_provider: pinned.provider,
      answered_by: body.provider,
      mode,
      attempts: attempts.map((attempt) => ({
        provider: attempt.provider,
        outcome: attempt.outcome,
        status: attempt.status ?? null
      }))
    });
  }
  receipt.failover = outcomes;
  return outcomes
    .map((row) => `${row.model}: ${row.mode} → ${row.answered_by}`)
    .join(' · ');
}

/**
 * ainish-rag writes progress lines to stdout before the JSON document, so a
 * naive JSON.parse fails. Try the whole payload first, then the longest suffix
 * that starts with a JSON delimiter.
 */
function extractJsonFromOutput(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* has a log prelude */
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines.slice(index).join('\n').trim();
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* keep scanning earlier offsets */
    }
  }
  return null;
}

async function checkRerank(receipt, baseUrl) {
  const environment = {
    ...process.env,
    JEV_LOCAL_ROUTER_URL: baseUrl,
    // Force the router to be the transport: the engine tries OpenRouter first.
    OPENROUTER_API_KEY: 'invalid-local-router-verify-key'
  };
  const started = Date.now();
  const query = spawnSync(
    'ainish-rag',
    ['query', 'decision transport failover provenance', '--json'],
    { encoding: 'utf8', timeout: 240_000, env: environment }
  );
  const ms = Date.now() - started;
  if (query.error) {
    throw new SkipCheck(`ainish-rag not runnable: ${query.error.message}`);
  }
  if (query.status !== 0) {
    throw new SkipCheck(`ainish-rag query failed: ${String(query.stderr || query.stdout).slice(0, 200)}`);
  }

  const parsed = extractJsonFromOutput(query.stdout);
  if (!parsed) {
    throw new SkipCheck('ainish-rag query did not return JSON (no index?)');
  }
  const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.results) ? parsed.results : [];
  const rationales = items.map((item) => String(item?.rationale ?? '')).filter(Boolean);
  if (rationales.length === 0) {
    throw new SkipCheck('ainish-rag query returned no reranked results (index empty?)');
  }
  const throughRouter = rationales.filter((rationale) => rationale.includes('Jev local-router:'));
  if (throughRouter.length === 0) {
    throw new Error(`rerank rationales do not name the local-router transport: ${rationales[0].slice(0, 160)}`);
  }

  receipt.rerank = { latency_ms: ms, results: items.length, through_router: throughRouter.length };
  return `${throughRouter.length}/${items.length} reranked chunks via local-router · ${ms} ms`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${describeError(error)}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const call = request(options.baseUrl, options.timeoutMs);
  const startedAt = Date.now();
  const receipt = {
    schema: RECEIPT_SCHEMA,
    generated_at: new Date().toISOString(),
    base_url: options.baseUrl,
    model: options.model,
    overall: 'fail',
    options: { timeout_ms: options.timeoutMs, skip_failover: options.skipFailover, rerank: options.rerank },
    checks: []
  };
  // Checks receive the receipt for context (baseUrl, pinned rows, options).
  receipt.options.model = options.model;
  receipt.baseUrl = options.baseUrl;

  const checks = [];
  checks.push(await runCheck('discovery', () => checkDiscovery(call, receipt)));
  checks.push(
    receipt.pinned?.length
      ? await runCheck('models', () => checkModels(call, receipt))
      : skippedCheck('models', 'discovery did not advertise a decision model')
  );
  checks.push(
    receipt.pinned?.length
      ? await runCheck('probe', () => checkProbe(call, receipt, options.timeoutMs))
      : skippedCheck('probe', 'discovery did not advertise a decision model')
  );
  checks.push(
    receipt.pinned?.length
      ? await runCheck('batch', () => checkBatch(call, receipt))
      : skippedCheck('batch', 'discovery did not advertise a decision model')
  );
  checks.push(
    receipt.pinned?.length
      ? await runCheck('chat guard', () => checkChatGuard(call, receipt))
      : skippedCheck('chat guard', 'discovery did not advertise a decision model')
  );
  checks.push(
    options.skipFailover
      ? skippedCheck('failover', '--skip-failover')
      : receipt.pinned?.length
        ? await runCheck('failover', () => checkFailover(call, receipt, options.timeoutMs))
        : skippedCheck('failover', 'discovery did not advertise a decision model')
  );
  checks.push(
    options.rerank
      ? await runCheck('rerank', () => checkRerank(receipt, options.baseUrl))
      : skippedCheck('rerank', 'pass --rerank to exercise ainish-rag')
  );

  receipt.checks = checks;
  receipt.elapsed_ms = Date.now() - startedAt;
  receipt.overall = checks.some((check) => check.status === 'fail') ? 'fail' : 'pass';

  if (options.out) {
    const target = path.resolve(options.out);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    receipt.receipt_path = target;
  }

  if (options.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    console.log(`Local Router decisions verification — ${options.baseUrl}`);
    for (const check of checks) {
      const label = check.status === 'pass' ? 'PASS' : check.status === 'fail' ? 'FAIL' : 'SKIP';
      console.log(`  [${label}] ${check.name.padEnd(10)} ${String(check.ms).padStart(6)} ms  ${check.detail ?? ''}`);
    }
    console.log(`Overall: ${receipt.overall.toUpperCase()} (${receipt.elapsed_ms} ms)`);
    if (receipt.receipt_path) console.log(`Receipt: ${receipt.receipt_path}`);
  }

  process.exit(receipt.overall === 'pass' ? 0 : 1);
}

await main();
