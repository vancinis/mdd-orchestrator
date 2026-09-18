import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EngramHttp } from './engram-http.js';
import { boundedText, runContext } from './phase-runner.js';
import type { PhaseRunner, Runtime, TaskCall } from './phase-runner.js';
import { answersFromLabels, questionEnvelope } from './preflight.js';
import type { QuestionEnvelope } from './preflight.js';
import type { Answers, Phase } from './policy.js';
import { freezeProfile, parseSettings } from './settings.js';
import { ManagedMemory } from './managed-memory.js';
import { objectWithKeys } from './validation.js';
import { concerns } from './concerns.js';

export type IntakeInspect = {
  setupPending?(runtime: Runtime, requirements?: string, messageID?: string): Promise<{ requirements: string; userMessageID: string } | undefined>;
  intake(runtime: Runtime, requirements: string, messageID: string): Promise<void | string>;
  question(runtime: Runtime, call: TaskCall, args: QuestionEnvelope): Promise<void>;
};
type Runner = Pick<PhaseRunner, 'start' | 'status' | 'approveNative' | 'block'> & Partial<Pick<PhaseRunner, 'approvalStopped' | 'assertChangeable' | 'assertFreshStart' | 'contribute' | 'explore' | 'priorGuards' | 'recordConsent' | 'reset' | 'submit'>>;
type Slot = { kind: 'preflight' | 'approval' | 'change'; args: QuestionEnvelope; phase?: Phase; callID?: string; requirements?: string };
type Intake = {
  runtime: Runtime; requirements: string;
  state: 'starting' | 'question-ready' | 'await-answer' | 'accepting' | 'active' | 'blocked' | 'stopped';
  slot?: Slot; reason?: string;
  provenance?: { requirements: 'native-user'; preflight: 'startup-profile' | 'native-question'; profile: string };
  receipts: { kind: Slot['kind']; phase?: Phase; callID: string; answers: string[][]; cancelled?: true }[];
  known: Partial<Answers>; userMessageID?: string; usedMessages: Set<string>; proposed: Set<string>; replacing?: true; notice?: string;
  restore?: { state: Intake['state']; slot?: Slot; requirements: string; known: Partial<Answers>; userMessageID?: string };
  memory?: { endpoint: string; project: string }; context?: { label: string; content: string };
};

/**
 * Approval and change labels are both user-facing text and the answer tokens this module
 * compares against, so they live in one place: a translated label can never drift from the
 * comparison that maps it to an outcome.
 */
export const APPROVAL_LABELS = Object.freeze({ proceed: 'Continuar', stop: 'Detener' });
export const CHANGE_LABELS = Object.freeze({ confirm: 'Confirmar el cambio', keep: 'Mantener el plan actual' });

export function approvalEnvelope(runID: string, phase: Phase): QuestionEnvelope {
  return { questions: [{ header: 'Aprobación', question: `¿Continuar con ${phase} en el run MDD ${runID}? Esto autoriza solo esta fase; los pedidos de permiso nativos siguen aplicando.`, multiple: false,
    options: [{ label: APPROVAL_LABELS.proceed, description: 'Autorizar únicamente esta fase.' }, { label: APPROVAL_LABELS.stop, description: 'Detener sin autorizar esta fase.' }] }] };
}

/**
 * The user typed their own text instead of choosing one of the offered options. Nothing is
 * selected, so nothing is approved, accepted or changed — but a person answering in their own
 * words is ordinary, not a protocol violation, and it is carried separately so the caller can
 * keep the run alive and deal with what was actually said.
 */
export class UnselectedAnswer extends Error {
  constructor(readonly text: string) {
    super('The user answered with their own text instead of choosing one of the offered options.');
  }
}

