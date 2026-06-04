import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gatewayModelAllowedForRouter,
  gatewayPresentedModelSegment,
  isKiloFreeModel,
  isClineFreeModel
} from '../build/gateway-provider-catalog.js';

test('gateway presented segments are unique for :free models', () => {
  const a = gatewayPresentedModelSegment('openrouter/free');
  const b = gatewayPresentedModelSegment('kilo-auto/free');
  assert.notEqual(a, b);
  assert.equal(a, 'openrouter-free');
  assert.equal(b, 'kilo-auto-free');
});

test('kilo free tier allowlist', () => {
  assert.equal(isKiloFreeModel('stepfun/step-3.7-flash:free'), true);
  assert.equal(isKiloFreeModel('anthropic/claude-opus-4.8'), false);
  assert.equal(
    gatewayModelAllowedForRouter('kilo', 'stepfun/step-3.7-flash:free'),
    true
  );
  assert.equal(
    gatewayModelAllowedForRouter('kilo', 'anthropic/claude-opus-4.8'),
    false
  );
});

test('cline free tier allowlist', () => {
  assert.equal(isClineFreeModel('openrouter/free'), true);
  assert.equal(isClineFreeModel('deepseek/deepseek-v4-flash'), false);
  assert.equal(gatewayModelAllowedForRouter('cline', 'openrouter/free'), true);
});
