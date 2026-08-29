import fs from 'fs';
import path from 'path';
import os from 'os';
import { Transform } from 'stream';
import { getProviderPricingEntry } from './provider-pricing';

export interface ToolCallSummary {
  name: string;
  arguments: string;
}

export interface ExpertLog {
  id: string;
  timestamp: string;
  clientName: string;
  requestModel: string;
  presentedModel: string;
  selectedModel: string;
  provider: string;
  routeKind: 'router' | 'fallback' | 'direct';
  routerId: string;
  stream: boolean;
  status: number;
  durationMs: number;
  modalities: string[];
  isMultimodal: boolean;
  toolCallsRequested: number;
  toolCalls: ToolCallSummary[];
  thinking: string;
  content: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  costPrompt: number;
  costCompletion: number;
  costCached: number;
  costTotal: number;
  costWithoutCaching: number;
  savingsDollars: number;
  errorType?: string;
  errorMessage?: string;
  systemPromptMatch?: boolean;
  prefixMatchChars?: number;
  prefixMatchTokens?: number;
  cacheMissReason?: string;
  dynamicPatternsDetected?: string[];
}

export interface LogAnalysis {
  totalRequests: number;
  totalTokens: {
    prompt: number;
    completion: number;
    cached: number;
    total: number;
  };
  totalCostDollars: number;
  totalSavingsDollars: number;
  cachingSavingsPercent: number;
  modalitiesCount: Record<string, number>;
  modelUsage: Record<string, number>;
  providerUsage: Record<string, number>;
  errorCount: Record<string, number>;
  cacheMissReasons: Record<string, number>;
  averageLatencyMs: number;
  modalitiesVerification: Record<string, {
    success: number;
    failure: number;
    avgCachedTokens: number;
  }>;
}

let lastSystemPrompt = '';
let lastFullPrompt = '';

function getLongestCommonPrefixLength(a: string, b: string): number {
  const minLength = Math.min(a.length, b.length);
  let i = 0;
  while (i < minLength && a[i] === b[i]) {
    i++;
  }
  return i;
}

function scanDynamicPatterns(text: string): string[] {
  const patterns: Record<string, RegExp> = {
    uuid: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    iso_timestamp: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/gi,
    date_slash: /\d{4}\/\d{2}\/\d{2}/gi,
    git_hash: /\b[0-9a-f]{40}\b/gi,
    temp_file: /tmp\/[a-zA-Z0-9_\-.]+/gi
  };
  const result: string[] = [];
  for (const [name, regex] of Object.entries(patterns)) {
    if (regex.test(text)) {
      result.push(name);
    }
  }
  return result;
}
const LOCAL_ROUTER_CONFIG_DIR = path.join(os.homedir(), '.config', 'local-router');
const LOGS_FILE_PATH = path.join(LOCAL_ROUTER_CONFIG_DIR, 'expert-logs.json');
const MAX_LOGS_ENTRIES = 1000;

let expertLogs: ExpertLog[] = [];

