import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Readable, Transform, Writable } from 'stream';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile as execFileCallback, execFileSync } from 'child_process';
import { promisify } from 'util';
import { WebSocket, WebSocketServer } from 'ws';
import { ProxyProvider } from './types';
import {
  OAuthProviderId,
  OAuthProviderState,
  OAuthProviderSummary,
  clearOAuthCredentials,
  fetchOAuthProviderModels,
  getOAuthAccessToken,
  getOAuthState,
  getOAuthStatus,
  getOAuthUpstreamHeaders,
  initAntigravityLogin,
  detectLocalAntigravitySession,
  detectLocalCursorSession,
  isOAuthProvider,
  listOAuthProviders,
  refreshOAuthToken,
  startCopilotLogin,
  cancelCopilotLogin
} from './oauth-providers';
import { createTlsServers, resolveTlsSettings, ZERO_CONFIG_HOSTNAME } from './tls';

/** Bridge helper for places that have a `string` and need to check
 *  whether it's one of our OAuth provider slugs. */
function isOAuthProviderName(name: string): boolean {
  return isOAuthProvider(name);
}

/** Safe wrapper around `getOAuthState` for code paths that might receive
 *  a non-OAuth slug (the underlying helper throws on unknown ids). */
function getOAuthStateSafe(name: string): OAuthProviderState | undefined {
  if (!isOAuthProviderName(name)) return undefined;
  return getOAuthState(name as OAuthProviderId);
}
import { sanitizeProviderRequestBody, stripReasoningMetadata, ThinkingLevel, DEFAULT_THINKING_LEVEL } from './reasoning';
import { loadExpertLogs, LogEntryTracker, createUsageSpyStream } from './expert-logs';
import { buildWraparoundExecutionPlan, buildEscalatingWraparoundPlan, buildMultiPassExecutionPlan, DEFAULT_FALLBACK_ROUNDS } from './execution-plan';
import {
  filterEligibleFallbackModels,
  estimateRequestContext,
  requestRequiresMultimodal,
  ModelCapabilitySpecs
} from './routing-capabilities';
import {
  buildResponseCreatedEvent,
  chatCompletionToResponsesResponse,
  createResponsesFakeResponse,
  cryptoRandomId,
  formatResponsesSseEvent
} from './responses-stream';
import { ensureOllamaBackend, pullOllamaCloudModels } from './ollama-backend';
import {
  filterOllamaCloudPullTags,
  isOllamaCloudPresentedIdBlocked
} from './ollama-cloud-catalog';
import {
  gatewayModelCatalogDisplay,
  gatewayPresentedModelId,
  gatewayPresentedModelSegment,
  resolveGatewayPresentedLegacyId
} from './gateway-provider-catalog';
import { registerConfigApiRoutes } from './routes/config-api';
import {
  PROVIDER_MODEL_REGISTRY,
  providerHasNoLiveModelList
} from './provider-model-registries';
import { catalogProviderSummaries } from './provider-registry';
import { loadCurationConfigs, loadRouterSettings, ROUTER_SETTINGS_PATH, saveRouterSettings, loadAgentProxyConfig, AgentProxyConfig } from './config-persistence';
import { normalizeGatewayChatCompletionBody } from './gateway-response';
import {
  DEFAULT_FALLBACK_ORDERED_IDS,
  buildDefaultFallbackModelIds,
  buildDefaultFallbackModelsText,
  PRESET_FALLBACK_ROUTES,
  OBSOLETE_PRESET_ROUTE_IDS
} from './routing-defaults';
import {
  DEFAULT_OLLAMA_API_KEY,
  ensureDefaultOllamaApiKey,
  isOllamaPlaceholderKey,
  isRealOllamaComApiKey,
  resolveOllamaApiKey
} from './ollama-keys';
import { assertSafeUpstreamUrl, safeFetch } from './ssrf-guard';
import { runCliAuto } from './cli-auto-bridge';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

export type ProviderModel = {
  id: string;
  provider: string;
  model: string;
  display: string;
  contextLength: number;
  outputTokens: number;
  supportsTools: boolean;
  supportsImages: boolean;
  supportsCache: boolean;
  supportsReasoning: boolean;
  tier?: string;
  sourceUrl?: string;
};

type ProviderSource = 'catalog' | 'custom';

export type ProviderSummary = {
  name: string;
  endpoint: string;
  keyEnvVar: string;
  defaultTool: string;
  source?: ProviderSource;
  displayName?: string;
};

export type CustomProviderRecord = {
  name: string;
  displayName?: string;
  endpoint: string;
  keyEnvVar: string;
  defaultTool: string;
  createdAt: string;
  /** Registered model names for this provider. Loopback local backends
   *  (llama.cpp `llama-server`, Unsloth) keep their models discoverable
   *  even while the backend is offline — connection state is a health
   *  concern, not a configuration concern. */
  models?: string[];
};

export type ProviderModelParseResult =
  | { ok: true; models: ProviderModel[] }
  | { ok: false; error: string };

type FallbackModel = {
  id: string;
  models: string[];
  disabledModels?: string[];
};

type FallbackModelParseResult =
  | { ok: true; model: FallbackModel }
  | { ok: false; error: string };

export type { FallbackModel, FallbackModelParseResult };

type ModelTarget = {
  providerName: string;
  actualModel: string;
  presentedModel?: string;
};

type AttemptFailure = {
  errorType: 'unknown_model' | 'provider_not_found' | 'provider_config' | 'upstream_http' | 'upstream_http_quota' | 'upstream_http_payment_required' | 'upstream_http_auth' | 'upstream_http_rate_limit' | 'upstream_http_unavailable' | 'upstream_http_invalid_request' | 'proxy_runtime';
  providerName?: string;
  actualModel?: string;
  status?: number;
  message: string;
  responseText?: string;
};

type AttemptSuccess = {
  providerName: string;
  actualModel: string;
  requestBody: any;
  response: globalThis.Response;
};

type AttemptResult =
  | { ok: true; value: AttemptSuccess }
  | { ok: false; error: AttemptFailure };

type CompletionOutputFormat = 'openai' | 'ollama_chat' | 'ollama_generate' | 'openai_responses';

dotenv.config();

const app = express();
const DEFAULT_PORT = 11434;
const DEFAULT_CONTEXT_LENGTH = 64000;
const CATALOG_MIGRATION_VERSION = 2;
const DEFAULT_OUTPUT_TOKENS = 4096;
const FALLBACK_PROVIDER_NAME = 'local-router';
const FALLBACK_PROVIDER_LEGACY_NAMES = ['fvs-code', 'fallback'];
const FALLBACK_PRIMARY_ATTEMPTS = 3;
const LOCAL_ROUTER_CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
const LEGACY_FVS_CONFIG_DIR = path.join(os.homedir(), '.config', 'fvs-code');
const FALLBACK_MODELS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'fallback-models.json');
const LEGACY_FALLBACK_MODELS_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'fallback-models.json');
const SYSTEM_PROMPT_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'system-prompt.json');
const LEGACY_SYSTEM_PROMPT_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'system-prompt.json');
const THINKING_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'thinking-config.json');
const LEGACY_THINKING_CONFIG_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'thinking-config.json');
const PROVIDER_MODELS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'provider-models.json');
const LEGACY_PROVIDER_MODELS_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'provider-models.json');
const MODEL_SOURCE_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'model-source-config.json');
const LEGACY_MODEL_SOURCE_CONFIG_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'model-source-config.json');
const ENDPOINT_MODELS_CACHE_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'endpoint-models-cache.json');
const LEGACY_ENDPOINT_MODELS_CACHE_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'endpoint-models-cache.json');
const CUSTOM_PROVIDERS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'custom-providers.json');
const WAFER_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'wafer-config.json');
const HEADROOM_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'headroom-config.json');
const RESERVED_PROVIDER_SLUGS = new Set([
  FALLBACK_PROVIDER_NAME,
  ...FALLBACK_PROVIDER_LEGACY_NAMES,
  'provider'
]);
const PROVIDER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PROVIDER_KEY_ENV_PATTERN = /^[A-Z0-9_]+_API_KEY$/;
const MAX_PROVIDER_SLUG_LENGTH = 48;
const SYSTEM_FALLBACK_ROUTE_ID = 'fallback-models';

/** Maps persisted upstream-style paths to presented catalog aliases. */
const UPSTREAM_MODEL_ID_ALIASES: Record<string, string> = {
  'nebius/zai-org/GLM-5.1': 'zai-code-pass-glm-5.1',
  'modal/zai-org/GLM-5.1-FP8': 'modal-glm-5.1-fp8',
  'nvidia-nim/stepfun-ai/step-3.7-flash': 'nvidia-nim-step-3.7-flash',
  'nebius/deepseek-ai/DeepSeek-V4-Pro': 'nebius-deepseek-v4-pro',
  'opencode/deepseek-v4-pro': 'opencode-go-deepseek-v4-pro',
  'opencode-go/deepseek-v4-pro': 'opencode-go-deepseek-v4-pro',
  'opencode/minimax-m3': 'opencode-go-minimax-m3',
  'opencode-go/minimax-m3': 'opencode-go-minimax-m3',
  'opencode/minimax-m3-free': 'opencode-zen-minimax-m3-free',
  'opencode-go/minimax-m3-free': 'opencode-zen-minimax-m3-free',
  'opencode-code/minimax-m3-free': 'opencode-zen-minimax-m3-free',
  'opencode/kimi-k2.6': 'opencode-go-kimi-k2.7-code',
  'opencode-go/kimi-k2.6': 'opencode-go-kimi-k2.7-code',
  'opencode/kimi-k2.7-code': 'opencode-go-kimi-k2.7-code',
  'opencode-go/kimi-k2.7-code': 'opencode-go-kimi-k2.7-code',
  'opencode/glm-5.1': 'opencode-go-glm-5.1',
  'opencode-go/glm-5.1': 'opencode-go-glm-5.1',
  'opencode/deepseek-v4-flash': 'opencode-go-deepseek-v4-flash',
  'opencode-go/deepseek-v4-flash': 'opencode-go-deepseek-v4-flash',
  'opencode/qwen3.7-max': 'opencode-go-qwen3.7-max',
  'opencode-go/qwen3.7-max': 'opencode-go-qwen3.7-max',
  'opencode/mimo-v2.5-pro': 'opencode-go-mimo-v2.5-pro',
  'opencode-go/mimo-v2.5-pro': 'opencode-go-mimo-v2.5-pro',
  'opencode/mimo-v2.5': 'opencode-go-mimo-v2.5',
  'opencode-go/mimo-v2.5': 'opencode-go-mimo-v2.5',
  'opencode-minimax-m3': 'opencode-go-minimax-m3',
  'opencode-minimax-m3-free': 'opencode-zen-minimax-m3-free',
  'opencode-code-minimax-m3': 'opencode-go-minimax-m3',
  'opencode-code-minimax-m3-free': 'opencode-zen-minimax-m3-free',
  'opencode-code-kimi-k2.6': 'opencode-go-kimi-k2.7-code',
  'opencode-code-kimi-k2.7-code': 'opencode-go-kimi-k2.7-code',
  'opencode-code-glm-5.1': 'opencode-go-glm-5.1',
  'opencode-code-deepseek-v4-pro': 'opencode-go-deepseek-v4-pro',
  'opencode-code-deepseek-v4-flash': 'opencode-go-deepseek-v4-flash',
  'opencode-code-qwen3.7-max': 'opencode-go-qwen3.7-max',
  'opencode-code-mimo-v2.5-pro': 'opencode-go-mimo-v2.5-pro',
  'opencode-code-mimo-v2.5': 'opencode-go-mimo-v2.5',
  'opencode-kimi-k2.6': 'opencode-go-kimi-k2.7-code',
  'opencode-kimi-k2.7-code': 'opencode-go-kimi-k2.7-code',
  'opencode-glm-5.1': 'opencode-go-glm-5.1',
  'opencode-deepseek-v4-pro': 'opencode-go-deepseek-v4-pro',
  'opencode-deepseek-v4-flash': 'opencode-go-deepseek-v4-flash',
  'opencode-qwen3.7-max': 'opencode-go-qwen3.7-max',
  'opencode-mimo-v2.5-pro': 'opencode-go-mimo-v2.5-pro',
  'opencode-mimo-v2.5': 'opencode-go-mimo-v2.5',
  'xiaomi-mimo/mimo-v2.5': 'xiaomi-mimo-mimo-v2.5',
  'zenmux/xiaomi/mimo-v2.5': 'zenmux-mimo-v2.5',
  'zenmux/xiaomi/mimo-v2.5-pro': 'zenmux-mimo-v2.5-pro',
  'nebius/nvidia/Nemotron-3-Ultra-550b-a55b': 'nebius-nemotron-3-ultra-550b-a55b',
  'openrouter-presets/@preset/chain-of-draft': 'openrouter-chain-of-draft',
  'openrouter/@preset/chain-of-draft': 'openrouter-chain-of-draft',
  'wafer-serverless/deepseek-v4-flash': 'wafer-ai-deepseek-v4-flash',
  'wafer-serverless/MiniMax-M3': 'wafer-ai-minimax-m3',
  'wafer-serverless/minimax-m3': 'wafer-ai-minimax-m3',
  'openrouter-presets/openrouter/free': 'openrouter-free',
  'openrouter/openrouter/free': 'openrouter-free',
  'openrouter-presets/deepseek/deepseek-v4-flash': 'openrouter-deepseek-v4-flash',
  'openrouter/deepseek/deepseek-v4-flash': 'openrouter-deepseek-v4-flash',
  'zenmux/deepseek/deepseek-v4-flash': 'zenmux-deepseek-v4-flash',
  'kilo/openrouter/free': 'kilo-openrouter-free',
  'kilo/nvidia/nemotron-3-ultra-550b-a55b:free': 'kilo-nvidia-nemotron-3-ultra-550b-a55b-free',
  'kilo/deepseek/deepseek-v4-flash': 'kilo-deepseek-deepseek-v4-flash-paid',
  'cline/deepseek/deepseek-v4-flash': 'cline-deepseek-deepseek-v4-flash-free',
  'cline/deepseek/deepseek-v4-pro': 'cline-deepseek-deepseek-v4-pro-paid',
  'cline/deepseek/deepseek-chat': 'cline-deepseek-deepseek-chat-paid',
  'cline/z-ai/glm-5.1': 'cline-z-ai-glm-5.1-paid',
  'cline/qwen/qwen3.7-max': 'cline-qwen-qwen3.7-max-paid',
  'cline/stepfun/step-3.7-flash': 'cline-stepfun-step-3.7-flash-paid',
  'cline/xiaomi/mimo-v2.5-pro': 'cline-xiaomi-mimo-v2.5-pro-paid',
  'cline/moonshotai/kimi-k2.6': 'cline-moonshotai-kimi-k2.6-paid',
  'kilo/deepseek/deepseek-v4-pro': 'kilo-deepseek-deepseek-v4-pro-paid',
  'kilo/deepseek/deepseek-chat': 'kilo-deepseek-deepseek-chat-paid',
  'kilo/z-ai/glm-5.1': 'kilo-z-ai-glm-5.1-paid',
  'kilo/qwen/qwen3.7-max': 'kilo-qwen-qwen3.7-max-paid',
  'kilo/minimax/minimax-m3': 'kilo-minimax-minimax-m3-paid',
  'kilo/stepfun/step-3.7-flash': 'kilo-stepfun-step-3.7-flash-paid',
  'kilo/xiaomi/mimo-v2.5-pro': 'kilo-xiaomi-mimo-v2.5-pro-paid',
  'kilo/xiaomi/mimo-v2.5': 'kilo-xiaomi-mimo-v2.5-paid',
  'kilo/moonshotai/kimi-k2.7-code': 'kilo-moonshotai-kimi-k2.7-code-paid'
};

const DEFAULT_FALLBACK_MODELS_TEXT = buildDefaultFallbackModelsText();

const parsedFallbackBaseRetrySeconds = Number.parseInt(
  process.env.LOCAL_ROUTER_FALLBACK_BASE_RETRY_SECONDS || process.env.FVS_FALLBACK_BASE_RETRY_SECONDS || '2',
  10
);
const FALLBACK_BASE_RETRY_SECONDS = Number.isInteger(parsedFallbackBaseRetrySeconds) && parsedFallbackBaseRetrySeconds >= 0
  ? parsedFallbackBaseRetrySeconds
  : 2;
const PROVIDER_PRESENTATION_PREFIXES: Record<string, string> = {
  'wafer-serverless': 'wafer-ai',
  'openrouter-presets': 'openrouter'
};

/**
 * Legacy provider slugs → canonical provider names. `openrouter-presets` was
 * renamed to `openrouter` (2026-08-18); persisted overrides, routing configs,
 * and older API calls may still reference the legacy slug.
 */
const LEGACY_PROVIDER_SLUG_ALIASES: Record<string, string> = {
  'openrouter-presets': 'openrouter'
};

export function canonicalProviderSlug(providerName: string): string {
  const trimmed = String(providerName || '').trim();
  return LEGACY_PROVIDER_SLUG_ALIASES[trimmed] || trimmed;
}
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(__filename) === fs.realpathSync(path.resolve(entry));
  } catch {
    return false;
  }
}

// Serve only when run as the process entrypoint (node build/index.js,
// tsx src/index.ts, bin/local-router.js child). Library consumers — e.g.
// tests importing build/index.js for pure helpers — bind nothing so the
// importing process can exit when its work is done.
export const shouldServe = isMainModule() || process.env.LOCAL_ROUTER_FORCE_SERVE === 'true';

const parsedPort = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
  ? parsedPort
  : DEFAULT_PORT;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Stricter rate limiting for config mutations and OAuth login.
const oauthLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many OAuth login attempts, please try again later.' }
});
const configMutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many config mutation requests, please try again later.' }
});

// Apply stricter limits to sensitive endpoints.
app.use('/api/oauth/login', oauthLoginLimiter);
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    return configMutationLimiter(req as any, res as any, next as any);
  }
  next();
});

// In-memory Key Store
const keyStore: Record<string, string> = {};
/** Providers whose keys were saved through the UI this process (source: memory). */
const uiSavedProviderKeys = new Set<string>();
const modelStore: Record<string, ProviderModel[]> = {};
const persistedProviderModelOverrides = new Set<string>();
let customProviderStore: CustomProviderRecord[] = [];
const fallbackModelStore: Record<string, FallbackModel> = {};
const modelSourceConfig: {
  catalogMigrationVersion?: number;
  source: 'custom' | 'endpoints';
  filterConfigured: boolean;
  curationEnabled: boolean;
  curatedEndpointModelKeys: string[];
  defaultCurationConfig?: string;
} = { source: 'custom', filterConfigured: true, curationEnabled: false, curatedEndpointModelKeys: [] };
const MAX_CURATED_ENDPOINT_MODEL_KEYS = 5000;
let endpointModelsCache: ProviderModel[] = [];
const DEFAULT_CHAIN_OF_DRAFT_PROMPT = `Think step by step, but only keep a minimum draft for each thinking step, with 5 words at most. Return the answer after your thinking.`;
const systemPromptConfig: { enabled: boolean; prompt: string; thinkingLevel: ThinkingLevel } = {
  enabled: false,
  prompt: DEFAULT_CHAIN_OF_DRAFT_PROMPT,
  thinkingLevel: DEFAULT_THINKING_LEVEL
};
const SECRET_FIELD_PATTERN = /(authorization|api[_-]?key|token|secret|password|cookie|set-cookie)/i;
function sanitizeDiagnosticText(value: string, maxLength = 180) {
  const redacted = value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*\s*[:=]\s*)([^,\s]+)/gi, '$1[REDACTED]')
    .trim();

  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}…`;
}

let catalogProviderSummariesCache: ProviderSummary[] | null = null;

function readCatalogProviderSummaries(): ProviderSummary[] {
  // In-code registry (src/provider-registry.ts) — providers.txt was removed
  // from the project 2026-08-20. Static per process; the module caches.
  if (catalogProviderSummariesCache) return catalogProviderSummariesCache;
  catalogProviderSummariesCache = catalogProviderSummaries() as ProviderSummary[];
  return catalogProviderSummariesCache;
}

function readCustomProviderSummaries(): ProviderSummary[] {
  return customProviderStore.map((record) => ({
    name: record.name,
    endpoint: record.endpoint,
    keyEnvVar: record.keyEnvVar,
    defaultTool: record.defaultTool || 'OpenAI Compatible',
    displayName: record.displayName,
    source: 'custom' as const
  }));
}

function allProviderSummaries(): ProviderSummary[] {
  return [...readCatalogProviderSummaries(), ...readCustomProviderSummaries()];
}

function isCustomProvider(providerName: string): boolean {
  return customProviderStore.some((record) => record.name === providerName);
}

function catalogProviderNames(): Set<string> {
  return new Set(readCatalogProviderSummaries().map((provider) => provider.name));
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * Custom providers whose endpoint is a local loopback service (llama.cpp
 * `llama-server`, Unsloth, and similar local backends registered by the
 * Local Router service shims) require no API key — the local HTTP endpoint
 * has no auth, so they count as configured and are probed on refresh.
 */
function isLocalLoopbackProvider(providerName: string): boolean {
  const record = customProviderStore.find((entry) => entry.name === providerName);
  if (!record) return false;
  try {
    const parsed = new URL(record.endpoint);
    return parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function normalizeCustomProviderEndpoint(rawEndpoint: string): { ok: true; endpoint: string } | { ok: false; error: string } {
  const trimmed = String(rawEndpoint || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'endpoint is required.' };
  }

  let normalized = trimmed.replace(/\/+$/, '');
  if (!normalized.endsWith('/v1')) {
    normalized = `${normalized}/v1`;
  }

  try {
    const parsed = new URL(normalized);
    const loopbackHttp = parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname);
    if (parsed.protocol !== 'https:' && !loopbackHttp) {
      return { ok: false, error: 'endpoint must use https:// (http:// is allowed only for localhost/127.0.0.1).' };
    }
  } catch {
    return { ok: false, error: 'endpoint must be a valid URL.' };
  }

  return { ok: true, endpoint: normalized };
}

function suggestKeyEnvVarForSlug(slug: string): string {
  const normalized = slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const base = normalized || 'CUSTOM';
  return `${base}_API_KEY`;
}

function validateCustomProviderSlug(slug: string): { ok: true; slug: string } | { ok: false; error: string } {
  const trimmed = String(slug || '').trim().toLowerCase();
  if (!trimmed) {
    return { ok: false, error: 'provider id (slug) is required.' };
  }
  if (trimmed.length > MAX_PROVIDER_SLUG_LENGTH) {
    return { ok: false, error: `provider id must be at most ${MAX_PROVIDER_SLUG_LENGTH} characters.` };
  }
  if (!PROVIDER_SLUG_PATTERN.test(trimmed)) {
    return { ok: false, error: 'provider id must be lowercase letters, numbers, and hyphens.' };
  }
  if (RESERVED_PROVIDER_SLUGS.has(trimmed)) {
    return { ok: false, error: `provider id "${trimmed}" is reserved.` };
  }
  if (catalogProviderNames().has(trimmed)) {
    return { ok: false, error: `provider id "${trimmed}" already exists in the provider registry.` };
  }
  return { ok: true, slug: trimmed };
}

function validateCustomProviderKeyEnvVar(
  keyEnvVar: string,
  excludeProviderName?: string
): { ok: true; keyEnvVar: string } | { ok: false; error: string } {
  const trimmed = String(keyEnvVar || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'keyEnvVar is required.' };
  }
  if (!PROVIDER_KEY_ENV_PATTERN.test(trimmed)) {
    return { ok: false, error: 'keyEnvVar must match ^[A-Z0-9_]+_API_KEY$.' };
  }

  const conflict = allProviderSummaries().find((provider) => (
    provider.keyEnvVar === trimmed && provider.name !== excludeProviderName
  ));
  if (conflict) {
    return { ok: false, error: `keyEnvVar already used by provider "${conflict.name}".` };
  }

  return { ok: true, keyEnvVar: trimmed };
}

function parseCustomProviderPayload(
  body: any,
  options: { requireName: boolean; existingName?: string }
): { ok: true; record: CustomProviderRecord } | { ok: false; error: string } {
  const existingName = options.existingName;
  const slugResult = options.requireName
    ? validateCustomProviderSlug(body?.name)
    : { ok: true as const, slug: existingName || '' };

  if (!slugResult.ok) {
    return slugResult;
  }
  if (!slugResult.slug) {
    return { ok: false, error: 'provider id is required.' };
  }

  const keyEnvVarResult = validateCustomProviderKeyEnvVar(
    body?.keyEnvVar || suggestKeyEnvVarForSlug(slugResult.slug),
    existingName
  );
  if (!keyEnvVarResult.ok) {
    return keyEnvVarResult;
  }

  const endpointResult = normalizeCustomProviderEndpoint(body?.endpoint);
  if (!endpointResult.ok) {
    return endpointResult;
  }

  const displayName = String(body?.displayName || body?.display || slugResult.slug).trim() || slugResult.slug;
  const defaultTool = String(body?.defaultTool || 'OpenAI Compatible').trim() || 'OpenAI Compatible';
  const existing = customProviderStore.find((entry) => entry.name === slugResult.slug);

  const models = sanitizeCustomProviderModels(body?.models)
    ?? (existing?.models ? [...existing.models] : undefined);

  return {
    ok: true,
    record: {
      name: slugResult.slug,
      displayName,
      endpoint: endpointResult.endpoint,
      keyEnvVar: keyEnvVarResult.keyEnvVar,
      defaultTool,
      createdAt: existing?.createdAt || new Date().toISOString(),
      ...(models && models.length > 0 ? { models } : {})
    }
  };
}

/** Operator-registered model names for a custom provider (deduped strings). */
function sanitizeCustomProviderModels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const models = [...new Set(raw
    .map((entry) => String(entry || '').trim())
    .filter(Boolean))];
  return models.length > 0 ? models : undefined;
}

// ── Standard local backends (offline-tolerant) ──────────────────────────────
// llama.cpp `llama-server`, Unsloth, and ollama are first-class loopback
// endpoints. llama.cpp + unsloth register idempotently at boot (keyless —
// the local HTTP endpoint has no auth) so the CONNECTION exists even when
// the binary is down; ollama is a built-in provider served from 11435.
// Registration state is a configuration fact, not a liveness fact: models
// stay discoverable while a backend is offline, and requests fail over
// gracefully. Deleting a standard backend through the API tombstones it so
// boot does not resurrect it.
const STANDARD_LOCAL_BACKENDS: Array<{
  slug: string;
  displayName: string;
  port: number;
  portEnvVar: string;
  keyEnvVar: string;
}> = [
  { slug: 'llama-cpp', displayName: 'llama.cpp (local llama-server)', port: 8080, portEnvVar: 'LLAMA_CPP_PORT', keyEnvVar: 'LLAMA_CPP_API_KEY' },
  { slug: 'unsloth', displayName: 'Unsloth (local)', port: 8888, portEnvVar: 'UNSLOTH_PORT', keyEnvVar: 'UNSLOTH_API_KEY' }
];

function standardLocalBackendPort(backend: (typeof STANDARD_LOCAL_BACKENDS)[number]): number {
  const envVal = process.env[backend.portEnvVar] || (backend.slug === 'unsloth' ? process.env.UNSLOTHER_PORT : '');
  const parsed = Number.parseInt(envVal || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : backend.port;
}

function dismissedLocalBackends(): Set<string> {
  try {
    if (!fs.existsSync(CUSTOM_PROVIDERS_PATH)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_PATH, 'utf8'));
    return new Set(Array.isArray(parsed?.dismissedLocalBackends) ? parsed.dismissedLocalBackends.map(String) : []);
  } catch {
    return new Set();
  }
}

function tombstoneLocalBackend(slug: string): void {
  if (!STANDARD_LOCAL_BACKENDS.some((backend) => backend.slug === slug)) return;
  const dismissed = dismissedLocalBackends();
  dismissed.add(slug);
  persistCustomProviderExtras({ dismissedLocalBackends: [...dismissed].sort() });
}

/** Persist the extras envelope (dismissed tombstones) around the provider list. */
function persistCustomProviderExtras(extras: { dismissedLocalBackends?: string[] }): void {
  try {
    const parsed = fs.existsSync(CUSTOM_PROVIDERS_PATH)
      ? JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_PATH, 'utf8'))
      : {};
    parsed.version = 1;
    parsed.providers = customProviderStore.map((record) => ({ ...record }));
    if (extras.dismissedLocalBackends) parsed.dismissedLocalBackends = extras.dismissedLocalBackends;
    const temporaryPath = `${CUSTOM_PROVIDERS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}
`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, CUSTOM_PROVIDERS_PATH);
  } catch (error: any) {
    console.error('Failed to persist custom provider extras:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function ensureStandardLocalBackends(): void {
  if (process.env.LOCAL_ROUTER_AUTO_REGISTER_LOCAL_BACKENDS === 'false') return;
  const dismissed = dismissedLocalBackends();
  let registered = 0;
  for (const backend of STANDARD_LOCAL_BACKENDS) {
    if (dismissed.has(backend.slug)) continue;
    const existing = customProviderStore.find((entry) => entry.name === backend.slug);
    const port = standardLocalBackendPort(backend);
    if (!existing) {
      customProviderStore.push({
        name: backend.slug,
        displayName: backend.displayName,
        endpoint: `http://127.0.0.1:${port}/v1`,
        keyEnvVar: backend.keyEnvVar,
        defaultTool: 'OpenAI Compatible',
        createdAt: new Date().toISOString()
      });
      registered++;
    } else if (backend.slug === 'unsloth' && existing.endpoint === 'http://127.0.0.1:8000/v1' && port === 8888) {
      existing.endpoint = `http://127.0.0.1:${port}/v1`;
      existing.keyEnvVar = backend.keyEnvVar;
      registered++;
    }
  }
  if (registered > 0) {
    customProviderStore.sort((a, b) => a.name.localeCompare(b.name));
    persistCustomProviders();
    console.log(`[backends] registered ${registered} local backend endpoint(s) (offline-tolerant): ${STANDARD_LOCAL_BACKENDS.map((b) => b.slug).join(', ')}`);
  }
}

/**
 * Loopback custom providers keep their registered models discoverable even
 * while the backend is offline: connection state is a health concern, not a
 * configuration concern. Rows use the same presentation pipeline as a live
 * probe so ids stay identical when the backend comes back.
 */
function localLoopbackRegisteredModels(): ProviderModel[] {
  const rows: ProviderModel[] = [];
  for (const record of customProviderStore) {
    if (!isLocalLoopbackProvider(record.name) || !Array.isArray(record.models)) continue;
    for (const modelName of record.models) {
      const id = defaultPresentedModelName(record.name, modelName);
      rows.push({
        id,
        provider: record.name,
        model: modelName,
        display: `${record.displayName || record.name}: ${modelName}`,
        contextLength: DEFAULT_CONTEXT_LENGTH,
        outputTokens: DEFAULT_OUTPUT_TOKENS,
        supportsTools: false,
        supportsImages: false,
        supportsCache: false,
        supportsReasoning: false,
        tier: 'local'
      });
    }
  }
  return rows;
}

