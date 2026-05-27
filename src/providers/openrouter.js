"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("../types");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const provider = {
    name: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    getHeaders: () => {
        const key = process.env.OPENROUTER_API_KEY;
        if (!key)
            throw new Error('OPENROUTER_API_KEY is not set in the environment');
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
        }
        catch (err) {
            console.error('Error fetching OpenRouter models:', err);
            return [];
        }
    }
};
exports.default = provider;
//# sourceMappingURL=openrouter.js.map