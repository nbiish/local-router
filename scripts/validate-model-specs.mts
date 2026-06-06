#!/usr/bin/env node
/**
 * validate-model-specs.mts — CI/CD Model Metadata Validation
 *
 * Cross-references providers.txt model rows against the canonical
 * model-specs.json to detect metadata drift (context window, output
 * token limits, capability flags).
 *
 * Usage:  node --import tsx scripts/validate-model-specs.mts
 *         npm run validate:model-specs
 *
 * Exit 0 = all checks pass (warnings are OK).
 * Exit 1 = at least one ERROR-level mismatch found.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROVIDERS_PATH = path.join(ROOT, 'providers.txt');
const SPECS_PATH = path.join(ROOT, 'src', 'model-specs.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  models: Record<string, ModelSpec>;
}

interface ProviderRow {
  rowNum: string;
  provider: string;
  model: string;
  display: string;
  context: number;
  output: number;
  tools: boolean;
  images: boolean;
}

interface Issue {
  level: 'ERROR' | 'WARN' | 'INFO';
  model: string;
  provider: string;
  field: string;
  expected: string | number | boolean;
  actual: string | number | boolean;
  note: string;
}

// ---------------------------------------------------------------------------
// Parse providers.txt the same way readProviderModels() does
// ---------------------------------------------------------------------------

function parseProvidersFile(filePath: string): ProviderRow[] {
  const content = fs.readFileSync(filePath, 'utf8');
  const rows: ProviderRow[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.replace(/^#\s*/, '').trim();
    if (!trimmed.startsWith('│')) continue;

    const columns = trimmed
      .split('│')
      .map((c) => c.trim())
      .filter(Boolean);

    if (columns.length < 6) continue;

    const [rowNum, provider, model, display, contextStr, outputStr, toolsStr, imagesStr] = columns;
    if (!/^\d+$/.test(rowNum)) continue;
    if (!provider || !model) continue;

    const context = parseTokenValue(contextStr);
    const output = parseTokenValue(outputStr);
    const tools = /^yes/i.test(toolsStr || '');
    const images = /^yes/i.test(imagesStr || '');

    rows.push({ rowNum, provider, model, display, context, output, tools, images });
  }

  return rows;
}