function loadCustomProviders(): void {
  if (!fs.existsSync(CUSTOM_PROVIDERS_PATH)) {
    customProviderStore = [];
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(CUSTOM_PROVIDERS_PATH, 'utf8'));
    const entries = Array.isArray(parsed?.providers) ? parsed.providers : [];
    customProviderStore = entries
      .map((raw: any) => {
        const name = String(raw?.name || '').trim().toLowerCase();
        const endpointResult = normalizeCustomProviderEndpoint(raw?.endpoint || '');
        if (!name || !endpointResult.ok) {
          return null;
        }
        // Tolerant keyEnvVar (2026-09-07): hand-registered keyless loopback
        // providers may carry no/invalid keyEnvVar (e.g. apiKey "none").
        // Dropping the whole record silently DELETED the operator's
        // registered provider + models at first persist. Synthesize a valid
        // env var name instead; loopback providers never read it.
        let keyEnvVar = String(raw?.keyEnvVar || '').trim();
        if (!PROVIDER_KEY_ENV_PATTERN.test(keyEnvVar)) {
          keyEnvVar = `${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
        }
        const models = sanitizeCustomProviderModels(raw?.models);
        return {
          name,
          displayName: String(raw?.displayName || name).trim() || name,
          endpoint: endpointResult.endpoint,
          keyEnvVar,
          defaultTool: String(raw?.defaultTool || 'OpenAI Compatible').trim() || 'OpenAI Compatible',
          createdAt: String(raw?.createdAt || new Date().toISOString()),
          ...(models ? { models } : {})
        } satisfies CustomProviderRecord;
      })
      .filter((entry: CustomProviderRecord | null): entry is CustomProviderRecord => Boolean(entry));
  } catch (error: any) {
    console.error('Failed to load custom providers:', sanitizeDiagnosticText(String(error?.message || error)));
    customProviderStore = [];
  }
}

function persistCustomProviders(): void {
  ensureLocalRouterConfigDir();
  const payload = {
    version: 1,
    providers: customProviderStore
      .map((record) => ({ ...record }))
      .sort((a, b) => a.name.localeCompare(b.name))
  };
  const temporaryPath = `${CUSTOM_PROVIDERS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, CUSTOM_PROVIDERS_PATH);
  fs.chmodSync(CUSTOM_PROVIDERS_PATH, 0o600);
}

function providerReferencedInRouting(providerName: string): string[] {
  const references: string[] = [];
  const prefix = `${providerName}/`;

  for (const route of Object.values(fallbackModelStore)) {
    for (const modelId of route.models) {
      if (modelId === providerName || modelId.startsWith(prefix)) {
        references.push(`fallback:${route.id}`);
      }
      const resolved = resolveModelTarget(modelId);
      if (resolved?.providerName === providerName) {
        references.push(`fallback:${route.id}`);
      }
    }
  }

  return Array.from(new Set(references));
}

function getProviderSummary(name: string): ProviderSummary | undefined {
  const canonicalName = canonicalProviderSlug(name);
  return allProviderSummaries().find((provider) => provider.name === canonicalName);
}

function cloneProviderModel(model: ProviderModel): ProviderModel {
  return {
    ...model
  };
}

function baselineProviderModels(rawProviderName: string): ProviderModel[] {
  const providerName = canonicalProviderSlug(rawProviderName);
  if (isCustomProvider(providerName)) {
    return [];
  }
  return endpointModelsCache
    .filter((model) => model.provider === providerName)
    .map((model) => cloneProviderModel(model));
}

function editableProviderModels(rawProviderName: string): ProviderModel[] {
  const providerName = canonicalProviderSlug(rawProviderName);
  if (!modelStore[providerName]) {
    modelStore[providerName] = baselineProviderModels(providerName);
  }
  return modelStore[providerName];
}

function rawProviderCacheModels(providerName: string): ProviderModel[] {
  // Unfiltered toggle-store section — discovery/refresh UI shows every
  // discovered model so the user can toggle any of them.
  return endpointModelsCache.filter((model) => model.provider === providerName);
}

function effectiveProviderModels(rawProviderName: string): ProviderModel[] {
  const providerName = canonicalProviderSlug(rawProviderName);
  if (modelStore[providerName]) return modelStore[providerName];
  const section = endpointModelsCache.filter((model) => model.provider === providerName);
  if (providerName === 'ollama') return section;
  const curated = new Set(modelSourceConfig.curatedEndpointModelKeys);
  return section.filter((model) => curated.has(endpointModelCurationKey(model)));
}

/**
 * Custom-editor saves are part of the single toggle catalog: pre-check every
 * saved override model so it serves immediately (mirrors the boot migration,
 * which pre-checks persisted overrides).
 */
function ensureCuratedOverrideSelection(providerName: string): void {
  const overrides = modelStore[providerName];
  if (!overrides || overrides.length === 0) return;
  const existing = new Set(modelSourceConfig.curatedEndpointModelKeys);
  let changed = false;
  for (const model of overrides) {
    const key = endpointModelCurationKey(model);
    if (!existing.has(key)) {
      existing.add(key);
      changed = true;
    }
  }
  if (!changed) return;
  modelSourceConfig.curatedEndpointModelKeys = [...existing].slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
  persistModelSourceConfig();
}

function providerModelSource(providerName: string) {
  if (modelStore[providerName]) {
    return 'memory';
  }
  if (isCustomProvider(providerName)) {
    return 'custom';
  }
  return 'baseline';
}

/**
 * Known-catalog view for one provider: explicit overrides when present, else
 * the full cached section (registry ∪ live merges) with NO curation filter.
 * Management surfaces (provider cards, Selected Provider Models list) read
 * this — serving continues through effectiveProviderModels' curated view.
 */
function knownProviderModels(rawProviderName: string): ProviderModel[] {
  const providerName = canonicalProviderSlug(rawProviderName);
  if (modelStore[providerName]) return modelStore[providerName];
  const cached = endpointModelsCache.filter((model) => model.provider === providerName);
  if (cached.length > 0) return cached;
  const registryEntries = PROVIDER_MODEL_REGISTRY[providerName] || [];
  if (registryEntries.length > 0) {
    return mapLiveRawModelsToCatalog(providerName, registryEntries.map((e) => ({ ...e })));
  }
  return [];
}

function providerConfigs() {
  return allProviderSummaries().map((provider) => {
    const hasKeyStoreKey = Boolean(keyStore[provider.name]);
    const hasMemoryKey = uiSavedProviderKeys.has(provider.name);
    const hasEnvKey = Boolean(providerEnvKeyValue(provider.keyEnvVar));
    const ollamaPlaceholder = provider.name === 'ollama'
      && isOllamaPlaceholderKey(keyStore.ollama || process.env.OLLAMA_API_KEY);
    // OAuth-based providers are "configured" when they have a valid access
    // token in the OAuth credentials store (GitHub Copilot device flow,
    // Google Antigravity PKCE). Without this, the UI shows "Not configured"
    // for providers that are actually authenticated via OAuth.
    const isOauth = isOAuthProvider(provider.name);
    const oauthAccessToken = isOauth ? getOAuthState(provider.name as OAuthProviderId)?.accessToken : undefined;
    const hasOAuthKey = Boolean(oauthAccessToken);
    const configured = provider.name === 'ollama' || hasKeyStoreKey || hasEnvKey || hasOAuthKey;
    let configuredSource: string;
    if (provider.name === 'ollama' && ollamaPlaceholder) {
      configuredSource = 'default';
    } else if (hasMemoryKey) {
      configuredSource = 'memory';
    } else if (pqcBundleProviders.has(provider.name)) {
      configuredSource = 'pqc';
    } else if (hasEnvKey) {
      configuredSource = 'env';
    } else if (hasOAuthKey) {
      configuredSource = 'oauth';
    } else {
      configuredSource = 'none';
    }
    const models = knownProviderModels(provider.name);
    const isCustom = provider.source === 'custom' || isCustomProvider(provider.name);

    // Attach OAuth status for OAuth-based providers so the config UI can
    // render the correct auth control (login button vs. key text field).
    const oauthStatus = isOAuthProvider(provider.name) ? getOAuthStatus(provider.name as OAuthProviderId) : undefined;

    return {
      ...provider,
      isCustom,
      configured,
      configuredSource,
      ollamaPlaceholder: provider.name === 'ollama' ? ollamaPlaceholder : undefined,
      modelSource: providerModelSource(provider.name),
      modelCount: models.length,
      models,
      oauthStatus
    };
  });
}

function providerBaseUrlEnvVar(providerName: string) {
  return `LOCAL_ROUTER_PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
}

function providerBaseUrl(summary: ProviderSummary) {
  const legacyEnvVar = `FVS_PROVIDER_${summary.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
  return process.env[providerBaseUrlEnvVar(summary.name)] || process.env[legacyEnvVar] || summary.endpoint;
}

function parseNumberCell(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value.replace(/,/g, '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseYesNoCell(value: string | undefined, fallback = false) {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith('yes')) return true;
  if (normalized.startsWith('no')) return false;
  return fallback;
}

function providerPresentationPrefix(providerName: string) {
  return PROVIDER_PRESENTATION_PREFIXES[providerName] || providerName;
}

function modelAliasSegment(modelName: string) {
  const segment = modelName.split('/').filter(Boolean).pop() || modelName;
  return segment
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function defaultPresentedModelName(providerName: string, modelName: string) {
  if (providerName === 'kilo' || providerName === 'cline') {
    return gatewayPresentedModelId(providerName, modelName);
  }
  const prefix = providerPresentationPrefix(providerName);
  const segment = modelAliasSegment(modelName);
  if (segment.startsWith(`${prefix}-`)) {
    return segment;
  }
  return `${prefix}-${segment || 'model'}`;
}

/**
 * Presented ids must stay unique per provider (2026-09-04): several providers
 * publish alias ids for the same underlying model (`zai-org/GLM-5.3-Flash`,
 * `GLM-5.3-Flash`, `glm-5.3-flash`) and each alias is a distinct curated
 * entry — the operator wires them into fallback chains separately to burn
 * credits in a chosen order. When the short segment collides, fall back to
 * the provider prefix + full sanitized model name (org segment included),
 * then a numeric suffix as a last resort.
 */
function makeUniquePresentedModelName(
  providerName: string,
  modelName: string,
  usedIds: Set<string>
): string {
  const base = defaultPresentedModelName(providerName, modelName);
  if (!usedIds.has(base)) return base;

  const prefix = providerPresentationPrefix(providerName);
  const fullSegment = modelName
    .replace(/^@/, '')
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const fullBase = fullSegment.startsWith(`${prefix}-`)
    ? fullSegment
    : `${prefix}-${fullSegment || 'model'}`;
  if (!usedIds.has(fullBase)) return fullBase;

  let suffix = 2;
  while (usedIds.has(`${fullBase}-${suffix}`)) suffix += 1;
  return `${fullBase}-${suffix}`;
}

function providerModelDisplay(providerName: string, modelName: string) {
  if (providerName === 'kilo' || providerName === 'cline') {
    return gatewayModelCatalogDisplay(providerName, modelName);
  }
  return `${providerPresentationPrefix(providerName)}:${modelName}`;
}

function modelCapabilities(model: ProviderModel) {
  const capabilities = ['completion'];
  if (model.supportsTools) capabilities.push('tools');
  if (model.supportsImages) capabilities.push('vision');
  return capabilities;
}

function modelMaxInputTokens(model: ProviderModel) {
  return model.contextLength || DEFAULT_CONTEXT_LENGTH;
}

function modelMaxOutputTokens(model: ProviderModel) {
  return model.outputTokens || DEFAULT_OUTPUT_TOKENS;
}

function stripOllamaLatestSuffix(value: string) {
  return value.endsWith(':latest') ? value.slice(0, -':latest'.length) : value;
}

function providerModelAliases(model: ProviderModel) {
  const aliases = new Set<string>([
    model.id,
    model.display,
    model.model,
    `${model.provider}/${model.model}`,
    `${model.provider}/${model.id}`
  ]);

  if (model.provider === FALLBACK_PROVIDER_NAME) {
    aliases.add(fallbackPresentedModelId(model.model));
    for (const legacyName of FALLBACK_PROVIDER_LEGACY_NAMES) {
      aliases.add(`${legacyName}/${model.model}`);
    }
  }

  for (const alias of [...aliases]) {
    if (alias && !alias.includes(':')) {
      aliases.add(`${alias}:latest`);
    }
  }

  return aliases;
}

function splitModelAliasEntry(entry: string): { model: string; presentedName: string } | null {
  if (entry.includes('|')) {
    return null;
  }

  const separatorIndex = entry.lastIndexOf(':');
  if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
    return null;
  }

  return {
    model: entry.slice(0, separatorIndex).trim(),
    presentedName: entry.slice(separatorIndex + 1).trim()
  };
}

function parseProviderModels(providerName: string, payload: any): ProviderModelParseResult {
  const rawModels = payload?.modelsText !== undefined ? payload.modelsText : payload?.models;
  const entries = Array.isArray(rawModels)
    ? rawModels
    : typeof rawModels === 'string'
      ? rawModels.split(/[,\r\n]+/)
      : [];

  if (entries.length === 0) {
    return { ok: false, error: 'models must be a non-empty array or comma/newline-delimited string.' };
  }

  const seenPresentedNames = new Set<string>();
  const models: ProviderModel[] = [];

  for (const entry of entries) {
    let model = '';
    let presentedName = '';
    let contextLength = DEFAULT_CONTEXT_LENGTH;
    let outputTokens = DEFAULT_OUTPUT_TOKENS;
    let supportsTools = true;
    let supportsImages = false;
    let supportsCache = false;
    let supportsReasoning = false;

    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const parsedEntry = splitModelAliasEntry(trimmed);
      if (!parsedEntry) {
        return {
          ok: false,
          error: 'Use colon-separated model aliases: provider-required-model:presented-local-router-model.'
        };
      }
      model = parsedEntry.model;
      presentedName = parsedEntry.presentedName;
    } else if (entry && typeof entry === 'object') {
      model = typeof entry.model === 'string' ? entry.model.trim() : '';
      presentedName = typeof entry.id === 'string'
        ? entry.id.trim()
        : typeof entry.presentedName === 'string'
          ? entry.presentedName.trim()
          : '';
      contextLength = typeof entry.contextLength === 'number' ? entry.contextLength : contextLength;
      outputTokens = typeof entry.outputTokens === 'number' ? entry.outputTokens : outputTokens;
      supportsTools = typeof entry.supportsTools === 'boolean' ? entry.supportsTools : supportsTools;
      supportsImages = typeof entry.supportsImages === 'boolean' ? entry.supportsImages : supportsImages;
      supportsCache = typeof entry.supportsCache === 'boolean' ? entry.supportsCache : supportsCache;
      supportsReasoning = typeof entry.supportsReasoning === 'boolean' ? entry.supportsReasoning : supportsReasoning;
    }

    if (model.startsWith(`${providerName}/`)) {
      model = model.slice(providerName.length + 1);
    }
    if (!presentedName) {
      presentedName = defaultPresentedModelName(providerName, model);
    }

    if (!model) continue;
    if (!Number.isInteger(contextLength) || contextLength <= 0) {
      return { ok: false, error: `Context length must be a positive integer for model: ${model}` };
    }
    if (!Number.isInteger(outputTokens) || outputTokens <= 0) {
      return { ok: false, error: `Output tokens must be a positive integer for model: ${model}` };
    }
    if (model.length > 512) {
      return { ok: false, error: `Model ID is too long: ${model.slice(0, 64)}` };
    }
    if (!/^[A-Za-z0-9@._:\/+-]+$/.test(model)) {
      return { ok: false, error: `Model ID contains unsupported characters: ${model}` };
    }
    if (presentedName.length > 512) {
      return { ok: false, error: `Presented model name is too long for model: ${model}` };
    }
    if (!/^[A-Za-z0-9@._:\/+-]+$/.test(presentedName)) {
      return { ok: false, error: `Presented model name contains unsupported characters: ${presentedName}` };
    }
    if (seenPresentedNames.has(presentedName)) {
      return { ok: false, error: `Duplicate presented model name: ${presentedName}` };
    }

    seenPresentedNames.add(presentedName);
    models.push({
      id: presentedName,
      provider: providerName,
      model,
      display: providerModelDisplay(providerName, model),
      contextLength,
      outputTokens,
      supportsTools,
      supportsImages,
      supportsCache,
      supportsReasoning
    });
  }

  if (models.length === 0) {
    return { ok: false, error: 'At least one model is required.' };
  }

  return { ok: true, models };
}

function parseSingleProviderModel(providerName: string, payload: any): ProviderModelParseResult {
  return parseProviderModels(providerName, { models: [payload] });
}

export function parseFallbackModel(payload: any, options?: { allowShort?: boolean }): FallbackModelParseResult {
  const rawId = typeof payload?.id === 'string' ? payload.id.trim() : '';
  const id = normalizeFallbackRouteId(rawId);
  if (!id) {
    return { ok: false, error: 'Fallback model id is required.' };
  }
  if (id.length > 512) {
    return { ok: false, error: `Fallback model id is too long: ${id.slice(0, 64)}` };
  }
  if (!/^[A-Za-z0-9@._:\/+-]+$/.test(id)) {
    return { ok: false, error: `Fallback model id contains unsupported characters: ${id}` };
  }
  if (id.includes('/')) {
    return { ok: false, error: `Fallback model id must be a single route name or ${FALLBACK_PROVIDER_NAME}/route-name.` };
  }

  const rawModels = payload?.modelsText !== undefined ? payload.modelsText : payload?.models;
  const entries = Array.isArray(rawModels)
    ? rawModels
    : typeof rawModels === 'string'
      ? rawModels.split(/[\n,;]+/).map((line) => line.trim()).filter((line) => line.length > 0)
      : [];

  if (entries.length === 0 && !options?.allowShort) {
    return { ok: false, error: 'Fallback models must be a non-empty array or comma/newline-delimited string.' };
  }

  const seen = new Set<string>();
  const models: string[] = [];
  const disabledSeen = new Set<string>();
  const disabledModels: string[] = [];
  const disabledDirectiveRegex = /^(.*?)\s+(!enabled|disabled)$/i;

  for (const entry of entries) {
    if (entry === null || entry === undefined) continue;
    let modelName = '';
    let isDisabled = false;
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const directiveMatch = trimmed.match(disabledDirectiveRegex);
      if (directiveMatch) {
        modelName = directiveMatch[1].trim();
        isDisabled = true;
      } else {
        modelName = trimmed;
      }
    } else if (entry && typeof entry === 'object' && typeof entry.model === 'string') {
      modelName = entry.model.trim();
      isDisabled = entry.enabled === false;
    }
    if (!modelName) continue;
    if (modelName.length > 512) {
      return { ok: false, error: `Fallback model entry is too long: ${modelName.slice(0, 64)}` };
    }
    if (!/^[A-Za-z0-9@._:\/+-]+$/.test(modelName)) {
      return { ok: false, error: `Fallback model entry contains unsupported characters: ${modelName}` };
    }
    if (seen.has(modelName)) {
      if (isDisabled && !disabledSeen.has(modelName)) {
        disabledSeen.add(modelName);
        disabledModels.push(modelName);
      }
      continue;
    }
    seen.add(modelName);
    models.push(modelName);
    if (isDisabled) {
      disabledSeen.add(modelName);
      disabledModels.push(modelName);
    }
  }

  if (models.length < 2 && !options?.allowShort) {
    return { ok: false, error: 'Fallback route requires at least two unique model entries.' };
  }

  const rawDisabled = payload?.disabledModels;
  if (Array.isArray(rawDisabled)) {
    for (const entry of rawDisabled) {
      if (typeof entry !== 'string') continue;
      const trimmed = entry.trim();
      if (!trimmed || !seen.has(trimmed) || disabledSeen.has(trimmed)) continue;
      disabledSeen.add(trimmed);
      disabledModels.push(trimmed);
    }
  } else if (typeof rawDisabled === 'string') {
    for (const entry of rawDisabled.split(/[,\s]+/)) {
      const trimmed = entry.trim();
      if (!trimmed || !seen.has(trimmed) || disabledSeen.has(trimmed)) continue;
      disabledSeen.add(trimmed);
      disabledModels.push(trimmed);
    }
  }

  const model: FallbackModel = { id, models };
  if (disabledModels.length > 0) {
    model.disabledModels = disabledModels;
  }

  return { ok: true, model };
}

function normalizeFallbackRouteId(value: string) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (trimmed.startsWith(`${FALLBACK_PROVIDER_NAME}/`)) {
    return trimmed.slice(FALLBACK_PROVIDER_NAME.length + 1).trim();
  }
  for (const legacyName of FALLBACK_PROVIDER_LEGACY_NAMES) {
    if (trimmed.startsWith(`${legacyName}/`)) {
      return trimmed.slice(legacyName.length + 1).trim();
    }
  }
  return trimmed;
}

function fallbackPresentedModelId(model: FallbackModel | string) {
  const routeId = typeof model === 'string' ? normalizeFallbackRouteId(model) : normalizeFallbackRouteId(model.id);
  return `${FALLBACK_PROVIDER_NAME}/${routeId}`;
}

function fallbackRetryDelaySeconds(retryIndex: number) {
  return FALLBACK_BASE_RETRY_SECONDS ** retryIndex;
}

function waitMs(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

function ensureLocalRouterConfigDir() {
  fs.mkdirSync(LOCAL_ROUTER_CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function migrateLegacyConfigIfNeeded() {
  if (!fs.existsSync(LEGACY_FVS_CONFIG_DIR)) return;

  const migrations: Array<[string, string]> = [
    [LEGACY_FALLBACK_MODELS_PATH, FALLBACK_MODELS_PATH],
    [LEGACY_PROVIDER_MODELS_PATH, PROVIDER_MODELS_PATH]
  ];

  for (const [legacyPath, primaryPath] of migrations) {
    if (fs.existsSync(legacyPath) && !fs.existsSync(primaryPath)) {
      try {
        fs.copyFileSync(legacyPath, primaryPath);
        fs.chmodSync(primaryPath, 0o600);
      } catch (error: any) {
        console.error(`Failed to migrate ${legacyPath}:`, sanitizeDiagnosticText(String(error?.message || error)));
      }
    }
  }
}

function existingPath(primaryPath: string, legacyPath: string) {
  return fs.existsSync(primaryPath) ? primaryPath : legacyPath;
}

function isLocalRouterProviderName(providerName: string | undefined) {
  return providerName === FALLBACK_PROVIDER_NAME || FALLBACK_PROVIDER_LEGACY_NAMES.includes(providerName || '');
}

export function cloneFallbackModel(model: FallbackModel): FallbackModel {
  const cloned: FallbackModel = {
    id: model.id,
    models: [...model.models]
  };
  if (Array.isArray(model.disabledModels) && model.disabledModels.length > 0) {
    cloned.disabledModels = [...new Set(model.disabledModels.filter((entry) => typeof entry === 'string' && entry.length > 0))];
  }
  return cloned;
}

// Fallback wipe guard (2026-09-04): a transition of the system chain from
// non-empty to empty is snapshotted to curation-backups/ and loudly warned —
// the 2026-09-04 churn produced silent empty-chain writes.
let lastKnownSystemChain: string[] | null = null;
/** Content snapshot of the last-applied router-settings.json (loop guard for the file watcher). */
let lastAppliedSettingsSnapshot = '';

function snapshotFallbackChainBackup(previousModels: string[]): void {
  try {
    fs.mkdirSync(CURATION_BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const payload = {
      provider: '__fallback_chain__',
      reason: 'system chain emptied',
      createdAt: new Date().toISOString(),
      keyCount: previousModels.length,
      keys: [...previousModels]
    };
    fs.writeFileSync(
      path.join(CURATION_BACKUP_DIR, `fallback-chain-${stamp}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    console.warn(`[fallback] Empty system chain write detected — previous ${previousModels.length} step(s) backed up to curation-backups/fallback-chain-${stamp}.json`);
  } catch (error: any) {
    console.error('[fallback] Failed to snapshot chain backup:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function persistFallbackModels() {
  ensureLocalRouterConfigDir();
  const sysRouteBefore = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
  const beforeModels = Array.isArray(sysRouteBefore?.models) ? sysRouteBefore.models : [];
  if (lastKnownSystemChain && lastKnownSystemChain.length > 0 && beforeModels.length === 0) {
    snapshotFallbackChainBackup(lastKnownSystemChain);
  }
  lastKnownSystemChain = [...beforeModels];
  const routes = Object.values(fallbackModelStore)
    .map((model) => cloneFallbackModel(model))
    .sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    version: 1,
    routes
  };
  const temporaryPath = `${FALLBACK_MODELS_PATH}.${process.pid}.tmp`;

  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, FALLBACK_MODELS_PATH);
  fs.chmodSync(FALLBACK_MODELS_PATH, 0o600);

  try {
    // Single-source sync (2026-09-04): the FULL chain set mirrors into
    // router-settings.json — the authoritative file the boot loader and the
    // disk watcher apply. Keeps API/toggle writers and the file convergent.
    const sysRoute = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
    let text = '';
    if (sysRoute) {
      const disabled = new Set(Array.isArray(sysRoute.disabledModels) ? sysRoute.disabledModels : []);
      text = (Array.isArray(sysRoute.models) ? sysRoute.models : [])
        .map((m) => (disabled.has(m) ? `${m} disabled` : m))
        .join('\n');
    }
    const merged = { ...loadRouterSettings(), fallbackModelsText: text, routes };
    lastAppliedSettingsSnapshot = JSON.stringify({ fallbackModelsText: text, routes });
    saveRouterSettings(merged);
  } catch (error) {
    // Non-fatal sync
  }
}

function loadPersistedFallbackModels() {
  const persistedPath = existingPath(FALLBACK_MODELS_PATH, LEGACY_FALLBACK_MODELS_PATH);
  if (!fs.existsSync(persistedPath)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    const entries = Array.isArray(parsed?.routes)
      ? parsed.routes
      : Array.isArray(parsed)
        ? parsed
        : [];

    for (const entry of entries) {
      let parsedRoute = parseFallbackModel(entry);
      if (!parsedRoute.ok && entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.id === 'string' && Array.isArray(entry.models)) {
        // Lenient path (2026-08-24): the live toggle API legitimately creates
        // 0/1-step chains (first "＋ Fallback" add, or an emptied chain kept as
        // the always-present system route). parseFallbackModel only accepts
        // ≥2, so persisted short chains silently vanished on restart. Accept
        // structurally valid short chains here; the API write path keeps the
        // ≥2 rule for freshly authored chains.
        const routeId = normalizeFallbackRouteId(entry.id);
        const shortModels = entry.models
          .filter((model: unknown): model is string => typeof model === 'string')
          .map((model: string) => model.trim())
          .filter(Boolean);
        const shortDisabled = Array.isArray(entry.disabledModels)
          ? entry.disabledModels.filter((model: unknown): model is string => typeof model === 'string').map((model: string) => model.trim()).filter(Boolean)
          : [];
        if (routeId && shortModels.length <= 1) {
          const candidate: FallbackModel = { id: routeId, models: Array.from(new Set(shortModels)) };
          if (shortDisabled.length > 0) candidate.disabledModels = shortDisabled.filter((m: string) => candidate.models.includes(m));
          parsedRoute = { ok: true, model: candidate };
        }
      }
      if (!parsedRoute.ok) continue;

      const referenceCheck = validateFallbackReferences(parsedRoute.model);
      if (!referenceCheck.ok) continue;

      fallbackModelStore[parsedRoute.model.id] = cloneFallbackModel(parsedRoute.model);
    }
  } catch (error: any) {
    console.error('Failed to load persisted fallback routes:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

/**
 * Single-source fallback configuration (2026-09-04): router-settings.json is
 * THE canonical chain definition — the /config/fallback page is a read-only
 * view of it, and every chain write (toggle/save/order) syncs back into it.
 * This loader therefore APPLIES the file (authoritative) rather than only
 * backfilling an empty cache: it wins over the derived fallback-models.json
 * cache at boot. Empty/absent file = no opinion (empty-by-default preserved).
 */
function applyRouterSettingsToStore(): boolean {
  const settings = loadRouterSettings();
  if (!settings || typeof settings !== 'object') return false;
  const hasText = typeof settings.fallbackModelsText === 'string' && settings.fallbackModelsText.trim().length > 0;
  const declaredRoutes = Array.isArray((settings as any).routes) ? (settings as any).routes : [];
  if (!hasText && declaredRoutes.length === 0) return false;

  let appliedRoutes = 0;
  for (const entry of declaredRoutes) {
    let parsedRoute = parseFallbackModel(entry);
    if (!parsedRoute.ok && entry && typeof entry === 'object' && typeof entry.id === 'string' && Array.isArray(entry.models)) {
      // Lenient path: accept structurally valid short chains (see cache loader).
      parsedRoute = parseFallbackModel(
        { id: entry.id, models: entry.models, disabledModels: entry.disabledModels },
        { allowShort: true }
      );
    }
    if (!parsedRoute.ok) continue;
    const referenceCheck = validateFallbackReferences(parsedRoute.model);
    if (!referenceCheck.ok) continue;
    fallbackModelStore[parsedRoute.model.id] = cloneFallbackModel(parsedRoute.model);
    appliedRoutes++;
  }

  if (hasText) {
    const parsed = parseFallbackModel({ id: SYSTEM_FALLBACK_ROUTE_ID, modelsText: settings.fallbackModelsText!.trim() }, { allowShort: true });
    if (parsed.ok) {
      fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID] = cloneFallbackModel(parsed.model);
      appliedRoutes++;
    }
  }

  if (appliedRoutes === 0) return false;
  lastAppliedSettingsSnapshot = JSON.stringify({ fallbackModelsText: settings.fallbackModelsText || '', routes: declaredRoutes });
  return true;
}

function loadPersistedRouterSettings() {
  try {
    if (applyRouterSettingsToStore()) {
      const sysRoute = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
      const stepCount = Array.isArray(sysRoute?.models) ? sysRoute!.models.length : 0;
      console.log(`[config] router-settings.json is the single source of truth — applied (${stepCount} system chain step(s)).`);
    }
  } catch (error: any) {
    console.error('Failed to load persisted router settings:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

/**
 * Watch router-settings.json so editing the file is the whole workflow:
 * save the file → the running router picks it up within ~2s (no restart).
 * Re-entrant writes from persistFallbackModels are ignored via snapshot
 * comparison (content-addressed, not mtime-addressed).
 */
function watchRouterSettingsFile(): void {
  if (!shouldServe || process.env.LOCAL_ROUTER_WATCH_SETTINGS === 'false') return;
  if (process.env.LOCAL_ROUTER_WATCH_SETTINGS === 'false') return;
  let debounce: NodeJS.Timeout | undefined;
  fs.watchFile(ROUTER_SETTINGS_PATH, { interval: 2000 }, () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        if (!fs.existsSync(ROUTER_SETTINGS_PATH)) return;
        const settings = loadRouterSettings();
        const snapshot = JSON.stringify({
          fallbackModelsText: typeof settings?.fallbackModelsText === 'string' ? settings.fallbackModelsText : '',
          routes: Array.isArray((settings as any)?.routes) ? (settings as any).routes : []
        });
        if (snapshot === lastAppliedSettingsSnapshot) return; // our own write
        if (applyRouterSettingsToStore()) {
          persistFallbackModels();
          const sysRoute = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
          const stepCount = Array.isArray(sysRoute?.models) ? sysRoute!.models.length : 0;
          console.log(`[config] router-settings.json changed on disk — reloaded (${stepCount} system chain step(s)).`);
        }
      } catch (error: any) {
        console.error('Failed to re-apply router settings:', sanitizeDiagnosticText(String(error?.message || error)));
      }
    }, 300);
  });
}

function loadPersistedSystemPrompt(): void {
  const persistedPath = existingPath(SYSTEM_PROMPT_PATH, LEGACY_SYSTEM_PROMPT_PATH);
  if (!fs.existsSync(persistedPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    if (typeof parsed?.enabled === 'boolean') {
      systemPromptConfig.enabled = parsed.enabled;
    }
    if (typeof parsed?.prompt === 'string' && parsed.prompt.trim()) {
      systemPromptConfig.prompt = parsed.prompt;
    }
  } catch (error: any) {
    console.error('Failed to load persisted system prompt config:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}
function persistSystemPrompt(): void {
  ensureLocalRouterConfigDir();
  const payload = {
    enabled: systemPromptConfig.enabled,
    prompt: systemPromptConfig.prompt
  };
  const temporaryPath = `${SYSTEM_PROMPT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, SYSTEM_PROMPT_PATH);
  fs.chmodSync(SYSTEM_PROMPT_PATH, 0o600);
}

let pqcBundleLoaded = false;
const HEALTH_STATE_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'health.json');
const HEALTH_PROBE_INTERVAL_MS = 15 * 60 * 1000;
// ── Thinking Level Configuration ───────────────────────────────────────────

const thinkingLevelStore: Record<string, ThinkingLevel> = {};
let thinkingProxyEnabled = false;

// ── Wafer AI ZDR Configuration ────────────────────────────────────────────

let waferZdrEnabled = true;

function loadPersistedThinkingConfig(): void {
  const persistedPath = existingPath(THINKING_CONFIG_PATH, LEGACY_THINKING_CONFIG_PATH);
  if (!fs.existsSync(persistedPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    if (typeof parsed?.enabled === 'boolean') {
      thinkingProxyEnabled = parsed.enabled;
    } else if (typeof parsed?.global === 'string') {
      // Existing installs with saved levels: keep proxy overrides active.
      thinkingProxyEnabled = true;
    }
    if (typeof parsed?.global === 'string') {
      systemPromptConfig.thinkingLevel = parsed.global as ThinkingLevel;
    }
    if (parsed?.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
      for (const [provider, level] of Object.entries(parsed.providers)) {
        if (typeof level === 'string') {
          thinkingLevelStore[provider] = level as ThinkingLevel;
        }
      }
    }
  } catch (error: any) {
    console.error('Failed to load persisted thinking config:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function persistThinkingConfig(): void {
  ensureLocalRouterConfigDir();
  const payload = {
    enabled: thinkingProxyEnabled,
    global: systemPromptConfig.thinkingLevel,
    providers: { ...thinkingLevelStore }
  };
  const temporaryPath = `${THINKING_CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, THINKING_CONFIG_PATH);
  fs.chmodSync(THINKING_CONFIG_PATH, 0o600);
}

function loadWaferConfig(): void {
  if (!fs.existsSync(WAFER_CONFIG_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(WAFER_CONFIG_PATH, 'utf8'));
    if (typeof parsed?.zdrEnabled === 'boolean') {
      waferZdrEnabled = parsed.zdrEnabled;
    }
  } catch (error: any) {
    console.error('Failed to load wafer config:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function persistWaferConfig(): void {
  ensureLocalRouterConfigDir();
  const payload = { zdrEnabled: waferZdrEnabled };
  const temporaryPath = `${WAFER_CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, WAFER_CONFIG_PATH);
  fs.chmodSync(WAFER_CONFIG_PATH, 0o600);
}

function waferZdrApiPayload() {
  return { zdrEnabled: waferZdrEnabled };
}

// ── Headroom Compression Configuration & Circuit Breaker ───────────────────

const DEFAULT_HEADROOM_PROXY_URL = 'http://localhost:8787';
const HEADROOM_TIMEOUT_MS = 1500; // Fast fail-open timeout (replaces 10s stall)
const HEADROOM_CIRCUIT_COOLOFF_MS = 30000; // 30s cooloff window when OPEN

let headroomEnabled = true;
let headroomProxyUrl = DEFAULT_HEADROOM_PROXY_URL;

export type HeadroomCircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface HeadroomCircuitBreaker {
  state: HeadroomCircuitState;
  lastFailureTime: number;
  lastSuccessTime: number;
  consecutiveFailures: number;
  lastCheckedAt: number;
  lastError: string | null;
}

const headroomCircuit: HeadroomCircuitBreaker = {
  state: 'CLOSED',
  lastFailureTime: 0,
  lastSuccessTime: 0,
  consecutiveFailures: 0,
  lastCheckedAt: 0,
  lastError: null,
};

// In-memory LRU cache to deduplicate compression across fallback cascade hops
const headroomCompressionCache = new Map<string, { messages: any[]; timestamp: number }>();
const headroomRequestCompressedMessages = new WeakMap<object, any[]>();
const MAX_COMPRESSION_CACHE_ENTRIES = 50;
const COMPRESSION_CACHE_TTL_MS = 60000; // 1 minute

function getHeadroomCacheKey(messages: any[], model: string): string {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  const len = messages.length;
  const first = messages[0]?.content || '';
  const last = messages[len - 1]?.content || '';
  const sample = `${model}:${len}:${typeof first === 'string' ? first.slice(0, 100) : ''}:${typeof last === 'string' ? last.slice(0, 100) : ''}`;
  let hash = 0;
  for (let i = 0; i < sample.length; i++) {
    hash = (hash << 5) - hash + sample.charCodeAt(i);
    hash |= 0;
  }
  return 'hm_' + Math.abs(hash).toString(16);
}

export function getHeadroomCircuitState(): HeadroomCircuitBreaker {
  return { ...headroomCircuit };
}

export function resetHeadroomCircuitBreaker(): void {
  headroomCircuit.state = 'CLOSED';
  headroomCircuit.lastFailureTime = 0;
  headroomCircuit.lastSuccessTime = Date.now();
  headroomCircuit.consecutiveFailures = 0;
  headroomCircuit.lastCheckedAt = Date.now();
  headroomCircuit.lastError = null;
  headroomCompressionCache.clear();
}

export async function probeHeadroomHealth(proxyUrl: string = headroomProxyUrl): Promise<{ ok: boolean; status: string; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    const url = new URL('/health', proxyUrl).toString();
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(HEADROOM_TIMEOUT_MS)
    });
    const latencyMs = Date.now() - started;
    headroomCircuit.lastCheckedAt = Date.now();
    if (res.ok) {
      headroomCircuit.state = 'CLOSED';
      headroomCircuit.lastSuccessTime = Date.now();
      headroomCircuit.consecutiveFailures = 0;
      headroomCircuit.lastError = null;
      return { ok: true, status: 'healthy', latencyMs };
    }
    const err = `HTTP ${res.status}`;
    headroomCircuit.consecutiveFailures += 1;
    headroomCircuit.state = 'OPEN';
    headroomCircuit.lastFailureTime = Date.now();
    headroomCircuit.lastError = err;
    return { ok: false, status: 'unhealthy', latencyMs, error: err };
  } catch (err: any) {
    const latencyMs = Date.now() - started;
    const errMsg = err?.name === 'TimeoutError' ? 'Connection timeout (1500ms)' : (err?.message || 'Connection failed');
    headroomCircuit.consecutiveFailures += 1;
    headroomCircuit.state = 'OPEN';
    headroomCircuit.lastFailureTime = Date.now();
    headroomCircuit.lastCheckedAt = Date.now();
    headroomCircuit.lastError = errMsg;
    return { ok: false, status: 'unreachable', latencyMs, error: errMsg };
  }
}

function loadHeadroomConfig(): void {
  if (!fs.existsSync(HEADROOM_CONFIG_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(HEADROOM_CONFIG_PATH, 'utf8'));
    if (typeof parsed?.enabled === 'boolean') {
      headroomEnabled = parsed.enabled;
    }
    if (typeof parsed?.proxyUrl === 'string' && parsed.proxyUrl.trim()) {
      headroomProxyUrl = parsed.proxyUrl.trim();
    }
  } catch (error: any) {
    console.error('Failed to load headroom config:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function persistHeadroomConfig(): void {
  ensureLocalRouterConfigDir();
  const payload = { enabled: headroomEnabled, proxyUrl: headroomProxyUrl };
  const temporaryPath = `${HEADROOM_CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, HEADROOM_CONFIG_PATH);
  fs.chmodSync(HEADROOM_CONFIG_PATH, 0o600);
}

export function headroomApiPayload() {
  const isCooldownActive = headroomCircuit.state === 'OPEN' &&
    (Date.now() - headroomCircuit.lastFailureTime <= HEADROOM_CIRCUIT_COOLOFF_MS);
  const effectiveCircuitState: HeadroomCircuitState = isCooldownActive
    ? 'OPEN'
    : (headroomCircuit.state === 'OPEN' ? 'HALF_OPEN' : headroomCircuit.state);

  return {
    enabled: headroomEnabled,
    proxyUrl: headroomProxyUrl,
    healthy: effectiveCircuitState === 'CLOSED',
    circuitState: effectiveCircuitState,
    lastCheckedAt: headroomCircuit.lastCheckedAt,
    lastError: headroomCircuit.lastError
  };
}

/**
 * Compress messages via the Headroom proxy before forwarding upstream.
 * Implements:
 * 1. Request-level caching & deduplication via WeakMap + LRU (zero circular reference risk).
 * 2. Circuit breaker protection: immediate fail-open (0ms) when proxy is unreachable/unhealthy.
 * 3. Fast failover timeout (1500ms, 0 retries).
 * On failure, fails open and returns the original body unchanged.
 */
export async function compressWithHeadroom(body: any, model: string): Promise<any> {
  if (!headroomEnabled || !Array.isArray(body?.messages) || body.messages.length === 0) {
    return body;
  }

  // 1. Check request-level deduplication cache via WeakMap (safe, non-mutating, zero serialization impact)
  if (typeof body === 'object' && body !== null && headroomRequestCompressedMessages.has(body)) {
    const cachedMessages = headroomRequestCompressedMessages.get(body)!;
    return { ...body, messages: cachedMessages };
  }

  const cacheKey = getHeadroomCacheKey(body.messages, model);
  if (cacheKey && headroomCompressionCache.has(cacheKey)) {
    const cached = headroomCompressionCache.get(cacheKey)!;
    if (Date.now() - cached.timestamp < COMPRESSION_CACHE_TTL_MS) {
      if (typeof body === 'object' && body !== null) {
        headroomRequestCompressedMessages.set(body, cached.messages);
      }
      return { ...body, messages: cached.messages };
    }
    headroomCompressionCache.delete(cacheKey);
  }

  // 2. Circuit breaker check
  const now = Date.now();
  if (headroomCircuit.state === 'OPEN') {
    if (now - headroomCircuit.lastFailureTime > HEADROOM_CIRCUIT_COOLOFF_MS) {
      headroomCircuit.state = 'HALF_OPEN';
    } else {
      // Circuit is OPEN — fail open immediately with 0ms delay
      if (typeof body === 'object' && body !== null) {
        headroomRequestCompressedMessages.set(body, body.messages);
      }
      return body;
    }
  }

  try {
    const { compress } = await import('headroom-ai');
    const result = await compress(body.messages, {
      model,
      baseUrl: headroomProxyUrl,
      timeout: HEADROOM_TIMEOUT_MS,
      fallback: true,
      retries: 0,
      stack: 'local_router'
    });

    // Success — mark circuit healthy
    headroomCircuit.state = 'CLOSED';
    headroomCircuit.lastSuccessTime = Date.now();
    headroomCircuit.consecutiveFailures = 0;
    headroomCircuit.lastCheckedAt = Date.now();
    headroomCircuit.lastError = null;

    if (result.compressed && result.tokensSaved > 0) {
      console.log(`[Headroom] ${result.tokensBefore} → ${result.tokensAfter} tokens (saved ${result.tokensSaved}, ${Math.round(result.compressionRatio * 100)}% ratio)`);
      const compressedBody = { ...body, messages: result.messages };
      if (typeof body === 'object' && body !== null) {
        headroomRequestCompressedMessages.set(body, result.messages);
      }

      // Cache across fallback attempts
      if (cacheKey) {
        if (headroomCompressionCache.size >= MAX_COMPRESSION_CACHE_ENTRIES) {
          const oldestKey = headroomCompressionCache.keys().next().value;
          if (oldestKey) headroomCompressionCache.delete(oldestKey);
        }
        headroomCompressionCache.set(cacheKey, { messages: result.messages, timestamp: Date.now() });
      }

      return compressedBody;
    }

    if (typeof body === 'object' && body !== null) {
      headroomRequestCompressedMessages.set(body, body.messages);
    }
    return body;
  } catch (err: any) {
    headroomCircuit.consecutiveFailures += 1;
    headroomCircuit.state = 'OPEN';
    headroomCircuit.lastFailureTime = Date.now();
    headroomCircuit.lastCheckedAt = Date.now();
    headroomCircuit.lastError = err?.message || String(err);

    console.warn(`[Headroom] Compression failed, circuit breaker OPEN for 30s (${sanitizeDiagnosticText(String(err?.message || err), 120)})`);
    if (typeof body === 'object' && body !== null) {
      headroomRequestCompressedMessages.set(body, body.messages);
    }
    return body;
  }
}

function getEffectiveThinkingLevel(providerName: string): ThinkingLevel {
  return thinkingLevelStore[providerName] ?? systemPromptConfig.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
}

function thinkingLevelApiPayload() {
  return {
    enabled: thinkingProxyEnabled,
    global: systemPromptConfig.thinkingLevel,
    default: DEFAULT_THINKING_LEVEL,
    providers: allProviderSummaries().map((summary) => ({
      name: summary.name,
      level: getEffectiveThinkingLevel(summary.name)
    }))
  };
}

function persistProviderModels() {
  ensureLocalRouterConfigDir();
  const payload = {
    version: 1,
    overrides: Object.entries(modelStore).map(([provider, models]) => ({
      provider,
      models: models.map((model) => ({
        id: model.id,
        provider: model.provider,
        model: model.model,
        display: model.display,
        contextLength: model.contextLength,
        outputTokens: model.outputTokens,
        supportsTools: model.supportsTools,
        supportsImages: model.supportsImages,
        supportsCache: model.supportsCache,
        supportsReasoning: model.supportsReasoning
      }))
    })).sort((a, b) => a.provider.localeCompare(b.provider))
  };
  const temporaryPath = `${PROVIDER_MODELS_PATH}.${process.pid}.tmp`;

  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, PROVIDER_MODELS_PATH);
  fs.chmodSync(PROVIDER_MODELS_PATH, 0o600);
}

function mergeBaselineProviderModelOverrides(): void {
  let changed = false;
  for (const providerName of Object.keys(modelStore)) {
    const memoryModels = modelStore[providerName];
    if (!Array.isArray(memoryModels) || memoryModels.length === 0) continue;

    const knownIds = new Set(memoryModels.map((model) => model.id));
    for (const baselineModel of baselineProviderModels(providerName)) {
      if (knownIds.has(baselineModel.id)) continue;
      memoryModels.push(cloneProviderModel(baselineModel));
      knownIds.add(baselineModel.id);
      changed = true;
    }
  }

  if (!changed) return;
  try {
    persistProviderModels();
    console.log('[catalog] Merged toggle-store models into persisted provider overrides.');
  } catch (error: any) {
    console.error('Failed to persist merged provider model overrides:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function loadPersistedProviderModels() {
  const persistedPath = existingPath(PROVIDER_MODELS_PATH, LEGACY_PROVIDER_MODELS_PATH);
  if (!fs.existsSync(persistedPath)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    const entries = Array.isArray(parsed?.overrides)
      ? parsed.overrides
      : [];

    for (const entry of entries) {
      const providerName = canonicalProviderSlug(String(entry?.provider || '').trim());
      if (!providerName) continue;
      const modelList = Array.isArray(entry?.models) ? entry.models : [];
      if (modelList.length === 0) continue;

      const migratedModels = modelList.map((raw: any) => ({
        id: String(raw?.id || ''),
        provider: canonicalProviderSlug(String(raw?.provider || providerName)),
        model: String(raw?.model || ''),
        display: String(raw?.display || ''),
        contextLength: Number.isInteger(raw?.contextLength) ? raw.contextLength : DEFAULT_CONTEXT_LENGTH,
        outputTokens: Number.isInteger(raw?.outputTokens) ? raw.outputTokens : DEFAULT_OUTPUT_TOKENS,
        supportsTools: Boolean(raw?.supportsTools),
        supportsImages: Boolean(raw?.supportsImages),
        supportsCache: Boolean(raw?.supportsCache),
        supportsReasoning: Boolean(raw?.supportsReasoning)
      }));
      const existingModels = modelStore[providerName];
      if (existingModels) {
        const knownIds = new Set(existingModels.map((model) => model.id));
        for (const model of migratedModels) {
          if (knownIds.has(model.id)) continue;
          existingModels.push(model);
          knownIds.add(model.id);
        }
      } else {
        modelStore[providerName] = migratedModels;
      }
      persistedProviderModelOverrides.add(providerName);
    }
  } catch (error: any) {
    console.error('Failed to load persisted provider models:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

/**
 * One-time catalog seeding (2026-08-20, v2): providers.txt and its frozen
 * legacy copy are fully removed; the persisted toggle store (endpoint cache
 * + curated keys) is the only catalog, seeded from the factual registries in
 * src/provider-model-registries.ts with every model pre-checked.
 */
function seedRegistryCatalogIfNeeded(): void {
  try {
    if (modelSourceConfig.catalogMigrationVersion === CATALOG_MIGRATION_VERSION && endpointModelsCache.length > 0) return;

    // v2 (2026-08-20): providers.txt and its frozen legacy copy are gone.
    // The factual registries (src/provider-model-registries.ts) seed the
    // toggle store: every registry model across all providers is unioned
    // into the cache and pre-checked, so the full known catalog is
    // immediately togglable (and served where a key is configured). Live
    // refreshes then layer actual upstream truth on top per provider.
    const previousKeys = new Set(endpointModelsCache.map((model) => endpointModelCurationKey(model)));
    const byKey = new Map(endpointModelsCache.map((model) => [endpointModelCurationKey(model), model]));
    const addedModels: ProviderModel[] = [];
    let added = 0;
    const providers = new Set<string>(Object.keys(PROVIDER_MODEL_REGISTRY));
    for (const providerName of providers) {
      const extras = PROVIDER_MODEL_REGISTRY[providerName] || [];
      if (extras.length === 0) continue;
      const mapped = mapLiveRawModelsToCatalog(providerName, extras.map((entry) => ({ ...entry })));
      for (const model of mapped) {
        const key = endpointModelCurationKey(model);
        if (!byKey.has(key)) {
          byKey.set(key, model);
          addedModels.push(model);
          added += 1;
        }
      }
    }
    endpointModelsCache = [...byKey.values()].sort((a, b) =>
      a.provider === b.provider
        ? a.model.localeCompare(b.model)
        : a.provider.localeCompare(b.provider)
    );
    // Pre-check only models the store has never seen: existing entries keep
    // the user's explicit toggle choices (untoggled ≠ undiscovered).
    const curated = new Set(modelSourceConfig.curatedEndpointModelKeys);
    for (const model of addedModels) curated.add(endpointModelCurationKey(model));
    modelSourceConfig.curatedEndpointModelKeys = [...curated].sort().slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
    modelSourceConfig.source = 'endpoints';
    modelSourceConfig.curationEnabled = true;
    modelSourceConfig.catalogMigrationVersion = CATALOG_MIGRATION_VERSION;
    persistEndpointModelsCache();
    persistModelSourceConfig();
    console.log(`[catalog] Registry seed v${CATALOG_MIGRATION_VERSION}: ${added} new model(s) unioned, all pre-checked.`);
  } catch (error) {
    console.error('[catalog] Registry catalog seed failed:', error);
  }
}


function loadModelSourceConfig(): void {
  const persistedPath = existingPath(MODEL_SOURCE_CONFIG_PATH, LEGACY_MODEL_SOURCE_CONFIG_PATH);
  if (!fs.existsSync(persistedPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    if (parsed && (parsed.source === 'custom' || parsed.source === 'endpoints')) {
      modelSourceConfig.source = parsed.source;
    }
    if (typeof parsed.catalogMigrationVersion === 'number') {
      modelSourceConfig.catalogMigrationVersion = parsed.catalogMigrationVersion;
    }
    if (typeof parsed.filterConfigured === 'boolean') {
      modelSourceConfig.filterConfigured = parsed.filterConfigured;
    }
    if (typeof parsed.curationEnabled === 'boolean') {
      modelSourceConfig.curationEnabled = parsed.curationEnabled;
    }
    if (Array.isArray(parsed.curatedEndpointModelKeys)) {
      const curatedKeys: string[] = parsed.curatedEndpointModelKeys
        .map((key: unknown) => String(key || '').trim())
        .filter((key: string) => key.length > 0);
      modelSourceConfig.curatedEndpointModelKeys = Array.from(new Set(curatedKeys))
        .slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
    }
    if (typeof parsed.defaultCurationConfig === 'string' && parsed.defaultCurationConfig.trim()) {
      modelSourceConfig.defaultCurationConfig = parsed.defaultCurationConfig.trim();
    }
  } catch (error: any) {
    console.error('Failed to load persisted model source config:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function persistModelSourceConfig(): void {
  ensureLocalRouterConfigDir();
  const temporaryPath = `${MODEL_SOURCE_CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(modelSourceConfig, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, MODEL_SOURCE_CONFIG_PATH);
  fs.chmodSync(MODEL_SOURCE_CONFIG_PATH, 0o600);
}

function filterConfiguredModels(models: ProviderModel[]): ProviderModel[] {
  if (!modelSourceConfig.filterConfigured) return models;
  return models.filter((model) => {
    if (model.provider === FALLBACK_PROVIDER_NAME) return true;
    if (model.provider === 'ollama') return true;
    if (isOAuthProviderName(model.provider)) {
      const oauthState = getOAuthStateSafe(model.provider);
      return Boolean(oauthState?.accessToken);
    }
    return providerHasConfiguredKey(model.provider);
  });
}

function endpointModelCurationKey(model: ProviderModel): string {
  return `${model.provider}::${model.model}`;
}

function endpointCurationActive(): boolean {
  // The toggle store is the only catalog (providers.txt model table retired
  // was retired (2026-08-20); curation is always active.
  return true;
}

/**
 * Endpoint Models curation: when enabled, discovery (/v1/models, /api/tags)
 * serves only endpoint models the operator checked in the /config catalog
 * (port-all → search → curate). Local Router fallback/router routes and
 * custom-mode model lists are unaffected.
 */
function applyEndpointCuration(models: ProviderModel[]): ProviderModel[] {
  if (!endpointCurationActive() || !modelSourceConfig.filterConfigured) return models;
  const curatedKeys = new Set(modelSourceConfig.curatedEndpointModelKeys);
  if (curatedKeys.size === 0) {
    // Local ollama backend stays discoverable even when nothing is curated.
    return models.filter((model) => model.provider === 'ollama');
  }
  return models.filter(
    (model) => model.provider === 'ollama' || curatedKeys.has(endpointModelCurationKey(model))
  );
}

function loadEndpointModelsCache(): void {
  const persistedPath = existingPath(ENDPOINT_MODELS_CACHE_PATH, LEGACY_ENDPOINT_MODELS_CACHE_PATH);
  if (!fs.existsSync(persistedPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    if (Array.isArray(parsed)) {
      endpointModelsCache = parsed;
    }
  } catch (error: any) {
    console.error('Failed to load persisted endpoint models cache:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function persistEndpointModelsCache(): void {
  ensureLocalRouterConfigDir();
  const temporaryPath = `${ENDPOINT_MODELS_CACHE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(endpointModelsCache, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, ENDPOINT_MODELS_CACHE_PATH);
  fs.chmodSync(ENDPOINT_MODELS_CACHE_PATH, 0o600);
}

function mapLiveRawModelsToCatalog(
  providerName: string,
  rawModels: Array<{ id: string; [key: string]: unknown }>
): ProviderModel[] {
  const baselineModels = rawProviderCacheModels(providerName);
  const providerModels: ProviderModel[] = [];

  // Provider metadata hints (2026-09-04): accept every common upstream shape
  // (OpenAI, OpenRouter, vLLM, llama.cpp, Ollama payloads). Nested paths cover
  // OpenRouter's top_provider.* and Ollama's model_info.*; providers that
  // publish nothing fall back to the shared default window.
  const numberHintPath = (raw: Record<string, unknown>, ...paths: string[]): number | undefined => {
    for (const path of paths) {
      let value: unknown = raw;
      for (const segment of path.split('.')) {
        value = (value && typeof value === 'object' && !Array.isArray(value))
          ? (value as Record<string, unknown>)[segment]
          : undefined;
      }
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  };
  const numberHintKeys = (raw: Record<string, unknown>, ...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = raw[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    }
    return undefined;
  };
  const contextHint = (raw: Record<string, unknown>): number | undefined =>
    numberHintKeys(
      raw,
      'contextLength',
      'context_length',
      'max_model_len',
      'max_context_length',
      'context_window',
      'context_window_tokens',
      'max_sequence_length',
      'max_input_tokens'
    ) ?? numberHintPath(
      raw,
      'top_provider.context_length',
      'model_info.context_length',
      'limits.context_length',
      'info.context_length',
      'wafer.context_length'
    );
  const outputHint = (raw: Record<string, unknown>): number | undefined =>
    numberHintKeys(
      raw,
      'outputTokens',
      'max_output_tokens',
      'max_output_length',
      'output_token_limit',
      'max_completion_tokens',
      'max_tokens_out'
    ) ?? numberHintPath(
      raw,
      'top_provider.max_completion_tokens',
      'limits.max_output_tokens',
      'info.max_output_tokens',
      'wafer.max_output_tokens'
    );

  const usedPresentedIds = new Set<string>();
  for (const raw of rawModels) {
    const modelId = raw.id;
    const presentedId = makeUniquePresentedModelName(providerName, modelId, usedPresentedIds);
    usedPresentedIds.add(presentedId);
    const matchingBaseline = baselineModels.find(
      (baseline) => baseline.provider === providerName && baseline.model === modelId
    );

    const booleanHint = (key: string, fallback: boolean): boolean => {
      const value = (raw as Record<string, unknown>)[key];
      return typeof value === 'boolean' ? value : fallback;
    };
    const booleanHintPath = (...paths: string[]): boolean | undefined => {
      for (const path of paths) {
        let value: unknown = raw;
        for (const segment of path.split('.')) {
          value = (value && typeof value === 'object' && !Array.isArray(value))
            ? (value as Record<string, unknown>)[segment]
            : undefined;
        }
        if (typeof value === 'boolean') return value;
      }
      return undefined;
    };
    const stringHint = (key: string): string | undefined => {
      const value = (raw as Record<string, unknown>)[key];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    const stringHintPath = (...paths: string[]): string | undefined => {
      for (const path of paths) {
        let value: unknown = raw;
        for (const segment of path.split('.')) {
          value = (value && typeof value === 'object' && !Array.isArray(value))
            ? (value as Record<string, unknown>)[segment]
            : undefined;
        }
        if (typeof value === 'string' && value.length > 0) return value;
      }
      return undefined;
    };

    const resolvedSupportsImages = booleanHint('supportsImages', false)
      || booleanHint('supports_vision', false)
      || (booleanHintPath('wafer.capabilities.vision') ?? false);
    const resolvedSupportsReasoning = booleanHint('supportsReasoning', false)
      || (booleanHintPath('wafer.capabilities.reasoning') ?? false);
    const resolvedSupportsTools = booleanHint('supportsTools', true)
      ?? booleanHintPath('wafer.capabilities.tools')
      ?? true;

    if (matchingBaseline) {
      // Live metadata wins over the registry baseline (2026-09-04): a cached
      // context/output value is only kept when upstream publishes none.
      providerModels.push({
        ...matchingBaseline,
        id: presentedId,
        contextLength: contextHint(raw) ?? matchingBaseline.contextLength ?? DEFAULT_CONTEXT_LENGTH,
        outputTokens: outputHint(raw) ?? matchingBaseline.outputTokens ?? DEFAULT_OUTPUT_TOKENS,
        supportsImages: resolvedSupportsImages || Boolean(matchingBaseline.supportsImages),
        supportsReasoning: resolvedSupportsReasoning || Boolean(matchingBaseline.supportsReasoning),
        supportsTools: resolvedSupportsTools && (matchingBaseline.supportsTools ?? true)
      });
      continue;
    }

    const rawTier = stringHint('tier') || stringHintPath('wafer.tier');
    const tier = rawTier === 'serverless_only' ? 'paid' : rawTier;

    providerModels.push({
      id: presentedId,
      provider: providerName,
      model: modelId,
      display: providerModelDisplay(providerName, modelId),
      contextLength: contextHint(raw) ?? DEFAULT_CONTEXT_LENGTH,
      outputTokens: outputHint(raw) ?? DEFAULT_OUTPUT_TOKENS,
      tier,
      sourceUrl: stringHint('sourceUrl'),
      supportsTools: resolvedSupportsTools,
      supportsImages: resolvedSupportsImages,
      supportsCache: booleanHint('supportsCache', false),
      supportsReasoning: resolvedSupportsReasoning
    });
  }

  return providerModels;
}

export type LiveModelSource = 'live' | 'registry' | 'catalog';

export interface LiveModelsResult {
  models: Array<{ id: string; object: string; owned_by: string }>;
  source: LiveModelSource;
  note?: string;
}

/**
 * Curated registry for providers with no /models API: factual registry
 * rows unioned with verified additions (see provider-model-registries.ts).
 */
function providerRegistryModels(providerName: string): LiveModelsResult['models'] {
  const seen = new Set<string>();
  const out: LiveModelsResult['models'] = [];
  const push = (id: string, extra: Record<string, unknown> = {}) => {
    const normalized = String(id || '').trim();
    if (!normalized) return;
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    out.push({ id: normalized, object: 'model', owned_by: providerName, ...extra });
  };
  for (const entry of PROVIDER_MODEL_REGISTRY[providerName] || []) {
    push(entry.id, {
      contextLength: entry.contextLength,
      outputTokens: entry.outputTokens,
      supportsTools: entry.supportsTools,
      supportsImages: entry.supportsImages,
      supportsCache: entry.supportsCache,
      supportsReasoning: entry.supportsReasoning,
      tier: entry.tier,
      sourceUrl: entry.sourceUrl
    });
  }
  for (const model of rawProviderCacheModels(providerName)) {
    push(model.model);
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

/**
 * Resolve a provider's discoverable model list. Always reports an honest
 * `source` so the UI can distinguish a real live fetch from a curated
 * registry (no upstream list API) or the curated registry catalog
 * (live fetch failed / no key). Never throws.
 */
async function fetchLiveProviderModels(providerName: string): Promise<LiveModelsResult> {
  if (providerName === 'ollama') {
    const mod = await import('./providers/ollama');
    return { models: await mod.fetchLiveOllamaModels(), source: 'live' };
  }

  try {
    const mod = await import(`./providers/${providerName}`);
    const provider = mod.default || mod;
    if (provider?.getModels) {
      return { models: await provider.getModels(), source: 'live' };
    }
  } catch {
    // Fall through to generic upstream loader.
  }

  const summary = getProviderSummary(providerName);
  if (!summary) {
    return { models: [], source: 'catalog', note: `Unknown provider: ${providerName}` };
  }

  const registryOnly = providerHasNoLiveModelList(summary.name);
  const registryResult = (note: string): LiveModelsResult => ({
    models: providerRegistryModels(summary.name),
    source: 'registry',
    note
  });
  const catalogResult = (models: LiveModelsResult['models'], note?: string): LiveModelsResult => ({
    models,
    source: 'catalog',
    note
  });

  if (registryOnly) {
    return registryResult(
      `${summary.name} publishes no models-list API — curated registry (catalog rows + verified additions).`
    );
  }

  const key = keyStore[summary.name] || providerEnvKeyValue(summary.keyEnvVar);
  const isLocalService = isLocalLoopbackProvider(providerName);
  const isOpenCatalogProvider = summary.name === 'wafer-serverless' || summary.name === 'commandcode';

  if (!key && !isLocalService && !isOpenCatalogProvider) {
    return catalogResult(
      providerRegistryModels(summary.name),
      'No API key saved — showing curated registry catalog.'
    );
  }

  try {
    const url = providerBaseUrl(summary);
    const headers: Record<string, string> = {};
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    let response = await safeFetch(`${url}/models`, {
      headers,
      signal: AbortSignal.timeout(6000)
    });

    // Public catalog fallback (2026-09-18): providers like wafer-serverless,
    // commandcode, openrouter, and zenmux publish public, unauthenticated /models
    // catalogs. If an invalid or ambient test key in the environment returns
    // 401/403, retry without Authorization header before giving up.
    if (!response.ok && (response.status === 401 || response.status === 403) && key && (isOpenCatalogProvider || summary.name === 'openrouter' || summary.name === 'zenmux')) {
      try {
        const publicResponse = await safeFetch(`${url}/models`, {
          signal: AbortSignal.timeout(6000)
        });
        if (publicResponse.ok) {
          response = publicResponse;
        }
      } catch {
        // Retain original response
      }
    }

    if (response.ok) {
      const data = await response.json();
      const list = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : [];
      const models = list
        .filter((model: any) => typeof (model?.id ?? model?.name ?? model?.model) === 'string')
        .map((model: any) => {
          // Metadata passthrough (2026-09-04): keep context/output hints the
          // upstream includes (context_length, max_output_tokens, …) so the
          // catalog shows real per-provider limits instead of defaults.
          const id = String(model.id ?? model.name ?? model.model).trim();
          return { ...model, id, object: 'model', owned_by: summary.name };
        });
      if (models.length > 0) {
        return { models, source: 'live' };
      }
      return catalogResult(
        providerRegistryModels(summary.name),
        `Upstream /models returned no recognizable model list — showing curated registry catalog.`
      );
    }

    if (!key && !isLocalService) {
      return catalogResult(
        providerRegistryModels(summary.name),
        'No API key saved — showing curated registry catalog.'
      );
    }

    return catalogResult(
      providerRegistryModels(summary.name),
      `Upstream /models fetch failed (HTTP ${response.status}) — showing curated registry catalog.`
    );
  } catch (error: any) {
    if (!key && !isLocalService) {
      return catalogResult(
        providerRegistryModels(summary.name),
        'No API key saved — showing curated registry catalog.'
      );
    }
    console.error(`Failed to fetch models from endpoint for provider ${providerName}:`, error);
    return catalogResult(
      rawProviderCacheModels(summary.name).map((model) => ({
        id: model.model,
        object: 'model',
        owned_by: summary.name
      })),
      `Upstream /models fetch failed (${error?.message || 'network error'}) — showing curated registry catalog.`
    );
  }
}

async function queryAllProviderEndpoints(): Promise<ProviderModel[]> {
  const providers = allProviderSummaries();
  const results = await Promise.all(
    providers.map(async (providerSummary) => {
      try {
        const fetched = await fetchProviderEndpointModels(providerSummary.name);
        return fetched.models;
      } catch (err) {
        console.error(`Error querying models for provider ${providerSummary.name}:`, err);
        return [];
      }
    })
  );
  return results.flat();
}

const PROVIDER_ENDPOINT_REFRESH_TIMEOUT_MS = 20_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/** Fetch one provider's live model list mapped to catalog shape, deduped by curation key. */
export interface ProviderEndpointFetch {
  models: ProviderModel[];
  source: LiveModelSource;
  note?: string;
}

async function fetchProviderEndpointModels(providerName: string): Promise<ProviderEndpointFetch> {
  const { models: rawModels, source, note } = await fetchLiveProviderModels(providerName);
  const mapped = mapLiveRawModelsToCatalog(providerName, rawModels);
  // Registry superset (2026-09-04): registry-only entries (e.g. GitHub
  // Copilot's VS Code `auto` model, which the live /models list omits) stay
  // selectable even when the upstream list doesn't advertise them.
  const liveModelNames = new Set(mapped.map((model) => model.model));
  const registryExtra = providerRegistryModels(providerName)
    .filter((raw) => !liveModelNames.has(String(raw.id)))
    .map((raw) => mapLiveRawModelsToCatalog(providerName, [raw])[0])
    .filter(Boolean);
  mapped.push(...registryExtra);
  const seen = new Set<string>();
  const deduped: ProviderModel[] = [];
  for (const model of mapped) {
    const key = endpointModelCurationKey(model);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(model);
  }
  return { models: deduped, source, note };
}

/** Replace one provider's section of the endpoint cache, preserving all other providers. */
function mergeProviderEndpointModels(providerName: string, models: ProviderModel[]): void {
  const others = endpointModelsCache.filter((model) => model.provider !== providerName);
  endpointModelsCache = [...others, ...models].sort((a, b) =>
    a.provider === b.provider
      ? a.model.localeCompare(b.model)
      : a.provider.localeCompare(b.provider)
  );
}

/**
 * First-fetch seeding: pre-check (select) every discovered model that already
 * exists in the curated toggle-store catalog so serving continuity is kept.
 * Providers that already have any selection are left untouched.
 */
function seedCurationDefaultsForProvider(providerName: string, models: ProviderModel[]): number {
  const existing = new Set(modelSourceConfig.curatedEndpointModelKeys);
  if (models.some((model) => existing.has(endpointModelCurationKey(model)))) return 0;
  const catalogModels = new Set(
    rawProviderCacheModels(providerName).map((model) => model.model)
  );
  let seeded = 0;
  for (const model of models) {
    if (!catalogModels.has(model.model)) continue;
    const key = endpointModelCurationKey(model);
    if (existing.has(key)) continue;
    existing.add(key);
    seeded++;
  }
  if (seeded > 0) {
    modelSourceConfig.curatedEndpointModelKeys = Array.from(existing).slice(0, 5000);
    persistModelSourceConfig();
  }
  return seeded;
}

/** Seed curation defaults for every provider in the endpoint cache (all-providers refresh). */
function ensureCurationDefaultsForCache(): void {
  const providers = Array.from(new Set(endpointModelsCache.map((model) => model.provider)));
  for (const provider of providers) {
    seedCurationDefaultsForProvider(
      provider,
      endpointModelsCache.filter((model) => model.provider === provider)
    );
  }
}

const CURATION_BACKUP_DIR = path.join(path.dirname(MODEL_SOURCE_CONFIG_PATH), 'curation-backups');
const MAX_CURATION_BACKUPS_PER_PROVIDER = 25;

/**
 * Before a bulk auto-off wipes a provider's toggle selection, snapshot the
 * removed keys to curation-backups/ (rolling window of 25 per provider) so a
 * carefully built selection is never unrecoverable.
 */
function snapshotProviderCurationBackup(providerName: string, removedKeys: string[]): void {
  try {
    fs.mkdirSync(CURATION_BACKUP_DIR, { recursive: true, mode: 0o700 });
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const payload = {
      provider: providerName,
      createdAt: now.toISOString(),
      keyCount: removedKeys.length,
      keys: removedKeys
    };
    fs.writeFileSync(
      path.join(CURATION_BACKUP_DIR, `curation-${providerName}-${stamp}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    const entries = fs.readdirSync(CURATION_BACKUP_DIR)
      .filter((name) => name.startsWith(`curation-${providerName}-`) && name.endsWith('.json'))
      .sort();
    const excess = entries.length - MAX_CURATION_BACKUPS_PER_PROVIDER;
    for (const name of entries.slice(0, Math.max(0, excess))) {
      fs.unlinkSync(path.join(CURATION_BACKUP_DIR, name));
    }
  } catch (error: any) {
    console.error('[catalog] Failed to snapshot curation backup:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

/**
 * Off-by-default curation (2026-08-22): a user-triggered refresh or key-save
 * discovery toggles every known model of the provider OFF so the operator
 * selects the few they actually serve instead of untoggling hundreds. The
 * provider's prior selection is snapshotted before clearing. Returns how
 * many keys were turned off.
 */
function deselectProviderCurationKeys(providerName: string): number {
  const prefix = `${providerName}::`;
  const previous = modelSourceConfig.curatedEndpointModelKeys.filter((key) => key.startsWith(prefix));
  if (previous.length === 0) return 0;
  snapshotProviderCurationBackup(providerName, previous);
  modelSourceConfig.curatedEndpointModelKeys = modelSourceConfig.curatedEndpointModelKeys
    .filter((key) => !key.startsWith(prefix));
  persistModelSourceConfig();
  return previous.length;
}

/**
 * Snapshot the ENTIRE curated list before a bulk replacement write so any
 * mass-shrink (the 2026-09-04 catalog-wipe class of incident) is recoverable.
 */
function snapshotFullCurationBackup(reason: string): void {
  try {
    fs.mkdirSync(CURATION_BACKUP_DIR, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const payload = {
      provider: '__full__',
      reason: sanitizeDiagnosticText(reason).slice(0, 120),
      createdAt: new Date().toISOString(),
      keyCount: modelSourceConfig.curatedEndpointModelKeys.length,
      keys: [...modelSourceConfig.curatedEndpointModelKeys]
    };
    fs.writeFileSync(
      path.join(CURATION_BACKUP_DIR, `curation-full-${stamp}.json`),
      `${JSON.stringify(payload, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
  } catch (error: any) {
    console.error('[catalog] Failed to snapshot full curation backup:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

const CURATION_GUARD_MIN_SIZE = 10;
const CURATION_GUARD_SHRINK_RATIO = 0.9;

/**
 * Curation merge guard: evaluate a proposed replacement of the curated list.
 * A replacement that drops >= CURATION_GUARD_SHRINK_RATIO of the current
 * selection (with a meaningful starting size) is treated as a probable
 * accident — the caller must pass an explicit force flag to apply it.
 */
function evaluateCurationShrink(nextKeys: string[]): {
  blocked: boolean;
  removedCount: number;
  removedKeys: string[];
  currentCount: number;
  nextCount: number;
} {
  const current = modelSourceConfig.curatedEndpointModelKeys;
  const next = new Set(nextKeys);
  const removedKeys = current.filter((key) => !next.has(key));
  const removedCount = removedKeys.length;
  const ratio = current.length === 0 ? 0 : removedCount / current.length;
  const blocked = current.length >= CURATION_GUARD_MIN_SIZE
    && removedCount >= CURATION_GUARD_MIN_SIZE
    && ratio >= CURATION_GUARD_SHRINK_RATIO;
  return { blocked, removedCount, removedKeys, currentCount: current.length, nextCount: nextKeys.length };
}

/** Deselect every provider present in the endpoint cache (Refresh All path). */
function deselectAllProviderCurationKeys(): number {
  let deselected = 0;
  const providers = Array.from(new Set(endpointModelsCache.map((model) => model.provider)));
  for (const providerName of providers) {
    deselected += deselectProviderCurationKeys(providerName);
  }
  return deselected;
}

/**
 * Refresh a single provider's endpoint-model cache section: fetch live,
 * merge into the cache, persist, and toggle the provider's models off —
 * refresh/key-save discovery is off-by-default (2026-08-22); the source
 * catalog stays fully toggleable.
 */
async function refreshProviderEndpointModels(providerName: string, options?: { preserveCuration?: boolean }): Promise<{
  models: ProviderModel[];
  deselectedCount: number;
  source: LiveModelSource;
  note?: string;
}> {
  const fetched = await withTimeout(
    fetchProviderEndpointModels(providerName),
    PROVIDER_ENDPOINT_REFRESH_TIMEOUT_MS,
    `Provider ${providerName} model refresh timed out after ${PROVIDER_ENDPOINT_REFRESH_TIMEOUT_MS / 1000}s`
  );
  const knownKeysBefore = new Set(endpointModelsCache.map((model) => endpointModelCurationKey(model)));
  mergeProviderEndpointModels(providerName, fetched.models);
  persistEndpointModelsCache();
  // preserveCuration (2026-09-04): automated re-checks (PQC resync, fallback
  // import heal) must never wipe the operator's curated selection — only the
  // explicit operator-triggered refresh path keeps the bulk-off behavior.
  const deselectedCount = options?.preserveCuration
    ? 0
    : deselectProviderCurationKeys(providerName);
  // New-discovery auto-curation (2026-09-04): a model that appears upstream
  // (e.g. a provider ships a new flash model) is served immediately instead
  // of waiting for a manual check — that is the whole point of a live
  // refresh. Existing selections are untouched.
  if (options?.preserveCuration) {
    let curated = 0;
    for (const model of fetched.models) {
      const key = endpointModelCurationKey(model);
      if (!knownKeysBefore.has(key) && !modelSourceConfig.curatedEndpointModelKeys.includes(key)) {
        modelSourceConfig.curatedEndpointModelKeys.push(key);
        curated += 1;
      }
    }
    if (curated > 0) {
      modelSourceConfig.curatedEndpointModelKeys.sort();
      persistModelSourceConfig();
      console.log(`[catalog] Auto-curated ${curated} newly discovered ${providerName} model(s).`);
    }
  }
  return { models: fetched.models, deselectedCount, source: fetched.source, note: fetched.note };
}

// ── Config round-trip re-check (2026-09-04) ────────────────────────────────
// After PQC keys sync on a new machine, provider models must be re-discovered
// automatically, and models referenced by imported fallback chains must come
// up Available — without the operator re-checking boxes by hand.

const providerRecheckInFlight = new Set<string>();

function fallbackReferencedModelIds(): Set<string> {
  const referenced = new Set<string>();
  for (const route of Object.values(fallbackModelStore)) {
    if (Array.isArray(route?.models)) {
      for (const modelId of route.models) {
        if (typeof modelId === 'string' && modelId.trim()) referenced.add(modelId.trim());
      }
    }
  }
  return referenced;
}

function providerSlugCandidatesForModelId(modelId: string): string[] {
  const candidates: string[] = [];
  for (const summary of allProviderSummaries()) {
    const slug = canonicalProviderSlug(summary.name);
    if (!slug || slug === 'ollama' || isCustomProvider(slug) || isLocalRouterProviderName(slug)) continue;
    if (modelId === slug || modelId.startsWith(`${slug}-`)) candidates.push(slug);
  }
  return candidates;
}

async function recheckProviderCatalog(providerName: string): Promise<void> {
  if (providerRecheckInFlight.has(providerName)) return;
  providerRecheckInFlight.add(providerName);
  try {
    await refreshProviderEndpointModels(providerName, { preserveCuration: true });
    // Auto-curate exactly the models referenced by fallback chains so an
    // imported config comes up Available instead of Unavailable.
    const referenced = fallbackReferencedModelIds();
    const providerModels = effectiveProviderModels(providerName);
    let added = 0;
    for (const model of providerModels) {
      if (!referenced.has(model.id)) continue;
      const key = endpointModelCurationKey(model);
      if (!modelSourceConfig.curatedEndpointModelKeys.includes(key)) {
        modelSourceConfig.curatedEndpointModelKeys.push(key);
        added += 1;
      }
    }
    if (added > 0) {
      modelSourceConfig.curatedEndpointModelKeys.sort();
      persistModelSourceConfig();
      console.log(`[catalog] Re-check auto-curated ${added} fallback-referenced model(s) for ${providerName}.`);
    }
  } catch (error: any) {
    console.warn(`[catalog] Post-sync re-check failed for ${providerName}: ${sanitizeDiagnosticText(String(error?.message || error))}`);
  } finally {
    providerRecheckInFlight.delete(providerName);
  }
}

/**
 * Schedule background catalog re-checks for the given providers (PQC resync,
 * boot, or fallback import). Sequential + staggered so we never hammer every
 * upstream at once; failures are logged, never fatal.
 */
function scheduleProviderRechecks(providerNames: string[], delayMs = 2000): void {
  const providers = Array.from(new Set(providerNames.filter(Boolean)));
  if (providers.length === 0) return;
  const timer = setTimeout(() => {
    void (async () => {
      for (const providerName of providers) {
        await recheckProviderCatalog(providerName);
      }
    })();
  }, delayMs);
  timer.unref?.();
}

/**
 * Config round-trip healer: make every fallback-referenced model resolvable.
 * 1. Models already in the endpoint cache → add their curation keys directly
 *    (this is the "shows Unavailable until re-checked" case).
 * 2. Models missing from the cache → schedule provider re-checks; after each
 *    refresh the auto-curator runs again over the fresh data.
 */
function scheduleRecheckForFallbackReferences(): void {
  const referenced = fallbackReferencedModelIds();
  if (referenced.size === 0) return;

  // Pass 1: direct-curate from whatever the cache already holds.
  let curated = 0;
  for (const model of endpointModelsCache) {
    if (!referenced.has(model.id)) continue;
    const key = endpointModelCurationKey(model);
    if (!modelSourceConfig.curatedEndpointModelKeys.includes(key)) {
      modelSourceConfig.curatedEndpointModelKeys.push(key);
      curated += 1;
    }
  }
  if (curated > 0) {
    modelSourceConfig.curatedEndpointModelKeys.sort();
    persistModelSourceConfig();
    console.log(`[catalog] Auto-curated ${curated} fallback-referenced model(s) from existing cache.`);
  }

  // Pass 2: schedule provider re-checks for referenced ids still missing.
  const cachedIds = new Set(endpointModelsCache.map((model) => model.id));
  const providers = new Set<string>();
  for (const modelId of referenced) {
    if (cachedIds.has(modelId)) continue;
    for (const slug of providerSlugCandidatesForModelId(modelId)) {
      providers.add(slug);
    }
  }
  if (providers.size > 0) {
    console.log(`[catalog] Fallback references missing from catalog; scheduling re-checks for: ${[...providers].join(', ')}`);
    scheduleProviderRechecks([...providers], 1500);
  }
}

type CatalogResolveOptions = {
  provider?: string;
  mode?: 'custom' | 'endpoints';
  live?: boolean;
};

async function resolveCatalogModels(options: CatalogResolveOptions = {}): Promise<ProviderModel[]> {
  const live = Boolean(options.live);
  const providerFilter = canonicalProviderSlug(String(options.provider || '').trim());

  if (live) {
    if (providerFilter) {
      if (isLocalRouterProviderName(providerFilter)) {
        return fallbackModelList();
      }
      const liveResult = await fetchLiveProviderModels(providerFilter);
      return mapLiveRawModelsToCatalog(providerFilter, liveResult.models);
    }
    return modelPresentationList();
  }

  if (providerFilter) {
    if (isLocalRouterProviderName(providerFilter)) {
      return fallbackModelList();
    }
    return effectiveProviderModels(providerFilter);
  }

  return modelPresentationList();
}

function providerCatalogModels(): ProviderModel[] {
  // Serving catalog: curated selection over the toggle store union any
  // persisted per-provider overrides (the custom editor still works; its
  // models are toggles like everything else). Provider alias entries stay
  // distinct (2026-09-04): each alias is separately curatable so the
  // operator can chain the same underlying model across providers/credits.
  const byKey = new Map<string, ProviderModel>();
  for (const model of modelPresentationList()) {
    byKey.set(endpointModelCurationKey(model), model);
  }
  for (const model of endpointModelsCache) {
    const key = endpointModelCurationKey(model);
    if (!byKey.has(key)) byKey.set(key, model);
  }
  // Local loopback backends (llama.cpp/unsloth): registered models stay in
  // the catalog even while the backend is offline (2026-09-07). First-sight
  // keys auto-curate, matching the auto-curate-new-discoveries behavior.
  const loopbackRows = localLoopbackRegisteredModels();
  const newlyCurated: string[] = [];
  for (const model of loopbackRows) {
    const key = endpointModelCurationKey(model);
    byKey.set(key, model);
    if (!modelSourceConfig.curatedEndpointModelKeys.includes(key)) {
      modelSourceConfig.curatedEndpointModelKeys.push(key);
      newlyCurated.push(key);
    }
  }
  if (newlyCurated.length > 0) {
    modelSourceConfig.curatedEndpointModelKeys.sort();
    try {
      persistModelSourceConfig();
      console.log(`[backends] auto-curated ${newlyCurated.length} local backend model(s).`);
    } catch { /* curation persistence is best-effort */ }
  }
  return applyEndpointCuration([...byKey.values()]);
}

async function discoveryModelList(live = false): Promise<ProviderModel[]> {
  if (live) {
    const upstream = await resolveCatalogModels({ live: true });
    const seen = new Set<string>();
    const merged: ProviderModel[] = [];
    for (const model of [...upstream, ...fallbackModelList()]) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
    return merged;
  }
  return [...providerCatalogModels(), ...fallbackModelList()];
}

const MODEL_ENTRY_CREATED_TIMESTAMP = Math.floor(Date.now() / 1000);

function openAIModelEntry(model: ProviderModel) {
  return {
    id: model.id,
    object: 'model',
    created: MODEL_ENTRY_CREATED_TIMESTAMP,
    owned_by: model.provider,
    display_name: model.display,
    context_length: model.contextLength,
    max_input_tokens: modelMaxInputTokens(model),
    max_output_tokens: modelMaxOutputTokens(model),
    capabilities: {
      toolCalling: model.supportsTools,
      imageInput: model.supportsImages,
      caching: model.supportsCache,
      reasoning: model.supportsReasoning
    }
  };
}

function activeProviderModelList(): ProviderModel[] {
  return providerCatalogModels();
}

function resolveModelTarget(modelName: string): ModelTarget | null {
  const configuredModel = findProviderModel(modelName) || findCatalogModel(modelName);
  if (configuredModel) {
    return {
      providerName: configuredModel.provider,
      actualModel: configuredModel.model,
      presentedModel: configuredModel.id
    };
  }

  const [rawProviderName, ...actualModelParts] = modelName.split('/');
  const actualModel = actualModelParts.join('/');
  if (rawProviderName && actualModel) {
    return {
      providerName: canonicalProviderSlug(rawProviderName),
      actualModel
    };
  }

  for (const provider of catalogProviderSummaries()) {
    const prefix = providerPresentationPrefix(provider.name);
    if (prefix && modelName.startsWith(prefix + '-')) {
      return {
        providerName: provider.name,
        actualModel: modelName.slice(prefix.length + 1)
      };
    }
    if (modelName.startsWith(provider.name + '-')) {
      return {
        providerName: provider.name,
        actualModel: modelName.slice(provider.name.length + 1)
      };
    }
  }

  return null;
}

function fallbackModelPresentation(model: FallbackModel): ProviderModel {
  const active = activeFallbackModels(model);
  const targets = active.length > 0 ? active : model.models;
  const resolvedSpecs = targets
    .map((target) => findCatalogModel(target) || findProviderModel(target))
    .filter(Boolean) as ProviderModel[];

  const maxContext = resolvedSpecs.length > 0
    ? Math.max(...resolvedSpecs.map((s) => s.contextLength || 0))
    : DEFAULT_CONTEXT_LENGTH;
  const maxOutput = resolvedSpecs.length > 0
    ? Math.max(...resolvedSpecs.map((s) => s.outputTokens || 0))
    : DEFAULT_OUTPUT_TOKENS;
  const anyImages = resolvedSpecs.some((s) => s.supportsImages);
  const anyTools = resolvedSpecs.some((s) => s.supportsTools);
  const anyCache = resolvedSpecs.some((s) => s.supportsCache);
  const anyReasoning = resolvedSpecs.some((s) => s.supportsReasoning);

  const routeId = normalizeFallbackRouteId(model.id);
  const presentedId = fallbackPresentedModelId(routeId);

  return {
    id: presentedId,
    provider: FALLBACK_PROVIDER_NAME,
    model: routeId,
    display: `${presentedId}: ${model.models.join(' -> ')}`,
    contextLength: maxContext > 0 ? maxContext : DEFAULT_CONTEXT_LENGTH,
    outputTokens: maxOutput > 0 ? maxOutput : DEFAULT_OUTPUT_TOKENS,
    supportsTools: resolvedSpecs.length > 0 ? anyTools : true,
    supportsImages: anyImages,
    supportsCache: anyCache,
    supportsReasoning: anyReasoning
  };
}

function fallbackModelList() {
  return Object.values(fallbackModelStore)
    .map((model) => fallbackModelPresentation(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function presentedModelList() {
  return [...activeProviderModelList(), ...fallbackModelList()];
}

function findFallbackModel(modelName: string): FallbackModel | undefined {
  if (typeof modelName !== 'string') return undefined;
  const routeId = normalizeFallbackRouteId(modelName);
  const direct = fallbackModelStore[routeId];
  if (direct) return direct;
  return Object.values(fallbackModelStore).find((entry) => normalizeFallbackRouteId(entry.id) === routeId);
}

function findSystemFallback(): FallbackModel | undefined {
  const direct = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
  if (direct) return direct;
  const entries = Object.values(fallbackModelStore);
  return entries.length > 0 ? entries[0] : undefined;
}

function validateFallbackReferences(model: FallbackModel) {
  const unresolved = model.models.filter((entry) => {
    if (findCatalogModel(entry)) return false;
    const resolved = resolveModelTarget(entry);
    if (!resolved || isLocalRouterProviderName(resolved.providerName)) return true;
    return !getProviderSummary(resolved.providerName);
  });

  if (unresolved.length > 0) {
    return { ok: false, error: `Fallback model references unknown model(s): ${unresolved.join(', ')}` } as const;
  }

  return { ok: true } as const;
}

function findPresentedNameConflict(providerName: string, presentedName: string) {
  const modelConflict = activeProviderModelList().find((model) => (
    model.provider !== providerName && model.id === presentedName
  ));
  if (modelConflict) return modelConflict;
  if (findFallbackModel(presentedName)) {
    return {
      id: fallbackPresentedModelId(presentedName),
      provider: FALLBACK_PROVIDER_NAME
    } as Pick<ProviderModel, 'id' | 'provider'>;
  }
  return undefined;
}

function modelDetails(model: ProviderModel) {
  return {
    parent_model: '',
    format: 'openai-compatible',
    family: model.provider,
    families: [model.provider],
    parameter_size: model.id,
    quantization_level: 'remote',
    context_length: model.contextLength
  };
}

/** Deterministic synthetic digest. The real ollama CLI (>= 0.32) renders
 * list entries by slicing digest[:12], so an empty digest panics ListHandler
 * ("slice bounds out of range [:12] with length 0"). Deriving the digest from
 * the presented id keeps it stable across requests and unique per model. */
function syntheticModelDigest(modelId: string): string {
  return `sha256:${crypto.createHash('sha256').update(`local-router:${modelId}`).digest('hex')}`;
}

function ollamaTag(model: ProviderModel) {
  return {
    name: model.id,
    model: model.id,
    modified_at: new Date().toISOString(),
    size: 1,
    digest: syntheticModelDigest(model.id),
    context_length: model.contextLength,
    max_output_tokens: modelMaxOutputTokens(model),
    details: modelDetails(model),
    capabilities: modelCapabilities(model)
  };
}

function findProviderModel(modelName: string): ProviderModel | undefined {
  const lookup = resolveGatewayPresentedLegacyId(stripOllamaLatestSuffix(modelName.trim()));
  return activeProviderModelList().find((model) => providerModelAliases(model).has(lookup));
}

/**
 * Inventory-scoped lookup: serving catalog ∪ endpoint cache. Chain authoring
 * (bootstrap, reference validation, UI toggles) accepts every model the router
 * actually knows about — chain steps with unconfigured providers are skipped
 * at runtime, so authoring must not be gated on the curated serving subset.
 */
function findCatalogModel(modelName: string): ProviderModel | undefined {
  const lookup = resolveGatewayPresentedLegacyId(stripOllamaLatestSuffix(modelName.trim()));
  return allCatalogModels().find((model) => providerModelAliases(model).has(lookup));
}

function normalizeCatalogModelId(raw: string): string {
  const trimmed = stripOllamaLatestSuffix(String(raw || '').trim());
  if (!trimmed) return trimmed;

  const aliasTarget = UPSTREAM_MODEL_ID_ALIASES[trimmed];
  if (aliasTarget) {
    const aliasMatch = findProviderModel(aliasTarget);
    if (aliasMatch) return aliasMatch.id;
  }

  const direct = findProviderModel(trimmed);
  if (direct) return direct.id;

  if (trimmed.includes('/')) {
    const slashIndex = trimmed.indexOf('/');
    const providerName = canonicalProviderSlug(trimmed.slice(0, slashIndex));
    const upstreamModel = trimmed.slice(slashIndex + 1);
    const catalogMatch = activeProviderModelList().find((model) => (
      model.provider === providerName && model.model === upstreamModel
    ));
    if (catalogMatch) return catalogMatch.id;

    const presented = defaultPresentedModelName(providerName, upstreamModel);
    const presentedMatch = findProviderModel(presented);
    if (presentedMatch) return presentedMatch.id;
  }

  return trimmed;
}

function migrateGatewayFallbackMiniMax(): void {
  const replacements: Record<string, string> = {
    'kilo-nvidia-nemotron-3-ultra-550b-a55b-free': 'kilo-minimax-minimax-m3-paid',
    'cline-nvidia-nemotron-3-ultra-550b-a55b-free': 'cline-minimax-minimax-m3-free'
  };
  let fallbackChanged = false;
  for (const route of Object.values(fallbackModelStore)) {
    const nextModels = route.models.map((modelId) => replacements[modelId] ?? modelId);
    if (nextModels.some((id, index) => id !== route.models[index])) {
      route.models = nextModels;
      fallbackChanged = true;
    }
  }
  if (!fallbackChanged) return;
  try {
    persistFallbackModels();
    console.log('[router] Migrated fallback gateway slots from Nemotron Ultra to MiniMax M3.');
  } catch (error: any) {
    console.error('Failed to persist gateway fallback MiniMax migration:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function pruneDisallowedOllamaCloudRouting(): void {
  const allowsPro = ollamaCloudRoutingAllowsPro();
  let fallbackChanged = false;
  for (const route of Object.values(fallbackModelStore)) {
    const before = route.models.length;
    route.models = route.models.filter((modelId) => {
      const resolved = findProviderModel(modelId);
      const target = resolveModelTarget(modelId);
      if (target?.providerName !== 'ollama' || !resolved) return true;
      return !isOllamaCloudPresentedIdBlocked(modelId, resolved.model, allowsPro);
    });
    if (route.models.length !== before) {
      fallbackChanged = true;
    }
  }

  if (fallbackChanged) {
    try {
      persistFallbackModels();
      console.log('[router] Pruned Ollama Cloud models from fallback chain (free-tier allowlist).');
    } catch (error: any) {
      console.error('Failed to persist pruned fallback routes:', sanitizeDiagnosticText(String(error?.message || error)));
    }
  }
}

function normalizeRoutingTierOrder(): void {
  // Empty-by-default world (2026-08-24): every chain in the store is
  // user-authored (or the always-present empty system chain). The old branch
  // that re-injected the curated DEFAULT_FALLBACK_ORDERED_IDS into the system
  // chain whenever the user "hadn't customized" is gone — it would stomp
  // staged single-model additions on every restart.
  let systemFallbackChanged = false;
  let otherFallbackChanged = false;
  for (const route of Object.values(fallbackModelStore)) {
    const isSystemFallback = (
      route.id === SYSTEM_FALLBACK_ROUTE_ID
      || normalizeFallbackRouteId(route.id) === SYSTEM_FALLBACK_ROUTE_ID
      || normalizeFallbackRouteId(route.id) === 'default'
    );

    let nextModels: string[];
    if (isSystemFallback) {
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const modelId of route.models) {
        const trimmed = String(modelId || '').trim();
        if (!trimmed || seen.has(trimmed) || !findCatalogModel(trimmed)) continue;
        seen.add(trimmed);
        deduped.push(trimmed);
      }
      nextModels = deduped;
    } else {
      const deduped: string[] = [];
      const seenModels = new Set<string>();
      for (const modelId of route.models) {
        const trimmed = String(modelId || '').trim();
        if (!trimmed || seenModels.has(trimmed) || !findCatalogModel(trimmed)) continue;
        seenModels.add(trimmed);
        deduped.push(trimmed);
      }
      if (deduped.length === 0) continue;
      nextModels = deduped;
    }

    if (nextModels.length === 0) continue;

    const orderChanged = (
      nextModels.length !== route.models.length
      || nextModels.some((modelId, index) => modelId !== route.models[index])
    );
    if (orderChanged) {
      route.models = nextModels;
      if (isSystemFallback) {
        systemFallbackChanged = true;
      } else {
        otherFallbackChanged = true;
      }
    }
  }

  if (systemFallbackChanged) {
    try {
      persistFallbackModels();
      console.log('[router] Synchronized fallback-models fixed chain with catalog.');
    } catch (error: any) {
      console.error('Failed to persist synchronized fallback-models route:', sanitizeDiagnosticText(String(error?.message || error)));
    }
  }

  if (otherFallbackChanged) {
    try {
      persistFallbackModels();
      console.log('[router] Reordered fallback route by provider tier.');
    } catch (error: any) {
      console.error('Failed to persist tier-ordered fallback route:', sanitizeDiagnosticText(String(error?.message || error)));
    }
  }
}

function migratePersistedRoutingConfig(): void {
  let fallbackChanged = false;
  for (const route of Object.values(fallbackModelStore)) {
    const normalized = route.models
      .map((modelId) => normalizeCatalogModelId(modelId))
      .filter(Boolean);
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const modelId of normalized) {
      if (seen.has(modelId)) continue;
      seen.add(modelId);
      deduped.push(modelId);
    }
    if (deduped.length !== route.models.length || deduped.some((id, index) => id !== route.models[index])) {
      route.models = deduped;
      fallbackChanged = true;
    }
  }

  normalizeRoutingTierOrder();
  migrateGatewayFallbackMiniMax();
  pruneDisallowedOllamaCloudRouting();

  if (fallbackChanged) {
    try {
      persistFallbackModels();
      console.log('[router] Normalized fallback route model IDs to presented catalog aliases.');
    } catch (error: any) {
      console.error('Failed to persist normalized fallback routes:', sanitizeDiagnosticText(String(error?.message || error)));
    }
  }
}

function findPresentedModel(modelName: string): ProviderModel | undefined {
  const lookup = stripOllamaLatestSuffix(modelName.trim());
  return presentedModelList().find((model) => providerModelAliases(model).has(lookup));
}

/** Ordered chain-member configurations for a local-router/<chain> route,
 * exposed in /api/show so clients and the config UI can see exactly which
 * models (and their specs) sit behind the route id. */
function fallbackChainInfo(model: ProviderModel) {
  if (model.provider !== FALLBACK_PROVIDER_NAME) return null;
  const route = findFallbackModel(model.model);
  if (!route) return null;
  const disabled = new Set(Array.isArray(route.disabledModels) ? route.disabledModels : []);
  const members = (Array.isArray(route.models) ? route.models : []).map((modelId, index) => {
    const info = findCatalogModel(modelId) || findProviderModel(modelId);
    const availability = candidateAvailability(modelId);
    return {
      order: index + 1,
      id: modelId,
      enabled: !disabled.has(modelId),
      known: Boolean(info),
      provider: info?.provider || availability?.provider || null,
      context_length: info?.contextLength ?? null,
      max_output_tokens: info ? modelMaxOutputTokens(info) : null,
      supports_tools: info?.supportsTools ?? null,
      supports_vision: info?.supportsImages ?? null,
      status: availability?.status || 'unavailable'
    };
  });
  return {
    route_id: route.id,
    members,
    display: `${fallbackPresentedModelId(route)}: ${route.models.join(' -> ')}`
  };
}

function ollamaShowPayload(model: ProviderModel) {
  const chain = fallbackChainInfo(model);
  return {
    license: '',
    modelfile: `FROM ${model.id}`,
    parameters: '',
    template: '',
    system: '',
    details: modelDetails(model),
    messages: [],
    model_info: {
      'general.architecture': model.provider,
      'general.basename': model.id,
      'general.name': model.id,
      'general.provider': model.provider,
      'general.upstream_model': model.model,
      [`${model.provider}.context_length`]: model.contextLength,
      context_length: model.contextLength,
      max_output_tokens: modelMaxOutputTokens(model),
      supports_tools: model.supportsTools,
      supports_vision: model.supportsImages,
      ...(chain ? { 'local-router.chain': chain.members.map((member) => member.id).join(' -> ') } : {})
    },
    ...(chain ? { local_router_chain: chain } : {}),
    projector_info: {},
    capabilities: modelCapabilities(model),
    modified_at: new Date().toISOString()
  };
}

function vscodeUserDir() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const home = os.homedir();
  const appData = process.env.APPDATA || (isWin ? path.join(home, 'AppData', 'Roaming') : '');

  const candidates: string[] = [];
  if (isWin && appData) {
    candidates.push(
      path.join(appData, 'Antigravity IDE', 'User'),
      path.join(appData, 'Antigravity', 'User'),
      path.join(appData, 'Cursor', 'User'),
      path.join(appData, 'Code', 'User')
    );
  } else if (isMac) {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Antigravity IDE', 'User'),
      path.join(home, 'Library', 'Application Support', 'Antigravity', 'User'),
      path.join(home, 'Library', 'Application Support', 'Cursor', 'User'),
      path.join(home, 'Library', 'Application Support', 'Code', 'User')
    );
  } else {
    candidates.push(
      path.join(home, '.config', 'Antigravity IDE', 'User'),
      path.join(home, '.config', 'Antigravity', 'User'),
      path.join(home, '.config', 'Cursor', 'User'),
      path.join(home, '.config', 'Code', 'User')
    );
  }

  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }

  if (isMac) return path.join(home, 'Library', 'Application Support', 'Code', 'User');
  if (isWin) return path.join(appData || path.join(home, 'AppData', 'Roaming'), 'Code', 'User');
  return path.join(home, '.config', 'Code', 'User');
}

function writeJsonWithBackup(filePath: string, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(filePath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function sqliteJsonSelect(dbPath: string, key: string): any {
  try {
    const output = execFileSync('sqlite3', [
      dbPath,
      `SELECT value FROM ItemTable WHERE key='${key.replace(/'/g, "''")}';`
    ], { encoding: 'utf8' }).trim();
    return output ? JSON.parse(output) : null;
  } catch {
    return null;
  }
}

function sqliteJsonUpsert(dbPath: string, key: string, value: any) {
  const jsonValue = JSON.stringify(value);
  const escapedKey = key.replace(/'/g, "''");
  const escapedValue = jsonValue.replace(/'/g, "''");

  execFileSync('sqlite3', [
    dbPath,
    `CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${escapedKey}', '${escapedValue}');`
  ], { encoding: 'utf8' });
}

function vscodeCachedOllamaModelEntry(model: ProviderModel) {
  return {
    identifier: `ollama/LocalRouter/${model.id}`,
    metadata: {
      extension: {
        value: 'GitHub.copilot-chat',
        _lower: 'github.copilot-chat'
      },
      id: model.id,
      vendor: 'ollama',
      name: model.id,
      family: model.provider,
      tooltip: `${model.id} | provider: ${model.provider} | upstream: ${model.model}`,
      version: model.model,
      multiplierNumeric: 0,
      maxInputTokens: modelMaxInputTokens(model),
      maxOutputTokens: modelMaxOutputTokens(model),
      isDefaultForLocation: {},
      isUserSelectable: true,
      capabilities: {
        vision: model.supportsImages,
        toolCalling: model.supportsTools,
        agentMode: model.supportsTools,
        imageInput: model.supportsImages
      },
      detail: model.id
    }
  };
}

function configureVSCodeModelPicker(hostUrl: string) {
  const userDir = vscodeUserDir();
  const chatLanguageModelsPath = path.join(userDir, 'chatLanguageModels.json');
  const statePath = path.join(userDir, 'globalStorage', 'state.vscdb');
  const models = [...providerCatalogModels(), ...fallbackModelList()];
  const modelNames = models.map((model) => model.id);
  const candidateToModel = new Map<string, ProviderModel>();

  const addCandidate = (candidate: unknown, model: ProviderModel) => {
    if (typeof candidate !== 'string' || !candidate.trim()) return;
    const value = candidate.trim();
    candidateToModel.set(value, model);
    candidateToModel.set(stripOllamaLatestSuffix(value), model);
  };

  for (const model of models) {
    for (const candidate of providerModelAliases(model)) {
      addCandidate(candidate, model);
    }
  }

  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });

  let entries: any[] = [];
  if (fs.existsSync(chatLanguageModelsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(chatLanguageModelsPath, 'utf8'));
      if (Array.isArray(parsed)) entries = parsed;
    } catch {
      entries = [];
    }
  }

  const filtered = entries.filter((entry) => entry?.vendor !== 'ollama');
  filtered.push({
    name: 'Local Router',
    vendor: 'ollama',
    url: hostUrl
  });
  writeJsonWithBackup(chatLanguageModelsPath, filtered);

  const prefs = sqliteJsonSelect(statePath, 'chatModelPickerPreferences') || {};
  const cachedModels = sqliteJsonSelect(statePath, 'chat.cachedLanguageModels.v2') || [];
  const pickerModelName = (identifier: string) => {
    const parts = identifier.split('/');
    return parts.length >= 3 ? parts.slice(2).join('/') : '';
  };

  if (Array.isArray(cachedModels)) {
    const cachedIdentifiers = new Set<string>();
    for (const entry of cachedModels) {
      const metadata = entry?.metadata;
      const identifier = typeof entry?.identifier === 'string' ? entry.identifier : '';
      if (identifier) cachedIdentifiers.add(identifier);
      if (!identifier || metadata?.vendor !== 'ollama') continue;

      let matchedModel: ProviderModel | undefined;
      for (const candidate of [
        pickerModelName(identifier),
        metadata?.id,
        metadata?.name,
        metadata?.family,
        metadata?.version,
        typeof metadata?.detail === 'string' ? metadata.detail.replace(/^Alias:\s*/i, '') : ''
      ]) {
        if (typeof candidate !== 'string' || !candidate.trim()) continue;
        const value = candidate.trim();
        matchedModel = matchedModel || candidateToModel.get(value) || candidateToModel.get(stripOllamaLatestSuffix(value));
      }

      if (matchedModel) {
        metadata.id = matchedModel.id;
        metadata.name = matchedModel.id;
        metadata.family = matchedModel.provider;
        metadata.version = matchedModel.model;
        metadata.detail = matchedModel.id;
        metadata.tooltip = `${matchedModel.id} | provider: ${matchedModel.provider} | upstream: ${matchedModel.model}`;
        metadata.maxInputTokens = modelMaxInputTokens(matchedModel);
        metadata.maxOutputTokens = modelMaxOutputTokens(matchedModel);
        metadata.capabilities = {
          ...(metadata.capabilities || {}),
          toolCalling: matchedModel.supportsTools,
          imageInput: matchedModel.supportsImages,
          agentMode: matchedModel.supportsTools
        };
      }
    }

    for (const model of models) {
      const identifier = `ollama/LocalRouter/${model.id}`;
      if (cachedIdentifiers.has(identifier)) continue;
      cachedModels.push(vscodeCachedOllamaModelEntry(model));
      cachedIdentifiers.add(identifier);
    }
    sqliteJsonUpsert(statePath, 'chat.cachedLanguageModels.v2', cachedModels);
  }

  const configuredIDs = new Set<string>();
  for (const model of models) {
    const ids = new Set<string>([
      `ollama/LocalRouter/${model.id}`,
      `ollama/Ollama/${model.id}`
    ]);

    if (!model.id.includes(':')) {
      ids.add(`ollama/LocalRouter/${model.id}:latest`);
      ids.add(`ollama/Ollama/${model.id}:latest`);
    }

    for (const id of ids) {
      prefs[id] = true;
      configuredIDs.add(id);
    }
  }

  let removedPickerIDCount = 0;
  for (const id of Object.keys(prefs)) {
    if (
      (id.startsWith('ollama/LocalRouter/') || id.startsWith('ollama/Local Router/') || id.startsWith('ollama/FVS-CODE/'))
      && !configuredIDs.has(id)
    ) {
      delete prefs[id];
      removedPickerIDCount += 1;
      continue;
    }

    if (!id.startsWith('ollama/Ollama/') || configuredIDs.has(id)) continue;

    const suffix = pickerModelName(id);
    const baseSuffix = stripOllamaLatestSuffix(suffix);
    const matchedModel = candidateToModel.get(suffix) || candidateToModel.get(baseSuffix);
    const [baseProviderName] = baseSuffix.split('/');
    const isFallbackAlias = isLocalRouterProviderName(baseProviderName);
    const isGeneratedDisplayAlias = Boolean(matchedModel) && /[:/]/.test(baseSuffix);

    if (isFallbackAlias || isGeneratedDisplayAlias) {
      delete prefs[id];
      removedPickerIDCount += 1;
    }
  }

  sqliteJsonUpsert(statePath, 'chatModelPickerPreferences', prefs);

  return {
    chatLanguageModelsPath,
    statePath,
    configuredModelCount: models.length,
    configuredPickerIDCount: configuredIDs.size,
    removedPickerIDCount,
    models: modelNames
  };
}

// ── PQC Secrets Persistence ────────────────────────────────────────────────

/**
 * Resolve a platform-appropriate PATH for spawned PQC child processes.
 * process.env.PATH is essentially always set; the fallback only triggers when it is unset
 * (stripped/minimal environments). POSIX gets the classic bin dirs; Windows gets System32 so
 * `python`/`where` resolve. Replaces the previous POSIX-only `/usr/local/bin:/usr/bin:/bin`.
 */
function defaultChildPathEnv(): string {
  if (process.env.PATH) return process.env.PATH;
  if (process.platform === 'win32') {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return [`${root}\\System32`, root, `${root}\\System32\\Wbem`].join(';');
  }
  return '/usr/local/bin:/usr/bin:/bin';
}

function getPqcConfigDirCandidates(): string[] {
  if (process.env.PQC_CONFIG_DIR) return [process.env.PQC_CONFIG_DIR];
  const candidates: string[] = [];
  const home = os.homedir();
  const noDot = path.join(home, 'config', 'pqc-secrets');
  if (fs.existsSync(noDot)) candidates.push(noDot);
  const dot = path.join(home, '.config', 'pqc-secrets');
  if (fs.existsSync(dot) && !candidates.includes(dot)) candidates.push(dot);

  // WSL interop (2026-09-18): when running under WSL, inspect Windows host user directories
  // (/mnt/<drive>/Users/<user>/.config/pqc-secrets) so Windows-managed PQC keys load seamlessly.
  try {
    if (fs.existsSync('/proc/version') && fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')) {
      if (fs.existsSync('/mnt')) {
        for (const driveRoot of fs.readdirSync('/mnt')) {
          const usersRoot = path.join('/mnt', driveRoot, 'Users');
          if (!fs.existsSync(usersRoot)) continue;
          for (const user of fs.readdirSync(usersRoot)) {
            if (user === 'Public' || user === 'Default' || user.startsWith('.')) continue;
            const winDot = path.join(usersRoot, user, '.config', 'pqc-secrets');
            if (fs.existsSync(winDot) && !candidates.includes(winDot)) candidates.push(winDot);
            const winNoDot = path.join(usersRoot, user, 'config', 'pqc-secrets');
            if (fs.existsSync(winNoDot) && !candidates.includes(winNoDot)) candidates.push(winNoDot);
          }
        }
      }
    }
  } catch {
    /* WSL interop probe unavailable */
  }

  if (candidates.length === 0) {
    candidates.push(dot);
  }
  return candidates;
}

function getPqcConfigDir(): string {
  if (process.env.PQC_CONFIG_DIR) return process.env.PQC_CONFIG_DIR;
  const candidates = getPqcConfigDirCandidates();
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'secrets.bundle.json'))) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0] || path.join(os.homedir(), '.config', 'pqc-secrets');
}

function getPqcBundlePath(): string {
  return path.join(getPqcConfigDir(), 'secrets.bundle.json');
}

function getPqcPubkeyPath(): string {
  return path.join(getPqcConfigDir(), 'recipient.pub');
}

/**
 * Locate the pqc-secrets entry point, platform-aware.
 *
 * `bin/pqc-secrets` is a dispatch wrapper: it execs the native Rust binary
 * (`bin/pqc-secrets.darwin-arm64`) on macOS arm64 and otherwise delegates to the Python
 * engine (`.agents/skills/pqc-secrets/scripts/pqc_secrets.py`) via `uv run`. On Windows we
 * look for `bin/pqc-secrets.exe` (then the extensionless name); executability on Windows is
 * determined by PATHEXT, not the POSIX exec bit, so we use F_OK (existence) there. On POSIX
 * we keep the X_OK check. This is the single place native-binary selection lives — to support
 * a new OS/arch, add its candidate name here and ship the binary.
 */
function getPqcBinPath(): string {
  const isWindows = process.platform === 'win32';
  const baseNames = isWindows ? ['pqc-secrets.cmd', 'pqc-secrets.bat', 'pqc-secrets.exe', 'pqc-secrets'] : ['pqc-secrets'];
  const roots = [
    path.resolve(__dirname, '..', 'bin'),
    path.resolve(process.cwd(), 'bin')
  ];
  const accessMode = isWindows ? fs.constants.F_OK : fs.constants.X_OK;
  for (const root of roots) {
    for (const base of baseNames) {
      const candidate = path.join(root, base);
      try {
        fs.accessSync(candidate, accessMode);
        return candidate;
      } catch { /* not found */ }
    }
  }
  return '';
}

function execPqcBin(args: string[], options: { input?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): string {
  const bin = getPqcBinPath();
  if (!bin) throw new Error('pqc-secrets binary not found');

  const spawnEnv = {
    ...process.env,
    PQC_CONFIG_DIR: getPqcConfigDir(),
    PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
    PATH: defaultChildPathEnv(),
    ...options.env
  };

  const timeout = options.timeout || 120000;

  if (process.platform === 'win32' && (bin.endsWith('.cmd') || bin.endsWith('.bat'))) {
    const scriptPath = path.resolve(__dirname, '..', '.agents', 'skills', 'pqc-secrets', 'scripts', 'pqc_secrets.py');
    if (fs.existsSync(scriptPath)) {
      try {
        return execFileSync('uv', ['run', scriptPath, ...args], {
          input: options.input,
          encoding: 'utf8',
          timeout,
          env: spawnEnv
        });
      } catch (err: any) {
        // Fall back to shell invocation if direct uv spawn fails
      }
    }
    return execFileSync(bin, args, {
      input: options.input,
      encoding: 'utf8',
      timeout,
      env: spawnEnv,
      shell: true
    });
  }

  return execFileSync(bin, args, {
    input: options.input,
    encoding: 'utf8',
    timeout,
    env: spawnEnv
  });
}

function ensurePqcKeypair(bin?: string): boolean {
  const pubkeyPath = getPqcPubkeyPath();
  if (fs.existsSync(pubkeyPath)) return true;
  try {
    execPqcBin(['keygen'], { timeout: 30000 });
    console.log(`[PQC] Generated new ML-KEM-768 keypair at ${getPqcConfigDir()}/`);
    return true;
  } catch (err) {
    console.error(`[PQC] Failed to generate keypair:`, (err as Error).message);
    return false;
  }
}

function loadKeysFromEnvironment(): number {
  const allSummaries = allProviderSummaries();
  let count = 0;
  for (const summary of allSummaries) {
    if (keyStore[summary.name]) continue;
    // Strict namespace: only LOCALROUTER_<KEY_ENV_VAR> counts as a Local
    // Router key; ambient plainly-named keys belong to other tools.
    const envValue = process.env[localRouterEnvVarName(summary.keyEnvVar)] || process.env[summary.keyEnvVar];
    if (envValue) {
      keyStore[summary.name] = envValue;
      count++;
    }
  }
  if (!keyStore['modal-proxy'] && process.env.MODAL_PROXY_TOKEN_ID && process.env.MODAL_PROXY_TOKEN_SECRET) {
    keyStore['modal-proxy'] = `${process.env.MODAL_PROXY_TOKEN_ID}.${process.env.MODAL_PROXY_TOKEN_SECRET}`;
    count++;
  }
  return count;
}

type PqcBundleSyncResult =
  | { ok: true; loaded: string[]; skipped: string[] }
  | { ok: false; error: string };

/**
 * Providers whose keys came from the PQC secrets bundle (vs UI save or raw
 * process env). Drives the configuredSource 'pqc' badge so operators can see
 * a key exists in the bundle even when it was packed outside Local Router.
 */
const pqcBundleProviders = new Set<string>();
let lastPqcSyncAt = 0;
const PQC_SYNC_MIN_INTERVAL_MS = 30_000;

/**
 * Run `pqc-secrets export`, map KEY=VAL lines onto registered providers, and
 * load matches into the key store. Retries the export once: the dispatcher
 * script cold-starts uv/python (its first run after reboots can exceed the
 * child timeout or race its dep cache).
 */
function syncKeysFromPqcBundle(options: { force?: boolean } = {}): PqcBundleSyncResult {
  const force = Boolean(options.force);
  if (!force && lastPqcSyncAt > 0 && Date.now() - lastPqcSyncAt < PQC_SYNC_MIN_INTERVAL_MS) {
    return { ok: false, error: 'cooldown' };
  }

  const bin = getPqcBinPath();
  if (!bin) return { ok: false, error: 'pqc-secrets binary not found' };

  const candidates = getPqcConfigDirCandidates();
  const bundleDirs = candidates.filter((dir) => fs.existsSync(path.join(dir, 'secrets.bundle.json')));

  if (bundleDirs.length === 0) {
    const defaultDir = getPqcConfigDir();
    const defaultBundle = path.join(defaultDir, 'secrets.bundle.json');
    if (Object.keys(keyStore).some((k) => k !== 'ollama' && keyStore[k])) {
      persistPqcSecrets();
    }
    if (!fs.existsSync(defaultBundle)) {
      return { ok: false, error: `no bundle at ${defaultBundle}` };
    }
    bundleDirs.push(defaultDir);
  }

  const loaded: string[] = [];
  const skipped: string[] = [];
  let anySuccess = false;
  let lastError: unknown = null;

  for (const dir of bundleDirs) {
    let output: string | null = null;
    try {
      output = execPqcBin(['export'], { env: { PQC_CONFIG_DIR: dir }, timeout: 120000 });
      anySuccess = true;
    } catch (err) {
      lastError = err;
      continue;
    }
    if (!output) continue;

    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      const match = line.match(/^export\s+([A-Z0-9_]+)=(.+)$/);
      if (!match) continue;
      const fullName = match[1];
      let value = match[2].trim().replace(/^["']|["']$/g, '').trim();
      if (value.startsWith('Authorization: Bearer ')) {
        value = value.slice('Authorization: Bearer '.length).trim();
      }
      const envVar = fullName.startsWith('LOCALROUTER_') ? fullName.slice('LOCALROUTER_'.length) : fullName;
      process.env[localRouterEnvVarName(envVar)] = value;
      process.env[envVar] = value;
      const providers = providerSummariesForEnvVar(envVar);
      if (providers.length > 0) {
        for (const provider of providers) {
          keyStore[provider.name] = value;
          pqcBundleProviders.add(provider.name);
          if (!loaded.includes(provider.name)) {
            loaded.push(provider.name);
          }
        }
      } else {
        if (!skipped.includes(fullName)) {
          skipped.push(fullName);
        }
      }
    }
  }

  if (!anySuccess && bundleDirs.length > 0) {
    const stderr = (() => {
      const candidate = (lastError as { stderr?: unknown } | null)?.stderr;
      if (typeof candidate === 'string') return candidate.trim();
      if (candidate instanceof Buffer) return candidate.toString('utf8').trim();
      return '';
    })();
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return { ok: false, error: `export failed: ${message}${stderr ? ` — stderr: ${sanitizeDiagnosticText(stderr).slice(0, 300)}` : ''}` };
  }

  if (process.env.MODAL_PROXY_TOKEN_ID && process.env.MODAL_PROXY_TOKEN_SECRET) {
    const combined = `${process.env.MODAL_PROXY_TOKEN_ID}.${process.env.MODAL_PROXY_TOKEN_SECRET}`;
    keyStore['modal-proxy'] = combined;
    pqcBundleProviders.add('modal-proxy');
    if (!loaded.includes('modal-proxy')) loaded.push('modal-proxy');
  }
  lastPqcSyncAt = Date.now();
  return { ok: true, loaded, skipped };
}

function loadPqcSecrets(): void {
  if (process.env.LOCAL_ROUTER_SKIP_PQC_LOAD === 'true') {
    const antigravitySession = detectLocalAntigravitySession();
  if (antigravitySession) {
    console.log('[oauth] Detected active Antigravity session on host system (' + (antigravitySession.accountLabel || 'authenticated') + ').');
  }
  const cursorSession = detectLocalCursorSession();
  if (cursorSession) {
    console.log('[oauth] Detected active Cursor session on host system (' + (cursorSession.accountLabel || 'authenticated') + ').');
  }
  ensureDefaultOllamaApiKey(keyStore);
    pruneDisallowedOllamaCloudRouting();
    return;
  }

  const bin = getPqcBinPath();
  if (!bin) {
    console.log(`[PQC] pqc-secrets binary not found — install at bin/pqc-secrets or run 'uv tool install' to enable bundle loading.`);
    console.log(`[PQC] Falling back to environment variables and process.env for provider keys.`);
    const envCount = loadKeysFromEnvironment();
    if (envCount > 0) {
      console.log(`[PQC] Loaded ${envCount} provider key(s) from environment.`);
    }
    ensureDefaultOllamaApiKey(keyStore);
    pruneDisallowedOllamaCloudRouting();
    reportMissingProviders();
    return;
  }

  const bundlePath = getPqcBundlePath();
  const bundleExists = fs.existsSync(bundlePath);

  if (!bundleExists) {
    console.log(`[PQC] No secrets bundle found at ${bundlePath}.`);
    console.log(`[PQC] To create one: run 'bin/pqc-secrets keygen' then 'bin/pqc-secrets pack' (pipe KEY=VAL lines via stdin).`);
    console.log(`[PQC] Falling back to environment variables for provider keys.`);
    const envCount = loadKeysFromEnvironment();
    if (envCount > 0) {
      console.log(`[PQC] Loaded ${envCount} provider key(s) from environment.`);
    }
    ensureDefaultOllamaApiKey(keyStore);
    pruneDisallowedOllamaCloudRouting();
    reportMissingProviders();
    return;
  }

  const sync = syncKeysFromPqcBundle({ force: true });
  if (sync.ok) {
    if (sync.loaded.length > 0) {
      pqcBundleLoaded = true;
    console.log(`[PQC] Loaded ${sync.loaded.length} provider key(s) from bundle: ${sync.loaded.join(', ')}`);
    }
    if (sync.skipped.length > 0) {
      console.log(`[PQC] Env vars not mapped to providers: ${sync.skipped.join(', ')}`);
    }
  } else {
    console.log(`[PQC] Failed to load bundle: ${sync.error}`);
    console.log(`[PQC] Falling back to environment variables.`);
  }
  const envCount = loadKeysFromEnvironment();
  if (envCount > 0) {
    console.log(`[PQC] Loaded ${envCount} additional provider key(s) from environment.`);
  }
  ensureDefaultOllamaApiKey(keyStore);
  pruneDisallowedOllamaCloudRouting();
  reportMissingProviders();
  // Hydrate Antigravity from the host IDE session (2026-09-04): runs on the
  // normal boot path too, not only when PQC loading is skipped.
  const antigravitySession = detectLocalAntigravitySession();
  if (antigravitySession) {
    console.log('[oauth] Detected active Antigravity session on host system (' + (antigravitySession.accountLabel || 'authenticated') + ').');
  }
  const cursorSession = detectLocalCursorSession();
  if (cursorSession) {
    console.log('[oauth] Detected active Cursor session on host system (' + (cursorSession.accountLabel || 'authenticated') + ').');
  }
}

function reportMissingProviders(): void {
  const allSummaries = allProviderSummaries();
  const missing = allSummaries.filter((s) => !keyStore[s.name] && !isOAuthProvider(s.name)).map((s) => s.name);
  if (missing.length > 0) {
    const missingWithoutOllama = missing.filter((name) => name !== 'ollama');
    if (missingWithoutOllama.length > 0) {
      console.log(`[PQC] Providers without keys: ${missingWithoutOllama.join(', ')}`);
    }
  }
}

function findProviderByEnvVar(envVar: string): ProviderSummary | undefined {
  return allProviderSummaries().find((s) => s.keyEnvVar === envVar);
}

function providerSummariesForEnvVar(envVar: string): ProviderSummary[] {
  return allProviderSummaries().filter((summary) => summary.keyEnvVar === envVar);
}

/**
 * Local Router's namespaced copy of a provider key: bundle sync and key
 * saves write ONLY this name, and every lookup reads ONLY this name — ambient
 * same-named variables for other tools (e.g. a plainly named KILO_API_KEY)
 * are deliberately invisible to Local Router so limit-scoped keys can't be
 * consumed by the wrong tool.
 */
function localRouterEnvVarName(keyEnvVar: string): string {
  return `LOCALROUTER_${keyEnvVar}`;
}

function providerEnvKeyValue(keyEnvVar: string): string | undefined {
  return process.env[localRouterEnvVarName(keyEnvVar)];
}

/** Catalog providers may share one env var (e.g. opencode-go + opencode-zen → OPENCODE_API_KEY). */
function setProviderKeyForEnvVar(envVar: string, keyValue: string): void {
  process.env[localRouterEnvVarName(envVar)] = keyValue;
  for (const summary of providerSummariesForEnvVar(envVar)) {
    keyStore[summary.name] = keyValue;
    uiSavedProviderKeys.add(summary.name);
  }
}

function clearProviderKeyForProvider(providerName: string): void {
  const summary = getProviderSummary(providerName);
  if (!summary) return;
  const envVar = summary.keyEnvVar;
  for (const sibling of providerSummariesForEnvVar(envVar)) {
    delete keyStore[sibling.name];
    uiSavedProviderKeys.delete(sibling.name);
    pqcBundleProviders.delete(sibling.name);
  }
  // Namespaced copy only — the operator's plainly-named ambient variable for
  // other tools is never touched.
  delete process.env[localRouterEnvVarName(envVar)];
}

function persistPqcSecrets(): void {
  const bin = getPqcBinPath();
  if (!bin) {
    console.warn(`[PQC] pqc-secrets binary not found — key changes will not persist across restarts. Install bin/pqc-secrets to enable.`);
    return;
  }
  try {
    const managedEnvVars = new Set<string>();
    for (const summary of allProviderSummaries()) {
      managedEnvVars.add(localRouterEnvVarName(summary.keyEnvVar));
      managedEnvVars.add(summary.keyEnvVar);
    }
    const preservedLines: string[] = [];
    if (fs.existsSync(getPqcBundlePath())) {
      let existingOutput: string | null = null;
      try {
        existingOutput = execPqcBin(['export'], { timeout: 120000 });
      } catch (err) {
        console.error('[PQC] Cannot persist safely: existing bundle export failed — not overwriting. Error:', sanitizeDiagnosticText(String((err as Error).message)));
        return;
      }
      for (const rawLine of (existingOutput || '').split(/\r?\n/)) {
        const line = rawLine.trim();
        const match = line.match(/^export\s+([A-Z0-9_]+)=(.+)$/);
        if (!match) continue;
        if (managedEnvVars.has(match[1])) continue;
        preservedLines.push(`${match[1]}=${match[2].trim()}`);
      }
    }

    const lines: string[] = [...preservedLines];
    const packedEnvVars = new Set<string>();
    for (const [providerName, keyValue] of Object.entries(keyStore)) {
      if (!keyValue) continue;
      if (providerName === 'ollama' && isOllamaPlaceholderKey(keyValue)) continue;
      const summary = getProviderSummary(providerName);
      if (summary) {
        const namespaced = localRouterEnvVarName(summary.keyEnvVar);
        if (!packedEnvVars.has(namespaced)) {
          packedEnvVars.add(namespaced);
          lines.push(`${namespaced}=${keyValue}`);
        }
      }
    }
    if (process.env.MODAL_PROXY_TOKEN_ID) {
      lines.push(`MODAL_PROXY_TOKEN_ID=${process.env.MODAL_PROXY_TOKEN_ID}`);
    }
    if (process.env.MODAL_PROXY_TOKEN_SECRET) {
      lines.push(`MODAL_PROXY_TOKEN_SECRET=${process.env.MODAL_PROXY_TOKEN_SECRET}`);
    }
    if (process.env.MODAL_SESSION_ID) {
      lines.push(`MODAL_SESSION_ID=${process.env.MODAL_SESSION_ID}`);
    }
    if (lines.length === 0) return;
    if (!ensurePqcKeypair(bin)) {
      console.error(`[PQC] Cannot persist: no keypair at ${getPqcPubkeyPath()}. Run 'bin/pqc-secrets keygen' manually.`);
      return;
    }
    execPqcBin(['pack'], {
      input: lines.join('\n') + '\n',
      timeout: 30000
    });
    console.log(`[PQC] Persisted ${lines.length} key(s) to ${getPqcBundlePath()}.`);
  } catch (err) {
    console.error('[PQC] Failed to persist secrets:', (err as Error).message);
  }
}

app.head('/', (req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/', (req: Request, res: Response) => {
  res.type('text/plain').send('Ollama is running');
});


app.get('/ui', (req: Request, res: Response) => {
  res.redirect('/config');
});

const configState = {
  get customProviderStore() { return customProviderStore; },
  set customProviderStore(val) { customProviderStore = val; },
  get thinkingProxyEnabled() { return thinkingProxyEnabled; },
  set thinkingProxyEnabled(val) { thinkingProxyEnabled = val; },
  get waferZdrEnabled() { return waferZdrEnabled; },
  set waferZdrEnabled(val) { waferZdrEnabled = val; },
  get headroomEnabled() { return headroomEnabled; },
  set headroomEnabled(val) { headroomEnabled = val; },
  get headroomProxyUrl() { return headroomProxyUrl; },
  set headroomProxyUrl(val) { headroomProxyUrl = val; },
  get endpointModelsCache() { return endpointModelsCache; },
  set endpointModelsCache(val) { endpointModelsCache = val; }
};

export const agentProxyConfig: AgentProxyConfig = loadAgentProxyConfig();

export function remapClaudeCodeModel(originalModel: string, config?: AgentProxyConfig): string {
  const cfg = config || agentProxyConfig;
  if (!cfg?.claudeCode?.enabled) return originalModel;

  const models = cfg.claudeCode.models || {};
  const lower = String(originalModel || '').toLowerCase().trim();

  const resolveTarget = (target?: string) => {
    if (!target) return undefined;
    const t = target.trim();
    if (t === '' || t === 'passthrough') return undefined;
    return t;
  };

  // 1. Sonnet 5 (1M context) slot
  if (lower.includes('sonnet-5') || lower.includes('sonnet 5')) {
    if (models.sonnet5_1m === 'passthrough') return originalModel;
    const target = resolveTarget(models.sonnet5_1m);
    if (target) return target;
  }

  // 2. Opus (1M context) slot
  if (lower.includes('opus')) {
    if (models.opus1m === 'passthrough') return originalModel;
    const target = resolveTarget(models.opus1m);
    if (target) return target;
  }

  // 3. Haiku slot
  if (lower.includes('haiku')) {
    if (models.haiku === 'passthrough') return originalModel;
    const target = resolveTarget(models.haiku);
    if (target) return target;
  }

  // 4. Sonnet slot
  if (lower.includes('sonnet')) {
    if (models.sonnet === 'passthrough') return originalModel;
    const target = resolveTarget(models.sonnet);
    if (target) return target;
  }

  // 5. Default slot
  if (models.default === 'passthrough') return originalModel;
  const defaultTarget = resolveTarget(models.default);
  if (defaultTarget && (lower === 'default' || lower === '' || lower.includes('claude'))) {
    return defaultTarget;
  }

  return originalModel;
}

const configApiDeps = {
  state: configState,
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
  snapshotFullCurationBackup,
  scheduleRecheckForFallbackReferences,
  writeProviderEndpointsDoc,
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
  agentProxyConfig,
  thinkingLevelApiPayload,
  thinkingLevelStore,
  persistThinkingConfig,
  persistWaferConfig,
  waferZdrApiPayload,
  persistHeadroomConfig,
  headroomApiPayload,
  probeHeadroom: probeHeadroomHealth,
  DEFAULT_FALLBACK_MODELS_TEXT,
  DEFAULT_CHAIN_OF_DRAFT_PROMPT,
  DEFAULT_THINKING_LEVEL,
  activeProviderModelList,
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
  validateFallbackReferences,
  isOAuthProvider,
  getOAuthStatus,
  getOAuthStateSafe,
  clearOAuthCredentials,
  refreshOAuthToken,
  fetchOAuthProviderModels
};

registerConfigApiRoutes(app, configApiDeps);

// Lazy load provider module
async function loadProvider(name: string): Promise<ProxyProvider | null> {
  try {
    const mod = await import(`./providers/${name}`);
    return mod.default || mod;
  } catch (err) {
    const summary = getProviderSummary(name);
    if (!summary) {
      console.error(`Failed to load provider: ${name}`);
      return null;
    }

    return {
      name: summary.name,
      baseUrl: providerBaseUrl(summary),
      getHeaders: (): Record<string, string> => {
        // Local loopback backends (llama.cpp `llama-server`, Unsloth) are
        // keyless by design — their localhost endpoint has no auth. Sending
        // no Authorization header is correct; throwing broke offline-tolerant
        // registration (2026-09-07).
        if (isLocalLoopbackProvider(summary.name)) {
          return { 'Content-Type': 'application/json' };
        }
        const key = keyStore[summary.name] || providerEnvKeyValue(summary.keyEnvVar);
        if (!key) {
          throw new Error(`${summary.keyEnvVar} is not set for ${summary.name}`);
        }

        return {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`
        };
      },
      getModels: async () => {
        const models = effectiveProviderModels(summary.name);
        return models.map((model) => ({
          id: model.model,
          object: 'model',
          owned_by: summary.name
        }));
      }
    };
  }
}


function modelPresentationList() {
  const providers = allProviderSummaries();
  if (providers.length === 0) {
    return applyEndpointCuration(endpointModelsCache);
  }

  return providers.flatMap((provider) => effectiveProviderModels(provider.name));
}

type ProviderCatalogMode = 'active' | 'custom' | 'all';

function parseProviderCatalogMode(raw: unknown): ProviderCatalogMode {
  const value = String(raw || 'active').trim().toLowerCase();
  if (value === 'custom' || value === 'all' || value === 'active') {
    return value;
  }
  return 'active';
}

function customCatalogModels(): ProviderModel[] {
  // Single-catalog regime (2026-08-20): the management view is every known
  // model — curated ∪ untoggled discoveries ∪ overrides. Off-by-default
  // refresh (2026-08-22) means the curated set can legitimately be empty;
  // management surfaces must never show nothing while the catalog is known.
  return allCatalogModels();
}

function allCatalogModels(): ProviderModel[] {
  // Everything known: registry/override/custom inventory ∪ curated serving ∪
  // live cache discoveries. Registry entries are meaningful chain candidates
  // even when never curated or cached, so chain authoring (bootstrap,
  // validation, toggles) resolves against this full inventory.
  const byKey = new Map<string, ProviderModel>();
  for (const model of modelPresentationList()) {
    byKey.set(`${model.provider}::${model.model}`, model);
  }
  for (const model of endpointModelsCache) {
    byKey.set(`${model.provider}::${model.model}`, model);
  }
  // Local loopback backends: registered models resolve for routing, chain
  // authoring, and validation even while the backend is offline.
  for (const model of localLoopbackRegisteredModels()) {
    byKey.set(`${model.provider}::${model.model}`, model);
  }
  return Array.from(byKey.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function catalogModelsForMode(mode: ProviderCatalogMode): ProviderModel[] {
  if (mode === 'all') {
    return allCatalogModels();
  }
  if (mode === 'custom') {
    return customCatalogModels();
  }
  return providerCatalogModels();
}

function providerModelsGroupedByProvider(models: ProviderModel[]) {
  const grouped = new Map<string, ProviderModel[]>();
  for (const model of models) {
    const bucket = grouped.get(model.provider) || [];
    bucket.push(model);
    grouped.set(model.provider, bucket);
  }

  return allProviderSummaries().map((provider) => ({
    provider: provider.name,
    source: providerModelSource(provider.name),
    models: (grouped.get(provider.name) || []).sort((a, b) => a.id.localeCompare(b.id))
  }));
}

ensureLocalRouterConfigDir();
migrateLegacyConfigIfNeeded();
loadCustomProviders();
// Model-source + toggle-store cache must load BEFORE persisted routes:
// route validation resolves candidates through the catalog, which is only
// populated after the legacy-catalog migration seeds it.
loadModelSourceConfig();

// Re-apply the configured default curation config at boot: a named saved
// selection the operator marked as the baseline for every server start.
if (modelSourceConfig.defaultCurationConfig) {
  const defaultConfig = loadCurationConfigs().find((config) => config.name === modelSourceConfig.defaultCurationConfig);
  if (defaultConfig) {
    modelSourceConfig.curatedEndpointModelKeys = Array.from(new Set(defaultConfig.selectedKeys))
      .slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
    modelSourceConfig.curationEnabled = true;
    try {
      persistModelSourceConfig();
      console.log(`[catalog] Applied default curation config "${defaultConfig.name}" (${modelSourceConfig.curatedEndpointModelKeys.length} models).`);
    } catch (error: unknown) {
      console.error('Failed to persist default curation config application:', sanitizeDiagnosticText(String(error instanceof Error ? error.message : error)));
    }
  } else {
    console.warn(`[catalog] Default curation config "${modelSourceConfig.defaultCurationConfig}" not found in curation-configs.json — leaving selection unchanged.`);
  }
}
loadEndpointModelsCache();
loadPersistedProviderModels();
seedRegistryBaselines();
if (shouldServe) {
  startCatalogHealthMonitor();
}
mergeBaselineProviderModelOverrides();
seedRegistryCatalogIfNeeded();
ensureStandardLocalBackends();
loadPersistedFallbackModels();
if (waferZdrEnabled) {
  console.log('[Wafer] ZDR enabled for GLM-5.1, Kimi-K2.6, deepseek-v4-pro');
}
loadPersistedRouterSettings();
if (shouldServe) {
  watchRouterSettingsFile();
}
loadPersistedSystemPrompt();
loadPersistedThinkingConfig();
loadWaferConfig();
loadHeadroomConfig();
if (headroomEnabled) {
  console.log(`[Headroom] Context compression enabled (proxy: ${headroomProxyUrl})`);
}
migratePersistedRoutingConfig();

// Empty-by-default (2026-08-24): no curated chains are seeded at boot. Users
// author their own chains in /config/fallback, or declare the complete route
// set (plus optional curation) in a startup config file: `local-router start
// --config <file>` or LOCAL_ROUTER_ROUTES_CONFIG (template: config/routes.example.json).
// Boot only cleans long-deprecated route ids from pre-existing stores.

function cleanupObsoletePresetRoutes() {
  let changed = false;
  for (const obsoleteId of OBSOLETE_PRESET_ROUTE_IDS) {
    if (fallbackModelStore[obsoleteId]) {
      delete fallbackModelStore[obsoleteId];
      changed = true;
      console.log(`[router] Removed obsolete preset fallback "${obsoleteId}".`);
    }
  }
  if (changed) {
    try { persistFallbackModels(); } catch (e: any) {
      console.error('[router] Failed to persist obsolete preset cleanup:', sanitizeDiagnosticText(String(e?.message || e)));
    }
  }
}

type RoutesConfigFile = {
  fallbackModels?: Record<string, string[] | { models?: string[]; disabledModels?: string[] }>;
  curation?: { enabled?: boolean; selectedKeys?: string[] };
  filterConfigured?: boolean;
};

function routesConfigFatal(message: string): never {
  console.error(`[config] ${message}`);
  process.exit(1);
}

function applyRoutesConfigFileIfSet() {
  const rawPath = String(process.env.LOCAL_ROUTER_ROUTES_CONFIG || '').trim();
  if (!rawPath) return;

  const configPath = path.resolve(rawPath);
  if (!fs.existsSync(configPath)) {
    routesConfigFatal(`Routes config file not found: ${configPath}`);
  }

  let parsed: RoutesConfigFile;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw) as RoutesConfigFile;
  } catch (error: any) {
    routesConfigFatal(`Routes config is not valid JSON (${configPath}): ${sanitizeDiagnosticText(String(error?.message || error), 220)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    routesConfigFatal(`Routes config must be a JSON object (${configPath}).`);
  }

  if (parsed.fallbackModels !== undefined) {
    if (!parsed.fallbackModels || typeof parsed.fallbackModels !== 'object' || Array.isArray(parsed.fallbackModels)) {
      routesConfigFatal(`"fallbackModels" must be an object mapping route ids to model lists (${configPath}).`);
    }
    const nextStore: Record<string, FallbackModel> = {};
    for (const [rawId, rawRoute] of Object.entries(parsed.fallbackModels)) {
      const routeId = normalizeFallbackRouteId(String(rawId || ''));
      if (!routeId) {
        routesConfigFatal(`Route with empty id in ${configPath}.`);
      }
      const modelsRaw = Array.isArray(rawRoute) ? rawRoute : (rawRoute && typeof rawRoute === 'object' ? rawRoute.models : undefined);
      const disabledRaw = Array.isArray(rawRoute) ? [] : (rawRoute && typeof rawRoute === 'object' && Array.isArray(rawRoute.disabledModels) ? rawRoute.disabledModels : []);
      if (!Array.isArray(modelsRaw)) {
        routesConfigFatal(`Route "${rawId}" must be an array of model ids or { models, disabledModels } (${configPath}).`);
      }
      const parsedRoute = parseFallbackModel({
        id: routeId,
        models: modelsRaw,
        disabledModels: disabledRaw
      });
      if (!parsedRoute.ok) {
        routesConfigFatal(`Route "${rawId}" invalid (${configPath}): ${parsedRoute.error}`);
      }
      const referenceCheck = validateFallbackReferences(parsedRoute.model);
      if (!referenceCheck.ok) {
        routesConfigFatal(`Route "${rawId}" references unknown models (${configPath}): ${referenceCheck.error}`);
      }
      nextStore[parsedRoute.model.id] = cloneFallbackModel(parsedRoute.model);
    }
    for (const key of Object.keys(fallbackModelStore)) {
      delete fallbackModelStore[key];
    }
    Object.assign(fallbackModelStore, nextStore);
    persistFallbackModels();
    console.log(`[config] Applied ${Object.keys(nextStore).length} fallback route(s) from ${configPath} (replaces local chains).`);
  }

  if (parsed.curation !== undefined) {
    if (!parsed.curation || typeof parsed.curation !== 'object' || Array.isArray(parsed.curation)) {
      routesConfigFatal(`"curation" must be an object (${configPath}).`);
    }
    if (Array.isArray(parsed.curation.selectedKeys)) {
      const keys = parsed.curation.selectedKeys.map((key) => String(key || '').trim()).filter(Boolean);
      modelSourceConfig.curatedEndpointModelKeys = Array.from(new Set(keys)).slice(0, MAX_CURATED_ENDPOINT_MODEL_KEYS);
      modelSourceConfig.curationEnabled = parsed.curation.enabled !== false;
    }
    if (typeof parsed.curation.enabled === 'boolean') {
      modelSourceConfig.curationEnabled = parsed.curation.enabled;
    }
    persistModelSourceConfig();
    console.log(`[config] Applied curation selection (${modelSourceConfig.curatedEndpointModelKeys.length} models, curation ${modelSourceConfig.curationEnabled ? 'on' : 'off'}) from ${configPath}.`);
  }

  if (typeof parsed.filterConfigured === 'boolean') {
    modelSourceConfig.filterConfigured = parsed.filterConfigured;
    persistModelSourceConfig();
    console.log(`[config] Applied filterConfigured=${parsed.filterConfigured} from ${configPath}.`);
  }
}

cleanupObsoletePresetRoutes();
applyRoutesConfigFileIfSet();

// The system chain ALWAYS exists — empty by default (2026-08-24 follow-up):
// it is the permanent landing pad for "＋ Fallback" staging and the cascade
// target for failed direct models. Zero curated steps are seeded; users add
// their own. A config file may populate it; an explicit { fallbackModels: {} }
// still leaves this one empty route present (by operator request).
function ensureSystemFallbackRouteExists() {
  if (fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID]) return;
  fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID] = { id: SYSTEM_FALLBACK_ROUTE_ID, models: [], disabledModels: [] };
  try {
    persistFallbackModels();
    console.log(`[router] Created empty system fallback chain "${SYSTEM_FALLBACK_ROUTE_ID}" (no curated steps — add your own).`);
  } catch (error: any) {
    console.error('[router] Failed to persist empty system fallback chain:', sanitizeDiagnosticText(String(error?.message || error)));
    delete fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
  }
}
ensureSystemFallbackRouteExists();


function ollamaImageToOpenAIUrl(image: unknown) {
  if (typeof image !== 'string' || !image.trim()) return null;
  const value = image.trim();
  if (/^(?:https?:|data:)/i.test(value)) return value;
  return `data:image/png;base64,${value}`;
}

function ollamaMessagesToOpenAI(messages: any[]) {
  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;
    const images = Array.isArray(message.images)
      ? message.images.map(ollamaImageToOpenAIUrl).filter(Boolean)
      : [];
    if (images.length === 0) return message;

    const contentParts: any[] = [];
    if (typeof message.content === 'string' && message.content) {
      contentParts.push({ type: 'text', text: message.content });
    } else if (Array.isArray(message.content)) {
      contentParts.push(...message.content);
    }
    for (const imageUrl of images) {
      contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
    }

    const { images: _images, ...rest } = message;
    return {
      ...rest,
      content: contentParts
    };
  });
}

function openAIToolCallToOllama(toolCall: any, index: number) {
  const rawArguments = toolCall?.function?.arguments;
  let parsedArguments: any = {};
  if (typeof rawArguments === 'string' && rawArguments.trim()) {
    try {
      parsedArguments = JSON.parse(rawArguments);
    } catch {
      parsedArguments = { value: rawArguments };
    }
  } else if (rawArguments && typeof rawArguments === 'object') {
    parsedArguments = rawArguments;
  }

  return {
    id: typeof toolCall?.id === 'string' ? toolCall.id : undefined,
    function: {
      index,
      name: typeof toolCall?.function?.name === 'string' ? toolCall.function.name : '',
      arguments: parsedArguments
    }
  };
}

function openAIToolCallsToOllama(toolCalls: any) {
  return Array.isArray(toolCalls)
    ? toolCalls.map((toolCall, index) => openAIToolCallToOllama(toolCall, index))
    : [];
}

function applyOllamaRequestOptions(openAiReq: any, ollamaBody: any) {
  const options = ollamaBody?.options && typeof ollamaBody.options === 'object'
    ? ollamaBody.options
    : {};

  if (typeof options.temperature === 'number') openAiReq.temperature = options.temperature;
  if (typeof options.top_p === 'number') openAiReq.top_p = options.top_p;
  if (typeof options.seed === 'number') openAiReq.seed = options.seed;
  if (typeof options.num_predict === 'number' && options.num_predict > 0) {
    openAiReq.max_tokens = options.num_predict;
  }
  if (Array.isArray(options.stop) || typeof options.stop === 'string') {
    openAiReq.stop = options.stop;
  }
  if (ollamaBody?.format === 'json') {
    openAiReq.response_format = { type: 'json_object' };
  } else if (ollamaBody?.format && typeof ollamaBody.format === 'object') {
    openAiReq.response_format = { type: 'json_schema', json_schema: ollamaBody.format };
  }
  if (Array.isArray(ollamaBody?.tools)) {
    openAiReq.tools = ollamaBody.tools;
  }
  if (ollamaBody?.think !== undefined) {
    openAiReq.think = ollamaBody.think;
  }
}

// Transform stream: converts OpenAI SSE chunks to Ollama NDJSON
function createOllamaStreamTransform(model: string, isGenerate: boolean) {
  let buffer = '';

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep the last incomplete line

      for (const line of lines) {
        if (line.trim().startsWith('data: ')) {
          const dataStr = line.replace(/^data:\s*/, '').trim();
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0] || {};
            const delta = choice.delta || {};
            const content = delta.content || '';
            const toolCalls = openAIToolCallsToOllama(delta.tool_calls);
            const done = choice.finish_reason != null;

            if (!content && toolCalls.length === 0 && !done) continue;

            let ollamaChunk: any = {
              model: model,
              created_at: new Date().toISOString(),
              done: done
            };

            if (isGenerate) {
              ollamaChunk.response = content;
            } else {
              ollamaChunk.message = {
                role: 'assistant',
                content: content
              };
              if (toolCalls.length > 0) {
                ollamaChunk.message.tool_calls = toolCalls;
              }
            }

            if (done) {
              ollamaChunk.done_reason = choice.finish_reason || 'stop';
            }

            this.push(JSON.stringify(ollamaChunk) + '\n');
          } catch (e) {
            // Ignore incomplete or parse error JSON in stream
          }
        }
      }
      callback();
    },
    flush(callback) {
      if (buffer.trim().startsWith('data: ') && buffer.includes('[DONE]')) {
        // flush complete
      }
      callback();
    }
  });
}

function createOpenAIReasoningStripTransform() {
  let buffer = '';

  return new Transform({
    transform(chunk, encoding, callback) {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const match = line.match(/^(\s*data:\s*)(.*)$/);
        if (!match) {
          this.push(`${line}\n`);
          continue;
        }

        const [, prefix, payload] = match;
        const trimmedPayload = payload.trim();
        if (!trimmedPayload || trimmedPayload === '[DONE]') {
          this.push(`${line}\n`);
          continue;
        }

        try {
          const parsed = JSON.parse(trimmedPayload);
          this.push(`${prefix}${JSON.stringify(stripReasoningMetadata(parsed))}\n`);
        } catch {
          this.push(`${line}\n`);
        }
      }

      callback();
    },
    flush(callback) {
      if (buffer) {
        const match = buffer.match(/^(\s*data:\s*)(.*)$/);
        if (match) {
          const [, prefix, payload] = match;
          const trimmedPayload = payload.trim();
          if (trimmedPayload && trimmedPayload !== '[DONE]') {
            try {
              this.push(`${prefix}${JSON.stringify(stripReasoningMetadata(JSON.parse(trimmedPayload)))}`);
              callback();
              return;
            } catch {
              // Fall through and flush the original buffered text.
            }
          }
        }
        this.push(buffer);
      }
      callback();
    }
  });
}

function ollamaCloudRoutingAllowsPro(): boolean {
  return isRealOllamaComApiKey(String(keyStore.ollama || resolveOllamaApiKey() || ''));
}

/**
 * PROVIDER_ENDPOINTS.md generator (2026-09-04): every provider's concrete
 * endpoints (base URL, models, chat), auth type, key env var, key status,
 * and curated model count — regenerated at server boot, on provider add,
 * and on key save, so the repo always carries a current endpoint map.
 */
// ── Catalog health monitor (2026-09-04) ─────────────────────────────────────
// Masters' suggestions: watch for silent curated-count collapse, empty
// discovery cache, PQC load failure, missing bridge binaries, and upstream
// reachability of the first fallback target — warn loudly, persist state.



function binaryOnPath(binary: string): boolean {
  try {
    const result = execFileSync('which', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return Boolean(result.trim());
  } catch {
    return false;
  }
}

function catalogHealthSnapshot(): Record<string, unknown> {
  const curated = modelSourceConfig.curatedEndpointModelKeys.length;
  const cached = endpointModelsCache.length;
  const bridges: Record<string, boolean> = {
    copilot: binaryOnPath(process.env.LOCAL_ROUTER_COPILOT_BIN || 'copilot'),
    cursor: binaryOnPath(process.env.LOCAL_ROUTER_CURSOR_BIN || 'cursor-agent')
  };
  return {
    timestamp: new Date().toISOString(),
    curatedCount: curated,
    cacheCount: cached,
    pqcBundleLoaded,
    bridges,
    systemChain: (fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID]?.models || []).slice()
  };
}

function persistHealthState(snapshot: Record<string, unknown>): void {
  try {
    ensureLocalRouterConfigDir();
    fs.writeFileSync(HEALTH_STATE_PATH, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error: any) {
    console.error('[health] Failed to persist health state:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

async function probeFirstFallbackTargetReachability(): Promise<void> {
  const chain = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID]?.models || [];
  const first = chain.find((id) => !id.startsWith('cursor-') && id !== 'github-copilot-auto');
  if (!first) return;
  const target = resolveModelTarget(first);
  if (!target || !target.actualModel) return;
  const provider = getProviderSummary(target.providerName);
  if (!provider?.endpoint) return;
  try {
    const res = await safeFetch(`${provider.endpoint.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${keyStore[target.providerName] || providerEnvKeyValue(provider.keyEnvVar) || ''}` },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) console.warn(`[health] First fallback target upstream ${provider.endpoint} answered HTTP ${res.status}`);
  } catch (error: any) {
    console.warn(`[health] First fallback target upstream unreachable: ${sanitizeDiagnosticText(String(error?.message || error), 120)}`);
  }
}

function runCatalogHealthCheck(): void {
  const snapshot = catalogHealthSnapshot();
  persistHealthState(snapshot);
  if (snapshot.curatedCount === 0) {
    console.warn('[health] WARN: curated model count is 0 — served catalog has collapsed.');
  }
  if (snapshot.cacheCount === 0) {
    console.warn('[health] WARN: endpoint models cache is empty.');
  }
  if (!snapshot.pqcBundleLoaded) {
    console.warn('[health] WARN: PQC bundle not loaded this run — provider keys may be missing.');
  }
  const missing = Object.entries(snapshot.bridges as Record<string, boolean>).filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length > 0) {
    console.warn(`[health] WARN: auto bridge binaries not found on PATH: ${missing.join(', ')}`);
  }
}

function startCatalogHealthMonitor(): void {
  if (!shouldServe) return;
  runCatalogHealthCheck();
  const timer = setInterval(() => {
    runCatalogHealthCheck();
    void probeFirstFallbackTargetReachability();
  }, HEALTH_PROBE_INTERVAL_MS);
  timer.unref?.();
}

function writeProviderEndpointsDoc(): void {
  try {
    const outPath = path.resolve(__dirname, '..', 'PROVIDER_ENDPOINTS.md');
    const lines: string[] = [
      '# Provider Endpoints Registry',
      '',
      '> AUTO-GENERATED by the Local Router server — do not hand-edit.',
      '> Regenerated at server boot, on provider add, and on key save.',
      '',
      '| Provider | Auth | Base URL | Models Endpoint | Chat Endpoint | Key Env Var | Key Status | Curated Models | CLI Auto Bridge |',
      '|---|---|---|---|---|---|---|---|'
    ];
    const cliBridgeStatus = (slug: string): string => {
      if (slug === 'github-copilot') return binaryOnPath(process.env.LOCAL_ROUTER_COPILOT_BIN || 'copilot') ? 'yes (copilot CLI — `github-copilot-auto`)' : 'CLI not found';
      if (slug === 'cursor') return binaryOnPath(process.env.LOCAL_ROUTER_CURSOR_BIN || 'cursor-agent') ? 'yes (cursor-agent CLI — `cursor-auto`)' : 'CLI not found';
      return '—';
    };
    for (const summary of allProviderSummaries()) {
      const slug = canonicalProviderSlug(summary.name);
      if (!slug || isLocalRouterProviderName(slug)) continue;
      const oauth = isOAuthProviderName(slug);
      const state = oauth ? getOAuthStateSafe(slug) : undefined;
      const auth = oauth
        ? (state?.accessToken ? 'OAuth (signed in)' : 'OAuth (not signed in)')
        : (isCustomProvider(slug) ? 'API key (custom)' : 'API key');
      const keyStatus = oauth
        ? (state?.accessToken ? 'token active' : 'not signed in')
        : (providerHasConfiguredKey(slug) ? 'configured' : 'missing');
      const base = String(summary.endpoint || '').replace(/\/+$/, '') || 'internal';
      const modelsEp = base === 'internal' ? 'internal' : `${base}/models`;
      const chatEp = base === 'internal' ? 'internal' : `${base}/chat/completions`;
      const curatedCount = modelSourceConfig.curatedEndpointModelKeys
        .filter((k) => k.startsWith(`${slug}::`)).length;
      lines.push(`| ${slug} | ${auth} | ${base} | ${modelsEp} | ${chatEp} | ${summary.keyEnvVar || '—'} | ${keyStatus} | ${curatedCount} | ${cliBridgeStatus(slug)} |`);
    }
    lines.push('', `_Generated ${new Date().toISOString()}._`, '');
    fs.writeFileSync(outPath, lines.join('\n'), { encoding: 'utf8' });
  } catch (error: any) {
    console.error('Failed to write PROVIDER_ENDPOINTS.md:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function cursorCliAuthenticated(): boolean {
  try {
    const configPath = path.join(os.homedir(), '.cursor', 'cli-config.json');
    if (!fs.existsSync(configPath)) return false;
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return Boolean(parsed?.authInfo?.authId || parsed?.authInfo?.userId);
  } catch {
    return false;
  }
}

function providerHasConfiguredKey(providerName: string) {
  if (providerName === 'ollama') {
    return true;
  }
  // Cursor CLI carries its own auth (outside the router's OAuth store):
  // treat the provider as configured when the CLI is signed in (2026-09-04).
  if (providerName === 'cursor' && cursorCliAuthenticated()) {
    return true;
  }
  // Local loopback custom providers (llama-server/unsloth service shims)
  // have no auth — always considered configured.
  if (isLocalLoopbackProvider(providerName)) {
    return true;
  }
  // OAuth providers are considered "configured" when they have a stored
  // access token (regardless of whether it has expired — the proxy will
  // refresh on the next request).
  if (isOAuthProviderName(providerName)) {
    const oauthState = getOAuthStateSafe(providerName);
    if (oauthState?.accessToken) return true;
  }
  const summary = getProviderSummary(providerName);
  if (!summary) return false;
  return Boolean(keyStore[summary.name] || providerEnvKeyValue(summary.keyEnvVar));
}

function shouldCascadeDirectModelToSystemFallback(modelName: string): boolean {
  const target = resolveModelTarget(modelName);
  if (target?.providerName === 'kilo' || target?.providerName === 'cline') {
    return false;
  }
  return true;
}

function candidateAvailability(modelName: string) {
  const target = resolveModelTarget(modelName);
  const resolved = Boolean(findProviderModel(modelName));
  const providerName = target?.providerName || '';
  const keyConfigured = providerName ? providerHasConfiguredKey(providerName) : false;
  let status: 'ready' | 'no_key' | 'unavailable';
  if (!target || isLocalRouterProviderName(providerName)) {
    status = 'unavailable';
  } else if (!keyConfigured) {
    status = 'no_key';
  } else if (!resolved) {
    status = 'unavailable';
  } else {
    status = 'ready';
  }
  return {
    model: modelName,
    provider: providerName || null,
    resolved,
    keyConfigured,
    status
  };
}

function fallbackStagePreflight(modelName: string): AttemptFailure | null {
  const target = resolveModelTarget(modelName);
  if (!target || !target.actualModel || isLocalRouterProviderName(target.providerName)) {
    // Graceful cascade: an unresolvable stage is a soft skip, not a
    // chain-killer — wraparound moves to the next stage.
    return {
      errorType: 'unknown_model',
      message: `Unknown fallback model "${modelName}" — skipping to next stage.`
    };
  }

  const provider = getProviderSummary(target.providerName);
  if (!provider) {
    return {
      errorType: 'provider_not_found',
      providerName: target.providerName,
      actualModel: target.actualModel,
      message: `No provider for "${target.providerName}" — skipping to next stage.`
    };
  }

  if (!providerHasConfiguredKey(target.providerName)) {
    // Dead provider (no key/credits): skip with zero retries instead of
    // burning FALLBACK_PRIMARY_ATTEMPTS live upstream calls.
    return {
      errorType: 'provider_config',
      providerName: target.providerName,
      actualModel: target.actualModel,
      message: `Provider "${target.providerName}" is not configured (no key/credits) — skipping to next stage.`
    };
  }

  const catalogModel = findProviderModel(modelName);
  if (
    target.providerName === 'ollama'
    && isOllamaCloudPresentedIdBlocked(modelName, catalogModel?.model || target.actualModel, ollamaCloudRoutingAllowsPro())
  ) {
    return {
      errorType: 'provider_config',
      providerName: target.providerName,
      actualModel: target.actualModel,
      message: `Ollama Cloud model "${modelName}" is not on the free-tier routing allowlist (Pro-only or not curated) — skipping to next stage.`
    };
  }

  return null;
}

export function classifyHttpFailure(status: number, bodyText: string): AttemptFailure['errorType'] {
  if (status === 401 || status === 403) return 'upstream_http_auth';
  if (status === 402 || status === 429) return 'upstream_http_quota';
  if (status === 402) return 'upstream_http_payment_required';
  if (status === 413 || status === 429) return 'upstream_http_rate_limit';
  if (status >= 500 && status < 600) return 'upstream_http_unavailable';
  if (status === 400 || status === 422) return 'upstream_http_invalid_request';

  const lower = String(bodyText || '').toLowerCase();
  if (/invalid[_\s-]?api[_\s-]?key|unauthorized|auth|credentials|access[_\s-]?denied|token[_\s-]?invalid|expired[_\s-]?key/.test(lower)) return 'upstream_http_auth';
  if (/quota|limit|rate[_\s-]?limit|usage[_\s-]?limit|billing|balance|insufficient/.test(lower)) return 'upstream_http_quota';
  if (/payment|overdue|past[_\s-]?due|invoice|subscription[_\s-]?expired/.test(lower)) return 'upstream_http_payment_required';
  if (/unavailable|maintenance|downtime|temporarily[_\s-]?unavailable|service[_\s-]?unavailable/.test(lower)) return 'upstream_http_unavailable';
  if (/invalid[_\s-]?request|bad[_\s-]?request|validation/.test(lower)) return 'upstream_http_invalid_request';

  return 'upstream_http';
}

export function normalizeHttpFailure(error: AttemptFailure): AttemptFailure {
  if (error.errorType !== 'upstream_http') return error;
  const status = typeof error.status === 'number' ? error.status : 500;
  const classified = classifyHttpFailure(status, error.responseText || '');
  if (classified !== 'upstream_http') {
    return { ...error, errorType: classified };
  }
  return error;
}

export function isClassifiedFailoverError(errorType: string): boolean {
  return errorType === 'upstream_http_quota' || errorType === 'upstream_http_payment_required' || errorType === 'upstream_http_rate_limit' || errorType === 'upstream_http_unavailable' || errorType === 'upstream_http_invalid_request';
}

export type ContentClassification = 'generated' | 'streaming' | 'instant_error';

export function classifyResponseContent(
  responseBody: string,
  isStreamResponse: boolean,
  httpStatus: number
): ContentClassification {
  if (httpStatus >= 400) return 'instant_error';

  if (isStreamResponse) {
    const chunks = responseBody.split(/\n\n/).filter((c: string) => c.trim().length > 0);
    if (chunks.length > 1) return 'streaming';
    const single = String(responseBody || '').toLowerCase();
    if (/"error"/.test(single) || /quota|rate.limit|balance|insufficient|invalid.api.key|unauthorized|expired|billing/.test(single)) return 'instant_error';
    return 'streaming';
  }

  try {
    const parsed = JSON.parse(responseBody);
    if (parsed?.error) return 'instant_error';
    if (Array.isArray(parsed?.choices) && parsed.choices.length > 0) return 'generated';
  } catch {
    // not valid JSON — likely streaming SSE fragments
  }

  return 'generated';
}

export function isContentFailoverTrigger(classification: ContentClassification): boolean {
  return classification === 'instant_error';
}

function classifyStreamChunkAsError(chunk: string): boolean {
  if (!chunk) return false;
  try {
    const data = chunk.replace(/^data:\s*/, '').trim();
    if (data === '[DONE]') return false;
    const parsed = JSON.parse(data);
    if (parsed?.error) return true;
  } catch {
    // not JSON — likely content delta
  }
  return false;
}

export function buildFailoverPreservedBody(body: any, preservedModel: string): any {
  const messages = Array.isArray(body?.messages) ? [...body.messages] : [];
  const systemEvent = {
    event: 'local_router.failover',
    data: {
      from: body.model,
      to: preservedModel,
      timestamp: new Date().toISOString()
    }
  };
  const prepared = { ...body, model: preservedModel, messages: [...messages, { role: 'system', content: JSON.stringify(systemEvent) }] };
  return prepared;
}

export function extractMessageText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (part.type === 'text' && typeof part.text === 'string') return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export function stripCacheControl(body: any): any {
  if (!body) return body;
  const newBody = { ...body };
  if (Array.isArray(newBody.messages)) {
    newBody.messages = newBody.messages.map((msg: any) => {
      if (!msg) return msg;
      if (Array.isArray(msg.content)) {
        const cleanedContent = msg.content.map((part: any) => {
          if (part && typeof part === 'object') {
            const { cache_control, ...rest } = part;
            return rest;
          }
          return part;
        });
        if (cleanedContent.length === 1 && cleanedContent[0]?.type === 'text' && typeof cleanedContent[0]?.text === 'string') {
          return { ...msg, content: cleanedContent[0].text };
        }
        return { ...msg, content: cleanedContent };
      }
      return msg;
    });
  }
  if (Array.isArray(newBody.tools)) {
    newBody.tools = newBody.tools.map((tool: any) => {
      if (tool && typeof tool === 'object' && 'cache_control' in tool) {
        const { cache_control, ...rest } = tool;
        return rest;
      }
      return tool;
    });
  }
  return newBody;
}

export function getPromptCacheKey(messages: any[], existingKey?: string): string | undefined {
  if (existingKey && typeof existingKey === 'string' && existingKey.trim()) {
    return existingKey.trim();
  }
  if (!Array.isArray(messages) || messages.length === 0) return undefined;

  // Filter out any synthetic failover notifications
  const realMessages = messages.filter((m: any) => {
    if (!m || typeof m !== 'object') return false;
    const txt = extractMessageText(m.content);
    return !txt.includes('local_router.failover');
  });

  const firstSystemMsg = realMessages.find((m: any) => m?.role === 'system');
  const firstUserMsg = realMessages.find((m: any) => m?.role === 'user');

  const firstSystem = firstSystemMsg ? extractMessageText(firstSystemMsg.content) : '';
  const firstUser = firstUserMsg ? extractMessageText(firstUserMsg.content) : '';

  const contentToHash = firstSystem + '|' + firstUser;
  if (!contentToHash.trim()) return undefined;

  let hash = 0;
  for (let i = 0; i < contentToHash.length; i++) {
    const char = contentToHash.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return 'lr_' + Math.abs(hash).toString(16);
}

export function injectPromptCaching(body: any, providerName: string): any {
  let newBody = { ...body };

  // 1. Prevent any tool/IDE from disabling caching via body flags
  const cacheOverrideKeys = ['cache', 'use_cache', 'no_cache', 'bypass_cache'];
  for (const k of cacheOverrideKeys) {
    if (k in newBody) {
      delete newBody[k];
    }
  }

  // 2. Strip provider.order to preserve sticky routing on OpenRouter
  if (providerName === 'openrouter' || providerName === 'openrouter-presets') {
    if (newBody.provider && typeof newBody.provider === 'object') {
      if ('order' in newBody.provider) {
        const cleanedProvider = { ...newBody.provider };
        delete cleanedProvider.order;
        if (Object.keys(cleanedProvider).length === 0) {
          delete newBody.provider;
        } else {
          newBody.provider = cleanedProvider;
        }
      }
    }
  }

  const cacheKey = getPromptCacheKey(
    newBody.messages,
    newBody.prompt_cache_key || newBody.session_id
  );

  const modelLower = String(newBody.model || '').toLowerCase();
  const isOpenAiFamily = modelLower.startsWith('gpt-') || 
                         modelLower.startsWith('o1-') || 
                         modelLower.startsWith('o3-') || 
                         modelLower.includes('chatgpt') ||
                         modelLower.includes('gpt-4') ||
                         modelLower.includes('gpt-5');

  // Preserve thinking tokens in context for Z.ai GLM models
  if (providerName === 'zai' || modelLower.includes('glm')) {
    newBody.clear_thinking = false;
  }

  // Ollama: set default keep_alive to '24h' if omitted so in-memory KV cache stays resident
  if (providerName === 'ollama' && newBody.keep_alive === undefined) {
    newBody.keep_alive = '24h';
  }

  // OpenAI-family models: clean cache_control from messages and tools, set 24h retention and prompt_cache_key
  if (isOpenAiFamily) {
    const cleanedBody = stripCacheControl(newBody);
    cleanedBody.prompt_cache_retention = '24h';
    if (cacheKey) {
      cleanedBody.prompt_cache_key = cacheKey;
    }
    return cleanedBody;
  }

  const supportsExplicitCacheControl = [
    'zenmux',
    'opencode-go',
    'opencode-zen',
    'xiaomi-mimo',
    'wafer-serverless',
    'openrouter',
    'openrouter-presets',
    'pioneer',
    'nous-portal',
    'cline',
    'kilo'
  ].includes(providerName);

  // Providers not supporting Anthropic explicit cache_control markers:
  // strip cache_control from messages & tools so upstream schema validation does not reject them.
  if (!supportsExplicitCacheControl) {
    newBody = stripCacheControl(newBody);

    if (cacheKey) {
      if (
        providerName === 'nebius' ||
        providerName === 'moonshot' ||
        providerName === 'modal-proxy' ||
        providerName === 'modal' ||
        providerName === 'nvidia-nim' ||
        providerName === 'zai' ||
        modelLower.includes('kimi') ||
        modelLower.includes('moonshot')
      ) {
        newBody.prompt_cache_key = cacheKey;
      }
    }
    return newBody;
  }

  // Explicit caching providers:
  const cacheControlValue = { type: 'ephemeral', ttl: '1h' };

  // 1. Tool Caching: cache tool schemas on the last tool definition
  if (Array.isArray(newBody.tools) && newBody.tools.length > 0) {
    const tools = newBody.tools.map((t: any, idx: number) => {
      if (idx === newBody.tools.length - 1) {
        return { ...t, cache_control: cacheControlValue };
      }
      return t;
    });
    newBody.tools = tools;
  }

  // 2. Message Caching: system prompt + preceding conversation turn
  if (Array.isArray(newBody.messages) && newBody.messages.length > 0) {
    const newMessages = [...newBody.messages];

    // System prompt breakpoint
    const systemIdx = newMessages.findIndex((m: any) => m && m.role === 'system');
    if (systemIdx !== -1 && newMessages[systemIdx]) {
      const msg = { ...newMessages[systemIdx] };
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControlValue }];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastPartIdx = msg.content.length - 1;
        msg.content = msg.content.map((part: any, idx: number) => 
          idx === lastPartIdx ? { ...part, cache_control: cacheControlValue } : part
        );
      }
      newMessages[systemIdx] = msg;
    }

    // Find the last real user message index (ignoring synthetic failovers)
    let lastUserIdx = -1;
    for (let i = newMessages.length - 1; i >= 0; i--) {
      const m = newMessages[i];
      if (m && m.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }

    // Multi-turn breakpoint: mark the message preceding the latest user turn
    const targetIdx = lastUserIdx > 0 ? lastUserIdx - 1 : newMessages.length - 2;
    if (targetIdx > 0 && newMessages[targetIdx] && targetIdx !== systemIdx) {
      const msg = { ...newMessages[targetIdx] };
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControlValue }];
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastPartIdx = msg.content.length - 1;
        msg.content = msg.content.map((part: any, idx: number) => 
          idx === lastPartIdx ? { ...part, cache_control: cacheControlValue } : part
        );
      }
      newMessages[targetIdx] = msg;
    }

    newBody.messages = newMessages;
  }

  // OpenRouter sticky routing: session_id and prompt_cache_key for all models
  if (providerName === 'openrouter' || providerName === 'openrouter-presets') {
    if (cacheKey) {
      newBody.session_id = cacheKey;
      newBody.prompt_cache_key = cacheKey;
    }
  } else if (cacheKey) {
    newBody.prompt_cache_key = cacheKey;
  }

  return newBody;
}

const execFileAsync = promisify(execFileCallback);

// ── GitHub Copilot auto bridge ──────────────────────────────────────────────

const COPILOT_BRIDGE_TIMEOUT_MS = 180_000;

/** Flatten an OpenAI chat request to the plain-text prompt the CLI expects. */
function copilotAutoPromptFromBody(body: any): string {
  const parts: string[] = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    if (message.role === 'system') parts.push(`[system]\n${content}`);
    else if (message.role === 'user') parts.push(content);
    else if (message.role === 'assistant') parts.push(`[assistant]\n${content}`);
  }
  return parts.join('\n\n') || 'Say OK';
}

/** Strip the CLI's trailing stat lines (Changes / AI Credits / Tokens / Resume). */
function stripCopilotCliStats(stdout: string): string {
  const statMarkers = /^(Changes|AI Credits|Tokens|Resume|Error:)\s/i;
  const lines = stdout.replace(/\r/g, '').split('\n');
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === '') continue;
    if (statMarkers.test(lines[i])) end = i;
    else break;
  }
  return lines.slice(0, end).join('\n').trim();
}

async function runCopilotAutoBridge(
  body: any,
  targetModelName: string,
  stream: boolean,
  requestStartedAt: number
): Promise<AttemptResult> {
  const prompt = copilotAutoPromptFromBody(body);
  const args = ['-p', prompt, '--model', 'auto'];
  try {
    const { stdout } = await execFileAsync(
      process.env.LOCAL_ROUTER_COPILOT_BIN || 'copilot',
      args,
      { timeout: COPILOT_BRIDGE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, shell: false, env: { ...process.env, NO_COLOR: '1' } }
    );
    const content = stripCopilotCliStats(stdout);
    if (!content) {
      return {
        ok: false,
        error: { errorType: 'upstream_http', status: 502, message: 'Copilot CLI auto bridge returned an empty response.' }
      };
    }
    const completionId = `copilot-auto-${Date.now()}`;
    const payload = {
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'auto',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: Math.ceil(prompt.length / 4),
        completion_tokens: Math.ceil(content.length / 4),
        total_tokens: Math.ceil((prompt.length + content.length) / 4)
      }
    };
    const responseBody = stream
      ? `data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', model: 'auto', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', model: 'auto', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
      : JSON.stringify(payload);
    const response = new Response(responseBody, {
      status: 200,
      headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' }
    });
    console.log(`[copilot-auto] bridge served ${content.length} chars in ${Date.now() - requestStartedAt}ms`);
    return {
      ok: true,
      value: { providerName: 'github-copilot', actualModel: 'auto', requestBody: body, response }
    };
  } catch (error: any) {
    const message = error?.killed
      ? `Copilot CLI auto bridge timed out after ${COPILOT_BRIDGE_TIMEOUT_MS / 1000}s.`
      : `Copilot CLI auto bridge failed: ${String(error?.message || error).slice(0, 200)}`;
    console.warn(`[copilot-auto] ${sanitizeDiagnosticText(message)}`);
    return {
      ok: false,
      error: { errorType: 'upstream_http', status: 502, providerName: 'github-copilot', actualModel: 'auto', message }
    };
  }
}

async function proxyModelAttempt(
  body: any,
  requestRoute: string,
  outputFormat: CompletionOutputFormat,
  presentedModelName: string,
  targetModelName: string,
  stream: boolean,
  requestStartedAt: number,
  fallbackData?: Record<string, unknown>
): Promise<AttemptResult> {
  const target = resolveModelTarget(targetModelName);
  if (!target || !target.actualModel) {
    const exampleModel = presentedModelList()[0]?.id || 'groq/llama3-8b-8192';
    return {
      ok: false,
      error: {
        errorType: 'unknown_model',
        message: `Unknown model "${targetModelName}". Configure it at /config or use a known model such as "${exampleModel}".`
      }
    };
  }

  if (target.providerName === FALLBACK_PROVIDER_NAME) {
    return {
      ok: false,
      error: {
        errorType: 'unknown_model',
        message: `Fallback model "${targetModelName}" cannot be nested inside another fallback route.`
      }
    };
  }

  // GitHub Copilot auto bridge (2026-09-04): the `auto` model only resolves
  // inside first-party Copilot clients — the API rejects it outright
  // (400 model_not_supported). Run the logged-in Copilot CLI headlessly
  // (`copilot -p <prompt> --model auto`) and wrap stdout as an
  // OpenAI-shaped response.
  if (target.providerName === 'github-copilot' && target.actualModel === 'auto') {
    return await runCopilotAutoBridge(body, targetModelName, stream, requestStartedAt);
  }

  // CLI auto bridges (2026-09-04): Copilot and Cursor resolve `auto`
  // client-side — their APIs reject the literal id.
  if (target.actualModel === 'auto' && (target.providerName === 'github-copilot' || target.providerName === 'cursor')) {
    const label = target.providerName === 'github-copilot' ? 'copilot' : 'cursor';
    const bridge = await runCliAuto(label, body);
    if (bridge.ok) {
      const completionId = `cli-auto-${Date.now()}`;
      const payload = {
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'auto',
        choices: [{ index: 0, message: { role: 'assistant', content: bridge.content }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: Math.max(1, Math.ceil((bridge.content || '').length / 4)),
          completion_tokens: Math.max(1, Math.ceil((bridge.content || '').length / 4)),
          total_tokens: Math.ceil(((body && JSON.stringify(body).length) || 0) / 4) + Math.ceil((bridge.content || '').length / 4)
        }
      };
      const responseBody = stream
        ? `data: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', model: 'auto', choices: [{ index: 0, delta: { role: 'assistant', content: bridge.content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: completionId, object: 'chat.completion.chunk', model: 'auto', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
        : JSON.stringify(payload);
      const response = new Response(responseBody, {
        status: 200,
        headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' }
      });
      console.log(`[cli-auto] ${label} bridge served ${bridge.elapsedMs}ms`);
      return {
        ok: true,
        value: { providerName: target.providerName, actualModel: 'auto', requestBody: body, response }
      };
    }
    console.warn(`[cli-auto] ${label} bridge failed: ${bridge.errorMessage || 'unknown'}`);
    return {
      ok: false,
      error: {
        errorType: 'upstream_http',
        status: bridge.errorStatus || 502,
        providerName: target.providerName,
        actualModel: 'auto',
        message: bridge.errorMessage || 'CLI auto bridge failed.'
      }
    };
  }

  const provider = await loadProvider(target.providerName);
  if (!provider || !provider.baseUrl) {
    return {
      ok: false,
      error: {
        errorType: 'provider_not_found',
        providerName: target.providerName,
        actualModel: target.actualModel,
        message: `No provider for "${target.providerName}" — skipping to next stage.`
      }
    };
  }

  let providerHeaders: Record<string, string>;
  try {
    // Pass the request messages to getHeadersAsync so per-request dynamic
    // headers (e.g. Copilot's X-Initiator) can inspect the conversation
    // (oh-my-pi pattern).
    providerHeaders = provider.getHeadersAsync
      ? await provider.getHeadersAsync({ messages: body?.messages })
      : provider.getHeaders();
  } catch (error: any) {
    return {
      ok: false,
      error: {
        errorType: 'provider_config',
        providerName: target.providerName,
        actualModel: target.actualModel,
        message: sanitizeDiagnosticText(String(error?.message || 'Provider key is missing.'))
      }
    };
  }

  // Inject Wafer AI ZDR header for eligible models
  const ZDR_ELIGIBLE_MODELS = new Set([
    'GLM-5.1',
    'Kimi-K2.6',
    'deepseek-v4-pro',
    'DeepSeek-V4.1-Flash',
    'deepseek-v4.1-flash',
    'GLM-5.2',
    'GLM-5.3',
    'GLM-5.3-Flash',
    'Kimi-K3',
    'DeepSeek-V4-Flash-0731-Fast'
  ]);
  if (target.providerName === 'wafer-serverless' && waferZdrEnabled && ZDR_ELIGIBLE_MODELS.has(target.actualModel)) {
    providerHeaders['Wafer-ZDR'] = 'required';
  }
  if (target.providerName === 'openrouter' || target.providerName === 'openrouter-presets') {
    providerHeaders['X-OpenRouter-Cache'] = 'true';
    const cacheKey = getPromptCacheKey(body?.messages, body?.prompt_cache_key || body?.session_id);
    if (cacheKey) {
      providerHeaders['X-Session-Id'] = cacheKey;
    }
  }
  if (target.providerName === 'modal-proxy') {
    if (!providerHeaders['Modal-Session-ID']) {
      const cacheKey = getPromptCacheKey(body?.messages, body?.prompt_cache_key || body?.session_id);
      if (cacheKey) {
        providerHeaders['Modal-Session-ID'] = cacheKey;
      }
    }
  }

  const requestBody = {
    ...body,
    model: target.actualModel
  };
  // Operator contract (2026-09-04): the proxy never sets a thinking default.
  // Each call configures its own thinking/effort; sanitize is pure passthrough
  // (Ollama `think` normalized to the portable `enable_thinking`).
  const safeRequestBody = sanitizeProviderRequestBody(requestBody, {
    providerName: target.providerName,
    modelName: target.actualModel
  });
  const compressedRequestBody = await compressWithHeadroom(safeRequestBody, target.actualModel);
  const cachedRequestBody = injectPromptCaching(compressedRequestBody, target.providerName);
  const finalBody = provider.formatBody ? provider.formatBody(cachedRequestBody) : cachedRequestBody;

  const attemptStartedAt = Date.now();
  try {
    const chatUrl = `${provider.baseUrl}/chat/completions`;
    const chatFetchInit: RequestInit = {
      method: 'POST',
      headers: providerHeaders,
      body: JSON.stringify(finalBody),
      signal: AbortSignal.timeout(stream ? 15000 : 30000)
    };
    // SSRF guard: custom providers have user-controlled endpoints.
    const response = isCustomProvider(target.providerName)
      ? await safeFetch(chatUrl, chatFetchInit)
      : await fetch(chatUrl, chatFetchInit);

    if (!response.ok) {
      const responseText = await response.text();
      const rawError: AttemptFailure = {
        errorType: 'upstream_http',
        providerName: target.providerName,
        actualModel: target.actualModel,
        status: response.status,
        message: `Provider error (${response.status})`,
        responseText
      };
      return { ok: false, error: normalizeHttpFailure(rawError) };
    }

    // Classify 200 responses that contain error payloads (some providers return 200 with error JSON)
    const contentType = response.headers.get('content-type') || '';
    const isJsonResponse = contentType.includes('application/json');
    const isStreamRequest = Boolean(stream);

    if (!isStreamRequest && isJsonResponse) {
      const responseClone = response.clone();
      try {
        const responseBodyText = await responseClone.text();
        const contentClass = classifyResponseContent(responseBodyText, false, response.status);
        if (isContentFailoverTrigger(contentClass)) {
          const bodyError: AttemptFailure = {
            errorType: 'upstream_http',
            providerName: target.providerName,
            actualModel: target.actualModel,
            status: response.status,
            message: `Provider returned error in 200 response body`,
            responseText: responseBodyText
          };
          return { ok: false, error: normalizeHttpFailure(bodyError) };
        }
      } catch {
        // classification failed — proceed with original response
      }
    }

    return {
      ok: true,
      value: {
        providerName: target.providerName,
        actualModel: target.actualModel,
        requestBody: finalBody,
        response
      }
    };
  } catch (error: any) {
    return {
      ok: false,
      error: {
        errorType: 'proxy_runtime',
        providerName: target.providerName,
        actualModel: target.actualModel,
        message: sanitizeDiagnosticText(String(error?.message || 'Proxy runtime failure'))
      }
    };
  }
}

async function sendSuccessfulProxyResponse(
  res: Response,
  model: string,
  stream: boolean,
  requestRoute: string,
  requestStartedAt: number,
  outputFormat: CompletionOutputFormat,
  success: AttemptSuccess,
  logTracker?: LogEntryTracker
) {
  const fetchResponse = success.response;

  if (stream) {
    if (outputFormat.startsWith('ollama')) {
      res.setHeader('Content-Type', 'application/x-ndjson');
    } else {
      res.setHeader('Content-Type', 'text/event-stream');
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    if (fetchResponse.body) {
      // @ts-ignore
      const nodeStream = Readable.fromWeb(fetchResponse.body);
      nodeStream.on('error', (err: unknown) => {
        console.error('[proxy] nodeStream error:', err instanceof Error ? err.message : String(err));
      });

      const spyStream = logTracker ? createUsageSpyStream((data) => logTracker.onUsage(data)) : null;
      if (spyStream) {
        spyStream.on('error', (err: unknown) => {
          console.error('[proxy] spyStream error:', err instanceof Error ? err.message : String(err));
        });
      }

      if (outputFormat.startsWith('ollama')) {
        const isGenerate = outputFormat === 'ollama_generate';
        const transform = createOllamaStreamTransform(model, isGenerate);
        transform.on('error', (err: unknown) => {
          console.error('[proxy] transform stream error:', err instanceof Error ? err.message : String(err));
        });
        if (spyStream) {
          nodeStream.pipe(transform).pipe(spyStream).pipe(res);
        } else {
          nodeStream.pipe(transform).pipe(res);
        }
      } else {
        const stripTransform = createOpenAIReasoningStripTransform();
        stripTransform.on('error', (err: unknown) => {
          console.error('[proxy] stripTransform stream error:', err instanceof Error ? err.message : String(err));
        });
        if (spyStream) {
          nodeStream.pipe(stripTransform).pipe(spyStream).pipe(res);
        } else {
          nodeStream.pipe(stripTransform).pipe(res);
        }
      }

      res.on('finish', () => {
        if (logTracker) {
          logTracker.onFinish(Date.now() - requestStartedAt);
        }
      });
    } else {
      if (logTracker) {
        logTracker.onFinish(Date.now() - requestStartedAt);
      }
      res.end();
    }
    return;
  }

  let upstreamData: any;
  try {
    upstreamData = await fetchResponse.json();
  } catch (parseError: any) {
    const errMsg = `Failed to parse upstream response body from ${success.providerName}: ${parseError?.message || parseError}`;
    console.error(`[sendSuccessfulProxyResponse] ${errMsg}`);
    if (logTracker) {
      logTracker.onFailure(502, 'upstream_parse_error', errMsg);
      logTracker.onFinish(Date.now() - requestStartedAt);
    }
    if (!res.headersSent) {
      if (outputFormat.startsWith('ollama')) {
        return res.status(502).json({ error: errMsg });
      }
      return res.status(502).json({
        error: {
          message: errMsg,
          type: 'upstream_error',
          code: 502
        }
      });
    }
    return;
  }
  const normalizedUpstream = normalizeGatewayChatCompletionBody(success.providerName, upstreamData);
  const data = stripReasoningMetadata(normalizedUpstream) as Record<string, unknown>;

  if (logTracker) {
    logTracker.onUsage(data);
    logTracker.onFinish(Date.now() - requestStartedAt);
  }

  if (outputFormat.startsWith('ollama')) {
    const choices = data.choices as Record<string, unknown>[] | undefined;
    const message = (choices?.[0]?.message as Record<string, unknown> | undefined) || {};
    const content = String(message.content || '');
    const toolCalls = openAIToolCallsToOllama(message.tool_calls);
    if (outputFormat === 'ollama_generate') {
      res.json({ model, created_at: new Date().toISOString(), response: content, done: true, done_reason: 'stop' });
    } else {
      const responseMessage: Record<string, unknown> = { role: 'assistant', content };
      if (toolCalls.length > 0) responseMessage.tool_calls = toolCalls;
      res.json({ model, created_at: new Date().toISOString(), message: responseMessage, done: true, done_reason: 'stop' });
    }
  } else {
    res.json(data);
  }
}

export function isFallbackStageEnabled(fallbackRoute: FallbackModel, modelName: string): boolean {
  if (!fallbackRoute.disabledModels || fallbackRoute.disabledModels.length === 0) return true;
  return !fallbackRoute.disabledModels.includes(modelName);
}

export function activeFallbackModels(fallbackRoute: FallbackModel): string[] {
  const disabled = new Set(fallbackRoute.disabledModels || []);
  return fallbackRoute.models.filter((model) => {
    if (disabled.has(model)) return false;
    const target = resolveModelTarget(model);
    // Key-presence filtering applies to resolvable catalog providers only.
    // Unknown/unresolvable entries stay in the plan so execution-shaped logic
    // (wraparound, disabled stages) holds for direct/arbitrary model ids;
    // they fail-and-cascade at execution time instead of vanishing here.
    if (!target) return true;
    if (!getProviderSummary(target.providerName)) return true;
    return providerHasConfiguredKey(target.providerName);
  });
}

export function fallbackExecutionPlan(fallbackRoute: FallbackModel, body?: any) {
  const active = activeFallbackModels(fallbackRoute);
  const eligible = (() => {
    if (!body) return active;
    return filterEligibleFallbackModels(active, body, (modelId) => {
      const m = findCatalogModel(modelId) || findProviderModel(modelId);
      return {
        contextLength: m?.contextLength || DEFAULT_CONTEXT_LENGTH,
        outputTokens: m?.outputTokens || DEFAULT_OUTPUT_TOKENS,
        supportsImages: Boolean(m?.supportsImages),
        supportsTools: m?.supportsTools ?? true,
        supportsCache: Boolean(m?.supportsCache),
        supportsReasoning: Boolean(m?.supportsReasoning)
      };
    }).eligible;
  })();
  // Escalating wraparound (2026-09-04): failure → next model; after two
  // fallback failures retry the top of the list (usage-reset), then escalate
  // the per-cycle failure threshold (3, 4, …) until the list is exhausted.
  return buildEscalatingWraparoundPlan(eligible);
}

async function handleChatCompletion(req: Request, res: Response, bodyOverrides?: any, options?: { outputFormat?: CompletionOutputFormat }) {
  const outputFormat = options?.outputFormat || 'openai';
  const requestStartedAt = Date.now();
  try {
    const body = bodyOverrides || req.body;
    const { model, stream } = body;
    const requestRoute = req.path || '/v1/chat/completions';

    if (!model) {
      return res.status(400).json({ error: 'Model is required in request body.' });
    }
    // Inject custom system prompt when enabled
    if (systemPromptConfig.enabled && systemPromptConfig.prompt && Array.isArray(body.messages)) {
      body.messages.unshift({ role: 'system', content: systemPromptConfig.prompt });
    }
    const rawClient = req.headers['x-local-router-client'];
    const clientName = typeof rawClient === 'string' ? rawClient : Array.isArray(rawClient) ? rawClient[0] : 'unknown';
    const fallbackRoute = findFallbackModel(model);
    const logTracker = new LogEntryTracker(
      clientName,
      String(model),
      fallbackRoute ? 'fallback' : 'direct'
    );
    logTracker.setRequestDetails(body);

    if (fallbackRoute) {
      return executeFallbackRoute(fallbackRoute, body, model, stream, requestRoute, outputFormat, requestStartedAt, res, logTracker);
    }

    // Direct model — try it, then cascade to system fallback on failure
    const directModelResult = await proxyModelAttempt(
      body,
      requestRoute,
      outputFormat,
      model,
      model,
      Boolean(stream),
      requestStartedAt
    );

    if (directModelResult.ok) {
      logTracker.onSuccess(directModelResult.value.providerName, directModelResult.value.actualModel, directModelResult.value.response.status);
      return sendSuccessfulProxyResponse(
        res,
        model,
        Boolean(stream),
        requestRoute,
        requestStartedAt,
        outputFormat,
        directModelResult.value,
        logTracker
      );
    }

    const sysFallback = findSystemFallback();

    if (sysFallback && shouldCascadeDirectModelToSystemFallback(model)) {
      const cascadeDetail = `${directModelResult.error.errorType} (status ${directModelResult.error.status || 500})`;
      console.warn(
        `[proxy] Direct model "${model}" failed on provider "${directModelResult.error.providerName}" — ` +
        `${cascadeDetail} — cascading to system fallback "${sysFallback.id}".`
      );
      return executeFallbackRoute(sysFallback, body, model, stream, requestRoute, outputFormat, requestStartedAt, res, logTracker);
    }
    if (directModelResult.error.errorType === 'upstream_http') {
      const errorBody = directModelResult.error.responseText || directModelResult.error.message;
      const errStatus = directModelResult.error.status || 502;
      logTracker.onFailure(errStatus, directModelResult.error.errorType, directModelResult.error.message);
      logTracker.onFinish(Date.now() - requestStartedAt);
      return res.status(errStatus).send(errorBody);
    }

    const directStatus = directModelResult.error.errorType === 'unknown_model'
      ? 400
      : directModelResult.error.errorType === 'provider_not_found'
        ? 400
        : directModelResult.error.errorType === 'provider_config'
          ? 400
          : 500;

    logTracker.onFailure(directStatus, directModelResult.error.errorType, directModelResult.error.message);
    logTracker.onFinish(Date.now() - requestStartedAt);

    return res.status(directStatus).json({
      error: directModelResult.error.message,
      provider: directModelResult.error.providerName,
      model: directModelResult.error.actualModel
    });
  } catch (err: any) {
    console.error('[handleChatCompletion] Unhandled error:', err?.stack || err?.message || err);
    if (!res.headersSent) {
      if (outputFormat.startsWith('ollama')) {
        return res.status(500).json({ error: err?.message || 'Internal error processing completion' });
      }
      return res.status(500).json({
        error: {
          message: err?.message || 'Internal error processing completion',
          type: 'internal_error'
        }
      });
    }
  }
}

async function executeFallbackRoute(
  fallbackRoute: FallbackModel,
  body: any,
  presentedModel: string,
  stream: boolean,
  requestRoute: string,
  outputFormat: CompletionOutputFormat,
  requestStartedAt: number,
  res: Response,
  logTracker?: LogEntryTracker
) {
  const activeModels = activeFallbackModels(fallbackRoute);
  const filterResult = filterEligibleFallbackModels(activeModels, body, (modelId) => {
    const m = findCatalogModel(modelId) || findProviderModel(modelId);
    return {
      contextLength: m?.contextLength || DEFAULT_CONTEXT_LENGTH,
      outputTokens: m?.outputTokens || DEFAULT_OUTPUT_TOKENS,
      supportsImages: Boolean(m?.supportsImages),
      supportsTools: m?.supportsTools ?? true,
      supportsCache: Boolean(m?.supportsCache),
      supportsReasoning: Boolean(m?.supportsReasoning)
    };
  });

  const attemptLog: Array<Record<string, unknown>> = [];

  // Record skipped models in the attempt log so clients have full observability
  for (const s of filterResult.skipped) {
    attemptLog.push({
      fallbackRoute: fallbackRoute.id,
      targetModel: s.model,
      skipped: true,
      reason: s.reason,
      contextLength: s.contextLength,
      supportsImages: s.supportsImages,
      requiredContext: filterResult.requiredContext,
      requiresMultimodal: filterResult.requiresMultimodal
    });
  }

  if (filterResult.error === 'no_multimodal_models') {
    const status = 400;
    const errorMsg = `Fallback model "${fallbackRoute.id}" has no multimodal-capable targets to process request containing image inputs.`;
    if (logTracker) {
      logTracker.onFailure(status, 'unsupported_multimodal', errorMsg);
      logTracker.onFinish(Date.now() - requestStartedAt);
    }
    return res.status(status).json({
      error: errorMsg,
      provider: 'local-router',
      fallback: {
        id: fallbackRoute.id,
        requiredContext: filterResult.requiredContext,
        requiresMultimodal: true,
        configuredTargets: fallbackRoute.models,
        attempts: attemptLog
      }
    });
  }

  const eligible = filterResult.eligible;
  if (eligible.length === 0) {
    const status = 502;
    const errorMsg = `Fallback model "${fallbackRoute.id}" has no active or eligible targets (requiredContext: ${filterResult.requiredContext}).`;
    if (logTracker) {
      logTracker.onFailure(status, 'fallback_exhaustion', errorMsg);
      logTracker.onFinish(Date.now() - requestStartedAt);
    }
    return res.status(status).json({
      error: errorMsg,
      provider: 'local-router',
      fallback: {
        id: fallbackRoute.id,
        requiredContext: filterResult.requiredContext,
        requiresMultimodal: filterResult.requiresMultimodal,
        configuredTargets: fallbackRoute.models,
        attempts: attemptLog
      }
    });
  }

  const plan = fallbackExecutionPlan(fallbackRoute, body);
  let lastFailure: AttemptFailure | null = null;

  for (let stageIndex = 0; stageIndex < plan.length; stageIndex += 1) {
    const stage = plan[stageIndex];

    const preflightFailure = fallbackStagePreflight(stage.model);
    if (preflightFailure) {
      lastFailure = preflightFailure;
      attemptLog.push({
        fallbackRoute: fallbackRoute.id,
        stage: stage.stage,
        targetModel: stage.model,
        attempt: 0,
        stageAttempts: stage.attempts,
        provider: preflightFailure.providerName || null,
        actualModel: preflightFailure.actualModel || null,
        status: preflightFailure.status || null,
        errorType: preflightFailure.errorType,
        errorMessage: sanitizeDiagnosticText(preflightFailure.message, 220),
        skipped: true
      });
      continue;
    }

    const preservedBody = stage.primary
      ? { ...body, model: stage.model }
      : buildFailoverPreservedBody(body, stage.model);

    for (let attempt = 1; attempt <= stage.attempts; attempt += 1) {
      const fallbackData = {
        route: fallbackRoute.id,
        stage: stage.stage,
        stageIndex: stageIndex + 1,
        stageAttempts: stage.attempts,
        attempt,
        targetModel: stage.model,
        totalStages: plan.length,
        primaryStage: stage.primary,
        failoverErrorType: isClassifiedFailoverError(lastFailure?.errorType || '') ? (lastFailure as AttemptFailure).errorType : undefined
      };

      const result = await proxyModelAttempt(
        preservedBody,
        requestRoute,
        outputFormat,
        presentedModel,
        stage.model,
        Boolean(stream),
        requestStartedAt,
        fallbackData
      );

      if (result.ok) {
        if (logTracker) {
          logTracker.onSuccess(result.value.providerName, result.value.actualModel, result.value.response.status);
        }
        return sendSuccessfulProxyResponse(
          res,
          presentedModel,
          Boolean(stream),
          requestRoute,
          requestStartedAt,
          outputFormat,
          result.value,
          logTracker
        );
      }

      lastFailure = result.error;
      const entry: Record<string, unknown> = {
        fallbackRoute: fallbackRoute.id,
        stage: stage.stage,
        targetModel: stage.model,
        attempt,
        stageAttempts: stage.attempts,
        provider: result.error.providerName || null,
        actualModel: result.error.actualModel || null,
        status: result.error.status || null,
        errorType: result.error.errorType,
        errorMessage: sanitizeDiagnosticText(result.error.message, 220),
        providerErrorPreview: sanitizeDiagnosticText(result.error.responseText || '', 280)
      };

      if (attempt < stage.attempts || stageIndex < plan.length - 1) {
        const waitSeconds = attempt < stage.attempts ? fallbackRetryDelaySeconds(attempt) : 0;
        entry.waitBeforeRetrySeconds = waitSeconds;
        attemptLog.push(entry);
        if (waitSeconds > 0) {
          await waitMs(waitSeconds * 1000);
        }
      } else {
        attemptLog.push(entry);
      }
    }
  }

  const terminalFailure = lastFailure as AttemptFailure | null;
  const status = terminalFailure?.status || 502;
  const terminalMessage = `Fallback model "${fallbackRoute.id}" exhausted all ${eligible.length} eligible targets across ${DEFAULT_FALLBACK_ROUNDS} retry passes.`;

  if (logTracker) {
    logTracker.onFailure(
      status,
      terminalFailure?.errorType || 'fallback_exhaustion',
      terminalFailure?.message || terminalMessage
    );
    logTracker.onFinish(Date.now() - requestStartedAt);
  }

  return res.status(status).json({
    error: terminalMessage,
    provider: 'local-router',
    fallback: {
      id: fallbackRoute.id,
      configuredTargets: fallbackRoute.models,
      eligibleTargets: eligible,
      requiredContext: filterResult.requiredContext,
      requiresMultimodal: filterResult.requiresMultimodal,
      passesCompleted: DEFAULT_FALLBACK_ROUNDS,
      terminalErrorType: terminalFailure?.errorType || null,
      terminalErrorMessage: terminalFailure?.message || null,
      attempts: attemptLog
    }
  });
}

app.post(['/v1/chat/completions', '/chat/completions'], async (req: Request, res: Response) => {
  await handleChatCompletion(req, res);
});

function chatCompletionToAnthropicResponse(chatData: any, requestedModel?: string): any {
  const choice = chatData?.choices?.[0] || {};
  const message = choice.message || {};
  const content: any[] = [];

  if (message.content) {
    content.push({
      type: 'text',
      text: message.content
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      if (tc.function) {
        let inputObj = {};
        try {
          inputObj = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {
          inputObj = { raw: tc.function.arguments };
        }
        content.push({
          type: 'tool_use',
          id: tc.id || `toolu_${cryptoRandomId()}`,
          name: tc.function.name,
          input: inputObj
        });
      }
    }
  }

  let stopReason = 'end_turn';
  if (choice.finish_reason === 'length') stopReason = 'max_tokens';
  else if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
  else if (choice.finish_reason === 'stop') stopReason = 'end_turn';

  const usage = chatData?.usage || {};

  return {
    id: `msg_${chatData?.id || cryptoRandomId()}`,
    type: 'message',
    role: 'assistant',
    model: requestedModel || chatData?.model || 'claude-3-5-sonnet',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    }
  };
}

app.post(['/v1/messages', '/messages'], async (req: Request, res: Response) => {
  const body = req.body || {};

  if (!body.model) {
    return res.status(400).json({
      error: { type: 'invalid_request_error', message: 'model is required' }
    });
  }

  const requestedModel = body.model;
  const effectiveModel = remapClaudeCodeModel(requestedModel);
  if (effectiveModel !== requestedModel) {
    console.log(`[claude-proxy] Remapped Claude Code model "${requestedModel}" -> "${effectiveModel}"`);
  }

  const chatBody: any = {
    model: effectiveModel,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stream: body.stream || false,
    stop: body.stop_sequences
  };

  const messages: any[] = [];
  if (typeof body.system === 'string' && body.system.trim()) {
    messages.push({ role: 'system', content: body.system });
  } else if (Array.isArray(body.system)) {
    const hasCacheControl = body.system.some((part: any) => part && typeof part === 'object' && part.cache_control);
    if (hasCacheControl) {
      const parts = body.system.map((part: any) => {
        if (typeof part === 'string') return { type: 'text', text: part };
        return {
          type: 'text',
          text: part.text || '',
          ...(part.cache_control ? { cache_control: part.cache_control } : {})
        };
      });
      messages.push({ role: 'system', content: parts });
    } else {
      const systemText = body.system
        .map((part: any) => (typeof part === 'string' ? part : part.text || ''))
        .join('\n');
      if (systemText.trim()) {
        messages.push({ role: 'system', content: systemText });
      }
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role;
      let content = msg.content;
      if (Array.isArray(content)) {
        content = content.map((part: any) => {
          if (part.type === 'text') {
            return {
              type: 'text',
              text: part.text,
              ...(part.cache_control ? { cache_control: part.cache_control } : {})
            };
          } else if (part.type === 'image') {
            const url = part.source?.data ? `data:${part.source.media_type};base64,${part.source.data}` : '';
            return {
              type: 'image_url',
              image_url: { url }
            };
          } else if (part.type === 'tool_use') {
            return {
              type: 'tool_calls',
              id: part.id,
              function: {
                name: part.name,
                arguments: JSON.stringify(part.input)
              }
            };
          } else if (part.type === 'tool_result') {
            return {
              type: 'tool_result',
              tool_use_id: part.tool_use_id,
              content: part.content
            };
          }
          return part;
        });
      }
      messages.push({ role, content });
    }
  }
  chatBody.messages = messages;

  if (Array.isArray(body.tools)) {
    chatBody.tools = body.tools.map((t: any) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema
      },
      ...(t.cache_control ? { cache_control: t.cache_control } : {})
    }));
  }

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let messageStarted = false;
    let contentBlockStarted = false;
    let toolBlockStarted = false;
    let openAiSseBuffer = '';
    let textIndex = 0;
    let currentToolId = '';
    let currentToolName = '';

    const processOpenAIToAnthropicStream = (chunk: any) => {
      openAiSseBuffer += chunk.toString();
      const lines = openAiSseBuffer.split('\n');
      openAiSseBuffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const dataStr = trimmed.substring(6).trim();
          if (dataStr === '[DONE]') {
            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 0 }
            })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            continue;
          }

          try {
            const data = JSON.parse(dataStr);
            const choice = data.choices?.[0] || {};
            const delta = choice.delta || {};
            
            if (!messageStarted) {
              res.write(`event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: {
                  id: `msg_${data.id || cryptoRandomId()}`,
                  type: 'message',
                  role: 'assistant',
                  model: requestedModel || data.model || 'claude-3-5-sonnet',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: 0 }
                }
              })}\n\n`);
              messageStarted = true;
            }

            if (delta.content) {
              if (!contentBlockStarted) {
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: textIndex,
                  content_block: { type: 'text', text: '' }
                })}\n\n`);
                contentBlockStarted = true;
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: textIndex,
                delta: { type: 'text_delta', text: delta.content }
              })}\n\n`);
            }

            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              if (contentBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: textIndex
                })}\n\n`);
                contentBlockStarted = false;
                textIndex++;
              }

              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  currentToolId = tc.id;
                  currentToolName = tc.function?.name || '';
                  res.write(`event: content_block_start\ndata: ${JSON.stringify({
                    type: 'content_block_start',
                    index: textIndex,
                    content_block: {
                      type: 'tool_use',
                      id: currentToolId,
                      name: currentToolName,
                      input: {}
                    }
                  })}`);
                  toolBlockStarted = true;
                }
                if (tc.function?.arguments) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: textIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                  })}`);
                }
              }
            }

            if (choice.finish_reason) {
              if (contentBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: textIndex
                })}`);
                contentBlockStarted = false;
              }
              if (toolBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: textIndex
                })}`);
                toolBlockStarted = false;
              }
              let stopReason = 'end_turn';
              if (choice.finish_reason === 'length') stopReason = 'max_tokens';
              else if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
              
              res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: data.usage?.completion_tokens || 0 }
              })}\n\n`);
            }
          } catch (err) {
            // ignore
          }
        }
      }
    };

    const fakeRes = new Writable({
      write(chunk, encoding, callback) {
        try {
          processOpenAIToAnthropicStream(chunk);
        } catch (e) {
          // ignore
        }
        callback();
      }
    }) as any;
    fakeRes.statusCode = 200;
    fakeRes.setHeader = () => {};
    fakeRes.status = (code: number) => {
      fakeRes.statusCode = code;
      return fakeRes;
    };
    fakeRes.json = (errData: any) => {
      res.status(fakeRes.statusCode).json(errData);
    };
    fakeRes.on('finish', () => {
      res.end();
    });

    req.body = chatBody;
    try {
      await handleChatCompletion(req, fakeRes);
    } catch (err: any) {
      res.status(500).json({ error: { type: 'api_error', message: err?.message || 'Anthropic stream failure' } });
    }
  } else {
    const fakeRes: any = {
      statusCode: 200,
      setHeader: () => {},
      status: (code: number) => {
        fakeRes.statusCode = code;
        return fakeRes;
      },
      json: (data: any) => {
        if (fakeRes.statusCode >= 400 || data.error) {
          res.status(fakeRes.statusCode).json(data);
        } else {
          const anthropicMsg = chatCompletionToAnthropicResponse(data, requestedModel);
          res.json(anthropicMsg);
        }
      }
    };

    req.body = chatBody;
    try {
      await handleChatCompletion(req, fakeRes);
    } catch (err: any) {
      res.status(500).json({ error: { type: 'api_error', message: err?.message || 'Anthropic response failure' } });
    }
  }
});

