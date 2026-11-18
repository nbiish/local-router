/**
 * health-registry.ts — deterministic cross-request fallback-chain quarantine.
 *
 * The fallback chain re-walks dead members on every request (152-stage
 * wraparound plans observed live, 2026-11-12). This registry answers one
 * question per chain member — "may it be attempted right now?" — from recorded
 * outcome evidence, so a provider/model that is "no longer working right"
 * stops burning stages instead of being retried into the ground.
 *
 * "Decisions live in code": thresholds and cooldowns are the constants/env
 * below, never inferred by a model at runtime. Rules (operator-confirmed
 * 2026-11-12, plan §4.1):
 *   - key_rejected / out_of_funds: 1 strike  -> cooldown (default 30 min).
 *     Retrying cannot heal a rejected key or an empty balance.
 *   - usage_limit / usage_error / transient upstream: 3 consecutive strikes
 *     -> cooldown (default 5 min). These can heal (window resets) but not
 *     within the same request's wraparound.
 *   - any success clears the member immediately.
 *   - when the whole chain would fail, quarantined members are force-tried as
 *     a last pass (plan §4.2) — a stale answer beats a 502.
 *
 * State is in-memory and re-derivable from the trajectory log: a restart
 * starts clean, staleness expires by construction (cooldowns are bounded),
 * and nothing is ever written back into router-settings.json (the chain file
 * is operator-authored truth). Opt out with LOCAL_ROUTER_HEALTH_DISABLE=1.
 */

import { errorClassFor } from './trajectories';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { decideCooldown, type UsagePolicy } from './usage-policy';
import { usagePolicyFor } from './usage-policy-table';

export type HealthOutcomeInput = {
  /** Route id of the fallback chain, or null for a direct call. */
  chainId: string | null;
  model: string;
  outcome: 'answered' | 'failed';
  errorType?: string | null;
  at?: number;
  /** Provider slug, used to look up the usage policy. */
  provider?: string | null;
  /** Response headers from the failing attempt, for reset parsing. */
  headers?: Record<string, string | undefined>;
  /** Response body text from the failing attempt, for reset hints. */
  bodyText?: string;
  /** Override the usage policy (tests, custom providers). */
  policy?: UsagePolicy;
};

export type AttemptVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** `cooldown:<errorType>` — recorded verbatim as the skip reason. */
      reason: string;
      errorType: string;
      until: number;
    };

export type QuarantinedMember = {
  model: string;
  errorType: string;
  until: number;
};

export type ChainHealthSnapshot = Record<string, { dead: QuarantinedMember[]; degraded: QuarantinedMember[] }>;

/** Failure types that are evidence about the member itself. Preflight/config
 * classes (unknown_model, provider_config, dimension mismatch, local proxy
 * bugs) are not: they say nothing about whether the upstream can answer. */
const EVIDENCE_FAILURE_TYPES = new Set([
  'upstream_http',
  'upstream_http_quota',
  'upstream_http_payment_required',
  'upstream_http_auth',
  'upstream_http_rate_limit',
  'upstream_http_unavailable',
  'upstream_http_invalid_request',
  'upstream_parse_error',
  // A route or model that does not exist on the provider is evidence about this
  // chain member, and a permanent one: it must park for a long window rather
  // than be retried as a transient.
  'upstream_route_not_found',
  'upstream_model_not_found',
  'mid_stream_error'
]);

/**
 * Failure types that must NOT quarantine the provider.
 *
 * `empty_completion` is a model-configuration outcome (a reasoning model that
 * spends its whole budget and answers nothing), not evidence that the upstream
 * is down. Booking it as provider ill-health would quarantine a healthy
 * provider for a prompt/model mismatch.
 */
const NON_EVIDENCE_FAILURE_TYPES = new Set(['empty_completion']);

const IMMEDIATE_QUARANTINE_CLASSES = new Set(['key_rejected', 'out_of_funds']);

const STRIKES_BEFORE_RETRYABLE_QUARANTINE = 3;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

