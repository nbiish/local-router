import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFileCallback);
const BRIDGE_TIMEOUT_MS = 180_000;

export type CliAutoBridgeResult = {
  ok: boolean;
  providerName: 'github-copilot' | 'cursor';
  actualModel: 'auto';
  content?: string;
  errorMessage?: string;
  errorStatus?: number;
  elapsedMs: number;
};

function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 300);
}

/** Flatten an OpenAI chat request to the plain-text prompt the CLI expects. */
export function promptFromBody(body: any): string {
  const parts: string[] = [];
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content);
    if (message.role === 'system') parts.push(`[system]\n${content}`);
    else if (message.role === 'user') parts.push(content);
    else if (message.role === 'assistant') parts.push(`[assistant]\n${content}`);
  }
  return parts.join('\n\n') || 'Say OK';
}

/** Strip the CLI's trailing stat lines (Changes / AI Credits / Tokens / Resume). */
export function stripCliStats(stdout: string): string {
  const statMarkers = /^(Changes|AI Credits|Tokens|Resume|Error:)\s/i;
  const lines = stdout.replace(/\r/g, '').split('\n');
  let end = lines.length;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].trim() === '') continue;
    if (statMarkers.test(lines[i])) end = i;
    else break;
  }
  return lines.slice(0, end).join('\n').trim();
}

/**
 * Run a logged-in first-party AI CLI headlessly against its `auto` model and
 * return the plain-text completion. Copilot and Cursor both resolve `auto`
 * client-side; their public APIs reject the literal id.
 */
export async function runCliAuto(
  label: 'copilot' | 'cursor',
  body: any
): Promise<CliAutoBridgeResult> {
  const startedAt = Date.now();
  const prompt = promptFromBody(body);
  const binary = label === 'copilot'
    ? (process.env.LOCAL_ROUTER_COPILOT_BIN || 'copilot')
    : (process.env.LOCAL_ROUTER_CURSOR_BIN || 'cursor-agent');
  const args = label === 'copilot'
    ? ['-p', prompt, '--model', 'auto']
    : ['-p', prompt, '--model', 'auto', '--output-format', 'text', '--mode', 'ask', '--trust'];
  try {
    const { stdout } = await execFileAsync(
      binary,
      args,
      { timeout: BRIDGE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, shell: false, env: { ...process.env, NO_COLOR: '1' } }
    );
    const content = stripCliStats(stdout);
    return {
      ok: Boolean(content),
      providerName: label === 'copilot' ? 'github-copilot' : 'cursor',
      actualModel: 'auto',
      content: content || undefined,
      errorMessage: content ? undefined : `${label} CLI auto bridge returned an empty response.`,
      errorStatus: content ? undefined : 502,
      elapsedMs: Date.now() - startedAt
    };
  } catch (error: any) {
    const message = error?.killed
      ? `${label} CLI auto bridge timed out after ${BRIDGE_TIMEOUT_MS / 1000}s.`
      : `${label} CLI auto bridge failed: ${sanitize(error?.message || error)}`;
    return {
      ok: false,
      providerName: label === 'copilot' ? 'github-copilot' : 'cursor',
      actualModel: 'auto',
      errorMessage: message,
      errorStatus: 502,
      elapsedMs: Date.now() - startedAt
    };
  }
}
