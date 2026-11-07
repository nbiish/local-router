/**
 * Decision-capable provider catalog.
 *
 * A provider appears here only when it really exposes a typed decisions
 * endpoint — not because it happens to sell chat models. Today that is
 * OpenRouter (`/api/alpha/decisions`, TypeSafe dialect) and ZenMux
 * (`/api/v1/decisions`, its own dialect). Adding a provider is one entry plus
 * a dialect in `dialects.ts`; the transport, fallback, discovery, and status
 * surfaces pick it up automatically.
 *
 * Live verification (2026-10-31):
 *   - OpenRouter answered `typesafe/jev-1.14` with `{answers:{...}}` in 379-710 ms.
 *   - ZenMux's `/api/v1/decisions` exists and validates requests, but currently
 *     answers 404 `model_not_supported` for `typesafe/jev-1.14`; it is catalogued
 *     so the router starts serving it the moment ZenMux opens the route.
 */

import type { DecisionQuestionType } from './types';

/** Wire dialect a provider speaks. */
export type DecisionDialectName = 'typesafe' | 'zenmux';

export interface DecisionProviderSpec {
  /** Provider slug used throughout Local Router (`openrouter`, `zenmux`). */
  name: string;
  label: string;
  /** Absolute decisions endpoint. Overridable per provider for tests. */
  endpoint: string;
  dialect: DecisionDialectName;
  /**
   * Canonical model ids this provider is expected to serve. The pattern is
   * the forward-compatible guard: a newer Jev build matches without a code
   * change, and an upstream `model_not_supported` answer simply fails over to
   * the next provider.
   */
  modelPattern: RegExp;
  /** Newest known decision model id (`typesafe/jev-1.14`). */
  latestModel: string;
  /**
   * Model name this provider accepts on the wire, when it differs from the canonical id.
   *
   * Providers do not share one vocabulary: OpenRouter resells under `typesafe/jev-<version>`,
   * while TypeSafe's own API publishes `jev-latest` / `jev-preview` and rejects the canonical
   * form. The router keeps one canonical id for callers and translates at the edge.
   */
  wireModel?: string;
  /** Default wire model for the canonical latest build, when `wireModel` is set. */
  wireModelForLatest?: string;
  /** Question primitives the dialect can carry end to end. */
  primitives: readonly DecisionQuestionType[];
  /** Static headers the provider expects in addition to auth. */
  extraHeaders?: Record<string, string>;
  note?: string;
}

/** Newest decision model shipped by TypeSafe; responses may carry a dated build. */
export const LATEST_DECISION_MODEL = 'typesafe/jev-1.14';

/**
 * The model name TypeSafe itself accepts for the newest build.
 *
 * Verified against the live API 2026-11-06: TypeSafe's own catalog lists exactly two models,
 * `jev-latest` and `jev-preview`, and it answers `400 api_usage_error "Unknown model:
 * typesafe/jev-1.14"` for the canonical id the router used to send. The canonical
 * `typesafe/jev-<version>` form is the reseller vocabulary (OpenRouter stamps it), not TypeSafe's.
 * Because the direct API publishes an alias rather than a version, `jev-latest` is also the
 * correct thing to send: it tracks whatever build TypeSafe currently serves, which is exactly the
 * "use the available named Jev version" behaviour a fallback chain wants.
 */
export const TYPESAFE_NATIVE_LATEST_MODEL = 'jev-latest';

/** Env var that overrides a provider's decisions endpoint (tests, staging). */
export function decisionEndpointEnvVar(providerName: string): string {
  return `LOCAL_ROUTER_DECISION_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_URL`;
}

export const DECISION_PROVIDERS: readonly DecisionProviderSpec[] = [
  {
    name: 'typesafe',
    label: 'TypeSafe System One API',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    dialect: 'typesafe',
    modelPattern: /^typesafe\/jev-\d+(?:\.\d+)*$/,
    latestModel: LATEST_DECISION_MODEL,
    // TypeSafe publishes `jev-latest`, not a versioned id: verified live, it rejects
    // `typesafe/jev-1.14` with api_usage_error "Unknown model". Sending the alias also means the
    // direct path follows whatever build TypeSafe serves today without a code change.
    wireModelForLatest: TYPESAFE_NATIVE_LATEST_MODEL,
    primitives: ['noul', 'choice', 'score'],
    note:
      'Direct source of the model: TypeSafe trains Jev. Accepts its own model names (jev-latest, ' +
      'jev-preview) and rejects the versioned reseller id, so the router translates at the edge.'
  },
  {
    name: 'openrouter',
    label: 'OpenRouter Decisions API',
    endpoint: 'https://openrouter.ai/api/alpha/decisions',
    dialect: 'typesafe',
    modelPattern: /^typesafe\/jev-\d+(?:\.\d+)*$/,
    latestModel: LATEST_DECISION_MODEL,
    primitives: ['noul', 'choice', 'score'],
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/nbiish/local-router',
      'X-Title': 'local-router-decisions'
    },
    note: 'Resold path to the same model: accepts the TypeSafe body unchanged.'
  },
  {
    name: 'zenmux',
    label: 'ZenMux Decisions API',
    endpoint: 'https://zenmux.ai/api/v1/decisions',
    dialect: 'zenmux',
    modelPattern: /^typesafe\/jev-\d+(?:\.\d+)*$/,
    latestModel: LATEST_DECISION_MODEL,
    primitives: ['choice', 'score'],
    note: 'Choice/score dialects; noul is derived from a calibrated two-option choice.'
  }
] as const;

