#!/usr/bin/env tsx
/**
 * CIP Daily Research Pipeline — GATHER → ANALYZE → PROPOSE → RECORD
 * Reads router telemetry, analyzes candidate performance, records findings.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
const EVENTS_PATH = path.join(CONFIG_DIR, 'router-events.csv');
const FINDINGS_PATH = path.join(CONFIG_DIR, 'cip-findings.jsonl');
const LEGACY_EVENTS = path.join(os.homedir(), '.config', 'fvs-code', 'router-events.csv');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function parseCSV(line: string): string[] {
  const fields: string[] = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (i+1 < line.length && line[i+1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else { if (c === '"') q = true; else if (c === ',') { fields.push(cur); cur = ''; } else cur += c; }
  }
  fields.push(cur); return fields;
}

function med(arr: number[]): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a,b) => a-b);
  const m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

interface CStats { model: string; attempts: number; successes: number; lats: number[]; toolAtt: number; toolOk: number; lastSeen: string; }

function readEvents(): Map<string, CStats> {
  const stats = new Map<string, CStats>();
  const ep = fs.existsSync(EVENTS_PATH) ? EVENTS_PATH : fs.existsSync(LEGACY_EVENTS) ? LEGACY_EVENTS : null;
  if (!ep) { console.log('[GATHER] No events file.'); return stats; }
  const txt = fs.readFileSync(ep, 'utf8');
  const lines = txt.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return stats;
  const h = lines[0].split(',').map(s => s.trim());
  const si = h.indexOf('selected_model'), sti = h.indexOf('status'), li = h.indexOf('candidate_latency_ms');
  const ti = h.indexOf('tool_calls_requested'), tvi = h.indexOf('tool_calls_valid'), tsi = h.indexOf('timestamp');
  for (let i = 1; i < lines.length; i++) {
    const f = parseCSV(lines[i]);
    const m = si >= 0 ? f[si]?.trim() : ''; if (!m) continue;
    let e = stats.get(m);
    if (!e) { e = { model: m, attempts: 0, successes: 0, lats: [], toolAtt: 0, toolOk: 0, lastSeen: '' }; stats.set(m, e); }
    e.attempts++; const s = sti >= 0 ? Number(f[sti]) : 0; if (s >= 200 && s < 300) e.successes++;
    const l = li >= 0 ? Number(f[li]) : 0; if (l > 0) e.lats.push(l);
    if (ti >= 0) { const tc = Number(f[ti]); if (tc > 0) { e.toolAtt++; if (Number(f[tvi]) > 0) e.toolOk++; } }
    if (tsi >= 0) e.lastSeen = f[tsi]?.trim() || '';
  }
  return stats;
}

const stats = readEvents();
console.log(`[GATHER] ${stats.size} candidates.`);
if (stats.size === 0) process.exit(0);

const allSR: number[] = [], allLat: number[] = [];
for (const [, s] of stats) { if (s.attempts >= 10) { allSR.push(s.successes / s.attempts); const ml = med(s.lats); if (ml > 0) allLat.push(ml); } }
const medSR = med(allSR), medLat = med(allLat);

const findings: Array<Record<string, unknown>> = [];
for (const [model, s] of stats) {
  if (s.attempts < 10) {
    findings.push({ ts: new Date().toISOString(), phase: 'ANALYZE', type: 'insufficient_data', model, conf: 'medium', details: { attempts: s.attempts }, rec: `Need ${10 - s.attempts} more samples.` });
    continue;
  }
  const sr = s.successes / s.attempts, ml = med(s.lats);
  if (sr < medSR - 0.1) findings.push({ ts: new Date().toISOString(), phase: 'PROPOSE', type: 'model_deranked', model, conf: 'high', details: { sr, medSR, attempts: s.attempts }, rec: `Derank ${model}: SR ${(sr*100).toFixed(1)}% < ${(medSR*100).toFixed(1)}% median.` });
  if (ml > medLat * 1.5 && medLat > 0) findings.push({ ts: new Date().toISOString(), phase: 'PROPOSE', type: 'latency_warning', model, conf: 'medium', details: { ml, medLat }, rec: `Latency ${ml}ms > ${(medLat*1.5).toFixed(0)}ms threshold.` });
}

ensureDir(CONFIG_DIR);
findings.forEach(f => fs.appendFileSync(FINDINGS_PATH, JSON.stringify(f) + '\n', { mode: 0o600 }));
console.log(`[RECORD] ${findings.length} findings → ${FINDINGS_PATH}`);
