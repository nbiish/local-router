import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
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
import { renderProvidersPage } from '../ui/pages/providers';
import { renderFallbackPage } from '../ui/pages/fallback';
import { renderRoutersPage } from '../ui/pages/routers';
import { renderThinkingPage } from '../ui/pages/thinking';
import { renderPricingPage } from '../ui/pages/pricing';
import { renderDiagnosticsPage } from '../ui/pages/diagnostics';
import {
  ProviderSummary,
  CustomProviderRecord,
  FallbackModel,
  RouterModel,
  RouterModelParseResult,
  FallbackModelParseResult,
  ProviderModel,
  ProviderModelParseResult
} from '../index';
import type { RouterSettings } from '../config-persistence';
import { loadRouterSettings, saveRouterSettings } from '../config-persistence';
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
  routerModelStore: Record<string, RouterModel>;
  thinkingLevelStore: Record<string, ThinkingLevel>;
  
  getProviderSummary: (name: string) => ProviderSummary | undefined;
  setProviderKeyForEnvVar: (envVar: string, val: string) => void;
  persistPqcSecrets: () => void;
  providerSummariesForEnvVar: (envVar: string) => ProviderSummary[];
  DEFAULT_OLLAMA_API_KEY: string;
  clearProviderKeyForProvider: (provider: string) => void;
  modelSourceConfig: { source: 'custom' | 'endpoints'; filterConfigured: boolean };
  persistModelSourceConfig: () => void;
  filterConfiguredModels: (models: ProviderModel[]) => ProviderModel[];
  ensureOllamaBackend: () => Promise<boolean>;
  queryAllProviderEndpoints: () => Promise<ProviderModel[]>;
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
  cloneRouterModel: (model: RouterModel) => RouterModel;
  candidateAvailability: (modelName: string) => any;
  parseRouterModel: (payload: any) => RouterModelParseResult;
  getProviderPricingSnapshot: () => any;
  upsertProviderPricingEntry: (modelId: string, entry: any) => any;
  deleteProviderPricingEntry: (modelId: string) => void;
  normalizeRouterRouteId: (id: string) => string;
  DEFAULT_ROUTER_ID: string;
  buildDefaultAutoLocalRouterModel: () => RouterModel | null;
  existingPath: (a: string, b: string) => string;
  ROUTER_EVENTS_PATH: string;
  LEGACY_ROUTER_EVENTS_PATH: string;
  parseFallbackModel: (payload: any) => FallbackModelParseResult;
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
  resolvedDefaultAutoRouterCandidatesText: () => string;
  DEFAULT_CHAIN_OF_DRAFT_PROMPT: string;
  DEFAULT_THINKING_LEVEL: ThinkingLevel;
  activeProviderModelList: () => ProviderModel[];
  applyPricingToRouterCandidates: (candidates: any[]) => any[];
  cloneProviderModel: (model: ProviderModel) => ProviderModel;
  computeTiers: (candidateModels: string[], eventsPath: string) => Array<{ model: string; tier: string; derankReasons?: string[] }>;
  csvEscape: (val: any) => string;
  diagnosticsSnapshot: (limit?: number) => any;
  editableProviderModels: (providerName: string) => ProviderModel[];
  fallbackModelPresentation: (model: FallbackModel) => ProviderModel;
  fallbackPresentedModelId: (model: FallbackModel | string) => string;
  findFallbackModel: (modelName: string) => FallbackModel | undefined;
  findProviderModel: (modelName: string) => ProviderModel | undefined;
  findRouterModel: (modelName: string) => RouterModel | undefined;
  modelStore: Record<string, ProviderModel[]>;
  parseCsvLine: (line: string) => string[];
  parseProviderModels: (provider: string, payload: any) => ProviderModelParseResult;
  persistFallbackModels: () => void;
  persistRouterModels: () => void;
  persistedProviderModelOverrides: Set<string>;
  providerModelSource: (providerName: string) => string;
  refreshRouterModelsPricing: () => void;
  resolveCatalogModels: (options?: any) => Promise<ProviderModel[]>;
  routerModelPresentation: (model: RouterModel) => ProviderModel;
  routerPresentedModelId: (model: RouterModel | string) => string;
  sanitizeDiagnosticText: (text: string) => string;
  selectRouterCandidate: (router: RouterModel, body: any) => { error: string; candidateScores?: any[] } | { selected: { model: string }; orderedCandidates: { model: string }[]; candidateScores: any[] };
  validateFallbackReferences: (model: FallbackModel) => any;
  validateRouterReferences: (model: RouterModel) => any;
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
    filterConfiguredModels,
    ensureOllamaBackend,
    queryAllProviderEndpoints,
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
    routerModelStore,
    cloneRouterModel,
    candidateAvailability,
    parseRouterModel,
    getProviderPricingSnapshot,
    upsertProviderPricingEntry,
    deleteProviderPricingEntry,
    normalizeRouterRouteId,
    DEFAULT_ROUTER_ID,
    buildDefaultAutoLocalRouterModel,
    existingPath,
    ROUTER_EVENTS_PATH,
    LEGACY_ROUTER_EVENTS_PATH,
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
    resolvedDefaultAutoRouterCandidatesText,
    DEFAULT_CHAIN_OF_DRAFT_PROMPT,
    DEFAULT_THINKING_LEVEL,
    activeProviderModelList,
    applyPricingToRouterCandidates,
    cloneProviderModel,
    computeTiers,
    csvEscape,
    diagnosticsSnapshot,
    editableProviderModels,
    fallbackModelPresentation,
    fallbackPresentedModelId,
    findFallbackModel,
    findProviderModel,
    findRouterModel,
    modelStore,
    parseCsvLine,
    parseProviderModels,
    persistFallbackModels,
    persistRouterModels,
    persistedProviderModelOverrides,
    providerModelSource,
    refreshRouterModelsPricing,
    resolveCatalogModels,
    routerModelPresentation,
    routerPresentedModelId,
    sanitizeDiagnosticText,
    selectRouterCandidate,
    validateFallbackReferences,
    validateRouterReferences
  } = deps;

  app.get('/config', (req: Request, res: Response) => {
    res.redirect('/config/providers');
  });

  app.get('/config/providers', (req: Request, res: Response) => {
    const html = renderProvidersPage({
      defaultRouterId: DEFAULT_ROUTER_ID,
      defaultRouterCandidatesText: resolvedDefaultAutoRouterCandidatesText(),
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    res.send(html);
  });

  app.get('/config/fallback', (req: Request, res: Response) => {
    const html = renderFallbackPage({
      defaultRouterId: DEFAULT_ROUTER_ID,
      defaultRouterCandidatesText: resolvedDefaultAutoRouterCandidatesText(),
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    res.send(html);
  });

  app.get('/config/routers', (req: Request, res: Response) => {
    const html = renderRoutersPage({
      defaultRouterId: DEFAULT_ROUTER_ID,
      defaultRouterCandidatesText: resolvedDefaultAutoRouterCandidatesText(),
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    res.send(html);
  });

  app.get('/config/thinking', (req: Request, res: Response) => {
    const html = renderThinkingPage({
      defaultRouterId: DEFAULT_ROUTER_ID,
      defaultRouterCandidatesText: resolvedDefaultAutoRouterCandidatesText(),
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    res.send(html);
  });

  app.get('/config/pricing', (req: Request, res: Response) => {
    const html = renderPricingPage({
      defaultRouterId: DEFAULT_ROUTER_ID,
      defaultRouterCandidatesText: resolvedDefaultAutoRouterCandidatesText(),
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    res.send(html);
  });

  app.get('/config/diagnostics', (req: Request, res: Response) => {
    const html = renderDiagnosticsPage({
      defaultRouterId: DEFAULT_ROUTER_ID,
      defaultRouterCandidatesText: resolvedDefaultAutoRouterCandidatesText(),
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    res.send(html);
  });

app.post('/api/keys', (req: Request, res: Response) => {
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
    return res.json({
      success: true,
      provider: providerName,
      keyEnvVar: summary.keyEnvVar,
      configured: true,
      configuredSource: 'memory',
      sharedProviders: providerSummariesForEnvVar(summary.keyEnvVar).map((entry) => entry.name)
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
  const { source, filterConfigured } = req.body;
  if (source !== undefined && source !== 'custom' && source !== 'endpoints') {
    return res.status(400).json({ error: 'source must be "custom" or "endpoints"' });
  }
  if (source !== undefined) {
    modelSourceConfig.source = source;
  }
  if (typeof filterConfigured === 'boolean') {
    modelSourceConfig.filterConfigured = filterConfigured;
  }
  persistModelSourceConfig();
  res.json({ success: true, ...modelSourceConfig });
});

app.post('/api/refresh-endpoint-models', async (req: Request, res: Response) => {
  try {
    await ensureOllamaBackend();
    const fetchedModels = await queryAllProviderEndpoints();
    state.endpointModelsCache = fetchedModels;
    persistEndpointModelsCache();
    const ollamaTags = filterOllamaCloudPullTags(
      effectiveProviderModels('ollama').map((model) => model.model),
      ollamaCloudRoutingAllowsPro()
    );
    void pullOllamaCloudModels(ollamaTags);
    res.json({ success: true, count: state.endpointModelsCache.length, data: state.endpointModelsCache });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to refresh endpoint models' });
  }
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
  const providerName = String(req.params.provider || '').trim();
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  const models = await resolveCatalogModels({ provider: providerName });

  return res.json({
    provider: providerName,
    source: providerModelSource(providerName),
    catalogMode: modelSourceConfig.source,
    models
  });
});

app.put('/api/provider-models/:provider', (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim();
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
  return res.json({
    success: true,
    provider: providerName,
    source: 'memory',
    models: parsed.models
  });
});

app.post('/api/provider-models/:provider/models', (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim();
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

  return res.json({
    success: true,
    provider: providerName,
    source: 'memory',
    model: nextModel,
    models: effectiveProviderModels(providerName)
  });
});

app.delete('/api/provider-models/:provider/models/:modelId', (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim();
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
  const providerName = String(req.params.provider || '').trim();
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
      delete process.env[summary.keyEnvVar];
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

app.get('/api/fallback-models', (req: Request, res: Response) => {
  const data = Object.values(fallbackModelStore)
    .map((model) => {
      const cloned = cloneFallbackModel(model);
      return {
        ...cloned,
        id: fallbackPresentedModelId(model),
        routeId: normalizeFallbackRouteId(model.id),
        display: fallbackModelPresentation(model).display
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  return res.json({ object: 'list', data });
});

app.get('/api/router-models', (req: Request, res: Response) => {
  const data = Object.values(routerModelStore)
    .map((model) => ({
      ...cloneRouterModel(model),
      id: routerPresentedModelId(model),
      routeId: normalizeRouterRouteId(model.id),
      display: routerModelPresentation(model).display
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return res.json({ object: 'list', data });
});

app.get('/api/routing/availability', (req: Request, res: Response) => {
  const raw = typeof req.query.models === 'string' ? req.query.models : '';
  const models = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
  const data = models.map((modelName) => candidateAvailability(modelName));
  return res.json({ object: 'list', data });
});

app.post('/api/router-models', (req: Request, res: Response) => {
  const parsed = parseRouterModel(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  const canonicalRouterId = routerPresentedModelId(parsed.model);
  const sameIdAsProvider = activeProviderModelList().some((model) => (
    model.id === parsed.model.id || model.id === canonicalRouterId
  ));
  if (sameIdAsProvider || findFallbackModel(parsed.model.id)) {
    return res.status(400).json({ error: `Router model id already exists: ${canonicalRouterId}` });
  }

  const referenceCheck = validateRouterReferences(parsed.model);
  if (!referenceCheck.ok) {
    return res.status(400).json({ error: referenceCheck.error });
  }

  const previousModel = routerModelStore[parsed.model.id]
    ? cloneRouterModel(routerModelStore[parsed.model.id])
    : null;
  const modelToStore = cloneRouterModel(parsed.model);
  modelToStore.candidates = applyPricingToRouterCandidates(modelToStore.candidates);
  routerModelStore[parsed.model.id] = modelToStore;

  try {
    persistRouterModels();
  } catch (error: any) {
    if (previousModel) {
      routerModelStore[previousModel.id] = previousModel;
    } else {
      delete routerModelStore[parsed.model.id];
    }
    return res.status(500).json({
      error: 'Failed to persist router model.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({
    success: true,
    persisted: true,
    model: {
      ...cloneRouterModel(routerModelStore[parsed.model.id]),
      id: routerPresentedModelId(parsed.model),
      routeId: parsed.model.id,
      display: routerModelPresentation(parsed.model).display
    }
  });
});

app.get('/api/provider-pricing', (req: Request, res: Response) => {
  return res.json(getProviderPricingSnapshot());
});

app.put('/api/provider-pricing/:modelId', (req: Request, res: Response) => {
  const modelId = String(req.params.modelId || '').trim();
  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required.' });
  }
  try {
    const entry = upsertProviderPricingEntry(modelId, {
      inputPricePerM: req.body?.inputPricePerM,
      outputPricePerM: req.body?.outputPricePerM,
      label: req.body?.label,
      validUntil: req.body?.validUntil,
      sourceUrl: req.body?.sourceUrl
    });
    refreshRouterModelsPricing();
    return res.json({ success: true, modelId, entry });
  } catch (error: any) {
    return res.status(400).json({ error: error?.message || 'Invalid pricing payload.' });
  }
});

app.delete('/api/provider-pricing/:modelId', (req: Request, res: Response) => {
  const modelId = String(req.params.modelId || '').trim();
  if (!modelId) {
    return res.status(400).json({ error: 'modelId is required.' });
  }
  const removed = deleteProviderPricingEntry(modelId);
  refreshRouterModelsPricing();
  return res.json({ success: true, modelId, removed });
});

app.post('/api/router-models/reset-defaults', (req: Request, res: Response) => {
  const targetId = normalizeRouterRouteId(
    typeof req.body?.id === 'string' && req.body.id.trim() ? req.body.id : DEFAULT_ROUTER_ID
  );
  if (targetId !== DEFAULT_ROUTER_ID) {
    return res.status(400).json({
      error: `Only ${DEFAULT_ROUTER_ID} can be reset via this endpoint. Use POST /api/router-models for other routers.`
    });
  }

  const defaultRouter = buildDefaultAutoLocalRouterModel();
  if (!defaultRouter) {
    return res.status(500).json({ error: 'Failed to build default auto-local router profile.' });
  }

  routerModelStore[DEFAULT_ROUTER_ID] = cloneRouterModel(defaultRouter);
  try {
    persistRouterModels();
  } catch (error: any) {
    delete routerModelStore[DEFAULT_ROUTER_ID];
    return res.status(500).json({
      error: 'Failed to persist default router reset.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({
    success: true,
    routeId: DEFAULT_ROUTER_ID,
    candidateCount: defaultRouter.candidates.length,
    model: {
      ...cloneRouterModel(routerModelStore[DEFAULT_ROUTER_ID]),
      id: routerPresentedModelId(defaultRouter),
      routeId: DEFAULT_ROUTER_ID,
      display: routerModelPresentation(defaultRouter).display
    }
  });
});

app.delete('/api/router-models', (req: Request, res: Response) => {
  const id = normalizeRouterRouteId(typeof req.body?.id === 'string' ? req.body.id : '');
  if (!id) {
    return res.status(400).json({ error: 'Router model id is required.' });
  }

  if (!routerModelStore[id]) {
    return res.status(404).json({ error: `Router model not found: ${id}` });
  }

  const previousModel = cloneRouterModel(routerModelStore[id]);
  delete routerModelStore[id];
  try {
    persistRouterModels();
  } catch (error: any) {
    routerModelStore[id] = previousModel;
    return res.status(500).json({
      error: 'Failed to persist router model removal.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }

  return res.json({ success: true, persisted: true, removed: routerPresentedModelId(id), routeId: id });
});

app.get('/api/router-events.csv', (req: Request, res: Response) => {
  res.type('text/csv');
  const eventsPath = existingPath(ROUTER_EVENTS_PATH, LEGACY_ROUTER_EVENTS_PATH);
  if (!fs.existsSync(eventsPath)) {
    return res.send('timestamp,router_id,presented_model,router_type,selected_model,status,duration_ms,candidate_latency_ms,stream,requires_tools,requires_images,code_density,language_count,multi_turn_depth,instruction_length,coding_task,approx_input_tokens,requested_output_tokens,tool_calls_requested,tool_calls_valid,reward_signal,prompt_hash,candidate_scores,error_type\n');
  }
  return res.send(fs.readFileSync(eventsPath, 'utf8'));
});

app.post('/api/router-models/:id/dry-run', (req: Request, res: Response) => {
  const routerId = normalizeRouterRouteId(String(req.params.id || ''));
  if (!routerId || !routerModelStore[routerId]) {
    return res.status(404).json({ error: `Router model not found: ${routerId || '(empty)'}` });
  }

  const router = routerModelStore[routerId];
  const decision = selectRouterCandidate(router, req.body || {});

  if ('error' in decision) {
    return res.json({
      router: {
        id: routerPresentedModelId(router),
        routeId: router.id,
        type: router.type
      },
      eligible: false,
      error: decision.error,
      candidateScores: decision.candidateScores
    });
  }

  return res.json({
    router: {
      id: routerPresentedModelId(router),
      routeId: router.id,
      type: router.type,
      explorationBudget: router.explorationBudget,
      costQualityTradeoff: router.costQualityTradeoff
    },
    eligible: true,
    selected: decision.selected.model,
    orderedCandidates: decision.orderedCandidates.map((candidate) => candidate.model),
    candidateScores: decision.candidateScores
  });
});

app.post('/api/router-models/:id/recompute', (req: Request, res: Response) => {
  const routerId = normalizeRouterRouteId(String(req.params.id || ''));
  if (!routerId || !routerModelStore[routerId]) {
    return res.status(404).json({ error: `Router model not found: ${routerId || '(empty)'}` });
  }

  const router = routerModelStore[routerId];
  const eventsPath = existingPath(ROUTER_EVENTS_PATH, LEGACY_ROUTER_EVENTS_PATH);

  if (!fs.existsSync(eventsPath)) {
    return res.json({
      router: { id: routerPresentedModelId(router), routeId: router.id, type: router.type },
      message: 'No telemetry data available yet. Make requests through this router to accumulate data.',
      proposals: [],
      sampleCount: 0
    });
  }

  const csvText = fs.readFileSync(eventsPath, 'utf8');
  const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    return res.json({
      router: { id: routerPresentedModelId(router), routeId: router.id, type: router.type },
      message: 'Telemetry file is empty (header only).',
      proposals: [],
      sampleCount: 0
    });
  }

  const headerLine = lines[0];
  const headers = headerLine.split(',').map((h) => h.trim());
  const routerIdIndex = headers.indexOf('router_id');
  const selectedModelIndex = headers.indexOf('selected_model');
  const statusIndex = headers.indexOf('status');
  const durationIndex = headers.indexOf('duration_ms');
  const candidateLatencyIndex = headers.indexOf('candidate_latency_ms');
  const toolCallsRequestedIndex = headers.indexOf('tool_calls_requested');
  const toolCallsValidIndex = headers.indexOf('tool_calls_valid');

  const candidateStats: Record<string, {
    attempts: number;
    successes: number;
    latencies: number[];
    toolCallAttempts: number;
    toolCallSuccesses: number;
  }> = {};

  for (let i = 1; i < lines.length; i += 1) {
    const row = lines[i].split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    if (row.length < headers.length) continue;

    const rowRouterId = (row[routerIdIndex] || '').replace(/^"|"$/g, '').trim();
    if (rowRouterId !== router.id) continue;

    const selectedModel = (row[selectedModelIndex] || '').replace(/^"|"$/g, '').trim();
    if (!selectedModel) continue;

    const statusRaw = (row[statusIndex] || '').replace(/^"|"$/g, '').trim();
    const statusCode = Number.parseInt(statusRaw, 10);
    const latencyRaw = candidateLatencyIndex >= 0
      ? (row[candidateLatencyIndex] || '').replace(/^"|"$/g, '').trim()
      : (row[durationIndex] || '').replace(/^"|"$/g, '').trim();
    const latencyMs = Number.parseFloat(latencyRaw);

    if (!candidateStats[selectedModel]) {
      candidateStats[selectedModel] = {
        attempts: 0,
        successes: 0,
        latencies: [],
        toolCallAttempts: 0,
        toolCallSuccesses: 0
      };
    }

    const stats = candidateStats[selectedModel];
    stats.attempts += 1;
    if (statusCode >= 200 && statusCode < 300) stats.successes += 1;
    if (Number.isFinite(latencyMs) && latencyMs > 0) stats.latencies.push(latencyMs);
    if (toolCallsRequestedIndex >= 0) {
      const toolCountRaw = (row[toolCallsRequestedIndex] || '').replace(/^"|"$/g, '').trim();
      const toolCount = Number.parseInt(toolCountRaw, 10);
      if (toolCount > 0) {
        stats.toolCallAttempts += 1;
        const toolValidRaw = (row[toolCallsValidIndex] || '').replace(/^"|"$/g, '').trim().toLowerCase();
        if (toolValidRaw === 'true' || toolValidRaw === '1') stats.toolCallSuccesses += 1;
      }
    }
  }

  const proposals: Array<Record<string, unknown>> = [];
  let totalSamples = 0;

  const tierResults = router.enableAutoTiers
    ? computeTiers(router.candidates.map((c) => c.model), eventsPath)
    : [];
  const tierMap = new Map(tierResults.map((t) => [t.model, t]));

  for (const candidate of router.candidates) {
    const stats = candidateStats[candidate.model];
    const tier = tierMap.get(candidate.model);
    if (!stats || stats.attempts === 0) {
      proposals.push({
        model: candidate.model,
        currentCodingScore: candidate.codingScore,
        currentInputPrice: candidate.inputPrice,
        currentOutputPrice: candidate.outputPrice,
        currentLatencyMs: candidate.latencyMs,
        sampleCount: 0,
        message: 'No telemetry data for this candidate yet.'
      });
      continue;
    }

    totalSamples += stats.attempts;
    const successRate = stats.successes / stats.attempts;
    const medianLatency = stats.latencies.length > 0
      ? stats.latencies.sort((a, b) => a - b)[Math.floor(stats.latencies.length / 2)]
      : null;
    const toolAccuracy = stats.toolCallAttempts > 0
      ? stats.toolCallSuccesses / stats.toolCallAttempts
      : null;

    const proposedCoding = Math.round(successRate * 100) / 100;
    const proposedLatency = medianLatency ? Math.round(medianLatency) : undefined;

    const changes: string[] = [];
    if (typeof candidate.codingScore === 'number' && Math.abs(proposedCoding - candidate.codingScore) > 0.05) {
      changes.push(`coding: ${candidate.codingScore} → ${proposedCoding}`);
    }
    if (typeof candidate.codingScore !== 'number') {
      changes.push(`coding: (unset) → ${proposedCoding} (inferred)`);
    }

    proposals.push({
      model: candidate.model,
      currentCodingScore: candidate.codingScore,
      currentInputPrice: candidate.inputPrice,
      currentOutputPrice: candidate.outputPrice,
      currentLatencyMs: null,
      sampleCount: stats.attempts,
      successRate: Number(successRate.toFixed(4)),
      medianLatencyMs: null,
      toolCallAccuracy: toolAccuracy ? Number(toolAccuracy.toFixed(4)) : null,
      proposedCodingScore: proposedCoding,
      proposedLatencyMs: null,
      tier: tier?.tier || null,
      tierDerankReasons: tier?.derankReasons || null,
      changes,
      needsReview: changes.length > 0
    });
  }

  return res.json({
    router: {
      id: routerPresentedModelId(router),
      routeId: router.id,
      type: router.type
    },
    totalSampleCount: totalSamples,
    generatedAt: new Date().toISOString(),
    proposals,
    recommendation: totalSamples < 25
      ? 'More data needed for reliable recommendations (minimum 25 samples per candidate recommended).'
      : proposals.some((p) => p.needsReview)
        ? 'Review proposed changes above and apply them via the /config UI or by re-saving the router with updated candidate metadata.'
        : 'All candidate metadata appears consistent with observed telemetry. No changes recommended.'
  });
});

app.post('/api/router-models/import', (req: Request, res: Response) => {
  const payload = req.body;
  const routers = Array.isArray(payload?.routers) ? payload.routers : Array.isArray(payload) ? payload : null;

  if (!routers || routers.length === 0) {
    return res.status(400).json({ error: 'Expected { routers: [...] } or an array of router model objects.' });
  }

  const imported: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const errors: Array<{ index: number; error: string }> = [];

  for (let i = 0; i < routers.length; i += 1) {
    const entry = routers[i];
    const parsed = parseRouterModel(entry);
    if (!parsed.ok) {
      errors.push({ index: i, error: parsed.error });
      continue;
    }

    const canonicalId = routerPresentedModelId(parsed.model);
    const existing = routerModelStore[parsed.model.id];
    if (existing) {
      if (req.body?.overwrite !== true) {
        skipped.push({ id: canonicalId, reason: 'Already exists. Set overwrite:true to replace.' });
        continue;
      }
    }

    const referenceCheck = validateRouterReferences(parsed.model);
    if (!referenceCheck.ok) {
      errors.push({ index: i, error: referenceCheck.error });
      continue;
    }

    if (parsed.model.type === 'bandit-local' && entry.banditState) {
      parsed.model.banditState = entry.banditState;
    }

    routerModelStore[parsed.model.id] = cloneRouterModel(parsed.model);
    imported.push(canonicalId);
  }

  try {
    persistRouterModels();
  } catch (err: any) {
    return res.status(500).json({
      error: 'Failed to persist imported routers.',
      details: sanitizeDiagnosticText(String(err?.message || err)),
      imported
    });
  }

  res.json({
    success: true,
    persisted: true,
    imported,
    skipped,
    errors,
    summary: `${imported.length} imported, ${skipped.length} skipped, ${errors.length} errors`
  });
});

app.get('/api/router-candidates.csv', (req: Request, res: Response) => {
  const eventsPath = existingPath(ROUTER_EVENTS_PATH, LEGACY_ROUTER_EVENTS_PATH);
  const candidateStats: Record<string, {
    successes: number; failures: number; latencies: number[];
    toolCallSuccesses: number; toolCallAttempts: number;
    lastObserved: string; sampleCount: number;
  }> = {};

  if (fs.existsSync(eventsPath)) {
    const csvText = fs.readFileSync(eventsPath, 'utf8');
    const lines = csvText.split(/\r?\n/).filter((line) => line.trim());
    if (lines.length > 1) {
      const rawHeaders = lines[0].split(',').map((h) => h.trim());
      const selectedIdx = rawHeaders.indexOf('selected_model');
      const statusIdx = rawHeaders.indexOf('status');
      const latencyIdx = rawHeaders.indexOf('candidate_latency_ms');
      const toolsValidIdx = rawHeaders.indexOf('tool_calls_valid');
      const timestampIdx = rawHeaders.indexOf('timestamp');

      for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        const model = selectedIdx >= 0 ? fields[selectedIdx]?.trim() : '';
        if (!model) continue;
        if (!candidateStats[model]) {
          candidateStats[model] = {
            successes: 0, failures: 0, latencies: [],
            toolCallSuccesses: 0, toolCallAttempts: 0,
            lastObserved: '', sampleCount: 0
          };
        }
        const stats = candidateStats[model];
        stats.sampleCount++;
        const status = statusIdx >= 0 ? Number(fields[statusIdx]) : 0;
        if (status >= 200 && status < 300) stats.successes++;
        else if (status > 0) stats.failures++;
        const latency = latencyIdx >= 0 ? Number(fields[latencyIdx]) : 0;
        if (latency > 0) stats.latencies.push(latency);
        const toolsValid = toolsValidIdx >= 0 ? Number(fields[toolsValidIdx]) : -1;
        if (toolsValid >= 0) {
          stats.toolCallAttempts++;
          if (toolsValid > 0) stats.toolCallSuccesses++;
        }
        if (timestampIdx >= 0) {
          stats.lastObserved = fields[timestampIdx]?.trim() || '';
        }
      }
    }
  }

  const headers = [
    'router_id',
    'presented_model',
    'router_type',
    'candidate_model',
    'provider',
    'upstream_model',
    'context_length',
    'output_tokens',
    'tools',
    'vision',
    'cache',
    'reasoning',
    'coding_score',
    'input_price',
    'output_price',
    'latency_ms',
    'success_rate',
    'tool_call_accuracy',
    'latency_p50_ms',
    'latency_p95_ms',
    'sample_count',
    'last_observed_at',
    'tier',
    'bandit_sample_count',
    'bandit_reward_mean',
    'exploration_budget',
    'notes'
  ];
  const rows = [headers.join(',')];
  for (const router of Object.values(routerModelStore).sort((a, b) => a.id.localeCompare(b.id))) {
    for (const candidate of router.candidates) {
      const model = findProviderModel(candidate.model);
      const banditState = router.banditState?.[candidate.model];
      const banditSampleCount = banditState?.sampleCount ?? '';
      const banditRewardMean = banditState && banditState.sampleCount > 0
        ? (banditState.b.reduce((sum, val) => sum + val, 0) / banditState.sampleCount).toFixed(4)
        : '';
      const stats = candidateStats[candidate.model];
      const totalAttempts = stats ? (stats.successes + stats.failures) : 0;
      const successRate = totalAttempts > 0 ? (stats!.successes / totalAttempts).toFixed(4) : '';
      const toolAccuracy = stats && stats.toolCallAttempts > 0
        ? (stats.toolCallSuccesses / stats.toolCallAttempts).toFixed(4) : '';
      const sortedLatencies = stats ? [...stats.latencies].sort((a, b) => a - b) : [];
      const p50 = sortedLatencies.length > 0
        ? sortedLatencies[Math.floor(sortedLatencies.length * 0.5)] : '';
      const p95 = sortedLatencies.length > 0
        ? sortedLatencies[Math.floor(sortedLatencies.length * 0.95)] : '';
      const sampleCount = stats?.sampleCount || 0;
      const lastObserved = stats?.lastObserved || '';
      const tier = sampleCount >= 50 ? 'verified' : sampleCount > 0 ? 'insufficient' : '';
      rows.push([
        router.id,
        routerPresentedModelId(router),
        router.type,
        candidate.model,
        model?.provider || '',
        model?.model || '',
        model?.contextLength || '',
        model?.outputTokens || '',
        model?.supportsTools ?? '',
        model?.supportsImages ?? '',
        model?.supportsCache ?? '',
        model?.supportsReasoning ?? '',
        candidate.codingScore ?? '',
        candidate.inputPrice ?? '',
        candidate.outputPrice ?? '',
        candidate.latencyMs ?? '',
        successRate,
        toolAccuracy,
        p50,
        p95,
        sampleCount || '',
        lastObserved,
        tier,
        banditSampleCount,
        banditRewardMean,
        router.explorationBudget ?? '',
        candidate.notes || ''
      ].map(csvEscape).join(','));
    }
  }

  res.type('text/csv').send(`${rows.join('\n')}\n`);
});

app.post('/api/fallback-models', (req: Request, res: Response) => {
  const parsed = parseFallbackModel(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  const canonicalFallbackId = fallbackPresentedModelId(parsed.model);
  const sameIdAsProvider = activeProviderModelList().some((model) => (
    model.id === parsed.model.id || model.id === canonicalFallbackId
  ));
  if (sameIdAsProvider || findRouterModel(parsed.model.id)) {
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

app.get('/api/router-settings', (req: Request, res: Response) => {
  const settings = loadRouterSettings();
  return res.json({
    fallbackModelsText: settings.fallbackModelsText || '',
    autoRouterCandidatesText: settings.autoRouterCandidatesText || ''
  });
});

app.put('/api/router-settings', (req: Request, res: Response) => {
  const body = req.body || {};
  const settings: RouterSettings = {};

  if (typeof body.fallbackModelsText === 'string') {
    settings.fallbackModelsText = body.fallbackModelsText;
  }
  if (typeof body.autoRouterCandidatesText === 'string') {
    settings.autoRouterCandidatesText = body.autoRouterCandidatesText;
  }

  try {
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
  try {
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

app.head('/api/version', (req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/api/version', (req: Request, res: Response) => {
  res.json({ version: process.env.OLLAMA_VERSION || '0.6.4' });
});

}