// =====================================================================
// OpenAI Responses API → chat-completions translation shim
// =====================================================================
// Codex CLI 0.135+ dropped wire_api="chat" and now requires
// wire_api="responses", which targets POST /v1/responses. local-router
// speaks the legacy /v1/chat/completions surface, so this route accepts
// the Responses request shape, normalizes it to a chat-completions body,
// calls the existing handleChatCompletion pipeline, and re-wraps the
// upstream chat-completion response in the Responses response envelope.
//
// Supports: input (string | item array), instructions, model, max_output_tokens,
// temperature, top_p, stream, tools, tool_choice, stop, user, metadata, store.
// Non-streaming via res.json intercept; streaming via HTTP SSE and WebSocket.
// =====================================================================

type ResponsesInputItem =
  | { type?: string; role?: 'system' | 'developer' | 'user' | 'assistant'; content: any }
  | string;

function responsesInputToMessages(input: any, instructions?: string): any[] {
  const messages: any[] = [];

  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({ role: 'system', content: instructions });
  }

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
    return messages;
  }

  if (!Array.isArray(input)) {
    // OpenAI also accepts a bare string; anything else is malformed.
    return messages;
  }

  for (const item of input as ResponsesInputItem[]) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    // Map developer/system to system, preserve user/assistant
    let role = item.role;
    if (role === 'developer') role = 'system';

    // Content can be a string or an array of typed parts
    let content: any = item.content;
    if (Array.isArray(content)) {
      // Translate Responses content parts → chat-completion parts.
      // We keep text and image_url; we drop other part types with a best-effort
      // text extraction so multi-modal prompts don't silently break.
      const textParts: string[] = [];
      const imageUrls: string[] = [];
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        if (part.type === 'input_text' || part.type === 'text') {
          textParts.push(String(part.text ?? ''));
        } else if (part.type === 'input_image' || part.type === 'image_url') {
          const url = part.image_url?.url || part.url;
          if (typeof url === 'string') imageUrls.push(url);
        } else if (typeof part.text === 'string') {
          textParts.push(part.text);
        }
      }
      if (imageUrls.length > 0) {
        content = [
          ...(textParts.length ? [{ type: 'text', text: textParts.join('\n') }] : []),
          ...imageUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))
        ];
      } else {
        content = textParts.join('\n');
      }
    }

    if (!role) role = 'user';
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') {
      role = 'user';
    }

    messages.push({ role, content });
  }

  return messages;
}

