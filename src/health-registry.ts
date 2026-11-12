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

export type HealthOutcomeInput = {
  /** Route id of the fallback chain, or null for a direct call. */
  chainId: string | null;
  model: string;
  outcome: 'answered' | 'failed';
  errorType?: string | null;
  at?: number;
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
  'upstream_parse_error'
]);

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
};

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

  private key(chainId: string | null, model: string): string {
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
      lastFailureAt: null
    };
    this.members.set(this.key(input.chainId, input.model), state);

    if (input.outcome === 'answered') {
      state.consecutiveFailures = 0;
      state.quarantineUntil = 0;
      state.quarantineErrorType = null;
      state.lastSuccessAt = now;
      return;
    }

    const errorType = input.errorType || 'unknown';
    state.lastFailureAt = now;
    if (!EVIDENCE_FAILURE_TYPES.has(errorType)) return;

    const errorClass = errorClassFor(errorType);
    if (IMMEDIATE_QUARANTINE_CLASSES.has(errorClass)) {
      // One strike: retrying a rejected key or an empty balance cannot heal it.
      state.consecutiveFailures = 0;
      state.quarantineUntil = now + this.cooldownAuthMs();
      state.quarantineErrorType = errorType;
      return;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= STRIKES_BEFORE_RETRYABLE_QUARANTINE) {
      state.quarantineUntil = now + this.cooldownRetryMs();
      state.quarantineErrorType = errorType;
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

  /** Tests and `LOCAL_ROUTER_HEALTH_DISABLE` transitions. */
  public reset(): void {
    this.members.clear();
  }
}

export const healthRegistry = new FallbackHealthRegistry();
