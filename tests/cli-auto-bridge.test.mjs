import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEscalatingWraparoundPlan } from '../build/execution-plan.js';
import { sanitizeProviderRequestBody } from '../build/reasoning.js';
import { stripCliStats, promptFromBody } from '../build/cli-auto-bridge.js';

test('escalating wraparound: 2 models repeats before exhaustion', () => {
  const plan = buildEscalatingWraparoundPlan(['A', 'B']);
  const models = plan.map((s) => s.model);
  assert.deepEqual(models, ['A', 'B', 'A', 'B']);
});

test('escalating wraparound: 3 models escalates from 2 to 3', () => {
  const plan = buildEscalatingWraparoundPlan(['A', 'B', 'C']);
  const models = plan.map((s) => s.model);
  assert.deepEqual(models, ['A', 'B', 'A', 'B', 'C']);
});

test('escalating wraparound: restart after 2 fallbacks, then 3, then full traversal', () => {
  const plan = buildEscalatingWraparoundPlan(['A', 'B', 'C', 'D']);
  const models = plan.map((s) => s.model);
  assert.deepEqual(models, ['A', 'B', 'A', 'B', 'C', 'A', 'B', 'C', 'D']);
});

test('escalating wraparound terminates for any chain length', () => {
  for (const n of [1, 2, 3, 5, 15]) {
    const models = Array.from({ length: n }, (_, i) => `m${i}`);
    const plan = buildEscalatingWraparoundPlan(models);
    assert.ok(plan.length > 0);
    assert.ok(plan.length <= (n * (n + 1)) / 2 + n);
    // every stage's model must exist in the chain
    for (const stage of plan) assert.ok(models.includes(stage.model));
  }
});

test('sanitize never injects a thinking default', () => {
  const out = sanitizeProviderRequestBody({ model: 'x', messages: [] }, {
    providerName: 'github-copilot',
    modelName: 'gpt-4o-mini',
    thinkingLevel: 'medium',
    applyProxyThinking: true
  });
  assert.equal('reasoning_effort' in out, false);
  assert.equal('enable_thinking' in out, false);
  assert.equal('thinking' in out, false);
});

test('sanitize passes explicit effort through and normalizes ollama think', () => {
  const high = sanitizeProviderRequestBody({ model: 'x', reasoning_effort: 'high' });
  assert.equal(high.reasoning_effort, 'high');
  const think = sanitizeProviderRequestBody({ model: 'x', think: true });
  assert.equal(think.enable_thinking, true);
  assert.equal('think' in think, false);
  const off = sanitizeProviderRequestBody({ model: 'x', reasoning_effort: 'none' });
  assert.equal(off.reasoning_effort, 'none');
});

test('stripCliStats removes trailing stat lines', () => {
  const raw = 'BRIDGE-OK\nChanges    +0 -0\nAI Credits 0.35 (3s)\nTokens     up 15.7k\nResume     copilot --resume=x';
  assert.equal(stripCliStats(raw), 'BRIDGE-OK');
  assert.equal(stripCliStats('plain'), 'plain');
});

test('promptFromBody flattens messages', () => {
  const p = promptFromBody({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] });
  assert.match(p, /\[system\]/);
  assert.match(p, /hi/);
});
