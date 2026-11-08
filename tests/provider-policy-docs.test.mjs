import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROVIDER_POLICIES } from '../build/provider-policy.js';
import { PROVIDER_REGISTRY } from '../build/provider-registry.js';

/**
 * The policy table is only factual if it stays tied to its evidence.
 *
 * `docs/caching/*.txt` holds the per-provider caching research (each file states
 * its "Last verified" date and source URLs). Nothing enforced the link, so the
 * table could drift from the docs — or a new provider could be registered with no
 * policy at all — and every other test would still pass because they all read the
 * table as the source of truth.
 *
 * These assertions keep the chain intact: registered provider → policy row → doc
 * file that the row cites.
 */

const ROOT = process.cwd();
const CACHING_DOCS = join(ROOT, 'docs', 'caching');

function docSlugs() {
  return readdirSync(CACHING_DOCS)
    .filter((name) => name.endsWith('.txt'))
    .map((name) => name.replace(/\.txt$/, ''));
}

test('every caching doc corresponds to a policy row', () => {
  const known = new Set(Object.keys(PROVIDER_POLICIES));
  const orphans = docSlugs().filter((slug) => !known.has(slug) && !known.has(slug.replace(/-presets$/, '')));
  assert.deepEqual(orphans, [],
    `a doc with no policy row is research nothing acts on: ${orphans.join(', ')}`);
});

test('every registered provider cites a doc it was transcribed from', () => {
  // The loopback providers are documented in code rather than in docs/caching
  // (they have no upstream), so they are the only rows allowed to cite a file
  // that does not exist under docs/caching/.
  const documentedInCode = new Set(['llama-cpp', 'llama-local', 'unsloth']);

  const failures = [];
  for (const entry of PROVIDER_REGISTRY) {
    const policy = PROVIDER_POLICIES[entry.name];
    if (!policy) {
      failures.push(`${entry.name}: no policy row`);
      continue;
    }
    const note = policy.caching.note;
    if (!note || note.trim().length < 10) {
      failures.push(`${entry.name}: caching row cites no evidence`);
      continue;
    }
    if (documentedInCode.has(entry.name)) continue;

    const referenced = (note.match(/docs\/caching\/([a-z0-9-]+)\.txt/g) || [])
      .map((match) => match.replace('docs/caching/', '').replace('.txt', ''));
    if (referenced.length === 0) {
      failures.push(`${entry.name}: caching row references no docs/caching file (${note.slice(0, 80)})`);
      continue;
    }
    for (const slug of referenced) {
      if (!docSlugs().includes(slug)) {
        failures.push(`${entry.name}: cites a missing doc docs/caching/${slug}.txt`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('every row in a caching doc is represented in the table', () => {
  const failures = [];
  for (const slug of docSlugs()) {
    const canonical = PROVIDER_POLICIES[slug] ? slug : slug.replace(/-presets$/, '');
    if (!PROVIDER_POLICIES[canonical]) {
      failures.push(`docs/caching/${slug}.txt has no matching policy row`);
    }
  }
  assert.deepEqual(failures, []);
});

test('each doc keeps its verification date so staleness is visible', () => {
  const failures = [];
  for (const slug of docSlugs()) {
    const text = readFileSync(join(CACHING_DOCS, `${slug}.txt`), 'utf8');
    if (!/Last verified:\s*\d{4}-\d{2}-\d{2}/.test(text)) {
      failures.push(`${slug}: no "Last verified" date`);
    }
  }
  assert.deepEqual(failures, []);
});

test('a reasoning row names where its dialect came from', () => {
  const failures = [];
  for (const [name, policy] of Object.entries(PROVIDER_POLICIES)) {
    const note = policy.reasoning.note;
    if (!note || note.trim().length < 10) {
      failures.push(`${name}: reasoning row cites no evidence`);
      continue;
    }
    // A reasoning claim must point at either a measured result, the repo's own
    // documented mapping, a code location, or an explicit inference marker.
    if (!/(docs\/caching|llms\.txt|measured|INFERENCE|src\/|2026-)/i.test(note)) {
      failures.push(`${name}: reasoning note cites nothing checkable (${note.slice(0, 80)})`);
    }
  }
  assert.deepEqual(failures, []);
});
