import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWraparoundExecutionPlan, buildEscalatingWraparoundPlan } from '../build/execution-plan.js';

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

test('escalating wraparound revisits every member without a predicate', () => {
  const plan = buildEscalatingWraparoundPlan(['A', 'B', 'C']);
  const models = plan.map((stage) => stage.model);
  assert.ok(models.filter((m) => m === 'A').length > 1, 'top of the chain is re-entered');
  assert.deepEqual([...new Set(models)].sort(), ['A', 'B', 'C']);
});

test('escalating wraparound omits revisits of quarantined members', () => {
  const plan = buildEscalatingWraparoundPlan(['A', 'B', 'C'], { skipRevisitsFor: (model) => model === 'A' });
  const models = plan.map((stage) => stage.model);
  assert.equal(models.filter((m) => m === 'A').length, 1, 'first occurrence stays (preflight records the cooldown skip)');
  assert.equal(models.indexOf('A'), 0, 'the kept occurrence is the first one');
  assert.ok(models.filter((m) => m === 'B').length > 0 && models.filter((m) => m === 'C').length > 0);
});

test('escalating wraparound gating applies to revisits only, not primaries', () => {
  const plan = buildEscalatingWraparoundPlan(['A', 'B', 'C'], { skipRevisitsFor: () => true });
  const models = plan.map((stage) => stage.model);
  assert.deepEqual(models, ['A', 'B', 'C'], 'each member keeps exactly its first attempt');
});
