import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const OLLAMA_BACKEND_HOST = process.env.OLLAMA_BACKEND_HOST || '127.0.0.1:11435';
const OLLAMA_BACKEND_BASE_URL = process.env.LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL
  || `http://${OLLAMA_BACKEND_HOST}/v1`;
const OLLAMA_BACKEND_TAGS_URL = `http://${OLLAMA_BACKEND_HOST}/api/tags`;
const SHIM_MARKER = '# local-router ollama shim';
const LEGACY_SHIM_MARKER = '# fvs-code ollama shim';
const SHIM_PATH = path.join(os.homedir(), '.local/bin/ollama');

let ollamaBackendProcess: ReturnType<typeof spawn> | null = null;
let ollamaBackendShutdownRegistered = false;

function whichAll(commandName: string): string[] {
  const result = spawnSync('sh', ['-lc', `which -a ${commandName} 2>/dev/null || true`], {
    encoding: 'utf8'
  });
  return result.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isShimBinary(binaryPath: string): boolean {
  try {
    const content = fs.readFileSync(binaryPath, 'utf8');
    return content.includes(SHIM_MARKER) || content.includes(LEGACY_SHIM_MARKER);
  } catch {
    return false;
  }
}

export function resolveRealOllamaBinary(): string | null {
  for (const candidate of whichAll('ollama')) {
    const resolved = path.resolve(candidate);
    if (resolved === path.resolve(SHIM_PATH)) continue;
    if (isShimBinary(candidate)) continue;
    return candidate;
  }
  return null;
}

async function probeOllamaBackend(timeoutMs = 1500): Promise<boolean> {
  try {
    const response = await fetch(OLLAMA_BACKEND_TAGS_URL, {
      signal: AbortSignal.timeout(timeoutMs)
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForOllamaBackend(maxAttempts = 40, delayMs = 250): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await probeOllamaBackend()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function registerOllamaBackendShutdown(): void {
  if (ollamaBackendShutdownRegistered) return;
  ollamaBackendShutdownRegistered = true;

  const stop = () => {
    if (!ollamaBackendProcess || ollamaBackendProcess.killed) return;
    ollamaBackendProcess.kill('SIGTERM');
    ollamaBackendProcess = null;
  };

  process.on('exit', stop);
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(143);
  });
}

export async function ensureOllamaBackend(): Promise<boolean> {
  if (process.env.LOCAL_ROUTER_SKIP_OLLAMA_ENSURE === 'true') {
    return false;
  }

  process.env.LOCAL_ROUTER_PROVIDER_OLLAMA_BASE_URL = OLLAMA_BACKEND_BASE_URL;
  process.env.OLLAMA_HOST = OLLAMA_BACKEND_HOST;

  if (await probeOllamaBackend()) {
    return true;
  }

  const binary = resolveRealOllamaBinary();
  if (!binary) {
    console.warn('[ollama] Real ollama binary not found; cloud models require `ollama serve` on 11435.');
    return false;
  }

  ollamaBackendProcess = spawn(binary, ['serve'], {
    detached: false,
    stdio: 'ignore',
    env: {
      ...process.env,
      OLLAMA_HOST: OLLAMA_BACKEND_HOST
    }
  });

  ollamaBackendProcess.on('error', (error) => {
    console.error('[ollama] Failed to start backend:', error.message);
  });

  ollamaBackendProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.warn(`[ollama] Backend exited (code=${code}, signal=${signal || 'none'})`);
    }
    ollamaBackendProcess = null;
  });

  registerOllamaBackendShutdown();

  const ready = await waitForOllamaBackend();
  if (ready) {
    console.log(`[ollama] Backend ready at ${OLLAMA_BACKEND_HOST}`);
  } else {
    console.warn(`[ollama] Backend did not become ready at ${OLLAMA_BACKEND_HOST}`);
  }

  return ready;
}

export async function pullOllamaCloudModels(modelTags: string[]): Promise<void> {
  if (process.env.LOCAL_ROUTER_SKIP_OLLAMA_ENSURE === 'true') {
    return;
  }

  const binary = resolveRealOllamaBinary();
  if (!binary) return;

  const uniqueTags = Array.from(new Set(
    modelTags.map((tag) => String(tag || '').trim()).filter(Boolean)
  ));

  if (uniqueTags.length === 0) return;

  await ensureOllamaBackend();

  for (const tag of uniqueTags) {
    try {
      const result = spawnSync(binary, ['pull', tag], {
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          OLLAMA_HOST: OLLAMA_BACKEND_HOST
        }
      });

      if (result.status === 0) {
        console.log(`[ollama] Pulled cloud model: ${tag}`);
      } else {
        const detail = (result.stderr || result.stdout || '').trim();
        console.warn(`[ollama] Pull failed for ${tag}${detail ? `: ${detail}` : ''}`);
      }
    } catch (error: any) {
      console.warn(`[ollama] Pull error for ${tag}:`, error?.message || error);
    }
  }
}

export function ollamaBackendBaseUrl(): string {
  return OLLAMA_BACKEND_BASE_URL;
}

export function ollamaBackendTagsUrl(): string {
  return OLLAMA_BACKEND_TAGS_URL;
}
