/**
 * trajectories.ts — per-request trajectory capture and fallback-chain health
 * analysis.
 *
 * Modeled on how the DeepSeek harness records its trajectories (~/.deepseek):
 * one inspectable record per request carrying the FULL ordered stage timeline
 * (every attempt, skip, and reason), metadata rollups (tokens, cost, duration),
 * and receipts with content-addressed spill so a huge payload never bloats the
 * log while staying retrievable by its `sha:` handle.
 *
 * The store is a plain append-only JSONL file agents can grep directly:
 *   ~/.config/local-router/trajectories/trajectories.jsonl
 *   ~/.config/local-router/trajectories/spill/<sha256>.txt
 *
 * What this exists to answer (operator ask, 2026-11-12): "which provider/model
 * in the fallback chain is no longer working right, or is being skipped, and
 * why" — after the fact, from the log, without a live repro.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export const TRAJECTORY_SCHEMA_VERSION = 2;

/**
 * Schema history:
 *   v1 — stage timeline, chain snapshot, winner, usage, cost, receipts.
 *   v2 — additive: `shedding` (explicit chain-alias shed marker) and a resolved
 *        `client` attribution. v1 records stay readable — every v2 field is
 *        optional, so a reader written for v1 keeps working unchanged.
 */

/**
 * Chain-alias shedding, made explicit.
 *
 * `local-router/fallback-models` is an alias that sheds to one concrete chain
 * member per request. Before v2 that was only inferable by comparing
 * `presentedModel` against `result.answeredBy` — an agent reading a record where
 * the alias answered as `xiaomi-mimo/mimo-v2.6-pro` had to know the alias
 * convention to avoid reading a shed as an outage or a misconfiguration. This
 * records the shed as its own fact.
 */
export interface TrajectoryShedding {
  /** The alias the client requested, e.g. `local-router/fallback-models`. */
  from: string;
  /** The concrete `provider/model` that actually served the request. */
  to: string;
  /** How many stage attempts were spent before the winner answered (0 = first). */
  attemptsBeforeAnswer: number;
  /** Configured members that were not even planned, keyed by count. */
  excludedCount: number;
}

/** Client attribution, with the provenance of how the name was derived. */
export type TrajectoryClientSource = 'header' | 'user-agent' | 'unknown';

export type TrajectoryStageOutcome = 'answered' | 'failed' | 'skipped';

export interface TrajectoryStage {
  /** Execution-plan stage label (`pass-N-step-M`), or `direct` for a direct call. */
  stage: string;
  targetModel: string;
  provider: string | null;
  actualModel: string | null;
  attempt: number;
  stageAttempts: number;
  outcome: TrajectoryStageOutcome;
  /** For skipped stages: why (preflight errorType or capability-filter reason). */
  skipReason?: string;
  /** Attempt made during the last-pass force-try despite an active cooldown (plan §4.2). */
  forced?: boolean;
  errorType?: string;
  status?: number | null;
  errorMessage?: string;
  providerErrorPreview?: string;
  waitBeforeRetrySeconds?: number;
  ms?: number;
}

export interface TrajectoryExcludedTarget {
  model: string;
  /** 'disabled_toggle' | 'no_configured_key' | capability-filter reason. */
  reason: string;
}

export interface TrajectoryChain {
  routeId: string;
  /** Every configured step, in chain order — the operator's intent. */
  configuredTargets: string[];
  /** Configured steps that could not even be planned, with the reason. */
  excludedTargets: TrajectoryExcludedTarget[];
  eligibleTargets: string[];
  requiredContext: number;
  requiresMultimodal: boolean;
  planStageCount: number;
}

export interface TrajectoryReceipt {
  sha: string;
  bytes: number;
  chars: number;
  /** Short inline copy so the UI can show something without a second fetch. */
  preview: string;
}

