import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Test remapClaudeCodeModel logic
import { remapClaudeCodeModel } from '../build/index.js';
import {
  loadAgentProxyConfig,
  saveAgentProxyConfig
} from '../build/config-persistence.js';
import { syncSystemAgentEnv, upsertShellExports, agentHarnessEnv } from '../build/agent-env-sync.js';
import { resolveCommandShim } from '../bin/lib/cli-spawn.js';
import {
  syncCodexHarnessConfig,
  readCodexHarnessState,
  upsertManagedBlock,
  removeManagedBlock,
  renderCodexProviderBlock,
  CODEX_MANAGED_BEGIN
} from '../build/agent-codex-config.js';

function makeHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('remapClaudeCodeModel returns original model when proxy is disabled', () => {
  const disabledConfig = {
    claudeCode: {
      enabled: false,
      models: {
        default: 'wafer-serverless/deepseek-v4.1-flash',
        opus1m: 'openrouter/anthropic/claude-3.7-sonnet',
        sonnet: 'wafer-serverless/deepseek-v4.1-flash',
        sonnet5_1m: 'local-router/fallback-models',
        haiku: 'groq/llama-3.3-70b-versatile'
      }
    }
  };

  assert.equal(remapClaudeCodeModel('claude-3-7-sonnet-20250219', disabledConfig), 'claude-3-7-sonnet-20250219');
  assert.equal(remapClaudeCodeModel('claude-opus-4-7[1m]', disabledConfig), 'claude-opus-4-7[1m]');
  assert.equal(remapClaudeCodeModel('claude-sonnet-5', disabledConfig), 'claude-sonnet-5');
  assert.equal(remapClaudeCodeModel('claude-3-5-haiku-20241022', disabledConfig), 'claude-3-5-haiku-20241022');
  assert.equal(remapClaudeCodeModel('default', disabledConfig), 'default');
});

test('remapClaudeCodeModel correctly remaps all 5 Claude Code model slots when enabled', () => {
  const enabledConfig = {
    claudeCode: {
      enabled: true,
      models: {
        default: 'wafer-serverless/deepseek-v4.1-flash',
        opus1m: 'openrouter/anthropic/claude-3.7-sonnet',
        sonnet: 'wafer-serverless/deepseek-v4.1-flash',
        sonnet5_1m: 'local-router/fallback-models',
        haiku: 'groq/llama-3.3-70b-versatile'
      }
    }
  };

  // 1. Sonnet slot
  assert.equal(remapClaudeCodeModel('claude-3-7-sonnet-20250219', enabledConfig), 'wafer-serverless/deepseek-v4.1-flash');
  assert.equal(remapClaudeCodeModel('claude-3-5-sonnet-20241022', enabledConfig), 'wafer-serverless/deepseek-v4.1-flash');
  assert.equal(remapClaudeCodeModel('claude-sonnet-4-5', enabledConfig), 'wafer-serverless/deepseek-v4.1-flash');

  // 2. Opus 1M slot
  assert.equal(remapClaudeCodeModel('claude-opus-4-7[1m]', enabledConfig), 'openrouter/anthropic/claude-3.7-sonnet');
  assert.equal(remapClaudeCodeModel('claude-3-opus-20240229[1m]', enabledConfig), 'openrouter/anthropic/claude-3.7-sonnet');
  assert.equal(remapClaudeCodeModel('claude-3-opus-20240229', enabledConfig), 'openrouter/anthropic/claude-3.7-sonnet');

  // 3. Sonnet 5 (1M context) slot
  assert.equal(remapClaudeCodeModel('claude-sonnet-5', enabledConfig), 'local-router/fallback-models');
  assert.equal(remapClaudeCodeModel('claude-sonnet-5[1m]', enabledConfig), 'local-router/fallback-models');

  // 4. Haiku slot
  assert.equal(remapClaudeCodeModel('claude-3-5-haiku-20241022', enabledConfig), 'groq/llama-3.3-70b-versatile');
  assert.equal(remapClaudeCodeModel('claude-3-haiku-20240307', enabledConfig), 'groq/llama-3.3-70b-versatile');

  // 5. Default slot
  assert.equal(remapClaudeCodeModel('default', enabledConfig), 'wafer-serverless/deepseek-v4.1-flash');
});

test('remapClaudeCodeModel supports passthrough settings per slot', () => {
  const mixedConfig = {
    claudeCode: {
      enabled: true,
      models: {
        default: 'local-router/fallback-models',
        opus1m: 'passthrough',
        sonnet: 'wafer-serverless/deepseek-v4.1-flash',
        sonnet5_1m: 'passthrough',
        haiku: 'passthrough'
      }
    }
  };

  // Opus should be passed through
  assert.equal(remapClaudeCodeModel('claude-opus-4-7[1m]', mixedConfig), 'claude-opus-4-7[1m]');
  // Sonnet 5 should be passed through
  assert.equal(remapClaudeCodeModel('claude-sonnet-5', mixedConfig), 'claude-sonnet-5');
  // Sonnet should be remapped
  assert.equal(remapClaudeCodeModel('claude-3-7-sonnet', mixedConfig), 'wafer-serverless/deepseek-v4.1-flash');
});

