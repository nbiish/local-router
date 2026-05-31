#!/usr/bin/env tsx
/**
 * CIP Apply Findings — reads cip-findings.jsonl and applies high-confidence proposals.
 * Updates router model candidates with suggested coding scores and latency values.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
const FINDINGS_PATH = path.join(CONFIG_DIR, 'cip-findings.jsonl');
const ROUTER_MODELS_PATH = path.join(CONFIG_DIR, 'router-models.json');

interface Finding { ts: string; type: string; model: string; conf: string; rec: string; details: Record<string, number>; }

function loadFindings(): Finding[] {
  if (!fs.existsSync(FINDINGS_PATH)) return [];
  return fs.readFileSync(FINDINGS_PATH, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function loadRouterModels(): Record<string, any> {
  if (!fs.existsSync(ROUTER_MODELS_PATH)) return {};
  return JSON.parse(fs.readFileSync(ROUTER_MODELS_PATH, 'utf8'));
}

function saveRouterModels(models: Record<string, any>): void {
  fs.writeFileSync(ROUTER_MODELS_PATH, JSON.stringify(models, null, 2), { mode: 0o600 });
}

const findings = loadFindings().filter((f: Finding) => f.conf === 'high');
console.log(`[CIP-APPLY] ${findings.length} high-confidence findings to process.`);

if (!findings.length) process.exit(0);

const models = loadRouterModels();
let applied = 0;

for (const f of findings) {
  for (const [rid, router] of Object.entries(models)) {
    const candidates = (router as any).candidates || [];
    const idx = candidates.findIndex((c: any) => c.model === f.model);
    if (idx < 0) continue;

    if (f.type === 'model_deranked') {
      // Enable auto-tiers on the router
      (router as any).enableAutoTiers = true;
      applied++;
      console.log(`  ✓ ${rid}: enabled auto-tiers (deranked ${f.model})`);
    } else if (f.type === 'score_adjustment') {
      if (f.details.sr !== undefined) {
        candidates[idx].codingScore = Math.round(f.details.sr * 100) / 100;
        applied++;
        console.log(`  ✓ ${rid}/${f.model}: codingScore → ${candidates[idx].codingScore}`);
      }
    }
  }
}

if (applied > 0) {
  saveRouterModels(models);
  console.log(`[CIP-APPLY] Applied ${applied} changes. Restart the server to take effect.`);
} else {
  console.log('[CIP-APPLY] No applicable changes found.');
}