export function nativeQuestionAnswers(args: QuestionEnvelope, raw: unknown): string[][] {
  const result = objectWithKeys(raw, 'native question output', ['title', 'output', 'metadata', 'attachments']);
  const metadata = objectWithKeys(result.metadata, 'native question metadata', ['answers', 'truncated']);
  if (metadata.truncated !== false || (result.attachments !== undefined && (!Array.isArray(result.attachments) || result.attachments.length))) {
    throw new Error('Unknown or truncated native question result.');
  }
  const answers = metadata.answers;
  if (!Array.isArray(answers) || answers.length !== args.questions.length) throw new Error('Native question answer count mismatch.');
  const selections = args.questions.map((_question, index) => {
    const selected: unknown = answers[index];
    if (!Array.isArray(selected) || selected.length !== 1 || typeof selected[0] !== 'string') throw new Error('Invalid native question answer label.');
    return [selected[0]];
  });
  const formatted = args.questions.map((q, i) => `"${q.question}"="${selections[i]!.join(', ')}"`).join(', ');
  if (result.title !== `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}` ||
      result.output !== `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`) {
    throw new Error('Native question output does not match its answer metadata.');
  }
  // Only an envelope that agrees with itself can have its labels read as what the user chose, so
  // an unlisted one is their own words here, rather than a result that was rewritten on the way.
  const unlisted = args.questions.findIndex((question, index) => !question.options.some(option => option.label === selections[index]![0]));
  if (unlisted >= 0) throw new UnselectedAnswer(selections[unlisted]![0]!);
  return selections;
}

export class NativeIntake {
  readonly #sessions = new Map<string, Intake>();
  readonly #questionOwners = new Map<QuestionEnvelope, string>();
  readonly #settings;
  readonly #profile;
  readonly #managed;
  constructor(readonly runner: Runner, readonly inspect: IntakeInspect, settings: unknown) {
    this.#settings = parseSettings(settings);
    this.#profile = freezeProfile(this.#settings);
    this.#managed = this.#settings.engram && 'mode' in this.#settings.engram ? new ManagedMemory(this.#settings.engram) : undefined;
  }

