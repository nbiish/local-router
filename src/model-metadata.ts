/**
 * model-metadata.ts — provider-agnostic extraction of model limits.
 *
 * Providers publish the same two numbers under incompatible shapes:
 * OpenAI-style `context_length`, Gemini's `inputTokenLimit`, Copilot's
 * `capabilities.limits.max_context_window_tokens`, Ollama's
 * `model_info.<architecture>.context_length`, vLLM's `max_model_len`, and
 * OpenRouter's `top_provider.context_length`. Missing one shape silently
 * pins a model to the shared default window, so every known shape is read
 * here in one place and covered by tests.
 */

export type NumberRecord = Record<string, unknown>;

function isRecord(value: unknown): value is NumberRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readPath(raw: NumberRecord, path: string): unknown {
  let value: unknown = raw;
  for (const segment of path.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[segment];
  }
  return value;
}

function readKeys(raw: NumberRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const direct = positive(raw[key]);
    if (direct !== undefined) return direct;
  }
  return undefined;
}

function readPaths(raw: NumberRecord, paths: string[]): number | undefined {
  for (const path of paths) {
    const value = positive(readPath(raw, path));
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * Ollama reports per-architecture keys such as
 * `model_info["llama.context_length"]`, so the key name is not stable.
 */
function readOllamaModelInfo(raw: NumberRecord): { context?: number; output?: number } {
  const info = raw.model_info;
  if (!isRecord(info)) return {};
  let context: number | undefined;
  let output: number | undefined;
  for (const [key, value] of Object.entries(info)) {
    const numeric = positive(value);
    if (numeric === undefined) continue;
    if (/(^|\.)context_length$/i.test(key)) context ??= numeric;
    if (/(^|\.)max_output_tokens$/i.test(key)) output ??= numeric;
  }
  return { context, output };
}

export function readContextHint(raw: NumberRecord): number | undefined {
  return readKeys(raw, [
    'contextLength',
    'context_length',
    'max_model_len',
    'max_context_length',
    'max_context_window',
    'context_window',
    'context_window_tokens',
    'max_sequence_length',
    'max_seq_len',
    'max_input_tokens',
    'inputTokenLimit',
    'context_size',
    'n_ctx',
    'contextWindow',
    'max_context_window_tokens'
  ])
    ?? readPaths(raw, [
      'top_provider.context_length',
      'top_provider.context_window',
      'model_info.context_length',
      'capabilities.limits.max_context_window_tokens',
      'capabilities.limits.max_prompt_tokens',
      'limits.context_length',
      'limits.context_window',
      'limits.max_context_length',
      'limits.max_context_window',
      'token_limits.context',
      'info.context_length',
      'wafer.context_length'
    ])
    ?? readOllamaModelInfo(raw).context;
}

export function readOutputHint(raw: NumberRecord): number | undefined {
  return readKeys(raw, [
    'outputTokens',
    'max_output_tokens',
    'max_output_length',
    'output_token_limit',
    'max_completion_tokens',
    'max_tokens_out',
    'outputTokenLimit'
  ])
    ?? readPaths(raw, [
      'top_provider.max_completion_tokens',
      'limits.max_output_tokens',
      'limits.max_completion_tokens',
      'capabilities.limits.max_output_tokens',
      'info.max_output_tokens',
      'wafer.max_output_tokens'
    ])
    ?? readOllamaModelInfo(raw).output;
}

/**
 * Canonical alias key for matching a live model id to a known registry row.
 * Snapshot suffixes (`-1017`), plan suffixes (`:free`, `:batch`) and display
 * markers (`[1m]`, `~`) differ between a provider's list and the curated
 * registry while describing the same model.
 */
export function normalizeModelAlias(modelId: string): string {
  return String(modelId || '')
    .trim()
    .toLowerCase()
    .replace(/^~/, '')
    .replace(/\[1m\]$/, '')
    .replace(/:(cloud|free|latest|batch)$/, '')
    .replace(/-(free|batch|latest|highspeed)$/, '')
    .replace(/-\d{4}$/, '');
}

function aliasKeys(modelId: string): string[] {
  const normalized = normalizeModelAlias(modelId);
  if (!normalized) return [];
  const keys = [normalized];
  const withoutNamespace = normalized.replace(/^[a-z0-9._-]+\//, '');
  if (withoutNamespace !== normalized) keys.push(withoutNamespace);
  return keys;
}

/**
 * Find the registry/cache row that describes a live model id. Exact ids win;
 * otherwise aliases are compared with and without the vendor namespace.
 */
export function pickBaselineModel<T extends { model: string }>(baselines: T[], modelId: string): T | undefined {
  const exact = baselines.find((row) => row.model === modelId);
  if (exact) return exact;

  const wanted = aliasKeys(modelId);
  if (wanted.length === 0) return undefined;
  for (const row of baselines) {
    const rowKeys = aliasKeys(row.model);
    if (rowKeys.some((key) => wanted.includes(key))) return row;
  }
  return undefined;
}

/**
 * Fill default-window metadata from curated registry rows.
 *
 * A provider that publishes no limits leaves a cached model at the shared
 * default (64K), and that stale default would otherwise survive every refresh
 * because the cache is the mapping baseline. Only defaults are replaced, so a
 * genuine provider-specific limit is never overwritten.
 */
export function reconcileModelMetadata<T extends {
  model: string;
  contextLength?: number;
  outputTokens?: number;
}>(options: {
  models: T[];
  registryRows: Array<{ model: string; contextLength?: number; outputTokens?: number }>;
  defaultContextLength: number;
  defaultOutputTokens: number;
}): { models: T[]; changed: number } {
  const { models, registryRows, defaultContextLength, defaultOutputTokens } = options;
  let changed = 0;

  const next = models.map((model) => {
    const row = pickBaselineModel(registryRows, model.model);
    if (!row) return model;
    const patch: Partial<T> = {};
    const contextIsDefault = !model.contextLength || model.contextLength === defaultContextLength;
    const outputIsDefault = !model.outputTokens || model.outputTokens === defaultOutputTokens;
    if (contextIsDefault && row.contextLength && row.contextLength !== model.contextLength) {
      (patch as Record<string, unknown>).contextLength = row.contextLength;
    }
    if (outputIsDefault && row.outputTokens && row.outputTokens !== model.outputTokens) {
      (patch as Record<string, unknown>).outputTokens = row.outputTokens;
    }
    if (Object.keys(patch).length === 0) return model;
    changed += 1;
    return { ...model, ...patch };
  });

  return { models: next, changed };
}
