import test from 'node:test';
import assert from 'node:assert/strict';

const { planAutoDisable, applyAutoDisable, reEnableModel } = await import('../build/auto-disable.js');

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000; // fixed clock keeps the reasons reproducible

function candidate(model, failingMs, rate = 1, consecutive = 5) {
  return { model, failingMs, failureRate: rate, consecutiveFailures: consecutive };
}

test('a member failing continuously past a day is disabled', () => {
  const plan = planAutoDisable({
    configuredModels: ['good', 'dead'],
    operatorDisabledModels: [],
    candidates: [candidate('dead', 25 * HOUR)],
    now: NOW
  });
  assert.deepEqual(plan.disable.map((d) => d.model), ['dead']);
  assert.match(plan.disable[0].reason, /auto:sustained_failure/);
  assert.match(plan.disable[0].reason, /25h/, 'the reason states how long it has been failing');
  assert.equal(plan.guardFired, false);
});

test('a member with a recent success is left alone', () => {
  // Not a candidate at all — the registry only offers members whose whole
  // threshold span is success-free. Guard the contract from this side too.
  const plan = planAutoDisable({
    configuredModels: ['good', 'ok'],
    operatorDisabledModels: [],
    candidates: [],
    now: NOW
  });
  assert.equal(plan.disable.length, 0);
});

test('the guard never empties a chain — the healthiest member survives', () => {
  const plan = planAutoDisable({
    configuredModels: ['worst', 'best'],
    operatorDisabledModels: [],
    candidates: [candidate('worst', 30 * HOUR, 1.0, 9), candidate('best', 25 * HOUR, 0.6, 3)],
    now: NOW
  });
  assert.equal(plan.guardFired, true);
  assert.deepEqual(plan.disable.map((d) => d.model), ['worst'], 'the healthier member stays enabled');
  assert.deepEqual(plan.kept.map((k) => k.model), ['best']);
  assert.match(plan.kept[0].why, /empty the chain/);
});

test('an operator-disabled member is never touched by auto-disable', () => {
  // 'a' is already off by operator choice. 'b' is not a candidate here, so the
  // only question is whether the operator's own choice gets re-reported.
  const plan = planAutoDisable({
    configuredModels: ['a', 'b'],
    operatorDisabledModels: ['a'],
    candidates: [candidate('a', 40 * HOUR)],
    now: NOW
  });
  assert.deepEqual(plan.disable.map((d) => d.model), [],
    'a is already off by operator choice and must not be re-reported');
});

test('auto-disable acts on a bad member when a healthy one remains', () => {
  const plan = planAutoDisable({
    configuredModels: ['bad', 'healthy'],
    operatorDisabledModels: [],
    candidates: [candidate('bad', 25 * HOUR)],
    now: NOW
  });
  assert.deepEqual(plan.disable.map((d) => d.model), ['bad']);
  assert.equal(plan.guardFired, false, 'a healthy member remains, so the guard does not fire');
});

test('the guard counts only members that are still enabled', () => {
  // 'a' is operator-disabled, so disabling 'b' would leave zero enabled members.
  const plan = planAutoDisable({
    configuredModels: ['a', 'b'],
    operatorDisabledModels: ['a'],
    candidates: [candidate('b', 30 * HOUR)],
    now: NOW
  });
  assert.equal(plan.guardFired, true);
  assert.equal(plan.disable.length, 0, 'b is the last enabled member and must survive');
  assert.deepEqual(plan.kept.map((k) => k.model), ['b']);
});

test('applying a plan does not duplicate an already-disabled member', () => {
  const plan = planAutoDisable({
    configuredModels: ['dead', 'ok'],
    operatorDisabledModels: [],
    candidates: [candidate('dead', 25 * HOUR)],
    now: NOW
  });
  const first = applyAutoDisable([], plan);
  assert.deepEqual(first.added, ['dead']);
  const second = applyAutoDisable(first.disabledModels, plan);
  assert.deepEqual(second.added, [], 'a repeat run adds nothing');
  assert.deepEqual(second.disabledModels, ['dead']);
});

test('re-enabling removes the member and nothing else', () => {
  assert.deepEqual(reEnableModel(['a', 'b', 'c'], 'b'), ['a', 'c']);
  assert.deepEqual(reEnableModel(['a'], 'missing'), ['a']);
});

test('a candidate absent from the chain is ignored', () => {
  const plan = planAutoDisable({
    configuredModels: ['x'],
    operatorDisabledModels: [],
    candidates: [candidate('ghost', 50 * HOUR)],
    now: NOW
  });
  assert.equal(plan.disable.length, 0, 'never disable something that is not in this chain');
});

test('an all-healthy chain produces an empty plan', () => {
  const plan = planAutoDisable({
    configuredModels: ['a', 'b', 'c'],
    operatorDisabledModels: [],
    candidates: [],
    now: NOW
  });
  assert.deepEqual(plan, { disable: [], kept: [], guardFired: false });
});

test('the plan is deterministic for identical evidence', () => {
  const input = {
    configuredModels: ['p', 'q', 'r'],
    operatorDisabledModels: [],
    candidates: [candidate('p', 25 * HOUR, 1, 5), candidate('q', 26 * HOUR, 0.9, 4), candidate('r', 30 * HOUR, 0.95, 7)],
    now: NOW
  };
  assert.deepEqual(planAutoDisable(input), planAutoDisable(input));
});
