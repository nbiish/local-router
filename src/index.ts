import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Readable } from 'stream';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 11434; // Simulating Ollama default port

app.use(cors());
app.use(express.json());

// Add your provider mappings here
const PROVIDERS: Record<string, { url: string, key: string | undefined }> = {
  groq: {
    url: 'https://api.groq.com/openai/v1',
    key: process.env.GROQ_API_KEY,
  },
  openrouter: {
    url: 'https://openrouter.ai/api/v1',
    key: process.env.OPENROUTER_API_KEY,
  },
  // Add more providers here...
};

// Route model prefixes or names to specific providers
function getProviderForModel(model: string) {
  // Simple heuristic: map specific models to Groq, else fallback to OpenRouter
  if (model.includes('llama3') || model.includes('mixtral')) {
    return PROVIDERS.groq;
  }
  return PROVIDERS.openrouter; 
}

app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const { model, stream } = req.body;
  
  if (!model) {
    return res.status(400).json({ error: 'Model is required in request body.' });
  }

  const provider = getProviderForModel(model);

  if (!provider || !provider.url) {
    return res.status(400).json({ error: "No suitable provider found for this model." });
  }

  try {
    const fetchResponse = await fetch(`${provider.url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${provider.key}`
      },
      body: JSON.stringify(req.body)
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

app.get('/v1/models', (req: Request, res: Response) => {
  // Allow VS Code extensions to successfully fetch the list of models
  res.json({
    object: 'list',
    data: [
      { id: 'llama3-8b-8192', object: 'model', owned_by: 'system' },
      { id: 'llama3-70b-8192', object: 'model', owned_by: 'system' },
      { id: 'mixtral-8x7b-32768', object: 'model', owned_by: 'system' }
    ]
  });
});

app.listen(PORT, () => {
  console.log(`FVS-Code OpenAI-compatible proxy running on http://localhost:${PORT}`);
  console.log(`Point your VS Code extension to: http://localhost:${PORT}/v1`);
});
