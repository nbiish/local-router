import path from "node:path";
import express, { Request, Response } from 'express';
import { checkUpdateStatus, applyUpdate } from "../update-checker";
import { ThinkingLevel } from '../reasoning';
import { ProxyProvider } from '../types';
import {
  clearOAuthCredentials,
  getOAuthStatus,
  getOAuthState,
  getSuppressedHostSession,
  clearLogoutMarker,
  initAntigravityLogin,
  isOAuthProvider,
  listOAuthProviders,
  startCopilotLogin,
  OAuthProviderId
} from '../oauth-providers';
import { ollamaBackendVersionUrl } from '../ollama-backend';
import { renderProvidersPage } from '../ui/pages/providers';
import { renderFallbackPage } from '../ui/pages/fallback';
import { renderThinkingPage } from '../ui/pages/thinking';
import { renderAgentsPage } from '../ui/pages/agents';
import { renderEfficiencyPage } from '../ui/pages/efficiency';
import { renderTrajectoriesPage } from '../ui/pages/trajectories';
import {
  ProviderSummary,
  CustomProviderRecord,
  FallbackModel,
  FallbackModelParseResult,
  ProviderModel,
  ProviderModelParseResult,
  applyEmbeddingProviderOrderToStore,
  LOCAL_ROUTER_CONFIG_DIR,
  PORT,
  STREAM_FIRST_BYTE_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  NON_STREAM_TIMEOUT_MS
} from '../index';
import type { RouterSettings, AgentProxyConfig } from '../config-persistence';
import {
  loadCurationConfigs,
  loadRouterSettings,
  saveCurationConfigs,
  loadAgentProxyConfig,
  saveAgentProxyConfig
} from '../config-persistence';
import { syncSystemAgentEnv, agentHarnessEnv } from '../agent-env-sync';
import { syncCodexHarnessConfig } from '../agent-codex-config';
import { syncHermesHarnessConfig } from '../agent-hermes-config';
import { syncPiHarnessConfig } from '../agent-pi-config';
import { collectAgentHarnessStatus, verifyAgentHarness, type AgentHarnessName } from '../agent-harness-status';
import { getExpertLogs, importExpertLogs, clearExpertLogs, analyzeLogs } from '../expert-logs';
import {
  listTrajectorySummaries,
  getTrajectory,
  readReceiptPayload,
  readTrajectoryLogRaw,
  analyzeTrajectories,
  clearTrajectories,
  trajectoryDir
} from '../trajectories';
import { healthRegistry, healthStatePath } from '../health-registry';
import {
  buildFallbackBundle,
  bundleToRouterSettings,
  describeChainChange,
  parseFallbackBundle,
  serializeFallbackBundle
} from '../fallback-config-bundle';
import { durability } from '../durability';
import { planAutoDisable } from '../auto-disable';
import { costBandFor, providerCoverageGaps } from '../fallback-topology';

export interface ConfigApiDeps {
  agentProxyConfig?: AgentProxyConfig;
  persistPqcSecrets: () => { ok: boolean; persisted: number; error?: string };
  pqcStatusReport: () => any;
  pqcResync: () => { ok: boolean; loaded: string[]; skipped: string[]; error?: string; loadedProviderCount: number };
  state: {
    customProviderStore: CustomProviderRecord[];
    thinkingProxyEnabled: boolean;
    waferZdrEnabled: boolean;
    endpointModelsCache: ProviderModel[];
  };
  keyStore: Record<string, string>;
  fallbackModelStore: Record<string, FallbackModel>;
  thinkingLevelStore: Record<string, ThinkingLevel>;
  
  getProviderSummary: (name: string) => ProviderSummary | undefined;
  setProviderKeyForEnvVar: (envVar: string, val: string) => void;
  providerSummariesForEnvVar: (envVar: string) => ProviderSummary[];
  DEFAULT_OLLAMA_API_KEY: string;
  clearProviderKeyForProvider: (provider: string) => void;
  modelSourceConfig: {
    source: 'custom' | 'endpoints';
    filterConfigured: boolean;
    curationEnabled: boolean;
    curatedEndpointModelKeys: string[];
    archivedModelKeys: string[];
    defaultCurationConfig?: string;
  };
  persistModelSourceConfig: () => void;
  canonicalProviderSlug: (name: string) => string;
  isLocalRouterProviderName: (name: string) => boolean;
  filterConfiguredModels: (models: ProviderModel[]) => ProviderModel[];
  ensureOllamaBackend: () => Promise<boolean>;
  queryAllProviderEndpoints: () => Promise<ProviderModel[]>;
  refreshProviderEndpointModels: (providerName: string, options?: { preserveCuration?: boolean }) => Promise<{
    models: ProviderModel[];
    deselectedCount: number;
    source: 'live' | 'registry' | 'catalog';
    note?: string;
  }>;
  ensureCurationDefaultsForCache: () => void;
  reconcileOperatorClearedProviders: (previousKeys: string[], nextKeys: string[]) => void;
  deselectAllProviderCurationKeys: () => number;
  scheduleRecheckForFallbackReferences: () => void;
  writeProviderEndpointsDoc: () => void;
  snapshotFullCurationBackup: (reason: string) => void;
  evaluateCurationShrink: (nextKeys: string[]) => {
    blocked: boolean;
    removedCount: number;
    removedKeys: string[];
    currentCount: number;
    nextCount: number;
  };
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
  tombstoneLocalBackend: (slug: string) => void;
  isCustomProvider: (id: string) => boolean;
  providerReferencedInRouting: (id: string) => string[];
  cloneFallbackModel: (model: FallbackModel) => FallbackModel;
  candidateAvailability: (modelName: string) => any;
  parseFallbackModel: (payload: any, options?: { allowShort?: boolean }) => FallbackModelParseResult;
  normalizeFallbackRouteId: (id: string) => string;
  PORT: number;
  configureVSCodeModelPicker: (baseUrl: string) => any;
  systemPromptConfig: { enabled: boolean; prompt: string; thinkingLevel: ThinkingLevel };
  persistSystemPrompt: () => void;
  thinkingLevelApiPayload: () => any;
  persistThinkingConfig: () => void;
  persistWaferConfig: () => void;
  waferZdrApiPayload: () => { zdrEnabled: boolean };
  DEFAULT_FALLBACK_MODELS_TEXT: string;
  DEFAULT_CHAIN_OF_DRAFT_PROMPT: string;
  DEFAULT_THINKING_LEVEL: ThinkingLevel;
  activeProviderModelList: () => ProviderModel[];
  /** Chain steps that can actually serve right now (keyed providers only). */
  activeFallbackModels: (route: FallbackModel) => string[];
  /** Which provider a presented model id resolves to, for coverage reporting. */
  resolveModelTarget: (modelName: string) => { providerName: string } | null;
  /** Topology candidate for one chain step, or undefined when it does not resolve. */
  topologyCandidateFor: (modelId: string) => any | undefined;
  /** The cost-first ordering a route would get, without applying it. */
  candidateOrderForRoute: (route: FallbackModel) => any[];
  cloneProviderModel: (model: ProviderModel) => ProviderModel;
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
    pqcStatusReport,
    pqcResync,
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
    reconcileOperatorClearedProviders,
    deselectAllProviderCurationKeys,
    scheduleRecheckForFallbackReferences,
    writeProviderEndpointsDoc,
    snapshotFullCurationBackup,
    evaluateCurationShrink,
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
    tombstoneLocalBackend,
    isCustomProvider,
    providerReferencedInRouting,
    fallbackModelStore,
    cloneFallbackModel,
    candidateAvailability,
    parseFallbackModel,
    normalizeFallbackRouteId,
    PORT,
    configureVSCodeModelPicker,
    systemPromptConfig,
    persistSystemPrompt,
    thinkingLevelApiPayload,
    thinkingLevelStore,
    persistThinkingConfig,
    persistWaferConfig,
    waferZdrApiPayload,
    DEFAULT_FALLBACK_MODELS_TEXT,
    DEFAULT_CHAIN_OF_DRAFT_PROMPT,
    DEFAULT_THINKING_LEVEL,
    activeProviderModelList,
    activeFallbackModels,
    resolveModelTarget,
    topologyCandidateFor,
    candidateOrderForRoute,
    cloneProviderModel,
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

