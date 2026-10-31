/**
 * Decisions HTTP transport.
 *
 * One POST, one timeout, no retries inside a single attempt: failover across
 * providers is the service's job, and it must be visible in the response. The
 * upstream URL is fixed by the catalog (or its per-provider override) and is
 * still validated by the SSRF guard so a misconfigured override cannot turn
 * the router into an internal-network proxy.
 */

import { safeFetch } from '../ssrf-guard';

export interface DecisionUpstreamResponse {
  status: number;
  /** Parsed JSON body when the upstream sent JSON; otherwise null. */
  body: unknown;
  /** Raw text (bounded) for error messages. */
  text: string;
  ms: number;
}

export function decisionTimeoutMs(): number {
  const raw = Number.parseInt(process.env.LOCAL_ROUTER_DECISION_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 30_000;
}

export async function postDecisionUpstream(
  endpoint: string,
  headers: Record<string, string>,
  payload: unknown,
  timeoutMs: number
): Promise<DecisionUpstreamResponse> {
  const startedAt = Date.now();
  const response = await safeFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();
  const ms = Date.now() - startedAt;
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, text: text.slice(0, 2_000), ms };
}

/** Extracts a readable upstream error message without leaking the request. */
export function upstreamErrorMessage(body: unknown, text: string): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string') return message;
    }
    if (typeof record.detail === 'string') return record.detail;
    if (typeof record.message === 'string') return record.message;
  }
  return (text || '').trim().slice(0, 300) || 'no error body';
}