function translateResponsesRequestToChatBody(body: any): any {
  const translated: any = {};

  if (typeof body.model === 'string') translated.model = body.model;
  translated.messages = responsesInputToMessages(body.input, body.instructions);

  if (body.max_output_tokens != null) translated.max_tokens = body.max_output_tokens;
  if (body.temperature != null) translated.temperature = body.temperature;
  if (body.top_p != null) translated.top_p = body.top_p;
  if (body.frequency_penalty != null) translated.frequency_penalty = body.frequency_penalty;
  if (body.presence_penalty != null) translated.presence_penalty = body.presence_penalty;
  if (body.user != null) translated.user = body.user;
  if (Array.isArray(body.stop) || typeof body.stop === 'string') translated.stop = body.stop;
  if (body.metadata != null) translated.metadata = body.metadata;

  // Tools: Responses API tools[] shape is the same as chat-completions tools[]
  // (function name + description + parameters), so we can pass them through.
  if (Array.isArray(body.tools)) translated.tools = body.tools;
  if (body.tool_choice != null) translated.tool_choice = body.tool_choice;
  if (body.stream != null) translated.stream = Boolean(body.stream);

  return translated;
}

app.post(['/v1/responses', '/responses'], async (req: Request, res: Response) => {
  const requestStartedAt = Date.now();
  const body = req.body || {};

  if (!body.model) {
    return res.status(400).json({
      error: { message: 'You must provide a `model` parameter.', type: 'invalid_request_error' }
    });
  }

  const chatBody = translateResponsesRequestToChatBody(body);
  if (chatBody.messages.length === 0) {
    return res.status(400).json({
      error: {
        message: '`input` is required and must contain at least one message.',
        type: 'invalid_request_error'
      }
    });
  }

  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const modelId = String(body.model);
    const responseId = `resp_${cryptoRandomId()}`;
    const emitSse = (event: { type: string; [key: string]: unknown }) => {
      res.write(formatResponsesSseEvent(event));
    };

    emitSse(buildResponseCreatedEvent(responseId, modelId));

    const fakeReq: any = {
      body: { ...chatBody, stream: true },
      get: (name: string) => req.get(name),
      protocol: req.protocol,
      headers: req.headers,
      path: '/v1/responses'
    };

    let streamEnded = false;
    const endStream = () => {
      if (!streamEnded) {
        streamEnded = true;
        res.end();
      }
    };

    const fakeRes = createResponsesFakeResponse({
      emit: (event) => {
        emitSse(event);
        if (event.type === 'response.completed' || event.type === 'response.failed') {
          endStream();
        }
      },
      modelId,
      responseId,
      onFinished: endStream
    });

    try {
      await handleChatCompletion(fakeReq, fakeRes as any);
      // Streaming responses end when the upstream SSE pipe closes (fakeRes final/onFinished).
    } catch (err: any) {
      if (!streamEnded) {
        emitSse({
          type: 'response.failed',
          response_id: responseId,
          error: { message: err?.message || 'Responses shim failure', type: 'server_error' }
        });
        endStream();
      }
    }
    return;
  }

  // Drive the existing chat-completions pipeline by faking a Request whose
  // body is the translated chat-completions shape. We use Express's req.res
  // and mutate req.body so handleChatCompletion picks it up.
  req.body = chatBody;

  // Capture the upstream response by intercepting res.json. We swap res.json
  // once, then restore it after the call. This avoids duplicating the entire
  // proxy/router/fallback pipeline.
  const originalJson = res.json.bind(res);
  let captured: any = null;
  let capturedStatus = 200;
  res.json = ((payload: any) => {
    captured = payload;
    return res;
  }) as any;
  res.status = ((code: number) => {
    capturedStatus = code;
    return res;
  }) as any;

  try {
    await handleChatCompletion(req, res);
  } catch (err: any) {
    res.json = originalJson;
    return res.status(500).json({
      error: { message: err?.message || 'Responses shim failure', type: 'server_error' }
    });
  }

  res.json = originalJson;

  if (!captured) {
    // The pipeline wrote to res directly (streaming or empty); pass through.
    return;
  }

  if (capturedStatus >= 400 || captured?.error) {
    // Forward upstream errors in Responses shape so Codex can parse them.
    return originalJson({
      error: captured.error || {
        message: 'Upstream returned an error',
        type: 'upstream_error'
      }
    });
  }

  const presented = String(body.model);
  const wrapped = chatCompletionToResponsesResponse(captured, presented);
  return originalJson(wrapped);
});

