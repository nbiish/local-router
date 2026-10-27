import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { renderOllamaShim, renderWindowsOllamaCmd, renderWindowsOllamaPs1 } = require('../bin/local-router.js');

function renderedShims() {
  return [
    renderOllamaShim('/usr/local/bin/ollama', 'services', null),
    renderWindowsOllamaCmd('C:\\Program Files\\Ollama\\ollama.exe', 'services', null),
    renderWindowsOllamaPs1('C:\\Program Files\\Ollama\\ollama.exe', 'services', null)
  ];
}

test('ollama shims on every OS send non-serve commands to the router when the app host is 11435', () => {
  for (const script of renderedShims()) {
    assert.match(script, /127\.0\.0\.1:11435/);
    assert.match(script, /127\.0\.0\.1:11434/);
    assert.equal(script.includes('caller already pinned'), false);
  }
});

test('install does not publish the router URL as the desktop OLLAMA_HOST', () => {
  const setup = readFileSync(join(import.meta.dirname, '..', 'scripts', 'setup-platform.mjs'), 'utf8');
  assert.equal(setup.includes('OLLAMA_HOST: "http://127.0.0.1:11434"'), false);
  assert.equal(setup.includes('OLLAMA_HOST: "127.0.0.1:11434"'), false);
  const routeSetCalls = setup.split('route", "set"').length - 1;
  assert.equal(routeSetCalls, 1, 'route set runs once for every platform');
});
