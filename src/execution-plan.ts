/**
 * Wraparound execution plan for fallback routes and router exhaustion.
 * Before advancing to model N+1, revisits models 1..N (one attempt each) so subscription
 * windows (e.g. 5h quotas) can recover before paid tiers are used.
 */

export type ExecutionStage = {
  stage: string;
  model: string;
  attempts: number;
  primary: boolean;
  pass?: number;
  totalPasses?: number;
};

export const DEFAULT_PRIMARY_STAGE_ATTEMPTS = 3;
export const DEFAULT_FALLBACK_ROUNDS = 3;

/**
 * Multi-pass execution plan:
 * Traverses eligible models in the fallback chain for `totalPasses` rounds (at least 3 rounds).
 * Pass 1: Primary traversal across all eligible models.
 * Pass 2: Second full pass (allows temporary 429 rate limits and concurrency locks to reset).
 * Pass 3: Third full pass before terminal failure from the 'local-router' provider.
 */
export function buildMultiPassExecutionPlan(
  models: string[],
  totalPasses: number = DEFAULT_FALLBACK_ROUNDS,
  attemptsPerModel: number = 1
): ExecutionStage[] {
  const stages: ExecutionStage[] = [];
  if (models.length === 0) return stages;

  for (let pass = 1; pass <= totalPasses; pass += 1) {
    for (let index = 0; index < models.length; index += 1) {
      stages.push({
        stage: `pass-${pass}-step-${index + 1}`,
        model: models[index],
        attempts: attemptsPerModel,
        primary: pass === 1 && index === 0,
        pass,
        totalPasses
      });
    }
  }

  return stages;
}

/**
 * For models [A, B, C]:
 * A (primary), revisit A, B (primary), A, B (revisit), C (primary), A, B, C (revisit).
 */
export function buildWraparoundExecutionPlan(
  models: string[],
  primaryAttempts: number = DEFAULT_PRIMARY_STAGE_ATTEMPTS
): ExecutionStage[] {
  const stages: ExecutionStage[] = [];
  if (models.length === 0) return stages;

  for (let index = 0; index < models.length; index += 1) {
    stages.push({
      stage: `primary-${index + 1}`,
      model: models[index],
      attempts: primaryAttempts,
      primary: true
    });

    if (index < models.length - 1) {
      for (let bridgeIndex = 0; bridgeIndex <= index; bridgeIndex += 1) {
        stages.push({
          stage: `wrap-${index + 1}-revisit-${bridgeIndex + 1}`,
          model: models[bridgeIndex],
          attempts: 1,
          primary: false
        });
      }
    }
  }

  return stages;
}

/**
 * Escalating wraparound plan (2026-09-04 operator contract):
 *
 * Failures always advance to the next model so agent harnesses are never
 * interrupted. After two fallback failures the FIRST model is retried (its
 * usage window may have reset), then the list runs until three models fail
 * and the top is retried again, then until four fail, and so on — the
 * per-cycle failure threshold escalates by one each restart — until a full
 * traversal completes without triggering a restart, i.e. the whole list is
 * exhausted.
 */
export function buildEscalatingWraparoundPlan(models: string[]): ExecutionStage[] {
  const stages: ExecutionStage[] = [];
  if (models.length === 0) return stages;

  let threshold = 2; // restart from the top after N failures in a cycle
  let failuresInCycle = 0;
  let pass = 1;
  let index = 0;
  // Each cycle costs at most `threshold` stages; the loop terminates once
  // threshold >= models.length (a full traversal then ends exhausted).
  const maxStages = (models.length * (models.length + 1)) / 2 + models.length;

  while (index < models.length && stages.length < maxStages) {
    stages.push({
      stage: `pass-${pass}-step-${index + 1}`,
      model: models[index],
      attempts: 1,
      primary: stages.length === 0,
      pass
    });

    failuresInCycle += 1;
    index += 1;

    if (failuresInCycle >= threshold && threshold < models.length) {
      // Usage-reset retry: start over from the top of the chain.
      pass += 1;
      index = 0;
      failuresInCycle = 0;
      threshold += 1;
    }
  }

  return stages;
}
