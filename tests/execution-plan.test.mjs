import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWraparoundExecutionPlan } from '../build/execution-plan.js';

test('wraparound plan revisits earlier models before advancing', () => {
  const plan = buildWraparoundExecutionPlan(['A', 'B', 'C'], 1);
  const models = plan.map((stage) => stage.model);
  assert.deepEqual(models, [
    'A',
    'A',
    'B',
    'A',
    'B',
    'C'
  ]);
});

test('wraparound includes revisit after first primary (A then A before B)', () => {
  const plan = buildWraparoundExecutionPlan(['A', 'B'], 3);
  const models = plan.map((stage) => stage.model);
  assert.equal(models[0], 'A');
  assert.equal(models[1], 'A');
  assert.equal(models[2], 'B');
});
