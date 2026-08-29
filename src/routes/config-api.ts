import express, { Request, Response } from 'express';
import { ThinkingLevel } from '../reasoning';
import { ProxyProvider } from '../types';
import {
  clearOAuthCredentials,
  getOAuthStatus,
  initAntigravityLogin,
  isOAuthProvider,
  startCopilotLogin,
  OAuthProviderId
} from '../oauth-providers';
import { ollamaBackendVersionUrl } from '../ollama-backend';
import { renderProvidersPage } from '../ui/pages/providers';
import { renderFallbackPage } from '../ui/pages/fallback';
import { renderThinkingPage } from '../ui/pages/thinking';
import { renderDiagnosticsPage } from '../ui/pages/diagnostics';
import {
  ProviderSummary,
  CustomProviderRecord,
  FallbackModel,
  FallbackModelParseResult,
  ProviderModel,
  ProviderModelParseResult
} from '../index';
import type { RouterSettings } from '../config-persistence';
import { loadCurationConfigs, loadRouterSettings, saveCurationConfigs, saveRouterSettings } from '../config-persistence';
import { getExpertLogs, importExpertLogs, clearExpertLogs, analyzeLogs } from '../expert-logs';

export interface ConfigApiDeps {
  state: {
    customProviderStore: CustomProviderRecord[];
    thinkingProxyEnabled: boolean;
    waferZdrEnabled: boolean;
    headroomEnabled: boolean;
    headroomProxyUrl: string;
    endpointModelsCache: ProviderModel[];
  };
  keyStore: Record<string, string>;
  fallbackModelStore: Record<string, FallbackModel>;
  thinkingLevelStore: Record<string, ThinkingLevel>;
  
  getProviderSummary: (name: string) => ProviderSummary | undefined;
  setProviderKeyForEnvVar: (envVar: string, val: string) => void;
  persistPqcSecrets: () => void;
  providerSummariesForEnvVar: (envVar: string) => ProviderSummary[];
  DEFAULT_OLLAMA_API_KEY: string;
  clearProviderKeyForProvider: (provider: string) => void;
  modelSourceConfig: {
    source: 'custom' | 'endpoints';
    filterConfigured: boolean;
    curationEnabled: boolean;
    curatedEndpointModelKeys: string[];
    defaultCurationConfig?: string;
  };
  persistModelSourceConfig: () => void;
  canonicalProviderSlug: (name: string) => string;
  isLocalRouterProviderName: (name: string) => boolean;
  filterConfiguredModels: (models: ProviderModel[]) => ProviderModel[];
  ensureOllamaBackend: () => Promise<boolean>;
  queryAllProviderEndpoints: () => Promise<ProviderModel[]>;
  refreshProviderEndpointModels: (providerName: string) => Promise<{
    models: ProviderModel[];
    deselectedCount: number;
    source: 'live' | 'registry' | 'catalog';
    note?: string;
  }>;
  ensureCurationDefaultsForCache: () => void;
  deselectAllProviderCurationKeys: () => number;
  syncKeysFromPqcBundle: (options?: { force?: boolean }) =>
    | { ok: true; loaded: string[]; skipped: string[] }
    | { ok: false; error: string };
  localRouterEnvVarName: (keyEnvVar: string) => string;
  mergeProviderEndpointModels: (providerName: string, models: ProviderModel[]) => void;
  knownProviderModels: (provider: string) => ProviderModel[];
  persistEndpointModelsCache: () => void;
  filterOllamaCloudPullTags: (tags: string[], allowsPro: boolean) => string[];
  effectiveProviderModels: (provider: string) => ProviderModel[];
  ollamaCloudRoutingAllowsPro: () => boolean;
  pullOllamaCloudModels: (tags: string[]) => Promise<void>;
  providerConfigs: () => any[];
  parseProviderCatalogMode: (raw: any) => any;
  catalogModelsForMode: (mode: any) => ProviderModel[];
  providerModelsGroupedByProvider: (models: ProviderModel[]) => Array<{ provider: string; source: string; models: ProviderModel[] }>;
  persistProviderModels: () => void;
  parseSingleProviderModel: (provider: string, payload: any) => ProviderModelParseResult;
  findPresentedNameConflict: (provider: string, name: string) => any;
  parseCustomProviderPayload: (payload: any, options?: any) => any;
  persistCustomProviders: () => void;
  isCustomProvider: (id: string) => boolean;
  providerReferencedInRouting: (id: string) => string[];
  cloneFallbackModel: (model: FallbackModel) => FallbackModel;
  candidateAvailability: (modelName: string) => any;
  parseFallbackModel: (payload: any, options?: { allowShort?: boolean }) => FallbackModelParseResult;
  normalizeFallbackRouteId: (id: string) => string;
  getSessions: () => any[];
  recordFeedback: (sessionId: string, rating: 'up' | 'down') => { ok: boolean; error?: string };
  PORT: number;
  configureVSCodeModelPicker: (baseUrl: string) => any;
  diagnosticsStore: { enabled: boolean; maxEntries: number; entries: any[] };
  pushDiagnostic: (diag: any) => void;
  systemPromptConfig: { enabled: boolean; prompt: string; thinkingLevel: ThinkingLevel };
  persistSystemPrompt: () => void;
  thinkingLevelApiPayload: () => any;
  persistThinkingConfig: () => void;
  persistWaferConfig: () => void;
  waferZdrApiPayload: () => { zdrEnabled: boolean };
  persistHeadroomConfig: () => void;
  headroomApiPayload: () => { enabled: boolean; proxyUrl: string };
  DEFAULT_FALLBACK_MODELS_TEXT: string;
  DEFAULT_CHAIN_OF_DRAFT_PROMPT: string;
  DEFAULT_THINKING_LEVEL: ThinkingLevel;
  activeProviderModelList: () => ProviderModel[];
  cloneProviderModel: (model: ProviderModel) => ProviderModel;
  diagnosticsSnapshot: (limit?: number) => any;
  editableProviderModels: (providerName: string) => ProviderModel[];
  ensureCuratedOverrideSelection: (providerName: string) => void;
  fallbackModelPresentation: (model: FallbackModel) => ProviderModel;
  fallbackPresentedModelId: (model: FallbackModel | string) => string;
  findFallbackModel: (modelName: string) => FallbackModel | undefined;
  findProviderModel: (modelName: string) => ProviderModel | undefined;
  findCatalogModel: (modelName: string) => ProviderModel | undefined;
  modelStore: Record<string, ProviderModel[]>;
  parseProviderModels: (provider: string, payload: any) => ProviderModelParseResult;
  persistFallbackModels: () => void;
  persistedProviderModelOverrides: Set<string>;
  providerModelSource: (providerName: string) => string;
  resolveCatalogModels: (options?: any) => Promise<ProviderModel[]>;
  sanitizeDiagnosticText: (text: string) => string;
  validateFallbackReferences: (model: FallbackModel) => any;
}