function parseTokenValue(raw: string | undefined): number {
  if (!raw) return 0;
  const cleaned = raw.replace(/,/g, '').trim();
  const parsed = Number.parseInt(cleaned, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Normalize model names for matching against specs
// ---------------------------------------------------------------------------

function normalizeModelName(model: string): string {
  // Strip provider-namespace prefixes and common suffixes
  const base = model
    .toLowerCase()
    .replace(/^(deepseek-ai\/|deepseek\/|minimaxai\/|moonshotai\/|nvidia\/|zai-org\/|z-ai\/|xiaomi\/|stepfun-ai\/|stepfun\/|sapiens-ai\/|nousresearch\/|qwen\/|poolside\/)/, '')
    .replace(/:(cloud|free|latest)$/, '')
    .replace(/-fp8$/, '')
    .replace(/-highspeed$/, '')
    .replace(/-free$/, '')
    .replace(/-a\d+b(-reasoning)?$/, '') // e.g. -a3b-reasoning, -a55b
    .replace(/-\d+b$/, '') // e.g. -550b, -120b, -30b
    .replace(/^@preset\/.*$/, '') // presets are opaque — skip
    .replace(/^code-pass-/, '') // zai code-pass- prefix
    .replace(/^openrouter\/.*$/, ''); // openrouter/free is opaque

  return base;
}

// ---------------------------------------------------------------------------
// Match a provider row to a canonical spec
// ---------------------------------------------------------------------------

function findSpec(model: string, specs: Record<string, ModelSpec>): [string, ModelSpec] | null {
  const normalized = normalizeModelName(model);
  if (!normalized) return null;

  // Exact match first
  if (specs[normalized]) return [normalized, specs[normalized]];

  // Fuzzy match: try substring matching
  for (const [key, spec] of Object.entries(specs)) {
    if (normalized.includes(key) || key.includes(normalized)) {
      return [key, spec];
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validate(rows: ProviderRow[], specs: SpecsFile): Issue[] {
  const issues: Issue[] = [];
  const matched = new Set<string>();
  const unmatched: ProviderRow[] = [];

  for (const row of rows) {
    const match = findSpec(row.model, specs.models);
    if (!match) {
      unmatched.push(row);
      continue;
    }

    const [specName, spec] = match;
    matched.add(specName);

    // Context check
    if (row.context > 0 && spec.context > 0) {
      if (row.context > spec.context) {
        issues.push({
          level: 'ERROR',
          model: row.model,
          provider: row.provider,
          field: 'context',
          expected: spec.context,
          actual: row.context,
          note: `Provider row claims ${row.context.toLocaleString()} ctx but model spec says ${spec.context.toLocaleString()} — provider value exceeds model capability`
        });
      } else if (row.context < spec.context * 0.5) {
        issues.push({
          level: 'WARN',
          model: row.model,
          provider: row.provider,
          field: 'context',
          expected: spec.context,
          actual: row.context,
          note: `Provider row has ${row.context.toLocaleString()} ctx, significantly below model spec ${spec.context.toLocaleString()} — may be provider-specific limit`
        });
      }
    }

    // Output check
    if (row.output > 0 && spec.output > 0) {
      if (row.output > spec.output) {
        issues.push({
          level: 'ERROR',
          model: row.model,
          provider: row.provider,
          field: 'output',
          expected: spec.output,
          actual: row.output,
          note: `Provider row claims ${row.output.toLocaleString()} output but model spec says ${spec.output.toLocaleString()} — provider value exceeds model capability`
        });
      } else if (row.output < spec.output * 0.25) {
        issues.push({
          level: 'WARN',
          model: row.model,
          provider: row.provider,
          field: 'output',
          expected: spec.output,
          actual: row.output,
          note: `Provider row has ${row.output.toLocaleString()} output, significantly below model spec ${spec.output.toLocaleString()} — may be provider-specific limit`
        });
      }
    }
  }

  // Report unmatched rows (INFO only)
  for (const row of unmatched) {
    const normalized = normalizeModelName(row.model);
    if (normalized) {
      issues.push({
        level: 'INFO',
        model: row.model,
        provider: row.provider,
        field: 'match',
        expected: 'spec entry',
        actual: 'none',
        note: `No matching spec for model "${row.model}" (normalized: "${normalized}"). Add to model-specs.json for validation.`
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║       Model Metadata Validation — providers.txt         ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log();

  if (!fs.existsSync(PROVIDERS_PATH)) {
    console.error(`ERROR: providers.txt not found at ${PROVIDERS_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(SPECS_PATH)) {
    console.error(`ERROR: model-specs.json not found at ${SPECS_PATH}`);
    process.exit(1);
  }

  const specs: SpecsFile = JSON.parse(fs.readFileSync(SPECS_PATH, 'utf8'));
  const rows = parseProvidersFile(PROVIDERS_PATH);

  console.log(`Parsed ${rows.length} model rows from providers.txt`);
  console.log(`Loaded ${Object.keys(specs.models).length} canonical specs from model-specs.json (updated: ${specs.updated})`);
  console.log();

  const issues = validate(rows, specs);

  const errors = issues.filter((i) => i.level === 'ERROR');
  const warnings = issues.filter((i) => i.level === 'WARN');
  const infos = issues.filter((i) => i.level === 'INFO');

  if (errors.length > 0) {
    console.log(`\x1b[31m❌ ERRORS (${errors.length}):\x1b[0m`);
    for (const issue of errors) {
      console.log(`  ${issue.provider}/${issue.model}  [${issue.field}]`);
      console.log(`    ${issue.note}`);
    }
    console.log();
  }

  if (warnings.length > 0) {
    console.log(`\x1b[33m⚠️  WARNINGS (${warnings.length}):\x1b[0m`);
    for (const issue of warnings) {
      console.log(`  ${issue.provider}/${issue.model}  [${issue.field}]`);
      console.log(`    ${issue.note}`);
    }
    console.log();
  }

  if (infos.length > 0) {
    console.log(`\x1b[36mℹ️  UNMATCHED (${infos.length}):\x1b[0m`);
    for (const issue of infos) {
      console.log(`  ${issue.provider}/${issue.model}`);
    }
    console.log();
  }

  const matchedCount = rows.length - infos.length;
  console.log(`Summary: ${matchedCount}/${rows.length} rows matched, ${errors.length} errors, ${warnings.length} warnings, ${infos.length} unmatched`);

  if (errors.length > 0) {
    console.log('\x1b[31m\nFAILED — fix the errors above before committing.\x1b[0m');
    process.exit(1);
  }

  console.log('\x1b[32m\n✅ PASSED — all matched model specs are consistent.\x1b[0m');
}

main();
