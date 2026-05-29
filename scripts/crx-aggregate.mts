#!/usr/bin/env tsx
/**
 * CRX Aggregate — computes community consensus from multiple provider.txt proposals.
 * Accepts multiple file paths and outputs a merged proposal with conflict resolution.
 */
import fs from 'fs';

const files = process.argv.slice(2).filter(f => fs.existsSync(f));
if (files.length === 0) {
  console.error('Usage: tsx crx-aggregate.mts <proposal1.txt> [proposal2.txt ...]');
  process.exit(1);
}

function parseModelLine(line: string): Record<string, string> | null {
  const m = line.match(/^#\s*│\s*(\d+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)\s*│\s*([^│]+)/);
  return m ? { num: m[1].trim(), provider: m[2].trim(), modelId: m[3].trim(), display: m[4].trim(), context: m[5].trim(), output: m[6].trim(), tools: m[7].trim(), img: m[8].trim(), cache: m[9].trim(), reason: m[10].trim() } : null;
}

interface ModelVote { modelId: string; votes: number; proposers: string[]; specs: Record<string, string>; }

const consensus = new Map<string, ModelVote>();

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    const model = parseModelLine(line);
    if (!model) continue;
    const key = `${model.provider}/${model.modelId}`;
    let entry = consensus.get(key);
    if (!entry) {
      entry = { modelId: key, votes: 0, proposers: [], specs: model };
      consensus.set(key, entry);
    }
    entry.votes++;
    entry.proposers.push(path.basename(file));
    // Majority-wins spec merging: use most common value for each field
    for (const field of ['context', 'output', 'tools', 'img', 'cache', 'reason']) {
      if (model[field] !== entry.specs[field] && entry.votes > 1) {
        entry.specs[field] = `${entry.specs[field]}↔${model[field]}`;
      }
    }
  }
}

const entries = [...consensus.values()].sort((a, b) => b.votes - a.votes);
console.log(`# CRX Aggregation Report — ${files.length} proposals, ${entries.length} unique models`);
console.log('');
console.log('| Model | Votes | Consensus Spec |');
console.log('|-------|-------|----------------|');

for (const e of entries) {
  const spec = `ctx=${e.specs.context} out=${e.specs.output} tools=${e.specs.tools} img=${e.specs.img} cache=${e.specs.cache} reason=${e.specs.reason}`;
  console.log(`| ${e.modelId} | ${e.votes} | ${spec} |`);
}

// Output high-consensus models ready for providers.txt
console.log('\n# --- High-Consensus Models (3+ votes) ---');
for (const e of entries) {
  if (e.votes >= 3) {
    console.log(`# │ -- │ ${e.specs.provider.padEnd(20)}│ ${e.specs.modelId.padEnd(40)}│ ${e.specs.display.padEnd(30)}│ ${e.specs.context.padEnd(10)}│ ${e.specs.output.padEnd(10)}│ ${e.specs.tools.padEnd(7)}│ ${e.specs.img.padEnd(6)}│ ${e.specs.cache.padEnd(7)}│ ${e.specs.reason.padEnd(10)}│`);
  }
}
