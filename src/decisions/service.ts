/**
 * Decision service — resolution, failover, provenance, status, live probe.
 *
 * The service is transport-agnostic: `index.ts` injects how a provider's
 * credentials resolve, so every key still comes from the in-memory key store /
 * resolved environment (PQC bundle -> env), never from the decisions request.
 *
 * Failover policy (deliberate, auditable):
 *   - provider availability (401/403/404/429/5xx, timeout, network) -> next provider;
 *   - malformed or partial answers                                -> next provider;
 *   - 400/422 contract rejections                                 -> next provider,
 *     and the caller sees a 400 only when every provider rejected the contract;
 *   - no provider at all                                          -> 503.
 */

import {
  decisionProvider,
  decisionProvidersForModel,
  decisionProviderOrder,
  decisionEndpoint,
  resolveDecisionModel,
  LATEST_DECISION_MODEL,
  type DecisionProviderSpec
} from './catalog';
import { decisionDialect, DecisionMalformedResponseError, validateDecisionQuestions } from './dialects';
import { decisionTimeoutMs, postDecisionUpstream, upstreamErrorMessage } from './transport';
import {
  DecisionContractError,
  DecisionTransportError,
  DecisionUnavailableError,
  type DecisionAnswer,
  type DecisionAttempt,
  type DecisionProvenance,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionResponse
} from './types';

export interface DecisionServiceDeps {
  /** True when the provider has a usable key in memory / resolved env. */
  hasProviderKey(providerName: string): boolean;
  /**
   * Provider auth headers. Throws with a safe, secret-free message when the key
   * is missing or the provider cannot be resolved.
   */
  resolveProviderHeaders(providerName: string): Promise<Record<string, string>>;
  /** Clock injection for tests. */
  now?: () => number;
}

export type DecisionOutcome =
  | { ok: true; status: 200; body: DecisionResponse; headers: Record<string, string> }
  | {
      ok: false;
      status: number;
      body: {
        error: {
          type: string;
          message: string;
          provider?: string;
          attempts: DecisionAttempt[];
        };
      };
      headers: Record<string, string>;
    };

export interface DecisionStatusProvider {
  name: string;
  label: string;
  endpoint: string;
  dialect: string;
  latest_model: string;
  key_configured: boolean;
  primitives: readonly string[];
  note?: string;
}

export interface DecisionProbeResult {
  provider: string;
  ok: boolean;
  status: number | null;
  ms: number;
  model?: string;
  error?: string;
  checked_at: string;
}

export interface DecisionStatus {
  ready: boolean;
  routes: string[];
  order: string[];
  latest_model: string;
  providers: DecisionStatusProvider[];
  advertised_models: Array<{ id: string; provider: string; model: string; display: string }>;
  last_probe: { checked_at: string; results: DecisionProbeResult[] } | null;
  recent: DecisionTelemetryEntry[];
}

export interface DecisionTelemetryEntry {
  at: string;
  route: string;
  requested_model: string;
  canonical_model: string;
  provider: string | null;
  dialect: string | null;
  status: number;
  ms: number;
  attempts: number;
  error?: string;
}

const TELEMETRY_LIMIT = 25;

const PROBE_QUESTION: DecisionQuestions = {
  probe: {
    type: 'noul',
    instructions: 'Does this probe reach a decisions endpoint?',
    criteria: { true: 'the endpoint answered', false: 'the endpoint did not answer' }
  }
};

export class DecisionService {
  private readonly deps: DecisionServiceDeps;
  private readonly now: () => number;
  private readonly telemetry: DecisionTelemetryEntry[] = [];
  private lastProbe: { checked_at: string; results: DecisionProbeResult[] } | null = null;

  constructor(deps: DecisionServiceDeps) {
    this.deps = deps;
    this.now = deps.now || (() => Date.now());
  }

  /** Providers that are catalogued, keyed, and therefore servable right now. */
  servableProviders(): DecisionProviderSpec[] {
    return decisionProviderOrder()
      .map((name) => decisionProvider(name))
      .filter((spec): spec is DecisionProviderSpec => Boolean(spec))
      .filter((spec) => this.deps.hasProviderKey(spec.name));
  }

