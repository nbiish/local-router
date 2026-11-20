#!/usr/bin/env node
/**
 * verify-provider-endpoints.mjs — read-only receipt for the provider rows that
 * this repository claims to be able to reach.
 *
 * Why this exists: a provider row is a set of factual claims (a host answers, a
 * credential authorises, the model ids in the registry are servable). Nothing in
 * the test suite can check those claims, because they require the network and a
 * key — so a row can rot for months while every unit test passes. That is
 * exactly what happened to `modal-proxy` (host retired, 404) and to the Nebius
 * catalog (16 of 29 curated ids dead upstream).
 *
 * Contract:
 *   - Read-only. It never writes, never changes curation, never spends beyond
 *     the single tiny completion per provider needed to prove servability.
 *   - Never prints, logs, or embeds a secret. Keys are pulled into memory and
 *     only ever compared for presence/length.
 *   - Honest. An upstream rejection is reported as that rejection, verbatim,
 *     with the row marked FAILED — not retried into a green.
 *
 * Usage:
 *   node scripts/verify-provider-endpoints.mjs [--provider <name>]... [--json]
 *   node scripts/verify-provider-endpoints.mjs --no-chat   # /v1/models only
 *
 * Exit codes:
 *   0  every targeted provider answered
 *   1  at least one provider failed
 *   2  no credentials available (nothing could be tested)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ── Targets ────────────────────────────────────────────────────────────────
//
// One entry per provider row this receipt can prove. Kept explicit rather than
// derived from the registry: a provider that needs a hand-written body shape
// (Modal's hostname-as-model, Nebius's reasoning dial) earns a line here.

const TARGETS = [
  {
    provider: 'nebius',
    keyVars: ['LOCALROUTER_NEBIUS_API_KEY', 'NEBIUS_API_KEY'],
    baseUrl: 'https://api.tokenfactory.nebius.com/v1',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
  },
  {
    provider: 'nebius-us-north1',
    keyVars: ['LOCALROUTER_NEBIUS_API_KEY', 'NEBIUS_API_KEY'],
    baseUrl: 'https://api.tokenfactory.us-north1.nebius.com/v1',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
  },
  {
    provider: 'modal-proxy',
    keyVars: ['MODAL_PROXY_TOKEN_ID', 'MODAL_PROXY_TOKEN_SECRET'],
    // The pair is joined, exactly as src/providers/modal-proxy.ts does it.
    joinWith: '.',
    baseUrl: 'https://nbiish--ep-deepseek-v4-1-flash-1017-server.us-west.modal.direct/v1',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
  },
  {
    provider: 'modal',
    keyVars: ['LOCALROUTER_MODAL_API_KEY', 'MODAL_API_KEY'],
    baseUrl: 'https://inference.us-west.modal.direct/v1',
    model: 'moonshotai/Kimi-K3',
    // Documented as an ak-/as- API-token provider; a wk-/ws- proxy pair is not
    // a substitute, so a 401 here is a real finding, not a script bug.
    note: 'needs ak-/as- API token, not a wk-/ws- proxy pair'
  }
];

// ── Secret handling ────────────────────────────────────────────────────────

/**
 * Load secrets from the PQC bundle into memory, exactly the way the router does
 * (`pqc-secrets export`). Failure is not fatal: an already-exported environment
 * is a legitimate source, and a missing bundle just means fewer targets run.
 */
function loadBundleSecrets() {
  const candidates = [
    path.join(process.cwd(), 'bin', 'pqc-secrets'),
    path.join(process.cwd(), '.agents', 'skills', 'pqc-secrets', 'scripts', 'pqc_secrets.py')
  ];
  for (const candidate of candidates) {
    let output;
    try {
      output = execFileSync(candidate, candidate.endsWith('.py') ? ['export'] : ['export'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 60_000
      });
    } catch {
      continue;
    }
    const secrets = {};
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      secrets[match[1]] = value;
    }
    if (Object.keys(secrets).length > 0) return { secrets, source: candidate };
  }
  return { secrets: {}, source: null };
}

