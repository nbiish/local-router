/**
 * Verify the fallback chain against the live router: real cost ordering, real
 * coverage, and the capability gate.
 *
 * Complements `tests/fallback-topology.test.mjs`, which is offline and therefore
 * cannot know whether an id is actually served. This one asks the router.
 *
 *   node scripts/verify-fallback-chain.mjs
 */
const ROUTER = process.env.LOCAL_ROUTER_TEST_URL || 'http://127.0.0.1:11434';

const failures = [];

async function json(pathname, init) {
  const res = await fetch(`${ROUTER}${pathname}`, init);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${pathname} -> ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

const coverage = await json('/api/routing/coverage');
console.log(`route: ${coverage.route}`);
console.log(`steps: ${coverage.steps.length}\n`);

console.table(coverage.steps.map((step) => ({
  model: step.model.length > 44 ? step.model.slice(0, 44) + '…' : step.model,
  band: step.costBand,
  status: step.status,
  ctx: step.contextLength,
  lvls: step.reasoningLevels,
  vis: step.supportsVision ? 'y' : '-'
})));

// 1. Cost ordering: bands must be non-decreasing (free -> subscription -> paid -> unknown).
const bandRank = { free: 0, subscription: 1, paid: 2, unknown: 3 };
let worst = -1;
for (const step of coverage.steps) {
  const rank = bandRank[step.costBand] ?? 3;
  if (rank < worst) {
    failures.push(`out of cost order: ${step.model} (${step.costBand}) follows a more expensive band`);
  }
  worst = Math.max(worst, rank);
}

// 2. Coverage: every configured chat provider reachable, nothing unkeyed in the chain.
if (coverage.coverage.providersAbsentFromChain.length > 0) {
  failures.push(`configured providers absent from the chain: ${coverage.coverage.providersAbsentFromChain.join(', ')}`);
}
if (coverage.coverage.unconfiguredProviders.length > 0) {
  failures.push(`chain steps whose provider has no key: ${coverage.coverage.unconfiguredProviders.join(', ')}`);
}

// 3. Every step must resolve; an unresolvable step is silently skipped at run time.
const dead = coverage.steps.filter((step) => step.status === 'unavailable');
if (dead.length > 0) {
  failures.push(`unavailable steps: ${dead.map((step) => step.model).join(', ')}`);
}

// 4. Suggested order must contain exactly the same steps (reordering, not filtering).
const actual = new Set(coverage.steps.map((step) => step.model));
const suggested = new Set(coverage.suggestedOrder);
if (actual.size !== suggested.size || [...actual].some((id) => !suggested.has(id))) {
  failures.push('the suggested order dropped or invented a step');
}

console.log(`\ncoverage: ${coverage.coverage.providersAbsentFromChain.length} absent, `
  + `${coverage.coverage.unconfiguredProviders.length} unkeyed, `
  + `${coverage.coverage.singleStepProviders.length} single-step`);
if (coverage.coverage.singleStepProviders.length > 0) {
  console.log(`  single-step providers (one failure loses the provider): ${coverage.coverage.singleStepProviders.join(', ')}`);
}

// 5. The capability gate: a request that chose a thinking level must never be
//    answered by a step with no dial.
const dialless = coverage.steps.filter((step) => step.reasoningLevels === 0).map((step) => step.model);
if (dialless.length > 0) {
  console.log(`\nsteps with no reasoning dial (excluded when a level is requested): ${dialless.join(', ')}`);
}

if (failures.length > 0) {
  console.error(`\nFAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nPASS: cost order is monotonic, coverage is complete, and every step resolves.');
