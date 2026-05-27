type JsonObject = Record<string, any>;

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

const NATIVE_REASONING_MODEL_PATTERN = /(deepseek|kimi|qwen[-_/]?(?:qwen)?3|qwen3|glm|z-ai|zai-org|moonshotai)/i;

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

export function shouldDisableNativeThinking(providerName: string, modelName: string): boolean {
  return NATIVE_REASONING_MODEL_PATTERN.test(`${providerName}/${modelName}`);
}

export function stripReasoningMetadata<T>(value: T): T {
  return stripReasoningMetadataInternal(value, 0) as T;
}

export function sanitizeProviderRequestBody<T extends JsonObject>(
  body: T,
  options: { providerName: string; modelName: string }
): T {
  const sanitized = stripReasoningMetadata(body) as JsonObject;
  const disableThinking = hasExplicitNoThinkingRequest(body)
    || shouldDisableNativeThinking(options.providerName, options.modelName);

  if (!disableThinking) {
    delete sanitized.think;
    return sanitized as T;
  }

  return applyNoThinkingHints(sanitized) as T;
}
