#!/usr/bin/env tsx
/**
 * CRX Validate — validates community contributions to providers.txt.
 * Checks format, required fields, provider existence, and spec consistency.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const PROVIDERS_PATH = path.join(os.homedir(), '.config', 'providers.txt');
const PROJECT_PROVIDERS = path.resolve(process.argv[2] || '');

if (!PROJECT_PROVIDERS || !fs.existsSync(PROJECT_PROVIDERS)) {
  console.error('Usage: tsx crx-validate.mts <path-to-proposed-providers.txt>');
  process.exit(1);
}

function parseModelLine(line: string): Record<string, string> | null {
  const match = line.match(/^#\s*│\s*(\d+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)/);
  if (!match) return null;
  return {
    num: match[1].trim(), provider: match[2].trim(), modelId: match[3].trim(),
    display: match[4].trim(), context: match[5].trim(), output: match[6].trim(),
    tools: match[7].trim(), img: match[8].trim(), cache: match[9].trim(), reason: match[10].trim()
  };
}

const knownProviders = new Set<string>();
const baseLines = fs.readFileSync(PROVIDERS_PATH, 'utf8').split('\n');
for (const line of baseLines) {
  const m = line.match(/^#\s*│\s*\w+\s*│\s*([a-z0-9-]+)\s*│/);
  if (m) knownProviders.add(m[1].trim());
}
// Also parse provider summary table
for (const line of baseLines) {
  const m = line.match(/^#\s*│\s*([a-z0-9-]+)\s*│/);
  if (m && !m[1].startsWith('─') && !m[1].startsWith('#')) knownProviders.add(m[1].trim());
}

const proposed = fs.readFileSync(PROJECT_PROVIDERS, 'utf8').split('\n');
const errors: string[] = [];
let validModels = 0;

for (const line of proposed) {
  const model = parseModelLine(line);
  if (!model) continue;

  if (!knownProviders.has(model.provider)) {
    errors.push(`Row ${model.num}: unknown provider "${model.provider}"`);
  }
  if (!/^[A-Za-z0-9@._:\/+-]+$/.test(model.modelId)) {
    errors.push(`Row ${model.num}: invalid model ID "${model.modelId}"`);
  }
  if (model.tools !== 'YES' && model.tools !== 'NO') {
    errors.push(`Row ${model.num}: tools must be YES or NO, got "${model.tools}"`);
  }
  if (model.reason !== 'YES' && model.reason !== 'NO' && model.reason !== 'NO*') {
    errors.push(`Row ${model.num}: reasoning must be YES/NO/NO*, got "${model.reason}"`);
  }
  validModels++;
}

if (errors.length) {
  console.error(`[CRX-VALIDATE] ${errors.length} errors in ${validModels} models:`);
  errors.forEach(e => console.error(`  ✗ ${e}`));
  process.exit(1);
}

console.log(`[CRX-VALIDATE] ✓ ${validModels} models validated successfully.`);