  async close(): Promise<void> { await this.#managed?.close(); }

  async start(value: unknown, runtime: Runtime, messageID: string): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only mdd-orchestrator may start MDD.');
    this.runner.assertFreshStart?.(runtime.sessionID);
    const previous = this.#sessions.get(runtime.sessionID);
    if (previous) {
      // An intake that never reached a run has nothing to protect. Refusing it would strand the
      // conversation: change requests need a run, so a failed intake could never be replaced.
      const state = this.runner.status(runtime.sessionID).state;
      const replaceable = state === 'complete' ||
        (state === 'not-started' && ['blocked', 'stopped'].includes(previous.state));
      if (!replaceable) throw new Error('This parent already has an MDD intake; use mdd_status or request a confirmed change.');
    }
    const input = objectWithKeys(value, 'start', ['requirements', 'context']);
    const requirements = boundedText(input.requirements, 'requirements', 12000);
    // Validated at intake so bad context fails here, not later when the first phase is prepared.
    // Only the pair is held: the runner attributes provenance itself when the run is created.
    const context = input.context === undefined ? undefined : (({ label, content }) => ({ label, content }))(runContext(input.context));
    const engram = this.#settings.engram;
    const pending = !previous && this.runner.status?.(runtime.sessionID).state !== 'complete' ? await this.inspect.setupPending?.(runtime, requirements, boundedText(messageID, 'native messageID', 256)) : undefined;
    if (pending && pending.requirements !== requirements) throw new Error('The original objective is pending. Resubmit its exact pendingStart arguments, not continuation text. For a different objective, use a fresh parent.');
    if (this.#sessions.get(runtime.sessionID) !== previous) throw new Error('Intake changed during setup inspection; read mdd_status.');
    // A restarted process has no previous intake, but the run it lost may have consumed user
    // messages and change proposals. Those guards are restored; the receipts that recorded actual
    // consent are not, because their call IDs would look like approvals this run never received.
    const guards = previous ? undefined : this.runner.priorGuards?.(runtime.sessionID);
    const entry: Intake = { runtime: { ...runtime }, requirements, state: 'starting', receipts: previous?.receipts ?? [], known: { ...this.#profile.answers }, usedMessages: new Set(previous?.usedMessages ?? guards?.usedMessages), proposed: new Set(previous?.proposed ?? guards?.proposed), ...(context ? { context } : {}), ...(previous ? { replacing: true } : {}) };
    if (previous) entry.restore = { state: previous.state, requirements: previous.requirements, known: previous.known, ...(previous.slot ? { slot: previous.slot } : {}), ...(previous.userMessageID ? { userMessageID: previous.userMessageID } : {}) };
    this.#sessions.set(runtime.sessionID, entry);
    try {
      const userID = pending?.userMessageID ?? await this.inspect.intake(entry.runtime, requirements, boundedText(messageID, 'native messageID', 256));
      if (typeof userID === 'string') {
        if (entry.usedMessages.has(userID)) throw new Error('This user message was already used; wait for an actual new request.');
        entry.userMessageID = userID; entry.usedMessages.add(userID);
        this.runner.assertFreshStart?.(runtime.sessionID, userID);
      } else if (previous) throw new Error('A fresh native user identity is required for another run.');
      if (!engram && ['engram', 'both'].includes(entry.known.artifactStore ?? '')) {
        delete entry.known.artifactStore;
        entry.notice = 'The saved artifact choice requires optional Engram memory, which is off. Choose a compatible artifact store for this run; the saved profile is unchanged.';
      }
      if (engram) {
        const endpoint = 'endpoint' in engram ? engram.endpoint : await this.#managed!.endpoint();
        const client = new EngramHttp(endpoint, { id: runtime.sessionID, project: '', directory: runtime.directory });
        await client.bootstrap();
        if ('project' in engram && engram.project) entry.notice = 'The deprecated Engram project setting is ignored. Memory is bound to the provider-resolved active workspace; remove project from global settings using mdd config.';
        entry.memory = { endpoint, project: client.project };
      }
      if (entry.state !== 'starting') throw new Error('Intake became uncertain during initialization.');
      const args = questionEnvelope(entry.known, !!engram);
      if (args.questions.length) {
        const id = randomUUID();
        for (const q of args.questions) q.question += ` [MDD intake ${id}]`;
        this.#slot(entry, { kind: 'preflight', args });
      } else await this.#startRunner(entry, [], 'startup-profile');
      return this.status(runtime.sessionID);
    } catch (error) {
      if (previous) { this.#sessions.set(runtime.sessionID, previous); throw error; }
      return this.#fail(entry, error);
    }
  }

  async changeRequest(value: unknown, runtime: Runtime, messageID: string): Promise<unknown> {
    const input = objectWithKeys(value, 'change request', ['kind', 'userText', 'requirements', 'concerns']);
    if (runtime.agent !== 'mdd-orchestrator' || !['rerun', 'material'].includes(String(input.kind))) throw new Error('Only the coordinator may request a rerun or material change.');
    const entry = this.#sessions.get(runtime.sessionID);
    if (!entry || entry.restore || !['active', 'question-ready', 'stopped', 'blocked'].includes(entry.state) ||
        (entry.state === 'question-ready' && entry.slot?.kind !== 'approval') ||
        (entry.state === 'blocked' && entry.slot?.callID && !entry.receipts.some(item => item.callID === entry.slot!.callID))) throw new Error('Finish or dismiss the current native interaction before requesting a change.');
    if (this.runner.status(runtime.sessionID).state !== 'not-started') this.runner.assertChangeable?.(runtime.sessionID);
    const userText = boundedText(input.userText, 'actual user request', 12000);
    const advisory = concerns(input.concerns);
    const requirements = input.kind === 'rerun' ? entry.requirements : boundedText(input.requirements, 'proposed requirements', 12000);
    if (input.kind === 'rerun' && (input.requirements !== undefined || advisory.length)) throw new Error('A preflight rerun retains requirements; use material change for a new objective.');
    if (input.kind === 'material' && (!advisory.length || requirements.trim() === entry.requirements.trim())) throw new Error('Material change requires changed requirements and explicit advisory evidence. Ordinary plan choices do not require this path.');
    const saved = { state: entry.state, requirements: entry.requirements, known: entry.known, ...(entry.slot ? { slot: entry.slot } : {}), ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}) };
    entry.state = 'accepting';
    try {
      const userID = await this.inspect.intake(runtime, userText, boundedText(messageID, 'native messageID', 256));
      const status = this.runner.status(runtime.sessionID);
      const backedConcern = input.kind === 'material' && 'concerns' in status && advisory.every(item => status.concerns.some(known => isDeepStrictEqual(known, item)));
      if (!userID || (entry.usedMessages.has(userID) && !backedConcern)) throw new Error('Change requests require a fresh actual user message or a recorded material concern, not a model approval claim.');
      const proposal = JSON.stringify([userID, input.kind, requirements.trim(), advisory.map(item => JSON.stringify(item)).sort()]);
      if (entry.proposed.has(proposal)) throw new Error('This change proposal was already presented. Do not repeat it without a new user request.');
      if (entry.state !== 'accepting') throw new Error('Change validation was interrupted.');
      entry.proposed.add(proposal); entry.usedMessages.add(userID); entry.userMessageID = userID; entry.restore = saved;
      this.#recordConsent(entry);
      const question = `${input.kind === 'rerun' ? '¿Volver a hacer las cinco preguntas de preflight para un run planificado nuevo?' : '¿Confirmás este cambio material de alcance y un run planificado nuevo?'} Los artefactos y la memoria actuales se conservan. Requisitos propuestos: ${requirements}${advisory.length ? ` Evidencia advertida: ${JSON.stringify(advisory)}` : ''} [MDD change ${randomUUID()}]`;
      this.#slot(entry, { kind: 'change', requirements, args: { questions: [{ header: 'Cambio', question, multiple: false, options: [{ label: CHANGE_LABELS.confirm, description: 'Responder el preflight una vez y arrancar un run planificado nuevo.' }, { label: CHANGE_LABELS.keep, description: 'No cambiar el run actual, sus respuestas ni su aprobación.' }] }] } });
      return this.status(runtime.sessionID);
    } catch (error) { entry.state = saved.state; throw error; }
  }

  /** Read-only investigation needs no accepted run; it only waits for a pending native interaction. */
  async explore(value: unknown, runtime: Runtime): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator' || !this.runner.explore) throw new Error('Only the coordinator may request read-only investigation.');
    const entry = this.#sessions.get(runtime.sessionID);
    if (entry && (entry.restore || ['starting', 'accepting', 'await-answer'].includes(entry.state) ||
        (entry.state === 'question-ready' && entry.slot?.kind !== 'approval'))) {
      throw new Error('A native question is pending. Let the user answer it before requesting investigation.');
    }
    await this.runner.explore(value, runtime);
    return this.status(runtime.sessionID);
  }

  /**
   * The coordinator hands MDD material it gathered for the current objective. MDD composes it into
   * the phase prompt, so the dispatched task stays exactly the one status returned.
   */
  contribute(value: unknown, runtime: Runtime): unknown {
    if (runtime.agent !== 'mdd-orchestrator' || !this.runner.contribute) throw new Error('Only the coordinator may contribute run context.');
    const entry = this.#sessions.get(runtime.sessionID);
    if (entry && entry.state !== 'active') throw new Error('Finish or dismiss the pending native interaction before contributing context; nothing was recorded.');
    this.runner.contribute(value, runtime);
    return this.status(runtime.sessionID);
  }

  /** The coordinator reports a phase it carried out itself instead of delegating it. */
  async submit(value: unknown, runtime: Runtime): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator' || !this.runner.submit) throw new Error('Only the coordinator may report a phase result.');
    const entry = this.#sessions.get(runtime.sessionID);
    if (entry && entry.state !== 'active') throw new Error('A phase cannot be reported before accepted preflight or its exact phase approval.');
    const status = await this.runner.submit(value, runtime);
    this.phaseRecorded(runtime.sessionID);
    return entry ? this.status(runtime.sessionID) : status;
  }

