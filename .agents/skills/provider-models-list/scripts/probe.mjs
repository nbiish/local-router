#!/usr/bin/env node
/**
 * provider-models-list probe — hits the live /v1/models endpoint of every
 * configured local-router provider and emits a unified table.
 *
 * Usage:
 *   node probe.mjs                              # all providers, all models
 *   node probe.mjs zenmux openrouter           # specific providers
 *   node probe.mjs --filter "step|kimi"          # regex filter on model id
 *   node probe.mjs --json                       # JSON output
 *   node probe.mjs --free                       # only free-tier models (heuristic)
 *   node probe.mjs --context 1000000            # only models with ctx >= 1M
 *
 * Keys are pulled from `process.env.<KEY_ENV_VAR>`; if the running shell
 * has not run `secrets-load`, the affected provider is skipped with a
 * "no key" warning rather than erroring.
 *
 * No secrets are written to disk or echoed to the log. Bearer tokens are
 * only used in-process for the fetch.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROVIDERS = [
  { slug: 'wafer-serverless',   baseUrl: 'https://pass.wafer.ai/v1',              envVar: 'WAFER_SERVERLESS_API_KEY', modelsPath: '/models' },
  { slug: 'zenmux',             baseUrl: 'https://zenmux.ai/api/v1',              envVar: 'ZENMUX_API_KEY',           modelsPath: '/models' },
  { slug: 'nebius',             baseUrl: 'https://api.tokenfactory.nebius.com/v1', envVar: 'NEBIUS_API_KEY',         modelsPath: '/models' },
  { slug: 'moonshot',           baseUrl: 'https://api.moonshot.ai/v1',            envVar: 'MOONSHOT_API_KEY',         modelsPath: '/models' },
  { slug: 'nvidia-nim',         baseUrl: 'https://integrate.api.nvidia.com/v1',   envVar: 'NVIDIA_NIM_API_KEY',       modelsPath: '/models' },
  { slug: 'modal',              baseUrl: 'https://api.us-west-2.modal.direct/v1', envVar: 'MODAL_API_KEY',            modelsPath: '/models' },
  { slug: 'openrouter',         baseUrl: 'https://openrouter.ai/api/v1',          envVar: 'OPENROUTER_API_KEY',       modelsPath: '/models' },
  { slug: 'xiaomi-mimo',        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1', envVar: 'XIAOMI_MIMO_API_KEY',   modelsPath: '/models' },
  { slug: 'opencode-go',        baseUrl: 'https://opencode.ai/zen/go/v1',          envVar: 'OPENCODE_API_KEY',         modelsPath: '/models' },
  { slug: 'opencode-zen',       baseUrl: 'https://opencode.ai/zen/v1',             envVar: 'OPENCODE_ZEN_API_KEY',     modelsPath: '/models' },
  { slug: 'zai',                baseUrl: 'https://api.z.ai/api/coding/paas/v4',    envVar: 'ZAI_API_KEY',              modelsPath: '/models' },
  { slug: 'ollama',             baseUrl: 'http://127.0.0.1:11435/v1',              envVar: 'OLLAMA_API_KEY',           modelsPath: '/models' },
  { slug: 'cline',              baseUrl: 'https://api.cline.bot/api/v1',          envVar: 'CLINE_API_KEY',            modelsPath: '/models' },
  { slug: 'kilo',               baseUrl: 'https://api.kilo.ai/api/gateway',       envVar: 'KILO_API_KEY',             modelsPath: '/models' },
  { slug: 'commandcode',        baseUrl: 'https://api.commandcode.ai/provider/v1', envVar: 'COMMANDCODE_API_KEY',  modelsPath: '/models' },
  { slug: 'pioneer',            baseUrl: 'https://api.pioneer.ai/v1',             envVar: 'PIONEER_API_KEY',          modelsPath: '/models' },
  { slug: 'nous-portal',        baseUrl: 'https://inference-api.nousresearch.com/v1', envVar: 'NOUS_API_KEY',         modelsPath: '/models' }
];

const OAUTH_SKIPS = new Set(['antigravity', 'github-copilot']);

function parseArgs(argv) {
  const opts = { providers: [], filter: null, json: false, free: false, minContext: 0, compare: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--free') { opts.free = true; continue; }
    if (a === '--compare') { opts.compare = true; continue; }
    if (a === '--filter') { opts.filter = new RegExp(argv[++i] || '', 'i'); continue; }
    if (a === '--context') { opts.minContext = Number.parseInt(argv[++i] || '0', 10); continue; }
    if (a.startsWith('--')) { console.error(`Unknown flag: ${a}`); process.exit(1); }
    opts.providers.push(a);
  }
  return opts;
}

async function fetchProviderModels(provider, signal) {
  const key = process.env[provider.envVar];
  if (!key) {
    return { ok: false, reason: `no key (${provider.envVar} not in env)`, models: [] };
  }
  const url = `${provider.baseUrl.replace(/\/+$/, '')}${provider.modelsPath}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      signal
    });
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}`, models: [] };
    }
    const body = await res.json();
    const list = Array.isArray(body.data) ? body.data
      : Array.isArray(body.models) ? body.models
      : Array.isArray(body) ? body
      : [];
    const models = list.map((m) => {
      const id = m.id || m.name || m.model || '';
      return {
        id: String(id),
        context: typeof m.context_length === 'number' ? m.context_length
              : typeof m.max_context_length === 'number' ? m.max_context_length
              : null,
        pricing: m.pricing || null,
        raw: m
      };
    });
    return { ok: true, reason: null, models };
  } catch (err) {
    return { ok: false, reason: err.message || 'fetch failed', models: [] };
  }
}

function isFreeHeuristic(model) {
  const id = String(model.id || '').toLowerCase();
  if (id.endsWith(':free') || id.includes(':free')) return true;
  if (id.endsWith('-free') || id.endsWith('.free')) return true;
  if (id.includes('openrouter/free')) return true;
  const p = model.pricing;
  if (p && Number(p.prompt) === 0 && Number(p.completion) === 0) return true;
  return false;
}

function filterModels(models, opts) {
  return models.filter((m) => {
    if (opts.filter && !opts.filter.test(m.id)) return false;
    if (opts.free && !isFreeHeuristic(m)) return false;
    if (opts.minContext > 0 && (m.context == null || m.context < opts.minContext)) return false;
    return true;
  });
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function readBaselineModels() {
  // Baseline = the authoritative in-code registry (src/provider-model-registries.ts),
  // read from the compiled build when available.
  for (const candidate of [
    path.resolve(process.cwd(), 'build/provider-model-registries.js'),
    path.resolve(__dirname, '../../../../build/provider-model-registries.js')
  ]) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const mod = await import(`file://${candidate}`);
      const registry = mod.PROVIDER_MODEL_REGISTRY || {};
      const models = [];
      for (const [provider, entries] of Object.entries(registry)) {
        for (const entry of entries || []) {
          if (entry?.id) models.push({ provider, model: entry.id });
        }
      }
      return models;
    } catch {
      // fall through to next candidate
    }
  }
  return [];
}

function renderComparison(results) {
  const baseline = await readBaselineModels();
  const baselineMap = new Map();
  for (const b of baseline) {
    if (!baselineMap.has(b.provider)) {
      baselineMap.set(b.provider, new Set());
    }
    baselineMap.get(b.provider).add(b.model.toLowerCase());
  }

  const reports = [];
  for (const { provider, result } of results) {
    if (!result.ok) continue;

    const liveIds = new Set(result.models.map(m => m.id.toLowerCase()));
    const baselineIds = baselineMap.get(provider.slug) || new Set();

    const added = result.models.filter(m => !baselineIds.has(m.id.toLowerCase()));
    const retired = [...baselineIds].filter(bId => !liveIds.has(bId));

    if (added.length > 0 || retired.length > 0) {
      reports.push(`\nProvider: ${provider.slug}`);
      if (added.length > 0) {
        reports.push(`  + ADDED UPSTREAM (missing in registry):`);
        for (const m of added) {
          const freeSuffix = isFreeHeuristic(m) ? ' (FREE)' : '';
          reports.push(`    - ${m.id}${freeSuffix}`);
        }
      }
      if (retired.length > 0) {
        reports.push(`  - RETIRED UPSTREAM (present in registry but missing live):`);
        for (const bId of retired) {
          reports.push(`    - ${bId}`);
        }
      }
    }
  }

  if (reports.length === 0) {
    return '\n✅ No model drift detected. All live provider models match the registry exactly.';
  }

  return '\n=== MODEL DRIFT AUDIT REPORT ===' + reports.join('\n');
}

function renderTable(rows) {
  const cols = [
    { name: 'PROVIDER', width: 22 },
    { name: 'MODEL ID', width: 56 },
    { name: 'CTX',       width: 10 },
    { name: 'PRICE/M in', width: 14 },
    { name: 'STATUS',   width: 16 }
  ];
  const sep = cols.map((c) => '-'.repeat(c.width)).join('-+-');
  const head = cols.map((c) => pad(c.name, c.width)).join(' | ');
  const lines = [head, sep];
  for (const r of rows) {
    lines.push(cols.map((c) => pad(r[c.name.toLowerCase()] ?? '', c.width)).join(' | '));
  }
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const targetSlugs = opts.providers.length
    ? new Set(opts.providers)
    : new Set(PROVIDERS.map((p) => p.slug));
  const targets = PROVIDERS.filter((p) => targetSlugs.has(p.slug));
  for (const skip of OAUTH_SKIPS) {
    if (targetSlugs.has(skip)) {
      console.error(`# ${skip} is OAuth; use the proxy's /api/oauth endpoint, not /v1/models.`);
    }
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10_000);
  try {
    const results = await Promise.all(
      targets.map(async (p) => ({ provider: p, result: await fetchProviderModels(p, ac.signal) }))
    );
    clearTimeout(timer);

    if (opts.compare) {
      console.log(renderComparison(results));
      return;
    }

    if (opts.json) {
      const out = results.map(({ provider, result }) => ({
        provider: provider.slug,
        ok: result.ok,
        reason: result.reason,
        models: filterModels(result.models, opts)
      }));
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    const rows = [];
    for (const { provider, result } of results) {
      if (!result.ok) {
        rows.push({
          provider: provider.slug,
          'model id': '—',
          ctx: '—',
          'price/m in': '—',
          status: result.reason
        });
        continue;
      }
      const filtered = filterModels(result.models, opts);
      if (filtered.length === 0) {
        rows.push({
          provider: provider.slug,
          'model id': '(no models match filter)',
          ctx: '—',
          'price/m in': '—',
          status: 'ok'
        });
        continue;
      }
      for (const m of filtered) {
        const p = m.pricing || {};
        rows.push({
          provider: provider.slug,
          'model id': m.id,
          ctx: m.context == null ? '?' : m.context.toLocaleString(),
          'price/m in': (p.prompt != null || p.completion != null)
            ? `in ${p.prompt ?? '?'} / out ${p.completion ?? '?'}`
            : '—',
          status: isFreeHeuristic(m) ? 'FREE' : 'paid'
        });
      }
    }
    console.log(renderTable(rows));
    console.log(`\n# ${results.length} provider(s) probed. OAuth providers (antigravity, github-copilot) excluded — use /api/oauth instead.`);
  } catch (err) {
    clearTimeout(timer);
    console.error(`fatal: ${err.message || err}`);
    process.exit(1);
  }
}

main();
