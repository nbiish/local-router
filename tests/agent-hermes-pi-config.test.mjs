import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  syncPiHarnessConfig,
  readPiHarnessState,
  PI_DEFAULT_MODEL
} from '../build/agent-pi-config.js';
import {
  hermesHomeDir,
  syncHermesHarnessConfig,
  readHermesHarnessState,
  upsertHermesConfigYaml,
  removeManagedHermesProvider,
  HERMES_MANAGED_MARKER
} from '../build/agent-hermes-config.js';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('syncPiHarnessConfig merges local-router provider, preserves other providers, and cleans up on disable', () => {
  const piDir = makeTempDir('lr-pi-');
  const modelsPath = path.join(piDir, 'models.json');
  fs.writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        zenmux: {
          baseUrl: 'https://zenmux.ai/api/v1',
          api: 'openai-completions',
          models: [{ id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' }]
        }
      }
    }, null, 2),
    'utf8'
  );

  const enabled = syncPiHarnessConfig({
    enabled: true,
    model: 'zai-glm-5.3-flash',
    baseUrl: 'http://127.0.0.1:11434',
    piAgentDir: piDir
  });
  assert.ok(enabled.ok, enabled.error);
  assert.equal(enabled.changed, true);

  const parsed = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  assert.ok(parsed.providers.zenmux, 'unrelated providers must survive');
  assert.equal(parsed.providers['local-router'].baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(parsed.providers['local-router'].apiKey, 'local-router');
  assert.deepEqual(
    parsed.providers['local-router'].models.map((m) => m.id),
    ['zai-glm-5.3-flash', PI_DEFAULT_MODEL]
  );

  const state = readPiHarnessState({ piAgentDir: piDir, baseUrl: 'http://127.0.0.1:11434' });
  assert.equal(state.providerState, 'present');
  assert.equal(state.hasFallbackRoute, true);

  // Idempotent re-sync reports changed: false
  const again = syncPiHarnessConfig({
    enabled: true,
    model: 'zai-glm-5.3-flash',
    baseUrl: 'http://127.0.0.1:11434',
    piAgentDir: piDir
  });
  assert.ok(again.ok);
  assert.equal(again.changed, false);

  const disabled = syncPiHarnessConfig({
    enabled: false,
    model: PI_DEFAULT_MODEL,
    baseUrl: 'http://127.0.0.1:11434',
    piAgentDir: piDir
  });
  assert.ok(disabled.ok);
  const afterDisable = JSON.parse(fs.readFileSync(modelsPath, 'utf8'));
  assert.equal(afterDisable.providers['local-router'], undefined);
  assert.ok(afterDisable.providers.zenmux, 'zenmux must survive disable');

  fs.rmSync(piDir, { recursive: true, force: true });
});

test('syncPiHarnessConfig rejects non-loopback baseUrl and malformed model ids', () => {
  const piDir = makeTempDir('lr-pi-reject-');
  const badUrl = syncPiHarnessConfig({
    enabled: true,
    model: PI_DEFAULT_MODEL,
    baseUrl: 'https://evil.example.com',
    piAgentDir: piDir
  });
  assert.equal(badUrl.ok, false);
  assert.match(String(badUrl.error || ''), /loopback/);

  const badModel = syncPiHarnessConfig({
    enabled: true,
    model: 'bad\nmodel',
    baseUrl: 'http://127.0.0.1:11434',
    piAgentDir: piDir
  });
  assert.equal(badModel.ok, false);
  fs.rmSync(piDir, { recursive: true, force: true });
});