export function registerConfigApiRoutes(app: express.Express, deps: ConfigApiDeps): void {
  const {
    state,
    keyStore,
    getProviderSummary,
    setProviderKeyForEnvVar,
    persistPqcSecrets,
    providerSummariesForEnvVar,
    DEFAULT_OLLAMA_API_KEY,
    clearProviderKeyForProvider,
    modelSourceConfig,
    persistModelSourceConfig,
    canonicalProviderSlug,
    isLocalRouterProviderName,
    filterConfiguredModels,
    ensureOllamaBackend,
    queryAllProviderEndpoints,
    refreshProviderEndpointModels,
    ensureCurationDefaultsForCache,
    deselectAllProviderCurationKeys,
    syncKeysFromPqcBundle,
    localRouterEnvVarName,
    mergeProviderEndpointModels,
    knownProviderModels,
    persistEndpointModelsCache,
    filterOllamaCloudPullTags,
    effectiveProviderModels,
    ollamaCloudRoutingAllowsPro,
    pullOllamaCloudModels,
    providerConfigs,
    parseProviderCatalogMode,
    catalogModelsForMode,
    providerModelsGroupedByProvider,
    persistProviderModels,
    parseSingleProviderModel,
    findPresentedNameConflict,
    parseCustomProviderPayload,
    persistCustomProviders,
    isCustomProvider,
    providerReferencedInRouting,
    fallbackModelStore,
    cloneFallbackModel,
    candidateAvailability,
    parseFallbackModel,
    normalizeFallbackRouteId,
    getSessions,
    recordFeedback,
    PORT,
    configureVSCodeModelPicker,
    diagnosticsStore,
    pushDiagnostic,
    systemPromptConfig,
    persistSystemPrompt,
    thinkingLevelApiPayload,
    thinkingLevelStore,
    persistThinkingConfig,
    persistWaferConfig,
    waferZdrApiPayload,
    persistHeadroomConfig,
    headroomApiPayload,
    DEFAULT_FALLBACK_MODELS_TEXT,
    DEFAULT_CHAIN_OF_DRAFT_PROMPT,
    DEFAULT_THINKING_LEVEL,
    activeProviderModelList,
    cloneProviderModel,
    diagnosticsSnapshot,
    editableProviderModels,
    ensureCuratedOverrideSelection,
    fallbackModelPresentation,
    fallbackPresentedModelId,
    findFallbackModel,
    findProviderModel,
    findCatalogModel,
    modelStore,
    parseProviderModels,
    persistFallbackModels,
    persistedProviderModelOverrides,
    providerModelSource,
    resolveCatalogModels,
    sanitizeDiagnosticText,
    validateFallbackReferences
  } = deps;

  app.get('/config', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.redirect('/config/providers');
  });

  app.get('/config/providers', (req: Request, res: Response) => {
    const html = renderProvidersPage({
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    // Config pages are live state (keys, catalog, routes) — never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  app.get('/config/fallback', (req: Request, res: Response) => {
    const html = renderFallbackPage({
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    // Config pages are live state (keys, catalog, routes) — never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  app.get('/config/thinking', (req: Request, res: Response) => {
    const html = renderThinkingPage({
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    // Config pages are live state (keys, catalog, routes) — never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  app.get('/config/diagnostics', (req: Request, res: Response) => {
    const html = renderDiagnosticsPage({
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    // Config pages are live state (keys, catalog, routes) — never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

app.post('/api/keys', async (req: Request, res: Response) => {
  const { provider, apiKey, groq, openrouter } = req.body;

  if (provider !== undefined || apiKey !== undefined) {
    if (typeof provider !== 'string' || typeof apiKey !== 'string') {
      return res.status(400).json({ error: 'provider and apiKey must both be strings.' });
    }

    const providerName = provider.trim();
    const keyValue = apiKey.trim();

    if (!providerName) {
      return res.status(400).json({ error: 'provider is required.' });
    }
    if (!keyValue) {
      return res.status(400).json({ error: 'apiKey is required.' });
    }
    if (keyValue.length > 8192) {
      return res.status(400).json({ error: 'apiKey is too long.' });
    }

    const summary = getProviderSummary(providerName);
    if (!summary) {
      return res.status(400).json({ error: `Unknown provider: ${providerName}` });
    }

    setProviderKeyForEnvVar(summary.keyEnvVar, keyValue);
    persistPqcSecrets();

    // Best-effort live model discovery now that this provider holds a key.
    // OAuth providers authenticate through their own flow and are skipped.
    // Discovery is off-by-default: discovered models arrive toggled off so the
    // operator selects the few they serve (any previous picks are backed up).
    let discovered: { count: number; deselectedCount: number; models: ProviderModel[]; source: string; note?: string } | null = null;
    if (!isOAuthProvider(providerName)) {
      try {
        const { models, deselectedCount, source, note } = await refreshProviderEndpointModels(providerName);
        discovered = { count: models.length, deselectedCount, models, source, note };
      } catch {
        // The key stays saved; discovery can be retried from the provider card.
      }
    }

    return res.json({
      success: true,
      provider: providerName,
      keyEnvVar: summary.keyEnvVar,
      configured: true,
      configuredSource: 'memory',
      sharedProviders: providerSummariesForEnvVar(summary.keyEnvVar).map((entry) => entry.name),
      discovered
    });
  }

  let updatedLegacyProvider = false;
  if (typeof groq === 'string' && groq.trim()) {
    keyStore.groq = groq.trim();
    process.env.GROQ_API_KEY = groq.trim();
    updatedLegacyProvider = true;
  }
  if (typeof openrouter === 'string' && openrouter.trim()) {
    keyStore.openrouter = openrouter.trim();
    process.env.OPENROUTER_API_KEY = openrouter.trim();
    updatedLegacyProvider = true;
  }
  if (updatedLegacyProvider) {
    persistPqcSecrets();
    return res.json({ success: true });
  }

  return res.status(400).json({ error: 'Expected { provider, apiKey } request body.' });
});

app.delete('/api/keys/:provider', (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim();
  if (!providerName) {
    return res.status(400).json({ error: 'provider is required.' });
  }

  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  if (providerName === 'ollama') {
    keyStore.ollama = DEFAULT_OLLAMA_API_KEY;
    process.env.OLLAMA_API_KEY = DEFAULT_OLLAMA_API_KEY;
    persistPqcSecrets();
    return res.json({
      success: true,
      provider: providerName,
      keyEnvVar: summary.keyEnvVar,
      configured: true,
      configuredSource: 'memory',
      placeholder: true,
      defaultKey: DEFAULT_OLLAMA_API_KEY
    });
  }

  clearProviderKeyForProvider(providerName);
  persistPqcSecrets();

  return res.json({
    success: true,
    provider: providerName,
    keyEnvVar: summary.keyEnvVar,
    configured: false,
    configuredSource: 'none',
    sharedProviders: providerSummariesForEnvVar(summary.keyEnvVar).map((entry) => entry.name)
  });
});

// ---------------------------------------------------------------------------
// OAuth provider login endpoints
// ---------------------------------------------------------------------------

app.get('/api/oauth/status/:provider', async (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim().toLowerCase();
  if (!isOAuthProvider(providerName)) {
    return res.status(400).json({ error: `Provider "${providerName}" is not an OAuth provider.` });
  }
  const status = getOAuthStatus(providerName as OAuthProviderId);
  res.json(status);
});

app.post('/api/oauth/login/:provider', async (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim().toLowerCase();
  if (!isOAuthProvider(providerName)) {
    return res.status(400).json({ error: `Provider "${providerName}" is not an OAuth provider.` });
  }

  if (providerName === 'antigravity') {
    try {
      const init = initAntigravityLogin();
      return res.json({
        success: true,
        provider: 'antigravity',
        authType: 'oauth-pkce',
        authUrl: init.authUrl,
        message: 'Open the auth URL in your browser to complete login. The Local Router callback server will capture the authorization code automatically.'
      });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || 'Failed to start Antigravity login.' });
    }
  }

  if (providerName === 'github-copilot') {
    try {
      const init = await startCopilotLogin();
      return res.json({
        success: true,
        provider: 'github-copilot',
        authType: 'oauth-device',
        userCode: init.userCode,
        verificationUri: init.verificationUri,
        expiresAt: init.expiresAt,
        interval: init.interval,
        message: `Enter code ${init.userCode} at ${init.verificationUri}. The server will automatically detect when you complete authorization.`
      });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || 'Failed to start GitHub Copilot login.' });
    }
  }

  return res.status(400).json({ error: `OAuth login not implemented for "${providerName}".` });
});

app.post('/api/oauth/complete/:provider', async (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim().toLowerCase();
  if (!isOAuthProvider(providerName)) {
    return res.status(400).json({ error: `Provider "${providerName}" is not an OAuth provider.` });
  }

  if (providerName === 'antigravity') {
    // The PKCE callback server captures the code and completes login
    // automatically. This endpoint is a manual trigger for headless setups
    // where the caller pastes the full redirect URL back.
    const { redirectUrl } = req.body || {};
    if (!redirectUrl || typeof redirectUrl !== 'string') {
      return res.status(400).json({ error: 'Body must include `redirectUrl` (the full http://127.0.0.1:51121/oauth-callback?code=... URL).' });
    }
    try {
      const url = new URL(redirectUrl);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      if (!code) {
        return res.status(400).json({ error: 'redirectUrl missing `code` query parameter.' });
      }
      // Reconstruct init from the in-memory pending state. We keep the
      // verifier on the module-level pending map by having the caller call
      // `/api/oauth/login/antigravity` first, which sets it up. For now we
      // rely on the local callback server; this endpoint is a fallback.
      return res.status(501).json({ error: 'Headless PKCE completion not yet implemented. Use the browser callback flow.' });
    } catch (error: any) {
      return res.status(400).json({ error: error?.message || 'Invalid redirectUrl.' });
    }
  }

  if (providerName === 'github-copilot') {
    // Device flow polling runs in the background after `/api/oauth/login`
    // is called. This endpoint is just a confirmation/status check for the
    // UI to know the login succeeded or is still pending.
    const status = getOAuthStatus('github-copilot');
    if (status.configured) {
      return res.json({ success: true, provider: 'github-copilot', configured: true, status });
    }
    return res.json({ success: true, provider: 'github-copilot', configured: false, pending: status.pendingDeviceCode ? true : false });
  }

  return res.status(400).json({ error: `OAuth complete not implemented for "${providerName}".` });
});

app.delete('/api/oauth/credentials/:provider', async (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim().toLowerCase();
  if (!isOAuthProvider(providerName)) {
    return res.status(400).json({ error: `Provider "${providerName}" is not an OAuth provider.` });
  }
  clearOAuthCredentials(providerName as OAuthProviderId);
  return res.json({ success: true, provider: providerName, configured: false });
});

app.get('/api/model-source', (req: Request, res: Response) => {
  res.json(modelSourceConfig);
});

app.put('/api/model-source', (req: Request, res: Response) => {
  // The Custom/Endpoint source switch was removed (2026-08-20): the toggle
  // catalog is the only model source. `source` is validated for backward
  // compatibility but normalized to 'endpoints'; only filterConfigured and
  // curation settings still mutate.
  const { source, filterConfigured } = req.body;
  if (source !== undefined && source !== 'custom' && source !== 'endpoints') {
    return res.status(400).json({ error: 'source must be "custom" or "endpoints"' });
  }
  if (typeof filterConfigured === 'boolean') {
    modelSourceConfig.filterConfigured = filterConfigured;
  }
  modelSourceConfig.source = 'endpoints';
  persistModelSourceConfig();
  res.json({ success: true, ...modelSourceConfig });
});

app.get('/api/model-curation', (req: Request, res: Response) => {
  const grouped = providerModelsGroupedByProvider(state.endpointModelsCache);
  res.json({
    source: modelSourceConfig.source,
    curationEnabled: modelSourceConfig.curationEnabled,
    selectedKeys: modelSourceConfig.curatedEndpointModelKeys,
    selectedCount: modelSourceConfig.curatedEndpointModelKeys.length,
    totalModels: state.endpointModelsCache.length,
    data: grouped
  });
});

app.put('/api/model-curation', (req: Request, res: Response) => {
  const { enabled, selectedKeys, activate } = req.body || {};

  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }

  if (activate !== undefined && typeof activate !== 'boolean') {
    return res.status(400).json({ error: 'activate must be a boolean.' });
  }

  // Activation: switch source to endpoints, enable curation, and pre-check
  // every cached model that already exists in the curated toggle-store catalog.
  if (activate === true) {
    if (state.endpointModelsCache.length === 0) {
      return res.status(409).json({ error: 'No endpoint models cached yet — refresh providers first.' });
    }
    modelSourceConfig.source = 'endpoints';
    modelSourceConfig.curationEnabled = true;
    ensureCurationDefaultsForCache();
  }

  if (selectedKeys !== undefined) {
    if (!Array.isArray(selectedKeys)) {
      return res.status(400).json({ error: 'selectedKeys must be an array of "provider::model" strings.' });
    }
    const invalidEntry = selectedKeys.find((key: unknown) => typeof key !== 'string' || !key.includes('::'));
    if (invalidEntry !== undefined) {
      return res.status(400).json({ error: 'selectedKeys entries must be "provider::model" strings.' });
    }
    modelSourceConfig.curatedEndpointModelKeys = Array.from(new Set(
      selectedKeys.map((key: string) => key.trim()).filter(Boolean)
    )).slice(0, 5000);
  }

  // Curation cannot be disabled in the single-catalog regime (2026-08-20):
  // the toggle selection IS the catalog. `enabled: false` is ignored.
  modelSourceConfig.curationEnabled = true;

  persistModelSourceConfig();

  return res.json({
    success: true,
    curationEnabled: modelSourceConfig.curationEnabled,
    selectedCount: modelSourceConfig.curatedEndpointModelKeys.length,
    selectedKeys: modelSourceConfig.curatedEndpointModelKeys
  });
});

const MAX_CURATED_ENDPOINT_MODEL_KEYS = 5000;

// ── Named Curation Configs ──────────────────────────────────────────────────

function parseCurationConfigName(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, 128) : '';
}

function parseCurationConfigKeys(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const keys = raw
    .map((key: unknown) => String(key || '').trim())
    .filter((key: string) => key.length > 0 && key.includes('::'));
  return Array.from(new Set(keys)).slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
}

app.get('/api/curation-configs', (req: Request, res: Response) => {
  const defaultName = typeof modelSourceConfig.defaultCurationConfig === 'string'
    ? modelSourceConfig.defaultCurationConfig
    : '';
  res.json({
    data: loadCurationConfigs().map((config) => ({
      name: config.name,
      count: config.selectedKeys.length,
      updatedAt: config.updatedAt || null,
      isDefault: config.name === defaultName
    }))
  });
});

app.post('/api/curation-configs', (req: Request, res: Response) => {
  const name = parseCurationConfigName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: 'name is required.' });
  }
  const selectedKeys = parseCurationConfigKeys(req.body?.selectedKeys);
  if (!selectedKeys) {
    return res.status(400).json({ error: 'selectedKeys must be an array of "provider::model" strings.' });
  }
  const configs = loadCurationConfigs();
  const existing = configs.find((config) => config.name === name);
  const record = { name, selectedKeys, updatedAt: new Date().toISOString() };
  if (existing) {
    configs[configs.indexOf(existing)] = record;
  } else {
    configs.push(record);
  }
  try {
    saveCurationConfigs(configs);
  } catch (error: unknown) {
    return res.status(500).json({
      error: 'Failed to persist curation config.',
      details: sanitizeDiagnosticText(String(error instanceof Error ? error.message : error))
    });
  }
  return res.json({ success: true, config: { name, count: selectedKeys.length } });
});

app.post('/api/curation-configs/load', (req: Request, res: Response) => {
  const name = parseCurationConfigName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: 'name is required.' });
  }
  const config = loadCurationConfigs().find((entry) => entry.name === name);
  if (!config) {
    return res.status(404).json({ error: `Curation config not found: ${name}` });
  }
  modelSourceConfig.source = 'endpoints';
  modelSourceConfig.curationEnabled = true;
  modelSourceConfig.curatedEndpointModelKeys = Array.from(new Set(config.selectedKeys))
    .slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
  try {
    persistModelSourceConfig();
  } catch (error: unknown) {
    return res.status(500).json({
      error: 'Failed to apply curation config.',
      details: sanitizeDiagnosticText(String(error instanceof Error ? error.message : error))
    });
  }
  return res.json({
    success: true,
    name,
    selectedCount: modelSourceConfig.curatedEndpointModelKeys.length,
    selectedKeys: modelSourceConfig.curatedEndpointModelKeys
  });
});

