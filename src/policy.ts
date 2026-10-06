export const POLICY_VERSION = 'mdd-routing-v1';

export type Answers = {
  certainty: 'very-sure' | 'somewhat-sure' | 'not-sure';
  artifactStore: 'engram' | 'openspec' | 'both' | 'none';
  mode: 'interactive' | 'automatic';
  summary: 'detailed' | 'medium' | 'low';
};

export type ScoredField = Exclude<keyof Answers, 'artifactStore'>;
export type Weights = { [Field in ScoredField]: Record<Answers[Field], number> };
export type Config = { threshold: number; weights: Weights };
export type Phase =
  | 'mdd-explore' | 'mdd-plan' | 'mdd-propose' | 'mdd-spec'
  | 'mdd-design' | 'mdd-tasks' | 'mdd-apply' | 'mdd-verify';

/**
 * The exact eight workflow phases, named once rather than derived by filtering every actor the
 * adapter happens to know about. `mdd-risk` and `orchestrator` are actors with a configurable
 * model, not stops on the route, so deriving this list from that broader roster would silently
 * let a new actor leak into every `Record<Phase, ...>` and phase-only guard that reads it.
 */
export const PHASES: readonly Phase[] = Object.freeze([
  'mdd-explore', 'mdd-plan', 'mdd-propose', 'mdd-spec',
  'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify',
]);

export function getDefaultConfig(): Config {
  return {
    threshold: 50,
    weights: {
      certainty: { 'very-sure': 10, 'somewhat-sure': 15, 'not-sure': 25 },
      mode: { interactive: 15, automatic: 5 },
      summary: { detailed: 25, medium: 10, low: 5 },
    },
  };
}