test('hermesHomeDir honors HERMES_HOME and platform defaults', () => {
  const prev = process.env.HERMES_HOME;
  try {
    process.env.HERMES_HOME = '/tmp/custom-hermes-home';
    assert.equal(hermesHomeDir(), path.resolve('/tmp/custom-hermes-home'));
    delete process.env.HERMES_HOME;
    const resolved = hermesHomeDir();
    assert.ok(resolved.endsWith('hermes') || resolved.endsWith('.hermes'));
  } finally {
    if (prev === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = prev;
  }
});

test('upsertHermesConfigYaml preserves existing providers and comments while updating local-router', () => {
  const existing = [
    '# operator comment',
    'model:',
    '  default: mimo-v2.6-pro',
    '  provider: xiaomi-mimo-code-plan',
    'providers:',
    '  xiaomi-mimo-code-plan:',
    '    name: Xiaomi',
    '    model: mimo-v2.6-pro',
    '  local-router:',
    '    base_url: http://127.0.0.1:9999/v1',
    '    model: old-model',
    'agent:',
    '  verbose: false',
    ''
  ].join('\n');

  const updated = upsertHermesConfigYaml(existing, {
    v1BaseUrl: 'http://127.0.0.1:11434/v1',
    model: 'local-router/fallback-models',
    setDefaultModel: false
  });

  assert.match(updated, /# operator comment/);
  assert.match(updated, /provider: xiaomi-mimo-code-plan/, 'root default provider must be preserved when setDefaultModel=false');
  assert.match(updated, /xiaomi-mimo-code-plan:/);
  assert.match(updated, /base_url: http:\/\/127\.0\.0\.1:11434\/v1/);
  assert.doesNotMatch(updated, /9999/);
  assert.match(updated, /agent:\n  verbose: false/);

  const removed = removeManagedHermesProvider(updated);
  assert.doesNotMatch(removed, new RegExp(HERMES_MANAGED_MARKER));
  assert.match(removed, /xiaomi-mimo-code-plan:/);
});

test('syncHermesHarnessConfig wires root config + context/consolidate profiles without altering unrelated profiles', () => {
  const home = makeTempDir('lr-hermes-');
  fs.writeFileSync(path.join(home, 'config.yaml'), 'model:\n  default: mimo-v2.6-pro\n  provider: xiaomi-mimo-code-plan\n', 'utf8');

  const ctxDir = path.join(home, 'profiles', 'context-elephant');
  const consDir = path.join(home, 'profiles', 'consolidate-goldfish');
  const otherDir = path.join(home, 'profiles', 'marketing-engineer');
  fs.mkdirSync(ctxDir, { recursive: true });
  fs.mkdirSync(consDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(ctxDir, 'config.yaml'), 'model:\n  default: old\n  provider: zai\n', 'utf8');
  fs.writeFileSync(path.join(consDir, 'config.yaml'), 'model:\n  default: old\n  provider: xiaomi\n', 'utf8');
  fs.writeFileSync(path.join(otherDir, 'config.yaml'), 'model:\n  default: mimo-v2.6-pro\n  provider: xiaomi-mimo-code-plan\n', 'utf8');

  const res = syncHermesHarnessConfig({
    enabled: true,
    model: 'local-router/fallback-models',
    baseUrl: 'http://127.0.0.1:11434',
    syncProfiles: true,
    hermesHome: home
  });
  assert.ok(res.ok, res.error);
  assert.deepEqual(res.profilesUpdated.sort(), ['consolidate-goldfish', 'context-elephant']);

  const state = readHermesHarnessState({ hermesHome: home, baseUrl: 'http://127.0.0.1:11434' });
  assert.equal(state.providerPresent, true);
  assert.equal(state.defaultProvider, 'xiaomi-mimo-code-plan', 'root default provider stays intact');

  const ctxState = state.profiles.find((p) => p.name === 'context-elephant');
  assert.equal(ctxState?.defaultProvider, 'local-router');
  assert.equal(ctxState?.defaultModel, 'local-router/fallback-models');
  assert.equal(ctxState?.providerPresent, true);

  const otherState = state.profiles.find((p) => p.name === 'marketing-engineer');
  assert.equal(otherState?.defaultProvider, 'xiaomi-mimo-code-plan', 'non-context profile must remain untouched');
  assert.equal(otherState?.providerPresent, false);

  fs.rmSync(home, { recursive: true, force: true });
});
