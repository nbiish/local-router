import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Managed `pi` CLI wiring (`~/.pi/agent/models.json`).
 *
 * `pi` resolves custom OpenAI-compatible endpoints from `providers.<name>` in
 * `models.json`. Adding a `local-router` provider entry pointing at loopback
 * `http://127.0.0.1:<port>/v1` with the placeholder `"local-router"` apiKey
 * lets `pi --model local-router/fallback-models` (and any configured route/model)
 * resolve cleanly on Windows, macOS, and Linux without touching other providers
 * or overwriting existing keys.
 */

export const PI_PROVIDER_ID = 'local-router';
export const PI_DEFAULT_MODEL = 'local-router/fallback-models';

export type PiProviderState = 'present' | 'missing' | 'stale' | 'invalid';

export type PiHarnessState = {
  dir: string;
  modelsPath: string;
  providerState: PiProviderState;
  baseUrl: string | null;
  models: string[];
  hasFallbackRoute: boolean;
};

export type PiSyncResult = {
  ok: boolean;
  enabled: boolean;
  modelsPath: string;
  changed: boolean;
  error?: string;
};

export function piAgentDir(override?: string): string {
  const explicit = (override || process.env.PI_CODING_AGENT_DIR || '').trim();
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.pi', 'agent');
}

export function piModelsPath(override?: string): string {
  return path.join(piAgentDir(override), 'models.json');
}

export function isLoopbackUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function normalizeLoopbackV1(baseUrl: string): string {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed || !isLoopbackUrl(trimmed)) {
    throw new Error(`pi local-router baseUrl must be a loopback URL, got: ${trimmed || '(empty)'}`);
  }
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
}

function validateModelId(model: string): string {
  const clean = String(model || '').trim();
  if (!clean || clean.length > 200 || /[\r\n]/.test(clean)) {
    throw new Error('pi model must be a single non-empty model id (200 chars max).');
  }
  return clean;
}

function buildPiModelSpec(id: string) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: 1050000,
    maxTokens: 131072,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null
    }
  };
}

export function readPiHarnessState(opts?: { piAgentDir?: string; baseUrl?: string }): PiHarnessState {
  const dir = piAgentDir(opts?.piAgentDir);
  const modelsPath = path.join(dir, 'models.json');
  const expectedV1 = opts?.baseUrl ? `${opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1` : null;

  if (!fs.existsSync(modelsPath)) {
    return {
      dir,
      modelsPath,
      providerState: 'missing',
      baseUrl: null,
      models: [],
      hasFallbackRoute: false
    };
  }

  try {
    const raw = fs.readFileSync(modelsPath, 'utf8');
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { dir, modelsPath, providerState: 'invalid', baseUrl: null, models: [], hasFallbackRoute: false };
    }
    const providers = (parsed as Record<string, any>).providers;
    const entry = providers && typeof providers === 'object' ? providers[PI_PROVIDER_ID] : null;
    if (!entry || typeof entry !== 'object') {
      return { dir, modelsPath, providerState: 'missing', baseUrl: null, models: [], hasFallbackRoute: false };
    }
    const entryBaseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : null;
    const models = Array.isArray(entry.models)
      ? entry.models
          .map((m: any) => (m && typeof m.id === 'string' ? m.id.trim() : ''))
          .filter(Boolean)
      : [];
    const hasFallbackRoute = models.includes(PI_DEFAULT_MODEL);
    const baseOk = Boolean(entryBaseUrl && isLoopbackUrl(entryBaseUrl) && (!expectedV1 || entryBaseUrl.replace(/\/+$/, '') === expectedV1));
    const providerState: PiProviderState = baseOk && models.length > 0 ? 'present' : 'stale';

    return {
      dir,
      modelsPath,
      providerState,
      baseUrl: entryBaseUrl,
      models,
      hasFallbackRoute
    };
  } catch {
    return {
      dir,
      modelsPath,
      providerState: 'invalid',
      baseUrl: null,
      models: [],
      hasFallbackRoute: false
    };
  }
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS ignores POSIX mode bits; safe to ignore.
  }
}

/**
 * Reconcile `~/.pi/agent/models.json` with Local Router's `pi` harness toggle.
 * Preserves every non-`local-router` provider in `models.json`.
 */
export function syncPiHarnessConfig(opts: {
  enabled: boolean;
  model: string;
  baseUrl: string;
  piAgentDir?: string;
}): PiSyncResult {
  const dir = piAgentDir(opts.piAgentDir);
  const modelsPath = path.join(dir, 'models.json');
  const result: PiSyncResult = {
    ok: true,
    enabled: Boolean(opts.enabled),
    modelsPath,
    changed: false
  };

  try {
    if (!opts.enabled) {
      if (!fs.existsSync(modelsPath)) return result;
      const raw = fs.readFileSync(modelsPath, 'utf8');
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return result;
      }
      const doc = parsed as Record<string, any>;
      if (!doc.providers || typeof doc.providers !== 'object' || !Object.prototype.hasOwnProperty.call(doc.providers, PI_PROVIDER_ID)) {
        return result;
      }
      delete doc.providers[PI_PROVIDER_ID];
      writeJsonAtomic(modelsPath, doc);
      result.changed = true;
      return result;
    }

    const model = validateModelId(opts.model);
    const v1BaseUrl = normalizeLoopbackV1(opts.baseUrl);

    let doc: Record<string, any> = {};
    if (fs.existsSync(modelsPath)) {
      const raw = fs.readFileSync(modelsPath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { ...result, ok: false, error: `${modelsPath} is not a JSON object.` };
        }
        doc = parsed as Record<string, any>;
      }
    }

    if (!doc.providers || typeof doc.providers !== 'object' || Array.isArray(doc.providers)) {
      doc.providers = {};
    }

    const desiredIds = model === PI_DEFAULT_MODEL ? [model] : [model, PI_DEFAULT_MODEL];
    const nextProvider = {
      baseUrl: v1BaseUrl,
      api: 'openai-completions',
      apiKey: 'local-router',
      models: desiredIds.map((id) => buildPiModelSpec(id))
    };

    const existingJson = JSON.stringify(doc.providers[PI_PROVIDER_ID] ?? null);
    const nextJson = JSON.stringify(nextProvider);
    if (existingJson !== nextJson) {
      doc.providers[PI_PROVIDER_ID] = nextProvider;
      writeJsonAtomic(modelsPath, doc);
      result.changed = true;
    }

    return result;
  } catch (error: any) {
    return {
      ...result,
      ok: false,
      error: error?.message || String(error)
    };
  }
}
