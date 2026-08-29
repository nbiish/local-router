import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Readable, Transform, Writable } from 'stream';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
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
import { loadSessions, loadFeedback, recordRequest, getSessions, getSessionById, recordFeedback, saveSessions } from './sessions';
import { loadExpertLogs, LogEntryTracker, createUsageSpyStream } from './expert-logs';
import { buildWraparoundExecutionPlan } from './execution-plan';
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
import { loadCurationConfigs, loadRouterSettings, saveRouterSettings } from './config-persistence';
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

type DiagnosticEventName =
  | 'proxy_request'
  | 'proxy_response'
  | 'proxy_error'
  | 'diagnostics_toggle'
  | 'diagnostics_clear';

type DiagnosticEntry = {
  id: number;
  timestamp: string;
  event: DiagnosticEventName;
  route: string;
  provider?: string;
  presentedModel?: string;
  actualModel?: string;
  stream?: boolean;
  status?: number;
  durationMs?: number;
  data: Record<string, unknown>;
};

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
const diagnosticsStore = {
  enabled: false,
  entries: [] as DiagnosticEntry[],
  nextId: 1,
  maxEntries: 200
};

function sanitizeDiagnosticText(value: string, maxLength = 180) {
  const redacted = value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/([A-Za-z0-9_]*(?:api[_-]?key|token|secret|password)[A-Za-z0-9_]*\s*[:=]\s*)([^,\s]+)/gi, '$1[REDACTED]')
    .trim();

  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}…`;
}

function summarizeMessagesForDiagnostics(messages: unknown[]) {
  const roles = new Set<string>();
  let contentCharacters = 0;
  let imageMessageCount = 0;
  let toolCallMessageCount = 0;

  for (const item of messages) {
    if (!item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (typeof message.role === 'string' && message.role.trim()) {
      roles.add(message.role.trim());
    }

    const content = message.content;
    if (typeof content === 'string') {
      contentCharacters += content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (!part || typeof part !== 'object') continue;
        const contentPart = part as Record<string, unknown>;
        if (typeof contentPart.text === 'string') {
          contentCharacters += contentPart.text.length;
        }
        if (contentPart.type === 'image_url' || contentPart.type === 'image') {
          imageMessageCount += 1;
        }
      }
    }

    if (Array.isArray(message.images) && message.images.length > 0) {
      imageMessageCount += 1;
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      toolCallMessageCount += message.tool_calls.length;
    }
  }

  return {
    count: messages.length,
    roles: Array.from(roles).slice(0, 8),
    approxContentCharacters: contentCharacters,
    imageMessageCount,
    toolCallMessageCount
  };
}

function summarizeRequestForDiagnostics(body: any) {
  const rawKeys = body && typeof body === 'object' ? Object.keys(body) : [];
  const toolNames = Array.isArray(body?.tools)
    ? body.tools
      .slice(0, 8)
      .map((tool: any) => sanitizeDiagnosticText(String(tool?.function?.name || tool?.name || 'tool')))
    : [];

  return {
    model: typeof body?.model === 'string' ? body.model : null,
    stream: Boolean(body?.stream),
    messageSummary: summarizeMessagesForDiagnostics(Array.isArray(body?.messages) ? body.messages : []),
    promptCharacters: typeof body?.prompt === 'string' ? body.prompt.length : 0,
    hasTools: Array.isArray(body?.tools) && body.tools.length > 0,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    toolNames,
    maxTokens: typeof body?.max_tokens === 'number' ? body.max_tokens : null,
    temperature: typeof body?.temperature === 'number' ? body.temperature : null,
    responseFormat: typeof body?.response_format?.type === 'string' ? body.response_format.type : null,
    keyCount: rawKeys.length,
    containsSensitiveFields: rawKeys.some((key) => SECRET_FIELD_PATTERN.test(key))
  };
}

function summarizeResponseForDiagnostics(body: any) {
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  const finishReasons = new Set<string>();
  let contentCharacters = 0;
  let toolCallCount = 0;

  for (const choice of choices) {
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
      finishReasons.add(choice.finish_reason);
    }
    const content = choice?.message?.content ?? choice?.delta?.content;
    if (typeof content === 'string') {
      contentCharacters += content.length;
    }
    const toolCalls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls;
    if (Array.isArray(toolCalls)) {
      toolCallCount += toolCalls.length;
    }
  }

  return {
    choiceCount: choices.length,
    finishReasons: Array.from(finishReasons).slice(0, 8),
    contentCharacters,
    toolCallCount,
    hasError: Boolean(body?.error)
  };
}

function pushDiagnostic(entry: Omit<DiagnosticEntry, 'id' | 'timestamp'>) {
  if (!diagnosticsStore.enabled && entry.event !== 'diagnostics_toggle' && entry.event !== 'diagnostics_clear') {
    return;
  }

  const record: DiagnosticEntry = {
    ...entry,
    id: diagnosticsStore.nextId,
    timestamp: new Date().toISOString()
  };
  diagnosticsStore.nextId += 1;
  diagnosticsStore.entries.push(record);

  if (diagnosticsStore.entries.length > diagnosticsStore.maxEntries) {
    diagnosticsStore.entries.splice(0, diagnosticsStore.entries.length - diagnosticsStore.maxEntries);
  }
}

function diagnosticsSnapshot(limit = 120) {
  const safeLimit = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, diagnosticsStore.maxEntries)
    : 120;

  return {
    enabled: diagnosticsStore.enabled,
    entryCount: diagnosticsStore.entries.length,
    maxEntries: diagnosticsStore.maxEntries,
    entries: diagnosticsStore.entries.slice(-safeLimit)
  };
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

  return {
    ok: true,
    record: {
      name: slugResult.slug,
      displayName,
      endpoint: endpointResult.endpoint,
      keyEnvVar: keyEnvVarResult.keyEnvVar,
      defaultTool,
      createdAt: existing?.createdAt || new Date().toISOString()
    }
  };
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
        const keyEnvVar = String(raw?.keyEnvVar || '').trim();
        if (!name || !endpointResult.ok || !PROVIDER_KEY_ENV_PATTERN.test(keyEnvVar)) {
          return null;
        }
        return {
          name,
          displayName: String(raw?.displayName || name).trim() || name,
          endpoint: endpointResult.endpoint,
          keyEnvVar,
          defaultTool: String(raw?.defaultTool || 'OpenAI Compatible').trim() || 'OpenAI Compatible',
          createdAt: String(raw?.createdAt || new Date().toISOString())
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

function persistFallbackModels() {
  ensureLocalRouterConfigDir();
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
    const sysRoute = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
    if (sysRoute) {
      const disabled = new Set(Array.isArray(sysRoute.disabledModels) ? sysRoute.disabledModels : []);
      const text = (Array.isArray(sysRoute.models) ? sysRoute.models : [])
        .map((m) => (disabled.has(m) ? `${m} disabled` : m))
        .join('\n');
      saveRouterSettings({ fallbackModelsText: text });
    }
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

function loadPersistedRouterSettings() {
  try {
    const settings = loadRouterSettings();
    if (!settings || typeof settings !== 'object') return;
    if (typeof settings.fallbackModelsText === 'string' && settings.fallbackModelsText.trim()) {
      const existing = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
      if (!existing || (!Array.isArray(existing.models) || existing.models.length === 0)) {
        const text = settings.fallbackModelsText.trim();
        const entries = text.split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean);
        if (entries.length >= 1) {
          const parsed = parseFallbackModel({ id: SYSTEM_FALLBACK_ROUTE_ID, modelsText: text }, { allowShort: true });
          if (parsed.ok) {
            fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID] = cloneFallbackModel(parsed.model);
          }
        }
      }
    }
  } catch (error: any) {
    console.error('Failed to load persisted router settings:', sanitizeDiagnosticText(String(error?.message || error)));
  }
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

// ── Headroom Compression Configuration ─────────────────────────────────────

const DEFAULT_HEADROOM_PROXY_URL = 'http://localhost:8787';
let headroomEnabled = true;
let headroomProxyUrl = DEFAULT_HEADROOM_PROXY_URL;

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

function headroomApiPayload() {
  return { enabled: headroomEnabled, proxyUrl: headroomProxyUrl };
}

/**
 * Compress messages via the Headroom proxy before forwarding upstream.
 * On failure (proxy unavailable, timeout, etc.) returns the original body unchanged —
 * headroom is an optimization layer and must never block the request pipeline.
 */
async function compressWithHeadroom(body: any, model: string): Promise<any> {
  if (!headroomEnabled || !Array.isArray(body?.messages) || body.messages.length === 0) {
    return body;
  }
  try {
    const { compress } = await import('headroom-ai');
    const result = await compress(body.messages, {
      model,
      baseUrl: headroomProxyUrl,
      timeout: 10_000,
      fallback: true,
      retries: 1,
      stack: 'local_router'
    });
    if (result.compressed && result.tokensSaved > 0) {
      console.log(`[Headroom] ${result.tokensBefore} → ${result.tokensAfter} tokens (saved ${result.tokensSaved}, ${Math.round(result.compressionRatio * 100)}% ratio)`);
      return { ...body, messages: result.messages };
    }
    return body;
  } catch (err: any) {
    console.error('[Headroom] Compression failed:', err?.message || err);
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
  if (!endpointCurationActive()) return models;
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

  for (const raw of rawModels) {
    const modelId = raw.id;
    const presentedId = defaultPresentedModelName(providerName, modelId);
    const matchingBaseline = baselineModels.find(
      (baseline) => baseline.provider === providerName && baseline.model === modelId
    );

    if (matchingBaseline) {
      providerModels.push({
        ...matchingBaseline,
        id: presentedId
      });
      continue;
    }

    const numberHint = (...keys: string[]): number | undefined => {
      for (const key of keys) {
        const value = (raw as Record<string, unknown>)[key];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
      }
      return undefined;
    };
    const booleanHint = (key: string, fallback: boolean): boolean => {
      const value = (raw as Record<string, unknown>)[key];
      return typeof value === 'boolean' ? value : fallback;
    };
    const stringHint = (key: string): string | undefined => {
      const value = (raw as Record<string, unknown>)[key];
      return typeof value === 'string' && value.length > 0 ? value : undefined;
    };
    providerModels.push({
      id: presentedId,
      provider: providerName,
      model: modelId,
      display: providerModelDisplay(providerName, modelId),
      contextLength: numberHint('contextLength', 'context_length') ?? DEFAULT_CONTEXT_LENGTH,
      outputTokens: numberHint('outputTokens', 'max_output_tokens') ?? DEFAULT_OUTPUT_TOKENS,
      tier: stringHint('tier'),
      sourceUrl: stringHint('sourceUrl'),
      supportsTools: booleanHint('supportsTools', true),
      supportsImages: booleanHint('supportsImages', false),
      supportsCache: booleanHint('supportsCache', false),
      supportsReasoning: booleanHint('supportsReasoning', false)
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

  const key = keyStore[summary.name] || providerEnvKeyValue(summary.keyEnvVar);
  const isLocalService = isLocalLoopbackProvider(providerName);

  if (!key && !isLocalService) {
    return registryOnly
      ? registryResult('No API key saved — showing curated registry; save the key to enable serving.')
      : catalogResult(
          providerRegistryModels(summary.name),
          'No API key saved — showing curated registry catalog.'
        );
  }

  if (registryOnly) {
    return registryResult(
      `${summary.name} publishes no models-list API — curated registry (catalog rows + verified additions).`
    );
  }

  try {
    const url = providerBaseUrl(summary);
    const headers: Record<string, string> = {};
    if (key) {
      headers.Authorization = `Bearer ${key}`;
    }
    const response = await safeFetch(`${url}/models`, {
      headers,
      signal: AbortSignal.timeout(6000)
    });
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
        .map((model: any) => model?.id ?? model?.name ?? model?.model)
        .filter((id: unknown): id is string => typeof id === 'string' && id.trim().length > 0)
        .map((id: string) => ({ id: id.trim(), object: 'model', owned_by: summary.name }));
      if (models.length > 0) {
        return { models, source: 'live' };
      }
      return catalogResult(
        providerRegistryModels(summary.name),
        `Upstream /models returned no recognizable model list — showing curated registry catalog.`
      );
    }
    return catalogResult(
      providerRegistryModels(summary.name),
      `Upstream /models fetch failed (HTTP ${response.status}) — showing curated registry catalog.`
    );
  } catch (error: any) {
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
async function refreshProviderEndpointModels(providerName: string): Promise<{
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
  mergeProviderEndpointModels(providerName, fetched.models);
  persistEndpointModelsCache();
  const deselectedCount = deselectProviderCurationKeys(providerName);
  return { models: fetched.models, deselectedCount, source: fetched.source, note: fetched.note };
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
  // models are toggles like everything else).
  const byKey = new Map<string, ProviderModel>();
  for (const model of modelPresentationList()) {
    byKey.set(endpointModelCurationKey(model), model);
  }
  for (const model of endpointModelsCache) {
    const key = endpointModelCurationKey(model);
    if (!byKey.has(key)) byKey.set(key, model);
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
  const configuredModel = findProviderModel(modelName);
  if (configuredModel) {
    return {
      providerName: configuredModel.provider,
      actualModel: configuredModel.model,
      presentedModel: configuredModel.id
    };
  }

  const [rawProviderName, ...actualModelParts] = modelName.split('/');
  const actualModel = actualModelParts.join('/');
  if (!rawProviderName || !actualModel) {
    return null;
  }

  return {
    providerName: canonicalProviderSlug(rawProviderName),
    actualModel
  };
}

function fallbackModelPresentation(model: FallbackModel): ProviderModel {
  const firstTarget = model.models[0];
  // Resolve the presenting step's specs from the full catalog inventory
  // (registry ∪ cache) first: chains are authored inventory-wide, so the
  // route must not advertise default 64k/4k metadata just because its first
  // step happens to be outside the curated serving subset right now.
  const firstResolved = firstTarget
    ? (findCatalogModel(firstTarget) || findProviderModel(firstTarget))
    : undefined;
  const routeId = normalizeFallbackRouteId(model.id);
  const presentedId = fallbackPresentedModelId(routeId);

  return {
    id: presentedId,
    provider: FALLBACK_PROVIDER_NAME,
    model: routeId,
    display: `${presentedId}: ${model.models.join(' -> ')}`,
    contextLength: firstResolved?.contextLength || DEFAULT_CONTEXT_LENGTH,
    outputTokens: firstResolved?.outputTokens || DEFAULT_OUTPUT_TOKENS,
    supportsTools: firstResolved?.supportsTools ?? true,
    supportsImages: firstResolved?.supportsImages ?? false,
    supportsCache: firstResolved?.supportsCache ?? false,
    supportsReasoning: false
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

function getPqcConfigDir(): string {
  if (process.env.PQC_CONFIG_DIR) return process.env.PQC_CONFIG_DIR;
  const noDot = path.join(os.homedir(), 'config', 'pqc-secrets');
  if (fs.existsSync(noDot)) return noDot;
  return path.join(os.homedir(), '.config', 'pqc-secrets');
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

function ensurePqcKeypair(bin: string): boolean {
  const pubkeyPath = getPqcPubkeyPath();
  if (fs.existsSync(pubkeyPath)) return true;
  try {
    execFileSync(bin, ['keygen'], {
      encoding: 'utf8',
      // uv-based pqc-secrets engine cold start can exceed 10s on first dependency resolution
      timeout: 30000,
      stdio: 'pipe',
      env: {
        ...process.env,
        PQC_CONFIG_DIR: getPqcConfigDir(),
        PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
        PATH: defaultChildPathEnv()
      }
    });
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
    const envValue = process.env[localRouterEnvVarName(summary.keyEnvVar)];
    if (envValue) {
      keyStore[summary.name] = envValue;
      count++;
    }
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
  const bundlePath = getPqcBundlePath();
  if (!fs.existsSync(bundlePath)) return { ok: false, error: `no bundle at ${bundlePath}` };

  const spawnEnv = {
    ...process.env,
    PQC_CONFIG_DIR: getPqcConfigDir(),
    PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
    PATH: defaultChildPathEnv()
  };
  let output: string | null = null;
  let lastError: unknown = null;
  try {
    // 120s: the uv/python engine cold-bootstraps its dependency cache
    // (cryptography wheels) on first use and far exceeds 30s downloads.
    output = execFileSync(bin, ['export'], {
      encoding: 'utf8',
      timeout: 120000,
      env: spawnEnv
    });
  } catch (err) {
    lastError = err;
  }
  if (output === null) {
    const stderr = (() => {
      const candidate = (lastError as { stderr?: unknown } | null)?.stderr;
      if (typeof candidate === 'string') return candidate.trim();
      if (candidate instanceof Buffer) return candidate.toString('utf8').trim();
      return '';
    })();
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    return { ok: false, error: `export failed: ${message}${stderr ? ` — stderr: ${sanitizeDiagnosticText(stderr).slice(0, 300)}` : ''}` };
  }

  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const line of output.split('\n')) {
    // Strict namespace (2026-08-22): only LOCALROUTER_* bundle entries map
    // onto providers. Plainly-named entries are reported as skipped with a
    // rename hint — they belong to other tools and stay untouched.
    const match = line.match(/^export\s+([A-Z0-9_]+)=(.+)$/);
    if (!match) continue;
    const fullName = match[1];
    const value = match[2];
    if (!fullName.startsWith('LOCALROUTER_')) {
      skipped.push(`${fullName} (rename to LOCALROUTER_${fullName} if this is a Local Router key)`);
      continue;
    }
    const envVar = fullName.slice('LOCALROUTER_'.length);
    process.env[localRouterEnvVarName(envVar)] = value;
    const providers = providerSummariesForEnvVar(envVar);
    if (providers.length > 0) {
      for (const provider of providers) {
        keyStore[provider.name] = value;
        pqcBundleProviders.add(provider.name);
        loaded.push(provider.name);
      }
    } else {
      skipped.push(envVar);
    }
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
    // Namespaced pack (2026-08-22): Local Router-owned keys are stored in the
    // bundle under LOCALROUTER_<KEY_ENV_VAR> names, and ONLY those names are
    // managed here. Plainly-named entries — including provider-named ones
    // like KILO_API_KEY used by other tools — are Local-Router-invisible and
    // always preserved. If the current bundle cannot be read we abort rather
    // than risk dropping unknown entries.
    const managedEnvVars = new Set<string>();
    for (const summary of allProviderSummaries()) {
      managedEnvVars.add(localRouterEnvVarName(summary.keyEnvVar));
    }
    const preservedLines: string[] = [];
    if (fs.existsSync(getPqcBundlePath())) {
      let existingOutput: string | null = null;
      try {
        existingOutput = execFileSync(bin, ['export'], {
          encoding: 'utf8',
          timeout: 120000,
          env: {
            ...process.env,
            PQC_CONFIG_DIR: getPqcConfigDir(),
            PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
            PATH: defaultChildPathEnv()
          }
        });
      } catch (err) {
        console.error('[PQC] Cannot persist safely: existing bundle export failed — not overwriting. Error:', sanitizeDiagnosticText(String((err as Error).message)));
        return;
      }
      for (const line of existingOutput.split('\n')) {
        const match = line.match(/^export\s+([A-Z0-9_]+)=(.+)$/);
        if (!match) continue;
        if (managedEnvVars.has(match[1])) continue;
        preservedLines.push(`${match[1]}=${match[2]}`);
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
    if (lines.length === 0) return;
    if (!ensurePqcKeypair(bin)) {
      console.error(`[PQC] Cannot persist: no keypair at ${getPqcPubkeyPath()}. Run 'bin/pqc-secrets keygen' manually.`);
      return;
    }
    execFileSync(bin, ['pack'], {
      input: lines.join('\n') + '\n',
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        PQC_CONFIG_DIR: getPqcConfigDir(),
        PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
        PATH: defaultChildPathEnv()
      }
    });
    if (process.env.LOCAL_ROUTER_DEV === 'true') {
      console.log(`[PQC] Persisted ${lines.length} key(s) to ${getPqcBundlePath()}.`);
    }
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
      getHeaders: () => {
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
mergeBaselineProviderModelOverrides();
seedRegistryCatalogIfNeeded();
loadPersistedFallbackModels();
if (waferZdrEnabled) {
  console.log('[Wafer] ZDR enabled for GLM-5.1, Kimi-K2.6, deepseek-v4-pro');
}
loadPersistedRouterSettings();
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

            this.push(JSON.stringify(ollamaChunk) + '\\n');
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

function providerHasConfiguredKey(providerName: string) {
  if (providerName === 'ollama') {
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
  if (!target || !resolved || isLocalRouterProviderName(providerName)) {
    status = 'unavailable';
  } else if (!keyConfigured) {
    status = 'no_key';
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
    return {
      errorType: 'unknown_model',
      message: `Unknown fallback model "${modelName}".`
    };
  }

  const provider = getProviderSummary(target.providerName);
  if (!provider) {
    return {
      errorType: 'provider_not_found',
      providerName: target.providerName,
      actualModel: target.actualModel,
      message: `No suitable provider found for: ${target.providerName}.`
    };
  }

  if (!providerHasConfiguredKey(target.providerName)) {
    return {
      errorType: 'provider_config',
      providerName: target.providerName,
      actualModel: target.actualModel,
      message: `Provider "${target.providerName}" is not configured. Add an API key at /config.`
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
      message: `Ollama Cloud model "${modelName}" is not on the free-tier routing allowlist (Pro-only or not curated).`
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

async function failoverPreserveSessionContext(presentedModel: string, targetModel: string): Promise<void> {
  try {
    const session = getSessionById(presentedModel);
    if (!session) return;
    session.modelUsage[targetModel] = (session.modelUsage[targetModel] || 0) + 1;
    session.lastActivity = new Date().toISOString();
    session.totalRequests += 1;
    saveSessions();
  } catch {
    // best-effort continuity
  }
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

export function stripCacheControl(body: any): any {
  if (!body || !Array.isArray(body.messages)) return body;
  const newBody = { ...body };
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
  return newBody;
}

export function getPromptCacheKey(messages: any[]): string | undefined {
  if (!Array.isArray(messages) || messages.length === 0) return undefined;
  const firstSystem = messages.find(m => m?.role === 'system')?.content;
  const firstUser = messages.find(m => m?.role === 'user')?.content;
  const contentToHash = String(firstSystem || '') + '|' + String(firstUser || '');
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
  const newBody = { ...body };

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

  const modelLower = String(newBody.model || '').toLowerCase();
  const isOpenAiFamily = modelLower.startsWith('gpt-') || 
                         modelLower.startsWith('o1-') || 
                         modelLower.startsWith('o3-') || 
                         modelLower.includes('chatgpt') ||
                         modelLower.includes('gpt-4') ||
                         modelLower.includes('gpt-5');

  if (isOpenAiFamily) {
    const cleanedBody = stripCacheControl(newBody);
    cleanedBody.prompt_cache_retention = "24h";
    const cacheKey = getPromptCacheKey(cleanedBody.messages);
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

  if (!supportsExplicitCacheControl) {
    return stripCacheControl(newBody);
  }

  const cacheControlValue = { type: 'ephemeral', ttl: '1h' };
  if (providerName === 'zai') {
    newBody.clear_thinking = false;
  }
  if (Array.isArray(newBody.messages) && newBody.messages.length > 0) {
    const newMessages = [...newBody.messages];

    if (newMessages[0] && newMessages[0].role === 'system') {
      const msg = { ...newMessages[0] };
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControlValue }];
      } else if (Array.isArray(msg.content) && msg.content[0]) {
        msg.content = msg.content.map((part: any, idx: number) => 
          idx === 0 ? { ...part, cache_control: cacheControlValue } : part
        );
      }
      newMessages[0] = msg;
    }

    const targetIdx = newMessages.length - 2;
    if (targetIdx > 0 && newMessages[targetIdx]) {
      const msg = { ...newMessages[targetIdx] };
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: cacheControlValue }];
      } else if (Array.isArray(msg.content) && msg.content[0]) {
        msg.content = msg.content.map((part: any, idx: number) => 
          idx === 0 ? { ...part, cache_control: cacheControlValue } : part
        );
      }
      newMessages[targetIdx] = msg;
    }

    newBody.messages = newMessages;
  }

  if (modelLower.includes('kimi') || modelLower.includes('moonshot')) {
    const cacheKey = getPromptCacheKey(newBody.messages);
    if (cacheKey) {
      newBody.prompt_cache_key = cacheKey;
    }
  }

  return newBody;
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

  const provider = await loadProvider(target.providerName);
  if (!provider || !provider.baseUrl) {
    return {
      ok: false,
      error: {
        errorType: 'provider_not_found',
        providerName: target.providerName,
        actualModel: target.actualModel,
        message: `No suitable provider found for: ${target.providerName}.`
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
  const ZDR_ELIGIBLE_MODELS = new Set(['GLM-5.1', 'Kimi-K2.6', 'deepseek-v4-pro']);
  if (target.providerName === 'wafer-serverless' && waferZdrEnabled && ZDR_ELIGIBLE_MODELS.has(target.actualModel)) {
    providerHeaders['Wafer-ZDR'] = 'required';
  }
  if (target.providerName === 'openrouter' || target.providerName === 'openrouter-presets') {
    providerHeaders['X-OpenRouter-Cache'] = 'true';
  }

  const requestBody = {
    ...body,
    model: target.actualModel
  };
  const safeRequestBody = sanitizeProviderRequestBody(requestBody, {
    providerName: target.providerName,
    modelName: target.actualModel,
    thinkingLevel: getEffectiveThinkingLevel(target.providerName),
    applyProxyThinking: thinkingProxyEnabled
  });
  const compressedRequestBody = await compressWithHeadroom(safeRequestBody, target.actualModel);
  const cachedRequestBody = injectPromptCaching(compressedRequestBody, target.providerName);
  const finalBody = provider.formatBody ? provider.formatBody(cachedRequestBody) : cachedRequestBody;

  pushDiagnostic({
    event: 'proxy_request',
    route: requestRoute,
    provider: target.providerName,
    presentedModel: presentedModelName,
    actualModel: target.actualModel,
    stream,
    data: {
      outputFormat,
      targetModel: targetModelName,
      fallback: fallbackData || null,
      request: summarizeRequestForDiagnostics(finalBody)
    }
  });

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
      pushDiagnostic({
        event: 'proxy_response',
        route: requestRoute,
        provider: target.providerName,
        presentedModel: presentedModelName,
        actualModel: target.actualModel,
        stream,
        status: response.status,
        durationMs: Date.now() - attemptStartedAt,
        data: {
          ok: false,
          targetModel: targetModelName,
          fallback: fallbackData || null,
          upstreamErrorBytes: responseText.length,
          upstreamErrorPreview: sanitizeDiagnosticText(responseText, 260)
        }
      });
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
          pushDiagnostic({
            event: 'proxy_response',
            route: requestRoute,
            provider: target.providerName,
            presentedModel: presentedModelName,
            actualModel: target.actualModel,
            stream,
            status: response.status,
            durationMs: Date.now() - attemptStartedAt,
            data: {
              ok: false,
              targetModel: targetModelName,
              fallback: fallbackData || null,
              contentClassification: contentClass,
              upstreamErrorPreview: sanitizeDiagnosticText(responseBodyText, 260)
            }
          });
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
    pushDiagnostic({
      event: 'proxy_error',
      route: requestRoute,
      provider: target.providerName,
      presentedModel: presentedModelName,
      actualModel: target.actualModel,
      stream,
      status: 500,
      durationMs: Date.now() - attemptStartedAt,
      data: {
        targetModel: targetModelName,
        fallback: fallbackData || null,
        errorName: sanitizeDiagnosticText(String(error?.name || 'Error')),
        errorMessage: sanitizeDiagnosticText(String(error?.message || 'Proxy runtime failure'))
      }
    });

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
  diagnosticsExtra?: Record<string, unknown>,
  logTracker?: LogEntryTracker
) {
  const fetchResponse = success.response;

  if (stream) {
    pushDiagnostic({
      event: 'proxy_response',
      route: requestRoute,
      provider: success.providerName,
      presentedModel: model,
      actualModel: success.actualModel,
      stream: true,
      status: fetchResponse.status,
      durationMs: Date.now() - requestStartedAt,
      data: {
        ok: true,
        responseContentType: fetchResponse.headers.get('content-type') || 'unknown',
        ...(diagnosticsExtra || {})
      }
    });

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

  const upstreamData = await fetchResponse.json();
  const normalizedUpstream = normalizeGatewayChatCompletionBody(success.providerName, upstreamData);
  const data = stripReasoningMetadata(normalizedUpstream) as Record<string, unknown>;

  pushDiagnostic({
    event: 'proxy_response',
    route: requestRoute,
    provider: success.providerName,
    presentedModel: model,
    actualModel: success.actualModel,
    stream: false,
    status: fetchResponse.status,
    durationMs: Date.now() - requestStartedAt,
    data: {
      ok: true,
      response: summarizeResponseForDiagnostics(data),
      ...(diagnosticsExtra || {})
    }
  });

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

export function fallbackExecutionPlan(fallbackRoute: FallbackModel) {
  return buildWraparoundExecutionPlan(activeFallbackModels(fallbackRoute), FALLBACK_PRIMARY_ATTEMPTS);
}

async function handleChatCompletion(req: Request, res: Response, bodyOverrides?: any, options?: { outputFormat?: CompletionOutputFormat }) {
  const body = bodyOverrides || req.body;
  const { model, stream } = body;
  const requestStartedAt = Date.now();
  const requestRoute = req.path || '/v1/chat/completions';
  const outputFormat = options?.outputFormat || 'openai';

  if (!model) {
    return res.status(400).json({ error: 'Model is required in request body.' });
  }
  // Inject custom system prompt when enabled
  if (systemPromptConfig.enabled && systemPromptConfig.prompt && Array.isArray(body.messages)) {
    body.messages.unshift({ role: 'system', content: systemPromptConfig.prompt });
  }
  const rawClient = req.headers['x-local-router-client'];
  const clientName = typeof rawClient === 'string' ? rawClient : Array.isArray(rawClient) ? rawClient[0] : 'unknown';
  recordRequest(clientName, String(model));
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
      undefined,
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
    pushDiagnostic({
      event: 'proxy_error',
      route: requestRoute,
      provider: directModelResult.error.providerName,
      presentedModel: model,
      actualModel: directModelResult.error.actualModel,
      stream: Boolean(stream),
      status: directModelResult.error.status || 500,
      durationMs: Date.now() - requestStartedAt,
      data: {
        directModelFailure: {
          model,
          errorType: directModelResult.error.errorType,
          errorMessage: sanitizeDiagnosticText(directModelResult.error.message, 220)
        },
        cascadingToSystemFallback: sysFallback.id
      }
    });
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
  const plan = fallbackExecutionPlan(fallbackRoute);
  const attemptLog: Array<Record<string, unknown>> = [];
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

    await failoverPreserveSessionContext(presentedModel, stage.model);
    const preservedBody = buildFailoverPreservedBody(body, stage.model);

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
          {
            fallback: {
              route: fallbackRoute.id,
              usedTargetModel: stage.model,
              stage: stage.stage,
              attempt,
              stageAttempts: stage.attempts,
              totalFailedAttemptsBeforeSuccess: attemptLog.length
            }
          },
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

      if (attempt < stage.attempts) {
        const waitSeconds = fallbackRetryDelaySeconds(attempt);
        entry.waitBeforeRetrySeconds = waitSeconds;
        pushDiagnostic({
          event: 'proxy_error',
          route: requestRoute,
          provider: result.error.providerName,
          presentedModel,
          actualModel: result.error.actualModel,
          stream: Boolean(stream),
          status: result.error.status || 500,
          durationMs: Date.now() - requestStartedAt,
          data: {
            fallback: fallbackData,
            waitBeforeRetrySeconds: waitSeconds,
            errorType: result.error.errorType,
            errorMessage: sanitizeDiagnosticText(result.error.message, 220),
            providerErrorPreview: sanitizeDiagnosticText(result.error.responseText || '', 180)
          }
        });
        attemptLog.push(entry);
        await waitMs(waitSeconds * 1000);
      } else {
        attemptLog.push(entry);
      }
    }
  }

  const terminalFailure = lastFailure as AttemptFailure | null;

  pushDiagnostic({
    event: 'proxy_error',
    route: requestRoute,
    provider: terminalFailure?.providerName,
    presentedModel,
    actualModel: terminalFailure?.actualModel,
    stream: Boolean(stream),
    status: terminalFailure?.status || 502,
    durationMs: Date.now() - requestStartedAt,
    data: {
      fallbackRoute: fallbackRoute.id,
      exhausted: true,
      attempts: attemptLog.length
    }
  });

  const status = terminalFailure?.status || 502;
  if (logTracker) {
    logTracker.onFailure(
      status,
      terminalFailure?.errorType || 'fallback_exhaustion',
      terminalFailure?.message || `Fallback model "${fallbackRoute.id}" exhausted all configured targets.`
    );
    logTracker.onFinish(Date.now() - requestStartedAt);
  }
  return res.status(status).json({
    error: `Fallback model "${fallbackRoute.id}" exhausted all configured targets.`,
    fallback: {
      id: fallbackRoute.id,
      configuredTargets: fallbackRoute.models,
      terminalErrorType: terminalFailure?.errorType || null,
      terminalErrorMessage: terminalFailure?.message || null,
      attempts: attemptLog
    }
  });
}

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  await handleChatCompletion(req, res);
});

function chatCompletionToAnthropicResponse(chatData: any): any {
  const choice = chatData?.choices?.[0] || {};
  const message = choice.message || {};
  const content: any[] = [];

  if (message.content) {
    content.push({
      type: 'text',
      text: message.content
    });
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || '{}');
      } catch {
        input = { value: tc.function?.arguments };
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function?.name,
        input
      });
    }
  }

  let stopReason: string | null = 'end_turn';
  if (choice.finish_reason === 'length') stopReason = 'max_tokens';
  else if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use';
  else if (choice.finish_reason === 'stop') stopReason = 'end_turn';

  const usage = chatData?.usage || {};

  return {
    id: `msg_${chatData?.id || cryptoRandomId()}`,
    type: 'message',
    role: 'assistant',
    model: chatData?.model || 'claude-3-5-sonnet',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0
    }
  };
}

app.post('/v1/messages', async (req: Request, res: Response) => {
  const body = req.body || {};

  if (!body.model) {
    return res.status(400).json({
      error: { type: 'invalid_request_error', message: 'model is required' }
    });
  }

  const chatBody: any = {
    model: body.model,
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
    const systemText = body.system
      .map((part: any) => (typeof part === 'string' ? part : part.text || ''))
      .join('\n');
    if (systemText.trim()) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = msg.role;
      let content = msg.content;
      if (Array.isArray(content)) {
        content = content.map((part: any) => {
          if (part.type === 'text') {
            return { type: 'text', text: part.text };
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
      }
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
            })}`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`);
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
                  model: data.model || 'claude-3-5-sonnet',
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: 0 }
                }
              })}`);
              messageStarted = true;
            }

            if (delta.content) {
              if (!contentBlockStarted) {
                res.write(`event: content_block_start\ndata: ${JSON.stringify({
                  type: 'content_block_start',
                  index: textIndex,
                  content_block: { type: 'text', text: '' }
                })}`);
                contentBlockStarted = true;
              }
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: textIndex,
                delta: { type: 'text_delta', text: delta.content }
              })}`);
            }

            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
              if (contentBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: textIndex
                })}`);
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
              })}`);
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
          const anthropicMsg = chatCompletionToAnthropicResponse(data);
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

app.post('/v1/responses', async (req: Request, res: Response) => {
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

app.get('/v1/models', async (req: Request, res: Response) => {
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
  const modelName = typeof req.body?.model === 'string'
    ? req.body.model.trim()
    : typeof req.body?.name === 'string'
      ? req.body.name.trim()
      : '';

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
  // Translate Ollama req -> OpenAI request
  const openAiReq: any = {
    model: req.body.model,
    messages: ollamaMessagesToOpenAI(Array.isArray(req.body.messages) ? req.body.messages : []),
    stream: req.body.stream !== false
  };
  applyOllamaRequestOptions(openAiReq, req.body);

  await handleChatCompletion(req, res, openAiReq, { outputFormat: 'ollama_chat' });
});

// POST /api/generate
app.post('/api/generate', async (req: Request, res: Response) => {
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
loadSessions();
loadFeedback();
loadPqcSecrets();

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
const shouldServe = isMainModule() || process.env.LOCAL_ROUTER_FORCE_SERVE === 'true';

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
