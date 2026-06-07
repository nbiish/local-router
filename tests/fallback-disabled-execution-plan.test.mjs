import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeFallbackModels,
  fallbackExecutionPlan
} from '../build/index.js';

test('fallbackExecutionPlan: disabled stage never appears in plan', () => {
  const route = {
    id: 'fallback-models',
    models: ['a', 'b', 'c'],
    disabledModels: ['b']
  };
  const plan = fallbackExecutionPlan(route);
  const models = plan.map((stage) => stage.model);
  assert.equal(models.includes('b'), false);
  assert.ok(models.length > 0);
  assert.ok(models.every((model) => model === 'a' || model === 'c'));
});

test('fallbackExecutionPlan: disabledModels field omitted means all stages active', () => {
  const route = {
    id: 'fallback-models',
    models: ['a', 'b', 'c']
  };
  const plan = fallbackExecutionPlan(route);
  const models = plan.map((stage) => stage.model);
  assert.ok(models.includes('a'));
  assert.ok(models.includes('b'));
  assert.ok(models.includes('c'));
});

test('fallbackExecutionPlan: all-disabled models yields empty plan (exhaustion path)', () => {
  const route = {
    id: 'fallback-models',
    models: ['a', 'b', 'c'],
    disabledModels: ['a', 'b', 'c']
  };
  const plan = fallbackExecutionPlan(route);
  assert.deepEqual(plan, []);
});

test('fallbackExecutionPlan: only one active model yields single-stage plan', () => {
  const route = {
    id: 'fallback-models',
    models: ['a', 'b', 'c'],
    disabledModels: ['b', 'c']
  };
  const plan = fallbackExecutionPlan(route);
  const models = plan.map((stage) => stage.model);
  assert.ok(models.length > 0);
  assert.ok(models.every((model) => model === 'a'));
});

test('activeFallbackModels: with two active models, plan revisits earlier one', () => {
  const route = {
    id: 'fallback-models',
    models: ['primary', 'secondary', 'tertiary'],
    disabledModels: ['tertiary']
  };
  const active = activeFallbackModels(route);
  assert.deepEqual(active, ['primary', 'secondary']);
  const plan = fallbackExecutionPlan(route);
  const models = plan.map((stage) => stage.model);
  assert.equal(models.includes('tertiary'), false);
  assert.ok(models.includes('primary'));
  assert.ok(models.includes('secondary'));
});
