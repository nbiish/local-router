#!/usr/bin/env node
/**
 * Prove Cline/Kilo catalog rows against live endpoints.
 * Free: Kilo = GET /models zero pricing + chat 200; Cline = recommended free + chat 200.
 * Paid: chat 200 on provider endpoint (not inferred from ZenMux).
 * Usage: eval "$(bin/pqc-secrets export)" && node scripts/validate-cline-kilo-catalog.mjs
 */
import fs from 'fs';
import path from 'path';

const RESEARCH_DIR = path.resolve('.agents/research');
const PROVIDERS_PATH = path.resolve('providers.txt');

const EXCLUDED_PREFIXES = ['anthropic/', 'openai/', 'google/'];
const KILO_ROUTER_IDS = new Set(['kilo-auto/free']);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Run: eval "$(bin/pqc-secrets export)"`);
    process.exit(1);
  }
  return value;
}

function excludedUpstream(id) {
  const normalized = String(id || '').toLowerCase();
  if (KILO_ROUTER_IDS.has(normalized)) return true;
  if (normalized === 'nvidia/nemotron-3.5-content-safety:free' || normalized === 'nvidia/nemotron-3.5-content-safety') return true;
  return EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    || normalized.includes('/gemini');
}

function parseCatalogRows(providerName) {
  const content = fs.readFileSync(PROVIDERS_PATH, 'utf8');
  const rows = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('# │')) continue;
    const columns = line
      .replace(/^#\s*/, '')
      .split('│')
      .map((part) => part.trim())
      .filter(Boolean);
    if (columns.length < 4 || !/^\d+$/.test(columns[0])) continue;
    if (columns[1] !== providerName) continue;
    rows.push({
      row: columns[0],
      provider: columns[1],
      model: columns[2],
      display: columns[3]
    });
  }

  return rows;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(45000) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  return { status: res.status, body };
}

async function chatProbe(baseUrl, apiKey, model) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false
    }),
    signal: AbortSignal.timeout(45000)
  });
  const text = await res.text();
  let error = '';
  try {
    const json = JSON.parse(text);
    error = json?.error?.message || json?.error?.type || '';
  } catch {
    error = text.slice(0, 160);
  }
  return { status: res.status, ok: res.status >= 200 && res.status < 300, error };
}

function isKiloFreePricing(entry) {
  const prompt = parseFloat(entry?.pricing?.prompt ?? '1');
  const completion = parseFloat(entry?.pricing?.completion ?? '1');
  return prompt === 0 && completion === 0;
}

async function validateKilo(kiloKey, catalogRows) {
  const baseUrl = 'https://api.kilo.ai/api/gateway';
  const modelsRes = await fetchJson(`${baseUrl}/models`, {
    Authorization: `Bearer ${kiloKey}`
  });
  const upstream = new Map(
    (modelsRes.body?.data || []).map((entry) => [entry.id, entry])
  );

  const pricingFree = (modelsRes.body?.data || [])
    .filter((entry) => isKiloFreePricing(entry))
    .map((entry) => entry.id)
    .filter((id) => !excludedUpstream(id));

  const provableFree = [];
  for (const id of pricingFree) {
    const probe = await chatProbe(baseUrl, kiloKey, id);
    if (probe.ok) provableFree.push(id);
  }

  const catalogByModel = new Map(catalogRows.map((row) => [row.model, row]));
  const catalogResults = [];
  for (const row of catalogRows) {
    const exists = upstream.has(row.model);
    const probe = exists
      ? await chatProbe(baseUrl, kiloKey, row.model)
      : { status: 0, ok: false, error: 'not in GET /models' };
    const tier = exists && isKiloFreePricing(upstream.get(row.model)) ? 'free' : 'paid';
    catalogResults.push({
      model: row.model,
      row: row.row,
      inCatalog: true,
      inUpstream: exists,
      upstreamTier: exists ? tier : null,
      chat: probe,
      keep: exists && probe.ok && !excludedUpstream(row.model)
    });
  }

  const missingFree = provableFree
    .filter((id) => !catalogByModel.has(id))
    .map((id) => ({ model: id, upstreamTier: 'free', inCatalog: false }));

  return {
    endpoint: baseUrl,
    upstreamCount: upstream.size,
    provableFree,
    catalogResults,
    missingFree,
    staleCatalog: catalogResults.filter((row) => row.inCatalog && !row.keep)
  };
}

async function validateCline(clineKey, catalogRows) {
  const baseUrl = 'https://api.cline.bot/api/v1';
  const recommended = await fetchJson(`${baseUrl}/ai/cline/recommended-models`);
  const recommendedFree = (recommended.body?.free || []).map((entry) => entry.id);

  const catalogByModel = new Map(catalogRows.map((row) => [row.model, row]));
  const catalogResults = [];
  for (const row of catalogRows) {
    const probe = await chatProbe(baseUrl, clineKey, row.model);
    const recommendedIsFree = recommendedFree.includes(row.model)
      || recommendedFree.includes(row.model.replace(/:free$/, ''));
    catalogResults.push({
      model: row.model,
      row: row.row,
      inCatalog: true,
      recommendedFree: recommendedIsFree,
      chat: probe,
      keep: probe.ok && !excludedUpstream(row.model)
    });
  }

  const extraCandidates = [...recommendedFree]
    .filter((id, index, all) => id && all.indexOf(id) === index)
    .filter((id) => !catalogByModel.has(id) && !catalogByModel.has(`${id}:free`));

  const missingFree = [];
  for (const id of extraCandidates) {
    const canonical = id.includes(':free') ? id : (
      catalogByModel.has(`${id}:free`) ? null : (
        id === 'nvidia/nemotron-3-ultra-550b-a55b' ? 'nvidia/nemotron-3-ultra-550b-a55b:free' : id
      )
    );
    if (!canonical || catalogByModel.has(canonical)) continue;
    const probe = await chatProbe(baseUrl, clineKey, canonical);
    if (probe.ok && !excludedUpstream(canonical)) {
      missingFree.push({ model: canonical, recommendedFree: true, chat: probe });
    }
  }

  const provableFree = catalogResults
    .filter((row) => row.recommendedFree && row.keep)
    .map((row) => row.model);
  for (const row of missingFree) {
    if (!provableFree.includes(row.model)) provableFree.push(row.model);
  }

  return {
    endpoint: baseUrl,
    recommendedFree,
    provableFree,
    catalogResults,
    missingFree,
    staleCatalog: catalogResults.filter((row) => row.inCatalog && !row.keep)
  };
}

async function main() {
  const clineKey = requireEnv('CLINE_API_KEY');
  const kiloKey = requireEnv('KILO_API_KEY');
  fs.mkdirSync(RESEARCH_DIR, { recursive: true });

  const clineCatalog = parseCatalogRows('cline');
  const kiloCatalog = parseCatalogRows('kilo');

  const report = {
    generatedAt: new Date().toISOString(),
    policy: {
      excludedFamilies: EXCLUDED_PREFIXES,
      kiloFreeSource: 'GET /models zero pricing + chat 200',
      clineFreeSource: 'recommended-models free[] + chat 200 (openrouter/free excluded — Kilo/OR only)',
      paidSource: 'chat 200 on provider endpoint (upstream tier paid for Kilo)'
    },
    cline: await validateCline(clineKey, clineCatalog),
    kilo: await validateKilo(kiloKey, kiloCatalog)
  };

  const outPath = path.join(RESEARCH_DIR, 'cline-kilo-catalog-validation.json');
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);

  const printSection = (name, section) => {
    console.log(`\n=== ${name} ===`);
    console.log(`Catalog rows: ${section.catalogResults.length}`);
    const freeCount = section.provableFree.length;
    console.log(`Provable free (chat 200): ${freeCount}`);
    const stale = section.staleCatalog.map((row) => row.model);
    if (stale.length) console.log(`REMOVE (not provable): ${stale.join(', ')}`);
    const missing = section.missingFree.map((row) => row.model);
    if (missing.length) console.log(`ADD free: ${missing.join(', ')}`);
    const keep = section.catalogResults.filter((row) => row.keep).map((row) => row.model);
    console.log(`KEEP: ${keep.join(', ')}`);
  };

  printSection('cline', report.cline);
  printSection('kilo', report.kilo);
  console.log(`\nWrote ${outPath}`);

  if (report.cline.staleCatalog.length || report.kilo.staleCatalog.length || report.cline.missingFree.length || report.kilo.missingFree.length) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
