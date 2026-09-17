import { POLICY_VERSION } from './policy.js';
import type { Answers, Phase, ScoredField } from './policy.js';
import { objectWithKeys, parseAnswers, parseConfig, ValidationError } from './validation.js';

export type Evaluation = {
  policyVersion: string;
  score: number;
  threshold: number;
  route: 'low' | 'high';
  phases: Phase[];
  contributions: { field: ScoredField; answer: string; points: number }[];
  reasons: string[];
};

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
      throw new ValidationError('profile.answers is required. Supply all five preflight answers; this proof does not prompt.');
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
    { field: 'complexity', answer: answers.complexity, points: config.weights.complexity[answers.complexity] },
  ];
  const score = contributions.reduce((sum, contribution) => sum + contribution.points, 0);
  const route = score >= config.threshold ? 'high' : 'low';
  const reasons = [
    `Score ${score} ${route === 'high' ? '>=' : '<'} threshold ${config.threshold}: ${route} route.`,
    'Artifact storage is unscored.',
  ];
  let phases: Phase[];
  if (route === 'high') {
    phases = ['mdd-explore', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify'];
    reasons.push('High route always includes exactly one exploration phase.');
  } else {
    const explorationReasons: string[] = [];
    if (answers.certainty !== 'very-sure') {
      explorationReasons.push(`Low-route exploration required: certainty is ${answers.certainty}.`);
    }
    if (answers.complexity !== 'not-complex') {
      explorationReasons.push(`Low-route exploration required: complexity is ${answers.complexity}.`);
    }
    if (request.explore === true) explorationReasons.push('Low-route exploration explicitly requested.');
    phases = ['mdd-plan', 'mdd-apply', 'mdd-verify'];
    if (explorationReasons.length > 0) {
      phases.unshift('mdd-explore');
      reasons.push(...explorationReasons);
    } else {
      reasons.push('Low-route exploration not required: very-sure requirements and not-complex work.');
    }
  }
  return {
    answers,
    evaluation: { policyVersion: POLICY_VERSION, score, threshold: config.threshold, route, phases, contributions, reasons },
  };
}

export function evaluate(value: unknown): Evaluation {
  return preflight(value).evaluation;
}
