#!/usr/bin/env node
/**
 * generate-providers-doc.mts — Deterministic Provider & Model Reference Generator
 *
 * Generates the read-only `docs/providers.txt` catalog from the compiled
 * in-code source-of-truth modules (`build/provider-registry.js`,
 * `build/provider-model-registries.js`, `build/provider-policy.js`),
 * `src/model-specs.json`, and `docs/caching/*.txt`.
 *
 * Runtime never parses `docs/providers.txt`; it exists purely as a
 * human-readable, diff-friendly, sourced factual reference.
 *
 * Usage:
 *   npm run docs:providers
 *   node --import tsx scripts/generate-providers-doc.mts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_REGISTRY } from '../build/provider-registry.js';
import { PROVIDER_MODEL_REGISTRY } from '../build/provider-model-registries.js';
import { PROVIDER_POLICIES, providerPolicyFor } from '../build/provider-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPECS_PATH = path.join(ROOT, 'src', 'model-specs.json');
const CACHING_DIR = path.join(ROOT, 'docs', 'caching');
const OUT_PATH = path.join(ROOT, 'docs', 'providers.txt');

interface ModelSpec {
  context: number;
  output: number;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  source: string;
}

interface SpecsFile {
  version: number;
  updated: string;
  description: string;
  models: Record<string, ModelSpec>;
}

interface CachingCitation {
  slug: string;
  relPath: string;
  lastVerified: string;
  urls: string[];
}

interface ProviderRegistryRow {
  name: string;
  endpoint: string;
  keyEnvVar: string;
  note?: string;
}

interface CatalogModelRow {
  id: string;
  contextLength?: number;
  outputTokens?: number;
  supportsTools?: boolean;
  supportsImages?: boolean;
  tier?: string;
  note?: string;
}

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-or-[a-zA-Z0-9_-]{12,}/,
  /\bghp_[a-zA-Z0-9]{16,}/,
  /\boc_sk_[a-zA-Z0-9_-]{12,}/,
  /\bsk-[a-zA-Z0-9]{24,}/,
];

function formatNum(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('en-US')
    : '-';
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function renderTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const formatRow = (cols: string[]): string =>
    cols.map((col, i) => padRight(col ?? '', widths[i])).join(' | ').trimEnd();

  return [
    formatRow(headers),
    widths.map((w) => '-'.repeat(w)).join('-+-'),
    ...rows.map(formatRow),
  ];
}

function readCachingDoc(slug: string): CachingCitation | null {
  const relPath = `docs/caching/${slug}.txt`;
  const absPath = path.join(CACHING_DIR, `${slug}.txt`);
  if (!fs.existsSync(absPath)) return null;

  const content = fs.readFileSync(absPath, 'utf8');
  const verifiedMatch = content.match(/^Last verified:\s*(.+)$/im);
  const urlMatches = content.match(/https?:\/\/[^\s)>\]"']+/g) ?? [];
  const uniqueUrls = Array.from(new Set(urlMatches)).sort();

  return {
    slug,
    relPath,
    lastVerified: verifiedMatch ? verifiedMatch[1].trim() : 'unspecified',
    urls: uniqueUrls,
  };
}

function resolveCitations(providerName: string, cachingNote: string): CachingCitation[] {
  const slugs = new Set<string>();
  const matches = cachingNote.match(/docs\/caching\/([a-z0-9-]+)\.txt/g) ?? [];
  for (const m of matches) {
    slugs.add(m.replace('docs/caching/', '').replace('.txt', ''));
  }
  if (fs.existsSync(path.join(CACHING_DIR, `${providerName}.txt`))) {
    slugs.add(providerName);
  }
  const results: CachingCitation[] = [];
  for (const slug of Array.from(slugs).sort()) {
    const doc = readCachingDoc(slug);
    if (doc) results.push(doc);
  }
  return results;
}

function assertNoSecrets(text: string): void {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`Refusing to write docs/providers.txt: matched forbidden secret pattern ${pattern}`);
    }
  }
}

function buildDocument(): string {
  const specs = JSON.parse(fs.readFileSync(SPECS_PATH, 'utf8')) as SpecsFile;
  const registryRows = PROVIDER_REGISTRY as readonly ProviderRegistryRow[];
  const modelCatalog = PROVIDER_MODEL_REGISTRY as Record<string, readonly CatalogModelRow[]>;

  const registryMap = new Map<string, ProviderRegistryRow>(
    registryRows.map((row) => [row.name, row]),
  );

  // Preserve built-in PROVIDER_REGISTRY order, then append policy/catalog extras deterministically.
  const orderedNames: string[] = registryRows.map((r) => r.name);
  const extraNames = new Set<string>([
    ...Object.keys(PROVIDER_POLICIES),
    ...Object.keys(modelCatalog),
  ]);
  for (const extra of Array.from(extraNames).sort()) {
    if (!registryMap.has(extra)) {
      orderedNames.push(extra);
    }
  }

  const lines: string[] = [];

  lines.push('# local-router — Sourced Providers & Model Specifications');
  lines.push(`# Specs updated: ${specs.updated} | Built-in registry providers: ${registryRows.length} | Total documented providers: ${orderedNames.length}`);
  lines.push('# Generated by: npm run docs:providers (scripts/generate-providers-doc.mts)');
  lines.push('# Source of truth: src/provider-registry.ts, src/provider-model-registries.ts, src/provider-policy.ts, src/model-specs.json, docs/caching/*.txt');
  lines.push('# Read-only documentation artifact; runtime routing never parses this file and contains zero secrets.');
  lines.push('');

  lines.push('## Live Probe & Documentation Notes (2026-11-25)');
  lines.push('- Public/keyless `/models` HTTP 200 verified (2026-11-25): wafer-serverless (13), zenmux (220), nvidia-nim (30), openrouter (472), opencode-go (108), opencode-zen (108), ollama (3 local default check), cline (458), kilo (467), commandcode (105), fastino (14), nous-portal (409).');
  lines.push('- Auth-gated `/models` returning 400/401/403/404 when unkeyed on clean host: nebius, nebius-us-north1, moonshot, modal, modal-proxy, typesafe, xiaomi-mimo, zai, antigravity, github-copilot, cursor.');
  lines.push('- Z.ai GLM-5.4 verified (2026-11-25): docs.z.ai documents 1,000,000 (1M) context and 131,072 (128K) max output with text/image/video/file inputs and Loop Transformer thinking (`thinking.type` / `reasoning_effort` low/high/max); live `:11434` probe to `zai/glm-5.4` returned HTTP 200 with `reasoning_tokens` billed.');
  lines.push('');

  lines.push('## 1. Provider Summary Table');
  lines.push('');

  const summaryRows = orderedNames.map((name) => {
    const reg = registryMap.get(name);
    const policy = providerPolicyFor(name);
    const catalog = modelCatalog[name] ?? [];
    const citations = resolveCitations(name, policy.caching.note || '');
    const verified = citations.length > 0
      ? citations.map((c) => `${c.slug}:${c.lastVerified}`).join(', ')
      : 'in-code policy';
    return [
      name,
      reg ? reg.endpoint : '(preset / local policy)',
      reg ? reg.keyEnvVar : '-',
      String(catalog.length),
      policy.reasoning.dialect,
      policy.caching.mechanism,
      verified,
    ];
  });

  lines.push(
    ...renderTable(
      ['provider', 'endpoint', 'auth_env', 'models', 'reasoning_dialect', 'caching', 'doc_verified'],
      summaryRows,
    ),
  );
  lines.push('');

  lines.push('## 2. Authoritative Model Specs (`src/model-specs.json`)');
  lines.push('');

  const sortedSpecIds = Object.keys(specs.models).sort();
  const specRows = sortedSpecIds.map((id) => {
    const s = specs.models[id];
    const caps = [
      s.tools ? 'tools' : null,
      s.vision ? 'vision' : null,
      s.reasoning ? 'reasoning' : null,
    ].filter(Boolean).join(',');
    return [
      id,
      formatNum(s.context),
      formatNum(s.output),
      caps || '-',
      s.source,
    ];
  });

  lines.push(
    ...renderTable(
      ['model_id', 'context', 'max_output', 'capabilities', 'source'],
      specRows,
    ),
  );
  lines.push('');

  lines.push('## 3. Per-Provider Reference');
  lines.push('');

  for (const name of orderedNames) {
    const reg = registryMap.get(name);
    const policy = providerPolicyFor(name);
    const catalog = modelCatalog[name] ?? [];
    const citations = resolveCitations(name, policy.caching.note || '');

    lines.push(`### ${name}`);
    lines.push(`Endpoint: ${reg ? reg.endpoint : 'local / preset (no built-in remote row)'}`);
    lines.push(`Auth env: ${reg ? reg.keyEnvVar : 'none'}`);
    if (reg?.note) {
      lines.push(`Registry note: ${reg.note}`);
    }
    lines.push(
      `Reasoning: dialect=${policy.reasoning.dialect}, levels=[${policy.reasoning.levels.join(', ')}], default=${policy.reasoning.defaultLevel}, acceptsXhigh=${String(policy.reasoning.acceptsXhigh)}`,
    );
    if (policy.reasoning.note) {
      lines.push(`Reasoning note: ${policy.reasoning.note}`);
    }
    lines.push(
      `Caching: mechanism=${policy.caching.mechanism}, maxBreakpoints=${policy.caching.maxBreakpoints}, ttl=${policy.caching.ttl}, stickyKey=${String(policy.caching.stickyKey)}`,
    );
    if (policy.caching.note) {
      lines.push(`Caching note: ${policy.caching.note}`);
    }
    if (citations.length > 0) {
      for (const c of citations) {
        lines.push(`Caching citation: ${c.relPath} (Last verified: ${c.lastVerified})`);
        if (c.urls.length > 0) {
          lines.push(`Sources: ${c.urls.join(' | ')}`);
        }
      }
    }

    if (catalog.length === 0) {
      lines.push('Catalog models: none (uses dynamic `/models` discovery or preset aliasing)');
    } else {
      lines.push(`Catalog models (${catalog.length}):`);
      for (const m of catalog) {
        const flags = [
          m.supportsTools ? 'tools' : null,
          m.supportsImages ? 'vision' : null,
          m.tier ? `tier=${m.tier}` : null,
        ].filter(Boolean).join(', ');
        const detail = [
          `ctx=${formatNum(m.contextLength)}`,
          `out=${formatNum(m.outputTokens)}`,
          flags || null,
          m.note ? `note="${m.note}"` : null,
        ].filter(Boolean).join(' | ');
        lines.push(`  - ${m.id}: ${detail}`);
      }
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

const content = buildDocument();
assertNoSecrets(content);
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, content, 'utf8');
console.log(`Generated ${path.relative(ROOT, OUT_PATH)} (${Buffer.byteLength(content, 'utf8')} bytes)`);
