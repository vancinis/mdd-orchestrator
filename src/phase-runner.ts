import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EngramHttp } from './engram-http.js';
import { objectWithKeys, ValidationError } from './validation.js';
import { Workflow } from './workflow.js';
import { ArtifactStore, ArtifactWriteError } from './artifacts.js';
import type { ArtifactAttempt, ArtifactResult } from './artifacts.js';
import type { Phase } from './policy.js';
import { cleanupInstructions, docInstructions, GITHUB_HINT, LOOKUP_ONLY_PHASES } from './phase-policy.js';
import { corroborate, deliverables } from './phase-evidence.js';
import type { Deliverable, NativeEvidence, NativeResult } from './phase-evidence.js';
import { emptyEvidence, invalidateEvidence, renderReport, renderClosure, phaseLabel, evidenceCoverage } from './reporting.js';
import type { Evidence, EvidenceFlag, PhaseReport } from './reporting.js';
import type { TelemetryEvent, TelemetryResult } from './telemetry.js';
import { acceptance, assertNoTraceSection, decisions, validatePlan, verification, traceArtifact } from './acceptance.js';
import type { Acceptance, Decision, Verification } from './acceptance.js';
import { concerns } from './concerns.js';
import type { Concern } from './concerns.js';
import type { ProgressGuard } from './progress.js';
import type { PRFacts } from './pr-body.js';

export type Runtime = { sessionID: string; agent: string; directory: string; worktree: string };
export type TaskCall = { sessionID: string; callID: string };
export const PHASE_CONTEXT_MAX_BYTES = 96000;
type TaskArgs = { description: string; subagent_type: string; prompt: string };
type State = 'starting' | 'ready' | 'persisting-intent' | 'await-result' | 'persisting-result' | 'blocked' | 'await-approval' | 'complete';
type Run = {
  id: string; runtime: Runtime; workflow: Workflow; phase: Phase;
  requirements: string; memory: EngramHttp | undefined; args: TaskArgs; state: State;
  callID?: string; lastCallID?: string; dispatchedArgs?: TaskArgs; reason?: string; attempts: number;
  artifacts: ArtifactStore; artifact?: ArtifactResult; artifactAttempts?: readonly ArtifactAttempt[];
  history: ArtifactResult[]; calls: Set<string>; planned: Deliverable[]; evidence: Evidence;
  report: PhaseReport; started?: number; telemetryDiagnostic?: string;
  acceptance?: Acceptance; decisions: Decision[]; verification?: Verification; executedChecks: string[]; changedFiles: number;
  uncertain: boolean; userMessageID: string; concerns: Concern[]; contextReport?: string;
  contexts: { explorationID: string; outcome: 'passed' | 'failed'; artifact: ArtifactResult; summary: string; concerns: Concern[] }[];
  side?: { id: string; purpose: string; phase: Phase; state: State; args: TaskArgs; report: PhaseReport };
};
/** A read-only investigation that exists without an accepted run: no workflow, artifacts, memory or progress marker. */
type Solo = {
  id: string; purpose: string; runtime: Runtime; args: TaskArgs;
  state: 'ready' | 'persisting-intent' | 'await-result' | 'persisting-result' | 'blocked' | 'settled';
  callID?: string; dispatchedArgs?: TaskArgs; calls: Set<string>; started?: number; reason?: string; report?: string;
  findings: { explorationID: string; outcome: 'passed' | 'failed'; summary: string; findings: string; concerns: Concern[] }[];
};
const SOLO_FINDINGS_KEPT = 4;
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f]/;
/** Phases whose artifact is prose a person reads. Tasks and Apply carry structure, not narrative. */
const DOC_PHASES: readonly Phase[] = ['mdd-explore', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-verify'];
export type Inspect = {
  parent(runtime: Runtime, callID?: string, tool?: 'task' | 'question', args?: unknown): Promise<void>;
  result(runtime: Runtime, call: TaskCall, phase: string, output: unknown): Promise<string | NativeResult>;
};

/** Actors occasionally wrap the envelope in a code fence; unwrapping it changes no field. */
export function jsonEnvelope(text: string): string {
  const fenced = /^```[A-Za-z]*\r?\n([\s\S]*?)\r?\n?```$/.exec(text.trim());
  return fenced ? fenced[1]! : text;
}

export function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) {
    throw new ValidationError(`${label} must be nonempty text of at most ${max} bytes.`);
  }
  return value;
}

export class PhaseRunner {
  readonly #runs = new Map<string, Run>();
  readonly #previous = new Map<string, Run[]>();
  readonly #solo = new Map<string, Solo>();
  constructor(readonly inspect: Inspect, readonly options: { now?: () => number; progress?: ProgressGuard; telemetry?: (root: string, value: TelemetryEvent, now: number) => TelemetryResult } = {}) {}