export interface TrajectoryRecord {
  schema_version: number;
  id: string;
  timestamp: string;
  durationMs: number;
  client: string;
  /** v2: how `client` was derived — never silently 'unknown' without saying so. */
  clientSource?: TrajectoryClientSource;
  /** Raw User-Agent, kept so a future resolver can improve attribution retroactively. */
  userAgent?: string;
  presentedModel: string;
  routeKind: 'direct' | 'fallback' | 'direct+cascade';
  routeId: string | null;
  request: {
    stream: boolean;
    modalities: string[];
    toolCallsRequested: number;
    messageCount: number;
    promptHash: string;
  };
  chain: TrajectoryChain | null;
  stages: TrajectoryStage[];
  /**
   * v2: present exactly when a chain alias shed to a concrete member. Absent
   * for a direct model call and for a chain that failed outright.
   */
  shedding?: TrajectoryShedding;
  result: {
    status: number;
    answeredBy: { provider: string; model: string } | null;
    errorType: string | null;
    errorMessage: string | null;
    usage: {
      promptTokens: number;
      completionTokens: number;
      cachedTokens: number;
      cacheWriteTokens: number;
    };
    cost: {
      total: number;
      prompt: number;
      completion: number;
      cached: number;
    };
  };
  receipts: {
    request?: TrajectoryReceipt;
    response?: TrajectoryReceipt;
    thinking?: TrajectoryReceipt;
    toolCalls?: TrajectoryReceipt;
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MAX_RECORDS = 2000;
const COMPACT_ABOVE = 2200;
const PREVIEW_CHARS = 400;
const SPILL_THRESHOLD_CHARS = 4096;

function trajectoryLogEnabled(): boolean {
  return process.env.LOCAL_ROUTER_TRAJECTORY_LOG !== '0';
}

export function trajectoryDir(): string {
  return process.env.LOCAL_ROUTER_TRAJECTORY_DIR
    || path.join(os.homedir(), '.config', 'local-router', 'trajectories');
}

function jsonlPath(): string {
  return path.join(trajectoryDir(), 'trajectories.jsonl');
}

function spillDir(): string {
  return path.join(trajectoryDir(), 'spill');
}

function ensureTrajectoryDir(): void {
  fs.mkdirSync(spillDir(), { recursive: true, mode: 0o700 });
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function previewOf(text: string): string {
  return text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;
}

/**
 * Content-addressed spill (DeepSeek receipt pattern): the record keeps size +
 * `sha:` handle + a short preview; the full text lives in spill/<sha>.txt and
 * is retrievable read-only via `readTrajectoryPart`.
 */
export function storeReceipt(text: string | undefined | null): TrajectoryReceipt | undefined {
  if (text == null) return undefined;
  const value = String(text);
  const sha = sha256Hex(value);
  const receipt: TrajectoryReceipt = {
    sha: `sha:${sha}`,
    bytes: Buffer.byteLength(value, 'utf8'),
    chars: value.length,
    preview: previewOf(value)
  };
  if (value.length > SPILL_THRESHOLD_CHARS) {
    ensureTrajectoryDir();
    const spillPath = path.join(spillDir(), `${sha}.txt`);
    if (!fs.existsSync(spillPath)) {
      fs.writeFileSync(spillPath, value, { encoding: 'utf8', mode: 0o600 });
    }
  }
  return receipt;
}

export function readReceiptPayload(receipt: TrajectoryReceipt | undefined): string | null {
  if (!receipt) return null;
  const sha = receipt.sha.replace(/^sha:/, '');
  if (!/^[0-9a-f]{64}$/.test(sha)) return null;
  const spillPath = path.join(spillDir(), `${sha}.txt`);
  try {
    if (fs.existsSync(spillPath)) {
      return fs.readFileSync(spillPath, 'utf8');
    }
  } catch {
    return null;
  }
  // Not spilled: the preview is the whole payload only when it fits.
  return receipt.chars <= PREVIEW_CHARS ? receipt.preview : null;
}

function parseJsonlLines(text: string): TrajectoryRecord[] {
  const records: TrajectoryRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
        records.push(parsed as TrajectoryRecord);
      }
    } catch {
      // A torn write must never poison the whole log.
    }
  }
  return records;
}

