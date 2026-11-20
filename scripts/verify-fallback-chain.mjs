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
  console.log(`\nsteps with no reasoning dial (tier-2 tail — reached only after every dial-capable step fails): ${dialless.join(', ')}`);
}

// 6. Trajectory evidence: the failures the router caused itself must be gone.
//
// These are the assertions that make the audit reproducible rather than a
// one-off reading of a log. Each was a measured defect on 2026-11-20.
const healthy = await json('/api/trajectories?limit=500&route=fallback-models');
const summaries = Array.isArray(healthy.trajectories) ? healthy.trajectories : [];

// 6a. A 2xx completion must never be booked as an auth or invalid-request
//     failure. `AUTH_RE`'s bare `auth` alternative made 45 of these.
const completionMisreads = [];
for (const summary of summaries) {
  const record = await json(`/api/trajectories/${encodeURIComponent(summary.id)}`);
  for (const stage of record.stages || []) {
    if (stage.outcome !== 'failed') continue;
    const status = Number(stage.status);
    const preview = String(stage.providerErrorPreview || '');
    if (status >= 200 && status < 300 && preview.includes('"choices"')) {
      completionMisreads.push(`${stage.targetModel} (${stage.errorType})`);
    }
  }
}
if (completionMisreads.length > 0) {
  failures.push(`2xx completions booked as failures: ${completionMisreads.slice(0, 5).join(', ')}`
    + `${completionMisreads.length > 5 ? ` (+${completionMisreads.length - 5} more)` : ''}`);
}

// 6b. Tier-2 ordering: no dial-less member may be ATTEMPTED before every
//     dial-capable member of the same request has failed. A breach means a
//     thinking request was silently downgraded while looking successful.
let tierOrderBreaches = 0;
for (const summary of summaries) {
  if (summary.answeredBy) continue;
  const record = await json(`/api/trajectories/${encodeURIComponent(summary.id)}`);
  const stages = record.stages || [];
  const firstDegraded = stages.findIndex((stage) => stage.reasoningDialDowngraded);
  if (firstDegraded === -1) continue;
  // Only a real upstream ATTEMPT after tier 2 started is a breach. A `skipped`
  // stage there is a cooldown note, which is expected and correct.
  const attemptedAfter = stages.slice(firstDegraded + 1).some((stage) => !stage.reasoningDialDowngraded
    && stage.outcome === 'failed');
  if (attemptedAfter) tierOrderBreaches += 1;
}
if (tierOrderBreaches > 0) {
  failures.push(`${tierOrderBreaches} trajectory(ies) attempted a dial-less member before exhausting dial-capable ones`);
}

// 6c. Every plan step must be either executed or explicitly explained. A
//     configured member that vanished (no stage, no exclusion) is the silent
//     drop this log exists to catch.
let unexplained = 0;
for (const summary of summaries.slice(0, 20)) {
  const record = await json(`/api/trajectories/${encodeURIComponent(summary.id)}`);
  const chain = record.chain;
  if (!chain) continue;
  const seen = new Set([
    ...(chain.eligibleTargets || []),
    ...(chain.degradedTargets || []),
    ...(chain.excludedTargets || []).map((entry) => entry.model)
  ]);
  for (const model of chain.configuredTargets || []) {
    if (!seen.has(model)) unexplained += 1;
  }
}
if (unexplained > 0) {
  failures.push(`${unexplained} configured chain member(s) appear in no tier and no exclusion reason`);
}

console.log(`\ntrajectory evidence: ${summaries.length} fallback summary(ies) inspected`);
console.log(`  2xx completions booked as failures: ${completionMisreads.length}`);
console.log(`  tier-2 ordering breaches: ${tierOrderBreaches}`);
console.log(`  unexplained chain members: ${unexplained}`);

if (failures.length > 0) {
  console.error(`\nFAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('\nPASS: cost order is monotonic, coverage is complete, every step resolves,');
console.log('      no 2xx completion is booked as a failure, tier-2 ordering holds,');
console.log('      and every configured member is reached or explained.');