  /**
   * Explicit recovery for the conversation. Phase scope releases the current attempt; run scope
   * forgets the run and its intake so a new objective can start here without a new conversation.
   */
  reset(runtime: Runtime, scope: 'phase' | 'run'): unknown {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may reset MDD state.');
    const entry = this.#sessions.get(runtime.sessionID);
    // Releasing the phase of a conversation whose run never started is really about the question
    // the user is stuck on, so the pending one is re-opened rather than the intake discarded.
    if (scope === 'phase' && entry?.slot && entry.state !== 'active' && !('runID' in (this.runner.status(runtime.sessionID) as object))) {
      const pending: Slot = { ...entry.slot };
      delete pending.callID;
      delete entry.restore; delete entry.reason;
      this.#slot(entry, pending);
      entry.notice = 'The pending question was re-opened. Nothing was approved or recorded: ask it again exactly as mdd_status returns it.';
      return { ...this.status(runtime.sessionID), reset: { scope: 'phase' as const } };
    }
    const applied = this.runner.reset?.(runtime.sessionID, scope) ?? { scope: 'run' as const };
    if (applied.scope === 'run') this.#sessions.delete(runtime.sessionID);
    else if (entry) {
      delete entry.slot; delete entry.reason; delete entry.restore; delete entry.replacing;
      entry.state = 'active';
      entry.notice = applied.approval
        ? `The run was released at its approval boundary: ${applied.phase ?? 'the next phase'} is waiting for the same approval question again. Nothing was approved and previous evidence is retained.`
        : `The ${applied.phase ?? 'current'} phase was released and is ready to run again. Previous evidence is retained.`;
      // A run released while it waited for approval still needs that approval, so its question is
      // re-armed here instead of leaving the conversation with nothing to answer.
      this.phaseRecorded(runtime.sessionID);
    }
    return { ...this.status(runtime.sessionID), reset: applied };
  }

