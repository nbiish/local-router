/**
 * Normalize OpenAI-compatible chat completion bodies from gateway providers.
 * Cline wraps completions in `{ data: { choices, ... } }`.
 */

export function normalizeGatewayChatCompletionBody(
  providerName: string,
  upstreamData: unknown
): Record<string, unknown> {
  if (!upstreamData || typeof upstreamData !== 'object' || Array.isArray(upstreamData)) {
    return (upstreamData ?? {}) as Record<string, unknown>;
  }

  const body = upstreamData as Record<string, unknown>;
  if (providerName !== 'cline') {
    return body;
  }

  const nested = body.data;
  if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
    return body;
  }

  const inner = nested as Record<string, unknown>;
  if (Array.isArray(inner.choices) || inner.object === 'chat.completion') {
    return inner;
  }

  return body;
}