app.put('/api/curation-configs/default', (req: Request, res: Response) => {
  const raw = req.body?.name;
  const name = parseCurationConfigName(raw);
  if (!name) {
    delete modelSourceConfig.defaultCurationConfig;
  } else if (!loadCurationConfigs().some((entry) => entry.name === name)) {
    return res.status(404).json({ error: `Curation config not found: ${name}` });
  } else {
    modelSourceConfig.defaultCurationConfig = name;
  }
  try {
    persistModelSourceConfig();
  } catch (error: unknown) {
    return res.status(500).json({
      error: 'Failed to update default curation config.',
      details: sanitizeDiagnosticText(String(error instanceof Error ? error.message : error))
    });
  }
  return res.json({ success: true, defaultCurationConfig: name || null });
});

app.delete('/api/curation-configs', (req: Request, res: Response) => {
  const name = parseCurationConfigName(req.body?.name);
  if (!name) {
    return res.status(400).json({ error: 'name is required.' });
  }
  const configs = loadCurationConfigs();
  if (!configs.some((entry) => entry.name === name)) {
    return res.status(404).json({ error: `Curation config not found: ${name}` });
  }
  try {
    saveCurationConfigs(configs.filter((entry) => entry.name !== name));
  } catch (error: unknown) {
    return res.status(500).json({
      error: 'Failed to delete curation config.',
      details: sanitizeDiagnosticText(String(error instanceof Error ? error.message : error))
    });
  }
  if (modelSourceConfig.defaultCurationConfig === name) {
    delete modelSourceConfig.defaultCurationConfig;
    try {
      persistModelSourceConfig();
    } catch (error: unknown) {
      return res.status(500).json({
        error: 'Deleted config, but failed to clear its default marker.',
        details: sanitizeDiagnosticText(String(error instanceof Error ? error.message : error))
      });
    }
  }
  return res.json({ success: true, removed: name });
});

