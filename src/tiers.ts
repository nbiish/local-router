import fs from 'fs';
import path from 'path';

export type CandidateTier = 'verified' | 'insufficient' | 'deranked';

export type CandidateStats = {
  model: string;
  successRate: number;
  medianLatencyMs: number;
  sampleCount: number;
  tier: CandidateTier;
  derankReasons?: string[];
  lastObserved: string;
};

const TIER_MIN_SAMPLES = 50;
const SUCCESS_RATE_THRESHOLD = 0.85;
const MAD_OUTLIER_THRESHOLD = 3.0;

function parseEventsCsv(filePath: string): Map<string, { successes: number; failures: number; latencies: number[]; lastObserved: string }> {
  const stats = new Map<string, { successes: number; failures: number; latencies: number[]; lastObserved: string }>();

  if (!fs.existsSync(filePath)) return stats;

  const csvText = fs.readFileSync(filePath, 'utf8');
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return stats;

  const headers = lines[0].split(',').map((h) => h.trim());
  const selectedIdx = headers.indexOf('selected_model');
  const statusIdx = headers.indexOf('status');
  const latencyIdx = headers.indexOf('candidate_latency_ms');
  const timestampIdx = headers.indexOf('timestamp');

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const model = selectedIdx >= 0 ? fields[selectedIdx]?.trim() : '';
    if (!model) continue;

    let entry = stats.get(model);
    if (!entry) {
      entry = { successes: 0, failures: 0, latencies: [], lastObserved: '' };
      stats.set(model, entry);
    }

    const status = statusIdx >= 0 ? Number(fields[statusIdx]) : 0;
    if (status >= 200 && status < 300) entry.successes++;
    else if (status > 0) entry.failures++;

    const latency = latencyIdx >= 0 ? Number(fields[latencyIdx]) : 0;
    if (latency > 0) entry.latencies.push(latency);

    if (timestampIdx >= 0 && fields[timestampIdx]) {
      entry.lastObserved = fields[timestampIdx].trim();
    }
  }

  return stats;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function mad(values: number[], med: number): number {
  if (values.length === 0) return 0;
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

export function computeTiers(
  candidateModels: string[],
  eventsPath: string
): CandidateStats[] {
  const rawStats = parseEventsCsv(eventsPath);
  const results: CandidateStats[] = [];

  if (rawStats.size === 0) {
    return candidateModels.map((model) => ({
      model,
      successRate: 0,
      medianLatencyMs: 0,
      sampleCount: 0,
      tier: 'insufficient' as CandidateTier,
      lastObserved: ''
    }));
  }

  // Collect global success rates and latencies for outlier detection
  const allSuccessRates: number[] = [];
  const allMedianLatencies: number[] = [];
  const sufficientEntries: { model: string; successRate: number; medianLatencyMs: number; sampleCount: number; lastObserved: string }[] = [];

  for (const [model, data] of rawStats) {
    const total = data.successes + data.failures;
    const sr = total > 0 ? data.successes / total : 0;
    const mlat = median(data.latencies);
    allSuccessRates.push(sr);
    allMedianLatencies.push(mlat);
    if (total >= TIER_MIN_SAMPLES) {
      sufficientEntries.push({
        model,
        successRate: sr,
        medianLatencyMs: mlat,
        sampleCount: total,
        lastObserved: data.lastObserved
      });
    }
  }

  const medianSR = median(allSuccessRates);
  const madSR = mad(allSuccessRates, medianSR);
  const medianLat = median(allMedianLatencies);
  const madLat = mad(allMedianLatencies, medianLat);

  const sufficientSet = new Set(sufficientEntries.map((e) => e.model));

  for (const candidateModel of candidateModels) {
    const raw = rawStats.get(candidateModel);
    const total = raw ? raw.successes + raw.failures : 0;
    const sr = total > 0 ? raw!.successes / total : 0;
    const mlat = raw ? median(raw.latencies) : 0;

    if (total < TIER_MIN_SAMPLES) {
      results.push({
        model: candidateModel,
        successRate: sr,
        medianLatencyMs: mlat,
        sampleCount: total,
        tier: 'insufficient',
        lastObserved: raw?.lastObserved || ''
      });
      continue;
    }

    const reasons: string[] = [];
    if (madSR > 0 && sr < medianSR - MAD_OUTLIER_THRESHOLD * madSR) {
      reasons.push(`success_rate_outlier: ${sr.toFixed(3)} < median ${medianSR.toFixed(3)}`);
    }
    if (madLat > 0 && mlat > medianLat + MAD_OUTLIER_THRESHOLD * madLat) {
      reasons.push(`latency_outlier: ${mlat}ms > median ${medianLat}ms`);
    }
    if (sr < SUCCESS_RATE_THRESHOLD) {
      reasons.push(`success_rate_below_threshold: ${sr.toFixed(3)} < ${SUCCESS_RATE_THRESHOLD}`);
    }

    if (reasons.length > 0) {
      results.push({
        model: candidateModel,
        successRate: sr,
        medianLatencyMs: mlat,
        sampleCount: total,
        tier: 'deranked',
        derankReasons: reasons,
        lastObserved: raw?.lastObserved || ''
      });
    } else {
      results.push({
        model: candidateModel,
        successRate: sr,
        medianLatencyMs: mlat,
        sampleCount: total,
        tier: 'verified',
        lastObserved: raw?.lastObserved || ''
      });
    }
  }

  return results;
}
