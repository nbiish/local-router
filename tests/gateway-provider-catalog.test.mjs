import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gatewayModelAllowedForRouter,
  gatewayPresentedModelSegment,
  isGatewayRouterModel,
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

test('gateway router models excluded from routing', () => {
  assert.equal(isGatewayRouterModel('openrouter/free'), true);
  assert.equal(gatewayModelAllowedForRouter('kilo', 'openrouter/free'), false);
  assert.equal(gatewayModelAllowedForRouter('kilo', 'kilo-auto/free'), false);
});

test('kilo free tier allowlist', () => {
  assert.equal(isKiloFreeModel('stepfun/step-3.7-flash:free'), true);
  assert.equal(isKiloFreeModel('nvidia/nemotron-3-super-120b-a12b:free'), true);
  assert.equal(isKiloFreeModel('openrouter/free'), false);
  assert.equal(isKiloFreeModel('anthropic/claude-opus-4.8'), false);
});

test('cline free tier allowlist', () => {
  assert.equal(isClineFreeModel('nvidia/nemotron-3-ultra-550b-a55b:free'), true);
  assert.equal(isClineFreeModel('minimax/minimax-m3'), true);
  assert.equal(isClineFreeModel('openrouter/free'), false);
  assert.equal(gatewayModelAllowedForRouter('cline', 'deepseek/deepseek-v4-flash'), true);
});