app.get(['/v1/models', '/models'], async (req: Request, res: Response) => {
  const requestedProvider = typeof req.query.provider === 'string'
    ? req.query.provider.trim()
    : '';
  const live = String(req.query.live || '').toLowerCase() === 'true';

  if (requestedProvider) {
    if (live && modelSourceConfig.source === 'custom') {
      console.log(`[catalog] live upstream model list requested for ${requestedProvider}`);
    }

    const models = await resolveCatalogModels({
      provider: requestedProvider,
      live
    });

    return res.json({
      object: 'list',
      data: models.map((model) => openAIModelEntry(model))
    });
  }

  const providerModels = await discoveryModelList(live);
  const filtered = filterConfiguredModels(providerModels);

  res.json({
    object: 'list',
    data: filtered.map((model) => openAIModelEntry(model)),
    catalog_mode: modelSourceConfig.source,
    filter_configured: modelSourceConfig.filterConfigured
  });
});

// ==========================================
// Ollama API Emulation Layer
// ==========================================

// GET /api/tags
app.head('/api/tags', (req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/api/tags', async (req: Request, res: Response) => {
  const live = String(req.query.live || '').toLowerCase() === 'true';
  const providerModels = await discoveryModelList(live);
  const filtered = filterConfiguredModels(providerModels);

  res.json({
    models: filtered.map((model) => ollamaTag(model))
  });
});

