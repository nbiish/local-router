import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Test remapClaudeCodeModel logic
import { remapClaudeCodeModel } from '../build/index.js';
import {
  loadAgentProxyConfig,
  saveAgentProxyConfig,
  AGENT_PROXY_CONFIG_PATH
} from '../build/config-persistence.js';
import { syncSystemAgentEnv } from '../build/agent-env-sync.js';

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

test('agent proxy config loads and saves round-trip', () => {
  const originalConfig = loadAgentProxyConfig();
  assert.ok(typeof originalConfig === 'object');
  assert.ok(typeof originalConfig.claudeCode === 'object');
  assert.ok(typeof originalConfig.claudeCode.enabled === 'boolean');

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

  // Restore original config
  saveAgentProxyConfig(originalConfig);
});

test('syncSystemAgentEnv writes ANTHROPIC_BASE_URL to env.sh', () => {
  const result = syncSystemAgentEnv();
  assert.ok(result.ok, result.error);

  const envPath = path.join(os.homedir(), '.config', 'local-router', 'env.sh');
  assert.ok(fs.existsSync(envPath), 'env.sh must exist');
  const content = fs.readFileSync(envPath, 'utf8');
  assert.ok(content.includes('ANTHROPIC_BASE_URL="http://127.0.0.1:11434"'), 'env.sh must export ANTHROPIC_BASE_URL');
  assert.ok(content.includes('ANTHROPIC_API_KEY="local-router"'), 'env.sh must export ANTHROPIC_API_KEY');
});