function ensureConfigDir(): void {
  if (!fs.existsSync(LOCAL_ROUTER_CONFIG_DIR)) {
    fs.mkdirSync(LOCAL_ROUTER_CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

export function loadExpertLogs(): void {
  try {
    ensureConfigDir();
    if (fs.existsSync(LOGS_FILE_PATH)) {
      const data = fs.readFileSync(LOGS_FILE_PATH, 'utf8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        expertLogs = parsed as ExpertLog[];
      }
    }
  } catch (error) {
    console.error('Failed to load expert logs:', error);
  }
}

export function saveExpertLogs(): void {
  try {
    ensureConfigDir();
    const tempPath = `${LOGS_FILE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(expertLogs, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, LOGS_FILE_PATH);
  } catch (error) {
    console.error('Failed to save expert logs:', error);
  }
}

export function getExpertLogs(): ExpertLog[] {
  return expertLogs;
}

export function clearExpertLogs(): void {
  expertLogs = [];
  try {
    if (fs.existsSync(LOGS_FILE_PATH)) {
      fs.unlinkSync(LOGS_FILE_PATH);
    }
  } catch (error) {
    console.error('Failed to delete expert logs file:', error);
  }
}

export function importExpertLogs(logs: unknown): { success: boolean; count: number; error?: string } {
  if (!Array.isArray(logs)) {
    return { success: false, count: 0, error: 'Logs payload must be an array.' };
  }

  // Validate basic shape
  const validLogs: ExpertLog[] = [];
  for (const item of logs) {
    if (item && typeof item === 'object' && 'id' in item && 'timestamp' in item) {
      validLogs.push(item as ExpertLog);
    }
  }

  expertLogs = [...validLogs, ...expertLogs].slice(0, MAX_LOGS_ENTRIES);
  saveExpertLogs();
  return { success: true, count: validLogs.length };
}

export function detectModalities(body: unknown): string[] {
  const result = new Set<string>();
  if (!body || typeof body !== 'object') {
    return ['text'];
  }

  const record = body as Record<string, unknown>;
  const messages = record.messages;

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg && typeof msg === 'object') {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === 'string') {
          result.add('text');
        } else if (Array.isArray(content)) {
          for (const part of content) {
            if (part && typeof part === 'object') {
              const partObj = part as Record<string, unknown>;
              const partType = String(partObj.type || '').toLowerCase();
              const mime = String(partObj.mime_type || '').toLowerCase();

              if (partType === 'text') {
                result.add('text');
              } else if (partType === 'image_url' || partType === 'image' || mime.startsWith('image/')) {
                result.add('image');
              } else if (partType === 'video_url' || partType === 'video' || mime.startsWith('video/')) {
                result.add('video');
              } else if (partType === 'input_audio' || partType === 'audio' || mime.startsWith('audio/')) {
                result.add('audio');
              } else if (partType === 'document' || mime === 'application/pdf') {
                result.add('pdf');
              }
            }
          }
        }

        const images = (msg as Record<string, unknown>).images;
        if (Array.isArray(images) && images.length > 0) {
          result.add('image');
        }
      }
    }
  }

  if (result.size === 0) {
    result.add('text');
  }

  return Array.from(result);
}

export function analyzeLogs(): LogAnalysis {
  let totalPrompt = 0;
  let totalCompletion = 0;
  let totalCached = 0;
  let totalCost = 0;
  let totalSavings = 0;
  let totalLatency = 0;
  let successCount = 0;
  const modalitiesCount: Record<string, number> = {};
  const modelUsage: Record<string, number> = {};
  const providerUsage: Record<string, number> = {};
  const errorCount: Record<string, number> = {};
  const cacheMissReasons: Record<string, number> = {};

  const modVerifyMap = new Map<string, { success: number; failure: number; cachedSum: number }>();

  for (const log of expertLogs) {
    totalPrompt += log.promptTokens;
    totalCompletion += log.completionTokens;
    totalCached += log.cachedTokens;
    totalCost += log.costTotal;
    totalSavings += log.savingsDollars;
    totalLatency += log.durationMs;

    if (log.status >= 200 && log.status < 300) {
      successCount++;
    }

    // Modalites tracking
    for (const mod of log.modalities) {
      modalitiesCount[mod] = (modalitiesCount[mod] || 0) + 1;
    }

    if (log.requestModel) {
      modelUsage[log.requestModel] = (modelUsage[log.requestModel] || 0) + 1;
    }
    if (log.provider) {
      providerUsage[log.provider] = (providerUsage[log.provider] || 0) + 1;
    }
    if (log.errorType) {
      errorCount[log.errorType] = (errorCount[log.errorType] || 0) + 1;
    }
    if (log.cacheMissReason) {
      cacheMissReasons[log.cacheMissReason] = (cacheMissReasons[log.cacheMissReason] || 0) + 1;
    }

    // Modalties verification
    const modKey = log.modalities.slice().sort().join('+') || 'text';
    const entry = modVerifyMap.get(modKey) || { success: 0, failure: 0, cachedSum: 0 };
    if (log.status >= 200 && log.status < 300) {
      entry.success++;
    } else {
      entry.failure++;
    }
    entry.cachedSum += log.cachedTokens;
    modVerifyMap.set(modKey, entry);
  }

  const modalitiesVerification: Record<string, { success: number; failure: number; avgCachedTokens: number }> = {};
  for (const [key, value] of modVerifyMap.entries()) {
    const total = value.success + value.failure;
    modalitiesVerification[key] = {
      success: value.success,
      failure: value.failure,
      avgCachedTokens: total > 0 ? Math.round(value.cachedSum / total) : 0
    };
  }

  const count = expertLogs.length;
  const avgLatency = count > 0 ? totalLatency / count : 0;
  const baseCost = totalCost + totalSavings;
  const savingsPercent = baseCost > 0 ? (totalSavings / baseCost) * 100 : 0;

  return {
    totalRequests: count,
    totalTokens: {
      prompt: totalPrompt,
      completion: totalCompletion,
      cached: totalCached,
      total: totalPrompt + totalCompletion
    },
    totalCostDollars: Math.round(totalCost * 10000) / 10000,
    totalSavingsDollars: Math.round(totalSavings * 10000) / 10000,
    cachingSavingsPercent: Math.round(savingsPercent * 10) / 10,
    modalitiesCount,
    modelUsage,
    providerUsage,
    errorCount,
    cacheMissReasons,
    averageLatencyMs: Math.round(avgLatency),
    modalitiesVerification
  };
}

export class LogEntryTracker {
  public log: ExpertLog;
  private streamingToolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();

  constructor(
    clientName: string,
    requestModel: string,
    routeKind: 'router' | 'fallback' | 'direct',
    routerId?: string
  ) {
    const now = new Date();
    this.log = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: now.toISOString(),
      clientName: clientName || 'unknown',
      requestModel: requestModel || 'unknown',
      presentedModel: requestModel || 'unknown',
      selectedModel: 'unknown',
      provider: 'unknown',
      routeKind,
      routerId: routerId || '',
      stream: false,
      status: 0,
      durationMs: 0,
      modalities: [],
      isMultimodal: false,
      toolCallsRequested: 0,
      toolCalls: [],
      thinking: '',
      content: '',
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      costPrompt: 0,
      costCompletion: 0,
      costCached: 0,
      costTotal: 0,
      costWithoutCaching: 0,
      savingsDollars: 0,
      systemPromptMatch: false,
      prefixMatchChars: 0,
      prefixMatchTokens: 0,
      cacheMissReason: '',
      dynamicPatternsDetected: []
    };
  }

  public setRequestDetails(body: unknown): void {
    this.log.modalities = detectModalities(body);
    this.log.isMultimodal = this.log.modalities.some((m) => m !== 'text');
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      this.log.stream = Boolean(record.stream);
      if (Array.isArray(record.tools)) {
        this.log.toolCallsRequested = record.tools.length;
      }
    }

    // Cache metrics calculation
    let systemPrompt = '';
    let fullPrompt = '';
    if (body && typeof body === 'object') {
      const record = body as Record<string, unknown>;
      const messages = record.messages;
      if (Array.isArray(messages)) {
        for (const msg of messages) {
          if (msg && typeof msg === 'object') {
            const msgObj = msg as Record<string, unknown>;
            const role = String(msgObj.role || '');
            const content = msgObj.content;
            let textPart = '';
            if (typeof content === 'string') {
              textPart = content;
            } else if (Array.isArray(content)) {
              for (const part of content) {
                if (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') {
                  textPart += (part as Record<string, unknown>).text;
                }
              }
            }
            if (role === 'system') {
              systemPrompt += textPart;
            }
            fullPrompt += `${role}: ${textPart}\n`;
          }
        }
      }
    }

    this.log.systemPromptMatch = (systemPrompt === lastSystemPrompt);
    this.log.prefixMatchChars = getLongestCommonPrefixLength(fullPrompt, lastFullPrompt);
    this.log.prefixMatchTokens = Math.round(this.log.prefixMatchChars / 4);
    this.log.dynamicPatternsDetected = scanDynamicPatterns(fullPrompt);

    // Update last prompts
    lastSystemPrompt = systemPrompt;
    lastFullPrompt = fullPrompt;
  }

  public onSuccess(providerName: string, actualModel: string, status: number): void {
    this.log.provider = providerName || 'unknown';
    this.log.selectedModel = actualModel || 'unknown';
    this.log.status = status;
  }

  public onFailure(status: number, errorType: string, errorMessage?: string): void {
    this.log.status = status || 500;
    this.log.errorType = errorType;
    if (errorMessage) {
      this.log.errorMessage = errorMessage;
    }
  }

  public onUsage(data: unknown): void {
    if (!data || typeof data !== 'object') {
      return;
    }

    const payload = data as Record<string, unknown>;

    // Handle token usage fields
    const usage = payload.usage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      if (typeof u.prompt_tokens === 'number') this.log.promptTokens = u.prompt_tokens;
      if (typeof u.completion_tokens === 'number') this.log.completionTokens = u.completion_tokens;
      if (typeof u.input_tokens === 'number') this.log.promptTokens = u.input_tokens;
      if (typeof u.output_tokens === 'number') this.log.completionTokens = u.output_tokens;

      // DeepSeek/OpenAI cached prompt tokens details
      const details = u.prompt_tokens_details;
      if (details && typeof details === 'object') {
        const d = details as Record<string, unknown>;
        if (typeof d.cached_tokens === 'number') {
          this.log.cachedTokens = d.cached_tokens;
        }
      }
      if (typeof u.cache_write_tokens === 'number') {
        this.log.cacheWriteTokens = u.cache_write_tokens;
      }
    }

    // Google Gemini cached content token count
    const usageMetadata = payload.usage_metadata;
    if (usageMetadata && typeof usageMetadata === 'object') {
      const um = usageMetadata as Record<string, unknown>;
      if (typeof um.cached_content_token_count === 'number') {
        this.log.cachedTokens = um.cached_content_token_count;
      }
    }

    // OpenRouter cached tokens
    if (typeof payload.cached_tokens === 'number') {
      this.log.cachedTokens = payload.cached_tokens;
    }
    if (typeof payload.cache_write_tokens === 'number') {
      this.log.cacheWriteTokens = payload.cache_write_tokens;
    }

    // Extract tool calls and thinking from choices/delta (for streaming or non-streaming)
    const choices = payload.choices;
    if (Array.isArray(choices) && choices[0]) {
      const choice = choices[0] as Record<string, unknown>;

      // 1. Non-streaming message
      const message = choice.message;
      if (message && typeof message === 'object') {
        const msg = message as Record<string, unknown>;

        // Capture content
        if (typeof msg.content === 'string') {
          this.log.content = msg.content;
        }

        // Capture thinking
        const thinkingKeys = ['reasoning_content', 'reasoningContent', 'thinking', 'reasoning'];
        for (const tk of thinkingKeys) {
          if (typeof msg[tk] === 'string' && msg[tk]) {
            this.log.thinking = msg[tk] as string;
            break;
          }
        }

        // Capture tool calls
        if (Array.isArray(msg.tool_calls)) {
          this.log.toolCalls = msg.tool_calls
            .map((tc) => {
              if (tc && typeof tc === 'object') {
                const tcObj = tc as Record<string, unknown>;
                const fn = tcObj.function as Record<string, unknown> | undefined;
                return {
                  name: String(fn?.name || tcObj.name || ''),
                  arguments: String(fn?.arguments || tcObj.arguments || '')
                };
              }
              return null;
            })
            .filter((x): x is ToolCallSummary => x !== null);
        }
      }

      // 2. Streaming delta
      const delta = choice.delta;
      if (delta && typeof delta === 'object') {
        const d = delta as Record<string, unknown>;

        // Append content
        if (typeof d.content === 'string') {
          this.log.content += d.content;
        }

        // Append thinking
        const thinkingKeys = ['reasoning_content', 'reasoningContent', 'thinking', 'reasoning'];
        for (const tk of thinkingKeys) {
          if (typeof d[tk] === 'string' && d[tk]) {
            this.log.thinking += d[tk] as string;
            break;
          }
        }

        // Merge tool calls
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            if (tc && typeof tc === 'object') {
              const tcObj = tc as Record<string, unknown>;
              const index = typeof tcObj.index === 'number' ? tcObj.index : 0;
              const existing = this.streamingToolCalls.get(index) || { arguments: '' };

              if (typeof tcObj.id === 'string') {
                existing.id = tcObj.id;
              }
              const fn = tcObj.function as Record<string, unknown> | undefined;
              if (fn) {
                if (typeof fn.name === 'string') {
                  existing.name = fn.name;
                }
                if (typeof fn.arguments === 'string') {
                  existing.arguments += fn.arguments;
                }
              }
              this.streamingToolCalls.set(index, existing);
            }
          }
        }
      }
    }
  }

  public onFinish(durationMs: number): void {
    this.log.durationMs = durationMs;

    // Convert accumulated streaming tool calls to array
    if (this.streamingToolCalls.size > 0) {
      this.log.toolCalls = Array.from(this.streamingToolCalls.values()).map((tc) => ({
        name: tc.name || '',
        arguments: tc.arguments
      }));
    }

    // Pricing calculation
    const pricing = getProviderPricingEntry(this.log.selectedModel) || getProviderPricingEntry(this.log.presentedModel);
    if (pricing) {
      const inputPricePerM = pricing.inputPricePerM;
      const outputPricePerM = pricing.outputPricePerM;
      const cacheReadPricePerM = pricing.cacheReadPricePerM ?? (inputPricePerM * 0.5); // 50% discount default

      const promptUncached = Math.max(0, this.log.promptTokens - this.log.cachedTokens);

      this.log.costPrompt = (promptUncached * inputPricePerM) / 1000000;
      this.log.costCached = (this.log.cachedTokens * cacheReadPricePerM) / 1000000;
      this.log.costCompletion = (this.log.completionTokens * outputPricePerM) / 1000000;
      this.log.costTotal = this.log.costPrompt + this.log.costCached + this.log.costCompletion;

      this.log.costWithoutCaching = (this.log.promptTokens * inputPricePerM + this.log.completionTokens * outputPricePerM) / 1000000;
      this.log.savingsDollars = Math.max(0, this.log.costWithoutCaching - this.log.costTotal);
    }

    // Compute cache miss reason if successful
    if (this.log.status >= 200 && this.log.status < 300) {
      if (this.log.cachedTokens > 0) {
        this.log.cacheMissReason = 'none';
      } else {
        const pricing = getProviderPricingEntry(this.log.selectedModel) || getProviderPricingEntry(this.log.presentedModel);
        const isCachingSupported = pricing ? pricing.cacheReadPricePerM !== undefined : true;
        if (!isCachingSupported) {
          this.log.cacheMissReason = 'unsupported';
        } else if (this.log.systemPromptMatch === false) {
          this.log.cacheMissReason = 'system_prompt_changed';
        } else if (typeof this.log.prefixMatchChars === 'number' && this.log.prefixMatchChars < 200) {
          this.log.cacheMissReason = 'prefix_drift';
        } else if (this.log.dynamicPatternsDetected && this.log.dynamicPatternsDetected.length > 0) {
          this.log.cacheMissReason = 'dynamic_patterns_detected';
        } else {
          this.log.cacheMissReason = 'cold_start_or_eviction';
        }
      }
    }

    // Add to logs and persist
    expertLogs = [this.log, ...expertLogs].slice(0, MAX_LOGS_ENTRIES);
    saveExpertLogs();
  }
}

export function createUsageSpyStream(onUsage: (data: unknown) => void): Transform {
  let buffer = '';
  return new Transform({
    transform(chunk: Buffer | string, encoding: string, callback: () => void) {
      const text = chunk.toString();
      this.push(chunk);
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        let payload = line.trim();
        if (payload.startsWith('data:')) {
          payload = payload.slice(5).trim();
        }
        if (payload && payload !== '[DONE]') {
          try {
            const parsed: unknown = JSON.parse(payload);
            onUsage(parsed);
          } catch {
            // Ignore JSON parse errors for incomplete chunks
          }
        }
      }
      callback();
    },
    flush(callback: () => void) {
      let payload = buffer.trim();
      if (payload.startsWith('data:')) {
        payload = payload.slice(5).trim();
      }
      if (payload && payload !== '[DONE]') {
        try {
          const parsed: unknown = JSON.parse(payload);
          onUsage(parsed);
        } catch {
          // Ignore
        }
      }
      callback();
    }
  });
}