  status(sessionID: string) {
    const entry = this.#sessions.get(sessionID);
    const status = this.runner.status?.(sessionID) ?? { state: 'not-started' };
    const memory = this.#settings.engram ? 'enabled' : 'off';
    if (!entry) return { ...status, memory, question: undefined, provenance: undefined, questionReceipts: [] };
    const side = 'contextual' in status && status.contextual;
    const state = entry.state === 'active' || side ? status.state : entry.state;
    return { ...status, state, memory, ...(entry.reason ? { reason: entry.reason } : {}),
      task: (entry.state === 'active' || side) && 'task' in status ? status.task : undefined,
      ...(entry.state !== 'active' && !side ? { next: { kind: entry.state === 'question-ready' ? 'question' : 'wait', ...(entry.slot?.phase ? { phase: entry.slot.phase } : {}) } } : {}),
      question: entry.state === 'question-ready' && !side ? structuredClone(entry.slot!.args) : undefined,
      notice: entry.notice,
      provenance: entry.provenance ? { ...entry.provenance } : undefined,
      questionReceipts: structuredClone(entry.receipts),
      ...(entry.state === 'await-answer' ? { reason: 'Native question is pending or uncertain. Do not repeat it or dispatch a task.' } : {}),
    };
  }

  async beforeQuestion(call: TaskCall, args: unknown): Promise<void> {
    const entry = this.#entry(call, args);
    if (!entry) return;
    // While MDD has a question pending, that one is the only question that may run: anything else
    // leaves the user answering two things at once, and an altered copy of it is a forgery.
    // Otherwise a question MDD never issued belongs to the coordinator, and asking the user
    // something of its own is ordinary work: treating that as MDD's own turned a clarification
    // between phases into a blocked run.
    if (entry.state === 'question-ready') {
      if (!isDeepStrictEqual(args, entry.slot!.args)) throw new Error('Question arguments differ from the pending question; no answer was accepted.');
    } else if (!this.#owned(args)) return;
    const status = this.runner.status(call.sessionID);
    if ('contextual' in status && status.contextual) throw new Error('Wait for the contextual exploration before answering the main approval.');
    if (entry.state !== 'question-ready') return this.#fail(entry, new Error('Unexpected, duplicate, or changed native question.'));
    entry.state = 'accepting';
    try {
      entry.slot!.callID = boundedText(call.callID, 'native question callID', 256);
      if (entry.receipts.some(receipt => receipt.callID === call.callID)) throw new Error('Native question call ID was already consumed.');
      await this.inspect.question(entry.runtime, call, entry.slot!.args);
      if (entry.state !== 'accepting') throw new Error('Question became uncertain before execution.');
      entry.state = 'await-answer';
    } catch (error) { this.#fail(entry, error); }
  }

  async afterQuestion(call: TaskCall, args: unknown, output: unknown): Promise<void> {
    const entry = this.#entry(call, args);
    if (!entry || !this.#owned(args)) return;
    const slot = entry.slot;
    if (entry.state !== 'await-answer' || !slot || slot.callID !== call.callID || !isDeepStrictEqual(args, slot.args)) {
      return this.#fail(entry, new Error('Native answer does not match the pending parent, call, and question.'));
    }
    entry.state = 'accepting';
    try {
      await this.inspect.question(entry.runtime, call, slot.args);
      if (entry.state !== 'accepting') throw new Error('Question became uncertain during result inspection.');
      const selections = nativeQuestionAnswers(slot.args, output);
      if (slot.kind === 'change') {
        if (selections[0]![0] === CHANGE_LABELS.keep) this.#restore(entry, 'Kept the current plan, answers and approval unchanged.');
        else {
          // A material change replaces the objective, so context gathered for the old one is no
          // longer trustworthy data. A plain preflight rerun keeps the same objective and its context.
          if (slot.requirements!.trim() !== entry.requirements.trim()) delete entry.context;
          entry.requirements = slot.requirements!; entry.known = {}; entry.replacing = true;
          const args = questionEnvelope({}, !!this.#settings.engram);
          for (const question of args.questions) question.question += ` [MDD re-preflight ${randomUUID()}]`;
          this.#slot(entry, { kind: 'preflight', args });
        }
      } else if (slot.kind === 'preflight') await this.#startRunner(entry, selections, 'native-question');
      else if (selections[0]![0] === APPROVAL_LABELS.stop) {
        entry.state = 'stopped';
        entry.reason = 'The user stopped at the phase approval boundary. No phase was authorized.';
        this.runner.approvalStopped?.(call.sessionID);
        this.runner.block(call.sessionID, entry.reason);
      } else {
        this.runner.approveNative(call.sessionID, slot.phase!);
        entry.state = 'active';
      }
      entry.receipts.push({ kind: slot.kind, ...(slot.phase ? { phase: slot.phase } : {}), callID: call.callID, answers: selections });
      this.#recordConsent(entry);
    } catch (error) {
      if (error instanceof UnselectedAnswer) return this.#unanswered(entry, slot, call);
      this.#fail(entry, error);
    }
  }

  /**
   * Nothing was selected, so nothing is approved, accepted or changed and the same question stays
   * open. The coordinator still receives the user's actual words in the question output, so it can
   * answer them and ask again. Ending the run here instead used to throw away a whole route, its
   * evidence and its approvals over one sentence typed in place of a click.
   */
  #unanswered(entry: Intake, slot: Slot, call: TaskCall): void {
    entry.receipts.push({ kind: slot.kind, ...(slot.phase ? { phase: slot.phase } : {}), callID: call.callID, answers: [], cancelled: true });
    this.#recordConsent(entry);
    if (slot.kind === 'change' && entry.restore) {
      this.#restore(entry, 'The user did not confirm the change in their answer, so the current run, its answers and its approval are unchanged. Read what they actually said before proposing anything again.');
      return;
    }
    const pending: Slot = { ...slot };
    delete pending.callID;
    this.#slot(entry, pending);
    entry.notice = slot.kind === 'approval'
      ? 'The user answered in their own words instead of choosing an option, so no phase was approved and nothing was recorded. Read what they actually said and respond to it; when the phase should still go ahead, ask the same approval question again exactly as mdd_status returns it. If their message changes the objective, use mdd_change_request instead.'
      : 'The user answered in their own words instead of choosing an option, so the run has not started and no answer was recorded. Respond to what they said, then ask the same preflight question again exactly as mdd_status returns it.';
  }

  phaseRecorded(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    if (!entry || entry.state !== 'active') return;
    const status = this.runner.status(sessionID);
    if (!('workflow' in status) || status.state === 'blocked') return;
    const next = status.workflow.nextAction;
    if (next.kind === 'approve') this.#slot(entry, { kind: 'approval', phase: next.phase, args: approvalEnvelope(status.runID, next.phase) });
  }

  guardTask(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    const status = this.runner.status(sessionID);
    if ('contextual' in status && status.contextual) return;
    if (entry && entry.state !== 'active') throw new Error('A task cannot execute before accepted preflight or its exact phase approval.');
  }

  nativeError(call: TaskCall): void {
    const entry = this.#sessions.get(call.sessionID);
    if (!entry || entry.slot?.callID !== call.callID || !['accepting', 'await-answer'].includes(entry.state)) return;
    entry.receipts.push({ kind: entry.slot.kind, callID: call.callID, answers: [], cancelled: true });
    this.#recordConsent(entry);
    if (entry.restore) { this.#restore(entry, 'Change cancelled; the current plan and approval are unchanged.'); return; }
    entry.state = 'stopped';
    entry.reason = 'The native question failed or was dismissed. No approval was recorded; do not repeat or dispatch.';
    this.runner.block(call.sessionID, entry.reason);
  }

  #entry(call: TaskCall, args: unknown): Intake | undefined {
    const owner = [...this.#questionOwners].find(([question]) => isDeepStrictEqual(question, args))?.[1];
    if (owner !== undefined && owner !== call.sessionID) throw new Error('MDD question belongs to another parent.');
    return this.#sessions.get(call.sessionID);
  }

  /** Only an envelope MDD composed drives consent. Anything else is the coordinator's own question. */
  #owned(args: unknown): boolean {
    return [...this.#questionOwners.keys()].some(question => isDeepStrictEqual(question, args));
  }

  /**
   * Consent lives here, but only the runner writes the preserved record, so the parts worth
   * keeping are handed over whenever they change. Receipts go across as history; the reuse
   * guards go across because a restarted process must still refuse a message or proposal that
   * was already used. Neither can authorize anything on its own.
   */
  #recordConsent(entry: Intake): void {
    this.runner.recordConsent?.(entry.runtime.sessionID, { questionReceipts: structuredClone(entry.receipts),
      usedMessages: [...entry.usedMessages], proposed: [...entry.proposed] });
  }

  #slot(entry: Intake, slot: Slot): void {
    entry.slot = structuredClone(slot);
    entry.state = 'question-ready';
    this.#questionOwners.set(entry.slot.args, entry.runtime.sessionID);
  }

  async #startRunner(entry: Intake, selections: unknown, source: 'startup-profile' | 'native-question'): Promise<void> {
    const expectedState = entry.state;
    const engram = entry.memory;
    // Handed over before the run exists, so the record the runner writes at start already carries
    // the guards rather than waiting for the first phase to close.
    this.#recordConsent(entry);
    await this.runner.start({ requirements: entry.requirements, preflight: { answers: answersFromLabels(entry.known, selections) },
      ...(entry.context ? { context: entry.context } : {}),
      ...(engram ? { engramEndpoint: engram.endpoint, project: engram.project } : {}) }, entry.runtime, { requirementsConfirmed: true, ...(entry.replacing ? { replace: true } : {}), ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}) });
    if (entry.state !== expectedState) throw new Error('Intake became uncertain during runner initialization.');
    entry.provenance = { requirements: 'native-user', preflight: source, profile: this.#profile.name };
    entry.state = 'active';
    delete entry.restore; delete entry.replacing; delete entry.reason;
    entry.notice = 'The planned run is ready. Previous run evidence is retained.';
  }

  #restore(entry: Intake, notice: string): void {
    const saved = entry.restore;
    if (!saved) throw new Error('No unchanged run is available to restore.');
    delete entry.slot; delete entry.userMessageID;
    Object.assign(entry, saved);
    delete entry.restore; delete entry.replacing; delete entry.reason;
    entry.notice = notice;
  }

  #fail(entry: Intake, error: unknown): never {
    entry.state = 'blocked';
    entry.reason = error instanceof Error ? error.message : 'Unknown native intake outcome.';
    this.runner.block(entry.runtime.sessionID, entry.reason);
    throw new Error(`MDD intake stopped: ${entry.reason} Nothing is locked: read mdd_status, then use mdd_reset to start over, or send a fresh request.`);
  }
}
