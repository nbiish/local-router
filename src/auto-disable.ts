/**
 * auto-disable.ts — turn sustained failure into a visible, reversible chain edit.
 *
 * The operator asked for auto-disable when a member "fails continuously past a
 * day". Three properties matter more than the rule itself:
 *
 *  1. **One source of truth.** The result is written into the existing
 *     `disabledModels` list on the route, which the chain already honors
 *     (`reason: 'disabled_toggle'`). There is no second disable mechanism to
 *     drift against, and the operator can see and undo it in the chain editor.
 *
 *  2. **Never empty a chain.** A chain with every member disabled is a 100%
 *     outage. If every member qualifies, the healthiest one is left enabled and
 *     a loud warning is raised — an operator can act on a warning; they cannot
 *     act on a dead router.
 *
 *  3. **Distinguishable and reversible.** An auto-disabled member is recorded
 *     with a reason and a timestamp so the UI can tell it apart from an
 *     operator's deliberate choice, and re-enabling is one action.
 *
 * This module does not decide *whether* a member qualifies — the health registry
 * owns that evidence. It only applies the decision to the chain, and it is
 * deliberately pure with respect to storage: the caller supplies the route and
 * persists.
 */

export interface AutoDisableCandidate {
  model: string;
  failingMs: number;
  failureRate: number | null;
  consecutiveFailures: number;
}

export interface AutoDisablePlan {
  /** Members to disable, with the reason recorded for each. */
  disable: { model: string; reason: string; since: number }[];
  /** Members kept despite qualifying, because disabling them would empty the chain. */
  kept: { model: string; why: string }[];
  /** True when the chain would have been emptied and the guard fired. */
  guardFired: boolean;
}

export interface AutoDisableInput {
  /** Every model configured on the route, in chain order. */
  configuredModels: string[];
  /** Models already disabled by the operator — never touched by this code. */
  operatorDisabledModels: string[];
  /** Members the health registry says have failed past the threshold. */
  candidates: AutoDisableCandidate[];
  now?: number;
}

/**
 * Pick the healthiest candidate to keep when disabling would empty the chain.
 *
 * Healthiest = lowest failure rate, then fewest consecutive failures, then
 * shortest failing span. Deterministic, so two runs over the same evidence
 * agree and the log is reproducible.
 */
function healthiest(candidates: AutoDisableCandidate[]): AutoDisableCandidate {
  return [...candidates].sort((a, b) => {
    const rateA = a.failureRate ?? 1;
    const rateB = b.failureRate ?? 1;
    if (rateA !== rateB) return rateA - rateB;
    if (a.consecutiveFailures !== b.consecutiveFailures) return a.consecutiveFailures - b.consecutiveFailures;
    return a.failingMs - b.failingMs;
  })[0];
}

export function planAutoDisable(input: AutoDisableInput): AutoDisablePlan {
  const now = input.now ?? Date.now();
  const operatorDisabled = new Set(input.operatorDisabledModels);
  const configured = input.configuredModels.filter((model) => !operatorDisabled.has(model));

  // Only members that are still enabled and actually present in the chain.
  const eligible = input.candidates.filter((candidate) => configured.includes(candidate.model));
  if (eligible.length === 0) {
    return { disable: [], kept: [], guardFired: false };
  }

  const operatorStillEnabled = configured.length;
  const disableAll = eligible.length;

  // The guard: disabling every remaining member is an outage, not a cleanup.
  if (disableAll >= operatorStillEnabled) {
    const survivor = healthiest(eligible);
    return {
      disable: eligible
        .filter((candidate) => candidate.model !== survivor.model)
        .map((candidate) => ({
          model: candidate.model,
          reason: `auto:sustained_failure (failing ${Math.round(candidate.failingMs / 3_600_000)}h, rate ${formatRate(candidate.failureRate)})`,
          since: now
        })),
      kept: [{
        model: survivor.model,
        why: 'kept enabled because disabling every member would empty the chain; it has the best observed health'
      }],
      guardFired: true
    };
  }

  return {
    disable: eligible.map((candidate) => ({
      model: candidate.model,
      reason: `auto:sustained_failure (failing ${Math.round(candidate.failingMs / 3_600_000)}h, rate ${formatRate(candidate.failureRate)})`,
      since: now
    })),
    kept: [],
    guardFired: false
  };
}

function formatRate(rate: number | null): string {
  return rate == null ? 'unknown' : `${Math.round(rate * 100)}%`;
}

/** Apply a plan to a route's disabled list without duplicating or reordering. */
export function applyAutoDisable(
  currentDisabled: string[],
  plan: AutoDisablePlan
): { disabledModels: string[]; added: string[] } {
  const existing = new Set(currentDisabled);
  const added: string[] = [];
  for (const entry of plan.disable) {
    if (!existing.has(entry.model)) {
      existing.add(entry.model);
      added.push(entry.model);
    }
  }
  return { disabledModels: [...existing], added };
}

/** Remove an auto-disabled member (operator re-enable). Returns the new list. */
export function reEnableModel(currentDisabled: string[], model: string): string[] {
  return currentDisabled.filter((entry) => entry !== model);
}
