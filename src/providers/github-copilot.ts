import { ProxyProvider } from '../types';
import {
  fetchOAuthProviderModels,
  getOAuthUpstreamHeaders
} from '../oauth-providers';

const provider: ProxyProvider = {
  name: 'github-copilot',
  baseUrl: 'https://api.githubcopilot.com',
  getHeaders: () => {
    // Synchronous fallback used by /config UI; never call this on the
    // hot path — the proxy uses getHeadersAsync instead.
    throw new Error('GitHub Copilot requires async headers — login first via /config');
  },
  getHeadersAsync: async () => getOAuthUpstreamHeaders('github-copilot'),
  getModels: async () => fetchOAuthProviderModels('github-copilot')
};

export default provider;