app.post('/api/provider-models/:provider/refresh', async (req: Request, res: Response) => {
  const providerName = canonicalProviderSlug(String(req.params.provider || '').trim());
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  try {
    const { models, deselectedCount, source, note } = await refreshProviderEndpointModels(providerName);
    return res.json({ success: true, provider: providerName, count: models.length, deselectedCount, source, note, data: models });
  } catch (error: any) {
    return res.status(502).json({ error: error?.message || 'Failed to refresh provider models' });
  }
});

app.post('/api/refresh-endpoint-models', async (req: Request, res: Response) => {
  try {
    await ensureOllamaBackend();
    const fetchedModels = await queryAllProviderEndpoints();
    // Per-provider section merge (2026-08-22): a provider whose fetch threw
    // contributes NO rows and keeps its existing cache section — refresh-all
    // must never destroy a section it failed to reach. Registry fallbacks
    // (returned with source 'catalog') merge normally.
    const fetchedProviders = Array.from(new Set(fetchedModels.map((model) => model.provider)));
    let mergedCount = 0;
    for (const providerName of fetchedProviders) {
      const section = fetchedModels.filter((model) => model.provider === providerName);
      mergeProviderEndpointModels(providerName, section);
      mergedCount += section.length;
    }
    persistEndpointModelsCache();
    // Off-by-default (2026-08-22): Refresh All repopulates the toggle store
    // and turns every refreshed provider's models OFF (selections backed up);
    // the operator re-checks the few models they serve per provider.
    const deselectedCount = deselectAllProviderCurationKeys();
    const ollamaTags = filterOllamaCloudPullTags(
      effectiveProviderModels('ollama').map((model) => model.model),
      ollamaCloudRoutingAllowsPro()
    );
    void pullOllamaCloudModels(ollamaTags);
    res.json({ success: true, count: mergedCount, deselectedCount, data: fetchedModels });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to refresh endpoint models' });
  }
});

app.post('/api/pqc-resync', (req: Request, res: Response) => {
  const force = req.body?.force === true;
  const result = syncKeysFromPqcBundle({ force });
  if (result.ok) {
    console.log(`[PQC] Resync loaded ${result.loaded.length} provider key(s) from bundle: ${result.loaded.join(', ')}`);
    return res.json({ success: true, resynced: true, loaded: result.loaded, skipped: result.skipped });
  }
  if (result.error === 'cooldown') {
    return res.json({ success: true, resynced: false, reason: 'cooldown' });
  }
  return res.status(502).json({ success: false, error: result.error });
});