type MemberState = {
  consecutiveFailures: number;
  quarantineUntil: number;
  quarantineErrorType: string | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  /** Why the current quarantine was chosen, for the health API and the log. */
  quarantineReason?: string;
  /** True when the cooldown came from a guess rather than published/observed fact. */
  quarantineInferred?: boolean;
  /** Rolling outcome history inside the failure-rate window (bounded). */
  history: { at: number; ok: boolean }[];
  /**
   * When the current unbroken failing streak began. Tracked explicitly because
   * `history` is pruned to the failure-rate window, so a member failing for 25
   * hours would otherwise look like it had only been failing for 24.
   */
  failingSince: number | null;
  /** Set when auto-disable fired; cleared on re-enable. */
  autoDisabledAt?: number | null;
  autoDisabledReason?: string | null;
};

/** Failure-rate window: 24h by operator ask ("fails continuously past a day"). */
const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Bounded per-member history so a hot member cannot grow the map without limit. */
const MAX_HISTORY_ENTRIES = 500;

class FallbackHealthRegistry {
  /** `${chainId}::${model}` -> state. Chain-scoped per plan §3 (a key rejected
   * under one route is recorded where it happened; other routes see it after
   * their own first failure). */
  private members = new Map<string, MemberState>();

  private disabled(): boolean {
    return process.env.LOCAL_ROUTER_HEALTH_DISABLE === '1';
  }

  private cooldownAuthMs(): number {
    return envInt('LOCAL_ROUTER_HEALTH_COOLDOWN_AUTH_MIN', 30) * 60 * 1000;
  }

  private cooldownRetryMs(): number {
    return envInt('LOCAL_ROUTER_HEALTH_COOLDOWN_RETRY_MIN', 5) * 60 * 1000;
  }

  /** Auto-disable threshold in hours (default 24h, per operator ask). */
  private autoDisableAfterMs(): number {
    return envInt('LOCAL_ROUTER_AUTO_DISABLE_AFTER_HOURS', 24) * 60 * 60 * 1000;
  }

  /**
   * Choose a cooldown from the member's usage policy plus whatever reset
   * evidence the failing response carried. Pure delegation to `decideCooldown`
   * so the rule table stays in one reviewable place.
   */
  private cooldownFor(input: HealthOutcomeInput, errorType: string): { ms: number; reason: string; inferred: boolean } {
    const policy = input.policy
      || (input.provider ? usagePolicyFor(input.provider) : undefined);
    const decision = decideCooldown({
      policy,
      errorType,
      headers: input.headers,
      bodyText: input.bodyText,
      defaultRetrySeconds: this.cooldownRetryMs() / 1000,
      defaultAuthSeconds: this.cooldownAuthMs() / 1000
    });
    // A permanent 404 parks like an auth failure: it will not heal in 5 minutes.
    const permanent = errorType === 'upstream_route_not_found' || errorType === 'upstream_model_not_found';
    const ms = permanent
      ? Math.max(decision.seconds * 1000, this.cooldownAuthMs())
      : decision.seconds * 1000;
    return {
      ms,
      reason: permanent ? `permanent: ${decision.reason}` : decision.reason,
      inferred: decision.evidence.inferred
    };
  }

  private pushHistory(state: MemberState, at: number, ok: boolean): void {
    state.history.push({ at, ok });
    if (state.history.length > MAX_HISTORY_ENTRIES) {
      state.history.splice(0, state.history.length - MAX_HISTORY_ENTRIES);
    }
    // Drop entries outside the window so a long-idle member cannot resurrect
    // an ancient failure into its rate.
    const cutoff = at - FAILURE_WINDOW_MS;
    while (state.history.length > 0 && state.history[0].at < cutoff) {
      state.history.shift();
    }
  }

  /** Failures/total inside the window; null when there is no evidence yet. */
  public failureRate(chainId: string | null, model: string, at?: number): number | null {
    const state = this.members.get(this.key(chainId, model));
    if (!state || state.history.length === 0) return null;
    const cutoff = (at ?? Date.now()) - FAILURE_WINDOW_MS;
    const windowed = state.history.filter((entry) => entry.at >= cutoff);
    if (windowed.length === 0) return null;
    const failures = windowed.filter((entry) => !entry.ok).length;
    return failures / windowed.length;
  }

