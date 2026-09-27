import { preflight } from './kernel.js';
import type { Evaluation } from './kernel.js';
import type { Answers, Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

export type NextAction =
  | { kind: 'execute' | 'approve' | 'await-result' | 'blocked'; phase: Phase }
  | { kind: 'finished' };
export type PhaseResult = { phase: Phase; outcome: 'passed' | 'failed'; evidenceSummary: string };
export type WorkflowEvent =
  | { kind: 'start' | 'approve' | 'rework'; phase: Phase }
  | { kind: 'retry' }
  | { kind: 'result'; result: PhaseResult };
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
  readonly #events: WorkflowEvent[] = [];
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

  /** Replay only transitions validated by the ordinary state machine; never restore authority from a snapshot. */
  static replay(request: unknown, events: readonly WorkflowEvent[]): Workflow {
    if (!Array.isArray(events) || events.length > 512) throw new ValidationError('Invalid workflow history.');
    const workflow = new Workflow(request);
    for (const event of events) {
      const item = objectWithKeys(event, 'workflow event', ['kind', 'phase', 'result']);
      if (item.kind === 'retry') {
        if (Object.keys(item).length !== 1 || !['blocked', 'await-result'].includes(workflow.#next.kind)) throw new ValidationError('Invalid retry event.');
        workflow.retry();
      } else if (item.kind === 'result') {
        if (Object.keys(item).length !== 2) throw new ValidationError('Invalid result event.');
        workflow.recordResult(item.result);
      } else if (item.kind === 'start' || item.kind === 'approve' || item.kind === 'rework') {
        if (Object.keys(item).length !== 2 || typeof item.phase !== 'string') throw new ValidationError('Invalid phase event.');
        workflow[item.kind](item.phase as Phase);
      } else throw new ValidationError('Unknown workflow event.');
    }
    return workflow;
  }

  history(): WorkflowEvent[] { return structuredClone(this.#events); }

  start(phase: Phase): void {
    if (this.#next.kind !== 'execute' || this.#next.phase !== phase) {
      throw new ValidationError('Only the current ready phase can start.');
    }
    this.#next = { kind: 'await-result', phase };
    this.#events.push({ kind: 'start', phase });
  }

  approve(phase: Phase): void {
    if (this.#next.kind !== 'approve' || this.#next.phase !== phase) {
      throw new ValidationError('Approval must name the exact phase awaiting approval.');
    }
    this.#next = { kind: 'execute', phase };
    this.#events.push({ kind: 'approve', phase });
  }

  /**
   * Returns an attempt that never produced a recorded result to ready, so the same phase can be
   * tried again. A recorded result is never discarded here; only the pending attempt is released.
   */
  retry(): void {
    if (this.#next.kind === 'await-result' || this.#next.kind === 'blocked') {
      this.#next = { kind: 'execute', phase: this.#next.phase };
      this.#events.push({ kind: 'retry' });
    }
  }

  /**
   * Sends a route blocked by a failed phase back to an earlier phase of the same route, so the
   * work that failure points at can be corrected without discarding the run. Recorded results
   * stay: they are the history, and the failed one is what the reworked phase is asked to fix.
   */
  rework(phase: Phase): void {
    if (this.#next.kind !== 'blocked') throw new ValidationError('Only a route stopped by a failed phase can be reworked.');
    const target = this.#evaluation.phases.indexOf(phase);
    const current = this.#evaluation.phases.indexOf(this.#next.phase);
    if (target < 0 || target >= current) throw new ValidationError('Rework must name an earlier phase of this route.');
    this.#index = target;
    this.#next = { kind: 'execute', phase };
    this.#events.push({ kind: 'rework', phase });
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
    this.#events.push({ kind: 'result', result: { phase: current, outcome, evidenceSummary } });
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
