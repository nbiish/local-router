"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("../types");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const provider = {
    name: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    getHeaders: () => {
        const key = process.env.GROQ_API_KEY;
        if (!key)
            throw new Error('GROQ_API_KEY is not set in the environment');
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${key}`
        };
    },
    getModels: async () => {
        // Lazy-load the models only when specifically requested
        const key = process.env.GROQ_API_KEY;
        if (!key)
            return [];
        try {
            const res = await fetch('https://api.groq.com/openai/v1/models', {
                headers: {
                    'Authorization': `Bearer ${key}`
                }
            });
            const data = await res.json();
            return data.data || [];
        }
        catch (err) {
            console.error('Error fetching Groq models:', err);
            return [];
        }
    }
};
exports.default = provider;
//# sourceMappingURL=groq.js.map