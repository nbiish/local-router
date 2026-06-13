import { ProxyProvider } from '../types';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Nous Portal — Nous Research's unified subscription inference gateway.
 *
 * Exposes an OpenAI-compatible /v1/chat/completions endpoint at
 * https://inference-api.nousresearch.com/v1 backed by org-scoped plan
 * credits (Hermes Desktop/CLI plan at https://portal.nousresearch.com/orgs/<id>).
 *
 * Static bearer auth via NOUS_API_KEY (issued from the portal dashboard,
 * format `sk-nous-...`). OAuth subscription is a separate auth path handled
 * by the hermes-agent client; the local-router initial integration is
 * static-key only.
 *
 * Live usage confirmed in hermes-agent issue #24000:
 *   curl -s -H "Authorization: Bearer $NOUS_API_KEY" \
 *     https://inference-api.nousresearch.com/v1/models
 */
const provider: ProxyProvider = {
  name: 'nous-portal',
  baseUrl: 'https://inference-api.nousresearch.com/v1',
  getHeaders: () => {
    const key = process.env.NOUS_API_KEY;
    if (!key) {
      throw new Error('NOUS_API_KEY is not set in the environment');
    }
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    };
  },
  getModels: async () => {
    try {
      const res = await fetch('https://inference-api.nousresearch.com/v1/models', {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      return data.data || [];
    } catch (err) {
      console.error('Error fetching Nous Portal models:', err);
      return [];
    }
  }
};

export default provider;
