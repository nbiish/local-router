/**
 * usage-policy.ts — how long a member's failure should park it, and why.
 *
 * The chain mixes three economically different things and used to treat them
 * identically:
 *
 *   - subscription capacity (a rolling usage window: a GLM coding plan, or an
 *     OAuth session that meters by quota) — exhausting it is not a transient
 *     error, and retrying in 5 minutes just wastes stages for hours;
 *   - free tiers, whose allowance is undocumented and changes without notice —
 *     the honest position is "unknown", learned from observed behaviour;
 *   - metered paid keys, where a 429 is a burst limit and a 402 is a billing
 *     problem.
 *
 * "Decisions live in code": this module is a pure function from (provider
 * policy, classified error, reset evidence) to a cooldown duration. A model
 * never chooses a cooldown; at most it may *label* a body this module could not
 * classify, and the label lands in the same deterministic table.
 *
 * Reset evidence has three tiers, strongest first:
 *   1. a header the provider published (`Retry-After`, `x-ratelimit-reset*`);
 *   2. a human sentence in the body ("retry shortly", "in 30 seconds");
 *   3. nothing — fall back to the class default and record that we guessed.
 * Tier 2 is deliberately weaker than tier 1 and is recorded as `inferred`, so a
 * later analysis can tell a measured park from an assumed one.
 */

/** Economic class of an access path. `unknown` is honest, not a placeholder. */
export type UsageClass = 'subscription' | 'free' | 'paid' | 'local' | 'unknown';

export interface UsagePolicy {
  class: UsageClass;
  /**
   * Length of the provider's rolling window, when known. A subscription that
   * meters by window can be exhausted for the whole window; parking it for the
   * retry default wastes every stage that touches it.
   */
  windowMinutes?: number;
  /** Does the provider publish machine-readable reset info? If not, we infer. */
  resetPublished?: boolean;
  /** Free-form evidence note; the docs/usage/<provider>.txt file carries the long form. */
  note: string;
}

export type ResetEvidenceSource = 'header' | 'body-hint' | 'window' | 'default';

export interface ResetEvidence {
  /** Seconds until the member may be usable again, when known. */
  seconds?: number;
  source: ResetEvidenceSource;
  /** True when this is a guess rather than a published or stated value. */
  inferred: boolean;
  detail?: string;
}

/** A parsed `Retry-After` / `x-ratelimit-reset*` set. */
export function parseResetHeaders(headers: Record<string, string | undefined>): ResetEvidence | null {
  const lower = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string' && value.trim()) lower.set(key.toLowerCase(), value.trim());
  }

  const retryAfter = lower.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return { seconds, source: 'header', inferred: false, detail: `retry-after: ${retryAfter}` };
    }
    // HTTP-date form: `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT`
    const when = Date.parse(retryAfter);
    if (Number.isFinite(when)) {
      const delta = Math.max(0, Math.round((when - Date.now()) / 1000));
      return { seconds: delta, source: 'header', inferred: false, detail: `retry-after: ${retryAfter}` };
    }
  }

  // Providers publish reset in several shapes; take the first that parses.
  //   x-ratelimit-reset-requests: 12s / 1m30s / 6h
  //   x-ratelimit-reset: 1699999999 (epoch seconds) or 30 (seconds)
  for (const key of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens', 'x-ratelimit-reset']) {
    const value = lower.get(key);
    if (!value) continue;
    const compact = /^(\d+)(ms|s|m|h|d)$/i.exec(value);
    if (compact) {
      const n = Number(compact[1]);
      const unit = compact[2].toLowerCase();
      const mult = unit === 'ms' ? 0.001 : unit === 's' ? 1 : unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400;
      return { seconds: Math.round(n * mult), source: 'header', inferred: false, detail: `${key}: ${value}` };
    }
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) {
      // Epoch seconds are far in the future; anything small is a delta.
      const seconds = numeric > 1_000_000_000 ? Math.max(0, numeric - Math.floor(Date.now() / 1000)) : numeric;
      return { seconds, source: 'header', inferred: false, detail: `${key}: ${value}` };
    }
  }

  return null;
}

/**
 * Body hints. These are deliberately conservative: a provider saying "retry
 * shortly" is a burst signal, not a window signal, so the hint only ever
 * shortens a park — it never licenses parking for hours.
 */