/**
 * Default provider preference: the source first, then the resold paths.
 *
 * Ordering the direct API first is what makes the route resilient rather than merely redundant:
 * every other provider is reselling this same model, so if TypeSafe is reachable it is the most
 * current and the least likely to be rate-limited by an intermediary.
 */
export const DEFAULT_DECISION_ORDER: readonly string[] = ['typesafe', 'openrouter', 'zenmux'];

export function decisionProvider(name: string): DecisionProviderSpec | undefined {
  const slug = name.trim().toLowerCase();
  return DECISION_PROVIDERS.find((provider) => provider.name === slug);
}

/** Resolved decisions endpoint, honouring the per-provider override env var. */
export function decisionEndpoint(spec: DecisionProviderSpec): string {
  const override = process.env[decisionEndpointEnvVar(spec.name)];
  const trimmed = typeof override === 'string' ? override.trim() : '';
  return trimmed || spec.endpoint;
}

/** Env var that overrides one provider's decision model id (e.g. a newly released build). */
export function decisionModelEnvVar(providerName: string): string {
  return `LOCAL_ROUTER_DECISION_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_MODEL`;
}

/** Env var that overrides one provider's API key (the name the provider itself documents). */
export function decisionKeyEnvVar(providerName: string): string {
  const known: Record<string, string> = {
    typesafe: 'TYPESAFE_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    zenmux: 'ZENMUX_API_KEY'
  };
  return known[providerName.trim().toLowerCase()] || `${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * The model id a provider should be asked for.
 *
 * Providers do not adopt a new build on the same day: when a Jev release lands, the direct API
 * usually has it first and a reseller follows later. A single global model id would therefore
 * either block the direct path on an older build or send a reseller an id it rejects. This
 * resolves per provider, so each can be pinned or advanced independently without a code change:
 *
 *   LOCAL_ROUTER_DECISION_TYPESAFE_MODEL=typesafe/jev-1.15
 *   LOCAL_ROUTER_DECISION_ZENMUX_MODEL=typesafe/jev-1.14
 *
 * The value is canonicalised, and an unrecognised value is ignored rather than forwarded, so a
 * typo cannot send a non-decision id to a decisions endpoint.
 */
export function decisionModelFor(spec: DecisionProviderSpec): string {
  const override = process.env[decisionModelEnvVar(spec.name)];
  const trimmed = typeof override === 'string' ? override.trim() : '';
  if (trimmed) {
    const canonical = canonicalizeDecisionId(trimmed);
    if (canonical) return canonical;
  }
  return spec.latestModel;
}

/**
 * The model string to put on the wire for this provider.
 *
 * Most providers take the canonical id unchanged. TypeSafe publishes its own names, so the
 * canonical `typesafe/jev-1.14` is translated to `jev-latest` (or, when an operator pins a
 * different build with LOCAL_ROUTER_DECISION_TYPESAFE_MODEL, that build's version suffix, which is
 * the closest native equivalent). This keeps one canonical id for callers and every provider's
 * vocabulary private to that provider.
 */
export function decisionWireModelFor(spec: DecisionProviderSpec): string {
  const canonical = decisionModelFor(spec);
  if (!spec.wireModelForLatest) return canonical;

  // An operator can bypass translation entirely by pinning the exact wire name.
  const override = process.env[decisionModelEnvVar(spec.name)];
  const trimmed = typeof override === 'string' ? override.trim() : '';
  if (trimmed && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed) && !/^typesafe\/jev-/.test(trimmed)) {
    return trimmed;
  }

  if (canonical === spec.latestModel) return spec.wireModelForLatest;
  // A pinned older/newer build: use its native short form (jev-1.15), which TypeSafe accepts for
  // builds it still serves.
  const short = canonical.replace(/^typesafe\//, '');
  return short || spec.wireModelForLatest;
}

/** Effective provider order: env override, then the catalog default. */
export function decisionProviderOrder(): string[] {
  const raw = process.env.LOCAL_ROUTER_DECISION_ORDER;
  const configured = typeof raw === 'string'
    ? raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean)
    : [];
  const known = configured.filter((name) => Boolean(decisionProvider(name)));
  const ordered = [...new Set([...known, ...DEFAULT_DECISION_ORDER])];
  return ordered.filter((name) => Boolean(decisionProvider(name)));
}

export interface ResolvedDecisionModel {
  /** Id the caller sent. */
  requested: string;
  /** Canonical upstream id (`typesafe/jev-1.14`). */
  canonical: string;
  /** Provider pinned by the caller (`openrouter/jev-1.14`), when any. */
  provider?: string;
  /** True when the id is a decision model at all. */
  matched: boolean;
}

/**
 * Canonical decision id, accepting the forms clients actually send:
 *
 *   typesafe/jev-1.14   (canonical; what ainish-rag posts)
 *   jev-1.14 / jev-latest
 *   typesafe/jev-latest
 *   openrouter/jev-1.14        (provider pinned)
 *   zenmux/typesafe/jev-1.14   (provider pinned, canonical body)
 *
 * `openrouter-jev-router` is deliberately NOT matched: it is a chat alias that
 * a general model serves, not a calibrated decision model.
 */
/** Route ids that name a decision chain rather than a specific build. */
const DECISION_ROUTE_ALIASES = new Set(['fallback-decision', 'decisions']);

export function resolveDecisionModel(model: string): ResolvedDecisionModel {
  const requested = typeof model === 'string' ? model.trim() : '';
  const fallback: ResolvedDecisionModel = { requested, canonical: requested, matched: false };
  if (!requested) return fallback;

  let remainder = requested;
  let provider: string | undefined;

  const slash = requested.indexOf('/');
  if (slash > 0) {
    const head = requested.slice(0, slash).toLowerCase();
    if (head === 'local-router') {
      remainder = requested.slice(slash + 1);
    } else if (decisionProvider(head)) {
      provider = head;
      remainder = requested.slice(slash + 1);
    }
  }

  // A route id names the decision chain, not a build. Resolve it to the current canonical model
  // so callers can write `local-router/fallback-decision` and never track Jev versions; the
  // provider failover underneath is unchanged.
  if (!provider && DECISION_ROUTE_ALIASES.has(remainder.toLowerCase())) {
    return { requested, canonical: LATEST_DECISION_MODEL, matched: true };
  }

  const canonical = canonicalizeDecisionId(remainder);
  if (!canonical) return { ...fallback, provider };
  return { requested, canonical, provider, matched: true };
}

/** Maps `jev-1.14` / `typesafe/jev-latest` to a canonical `typesafe/jev-*` id. */
export function canonicalizeDecisionId(id: string): string | null {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (!trimmed) return null;

  const withoutNamespace = trimmed.toLowerCase().startsWith('typesafe/')
    ? trimmed.slice('typesafe/'.length)
    : trimmed;
  if (!/^jev-(?:\d+(?:\.\d+)*|latest)$/i.test(withoutNamespace)) return null;
  if (withoutNamespace.toLowerCase() === 'jev-latest') return LATEST_DECISION_MODEL;
  return `typesafe/${withoutNamespace.toLowerCase()}`;
}

/** True when an id names a decision model rather than a chat alias. */
export function isDecisionModelId(id: string): boolean {
  return resolveDecisionModel(id).matched;
}

/**
 * Providers expected to serve a canonical model, in preference order.
 *
 * A provider whose configured build differs from the requested one is excluded: sending it an id
 * it publishes as unverified is how a chain records a misleading `model_not_supported` and burns a
 * failover step. Providers on the same build, or with no per-provider pin, are candidates.
 */
export function decisionProvidersForModel(canonical: string): DecisionProviderSpec[] {
  const order = decisionProviderOrder();
  return order
    .map((name) => decisionProvider(name))
    .filter((spec): spec is DecisionProviderSpec => {
      if (!spec) return false;
      if (!spec.modelPattern.test(canonical)) return false;
      return decisionModelFor(spec) === canonical;
    });
}

/** Provider-qualified model ids advertised on `/v1/models` for discovery. */
export function advertisedDecisionModels(providers: readonly DecisionProviderSpec[]): Array<{
  provider: string;
  id: string;
  canonical: string;
  display: string;
}> {
  const rows: Array<{ provider: string; id: string; canonical: string; display: string }> = [];
  for (const spec of providers) {
    const short = spec.latestModel.replace(/^typesafe\//, '');
    rows.push({
      provider: spec.name,
      id: `${spec.name}/${short}`,
      canonical: spec.latestModel,
      display: `TypeSafe Jev ${short.replace(/^jev-/, '')} (${spec.name} decisions)`
    });
  }
  return rows;
}