app.get('/api/provider-configs', (req: Request, res: Response) => {
  res.json({ object: 'list', data: providerConfigs() });
});

app.get('/api/provider-models', (req: Request, res: Response) => {
  const catalog = parseProviderCatalogMode(req.query.catalog);
  const models = catalogModelsForMode(catalog);
  const providers = providerModelsGroupedByProvider(models);

  res.json({
    object: 'list',
    catalog,
    modelSource: modelSourceConfig.source,
    endpointCacheCount: state.endpointModelsCache.length,
    data: providers
  });
});

app.get('/api/provider-models/:provider', async (req: Request, res: Response) => {
  const providerName = canonicalProviderSlug(String(req.params.provider || '').trim());
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  // Management view: every known model for the provider (off-by-default
  // curation can leave the serving subset empty while the catalog is known).
  const models = isLocalRouterProviderName(providerName)
    ? await resolveCatalogModels({ provider: providerName })
    : knownProviderModels(providerName);

  return res.json({
    provider: providerName,
    source: providerModelSource(providerName),
    catalogMode: modelSourceConfig.source,
    models
  });
});

app.put('/api/provider-models/:provider', (req: Request, res: Response) => {
  const providerName = canonicalProviderSlug(String(req.params.provider || '').trim());
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  const parsed = parseProviderModels(providerName, req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  const conflictingModel = parsed.models.find((model) => findPresentedNameConflict(providerName, model.id));
  if (conflictingModel) {
    return res.status(400).json({ error: `Presented model name already exists: ${conflictingModel.id}` });
  }

  modelStore[providerName] = parsed.models.map((model) => cloneProviderModel(model));
  persistedProviderModelOverrides.add(providerName);
  persistProviderModels();
  ensureCuratedOverrideSelection(providerName);
  return res.json({
    success: true,
    provider: providerName,
    source: 'memory',
    models: parsed.models
  });
});

app.post('/api/provider-models/:provider/models', (req: Request, res: Response) => {
  const providerName = canonicalProviderSlug(String(req.params.provider || '').trim());
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  const parsed = parseSingleProviderModel(providerName, req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const nextModel = parsed.models[0];
  const conflictingModel = findPresentedNameConflict(providerName, nextModel.id);
  if (conflictingModel) {
    return res.status(400).json({ error: `Presented model name already exists: ${nextModel.id}` });
  }

  const editable = editableProviderModels(providerName);
  const existingIndex = editable.findIndex((model) => (
    model.id === nextModel.id || model.model === nextModel.model
  ));
  if (existingIndex >= 0) {
    editable[existingIndex] = cloneProviderModel(nextModel);
  } else {
    editable.push(cloneProviderModel(nextModel));
  }
  persistProviderModels();
  ensureCuratedOverrideSelection(providerName);

  return res.json({
    success: true,
    provider: providerName,
    source: 'memory',
    model: nextModel,
    models: effectiveProviderModels(providerName)
  });
});

app.delete('/api/provider-models/:provider/models/:modelId', (req: Request, res: Response) => {
  const providerName = canonicalProviderSlug(String(req.params.provider || '').trim());
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  const modelId = String(req.params.modelId || '').trim();
  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required.' });
  }

  const editable = editableProviderModels(providerName);
  const previousCount = editable.length;
  modelStore[providerName] = editable.filter((model) => (
    model.id !== modelId && model.model !== modelId
  ));
  if (modelStore[providerName].length === previousCount) {
    return res.status(404).json({ error: `Model not found for provider ${providerName}: ${modelId}` });
  }
  persistProviderModels();

  return res.json({
    success: true,
    provider: providerName,
    source: 'memory',
    removed: modelId,
    models: effectiveProviderModels(providerName)
  });
});

app.delete('/api/provider-models/:provider', (req: Request, res: Response) => {
  const providerName = canonicalProviderSlug(String(req.params.provider || '').trim());
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  delete modelStore[providerName];
  persistedProviderModelOverrides.delete(providerName);
  persistProviderModels();
  return res.json({
    success: true,
    provider: providerName,
    source: providerModelSource(providerName),
    models: effectiveProviderModels(providerName),
    resetTo: isCustomProvider(providerName) ? 'custom-empty' : 'baseline'
  });
});

const PROXY_ENDPOINTS_DOCUMENTATION = {
  proxyBaseUrl: 'http://127.0.0.1:11434',
  clientEndpoints: [
    { method: 'POST', path: '/v1/chat/completions', role: 'Primary OpenAI-compatible inference' },
    { method: 'GET', path: '/v1/models', role: 'OpenAI model discovery' },
    { method: 'GET', path: '/api/tags', role: 'Ollama model discovery' },
    { method: 'POST', path: '/api/show', role: 'Ollama model metadata' },
    { method: 'POST', path: '/api/chat', role: 'Ollama chat (translated to chat completions)' },
    { method: 'POST', path: '/api/generate', role: 'Ollama generate (translated to chat completions)' },
    { method: 'POST', path: '/v1/responses', role: 'Codex Responses API shim' },
    { method: 'POST', path: '/v1/messages', role: 'Anthropic Messages API shim' },
    { method: 'GET', path: '/', role: 'Ollama presence probe' },
    { method: 'GET', path: '/api/version', role: 'Ollama version probe' }
  ],
  modelIdFormat: '{providerSlug}/{presentedAliasOrUpstreamId}',
  upstreamRequirements: {
    baseUrl: 'HTTPS URL ending in /v1',
    chatCompletions: 'POST {baseUrl}/chat/completions with Authorization: Bearer <key>',
    modelsDiscovery: 'GET {baseUrl}/models (optional)'
  }
};

app.get('/api/proxy-endpoints', (_req: Request, res: Response) => {
  res.json(PROXY_ENDPOINTS_DOCUMENTATION);
});

app.post('/api/providers', (req: Request, res: Response) => {
  const parsed = parseCustomProviderPayload(req.body, { requireName: true });
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  if (state.customProviderStore.some((entry) => entry.name === parsed.record.name)) {
    return res.status(409).json({ error: `Custom provider "${parsed.record.name}" already exists.` });
  }

  state.customProviderStore.push(parsed.record);
  state.customProviderStore.sort((a, b) => a.name.localeCompare(b.name));
  persistCustomProviders();

  return res.status(201).json({
    success: true,
    provider: {
      ...parsed.record,
      source: 'custom',
      isCustom: true
    }
  });
});

app.put('/api/providers/:id', (req: Request, res: Response) => {
  const providerId = String(req.params.id || '').trim().toLowerCase();
  if (!isCustomProvider(providerId)) {
    return res.status(404).json({ error: `Custom provider not found: ${providerId}` });
  }

  const parsed = parseCustomProviderPayload(
    { ...req.body, name: providerId },
    { requireName: false, existingName: providerId }
  );
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  const index = state.customProviderStore.findIndex((entry) => entry.name === providerId);
  if (index < 0) {
    return res.status(404).json({ error: `Custom provider not found: ${providerId}` });
  }

  state.customProviderStore[index] = parsed.record;
  persistCustomProviders();

  return res.json({
    success: true,
    provider: {
      ...parsed.record,
      source: 'custom',
      isCustom: true
    }
  });
});

app.delete('/api/providers/:id', (req: Request, res: Response) => {
  const providerId = String(req.params.id || '').trim().toLowerCase();
  if (!isCustomProvider(providerId)) {
    return res.status(404).json({ error: `Custom provider not found: ${providerId}` });
  }

  const references = providerReferencedInRouting(providerId);
  if (references.length > 0) {
    return res.status(409).json({
      error: `Cannot delete provider "${providerId}" while referenced by routing.`,
      references
    });
  }

  state.customProviderStore = state.customProviderStore.filter((entry) => entry.name !== providerId);
  persistCustomProviders();

  const unsetKey = String(req.query.unsetKey || '').toLowerCase() === 'true';
  if (unsetKey) {
    const summary = getProviderSummary(providerId);
    if (summary) {
      delete keyStore[providerId];
      delete process.env[localRouterEnvVarName(summary.keyEnvVar)];
      persistPqcSecrets();
    }
  }

  delete modelStore[providerId];
  persistProviderModels();

  return res.json({
    success: true,
    provider: providerId,
    removed: true,
    keyUnset: unsetKey
  });
});

// Per-chain-member configuration summary (context size, output budget,
// capability flags, catalog knowledge, key/readiness status) so config UIs
// can show exactly which models and configurations back each
// local-router/<chain> route without N secondary lookups.
function fallbackChainDetails(route: FallbackModel) {
  return (Array.isArray(route.models) ? route.models : []).map((modelId) => {
    const catalogModel = findCatalogModel(modelId);
    const servedModel = findProviderModel(modelId);
    const info = servedModel || catalogModel;
    const availability = candidateAvailability(modelId);
    return {
      id: modelId,
      known: Boolean(catalogModel),
      served: Boolean(servedModel),
      provider: info?.provider || availability?.provider || null,
      contextLength: info?.contextLength ?? null,
      outputTokens: info?.outputTokens ?? null,
      supportsTools: info?.supportsTools ?? null,
      supportsVision: info?.supportsImages ?? null,
      supportsCache: info?.supportsCache ?? null,
      supportsReasoning: info?.supportsReasoning ?? null,
      status: availability?.status || 'unavailable'
    };
  });
}

app.get('/api/fallback-models', (req: Request, res: Response) => {
  const data = Object.values(fallbackModelStore)
    .map((model) => {
      const cloned = cloneFallbackModel(model);
      return {
        ...cloned,
        id: fallbackPresentedModelId(model),
        routeId: normalizeFallbackRouteId(model.id),
        display: fallbackModelPresentation(model).display,
        chainDetails: fallbackChainDetails(model)
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return res.json({ object: 'list', data });
});

app.get('/api/routing/availability', (req: Request, res: Response) => {
  const raw = typeof req.query.models === 'string' ? req.query.models : '';
  const models = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const data = models.map((modelName) => candidateAvailability(modelName));
  return res.json({ object: 'list', data });
});

app.post('/api/fallback-models', (req: Request, res: Response) => {
  const rawId = typeof req.body?.id === 'string' ? req.body.id.trim() : '';
  const id = normalizeFallbackRouteId(rawId);
  const isExistingRoute = Boolean(id && fallbackModelStore[id]);
  const parsed = parseFallbackModel(req.body, { allowShort: isExistingRoute || req.body?.allowShort === true });
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  const canonicalFallbackId = fallbackPresentedModelId(parsed.model);
  const sameIdAsProvider = activeProviderModelList().some((model) => (
    model.id === parsed.model.id || model.id === canonicalFallbackId
  ));
  if (sameIdAsProvider) {
    return res.status(400).json({ error: `Fallback model id already exists in provider catalog: ${canonicalFallbackId}` });
  }

  const referenceCheck = validateFallbackReferences(parsed.model);
  if (!referenceCheck.ok) {
    return res.status(400).json({ error: referenceCheck.error });
  }

  const previousModel = fallbackModelStore[parsed.model.id]
    ? cloneFallbackModel(fallbackModelStore[parsed.model.id])
    : null;
  fallbackModelStore[parsed.model.id] = cloneFallbackModel(parsed.model);

  try {
    persistFallbackModels();
  } catch (error: any) {
    if (previousModel) {
      fallbackModelStore[previousModel.id] = previousModel;
    } else {
      delete fallbackModelStore[parsed.model.id];
    }
    return res.status(500).json({
      error: 'Failed to persist fallback route.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({
    success: true,
    persisted: true,
    model: {
      ...cloneFallbackModel(fallbackModelStore[parsed.model.id]),
      id: fallbackPresentedModelId(parsed.model),
      routeId: parsed.model.id,
      display: fallbackModelPresentation(parsed.model).display
    }
  });
});

app.delete('/api/fallback-models', (req: Request, res: Response) => {
  const id = normalizeFallbackRouteId(typeof req.body?.id === 'string' ? req.body.id : '');
  if (!id) {
    return res.status(400).json({ error: 'Fallback model id is required.' });
  }

  if (!fallbackModelStore[id]) {
    return res.status(404).json({ error: `Fallback model not found: ${id}` });
  }

  const previousModel = cloneFallbackModel(fallbackModelStore[id]);
  delete fallbackModelStore[id];
  try {
    persistFallbackModels();
  } catch (error: any) {
    fallbackModelStore[id] = previousModel;
    return res.status(500).json({
      error: 'Failed to persist fallback route removal.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({ success: true, persisted: true, removed: fallbackPresentedModelId(id), routeId: id });
});

app.post('/api/fallback-chain/toggle', (req: Request, res: Response) => {
  const body = req.body || {};
  const modelId = typeof body.modelId === 'string' ? body.modelId.trim() : '';
  const enabled = body.enabled;

  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required.' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }
  if (!findCatalogModel(modelId)) {
    return res.status(400).json({ error: `Unknown model: ${modelId}` });
  }

  const SYSTEM_CHAIN_ROUTE_ID = 'fallback-models';
  const routeId = typeof body.routeId === 'string' && body.routeId.trim()
    ? body.routeId.trim()
    : SYSTEM_CHAIN_ROUTE_ID;
  const previousRoute = fallbackModelStore[routeId]
    ? cloneFallbackModel(fallbackModelStore[routeId])
    : null;
  if (!previousRoute && routeId !== SYSTEM_CHAIN_ROUTE_ID) {
    return res.status(404).json({ error: `Fallback route not found: ${routeId}` });
  }

  const route = previousRoute
    ? cloneFallbackModel(previousRoute)
    : ({ id: routeId, models: [], disabledModels: [] } as FallbackModel);
  if (!Array.isArray(route.models)) route.models = [];
  if (!Array.isArray(route.disabledModels)) route.disabledModels = [];

  const inChain = route.models.includes(modelId);
  if (enabled && !inChain) {
    route.models.push(modelId);
  } else if (!enabled && inChain) {
    route.models = route.models.filter((entry) => entry !== modelId);
    route.disabledModels = route.disabledModels.filter((entry) => entry !== modelId);
  } else {
    return res.json({
      success: true,
      persisted: false,
      route: { id: route.id, models: [...route.models], disabledModels: [...route.disabledModels] }
    });
  }

  fallbackModelStore[routeId] = route;
  try {
    persistFallbackModels();
  } catch (error: any) {
    if (previousRoute) {
      fallbackModelStore[routeId] = previousRoute;
    } else {
      delete fallbackModelStore[routeId];
    }
    return res.status(500).json({
      error: 'Failed to persist fallback chain.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({
    success: true,
    persisted: true,
    route: { id: route.id, models: [...route.models], disabledModels: [...route.disabledModels] }
  });
});

app.post('/api/fallback-chain/reorder', (req: Request, res: Response) => {
  const body = req.body || {};
  const orderedIds = body.orderedIds;

  if (!Array.isArray(orderedIds)
    || orderedIds.length === 0
    || orderedIds.some((entry) => typeof entry !== 'string' || !entry.trim())
    || new Set(orderedIds).size !== orderedIds.length) {
    return res.status(400).json({ error: 'orderedIds must be an array of non-empty unique model id strings.' });
  }

  const routeId = typeof body.routeId === 'string' && body.routeId.trim()
    ? body.routeId.trim()
    : 'fallback-models';
  const route = fallbackModelStore[routeId];
  if (!route) {
    return res.status(404).json({ error: `Fallback route not found: ${routeId}` });
  }
  const currentModels = Array.isArray(route.models) ? route.models : [];
  if (orderedIds.length !== currentModels.length
    || !orderedIds.every((entry: string) => currentModels.includes(entry))) {
    return res.status(409).json({ error: 'orderedIds must contain exactly the current chain models.' });
  }

  const previousRoute = cloneFallbackModel(route);
  const updated = cloneFallbackModel(route);
  updated.models = orderedIds.map((entry: string) => entry.trim());
  fallbackModelStore[routeId] = updated;

  try {
    persistFallbackModels();
  } catch (error: any) {
    fallbackModelStore[routeId] = previousRoute;
    return res.status(500).json({
      error: 'Failed to persist fallback chain order.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({
    success: true,
    persisted: true,
    route: { id: updated.id, models: [...updated.models], disabledModels: [...(updated.disabledModels || [])] }
  });
});

app.get('/api/router-settings', (req: Request, res: Response) => {
  const settings = loadRouterSettings();
  let fallbackText = settings.fallbackModelsText || '';
  const sysRoute = fallbackModelStore['fallback-models'];
  if (sysRoute && Array.isArray(sysRoute.models)) {
    const disabled = new Set(Array.isArray(sysRoute.disabledModels) ? sysRoute.disabledModels : []);
    fallbackText = sysRoute.models.map((m) => (disabled.has(m) ? `${m} disabled` : m)).join('\n');
  }
  const routes = Object.values(fallbackModelStore).map((model) => cloneFallbackModel(model));
  return res.json({
    fallbackModelsText: fallbackText,
    routes
  });
});

app.put('/api/router-settings', (req: Request, res: Response) => {
  const body = req.body || {};
  const settings: RouterSettings = {};

  if (Array.isArray(body.routes)) {
    for (const routeEntry of body.routes) {
      const parsed = parseFallbackModel(routeEntry, { allowShort: true });
      if (parsed.ok) {
        fallbackModelStore[parsed.model.id] = cloneFallbackModel(parsed.model);
      }
    }
  }

  if (typeof body.fallbackModelsText === 'string') {
    settings.fallbackModelsText = body.fallbackModelsText;
    const parsed = parseFallbackModel({ id: 'fallback-models', modelsText: body.fallbackModelsText }, { allowShort: true });
    if (parsed.ok) {
      fallbackModelStore['fallback-models'] = cloneFallbackModel(parsed.model);
    }
  }

  try {
    persistFallbackModels();
    saveRouterSettings(settings);
  } catch (error: any) {
    return res.status(500).json({
      error: 'Failed to persist router settings.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({ success: true, settings });
});

app.delete('/api/router-settings', (req: Request, res: Response) => {
  fallbackModelStore['fallback-models'] = {
    id: 'fallback-models',
    models: []
  };
  try {
    persistFallbackModels();
    saveRouterSettings({});
  } catch (error: any) {
    return res.status(500).json({
      error: 'Failed to reset router settings.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({ success: true });
});

// ── Expert Logs Tracking ──
app.get('/api/logs', (req: Request, res: Response) => {
  return res.json({ logs: getExpertLogs() });
});

app.get('/api/logs/export', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="expert-logs.json"');
  return res.json(getExpertLogs());
});

app.post('/api/logs/import', (req: Request, res: Response) => {
  const payload: unknown = req.body;
  const result = importExpertLogs(payload);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  return res.json({ success: true, count: result.count });
});

app.delete('/api/logs', (req: Request, res: Response) => {
  clearExpertLogs();
  return res.json({ success: true });
});

app.get('/api/logs/analyze', (req: Request, res: Response) => {
  return res.json(analyzeLogs());
});

// ── Session Tracking ──
app.get('/api/sessions', (req: Request, res: Response) => {
  return res.json({ sessions: getSessions() });
});

app.post('/api/sessions/:id/feedback', (req: Request, res: Response) => {
  const rawSid = req.params.id;
  const sessionId = typeof rawSid === 'string' ? rawSid : Array.isArray(rawSid) ? rawSid[0] : '';
  const rawRating: unknown = req.body?.rating;
  if (typeof rawRating !== 'string' || (rawRating !== 'up' && rawRating !== 'down')) {
    return res.status(400).json({ error: 'Rating must be "up" or "down".' });
  }
  const rating = rawRating as 'up' | 'down';
  const result = recordFeedback(sessionId, rating);
  if (!result.ok) {
    return res.status(404).json({ error: result.error });
  }
  return res.json({ success: true });
});

app.post('/api/vscode/configure', (req: Request, res: Response) => {
  try {
    const host = req.get('host') || `localhost:${PORT}`;
    const protocol = req.protocol || 'http';
    const configured = configureVSCodeModelPicker(`${protocol}://${host}`);
    return res.json({ success: true, ...configured });
  } catch (error: any) {
    return res.status(500).json({
      error: 'Failed to configure VS Code model picker.',
      details: error?.message || String(error)
    });
  }
});

app.get('/api/diagnostics', (req: Request, res: Response) => {
  const limitRaw = Number.parseInt(String(req.query.limit || ''), 10);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, diagnosticsStore.maxEntries)
    : 120;

  return res.json(diagnosticsSnapshot(limit));
});

app.put('/api/diagnostics', (req: Request, res: Response) => {
  if (typeof req.body?.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }

  diagnosticsStore.enabled = req.body.enabled;
  pushDiagnostic({
    event: 'diagnostics_toggle',
    route: '/api/diagnostics',
    data: { enabled: diagnosticsStore.enabled }
  });

  return res.json(diagnosticsSnapshot(40));
});

app.delete('/api/diagnostics', (req: Request, res: Response) => {
  const cleared = diagnosticsStore.entries.length;
  diagnosticsStore.entries = [];
  pushDiagnostic({
    event: 'diagnostics_clear',
    route: '/api/diagnostics',
    data: { cleared }
  });

  return res.json({ success: true, cleared });
});
// ── System Prompt ──
app.get('/api/system-prompt', (req: Request, res: Response) => {
  return res.json({
    enabled: systemPromptConfig.enabled,
    prompt: systemPromptConfig.prompt,
    defaultPrompt: DEFAULT_CHAIN_OF_DRAFT_PROMPT,
    thinkingLevel: systemPromptConfig.thinkingLevel,
    defaultThinkingLevel: DEFAULT_THINKING_LEVEL
  });
});
app.put('/api/system-prompt', (req: Request, res: Response) => {
  const { enabled, prompt, thinkingLevel } = req.body ?? {};
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }
  if (prompt !== undefined) {
    if (typeof prompt !== 'string') {
      return res.status(400).json({ error: 'prompt must be a string.' });
    }
    systemPromptConfig.prompt = prompt.trim() || DEFAULT_CHAIN_OF_DRAFT_PROMPT;
  }
  if (thinkingLevel !== undefined) {
    return res.status(400).json({
      error: 'thinkingLevel is configured via PUT /api/thinking-level (use { global: "<level>" }).'
    });
  }
  if (enabled !== undefined) {
    systemPromptConfig.enabled = enabled;
  }
  persistSystemPrompt();
  return res.json({
    enabled: systemPromptConfig.enabled,
    prompt: systemPromptConfig.prompt,
    defaultPrompt: DEFAULT_CHAIN_OF_DRAFT_PROMPT,
    thinkingLevel: systemPromptConfig.thinkingLevel,
    defaultThinkingLevel: DEFAULT_THINKING_LEVEL
  });
});

// ── Thinking Level API ─────────────────────────────────────────────────────
app.get('/api/thinking-level', (req: Request, res: Response) => {
  res.json(thinkingLevelApiPayload());
});

app.put('/api/thinking-level', (req: Request, res: Response) => {
  const { enabled, global: globalLevel, provider, level } = req.body ?? {};

  const validLevels: ThinkingLevel[] = ['none', 'low', 'medium', 'high', 'xhigh'];

  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled must be a boolean.' });
    }
    state.thinkingProxyEnabled = enabled;
  }

  if (globalLevel !== undefined) {
    if (!validLevels.includes(globalLevel)) {
      return res.status(400).json({ error: `Invalid thinking level: ${globalLevel}. Must be one of: ${validLevels.join(', ')}` });
    }
    systemPromptConfig.thinkingLevel = globalLevel;
  }

  if (provider !== undefined && level !== undefined) {
    if (typeof provider !== 'string' || !provider.trim()) {
      return res.status(400).json({ error: 'provider must be a non-empty string.' });
    }
    if (!validLevels.includes(level)) {
      return res.status(400).json({ error: `Invalid thinking level: ${level}. Must be one of: ${validLevels.join(', ')}` });
    }
    const summary = getProviderSummary(provider);
    if (!summary) {
      return res.status(404).json({ error: `Unknown provider: ${provider}` });
    }
    thinkingLevelStore[provider] = level;
  }

  persistThinkingConfig();
  return res.json(thinkingLevelApiPayload());
});

app.delete('/api/thinking-level/:provider', (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim();
  if (!providerName) {
    return res.status(400).json({ error: 'provider is required.' });
  }
  delete thinkingLevelStore[providerName];
  persistThinkingConfig();
  return res.json(thinkingLevelApiPayload());
});

// ── Wafer AI ZDR Config API ────────────────────────────────────────────────
app.get('/api/wafer-config', (req: Request, res: Response) => {
  return res.json(waferZdrApiPayload());
});

app.put('/api/wafer-config', (req: Request, res: Response) => {
  if (typeof req.body?.zdrEnabled !== 'boolean') {
    return res.status(400).json({ error: 'zdrEnabled must be a boolean.' });
  }
  state.waferZdrEnabled = req.body.zdrEnabled;
  persistWaferConfig();
  return res.json(waferZdrApiPayload());
});

// ── Headroom Compression Config API ────────────────────────────────────────
app.get('/api/headroom-config', (req: Request, res: Response) => {
  return res.json(headroomApiPayload());
});

app.put('/api/headroom-config', (req: Request, res: Response) => {
  if (req.body?.enabled !== undefined && typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be a boolean.' });
  }
  if (req.body?.proxyUrl !== undefined && typeof req.body.proxyUrl !== 'string') {
    return res.status(400).json({ error: 'proxyUrl must be a string.' });
  }
  if (typeof req.body?.enabled === 'boolean') {
    state.headroomEnabled = req.body.enabled;
  }
  if (typeof req.body?.proxyUrl === 'string' && req.body.proxyUrl.trim()) {
    state.headroomProxyUrl = req.body.proxyUrl.trim();
  }
  persistHeadroomConfig();
  return res.json(headroomApiPayload());
});

// IDE version-probe compatibility (VS Code Copilot Chat requires ollama >=
// 0.6.4): report the real backend ollama's version when it is reachable so
// clients always see a true, current version. An explicit OLLAMA_VERSION env
// override still wins (legacy operator knob); the 0.6.4 floor is the last
// resort so a probe failure never degrades the response below the IDE
// minimum. Never fail: this endpoint must answer 200 JSON fast, because
// clients translate any transport/parse failure into the "Unable to verify
// Ollama server version" error.
const DEFAULT_OLLAMA_VERSION = '0.6.4';
const OLLAMA_VERSION_CACHE_MS = 30_000;
let mirroredOllamaVersion: { value: string; fetchedAt: number } | null = null;

async function currentOllamaVersion(): Promise<string> {
  const envOverride = String(process.env.OLLAMA_VERSION || '').trim();
  if (envOverride) return envOverride;
  if (mirroredOllamaVersion && Date.now() - mirroredOllamaVersion.fetchedAt < OLLAMA_VERSION_CACHE_MS) {
    return mirroredOllamaVersion.value;
  }
  try {
    const probe = await fetch(ollamaBackendVersionUrl(), { signal: AbortSignal.timeout(1000) });
    const parsed = await probe.json().catch(() => ({})) as { version?: unknown };
    const version = typeof parsed?.version === 'string' ? parsed.version.trim() : '';
    if (version) {
      mirroredOllamaVersion = { value: version, fetchedAt: Date.now() };
      return version;
    }
  } catch {
    // Backend offline or slow — fall through to the minimum floor.
  }
  return DEFAULT_OLLAMA_VERSION;
}

app.head('/api/version', (req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/api/version', async (req: Request, res: Response) => {
  res.json({ version: await currentOllamaVersion() });
});

}