  /**
   * Auto-disable candidates: members that have failed continuously for at least
   * the threshold, with no success anywhere in that span. Deliberately strict —
   * a single success resets the clock, because "continuously past a day" is what
   * the operator asked for, not "has a bad rate over a day".
   */
  public autoDisableCandidates(at?: number): { chainId: string; model: string; since: number; failingMs: number }[] {
    if (this.disabled()) return [];
    const now = at ?? Date.now();
    const threshold = this.autoDisableAfterMs();
    const out: { chainId: string; model: string; since: number; failingMs: number }[] = [];
    for (const [key, state] of this.members) {
      const sep = key.indexOf('::');
      const chainId = key.slice(0, sep);
      const model = key.slice(sep + 2);
      if (state.autoDisabledAt) continue;
      const lastOk = state.lastSuccessAt;
      if (lastOk != null && lastOk > now - threshold) continue;
      if (state.lastFailureAt == null) continue;
      // The failing span comes from the explicit streak start, not from pruned
      // history — history only holds the rate window, which is the same length
      // as the threshold and would make a 25-hour outage unprovable.
      const since = state.failingSince ?? lastOk ?? (state.history[0]?.at ?? state.lastFailureAt);
      const failingMs = now - since;
      if (failingMs < threshold) continue;
      if (state.consecutiveFailures < 1) continue;
      out.push({ chainId: chainId === '(direct)' ? null as unknown as string : chainId, model, since, failingMs });
    }
    return out;
  }

  /** Record that auto-disable fired for a member (caller performs the chain edit). */
  public markAutoDisabled(chainId: string | null, model: string, reason: string, at?: number): void {
    const state = this.members.get(this.key(chainId, model));
    if (!state) return;
    state.autoDisabledAt = at ?? Date.now();
    state.autoDisabledReason = reason;
  }

  /** Operator re-enable: clear the flag and the streak so it gets a fresh start. */
  public clearAutoDisabled(chainId: string | null, model: string): boolean {
    const state = this.members.get(this.key(chainId, model));
    if (!state) return false;
    state.autoDisabledAt = null;
    state.autoDisabledReason = null;
    state.consecutiveFailures = 0;
    state.quarantineUntil = 0;
    state.quarantineErrorType = null;
    return true;
  }

  public key(chainId: string | null, model: string): string {
    return `${chainId || '(direct)'}::${model}`;
  }

  public recordOutcome(input: HealthOutcomeInput): void {
    if (this.disabled()) return;
    const now = input.at ?? Date.now();
    const state = this.members.get(this.key(input.chainId, input.model)) || {
      consecutiveFailures: 0,
      quarantineUntil: 0,
      quarantineErrorType: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      history: [],
      failingSince: null
    };
    this.members.set(this.key(input.chainId, input.model), state);

    if (input.outcome === 'answered') {
      state.consecutiveFailures = 0;
      state.quarantineUntil = 0;
      state.quarantineErrorType = null;
      state.quarantineReason = undefined;
      state.quarantineInferred = undefined;
      state.lastSuccessAt = now;
      state.failingSince = null;
      this.pushHistory(state, now, true);
      return;
    }

    const errorType = input.errorType || 'unknown';
    state.lastFailureAt = now;
    // Start the streak clock on the first failure after a success.
    if (state.failingSince == null) state.failingSince = now;
    this.pushHistory(state, now, false);

    // Never let a model-configuration outcome quarantine a healthy provider.
    if (NON_EVIDENCE_FAILURE_TYPES.has(errorType)) return;
    if (!EVIDENCE_FAILURE_TYPES.has(errorType)) return;

    const errorClass = errorClassFor(errorType);
    const permanent = errorType === 'upstream_route_not_found' || errorType === 'upstream_model_not_found';
    if (IMMEDIATE_QUARANTINE_CLASSES.has(errorClass) || permanent) {
      // One strike: retrying a rejected key, an empty balance, or a route that
      // does not exist cannot heal on the next attempt.
      const cooldown = this.cooldownFor(input, errorType);
      state.consecutiveFailures = 0;
      state.quarantineUntil = now + cooldown.ms;
      state.quarantineErrorType = errorType;
      state.quarantineReason = cooldown.reason;
      state.quarantineInferred = cooldown.inferred;
      return;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= STRIKES_BEFORE_RETRYABLE_QUARANTINE) {
      const cooldown = this.cooldownFor(input, errorType);
      state.quarantineUntil = now + cooldown.ms;
      state.quarantineErrorType = errorType;
      state.quarantineReason = cooldown.reason;
      state.quarantineInferred = cooldown.inferred;
    }
  }

