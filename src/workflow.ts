import { isDeepStrictEqual } from 'node:util';
import { HIGH_ROUTE, preflight, ROUTES } from './kernel.js';
import type { Evaluation } from './kernel.js';
import type { Answers, Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';
import { applyPlan, completeRemaining, completeStep, selectedStep, taskIDs } from './apply-batches.js';
import type { ApplyProgress, ApplyStep } from './apply-batches.js';

/**
 * A request may carry `route`: the phases a run started before the mdd-risk stop existed was
 * evaluated with. It is not a preflight answer and grants nothing; it only has to be one of the
 * routes the earlier score-routed policy could choose. Such a legacy run keeps that route to the
 * end and never enters the risk stop. A run started now records no route: its tail is selected
 * only by the replayed mdd-risk verdict, override or manual recovery events.
 */
function recordedRoute(request: unknown): { base: unknown; route?: Phase[] } {
  if (!request || typeof request !== 'object' || Array.isArray(request) || !Object.hasOwn(request, 'route')) return { base: request };
  const { route, ...base } = request as Record<string, unknown>;
  if (!ROUTES.some(known => isDeepStrictEqual(route, [...known]))) throw new ValidationError('The recorded route is not a known MDD route.');
  return { base, route: [...route as Phase[]] };
}

/**
 * `execute-risk` / `await-risk-result` / `blocked-risk` model `mdd-risk` as its own typed
 * execution stop, deliberately apart from the eight `Phase` values: it assesses complexity and
 * risk and selects the continuation, it does not occupy a stop on the eight-phase route, and its
 * report is not an ordinary phase report. Before a validated verdict selects a continuation, the
 * route is undecided: there is exactly one stop beyond exploration, this one, and no low or high
 * tail is reachable yet.
 */
/**
 * How the active route was selected, once a tail is set: `suggested` and `override` only follow
 * a passed `mdd-risk` verdict (the verdict itself is always retained; override only changes which
 * tail runs), while `manual` follows a user recovery choice from `blocked-risk`, which never
 * carries a `RiskVerdict`. Status and report read this to show provenance honestly.
 */
export type RouteOrigin = 'suggested' | 'override' | 'manual';
export type NextAction =
  | { kind: 'execute' | 'approve' | 'await-result' | 'blocked'; phase: Phase }
  | { kind: 'execute-risk' | 'await-risk-result' | 'blocked-risk' }
  | { kind: 'finished' };
export type PhaseResult = { phase: Phase; outcome: 'passed' | 'failed'; evidenceSummary: string;
  applyPlan?: ApplyStep[]; completed?: string[]; batchID?: string };
/** `mdd-risk`'s own result shape: a route is only ever present on a passed outcome. */
export type RiskResult = { outcome: 'passed' | 'failed'; evidenceSummary: string; route?: 'low' | 'high' };
export type WorkflowEvent =
  | { kind: 'start' | 'approve' | 'rework'; phase: Phase }
  | { kind: 'apply-plan'; planned: ApplyStep[] }
  | { kind: 'retry' | 'risk-start' }
  | { kind: 'result'; result: PhaseResult }
  | { kind: 'risk-result'; result: RiskResult }
  /**
   * The user forces the other route instead of the one `mdd-risk` suggested, while the first tail
   * phase of the suggested route is still only awaiting its ordinary approval (`approve`/`execute`
   * are unchanged: continuing is still just an ordinary `approve` event, never a new kind). The
   * original `risk-result` event is never replaced; only which tail runs changes.
   */
  | { kind: 'route-override' }
  /**
   * The user's recovery decision from `blocked-risk`: retry reuses the plain `retry` event. Low
   * and high are manual choices with no `RiskVerdict` — no `risk-result` event is appended for
   * them, only this one, naming the manually chosen route.
   */
  | { kind: 'risk-recovery'; route: 'low' | 'high' };
export type WorkflowSnapshot = {
  answers: Answers;
  evaluation: Evaluation;
  nextAction: NextAction;
  results: PhaseResult[];
  /** Present only once a tail has actually been selected, by any origin. */
  routeOrigin?: RouteOrigin;
};

const LOW_TAIL = ['mdd-plan', 'mdd-apply', 'mdd-verify'] as const;
const HIGH_TAIL = ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify'] as const;

/**
 * The results that still describe the held plan. A rework that sends the route back to a planning
 * phase (any phase before Apply) replaces acceptance, decisions or the plan, so what Tasks and Verify
 * recorded before it no longer describes what is held. That boundary is visible in the results
 * alone: a result on an earlier planning phase than the one before it. Until the reworked phase
 * records its first result, the boundary is the phase the route now stands at (`current`): a planning
 * phase earlier than the last result means everything recorded so far belongs to the old plan.
 * Results are never discarded; this only says which of them the held plan and verification answer for.
 */
export function currentGeneration(results: readonly PhaseResult[], route: readonly Phase[], current?: Phase): PhaseResult[] {
  const apply = route.indexOf('mdd-apply');
  const planning = (phase: Phase) => { const at = route.indexOf(phase); return at >= 0 && at < apply; };
  const last = results.at(-1);
  if (current && last && planning(current) && route.indexOf(current) < route.indexOf(last.phase)) return [];
  let start = 0;
  for (let index = 1; index < results.length; index += 1) {
    const phase = results[index]!.phase;
    if (planning(phase) && route.indexOf(phase) < route.indexOf(results[index - 1]!.phase)) start = index;
  }
  return results.slice(start);
}

export class Workflow {
  readonly #answers: Answers;
  readonly #evaluation: Evaluation;
  readonly #results: PhaseResult[] = [];
  readonly #events: WorkflowEvent[] = [];
  #index = 0;
  #next: NextAction;
  #apply: ApplyProgress | undefined;
  /**
   * Set by a rework that returns a failed Verify to Apply, cleared by the next passed Apply. That
   * pass is one correction owned by one actor: it may complete every remaining deliverable at once,
   * because the findings it closes cut across them. Replay still accepts the older step-by-step form.
   */
  #correcting = false;
  #routeOrigin?: RouteOrigin;
  /** A run started on a recorded score-routed route, before the mdd-risk stop existed. */
  readonly #legacyRoute: boolean;

  constructor(request: unknown) {
    const { base, route } = recordedRoute(request);
    const resolved = preflight(base);
    this.#answers = resolved.answers;
    const current = resolved.evaluation;
    // A new run's route is provisional at construction: exploration is the one phase every route
    // starts with, and nothing beyond it is authorized until a validated mdd-risk verdict selects
    // the low or high continuation; nothing in the preflight substitutes for that. Only a run
    // that recorded its route before the risk stop existed keeps that route instead.
    this.#legacyRoute = route !== undefined;
    this.#evaluation = !route ? current : {
      ...current, route: isDeepStrictEqual(route, [...HIGH_ROUTE]) ? 'high' : 'low', phases: route,
      reasons: [...current.reasons, `This run keeps the route it started with (${route.join(', ')}), recorded before the mdd-risk stop selected routes.`],
    };
    this.#next = { kind: 'execute', phase: this.#evaluation.phases[0]! };
  }

  /**
   * The request to persist for this run. A new run records no route beside it: its tail is derived
   * from the replayed risk verdict, override or manual recovery events. A legacy run keeps the
   * route it recorded, so it still replays on that route after every restart.
   */
  static recordedRequest(request: unknown, workflow: Workflow): unknown {
    const { base } = recordedRoute(request);
    if (!workflow.#legacyRoute || !base || typeof base !== 'object' || Array.isArray(base)) return structuredClone(base);
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
      ...(this.#routeOrigin ? { routeOrigin: this.#routeOrigin } : {}),
    });
  }

  /** Replay only transitions validated by the ordinary state machine; never restore authority from a snapshot. */
  static replay(request: unknown, events: readonly WorkflowEvent[]): Workflow {
    try { return Workflow.#replay(request, events); }
    catch (error) {
      // A record written before runs kept their route, and before the risk stop, does not replay
      // as a new run. Its own history then names the route it ran on, and it is accepted only when
      // exactly one known legacy route reproduces that history.
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
      const item = objectWithKeys(event, 'workflow event', ['kind', 'phase', 'result', 'planned', 'route']);
      if (item.kind === 'retry') {
        if (Object.keys(item).length !== 1 || !['blocked', 'await-result', 'blocked-risk', 'await-risk-result'].includes(workflow.#next.kind))
          throw new ValidationError('Invalid retry event.');
        workflow.retry();
      } else if (item.kind === 'apply-plan') {
        if (Object.keys(item).length !== 2) throw new ValidationError('Invalid Apply plan event.');
        workflow.bindApplyPlan(item.planned);
      } else if (item.kind === 'result') {
        if (Object.keys(item).length !== 2) throw new ValidationError('Invalid result event.');
        workflow.recordResult(item.result);
      } else if (item.kind === 'risk-start') {
        if (Object.keys(item).length !== 1) throw new ValidationError('Invalid risk-start event.');
        workflow.startRisk();
      } else if (item.kind === 'risk-result') {
        if (Object.keys(item).length !== 2) throw new ValidationError('Invalid risk-result event.');
        workflow.recordRiskResult(item.result);
      } else if (item.kind === 'route-override') {
        if (Object.keys(item).length !== 1) throw new ValidationError('Invalid route-override event.');
        workflow.overrideRoute();
      } else if (item.kind === 'risk-recovery') {
        if (Object.keys(item).length !== 2) throw new ValidationError('Invalid risk-recovery event.');
        workflow.chooseManualRoute(item.route as 'low' | 'high');
      } else if (item.kind === 'start' || item.kind === 'approve' || item.kind === 'rework') {
        if (Object.keys(item).length !== 2 || typeof item.phase !== 'string') throw new ValidationError('Invalid phase event.');
        workflow[item.kind](item.phase as Phase);
      } else throw new ValidationError('Unknown workflow event.');
    }
    return workflow;
  }

  history(): WorkflowEvent[] { return structuredClone(this.#events); }

  applyProgress(): ApplyProgress | undefined { return this.#apply ? structuredClone(this.#apply) : undefined; }

  /** Whether the Apply now due is the single correction pass a Verify rework asked for. */
  correcting(): boolean { return this.#correcting; }

  /** The results the held plan and verification still answer for; see `currentGeneration`. */
  generation(): PhaseResult[] {
    return structuredClone(currentGeneration(this.#results, this.#evaluation.phases, 'phase' in this.#next ? this.#next.phase : undefined));
  }

  /** Settled legacy histories remain legacy; only a newly authorized Apply gets a batch plan. */
  bindApplyPlan(value: unknown): void {
    if (this.#apply || (this.#next.kind !== 'execute' && this.#next.kind !== 'approve') ||
        this.#next.phase !== 'mdd-apply') throw new ValidationError('Only an unassigned ready Apply may bind its held plan.');
    const planned = applyPlan(value);
    this.#apply = { epoch: 1, planned, completed: [] };
    this.#events.push({ kind: 'apply-plan', planned: structuredClone(planned) });
  }

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
    } else if (this.#next.kind === 'await-risk-result' || this.#next.kind === 'blocked-risk') {
      this.#next = { kind: 'execute-risk' };
      this.#events.push({ kind: 'retry' });
    }
  }

  /**
   * Sends a route blocked by a failed phase back to an earlier phase of the same route, so the
   * work that failure points at can be corrected without discarding the run. Recorded results
   * stay: they are the history, and the failed one is what the reworked phase is asked to fix.
   * Returning to a planning phase also releases the held Apply plan: the phases that follow will
   * plan again, and the old deliverables no longer describe what will be implemented.
   */
  rework(phase: Phase): void {
    if (this.#next.kind !== 'blocked') throw new ValidationError('Only a route stopped by a failed phase can be reworked.');
    const target = this.#evaluation.phases.indexOf(phase);
    const current = this.#evaluation.phases.indexOf(this.#next.phase);
    if (target < 0 || target >= current) throw new ValidationError('Rework must name an earlier phase of this route.');
    const planning = target < this.#evaluation.phases.indexOf('mdd-apply');
    this.#index = target;
    if (this.#apply) this.#apply = { ...this.#apply, epoch: this.#apply.epoch + 1, completed: [], ...(planning ? { planned: [] } : {}) };
    this.#correcting = phase === 'mdd-apply';
    this.#next = { kind: 'execute', phase };
    this.#events.push({ kind: 'rework', phase });
  }

  recordResult(value: unknown): void {
    const { phase, outcome, evidenceSummary, applyPlan: plan, completed, batchID } = objectWithKeys(
      value, 'result', ['phase', 'outcome', 'evidenceSummary', 'applyPlan', 'completed', 'batchID'],
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
    let progress = this.#apply;
    const recorded: PhaseResult = { phase: current, outcome, evidenceSummary };
    if (plan !== undefined) {
      if (outcome !== 'passed' || !['mdd-plan', 'mdd-tasks'].includes(current)) throw new ValidationError('Only successful planning may assign Apply deliverables.');
      recorded.applyPlan = applyPlan(plan);
      progress = { epoch: (progress?.epoch ?? 0) + 1, planned: recorded.applyPlan, completed: [] };
    }
    if (current === 'mdd-apply' && progress) {
      if (typeof batchID !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(batchID) || this.#results.some(result => result.batchID === batchID)) {
        throw new ValidationError('Apply needs a distinct batch artifact identity.');
      }
      recorded.batchID = batchID;
      if (outcome === 'passed') {
        // The correction pass may close the whole plan at once; a history recorded before it
        // existed completed one step per result, and still replays that way.
        progress = this.#correcting && taskIDs(completed).length > 1 ? completeRemaining(progress, completed) : completeStep(progress, completed);
        recorded.completed = taskIDs(completed);
        this.#correcting = false;
      } else if (completed !== undefined && taskIDs(completed).length) throw new ValidationError('A failed Apply cannot earn completion.');
    } else if (completed !== undefined || batchID !== undefined) throw new ValidationError('Completion belongs only to a planned Apply batch.');
    this.#apply = progress;
    this.#results.push(recorded);
    this.#events.push({ kind: 'result', result: structuredClone(recorded) });
    if (outcome === 'failed') {
      this.#next = { kind: 'blocked', phase: current };
      return;
    }
    if (current === 'mdd-apply' && progress && selectedStep(progress)) {
      this.#next = { kind: 'execute', phase: current };
      return;
    }
    // Exploration is always the first and, until a route is selected, only phase this run holds.
    // A passed exploration moves to the risk stop, never straight to a tail phase: nothing here
    // decides the continuation.
    if (current === 'mdd-explore' && !this.#legacyRoute) {
      this.#next = { kind: 'execute-risk' };
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

  /** Begins dispatching mdd-risk. Only reachable once a passed exploration left the route undecided. */
  startRisk(): void {
    if (this.#next.kind !== 'execute-risk') throw new ValidationError('mdd-risk can only start from the execute-risk stop.');
    this.#next = { kind: 'await-risk-result' };
    this.#events.push({ kind: 'risk-start' });
  }

  /**
   * Settles the risk stop and, on a passed outcome, selects the continuation in the same step:
   * a route is never recorded apart from the verdict that authorized it, and a failed or invalid
   * assessment leaves the run blocked without ever appending a tail.
   */
  recordRiskResult(value: unknown): void {
    const input = objectWithKeys(value, 'risk result', ['outcome', 'evidenceSummary', 'route']);
    const { outcome, evidenceSummary, route } = input;
    if (outcome !== 'passed' && outcome !== 'failed') {
      throw new ValidationError('risk result.outcome must be passed or failed.');
    }
    if (typeof evidenceSummary !== 'string' || evidenceSummary.trim().length === 0) {
      throw new ValidationError('risk result.evidenceSummary must be a nonempty string.');
    }
    if (this.#next.kind !== 'await-risk-result') {
      throw new ValidationError('A risk result must name the currently running risk assessment.');
    }
    if (outcome === 'failed') {
      if (route !== undefined) throw new ValidationError('risk result.route is only accepted when outcome is passed.');
      this.#next = { kind: 'blocked-risk' };
      this.#events.push({ kind: 'risk-result', result: { outcome, evidenceSummary } });
      return;
    }
    if (route !== 'low' && route !== 'high') {
      throw new ValidationError('A passed risk result requires route low or high.');
    }
    this.#events.push({ kind: 'risk-result', result: { outcome, evidenceSummary, route } });
    // The verdict alone authorizes its own, suggested route: automatic mode proceeds with it
    // immediately (D2, S4); interactive mode still awaits the ordinary approval of the first
    // tail phase, exactly as before, which `overrideRoute` may redirect before it is given.
    this.#applyRoute(route, 'suggested', false);
  }

  /**
   * Applies a tail to the evaluation and records how its route was decided. Never discards or
   * rewrites the original risk verdict; that stays in the `risk-result` event already recorded.
   * `authorized` skips the ordinary interactive approval for the first tail phase: the suggested
   * route from a passed verdict still awaits it, but choosing it explicitly (override or a manual
   * recovery choice) is itself the one native decision that authorizes that phase.
   */
  #applyRoute(route: 'low' | 'high', origin: RouteOrigin, authorized: boolean): void {
    const tail = route === 'high' ? HIGH_TAIL : LOW_TAIL;
    this.#evaluation.phases = ['mdd-explore', ...tail];
    this.#evaluation.route = route;
    this.#routeOrigin = origin;
    this.#index = 1;
    this.#next = { kind: authorized || this.#answers.mode === 'automatic' ? 'execute' : 'approve', phase: tail[0] };
  }

  /**
   * The user forces the other route while the suggested route's first tail phase is still only
   * awaiting its ordinary approval. The original `risk-result` verdict stays exactly as recorded;
   * only which tail runs changes, with `override` provenance instead of `suggested`.
   */
  overrideRoute(): void {
    if (this.#next.kind !== 'approve' || this.#routeOrigin !== 'suggested' || this.#results.length !== 1) {
      throw new ValidationError('The route can only be overridden before its first tail phase is approved or started.');
    }
    const current = this.#evaluation.route;
    if (current !== 'low' && current !== 'high') throw new ValidationError('No route to override.');
    this.#applyRoute(current === 'low' ? 'high' : 'low', 'override', true);
    this.#events.push({ kind: 'route-override' });
  }

  /**
   * The user manually selects a route after a blocked (failed or exhausted) risk assessment. This
   * is never a `RiskVerdict`: no `risk-result` event is appended, only this manual choice, and the
   * choice itself authorizes the first tail phase in both modes, since there is no automatic
   * continuation without one.
   */
  chooseManualRoute(route: unknown): void {
    if (this.#next.kind !== 'blocked-risk') throw new ValidationError('A manual route can only be chosen while risk is blocked.');
    if (route !== 'low' && route !== 'high') throw new ValidationError('A manual route choice must be low or high.');
    const tail = route === 'high' ? HIGH_TAIL : LOW_TAIL;
    this.#evaluation.phases = ['mdd-explore', ...tail];
    this.#evaluation.route = route;
    this.#routeOrigin = 'manual';
    this.#index = 1;
    this.#next = { kind: 'execute', phase: tail[0] };
    this.#events.push({ kind: 'risk-recovery', route });
  }
}
