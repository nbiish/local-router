import { ProxyProvider } from '../types';
import dotenv from 'dotenv';
dotenv.config();

const provider: ProxyProvider = {
  name: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  getHeaders: () => {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error('OPENROUTER_API_KEY is not set in the environment');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    };
  },
  getModels: async () => {
    // Lazy-load OpenRouter models
    try {
      const res = await fetch('https://openrouter.ai/api/v1/models');
      const data = await res.json();
      return data.data || [];
    } catch (err) {
      console.error('Error fetching OpenRouter models:', err);
      return [];
    }
  }
};

export default provider;
