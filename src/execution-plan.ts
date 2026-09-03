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