app.get('/api/ps', (req: Request, res: Response) => {
  res.json({ models: [] });
});

app.post('/api/show', (req: Request, res: Response) => {
  // Ollama 0.31.x client sends the model in `name` with `model` as an empty
  // string. Accept `name` whenever `model` is missing or blank — non-empty
  // `model` still wins.
  const rawModel = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const modelName = rawModel || rawName;

  if (!modelName) {
    return res.status(400).json({ error: 'model is required.' });
  }

  const model = findPresentedModel(modelName);
  if (!model) {
    return res.status(404).json({ error: `model '${modelName}' not found` });
  }

  return res.json(ollamaShowPayload(model));
});

app.get('/api/show/:model', (req: Request, res: Response) => {
  const modelName = String(req.params.model || '').trim();
  if (!modelName) {
    return res.status(400).json({ error: 'model is required.' });
  }

  const model = findPresentedModel(modelName);
  if (!model) {
    return res.status(404).json({ error: `model '${modelName}' not found` });
  }

  return res.json(ollamaShowPayload(model));
});

app.get(/^\/api\/show\/(.+)$/, (req: Request, res: Response) => {
  const modelName = decodeURIComponent(String(req.params[0] || '')).trim();
  if (!modelName) {
    return res.status(400).json({ error: 'model is required.' });
  }

  const model = findPresentedModel(modelName);
  if (!model) {
    return res.status(404).json({ error: `model '${modelName}' not found` });
  }

  return res.json(ollamaShowPayload(model));
});

