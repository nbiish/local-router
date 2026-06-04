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
};

export const DEFAULT_PRIMARY_STAGE_ATTEMPTS = 3;

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
