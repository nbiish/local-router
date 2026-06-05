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

test('kilo-auto/free excluded from routing; openrouter/free allowed', () => {
  assert.equal(isGatewayRouterModel('kilo-auto/free'), true);
  assert.equal(isGatewayRouterModel('openrouter/free'), false);
  assert.equal(gatewayModelAllowedForRouter('kilo', 'openrouter/free'), true);
  assert.equal(gatewayModelAllowedForRouter('kilo', 'kilo-auto/free'), false);
  assert.equal(gatewayModelAllowedForRouter('cline', 'openrouter/free'), false);
});

test('kilo free tier allowlist', () => {
  assert.equal(isKiloFreeModel('stepfun/step-3.7-flash:free'), true);
  assert.equal(isKiloFreeModel('nvidia/nemotron-3-super-120b-a12b:free'), true);
  assert.equal(isKiloFreeModel('nvidia/nemotron-3-ultra-550b-a55b:free'), true);
  assert.equal(isKiloFreeModel('openrouter/free'), true);
  assert.equal(isKiloFreeModel('openrouter/owl-alpha'), true);
  assert.equal(isKiloFreeModel('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'), true);
  assert.equal(isKiloFreeModel('poolside/laguna-m.1:free'), true);
  assert.equal(isKiloFreeModel('anthropic/claude-opus-4.8'), false);
  assert.equal(isKiloFreeModel('deepseek/deepseek-v4-flash'), false);
});

test('cline free tier allowlist and paid deepseek', () => {
  assert.equal(isClineFreeModel('nvidia/nemotron-3-ultra-550b-a55b:free'), true);
  assert.equal(isClineFreeModel('minimax/minimax-m3'), true);
  assert.equal(isClineFreeModel('openrouter/free'), false);
  assert.equal(isClineFreeModel('deepseek/deepseek-v4-flash'), false);
  assert.equal(gatewayModelAllowedForRouter('cline', 'deepseek/deepseek-v4-flash'), true);
  assert.equal(gatewayModelAllowedForRouter('cline', 'qwen/qwen3-coder'), true);
  assert.equal(gatewayModelAllowedForRouter('cline', 'anthropic/claude-sonnet-4-6'), false);
});

test('kilo gateway allows catalog models except meta-routers', () => {
  assert.equal(gatewayModelAllowedForRouter('kilo', 'deepseek/deepseek-v4-pro'), true);
  assert.equal(gatewayModelAllowedForRouter('kilo', 'anthropic/claude-opus-4.8'), true);
  assert.equal(gatewayModelAllowedForRouter('kilo', 'kilo-auto/free'), false);
});
