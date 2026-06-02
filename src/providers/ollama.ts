import { ProxyProvider } from '../types';

const provider: ProxyProvider = {
  name: 'ollama',
  baseUrl: process.env.LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL || 'http://127.0.0.1:11435/v1',
  getHeaders: () => {
    return {
      'Content-Type': 'application/json'
    };
  },
  getModels: async () => {
    try {
      const url = process.env.LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL || 'http://127.0.0.1:11435/v1';
      // We can use the /v1/models endpoint that real ollama provides
      const res = await fetch(`${url}/models`);
      if (!res.ok) {
        return [];
      }
      const data = await res.json();
      return (data.data || []).map((model: any) => ({
        id: model.id,
        object: 'model',
        owned_by: 'ollama'
      }));
    } catch {
      return [];
    }
  }
};

export default provider;