  public mayAttempt(chainId: string | null, model: string): AttemptVerdict {
    if (this.disabled()) return { allowed: true };
    const state = this.members.get(this.key(chainId, model));
    if (!state) return { allowed: true };
    const now = Date.now();
    if (state.quarantineUntil > now && state.quarantineErrorType) {
      return {
        allowed: false,
        reason: `cooldown:${state.quarantineErrorType}`,
        errorType: state.quarantineErrorType,
        until: state.quarantineUntil
      };
    }
    if (state.quarantineUntil !== 0 && state.quarantineUntil <= now) {
      // Cooldown expired: the next attempt starts a fresh strike window.
      state.quarantineUntil = 0;
      state.quarantineErrorType = null;
      state.consecutiveFailures = 0;
    }
    return { allowed: true };
  }

  /** Force-try candidates (plan §4.2): members currently quarantined under
   * this chain, in insertion order (= chain order of first observation). */
  public quarantined(chainId: string | null): QuarantinedMember[] {
    const prefix = `${chainId || '(direct)'}::`;
    const out: QuarantinedMember[] = [];
    const now = Date.now();
    for (const [key, state] of this.members) {
      if (!key.startsWith(prefix)) continue;
      if (state.quarantineUntil > now && state.quarantineErrorType) {
        out.push({
          model: key.slice(prefix.length),
          errorType: state.quarantineErrorType,
          until: state.quarantineUntil
        });
      }
    }
    return out;
  }

  public snapshot(): ChainHealthSnapshot {
    const out: ChainHealthSnapshot = {};
    for (const chainId of new Set(
      [...this.members.keys()].map((key) => key.slice(0, key.indexOf('::')))
    )) {
      const quarantined = this.quarantined(chainId === '(direct)' ? null : chainId);
      if (quarantined.length === 0) continue;
      out[chainId] = {
        dead: quarantined.filter((m) => IMMEDIATE_QUARANTINE_CLASSES.has(errorClassFor(m.errorType))),
        degraded: quarantined.filter((m) => !IMMEDIATE_QUARANTINE_CLASSES.has(errorClassFor(m.errorType)))
      };
    }
    return out;
  }

  /**
   * Per-member diagnostic row: why it is parked, for how long, how often it
   * fails, and whether auto-disable fired. This is the surface an operator
   * reads to decide whether to keep a member, so it states inference honestly
   * rather than presenting a guess as a measurement.
   */
  public diagnostics(chainId: string | null, model: string, at?: number): {
    quarantined: boolean;
    errorType: string | null;
    until: number | null;
    reason: string | null;
    inferred: boolean;
    failureRate: number | null;
    consecutiveFailures: number;
    lastSuccessAt: number | null;
    lastFailureAt: number | null;
    autoDisabled: boolean;
    autoDisabledReason: string | null;
  } {
    const state = this.members.get(this.key(chainId, model));
    const now = at ?? Date.now();
    if (!state) {
      return {
        quarantined: false, errorType: null, until: null, reason: null, inferred: false,
        failureRate: null, consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null,
        autoDisabled: false, autoDisabledReason: null
      };
    }
    const quarantined = state.quarantineUntil > now && Boolean(state.quarantineErrorType);
    return {
      quarantined,
      errorType: state.quarantineErrorType,
      until: quarantined ? state.quarantineUntil : null,
      reason: state.quarantineReason ?? null,
      inferred: Boolean(state.quarantineInferred),
      failureRate: this.failureRate(chainId, model, now),
      consecutiveFailures: state.consecutiveFailures,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      autoDisabled: Boolean(state.autoDisabledAt),
      autoDisabledReason: state.autoDisabledReason ?? null
    };
  }

  /** Tests and `LOCAL_ROUTER_HEALTH_DISABLE` transitions. */
  public reset(): void {
    this.members.clear();
  }