export function loadTrajectories(): TrajectoryRecord[] {
  try {
    const file = jsonlPath();
    if (!fs.existsSync(file)) return [];
    return parseJsonlLines(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    console.error('[trajectories] failed to read log:', error);
    return [];
  }
}

/** Raw JSONL log — what an agent grepping the on-disk file sees. */
export function readTrajectoryLogRaw(): string {
  try {
    const file = jsonlPath();
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

let countedDir = '';
let recordCount = -1;

/** Lazy line count so appends stay O(1) until the compaction threshold. */
function ensureRecordCount(): void {
  const dir = trajectoryDir();
  if (recordCount >= 0 && countedDir === dir) return;
  countedDir = dir;
  try {
    const file = jsonlPath();
    recordCount = fs.existsSync(file)
      ? fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).length
      : 0;
  } catch {
    recordCount = 0;
  }
}

function compactLog(records: TrajectoryRecord[]): void {
  const keep = records.slice(-MAX_RECORDS);
  const tmpPath = `${jsonlPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, jsonlPath());
  recordCount = keep.length;

  // Drop spill files the retained records no longer reference. Bounded to the
  // module's own spill directory.
  const referenced = new Set<string>();
  for (const record of keep) {
    for (const receipt of Object.values(record.receipts || {})) {
      if (receipt && typeof receipt.sha === 'string') {
        referenced.add(receipt.sha.replace(/^sha:/, ''));
      }
    }
  }
  const dir = spillDir();
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f]{64}\.txt$/.test(name)) continue;
      if (!referenced.has(name.slice(0, -4))) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          // Best-effort pruning; an orphan spill file is not a failure.
        }
      }
    }
  }
}

export function appendTrajectory(record: TrajectoryRecord): void {
  if (!trajectoryLogEnabled()) return;
  try {
    ensureTrajectoryDir();
    fs.appendFileSync(jsonlPath(), JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    ensureRecordCount();
    recordCount += 1;
    if (recordCount > COMPACT_ABOVE) {
      compactLog(loadTrajectories());
    }
  } catch (error) {
    console.error('[trajectories] failed to append:', error);
  }
}

export function clearTrajectories(): void {
  try {
    const file = jsonlPath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    recordCount = 0;
    const dir = spillDir();
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (/^[0-9a-f]{64}\.txt$/.test(name)) {
          try {
            fs.unlinkSync(path.join(dir, name));
          } catch {
            // Best-effort.
          }
        }
      }
    }
  } catch (error) {
    console.error('[trajectories] failed to clear:', error);
    throw error;
  }
}

export function getTrajectory(id: string): TrajectoryRecord | undefined {
  return loadTrajectories().find((record) => record.id === id);
}

export interface TrajectoryListOptions {
  limit?: number;
  route?: string;
  outcome?: 'success' | 'failure';
  since?: string;
}

export interface TrajectorySummary {
  id: string;
  timestamp: string;
  durationMs: number;
  client: string;
  /** v2: how the client name was derived; absent on v1 records. */
  clientSource?: TrajectoryClientSource;
  presentedModel: string;
  /** v2: the concrete `provider/model` a chain alias shed to, if it shed. */
  shedTo?: string;
  routeKind: TrajectoryRecord['routeKind'];
  routeId: string | null;
  status: number;
  answeredBy: TrajectoryRecord['result']['answeredBy'];
  errorType: string | null;
  stageCount: number;
  failedStages: number;
  skippedStages: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costTotal: number;
}

export function summarizeTrajectory(record: TrajectoryRecord): TrajectorySummary {
  let failedStages = 0;
  let skippedStages = 0;
  for (const stage of record.stages || []) {
    if (stage.outcome === 'failed') failedStages += 1;
    if (stage.outcome === 'skipped') skippedStages += 1;
  }
  return {
    id: record.id,
    timestamp: record.timestamp,
    durationMs: record.durationMs,
    client: record.client,
    ...(record.clientSource ? { clientSource: record.clientSource } : {}),
    presentedModel: record.presentedModel,
    ...(record.shedding ? { shedTo: record.shedding.to } : {}),
    routeKind: record.routeKind,
    routeId: record.routeId,
    status: record.result?.status ?? 0,
    answeredBy: record.result?.answeredBy ?? null,
    errorType: record.result?.errorType ?? null,
    stageCount: (record.stages || []).length,
    failedStages,
    skippedStages,
    promptTokens: record.result?.usage?.promptTokens ?? 0,
    completionTokens: record.result?.usage?.completionTokens ?? 0,
    cachedTokens: record.result?.usage?.cachedTokens ?? 0,
    costTotal: record.result?.cost?.total ?? 0
  };
}

export function listTrajectorySummaries(options: TrajectoryListOptions = {}): TrajectorySummary[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  let records = loadTrajectories();
  if (options.route) {
    records = records.filter((r) => (r.routeId || '(direct)') === options.route);
  }
  if (options.outcome) {
    records = records.filter((r) => {
      const ok = r.result?.status >= 200 && r.result.status < 300;
      return options.outcome === 'success' ? ok : !ok;
    });
  }
  if (options.since) {
    const sinceMs = Date.parse(options.since);
    if (Number.isFinite(sinceMs)) {
      records = records.filter((r) => Date.parse(r.timestamp) >= sinceMs);
    }
  }
  records = records.slice(-limit).reverse();
  return records.map(summarizeTrajectory);
}

// ---------------------------------------------------------------------------
// Health analysis — "is a chain member dead or silently skipped?"
// ---------------------------------------------------------------------------

/**
 * The four stable error classes an operator or agent triages against
 * (2026-11-12): a rejected key, an empty balance, a usage limit, or a usage
 * error are four different fixes — key refresh, top-up, backoff, request
 * change — and the raw errorType strings cannot carry that alone.
 */
export type ErrorClass = 'key_rejected' | 'out_of_funds' | 'usage_limit' | 'usage_error' | 'other';

export function errorClassFor(errorType: string | null | undefined): ErrorClass {
  switch (errorType) {
    case 'upstream_http_auth':
      return 'key_rejected';
    case 'upstream_http_payment_required':
      return 'out_of_funds';
    case 'upstream_http_quota':
    case 'upstream_http_rate_limit':
      return 'usage_limit';
    case 'upstream_http_invalid_request':
      return 'usage_error';
    default:
      return 'other';
  }
}

export interface ModelHealth {
  model: string;
  planned: number;
  answered: number;
  failed: number;
  skipped: number;
  skipReasons: Record<string, number>;
  errorTypes: Record<string, number>;
  /** Nonzero stable error-class counts over the window (§4.3). */
  errorClasses: Record<string, number>;
  answerRate: number;
  lastError: string | null;
  lastSeen: string | null;
  flags: string[];
}

export interface RouteHealth {
  routeId: string;
  trajectories: number;
  successes: number;
  successRate: number;
  winnerCounts: Record<string, number>;
  models: ModelHealth[];
}

export interface TrajectoryHealthReport {
  generatedAt: string;
  windowRecords: number;
  routes: RouteHealth[];
}

const MIN_OBSERVATIONS = 3;

function dominantReason(counts: Record<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [reason, count] of Object.entries(counts)) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

export function analyzeTrajectories(records?: TrajectoryRecord[]): TrajectoryHealthReport {
  const window = (records ?? loadTrajectories()).slice(-200);

  // Group per route; routeId null (direct calls) shares the '(direct)' bucket.
  const byRoute = new Map<string, TrajectoryRecord[]>();
  for (const record of window) {
    const key = record.routeId || '(direct)';
    const bucket = byRoute.get(key);
    if (bucket) bucket.push(record);
    else byRoute.set(key, [record]);
  }

  const routes: RouteHealth[] = [];
  for (const [routeId, group] of byRoute.entries()) {
    const winnerCounts: Record<string, number> = {};
    let successes = 0;

    // Per model: ordered observation list for the recent/prior comparison.
    interface Observation { at: number; outcome: 'answered' | 'failed' | 'skipped'; reason?: string; error?: string }
    const observations = new Map<string, Observation[]>();
    const configuredOrder: string[] = [];
    // Eligibility is not execution: a step planned after the winner is never
    // reached and must not be flagged. Only steps absent from eligible AND
    // excluded AND executed are invisible in the trace.
    const everEligible = new Set<string>();

    const recordObs = (model: string, obs: Observation) => {
      const list = observations.get(model);
      if (list) list.push(obs);
      else observations.set(model, [obs]);
    };

    for (const record of group) {
      const ok = record.result?.status >= 200 && record.result.status < 300;
      if (ok) successes += 1;
      const winner = record.result?.answeredBy;
      if (winner) {
        const key = `${winner.provider}/${winner.model}`;
        winnerCounts[key] = (winnerCounts[key] || 0) + 1;
      }
      const at = Date.parse(record.timestamp) || 0;

      for (const model of record.chain?.configuredTargets || []) {
        if (!configuredOrder.includes(model)) configuredOrder.push(model);
      }
      for (const model of record.chain?.eligibleTargets || []) {
        everEligible.add(model);
      }
      for (const excluded of record.chain?.excludedTargets || []) {
        recordObs(excluded.model, { at, outcome: 'skipped', reason: excluded.reason });
      }
      for (const stage of record.stages || []) {
        if (stage.outcome === 'answered') {
          recordObs(stage.targetModel, { at, outcome: 'answered' });
        } else if (stage.outcome === 'failed') {
          recordObs(stage.targetModel, {
            at,
            outcome: 'failed',
            error: stage.errorType || stage.errorMessage || 'unknown'
          });
        } else {
          recordObs(stage.targetModel, {
            at,
            outcome: 'skipped',
            reason: stage.skipReason || stage.errorType || 'unknown'
          });
        }
      }
    }

    const models: ModelHealth[] = [];
    for (const [model, obsList] of observations.entries()) {
      let answered = 0;
      let failed = 0;
      let skipped = 0;
      const skipReasons: Record<string, number> = {};
      const errorTypes: Record<string, number> = {};
      let lastError: string | null = null;
      let lastSeen: string | null = null;

      for (const obs of obsList) {
        if (obs.outcome === 'answered') answered += 1;
        else if (obs.outcome === 'failed') {
          failed += 1;
          const key = obs.error || 'unknown';
          errorTypes[key] = (errorTypes[key] || 0) + 1;
          lastError = key;
        } else {
          skipped += 1;
          const key = obs.reason || 'unknown';
          skipReasons[key] = (skipReasons[key] || 0) + 1;
        }
        if (!lastSeen || obs.at > Date.parse(lastSeen)) {
          lastSeen = obs.at > 0 ? new Date(obs.at).toISOString() : lastSeen;
        }
      }

      const attempted = answered + failed;
      const flags: string[] = [];

      // Stable error classes (§4.3): the same window, four triage buckets.
      const errorClasses: Record<string, number> = {};
      for (const key of Object.keys(errorTypes)) {
        const cls = errorClassFor(key);
        if (cls === 'other') continue;
        errorClasses[cls] = (errorClasses[cls] || 0) + errorTypes[key];
      }
      const lastErrorClass = errorClassFor(lastError);
      for (const cls of Object.keys(errorClasses)) {
        // Flag a class when it is the member's current problem (last error) or
        // repeats — a single transient rate limit on an answering member stays
        // a count, not an alarm.
        if (errorClasses[cls] >= 2 || cls === lastErrorClass) {
          flags.push(cls);
        }
      }

      if (attempted >= MIN_OBSERVATIONS && answered === 0) {
        flags.push('never_answers');
      }
      if (obsList.length >= MIN_OBSERVATIONS && skipped === obsList.length) {
        flags.push('always_skipped');
      }

      // Recent-error spike: failure rate over the last 20 attempts is >=50%
      // and at least double the rate before that.
      const attemptObs = obsList.filter((o) => o.outcome !== 'skipped');
      if (attemptObs.length >= 6) {
        const recent = attemptObs.slice(-20);
        const prior = attemptObs.slice(0, Math.max(0, attemptObs.length - recent.length));
        const recentRate = recent.filter((o) => o.outcome === 'failed').length / recent.length;
        const priorRate = prior.length >= 3
          ? prior.filter((o) => o.outcome === 'failed').length / prior.length
          : 0;
        if (recentRate >= 0.5 && recentRate >= Math.max(priorRate * 2, 0.5)) {
          flags.push('recent_error_spike');
        }
      }

      models.push({
        model,
        planned: obsList.length,
        answered,
        failed,
        skipped,
        skipReasons,
        errorTypes,
        errorClasses,
        answerRate: obsList.length > 0 ? Math.round((answered / obsList.length) * 1000) / 1000 : 0,
        lastError,
        lastSeen,
        flags
      });
    }

    // Configured but never observed and never even eligible — not planned,
    // not excluded, not executed. With full capture this should be empty; a
    // hit means a stage vanished without a recorded reason (the exact bug
    // class this log exists for). Ever-eligible-but-unreached is healthy: the
    // chain answered before those steps — a zero row, no flag.
    for (const model of configuredOrder) {
      if (observations.has(model)) continue;
      models.push({
        model,
        planned: 0,
        answered: 0,
        failed: 0,
        skipped: 0,
        skipReasons: {},
        errorTypes: {},
        errorClasses: {},
        answerRate: 0,
        lastError: null,
        lastSeen: null,
        flags: everEligible.has(model) ? [] : ['missing_from_plan']
      });
    }

    // Chain order first (operator intent), observed-only models after.
    models.sort((a, b) => {
      const ai = configuredOrder.indexOf(a.model);
      const bi = configuredOrder.indexOf(b.model);
      return (ai === -1 ? configuredOrder.length : ai) - (bi === -1 ? configuredOrder.length : bi);
    });

    routes.push({
      routeId,
      trajectories: group.length,
      successes,
      successRate: group.length > 0 ? Math.round((successes / group.length) * 1000) / 1000 : 0,
      winnerCounts,
      models
    });
  }

  routes.sort((a, b) => b.trajectories - a.trajectories);
  return {
    generatedAt: new Date().toISOString(),
    windowRecords: window.length,
    routes
  };
}

// ---------------------------------------------------------------------------
// Tracker — built beside the request, flushed once via LogEntryTracker.onFinish
// ---------------------------------------------------------------------------

/** Narrow untrusted parsed JSON to an indexable record (the guard runs before the cast). */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function summarizeRequestBody(body: unknown): {
  requestJson: string;
  stream: boolean;
  modalities: string[];
  toolCallsRequested: number;
  messageCount: number;
  promptHash: string;
} {
  const record = asRecord(body) ?? {};
  const messages: unknown[] = Array.isArray(record.messages) ? record.messages : [];

  // Redact binary payloads before hashing/spilling: an image is not
  // inspectable text and would otherwise dominate every record.
  const sanitized = messages.map((msg) => {
    const msgRecord = asRecord(msg);
    const role = msgRecord && 'role' in msgRecord ? msgRecord.role : undefined;
    const content = msgRecord && 'content' in msgRecord ? msgRecord.content : undefined;
    if (typeof content === 'string') return { role, content };
    if (Array.isArray(content)) {
      return {
        role,
        content: content.map((part) => {
          const partRecord = asRecord(part);
          if (!partRecord || !('type' in partRecord)) return { omitted: true };
          const type = String(partRecord.type || '');
          if (type === 'text') {
            const text = 'text' in partRecord ? partRecord.text : undefined;
            return typeof text === 'string' ? { type: 'text', text } : { type: 'text', omitted: true };
          }
          return { type, omitted: true };
        })
      };
    }
    return { role, content };
  });

  const toolDeclarations: unknown[] = Array.isArray(record.tools) ? record.tools : [];
  const tools = toolDeclarations
    .map((tool) => {
      const toolRecord = asRecord(tool);
      const fn = toolRecord && 'function' in toolRecord ? asRecord(toolRecord.function) : null;
      const name = (fn && 'name' in fn ? fn.name : undefined)
        ?? (toolRecord && 'name' in toolRecord ? toolRecord.name : undefined);
      return typeof name === 'string' && name ? name : null;
    })
    .filter((name): name is string => name !== null);

  const requestJson = JSON.stringify({
    model: record.model,
    stream: Boolean(record.stream),
    tools,
    messages: sanitized
  });

  const modalities = new Set<string>(['text']);
  for (const msg of messages) {
    const msgRecord = asRecord(msg);
    const content = msgRecord && 'content' in msgRecord ? msgRecord.content : undefined;
    if (Array.isArray(content)) {
      for (const part of content) {
        const partRecord = asRecord(part);
        const type = String((partRecord && 'type' in partRecord ? partRecord.type : '') || '').toLowerCase();
        const mime = String((partRecord && 'mime_type' in partRecord ? partRecord.mime_type : '') || '').toLowerCase();
        if (type.includes('image')) modalities.add('image');
        else if (type.includes('audio')) modalities.add('audio');
        else if (type.includes('video')) modalities.add('video');
        else if (type === 'document' || mime.includes('pdf')) modalities.add('pdf');
      }
    }
  }

  return {
    requestJson,
    stream: Boolean(record.stream),
    modalities: Array.from(modalities),
    toolCallsRequested: tools.length,
    messageCount: messages.length,
    promptHash: sha256Hex(requestJson).slice(0, 16)
  };
}

/** Structural finish input — a finished `ExpertLog` is assignable to this. */
export interface TrajectoryFinishInput {
  timestamp?: string;
  durationMs?: number;
  status: number;
  errorType?: string;
  errorMessage?: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  costTotal?: number;
  costPrompt?: number;
  costCompletion?: number;
  costCached?: number;
  content?: string;
  thinking?: string;
  toolCalls?: { name: string; arguments: string }[];
}

/**
 * Resolve who made this request.
 *
 * Observed 2026-11-14: every live record said `client: "unknown"` because the
 * router read only `x-local-router-client`, and pi — the harness that now
 * powers ainish-rag's review drivers — sends no such header. It does send a
 * real User-Agent: `pi/1.5.2 (darwin; node/v22.22.3; arm64)`.
 *
 * Order matters. An explicit header wins because a client that bothered to set
 * it knows itself better than its UA does. The UA is a fallback, and the
 * `clientSource` field records which path produced the name so an 'unknown' is
 * never mistaken for "attribution worked and the answer was unknown".
 */
export function resolveTrajectoryClient(
  headerValue: string | string[] | undefined,
  userAgent: string | undefined
): { client: string; clientSource: TrajectoryClientSource; userAgent?: string } {
  const header = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  const trimmedHeader = typeof header === 'string' ? header.trim() : '';
  if (trimmedHeader) {
    return { client: trimmedHeader, clientSource: 'header', ...(userAgent ? { userAgent } : {}) };
  }
  const ua = typeof userAgent === 'string' ? userAgent.trim() : '';
  if (ua) {
    // Take the product token before the first '/', ' ' or '(' — `pi/1.5.2 (...)`
    // becomes `pi`, `ainish-rag/0.9 (…)` becomes `ainish-rag`, and a bare
    // `curl/8.4.0` becomes `curl`. Empty product tokens fall through to unknown.
    const product = (/^([^\s/()]+)/.exec(ua) || [])[1];
    if (product) {
      return { client: product.toLowerCase(), clientSource: 'user-agent', userAgent: ua };
    }
  }
  return { client: 'unknown', clientSource: 'unknown', ...(ua ? { userAgent: ua } : {}) };
}

/**
 * Derive the explicit shed marker for a finished record.
 *
 * Returns undefined — not a zeroed object — when no shed happened, because a
 * present-but-empty marker reads as "the chain answered without shedding" while
 * an absent one reads as "this was not a chain call". Readers that ignore the
 * field keep working; readers that use it never have to infer.
 */
export function deriveShedding(
  presentedModel: string,
  answeredBy: { provider: string; model: string } | null,
  stages: TrajectoryStage[],
  chain: TrajectoryChain | null
): TrajectoryShedding | undefined {
  if (!answeredBy || !chain) return undefined;
  const winners = stages.filter((stage) => stage.outcome === 'answered');
  if (winners.length === 0) return undefined;
  const concrete = `${answeredBy.provider}/${answeredBy.model}`;
  // A direct call answered by the very model asked for is not a shed. An alias
  // answer is always a shed, because the alias is never itself a model.
  const isAliasAnswer = presentedModel !== concrete
    && concrete !== `${answeredBy.provider}/${presentedModel}`;
  if (!isAliasAnswer) return undefined;
  return {
    from: presentedModel,
    to: concrete,
    attemptsBeforeAnswer: stages.filter(
      (stage) => stage.outcome !== 'answered' && stage.outcome !== 'skipped'
    ).length,
    excludedCount: chain.excludedTargets?.length ?? 0
  };
}

export class TrajectoryTracker {
  private stages: TrajectoryStage[] = [];
  private chain: TrajectoryChain | null = null;
  private requestMeta: TrajectoryRecord['request'];
  private requestJson = '';
  private finished = false;
  constructor(
    private meta: {
      client: string;
      /** v2: where `client` came from. Defaults to 'header' for existing callers. */
      clientSource?: TrajectoryClientSource;
      /** v2: raw User-Agent for retroactive attribution. */
      userAgent?: string;
      presentedModel: string;
      routeKind: TrajectoryRecord['routeKind'];
      routeId?: string | null;
    },
    requestBody?: unknown
  ) {
    const summary = summarizeRequestBody(requestBody ?? {});
    this.requestJson = summary.requestJson;
    this.requestMeta = {
      stream: summary.stream,
      modalities: summary.modalities,
      toolCallsRequested: summary.toolCallsRequested,
      messageCount: summary.messageCount,
      promptHash: summary.promptHash
    };
  }

  public setChain(chain: TrajectoryChain | null): void {
    this.chain = chain;
  }

  /** A direct model attempt failed and the request cascaded into a fallback route. */
  public markCascade(routeId: string): void {
    this.meta.routeKind = 'direct+cascade';
    this.meta.routeId = routeId;
  }

  public addStage(stage: TrajectoryStage): void {
    this.stages.push(stage);
  }

  /** Flatten the tracker's view for debugging and tests. */
  public getStages(): TrajectoryStage[] {
    return this.stages.slice();
  }

  public finish(log: TrajectoryFinishInput): TrajectoryRecord | null {
    if (this.finished) return null;
    this.finished = true;

    const answered = this.stages.find((s) => s.outcome === 'answered');
    const answeredBy = answered
      ? { provider: answered.provider || 'unknown', model: answered.actualModel || answered.targetModel }
      : null;
    const record: TrajectoryRecord = {
      schema_version: TRAJECTORY_SCHEMA_VERSION,
      id: `traj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: log.timestamp || new Date().toISOString(),
      durationMs: log.durationMs || 0,
      client: this.meta.client,
      clientSource: this.meta.clientSource ?? 'header',
      ...(this.meta.userAgent ? { userAgent: this.meta.userAgent } : {}),
      presentedModel: this.meta.presentedModel,
      routeKind: this.meta.routeKind,
      routeId: this.meta.routeId ?? this.chain?.routeId ?? null,
      request: this.requestMeta,
      chain: this.chain,
      stages: this.stages,
      shedding: deriveShedding(this.meta.presentedModel, answeredBy, this.stages, this.chain),
      result: {
        status: log.status || 0,
        answeredBy,
        errorType: log.errorType || null,
        errorMessage: log.errorMessage ? previewOf(log.errorMessage) : null,
        usage: {
          promptTokens: log.promptTokens || 0,
          completionTokens: log.completionTokens || 0,
          cachedTokens: log.cachedTokens || 0,
          cacheWriteTokens: log.cacheWriteTokens || 0
        },
        cost: {
          total: log.costTotal || 0,
          prompt: log.costPrompt || 0,
          completion: log.costCompletion || 0,
          cached: log.costCached || 0
        }
      },
      receipts: {}
    };

    const requestReceipt = storeReceipt(this.requestJson);
    if (requestReceipt) record.receipts.request = requestReceipt;
    // Empty content/thinking carries no information — skip the receipt rather
    // than log a 0-char handle for every tool-call-only answer.
    if (log.content) {
      const responseReceipt = storeReceipt(log.content);
      if (responseReceipt) record.receipts.response = responseReceipt;
    }
    if (log.thinking) {
      const thinkingReceipt = storeReceipt(log.thinking);
      if (thinkingReceipt) record.receipts.thinking = thinkingReceipt;
    }
    if (log.toolCalls && log.toolCalls.length > 0) {
      const toolCallsReceipt = storeReceipt(JSON.stringify(log.toolCalls, null, 2));
      if (toolCallsReceipt) record.receipts.toolCalls = toolCallsReceipt;
    }

    appendTrajectory(record);
    return record;
  }
}
