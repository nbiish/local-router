import express, { Request, Response } from 'express';
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
import { computeTiers } from './tiers';
import { buildWraparoundExecutionPlan } from './execution-plan';
import { stableSortModelIdsByRoutingExhaustion } from './routing-exhaustion-order';
import {
  applyPricingToRouterCandidates,
  deleteProviderPricingEntry,
  getProviderPricingSnapshot,
  loadProviderPricingStore,
  resolveEffectiveCandidatePricing,
  upsertProviderPricingEntry
} from './provider-pricing';
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
  gatewayModelAllowedForRouter,
  gatewayModelCatalogDisplay,
  gatewayPresentedModelId,
  gatewayPresentedModelSegment,
  resolveGatewayPresentedLegacyId
} from './gateway-provider-catalog';
import { registerConfigApiRoutes } from './routes/config-api';
import { loadRouterSettings, saveRouterSettings } from './config-persistence';
import { normalizeGatewayChatCompletionBody } from './gateway-response';
import {
  DEFAULT_FALLBACK_ORDERED_IDS,
  buildDefaultAutoRouterCandidateLines,
  buildDefaultFallbackModelIds,
  buildDefaultFallbackModelsText,
  isAllowedAutoRouterGatewayFreeModel
} from './routing-defaults';
import {
  DEFAULT_OLLAMA_API_KEY,
  ensureDefaultOllamaApiKey,
  isOllamaPlaceholderKey,
  isRealOllamaComApiKey,
  resolveOllamaApiKey
} from './ollama-keys';

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

type RouterType = 'priority' | 'pareto-code' | 'auto-local' | 'bandit-local';

type BanditState = {
  A: number[][];
  b: number[];
  gamma: number;
  sampleCount: number;
};

type RouterCandidate = {
  model: string;
  codingScore?: number;
  inputPrice?: number;
  outputPrice?: number;
  latencyMs?: number;
  notes?: string;
  enabled?: boolean;
};

export type RouterModel = {
  id: string;
  type: RouterType;
  candidates: RouterCandidate[];
  minCodingScore?: number;
  costQualityTradeoff?: number;
  explorationBudget?: number;
  enableAutoTiers?: boolean;
  banditState?: Record<string, BanditState>;
};

export type RouterModelParseResult =
  | { ok: true; model: RouterModel }
  | { ok: false; error: string };

type RouterDecision = {
  router: RouterModel;
  selected: RouterCandidate;
  orderedCandidates: RouterCandidate[];
  candidateScores: Array<Record<string, unknown>>;
};

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
const DEFAULT_OUTPUT_TOKENS = 4096;
const FALLBACK_PROVIDER_NAME = 'local-router';
const FALLBACK_PROVIDER_LEGACY_NAMES = ['fvs-code', 'fallback'];
const FALLBACK_PRIMARY_ATTEMPTS = 3;
const LOCAL_ROUTER_CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
const LEGACY_FVS_CONFIG_DIR = path.join(os.homedir(), '.config', 'fvs-code');
const FALLBACK_MODELS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'fallback-models.json');
const LEGACY_FALLBACK_MODELS_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'fallback-models.json');
const ROUTER_MODELS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'router-models.json');
const LEGACY_ROUTER_MODELS_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'router-models.json');
const SYSTEM_PROMPT_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'system-prompt.json');
const LEGACY_SYSTEM_PROMPT_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'system-prompt.json');
const THINKING_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'thinking-config.json');
const LEGACY_THINKING_CONFIG_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'thinking-config.json');
const ROUTER_EVENTS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'router-events.csv');
const LEGACY_ROUTER_EVENTS_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'router-events.csv');
const PROVIDER_MODELS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'provider-models.json');
const LEGACY_PROVIDER_MODELS_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'provider-models.json');
const MODEL_SOURCE_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'model-source-config.json');
const LEGACY_MODEL_SOURCE_CONFIG_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'model-source-config.json');
const ENDPOINT_MODELS_CACHE_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'endpoint-models-cache.json');
const LEGACY_ENDPOINT_MODELS_CACHE_PATH = path.join(LEGACY_FVS_CONFIG_DIR, 'endpoint-models-cache.json');
const CUSTOM_PROVIDERS_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'custom-providers.json');
const WAFER_CONFIG_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'wafer-config.json');
const RESERVED_PROVIDER_SLUGS = new Set([
  FALLBACK_PROVIDER_NAME,
  ...FALLBACK_PROVIDER_LEGACY_NAMES,
  'provider'
]);
const PROVIDER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const PROVIDER_KEY_ENV_PATTERN = /^[A-Z0-9_]+_API_KEY$/;
const MAX_PROVIDER_SLUG_LENGTH = 48;
const DEFAULT_ROUTER_TYPE: RouterType = 'auto-local';
const DEFAULT_ROUTER_MIN_CODING_SCORE = 0.66;
const DEFAULT_ROUTER_COST_QUALITY_TRADEOFF = 7;
const ROUTER_CANDIDATE_RETRIES = 2;
const SYSTEM_FALLBACK_ROUTE_ID = 'fallback-models';
const DEFAULT_ROUTER_ID = 'auto-router-main';
const LEGACY_ROUTER_ROUTE_ALIASES: Record<string, string> = {
  'auto-local-main': 'auto-router-main'
};
/**
 * Provider sub-order within a routing exhaustion band.
 * Free vs paid placement uses `routing-exhaustion-order.ts` (Kilo/Cline free early; Kilo/Cline paid before OpenCode paid).
 */
const DEFAULT_PROVIDER_TIER_ORDER = [
  'ollama',
  'kilo',
  'cline',
  'nvidia-nim',
  'modal',
  'nebius',
  'opencode-zen',
  'opencode-go',
  'zai',
  'xiaomi-mimo',
  'wafer-serverless',
  'zenmux',
  'openrouter-presets'
] as const;

const PRESENTATION_PREFIX_TO_PROVIDER: Record<string, string> = {
  ollama: 'ollama',
  kilo: 'kilo',
  cline: 'cline',
  'nvidia-nim': 'nvidia-nim',
  modal: 'modal',
  nebius: 'nebius',
  'opencode-zen': 'opencode-zen',
  'opencode-go': 'opencode-go',
  opencode: 'opencode-go',
  zai: 'zai',
  'xiaomi-mimo': 'xiaomi-mimo',
  'wafer-ai': 'wafer-serverless',
  'wafer-serverless': 'wafer-serverless',
  zenmux: 'zenmux',
  openrouter: 'openrouter-presets',
  'openrouter-presets': 'openrouter-presets'
};

function resolvedDefaultAutoRouterCandidatesText(): string {
  return buildDefaultAutoRouterCandidateLines(catalogRefForPresentedModel).join('\n');
}

const LEGACY_AUTO_LOCAL_MAIN_MODELS = new Set([
  'openrouter-1-million-chain-of-draft',
  'openrouter-chain-of-draft',
  'openrouter-openrouter-personal-router',
  'openrouter-1-million-main',
  'openrouter-free-chain-of-draft'
]);

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
  'opencode/kimi-k2.6': 'opencode-go-kimi-k2.6',
  'opencode-go/kimi-k2.6': 'opencode-go-kimi-k2.6',
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
  'opencode-code-kimi-k2.6': 'opencode-go-kimi-k2.6',
  'opencode-code-glm-5.1': 'opencode-go-glm-5.1',
  'opencode-code-deepseek-v4-pro': 'opencode-go-deepseek-v4-pro',
  'opencode-code-deepseek-v4-flash': 'opencode-go-deepseek-v4-flash',
  'opencode-code-qwen3.7-max': 'opencode-go-qwen3.7-max',
  'opencode-code-mimo-v2.5-pro': 'opencode-go-mimo-v2.5-pro',
  'opencode-code-mimo-v2.5': 'opencode-go-mimo-v2.5',
  'opencode-kimi-k2.6': 'opencode-go-kimi-k2.6',
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
  'wafer-serverless/deepseek-v4-flash': 'wafer-ai-deepseek-v4-flash',
  'wafer-serverless/MiniMax-M3': 'wafer-ai-minimax-m3',
  'wafer-serverless/minimax-m3': 'wafer-ai-minimax-m3',
  'openrouter-presets/openrouter/free': 'openrouter-free',
  'openrouter-presets/deepseek/deepseek-v4-flash': 'openrouter-deepseek-v4-flash',
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
  'kilo/moonshotai/kimi-k2.6': 'kilo-moonshotai-kimi-k2.6-paid'
};

function providerTierIndex(providerSlug: string): number {
  const index = DEFAULT_PROVIDER_TIER_ORDER.indexOf(providerSlug as typeof DEFAULT_PROVIDER_TIER_ORDER[number]);
  return index >= 0 ? index : DEFAULT_PROVIDER_TIER_ORDER.length;
}