/** A key is present if every named var resolves, from the bundle or the env. */
function resolveKey(target, bundle) {
  for (const name of target.keyVars) {
    const value = process.env[name] || bundle[name];
    if (value) RESOLVED_SECRETS.push(value);
  }
  // A joined key (Modal's `wk-`. `ws-` pair) needs EVERY part; a plain row needs
  // the FIRST that resolves, because its list is a set of accepted spellings.
  if (target.joinWith) {
    const parts = [];
    for (const name of target.keyVars) {
      const value = process.env[name] || bundle[name];
      if (!value) return { ok: false, missing: name };
      parts.push(value);
    }
    return { ok: true, value: parts.join(target.joinWith) };
  }
  for (const name of target.keyVars) {
    const value = process.env[name] || bundle[name];
    if (value) return { ok: true, value, name };
  }
  return { ok: false, missing: target.keyVars.join(' or ') };
}

/**
 * Strip every configured secret out of text that came from upstream.
 *
 * Modal's proxy rejection echoes the token ID back in the body
 * ("Webhook token not found: wk-..."). The ID alone is half a credential, and
 * this repository's diagnostics surface upstream bodies into logs and the UI, so
 * nothing that reaches stdout may carry it.
 */
function redactSecrets(text, secrets) {
  let output = String(text ?? '');
  for (const value of secrets) {
    if (!value || value.length < 6) continue;
    output = output.split(value).join('[redacted]');
  }
  return output;
}

/** Every secret value this run has resolved, for redaction. */
const RESOLVED_SECRETS = [];

/** What may be echoed about a secret: its presence, never its content. */
function redact(value) {
  if (!value) return '(unset)';
  return `len=${value.length}`;
}

// ── Probes ─────────────────────────────────────────────────────────────────

async function fetchJson(url, init, timeoutMs = 30_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, ok: response.ok, body };
}

/** Extract a short, non-secret reason from an upstream error body. */
function describeError(body) {
  const raw = typeof body === 'string'
    ? body
    : (typeof body?.error === 'string'
      ? body.error
      : (body?.error && typeof body.error === 'object'
        ? String(body.error.message || body.error.type || JSON.stringify(body.error))
        : JSON.stringify(body)));
  return redactSecrets(raw, RESOLVED_SECRETS).slice(0, 160);
}

