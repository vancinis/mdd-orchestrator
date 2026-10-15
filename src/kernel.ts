import { FIXED_ROUTING_VERSION, FUTURE_ROUTING_VERSION, POLICY_VERSION } from './policy.js';
import type { Answers, Phase } from './policy.js';
import { objectWithKeys, parseAnswers, ValidationError } from './validation.js';

export type Evaluation = {
  policyVersion: string;
  /**
   * Absent until a validated `mdd-risk` verdict, a user override of it, or a manual recovery
   * choice selects the continuation (see `Workflow.recordRiskResult`). Nothing in the preflight
   * selects or predicts a route, so there is nothing to show before then.
   */
  route?: 'low' | 'high';
  phases: Phase[];
  reasons: string[];
};

/**
 * Every route the earlier score-routed policy could record beside a run's request. A run started
 * on one of them keeps it (see Workflow); a run started now is routed only by mdd-risk's verdict.
 */
export const HIGH_ROUTE: readonly Phase[] = Object.freeze(['mdd-explore', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify']);
export const LOW_ROUTE: readonly Phase[] = Object.freeze(['mdd-plan', 'mdd-apply', 'mdd-verify']);
export const LOW_EXPLORE_ROUTE: readonly Phase[] = Object.freeze(['mdd-explore', ...LOW_ROUTE]);
export const ROUTES: readonly (readonly Phase[])[] = Object.freeze([HIGH_ROUTE, LOW_EXPLORE_ROUTE, LOW_ROUTE]);

/** Read a preserved request's explicit pin without inferring a version from history or answers. */
export function requestRoutingVersion(value: unknown): typeof FIXED_ROUTING_VERSION | undefined {
  const request = objectWithKeys(value, 'request', ['answers', 'profile', 'explore', 'route', 'routingVersion']);
  if (!Object.hasOwn(request, 'routingVersion')) return undefined;
  if (request.routingVersion === FUTURE_ROUTING_VERSION) {
    throw new ValidationError('request.routingVersion 3: native-context-required. Fixed evaluation and Workflow cannot execute the native adaptive protocol; public registration remains inactive.');
  }
  if (request.routingVersion !== FIXED_ROUTING_VERSION) {
    throw new ValidationError('request.routingVersion is unsupported; omit it for historical semantics or supply integer 2 for fixed routing.');
  }
  return FIXED_ROUTING_VERSION;
}

export function preflight(value: unknown): { answers: Answers; evaluation: Evaluation } {
  // The preflight used to be scored against a threshold, configurable through `config`. Nothing
  // is scored now, so a request that still tries to tune a score is told so rather than having
  // its weights quietly ignored.
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'config')) {
    throw new ValidationError('request.config is no longer accepted: preflight answers are not scored, and a validated mdd-risk verdict selects the route.');
  }
  const request = objectWithKeys(value, 'request', ['answers', 'profile', 'explore', 'routingVersion']);
  requestRoutingVersion(request);
  const hasAnswers = Object.hasOwn(request, 'answers');
  const hasProfile = Object.hasOwn(request, 'profile');
  if (hasAnswers === hasProfile) {
    throw new ValidationError('Supply exactly one source: answers or profile.');
  }
  let source = request.answers;
  if (hasProfile) {
    const profile = objectWithKeys(request.profile, 'profile', ['answers']);
    if (!Object.hasOwn(profile, 'answers')) {
      throw new ValidationError('profile.answers is required. Supply the four active preflight answers (certainty, artifactStore, mode, summary); legacy complexity is accepted but ignored. This proof does not prompt.');
    }
    source = profile.answers;
  }
  const answers = parseAnswers(source);
  if (Object.hasOwn(request, 'explore') && typeof request.explore !== 'boolean') {
    throw new ValidationError('request.explore must be a boolean.');
  }
  // request.explore is accepted for backward compatibility with saved requests but no longer
  // changes which phase runs first: every run starts with exploration.
  const reasons = [
    'Every run always starts with exactly one exploration phase before any routing decision.',
    'A validated mdd-risk verdict selects the low or high continuation; the preflight answers are not scored.',
  ];
  const phases: Phase[] = ['mdd-explore'];
  return { answers, evaluation: { policyVersion: POLICY_VERSION, phases, reasons } };
}

export function evaluate(value: unknown): Evaluation {
  return preflight(value).evaluation;
}