function inferProviderSlugFromPresentedId(modelId: string): string | null {
  const trimmed = String(modelId || '').trim();
  if (!trimmed) return null;

  const normalized = trimmed.toLowerCase();
  const prefixes = Object.keys(PRESENTATION_PREFIX_TO_PROVIDER)
    .sort((left, right) => right.length - left.length);
  for (const prefix of prefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}-`)) {
      return PRESENTATION_PREFIX_TO_PROVIDER[prefix];
    }
  }

  return null;
}

function catalogRefForPresentedModel(modelId: string) {
  const match = findProviderModel(modelId);
  return match ? { provider: match.provider, model: match.model } : undefined;
}

function stableSortModelIdsByProviderTier(modelIds: string[]): string[] {
  return stableSortModelIdsByRoutingExhaustion(modelIds, catalogRefForPresentedModel);
}

function orderEligibleRouterEntriesByExhaustion<T extends { candidate: RouterCandidate }>(entries: T[]): T[] {
  const tierOrder = stableSortModelIdsByRoutingExhaustion(
    entries.map((entry) => entry.candidate.model),
    catalogRefForPresentedModel
  );
  const byModel = new Map(entries.map((entry) => [entry.candidate.model, entry]));
  return tierOrder
    .map((modelId) => byModel.get(modelId))
    .filter((entry): entry is T => Boolean(entry));
}

function defaultFallbackModelIds(): string[] {
  // No catalog lookup at module init (findProviderModel needs modelSourceConfig).
  return buildDefaultFallbackModelIds(() => undefined);
}

const DEFAULT_FALLBACK_MODELS_TEXT = buildDefaultFallbackModelsText(() => undefined);

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
const parsedPort = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
  ? parsedPort
  : DEFAULT_PORT;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// In-memory Key Store
const keyStore: Record<string, string> = {};
const modelStore: Record<string, ProviderModel[]> = {};
const persistedProviderModelOverrides = new Set<string>();
let customProviderStore: CustomProviderRecord[] = [];
const fallbackModelStore: Record<string, FallbackModel> = {};
const routerModelStore: Record<string, RouterModel> = {};
const modelSourceConfig: { source: 'custom' | 'endpoints' } = { source: 'custom' };
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

function readCatalogProviderSummaries(): ProviderSummary[] {
  const providersPath = path.resolve(process.cwd(), 'providers.txt');

  try {
    const content = fs.readFileSync(providersPath, 'utf8');
    const summaries: ProviderSummary[] = [];

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('# │')) continue;

      const columns = line
        .replace(/^#\s*/, '')
        .split('│')
        .map((part) => part.trim())
        .filter(Boolean);

      if (columns.length !== 3) continue;

      const [name, endpoint, keyEnvVar] = columns;
      if (!name || !endpoint || !keyEnvVar) continue;
      if (name.toLowerCase() === 'provider') continue;
      if (!PROVIDER_KEY_ENV_PATTERN.test(keyEnvVar)) continue;
      if (!/^https?:\/\//.test(endpoint)) continue;

      summaries.push({
        name,
        endpoint,
        keyEnvVar,
        defaultTool: '',
        source: 'catalog'
      });
    }

    return summaries;
  } catch (error) {
    console.error('Failed to read providers.txt provider summary table:', error);
    return [];
  }
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
    return { ok: false, error: `provider id "${trimmed}" already exists in providers.txt.` };
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

  for (const router of Object.values(routerModelStore)) {
    for (const candidate of router.candidates) {
      if (candidate.model === providerName || candidate.model.startsWith(prefix)) {
        references.push(`router:${router.id}`);
      }
      const resolved = resolveModelTarget(candidate.model);
      if (resolved?.providerName === providerName) {
        references.push(`router:${router.id}`);
      }
    }
  }

  return Array.from(new Set(references));
}

function getProviderSummary(name: string): ProviderSummary | undefined {
  return allProviderSummaries().find((provider) => provider.name === name);
}

function cloneProviderModel(model: ProviderModel): ProviderModel {
  return {
    ...model
  };
}

function baselineProviderModels(providerName: string): ProviderModel[] {
  if (isCustomProvider(providerName)) {
    return [];
  }
  return readProviderModels()
    .filter((model) => model.provider === providerName)
    .map((model) => cloneProviderModel(model));
}

function editableProviderModels(providerName: string): ProviderModel[] {
  if (!modelStore[providerName]) {
    modelStore[providerName] = baselineProviderModels(providerName);
  }
  return modelStore[providerName];
}

function effectiveProviderModels(providerName: string): ProviderModel[] {
  return modelStore[providerName] || readProviderModels().filter((model) => model.provider === providerName);
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

function providerConfigs() {
  return allProviderSummaries().map((provider) => {
    const hasMemoryKey = Boolean(keyStore[provider.name]);
    const hasEnvKey = Boolean(process.env[provider.keyEnvVar]);
    const ollamaPlaceholder = provider.name === 'ollama'
      && isOllamaPlaceholderKey(keyStore.ollama || process.env.OLLAMA_API_KEY);
    const configured = provider.name === 'ollama' || hasMemoryKey || hasEnvKey;
    let configuredSource: string;
    if (provider.name === 'ollama' && ollamaPlaceholder) {
      configuredSource = 'default';
    } else if (hasMemoryKey) {
      configuredSource = 'memory';
    } else if (hasEnvKey) {
      configuredSource = 'env';
    } else {
      configuredSource = 'none';
    }
    const models = effectiveProviderModels(provider.name);
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
  const segment = modelAliasSegment(modelName);
  return `${providerPresentationPrefix(providerName)}-${segment || 'model'}`;
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

export function parseFallbackModel(payload: any): FallbackModelParseResult {
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

  if (entries.length === 0) {
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

  if (models.length < 2) {
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

function normalizeRouterRouteId(value: string) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (LEGACY_ROUTER_ROUTE_ALIASES[trimmed]) {
    return LEGACY_ROUTER_ROUTE_ALIASES[trimmed];
  }
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

function validateRouteId(routeType: 'Fallback' | 'Router', id: string) {
  if (!id) return `${routeType} model id is required.`;
  if (id.length > 512) return `${routeType} model id is too long: ${id.slice(0, 64)}`;
  if (!/^[A-Za-z0-9@._:\/+-]+$/.test(id)) return `${routeType} model id contains unsupported characters: ${id}`;
  if (id.includes('/')) return `${routeType} model id must be a single route name or ${FALLBACK_PROVIDER_NAME}/route-name.`;
  return '';
}

function parseRouterType(value: unknown): RouterType {
  if (value === 'pareto-code' || value === 'auto-local' || value === 'priority' || value === 'bandit-local') return value;
  return DEFAULT_ROUTER_TYPE;
}

function parseBoundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function parseRouterCandidateLine(line: string): RouterCandidate | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const [modelPart, ...metadataParts] = trimmed.split(',').map((part) => part.trim());
  if (!modelPart) return null;

  const candidate: RouterCandidate = { model: modelPart, enabled: true };
  for (const part of metadataParts) {
    const [rawKey, ...rawValueParts] = part.split('=');
    const key = rawKey.trim().toLowerCase();
    const value = rawValueParts.join('=').trim();
    if (!key || !value) continue;
    if (key === 'coding' || key === 'coding_score' || key === 'score') {
      candidate.codingScore = parseBoundedNumber(value, 0, 1);
    } else if (key === 'input' || key === 'input_price') {
      candidate.inputPrice = parseBoundedNumber(value, 0, Number.MAX_SAFE_INTEGER);
    } else if (key === 'output' || key === 'output_price') {
      candidate.outputPrice = parseBoundedNumber(value, 0, Number.MAX_SAFE_INTEGER);
    } else if (key === 'latency' || key === 'latency_ms') {
      candidate.latencyMs = parseBoundedNumber(value, 0, Number.MAX_SAFE_INTEGER);
    } else if (key === 'notes') {
      candidate.notes = sanitizeDiagnosticText(value, 120);
    } else if (key === 'enabled') {
      const lowerValue = value.toLowerCase();
      candidate.enabled = lowerValue !== 'false' && lowerValue !== '0' && lowerValue !== 'no';
    }
  }

  return candidate;
}

export function parseRouterModel(payload: any): RouterModelParseResult {
  const rawId = typeof payload?.id === 'string' ? payload.id.trim() : '';
  const id = normalizeRouterRouteId(rawId);
  const routeError = validateRouteId('Router', id);
  if (routeError) return { ok: false, error: routeError };

  const type = parseRouterType(payload?.type);
  const rawCandidates = payload?.candidatesText !== undefined ? payload.candidatesText : payload?.candidates;
  const entries = Array.isArray(rawCandidates)
    ? rawCandidates
    : typeof rawCandidates === 'string'
      ? rawCandidates.split(/\r?\n|;/)
      : [];

  if (entries.length === 0) {
    return { ok: false, error: 'Router candidates must be a non-empty array or newline-delimited string.' };
  }

  const seen = new Set<string>();
  const candidates: RouterCandidate[] = [];
  for (const entry of entries) {
    const candidate = typeof entry === 'string'
      ? parseRouterCandidateLine(entry)
      : entry && typeof entry === 'object'
        ? {
            model: typeof entry.model === 'string' ? entry.model.trim() : '',
            codingScore: parseBoundedNumber(entry.codingScore, 0, 1),
            inputPrice: parseBoundedNumber(entry.inputPrice, 0, Number.MAX_SAFE_INTEGER),
            outputPrice: parseBoundedNumber(entry.outputPrice, 0, Number.MAX_SAFE_INTEGER),
            latencyMs: parseBoundedNumber(entry.latencyMs, 0, Number.MAX_SAFE_INTEGER),
            notes: typeof entry.notes === 'string' ? sanitizeDiagnosticText(entry.notes, 120) : undefined,
            enabled: entry.enabled !== false
          }
        : null;
    if (!candidate || !candidate.model) continue;
    if (candidate.model.length > 512) {
      return { ok: false, error: `Router candidate model is too long: ${candidate.model.slice(0, 64)}` };
    }
    if (!/^[A-Za-z0-9@._:\/+-]+$/.test(candidate.model)) {
      return { ok: false, error: `Router candidate model contains unsupported characters: ${candidate.model}` };
    }
    if (seen.has(candidate.model)) continue;
    seen.add(candidate.model);
    candidates.push(candidate);
  }

  if (candidates.length === 0) {
    return { ok: false, error: 'Router requires at least one unique candidate model.' };
  }

  return {
    ok: true,
    model: {
      id,
      type,
      candidates,
      minCodingScore: parseBoundedNumber(payload?.minCodingScore, 0, 1) ?? DEFAULT_ROUTER_MIN_CODING_SCORE,
      costQualityTradeoff: parseBoundedNumber(payload?.costQualityTradeoff, 0, 10) ?? DEFAULT_ROUTER_COST_QUALITY_TRADEOFF,
      explorationBudget: parseBoundedNumber(payload?.explorationBudget, 0, 1) ?? 0.05,
      enableAutoTiers: payload?.enableAutoTiers === true || payload?.enableAutoTiers === 'true',
      banditState: type === 'bandit-local' ? (payload?.banditState || {}) : undefined
    }
  };
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
    [LEGACY_ROUTER_MODELS_PATH, ROUTER_MODELS_PATH],
    [LEGACY_PROVIDER_MODELS_PATH, PROVIDER_MODELS_PATH],
    [LEGACY_ROUTER_EVENTS_PATH, ROUTER_EVENTS_PATH]
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

function cloneRouterModel(model: RouterModel): RouterModel {
  const cloned: RouterModel = {
    id: model.id,
    type: model.type,
    candidates: model.candidates.map((candidate) => ({ ...candidate })),
    minCodingScore: model.minCodingScore,
    costQualityTradeoff: model.costQualityTradeoff,
    explorationBudget: model.explorationBudget
  };
  if (model.banditState) {
    cloned.banditState = {};
    for (const [key, state] of Object.entries(model.banditState)) {
      cloned.banditState[key] = {
        A: state.A.map((row) => [...row]),
        b: [...state.b],
        gamma: state.gamma,
        sampleCount: state.sampleCount
      };
    }
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
      const parsedRoute = parseFallbackModel(entry);
      if (!parsedRoute.ok) continue;

      const referenceCheck = validateFallbackReferences(parsedRoute.model);
      if (!referenceCheck.ok) continue;

      fallbackModelStore[parsedRoute.model.id] = cloneFallbackModel(parsedRoute.model);
    }
  } catch (error: any) {
    console.error('Failed to load persisted fallback routes:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function persistRouterModels() {
  ensureLocalRouterConfigDir();
  const routers = Object.values(routerModelStore)
    .map((model) => cloneRouterModel(model))
    .sort((a, b) => a.id.localeCompare(b.id));
  const payload = {
    version: 1,
    routers
  };
  const temporaryPath = `${ROUTER_MODELS_PATH}.${process.pid}.tmp`;

  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, ROUTER_MODELS_PATH);
  fs.chmodSync(ROUTER_MODELS_PATH, 0o600);
}

function loadPersistedRouterModels() {
  const persistedPath = existingPath(ROUTER_MODELS_PATH, LEGACY_ROUTER_MODELS_PATH);
  if (!fs.existsSync(persistedPath)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(persistedPath, 'utf8'));
    const entries = Array.isArray(parsed?.routers)
      ? parsed.routers
      : Array.isArray(parsed)
        ? parsed
        : [];

    for (const entry of entries) {
      const parsedRoute = parseRouterModel(entry);
      if (!parsedRoute.ok) continue;

      const referenceCheck = validateRouterReferences(parsedRoute.model);
      if (!referenceCheck.ok) continue;

      const model = cloneRouterModel(parsedRoute.model);
      model.candidates = applyPricingToRouterCandidates(model.candidates);
      routerModelStore[parsedRoute.model.id] = model;
    }
  } catch (error: any) {
    console.error('Failed to load persisted router routes:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}
function loadPersistedRouterSettings() {
  try {
    const settings = loadRouterSettings();
    if (!settings || typeof settings !== 'object') return;
    if (typeof settings.fallbackModelsText === 'string' && settings.fallbackModelsText.trim()) {
      const text = settings.fallbackModelsText.trim();
      const entries = text.split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean);
      if (entries.length >= 2) {
        fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID] = {
          id: SYSTEM_FALLBACK_ROUTE_ID,
          models: entries
        };
      }
    }
    if (typeof settings.autoRouterCandidatesText === 'string' && settings.autoRouterCandidatesText.trim()) {
      const text = settings.autoRouterCandidatesText.trim();
      const entries = text.split(/\r?\n|;/).map((line) => line.trim()).filter(Boolean);
      if (entries.length >= 2 && routerModelStore[DEFAULT_ROUTER_ID]) {
        routerModelStore[DEFAULT_ROUTER_ID] = {
          ...routerModelStore[DEFAULT_ROUTER_ID],
          candidates: entries.map((model) => ({ model, enabled: true }))
        };
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
    console.log('[catalog] Merged new providers.txt models into persisted provider overrides.');
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
      const providerName = String(entry?.provider || '').trim();
      if (!providerName) continue;
      const modelList = Array.isArray(entry?.models) ? entry.models : [];
      if (modelList.length === 0) continue;

      modelStore[providerName] = modelList.map((raw: any) => ({
        id: String(raw?.id || ''),
        provider: String(raw?.provider || providerName),
        model: String(raw?.model || ''),
        display: String(raw?.display || ''),
        contextLength: Number.isInteger(raw?.contextLength) ? raw.contextLength : DEFAULT_CONTEXT_LENGTH,
        outputTokens: Number.isInteger(raw?.outputTokens) ? raw.outputTokens : DEFAULT_OUTPUT_TOKENS,
        supportsTools: Boolean(raw?.supportsTools),
        supportsImages: Boolean(raw?.supportsImages),
        supportsCache: Boolean(raw?.supportsCache),
        supportsReasoning: Boolean(raw?.supportsReasoning)
      }));
      persistedProviderModelOverrides.add(providerName);
    }
  } catch (error: any) {
    console.error('Failed to load persisted provider models:', sanitizeDiagnosticText(String(error?.message || error)));
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
  rawModels: Array<{ id: string }>
): ProviderModel[] {
  const baselineModels = readProviderModels();
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

    providerModels.push({
      id: presentedId,
      provider: providerName,
      model: modelId,
      display: providerModelDisplay(providerName, modelId),
      contextLength: DEFAULT_CONTEXT_LENGTH,
      outputTokens: DEFAULT_OUTPUT_TOKENS,
      supportsTools: true,
      supportsImages: false,
      supportsCache: false,
      supportsReasoning: false
    });
  }

  return providerModels;
}

async function fetchLiveProviderModels(providerName: string): Promise<Array<{ id: string; object: string; owned_by: string }>> {
  if (providerName === 'ollama') {
    const mod = await import('./providers/ollama');
    return mod.fetchLiveOllamaModels();
  }

  try {
    const mod = await import(`./providers/${providerName}`);
    const provider = mod.default || mod;
    if (provider?.getModels) {
      return provider.getModels();
    }
  } catch {
    // Fall through to generic upstream loader.
  }

  const summary = getProviderSummary(providerName);
  if (!summary) {
    return [];
  }

  const key = keyStore[summary.name] || process.env[summary.keyEnvVar];
  if (key) {
    try {
      const url = providerBaseUrl(summary);
      const response = await fetch(`${url}/models`, {
        headers: {
          Authorization: `Bearer ${key}`
        },
        signal: AbortSignal.timeout(6000)
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.data)) {
          return data.data.map((model: any) => ({
            id: model.id,
            object: 'model',
            owned_by: summary.name
          }));
        }
      }
    } catch (error) {
      console.error(`Failed to fetch models from endpoint for provider ${providerName}:`, error);
    }
  }

  return effectiveProviderModels(summary.name).map((model) => ({
    id: model.model,
    object: 'model',
    owned_by: summary.name
  }));
}

async function queryAllProviderEndpoints(): Promise<ProviderModel[]> {
  const providers = allProviderSummaries();
  const results = await Promise.all(
    providers.map(async (providerSummary) => {
      try {
        const rawModels = await fetchLiveProviderModels(providerSummary.name);
        return mapLiveRawModelsToCatalog(providerSummary.name, rawModels);
      } catch (err) {
        console.error(`Error querying models for provider ${providerSummary.name}:`, err);
        return [];
      }
    })
  );
  return results.flat();
}

type CatalogResolveOptions = {
  provider?: string;
  mode?: 'custom' | 'endpoints';
  live?: boolean;
};

async function resolveCatalogModels(options: CatalogResolveOptions = {}): Promise<ProviderModel[]> {
  const mode = options.mode ?? modelSourceConfig.source;
  const live = Boolean(options.live);
  const providerFilter = String(options.provider || '').trim();
  const endpointsActive = mode === 'endpoints' && endpointModelsCache.length > 0;

  if (live) {
    if (mode === 'custom' && !providerFilter) {
      return modelPresentationList();
    }
    if (providerFilter) {
      if (isLocalRouterProviderName(providerFilter)) {
        return [...fallbackModelList(), ...routerModelList()];
      }
      const rawModels = await fetchLiveProviderModels(providerFilter);
      return mapLiveRawModelsToCatalog(providerFilter, rawModels);
    }
    if (!endpointsActive) {
      return modelPresentationList();
    }
    return queryAllProviderEndpoints();
  }

  if (endpointsActive) {
    if (providerFilter) {
      if (isLocalRouterProviderName(providerFilter)) {
        return [...fallbackModelList(), ...routerModelList()];
      }
      return endpointModelsCache.filter((model) => model.provider === providerFilter);
    }
    return endpointModelsCache;
  }

  if (providerFilter) {
    if (isLocalRouterProviderName(providerFilter)) {
      return [...fallbackModelList(), ...routerModelList()];
    }
    return effectiveProviderModels(providerFilter);
  }

  return modelPresentationList();
}

function providerCatalogModels(): ProviderModel[] {
  if (modelSourceConfig.source === 'endpoints' && endpointModelsCache.length > 0) {
    return endpointModelsCache;
  }
  return modelPresentationList();
}

async function discoveryModelList(live = false): Promise<ProviderModel[]> {
  if (live) {
    const upstream = await resolveCatalogModels({ live: true });
    const seen = new Set<string>();
    const merged: ProviderModel[] = [];
    for (const model of [...upstream, ...fallbackModelList(), ...routerModelList()]) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      merged.push(model);
    }
    return merged;
  }
  return [...providerCatalogModels(), ...fallbackModelList(), ...routerModelList()];
}

function openAIModelEntry(model: ProviderModel) {
  return {
    id: model.id,
    object: 'model',
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

  const [providerName, ...actualModelParts] = modelName.split('/');
  const actualModel = actualModelParts.join('/');
  if (!providerName || !actualModel) {
    return null;
  }

  return {
    providerName,
    actualModel
  };
}

function fallbackModelPresentation(model: FallbackModel): ProviderModel {
  const firstTarget = model.models[0];
  const firstResolved = firstTarget ? findProviderModel(firstTarget) : undefined;
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

function routerPresentedModelId(model: RouterModel | string) {
  const routeId = typeof model === 'string' ? normalizeRouterRouteId(model) : normalizeRouterRouteId(model.id);
  return `${FALLBACK_PROVIDER_NAME}/${routeId}`;
}

function routerModelPresentation(model: RouterModel): ProviderModel {
  const firstTarget = model.candidates[0]?.model;
  const firstResolved = firstTarget ? findProviderModel(firstTarget) : undefined;
  const routeId = normalizeRouterRouteId(model.id);
  const presentedId = routerPresentedModelId(routeId);

  return {
    id: presentedId,
    provider: FALLBACK_PROVIDER_NAME,
    model: routeId,
    display: `${presentedId}: ${model.type} router over ${model.candidates.map((candidate) => candidate.model).join(' | ')}`,
    contextLength: firstResolved?.contextLength || DEFAULT_CONTEXT_LENGTH,
    outputTokens: firstResolved?.outputTokens || DEFAULT_OUTPUT_TOKENS,
    supportsTools: model.candidates.some((candidate) => findProviderModel(candidate.model)?.supportsTools),
    supportsImages: model.candidates.some((candidate) => findProviderModel(candidate.model)?.supportsImages),
    supportsCache: model.candidates.some((candidate) => findProviderModel(candidate.model)?.supportsCache),
    supportsReasoning: false
  };
}

function fallbackModelList() {
  return Object.values(fallbackModelStore)
    .map((model) => fallbackModelPresentation(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function routerModelList() {
  return Object.values(routerModelStore)
    .map((model) => routerModelPresentation(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function presentedModelList() {
  return [...activeProviderModelList(), ...fallbackModelList(), ...routerModelList()];
}

function findFallbackModel(modelName: string): FallbackModel | undefined {
  if (typeof modelName !== 'string') return undefined;
  const routeId = normalizeFallbackRouteId(modelName);
  const direct = fallbackModelStore[routeId];
  if (direct) return direct;
  return Object.values(fallbackModelStore).find((entry) => normalizeFallbackRouteId(entry.id) === routeId);
}

function findRouterModel(modelName: string): RouterModel | undefined {
  if (typeof modelName !== 'string') return undefined;
  const routeId = normalizeRouterRouteId(stripOllamaLatestSuffix(modelName));
  const direct = routerModelStore[routeId];
  if (direct) return direct;
  return Object.values(routerModelStore).find((entry) => normalizeRouterRouteId(entry.id) === routeId);
}

function findSystemFallback(): FallbackModel | undefined {
  const direct = fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID];
  if (direct) return direct;
  const entries = Object.values(fallbackModelStore);
  return entries.length > 0 ? entries[0] : undefined;
}

function validateFallbackReferences(model: FallbackModel) {
  const unresolved = model.models.filter((entry) => {
    if (findProviderModel(entry)) return false;
    const resolved = resolveModelTarget(entry);
    if (!resolved || isLocalRouterProviderName(resolved.providerName)) return true;
    return !getProviderSummary(resolved.providerName);
  });

  if (unresolved.length > 0) {
    return { ok: false, error: `Fallback model references unknown model(s): ${unresolved.join(', ')}` } as const;
  }

  return { ok: true } as const;
}

function validateRouterReferences(model: RouterModel) {
  const unresolved = model.candidates.filter((candidate) => {
    if (findProviderModel(candidate.model)) return false;
    const resolved = resolveModelTarget(candidate.model);
    if (!resolved || isLocalRouterProviderName(resolved.providerName)) return true;
    return !getProviderSummary(resolved.providerName);
  });

  if (unresolved.length > 0) {
    return { ok: false, error: `Router references unknown candidate model(s): ${unresolved.map((entry) => entry.model).join(', ')}` } as const;
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
  if (findRouterModel(presentedName)) {
    return {
      id: routerPresentedModelId(presentedName),
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

function ollamaTag(model: ProviderModel) {
  return {
    name: model.id,
    model: model.id,
    modified_at: new Date().toISOString(),
    size: 1,
    digest: '',
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
    const providerName = trimmed.slice(0, slashIndex);
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

function isLegacyAutoLocalMainRouter(router: RouterModel): boolean {
  const models = router.candidates.map((candidate) => candidate.model);
  return models.length === LEGACY_AUTO_LOCAL_MAIN_MODELS.size
    && models.every((modelId) => LEGACY_AUTO_LOCAL_MAIN_MODELS.has(modelId));
}

function buildDefaultAutoLocalRouterModel(): RouterModel | null {
  const parsed = parseRouterModel({
    id: DEFAULT_ROUTER_ID,
    type: DEFAULT_ROUTER_TYPE,
    minCodingScore: DEFAULT_ROUTER_MIN_CODING_SCORE,
    costQualityTradeoff: DEFAULT_ROUTER_COST_QUALITY_TRADEOFF,
    candidatesText: resolvedDefaultAutoRouterCandidatesText()
  });
  if (!parsed.ok) {
    console.error('Failed to build default auto-local router:', parsed.error);
    return null;
  }
  const referenceCheck = validateRouterReferences(parsed.model);
  if (!referenceCheck.ok) {
    console.error('Default auto-local router references unresolved candidates:', referenceCheck.error);
    return null;
  }
  return {
    ...parsed.model,
    candidates: applyPricingToRouterCandidates(parsed.model.candidates)
  };
}

function mergeMissingDefaultRouterCandidates(): void {
  const defaultRouter = buildDefaultAutoLocalRouterModel();
  const existingRouter = routerModelStore[DEFAULT_ROUTER_ID];
  if (!defaultRouter || !existingRouter || existingRouter.type !== DEFAULT_ROUTER_TYPE) return;

  const knownModels = new Set(existingRouter.candidates.map((candidate) => candidate.model));
  let changed = false;
  for (const candidate of defaultRouter.candidates) {
    if (knownModels.has(candidate.model)) continue;
    existingRouter.candidates.push({ ...candidate });
    knownModels.add(candidate.model);
    changed = true;
  }

  if (!changed) return;

  existingRouter.candidates = applyPricingToRouterCandidates(existingRouter.candidates);
  routerModelStore[DEFAULT_ROUTER_ID] = cloneRouterModel(existingRouter);
  try {
    persistRouterModels();
    console.log('[router] Merged missing default candidates into auto-router-main.');
  } catch (error: any) {
    console.error('Failed to persist merged auto-router-main candidates:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

function pruneDisallowedGatewayFreeRouting(): void {
  let routerChanged = false;
  const autoRouter = routerModelStore[DEFAULT_ROUTER_ID];
  if (autoRouter?.candidates?.length) {
    const before = autoRouter.candidates.length;
    autoRouter.candidates = autoRouter.candidates.filter((candidate) => {
      const modelId = String(candidate.model || '').trim();
      if (!modelId.endsWith('-free')) return true;
      if (!modelId.startsWith('cline-') && !modelId.startsWith('kilo-')) return true;
      return isAllowedAutoRouterGatewayFreeModel(modelId);
    });
    if (autoRouter.candidates.length !== before) {
      routerModelStore[DEFAULT_ROUTER_ID] = cloneRouterModel(autoRouter);
      routerChanged = true;
    }
  }

  if (routerChanged) {
    try {
      persistRouterModels();
      console.log('[router] Pruned Cline/Kilo free models outside curated auto-router allowlist.');
    } catch (error: any) {
      console.error('Failed to persist pruned gateway free router candidates:', sanitizeDiagnosticText(String(error?.message || error)));
    }
  }
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
  let routerChanged = false;
  const autoRouter = routerModelStore[DEFAULT_ROUTER_ID];
  if (autoRouter?.candidates?.length) {
    const before = autoRouter.candidates.length;
    autoRouter.candidates = autoRouter.candidates.filter((candidate) => {
      const resolved = findProviderModel(candidate.model);
      const target = resolveModelTarget(candidate.model);
      if (target?.providerName !== 'ollama' || !resolved) return true;
      return !isOllamaCloudPresentedIdBlocked(
        candidate.model,
        resolved.model,
        allowsPro
      );
    });
    if (autoRouter.candidates.length !== before) {
      routerModelStore[DEFAULT_ROUTER_ID] = cloneRouterModel(autoRouter);
      routerChanged = true;
    }
  }

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

  if (routerChanged) {
    try {
      persistRouterModels();
      console.log('[router] Pruned Ollama Cloud models outside free-tier routing allowlist.');
    } catch (error: any) {
      console.error('Failed to persist pruned router candidates:', sanitizeDiagnosticText(String(error?.message || error)));
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
  let routerChanged = false;
  const autoRouter = routerModelStore[DEFAULT_ROUTER_ID];
  if (autoRouter?.candidates?.length) {
    const sortedModelIds = stableSortModelIdsByProviderTier(
      autoRouter.candidates.map((candidate) => candidate.model)
    );
    const orderChanged = sortedModelIds.some((modelId, index) => (
      modelId !== autoRouter.candidates[index]?.model
    ));
    if (orderChanged) {
      const candidatesByModel = new Map(
        autoRouter.candidates.map((candidate) => [candidate.model, candidate])
      );
      autoRouter.candidates = sortedModelIds
        .map((modelId) => candidatesByModel.get(modelId))
        .filter((candidate): candidate is RouterCandidate => Boolean(candidate))
        .map((candidate) => ({ ...candidate }));
      routerModelStore[DEFAULT_ROUTER_ID] = cloneRouterModel(autoRouter);
      routerChanged = true;
    }
  }

  const routerSettingsForFallback = loadRouterSettings();
  const hasUserCustomizedFallback = typeof routerSettingsForFallback.fallbackModelsText === 'string' && routerSettingsForFallback.fallbackModelsText.trim().length > 0;


  let systemFallbackChanged = false;
  let otherFallbackChanged = false;
  const defaultFallbackIds = resolvedDefaultFallbackModels();
  for (const route of Object.values(fallbackModelStore)) {
    const isSystemFallback = (
      route.id === SYSTEM_FALLBACK_ROUTE_ID
      || normalizeFallbackRouteId(route.id) === SYSTEM_FALLBACK_ROUTE_ID
      || normalizeFallbackRouteId(route.id) === 'default'
    );

    let nextModels: string[];
    if (isSystemFallback && !hasUserCustomizedFallback) {
      const catalogValid = (modelId: string) => Boolean(findProviderModel(modelId));
      const preferred = DEFAULT_FALLBACK_ORDERED_IDS.filter(catalogValid);
      const preferredSet = new Set(preferred);
      const extras: string[] = [];
      const seenExtras = new Set<string>();
      for (const modelId of [...defaultFallbackIds, ...route.models]) {
        const trimmed = String(modelId || '').trim();
        if (!trimmed || preferredSet.has(trimmed) || seenExtras.has(trimmed) || !catalogValid(trimmed)) {
          continue;
        }
        seenExtras.add(trimmed);
        extras.push(trimmed);
      }
      nextModels = [...preferred, ...extras];
    } else if (isSystemFallback && hasUserCustomizedFallback) {
      const deduped: string[] = [];
      const seen = new Set<string>();
      for (const modelId of route.models) {
        const trimmed = String(modelId || '').trim();
        if (!trimmed || seen.has(trimmed) || !findProviderModel(trimmed)) continue;
        seen.add(trimmed);
        deduped.push(trimmed);
      }
      nextModels = deduped;
    } else {
      const deduped: string[] = [];
      const seenModels = new Set<string>();
      for (const modelId of route.models) {
        const trimmed = String(modelId || '').trim();
        if (!trimmed || seenModels.has(trimmed) || !findProviderModel(trimmed)) continue;
        seenModels.add(trimmed);
        deduped.push(trimmed);
      }
      if (deduped.length === 0) continue;
      nextModels = stableSortModelIdsByProviderTier(deduped);
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

  if (routerChanged) {
    try {
      persistRouterModels();
      console.log('[router] Reordered auto-router-main candidates by provider tier.');
    } catch (error: any) {
      console.error('Failed to persist tier-ordered router candidates:', sanitizeDiagnosticText(String(error?.message || error)));
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
  const legacyRouter = routerModelStore['auto-local-main'];
  if (legacyRouter && !routerModelStore[DEFAULT_ROUTER_ID]) {
    routerModelStore[DEFAULT_ROUTER_ID] = cloneRouterModel({
      ...legacyRouter,
      id: DEFAULT_ROUTER_ID,
      candidates: applyPricingToRouterCandidates(legacyRouter.candidates)
    });
    delete routerModelStore['auto-local-main'];
    try {
      persistRouterModels();
      console.log('[router] Renamed auto-local-main → auto-router-main.');
    } catch (error: any) {
      console.error('Failed to persist router rename:', sanitizeDiagnosticText(String(error?.message || error)));
    }
  }

  const defaultRouter = buildDefaultAutoLocalRouterModel();
  const existingRouter = routerModelStore[DEFAULT_ROUTER_ID];
  if (defaultRouter && existingRouter && isLegacyAutoLocalMainRouter(existingRouter)) {
    routerModelStore[DEFAULT_ROUTER_ID] = cloneRouterModel(defaultRouter);
    try {
      persistRouterModels();
      console.log('[router] Migrated auto-local-main from legacy OpenRouter-only presets to default candidate catalog.');
    } catch (error: any) {
      console.error('Failed to persist migrated auto-local-main router:', sanitizeDiagnosticText(String(error?.message || error)));
    }
  }

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

  mergeMissingDefaultRouterCandidates();
  normalizeRoutingTierOrder();
  migrateGatewayFallbackMiniMax();
  pruneDisallowedOllamaCloudRouting();
  pruneDisallowedGatewayFreeRouting();

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

function ollamaShowPayload(model: ProviderModel) {
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
      supports_vision: model.supportsImages
    },
    projector_info: {},
    capabilities: modelCapabilities(model),
    modified_at: new Date().toISOString()
  };
}

function vscodeUserDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Code', 'User');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User');
}

function writeJsonWithBackup(filePath: string, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
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
  const models = [...providerCatalogModels(), ...fallbackModelList(), ...routerModelList()];
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

  fs.mkdirSync(path.dirname(statePath), { recursive: true });

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

function getPqcBinPath(): string {
  const candidates = [
    path.resolve(__dirname, '..', 'bin', 'pqc-secrets'),
    path.resolve(process.cwd(), 'bin', 'pqc-secrets'),
  ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* not found */ }
  }
  return '';
}

function ensurePqcKeypair(bin: string): boolean {
  const pubkeyPath = getPqcPubkeyPath();
  if (fs.existsSync(pubkeyPath)) return true;
  try {
    execFileSync(bin, ['keygen'], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
      env: {
        ...process.env,
        PQC_CONFIG_DIR: getPqcConfigDir(),
        PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
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
    const envValue = process.env[summary.keyEnvVar];
    if (envValue) {
      keyStore[summary.name] = envValue;
      count++;
    }
  }
  return count;
}

function loadPqcSecrets(): void {
  if (process.env.LOCAL_ROUTER_SKIP_PQC_LOAD === 'true') {
    ensureDefaultOllamaApiKey(keyStore);
    pruneDisallowedOllamaCloudRouting();
    pruneDisallowedGatewayFreeRouting();
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
    pruneDisallowedGatewayFreeRouting();
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
    pruneDisallowedGatewayFreeRouting();
    reportMissingProviders();
    return;
  }

  try {
    const output = execFileSync(bin, ['export'], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PQC_CONFIG_DIR: getPqcConfigDir(),
        PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
      }
    });
    const loadedProviders: string[] = [];
    const skippedEnvVars: string[] = [];
    for (const line of output.split('\n')) {
      const match = line.match(/^export\s+(\w+)=(.+)$/);
      if (!match) continue;
      const envVar = match[1];
      const value = match[2];
      process.env[envVar] = value;
      const providers = providerSummariesForEnvVar(envVar);
      if (providers.length > 0) {
        for (const provider of providers) {
          keyStore[provider.name] = value;
          loadedProviders.push(provider.name);
        }
      } else {
        skippedEnvVars.push(envVar);
      }
    }
    if (loadedProviders.length > 0) {
      console.log(`[PQC] Loaded ${loadedProviders.length} provider key(s) from bundle: ${loadedProviders.join(', ')}`);
    }
    if (skippedEnvVars.length > 0) {
      console.log(`[PQC] Env vars not mapped to providers: ${skippedEnvVars.join(', ')}`);
    }
    const envCount = loadKeysFromEnvironment();
    if (envCount > 0) {
      console.log(`[PQC] Loaded ${envCount} additional provider key(s) from environment.`);
    }
    ensureDefaultOllamaApiKey(keyStore);
    pruneDisallowedOllamaCloudRouting();
    pruneDisallowedGatewayFreeRouting();
    reportMissingProviders();
  } catch (err) {
    console.log(`[PQC] Failed to load bundle:`, (err as Error).message);
    console.log(`[PQC] Falling back to environment variables.`);
    loadKeysFromEnvironment();
    ensureDefaultOllamaApiKey(keyStore);
    pruneDisallowedOllamaCloudRouting();
    pruneDisallowedGatewayFreeRouting();
    reportMissingProviders();
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

/** Catalog providers may share one env var (e.g. opencode-go + opencode-zen → OPENCODE_API_KEY). */
function setProviderKeyForEnvVar(envVar: string, keyValue: string): void {
  process.env[envVar] = keyValue;
  for (const summary of providerSummariesForEnvVar(envVar)) {
    keyStore[summary.name] = keyValue;
  }
}

function clearProviderKeyForProvider(providerName: string): void {
  const summary = getProviderSummary(providerName);
  if (!summary) return;
  for (const sibling of providerSummariesForEnvVar(summary.keyEnvVar)) {
    delete keyStore[sibling.name];
  }
  delete process.env[summary.keyEnvVar];
}

function persistPqcSecrets(): void {
  const bin = getPqcBinPath();
  if (!bin) {
    console.warn(`[PQC] pqc-secrets binary not found — key changes will not persist across restarts. Install bin/pqc-secrets to enable.`);
    return;
  }
  try {
    const lines: string[] = [];
    const packedEnvVars = new Set<string>();
    for (const [providerName, keyValue] of Object.entries(keyStore)) {
      if (!keyValue) continue;
      if (providerName === 'ollama' && isOllamaPlaceholderKey(keyValue)) continue;
      const summary = getProviderSummary(providerName);
      if (summary && !packedEnvVars.has(summary.keyEnvVar)) {
        packedEnvVars.add(summary.keyEnvVar);
        lines.push(`${summary.keyEnvVar}=${keyValue}`);
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
      timeout: 10000,
      env: {
        ...process.env,
        PQC_CONFIG_DIR: getPqcConfigDir(),
        PQC_USE_KEYCHAIN: process.env.PQC_USE_KEYCHAIN || 'false',
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin'
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
  get endpointModelsCache() { return endpointModelsCache; },
  set endpointModelsCache(val) { endpointModelsCache = val; }
};

type RouterSettings = {
  fallbackModelsText?: string;
  autoRouterCandidatesText?: string;
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
  loadRouterSettings,
  saveRouterSettings,
  persistedProviderModelOverrides,
  providerModelSource,
  refreshRouterModelsPricing,
  resolveCatalogModels,
  routerModelPresentation,
  routerPresentedModelId,
  sanitizeDiagnosticText,
  selectRouterCandidate,
  validateFallbackReferences,
  validateRouterReferences,
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
        const key = keyStore[summary.name] || process.env[summary.keyEnvVar];
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

function readProviderModels(): ProviderModel[] {
  const providersPath = path.resolve(process.cwd(), 'providers.txt');

  try {
    const content = fs.readFileSync(providersPath, 'utf8');
    const models: ProviderModel[] = [];
    const seen = new Set<string>();

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line.startsWith('# │')) continue;

      const columns = line
        .replace(/^#\s*/, '')
        .split('│')
        .map((part) => part.trim())
        .filter(Boolean);

      if (columns.length < 4) continue;

      const [
        rowNumber,
        provider,
        model,
        display,
        context,
        output,
        tools,
        images,
        cache,
        reasoning
      ] = columns;
      if (!/^\d+$/.test(rowNumber)) continue;
      if (!provider || !model || !display) continue;

      const id = defaultPresentedModelName(provider, model);
      if (seen.has(id)) continue;

      seen.add(id);
      models.push({
        id,
        provider,
        model,
        display: providerModelDisplay(provider, model),
        contextLength: parseNumberCell(context, DEFAULT_CONTEXT_LENGTH),
        outputTokens: parseNumberCell(output, DEFAULT_OUTPUT_TOKENS),
        supportsTools: parseYesNoCell(tools, true),
        supportsImages: parseYesNoCell(images, false),
        supportsCache: parseYesNoCell(cache, false),
        supportsReasoning: parseYesNoCell(reasoning, false)
      });
    }

    return models;
  } catch (error) {
    console.error('Failed to read providers.txt, falling back to built-in model list:', error);
    return [
      {
        id: 'groq-llama3-8b-8192',
        provider: 'groq',
        model: 'llama3-8b-8192',
        display: 'groq:llama3-8b-8192',
        contextLength: 8192,
        outputTokens: DEFAULT_OUTPUT_TOKENS,
        supportsTools: true,
        supportsImages: false,
        supportsCache: false,
        supportsReasoning: false
      },
      {
        id: 'openrouter-claude-3-sonnet',
        provider: 'openrouter',
        model: 'anthropic/claude-3-sonnet',
        display: 'openrouter:anthropic/claude-3-sonnet',
        contextLength: DEFAULT_CONTEXT_LENGTH,
        outputTokens: DEFAULT_OUTPUT_TOKENS,
        supportsTools: true,
        supportsImages: false,
        supportsCache: false,
        supportsReasoning: false
      }
    ];
  }
}

function modelPresentationList() {
  const providers = allProviderSummaries();
  if (providers.length === 0) {
    return readProviderModels();
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
  const previousSource = modelSourceConfig.source;
  modelSourceConfig.source = 'custom';
  const models = modelPresentationList();
  modelSourceConfig.source = previousSource;
  return models;
}

function allCatalogModels(): ProviderModel[] {
  if (modelSourceConfig.source === 'custom') {
    return customCatalogModels();
  }
  const byKey = new Map<string, ProviderModel>();
  for (const model of customCatalogModels()) {
    byKey.set(`${model.provider}::${model.model}`, model);
  }
  for (const model of endpointModelsCache) {
    byKey.set(`${model.provider}::${model.model}`, model);
  }
  return Array.from(byKey.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function catalogModelsForMode(mode: ProviderCatalogMode): ProviderModel[] {
  if (mode === 'custom') {
    return customCatalogModels();
  }
  if (mode === 'all') {
    return allCatalogModels();
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
loadPersistedProviderModels();
mergeBaselineProviderModelOverrides();
loadPersistedFallbackModels();
if (waferZdrEnabled) {
  console.log('[Wafer] ZDR enabled for GLM-5.1, Kimi-K2.6');
}
loadPersistedRouterModels();
loadPersistedRouterSettings();
loadProviderPricingStore();
loadPersistedSystemPrompt();
loadPersistedThinkingConfig();
loadWaferConfig();
loadModelSourceConfig();
loadEndpointModelsCache();

function ensureDefaultRouter() {
  if (routerModelStore[DEFAULT_ROUTER_ID]) return;

  const hasAnyRouter = Object.keys(routerModelStore).length > 0;
  if (hasAnyRouter) return;

  const parsed = parseRouterModel({
    id: DEFAULT_ROUTER_ID,
    type: DEFAULT_ROUTER_TYPE,
    minCodingScore: DEFAULT_ROUTER_MIN_CODING_SCORE,
    costQualityTradeoff: DEFAULT_ROUTER_COST_QUALITY_TRADEOFF,
    candidatesText: resolvedDefaultAutoRouterCandidatesText()
  });

  if (!parsed.ok) {
    console.error('Failed to bootstrap default router:', parsed.error);
    return;
  }

  const referenceCheck = validateRouterReferences(parsed.model);
  if (!referenceCheck.ok) {
    console.error('Default router references unresolved candidates:', referenceCheck.error);
    return;
  }

  routerModelStore[parsed.model.id] = cloneRouterModel({
    ...parsed.model,
    candidates: applyPricingToRouterCandidates(parsed.model.candidates)
  });
  try {
    persistRouterModels();
  } catch (error: any) {
    console.error('Failed to persist default router:', sanitizeDiagnosticText(String(error?.message || error)));
    delete routerModelStore[parsed.model.id];
  }
}

function refreshRouterModelsPricing(): void {
  let changed = false;
  for (const [id, router] of Object.entries(routerModelStore)) {
    const priced = applyPricingToRouterCandidates(router.candidates);
    const samePricing = priced.every((candidate, index) => (
      candidate.inputPrice === router.candidates[index]?.inputPrice
      && candidate.outputPrice === router.candidates[index]?.outputPrice
    ));
    if (samePricing) continue;
    routerModelStore[id] = {
      ...router,
      candidates: priced
    };
    changed = true;
  }
  if (!changed) return;
  try {
    persistRouterModels();
  } catch (error: any) {
    console.error('Failed to persist router pricing refresh:', sanitizeDiagnosticText(String(error?.message || error)));
  }
}

migratePersistedRoutingConfig();
ensureDefaultRouter();

function ensureDefaultFallback() {
  if (fallbackModelStore[SYSTEM_FALLBACK_ROUTE_ID]) return;

  const hasAnyFallback = Object.keys(fallbackModelStore).length > 0;
  if (hasAnyFallback) return;

  const resolvedModels = resolvedDefaultFallbackModels();
  if (resolvedModels.length < 2) {
    console.error('Default fallback bootstrap skipped: fewer than 2 resolved models in catalog.');
    return;
  }

  const parsed = parseFallbackModel({
    id: SYSTEM_FALLBACK_ROUTE_ID,
    models: resolvedModels
  });

  if (!parsed.ok) {
    console.error('Failed to bootstrap default fallback route:', parsed.error);
    return;
  }

  fallbackModelStore[parsed.model.id] = {
    id: parsed.model.id,
    models: [...parsed.model.models]
  };

  try {
    persistFallbackModels();
    console.log(`[router] Bootstrapped default fallback route "${SYSTEM_FALLBACK_ROUTE_ID}" with ${parsed.model.models.length} models.`);
  } catch (error: any) {
    console.error('Failed to persist default fallback route:', sanitizeDiagnosticText(String(error?.message || error)));
    delete fallbackModelStore[parsed.model.id];
  }
}

ensureDefaultFallback();

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

function requestFeatureSummary(body: any) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const summary = summarizeMessagesForDiagnostics(messages);
  const requestedOutputTokens = typeof body?.max_tokens === 'number' && body.max_tokens > 0
    ? body.max_tokens
    : DEFAULT_OUTPUT_TOKENS;

  let allText = '';
  let firstUserLength = 0;
  const roles = new Set<string>();
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    if (typeof message.role === 'string') roles.add(message.role);
    const content = message.content;
    if (typeof content === 'string') {
      allText += content;
      if (!firstUserLength && message.role === 'user') firstUserLength = content.length;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part?.text === 'string') allText += part.text;
      }
      if (!firstUserLength && message.role === 'user') firstUserLength = allText.length;
    }
  }

  const codeIndicators = (allText.match(/[{}\[\]();=><|&^~`@#\$\\\/.:*+-]+/g) || []).length;
  const wordChars = (allText.match(/[a-zA-Z0-9_]+/g) || []).length;
  const codeDensity = wordChars > 0 ? codeIndicators / (codeIndicators + wordChars) : 0;

  const languagePatterns: Array<[RegExp, string]> = [
    [/import\s+(React|{.*})?\s*from\s*['"]/g, 'tsx'],
    [/def\s+\w+\s*\(|import\s+\w+/g, 'py'],
    [/func\s+\w+\s*\(|package\s+\w+/g, 'go'],
    [/fn\s+\w+\s*[<(]|let\s+mut\s+/g, 'rs'],
    [/function\s+\w+\s*\(|const\s+\w+\s*=\s*(\(\)|function)/g, 'js'],
    [/class\s+\w+\s*\{|public\s+(static\s+)?void\s+/g, 'java'],
    [/SELECT\s+.+\s+FROM\s+/i, 'sql'],
    [/<[a-zA-Z]+\s*\/?>|<\/[a-zA-Z]+>/g, 'html']
  ];
  const detectedLanguages = new Set<string>();
  for (const [pattern, lang] of languagePatterns) {
    if (pattern.test(allText)) detectedLanguages.add(lang);
  }

  return {
    approxInputTokens: Math.ceil(((summary.approxContentCharacters || 0) + (typeof body?.prompt === 'string' ? body.prompt.length : 0)) / 4),
    requestedOutputTokens,
    requiresTools: Array.isArray(body?.tools) && body.tools.length > 0,
    requiresImages: summary.imageMessageCount > 0,
    codeDensity: Math.round(codeDensity * 1000) / 1000,
    languageCount: detectedLanguages.size,
    detectedLanguages: Array.from(detectedLanguages).slice(0, 6),
    multiTurnDepth: roles.size,
    instructionLength: firstUserLength
  };
}

function ollamaCloudRoutingAllowsPro(): boolean {
  return isRealOllamaComApiKey(String(keyStore.ollama || resolveOllamaApiKey() || ''));
}

function providerHasConfiguredKey(providerName: string) {
  if (providerName === 'ollama') {
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
  return Boolean(keyStore[summary.name] || process.env[summary.keyEnvVar]);
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

function resolvedDefaultFallbackModels(): string[] {
  return buildDefaultFallbackModelIds(catalogRefForPresentedModel)
    .filter((id) => Boolean(findProviderModel(id)));
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

function isImmediateRouterSkipError(errorType: AttemptFailure['errorType']) {
  return errorType === 'provider_config'
    || errorType === 'provider_not_found'
    || errorType === 'unknown_model'
    || errorType === 'upstream_http_auth'
    || errorType === 'upstream_http_invalid_request';
}

function inferredCodingScore(model: ProviderModel, candidate: RouterCandidate) {
  if (typeof candidate.codingScore === 'number') return candidate.codingScore;
  const haystack = `${model.id} ${model.model} ${model.display}`.toLowerCase();
  if (/(deepseek.*v4-pro|qwen3\.7|max|gemini.*pro|glm-5\.1|kimi-k2\.6)/.test(haystack)) return 0.82;
  if (/(pro|sonnet|opus|coder|coding)/.test(haystack)) return 0.72;
  if (/(flash|mini|max|m2\.5|mimo|glm)/.test(haystack)) return 0.48;
  return 0.34;
}

function candidateCostEstimate(candidate: RouterCandidate, model: ProviderModel) {
  const resolved = resolveEffectiveCandidatePricing(candidate.model, {
    inputPrice: candidate.inputPrice,
    outputPrice: candidate.outputPrice
  });
  const inputPrice = typeof resolved.inputPrice === 'number' ? resolved.inputPrice : 0;
  const outputPrice = typeof resolved.outputPrice === 'number' ? resolved.outputPrice : 0;
  if (inputPrice || outputPrice) return inputPrice + outputPrice;

  let base = 2;
  if (model.contextLength >= 1000000) base = 3;
  else if (model.contextLength >= 128000) base = 2;
  else base = 1;

  const id = `${model.id} ${model.model}`.toLowerCase();
  if (/(pro|opus|sonnet|v4-pro|k2\.6|max)/.test(id)) base = Math.max(base, 3);
  if (/(flash|mini|nano|haiku|v1-8k|v1-32k)/.test(id)) base = Math.min(base, 1);

  return base;
}

const BANDIT_CONTEXT_DIM = 6;

function banditContextVector(features: ReturnType<typeof requestFeatureSummary>, body: any): number[] {
  const toolCount = Array.isArray(body?.tools) ? Math.min(body.tools.length, 10) : 0;
  const messageCount = Array.isArray(body?.messages) ? Math.min(body.messages.length, 20) : 0;

  return [
    Math.min(features.approxInputTokens / 100000, 1),
    Math.min(features.requestedOutputTokens / 100000, 1),
    features.requiresTools ? 1 : 0,
    features.requiresImages ? 1 : 0,
    toolCount / 10,
    messageCount / 20
  ];
}

function banditIdentityMatrix(dim: number): number[][] {
  const I: number[][] = [];
  for (let i = 0; i < dim; i += 1) {
    I.push(Array(dim).fill(0));
    I[i][i] = 1;
  }
  return I;
}

function banditMatrixVectorMul(A: number[][], v: number[]): number[] {
  return A.map((row) => row.reduce((sum, a, j) => sum + a * v[j], 0));
}

function banditDot(a: number[], b: number[]): number {
  return a.reduce((sum, val, i) => sum + val * b[i], 0);
}

function banditVectorScale(v: number[], scale: number): number[] {
  return v.map((val) => val * scale);
}

function banditMatrixScale(A: number[][], scale: number): number[][] {
  return A.map((row) => row.map((val) => val * scale));
}

function banditOuterProduct(a: number[], b: number[]): number[][] {
  return a.map((ai) => b.map((bj) => ai * bj));
}

function banditMatrixAdd(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => row.map((val, j) => val + B[i][j]));
}

function banditSolve(A: number[][], b: number[]): number[] {
  const n = A.length;
  const augmented = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col += 1) {
    let maxRow = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(augmented[row][col]) > Math.abs(augmented[maxRow][col])) maxRow = row;
    }
    [augmented[col], augmented[maxRow]] = [augmented[maxRow], augmented[col]];

    const pivot = augmented[col][col];
    if (Math.abs(pivot) < 1e-12) continue;

    for (let j = col; j <= n; j += 1) augmented[col][j] /= pivot;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = augmented[row][col];
      for (let j = col; j <= n; j += 1) augmented[row][j] -= factor * augmented[col][j];
    }
  }

  return augmented.map((row) => row[n]);
}

function banditInitState(dim: number, gamma: number): BanditState {
  return {
    A: banditIdentityMatrix(dim),
    b: Array(dim).fill(0),
    gamma,
    sampleCount: 0
  };
}

function banditPredict(state: BanditState, context: number[], explorationAlpha: number): { score: number; theta: number[]; uncertainty: number } {
  const theta = banditSolve(state.A, state.b);
  const AInvContext = banditSolve(state.A, context);
  const uncertainty = Math.sqrt(Math.max(0, banditDot(context, AInvContext)));
  const predictedReward = banditDot(theta, context);
  return {
    score: predictedReward + explorationAlpha * uncertainty,
    theta,
    uncertainty
  };
}

function banditUpdate(state: BanditState, context: number[], reward: number): void {
  const gamma = state.gamma;
  state.A = banditMatrixAdd(
    banditMatrixScale(state.A, gamma),
    banditOuterProduct(context, context)
  );
  state.b = banditVectorAdd(
    banditVectorScale(state.b, gamma),
    banditVectorScale(context, reward)
  );
  state.sampleCount += 1;
}

function banditVectorAdd(a: number[], b: number[]): number[] {
  return a.map((val, i) => val + b[i]);
}

function routerCandidateEligibility(router: RouterModel, candidate: RouterCandidate, body: any) {
  const resolved = findProviderModel(candidate.model);
  const target = resolveModelTarget(candidate.model);
  const features = requestFeatureSummary(body);
  const rejectionReasons: string[] = [];

  if (candidate.enabled === false) {
    rejectionReasons.push('candidate_disabled');
  }
  if (!target || isLocalRouterProviderName(target.providerName)) {
    rejectionReasons.push('unresolved');
  }
  if (target && !providerHasConfiguredKey(target.providerName)) {
    rejectionReasons.push('missing_provider_key');
  }
  if (target && rejectionReasons.includes('missing_provider_key')) {
    console.warn(`[router] Skipping candidate "${candidate.model}" — provider "${target.providerName}" has no configured API key`);
  }
  if (
    target?.providerName === 'ollama'
    && resolved
    && isOllamaCloudPresentedIdBlocked(candidate.model, resolved.model, ollamaCloudRoutingAllowsPro())
  ) {
    rejectionReasons.push('ollama_cloud_tier_blocked');
  }
  if (
    target
    && resolved
    && (target.providerName === 'kilo' || target.providerName === 'cline')
    && !gatewayModelAllowedForRouter(target.providerName, resolved.model)
  ) {
    rejectionReasons.push('gateway_tier_blocked');
  }
  if (resolved) {
    if (features.requiresTools && !resolved.supportsTools) rejectionReasons.push('tools_required');
    if (features.requiresImages && !resolved.supportsImages) rejectionReasons.push('vision_required');
    if (features.approxInputTokens + features.requestedOutputTokens > resolved.contextLength) rejectionReasons.push(`context_exceeded(need=${features.approxInputTokens + features.requestedOutputTokens},limit=${resolved.contextLength})`);
    if (features.requestedOutputTokens > resolved.outputTokens) rejectionReasons.push(`output_exceeded(need=${features.requestedOutputTokens},limit=${resolved.outputTokens})`);
  }

  const codingScore = resolved ? inferredCodingScore(resolved, candidate) : (candidate.codingScore || 0);
  if (router.type === 'pareto-code' && typeof router.minCodingScore === 'number' && codingScore < router.minCodingScore) {
    rejectionReasons.push('coding_score_below_minimum');
  }

  return {
    ok: rejectionReasons.length === 0,
    rejectionReasons,
    resolved,
    target,
    codingScore,
    features
  };
}

function selectBanditCandidate(router: RouterModel, body: any): RouterDecision | { error: string; candidateScores: Array<Record<string, unknown>> } {
  const features = requestFeatureSummary(body);
  const context = banditContextVector(features, body);
  const explorationAlpha = router.explorationBudget ?? 0.05;
  const dim = BANDIT_CONTEXT_DIM;

  if (!router.banditState) {
    router.banditState = {};
  }

  const banditState = router.banditState;

  const scored = router.candidates.map((candidate, index) => {
    const eligibility = routerCandidateEligibility(router, candidate, body);
    const model = eligibility.resolved;
    const cost = model ? candidateCostEstimate(candidate, model) : Number.MAX_SAFE_INTEGER;
    const latencyMs = typeof candidate.latencyMs === 'number' ? candidate.latencyMs : 2000;

    let banditScore = eligibility.codingScore;
    let theta: number[] = [];
    let uncertainty = 0;

    if (eligibility.ok) {
      const state = banditState[candidate.model] || banditInitState(dim, 0.98);
      banditState[candidate.model] = state;
      const prediction = banditPredict(state, context, explorationAlpha * (1 / Math.max(1, Math.log(state.sampleCount + 2))));
      banditScore = Math.max(0, Math.min(1, prediction.score));
      theta = prediction.theta;
      uncertainty = prediction.uncertainty;
    }

    return {
      candidate,
      index,
      eligible: eligibility.ok,
      reasons: eligibility.rejectionReasons,
      model,
      codingScore: eligibility.codingScore,
      cost,
      latencyMs,
      banditScore,
      theta,
      uncertainty
    };
  });

  const candidateScores = scored.map((entry) => ({
    model: entry.candidate.model,
    eligible: entry.eligible,
    reasons: entry.reasons,
    codingScore: Number(entry.codingScore.toFixed(4)),
    costEstimate: entry.cost === Number.MAX_SAFE_INTEGER ? null : entry.cost,
    latencyMs: null,
    contextLength: entry.model?.contextLength || null,
    maxOutput: entry.model?.outputTokens || null,
    banditScore: entry.eligible ? Number(entry.banditScore.toFixed(4)) : null,
    uncertainty: entry.eligible ? Number(entry.uncertainty.toFixed(4)) : null,
    sampleCount: entry.eligible ? (banditState[entry.candidate.model]?.sampleCount || 0) : null,
    score: entry.eligible ? Number(entry.banditScore.toFixed(4)) : null
  }));

  const eligibleEntries = scored.filter((entry) => entry.eligible);
  if (eligibleEntries.length === 0) {
    const missingProviders = [...new Set(
      scored
        .filter((e) => e.reasons?.includes('missing_provider_key'))
        .map((e) => { const t = resolveModelTarget(e.candidate.model); return t?.providerName; })
        .filter(Boolean) as string[]
    )];
    const detail = missingProviders.length > 0
      ? ` Configure one of these providers: ${missingProviders.join(', ')}.`
      : '';
    return {
      error: `Router has no eligible configured candidate models for this request.${detail}`,
      candidateScores
    };
  }

  const MIN_EXPLORATION_SAMPLES = 10;
  const needsExploration = eligibleEntries.some((entry) => {
    const state = banditState[entry.candidate.model];
    return !state || state.sampleCount < MIN_EXPLORATION_SAMPLES;
  });

  let ordered: typeof scored;
  if (needsExploration) {
    const unexplored = eligibleEntries.filter((entry) => {
      const state = banditState[entry.candidate.model];
      return !state || state.sampleCount < MIN_EXPLORATION_SAMPLES;
    });
    const explored = eligibleEntries.filter((entry) => {
      const state = banditState[entry.candidate.model];
      return state && state.sampleCount >= MIN_EXPLORATION_SAMPLES;
    });
    const unexploredSorted = unexplored.sort((a, b) => (
      (banditState[a.candidate.model]?.sampleCount || 0) - (banditState[b.candidate.model]?.sampleCount || 0)
    ));
    const exploredSorted = explored.sort((a, b) => b.banditScore - a.banditScore || a.index - b.index);
    ordered = orderEligibleRouterEntriesByExhaustion([...unexploredSorted, ...exploredSorted]);
  } else {
    ordered = orderEligibleRouterEntriesByExhaustion(eligibleEntries);
  }

  return {
    router,
    selected: ordered[0].candidate,
    orderedCandidates: ordered.map((entry) => entry.candidate),
    candidateScores
  };
}

export function selectRouterCandidate(router: RouterModel, body: any): RouterDecision | { error: string; candidateScores: Array<Record<string, unknown>> } {
  const tradeOff = router.costQualityTradeoff ?? DEFAULT_ROUTER_COST_QUALITY_TRADEOFF;

  if (router.type === 'bandit-local') {
    return selectBanditCandidate(router, body);
  }

  const scored = router.candidates.map((candidate, index) => {
    const eligibility = routerCandidateEligibility(router, candidate, body);
    const model = eligibility.resolved;
    const cost = model ? candidateCostEstimate(candidate, model) : Number.MAX_SAFE_INTEGER;
    const latencyMs = typeof candidate.latencyMs === 'number' ? candidate.latencyMs : 2000;

    return {
      candidate,
      index,
      eligible: eligibility.ok,
      reasons: eligibility.rejectionReasons,
      model,
      codingScore: eligibility.codingScore,
      cost,
      latencyMs
    };
  });

  const eligible = scored.filter((entry) => entry.eligible);

  // Auto-tier deranking
  if (router.enableAutoTiers) {
    const eventsPath = existingPath(ROUTER_EVENTS_PATH, LEGACY_ROUTER_EVENTS_PATH);
    const candidateModels = router.candidates.map((c) => c.model);
    const tiers = computeTiers(candidateModels, eventsPath);
    const derankedSet = new Set(tiers.filter((t) => t.tier === 'deranked').map((t) => t.model));
    if (derankedSet.size > 0) {
      for (const entry of scored) {
        if (derankedSet.has(entry.candidate.model)) {
          entry.eligible = false;
          entry.reasons = [...(entry.reasons || []), 'auto_tier_deranked'];
        }
      }
    }
  }

  const allCosts = scored.map((entry) => entry.cost).filter((c) => c !== Number.MAX_SAFE_INTEGER);
  const maxCost = allCosts.length > 0 ? Math.max(...allCosts) : 1;
  const allContexts = scored.map((entry) => entry.model?.contextLength || 0).filter(Boolean);
  const maxContext = allContexts.length > 0 ? Math.max(...allContexts) : 1;

  const scoredNormalized = scored.map((entry) => {
    if (!entry.eligible) {
      return { ...entry, score: Number.NEGATIVE_INFINITY };
    }

    const qualityWeight = router.type === 'auto-local' ? tradeOff / 10 : router.type === 'pareto-code' ? 1.0 : 1.0;
    const costWeight = router.type === 'auto-local' ? (10 - tradeOff) / 10 : router.type === 'pareto-code' ? 0.2 : 1.0;
    const contextWeight = router.type === 'auto-local' ? 0.1 : router.type === 'pareto-code' ? 0.1 : 0.3;

    const normalizedCoding = entry.codingScore;
    const normalizedCost = maxCost > 0 ? entry.cost / maxCost : 0;
    const normalizedContext = maxContext > 0 ? (entry.model?.contextLength || 0) / maxContext : 0;
    const indexPenalty = entry.index / Math.max(scored.length, 1);

    const isFree = entry.cost === 0 || entry.candidate.model.includes('-free') || entry.candidate.model.includes('cloud') || entry.candidate.model.includes('openrouter-free');
    const freeTerm = isFree ? 0.15 : 0.0;

    const score = (qualityWeight * normalizedCoding)
      - (costWeight * normalizedCost)
      + (contextWeight * normalizedContext)
      + freeTerm
      - (0.001 * indexPenalty);

    return { ...entry, score };
  });

  const candidateScores = scoredNormalized.map((entry) => ({
    model: entry.candidate.model,
    eligible: entry.eligible,
    reasons: entry.reasons,
    codingScore: Number(entry.codingScore.toFixed(4)),
    costEstimate: entry.cost === Number.MAX_SAFE_INTEGER ? null : entry.cost,
    latencyMs: null,
    contextLength: entry.model?.contextLength || null,
    maxOutput: entry.model?.outputTokens || null,
    score: Number.isFinite(entry.score) ? Number(entry.score.toFixed(4)) : null
  }));

  const eligibleEntries = scoredNormalized.filter((entry) => entry.eligible && Number.isFinite(entry.score));
  if (eligibleEntries.length === 0) {
    const missingProviders = [...new Set(
      scoredNormalized
        .filter((e) => e.reasons?.includes('missing_provider_key'))
        .map((e) => { const t = resolveModelTarget(e.candidate.model); return t?.providerName; })
        .filter(Boolean) as string[]
    )];
    const detail = missingProviders.length > 0
      ? ` Configure one of these providers: ${missingProviders.join(', ')}.`
      : '';
    return {
      error: `Router has no eligible configured candidate models for this request.${detail}`,
      candidateScores
    };
  }

  const ordered = router.type === 'priority'
    ? eligibleEntries.sort((a, b) => a.index - b.index)
    : orderEligibleRouterEntriesByExhaustion(eligibleEntries);

  return {
    router,
    selected: ordered[0].candidate,
    orderedCandidates: ordered.map((entry) => entry.candidate),
    candidateScores
  };
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function routerEventFeatures(features: ReturnType<typeof requestFeatureSummary>, body: any) {
  let promptHash = '';
  try {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const sample = JSON.stringify(messages.slice(0, 3)).slice(0, 500);
    promptHash = crypto.createHash('sha256').update(sample).digest('hex').slice(0, 16);
  } catch { /* ignore hash failures */ }

  return {
    requires_tools: features.requiresTools,
    requires_images: features.requiresImages,
    code_density: features.codeDensity,
    language_count: features.languageCount,
    multi_turn_depth: features.multiTurnDepth,
    instruction_length: features.instructionLength,
    coding_task: features.codeDensity > 0.1 || features.languageCount > 0,
    approx_input_tokens: features.approxInputTokens,
    requested_output_tokens: features.requestedOutputTokens,
    tool_calls_requested: Array.isArray(body?.tools) ? body.tools.length : 0,
    tool_calls_valid: 0,
    reward_signal: 0,
    prompt_hash: promptHash
  };
}

function recordProxyTelemetry(event: {
  routeKind: 'router' | 'direct' | 'fallback';
  routerId?: string;
  routerType?: string;
  presentedModel: string;
  selectedModel: string;
  status: number;
  durationMs: number;
  stream: boolean;
  body: any;
  errorType?: string;
  rewardSignal?: number;
  toolCallsValid?: boolean;
  candidateScores?: unknown;
}) {
  const features = requestFeatureSummary(event.body);
  const eventFeatures = routerEventFeatures(features, event.body);
  appendRouterEvent({
    timestamp: new Date().toISOString(),
    router_id: event.routeKind === 'router' ? (event.routerId || '') : event.routeKind,
    presented_model: event.presentedModel,
    router_type: event.routeKind === 'router' ? (event.routerType || '') : event.routeKind,
    selected_model: event.selectedModel,
    status: event.status,
    duration_ms: event.durationMs,
    candidate_latency_ms: event.durationMs,
    stream: event.stream,
    ...eventFeatures,
    tool_calls_valid: event.toolCallsValid ?? 0,
    reward_signal: event.rewardSignal ?? 0,
    prompt_hash: eventFeatures.prompt_hash,
    candidate_scores: event.candidateScores ? JSON.stringify(event.candidateScores) : '',
    error_type: event.errorType || ''
  });
}

function appendRouterEvent(event: Record<string, unknown>) {
  try {
    ensureLocalRouterConfigDir();
    const headers = [
      'timestamp',
      'router_id',
      'presented_model',
      'router_type',
      'selected_model',
      'status',
      'duration_ms',
      'candidate_latency_ms',
      'stream',
      'requires_tools',
      'requires_images',
      'code_density',
      'language_count',
      'multi_turn_depth',
      'instruction_length',
      'coding_task',
      'approx_input_tokens',
      'requested_output_tokens',
      'tool_calls_requested',
      'tool_calls_valid',
      'reward_signal',
      'prompt_hash',
      'candidate_scores',
      'error_type'
    ];
    if (!fs.existsSync(ROUTER_EVENTS_PATH)) {
      fs.writeFileSync(ROUTER_EVENTS_PATH, `${headers.join(',')}\n`, { encoding: 'utf8', mode: 0o600 });
    }
    const row = headers.map((header) => csvEscape(event[header])).join(',');
    fs.appendFileSync(ROUTER_EVENTS_PATH, `${row}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(ROUTER_EVENTS_PATH, 0o600);
  } catch {
    // best-effort telemetry — never crash a request over CSV writes
  }
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

function injectPromptCaching(body: any, providerName: string): any {
  const isCachingSupported = ['zenmux', 'opencode-go', 'opencode-zen', 'xiaomi-mimo', 'wafer-serverless', 'openrouter', 'openrouter-presets'].includes(providerName);
  if (!isCachingSupported) return body;

  const messages = body.messages || [];
  const totalMessageLength = messages.reduce((acc: number, m: any) => acc + (typeof m.content === 'string' ? m.content.length : 0), 0);
  const isLargePrompt = totalMessageLength > 800 || messages.length >= 4;
  if (!isLargePrompt) return body;

  const newBody = { ...body };
  if (Array.isArray(newBody.messages) && newBody.messages.length > 0) {
    const newMessages = [...newBody.messages];

    if (newMessages[0] && newMessages[0].role === 'system') {
      const msg = { ...newMessages[0] };
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
      } else if (Array.isArray(msg.content) && msg.content[0]) {
        msg.content = msg.content.map((part: any, idx: number) => 
          idx === 0 ? { ...part, cache_control: { type: 'ephemeral' } } : part
        );
      }
      newMessages[0] = msg;
    }

    const targetIdx = newMessages.length - 2;
    if (targetIdx > 0 && newMessages[targetIdx]) {
      const msg = { ...newMessages[targetIdx] };
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } }];
      } else if (Array.isArray(msg.content) && msg.content[0]) {
        msg.content = msg.content.map((part: any, idx: number) => 
          idx === 0 ? { ...part, cache_control: { type: 'ephemeral' } } : part
        );
      }
      newMessages[targetIdx] = msg;
    }

    newBody.messages = newMessages;
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
  const ZDR_ELIGIBLE_MODELS = new Set(['GLM-5.1', 'Kimi-K2.6']);
  if (target.providerName === 'wafer-serverless' && waferZdrEnabled && ZDR_ELIGIBLE_MODELS.has(target.actualModel)) {
    providerHeaders['Wafer-ZDR'] = 'required';
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
  const cachedRequestBody = injectPromptCaching(safeRequestBody, target.providerName);
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
    const response = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: providerHeaders,
      body: JSON.stringify(finalBody)
    });

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
  diagnosticsExtra?: Record<string, unknown>
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
      if (outputFormat.startsWith('ollama')) {
        const isGenerate = outputFormat === 'ollama_generate';
        const transform = createOllamaStreamTransform(model, isGenerate);
        nodeStream.pipe(transform).pipe(res);
      } else {
        nodeStream.pipe(createOpenAIReasoningStripTransform()).pipe(res);
      }
    } else {
      res.end();
    }
    return;
  }

  const upstreamData = await fetchResponse.json();
  const normalizedUpstream = normalizeGatewayChatCompletionBody(success.providerName, upstreamData);
  const data = stripReasoningMetadata(normalizedUpstream) as Record<string, any>;

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

  if (outputFormat.startsWith('ollama')) {
    const message = data.choices?.[0]?.message || {};
    const content = message.content || '';
    const toolCalls = openAIToolCallsToOllama(message.tool_calls);
    if (outputFormat === 'ollama_generate') {
      res.json({ model, created_at: new Date().toISOString(), response: content, done: true, done_reason: 'stop' });
    } else {
      const responseMessage: any = { role: 'assistant', content };
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
  if (!fallbackRoute.disabledModels || fallbackRoute.disabledModels.length === 0) {
    return [...fallbackRoute.models];
  }
  const disabled = new Set(fallbackRoute.disabledModels);
  return fallbackRoute.models.filter((model) => !disabled.has(model));
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

  const routerRoute = findRouterModel(model);
  if (routerRoute) {
    const decision = selectRouterCandidate(routerRoute, body);
    if ('error' in decision) {
      const features = requestFeatureSummary(body);
      const eventFeatures = routerEventFeatures(features, body);
      appendRouterEvent({
        timestamp: new Date().toISOString(),
        router_id: routerRoute.id,
        presented_model: routerPresentedModelId(routerRoute),
        router_type: routerRoute.type,
        selected_model: '',
        status: 400,
        duration_ms: Date.now() - requestStartedAt,
        candidate_latency_ms: 0,
        stream: Boolean(stream),
        ...eventFeatures,
        candidate_scores: JSON.stringify(decision.candidateScores),
        error_type: 'no_eligible_candidates'
      });

      const systemFallbackForEligibility = findSystemFallback();
      if (systemFallbackForEligibility) {
        pushDiagnostic({
          event: 'proxy_error',
          route: requestRoute,
          presentedModel: model,
          stream: Boolean(stream),
          status: 400,
          durationMs: Date.now() - requestStartedAt,
          data: {
            routerNoEligibleCandidates: {
              route: routerRoute.id,
              error: decision.error,
              candidateScores: decision.candidateScores
            },
            cascadingToSystemFallback: systemFallbackForEligibility.id
          }
        });
        return executeFallbackRoute(
          systemFallbackForEligibility,
          body,
          model,
          stream,
          requestRoute,
          outputFormat,
          requestStartedAt,
          res
        );
      }

      return res.status(400).json({
        error: decision.error,
        router: {
          id: routerPresentedModelId(routerRoute),
          routeId: routerRoute.id,
          type: routerRoute.type,
          candidates: routerRoute.candidates.map((candidate) => candidate.model),
          candidateScores: decision.candidateScores
        }
      });
    }

    const attemptLog: Array<Record<string, unknown>> = [];
    let lastFailure: AttemptFailure | null = null;
    const candidateByModel = new Map(decision.orderedCandidates.map((entry) => [entry.model, entry]));
    const routerExecutionPlan = buildWraparoundExecutionPlan(
      decision.orderedCandidates.map((entry) => entry.model),
      1 + ROUTER_CANDIDATE_RETRIES
    );
    let stageOrdinal = 0;

    for (const stage of routerExecutionPlan) {
      const candidate = candidateByModel.get(stage.model);
      if (!candidate) continue;
      stageOrdinal += 1;
      const routerData = {
        route: routerRoute.id,
        type: routerRoute.type,
        selectedModel: decision.selected.model,
        targetModel: candidate.model,
        candidateIndex: stageOrdinal,
        candidateCount: routerExecutionPlan.length,
        candidateScores: decision.candidateScores,
        executionStage: stage.stage,
        wraparoundRevisit: !stage.primary
      };

      let candidateSucceeded = false;
      for (let attempt = 1; attempt <= stage.attempts; attempt += 1) {
        const result = await proxyModelAttempt(
          body,
          requestRoute,
          outputFormat,
          model,
          candidate.model,
          Boolean(stream),
          requestStartedAt,
          { ...routerData, candidateAttempt: attempt, candidateMaxAttempts: stage.attempts }
        );

        if (result.ok) {
          candidateSucceeded = true;
          const features = requestFeatureSummary(body);
          const eventFeatures = routerEventFeatures(features, body);
          const attemptDuration = Date.now() - requestStartedAt;

          if (routerRoute.type === 'bandit-local' && routerRoute.banditState) {
            const context = banditContextVector(features, body);
            const state = routerRoute.banditState[candidate.model];
            if (state) {
              banditUpdate(state, context, 1);
              try { persistRouterModels(); } catch { /* best-effort */ }
            }
          }

          appendRouterEvent({
            timestamp: new Date().toISOString(),
            router_id: routerRoute.id,
            presented_model: routerPresentedModelId(routerRoute),
            router_type: routerRoute.type,
            selected_model: candidate.model,
            status: result.value.response.status,
            duration_ms: attemptDuration,
            candidate_latency_ms: attemptDuration,
            stream: Boolean(stream),
            ...eventFeatures,
            tool_calls_valid: eventFeatures.tool_calls_requested > 0,
            reward_signal: 1,
            candidate_scores: JSON.stringify(decision.candidateScores),
            error_type: ''
          });
          return sendSuccessfulProxyResponse(
            res,
            model,
            Boolean(stream),
            requestRoute,
            requestStartedAt,
            outputFormat,
            result.value,
            {
              router: {
                route: routerRoute.id,
                type: routerRoute.type,
                selectedModel: candidate.model,
                primarySelectedModel: decision.selected.model,
                candidateAttempt: attempt,
                candidateMaxAttempts: stage.attempts,
                executionStage: stage.stage,
                failedAttemptsBeforeSuccess: attemptLog.length
              }
            }
          );
        }

        lastFailure = result.error;

        if (routerRoute.type === 'bandit-local' && routerRoute.banditState && attempt === stage.attempts) {
          const requestFeats = requestFeatureSummary(body);
          const ctx = banditContextVector(requestFeats, body);
          const state = routerRoute.banditState[candidate.model];
          if (state) {
            banditUpdate(state, ctx, 0);
            try { persistRouterModels(); } catch { /* best-effort */ }
          }
        }

        attemptLog.push({
          routerRoute: routerRoute.id,
          targetModel: candidate.model,
          executionStage: stage.stage,
          candidateAttempt: attempt,
          candidateMaxAttempts: stage.attempts,
          provider: result.error.providerName || null,
          actualModel: result.error.actualModel || null,
          status: result.error.status || null,
          errorType: result.error.errorType,
          errorMessage: sanitizeDiagnosticText(result.error.message, 220),
          providerErrorPreview: sanitizeDiagnosticText(result.error.responseText || '', 280)
        });

        if (isImmediateRouterSkipError(result.error.errorType)) {
          break;
        }

        if (attempt < stage.attempts) {
          const waitSeconds = fallbackRetryDelaySeconds(attempt);
          pushDiagnostic({
            event: 'proxy_error',
            route: requestRoute,
            provider: result.error.providerName,
            presentedModel: model,
            actualModel: result.error.actualModel,
            stream: Boolean(stream),
            status: result.error.status || 500,
            durationMs: Date.now() - requestStartedAt,
            data: {
              routerRetry: { route: routerRoute.id, candidate: candidate.model, attempt, waitBeforeRetrySeconds: waitSeconds },
              errorType: result.error.errorType,
              errorMessage: sanitizeDiagnosticText(result.error.message, 220),
              providerErrorPreview: sanitizeDiagnosticText(result.error.responseText || '', 180)
            }
          });
          await waitMs(waitSeconds * 1000);
        }
      }
    }

    const terminalFailure = lastFailure as AttemptFailure | null;
    const status = terminalFailure?.status || 502;
    const features = requestFeatureSummary(body);
    const eventFeatures = routerEventFeatures(features, body);
    appendRouterEvent({
      timestamp: new Date().toISOString(),
      router_id: routerRoute.id,
      presented_model: routerPresentedModelId(routerRoute),
      router_type: routerRoute.type,
      selected_model: decision.selected.model,
      status,
      duration_ms: Date.now() - requestStartedAt,
      candidate_latency_ms: Date.now() - requestStartedAt,
      stream: Boolean(stream),
      ...eventFeatures,
      tool_calls_valid: false,
      candidate_scores: JSON.stringify(decision.candidateScores),
      error_type: terminalFailure?.errorType || 'router_exhausted'
    });

    const systemFallback = findSystemFallback();
    if (systemFallback) {
      pushDiagnostic({
        event: 'proxy_error',
        route: requestRoute,
        presentedModel: model,
        stream: Boolean(stream),
        status,
        durationMs: Date.now() - requestStartedAt,
        data: {
          routerExhausted: { route: routerRoute.id, attempts: attemptLog.length },
          cascadingToSystemFallback: systemFallback.id
        }
      });
      return executeFallbackRoute(systemFallback, body, model, stream, requestRoute, outputFormat, requestStartedAt, res);
    }

    return res.status(status).json({
      error: `Router model "${routerRoute.id}" exhausted all eligible candidates. No system fallback configured.`,
      router: {
        id: routerPresentedModelId(routerRoute),
        routeId: routerRoute.id,
        type: routerRoute.type,
        selectedModel: decision.selected.model,
        attempts: attemptLog,
        candidateScores: decision.candidateScores
      }
    });
  }

  const fallbackRoute = findFallbackModel(model);
  if (fallbackRoute) {
    return executeFallbackRoute(fallbackRoute, body, model, stream, requestRoute, outputFormat, requestStartedAt, res);
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
    const features = requestFeatureSummary(body);
    const eventFeatures = routerEventFeatures(features, body);
    recordProxyTelemetry({
      routeKind: 'direct',
      presentedModel: String(model),
      selectedModel: directModelResult.value.actualModel || String(model),
      status: directModelResult.value.response.status,
      durationMs: Date.now() - requestStartedAt,
      stream: Boolean(stream),
      body,
      rewardSignal: 1,
      toolCallsValid: eventFeatures.tool_calls_requested > 0
    });
    return sendSuccessfulProxyResponse(
      res,
      model,
      Boolean(stream),
      requestRoute,
      requestStartedAt,
      outputFormat,
      directModelResult.value
    );
  }

  recordProxyTelemetry({
    routeKind: 'direct',
    presentedModel: String(model),
    selectedModel: directModelResult.error.actualModel || String(model),
    status: directModelResult.error.status || 500,
    durationMs: Date.now() - requestStartedAt,
    stream: Boolean(stream),
    body,
    errorType: directModelResult.error.errorType,
    rewardSignal: 0
  });

  const sysFallback = findSystemFallback();
  if (sysFallback && shouldCascadeDirectModelToSystemFallback(model)) {
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
    return executeFallbackRoute(sysFallback, body, model, stream, requestRoute, outputFormat, requestStartedAt, res);
  }

  if (directModelResult.error.errorType === 'upstream_http') {
    const errorBody = directModelResult.error.responseText || directModelResult.error.message;
    return res.status(directModelResult.error.status || 502).send(errorBody);
  }

  const directStatus = directModelResult.error.errorType === 'unknown_model'
    ? 400
    : directModelResult.error.errorType === 'provider_not_found'
      ? 400
      : directModelResult.error.errorType === 'provider_config'
        ? 400
        : 500;

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
  res: Response
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
        recordProxyTelemetry({
          routeKind: 'fallback',
          routerId: fallbackRoute.id,
          presentedModel,
          selectedModel: stage.model,
          status: result.value.response.status,
          durationMs: Date.now() - requestStartedAt,
          stream: Boolean(stream),
          body,
          rewardSignal: 1,
          toolCallsValid: Array.isArray(body?.tools) && body.tools.length > 0
        });
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
          }
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
                  model: data.model || 'claude-3-5-sonnet',
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
                  })}\n\n`);
                  toolBlockStarted = true;
                }
                if (tc.function?.arguments) {
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: textIndex,
                    delta: { type: 'input_json_delta', partial_json: tc.function.arguments }
                  })}\n\n`);
                }
              }
            }

            if (choice.finish_reason) {
              if (contentBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: textIndex
                })}\n\n`);
                contentBlockStarted = false;
              }
              if (toolBlockStarted) {
                res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                  type: 'content_block_stop',
                  index: textIndex
                })}\n\n`);
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

  res.json({
    object: 'list',
    data: providerModels.map((model) => openAIModelEntry(model)),
    catalog_mode: modelSourceConfig.source
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

  res.json({
    models: providerModels.map((model) => ollamaTag(model))
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

loadSessions();
loadFeedback();
loadPqcSecrets();

const server = app.listen(PORT, () => {
  console.log(`Local Router OpenAI-compatible proxy running on http://localhost:${PORT}`);
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

server.on('upgrade', (request, socket, head) => {
  const urlObj = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  if (pathname === '/v1/responses') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});