test('agent proxy config loads and saves both harness sections', () => {
  const originalConfig = loadAgentProxyConfig();
  assert.ok(typeof originalConfig === 'object');
  assert.ok(typeof originalConfig.claudeCode === 'object');
  assert.ok(typeof originalConfig.claudeCode.enabled === 'boolean');
  // Legacy config files (Claude-only) migrate to a Codex section with defaults.
  assert.ok(typeof originalConfig.codex === 'object');
  assert.equal(typeof originalConfig.codex.enabled, 'boolean');
  assert.equal(typeof originalConfig.codex.model, 'string');

  const testConfig = {
    claudeCode: {
      enabled: true,
      models: {
        default: 'test/model-default',
        opus1m: 'test/model-opus',
        sonnet: 'test/model-sonnet',
        sonnet5_1m: 'test/model-sonnet5',
        haiku: 'test/model-haiku'
      }
    },
    codex: {
      enabled: true,
      model: 'test/codex-model'
    }
  };

  saveAgentProxyConfig(testConfig);
  const reloaded = loadAgentProxyConfig();
  assert.equal(reloaded.claudeCode.enabled, true);
  assert.equal(reloaded.claudeCode.models.default, 'test/model-default');
  assert.equal(reloaded.claudeCode.models.opus1m, 'test/model-opus');
  assert.equal(reloaded.claudeCode.models.sonnet, 'test/model-sonnet');
  assert.equal(reloaded.claudeCode.models.sonnet5_1m, 'test/model-sonnet5');
  assert.equal(reloaded.claudeCode.models.haiku, 'test/model-haiku');
  assert.equal(reloaded.codex.enabled, true);
  assert.equal(reloaded.codex.model, 'test/codex-model');

  // Restore original config
  saveAgentProxyConfig(originalConfig);
});

test('upsertShellExports updates stale values, appends missing keys, preserves unrelated lines', () => {
  const existing = [
    'export ANTHROPIC_BASE_URL="http://old-host:9999"',
    'export KEEP_ME="yes"',
    'export OPENAI_BASE_URL="http://old-host:9999/v1"',
    'export OPENAI_BASE_URL="http://duplicate:1/v1"',
    ''
  ].join('\n');

  const vars = agentHarnessEnv('http://127.0.0.1:11434');
  const next = upsertShellExports(existing, vars);

  assert.match(next, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:11434"/);
  assert.match(next, /export OPENAI_BASE_URL="http:\/\/127\.0\.0\.1:11434\/v1"/);
  assert.match(next, /export ANTHROPIC_AUTH_TOKEN="local-router"/);
  assert.match(next, /export OPENAI_API_KEY="local-router"/);
  assert.match(next, /export KEEP_ME="yes"/);
  assert.equal((next.match(/OPENAI_BASE_URL=/g) || []).length, 1, 'duplicate managed exports must collapse to one');
  assert.equal(next, upsertShellExports(next, vars), 're-sync must be idempotent');
});

test('syncSystemAgentEnv writes both harness families into a scoped env.sh', () => {
  const home = makeHome('lr-env-');
  const envPath = path.join(home, '.config', 'local-router', 'env.sh');
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, 'export ANTHROPIC_BASE_URL="http://stale:1"\n', 'utf8');

  const result = syncSystemAgentEnv({
    homeDir: home,
    baseUrl: 'http://127.0.0.1:11434',
    skipOsEnvironment: true
  });
  assert.ok(result.ok, result.error);
  assert.equal(result.envScriptPath, envPath);

  const content = fs.readFileSync(envPath, 'utf8');
  assert.match(content, /export ANTHROPIC_BASE_URL="http:\/\/127\.0\.0\.1:11434"/);
  assert.match(content, /export ANTHROPIC_AUTH_TOKEN="local-router"/);
  assert.match(content, /export OPENAI_BASE_URL="http:\/\/127\.0\.0\.1:11434\/v1"/);
  assert.match(content, /export OPENAI_API_KEY="local-router"/);
  assert.doesNotMatch(content, /stale:1/);

  fs.rmSync(home, { recursive: true, force: true });
});

test('managed Codex provider block upserts and removes without touching operator config', () => {
  const block = renderCodexProviderBlock('http://127.0.0.1:11434');
  const original = 'model = "gpt-5.3-codex"\n\n[mcp_servers.context7]\ncommand = "npx"\n';
  const withBlock = upsertManagedBlock(original, block);

  assert.match(withBlock, /model = "gpt-5\.3-codex"/);
  assert.match(withBlock, /\[mcp_servers\.context7\]/);
  assert.ok(withBlock.includes(CODEX_MANAGED_BEGIN));
  assert.equal(upsertManagedBlock(withBlock, block), withBlock, 'upsert must be idempotent');

  const restored = removeManagedBlock(withBlock);
  assert.doesNotMatch(restored, /local-router managed block/);
  assert.match(restored, /model = "gpt-5\.3-codex"/);
  assert.match(restored, /\[mcp_servers\.context7\]/);
});