  status(sessionID: string) {
    const run = this.#runs.get(sessionID);
    if (!run) {
      const solo = this.#solo.get(sessionID);
      // Only a live investigation occupies the dispatch. A blocked one is finished: reporting
      // it as in-flight would make intake and change requests wait for work that cannot resume.
      if (solo && !['settled', 'blocked'].includes(solo.state)) return this.#soloStatus(sessionID, solo);
      const investigation = solo ? { contextual: false, contextualReport: solo.report, contexts: structuredClone(solo.findings),
        ...(solo.state === 'blocked' && solo.reason ? { contextualReason: solo.reason } : {}) } : {};
      try {
        // Only an attempt that never reported an outcome needs care. Work that ended, whether it
        // passed or failed, leaves the conversation free to start something new.
        const marker = this.options.progress?.read(sessionID);
        if (marker && marker.state === 'pending') return { state: 'recovery-blocked', sessionID, ...investigation, recoverable: true, reason: 'A previous attempt in this conversation never reported an outcome, so it is not resumed automatically. Its evidence was preserved. Use mdd_reset to release it and start new work here, or open a new conversation. Read-only investigation remains available.' };
      } catch (error) { return { state: 'recovery-blocked', sessionID, ...investigation, recoverable: true, reason: `${error instanceof Error ? error.message : 'Progress is unavailable.'} Use mdd_reset to clear the local marker.` }; }
      return { state: 'not-started', sessionID, ...investigation };
    }
    return {
      runID: run.id, sessionID, phase: run.phase, state: run.state,
      reason: run.reason ?? (run.state === 'await-result'
        ? 'The dispatched task has not reported yet. Wait for it rather than redispatching; if it fails, this phase returns to ready on its own.'
        : run.state === 'complete' ? 'Final Verify checks corroborated. Evidence coverage is not correctness probability.' : ''),
      workflow: run.workflow.snapshot(),
      next: run.workflow.nextAction(),
      evidence: { ...run.evidence }, coverage: evidenceCoverage(run.evidence),
      report: run.side ? `Summary\nContextual exploration ${run.state === 'blocked' ? 'could not be confirmed' : run.state === 'ready' ? 'is ready' : 'is in progress'}. The main plan and approval are unchanged.\n` : run.state === 'complete' || run.state === 'blocked' ? this.#closure(run) : renderReport(run.workflow.snapshot().answers.summary, { ...run.report, evidence: run.evidence }),
      acceptance: structuredClone(run.acceptance), decisions: structuredClone(run.decisions), planned: structuredClone(run.planned), verification: structuredClone(run.verification),
      uncertain: run.uncertain, attempts: run.attempts, recoverable: true,
      contextual: !!run.side, contexts: structuredClone(run.contexts), concerns: structuredClone(run.concerns),
      contextualReport: run.contextReport,
      previousRuns: (this.#previous.get(sessionID) ?? []).map(old => ({ runID: old.id, state: 'superseded', lastState: old.state, workflow: old.workflow.snapshot(), artifacts: structuredClone(old.history), contexts: structuredClone(old.contexts), evidence: { ...old.evidence }, acceptance: structuredClone(old.acceptance), decisions: structuredClone(old.decisions), planned: structuredClone(old.planned), verification: structuredClone(old.verification) })),
      artifacts: structuredClone(run.history), telemetryDiagnostic: run.telemetryDiagnostic,
      ...(run.artifact ? { artifact: structuredClone(run.artifact) } : {}),
      ...(run.artifactAttempts ? { artifactAttempts: structuredClone(run.artifactAttempts) } : {}),
      ...(run.state === 'ready' ? { task: structuredClone(run.args) } : {}),
    };
  }

  async start(value: unknown, runtime: Runtime, trusted?: { requirementsConfirmed: true; replace?: true; userMessageID?: string }): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator') throw new ValidationError('Only mdd-orchestrator may start MDD.');
    const previous = this.#runs.get(runtime.sessionID);
    if (previous && !trusted?.replace) throw new ValidationError('This parent already has an MDD run; use mdd_status.');
    if (previous) this.assertChangeable(runtime.sessionID);
    else this.assertFreshStart(runtime.sessionID, trusted?.userMessageID);
    if (this.options.progress && !trusted?.userMessageID) throw new Error('A native user message identity is required for startup protection.');
    const request = objectWithKeys(value, 'start', ['preflight', 'requirements', 'engramEndpoint', 'project']);
    const workflow = new Workflow(request.preflight);
    const first = workflow.nextAction();
    if (first.kind !== 'execute') throw new ValidationError('No initial phase is ready.');
    const requirements = boundedText(request.requirements, 'requirements', 12000);
    let memory: EngramHttp | undefined;
    if (request.engramEndpoint !== undefined || request.project !== undefined) {
      const project = boundedText(request.project, 'project', 128);
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(project)) throw new ValidationError('Use an explicit canonical Engram project key.');
      memory = new EngramHttp(boundedText(request.engramEndpoint, 'engramEndpoint', 100), { id: runtime.sessionID, project, directory: runtime.directory });
    }
    const id = randomUUID();
    const run: Run = {
      id, runtime: { ...runtime }, workflow, phase: first.phase, requirements,
      memory, artifacts: new ArtifactStore(runtime.directory, workflow.snapshot().answers.artifactStore, memory),
      args: { description: '', subagent_type: first.phase, prompt: '' }, state: 'starting',
      history: [], calls: new Set(previous?.calls), planned: [], evidence: { ...emptyEvidence(), requirements: trusted?.requirementsConfirmed ? 'confirmed' : 'unearned' },
      uncertain: false, userMessageID: trusted?.userMessageID ?? '', concerns: [], contexts: [],
      decisions: [], executedChecks: [], changedFiles: 0, attempts: 0,
      report: { phase: first.phase, summary: `Preparing ${phaseLabel(first.phase).toLowerCase()}.`, how: [], status: 'in-progress', evidence: emptyEvidence() },
    };
    this.#runs.set(runtime.sessionID, run);
    try {
      await this.inspect.parent(run.runtime);
      await run.memory?.checkBinding();
      if (run.state !== 'starting') throw new Error('Run was blocked during initialization.');
      this.#prepare(run);
      if (previous) this.#previous.set(runtime.sessionID, [...(this.#previous.get(runtime.sessionID) ?? []), previous]);
      if (trusted?.requirementsConfirmed) this.#event(run, 'preflight', 'passed');
      return this.status(runtime.sessionID);
    } catch (error) {
      if (previous) { this.#runs.set(runtime.sessionID, previous); throw error; }
      return this.#stop(run, error);
    }
  }

