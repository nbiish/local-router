#!/usr/bin/env node
/**
 * Carry the fallback chain between machines over the router's loopback API.
 *
 *   node scripts/fallback-config.mjs export [--out chain.json]
 *   node scripts/fallback-config.mjs import <file> [--apply]
 *
 * Import is a no-write dry run unless --apply is given (mirrors the UI).
 * The API validates the bundle; this script never writes the chain file itself.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_FILE_BYTES = 1024 * 1024;
const rawUrl = process.env.LOCAL_ROUTER_URL || 'http://127.0.0.1:11434';
let baseUrl;
try {
  baseUrl = new URL(rawUrl);
} catch {
  console.error('LOCAL_ROUTER_URL is not a valid URL.');
  process.exit(2);
}
// Loopback only: this CLI must never be a bridge to a remote router.
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(baseUrl.hostname)) {
  console.error('LOCAL_ROUTER_URL must point at a loopback address.');
  process.exit(2);
}

const args = process.argv.slice(2);
const command = args[0];

function flag(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

async function api(resource, body) {
  const response = await fetch(`${baseUrl.origin}${resource}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success !== true) {
    throw new Error(data.error || `${resource} -> HTTP ${response.status}`);
  }
  return data;
}

function printDiff(diff) {
  if (!diff) return;
  for (const [label, key] of [
    ['Added steps', 'chainAdded'],
    ['Removed steps', 'chainRemoved'],
    ['Added routes', 'routesAdded'],
    ['Removed routes', 'routesRemoved']
  ]) {
    const values = diff[key];
    if (Array.isArray(values) && values.length) console.log(`${label}: ${values.join(', ')}`);
  }
  if (diff.orderChanged) console.log('Step order changed: yes');
}

async function run() {
  if (command === 'export') {
    const data = await api('/api/config/fallback/export');
    const out = flag('--out') || data.filename || 'local-router-fallback.json';
    fs.writeFileSync(out, data.config, { encoding: 'utf8', mode: 0o600 });
    console.log(`Wrote ${path.resolve(out)} (no credentials included).`);
    return;
  }

  if (command === 'import') {
    const file = args.find((arg) => !arg.startsWith('--') && arg !== 'import');
    if (!file) {
      console.error('Usage: fallback-config.mjs import <file> [--apply]');
      process.exit(2);
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      console.error('Config file is missing or larger than 1 MiB.');
      process.exit(2);
    }
    const config = fs.readFileSync(file, 'utf8');
    const apply = args.includes('--apply');
    const preview = await api('/api/config/fallback/import', { config, dryRun: true });
    console.log(apply ? 'Importing chain:' : 'Dry run — nothing written:');
    printDiff(preview.diff);
    if (!apply) {
      console.log('Re-run with --apply to write the chain.');
      return;
    }
    const result = await api('/api/config/fallback/import', { config, dryRun: false });
    printDiff(result.diff);
    console.log('Chain imported.');
    return;
  }

  console.error('Usage: fallback-config.mjs export [--out file] | import <file> [--apply]');
  process.exit(2);
}

run().catch((error) => {
  console.error(`fallback-config: ${error && error.message ? error.message : String(error)}`);
  process.exit(1);
});
