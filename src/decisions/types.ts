/**
 * Canonical decision-model contract for Local Router.
 *
 * Local Router speaks one wire contract at its edge — the TypeSafe System One
 * shape that OpenRouter's Decisions API (`/api/alpha/decisions`) also serves:
 *
 *   { model, state, questions: { <id>: { type, instructions, criteria, ... } } }
 *   { model, answers: { <id>: { type, noul | choice | score, ... } }, usage }
 *
 * Clients (ainish-rag, agent harnesses, scripts) send that shape to the
 * loopback router and never learn which upstream provider answered. Providers
 * that speak a different dialect (ZenMux today) are translated inside
 * `src/decisions/dialects.ts`, and the translation stays visible in the
 * response's `local_router` block — a calibrated answer is never silently
 * substituted or invented.
 */

/** Question primitives a decision model can answer. */
export type DecisionQuestionType = 'noul' | 'choice' | 'score';

export interface NoulQuestion {
  type: 'noul';
  instructions?: unknown;
  /** `{ true, false }` descriptions of what counts as yes / no. */
  criteria?: { true?: unknown; false?: unknown } | null;
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions?: unknown;
  /** Explicit option list; when absent, `criteria` keys are the options. */
  options?: string[];
  /** Option name -> description of when that option applies. */
  criteria?: Record<string, unknown> | null;
}

export interface ScoreQuestion {
  type: 'score';
  instructions?: unknown;
  /** Ordered level numbers (`[1..n]`); optional, derived from criteria length. */
  levels?: number[];
  /** One description per level, lowest first. */
  criteria?: unknown[] | null;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export type DecisionQuestions = Record<string, DecisionQuestion>;

export interface DecisionRequest {
  /** Canonical model id (`typesafe/jev-1.14`) or a provider-qualified alias. */
  model: string;
  /** Content every question in the batch refers to. */
  state: unknown;
  questions: DecisionQuestions;
}

export interface NoulAnswer {
  type: 'noul';
  /** Probability of yes/true, 0..1. */
  noul: number;
  confidence?: number;
  /**
   * Set when a provider had no native noul primitive and the answer was
   * derived from a calibrated two-option choice (`true` / `false`).
   */
  translated_from?: 'choice';
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export interface ScoreAnswer {
  type: 'score';
  /** Probability-weighted expected level, 0-based (`[0, n-1]`). */
  score: number;
  probabilities?: Record<string, number>;
  legend?: Record<string, string>;
  confidence?: number;
}

export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface DecisionUsage {
  input_tokens?: number;
  output_tokens?: number;
  cost?: number;
  [key: string]: unknown;
}

/** Canonical response returned by the router's decisions routes. */
export interface DecisionResponse {
  /** Model id reported by the upstream provider (dated build when supplied). */
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage?: DecisionUsage;
  id?: string;
  /** Provider that actually answered (`openrouter`, `zenmux`). */
  provider: string;
  /** Dialect used on the wire (`typesafe` or `zenmux`). */
  dialect: string;
  /** Transport + translation provenance, additive and safe to ignore. */
  local_router?: DecisionProvenance;
}

export interface DecisionAttempt {
  provider: string;
  dialect: string;
  outcome: 'answered' | 'skipped' | 'retryable_error' | 'contract_error' | 'malformed_response';
  status?: number;
  ms: number;
  model?: string;
  detail?: string;
}

export interface DecisionProvenance {
  route: string;
  requested_model: string;
  canonical_model: string;
  provider: string;
  dialect: string;
  attempts: DecisionAttempt[];
  translations: string[];
  elapsed_ms: number;
}

/** A caller mistake: the request cannot be honored by any provider. HTTP 400. */
export class DecisionContractError extends Error {
  readonly status = 400;
  readonly type = 'invalid_decision_request';
  constructor(message: string) {
    super(message);
    this.name = 'DecisionContractError';
  }
}

/** No provider could answer. HTTP 502 with per-attempt detail. */
export class DecisionTransportError extends Error {
  readonly status = 502;
  readonly type = 'decision_transport_error';
  readonly attempts: DecisionAttempt[];
  constructor(message: string, attempts: DecisionAttempt[]) {
    super(message);
    this.name = 'DecisionTransportError';
    this.attempts = attempts;
  }
}

/** No provider is configured (or catalogued) for the requested model. HTTP 503. */
export class DecisionUnavailableError extends Error {
  readonly status = 503;
  readonly type = 'decision_provider_unavailable';
  readonly attempts: DecisionAttempt[];
  constructor(message: string, attempts: DecisionAttempt[] = []) {
    super(message);
    this.name = 'DecisionUnavailableError';
    this.attempts = attempts;
  }
}