async function verifyTarget(target, key, options) {
  const result = { provider: target.provider, baseUrl: target.baseUrl, steps: [], ok: false };
  const headers = { Authorization: `Bearer ${key.value}` };

  if (target.note) result.note = target.note;

  // 1. Discovery. A provider that cannot list models can still serve chat, so a
  //    failure here is recorded but does not by itself fail the row.
  const models = await fetchJson(`${target.baseUrl}/models`, { headers });
  const listed = Array.isArray(models.body?.data)
    ? models.body.data.map((entry) => entry?.id).filter(Boolean)
    : [];
  result.steps.push({
    step: 'models',
    status: models.status,
    ok: models.ok,
    listed: listed.length,
    ...(models.ok ? {} : { error: describeError(models.body) }),
    ...(models.ok && listed.length > 0 ? { ids: listed } : {})
  });

  if (models.ok && listed.length > 0 && !listed.includes(target.model)) {
    result.steps.push({
      step: 'model-presence',
      ok: false,
      error: `${target.model} is in the registry but not in the live listing`
    });
  }

  // 2. Servability. One minimal completion with the registry's own model id —
  //    a listing entry is not proof that the id can actually answer.
  if (!options.noChat) {
    const chat = await fetchJson(`${target.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        // Reasoning models spend the first tokens thinking. A 8-token budget
        // returns 200 with empty content on both Nebius hosts, which would make
        // this step assert nothing; 64 leaves room for a one-word answer.
        max_tokens: 64,
        temperature: 0,
        stream: false
      })
    }, 90_000);
    const content = chat.body?.choices?.[0]?.message?.content;
    const reasoning = chat.body?.choices?.[0]?.message?.reasoning_content;
    const hasChoice = Array.isArray(chat.body?.choices) && chat.body.choices.length > 0;
    // A reasoning model with a small budget can spend every token thinking and
    // return empty `content` while `reasoning_content` is populated. That is a
    // served request, not a failure — so either field is proof of servability,
    // and the step only fails when no choice came back at all.
    result.steps.push({
      step: 'chat',
      status: chat.status,
      ok: chat.ok && hasChoice,
      ...(chat.ok
        ? {
          reply: String(content ?? '').slice(0, 40) || '(empty content)',
          ...(reasoning ? { reasoningChars: String(reasoning).length } : {})
        }
        : { error: describeError(chat.body) })
    });
  }

  // A row passes when the chat step passed. Discovery is evidence, not a gate:
  // an upstream can serve chat while its /models endpoint is absent or gated.
  const chatStep = result.steps.find((step) => step.step === 'chat');
  const presenceStep = result.steps.find((step) => step.step === 'model-presence');
  result.ok = options.noChat
    ? Boolean(models.ok)
    : Boolean(chatStep?.ok) && !presenceStep;
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { providers: [], json: false, noChat: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--no-chat') options.noChat = true;
    else if (arg === '--provider') options.providers.push(argv[++index]);
    else if (arg.startsWith('--provider=')) options.providers.push(arg.slice('--provider='.length));
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { secrets, source } = loadBundleSecrets();
  const bundle = { ...secrets, ...process.env };

  const targets = options.providers.length > 0
    ? TARGETS.filter((target) => options.providers.includes(target.provider))
    : TARGETS;

  if (targets.length === 0) {
    console.error('No matching provider. Known: ' + TARGETS.map((t) => t.provider).join(', '));
    process.exit(2);
  }

  const results = [];
  let ranAny = false;

  for (const target of targets) {
    const key = resolveKey(target, bundle);
    if (!key.ok) {
      results.push({
        provider: target.provider,
        baseUrl: target.baseUrl,
        ok: false,
        skipped: true,
        reason: `${key.missing} not set (bundle + env both empty)`
      });
      continue;
    }
    ranAny = true;
    results.push(await verifyTarget(target, key, options));
  }

  if (options.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      keySource: source ? path.relative(process.cwd(), source) : 'environment only',
      results
    }, null, 2));
  } else {
    console.log(`provider endpoint receipt — ${new Date().toISOString()}`);
    console.log(`key source: ${source ? path.relative(process.cwd(), source) : 'environment only'}`);
    for (const result of results) {
      const verdict = result.skipped ? 'SKIP' : result.ok ? 'PASS' : 'FAIL';
      console.log(`\n[${verdict}] ${result.provider}  ${result.baseUrl}`);
      if (result.reason) console.log(`       ${result.reason}`);
      if (result.note) console.log(`       note: ${result.note}`);
      for (const step of result.steps || []) {
        if (step.step === 'models') {
          console.log(`       models: HTTP ${step.status}, ${step.listed} listed`
            + (step.error ? ` — ${step.error}` : ''));
        } else if (step.step === 'chat') {
          console.log(`       chat:   HTTP ${step.status}`
            + (step.ok ? ` — reply ${JSON.stringify(step.reply)}` : ` — ${step.error}`));
        } else {
          console.log(`       ${step.step}: ${step.ok ? 'ok' : `FAILED — ${step.error}`}`);
        }
      }
    }
  }

  if (!ranAny) {
    console.error('\nno credentials available — nothing was verified');
    process.exit(2);
  }
  process.exit(results.some((result) => !result.ok && !result.skipped) ? 1 : 0);
}

main().catch((error) => {
  // Never let a stack trace carry a key or a URL with a token in it.
  console.error(`receipt failed: ${String(error?.message || error).slice(0, 300)}`);
  process.exit(1);
});