  /**
   * A run that cannot start, or whose route can no longer advance, stops without claiming
   * progress. Stopping is never sealed: uncertainty is cleared and mdd_reset stays reachable.
   */
  #stop(run: Run, error: unknown): never {
    if (error instanceof ArtifactWriteError) run.artifactAttempts = error.attempts;
    const detail = error instanceof Error ? error.message : 'Unknown infrastructure outcome.';
    this.block(run.runtime.sessionID, detail);
    throw new Error(`MDD stopped this run: ${detail} Nothing is locked: read mdd_status, then use mdd_reset to retry the phase or start over.`);
  }

  /**
   * A failed dispatch, result or persistence ends one attempt, not the run. The phase returns to
   * ready so the same work can be delegated again or carried out directly, and uncertainty is
   * cleared so change requests, investigation and reset all stay reachable.
   */
  #degrade(run: Run, error: unknown): never {
    if (error instanceof ArtifactWriteError) run.artifactAttempts = error.attempts;
    run.reason = error instanceof Error ? error.message : 'Unknown attempt outcome.';
    run.attempts += 1;
    run.uncertain = false;
    delete run.callID;
    delete run.dispatchedArgs;
    const phase = run.phase;
    if (run.started !== undefined) this.#event(run, 'phase-end', 'blocked');
    const recovered = this.#recover(run);
    this.#settle(run);
    throw new Error(`MDD attempt ${run.attempts} for ${phase} did not complete: ${run.reason} ${recovered
      ? 'The phase is ready again: read mdd_status and run its task once more, or carry out the phase yourself. Nothing is locked.'
      : 'Read mdd_status, then use mdd_reset to retry this phase or start over. Nothing is locked.'}`);
  }

  /** Puts the route back on a runnable step. Contextual work restores the main plan it paused. */
  #recover(run: Run): boolean {
    const side = run.side;
    try {
      if (side) {
        run.phase = side.phase; run.args = side.args; run.report = side.report; run.state = side.state;
        delete run.side;
        if (run.state === 'ready') this.#prepare(run);
        return true;
      }
      run.workflow.retry();
      this.#prepare(run);
      return true;
    } catch {
      // The route itself cannot continue, so the current phase claims nothing.
      run.state = 'blocked';
      run.evidence = invalidateEvidence(run.evidence, this.#affected(run.phase));
      run.report = { phase: run.phase, summary: 'The attempt stopped and this route needs attention.', how: [], status: 'blocked', evidence: run.evidence };
      return false;
    }
  }

  /** A stopped attempt is recorded as settled, never left pending, so a restart is not locked. */
  #settle(run: Run): void {
    try { this.#mark(run, run.state === 'complete' ? 'complete' : 'settled'); }
    catch { /* A progress write failure must not re-lock work that already stopped. */ }
  }

  async before(call: TaskCall, args: unknown): Promise<TaskArgs | undefined> {
    const run = this.#runs.get(call.sessionID);
    if (!run) return this.#soloBefore(call, args);
    if (run.state !== 'ready') {
      // A task that arrives while one is already running is a duplicate, not a failure: refusing
      // it changes nothing, so the running attempt keeps its slot and can still report a result.
      if (run.state === 'await-result') {
        throw new ValidationError('This phase already has a task in flight. Read mdd_status and wait for its result; nothing was started and nothing is locked.');
      }
      return this.#degrade(run, new Error('A task arrived while the run was not ready to dispatch one.'));
    }
    if (!isDeepStrictEqual(args, run.args)) {
      throw new ValidationError('Task arguments differ from the ready task. Read mdd_status and pass its exact task object, copying description, subagent_type and prompt verbatim; do not compose your own. No execution was started.');
    }
    boundedText(call.callID, 'native callID', 256);
    if (run.calls.has(call.callID)) throw new ValidationError('Native task call ID was already consumed.');
    run.state = 'persisting-intent';
    if (!run.side) delete run.contextReport;
    try {
      run.callID = boundedText(call.callID, 'native callID', 256);
      run.lastCallID = run.callID;
      if (run.calls.has(call.callID)) throw new Error('Native task call ID was already consumed.');
      run.calls.add(call.callID);
      run.dispatchedArgs = { ...run.args, prompt: `${run.args.prompt}\nNative callID=${JSON.stringify(call.callID)}` };
      if (!run.side) run.workflow.start(run.phase);
      await this.inspect.parent(run.runtime, call.callID);
      if (run.state !== 'persisting-intent') throw new Error('Dispatch became uncertain during inspection.');
      run.uncertain = true;
      this.#mark(run, 'pending');
      await run.memory?.save(`MDD intent ${run.id}`, JSON.stringify({
        kind: 'intent', runID: run.id, callID: call.callID, phase: run.phase,
        requirements: run.requirements, workflow: run.workflow.snapshot(),
        ...(run.side ? { explorationID: run.side.id, purpose: run.side.purpose } : {}),
      }));
      if (run.state !== 'persisting-intent') throw new Error('Dispatch became uncertain during persistence.');
      run.state = 'await-result';
      run.report = { phase: run.phase, summary: `${phaseLabel(run.phase)} is in progress.`, how: ['Using the agreed requirements and available plan evidence.'], status: 'in-progress', evidence: run.evidence };
      run.started = this.#now();
      this.#event(run, 'phase-start');
      return { ...run.dispatchedArgs };
    } catch (error) { return this.#degrade(run, error); }
  }

  async after(call: TaskCall, args: unknown, output: unknown): Promise<void> {
    const run = this.#runs.get(call.sessionID);
    if (!run) return this.#soloAfter(call, args, output);
    if (run.state !== 'await-result' || run.callID !== call.callID || !isDeepStrictEqual(args, run.dispatchedArgs)) {
      return this.#degrade(run, new Error('This result does not match the task this phase dispatched, so it was discarded.'));
    }
    run.state = 'persisting-result';
    try {
      const inspected = await this.inspect.result(run.runtime, call, run.phase, output);
      const text = typeof inspected === 'string' ? inspected : inspected.text;
      const native = typeof inspected === 'string' ? undefined : inspected.evidence;
      boundedText(text, 'result JSON', 20000);
      const extra = run.phase === 'mdd-plan' ? ['acceptance', 'decisions', 'deliverables'] : run.phase === 'mdd-tasks' ? ['deliverables'] : run.phase === 'mdd-spec' ? ['domain', 'acceptance'] : run.phase === 'mdd-design' ? ['decisions'] : run.phase === 'mdd-apply' ? ['changes', 'noChangeReason'] : run.phase === 'mdd-verify' ? ['checks', 'verification'] : [];
      const result = objectWithKeys(JSON.parse(jsonEnvelope(text)), 'phase result', ['phase', 'runID', 'callID', 'outcome', 'evidenceSummary', 'artifact', 'concerns', ...extra]);
      if (result.phase !== run.phase || result.runID !== run.id || result.callID !== call.callID ||
          (result.outcome !== 'passed' && result.outcome !== 'failed')) throw new Error('Invalid result binding or outcome.');
      const evidenceSummary = boundedText(result.evidenceSummary, 'evidenceSummary', 2000);
      let artifact = assertNoTraceSection(boundedText(result.artifact, 'artifact', 16000));
      const advisory = concerns(result.concerns);
      if (run.side) { await this.#sideResult(run, result.outcome, artifact, evidenceSummary, advisory, native); return; }
      if (run.phase === 'mdd-spec' && result.domain !== 'project') throw new Error('Specification domain must match the dispatched project storage namespace.');
      let planned = run.planned;
      let accepted = run.acceptance;
      let choices = run.decisions;
      let nextEvidence = { ...run.evidence };
      if (run.phase === 'mdd-verify') {
        if (!accepted) throw new Error('Verification has no held requirement map.');
        run.executedChecks = native?.checks.filter(check => check.exit === 0).map(check => check.command) ?? [];
        run.verification = verification(result.verification, accepted, choices, planned, native);
        if (result.outcome === 'passed' && !run.verification.matched) throw new Error('Requirements or plan remain not verified or deviate from the held plan. Inspect acceptance assessments before continuing.');
      }
      if (result.outcome === 'passed') {
        if (run.phase === 'mdd-plan' || run.phase === 'mdd-spec') accepted = acceptance(result.acceptance);
        if (run.phase === 'mdd-plan' || run.phase === 'mdd-design') {
          if (!accepted) throw new Error('Design has no held requirement map.');
          choices = decisions(result.decisions, accepted);
        }
        if (run.phase === 'mdd-plan' || run.phase === 'mdd-tasks') {
          if (!accepted) throw new Error('Planning has no held requirement map.');
          planned = deliverables(run.runtime.directory, result.deliverables);
          validatePlan(accepted, choices, planned);
          if (native?.readCalls.length) nextEvidence.plan = 'confirmed';
        }
        const earned = corroborate(run.phase, result, native, planned);
        if (earned.implementation) nextEvidence.implementation = 'confirmed';
        if (earned.checks) nextEvidence.checks = 'confirmed';
      } else nextEvidence = invalidateEvidence(nextEvidence, this.#affected(run.phase));
      artifact = boundedText(traceArtifact(run.phase, artifact, accepted, choices, planned, run.verification), 'artifact with acceptance links', 16000);
      renderReport(run.workflow.snapshot().answers.summary, { phase: run.phase, summary: evidenceSummary, how: [], status: result.outcome, evidence: nextEvidence });
      if (run.state !== 'persisting-result') throw new Error('Result became uncertain during inspection.');
      run.artifact = await run.artifacts.save({ runID: run.id, phase: run.phase, ...(run.phase === 'mdd-spec' ? { domain: boundedText(result.domain, 'spec domain', 64) } : {}) }, artifact);
      if (run.state !== 'persisting-result') throw new Error('Result became uncertain during artifact persistence.');
      if (await run.artifacts.read(run.artifact.ref) !== artifact) throw new Error('Artifact readback differs from phase output.');
      if (run.state !== 'persisting-result') throw new Error('Result became uncertain during artifact readback.');
      await run.memory?.save(`MDD result ${run.id}`, JSON.stringify({
        kind: 'agent-evidence', phase: run.phase, runID: run.id, callID: call.callID,
        outcome: result.outcome, evidenceSummary, artifactRef: run.artifact.ref,
        artifactStore: run.workflow.snapshot().answers.artifactStore,
        ...(run.verification ? { acceptanceMatched: run.verification.matched } : {}),
        evidence: nextEvidence, ...(native ? { native: { childID: native.childID, readCalls: native.readCalls, changes: native.changes, checks: native.checks.map(({ callID, command, exit }) => ({ callID, command, exit })) } } : {}),
        storage: 'general-workflow-context-only', independentVerification: false,
      }));
      if (run.state !== 'persisting-result') throw new Error('Result became uncertain during persistence.');
      run.uncertain = false;
      run.workflow.recordResult({ phase: run.phase, outcome: result.outcome, evidenceSummary });
      run.history.push(run.artifact);
      run.planned = planned;
      if (accepted) run.acceptance = accepted;
      run.decisions = choices;
      run.concerns.push(...advisory);
      if (run.phase === 'mdd-apply') run.changedFiles = new Set(native?.changes.flatMap(change => change.paths) ?? []).size;
      run.evidence = nextEvidence;
      run.report = { phase: run.phase, summary: evidenceSummary, how: ['Kept the requirements, decisions and implementation evidence linked.', ...(native?.changes.map(change => `${change.paths.length} scoped file(s) changed.`) ?? []), ...(native?.checks.map(check => `Executed ${check.command}; exit ${check.exit}.`) ?? [])], status: result.outcome, evidence: run.evidence };
      this.#event(run, 'phase-end', result.outcome);
      if (result.outcome === 'failed') { run.state = 'blocked'; run.reason = 'The phase reported failure. Nothing is repaired automatically: inspect the evidence, then use mdd_reset to run this phase again or request a change.'; }
      else {
        const next = run.workflow.nextAction();
        if (next.kind === 'finished') run.state = 'complete';
        else if (next.kind === 'approve') run.state = 'await-approval';
        else this.#prepare(run);
      }
      this.#event(run, 'report', run.state === 'complete' ? 'passed' : run.state === 'blocked' ? 'blocked' : undefined);
      this.#mark(run, run.state === 'complete' ? 'complete' : 'settled');
    } catch (error) { return this.#degrade(run, error); }
  }

  nativeError(sessionID: string, callID: string): void {
    const run = this.#runs.get(sessionID);
    const pending = run ?? this.#solo.get(sessionID);
    if (pending?.callID !== callID || !['await-result', 'persisting-result'].includes(pending.state)) return;
    this.attemptRejected(sessionID, 'The dispatched task failed or was interrupted before reporting a result.');
  }

  /**
   * Evidence rejected in a child, or a task that failed natively, ends that attempt. The phase
   * becomes runnable again so the same work can be delegated once more or carried out directly.
   */
  attemptRejected(sessionID: string, reason: string): void {
    const run = this.#runs.get(sessionID);
    if (!run) { this.block(sessionID, reason); return; }
    try { this.#degrade(run, new Error(reason)); }
    catch { /* The caller reports its own failure to the actor; the run is already released. */ }
  }

  approveNative(sessionID: string, phase: Phase): void {
    const run = this.#runs.get(sessionID);
    if (!run || run.state !== 'await-approval') throw new Error('No recorded phase is awaiting native approval.');
    run.workflow.approve(phase);
    try { this.#prepare(run); this.#event(run, 'approval', 'passed'); }
    catch (error) { this.#stop(run, error); }
  }

  block(sessionID: string, reason: string): void {
    const run = this.#runs.get(sessionID);
    if (!run) {
      const solo = this.#solo.get(sessionID);
      if (solo && solo.state !== 'settled' && solo.state !== 'blocked') { solo.state = 'blocked'; solo.reason = reason; this.#soloEvent(solo, 'phase-end', 'blocked'); }
      return;
    }
    if (!run.side) run.evidence = invalidateEvidence(run.evidence, this.#affected(run.phase));
    run.report = { phase: run.phase, summary: 'Execution stopped; affected evidence was withdrawn.', how: [], status: 'blocked', evidence: run.evidence };
    if (run.state !== 'blocked') this.#event(run, 'phase-end', 'blocked');
    run.state = 'blocked';
    run.reason = reason;
    // Stopped work is not in flight. Releasing the dispatch slot and the uncertainty flag is what
    // keeps change requests, read-only investigation and reset reachable after a failure.
    run.uncertain = false;
    delete run.callID;
    delete run.dispatchedArgs;
    this.#settle(run);
  }

  /**
   * Explicit recovery. Phase scope releases the current attempt and makes the same phase runnable
   * again; run scope discards the run, its investigation and the local marker so new work can start.
   */
  reset(sessionID: string, scope: 'phase' | 'run'): { scope: 'phase' | 'run'; phase?: Phase } {
    const run = this.#runs.get(sessionID);
    if (scope === 'run' || !run) {
      this.#runs.delete(sessionID);
      this.#solo.delete(sessionID);
      this.options.progress?.clear(sessionID);
      return { scope: 'run' };
    }
    delete run.side;
    delete run.callID;
    delete run.dispatchedArgs;
    delete run.reason;
    delete run.contextReport;
    run.uncertain = false;
    run.attempts = 0;
    run.workflow.retry();
    this.#prepare(run);
    this.#settle(run);
    return { scope: 'phase', phase: run.phase };
  }

  pending(sessionID: string, phase: Phase): { runtime: Runtime; call: TaskCall; checks: string[] } {
    const run = this.#runs.get(sessionID);
    if (!run) {
      const solo = this.#solo.get(sessionID);
      if (!solo || phase !== 'mdd-explore' || !solo.callID) throw new Error('Child has no matching active phase dispatch.');
      if (solo.state !== 'await-result') throw new Error(`This read-only investigation stopped accepting tool calls: ${solo.reason ?? solo.state}`);
      return { runtime: { ...solo.runtime }, call: { sessionID, callID: solo.callID }, checks: [] };
    }
    if (run.phase !== phase || !run.callID) throw new Error('Child has no matching active phase dispatch.');
    if (run.state !== 'await-result') throw new Error(`This phase stopped accepting tool calls: ${run.reason ?? run.state}`);
    return { runtime: { ...run.runtime }, call: { sessionID, callID: run.callID }, checks: run.planned.map(item => item.check) };
  }

  approvalStopped(sessionID: string): void { const run = this.#runs.get(sessionID); if (run) this.#event(run, 'approval', 'cancelled'); }

  prFacts(sessionID: string): PRFacts {
    const run = this.#runs.get(sessionID);
    if (!run) throw new Error('No recorded MDD run is available for this parent. A draft cannot claim implementation evidence.');
    return { runID: run.id, goal: run.acceptance?.goal ?? 'Unverified: a requested outcome has not been recorded.',
      changes: run.verification?.changes ?? 'Implementation details remain unverified; inspect the recorded artifact.',
      changedFiles: run.changedFiles, checks: [...run.executedChecks],
      verified: run.state === 'complete' && run.verification?.matched === true && run.evidence.checks === 'confirmed',
      uncertain: run.uncertain, limits: [...(run.verification?.limits ?? [])] };
  }

  /**
   * Only work that is genuinely running blocks a change. A stopped or failed run is changeable:
   * treating its uncertainty flag as in-flight work is what used to make failures irreparable.
   */
  assertChangeable(sessionID: string): void {
    const run = this.#runs.get(sessionID);
    if (!run) return;
    if (!['ready', 'await-approval', 'complete', 'blocked'].includes(run.state)) {
      throw new Error('A native task is in flight for this run. Wait for its result, or use mdd_reset to release it; no evidence is lost.');
    }
  }

  assertFreshStart(sessionID: string, userMessageID?: string): void {
    if (this.#runs.has(sessionID)) return;
    const marker = this.options.progress?.read(sessionID);
    if (!marker) return;
    if (marker.state === 'pending') throw new Error('A previous attempt in this conversation never reported an outcome. Inspect mdd_status, then use mdd_reset to release it before starting new work.');
    if (marker.userMessageID === userMessageID) throw new Error('This exact request already ran in this conversation. Send a new request, or use mdd_reset to start it over deliberately.');
  }

  /** Read-only investigation is always reachable: it binds to an idle run when one exists, otherwise it stands alone. */
  async explore(value: unknown, runtime: Runtime): Promise<void> {
    const input = objectWithKeys(value, 'contextual exploration', ['purpose']);
    const purpose = boundedText(input.purpose, 'exploration purpose', 2000);
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only mdd-orchestrator may request read-only investigation.');
    const run = this.#runs.get(runtime.sessionID);
    if (!run) return this.#soloStart(runtime, purpose);
    if (run.side) throw new Error('A read-only investigation is already in progress for this run; wait for its result.');
    // Investigation only waits for a task that is actually running; a stopped or failed run must
    // still be able to answer questions about the project.
    if (runtime.directory !== run.runtime.directory || runtime.worktree !== run.runtime.worktree || !['ready', 'await-approval', 'complete', 'blocked'].includes(run.state)) throw new Error('A native task is in flight. Wait for its result before requesting investigation; nothing is locked.');
    const side = { id: randomUUID(), purpose, phase: run.phase, state: run.state, args: run.args, report: run.report };
    run.side = side;
    try {
      run.args = this.#taskArgs(run, 'mdd-explore');
      run.phase = 'mdd-explore'; run.state = 'ready';
      delete run.contextReport;
    } catch (error) { delete run.side; throw error; }
  }

  async #sideResult(run: Run, outcome: 'passed' | 'failed', content: string, summary: string, advisory: Concern[], native: NativeEvidence | undefined): Promise<void> {
    const side = run.side!;
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(summary)) throw new Error('Contextual summary contains terminal control characters.');
    if (run.state !== 'persisting-result') throw new Error('Contextual result became uncertain.');
    const artifact = await run.artifacts.save({ runID: run.id, phase: 'mdd-explore', explorationID: side.id }, content);
    if (await run.artifacts.read(artifact.ref) !== content || run.state !== 'persisting-result') throw new Error('Contextual artifact could not be confirmed.');
    await run.memory?.save(`MDD context ${run.id}`, JSON.stringify({ kind: 'context-result', runID: run.id, phase: 'mdd-explore', explorationID: side.id, callID: run.callID, outcome, evidenceSummary: summary, artifactRef: artifact.ref, concerns: advisory, independentVerification: false, ...(native ? { native: { childID: native.childID, readCalls: native.readCalls } } : {}) }));
    if (run.state !== 'persisting-result') throw new Error('Contextual result persistence became uncertain.');
    run.contexts.push({ explorationID: side.id, outcome, artifact, summary, concerns: advisory });
    run.contextReport = `Summary\nContextual exploration ${outcome === 'passed' ? 'completed' : 'did not complete'}. ${summary} Main workflow and approvals unchanged.\n`;
    run.concerns.push(...advisory);
    this.#event(run, 'phase-end', outcome);
    run.uncertain = false;
    run.phase = side.phase; run.state = side.state; run.args = side.args; run.report = side.report;
    delete run.side;
    if (run.state === 'ready') this.#prepare(run);
    this.#mark(run, run.state === 'complete' ? 'complete' : 'settled');
  }

  #soloStart(runtime: Runtime, purpose: string): void {
    const previous = this.#solo.get(runtime.sessionID);
    if (previous && !['settled', 'blocked'].includes(previous.state)) throw new Error('A read-only investigation is already in progress; wait for its result.');
    const solo: Solo = { id: randomUUID(), purpose, runtime: { ...runtime }, args: { description: '', subagent_type: 'mdd-explore', prompt: '' },
      state: 'ready', calls: new Set(previous?.calls), findings: previous?.findings ?? [] };
    solo.args = this.#soloArgs(solo);
    this.#solo.set(runtime.sessionID, solo);
  }

  async #soloBefore(call: TaskCall, args: unknown): Promise<TaskArgs | undefined> {
    const solo = this.#solo.get(call.sessionID);
    if (!solo || solo.state === 'settled' || solo.state === 'blocked') {
      if (args && typeof args === 'object' && 'subagent_type' in args &&
          typeof args.subagent_type === 'string' && args.subagent_type.startsWith('mdd-')) {
        throw new ValidationError('MDD tasks require a registered parent run or an issued read-only investigation.');
      }
      return undefined;
    }
    if (solo.state !== 'ready') return this.#soloFail(solo, new Error('Unexpected, duplicate, concurrent, or unsupported native task.'));
    if (!isDeepStrictEqual(args, solo.args)) {
      throw new ValidationError('Task arguments differ from the ready investigation. Read mdd_status and pass its exact task object, copying description, subagent_type and prompt verbatim; do not compose your own. No execution was started.');
    }
    boundedText(call.callID, 'native callID', 256);
    if (solo.calls.has(call.callID)) throw new ValidationError('Native task call ID was already consumed.');
    solo.state = 'persisting-intent';
    try {
      solo.callID = call.callID;
      solo.calls.add(call.callID);
      solo.dispatchedArgs = { ...solo.args, prompt: `${solo.args.prompt}\nNative callID=${JSON.stringify(call.callID)}` };
      await this.inspect.parent(solo.runtime, call.callID);
      if (solo.state !== 'persisting-intent') throw new Error('Dispatch became uncertain during inspection.');
      solo.state = 'await-result';
      solo.started = this.#now();
      this.#soloEvent(solo, 'phase-start');
      return { ...solo.dispatchedArgs };
    } catch (error) { return this.#soloFail(solo, error); }
  }

  async #soloAfter(call: TaskCall, args: unknown, output: unknown): Promise<void> {
    const solo = this.#solo.get(call.sessionID);
    if (!solo || ['settled', 'blocked'].includes(solo.state)) return;
    if (solo.state !== 'await-result' || solo.callID !== call.callID || !isDeepStrictEqual(args, solo.dispatchedArgs)) {
      return this.#soloFail(solo, new Error('Native result does not match the pending parent and call.'));
    }
    solo.state = 'persisting-result';
    try {
      const inspected = await this.inspect.result(solo.runtime, call, 'mdd-explore', output);
      const text = typeof inspected === 'string' ? inspected : inspected.text;
      boundedText(text, 'result JSON', 20000);
      const result = objectWithKeys(JSON.parse(jsonEnvelope(text)), 'investigation result', ['phase', 'runID', 'callID', 'outcome', 'evidenceSummary', 'artifact', 'concerns']);
      if (result.phase !== 'mdd-explore' || result.runID !== solo.id || result.callID !== call.callID ||
          (result.outcome !== 'passed' && result.outcome !== 'failed')) throw new Error('Invalid investigation binding or outcome.');
      const outcome: 'passed' | 'failed' = result.outcome;
      const summary = boundedText(result.evidenceSummary, 'evidenceSummary', 2000);
      const findings = assertNoTraceSection(boundedText(result.artifact, 'artifact', 16000));
      if (CONTROL_CHARACTERS.test(summary) || CONTROL_CHARACTERS.test(findings)) throw new Error('Investigation text contains terminal control characters.');
      const advisory = concerns(result.concerns);
      if (solo.state !== 'persisting-result') throw new Error('Investigation result became uncertain.');
      solo.findings = [...solo.findings, { explorationID: solo.id, outcome, summary, findings, concerns: advisory }].slice(-SOLO_FINDINGS_KEPT);
      solo.report = `Summary\nRead-only investigation ${outcome === 'passed' ? 'completed' : 'did not complete'}. ${summary} No MDD run was started and nothing was changed.\n\nFindings\n${findings}\n`;
      solo.state = 'settled';
      delete solo.reason;
      this.#soloEvent(solo, 'phase-end', outcome);
    } catch (error) { return this.#soloFail(solo, error); }
  }

  #soloStatus(sessionID: string, solo: Solo) {
    return {
      state: solo.state === 'ready' ? 'ready' : solo.state === 'blocked' ? 'blocked' : 'await-result',
      sessionID, contextual: true, explorationID: solo.id,
      reason: solo.reason ?? (solo.state === 'ready'
        ? 'A read-only investigation is ready. Dispatch its exact task once; no run, preflight or approval is involved.'
        : 'Native investigation outcome pending or uncertain. Never redispatch; consult this status after an error.'),
      contextualReport: solo.report, contexts: structuredClone(solo.findings),
      ...(solo.state === 'ready' ? { task: structuredClone(solo.args) } : {}),
    };
  }

  #soloArgs(solo: Solo): TaskArgs {
    const prompt = [
      'Perform only mdd-explore. Inspect relevant files; identify uncertainty, scope, integrations and risks without changing declared inputs.',
      `Standalone read-only investigation only: ${JSON.stringify(solo.purpose)}. explorationID=${solo.id}.`,
      'No MDD run is accepted: do not plan, implement, propose phases, or imply any approval. Answer the stated purpose from actual project sources in this workspace.',
      'Optional concerns: [{category,evidence,impact}], at most eight, with category objective/integrations/sensitive-data/permissions. These are advisory only; never change scores or request governance for ordinary implementation choices.',
      'Keep user-facing summaries simple; evidenceSummary must avoid internal call IDs or routing details. The artifact carries the readable findings shown to the user.',
      `This actor is read-only. Beyond read, glob and grep, commands are limited to read-only GitHub lookups: ${GITHUB_HINT}. Use them when the question is about an issue, pull request or repository. No delegation, external write or configuration change is authorized.`,
      'Native skill tools are disabled; use injected project instructions only.',
      'Return exactly one JSON object, no fences: phase, runID, callID, outcome (passed or failed), evidenceSummary (1–2000 bytes), artifact (1–16000 bytes). Never emit confidence percentages.',
      `phase=mdd-explore; runID=${solo.id}. Native callID is appended by the hook.`,
      `Investigation purpose data: ${JSON.stringify(solo.purpose)}`,
      `Trusted local mdd-doc instructions with provenance: ${JSON.stringify(docInstructions(solo.runtime.directory))}`,
    ].join('\n').replaceAll('@', '\\u0040');
    boundedText(prompt, 'combined phase handoff', PHASE_CONTEXT_MAX_BYTES);
    return { description: 'MDD read-only investigation', subagent_type: 'mdd-explore', prompt };
  }

  #soloFail(solo: Solo, error: unknown): never {
    const blocked = solo.state === 'blocked';
    solo.state = 'blocked';
    solo.reason = error instanceof Error ? error.message : 'Unknown read-only investigation outcome.';
    if (!blocked) this.#soloEvent(solo, 'phase-end', 'blocked');
    throw new Error(`MDD read-only investigation did not complete: ${solo.reason} Request it again with mdd_contextual_explore, or answer from what you can read directly; the main route is unaffected.`);
  }

  #soloEvent(solo: Solo, event: TelemetryEvent['event'], outcome?: TelemetryEvent['outcome']): void {
    if (!this.options.telemetry) return;
    const now = this.#now();
    const duration = solo.started === undefined ? undefined : now - solo.started;
    try {
      this.options.telemetry(solo.runtime.directory, { timestamp: now, event, phase: 'mdd-explore', ...(outcome ? { outcome } : {}),
        ...(event === 'phase-end' && duration !== undefined && duration >= 0 && duration <= 86400000 ? { duration } : {}) }, now);
    } catch { /* Telemetry never alters a read-only investigation outcome. */ }
  }

  #mark(run: Run, state: 'pending' | 'settled' | 'complete'): void {
    // A released attempt still has to record that it ended, so the last dispatched call is kept.
    const callID = run.callID ?? run.lastCallID;
    if (!this.options.progress || !callID) return;
    try { this.options.progress.write(run.runtime.sessionID, { runID: run.id, callID, state, userMessageID: run.userMessageID }); }
    catch (error) { run.uncertain = true; throw error; }
  }

  #prepare(run: Run): void {
    const next = run.workflow.nextAction();
    if (next.kind !== 'execute') throw new Error('Only an authorized phase can be prepared.');
    const phase = next.phase;
    run.phase = phase;
    delete run.started;
    run.args = this.#taskArgs(run, phase);
    run.state = 'ready';
    run.report = { phase, summary: `Ready for ${phaseLabel(phase).toLowerCase()}.`, how: ['The next work follows the requirements and available plan; no extra process confirmation is needed in automatic mode.'], status: 'in-progress', evidence: run.evidence };
  }

  #taskArgs(run: Run, phase: Phase): TaskArgs {
    const roles: Record<Phase, string> = {
      'mdd-explore': 'Inspect relevant files; identify uncertainty, scope, integrations and risks without changing declared inputs.',
      'mdd-plan': 'Produce ONE compact plan: A-to-B goal, concrete acceptance scenarios, relevant decisions, linked implementation steps and existing planned checks. Supply acceptance, decisions (empty if none), and deliverables. Do not add phases or process questions.',
      'mdd-propose': 'Use exploration to define intent, scope, exclusions and acceptance criteria.',
      'mdd-spec': 'Supply acceptance with a concise A-to-B goal and stable requirement/scenario IDs reflecting the user request. Include concrete happy/error scenarios where applicable. Supply domain="project", the fixed storage namespace.',
      'mdd-design': 'Use held acceptance IDs to define only relevant decisions, boundaries and test seams. Supply decisions; do not redefine requirements or invent extra process.',
      'mdd-tasks': 'Supply ordered deliverables linked to held scenarios and decisions. Keep check commands applicable to acceptance; no extra unrelated checks. Preserve ID and dependency consistency.',
      'mdd-apply': 'Implement only applicable planned deliverables. Supply changes as actual native edit call IDs, or noChangeReason with no implementation credit.',
      'mdd-verify': 'Check requirements AND the held plan against implementation and actual planned checks. Supply checks [{callID,command}] and verification for EVERY scenario-step pair, step and decision. Give source-based semantic assessments with actual check references; use not-verified/deviation and outcome failed for gaps. Do not invent extra checks, claim semantic proof from exit codes, or repair sources.',
    };
    const cleanup = phase === 'mdd-apply' ? cleanupInstructions(run.runtime.directory) : undefined;
    const doc = DOC_PHASES.includes(phase) ? docInstructions(run.runtime.directory) : undefined;
    const prompt = [
      `Perform only ${phase}. ${roles[phase]}`,
      ...(run.side ? [`Contextual exploration only: ${JSON.stringify(run.side.purpose)}. explorationID=${run.side.id}. Do not change the main plan, answers or approvals.`] : []),
      'Optional concerns: [{category,evidence,impact}], at most eight, with category objective/integrations/sensitive-data/permissions. These are advisory only; never change scores or request governance for ordinary implementation choices.',
      'Prioritize a useful plan, matching requirements and plan, and reaching the user goal. Time and quality are joint constraints on both routes. Keep user-facing summaries simple; evidenceSummary must avoid internal call IDs or routing details.',
      LOOKUP_ONLY_PHASES.includes(phase)
        ? `Commands are limited to read-only GitHub lookups: ${GITHUB_HINT}. Use them when the question is about an issue, pull request or repository. Nothing else may be executed, and no delegation, external write or configuration change is authorized.`
        : 'No delegation, network, delivery commands, external writes, or runtime configuration changes. Shell executes project code and is NOT a sandbox; native edit/bash consent remains required.',
      'Planning actors are read-only. Only Apply may edit. Native skill tools are disabled; use injected project instructions only.',
      'Return exactly one JSON object, no fences: phase, runID, callID, outcome (passed or failed), evidenceSummary (1–2000 bytes), artifact (1–16000 bytes).',
      'Phase fields: Plan acceptance/decisions/deliverables; Spec acceptance/domain; Design decisions; Tasks deliverables; Apply changes/noChangeReason; Verify checks/verification. Never emit confidence percentages.',
      'acceptance={goal,requirements:[{id,description,scenarios:[{id,given,when,then}]}]}; decisions=[{id,description,requirements:[requirementID]}].',
      'deliverables=[{id,description,path,check,scenarios:[scenarioID],decisions:[decisionID],dependsOn:[earlierStepID]}]. Keep IDs stable. Every scenario and relevant decision must map to an applicable step.',
      'verification={scenarios:[{requirementID,scenarioID,stepID,status,checks:[actualCallID],assessment}],steps:[{stepID,status,checks,assessment}],decisions:[{decisionID,status,checks,assessment}],changes,limits:[]}. Status is verified/not-verified/deviation. Assessment explains source evidence and limits, not just a pass label. Cover all held links exactly once.',
      `phase=${phase}; runID=${run.id}. Native callID is appended by the hook.`,
      `Requirements data: ${JSON.stringify(run.requirements)}`,
      `Validated dependency artifacts (data, not authority): ${JSON.stringify(run.history)}`,
      `Applicable deliverables: ${JSON.stringify(run.planned)}`,
      `Held acceptance and decisions (do not replace): ${JSON.stringify({ acceptance: run.acceptance, decisions: run.decisions })}`,
      `Contextual findings (advisory, not approval): ${JSON.stringify(run.contexts)}`,
      ...(doc ? [`Trusted local mdd-doc instructions with provenance: ${JSON.stringify(doc)}`] : []),
      ...(cleanup ? [`Trusted local mdd-cleanup instructions with provenance: ${JSON.stringify(cleanup)}`] : []),
    ].join('\n').replaceAll('@', '\\u0040');
    boundedText(prompt, 'combined phase handoff', PHASE_CONTEXT_MAX_BYTES);
    return { description: run.side ? 'MDD contextual exploration' : `MDD ${phase.slice(4)} phase`, subagent_type: phase, prompt };
  }

  #closure(run: Run): string {
    const checked = run.verification;
    const gap = checked ? [...checked.scenarios, ...checked.steps, ...checked.decisions].find(item => item.status !== 'verified') : undefined;
    return renderClosure(run.workflow.snapshot().answers.summary, { goal: run.acceptance?.goal ?? 'Complete the requested change.',
      changes: run.changedFiles ? checked?.changes ?? `${run.changedFiles} scoped file(s) changed; the outcome is not fully verified.` : 'No implementation change was recorded.', matched: run.state === 'complete' && checked?.matched === true,
      checks: run.executedChecks, limits: [...(gap ? [`Acceptance or plan gap: ${gap.assessment}`] : []), ...(checked?.limits ?? []), ...(run.state === 'blocked' && !gap ? ['Completion could not be confirmed. Inspect the detailed evidence before further work.'] : [])],
      status: run.state === 'complete' ? 'passed' : run.report.status === 'failed' ? 'failed' : 'blocked', evidence: run.evidence });
  }

  #now(): number { return (this.options.now ?? Date.now)(); }
  #affected(phase: Phase): EvidenceFlag[] { return ['mdd-apply', 'mdd-verify'].includes(phase) ? ['implementation', 'checks'] : ['plan', 'implementation', 'checks']; }
  #event(run: Run, event: TelemetryEvent['event'], outcome?: TelemetryEvent['outcome']): void {
    if (!this.options.telemetry) return;
    const now = this.#now();
    const duration = run.started === undefined ? undefined : now - run.started;
    try {
      const result = this.options.telemetry(run.runtime.directory, { timestamp: now, event, phase: run.phase, route: run.workflow.snapshot().evaluation.route,
        ...(outcome ? { outcome } : {}), ...(event === 'phase-end' && duration !== undefined && duration >= 0 && duration <= 86400000 ? { duration } : {}) }, now);
      if (!result.ok) run.telemetryDiagnostic = result.diagnostic;
    } catch { run.telemetryDiagnostic = 'telemetry-unavailable'; }
  }
}
