import { preflight } from './kernel.js';
import type { Evaluation } from './kernel.js';
import type { Answers, Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

export type NextAction =
  | { kind: 'execute' | 'approve' | 'await-result' | 'blocked'; phase: Phase }
  | { kind: 'finished' };
export type PhaseResult = { phase: Phase; outcome: 'passed' | 'failed'; evidenceSummary: string };
export type WorkflowSnapshot = {
  answers: Answers;
  evaluation: Evaluation;
  nextAction: NextAction;
  results: PhaseResult[];
};

export class Workflow {
  readonly #answers: Answers;
  readonly #evaluation: Evaluation;
  readonly #results: PhaseResult[] = [];
  #index = 0;
  #next: NextAction;

  constructor(request: unknown) {
    const resolved = preflight(request);
    this.#answers = resolved.answers;
    this.#evaluation = resolved.evaluation;
    this.#next = { kind: 'execute', phase: this.#evaluation.phases[0]! };
  }

  nextAction(): NextAction {
    return { ...this.#next };
  }

  snapshot(): WorkflowSnapshot {
    return structuredClone({
      answers: this.#answers,
      evaluation: this.#evaluation,
      nextAction: this.#next,
      results: this.#results,
    });
  }

  start(phase: Phase): void {
    if (this.#next.kind !== 'execute' || this.#next.phase !== phase) {
      throw new ValidationError('Only the current ready phase can start.');
    }
    this.#next = { kind: 'await-result', phase };
  }

  approve(phase: Phase): void {
    if (this.#next.kind !== 'approve' || this.#next.phase !== phase) {
      throw new ValidationError('Approval must name the exact phase awaiting approval.');
    }
    this.#next = { kind: 'execute', phase };
  }

  /**
   * Returns an attempt that never produced a recorded result to ready, so the same phase can be
   * tried again. A recorded result is never discarded here; only the pending attempt is released.
   */
  retry(): void {
    if (this.#next.kind === 'await-result' || this.#next.kind === 'blocked') {
      this.#next = { kind: 'execute', phase: this.#next.phase };
    }
  }

  recordResult(value: unknown): void {
    const { phase, outcome, evidenceSummary } = objectWithKeys(
      value, 'result', ['phase', 'outcome', 'evidenceSummary'],
    );
    if (outcome !== 'passed' && outcome !== 'failed') {
      throw new ValidationError('result.outcome must be passed or failed.');
    }
    if (typeof evidenceSummary !== 'string' || evidenceSummary.trim().length === 0) {
      throw new ValidationError('result.evidenceSummary must be a nonempty string.');
    }
    if (this.#next.kind !== 'await-result' || this.#next.phase !== phase) {
      throw new ValidationError('A result must name the current running phase.');
    }
    const current = this.#next.phase;
    this.#results.push({ phase: current, outcome, evidenceSummary });
    if (outcome === 'failed') {
      this.#next = { kind: 'blocked', phase: current };
      return;
    }
    const nextPhase = this.#evaluation.phases[this.#index + 1];
    if (nextPhase === undefined) {
      this.#next = { kind: 'finished' };
      return;
    }
    this.#index += 1;
    this.#next = {
      kind: this.#answers.mode === 'automatic' ? 'execute' : 'approve',
      phase: nextPhase,
    };
  }
}
