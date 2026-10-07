import { POLICY_VERSION } from './policy.js';
import type { Answers, Phase, ScoredField } from './policy.js';
import { objectWithKeys, parseAnswers, parseConfig, ValidationError } from './validation.js';

export type Evaluation = {
  policyVersion: string;
  score: number;
  threshold: number;
  /**
   * Diagnostic only until a validated `mdd-risk` verdict selects the continuation; see
   * `Workflow.recordRiskResult`. No preflight score authorizes a route.
   */
  route: 'low' | 'high';
  phases: Phase[];
  contributions: { field: ScoredField; answer: string; points: number }[];
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

export function preflight(value: unknown): { answers: Answers; evaluation: Evaluation } {
  const request = objectWithKeys(value, 'request', ['answers', 'profile', 'config', 'explore']);
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
  const config = parseConfig(Object.hasOwn(request, 'config') ? request.config : {});
  if (Object.hasOwn(request, 'explore') && typeof request.explore !== 'boolean') {
    throw new ValidationError('request.explore must be a boolean.');
  }

  const contributions: Evaluation['contributions'] = [
    { field: 'certainty', answer: answers.certainty, points: config.weights.certainty[answers.certainty] },
    { field: 'mode', answer: answers.mode, points: config.weights.mode[answers.mode] },
    { field: 'summary', answer: answers.summary, points: config.weights.summary[answers.summary] },
  ];
  const score = contributions.reduce((sum, contribution) => sum + contribution.points, 0);
  // The legacy score is kept as a diagnostic, not a decision: it no longer picks low or high.
  // Every run always starts with exploration, then a validated mdd-risk verdict is the only thing
  // that selects the continuation (see Workflow.recordRiskResult). request.explore and
  // answers.certainty are accepted for backward compatibility with saved profiles but no longer
  // change which phase runs first.
  const route = score >= config.threshold ? 'high' : 'low';
  const reasons = [
    `Score ${score} ${route === 'high' ? '>=' : '<'} threshold ${config.threshold} (diagnostic only; mdd-risk's validated verdict selects the route, not this score).`,
    'Artifact storage is unscored.',
    'Every run always starts with exactly one exploration phase before any routing decision.',
  ];
  const phases: Phase[] = ['mdd-explore'];
  return {
    answers,
    evaluation: { policyVersion: POLICY_VERSION, score, threshold: config.threshold, route, phases, contributions, reasons },
  };
}

export function evaluate(value: unknown): Evaluation {
  return preflight(value).evaluation;
}
