import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import { ProxyProvider } from './types';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 11434;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Lazy load provider module
async function loadProvider(name: string): Promise<ProxyProvider | null> {
  try {
    const ext = process.env.NODE_ENV === 'production' ? 'js' : 'ts';
    // Use dynamic import
    const mod = await import(`./providers/${name}`);
    return mod.default || mod;
  } catch (err) {
    console.error(`Failed to load provider: ${name}`);
    return null;
  }
}

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const { model, stream } = req.body;
  
  if (!model) {
    return res.status(400).json({ error: 'Model is required in request body.' });
  }

  // Expecting format: "providerName/modelName", e.g., "groq/llama3-8b-8192"
  const [providerName, ...modelParts] = model.split('/');
  const actualModel = modelParts.join('/'); // In case model name has slashes, e.g. openrouter models "anthropic/claude-3-opus"
  
  if (!actualModel) {
     return res.status(400).json({ 
       error: 'Invalid model format. Please prefix with the provider you want, e.g. "groq/llama3-8b-8192" or "openrouter/anthropic/claude-3-opus".' 
     });
  }

  const provider = await loadProvider(providerName);

  if (!provider || !provider.baseUrl) {
    return res.status(400).json({ error: `No suitable provider found for: ${providerName}.` });
  }

  try {
    const providerHeaders = provider.getHeaders();
    
    // Modify body: set the actual model name intended for the provider
    const requestBody = {
      ...req.body,
      model: actualModel
    };
    
    const finalBody = provider.formatBody ? provider.formatBody(requestBody) : requestBody;

    const fetchResponse = await fetch(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: providerHeaders,
      body: JSON.stringify(finalBody)
    });

    if (!fetchResponse.ok) {
        const errorText = await fetchResponse.text();
        console.error(`Provider error (${fetchResponse.status}):`, errorText);
        return res.status(fetchResponse.status).send(errorText);
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      // Node.js 18+ fetch ReadableStream to Express Response
      if (fetchResponse.body) {
         // @ts-ignore
         const nodeStream = Readable.fromWeb(fetchResponse.body);
         nodeStream.pipe(res);
      }
    } else {
      const data = await fetchResponse.json();
      res.json(data);
    }
  } catch (error: any) {
    console.error('Error proxying request:', error);
    res.status(500).json({ error: 'Proxy Internal Server Error', details: error.message });
  }
});

app.get('/v1/models', async (req: Request, res: Response) => {
  // fcc-server style: we can optionally pass ?provider=groq to fetch models from a specific provider
  const requestedProvider = req.query.provider as string;

  if (requestedProvider) {
    const provider = await loadProvider(requestedProvider);
    if (provider && provider.getModels) {
      const models = await provider.getModels();
      // Prefix the models with provider name so they show correctly in UI
      const prefixedModels = models.map((m: any) => ({
         ...m,
         id: `${requestedProvider}/${m.id}`
      }));
      return res.json({ object: 'list', data: prefixedModels });
    }
  }

  // To keep load times down natively, only return placeholders. 
  // You should configure custom models in your VS Code extension directly
  // following the format "provider/model_name" (e.g. "openrouter/meta-llama/llama-3-8b-instruct")
  res.json({
    object: 'list',
    data: [
      { id: 'groq/llama3-8b-8192', object: 'model', owned_by: 'system' },
      { id: 'groq/llama3-70b-8192', object: 'model', owned_by: 'system' },
      { id: 'groq/mixtral-8x7b-32768', object: 'model', owned_by: 'system' },
      { id: 'openrouter/anthropic/claude-3-opus', object: 'model', owned_by: 'system' },
      { id: 'openrouter/anthropic/claude-3-sonnet', object: 'model', owned_by: 'system' }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`FVS-Code OpenAI-compatible proxy running on http://localhost:${PORT}`);
  console.log(`Point your VS Code extension to: http://localhost:${PORT}/v1`);
});