test('syncCodexHarnessConfig writes provider + profile, then removes only its own files', () => {
  const codexHome = makeHome('lr-codex-');
  const configPath = path.join(codexHome, 'config.toml');
  const profilePath = path.join(codexHome, 'local-router.config.toml');
  fs.writeFileSync(configPath, 'model = "gpt-5.3-codex"\n', 'utf8');

  const enabled = syncCodexHarnessConfig({
    enabled: true,
    model: 'local-router/fallback-models',
    baseUrl: 'http://127.0.0.1:11434',
    codexHome
  });
  assert.ok(enabled.ok, enabled.error);
  assert.ok(fs.existsSync(profilePath));

  const configText = fs.readFileSync(configPath, 'utf8');
  assert.match(configText, /\[model_providers\.local-router\]/);
  assert.match(configText, /base_url = "http:\/\/127\.0\.0\.1:11434\/v1"/);
  assert.match(configText, /wire_api = "responses"/);
  assert.match(configText, /model = "gpt-5\.3-codex"/, 'operator config must survive');

  const profileText = fs.readFileSync(profilePath, 'utf8');
  assert.match(profileText, /model_provider = "local-router"/);
  assert.match(profileText, /model = "local-router\/fallback-models"/);

  const state = readCodexHarnessState({ codexHome });
  assert.equal(state.providerBlock, 'present');
  assert.equal(state.profile, 'present');
  assert.equal(state.profileModel, 'local-router/fallback-models');

  // Re-sync with a new model updates the profile without duplicating the block.
  syncCodexHarnessConfig({
    enabled: true,
    model: 'groq/llama-3.3-70b-versatile',
    baseUrl: 'http://127.0.0.1:11434',
    codexHome
  });
  const updated = fs.readFileSync(configPath, 'utf8');
  assert.equal((updated.match(/\[model_providers\.local-router\]/g) || []).length, 1);

  const disabled = syncCodexHarnessConfig({
    enabled: false,
    model: 'local-router/fallback-models',
    baseUrl: 'http://127.0.0.1:11434',
    codexHome
  });
  assert.ok(disabled.ok, disabled.error);
  assert.equal(fs.existsSync(profilePath), false);
  const restored = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(restored, /model_providers\.local-router/);
  assert.match(restored, /model = "gpt-5\.3-codex"/);

  fs.rmSync(codexHome, { recursive: true, force: true });
});

test('syncCodexHarnessConfig refuses to clobber a foreign provider table', () => {
  const codexHome = makeHome('lr-codex-conflict-');
  const configPath = path.join(codexHome, 'config.toml');
  const original = '[model_providers.local-router]\nname = "Mine"\nbase_url = "https://example.test/v1"\n';
  fs.writeFileSync(configPath, original, 'utf8');

  const result = syncCodexHarnessConfig({
    enabled: true,
    model: 'local-router/fallback-models',
    baseUrl: 'http://127.0.0.1:11434',
    codexHome
  });

  assert.equal(result.ok, false);
  assert.match(String(result.error || ''), /already defines/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), original, 'conflicting config must be left untouched');
  assert.equal(readCodexHarnessState({ codexHome }).providerBlock, 'conflict');

  fs.rmSync(codexHome, { recursive: true, force: true });
});

test('resolveCommandShim resolves an npm-style .cmd wrapper to its real script', () => {
  const dir = makeHome('lr-shim-js-');
  const rel = ['node_modules', '@openai', 'codex', 'bin', 'codex.js'].join(path.sep);
  const js = path.join(dir, rel);
  fs.mkdirSync(path.dirname(js), { recursive: true });
  fs.writeFileSync(js, 'console.log("codex");\n', 'utf8');

  const shim = path.join(dir, 'codex.cmd');
  fs.writeFileSync(shim, `@ECHO off\r\n"%dp0%${path.sep}${rel}" %*\r\n`, 'utf8');

  const resolved = resolveCommandShim(shim);
  assert.ok(resolved, 'npm shim must resolve');
  assert.equal(resolved.command, process.execPath);
  assert.deepEqual(resolved.prefixArgs, [js]);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCommandShim resolves a native .exe wrapper', () => {
  const dir = makeHome('lr-shim-exe-');
  const rel = ['bin', 'claude.exe'].join(path.sep);
  const exe = path.join(dir, rel);
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'MZplaceholder', 'utf8');

  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, `@ECHO off\r\n"%dp0%${path.sep}${rel}" %*\r\n`, 'utf8');

  const resolved = resolveCommandShim(shim);
  assert.ok(resolved, 'native shim must resolve');
  assert.equal(resolved.command, exe);
  assert.deepEqual(resolved.prefixArgs, []);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveCommandShim returns null for an unknown wrapper format', () => {
  const dir = makeHome('lr-shim-unknown-');
  const shim = path.join(dir, 'tool.cmd');
  fs.writeFileSync(shim, '@ECHO off\r\necho hello\r\n', 'utf8');

  assert.equal(resolveCommandShim(shim), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
