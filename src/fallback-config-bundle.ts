/**
 * Portable fallback-chain bundle (`local-router-fallback/v1`).
 *
 * The chain's authoritative home is `router-settings.json` (checkout-root,
 * gitignored, boot-authoritative). This module is the boundary for moving just
 * that chain between machines: it serialises a strict, versioned subset and
 * validates any incoming file before it is allowed near the write path.
 *
 * Two properties are deliberate:
 *  - No credentials, catalog selection, or provider config travel. Keys live in
 *    per-machine PQC identities and cannot be copied as files.
 *  - Every rejection is deterministic code, and error messages never echo
 *    untrusted input back into logs or the UI.
 */

import type { RouterSettings } from './config-persistence';

export const FALLBACK_BUNDLE_SCHEMA = 'local-router-fallback/v1' as const;
export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const MAX_CHAIN_LINES = 200;
export const MAX_ROUTES = 50;
export const MAX_MODELS_PER_ROUTE = 100;
export const MAX_ID_LENGTH = 256;

const DISABLED_SUFFIX = ' disabled';
// Deliberately permissive for real model ids, but excludes whitespace, control
// characters, quotes and shell/markup metacharacters.
const MODEL_ID_RE = /^[A-Za-z0-9._:/@+=~-]+$/;
const TOP_LEVEL_KEYS = ['schema', 'exportedAt', 'fallbackModelsText', 'routes'];
const ROUTE_KEYS = ['id', 'models', 'disabledModels'];

export type PortableRoute = {
  id: string;
  models: string[];
  disabledModels?: string[];
};

export type FallbackBundle = {
  schema: typeof FALLBACK_BUNDLE_SCHEMA;
  exportedAt: string;
  fallbackModelsText: string;
  routes: PortableRoute[];
};

export type BundleParseResult =
  | { ok: true; bundle: FallbackBundle }
  | { ok: false; error: string };

export type ChainChange = {
  chainAdded: string[];
  chainRemoved: string[];
  orderChanged: boolean;
  routesAdded: string[];
  routesRemoved: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKnownKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isValidModelId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID_LENGTH
    && MODEL_ID_RE.test(value);
}

/** Parse the advanced textarea form: one model per line, ` disabled` suffix. */
export function parseChainText(text: string): Array<{ model: string; enabled: boolean }> {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const disabled = line.endsWith(DISABLED_SUFFIX);
      const model = disabled ? line.slice(0, -DISABLED_SUFFIX.length).trim() : line;
      return { model, enabled: !disabled };
    });
}

function normaliseText(text: string): string {
  return parseChainText(text)
    .map((entry) => (entry.enabled ? entry.model : `${entry.model}${DISABLED_SUFFIX}`))
    .join('\n');
}

