import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

export type AgentChoice = 'auto' | 'free-claude-code' | 'omp' | 'trae-cli' | 'mini';

export interface AgentInfo {
  id: AgentChoice;
  name: string;
  command: string;
  installed: boolean;
  version?: string;
  description: string;
}

export interface AgentExecutionOptions {
  prompt: string;
  agentChoice?: AgentChoice;
  fleetEnabled?: boolean;
  cwd?: string;
  timeoutMs?: number;
}

export interface AgentExecutionResult {
  ok: boolean;
  agentUsed: string;
  output: string;
  trace: string[];
  durationMs: number;
}

function commandExists(cmd: string): boolean {
  try {
    const checkCmd = os.platform() === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(checkCmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectInstalledAgents(): AgentInfo[] {
  const hasFccClaude = commandExists('fcc-claude');
  const hasClaude = commandExists('claude');
  const hasOmp = commandExists('omp');
  const hasTraeCli = commandExists('trae-cli');
  const hasMini = commandExists('mini') || commandExists('mini-live');

  return [
    {
      id: 'free-claude-code',
      name: 'Free Claude Code',
      command: hasFccClaude ? 'fcc-claude' : (hasClaude ? 'claude' : 'fcc-claude'),
      installed: hasFccClaude || hasClaude,
      description: 'Claude Code proxy launcher powered by local-router / FCC'
    },
    {
      id: 'omp',
      name: 'OhMyPy (omp)',
      command: 'omp',
      installed: hasOmp,
      description: 'Non-interactive OhMyPy headless Python & SWE coding assistant'
    },
    {
      id: 'trae-cli',
      name: 'Trae SWE Agent (trae-cli)',
      command: 'trae-cli',
      installed: hasTraeCli,
      description: 'ByteDance Trae CLI agent for AST refactoring and patch creation'
    },
    {
      id: 'mini',
      name: 'Live-SWE Agent (mini)',
      command: commandExists('mini') ? 'mini' : 'mini-live',
      installed: hasMini,
      description: 'OpenAutoCoder test-driven reproduction & dynamic tool synthesis'
    }
  ];
}

function buildAgentEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const localRouterUrl = 'http://127.0.0.1:11434';
  const openAiUrl = 'http://127.0.0.1:11434/v1';

  return {
    ...process.env,
    ANTHROPIC_BASE_URL: localRouterUrl,
    ANTHROPIC_AUTH_TOKEN: 'local-router',
    OPENAI_BASE_URL: openAiUrl,
    OPENAI_API_KEY: 'local-router',
    OLLAMA_HOST: localRouterUrl,
    MODEL: 'local-router/fallback-models',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_FEEDBACK_COMMAND: '1',
    DISABLE_ERROR_REPORTING: '1',
    NONINTERACTIVE: '1',
    ...extraEnv
  };
}

function resolveCommandForAgent(agent: AgentChoice, prompt: string, fleetEnabled: boolean): { command: string; args: string[] } | null {
  const agents = detectInstalledAgents();

  if (agent === 'free-claude-code') {
    const fcc = agents.find((a) => a.id === 'free-claude-code');
    if (!fcc?.installed) return null;
    return {
      command: fcc.command,
      args: ['-p', prompt, '--dangerously-skip-permissions']
    };
  }

  if (agent === 'omp') {
    const omp = agents.find((a) => a.id === 'omp');
    if (!omp?.installed) return null;
    return {
      command: omp.command,
      args: ['-p', prompt]
    };
  }

  if (agent === 'trae-cli') {
    const trae = agents.find((a) => a.id === 'trae-cli');
    if (!trae?.installed) return null;
    const args = ['run', '-p', prompt, '--console-type', 'simple', '--max-steps', '30'];
    if (fleetEnabled) {
      args.push('--fleet');
    }
    return {
      command: trae.command,
      args
    };
  }

  if (agent === 'mini') {
    const mini = agents.find((a) => a.id === 'mini');
    if (!mini?.installed) return null;
    return {
      command: mini.command,
      args: ['--task', prompt, '--yolo', '--exit-immediately']
    };
  }

  return null;
}

export async function executeAgentProcess(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;

    const proc = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill('SIGTERM');
      } catch {}
    }, timeoutMs);

    proc.stdout?.on('data', (data) => {
      output += data.toString('utf8');
    });

    proc.stderr?.on('data', (data) => {
      output += data.toString('utf8');
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, output: output + '\n[ERROR] Execution timed out.' });
      } else {
        resolve({ ok: code === 0, output });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: output + `\n[ERROR] Process failed to start: ${err.message}` });
    });
  });
}

export async function executeAgentChain(options: AgentExecutionOptions): Promise<AgentExecutionResult> {
  const startTime = Date.now();
  const prompt = options.prompt;
  const choice = options.agentChoice || 'auto';
  const fleetEnabled = options.fleetEnabled !== false;
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeoutMs || 300_000; // 5 min default

  const trace: string[] = [];
  const env = buildAgentEnv();

  // Primary fallback chain when choice is 'auto': free-claude-code -> omp -> trae-cli
  const chain: AgentChoice[] = choice === 'auto'
    ? ['free-claude-code', 'omp', 'trae-cli']
    : [choice];

  let lastOutput = '';
  let lastAgent = 'none';

  for (const candidate of chain) {
    const resolved = resolveCommandForAgent(candidate, prompt, fleetEnabled);
    if (!resolved) {
      trace.push(`${candidate}: not installed or unavailable`);
      continue;
    }

    trace.push(`attempting ${candidate} (${resolved.command})`);
    const result = await executeAgentProcess(resolved.command, resolved.args, cwd, env, timeoutMs);
    lastOutput = result.output;
    lastAgent = candidate;

    if (result.ok) {
      trace.push(`${candidate}: OK`);
      return {
        ok: true,
        agentUsed: candidate,
        output: result.output,
        trace,
        durationMs: Date.now() - startTime
      };
    } else {
      trace.push(`${candidate}: FAILED`);
      // If user selected a specific agent, do not fall back
      if (choice !== 'auto') {
        break;
      }
    }
  }

  return {
    ok: false,
    agentUsed: lastAgent,
    output: lastOutput || 'No agent completed the task successfully.',
    trace,
    durationMs: Date.now() - startTime
  };
}