  /**
   * Persist the registry so a restart does not re-walk known-dead members.
   *
   * The file is a plain JSON snapshot, deliberately not the trajectory JSONL: it
   * is derived state that must be cheap to write on every state change and
   * cheap to discard when corrupt. Writes are best-effort — a failure to persist
   * must never fail a request, so errors are logged and swallowed here, but the
   * caller can still detect a load failure at boot.
   */
  public save(filePath: string = healthStatePath()): boolean {
    if (this.disabled()) return false;
    try {
      const payload = {
        schema: 'local-router/health-state/v1',
        savedAt: new Date().toISOString(),
        members: Object.fromEntries(this.members)
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      // Write-then-rename: a crash mid-write leaves the previous good file, never
      // a half-parsed one that would silently drop every quarantine.
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, filePath);
      return true;
    } catch (error) {
      console.error('[health] failed to persist state:', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  /**
   * Restore persisted state. Fails OPEN: a missing, unreadable, or corrupt file
   * starts a clean registry with a warning, because starting clean is exactly
   * today's behaviour and starting "everything quarantined" would take the
   * whole fleet down on a bad write.
   */
  public load(filePath: string = healthStatePath()): 'loaded' | 'missing' | 'corrupt' | 'disabled' {
    if (this.disabled()) return 'disabled';
    if (!fs.existsSync(filePath)) return 'missing';
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || typeof parsed.members !== 'object') {
        console.warn(`[health] state file has an unexpected shape; starting clean: ${filePath}`);
        return 'corrupt';
      }
      const now = Date.now();
      let restored = 0;
      for (const [key, value] of Object.entries(parsed.members as Record<string, unknown>)) {
        if (!key.includes('::') || !value || typeof value !== 'object') continue;
        const state = value as Partial<MemberState>;
        const history = Array.isArray(state.history)
          ? state.history.filter((entry): entry is { at: number; ok: boolean } => (
              Boolean(entry) && typeof entry.at === 'number' && typeof entry.ok === 'boolean'
            ))
          : [];
        this.members.set(key, {
          consecutiveFailures: Number(state.consecutiveFailures) || 0,
          // Expired cooldowns are restored as expired, so a stale park does not
          // keep a healthy member out after a long downtime.
          quarantineUntil: Number(state.quarantineUntil) || 0,
          quarantineErrorType: typeof state.quarantineErrorType === 'string' ? state.quarantineErrorType : null,
          lastSuccessAt: typeof state.lastSuccessAt === 'number' ? state.lastSuccessAt : null,
          lastFailureAt: typeof state.lastFailureAt === 'number' ? state.lastFailureAt : null,
          quarantineReason: typeof state.quarantineReason === 'string' ? state.quarantineReason : undefined,
          quarantineInferred: typeof state.quarantineInferred === 'boolean' ? state.quarantineInferred : undefined,
          history: history.filter((entry) => entry.at >= now - FAILURE_WINDOW_MS).slice(-MAX_HISTORY_ENTRIES),
          failingSince: typeof state.failingSince === 'number' ? state.failingSince : null,
          autoDisabledAt: typeof state.autoDisabledAt === 'number' ? state.autoDisabledAt : null,
          autoDisabledReason: typeof state.autoDisabledReason === 'string' ? state.autoDisabledReason : null
        });
        restored += 1;
      }
      const stillParked = this.quarantined(null).length;
      console.log(`[health] restored ${restored} member state(s) from ${filePath} (${stillParked} direct-call member(s) still parked)`);
      return 'loaded';
    } catch (error) {
      console.warn(
        `[health] state file unreadable or corrupt; starting clean (${filePath}):`,
        error instanceof Error ? error.message : String(error)
      );
      return 'corrupt';
    }
  }
}

/** Where the quarantine snapshot lives; `LOCAL_ROUTER_HEALTH_STATE` pins it (tests).
 *
 * Deliberately NOT `health.json`: that file is an existing operator-facing
 * snapshot (curated/cache counts, bridges, chainHealth) written by the router on
 * a 15-minute probe. Writing quarantine state there would clobber it, and a
 * later reader of either shape would misparse the other. Two writers, two files.
 */
export function healthStatePath(): string {
  const pinned = process.env.LOCAL_ROUTER_HEALTH_STATE;
  if (pinned) return pinned;
  const configDir = process.env.LOCAL_ROUTER_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'local-router');
  return path.join(configDir, 'quarantine-state.json');
}

export const healthRegistry = new FallbackHealthRegistry();