// POST /api/chat
app.post('/api/chat', async (req: Request, res: Response) => {
  try {
    // Translate Ollama req -> OpenAI request
    const openAiReq: any = {
      model: req.body.model,
      messages: ollamaMessagesToOpenAI(Array.isArray(req.body.messages) ? req.body.messages : []),
      stream: req.body.stream !== false
    };
    applyOllamaRequestOptions(openAiReq, req.body);

    await handleChatCompletion(req, res, openAiReq, { outputFormat: 'ollama_chat' });
  } catch (err: any) {
    console.error('[POST /api/chat] Unhandled error:', err?.stack || err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Internal server error in /api/chat' });
    }
  }
});

// POST /api/generate
app.post('/api/generate', async (req: Request, res: Response) => {
  try {
    const message: any = { role: 'user', content: typeof req.body.prompt === 'string' ? req.body.prompt : '' };
    if (Array.isArray(req.body.images)) {
      message.images = req.body.images;
    }

    // Translate to /chat/completions
    const openAiReq: any = {
      model: req.body.model,
      messages: ollamaMessagesToOpenAI([message]),
      stream: req.body.stream !== false
    };
    applyOllamaRequestOptions(openAiReq, req.body);

    await handleChatCompletion(req, res, openAiReq, { outputFormat: 'ollama_generate' });
  } catch (err: any) {
    console.error('[POST /api/generate] Unhandled error:', err?.stack || err?.message || err);
    if (!res.headersSent) {
      res.status(500).json({ error: err?.message || 'Internal server error in /api/generate' });
    }
  }
});

