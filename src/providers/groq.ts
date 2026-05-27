import { ProxyProvider } from '../types';
import dotenv from 'dotenv';
dotenv.config();

const provider: ProxyProvider = {
  name: 'groq',
  baseUrl: 'https://api.groq.com/openai/v1',
  getHeaders: () => {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error('GROQ_API_KEY is not set in the environment');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    };
  },
  getModels: async () => {
    // Lazy-load the models only when specifically requested
    const key = process.env.GROQ_API_KEY;
    if (!key) return [];
    try {
      const res = await fetch('https://api.groq.com/openai/v1/models', {
        headers: {
          'Authorization': `Bearer ${key}`
        }
      });
      const data = await res.json();
      return data.data || [];
    } catch (err) {
      console.error('Error fetching Groq models:', err);
      return [];
    }
  }
};

export default provider;
