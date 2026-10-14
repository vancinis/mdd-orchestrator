/**
 * v1 scored the preflight answers against a threshold. v2 scores nothing: every run starts with
 * exploration and a validated mdd-risk verdict alone selects the low or high continuation.
 */
export const POLICY_VERSION = 'mdd-routing-v2';

/** Request pins are not output policy identifiers; omission is never upgraded or stamped. */
export const FIXED_ROUTING_VERSION = 2;
export const FUTURE_ROUTING_VERSION = 3;
/** Vocabulary for future assessments only; current runtime routes remain low or high. */
export type AssessmentLevel = 'low' | 'medium' | 'high';

export type Answers = {
  certainty: 'very-sure' | 'somewhat-sure' | 'not-sure';
  artifactStore: 'engram' | 'openspec' | 'both' | 'none';
  mode: 'interactive' | 'automatic';
  summary: 'detailed' | 'medium' | 'low';
};

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
