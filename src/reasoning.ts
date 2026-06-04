type JsonObject = Record<string, any>;

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'none';

const RESPONSE_REASONING_KEYS = new Set([
  'reasoning_content',
  'reasoningContent',
  'reasoning_details',
  'reasoningDetails',
  'redacted_thinking',
  'redactedThinking',
  'thinking_signature',
  'thinkingSignature',
  'reasoning_signature',
  'reasoningSignature'
]);

const REASONING_BLOCK_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'reasoning',
  'reasoning_content'
]);

const NATIVE_REASONING_MODEL_PATTERN = /(deepseek|kimi|qwen[-_/]?(?:qwen)?3|qwen3|glm|z-ai|zai-org|moonshotai|minimax|stepfun|sapiens)/i;

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isReasoningContentBlock(value: unknown): boolean {
  if (!isObject(value)) return false;

  const type = value.type;
  return typeof type === 'string' && REASONING_BLOCK_TYPES.has(type.toLowerCase());
}

function hasExplicitNoThinkingRequest(value: JsonObject): boolean {
  if (value.think === false) return true;
  if (value.enable_thinking === false) return true;
  if (value.reasoning_effort === 'none') return true;

  const thinking = value.thinking;
  if (isObject(thinking)) {
    if (thinking.type === 'disabled') return true;
    if (thinking.enabled === false) return true;
  }

  return false;
}

function stripReasoningMetadataInternal(value: unknown, depth: number): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isReasoningContentBlock(item))
      .map((item) => stripReasoningMetadataInternal(item, depth + 1));
  }

  if (!isObject(value)) return value;

  const output: JsonObject = {};

  for (const [key, child] of Object.entries(value)) {
    if (RESPONSE_REASONING_KEYS.has(key)) continue;
    if (depth > 0 && (key === 'thinking' || key === 'reasoning')) continue;

    output[key] = stripReasoningMetadataInternal(child, depth + 1);
  }

  return output;
}

function applyNoThinkingHints(body: JsonObject): JsonObject {
  const next: JsonObject = {
    ...body,
    reasoning_effort: 'none',
    thinking: { type: 'disabled' }
  };

  delete next.think;

  if ('enable_thinking' in next) next.enable_thinking = false;
  if ('include_reasoning' in next) next.include_reasoning = false;
  if ('return_reasoning' in next) next.return_reasoning = false;

  if (isObject(next.extra_body)) {
    const extraBody: JsonObject = { ...next.extra_body };
    delete extraBody.reasoning_budget;

    if ('enable_thinking' in extraBody) extraBody.enable_thinking = false;
    if ('include_reasoning' in extraBody) extraBody.include_reasoning = false;
    if ('return_reasoning' in extraBody) extraBody.return_reasoning = false;
    if ('reasoning_effort' in extraBody) extraBody.reasoning_effort = 'none';

    if (isObject(extraBody.chat_template_kwargs)) {
      const chatTemplateKwargs: JsonObject = {
        ...extraBody.chat_template_kwargs,
        thinking: false,
        enable_thinking: false
      };
      delete chatTemplateKwargs.reasoning_budget;
      extraBody.chat_template_kwargs = chatTemplateKwargs;
    }

    next.extra_body = extraBody;
  }

  return next;
}

/**
 * Map thinking level to provider-specific request parameters.
 * Different providers use different parameter names for reasoning/thinking.
 */
export function getThinkingRequestParams(
  level: ThinkingLevel,
  providerName: string,
  modelName: string
): JsonObject {
  if (level === 'none') {
    return { reasoning_effort: 'none', thinking: { type: 'disabled' } };
  }

  const normalized = `${providerName}/${modelName}`.toLowerCase();

  // DeepSeek, Qwen, GLM, Z.ai, MiniMax, StepFun, Sapiens use enable_thinking
  if (/(deepseek|qwen|glm|z-ai|zai|minimax|stepfun|sapiens)/.test(normalized)) {
    return { enable_thinking: true };
  }

  // Moonshot/Kimi uses enable_thinking
  if (/(moonshot|kimi)/.test(normalized)) {
    return { enable_thinking: true };
  }

  // Default: OpenAI-style reasoning_effort (low, medium, high)
  // xhigh maps to high for providers that don't support it
  const effort = level === 'xhigh' ? 'high' : level;
  return { reasoning_effort: effort };
}

export function shouldDisableNativeThinking(providerName: string, modelName: string): boolean {
  return NATIVE_REASONING_MODEL_PATTERN.test(`${providerName}/${modelName}`);
}

export function stripReasoningMetadata<T>(value: T): T {
  return stripReasoningMetadataInternal(value, 0) as T;
}

/**
 * Sanitize provider request body before forwarding upstream.
 *
 * CRITICAL: We do NOT strip reasoning_metadata from request bodies.
 * Stripping reasoning_content from assistant messages breaks multi-turn
 * conversations with providers like Moonshot that require reasoning_content
 * to be present in assistant tool_call messages when thinking is enabled.
 *
 * Reasoning metadata is only stripped from responses (see stripReasoningMetadata).
 */
export function sanitizeProviderRequestBody<T extends JsonObject>(
  body: T,
  options: {
    providerName: string;
    modelName: string;
    thinkingLevel?: ThinkingLevel;
    applyProxyThinking?: boolean;
  }
): T {
  if (options.applyProxyThinking === false) {
    const passthrough = { ...body } as JsonObject;
    delete passthrough.think;
    return passthrough as T;
  }

  const level = options.thinkingLevel ?? DEFAULT_THINKING_LEVEL;

  // Respect explicit user request to disable thinking
  if (hasExplicitNoThinkingRequest(body)) {
    const sanitized = { ...body } as JsonObject;
    delete sanitized.think;
    return applyNoThinkingHints(sanitized) as T;
  }

  // For native reasoning models, default to disabling unless explicitly enabled
  const isNativeReasoning = shouldDisableNativeThinking(options.providerName, options.modelName);
  if (isNativeReasoning && level === 'none') {
    return applyNoThinkingHints(body) as T;
  }

  // Apply configured thinking level
  const sanitized = { ...body } as JsonObject;
  delete sanitized.think;

  const thinkingParams = getThinkingRequestParams(level, options.providerName, options.modelName);

  // Merge thinking params, preserving existing extra_body
  const result: JsonObject = { ...sanitized };
  for (const [key, value] of Object.entries(thinkingParams)) {
    if (key === 'extra_body' && isObject(result.extra_body) && isObject(value)) {
      result.extra_body = { ...result.extra_body, ...value };
    } else {
      result[key] = value;
    }
  }

  return result as T;
}
