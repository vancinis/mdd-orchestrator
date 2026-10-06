import { isDeepStrictEqual } from 'node:util';
import { HIGH_ROUTE, preflight, ROUTES } from './kernel.js';
import type { Evaluation } from './kernel.js';
import type { Answers, Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

/**
 * A request may carry `route`: the phases its run was evaluated with when it started. It is not
 * a preflight answer and grants nothing; it only has to be one of the routes the policy can
 * choose, so a persisted run keeps the route it was started on after the routing policy changes.
 */
function recordedRoute(request: unknown): { base: unknown; route?: Phase[] } {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(request, 'route')) return { base: request };
  const { route, ...base } = request as Record<string, unknown>;
  if (!ROUTES.some(known => isDeepStrictEqual(route, [...known]))) throw new ValidationError('The recorded route is not a known MDD route.');
  return { base, route: [...route as Phase[]] };
}

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
    const { base, route } = recordedRoute(request);
    const resolved = preflight(base);
    this.#answers = resolved.answers;
    const current = resolved.evaluation;
    this.#evaluation = !route || isDeepStrictEqual(route, current.phases) ? current : {
      ...current, route: isDeepStrictEqual(route, [...HIGH_ROUTE]) ? 'high' : 'low', phases: route,
      reasons: [...current.reasons, `This run keeps the route it started with (${route.join(', ')}); the current routing policy would choose ${current.phases.join(', ')}.`],
    };
    this.#next = { kind: 'execute', phase: this.#evaluation.phases[0]! };
  }

  /** The request to persist for this run: its preflight request plus the route it started on. */
  static recordedRequest(request: unknown, workflow: Workflow): unknown {
    const { base } = recordedRoute(request);
    if (!base || typeof base !== 'object' || Array.isArray(base)) return structuredClone(base);
    return { ...structuredClone(base as Record<string, unknown>), route: [...workflow.#evaluation.phases] };
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
    try { return Workflow.#replay(request, events); }
    catch (error) {
      // A record written before runs kept their route is replayed under today's policy, which
      // may route the same answers differently. Its own history then names the route it ran on,
      // and it is accepted only when exactly one known route reproduces that history.
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.hasOwn(request, 'route')) throw error;
      const fits = ROUTES.flatMap(route => {
        try { return [Workflow.#replay({ ...request as Record<string, unknown>, route: [...route] }, events)]; }
        catch { return []; }
      });
      if (fits.length === 1) return fits[0]!;
      throw error;
    }
  }

  static #replay(request: unknown, events: readonly WorkflowEvent[]): Workflow {
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