  /**
   * Executes one canonical decision batch, failing over between providers.
   * Never throws for expected conditions: returns a structured outcome.
   */
  async execute(payload: unknown, route: string): Promise<DecisionOutcome> {
    const startedAt = this.now();
    let request: DecisionRequest;
    try {
      request = parseDecisionRequest(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid decisions request.';
      return {
        ok: false,
        status: 400,
        body: { error: { type: 'invalid_decision_request', message, attempts: [] } },
        headers: {}
      };
    }

    const resolved = resolveDecisionModel(request.model);
    if (!resolved.matched) {
      const message = `Unknown decision model "${request.model}". Use ${LATEST_DECISION_MODEL} or a provider-qualified id such as openrouter/jev-1.14.`;
      this.record({
        route,
        requested: request.model,
        canonical: request.model,
        provider: null,
        dialect: null,
        status: 404,
        ms: this.now() - startedAt,
        attempts: 0,
        error: message
      });
      return {
        ok: false,
        status: 404,
        body: { error: { type: 'unknown_decision_model', message, attempts: [] } },
        headers: {}
      };
    }

    const attempts: DecisionAttempt[] = [];
    const translations: string[] = [];
    const candidates = this.candidatesFor(resolved.canonical, resolved.provider);

    if (candidates.length === 0) {
      const message = this.unavailableMessage(resolved.canonical, resolved.provider);
      const error = new DecisionUnavailableError(message);
      this.record({
        route,
        requested: request.model,
        canonical: resolved.canonical,
        provider: null,
        dialect: null,
        status: error.status,
        ms: this.now() - startedAt,
        attempts: 0,
        error: message
      });
      return {
        ok: false,
        status: error.status,
        body: { error: { type: error.type, message, attempts } },
        headers: {}
      };
    }

    let lastStatus = 0;
    let lastDetail = '';
    let contractRejections = 0;

    for (const spec of candidates) {
      const dialect = decisionDialect(spec.dialect);
      let headers: Record<string, string>;
      try {
        headers = await this.deps.resolveProviderHeaders(spec.name);
      } catch (error) {
        attempts.push({
          provider: spec.name,
          dialect: spec.dialect,
          outcome: 'skipped',
          ms: 0,
          detail: error instanceof Error ? error.message : 'provider key unavailable'
        });
        continue;
      }

      let encoded;
      try {
        encoded = dialect.encode({
          canonicalModel: resolved.canonical,
          state: request.state,
          questions: request.questions
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Request cannot be encoded.';
        attempts.push({
          provider: spec.name,
          dialect: spec.dialect,
          outcome: 'skipped',
          ms: 0,
          detail: message
        });
        lastDetail = message;
        lastStatus = 400;
        continue;
      }
      for (const note of encoded.translations) {
        if (!translations.includes(note)) translations.push(note);
      }
      // Provenance reports the translations of the provider that actually
      // answered, not every dialect that was tried along the way.
      const answerTranslations = [...encoded.translations];

      let upstream;
      try {
        upstream = await postDecisionUpstream(
          decisionEndpoint(spec),
          headers,
          encoded.body,
          decisionTimeoutMs()
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'network failure';
        attempts.push({
          provider: spec.name,
          dialect: spec.dialect,
          outcome: 'retryable_error',
          ms: 0,
          detail: message
        });
        lastDetail = `${spec.name}: ${message}`;
        lastStatus = 502;
        continue;
      }

      if (upstream.status === 400 || upstream.status === 422) {
        contractRejections += 1;
        const detail = upstreamErrorMessage(upstream.body, upstream.text);
        attempts.push({
          provider: spec.name,
          dialect: spec.dialect,
          outcome: 'contract_error',
          status: upstream.status,
          ms: upstream.ms,
          detail
        });
        lastDetail = `${spec.name}: ${detail}`;
        lastStatus = 400;
        continue;
      }

      if (upstream.status < 200 || upstream.status >= 300) {
        const detail = upstreamErrorMessage(upstream.body, upstream.text);
        attempts.push({
          provider: spec.name,
          dialect: spec.dialect,
          outcome: 'retryable_error',
          status: upstream.status,
          ms: upstream.ms,
          detail
        });
        lastDetail = `${spec.name}: ${detail}`;
        lastStatus = 502;
        continue;
      }

      let decoded;
      try {
        decoded = dialect.decode(upstream.body, request.questions, resolved.canonical);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'malformed provider response';
        attempts.push({
          provider: spec.name,
          dialect: spec.dialect,
          outcome: 'malformed_response',
          status: upstream.status,
          ms: upstream.ms,
          detail: message
        });
        lastDetail = `${spec.name}: ${message}`;
        lastStatus = 502;
        continue;
      }

      attempts.push({
        provider: spec.name,
        dialect: spec.dialect,
        outcome: 'answered',
        status: upstream.status,
        ms: upstream.ms,
        model: decoded.model
      });

      const provenance: DecisionProvenance = {
        route,
        requested_model: resolved.requested,
        canonical_model: resolved.canonical,
        provider: spec.name,
        dialect: spec.dialect,
        attempts,
        translations: answerTranslations,
        elapsed_ms: this.now() - startedAt
      };

      this.record({
        route,
        requested: resolved.requested,
        canonical: resolved.canonical,
        provider: spec.name,
        dialect: spec.dialect,
        status: 200,
        ms: provenance.elapsed_ms,
        attempts: attempts.length
      });

      return {
        ok: true,
        status: 200,
        body: {
          model: decoded.model,
          answers: decoded.answers,
          ...(decoded.usage ? { usage: decoded.usage } : {}),
          ...(decoded.id ? { id: decoded.id } : {}),
          provider: spec.name,
          dialect: spec.dialect,
          local_router: provenance
        },
        headers: {
          'x-localrouter-decision-provider': spec.name,
          'x-localrouter-decision-dialect': spec.dialect,
          'x-localrouter-decision-model': decoded.model,
          'x-localrouter-decision-attempts': String(attempts.length)
        }
      };
    }

    const elapsed = this.now() - startedAt;
    const message = lastDetail || 'No decision provider answered.';
    const allContract = attempts.length > 0 && contractRejections === attempts.length;
    const status = allContract ? 400 : 502;

    this.record({
      route,
      requested: resolved.requested,
      canonical: resolved.canonical,
      provider: null,
      dialect: null,
      status,
      ms: elapsed,
      attempts: attempts.length,
      error: message
    });

    if (allContract) {
      const contractMessage = attempts
        .map((attempt) => `${attempt.provider}: ${attempt.detail || 'rejected the request'}`)
        .join('; ');
      return {
        ok: false,
        status: 400,
        body: {
          error: {
            type: 'invalid_decision_request',
            message: contractMessage || message,
            attempts
          }
        },
        headers: {}
      };
    }
    const transport = new DecisionTransportError(message, attempts);
    return {
      ok: false,
      status: transport.status,
      body: { error: { type: transport.type, message, attempts } },
      headers: {}
    };
  }

  /** Provider precedence for a model: a caller pin first, then configured order. */
  private candidatesFor(canonical: string, pinned?: string): DecisionProviderSpec[] {
    const servable = this.servableProviders().filter((spec) => spec.modelPattern.test(canonical));
    if (!pinned) return servable;
    const first = servable.filter((spec) => spec.name === pinned);
    const rest = servable.filter((spec) => spec.name !== pinned);
    return [...first, ...rest];
  }

  private unavailableMessage(canonical: string, pinned?: string): string {
    const providers = decisionProvidersForModel(canonical)
      .map((spec) => `${spec.name} (${this.deps.hasProviderKey(spec.name) ? 'key present' : 'no key'})`)
      .join(', ');
    const pin = pinned ? ` for pinned provider "${pinned}"` : '';
    return `No decision provider is available for ${canonical}${pin}. Configured decision providers: ${providers || 'none'}. Store the provider API key through /config or the PQC store.`;
  }

  /** Capability report used by `/api/decisions/status` and diagnostics. */
  status(): DecisionStatus {
    const order = decisionProviderOrder();
    const providers: DecisionStatusProvider[] = [];
    const advertised: DecisionStatus['advertised_models'] = [];

    for (const name of order) {
      const spec = decisionProvider(name);
      if (!spec) continue;
      const keyConfigured = this.deps.hasProviderKey(spec.name);
      providers.push({
        name: spec.name,
        label: spec.label,
        endpoint: decisionEndpoint(spec),
        dialect: spec.dialect,
        latest_model: spec.latestModel,
        key_configured: keyConfigured,
        primitives: spec.primitives,
        ...(spec.note ? { note: spec.note } : {})
      });
      if (keyConfigured) {
        const short = spec.latestModel.replace(/^typesafe\//, '');
        advertised.push({
          id: `${spec.name}/${short}`,
          provider: spec.name,
          model: spec.latestModel,
          display: `TypeSafe Jev ${short.replace(/^jev-/, '')} (${spec.name} decisions)`
        });
      }
    }

    return {
      ready: advertised.length > 0,
      routes: ['/api/alpha/decisions', '/v1/decisions', '/decisions'],
      order,
      latest_model: LATEST_DECISION_MODEL,
      providers,
      advertised_models: advertised,
      last_probe: this.lastProbe,
      recent: [...this.telemetry].reverse()
    };
  }

  /** Live probe of every configured decision provider (typed noul batch). */
  async probe(): Promise<{ checked_at: string; results: DecisionProbeResult[] }> {
    const results: DecisionProbeResult[] = [];
    for (const spec of this.servableProviders()) {
      const startedAt = this.now();
      const checkedAt = new Date(this.now()).toISOString();
      try {
        const headers = await this.deps.resolveProviderHeaders(spec.name);
        const dialect = decisionDialect(spec.dialect);
        const encoded = dialect.encode({
          canonicalModel: spec.latestModel,
          state: 'probe',
          questions: PROBE_QUESTION
        });
        const upstream = await postDecisionUpstream(
          decisionEndpoint(spec),
          headers,
          encoded.body,
          10_000
        );
        let ok = upstream.status >= 200 && upstream.status < 300;
        let model: string | undefined;
        let error: string | undefined;
        if (ok) {
          try {
            const decoded = dialect.decode(upstream.body, PROBE_QUESTION, spec.latestModel);
            model = decoded.model;
          } catch (decodeError) {
            ok = false;
            error = decodeError instanceof Error ? decodeError.message : 'malformed probe response';
          }
        } else {
          error = `HTTP ${upstream.status}: ${upstreamErrorMessage(upstream.body, upstream.text)}`;
        }
        results.push({
          provider: spec.name,
          ok,
          status: upstream.status,
          ms: this.now() - startedAt,
          ...(model ? { model } : {}),
          ...(error ? { error } : {}),
          checked_at: checkedAt
        });
      } catch (error) {
        results.push({
          provider: spec.name,
          ok: false,
          status: null,
          ms: this.now() - startedAt,
          error: error instanceof Error ? error.message : 'probe failed',
          checked_at: checkedAt
        });
      }
    }
    this.lastProbe = { checked_at: new Date(this.now()).toISOString(), results };
    return this.lastProbe;
  }

  private record(entry: {
    route: string;
    requested: string;
    canonical: string;
    provider: string | null;
    dialect: string | null;
    status: number;
    ms: number;
    attempts: number;
    error?: string;
  }): void {
    this.telemetry.push({
      at: new Date(this.now()).toISOString(),
      route: entry.route,
      requested_model: entry.requested,
      canonical_model: entry.canonical,
      provider: entry.provider,
      dialect: entry.dialect,
      status: entry.status,
      ms: entry.ms,
      attempts: entry.attempts,
      ...(entry.error ? { error: entry.error } : {})
    });
    if (this.telemetry.length > TELEMETRY_LIMIT) {
      this.telemetry.splice(0, this.telemetry.length - TELEMETRY_LIMIT);
    }
  }
}

/** Validates the canonical request envelope before any provider is contacted. */
export function parseDecisionRequest(payload: unknown): DecisionRequest {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DecisionContractError('Decisions request body must be a JSON object.');
  }
  const record = payload as Record<string, unknown>;
  const model = typeof record.model === 'string' ? record.model.trim() : '';
  if (!model) throw new DecisionContractError('Decisions request requires a model id.');
  if (record.state === undefined) throw new DecisionContractError('Decisions request requires state.');
  const questions = record.questions;
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) {
    throw new DecisionContractError('Decisions request requires a questions object keyed by question id.');
  }
  const entries = Object.entries(questions as Record<string, unknown>);
  if (entries.length === 0) {
    throw new DecisionContractError('Decisions request requires at least one question.');
  }
  for (const [id, question] of entries) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) {
      throw new DecisionContractError(`Question "${id}" must be an object.`);
    }
  }
  validateDecisionQuestions(questions as DecisionQuestions);
  return { model, state: record.state, questions: questions as DecisionQuestions };
}

/** Payload shape of a single answer for callers that want a typed helper. */
export type { DecisionAnswer, DecisionQuestion };
