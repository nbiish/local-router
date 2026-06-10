import { ProxyProvider } from '../types';
import {
  fetchOAuthProviderModels,
  getOAuthUpstreamHeaders
} from '../oauth-providers';

const provider: ProxyProvider = {
  name: 'antigravity',
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  getHeaders: () => {
    // Synchronous fallback used by /config UI; never call this on the
    // hot path — the proxy uses getHeadersAsync instead.
    throw new Error('Antigravity requires async headers — login first via /config');
  },
  getHeadersAsync: async () => getOAuthUpstreamHeaders('antigravity'),
  getModels: async () => fetchOAuthProviderModels('antigravity')
};

export default provider;
