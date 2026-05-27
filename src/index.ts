import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Readable, Transform } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { ProxyProvider } from './types';
import { sanitizeProviderRequestBody, stripReasoningMetadata } from './reasoning';

type ProviderModel = {
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

type ProviderSummary = {
  name: string;
  endpoint: string;
  keyEnvVar: string;
  defaultTool: string;
};

type ProviderModelParseResult =
  | { ok: true; models: ProviderModel[] }
  | { ok: false; error: string };

type FallbackModel = {
  id: string;
  models: string[];
};

type FallbackModelParseResult =
  | { ok: true; model: FallbackModel }
  | { ok: false; error: string };

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
};

type RouterModel = {
  id: string;
  type: RouterType;
  candidates: RouterCandidate[];
  minCodingScore?: number;
  costQualityTradeoff?: number;
  explorationBudget?: number;
  banditState?: Record<string, BanditState>;
};

type RouterModelParseResult =
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
  errorType: 'unknown_model' | 'provider_not_found' | 'provider_config' | 'upstream_http' | 'proxy_runtime';
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

type CompletionOutputFormat = 'openai' | 'ollama_chat' | 'ollama_generate';

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
const FALLBACK_PROVIDER_NAME = 'fvs-code';
const FALLBACK_PROVIDER_LEGACY_NAME = 'fallback';
const FALLBACK_PRIMARY_ATTEMPTS = 3;
const FVS_CONFIG_DIR = path.join(os.homedir(), '.config', 'fvs-code');
const FALLBACK_MODELS_PATH = path.join(FVS_CONFIG_DIR, 'fallback-models.json');
const ROUTER_MODELS_PATH = path.join(FVS_CONFIG_DIR, 'router-models.json');
const ROUTER_EVENTS_PATH = path.join(FVS_CONFIG_DIR, 'router-events.csv');
const DEFAULT_ROUTER_TYPE: RouterType = 'auto-local';
const DEFAULT_ROUTER_MIN_CODING_SCORE = 0.66;
const DEFAULT_ROUTER_COST_QUALITY_TRADEOFF = 7;
const ROUTER_CANDIDATE_RETRIES = 2;
const SYSTEM_FALLBACK_ROUTE_ID = 'fallback-models';
const DEFAULT_ROUTER_CANDIDATES_TEXT = [
  'openrouter-1-million-chain-of-draft, coding=0.88, input=1, output=2, latency=1200, notes=DeepSeek V4 Pro + DeepSeek V4 Flash + Xiaomi MiMo-V2.5-Pro',
  'openrouter-chain-of-draft, coding=0.86, input=1, output=2, latency=1300, notes=DeepSeek V4 Pro + MoonshotAI Kimi K2.6 + Xiaomi MiMo-V2.5-Pro',
  'openrouter-openrouter-personal-router, coding=0.84, input=1, output=2, latency=1100, notes=DeepSeek V4 Pro + MoonshotAI Kimi Latest + Xiaomi MiMo-V2.5-Pro',
  'openrouter-1-million-main, coding=0.82, input=1, output=2, latency=1000, notes=DeepSeek V4 Pro + DeepSeek V4 Flash + Xiaomi MiMo-V2.5-Pro',
  'openrouter-free-chain-of-draft, coding=0.72, input=0, output=1, latency=1500, notes=Composition unconfirmed'
].join('\n');
const parsedFallbackBaseRetrySeconds = Number.parseInt(process.env.FVS_FALLBACK_BASE_RETRY_SECONDS || '2', 10);
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
const fallbackModelStore: Record<string, FallbackModel> = {};
const routerModelStore: Record<string, RouterModel> = {};
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

function readProviderSummaries(): ProviderSummary[] {
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

      if (columns.length !== 4) continue;

      const [name, endpoint, keyEnvVar, defaultTool] = columns;
      if (!name || !endpoint || !keyEnvVar) continue;
      if (name.toLowerCase() === 'provider') continue;
      if (!/^[A-Z0-9_]+_API_KEY$/.test(keyEnvVar)) continue;
      if (!/^https?:\/\//.test(endpoint)) continue;

      summaries.push({
        name,
        endpoint,
        keyEnvVar,
        defaultTool
      });
    }

    return summaries;
  } catch (error) {
    console.error('Failed to read providers.txt provider summary table:', error);
    return [];
  }
}

function getProviderSummary(name: string): ProviderSummary | undefined {
  return readProviderSummaries().find((provider) => provider.name === name);
}

function cloneProviderModel(model: ProviderModel): ProviderModel {
  return {
    ...model
  };
}

function baselineProviderModels(providerName: string): ProviderModel[] {
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
  return modelStore[providerName] ? 'memory' : 'baseline';
}

function providerConfigs() {
  return readProviderSummaries().map((provider) => {
    const hasMemoryKey = Boolean(keyStore[provider.name]);
    const hasEnvKey = Boolean(process.env[provider.keyEnvVar]);
    const configured = hasMemoryKey || hasEnvKey;
    const configuredSource = hasMemoryKey ? 'memory' : hasEnvKey ? 'env' : 'none';
    const models = effectiveProviderModels(provider.name);

    return {
      ...provider,
      configured,
      configuredSource,
      modelSource: providerModelSource(provider.name),
      modelCount: models.length,
      models
    };
  });
}

function providerBaseUrlEnvVar(providerName: string) {
  return `FVS_PROVIDER_${providerName.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_BASE_URL`;
}

function providerBaseUrl(summary: ProviderSummary) {
  return process.env[providerBaseUrlEnvVar(summary.name)] || summary.endpoint;
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
  const segment = modelAliasSegment(modelName);
  return `${providerPresentationPrefix(providerName)}-${segment || 'model'}`;
}

function providerModelDisplay(providerName: string, modelName: string) {
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
    `${model.provider}/${model.model}`
  ]);

  if (model.provider === FALLBACK_PROVIDER_NAME) {
    aliases.add(fallbackPresentedModelId(model.model));
    aliases.add(`${FALLBACK_PROVIDER_LEGACY_NAME}/${model.model}`);
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
          error: 'Use colon-separated model aliases: provider-required-model:presented-fvs-code-model.'
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

function parseFallbackModel(payload: any): FallbackModelParseResult {
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
      ? rawModels.split(/[,\r\n]+/)
      : [];

  if (entries.length === 0) {
    return { ok: false, error: 'Fallback models must be a non-empty array or comma/newline-delimited string.' };
  }

  const seen = new Set<string>();
  const models: string[] = [];

  for (const entry of entries) {
    const modelName = typeof entry === 'string' ? entry.trim() : '';
    if (!modelName || modelName.startsWith('#')) continue;
    if (modelName.length > 512) {
      return { ok: false, error: `Fallback model entry is too long: ${modelName.slice(0, 64)}` };
    }
    if (!/^[A-Za-z0-9@._:\/+-]+$/.test(modelName)) {
      return { ok: false, error: `Fallback model entry contains unsupported characters: ${modelName}` };
    }
    if (seen.has(modelName)) continue;
    seen.add(modelName);
    models.push(modelName);
  }

  if (models.length < 2) {
    return { ok: false, error: 'Fallback route requires at least two unique model entries.' };
  }

  return {
    ok: true,
    model: {
      id,
      models
    }
  };
}

function normalizeRouterRouteId(value: string) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (trimmed.startsWith(`${FALLBACK_PROVIDER_NAME}/`)) {
    return trimmed.slice(FALLBACK_PROVIDER_NAME.length + 1).trim();
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

  const candidate: RouterCandidate = { model: modelPart };
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
    }
  }

  return candidate;
}

function parseRouterModel(payload: any): RouterModelParseResult {
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
            notes: typeof entry.notes === 'string' ? sanitizeDiagnosticText(entry.notes, 120) : undefined
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
  if (trimmed.startsWith(`${FALLBACK_PROVIDER_LEGACY_NAME}/`)) {
    return trimmed.slice(FALLBACK_PROVIDER_LEGACY_NAME.length + 1).trim();
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

function ensureFvsConfigDir() {
  fs.mkdirSync(FVS_CONFIG_DIR, { recursive: true, mode: 0o700 });
}

function cloneFallbackModel(model: FallbackModel): FallbackModel {
  return {
    id: model.id,
    models: [...model.models]
  };
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
  ensureFvsConfigDir();
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
  if (!fs.existsSync(FALLBACK_MODELS_PATH)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(FALLBACK_MODELS_PATH, 'utf8'));
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
  ensureFvsConfigDir();
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
  if (!fs.existsSync(ROUTER_MODELS_PATH)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(ROUTER_MODELS_PATH, 'utf8'));
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

      routerModelStore[parsedRoute.model.id] = cloneRouterModel(parsedRoute.model);
    }
  } catch (error: any) {
    console.error('Failed to load persisted router routes:', sanitizeDiagnosticText(String(error?.message || error)));
  }
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
  return [...modelPresentationList(), ...fallbackModelList(), ...routerModelList()];
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
    if (!resolved || resolved.providerName === FALLBACK_PROVIDER_NAME || resolved.providerName === FALLBACK_PROVIDER_LEGACY_NAME) return true;
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
    if (!resolved || resolved.providerName === FALLBACK_PROVIDER_NAME || resolved.providerName === FALLBACK_PROVIDER_LEGACY_NAME) return true;
    return !getProviderSummary(resolved.providerName);
  });

  if (unresolved.length > 0) {
    return { ok: false, error: `Router references unknown candidate model(s): ${unresolved.map((entry) => entry.model).join(', ')}` } as const;
  }

  return { ok: true } as const;
}