  app.get('/config/agents', (req: Request, res: Response) => {
    const html = renderAgentsPage({
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    // Config pages are live state (keys, catalog, routes) — never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  app.get('/config/efficiency', (req: Request, res: Response) => {
    const html = renderEfficiencyPage({
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    // Config pages are live state (keys, catalog, routes) — never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  app.get('/config/trajectories', (req: Request, res: Response) => {
    const html = renderTrajectoriesPage({
      defaultFallbackModelsText: DEFAULT_FALLBACK_MODELS_TEXT
    });
    // Config pages are live state (keys, catalog, routes) — never cacheable.
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  });

  // The /config/chat section was removed (2026-09-04): Local Router stays a
  // focused single source for provider keys, model catalog, and fallback
  // chains. The cursor-auto / github-copilot-auto PROVIDERS
  // remain fully served — see src/cli-auto-bridge.ts (cursor-agent / copilot
  // CLI bridges driving their auto models).

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
    const persistence = persistPqcSecrets();
    if (!persistence.ok) {
      console.warn(`[PQC] Key saved in memory but bundle persistence failed: ${persistence.error || 'unknown error'}`);
    }

    // A new key invalidates the old key's verdict (measured 2026-11-21): the
    // operator fixed a rejected key, but `key_rejected` parks a member for 30
    // minutes and this handler touched no health state, so the corrected key was
    // still skipped. Clearing here means the fix takes effect on the NEXT request
    // rather than after a cooldown the operator cannot see.
    let clearedParks = 0;
    try {
      clearedParks = healthRegistry.clearProvider(providerName);
      if (clearedParks > 0) {
        console.log(`[health] key saved for ${providerName} — cleared ${clearedParks} parked member(s)`);
      }
    } catch (error) {
      // Health bookkeeping must never fail the save: the key is already stored.
      console.warn('[health] could not clear parks after key save:', sanitizeDiagnosticText(String(error)));
    }

    // Best-effort live model discovery now that this provider holds a key.
    // OAuth providers authenticate through their own flow and are skipped.
    // Discovery is off-by-default: discovered models arrive toggled off so the
    // operator selects the few they serve (any previous picks are backed up).
    let discovered: { count: number; deselectedCount: number; models: ProviderModel[]; source: string; note?: string } | null = null;
    if (!isOAuthProvider(providerName)) {
      try {
        const { models, deselectedCount, source, note } = await refreshProviderEndpointModels(providerName, { preserveCuration: true });
        discovered = { count: models.length, deselectedCount, models, source, note };
      } catch {
        // The key stays saved; discovery can be retried from the provider card.
      }
    }

    writeProviderEndpointsDoc();
    return res.json({
      success: true,
      provider: providerName,
      keyEnvVar: summary.keyEnvVar,
      configured: true,
      configuredSource: 'memory',
      persisted: persistence.ok,
      ...(persistence.ok ? {} : { warning: `Key is active in memory but could not be persisted to the PQC bundle: ${persistence.error || 'unknown error'}` }),
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
    const persistence = persistPqcSecrets();
    writeProviderEndpointsDoc();
    return res.json({
      success: true,
      persisted: persistence.ok,
      ...(persistence.ok ? {} : { warning: `Key is active in memory but could not be persisted: ${persistence.error || 'unknown error'}` })
    });
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
    writeProviderEndpointsDoc();
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

app.get('/api/oauth/providers', async (_req: Request, res: Response) => {
  const providers = listOAuthProviders();
  const statuses = providers.map((id) => getOAuthStatus(id));
  res.json({
    success: true,
    providers: statuses
  });
});


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

  if (providerName === 'cursor') {
    try {
      // Cursor has no router-native login flow — its credential lives in the
      // host IDE/CLI. An explicit login click IS consent to re-adopt that
      // session, so clear the logout marker first; logout stays sticky for
      // the passive paths (status/boot) until this explicit call.
      clearLogoutMarker('cursor');
      const session = getOAuthState('cursor');
      if (session) {
        return res.json({
          success: true,
          provider: 'cursor',
          authType: 'oauth-pkce',
          configured: true,
          message: `Logged in to Cursor as ${session.accountLabel || "user"} (host session re-adopted).`,
          status: getOAuthStatus('cursor')
        });
      }
      return res.json({
        success: true,
        provider: 'cursor',
        authType: 'oauth-pkce',
        configured: false,
        message: "No active Cursor session found. Sign in via the Cursor IDE or run `cursor-agent login` in a terminal — Local Router detects the session automatically."
      });
    } catch (error: any) {
      return res.status(500).json({ error: error?.message || "Failed to check Cursor authentication." });
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
  // Tell the UI when the host IDE/CLI itself is still signed in: the router
  // now ignores that exact session (logout marker), but a fresh vendor-side
  // login will be picked up automatically.
  const retained = getSuppressedHostSession(providerName as OAuthProviderId);
  return res.json({
    success: true,
    provider: providerName,
    configured: false,
    hostSessionRetained: Boolean(retained),
    accountLabel: retained?.accountLabel
  });
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
    archivedKeys: modelSourceConfig.archivedModelKeys,
    totalModels: state.endpointModelsCache.length,
    data: grouped
  });
});

// Curation merge guard: a replacement that drops >=90% of a meaningful
// curated list is treated as a probable accident (2026-09-04 catalog-wipe
// class of incident). Such writes require an explicit `force: true`; any
// substantial shrink snapshots the outgoing list first.
function guardCurationReplacement(
  nextKeys: string[],
  force: unknown,
  reason: string
): { blocked?: ReturnType<typeof evaluateCurationShrink> } {
  const evaluation = evaluateCurationShrink(nextKeys);
  if (evaluation.blocked && force !== true) {
    return { blocked: evaluation };
  }
  if (
    evaluation.removedCount > 0
    && evaluation.currentCount > 0
    && evaluation.removedCount >= evaluation.currentCount / 2
  ) {
    snapshotFullCurationBackup(force === true ? `${reason} (forced)` : reason);
  }
  return {};
}

app.put('/api/model-curation', (req: Request, res: Response) => {
  const { enabled, selectedKeys, activate, archivedKeys } = req.body || {};

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
    const nextKeys = Array.from(new Set(
      selectedKeys.map((key: string) => key.trim()).filter(Boolean)
    )).slice(0, 5000);
    const guard = guardCurationReplacement(nextKeys, req.body?.force, 'PUT /api/model-curation');
    if (guard.blocked) {
      return res.status(409).json({
        error: `Curation merge guard: this write would remove ${guard.blocked.removedCount} of ${guard.blocked.currentCount} curated models. Re-send with "force": true if this is intentional.`,
        removedCount: guard.blocked.removedCount,
        currentCount: guard.blocked.currentCount,
        removedKeysPreview: guard.blocked.removedKeys.slice(0, 25)
      });
    }
    reconcileOperatorClearedProviders(modelSourceConfig.curatedEndpointModelKeys, nextKeys);
    modelSourceConfig.curatedEndpointModelKeys = nextKeys;
  }

  // Archive state (2026-11-12): reversible presentation toggle — no merge
  // guard; an archived model stays discoverable and restorable.
  if (archivedKeys !== undefined) {
    if (!Array.isArray(archivedKeys)) {
      return res.status(400).json({ error: 'archivedKeys must be an array of "provider::model" strings.' });
    }
    const invalidArchive = archivedKeys.find((key: unknown) => typeof key !== 'string' || !key.includes('::'));
    if (invalidArchive !== undefined) {
      return res.status(400).json({ error: 'archivedKeys entries must be "provider::model" strings.' });
    }
    modelSourceConfig.archivedModelKeys = Array.from(new Set(
      archivedKeys.map((key: string) => key.trim()).filter(Boolean)
    ));
  }

  // Curation cannot be disabled in the single-catalog regime (2026-08-20):
  // the toggle selection IS the catalog. `enabled: false` is ignored.
  modelSourceConfig.curationEnabled = true;

  persistModelSourceConfig();

  return res.json({
    success: true,
    curationEnabled: modelSourceConfig.curationEnabled,
    selectedCount: modelSourceConfig.curatedEndpointModelKeys.length,
    selectedKeys: modelSourceConfig.curatedEndpointModelKeys,
    archivedKeys: modelSourceConfig.archivedModelKeys
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
  const nextKeys = Array.from(new Set(config.selectedKeys))
    .slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
  const guard = guardCurationReplacement(nextKeys, req.body?.force, `curation-configs/load:${name}`);
  if (guard.blocked) {
    return res.status(409).json({
      error: `Curation merge guard: loading "${name}" would remove ${guard.blocked.removedCount} of ${guard.blocked.currentCount} curated models. Re-send with "force": true if this is intentional.`,
      removedCount: guard.blocked.removedCount,
      currentCount: guard.blocked.currentCount,
      removedKeysPreview: guard.blocked.removedKeys.slice(0, 25)
    });
  }
  modelSourceConfig.source = 'endpoints';
  modelSourceConfig.curationEnabled = true;
  reconcileOperatorClearedProviders(modelSourceConfig.curatedEndpointModelKeys, nextKeys);
  modelSourceConfig.curatedEndpointModelKeys = nextKeys;
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
    const { models, deselectedCount, source, note } = await refreshProviderEndpointModels(providerName, { preserveCuration: true });
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
    // New discoveries are HIDDEN by default (operator decision 2026-11-12,
    // plan §4.2): refresh-all merges the live catalog into the view but no
    // longer auto-curates — tools see only what the operator checked.
    // Fallback-referenced models are re-curated afterwards so chain steps
    // stay Available (a chain reference is an explicit admission).
    scheduleRecheckForFallbackReferences();
    const deselectedCount = 0;
    const ollamaTags = filterOllamaCloudPullTags(
      effectiveProviderModels('ollama').map((model) => model.model),
      ollamaCloudRoutingAllowsPro()
    );
    void pullOllamaCloudModels(ollamaTags);
    res.json({ success: true, count: mergedCount, deselectedCount, preservedSelection: true, data: fetchedModels });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to refresh endpoint models' });
  }
});

app.post('/api/pqc-resync', (req: Request, res: Response) => {
  const force = req.body?.force === true;
  const result = syncKeysFromPqcBundle({ force });
  if (result.ok) {
    console.log(`[PQC] Resync loaded ${result.loaded.length} provider key(s) from bundle: ${result.loaded.join(', ')}`);
    // Config round-trip (2026-09-04): keys just arrived — re-check provider
    // catalogs so imported fallback references resolve without manual re-checks.
    const recheckProviders = Array.from(new Set(
      result.loaded.flatMap((envVar) => providerSummariesForEnvVar(envVar).map((summary) => summary.name))
    ));
    if (recheckProviders.length > 0) {
      setTimeout(() => scheduleRecheckForFallbackReferences(), 1500).unref?.();
    }
    return res.json({ success: true, resynced: true, loaded: result.loaded, skipped: result.skipped, recheckingProviders: recheckProviders });
  }
  if (result.error === 'cooldown') {
    return res.json({ success: true, resynced: false, reason: 'cooldown' });
  }
  return res.status(502).json({ success: false, error: result.error });
});

app.get('/api/update-status', async (req: Request, res: Response) => {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const status = await checkUpdateStatus(projectRoot, false);
  res.json({ success: true, ...status });
});

app.post('/api/check-updates', async (req: Request, res: Response) => {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const status = await checkUpdateStatus(projectRoot, true);
  res.json({ success: true, ...status });
});

app.post('/api/apply-update', (req: Request, res: Response) => {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const result = applyUpdate(projectRoot);
  res.json(result);
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
  writeProviderEndpointsDoc();

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
  // A deleted standard local backend stays deleted across boots (tombstone).
  tombstoneLocalBackend(providerId);

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

/**
 * Chain coverage: does the fallback chain actually use every provider the
 * operator has configured, and is each provider reached by more than one step?
 *
 * Measured 2026-11-09: 15 providers were configured and `antigravity` — an
 * entire OAuth subscription — appeared in the chain zero times, while
 * `nebius` appeared with no key at all. Neither was visible anywhere the
 * operator would look; both are reported here.
 *
 * Read-only. It never reshapes the chain: reordering is a deliberate act, and a
 * diagnostic that mutates the thing it reports is not a diagnostic.
 */
app.get('/api/routing/coverage', (req: Request, res: Response) => {
  const routeId = typeof req.query.route === 'string' && req.query.route.trim()
    ? normalizeFallbackRouteId(req.query.route)
    : 'fallback-models';
  const route = fallbackModelStore[routeId];
  if (!route) {
    return res.status(404).json({ error: `Unknown fallback route "${routeId}".` });
  }

  const configuredProviders = providerConfigs()
    .filter((provider) => provider.configured)
    .map((provider) => provider.name);
  const chainModels = activeFallbackModels(route);
  const chainProviders = chainModels
    .map((modelId) => resolveModelTarget(modelId)?.providerName)
    .filter((provider): provider is string => Boolean(provider));

  const gaps = providerCoverageGaps({
    configuredProviders,
    // Only a decisions-only provider is genuinely non-chat. Ollama Cloud is a
    // chat provider with documented free tiers, and the local loopback backend is
    // a legitimate (if not preferred) target, so excluding either would hide a
    // real gap behind a rule.
    nonChatProviders: ['typesafe'],
    chainProviders
  });

  const steps = chainModels.map((modelId) => {
    const availability = candidateAvailability(modelId);
    const candidate = topologyCandidateFor(modelId);
    return {
      model: modelId,
      provider: availability.provider,
      status: availability.status,
      costBand: candidate ? costBandFor(candidate.tier, modelId, candidate.accessPath) : 'unknown',
      contextLength: candidate?.contextLength ?? null,
      reasoningLevels: candidate?.reasoningLevelCount ?? 0,
      supportsVision: candidate?.supportsVision ?? false,
      caches: candidate?.caches ?? false
    };
  });

  return res.json({
    route: routeId,
    steps,
    configuredProviders,
    coverage: gaps,
    // An ordered-by-cost view of what a correctly sorted chain would look like.
    // Reported, never applied.
    suggestedOrder: candidateOrderForRoute(route).map((candidate) => candidate.id)
  });
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

  // Merge guard for chains (2026-09-04): emptying a chain that previously had
  // 3+ steps requires an explicit force flag — the silent empty-chain write
  // class of incident. Snapshots are taken by persistFallbackModels.
  const previousChain = Array.isArray(previousModel?.models) ? previousModel.models : [];
  const nextChain = Array.isArray(parsed.model.models) ? parsed.model.models : [];
  const uiOriginated = req.body?.origin === 'ui';
  if (previousChain.length >= 3 && nextChain.length === 0 && req.body?.force !== true && !uiOriginated) {
    return res.status(409).json({
      error: `Fallback merge guard: this write would empty the "${parsed.model.id}" chain (${previousChain.length} steps). Re-send with "force": true if intentional.`,
      previousStepCount: previousChain.length
    });
  }

  fallbackModelStore[parsed.model.id] = cloneFallbackModel(parsed.model);
  // The embedding route carries a fixed provider order (OpenRouter before ZenMux). Correcting it
  // here rather than at the next boot means a save or reorder cannot leave the route answering
  // from the wrong provider even once.
  applyEmbeddingProviderOrderToStore();

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

  // Config round-trip (2026-09-04): an imported chain may reference models
  // this machine has not discovered yet — schedule catalog re-checks for the
  // providers involved so steps come up Available instead of Unavailable.
  scheduleRecheckForFallbackReferences();

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

const SYSTEM_FALLBACK_ROUTE = 'fallback-models';

// Set the default system chain: copies the named route's steps into the
// `fallback-models` route that the `local-router/fallback-models` alias and
// the direct-model cascade use. Persists across shutdowns via
// fallback-models.json.
app.post('/api/fallback-models/set-default', (req: Request, res: Response) => {
  const id = normalizeFallbackRouteId(String(req.body?.id || '').trim());
  const source = fallbackModelStore[id];
  if (!source) {
    return res.status(404).json({ error: `Fallback route not found: ${id}` });
  }
  if (id === SYSTEM_FALLBACK_ROUTE) {
    return res.json({ success: true, alreadyDefault: true, id });
  }
  const sysRoute = fallbackModelStore[SYSTEM_FALLBACK_ROUTE] || { id: SYSTEM_FALLBACK_ROUTE, models: [], disabledModels: [] };
  sysRoute.models = [...(Array.isArray(source.models) ? source.models : [])];
  sysRoute.disabledModels = [...(Array.isArray(source.disabledModels) ? source.disabledModels : [])];
  fallbackModelStore[SYSTEM_FALLBACK_ROUTE] = sysRoute;
  persistFallbackModels();
  return res.json({
    success: true,
    defaultRoute: SYSTEM_FALLBACK_ROUTE,
    steps: sysRoute.models.length,
    models: sysRoute.models
  });
});

// Unset the default system chain: empties `fallback-models`. The route
// itself remains (always present as the cascade target).
app.post('/api/fallback-models/unset-default', (_req: Request, res: Response) => {
  const sysRoute = fallbackModelStore[SYSTEM_FALLBACK_ROUTE];
  if (!sysRoute) {
    fallbackModelStore[SYSTEM_FALLBACK_ROUTE] = { id: SYSTEM_FALLBACK_ROUTE, models: [], disabledModels: [] };
    persistFallbackModels();
    return res.json({ success: true, unset: true });
  }
  const removed = Array.isArray(sysRoute.models) ? sysRoute.models.length : 0;
  sysRoute.models = [];
  sysRoute.disabledModels = [];
  persistFallbackModels();
  return res.json({ success: true, unset: true, removedSteps: removed });
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
  // Removing the ZenMux step is what a disable looks like; adding a step can also complete the
  // pair, so the provider order is re-checked on both branches.
  applyEmbeddingProviderOrderToStore();
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
  // A drag that puts ZenMux ahead of OpenRouter is corrected here, so the embedding route cannot
  // serve from the wrong provider between this write and the next boot.
  const orderPin = applyEmbeddingProviderOrderToStore();

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
    route: { id: updated.id, models: [...updated.models], disabledModels: [...(updated.disabledModels || [])] },
    providerOrderPinned: orderPin.applied ? orderPin.models : undefined
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

/**
 * The single writer for bulk chain settings. Both PUT /api/router-settings and
 * the portable-config import funnel through here so `persistFallbackModels()`
 * remains the only code that writes the authoritative chain file.
 */
function applyRouterSettingsPayload(body: any): { success: true; settings: RouterSettings } {
  const payload = body && typeof body === 'object' ? body : {};
  const settings: RouterSettings = {};

  if (Array.isArray(payload.routes)) {
    for (const routeEntry of payload.routes) {
      const parsed = parseFallbackModel(routeEntry, { allowShort: true });
      if (parsed.ok) {
        fallbackModelStore[parsed.model.id] = cloneFallbackModel(parsed.model);
      }
    }
  }

  if (typeof payload.fallbackModelsText === 'string') {
    settings.fallbackModelsText = payload.fallbackModelsText;
    const parsed = parseFallbackModel({ id: 'fallback-models', modelsText: payload.fallbackModelsText }, { allowShort: true });
    if (parsed.ok) {
      fallbackModelStore['fallback-models'] = cloneFallbackModel(parsed.model);
    }
  }
  // Bulk settings writes carry whole routes, so the embedding provider pin is re-applied here too.
  applyEmbeddingProviderOrderToStore();

  // `persistFallbackModels` already writes the COMPLETE settings file (every
  // route plus the chain text). A second `saveRouterSettings(settings)` here
  // used to overwrite that file with `{ fallbackModelsText }` alone, silently
  // dropping the purpose-scoped routes (fallback-embedding/fallback-decision)
  // from the authoritative file on every bulk settings write.
  persistFallbackModels();
  return { success: true, settings };
}

app.put('/api/router-settings', (req: Request, res: Response) => {
  try {
    return res.json(applyRouterSettingsPayload(req.body));
  } catch (error: any) {
    return res.status(500).json({
      error: 'Failed to persist router settings.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }
});

/** Export only the fallback chain as a versioned, credential-free JSON file. */
app.get('/api/config/fallback/export', (req: Request, res: Response) => {
  const bundle = buildFallbackBundle(loadRouterSettings());
  const config = serializeFallbackBundle(bundle);
  const filename = `local-router-fallback-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.json({ success: true, filename, config });
});

/**
 * Import a portable chain. Defaults to a no-write dry run so a stray POST can
 * never replace the live chain; the UI and CLI must opt in with `dryRun:false`.
 * The previous bundle is returned so the operator can roll back.
 */
app.post('/api/config/fallback/import', (req: Request, res: Response) => {
  const body = req.body || {};
  if (typeof body.config !== 'string') {
    return res.status(400).json({ success: false, error: 'Config must be text.' });
  }
  const parsed = parseFallbackBundle(body.config);
  if (!parsed.ok) {
    return res.status(400).json({ success: false, error: parsed.error });
  }

  const current = loadRouterSettings();
  const next = bundleToRouterSettings(parsed.bundle);
  const diff = describeChainChange(current, next);
  const previousConfig = serializeFallbackBundle(buildFallbackBundle(current));

  if (body.dryRun !== false) {
    return res.json({ success: true, dryRun: true, diff, previousConfig });
  }

  try {
    applyRouterSettingsPayload(next);
  } catch (error: any) {
    return res.status(500).json({
      success: false,
      error: 'Failed to import fallback chain.',
      details: sanitizeDiagnosticText(String(error?.message || error))
    });
  }
  return res.json({ success: true, dryRun: false, diff, previousConfig });
});

app.delete('/api/router-settings', (req: Request, res: Response) => {
  fallbackModelStore['fallback-models'] = {
    id: 'fallback-models',
    models: []
  };
  try {
    // Same rule as PUT: the full route set stays in the file; only this route is
    // reset. Writing `{}` afterwards would discard the other routes.
    persistFallbackModels();
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

// ── Trajectory Traces (2026-11-12: fallback-chain observability) ──
// Machine-readable mirror of ~/.config/local-router/trajectories/trajectories.jsonl
// so agents can inspect every model call and every skipped chain member.

app.get('/api/trajectories', (req: Request, res: Response) => {
  return res.json({
    trajectories: listTrajectorySummaries({
      limit: req.query.limit ? Number(req.query.limit) : undefined,
      route: typeof req.query.route === 'string' ? req.query.route : undefined,
      outcome: req.query.outcome === 'success' || req.query.outcome === 'failure' ? req.query.outcome : undefined,
      since: typeof req.query.since === 'string' ? req.query.since : undefined
    })
  });
});

app.get('/api/trajectories/health', (_req: Request, res: Response) => {
  // chainHealth: live quarantine state (plan T5) beside the window analysis —
  // agents get "why is this member skipped" and "what class of error" in one call.
  return res.json({ ...analyzeTrajectories(), chainHealth: healthRegistry.snapshot() });
});

/**
 * Advisory chain recommendations.
 *
 * The auto-disable machinery (`planAutoDisable`) was written and tested but
 * never called from production code, so a member failing for a day was still a
 * chain member — skipped forever on the 5-minute cooldown cycle. This endpoint
 * exposes that reasoning WITHOUT applying it: the router never writes
 * `disabledModels`, because the chain is operator-authored truth and an
 * automatic edit there is an unattended change to the routing behaviour of every
 * agent on this machine. The operator reads the recommendation, then edits the
 * chain (which the file watcher applies live).
 */
app.get('/api/chain/recommendations', (_req: Request, res: Response) => {
  const health = analyzeTrajectories();
  const candidates = healthRegistry.autoDisableCandidates();
  const byChain = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const chainId = (candidate.chainId as string | null) || '(direct)';
    const bucket = byChain.get(chainId);
    if (bucket) bucket.push(candidate);
    else byChain.set(chainId, [candidate]);
  }

  const recommendations: Array<Record<string, unknown>> = [];
  for (const [chainId, members] of byChain.entries()) {
    const route = health.routes.find((entry) => entry.routeId === chainId);
    const configuredModels = route ? route.models.map((model) => model.model) : members.map((m) => m.model);
    const plan = planAutoDisable({
      configuredModels,
      operatorDisabledModels: [],
      candidates: members.map((member) => ({
        model: member.model,
        failingMs: member.failingMs,
        failureRate: healthRegistry.failureRate(member.chainId, member.model),
        consecutiveFailures: 1
      }))
    });
    const kept = new Map(plan.kept.map((entry) => [entry.model, entry.why]));
    for (const member of members) {
      const wouldDisable = plan.disable.some((entry) => entry.model === member.model);
      recommendations.push({
        routeId: chainId,
        model: member.model,
        failingHours: Math.round((member.failingMs / 3_600_000) * 10) / 10,
        failureRate: healthRegistry.failureRate(member.chainId, member.model),
        action: wouldDisable ? 'disable' : 'keep',
        why: wouldDisable
          ? 'Failed continuously past the threshold with no success in the window.'
          : kept.get(member.model) || 'Kept because disabling it would empty the chain.',
        // Stated so a caller never assumes the router acted on this.
        applied: false
      });
    }
  }

  return res.json({
    generatedAt: new Date().toISOString(),
    advisoryOnly: true,
    note: 'The router never edits the chain. Apply a recommendation by disabling the model in the fallback editor or router-settings.json.',
    thresholdHours: Number(process.env.LOCAL_ROUTER_AUTO_DISABLE_AFTER_HOURS || 24),
    recommendations
  });
});

app.get('/api/trajectories/export', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="trajectories.jsonl"');
  return res.send(readTrajectoryLogRaw());
});

app.get('/api/trajectories/:id', (req: Request, res: Response) => {
  const record = getTrajectory(String(req.params.id));
  if (!record) {
    return res.status(404).json({ error: 'Trajectory not found.' });
  }
  const part = typeof req.query.part === 'string' ? req.query.part : '';
  if (part) {
    // `outbound` addresses a specific stage's request body: ?part=outbound&stage=0.
    // Without this an agent could see the sha: handle in the record but had no
    // supported way to read the body, which is the fact the 2026-11-20 audit
    // needed for every defect it found.
    if (part === 'outbound') {
      const index = Number(req.query.stage ?? 0);
      const stage = Number.isInteger(index) && index >= 0 ? record.stages?.[index] : undefined;
      if (!stage) {
        return res.status(404).json({ error: `No stage at index ${req.query.stage ?? 0}.` });
      }
      const text = readReceiptPayload(stage.outbound);
      if (text == null) {
        return res.status(404).json({ error: 'This stage recorded no outbound body.' });
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.send(text);
    }
    if (part !== 'request' && part !== 'response' && part !== 'thinking' && part !== 'toolCalls') {
      return res.status(400).json({ error: 'Unknown part. Use request|response|thinking|toolCalls|outbound.' });
    }
    const text = readReceiptPayload(record.receipts[part]);
    if (text == null) {
      return res.status(404).json({ error: 'Payload not retained — only the preview survived.' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(text);
  }
  return res.json(record);
});

app.delete('/api/trajectories', (_req: Request, res: Response) => {
  clearTrajectories();
  return res.json({ success: true });
});


// ── Environment Variables for External AI Tools ──
app.get('/api/env', (req: Request, res: Response) => {
  const host = '127.0.0.1';
  const port = process.env.PORT || '11434';
  const baseUrl = `http://${host}:${port}`;

  const envs = {
    OLLAMA_HOST: baseUrl,
    OLLAMA_API_BASE: baseUrl,
    ...agentHarnessEnv(baseUrl)
  };

  const format = String(req.query.format || 'json').toLowerCase();
  if (format === 'bash' || format === 'sh' || format === 'zsh') {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(Object.entries(envs).map(([k, v]) => `export ${k}="${v}"`).join('\n'));
  }
  if (format === 'ps1' || format === 'pwsh') {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(Object.entries(envs).map(([k, v]) => `$env:${k} = "${v}"`).join('\n'));
  }
  if (format === 'cmd') {
    res.setHeader('Content-Type', 'text/plain');
    return res.send(Object.entries(envs).map(([k, v]) => `set ${k}=${v}`).join('\n'));
  }

  return res.json(envs);
});

// ── PQC secrets diagnostics ───────────────────────────────────────────────
// Names and mappings only — never values. This is the endpoint that answers
// "I packed the key, why does the router say no key?".
app.get('/api/pqc/status', (req: Request, res: Response) => {
  try {
    return res.json({ ok: true, ...pqcStatusReport() });
  } catch (error: any) {
    return res.status(500).json({ error: sanitizeDiagnosticText(String(error?.message || error)) });
  }
});

app.post('/api/pqc/resync', (req: Request, res: Response) => {
  const result = pqcResync();
  // A resync reloads every key from the vault, so any park recorded against an
  // older key is stale in the same way a single key save makes one stale.
  // Clearing every park is the only correct answer here: the router cannot tell
  // which individual keys changed, and a chain that is silently skipping a
  // provider whose key was just reloaded is exactly the interruption this
  // endpoint exists to prevent.
  let clearedParks = 0;
  if (result.ok) {
    try {
      clearedParks = healthRegistry.clearAllParks();
      if (clearedParks > 0) {
        console.log(`[health] bundle resync — cleared ${clearedParks} parked member(s)`);
      }
    } catch (error) {
      console.warn('[health] could not clear parks after resync:', sanitizeDiagnosticText(String(error)));
    }
  }
  return res.status(result.ok ? 200 : 500).json({ ...result, clearedParks });
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

  const validLevels: ThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

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


// ── Agent Proxy Config API ─────────────────────────────────────────────────
// Four harnesses, one contract:
//   Claude Code — model remapping on /v1/messages + Anthropic client env.
//   Codex CLI   — managed provider/profile files + OpenAI client env.
//   Hermes      — config.yaml + context/consolidate profile provider wiring.
//   pi CLI      — ~/.pi/agent/models.json local-router provider wiring.
// Saving reconciles the on-disk wiring, and the status/verify endpoints let
// the page prove the loopback path instead of guessing.

function agentHarnessBaseUrl(): string {
  return `http://127.0.0.1:${PORT}`;
}

function validateHarnessModelUpdate(
  name: string,
  incoming: any,
  target: { enabled: boolean; model: string }
): string | null {
  if (!incoming || typeof incoming !== 'object') {
    return `${name} must be an object.`;
  }
  if (incoming.enabled !== undefined && typeof incoming.enabled !== 'boolean') {
    return `${name}.enabled must be a boolean.`;
  }
  if (incoming.model !== undefined) {
    if (typeof incoming.model !== 'string') {
      return `${name}.model must be a string.`;
    }
    const model = incoming.model.trim();
    if (!model || model.length > 200 || /[\r\n]/.test(model)) {
      return `${name}.model must be a single non-empty model id (200 chars max).`;
    }
    target.model = model;
  }
  if (typeof incoming.enabled === 'boolean') {
    target.enabled = incoming.enabled;
  }
  return null;
}

function applyAgentHarnessState(config: AgentProxyConfig) {
  const baseUrl = agentHarnessBaseUrl();
  const env = syncSystemAgentEnv({
    baseUrl,
    skipOsEnvironment: process.env.LOCAL_ROUTER_SKIP_OS_ENV === '1'
  });
  const codex = syncCodexHarnessConfig({
    enabled: Boolean(config.codex?.enabled),
    model: String(config.codex?.model || ''),
    baseUrl
  });
  const hermes = syncHermesHarnessConfig({
    enabled: Boolean(config.hermes?.enabled),
    model: String(config.hermes?.model || 'local-router/fallback-models'),
    syncProfiles: config.hermes?.syncProfiles !== false,
    baseUrl
  });
  const pi = syncPiHarnessConfig({
    enabled: Boolean(config.pi?.enabled),
    model: String(config.pi?.model || 'local-router/fallback-models'),
    baseUrl
  });
  return { env, codex, hermes, pi };
}

app.get('/api/agents-proxy', (req: Request, res: Response) => {
  const config = loadAgentProxyConfig();
  const rawModels = activeProviderModelList();
  const configuredModels = filterConfiguredModels(rawModels);

  const fallbackRoutesList = Object.values(fallbackModelStore).map((fm) => ({
    id: fm.id,
    models: fm.models
  }));

  return res.json({
    config,
    availableModels: configuredModels.map((m) => ({
      id: m.id,
      model: m.model,
      display: m.display,
      provider: m.provider
    })),
    fallbackRoutes: fallbackRoutesList
  });
});

app.get('/api/agents-proxy/status', (req: Request, res: Response) => {
  const config = loadAgentProxyConfig();
  return res.json({
    ok: true,
    status: collectAgentHarnessStatus(config, { baseUrl: agentHarnessBaseUrl() })
  });
});

app.put('/api/agents-proxy', (req: Request, res: Response) => {
  const current = loadAgentProxyConfig();
  const incoming = req.body ?? {};

  if (incoming.claudeCode) {
    if (typeof incoming.claudeCode.enabled === 'boolean') {
      current.claudeCode.enabled = incoming.claudeCode.enabled;
    }
    if (incoming.claudeCode.models && typeof incoming.claudeCode.models === 'object') {
      for (const slot of ['default', 'opus1m', 'sonnet', 'sonnet5_1m', 'haiku'] as const) {
        if (typeof incoming.claudeCode.models[slot] === 'string') {
          current.claudeCode.models[slot] = incoming.claudeCode.models[slot].trim();
        }
      }
    }
  }

  if (incoming.codex !== undefined) {
    const err = validateHarnessModelUpdate('codex', incoming.codex, current.codex);
    if (err) return res.status(400).json({ error: err });
  }

  if (incoming.hermes !== undefined) {
    const hermesTarget = current.hermes || { enabled: false, model: 'local-router/fallback-models', syncProfiles: true };
    const err = validateHarnessModelUpdate('hermes', incoming.hermes, hermesTarget);
    if (err) return res.status(400).json({ error: err });
    if (incoming.hermes.syncProfiles !== undefined) {
      if (typeof incoming.hermes.syncProfiles !== 'boolean') {
        return res.status(400).json({ error: 'hermes.syncProfiles must be a boolean.' });
      }
      hermesTarget.syncProfiles = incoming.hermes.syncProfiles;
    }
    current.hermes = hermesTarget;
  }

  if (incoming.pi !== undefined) {
    const piTarget = current.pi || { enabled: false, model: 'local-router/fallback-models' };
    const err = validateHarnessModelUpdate('pi', incoming.pi, piTarget);
    if (err) return res.status(400).json({ error: err });
    current.pi = piTarget;
  }

  saveAgentProxyConfig(current);
  if (deps.agentProxyConfig) {
    deps.agentProxyConfig.claudeCode = current.claudeCode;
    deps.agentProxyConfig.codex = current.codex;
    deps.agentProxyConfig.hermes = current.hermes;
    deps.agentProxyConfig.pi = current.pi;
  }

  const applied = applyAgentHarnessState(current);
  const errors = [
    applied.env.ok ? null : applied.env.error,
    applied.codex.ok ? null : applied.codex.error,
    applied.hermes.ok ? null : applied.hermes.error,
    applied.pi.ok ? null : applied.pi.error
  ].filter(Boolean);

  return res.json({
    ok: true,
    config: current,
    applied,
    warnings: errors
  });
});

app.post('/api/agents-proxy/verify', async (req: Request, res: Response) => {
  const harness = String(req.body?.harness || '').toLowerCase();
  if (harness !== 'claude' && harness !== 'codex' && harness !== 'hermes' && harness !== 'pi') {
    return res.status(400).json({ error: 'harness must be claude, codex, hermes, or pi.' });
  }
  const config = loadAgentProxyConfig();
  const result = await verifyAgentHarness(harness as AgentHarnessName, config, { baseUrl: agentHarnessBaseUrl() });
  return res.json({ ok: result.ok, result });
});

app.post('/api/agents-proxy/sync-env', (req: Request, res: Response) => {
  const config = loadAgentProxyConfig();
  const applied = applyAgentHarnessState(config);
  if (!applied.env.ok && !applied.codex.ok && !applied.hermes.ok && !applied.pi.ok) {
    return res.status(500).json({
      error: applied.env.error || applied.codex.error || applied.hermes.error || applied.pi.error || 'Failed to synchronize agent environment'
    });
  }
  return res.json({
    ok: true,
    syncedAt: new Date().toISOString(),
    applied
  });
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

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x.replace(/[^0-9]/g, ''), 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x.replace(/[^0-9]/g, ''), 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

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
      const effectiveVersion = compareSemver(version, DEFAULT_OLLAMA_VERSION) >= 0 ? version : DEFAULT_OLLAMA_VERSION;
      mirroredOllamaVersion = { value: effectiveVersion, fetchedAt: Date.now() };
      return effectiveVersion;
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

/**
 * `/api/health` — the always-on operator surface.
 *
 * `/api/version` answers "is a version-shaped thing listening", which is what an
 * Ollama client probes and must stay cheap and static. This endpoint answers the
 * question an unattended deployment actually has: has this process been up
 * continuously, is anything stuck in flight, and what has it survived?
 *
 * `incidents` is the important field. With crash handlers installed the process
 * keeps serving after a stray rejection, which is right for a router powering
 * long agent runs — but it means a repeating fault could otherwise go unnoticed
 * forever. Reporting `repeats` turns "survived quietly" into "survived, and it
 * has happened 40 times", which is actionable.
 */
app.get('/api/health', (req: Request, res: Response) => {
  const snapshot = durability.snapshot();
  const startedMs = Date.parse(snapshot.startedAt);
  const uptimeMs = Number.isFinite(startedMs) ? Date.now() - startedMs : 0;
  // Quarantine count comes from the registry's own snapshot: a member parked
  // under an active cooldown is the single most common reason a chain looks
  // "broken" after a long uptime, so health states the number up front.
  let quarantined = 0;
  try {
    for (const chain of Object.values(healthRegistry.snapshot())) {
      quarantined += (chain.dead?.length || 0) + (chain.degraded?.length || 0);
    }
  } catch {
    // A registry failure must not make health itself fail.
  }
  res.json({
    ok: !snapshot.shuttingDown,
    status: snapshot.shuttingDown ? 'draining' : 'serving',
    startedAt: snapshot.startedAt,
    uptimeMs,
    uptimeHuman: formatUptime(uptimeMs),
    inFlight: snapshot.inFlight,
    peakInFlight: snapshot.peakInFlight,
    incidents: snapshot.incidents,
    quarantinedMembers: quarantined,
    state: {
      configDir: LOCAL_ROUTER_CONFIG_DIR,
      trajectoryDir: trajectoryDir(),
      healthStatePath: healthStatePath(),
      logPath: path.join(LOCAL_ROUTER_CONFIG_DIR, `proxy-${PORT}.log`)
    },
    // The limits a long-running process is actually working under, so an
    // operator can reason about behaviour without reading source.
    limits: {
      streamFirstByteMs: STREAM_FIRST_BYTE_TIMEOUT_MS,
      streamIdleMs: STREAM_IDLE_TIMEOUT_MS,
      nonStreamMs: NON_STREAM_TIMEOUT_MS,
      shutdownGraceMs: Number(process.env.LOCAL_ROUTER_SHUTDOWN_GRACE_MS) > 0
        ? Number(process.env.LOCAL_ROUTER_SHUTDOWN_GRACE_MS)
        : 10 * 60 * 1000
    }
  });
});

/** `3d 4h 12m` — readable at a glance in a JSON dump or a `jq` pipeline. */
function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

}