const isDevMode = process.env.LOCAL_ROUTER_DEV === 'true' || process.env.NODE_ENV === 'development';

// Central error handler — never leak stack traces to clients.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof err?.status === 'number'
    ? err.status
    : (typeof err?.statusCode === 'number' ? err.statusCode : 500);
  const message = status >= 500 && !isDevMode
    ? 'Internal server error'
    : (err?.message || 'Request failed');
  if (status >= 500) {
    console.error('[error-handler]', err?.stack || err?.message || err);
  }
  res.status(status).json({
    error: { message, type: err?.type || 'server_error' }
  });
});

loadExpertLogs();
loadPqcSecrets();
runCatalogHealthCheck();
// Boot-time config round-trip: once keys are in memory, re-check provider
// catalogs whose fallback-referenced models are missing (new-machine import).
setTimeout(() => scheduleRecheckForFallbackReferences(), 4000).unref?.();
// Registry baselines (2026-09-04): make registry-only entries (copilot/cursor
// `auto`, curated premiums) catalogable without waiting for a live refresh.
function seedRegistryBaselines(): void {
  try {
    let seeded = 0;
    for (const summary of allProviderSummaries()) {
      const slug = canonicalProviderSlug(summary.name);
      if (!slug || isLocalRouterProviderName(slug) || isCustomProvider(slug)) continue;
      const known = new Set(endpointModelsCache.filter((m) => m.provider === slug).map((m) => m.model));
      const extras = providerRegistryModels(slug)
        .filter((raw) => !known.has(String(raw.id)))
        .map((raw) => mapLiveRawModelsToCatalog(slug, [raw])[0])
        .filter(Boolean);
      if (extras.length > 0) {
        // Cache seeding only (2026-09-04): registry baselines are DISCOVERABLE
        // after boot, but never auto-curated — curation stays operator- and
        // fallback-healer-driven, otherwise every restart balloons the served
        // catalog back up to the full registry.
        mergeProviderEndpointModels(slug, extras);
        seeded += extras.length;
      }
    }
    if (seeded > 0) {
      modelSourceConfig.curatedEndpointModelKeys.sort();
      persistEndpointModelsCache();
      persistModelSourceConfig();
      console.log(`[catalog] Seeded ${seeded} registry baseline model(s) into the cache.`);
    }
  } catch (error: any) {
    console.error('[catalog] Registry baseline seed failed:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}
if (shouldServe) {
  writeProviderEndpointsDoc();
}

// shouldServe and isMainModule defined at top

const bindHost = process.env.LOCAL_ROUTER_BIND_ALL === 'true' ? '0.0.0.0' : '127.0.0.1';
const server = shouldServe ? app.listen(PORT, bindHost, () => {
  console.log(`Local Router OpenAI-compatible proxy running on http://localhost:${PORT}`);
  console.log(`[Security] Bound to ${bindHost}${bindHost === '127.0.0.1' ? ' (loopback only — set LOCAL_ROUTER_BIND_ALL=true for all interfaces)' : ' (all interfaces)'}`);
  console.log(`Point your VS Code extension to: http://localhost:${PORT}/v1`);
  if (isDevMode) {
    console.log(`[DEV] Hot reload enabled — file changes will restart the server automatically.`);
    console.log(`[DEV] Config UI: http://localhost:${PORT}/config`);
    console.log(`[DEV] Set PORT=11435 to run alongside production Ollama on 11434.`);
    console.log(`[DEV] Use 'npm run dev' for tsx watch mode or 'npm run build:watch' for tsc --watch.`);
  }

  void (async () => {
    await ensureOllamaBackend();
    const ollamaTags = filterOllamaCloudPullTags(
      effectiveProviderModels('ollama').map((model) => model.model),
      ollamaCloudRoutingAllowsPro()
    );
    await pullOllamaCloudModels(ollamaTags);
  })();
}) : null;

// Dual-stack loopback: several IDEs (VS Code Copilot Chat and friends) resolve
// `localhost` to ::1 first; an IPv4-only socket means their ollama probe hits
// ECONNREFUSED and surfaces the misleading "Unable to verify Ollama server
// version" error even though the proxy is healthy. Bind the IPv6 loopback
// alongside 127.0.0.1 (loopback-only posture unchanged); skip when the
// operator opted into LAN-wide binding (0.0.0.0 covers the intent) and
// degrade gracefully on hosts without IPv6.
const serverV6 = shouldServe && bindHost === '127.0.0.1'
  ? app.listen(PORT, '::1', () => {
    console.log('[Security] Also bound to ::1 (IPv6 loopback — dual-stack localhost)');
  })
  : null;
serverV6?.on('error', (err: any) => {
  console.warn('[Security] IPv6 loopback bind failed; continuing IPv4-only:',
    sanitizeDiagnosticText(String(err?.message || err)));
});

// TLS / HTTPS listener (2026-09-07): strict client tooling that refuses plain
// HTTP or loopback URL strings (`http`, `localhost`, `127.0.0.1`) can
// additionally be pointed at an `https://` URL with a friendly hostname. The
// plain-HTTP listeners above stay untouched so every existing drop-in client
// keeps working. Surface: LOCAL_ROUTER_TLS, LOCAL_ROUTER_TLS_PORT (default
// 11443), LOCAL_ROUTER_TLS_HOSTNAME, LOCAL_ROUTER_TLS_CERT/KEY — see
// src/tls.ts and the llms.txt "TLS / HTTPS Listener Contract".
const tlsSettings = resolveTlsSettings();
if (shouldServe && tlsSettings.enabled) {
  void (async () => {
    try {
      const tls = await createTlsServers(app, tlsSettings);
      if (!tls) {
        return;
      }
      const [tlsServerV4, tlsServerV6] = tls.servers;
      tlsServerV4.listen(tlsSettings.port, bindHost, () => {
        console.log(`[TLS] HTTPS listener running on https://localhost:${tlsSettings.port} (same app as http://localhost:${PORT})`);
        console.log(`[TLS] Strict-tooling URL (public DNS -> loopback): https://${ZERO_CONFIG_HOSTNAME}:${tlsSettings.port}`);
        console.log(`[TLS] Custom hostname URL: https://${tlsSettings.hostname}:${tlsSettings.port} (hosts entry: "127.0.0.1 ${tlsSettings.hostname}")`);
        console.log(`[TLS] Cert: ${tls.material.certPath} (${tls.material.generated ? 'generated self-signed' : 'operator-supplied'}${tls.material.validTo ? `, valid to ${tls.material.validTo.slice(0, 10)}` : ''}) — trust via NODE_EXTRA_CA_CERTS or see 'local-router tls status'`);
      });
      tlsServerV4.on('error', (err: any) => {
        console.error(`[TLS] HTTPS bind failed on ${bindHost}:${tlsSettings.port}:`,
          sanitizeDiagnosticText(String(err?.message || err)));
      });
      if (bindHost === '127.0.0.1') {
        tlsServerV6.listen(tlsSettings.port, '::1', () => {
          console.log('[TLS] HTTPS also bound to ::1 (IPv6 loopback — dual-stack)');
        });
        tlsServerV6.on('error', (err: any) => {
          console.warn('[TLS] HTTPS IPv6 loopback bind failed; continuing IPv4-only:',
            sanitizeDiagnosticText(String(err?.message || err)));
        });
      }
      // Codex-style WebSocket clients must also work over wss://.
      tlsServerV4.on('upgrade', handleHttpUpgrade);
      tlsServerV6.on('upgrade', handleHttpUpgrade);
    } catch (error: any) {
      console.error('[TLS] HTTPS listener startup failed (HTTP serving continues):',
        sanitizeDiagnosticText(String(error?.message || error)));
    }
  })();
}

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws: WebSocket) => {
  let isGenerating = false;

  ws.on('message', async (messageData: string) => {
    try {
      const event = JSON.parse(messageData);
      if (event.type === 'response.create') {
        if (isGenerating) {
          ws.send(JSON.stringify({
            type: 'response.failed',
            error: { message: 'Another response is currently in progress.', type: 'invalid_request_error' }
          }));
          return;
        }

        const body = event.response || {};
        if (!body.model) {
          ws.send(JSON.stringify({
            type: 'response.failed',
            error: { message: 'You must provide a `model` parameter.', type: 'invalid_request_error' }
          }));
          return;
        }

        const chatBody = translateResponsesRequestToChatBody(body);
        if (chatBody.messages.length === 0) {
          ws.send(JSON.stringify({
            type: 'response.failed',
            error: { message: '`input` is required and must contain at least one message.', type: 'invalid_request_error' }
          }));
          return;
        }

        isGenerating = true;

        const responseId = `resp_${cryptoRandomId()}`;
        const modelId = String(body.model);

        ws.send(JSON.stringify(buildResponseCreatedEvent(responseId, modelId)));

        const fakeReq: any = {
          body: chatBody,
          get: (name: string) => {
            if (name.toLowerCase() === 'x-local-router-client') return 'codex';
            return undefined;
          },
          protocol: 'http',
          headers: {},
          path: '/v1/responses'
        };

        const fakeRes = createResponsesFakeResponse({
          emit: (streamEvent) => ws.send(JSON.stringify(streamEvent)),
          modelId,
          responseId,
          onFinished: () => {
            isGenerating = false;
          }
        });

        try {
          fakeReq.body.stream = true;
          await handleChatCompletion(fakeReq, fakeRes as any);
        } catch (err: any) {
          ws.send(JSON.stringify({
            type: 'response.failed',
            response_id: responseId,
            error: { message: err?.message || 'Responses WS shim failure', type: 'server_error' }
          }));
          isGenerating = false;
        }
      }
    } catch (err) {
      ws.send(JSON.stringify({
        type: 'response.failed',
        error: { message: 'Malformed JSON payload.', type: 'invalid_request_error' }
      }));
    }
  });

  ws.on('close', () => {
    isGenerating = false;
  });
});

function handleHttpUpgrade(request: any, socket: any, head: any) {
  const urlObj = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  if (pathname === '/v1/responses') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
}

server?.on('upgrade', handleHttpUpgrade);
serverV6?.on('upgrade', handleHttpUpgrade);

export {
  estimateRequestContext,
  requestRequiresMultimodal,
  filterEligibleFallbackModels
};