function findPresentedNameConflict(providerName: string, presentedName: string) {
  const modelConflict = modelPresentationList().find((model) => (
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
  const lookup = stripOllamaLatestSuffix(modelName.trim());
  return modelPresentationList().find((model) => providerModelAliases(model).has(lookup));
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
    identifier: `ollama/FVS-CODE/${model.id}`,
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
  const models = presentedModelList();
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
    name: 'FVS-CODE',
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
      const identifier = `ollama/FVS-CODE/${model.id}`;
      if (cachedIdentifiers.has(identifier)) continue;
      cachedModels.push(vscodeCachedOllamaModelEntry(model));
      cachedIdentifiers.add(identifier);
    }
    sqliteJsonUpsert(statePath, 'chat.cachedLanguageModels.v2', cachedModels);
  }

  const configuredIDs = new Set<string>();
  for (const model of models) {
    const ids = new Set<string>([
      `ollama/FVS-CODE/${model.id}`,
      `ollama/Ollama/${model.id}`
    ]);

    if (!model.id.includes(':')) {
      ids.add(`ollama/FVS-CODE/${model.id}:latest`);
      ids.add(`ollama/Ollama/${model.id}:latest`);
    }

    for (const id of ids) {
      prefs[id] = true;
      configuredIDs.add(id);
    }
  }

  let removedPickerIDCount = 0;
  for (const id of Object.keys(prefs)) {
    if (id.startsWith('ollama/FVS-CODE/') && !configuredIDs.has(id)) {
      delete prefs[id];
      removedPickerIDCount += 1;
      continue;
    }

    if (!id.startsWith('ollama/Ollama/') || configuredIDs.has(id)) continue;

    const suffix = pickerModelName(id);
    const baseSuffix = stripOllamaLatestSuffix(suffix);
    const matchedModel = candidateToModel.get(suffix) || candidateToModel.get(baseSuffix);
    const isFallbackAlias = baseSuffix.startsWith(`${FALLBACK_PROVIDER_NAME}/`) || baseSuffix.startsWith(`${FALLBACK_PROVIDER_LEGACY_NAME}/`);
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

app.head('/', (req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/', (req: Request, res: Response) => {
  res.type('text/plain').send('Ollama is running');
});

// Serve the Web UI for key management
app.get('/config', (req: Request, res: Response) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>FVS-Code Config</title>
      <style>
        :root {
          color-scheme: light;
          --app-bg: rgb(244, 247, 251);
          --surface: rgb(255, 255, 255);
          --surface-soft: rgb(249, 251, 254);
          --surface-raised: rgb(255, 255, 255);
          --text: rgb(28, 36, 48);
          --muted: rgb(91, 101, 116);
          --border: rgb(214, 224, 236);
          --border-strong: rgb(196, 209, 225);
          --primary: rgb(0, 103, 179);
          --primary-hover: rgb(0, 79, 140);
          --primary-text: rgb(255, 255, 255);
          --primary-soft: rgb(231, 242, 255);
          --secondary-bg: rgb(244, 247, 250);
          --secondary-hover: rgb(232, 238, 246);
          --success-bg: rgb(231, 248, 238);
          --success-text: rgb(31, 122, 61);
          --warning-bg: rgb(255, 243, 221);
          --warning-text: rgb(138, 91, 0);
          --danger-text: rgb(180, 35, 24);
          --log-bg: rgb(15, 23, 42);
          --log-text: rgb(209, 213, 219);
          --shadow: rgba(15, 23, 42, 0.12);
          --focus-ring: rgba(0, 122, 204, 0.18);
        }
        * { box-sizing: border-box; }
        body {
          font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          max-width: 960px;
          margin: 40px auto;
          padding: 20px;
          background: var(--app-bg);
          color: var(--text);
          transition: background-color 160ms ease, color 160ms ease;
        }
        .card {
          background: var(--surface);
          color: var(--text);
          padding: 20px;
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: 0 8px 24px var(--shadow);
          margin-bottom: 20px;
          transition: background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
        }
        h2, h3, h4, h5 { color: var(--text); }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input, textarea, select {
          width: 100%;
          padding: 8px;
          color: var(--text);
          background: var(--surface-raised);
          border: 1px solid var(--border-strong);
          border-radius: 4px;
        }
        input:focus, textarea:focus, select:focus {
          outline: none;
          border-color: var(--primary);
          box-shadow: 0 0 0 3px var(--focus-ring);
        }
        input:disabled { color: var(--muted); background: var(--surface-soft); }
        textarea { min-height: 140px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; font-size: 13px; }
        button {
          background: var(--primary);
          color: var(--primary-text);
          border: 1px solid transparent;
          padding: 10px 15px;
          border-radius: 4px;
          cursor: pointer;
        }
        button:hover { background: var(--primary-hover); }
        a { color: var(--primary); }
        #message { margin-top: 15px; font-weight: bold; color: var(--success-text); }
        .muted { color: var(--muted); font-size: 14px; }
        .catalog { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-top: 16px; }
        .provider-group { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: var(--surface-soft); }
        .provider-group h3 { margin: 0 0 8px; font-size: 16px; }
        .model-list { list-style: none; padding: 0; margin: 0; }
        .model-list li { padding: 6px 0; border-top: 1px solid var(--border); font-size: 14px; word-break: break-word; }
        .model-list li:first-child { border-top: 0; }
        .catalog-meta { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
        .provider-picker { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: end; margin-top: 16px; }
        .provider-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin-top: 16px; }
        .provider-card { border: 1px solid var(--border); border-radius: 8px; padding: 14px; background: var(--surface-raised); }
        .provider-card.active { border-color: var(--primary); box-shadow: 0 0 0 2px var(--focus-ring); }
        .provider-card h4 { margin: 0 0 8px; font-size: 15px; }
        .provider-card .row { margin-top: 10px; }
        .pill { display: inline-block; padding: 3px 8px; border-radius: 999px; background: var(--primary-soft); color: var(--primary); font-size: 12px; margin-left: 8px; }
        .status-pill { margin: 8px 0 0; margin-left: 0; }
        .status-pill.configured { background: var(--success-bg); color: var(--success-text); }
        .status-pill.pending { background: var(--warning-bg); color: var(--warning-text); }
        .row-actions { display: flex; gap: 10px; }
        .button-row { display: flex; gap: 10px; flex-wrap: wrap; }
        .button-secondary { background: var(--secondary-bg); color: var(--text); border: 1px solid var(--border-strong); }
        .button-secondary:hover { background: var(--secondary-hover); }
        #message.error { color: var(--danger-text); }
        #message.success { color: var(--success-text); }
        .theme-panel {
          display: grid;
          grid-template-columns: minmax(180px, 0.45fr) 1fr;
          gap: 18px;
          align-items: center;
          margin-bottom: 18px;
          padding: 14px;
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface-soft);
        }
        .theme-title { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
        .theme-value { color: var(--muted); font-size: 13px; font-weight: 700; }
        .theme-slider { display: grid; gap: 7px; }
        .theme-slider input[type="range"] { padding: 0; border: 0; accent-color: var(--primary); background: transparent; }
        .theme-scale-labels { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; }
        .diagnostics-controls { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
        .diagnostics-log {
          margin-top: 12px;
          border-radius: 8px;
          border: 1px solid var(--border-strong);
          background: var(--log-bg);
          color: var(--log-text);
          padding: 12px;
          min-height: 120px;
          max-height: 320px;
          overflow: auto;
          white-space: pre-wrap;
          word-break: break-word;
          font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
          font-size: 12px;
          line-height: 1.45;
        }
        .model-flag-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 8px; margin-top: 10px; }
        .flag-toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--text); }
        .flag-toggle input { width: auto; margin: 0; }
        .provider-model-list { margin-top: 14px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        .provider-model-item { padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface-raised); }
        .provider-model-item:first-child { border-top: 0; }
        .provider-model-item h5 { margin: 0 0 4px; font-size: 14px; }
        .provider-model-item .meta { font-size: 12px; color: var(--muted); margin: 3px 0; }
        .provider-model-item .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
        .provider-model-item .tag { font-size: 11px; color: var(--primary); background: var(--primary-soft); border-radius: 999px; padding: 2px 7px; }
        .provider-model-item .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
        .provider-model-empty { padding: 10px 12px; font-size: 13px; color: var(--muted); background: var(--surface-soft); }
        .fallback-route-list { margin-top: 14px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
        .fallback-route-item { padding: 10px 12px; border-top: 1px solid var(--border); background: var(--surface-raised); }
        .fallback-route-item:first-child { border-top: 0; }
        .fallback-route-item h4 { margin: 0 0 4px; font-size: 14px; }
        .fallback-route-item .meta { font-size: 12px; color: var(--muted); margin: 3px 0; word-break: break-word; }
        .fallback-route-item .actions { margin-top: 8px; display: flex; gap: 8px; flex-wrap: wrap; }
        .fallback-route-empty { padding: 10px 12px; font-size: 13px; color: var(--muted); background: var(--surface-soft); }
        @media (max-width: 720px) {
          body { margin: 0 auto; padding: 12px; }
          .theme-panel, .provider-picker { grid-template-columns: 1fr; }
          .catalog-meta { align-items: flex-start; flex-direction: column; }
        }
      </style>
      <script>
        const THEME_STORAGE_KEY = 'fvs-code-config-color-scheme-scale';
        const THEME_PRESETS = [
          {
            name: 'Light',
            bg: [244, 247, 251],
            surface: [255, 255, 255],
            surfaceSoft: [249, 251, 254],
            surfaceRaised: [255, 255, 255],
            text: [28, 36, 48],
            muted: [91, 101, 116],
            border: [214, 224, 236],
            borderStrong: [196, 209, 225],
            primary: [0, 103, 179],
            primaryHover: [0, 79, 140],
            primaryText: [255, 255, 255],
            primarySoft: [231, 242, 255],
            secondaryBg: [244, 247, 250],
            secondaryHover: [232, 238, 246],
            successBg: [231, 248, 238],
            successText: [31, 122, 61],
            warningBg: [255, 243, 221],
            warningText: [138, 91, 0],
            dangerText: [180, 35, 24],
            logBg: [15, 23, 42],
            logText: [209, 213, 219],
            shadow: [15, 23, 42, 0.12],
            focusRing: [0, 122, 204, 0.18]
          },
          {
            name: 'Balanced',
            bg: [226, 232, 240],
            surface: [245, 248, 252],
            surfaceSoft: [235, 240, 247],
            surfaceRaised: [250, 252, 255],
            text: [30, 41, 59],
            muted: [82, 96, 117],
            border: [187, 199, 216],
            borderStrong: [161, 176, 198],
            primary: [9, 88, 154],
            primaryHover: [7, 70, 125],
            primaryText: [255, 255, 255],
            primarySoft: [219, 237, 255],
            secondaryBg: [232, 238, 246],
            secondaryHover: [220, 229, 240],
            successBg: [218, 244, 229],
            successText: [25, 106, 54],
            warningBg: [255, 238, 207],
            warningText: [128, 78, 0],
            dangerText: [166, 35, 31],
            logBg: [18, 27, 44],
            logText: [218, 224, 234],
            shadow: [15, 23, 42, 0.16],
            focusRing: [15, 112, 191, 0.22]
          },
          {
            name: 'Dark',
            bg: [15, 20, 29],
            surface: [24, 31, 43],
            surfaceSoft: [29, 38, 52],
            surfaceRaised: [32, 42, 57],
            text: [238, 242, 247],
            muted: [177, 187, 201],
            border: [61, 74, 94],
            borderStrong: [82, 98, 122],
            primary: [98, 178, 255],
            primaryHover: [133, 197, 255],
            primaryText: [8, 19, 33],
            primarySoft: [25, 63, 102],
            secondaryBg: [38, 49, 66],
            secondaryHover: [49, 63, 83],
            successBg: [20, 66, 44],
            successText: [124, 222, 162],
            warningBg: [92, 62, 18],
            warningText: [255, 206, 124],
            dangerText: [255, 137, 127],
            logBg: [8, 12, 20],
            logText: [225, 232, 242],
            shadow: [0, 0, 0, 0.32],
            focusRing: [98, 178, 255, 0.26]
          }
        ];

        function clampThemeScale(rawValue) {
          const value = Number.parseInt(String(rawValue), 10);
          if (!Number.isFinite(value)) return 0;
          return Math.max(0, Math.min(100, value));
        }

        function mixNumber(start, end, amount) {
          return Math.round(start + (end - start) * amount);
        }

        function mixColor(start, end, amount) {
          return start.map((channel, index) => {
            const next = end[index];
            return index === 3
              ? Number((channel + (next - channel) * amount).toFixed(3))
              : mixNumber(channel, next, amount);
          });
        }

        function themeAtScale(scale) {
          const clamped = clampThemeScale(scale);
          const lowerIndex = clamped <= 50 ? 0 : 1;
          const upperIndex = clamped <= 50 ? 1 : 2;
          const amount = clamped <= 50 ? clamped / 50 : (clamped - 50) / 50;
          const lower = THEME_PRESETS[lowerIndex];
          const upper = THEME_PRESETS[upperIndex];
          const theme = { name: clamped < 34 ? 'Light' : clamped < 67 ? 'Balanced' : 'Dark' };

          for (const key of Object.keys(lower)) {
            if (key === 'name') continue;
            theme[key] = mixColor(lower[key], upper[key], amount);
          }
          return theme;
        }

        function cssColor(channels) {
          if (channels.length === 4) return 'rgba(' + channels.join(', ') + ')';
          return 'rgb(' + channels.join(', ') + ')';
        }

        function setThemeVariable(name, channels) {
          document.documentElement.style.setProperty(name, cssColor(channels));
        }

        function applyThemeScale(scale, persist) {
          const clamped = clampThemeScale(scale);
          const theme = themeAtScale(clamped);
          const mapping = {
            '--app-bg': theme.bg,
            '--surface': theme.surface,
            '--surface-soft': theme.surfaceSoft,
            '--surface-raised': theme.surfaceRaised,
            '--text': theme.text,
            '--muted': theme.muted,
            '--border': theme.border,
            '--border-strong': theme.borderStrong,
            '--primary': theme.primary,
            '--primary-hover': theme.primaryHover,
            '--primary-text': theme.primaryText,
            '--primary-soft': theme.primarySoft,
            '--secondary-bg': theme.secondaryBg,
            '--secondary-hover': theme.secondaryHover,
            '--success-bg': theme.successBg,
            '--success-text': theme.successText,
            '--warning-bg': theme.warningBg,
            '--warning-text': theme.warningText,
            '--danger-text': theme.dangerText,
            '--log-bg': theme.logBg,
            '--log-text': theme.logText,
            '--shadow': theme.shadow,
            '--focus-ring': theme.focusRing
          };

          for (const [name, channels] of Object.entries(mapping)) {
            setThemeVariable(name, channels);
          }

          document.documentElement.style.colorScheme = clamped >= 67 ? 'dark' : 'light';
          document.documentElement.dataset.themeScale = String(clamped);

          const input = document.getElementById('colorSchemeScale');
          const value = document.getElementById('colorSchemeValue');
          if (input) input.value = String(clamped);
          if (value) value.innerText = theme.name + ' - ' + clamped + '%';

          if (persist) {
            localStorage.setItem(THEME_STORAGE_KEY, String(clamped));
          }
        }

        function setThemeScale(value) {
          applyThemeScale(value, true);
        }

        function initializeThemeScale() {
          const stored = localStorage.getItem(THEME_STORAGE_KEY);
          applyThemeScale(stored === null ? 0 : stored, false);
        }

        initializeThemeScale();
      </script>
    </head>
    <body>
      <div class="card">
        <div class="theme-panel">
          <div>
            <div class="theme-title">
              <label id="colorSchemeLabel" for="colorSchemeScale">Color Scheme</label>
              <span id="colorSchemeValue" class="theme-value">Light - 0%</span>
            </div>
            <p class="muted">Adjusts contrast, surfaces, borders, and accent colors across the configuration UI.</p>
          </div>
          <div class="theme-slider">
            <input id="colorSchemeScale" type="range" min="0" max="100" step="1" value="0" aria-labelledby="colorSchemeLabel" oninput="setThemeScale(this.value)" onchange="setThemeScale(this.value)">
            <div class="theme-scale-labels" aria-hidden="true">
              <span>Light</span>
              <span>Balanced</span>
              <span>Dark</span>
            </div>
          </div>
        </div>
        <h2>FVS-Code Secure Key Configuration</h2>
        <p>Keys are stored securely in-memory and will be lost on server restart.</p>
        <div class="provider-picker">
          <div class="form-group">
            <label for="providerSelect">Provider</label>
            <select id="providerSelect"></select>
          </div>
          <div class="form-group">
            <label>Provider Key Env Var</label>
            <input id="providerEnvVar" type="text" disabled>
          </div>
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="password" id="providerKey" placeholder="Enter provider API key">
        </div>
        <div class="button-row">
          <button onclick="saveProviderKey()">Save Selected Provider Key</button>
        </div>
        <div class="form-group" style="margin-top:18px;">
          <label>Provider Model Manager (one model at a time)</label>
          <p class="muted">Defaults from providers.txt remain available. Add, update, or delete single models per provider in-memory without removing the provider itself.</p>
          <div class="provider-picker">
            <div class="form-group">
              <label for="modelUpstream">Upstream Model ID</label>
              <input id="modelUpstream" type="text" placeholder="@preset/chain-of-draft">
            </div>
            <div class="form-group">
              <label for="modelPresented">Presented Model Name (alias)</label>
              <input id="modelPresented" type="text" placeholder="openrouter-chain-of-draft">
            </div>
          </div>
          <div class="provider-picker">
            <div class="form-group">
              <label for="modelContextLength">Context Length</label>
              <input id="modelContextLength" type="number" min="1" step="1" value="64000">
            </div>
            <div class="form-group">
              <label for="modelOutputTokens">Max Output Tokens</label>
              <input id="modelOutputTokens" type="number" min="1" step="1" value="4096">
            </div>
          </div>
          <div class="model-flag-grid">
            <label class="flag-toggle"><input id="modelSupportsTools" type="checkbox" checked>Tools</label>
            <label class="flag-toggle"><input id="modelSupportsImages" type="checkbox">Vision</label>
            <label class="flag-toggle"><input id="modelSupportsCache" type="checkbox">Cache</label>
            <label class="flag-toggle"><input id="modelSupportsReasoning" type="checkbox">Reasoning</label>
          </div>
        </div>
        <div class="button-row">
          <button onclick="saveProviderModel()">Add / Update Selected Provider Model</button>
          <button class="button-secondary" onclick="clearProviderModelForm()">Clear Model Form</button>
          <button class="button-secondary" onclick="resetSelectedProviderModels()">Reset Selected Provider Models</button>
          <button class="button-secondary" onclick="configureVSCodePicker()">Refresh VS Code Model Picker</button>
        </div>
        <div class="form-group" style="margin-top:16px;">
          <label>Selected Provider Models</label>
          <div id="providerModelList" class="provider-model-list">
            <div class="provider-model-empty">Loading selected provider models...</div>
          </div>
        </div>
        <div id="message"></div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Fallback Model Routes</h2>
            <p class="muted">Create a presented fallback model from existing model IDs. The route appears in /v1/models, /api/tags, /api/show, and VS Code picker refreshes.</p>
          </div>
          <div class="muted" id="fallbackCount">Loading fallback routes...</div>
        </div>
        <div class="provider-picker">
          <div class="form-group">
            <label for="fallbackRouteId">Presented Fallback Model Name</label>
            <input id="fallbackRouteId" type="text" placeholder="fvs-fallback-main">
          </div>
          <div class="form-group">
            <label for="fallbackModelsText">Fallback Model Chain</label>
            <textarea id="fallbackModelsText" placeholder="wafer-ai-deepseek-v4-pro&#10;openrouter-chain-of-draft&#10;moonshot-kimi-k2.6"></textarea>
          </div>
        </div>
        <div class="button-row">
          <button onclick="saveFallbackRoute()">Add / Update Fallback Route</button>
          <button class="button-secondary" onclick="clearFallbackRouteForm()">Clear Fallback Form</button>
          <button class="button-secondary" onclick="configureVSCodePicker()">Refresh VS Code Model Picker</button>
        </div>
        <div id="fallbackRouteList" class="fallback-route-list">
          <div class="fallback-route-empty">Loading fallback routes...</div>
        </div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Router Models</h2>
            <p class="muted">Create a local router model from explicit candidate model IDs. Routers appear as fvs-code/&lt;name&gt; and only select from the candidates listed here.</p>
          </div>
          <div class="muted" id="routerCount">Loading router models...</div>
        </div>
        <div class="provider-picker">
          <div class="form-group">
            <label for="routerRouteId">Presented Router Model Name</label>
            <input id="routerRouteId" type="text" placeholder="auto-local-main">
          </div>
          <div class="form-group">
            <label for="routerType">Router Type</label>
            <select id="routerType" onchange="toggleBanditFields()">
              <option value="auto-local">auto-local</option>
              <option value="pareto-code">pareto-code</option>
              <option value="priority">priority</option>
              <option value="bandit-local">bandit-local</option>
            </select>
          </div>
        </div>
        <div class="provider-picker">
          <div class="form-group">
            <label for="routerMinCodingScore">Min Coding Score (0-1)</label>
            <input id="routerMinCodingScore" type="number" min="0" max="1" step="0.01" value="0.66">
          </div>
          <div class="form-group">
            <label for="routerCostQualityTradeoff">Cost/Quality Tradeoff (0-10)</label>
            <input id="routerCostQualityTradeoff" type="number" min="0" max="10" step="1" value="7">
          </div>
          <div class="form-group" id="banditExplorationGroup" style="display:none;">
            <label for="routerExplorationBudget">Exploration Budget (0-1)</label>
            <input id="routerExplorationBudget" type="number" min="0" max="1" step="0.01" value="0.05">
            <p class="muted">Controls how much the bandit explores new candidates. Higher = more exploration. 0.05 is a safe default.</p>
          </div>
        </div>
        <div class="form-group">
          <label for="routerCandidatesText">Candidate Models</label>
          <textarea id="routerCandidatesText" placeholder="wafer-ai-deepseek-v4-pro, coding=0.86, input=1, output=2, latency=1200&#10;openrouter-chain-of-draft, coding=0.80&#10;mimo-mimo-v2.5-pro, coding=0.45"></textarea>
        </div>
        <div class="button-row">
          <button onclick="saveRouterRoute()">Add / Update Router Model</button>
          <button class="button-secondary" onclick="clearRouterRouteForm()">Reset Router Defaults</button>
          <button class="button-secondary" onclick="configureVSCodePicker()">Refresh VS Code Model Picker</button>
          <a class="button-secondary" href="/api/router-candidates.csv" style="display:inline-block; text-decoration:none; padding:10px 15px; border-radius:4px;">Export Candidates CSV</a>
          <a class="button-secondary" href="/api/router-events.csv" style="display:inline-block; text-decoration:none; padding:10px 15px; border-radius:4px;">Export Events CSV</a>
          <button class="button-secondary" onclick="recomputeRouter()">Recompute from Telemetry</button>
          <button class="button-secondary" onclick="importRouterBackup()">Import Backup</button>
        </div>
        <div id="recomputeResults" style="margin-top:12px; display:none;">
          <h4>Recompute Results</h4>
          <div id="recomputeSummary" class="muted"></div>
          <div id="recomputeProposals" style="margin-top:8px;"></div>
        </div>
        <input type="file" id="routerImportFile" accept=".json" style="display:none;" onchange="handleRouterImportFile(event)">
        <div id="routerRouteList" class="fallback-route-list">
          <div class="fallback-route-empty">Loading router models...</div>
        </div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Available Providers & Models</h2>
            <p class="muted">This list is generated from providers.txt and powers both the OpenAI-compatible and Ollama-compatible endpoints.</p>
          </div>
          <div class="muted" id="catalogCount">Loading catalog...</div>
        </div>
        <div id="catalog" class="catalog"></div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Provider Key Configs</h2>
            <p class="muted">Select one of the providers from providers.txt, then save the API key in-memory for that backend.</p>
          </div>
          <div class="muted" id="providerCount">Loading providers...</div>
        </div>
        <div id="providerGrid" class="provider-grid"></div>
      </div>
      <div class="card">
        <div class="catalog-meta">
          <div>
            <h2>Diagnostics</h2>
            <p class="muted">Redacted request/response summaries for troubleshooting. API keys, authorization headers, and full payload content are excluded.</p>
          </div>
          <div class="muted" id="diagnosticsStatus">Loading diagnostics...</div>
        </div>
        <div class="diagnostics-controls">
          <button id="diagnosticsToggle" class="button-secondary" onclick="toggleDiagnostics()">Enable Diagnostics</button>
          <button class="button-secondary" onclick="refreshDiagnostics()">Refresh Diagnostics</button>
          <button class="button-secondary" onclick="clearDiagnostics()">Clear Diagnostics</button>
        </div>
        <pre id="diagnosticsLog" class="diagnostics-log">Loading diagnostics...</pre>
      </div>
      <script>
        let providerConfigs = [];
        let fallbackRoutes = [];
        let routerRoutes = [];
        let diagnosticsEnabled = false;
        let activeModelEditId = '';
        let activeFallbackRouteId = '';
        let activeRouterRouteId = '';
        const DEFAULT_ROUTER_CANDIDATES_TEXT = ${JSON.stringify(DEFAULT_ROUTER_CANDIDATES_TEXT)};

        function escapeHtml(value) {
          return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function setMessage(text, type) {
          const messageEl = document.getElementById('message');
          messageEl.classList.remove('error', 'success');
          messageEl.classList.add(type === 'error' ? 'error' : 'success');
          messageEl.innerText = text;
        }

        function renderProviderSelection() {
          const selectEl = document.getElementById('providerSelect');
          const envVarEl = document.getElementById('providerEnvVar');
          const providerGridEl = document.getElementById('providerGrid');
          const providerCountEl = document.getElementById('providerCount');
          const existingSelection = selectEl.value;

          if (!Array.isArray(providerConfigs) || providerConfigs.length === 0) {
            selectEl.innerHTML = '';
            envVarEl.value = '';
            providerCountEl.innerText = '0/0 configured';
            providerGridEl.innerHTML = '';
            renderProviderModelList(null);
            return;
          }

          selectEl.innerHTML = providerConfigs.map((provider) => '<option value="' + escapeHtml(provider.name) + '">' + escapeHtml(provider.name) + '</option>').join('');
          if (providerConfigs.some((provider) => provider.name === existingSelection)) {
            selectEl.value = existingSelection;
          }

          const setSelectedProvider = () => {
            const selected = providerConfigs.find((provider) => provider.name === selectEl.value) || providerConfigs[0];
            if (!selected) return;
            envVarEl.value = selected.keyEnvVar;
            clearProviderModelForm();
            renderProviderModelList(selected);
            highlightSelectedProvider(selected.name);
          };

          selectEl.onchange = setSelectedProvider;
          setSelectedProvider();

          const configuredCount = providerConfigs.filter((provider) => provider.configured).length;
          providerCountEl.innerText = configuredCount + '/' + providerConfigs.length + ' configured';

          providerGridEl.innerHTML = providerConfigs.map((provider) => {
            const statusLabel = provider.configured ? 'Configured' : 'Not configured';
            const statusClass = provider.configured ? 'configured' : 'pending';
            const sourceLabel = provider.configured ? provider.configuredSource : 'none';
            const modelSummary = provider.modelCount + ' models (' + provider.modelSource + ')';
            const capabilitySummary = (Array.isArray(provider.models) ? provider.models : [])
              .slice(0, 3)
              .map((model) => model.id + ' (' + (model.contextLength || 0) + ' ctx, ' + (model.outputTokens || 0) + ' out)')
              .join(', ');
            return '<section class="provider-card" data-provider="' + escapeHtml(provider.name) + '">' +
              '<h4>' + escapeHtml(provider.name) + '<span class="pill">' + escapeHtml(provider.defaultTool) + '</span></h4>' +
              '<div class="muted">Endpoint: ' + escapeHtml(provider.endpoint) + '</div>' +
              '<div class="muted">Key Env Var: ' + escapeHtml(provider.keyEnvVar) + '</div>' +
              '<div class="muted">Configured Source: ' + escapeHtml(sourceLabel) + '</div>' +
              '<div class="muted">Presented Models: ' + escapeHtml(modelSummary) + '</div>' +
              '<div class="muted">' + escapeHtml(capabilitySummary) + '</div>' +
              '<div class="pill status-pill ' + statusClass + '">' + escapeHtml(statusLabel) + '</div>' +
              '<div class="row row-actions">' +
                '<button data-use-provider="' + escapeHtml(provider.name) + '">Use this provider</button>' +
                '<button class="button-secondary" data-reset-provider="' + escapeHtml(provider.name) + '">Reset key</button>' +
              '</div>' +
            '</section>';
          }).join('');

          providerGridEl.querySelectorAll('button[data-use-provider]').forEach((button) => {
            button.addEventListener('click', () => {
              selectProvider(button.getAttribute('data-use-provider') || '');
            });
          });
          providerGridEl.querySelectorAll('button[data-reset-provider]').forEach((button) => {
            button.addEventListener('click', () => {
              resetProviderKey(button.getAttribute('data-reset-provider') || '');
            });
          });

          highlightSelectedProvider(selectEl.value);
        }

        function selectProvider(providerName) {
          const selectEl = document.getElementById('providerSelect');
          selectEl.value = providerName;
          selectEl.dispatchEvent(new Event('change'));
          highlightSelectedProvider(providerName);
        }

        function highlightSelectedProvider(providerName) {
          document.querySelectorAll('.provider-card').forEach((card) => {
            card.classList.toggle('active', card.getAttribute('data-provider') === providerName);
          });
        }

        function selectedProviderConfig() {
          const providerName = document.getElementById('providerSelect').value;
          return providerConfigs.find((provider) => provider.name === providerName) || null;
        }

        function clearProviderModelForm() {
          activeModelEditId = '';
          document.getElementById('modelUpstream').value = '';
          document.getElementById('modelPresented').value = '';
          document.getElementById('modelContextLength').value = '64000';
          document.getElementById('modelOutputTokens').value = '4096';
          document.getElementById('modelSupportsTools').checked = true;
          document.getElementById('modelSupportsImages').checked = false;
          document.getElementById('modelSupportsCache').checked = false;
          document.getElementById('modelSupportsReasoning').checked = false;
        }

        function renderProviderModelList(provider) {
          const listEl = document.getElementById('providerModelList');
          const models = Array.isArray(provider?.models) ? provider.models : [];
          if (!provider) {
            listEl.innerHTML = '<div class="provider-model-empty">Select a provider to manage models.</div>';
            return;
          }
          if (models.length === 0) {
            listEl.innerHTML = '<div class="provider-model-empty">No models configured for this provider.</div>';
            return;
          }

          listEl.innerHTML = models.map((model) => {
            const tags = [];
            if (model.supportsTools) tags.push('tools');
            if (model.supportsImages) tags.push('vision');
            if (model.supportsCache) tags.push('cache');
            if (model.supportsReasoning) tags.push('reasoning');
            const renderedTags = tags.length > 0
              ? tags.map((tag) => '<span class="tag">' + escapeHtml(tag) + '</span>').join('')
              : '<span class="tag">completion</span>';

            return '<div class="provider-model-item" data-model-id="' + escapeHtml(model.id) + '">' +
              '<h5>' + escapeHtml(model.id) + '</h5>' +
              '<div class="meta">Upstream: ' + escapeHtml(model.model) + '</div>' +
              '<div class="meta">Context: ' + escapeHtml(model.contextLength) + ' | Output: ' + escapeHtml(model.outputTokens) + '</div>' +
              '<div class="meta">Source: ' + escapeHtml(provider.modelSource || provider.source || 'baseline') + '</div>' +
              '<div class="tags">' + renderedTags + '</div>' +
              '<div class="actions">' +
                '<button class="button-secondary" data-edit-model="' + escapeHtml(model.id) + '">Edit</button>' +
                '<button class="button-secondary" data-delete-model="' + escapeHtml(model.id) + '">Delete</button>' +
              '</div>' +
            '</div>';
          }).join('');

          listEl.querySelectorAll('button[data-edit-model]').forEach((button) => {
            button.addEventListener('click', () => {
              const modelId = button.getAttribute('data-edit-model') || '';
              const selectedModel = models.find((entry) => entry.id === modelId);
              if (!selectedModel) return;
              activeModelEditId = selectedModel.id;
              document.getElementById('modelUpstream').value = selectedModel.model || '';
              document.getElementById('modelPresented').value = selectedModel.id || '';
              document.getElementById('modelContextLength').value = String(selectedModel.contextLength || 64000);
              document.getElementById('modelOutputTokens').value = String(selectedModel.outputTokens || 4096);
              document.getElementById('modelSupportsTools').checked = Boolean(selectedModel.supportsTools);
              document.getElementById('modelSupportsImages').checked = Boolean(selectedModel.supportsImages);
              document.getElementById('modelSupportsCache').checked = Boolean(selectedModel.supportsCache);
              document.getElementById('modelSupportsReasoning').checked = Boolean(selectedModel.supportsReasoning);
            });
          });

          listEl.querySelectorAll('button[data-delete-model]').forEach((button) => {
            button.addEventListener('click', () => {
              deleteProviderModel(button.getAttribute('data-delete-model') || '');
            });
          });
        }

        async function saveProviderModel() {
          const provider = document.getElementById('providerSelect').value;
          const model = document.getElementById('modelUpstream').value.trim();
          const presentedName = document.getElementById('modelPresented').value.trim();
          const contextLengthRaw = Number.parseInt(document.getElementById('modelContextLength').value, 10);
          const outputTokensRaw = Number.parseInt(document.getElementById('modelOutputTokens').value, 10);

          if (!provider || !model) {
            setMessage('Select a provider and enter an upstream model ID.', 'error');
            return;
          }
          if (!Number.isInteger(contextLengthRaw) || contextLengthRaw <= 0) {
            setMessage('Context length must be a positive integer.', 'error');
            return;
          }
          if (!Number.isInteger(outputTokensRaw) || outputTokensRaw <= 0) {
            setMessage('Max output tokens must be a positive integer.', 'error');
            return;
          }

          const payload = {
            model,
            id: presentedName || undefined,
            contextLength: contextLengthRaw,
            outputTokens: outputTokensRaw,
            supportsTools: document.getElementById('modelSupportsTools').checked,
            supportsImages: document.getElementById('modelSupportsImages').checked,
            supportsCache: document.getElementById('modelSupportsCache').checked,
            supportsReasoning: document.getElementById('modelSupportsReasoning').checked
          };

          const res = await fetch('/api/provider-models/' + encodeURIComponent(provider) + '/models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const responsePayload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(responsePayload?.error || 'Failed to save provider model.', 'error');
            return;
          }

          const action = activeModelEditId ? 'updated' : 'added';
          setMessage('Provider model ' + action + ' in-memory successfully.', 'success');
          clearProviderModelForm();
          await loadProviderConfigs();
          await loadCatalog();
        }

        async function deleteProviderModel(modelId) {
          const provider = document.getElementById('providerSelect').value;
          if (!provider || !modelId) return;

          const res = await fetch('/api/provider-models/' + encodeURIComponent(provider) + '/models/' + encodeURIComponent(modelId), {
            method: 'DELETE'
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to delete provider model.', 'error');
            return;
          }

          setMessage('Removed provider model: ' + modelId, 'success');
          if (activeModelEditId === modelId) {
            clearProviderModelForm();
          }
          await loadProviderConfigs();
          await loadCatalog();
        }

        function clearFallbackRouteForm() {
          activeFallbackRouteId = '';
          document.getElementById('fallbackRouteId').value = '';
          document.getElementById('fallbackRouteId').disabled = false;
          document.getElementById('fallbackModelsText').value = '';
        }

        function renderFallbackRoutes() {
          const countEl = document.getElementById('fallbackCount');
          const listEl = document.getElementById('fallbackRouteList');
          const routes = Array.isArray(fallbackRoutes) ? fallbackRoutes : [];
          countEl.innerText = routes.length + ' fallback route' + (routes.length === 1 ? '' : 's');

          if (routes.length === 0) {
            listEl.innerHTML = '<div class="fallback-route-empty">No fallback routes configured yet.</div>';
            return;
          }

          listEl.innerHTML = routes.map((route) => {
            const models = Array.isArray(route.models) ? route.models : [];
            return '<div class="fallback-route-item" data-fallback-route="' + escapeHtml(route.id) + '">' +
              '<h4>' + escapeHtml(route.id) + '</h4>' +
              '<div class="meta">Chain: ' + escapeHtml(models.join(' -> ')) + '</div>' +
              '<div class="meta">Displayed as: ' + escapeHtml(route.display || ('fallback:' + models.join(' -> '))) + '</div>' +
              '<div class="actions">' +
                '<button class="button-secondary" data-edit-fallback="' + escapeHtml(route.id) + '">Edit</button>' +
                '<button class="button-secondary" data-delete-fallback="' + escapeHtml(route.id) + '">Delete</button>' +
              '</div>' +
            '</div>';
          }).join('');

          listEl.querySelectorAll('button[data-edit-fallback]').forEach((button) => {
            button.addEventListener('click', () => {
              const routeId = button.getAttribute('data-edit-fallback') || '';
              const route = routes.find((entry) => entry.id === routeId);
              if (!route) return;
              activeFallbackRouteId = route.id;
              document.getElementById('fallbackRouteId').value = route.id;
              document.getElementById('fallbackRouteId').disabled = true;
              document.getElementById('fallbackModelsText').value = Array.isArray(route.models) ? route.models.join('\\n') : '';
            });
          });

          listEl.querySelectorAll('button[data-delete-fallback]').forEach((button) => {
            button.addEventListener('click', () => {
              deleteFallbackRoute(button.getAttribute('data-delete-fallback') || '');
            });
          });
        }

        async function loadFallbackRoutes() {
          const res = await fetch('/api/fallback-models');
          const payload = await res.json().catch(() => ({}));
          fallbackRoutes = Array.isArray(payload?.data) ? payload.data : [];
          renderFallbackRoutes();
        }

        async function saveFallbackRoute() {
          const id = document.getElementById('fallbackRouteId').value.trim();
          const modelsText = document.getElementById('fallbackModelsText').value.trim();

          if (!id || !modelsText) {
            setMessage('Enter a fallback model name and at least two model entries.', 'error');
            return;
          }

          const res = await fetch('/api/fallback-models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, modelsText })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to save fallback route.', 'error');
            return;
          }

          setMessage('Fallback route saved persistently.', 'success');
          clearFallbackRouteForm();
          await loadFallbackRoutes();
          await loadCatalog();
        }

        async function deleteFallbackRoute(routeId) {
          if (!routeId) return;

          const res = await fetch('/api/fallback-models', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: routeId })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to delete fallback route.', 'error');
            return;
          }

          setMessage('Removed fallback route: ' + routeId, 'success');
          if (activeFallbackRouteId === routeId) {
            clearFallbackRouteForm();
          }
          await loadFallbackRoutes();
          await loadCatalog();
        }

        function applyRouterDefaults() {
          document.getElementById('routerType').value = 'auto-local';
          document.getElementById('routerMinCodingScore').value = '0.66';
          document.getElementById('routerCostQualityTradeoff').value = '7';
          document.getElementById('routerExplorationBudget').value = '0.05';
          document.getElementById('routerCandidatesText').value = DEFAULT_ROUTER_CANDIDATES_TEXT;
          toggleBanditFields();
        }

        function toggleBanditFields() {
          var isBandit = document.getElementById('routerType').value === 'bandit-local';
          document.getElementById('banditExplorationGroup').style.display = isBandit ? '' : 'none';
        }

        function clearRouterRouteForm() {
          activeRouterRouteId = '';
          document.getElementById('routerRouteId').value = '';
          document.getElementById('routerRouteId').disabled = false;
          applyRouterDefaults();
        }

        function renderRouterRoutes() {
          const countEl = document.getElementById('routerCount');
          const listEl = document.getElementById('routerRouteList');
          const routes = Array.isArray(routerRoutes) ? routerRoutes : [];
          countEl.innerText = routes.length + ' router model' + (routes.length === 1 ? '' : 's');

          if (routes.length === 0) {
            listEl.innerHTML = '<div class="fallback-route-empty">No router models configured yet.</div>';
            return;
          }

          listEl.innerHTML = routes.map((route) => {
            const candidates = Array.isArray(route.candidates) ? route.candidates : [];
            const models = candidates.map((candidate) => candidate.model || candidate).filter(Boolean);
            return '<div class="fallback-route-item" data-router-route="' + escapeHtml(route.id) + '">' +
              '<h4>' + escapeHtml(route.id) + '</h4>' +
              '<div class="meta">Type: ' + escapeHtml(route.type || 'priority') + '</div>' +
              '<div class="meta">Candidates: ' + escapeHtml(models.join(' | ')) + '</div>' +
              '<div class="meta">Displayed as: ' + escapeHtml(route.display || route.id) + '</div>' +
              '<div class="actions">' +
                '<button class="button-secondary" data-edit-router="' + escapeHtml(route.id) + '">Edit</button>' +
                '<button class="button-secondary" data-delete-router="' + escapeHtml(route.id) + '">Delete</button>' +
              '</div>' +
            '</div>';
          }).join('');

          listEl.querySelectorAll('button[data-edit-router]').forEach((button) => {
            button.addEventListener('click', () => {
              const routeId = button.getAttribute('data-edit-router') || '';
              const route = routes.find((entry) => entry.id === routeId);
              if (!route) return;
              activeRouterRouteId = route.id;
              document.getElementById('routerRouteId').value = route.id;
              document.getElementById('routerRouteId').disabled = true;
              document.getElementById('routerType').value = route.type || 'auto-local';
              document.getElementById('routerMinCodingScore').value = route.minCodingScore ?? '0.66';
              document.getElementById('routerCostQualityTradeoff').value = route.costQualityTradeoff ?? '7';
              document.getElementById('routerExplorationBudget').value = route.explorationBudget ?? '0.05';
              toggleBanditFields();
              document.getElementById('routerCandidatesText').value = Array.isArray(route.candidates)
                ? route.candidates.map((candidate) => {
                    const parts = [candidate.model];
                    if (candidate.codingScore !== undefined) parts.push('coding=' + candidate.codingScore);
                    if (candidate.inputPrice !== undefined) parts.push('input=' + candidate.inputPrice);
                    if (candidate.outputPrice !== undefined) parts.push('output=' + candidate.outputPrice);
                    if (candidate.latencyMs !== undefined) parts.push('latency=' + candidate.latencyMs);
                    return parts.join(', ');
                  }).join('\\n')
                : '';
            });
          });

          listEl.querySelectorAll('button[data-delete-router]').forEach((button) => {
            button.addEventListener('click', () => {
              deleteRouterRoute(button.getAttribute('data-delete-router') || '');
            });
          });
        }

        async function loadRouterRoutes() {
          const res = await fetch('/api/router-models');
          const payload = await res.json().catch(() => ({}));
          routerRoutes = Array.isArray(payload?.data) ? payload.data : [];
          renderRouterRoutes();
        }

        async function saveRouterRoute() {
          const id = document.getElementById('routerRouteId').value.trim();
          const type = document.getElementById('routerType').value;
          const candidatesText = document.getElementById('routerCandidatesText').value.trim();
          const minCodingScoreRaw = document.getElementById('routerMinCodingScore').value;
          const costQualityTradeoffRaw = document.getElementById('routerCostQualityTradeoff').value;
          const explorationBudgetRaw = document.getElementById('routerExplorationBudget').value;

          if (!id || !candidatesText) {
            setMessage('Enter a router model name and at least one candidate model.', 'error');
            return;
          }

          const payload = { id, type, candidatesText };
          if (minCodingScoreRaw !== '') payload.minCodingScore = Number(minCodingScoreRaw);
          if (costQualityTradeoffRaw !== '') payload.costQualityTradeoff = Number(costQualityTradeoffRaw);
          if (explorationBudgetRaw !== '' && type === 'bandit-local') payload.explorationBudget = Number(explorationBudgetRaw);

          const res = await fetch('/api/router-models', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const responsePayload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(responsePayload?.error || 'Failed to save router model.', 'error');
            return;
          }

          setMessage('Router model saved persistently.', 'success');
          clearRouterRouteForm();
          await loadRouterRoutes();
          await loadCatalog();
        }

        async function deleteRouterRoute(routeId) {
          if (!routeId) return;

          const res = await fetch('/api/router-models', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: routeId })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to delete router model.', 'error');
            return;
          }

          setMessage('Removed router model: ' + routeId, 'success');
          if (activeRouterRouteId === routeId) {
            clearRouterRouteForm();
          }
          await loadRouterRoutes();
          await loadCatalog();
        }

        async function recomputeRouter() {
          const routeId = activeRouterRouteId || document.getElementById('routerRouteId').value.trim();
          if (!routeId) {
            setMessage('Select or enter a router model name first.', 'error');
            return;
          }

          setMessage('Analyzing telemetry...', 'success');
          const res = await fetch('/api/router-models/' + encodeURIComponent(routeId) + '/recompute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Recompute failed.', 'error');
            return;
          }

          const resultsEl = document.getElementById('recomputeResults');
          const summaryEl = document.getElementById('recomputeSummary');
          const proposalsEl = document.getElementById('recomputeProposals');
          resultsEl.style.display = '';

          summaryEl.innerHTML = payload.totalSampleCount + ' samples analyzed. ' + escapeHtml(payload.recommendation || '');

          const proposals = Array.isArray(payload.proposals) ? payload.proposals : [];
          if (proposals.length === 0) {
            proposalsEl.innerHTML = '<div class="muted">No proposals to review.</div>';
            setMessage('Recompute complete. No changes needed.', 'success');
            return;
          }

          proposalsEl.innerHTML = proposals.map((proposal) => {
            const changes = Array.isArray(proposal.changes) ? proposal.changes : [];
            const needsReview = Boolean(proposal.needsReview);
            if (!needsReview) {
              return '<div class="provider-model-item" style="opacity:0.65;">' +
                '<h5>' + escapeHtml(proposal.model) + '</h5>' +
                '<div class="meta">' + escapeHtml(proposal.sampleCount) + ' samples | success rate: ' + escapeHtml(proposal.successRate) + ' | median latency: ' + (proposal.medianLatencyMs !== null ? escapeHtml(proposal.medianLatencyMs) + 'ms' : 'N/A') + '</div>' +
                '<div class="muted">No changes needed — metadata consistent with observed telemetry.</div>' +
                '</div>';
            }

            return '<div class="provider-model-item" style="border-left:3px solid #007acc;">' +
              '<h5>' + escapeHtml(proposal.model) + '</h5>' +
              '<div class="meta">' + escapeHtml(proposal.sampleCount) + ' samples | success rate: ' + escapeHtml(proposal.successRate) + (proposal.toolCallAccuracy !== null ? ' | tool accuracy: ' + escapeHtml(proposal.toolCallAccuracy) : '') + '</div>' +
              '<div class="meta">Changes: ' + escapeHtml(changes.join('; ') || 'none') + '</div>' +
              '<div class="actions">' +
                '<button class="button-secondary" data-apply-proposal="' + escapeHtml(proposal.model) + '" data-proposed-coding="' + escapeHtml(proposal.proposedCodingScore) + '" data-proposed-latency="' + (proposal.proposedLatencyMs !== undefined ? escapeHtml(proposal.proposedLatencyMs) : '') + '">Apply these updates to form</button>' +
              '</div>' +
              '</div>';
          }).join('');

          proposalsEl.querySelectorAll('button[data-apply-proposal]').forEach((button) => {
            button.addEventListener('click', () => {
              const model = button.getAttribute('data-apply-proposal') || '';
              const proposedCoding = button.getAttribute('data-proposed-coding') || '';
              const proposedLatency = button.getAttribute('data-proposed-latency') || '';

              const textarea = document.getElementById('routerCandidatesText');
              const lines = textarea.value.split('\\n');
              const updated = lines.map((line) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) return line;
                const parts = trimmed.split(',').map((p) => p.trim());
                if (parts[0] !== model) return line;
                const metadata = parts.slice(1).map((part) => {
                  const [key] = part.split('=');
                  const k = key.trim().toLowerCase();
                  if (k === 'coding' && proposedCoding) return 'coding=' + proposedCoding;
                  if (k === 'latency' && proposedLatency) return 'latency=' + proposedLatency;
                  return part;
                });
                return [parts[0], ...metadata].join(', ');
              });
              textarea.value = updated.join('\\n');
              setMessage('Applied proposed updates for ' + model + ' to the candidate form. Review and save the router.', 'success');
            });
          });

          setMessage('Recompute complete. ' + proposals.filter((p) => p.needsReview).length + ' candidate(s) need review.', 'success');
        }

        function importRouterBackup() {
          document.getElementById('routerImportFile').click();
        }

        async function handleRouterImportFile(event) {
          const file = event.target?.files?.[0];
          if (!file) return;

          try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const res = await fetch('/api/router-models/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(parsed)
            });
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              setMessage(payload?.error || 'Import failed.', 'error');
              return;
            }

            setMessage(payload?.summary || 'Import complete.', 'success');
            await loadRouterRoutes();
            await loadCatalog();
          } catch (err) {
            setMessage('Failed to parse import file. Expected JSON with a "routers" array.', 'error');
          }

          event.target.value = '';
        }

        function formatDiagnosticsEntry(entry) {
          const timestamp = entry?.timestamp || '';
          const event = entry?.event || 'event';
          const route = entry?.route || '';
          const provider = entry?.provider ? ' provider=' + entry.provider : '';
          const model = entry?.presentedModel ? ' model=' + entry.presentedModel : '';
          const actual = entry?.actualModel ? ' upstream=' + entry.actualModel : '';
          const stream = entry?.stream !== undefined ? ' stream=' + Boolean(entry.stream) : '';
          const status = entry?.status !== undefined ? ' status=' + entry.status : '';
          const duration = entry?.durationMs !== undefined ? ' durationMs=' + entry.durationMs : '';
          const summary = JSON.stringify(entry?.data || {}, null, 2);
          return '[' + timestamp + '] ' + event + ' route=' + route + provider + model + actual + stream + status + duration + '\\n' + summary;
        }

        async function refreshDiagnostics() {
          const statusEl = document.getElementById('diagnosticsStatus');
          const toggleEl = document.getElementById('diagnosticsToggle');
          const logEl = document.getElementById('diagnosticsLog');

          try {
            const res = await fetch('/api/diagnostics?limit=120');
            const payload = await res.json().catch(() => ({}));
            if (!res.ok) {
              statusEl.innerText = payload?.error || 'Diagnostics unavailable';
              logEl.textContent = 'Failed to load diagnostics.';
              return;
            }

            diagnosticsEnabled = Boolean(payload?.enabled);
            const entryCount = Number(payload?.entryCount || 0);
            const maxEntries = Number(payload?.maxEntries || 0);
            statusEl.innerText = (diagnosticsEnabled ? 'Enabled' : 'Disabled') + ' | ' + entryCount + '/' + maxEntries + ' entries';
            toggleEl.innerText = diagnosticsEnabled ? 'Disable Diagnostics' : 'Enable Diagnostics';

            const entries = Array.isArray(payload?.entries) ? payload.entries : [];
            const rendered = entries.map((entry) => formatDiagnosticsEntry(entry)).join('\\n\\n');
            logEl.textContent = rendered || 'No diagnostics captured yet.';
          } catch (error) {
            statusEl.innerText = 'Diagnostics unavailable';
            logEl.textContent = 'Failed to load diagnostics.';
          }
        }

        async function toggleDiagnostics() {
          const nextState = !diagnosticsEnabled;
          const res = await fetch('/api/diagnostics', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: nextState })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to update diagnostics setting.', 'error');
            return;
          }

          diagnosticsEnabled = Boolean(payload?.enabled);
          setMessage('Diagnostics ' + (diagnosticsEnabled ? 'enabled' : 'disabled') + '.', 'success');
          await refreshDiagnostics();
        }

        async function clearDiagnostics() {
          const res = await fetch('/api/diagnostics', { method: 'DELETE' });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to clear diagnostics.', 'error');
            return;
          }

          setMessage('Diagnostics cleared.', 'success');
          await refreshDiagnostics();
        }

        async function loadProviderConfigs() {
          const res = await fetch('/api/provider-configs');
          const payload = await res.json();
          providerConfigs = Array.isArray(payload?.data) ? payload.data : [];
          renderProviderSelection();
        }

        async function saveKeys() {
          const provider = document.getElementById('providerSelect').value;
          const keyInputEl = document.getElementById('providerKey');
          const apiKey = keyInputEl.value;

          if (!provider || !apiKey) {
            setMessage('Select a provider and enter an API key before saving.', 'error');
            return;
          }

          const res = await fetch('/api/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, apiKey })
          });

          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
             setMessage(payload?.error || 'Failed to save provider key.', 'error');
             return;
          }

          keyInputEl.value = '';
          setMessage('Provider key saved in-memory successfully.', 'success');
          await loadProviderConfigs();
          await loadCatalog();
        }

        async function resetProviderKey(providerName) {
          if (!providerName) return;

          const res = await fetch('/api/keys/' + encodeURIComponent(providerName), {
            method: 'DELETE'
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to reset provider key.', 'error');
            return;
          }

          document.getElementById('providerKey').value = '';
          setMessage('Cleared in-memory key for ' + providerName + '.', 'success');
          await loadProviderConfigs();
          await loadCatalog();
        }

        function saveProviderKey() {
          saveKeys();
        }

        async function resetSelectedProviderModels() {
          const provider = document.getElementById('providerSelect').value;
          if (!provider) return;

          const res = await fetch('/api/provider-models/' + encodeURIComponent(provider), {
            method: 'DELETE'
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to reset provider models.', 'error');
            return;
          }

          setMessage('Provider models reset to providers.txt baseline.', 'success');
          clearProviderModelForm();
          await loadProviderConfigs();
          await loadCatalog();
        }

        async function configureVSCodePicker() {
          const res = await fetch('/api/vscode/configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) {
            setMessage(payload?.error || 'Failed to refresh VS Code model picker.', 'error');
            return;
          }

          setMessage('VS Code model picker refreshed. Reload the VS Code window if the dropdown is already open.', 'success');
        }

        async function loadCatalog() {
          const catalogEl = document.getElementById('catalog');
          const countEl = document.getElementById('catalogCount');

          try {
            const res = await fetch('/v1/models');
            const payload = await res.json();
            const data = Array.isArray(payload?.data) ? payload.data : [];

            const grouped = data.reduce((acc, model) => {
              const provider = model.owned_by || 'unknown';
              if (!acc[provider]) acc[provider] = [];
              acc[provider].push(model);
              return acc;
            }, {});

            const providerNames = Object.keys(grouped).sort();
            countEl.innerText = data.length + ' models across ' + providerNames.length + ' providers';

            catalogEl.innerHTML = providerNames.map((provider) => {
              const models = grouped[provider]
                .map((model) => '<li><strong>' + escapeHtml(model.id) + '</strong><br><span class="muted">' + escapeHtml(model.display_name || '') + '</span><br><span class="muted">Context: ' + escapeHtml(model.context_length || '') + ' | Output: ' + escapeHtml(model.max_output_tokens || '') + '</span></li>')
                .join('');

              return '<section class="provider-group">' +
                '<h3>' + escapeHtml(provider) + '</h3>' +
                '<ul class="model-list">' + models + '</ul>' +
              '</section>';
            }).join('');
          } catch (error) {
            countEl.innerText = 'Unable to load catalog';
            catalogEl.innerHTML = '<div class="muted">The provider catalog could not be loaded from /v1/models.</div>';
          }
        }

        initializeThemeScale();
        loadProviderConfigs();
        loadFallbackRoutes();
        loadRouterRoutes();
        applyRouterDefaults();
        loadCatalog();
        refreshDiagnostics();
      </script>
    </body>
    </html>
  `);
});

app.get('/ui', (req: Request, res: Response) => {
  res.redirect('/config');
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

    keyStore[providerName] = keyValue;
    process.env[summary.keyEnvVar] = keyValue;
    return res.json({
      success: true,
      provider: providerName,
      keyEnvVar: summary.keyEnvVar,
      configured: true,
      configuredSource: 'memory'
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

  delete keyStore[providerName];
  delete process.env[summary.keyEnvVar];

  return res.json({
    success: true,
    provider: providerName,
    keyEnvVar: summary.keyEnvVar,
    configured: false,
    configuredSource: 'none'
  });
});

app.get('/api/provider-configs', (req: Request, res: Response) => {
  res.json({ object: 'list', data: providerConfigs() });
});

app.get('/api/provider-models', (req: Request, res: Response) => {
  const providers = readProviderSummaries().map((provider) => ({
    provider: provider.name,
    source: providerModelSource(provider.name),
    models: effectiveProviderModels(provider.name)
  }));

  res.json({ object: 'list', data: providers });
});

app.get('/api/provider-models/:provider', (req: Request, res: Response) => {
  const providerName = String(req.params.provider || '').trim();
  const summary = getProviderSummary(providerName);
  if (!summary) {
    return res.status(404).json({ error: `Unknown provider: ${providerName}` });
  }

  return res.json({
    provider: providerName,
    source: providerModelSource(providerName),
    models: effectiveProviderModels(providerName)
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
  return res.json({
    success: true,
    provider: providerName,
    source: providerModelSource(providerName),
    models: effectiveProviderModels(providerName)
  });
});

app.get('/api/fallback-models', (req: Request, res: Response) => {
  const data = Object.values(fallbackModelStore)
    .map((model) => ({
      ...model,
      id: fallbackPresentedModelId(model),
      routeId: normalizeFallbackRouteId(model.id),
      display: fallbackModelPresentation(model).display
    }))
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

app.post('/api/router-models', (req: Request, res: Response) => {
  const parsed = parseRouterModel(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }

  const canonicalRouterId = routerPresentedModelId(parsed.model);
  const sameIdAsProvider = modelPresentationList().some((model) => (
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
  routerModelStore[parsed.model.id] = cloneRouterModel(parsed.model);

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
  if (!fs.existsSync(ROUTER_EVENTS_PATH)) {
    return res.send('timestamp,router_id,presented_model,router_type,selected_model,status,duration_ms,stream,requires_tools,requires_images,approx_input_tokens,requested_output_tokens,candidate_scores,error_type\n');
  }
  return res.send(fs.readFileSync(ROUTER_EVENTS_PATH, 'utf8'));
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
  const eventsPath = ROUTER_EVENTS_PATH;

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

  for (const candidate of router.candidates) {
    const stats = candidateStats[candidate.model];
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
    if (typeof candidate.latencyMs === 'number' && proposedLatency && Math.abs(proposedLatency - candidate.latencyMs) > 200) {
      changes.push(`latency: ${candidate.latencyMs}ms → ${proposedLatency}ms`);
    }
    if (typeof candidate.codingScore !== 'number') {
      changes.push(`coding: (unset) → ${proposedCoding} (inferred)`);
    }

    proposals.push({
      model: candidate.model,
      currentCodingScore: candidate.codingScore,
      currentInputPrice: candidate.inputPrice,
      currentOutputPrice: candidate.outputPrice,
      currentLatencyMs: candidate.latencyMs,
      sampleCount: stats.attempts,
      successRate: Number(successRate.toFixed(4)),
      medianLatencyMs: medianLatency,
      toolCallAccuracy: toolAccuracy ? Number(toolAccuracy.toFixed(4)) : null,
      proposedCodingScore: proposedCoding,
      proposedLatencyMs: proposedLatency,
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
  const sameIdAsProvider = modelPresentationList().some((model) => (
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
  fallbackModelStore[parsed.model.id] = {
    id: parsed.model.id,
    models: [...parsed.model.models]
  };

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
      ...fallbackModelStore[parsed.model.id],
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

app.head('/api/version', (req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/api/version', (req: Request, res: Response) => {
  res.json({ version: process.env.OLLAMA_VERSION || '0.6.4' });
});

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
  const providers = readProviderSummaries();
  if (providers.length === 0) {
    return readProviderModels();
  }

  return providers.flatMap((provider) => effectiveProviderModels(provider.name));
}

loadPersistedFallbackModels();
loadPersistedRouterModels();

const DEFAULT_ROUTER_ID = 'auto-local-main';

function ensureDefaultRouter() {
  if (routerModelStore[DEFAULT_ROUTER_ID]) return;

  const hasAnyRouter = Object.keys(routerModelStore).length > 0;
  if (hasAnyRouter) return;

  const parsed = parseRouterModel({
    id: DEFAULT_ROUTER_ID,
    type: DEFAULT_ROUTER_TYPE,
    minCodingScore: DEFAULT_ROUTER_MIN_CODING_SCORE,
    costQualityTradeoff: DEFAULT_ROUTER_COST_QUALITY_TRADEOFF,
    candidatesText: DEFAULT_ROUTER_CANDIDATES_TEXT
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

  routerModelStore[parsed.model.id] = cloneRouterModel(parsed.model);
  try {
    persistRouterModels();
  } catch (error: any) {
    console.error('Failed to persist default router:', sanitizeDiagnosticText(String(error?.message || error)));
    delete routerModelStore[parsed.model.id];
  }
}

ensureDefaultRouter();

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

function providerHasConfiguredKey(providerName: string) {
  const summary = getProviderSummary(providerName);
  if (!summary) return false;
  return Boolean(keyStore[summary.name] || process.env[summary.keyEnvVar]);
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
  const inputPrice = typeof candidate.inputPrice === 'number' ? candidate.inputPrice : 0;
  const outputPrice = typeof candidate.outputPrice === 'number' ? candidate.outputPrice : 0;
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

  if (!target || target.providerName === FALLBACK_PROVIDER_NAME || target.providerName === FALLBACK_PROVIDER_LEGACY_NAME) {
    rejectionReasons.push('unresolved');
  }
  if (target && !providerHasConfiguredKey(target.providerName)) {
    rejectionReasons.push('missing_provider_key');
  }
  if (resolved) {
    if (features.requiresTools && !resolved.supportsTools) rejectionReasons.push('tools_required');
    if (features.requiresImages && !resolved.supportsImages) rejectionReasons.push('vision_required');
    if (features.approxInputTokens + features.requestedOutputTokens > resolved.contextLength) rejectionReasons.push('context_exceeded');
    if (features.requestedOutputTokens > resolved.outputTokens) rejectionReasons.push('output_exceeded');
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
    latencyMs: entry.latencyMs,
    banditScore: entry.eligible ? Number(entry.banditScore.toFixed(4)) : null,
    uncertainty: entry.eligible ? Number(entry.uncertainty.toFixed(4)) : null,
    sampleCount: entry.eligible ? (banditState[entry.candidate.model]?.sampleCount || 0) : null,
    score: entry.eligible ? Number(entry.banditScore.toFixed(4)) : null
  }));

  const eligibleEntries = scored.filter((entry) => entry.eligible);
  if (eligibleEntries.length === 0) {
    return {
      error: 'Router has no eligible configured candidate models for this request.',
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
    ordered = [...unexplored.sort((a, b) => (banditState[a.candidate.model]?.sampleCount || 0) - (banditState[b.candidate.model]?.sampleCount || 0)), ...explored.sort((a, b) => b.banditScore - a.banditScore || a.index - b.index)];
  } else {
    ordered = eligibleEntries.sort((a, b) => b.banditScore - a.banditScore || a.index - b.index);
  }

  return {
    router,
    selected: ordered[0].candidate,
    orderedCandidates: ordered.map((entry) => entry.candidate),
    candidateScores
  };
}

function selectRouterCandidate(router: RouterModel, body: any): RouterDecision | { error: string; candidateScores: Array<Record<string, unknown>> } {
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
  const allCosts = scored.map((entry) => entry.cost).filter((c) => c !== Number.MAX_SAFE_INTEGER);
  const maxCost = allCosts.length > 0 ? Math.max(...allCosts) : 1;
  const maxLatency = Math.max(...scored.map((entry) => entry.latencyMs), 1);

  const scoredNormalized = scored.map((entry) => {
    if (!entry.eligible) {
      return { ...entry, score: Number.NEGATIVE_INFINITY };
    }

    const qualityWeight = router.type === 'auto-local' ? tradeOff / 10 : router.type === 'pareto-code' ? 1.0 : 1.0;
    const costWeight = router.type === 'auto-local' ? (10 - tradeOff) / 10 : router.type === 'pareto-code' ? 0.2 : 1.0;
    const latencyWeight = router.type === 'auto-local' ? 0.1 : router.type === 'pareto-code' ? 0.1 : 0.3;

    const normalizedCoding = entry.codingScore;
    const normalizedCost = maxCost > 0 ? entry.cost / maxCost : 0;
    const normalizedLatency = entry.latencyMs / maxLatency;
    const indexPenalty = entry.index / Math.max(scored.length, 1);

    const score = (qualityWeight * normalizedCoding)
      - (costWeight * normalizedCost)
      - (latencyWeight * normalizedLatency)
      - (0.001 * indexPenalty);

    return { ...entry, score };
  });

  const candidateScores = scoredNormalized.map((entry) => ({
    model: entry.candidate.model,
    eligible: entry.eligible,
    reasons: entry.reasons,
    codingScore: Number(entry.codingScore.toFixed(4)),
    costEstimate: entry.cost === Number.MAX_SAFE_INTEGER ? null : entry.cost,
    latencyMs: entry.latencyMs,
    score: Number.isFinite(entry.score) ? Number(entry.score.toFixed(4)) : null
  }));

  const eligibleEntries = scoredNormalized.filter((entry) => entry.eligible && Number.isFinite(entry.score));
  if (eligibleEntries.length === 0) {
    return {
      error: 'Router has no eligible configured candidate models for this request.',
      candidateScores
    };
  }

  const ordered = router.type === 'priority'
    ? eligibleEntries.sort((a, b) => a.index - b.index)
    : eligibleEntries.sort((a, b) => b.score - a.score || a.index - b.index);

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

function routerEventFeatures(features: ReturnType<typeof requestFeatureSummary>, body: any) {
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
    reward_signal: 0
  };
}

function appendRouterEvent(event: Record<string, unknown>) {
  ensureFvsConfigDir();
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
    'candidate_scores',
    'error_type'
  ];
  if (!fs.existsSync(ROUTER_EVENTS_PATH)) {
    fs.writeFileSync(ROUTER_EVENTS_PATH, `${headers.join(',')}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  const row = headers.map((header) => csvEscape(event[header])).join(',');
  fs.appendFileSync(ROUTER_EVENTS_PATH, `${row}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(ROUTER_EVENTS_PATH, 0o600);
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
    providerHeaders = provider.getHeaders();
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

  const requestBody = {
    ...body,
    model: target.actualModel
  };
  const safeRequestBody = sanitizeProviderRequestBody(requestBody, {
    providerName: target.providerName,
    modelName: target.actualModel
  });
  const finalBody = provider.formatBody ? provider.formatBody(safeRequestBody) : safeRequestBody;

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
      return {
        ok: false,
        error: {
          errorType: 'upstream_http',
          providerName: target.providerName,
          actualModel: target.actualModel,
          status: response.status,
          message: `Provider error (${response.status})`,
          responseText
        }
      };
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
  const data = stripReasoningMetadata(upstreamData);

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

function fallbackExecutionPlan(models: string[]) {
  const stages: Array<{ stage: string; model: string; attempts: number; primary: boolean }> = [];
  if (models.length === 0) return stages;

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index];
    stages.push({
      stage: `primary-${index + 1}`,
      model,
      attempts: FALLBACK_PRIMARY_ATTEMPTS,
      primary: true
    });

    if (index < models.length - 1 && index > 0) {
      for (let bridgeIndex = 0; bridgeIndex <= index; bridgeIndex += 1) {
        stages.push({
          stage: `bridge-${index + 1}-to-${index + 2}`,
          model: models[bridgeIndex],
          attempts: 1,
          primary: false
        });
      }
    }
  }

  return stages;
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
    for (let index = 0; index < decision.orderedCandidates.length; index += 1) {
      const candidate = decision.orderedCandidates[index];
      const routerData = {
        route: routerRoute.id,
        type: routerRoute.type,
        selectedModel: decision.selected.model,
        targetModel: candidate.model,
        candidateIndex: index + 1,
        candidateCount: decision.orderedCandidates.length,
        candidateScores: decision.candidateScores
      };

      let candidateSucceeded = false;
      for (let attempt = 1; attempt <= 1 + ROUTER_CANDIDATE_RETRIES; attempt += 1) {
        const result = await proxyModelAttempt(
          body,
          requestRoute,
          outputFormat,
          model,
          candidate.model,
          Boolean(stream),
          requestStartedAt,
          { ...routerData, candidateAttempt: attempt, candidateMaxAttempts: 1 + ROUTER_CANDIDATE_RETRIES }
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
                candidateMaxAttempts: 1 + ROUTER_CANDIDATE_RETRIES,
                failedAttemptsBeforeSuccess: attemptLog.length
              }
            }
          );
        }

        lastFailure = result.error;

        if (routerRoute.type === 'bandit-local' && routerRoute.banditState && attempt === 1 + ROUTER_CANDIDATE_RETRIES) {
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
          candidateAttempt: attempt,
          candidateMaxAttempts: 1 + ROUTER_CANDIDATE_RETRIES,
          provider: result.error.providerName || null,
          actualModel: result.error.actualModel || null,
          status: result.error.status || null,
          errorType: result.error.errorType,
          errorMessage: sanitizeDiagnosticText(result.error.message, 220),
          providerErrorPreview: sanitizeDiagnosticText(result.error.responseText || '', 280)
        });

        if (attempt <= ROUTER_CANDIDATE_RETRIES) {
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

  const sysFallback = findSystemFallback();
  if (sysFallback) {
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
  const plan = fallbackExecutionPlan(fallbackRoute.models);
    const attemptLog: Array<Record<string, unknown>> = [];
    let lastFailure: AttemptFailure | null = null;

    for (let stageIndex = 0; stageIndex < plan.length; stageIndex += 1) {
      const stage = plan[stageIndex];
      for (let attempt = 1; attempt <= stage.attempts; attempt += 1) {
        const fallbackData = {
          route: fallbackRoute.id,
          stage: stage.stage,
          stageIndex: stageIndex + 1,
          stageAttempts: stage.attempts,
          attempt,
          targetModel: stage.model,
          totalStages: plan.length,
          primaryStage: stage.primary
        };

        const result = await proxyModelAttempt(
          body,
          requestRoute,
          outputFormat,
          presentedModel,
          stage.model,
          Boolean(stream),
          requestStartedAt,
          fallbackData
        );

        if (result.ok) {
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
        attempts: attemptLog
      }
    });
}

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  await handleChatCompletion(req, res);
});

app.get('/v1/models', async (req: Request, res: Response) => {
  // fcc-server style: we can optionally pass ?provider=groq to fetch models from a specific provider
  const requestedProvider = req.query.provider as string;
  const providerModels = presentedModelList();

  if (requestedProvider) {
    if (requestedProvider === FALLBACK_PROVIDER_NAME || requestedProvider === FALLBACK_PROVIDER_LEGACY_NAME) {
      return res.json({
        object: 'list',
        data: [...fallbackModelList(), ...routerModelList()].map((model) => ({
          id: model.id,
          object: 'model',
          owned_by: model.provider
        }))
      });
    }

    const provider = await loadProvider(requestedProvider);
    if (provider && provider.getModels) {
      const models = await provider.getModels();
      // Prefix the models with provider name so they show correctly in UI
      const prefixedModels = models.map((m: any) => ({
         ...m,
         id: `${requestedProvider}/${m.id}`
      }));
      return res.json({ object: 'list', data: prefixedModels });
    }
  }

  // Model presentation is driven by providers.txt so Ollama/OpenAI clients
  // and fcc-style tooling see the same canonical list.
  res.json({
    object: 'list',
    data: providerModels.map((model) => ({
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
    }))
  });
});

// ==========================================
// Ollama API Emulation Layer
// ==========================================

// GET /api/tags
app.head('/api/tags', (req: Request, res: Response) => {
  res.status(200).end();
});

app.get('/api/tags', (req: Request, res: Response) => {
  const providerModels = presentedModelList();

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

app.listen(PORT, () => {
  console.log(`FVS-Code OpenAI-compatible proxy running on http://localhost:${PORT}`);
  console.log(`Point your VS Code extension to: http://localhost:${PORT}/v1`);
});