export function parseResetHint(bodyText: string): ResetEvidence | null {
  const text = String(bodyText || '').toLowerCase();

  const explicit = /(?:retry|try again|resets?|available)\s+(?:in|after)\s+(\d+)\s*(second|sec|minute|min|hour|hr)s?/.exec(text);
  if (explicit) {
    const n = Number(explicit[1]);
    const unit = explicit[2];
    const mult = unit.startsWith('sec') ? 1 : unit.startsWith('min') ? 60 : 3600;
    return { seconds: n * mult, source: 'body-hint', inferred: false, detail: explicit[0] };
  }

  const retryAfterSeconds = /retry[- ]after[":\s]+(\d+)/.exec(text);
  if (retryAfterSeconds) {
    return { seconds: Number(retryAfterSeconds[1]), source: 'body-hint', inferred: false, detail: retryAfterSeconds[0] };
  }

  // The most common real shape (measured 2026-11-18 on OpenRouter free tier):
  // "temporarily rate-limited upstream. Please retry shortly".
  if (/retry shortly|temporarily rate.?limited|please try again|slow down/.test(text)) {
    return { seconds: 60, source: 'body-hint', inferred: true, detail: 'burst hint ("retry shortly")' };
  }

  return null;
}

/**
 * Signature of a *window* exhaustion rather than a burst limit. A subscription
 * plan that has spent its rolling allowance usually says so; when it does, the
 * correct park is the window, not the burst default.
 */
export function looksLikeWindowExhaustion(bodyText: string): boolean {
  const text = String(bodyText || '').toLowerCase();
  return /usage limit|quota exceeded|out of quota|limit resets|window|daily limit|hourly limit|plan limit|credits exhausted/.test(text);
}

export interface CooldownDecision {
  seconds: number;
  evidence: ResetEvidence;
  /** Human-readable justification, surfaced on the health API and in the log. */
  reason: string;
}

export interface CooldownInput {
  policy: UsagePolicy | undefined;
  /** Classified error type (`upstream_http_rate_limit`, `upstream_http_quota`, …). */
  errorType: string;
  /** Headers from the failing response, when the caller captured them. */
  headers?: Record<string, string | undefined>;
  /** Body text from the failing response, when available. */
  bodyText?: string;
  /** Class default for retryable failures (seconds). */
  defaultRetrySeconds: number;
  /** Class default for auth/payment failures (seconds). */
  defaultAuthSeconds: number;
}

/**
 * Decide how long to park a member. Pure and deterministic — the same inputs
 * always produce the same cooldown, which is what makes it testable and what
 * keeps a model out of the decision path.
 */
export function decideCooldown(input: CooldownInput): CooldownDecision {
  const { policy, errorType, headers, bodyText } = input;

  // Tier 1: a published header always wins — the provider told us exactly.
  const fromHeader = headers ? parseResetHeaders(headers) : null;
  if (fromHeader?.seconds != null) {
    return {
      seconds: fromHeader.seconds,
      evidence: fromHeader,
      reason: `provider published a reset (${fromHeader.detail})`
    };
  }

  // Auth / payment classes cannot heal by waiting a few minutes.
  const isAuthClass = errorType === 'upstream_http_auth' || errorType === 'upstream_http_payment_required';

  // A subscription whose whole window is spent stays parked for the window.
  const windowMinutes = policy?.windowMinutes;
  if (windowMinutes && !isAuthClass && bodyText && looksLikeWindowExhaustion(bodyText)) {
    return {
      seconds: windowMinutes * 60,
      evidence: { seconds: windowMinutes * 60, source: 'window', inferred: false, detail: `window ${windowMinutes}m` },
      reason: `subscription window exhausted — parked for the ${windowMinutes}m window`
    };
  }

  // Tier 2: a body hint. Never longer than the window it might be describing.
  const fromBody = bodyText ? parseResetHint(bodyText) : null;
  if (fromBody?.seconds != null) {
    const cap = windowMinutes ? windowMinutes * 60 : Number.POSITIVE_INFINITY;
    return {
      seconds: Math.min(fromBody.seconds, cap),
      evidence: fromBody,
      reason: `body carried a reset hint (${fromBody.detail})`
    };
  }

  // Tier 3: class default, recorded as a guess.
  const seconds = isAuthClass ? input.defaultAuthSeconds : input.defaultRetrySeconds;
  return {
    seconds,
    evidence: { seconds, source: 'default', inferred: true, detail: `${errorType} class default` },
    reason: `no reset published or stated — ${errorType} class default`
  };
}