/** Build an export bundle from the current authoritative settings. */
export function buildFallbackBundle(settings: RouterSettings): FallbackBundle {
  const routes: PortableRoute[] = (Array.isArray(settings.routes) ? settings.routes : [])
    .filter((route): route is NonNullable<RouterSettings['routes']>[number] =>
      Boolean(route) && typeof route.id === 'string' && Array.isArray(route.models))
    .map((route) => {
      const out: PortableRoute = {
        id: route.id,
        models: route.models.map((model) => String(model))
      };
      if (Array.isArray(route.disabledModels)) {
        out.disabledModels = route.disabledModels.map((model) => String(model));
      }
      return out;
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    schema: FALLBACK_BUNDLE_SCHEMA,
    exportedAt: new Date().toISOString(),
    fallbackModelsText: normaliseText(settings.fallbackModelsText || ''),
    routes
  };
}

export function serializeFallbackBundle(bundle: FallbackBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function fail(error: string): BundleParseResult {
  return { ok: false, error };
}

/**
 * Validate an incoming bundle. Fails closed on any malformed, oversized,
 * unknown-field, or control-character input; never throws.
 */
export function parseFallbackBundle(raw: string): BundleParseResult {
  if (typeof raw !== 'string') return fail('Config must be text.');
  if (raw.length > MAX_BUNDLE_BYTES * 2) return fail('Config is too large.');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BUNDLE_BYTES) return fail('Config is too large.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail('Config is not valid JSON.');
  }
  if (!isRecord(parsed)) return fail('Config must be a JSON object.');
  if (!onlyKnownKeys(parsed, TOP_LEVEL_KEYS)) return fail('Config has unsupported fields.');
  if (parsed.schema !== FALLBACK_BUNDLE_SCHEMA) {
    return fail(`Unsupported schema; expected ${FALLBACK_BUNDLE_SCHEMA}.`);
  }
  if (typeof parsed.exportedAt !== 'string' || parsed.exportedAt.length > 64) {
    return fail('Config has an invalid export timestamp.');
  }
  if (typeof parsed.fallbackModelsText !== 'string') {
    return fail('Config is missing the fallback chain text.');
  }

  const chain = parseChainText(parsed.fallbackModelsText);
  if (chain.length > MAX_CHAIN_LINES) return fail('Config chain has too many steps.');
  for (const entry of chain) {
    if (!isValidModelId(entry.model)) return fail('Config chain contains an invalid model id.');
  }

  if (!Array.isArray(parsed.routes)) return fail('Config is missing the route list.');
  if (parsed.routes.length > MAX_ROUTES) return fail('Config has too many routes.');

  const routes: PortableRoute[] = [];
  const seen = new Set<string>();
  for (const rawRoute of parsed.routes) {
    if (!isRecord(rawRoute)) return fail('Config contains an invalid route.');
    if (!onlyKnownKeys(rawRoute, ROUTE_KEYS)) return fail('Config route has unsupported fields.');
    if (!isValidModelId(rawRoute.id)) return fail('Config contains an invalid route id.');
    if (seen.has(rawRoute.id)) return fail('Config contains duplicate route ids.');
    seen.add(rawRoute.id);
    if (!Array.isArray(rawRoute.models) || rawRoute.models.length > MAX_MODELS_PER_ROUTE) {
      return fail('Config route has an invalid model list.');
    }
    if (!rawRoute.models.every(isValidModelId)) return fail('Config route has an invalid model id.');
    const route: PortableRoute = { id: rawRoute.id, models: rawRoute.models.slice() };
    if (rawRoute.disabledModels !== undefined) {
      if (!Array.isArray(rawRoute.disabledModels)
        || rawRoute.disabledModels.length > MAX_MODELS_PER_ROUTE
        || !rawRoute.disabledModels.every(isValidModelId)) {
        return fail('Config route has an invalid disabled-model list.');
      }
      route.disabledModels = rawRoute.disabledModels.slice();
    }
    routes.push(route);
  }
  routes.sort((a, b) => a.id.localeCompare(b.id));

  return {
    ok: true,
    bundle: {
      schema: FALLBACK_BUNDLE_SCHEMA,
      exportedAt: parsed.exportedAt,
      fallbackModelsText: normaliseText(parsed.fallbackModelsText),
      routes
    }
  };
}

/** The only shape the write path accepts from an imported bundle. */
export function bundleToRouterSettings(bundle: FallbackBundle): RouterSettings {
  return {
    fallbackModelsText: bundle.fallbackModelsText,
    routes: bundle.routes.map((route) => ({
      id: route.id,
      models: [...route.models],
      ...(route.disabledModels ? { disabledModels: [...route.disabledModels] } : {})
    }))
  };
}

/** Human-readable, set-based diff for the import preview. */
export function describeChainChange(current: RouterSettings, next: RouterSettings): ChainChange {
  const currentChain = parseChainText(current.fallbackModelsText || '').map((entry) => entry.model);
  const nextChain = parseChainText(next.fallbackModelsText || '').map((entry) => entry.model);
  const currentSet = new Set(currentChain);
  const nextSet = new Set(nextChain);
  const currentRoutes = new Set((current.routes || []).map((route) => route.id));
  const nextRoutes = new Set((next.routes || []).map((route) => route.id));
  return {
    chainAdded: nextChain.filter((model) => !currentSet.has(model)),
    chainRemoved: currentChain.filter((model) => !nextSet.has(model)),
    orderChanged: currentChain.length === nextChain.length
      && currentChain.some((model, index) => model !== nextChain[index]),
    routesAdded: [...nextRoutes].filter((id) => !currentRoutes.has(id)),
    routesRemoved: [...currentRoutes].filter((id) => !nextRoutes.has(id))
  };
}
