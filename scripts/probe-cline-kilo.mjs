#!/usr/bin/env node
/**
 * Probe Cline + Kilo gateways. Requires env from PQC:
 *   eval "$(bin/pqc-secrets export)" && node scripts/probe-cline-kilo.mjs
 */
import fs from 'fs';
import path from 'path';

const RESEARCH_DIR = path.resolve('.agents/research');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Run: eval "$(bin/pqc-secrets export)"`);
    process.exit(1);
  }
  return value;
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
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
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  let err;
  try {
    const j = JSON.parse(text);
    err = j.error;
  } catch {
    err = text.slice(0, 120);
  }
  return { status: res.status, error: err };
}

async function main() {
  const clineKey = requireEnv('CLINE_API_KEY');
  const kiloKey = requireEnv('KILO_API_KEY');
  fs.mkdirSync(RESEARCH_DIR, { recursive: true });

  const kiloBase = 'https://api.kilo.ai/api/gateway';
  const clineBase = 'https://api.cline.bot/api/v1';

  const kiloModelsAnon = await fetchJson(`${kiloBase}/models`);
  const kiloModelsAuth = await fetchJson(`${kiloBase}/models`, {
    Authorization: `Bearer ${kiloKey}`
  });

  fs.writeFileSync(
    path.join(RESEARCH_DIR, 'kilo-models-anon.json'),
    JSON.stringify({ status: kiloModelsAnon.status, count: kiloModelsAnon.body?.data?.length }, null, 2)
  );
  fs.writeFileSync(
    path.join(RESEARCH_DIR, 'kilo-models-auth-summary.json'),
    JSON.stringify(
      {
        status: kiloModelsAuth.status,
        count: kiloModelsAuth.body?.data?.length,
        freeIds: (kiloModelsAuth.body?.data || [])
          .filter((m) => {
            const p = parseFloat(m.pricing?.prompt ?? '1');
            const c = parseFloat(m.pricing?.completion ?? '1');
            return p === 0 && c === 0;
          })
          .map((m) => m.id)
      },
      null,
      2
    )
  );

  const clineModels = [
    'openrouter/free',
    'deepseek/deepseek-v4-flash',
    'minimax/minimax-m2.5'
  ];
  const clineProbes = {};
  for (const model of clineModels) {
    clineProbes[model] = await chatProbe(clineBase, clineKey, model);
  }
  fs.writeFileSync(
    path.join(RESEARCH_DIR, 'cline-chat-probes.json'),
    JSON.stringify(clineProbes, null, 2)
  );

  console.log('Wrote summaries to', RESEARCH_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
