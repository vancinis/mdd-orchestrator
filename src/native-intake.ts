import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { EngramHttp, LESSON_TITLE_PREFIX, mddDataRoot } from './engram-http.js';
import { readLessons, recordLesson, renderLessonsReport } from './lessons.js';
import type { LessonState } from './lessons.js';
import { boundedText, runContext } from './phase-runner.js';
import type { PhaseRunner, Runtime, TaskCall } from './phase-runner.js';
import { answersFromLabels, questionEnvelope } from './preflight.js';
import type { QuestionEnvelope } from './preflight.js';
import type { Answers, Phase } from './policy.js';
import { freezeProfile, parseSettings } from './settings.js';
import { ManagedMemory } from './managed-memory.js';
import { objectWithKeys } from './validation.js';
import { concerns } from './concerns.js';
import { STABLE_CHECKPOINT_VERSION } from './checkpoint.js';
import type { CheckpointStore } from './checkpoint.js';
import type { QuestionCheckpointStore, QuestionRecord } from './question-checkpoint.js';
import type { RunOwnershipStore } from './run-ownership.js';

export type IntakeInspect = {
  setupPending?(runtime: Runtime, requirements?: string, messageID?: string): Promise<{ requirements: string; userMessageID: string } | undefined>;
  intake(runtime: Runtime, requirements: string, messageID: string, scope?: 'latest' | 'objective'): Promise<void | string>;
  question(runtime: Runtime, call: TaskCall, args: QuestionEnvelope): Promise<void>;
  transferLiveness?(runtime: Runtime, sourceSessionID: string, runID: string, requestDigest: string,
    assistantMessageID?: string): Promise<'running' | 'stopped' | 'unknown'>;
};
type Runner = Pick<PhaseRunner, 'start' | 'status' | 'approveNative' | 'block'> & Partial<Pick<PhaseRunner, 'approvalStopped' | 'assertChangeable' | 'assertFreshStart' | 'closeForFreshStart' | 'contribute' | 'explore' | 'movedAway' | 'priorGuards' | 'recordConsent' | 'reset' | 'resumable' | 'submit' | 'owner' | 'reserve' | 'release' | 'handoffRecoveredQuestion'>>;
/** The run and settled state a native question reserved the durable writer against. */
type Reservation = NonNullable<QuestionRecord['reservation']>;
type Slot = { kind: 'preflight' | 'approval' | 'change' | 'clarification'; args: QuestionEnvelope; phase?: Phase; callID?: string; requirements?: string };
type Clarification = { question: string; options: { label: string; description: string; recommended?: boolean }[]; deferrable?: boolean };
type Intake = {
  runtime: Runtime; requirements: string;
  intakeToken?: string;
  state: 'starting' | 'question-ready' | 'review-ready' | 'paused' | 'await-answer' | 'accepting' | 'active' | 'blocked' | 'stopped';
  slot?: Slot; reason?: string;
  provenance?: { requirements: 'native-user'; preflight: 'startup-profile' | 'native-question'; profile: string };
  receipts: { kind: Slot['kind']; phase?: Phase; callID: string; answers: string[][]; cancelled?: true }[];
  known: Partial<Answers>; userMessageID?: string; usedMessages: Set<string>; proposed: Set<string>; replacing?: true; notice?: string;
  restore?: { state: Intake['state']; slot?: Slot; requirements: string; known: Partial<Answers>; userMessageID?: string; clarifications: Clarification[]; deferred: Clarification[]; clarificationAnswers: { question: string; answer: string; phase: Phase; disposition: 'answered' | 'deferred' }[] };
  memory?: { endpoint: string; project: string }; context?: { label: string; content: string };
  clarifications: Clarification[]; deferred: Clarification[];
  clarificationAnswers: { question: string; answer: string; phase: Phase; disposition: 'answered' | 'deferred' }[];
  /** Set while a native question holds the durable run writer; persisted with its record. */
  reserved?: Reservation;
};

/**
 * Approval and change labels are both user-facing text and the answer tokens this module
 * compares against, so they live in one place: a translated label can never drift from the
 * comparison that maps it to an outcome.
 */
export const APPROVAL_LABELS = Object.freeze({ proceed: 'Continuar', pause: 'Pausar', detail: 'Obtener un resumen más completo de esta fase' });
export const CHANGE_LABELS = Object.freeze({ confirm: 'Confirmar el cambio', keep: 'Mantener el plan actual' });
export const CLARIFICATION_LABELS = Object.freeze({ defer: 'Dejar para más adelante', delegate: 'Que decida el agente' });
const clarificationOptionLabel = (option: Clarification['options'][number]): string => `${option.label}${option.recommended ? ' (Recomendada)' : ''}`;

export function approvalEnvelope(runID: string, phase: Phase, detail = false): QuestionEnvelope {
  return { questions: [{ header: 'Aprobación', question: `¿Continuar con ${phase} en el run MDD ${runID}? Esto autoriza solo esta fase; los pedidos de permiso nativos siguen aplicando.`, multiple: false,
    options: [{ label: APPROVAL_LABELS.proceed, description: 'Autorizar únicamente esta fase.' }, { label: APPROVAL_LABELS.pause, description: 'Pausar sin rechazar la fase ni perder el plan.' },
      ...(detail ? [{ label: APPROVAL_LABELS.detail, description: 'Ver más información antes de tomar una decisión.' }] : [])] }] };
}

function clarificationEnvelope(item: Clarification): QuestionEnvelope {
  return { questions: [{ header: 'Detalle', question: item.question, multiple: false,
    options: [...item.options.map(option => ({ label: clarificationOptionLabel(option), description: option.description })),
      ...(item.deferrable ? [{ label: CLARIFICATION_LABELS.defer, description: 'Resolver esto en una fase posterior; no se considera decidido.' }] : []),
      { label: CLARIFICATION_LABELS.delegate, description: 'Delegar esta decisión al agente de la próxima fase.' }] }] };
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
  readonly #reissued = new Set<string>();
  readonly #questionOwners = new Map<QuestionEnvelope, string>();
  readonly #settings;
  readonly #profile;
  readonly #managed;
  constructor(readonly runner: Runner, readonly inspect: IntakeInspect, settings: unknown,
    readonly durable: { questions?: QuestionCheckpointStore; checkpoint?: CheckpointStore; ownership?: RunOwnershipStore } = {}) {
    this.#settings = parseSettings(settings);
    this.#profile = freezeProfile(this.#settings);
    this.#managed = this.#settings.engram && 'mode' in this.#settings.engram ? new ManagedMemory(this.#settings.engram) : undefined;
  }

  async close(): Promise<void> { await this.#managed?.close(); }

  /**
   * Frees a parent whose run moved to another conversation: its unresolved question record (if
   * any) and in-memory intake are dropped. Nothing here can approve or answer for that run.
   */
  forgetMovedAway(sessionID: string): void {
    this.durable.questions?.clear(sessionID);
    this.#forget(sessionID);
  }

  /**
   * Whether an unresolved native question (approval, clarification, change or a re-preflight of an
   * existing run) holds this parent's durable writer. Only then is its binding checked; a question
   * that no longer holds the writer is answered by `orphanQuestion` instead of locking the parent.
   */
  pendingQuestionOwner(sessionID: string): boolean {
    const record = this.durable.questions?.read(sessionID);
    if (!record || !['pending', 'answered'].includes(record.state) || !record.callID) return false;
    const runID = record.runID ?? record.reservation?.runID;
    const ownership = this.durable.ownership;
    if (!runID || !ownership) return false;
    const owner = ownership.read(runID);
    if (!owner || owner.state !== 'reserved' || owner.callID !== record.callID || owner.ownerSessionID !== sessionID ||
        ownership.parent(sessionID) !== runID) return false;
    const saved = this.durable.checkpoint?.read(sessionID)?.checkpoint;
    // Without a resumable checkpoint there is no bound run to hand off to; the reservation is then
    // released as a crashed reservation (run discard only) on the user's word.
    if (!saved) return false;
    if (record.checkpoint && (saved?.version !== STABLE_CHECKPOINT_VERSION || saved.runID !== runID || saved.parent !== sessionID ||
        record.checkpoint.sequence > saved.sequence ||
        (saved.sequence === record.checkpoint.sequence && (saved.dataDigest !== record.checkpoint.digest ||
          (record.reservation !== undefined && saved.stable.state !== record.reservation.stable)))))
      throw new Error('Pending question and run checkpoint disagree; no reservation may be released.');
    return true;
  }

  /** An unresolved question record whose reservation is gone (released, or its process died). */
  #orphanQuestion(sessionID: string): QuestionRecord | undefined {
    const record = this.durable.questions?.read(sessionID);
    if (!record || !['pending', 'answered'].includes(record.state) || !record.callID) return undefined;
    const runID = record.runID ?? record.reservation?.runID;
    const owner = runID ? this.durable.ownership?.read(runID) : undefined;
    return owner?.state === 'reserved' && owner.callID === record.callID ? undefined : record;
  }

  /** Settle a question record on user attestation: pending is cancelled, an unapplied answer is re-presented. */
  #retireQuestionRecord(sessionID: string, record: QuestionRecord): void {
    if (record.state === 'answered') {
      const { callID: _callID, answer: _answer, reservation: _reservation, ...rest } = record;
      const slot = structuredClone(record.slot);
      slot.args.questions[0]!.question += ` [MDD re-present ${randomUUID()}]`;
      this.durable.questions!.write(sessionID, { ...rest, sequence: record.sequence + 1, state: 'prepared', slot,
        retiredCalls: [...(record.retiredCalls ?? []), record.callID!] });
    } else this.durable.questions!.write(sessionID, { ...record, state: 'cancelled', sequence: record.sequence + 1 });
  }

  releasePendingQuestion(sessionID: string, attested: boolean, resetCallID?: string): boolean {
    if (!this.pendingQuestionOwner(sessionID)) {
      // The writer is no longer held for it, so there is nothing to hand off; the record itself
      // still has to be settled, and only on the user's word, never by inference.
      const orphan = this.#sessions.has(sessionID) ? undefined : this.#orphanQuestion(sessionID);
      if (!orphan || !attested) return false;
      this.#retireQuestionRecord(sessionID, orphan);
      return true;
    }
    if (!attested) throw new Error('Releasing an interrupted native question needs the exact latest user attestation.');
    const record = this.durable.questions!.read(sessionID)!;
    if (!resetCallID) throw new Error('A reset reservation is required before question recovery.');
    this.runner.handoffRecoveredQuestion?.(sessionID, record.callID!, resetCallID);
    if (record.state === 'answered') {
      const { callID: _callID, answer: _answer, reservation: _reservation, ...rest } = record;
      const slot = structuredClone(record.slot);
      slot.args.questions[0]!.question += ` [MDD re-present ${randomUUID()}]`;
      this.durable.questions!.write(sessionID, { ...rest, sequence: record.sequence + 1, state: 'prepared', slot,
        retiredCalls: [...(record.retiredCalls ?? []), record.callID!] });
    } else this.durable.questions!.write(sessionID, { ...record, state: 'cancelled', sequence: record.sequence + 1 });
    return true;
  }

  /** Restore only an already registered session; never bootstrap a replacement memory identity. */
  async boundRunMemory(runtime: Runtime, project: string): Promise<EngramHttp> {
    const engram = this.#settings.engram;
    if (!engram) throw new Error('This run needs Engram, but memory is disabled.');
    const endpoint = 'endpoint' in engram ? engram.endpoint : await this.#managed!.endpoint();
    const client = new EngramHttp(endpoint, { id: runtime.sessionID, project, directory: runtime.directory });
    await client.checkBinding();
    return client;
  }


  /** Reissue only the question envelope, never its historical answer or approval. */
  recover(runtime: Runtime): void {
    if (this.#sessions.has(runtime.sessionID)) return;
    const status = this.runner.status(runtime.sessionID);
    if (!('workflow' in status) || status.workflow.nextAction.kind !== 'approve' || status.state !== 'await-approval') return;
    const checkpoint = this.durable.checkpoint?.read(runtime.sessionID)?.checkpoint;
    if (checkpoint?.version !== STABLE_CHECKPOINT_VERSION || checkpoint.runID !== status.runID ||
        checkpoint.data.directory !== runtime.directory || checkpoint.data.worktree !== runtime.worktree) {
      throw new Error('The native question cannot be bound to a validated same-parent checkpoint.');
    }
    const recorded = this.durable.questions?.read(runtime.sessionID);
    if (recorded && (recorded.runID !== status.runID ||
        (recorded.checkpoint && recorded.checkpoint.sequence > checkpoint.sequence))) throw new Error('The native question belongs to a different or newer run.');
    if (recorded && !['approval', 'clarification'].includes(recorded.slot.kind) &&
        !['settled', 'cancelled', 'withdrawn'].includes(recorded.state)) throw new Error('A different native question is unresolved; no approval was reissued.');
    const phase = status.workflow.nextAction.phase;
    if (recorded && ['prepared', 'pending', 'answered'].includes(recorded.state) && recorded.slot.phase !== phase) {
      throw new Error('The native question names another phase; no approval was reissued.');
    }
    const entry: Intake = {
      runtime: { ...runtime }, requirements: checkpoint.data.requirements, state: 'review-ready',
      receipts: [], known: { ...status.workflow.answers }, userMessageID: checkpoint.data.userMessageID,
      usedMessages: new Set(checkpoint.data.usedMessages), proposed: new Set(checkpoint.data.proposed),
      clarifications: structuredClone(recorded?.clarifications ?? []), deferred: structuredClone(recorded?.deferred ?? []),
      clarificationAnswers: structuredClone(recorded?.clarificationAnswers ?? []),
    };
    this.#sessions.set(runtime.sessionID, entry);
    try {
      if (recorded && ['prepared', 'pending', 'answered'].includes(recorded.state)) {
        const slot: Slot = structuredClone(recorded.slot);
        slot.args.questions[0]!.question += ` [MDD re-present ${randomUUID()}]`;
        this.#slot(entry, slot, true);
        entry.notice = 'The earlier native question is not consent. Ask this newly issued question and use only its fresh native answer.';
        this.#reissued.add(runtime.sessionID);
      }
      if (recorded?.state === 'cancelled') this.#reissued.add(runtime.sessionID);
    } catch (error) { this.#sessions.delete(runtime.sessionID); throw error; }
  }

  async start(value: unknown, runtime: Runtime, messageID: string): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only mdd-orchestrator may start MDD.');
    // The intake of a run that moved to another conversation governs nothing here any more.
    if (this.runner.movedAway?.(runtime.sessionID)) this.#forget(runtime.sessionID);
    if (!this.#sessions.has(runtime.sessionID) && this.#unresolved(runtime.sessionID)) throw new Error('A native question in this parent has an unresolved outcome. Inspect mdd_status and explicitly discard the run before starting another.');
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
    this.runner.owner?.(runtime.sessionID);
    if (this.#sessions.get(runtime.sessionID) !== previous) throw new Error('Intake changed during setup inspection; read mdd_status.');
    // A restarted process has no previous intake, but the run it lost may have consumed user
    // messages and change proposals. Those guards are restored; the receipts that recorded actual
    // consent are not, because their call IDs would look like approvals this run never received.
    const guards = previous ? undefined : this.runner.priorGuards?.(runtime.sessionID);
    const entry: Intake = { runtime: { ...runtime }, requirements, state: 'starting', receipts: previous?.receipts ?? [], known: { ...this.#profile.answers }, usedMessages: new Set(previous?.usedMessages ?? guards?.usedMessages), proposed: new Set(previous?.proposed ?? guards?.proposed), clarifications: [], deferred: [], clarificationAnswers: [], ...(context ? { context } : {}), ...(previous ? { replacing: true } : {}) };
    if (previous) entry.restore = { state: previous.state, requirements: previous.requirements, known: previous.known, clarifications: previous.clarifications, deferred: previous.deferred, clarificationAnswers: previous.clarificationAnswers, ...(previous.slot ? { slot: previous.slot } : {}), ...(previous.userMessageID ? { userMessageID: previous.userMessageID } : {}) };
    this.#sessions.set(runtime.sessionID, entry);
    try {
      // An objective may be older than the last thing the user said: a continuation message never
      // replaces the request it continues. Consent paths keep requiring the latest user text.
      const userID = pending?.userMessageID ?? await this.inspect.intake(entry.runtime, requirements, boundedText(messageID, 'native messageID', 256), 'objective');
      this.runner.owner?.(runtime.sessionID);
      if (typeof userID === 'string') {
        if (entry.usedMessages.has(userID)) throw new Error('This user message was already used; wait for an actual new request.');
        entry.userMessageID = userID; entry.usedMessages.add(userID);
        // A finished run a restart left unloaded is closed now, as the same run would be replaced
        // in process: the new objective is proven native, and the old evidence is set aside.
        if (!previous) this.runner.closeForFreshStart?.(runtime.sessionID);
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
      if (previous?.intakeToken && ['blocked', 'stopped'].includes(previous.state))
        this.durable.ownership?.retireIntake(runtime.sessionID, previous.intakeToken);
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
    if (!entry || entry.restore || !['active', 'review-ready', 'paused', 'question-ready', 'stopped', 'blocked'].includes(entry.state) ||
        (entry.state === 'question-ready' && !['approval', 'clarification'].includes(entry.slot?.kind ?? '')) ||
        (entry.state === 'blocked' && entry.slot?.callID && !entry.receipts.some(item => item.callID === entry.slot!.callID))) throw new Error('Finish or dismiss the current native interaction before requesting a change.');
    if (this.runner.status(runtime.sessionID).state !== 'not-started') this.runner.assertChangeable?.(runtime.sessionID);
    const userText = boundedText(input.userText, 'actual user request', 12000);
    const advisory = concerns(input.concerns);
    const requirements = input.kind === 'rerun' ? entry.requirements : boundedText(input.requirements, 'proposed requirements', 12000);
    if (input.kind === 'rerun' && (input.requirements !== undefined || advisory.length)) throw new Error('A preflight rerun retains requirements; use material change for a new objective.');
    if (input.kind === 'material' && requirements.trim() === entry.requirements.trim()) throw new Error('A material change needs requirements that differ from the current ones. Ordinary plan choices do not require this path.');
    const saved = { state: entry.state, requirements: entry.requirements, known: entry.known, clarifications: [...entry.clarifications], deferred: [...entry.deferred], clarificationAnswers: [...entry.clarificationAnswers], ...(entry.slot ? { slot: entry.slot } : {}), ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}) };
    entry.state = 'accepting';
    try {
      const userID = await this.inspect.intake(runtime, userText, boundedText(messageID, 'native messageID', 256));
      this.runner.owner?.(runtime.sessionID);
      const status = this.runner.status(runtime.sessionID);
      // A fresh user message asking for the change is authority enough. Only when that message was
      // already spent must the proposal rest on concerns a phase actually recorded.
      const backedConcern = input.kind === 'material' && advisory.length > 0 && 'concerns' in status && advisory.every(item => status.concerns.some(known => isDeepStrictEqual(known, item)));
      if (!userID) throw new Error('Change requests require the actual latest user message, not a model approval claim.');
      if (entry.usedMessages.has(userID) && !backedConcern) throw new Error(input.kind === 'material'
        ? 'This user message was already used by MDD. Ask the user to state the change in a new message, or back the proposal with concerns a phase already recorded.'
        : 'This user message was already used by MDD. A rerun needs a new user message asking for it.');
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
        (entry.state === 'question-ready' && !['approval', 'clarification'].includes(entry.slot?.kind ?? '')))) {
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
    if (entry && !['active', 'review-ready', 'paused'].includes(entry.state)) throw new Error('Finish or dismiss the pending native interaction before contributing context; nothing was recorded.');
    this.runner.contribute(value, runtime);
    return this.status(runtime.sessionID);
  }

  /** Review must finish before the native phase approval is ever offered. */
  prepareAdvance(value: unknown, runtime: Runtime): unknown {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may prepare phase advancement.');
    const entry = this.#sessions.get(runtime.sessionID);
    if (!entry || !['review-ready', 'paused'].includes(entry.state)) throw new Error('Phase review is not ready; no approval was changed.');
    const status = this.runner.status(runtime.sessionID);
    if (!('workflow' in status) || status.workflow.nextAction.kind !== 'approve') throw new Error('No phase is awaiting approval.');
    const input = objectWithKeys(value, 'advance preparation', ['questions']);
    if (!Array.isArray(input.questions) || input.questions.length > 8) throw new Error('Provide up to eight clarification questions, or an empty array when none remain.');
    const questions: Clarification[] = input.questions.map(raw => {
      const item = objectWithKeys(raw, 'clarification', ['question', 'options', 'deferrable']);
      const question = boundedText(item.question, 'clarification question', 1000);
      if (!Array.isArray(item.options) || !item.options.length || item.options.length > 6 || (item.deferrable !== undefined && typeof item.deferrable !== 'boolean')) throw new Error('Clarifications require one to six options and a boolean deferrable flag.');
      const options = item.options.map(rawOption => {
        const option = objectWithKeys(rawOption, 'clarification option', ['label', 'description', 'recommended']);
        if (option.recommended !== undefined && typeof option.recommended !== 'boolean') throw new Error('recommended must be boolean.');
        return { label: boundedText(option.label, 'option label', 100), description: boundedText(option.description, 'option description', 500), recommended: option.recommended === true };
      });
      const labels = options.map(clarificationOptionLabel);
      if (new Set([...labels, CLARIFICATION_LABELS.defer, CLARIFICATION_LABELS.delegate]).size !== labels.length + 2) throw new Error('Clarification option labels must be unique and not reserved.');
      return { question, options, deferrable: item.deferrable === true };
    });
    if (questions.length) {
      // A question explicitly re-offered by the coordinator replaces its pending copy.
      const named = new Set(questions.map(item => item.question));
      entry.clarifications = [...entry.clarifications.filter(item => !named.has(item.question)), ...questions];
    }
    delete entry.reason;
    this.#nextReviewQuestion(entry);
    return this.status(runtime.sessionID);
  }

  /** A question or edit may return to review without accepting or declining a pending approval. */
  revisit(runtime: Runtime): unknown {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may revisit phase review.');
    const entry = this.#sessions.get(runtime.sessionID);
    if (!entry || entry.state !== 'question-ready' || !['approval', 'clarification'].includes(entry.slot?.kind ?? '')) throw new Error('No idle phase question can be revisited.');
    this.#persistQuestion(entry, 'withdrawn');
    delete entry.slot;
    entry.clarifications = entry.clarifications.filter(item =>
      entry.clarificationAnswers.findLast(answer => answer.question === item.question)?.disposition === 'deferred');
    entry.state = 'review-ready';
    entry.notice = 'The phase question was withdrawn without approval. Answer the user or edit the plan, then prepare advancement again.';
    return this.status(runtime.sessionID);
  }

  #nextReviewQuestion(entry: Intake): void {
    const status = this.runner.status(entry.runtime.sessionID);
    if (!('workflow' in status) || status.workflow.nextAction.kind !== 'approve') throw new Error('No phase is awaiting approval.');
    const phase = status.workflow.nextAction.phase;
    const item = entry.clarifications[0];
    const args = item ? clarificationEnvelope(item) : approvalEnvelope(status.runID, phase, status.reportDetail !== 'detailed');
    if (this.#reissued.delete(entry.runtime.sessionID)) args.questions[0]!.question += ` [MDD re-present ${randomUUID()}]`;
    this.#slot(entry, { kind: item ? 'clarification' : 'approval', phase, args });
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
  reset(runtime: Runtime, scope: 'phase' | 'run' | 'rework'): unknown {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may reset MDD state.');
    const entry = this.#sessions.get(runtime.sessionID);
    // Releasing the phase of a conversation whose run never started is really about the question
    // the user is stuck on, so the pending one is re-opened rather than the intake discarded.
    if (scope === 'phase' && entry?.slot && entry.state !== 'active' && !('runID' in (this.runner.status(runtime.sessionID) as object))) {
      const pending: Slot = { ...entry.slot };
      delete pending.callID;
      delete entry.restore; delete entry.reason;
      this.#slot(entry, pending, true);
      entry.notice = 'The pending question was re-opened. Nothing was approved or recorded: ask it again exactly as mdd_status returns it.';
      return { ...this.status(runtime.sessionID), reset: { scope: 'phase' as const } };
    }
    const intakeToken = this.durable.ownership?.intake(runtime.sessionID)?.token;
    const applied = this.runner.reset?.(runtime.sessionID, scope) ?? { scope: 'run' as const };
    if (applied.scope === 'run') {
      if (intakeToken) {
        const current = this.durable.ownership?.intake(runtime.sessionID);
        if (current?.state !== 'retired') this.durable.ownership?.retireIntake(runtime.sessionID, intakeToken);
      }
      this.durable.questions?.clear(runtime.sessionID); this.#forget(runtime.sessionID);
    }
    else if (entry) {
      delete entry.slot; delete entry.reason; delete entry.restore; delete entry.replacing;
      entry.state = 'active';
      entry.notice = applied.scope === 'rework'
        ? `Verification failed and the user chose to correct it: ${applied.phase ?? 'mdd-apply'} is ready again with the verification findings as its newest input. Verification follows it through the route's ordinary approval. Previous evidence is retained.`
        : applied.approval
        ? `The run was released at its approval boundary: ${applied.phase ?? 'the next phase'} is waiting for the same approval question again. Nothing was approved and previous evidence is retained.`
        : `The ${applied.phase ?? 'current'} phase was released and is ready to run again. Previous evidence is retained.`;
      // A run released while it waited for approval still needs that approval, so its question is
      // re-armed here instead of leaving the conversation with nothing to answer.
      this.phaseRecorded(runtime.sessionID);
    }
    return { ...this.status(runtime.sessionID), reset: applied };
  }

  /**
   * The memory client for work that is not a run. Lessons outlive runs by design, so they cannot
   * depend on one existing: this binds the same conversation the same way `start` does, and every
   * caller treats a failure as "memory is unavailable", never as a reason to lose the lesson.
   */
  async #memory(runtime: Runtime): Promise<EngramHttp | undefined> {
    const engram = this.#settings.engram;
    if (!engram) return undefined;
    const endpoint = 'endpoint' in engram ? engram.endpoint : await this.#managed!.endpoint();
    const client = new EngramHttp(endpoint, { id: runtime.sessionID, project: '', directory: runtime.directory });
    await client.bootstrap();
    return client;
  }

  /**
   * Records something MDD did badly, in the user's own words, so a later session can find it. The
   * local file is the record; memory is the index that makes it findable from another conversation
   * months later. Writing the local copy first is deliberate: with memory off, which is the default
   * and an ordinary way to run MDD, the improvement must still be kept.
   */
  async improve(input: { title: string; detail: string; phase?: Phase }, runtime: Runtime): Promise<unknown> {
    const recorded = recordLesson(mddDataRoot(runtime.directory), {
      source: 'user', title: input.title, detail: input.detail, ...(input.phase ? { phase: input.phase } : {}),
    });
    if (!recorded.ok) {
      throw new Error(recorded.diagnostic === 'invalid-lesson'
        ? 'The improvement needs a short title and a detail describing what went wrong, both plain text within their limits. Nothing was recorded.'
        : 'The local improvements file could not be written, so nothing was recorded. Inspect the .mdd directory.');
    }
    let memory: 'saved' | 'unavailable' | 'off' = this.#settings.engram ? 'unavailable' : 'off';
    try {
      const client = await this.#memory(runtime);
      if (client) {
        await client.saveLesson(`${LESSON_TITLE_PREFIX} ${recorded.recorded.title}`.slice(0, 200),
          JSON.stringify({ kind: 'mdd-improvement', ...recorded.recorded, workspace: runtime.directory }));
        memory = 'saved';
      }
    } catch { /* The local record already holds it; memory is an index, not the record. */ }
    return {
      recorded: recorded.recorded, total: recorded.total, memory,
      ...(recorded.pruned ? { pruned: recorded.pruned } : {}),
      note: memory === 'saved'
        ? 'Recorded locally in .mdd/lessons.jsonl and indexed in memory so a later session can find it.'
        : memory === 'off'
          ? 'Recorded locally in .mdd/lessons.jsonl. Optional memory is off, so it is findable in this workspace only.'
          : 'Recorded locally in .mdd/lessons.jsonl. The memory service did not answer, so it was not indexed; say so rather than claiming it was.',
    };
  }

  /**
   * Answers "what have I been told I do badly". Local entries are the answer; memory adds the ones
   * recorded in other conversations. A memory that does not answer degrades to the local list with
   * that fact stated, because a review presented as complete when half of it is missing is worse
   * than a short review that says so.
   */
  async improvements(query: { text?: string; state?: LessonState; limit?: number }, runtime: Runtime): Promise<unknown> {
    const local = readLessons(mddDataRoot(runtime.directory), query);
    if (!local.ok) throw new Error('The local improvements file could not be read. Inspect the .mdd directory.');
    let memory: 'searched' | 'unavailable' | 'off' = this.#settings.engram ? 'unavailable' : 'off';
    let remote: { id: number; title: string; content: string; created: string | undefined }[] = [];
    try {
      const client = await this.#memory(runtime);
      if (client) {
        remote = await client.searchLessons(query.text ?? '', Math.min(50, Math.max(1, query.limit ?? 20)));
        memory = 'searched';
      }
    } catch { /* The local list is still the answer. */ }
    // Memory holds the same entries this workspace already has, so only rows whose id is not local
    // are reported separately: presenting a lesson twice makes a review look bigger than it is.
    const known = new Set(local.lessons.map(lesson => lesson.id));
    const elsewhere = remote.filter(row => {
      try { return !known.has(String((JSON.parse(row.content) as { id?: unknown }).id ?? '')); } catch { return true; }
    });
    return {
      lessons: local.lessons, total: local.total, memory,
      ...(elsewhere.length ? { fromMemory: elsewhere } : {}),
      report: renderLessonsReport(local.lessons, local.total),
      instruction: 'Present report as it is: it is already written for the user. Never invent an improvement that is not listed here.',
    };
  }

  status(sessionID: string) {
    const entry = this.#sessions.get(sessionID);
    const status = this.runner.status?.(sessionID) ?? { state: 'not-started' };
    const memory = this.#settings.engram ? 'enabled' : 'off';
    if (!entry) {
      if (this.#unresolved(sessionID)) return { ...status, state: 'recovery-blocked', memory, question: undefined, task: undefined,
        provenance: undefined, questionReceipts: [], reason: 'A native question outcome is unconfirmed. Do not ask again or infer an answer. Reinspect native history before any future restoration; explicit run discard remains available.' };
      return { ...status, memory, question: undefined, provenance: undefined, questionReceipts: [] };
    }
    const side = 'contextual' in status && status.contextual;
    const state = entry.state === 'active' || side ? status.state : entry.state;
    return { ...status, state, memory, ...(entry.reason ? { reason: entry.reason } : {}),
      task: (entry.state === 'active' || side) && 'task' in status ? status.task : undefined,
      ...(entry.state !== 'active' && !side ? { next: { kind: entry.state === 'question-ready' ? 'question' : entry.state === 'review-ready' ? 'review' : 'wait', ...(entry.slot?.phase ? { phase: entry.slot.phase } : {}) } } : {}),
      question: entry.state === 'question-ready' && !side ? structuredClone(entry.slot!.args) : undefined,
      clarificationAnswers: structuredClone(entry.clarificationAnswers),
      pendingClarifications: structuredClone([...entry.deferred, ...entry.clarifications.filter(item => entry.clarificationAnswers.some(answer => answer.question === item.question && answer.disposition === 'deferred'))]),
      notice: entry.notice,
      provenance: entry.provenance ? { ...entry.provenance } : undefined,
      questionReceipts: structuredClone(entry.receipts),
      ...(entry.state === 'await-answer' ? { reason: 'Native question is pending or uncertain. Do not repeat it or dispatch a task.' } : {}),
    };
  }

  /** An MDD question of a run that moved to another conversation can never answer anything here. */
  #refuseMovedAway(call: TaskCall, args: unknown): void {
    if (!this.runner.movedAway?.(call.sessionID)) return;
    if (this.#sessions.has(call.sessionID) || this.#owned(args))
      throw new Error('This conversation\'s run moved to another conversation; its native questions cannot approve or answer anything here.');
  }

  async beforeQuestion(call: TaskCall, args: unknown): Promise<void> {
    this.#refuseMovedAway(call, args);
    const owner = this.runner.owner?.(call.sessionID);
    const entry = this.#entry(call, args);
    if (!entry) { if (owner) throw new Error('Native question has no restored intake; no answer is authorized.'); return; }
    if (entry.slot?.kind === 'preflight') this.#assertIntake(entry);
    // While MDD has a question pending, that one is the only question that may run: anything else
    // leaves the user answering two things at once, and an altered copy of it is a forgery.
    // Otherwise a question MDD never issued belongs to the coordinator, and asking the user
    // something of its own is ordinary work: treating that as MDD's own turned a clarification
    // between phases into a blocked run.
    if (entry.state === 'question-ready') {
      if (!isDeepStrictEqual(args, entry.slot!.args)) throw new Error('Question arguments differ from the pending question; no answer was accepted.');
    } else if (!this.#owned(args)) {
      if (entry.state === 'accepting' || entry.state === 'await-answer') throw new Error('A native MDD question is already pending; no unrelated question may run.');
      return;
    }
    const status = this.runner.status(call.sessionID);
    if ('contextual' in status && status.contextual) throw new Error('Wait for the contextual exploration before answering the main approval.');
    if (entry.state !== 'question-ready') return this.#fail(entry, new Error('Unexpected, duplicate, or changed native question.'));
    const reserved = this.runner.reserve?.(call.sessionID, call.callID);
    const held = this.runner.status(call.sessionID).state;
    // Recorded with the question so a restart can prove which run and settled state it holds.
    if (reserved && ['ready', 'await-approval', 'blocked', 'complete'].includes(held)) entry.reserved = { runID: reserved.runID, stable: held as Reservation['stable'] };
    else delete entry.reserved;
    entry.state = 'accepting';
    try {
      entry.slot!.callID = boundedText(call.callID, 'native question callID', 256);
      if (entry.receipts.some(receipt => receipt.callID === call.callID)) throw new Error('Native question call ID was already consumed.');
      if (this.durable.questions?.read(call.sessionID)?.retiredCalls?.includes(call.callID)) throw new Error('Native question call ID belongs to an earlier question.');
      this.#persistQuestion(entry, 'pending');
      await this.inspect.question(entry.runtime, call, entry.slot!.args);
      this.runner.owner?.(call.sessionID, call.callID);
      if (entry.state !== 'accepting') throw new Error('Question became uncertain before execution.');
      entry.state = 'await-answer';
    } catch (error) { this.runner.release?.(call.sessionID, call.callID); delete entry.reserved; this.#fail(entry, error); }
  }

  /**
   * A native question whose answer could not be accepted still ended. Its durable record is
   * settled first — a pending one is cancelled, an answered one keeps its unapplied answer — and
   * only then is the writer released, so the parent is never left locked by a finished call.
   */
  #abandonQuestion(entry: Intake, call: TaskCall): void {
    try {
      const record = this.durable.questions?.read(call.sessionID);
      if (record?.callID === call.callID && record.state === 'pending')
        this.durable.questions!.write(call.sessionID, { ...record, state: 'cancelled', sequence: record.sequence + 1 });
      const settled = this.durable.questions?.read(call.sessionID);
      if (!this.durable.questions || (settled?.callID === call.callID && ['cancelled', 'answered', 'settled'].includes(settled.state)) ||
          (settled && settled.callID !== call.callID)) {
        this.runner.release?.(call.sessionID, call.callID);
        delete entry.reserved;
      }
    } catch { /* The record is unconfirmed: the reservation stays, and reset needs the user's word. */ }
  }

  async afterQuestion(call: TaskCall, args: unknown, output: unknown): Promise<void> {
    this.#refuseMovedAway(call, args);
    const owner = this.runner.owner?.(call.sessionID, call.callID);
    const entry = this.#entry(call, args);
    if (!entry || !this.#owned(args)) { if (owner) throw new Error('Native question callback has no current issued question; no answer was accepted.'); return; }
    if (this.durable.questions?.read(call.sessionID)?.retiredCalls?.includes(call.callID))
      throw new Error('Native question call was retired; its old answer cannot affect the fresh question.');
    const slot = entry.slot;
    if (slot?.kind === 'preflight') this.#assertIntake(entry);
    if (entry.state !== 'await-answer' || !slot || slot.callID !== call.callID || !isDeepStrictEqual(args, slot.args)) {
      return this.#fail(entry, new Error('Native answer does not match the pending parent, call, and question.'));
    }
    entry.state = 'accepting';
    try {
      await this.inspect.question(entry.runtime, call, slot.args);
      this.runner.owner?.(call.sessionID, call.callID);
      if (entry.state !== 'accepting') throw new Error('Question became uncertain during result inspection.');
      let selections: string[][];
      try { selections = nativeQuestionAnswers(slot.args, output); }
      catch (error) {
        if (!(error instanceof UnselectedAnswer) || slot.kind !== 'clarification') throw error;
        selections = [[boundedText(error.text, 'free-text clarification', 12000)]];
      }
      // A native callback is evidence of an answer, not replayable consent. Persist its exact
      // selections before any approval or plan transition; an incomplete write blocks the route.
      this.#persistQuestion(entry, 'answered', selections);
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
      else if (slot.kind === 'clarification') {
        const item = entry.clarifications[0]!;
        const answer = selections[0]![0]!;
        const deferred = answer === CLARIFICATION_LABELS.defer;
        // A deferral is context, not a choice: the next actor must not silently decide it.
        this.runner.contribute?.({ label: `Clarification: ${item.question}`, content: deferred
          ? 'Deferred by the user; unresolved. Do not assume a choice. Continue only with work safe without this decision.'
          : `Answer: ${answer}` }, entry.runtime);
        entry.clarificationAnswers.push({ question: item.question, answer, phase: slot.phase!, disposition: deferred ? 'deferred' : 'answered' });
        if (deferred) entry.deferred.push(item);
        entry.clarifications.shift();
        this.#nextReviewQuestion(entry);
      } else if (selections[0]![0] === APPROVAL_LABELS.pause) {
        entry.state = 'paused';
        entry.reason = 'The user paused before the next phase. No phase was authorized or rejected.';
        this.runner.approvalStopped?.(call.sessionID);
      } else if (selections[0]![0] === APPROVAL_LABELS.detail) {
        const current = this.runner.status(call.sessionID);
        if (!('runID' in current) || !slot.phase) throw new Error('Phase detail is no longer available.');
        this.#slot(entry, { kind: 'approval', phase: slot.phase, args: approvalEnvelope(current.runID, slot.phase) });
        entry.notice = 'Show the full phase report and relevant artifact from mdd_status(detail="full") before asking this approval again. Nothing was approved.';
      } else {
        this.runner.approveNative(call.sessionID, slot.phase!);
        entry.state = 'active';
        delete entry.notice;
      }
      entry.receipts.push({ kind: slot.kind, ...(slot.phase ? { phase: slot.phase } : {}), callID: call.callID, answers: selections });
      this.#recordConsent(entry);
      if (entry.slot === slot) this.#persistQuestion(entry, 'settled');
      this.runner.release?.(call.sessionID, call.callID);
      delete entry.reserved;
    } catch (error) {
      if (error instanceof UnselectedAnswer) { this.#unanswered(entry, slot, call); this.runner.release?.(call.sessionID, call.callID); delete entry.reserved; return; }
      this.#abandonQuestion(entry, call);
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
    this.#persistQuestion(entry, 'cancelled');
    entry.receipts.push({ kind: slot.kind, ...(slot.phase ? { phase: slot.phase } : {}), callID: call.callID, answers: [], cancelled: true });
    this.#recordConsent(entry);
    if (slot.kind === 'change' && entry.restore) {
      this.#restore(entry, 'The user did not confirm the change in their answer, so the current run, its answers and its approval are unchanged. Read what they actually said before proposing anything again.');
      return;
    }
    const pending: Slot = { ...slot };
    delete pending.callID;
    this.#slot(entry, pending, true);
    entry.notice = slot.kind === 'approval'
      ? 'The user answered in their own words instead of choosing an option, so no phase was approved and nothing was recorded. Read what they actually said and respond to it; when the phase should still go ahead, ask the same approval question again exactly as mdd_status returns it. If their message changes the objective, use mdd_change_request instead.'
      : slot.kind === 'clarification'
      ? 'The phase was not approved. Read the user\'s words and respond to them; this clarification remains pending. Ask the same clarification question again exactly as mdd_status returns it.'
      : 'The user answered in their own words instead of choosing an option, so the run has not started and no answer was recorded. Respond to what they said, then ask the same preflight question again exactly as mdd_status returns it.';
  }

  phaseRecorded(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    if (!entry || entry.state !== 'active') return;
    const status = this.runner.status(sessionID);
    if (!('workflow' in status) || status.state === 'blocked') return;
    const next = status.workflow.nextAction;
    if (next.kind === 'approve') {
      const old = entry.slot;
      entry.state = 'review-ready'; delete entry.slot; delete entry.notice;
      // Only a completed subsequent phase makes deferred questions eligible again. Never re-offer
      // them at the approval immediately following the original deferral.
      entry.clarifications = entry.deferred;
      entry.deferred = [];
      if (old?.callID) this.#persistQuestion(entry, 'settled', undefined, old);
    }
  }

  guardTask(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    const status = this.runner.status(sessionID);
    if ('contextual' in status && status.contextual) return;
    if (entry && entry.state !== 'active') throw new Error('A task cannot execute before accepted preflight or its exact phase approval.');
  }

  nativeError(call: TaskCall): void {
    this.runner.owner?.(call.sessionID, call.callID);
    const entry = this.#sessions.get(call.sessionID);
    if (!entry || entry.slot?.callID !== call.callID || !['accepting', 'await-answer'].includes(entry.state)) return;
    this.#persistQuestion(entry, 'cancelled');
    entry.receipts.push({ kind: entry.slot.kind, callID: call.callID, answers: [], cancelled: true });
    this.#recordConsent(entry);
    this.runner.release?.(call.sessionID, call.callID);
    delete entry.reserved;
    if (entry.restore) { this.#restore(entry, 'Change cancelled; the current plan and approval are unchanged.'); return; }
    if (['approval', 'clarification'].includes(entry.slot.kind)) {
      entry.state = 'paused';
      entry.reason = 'The native phase question was dismissed. The run and unresolved questions remain; no phase was authorized.';
      return;
    }
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
   * Every envelope MDD ever issued stays registered, so a stale one is still recognised as a
   * replay rather than mistaken for a question of the coordinator's own. That record belongs to
   * the conversation, though: once a run is forgotten, keeping its envelopes would grow this map
   * for the life of the process and slow down every question that has to be matched against it.
   */
  #forget(sessionID: string): void {
    this.#reissued.delete(sessionID);
    for (const [question, owner] of this.#questionOwners) if (owner === sessionID) this.#questionOwners.delete(question);
    this.#sessions.delete(sessionID);
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

  #claimIntake(entry: Intake): void {
    if (!this.durable.ownership) return;
    const parent = entry.runtime.sessionID;
    const current = this.durable.ownership.intake(parent);
    if (entry.intakeToken && current?.state === 'pending' && current.token === entry.intakeToken) return;
    if (!entry.userMessageID) throw new Error('Native intake needs a proven user message before reserving its question.');
    const token = randomUUID();
    this.durable.ownership.claimIntake(parent, token, entry.userMessageID);
    entry.intakeToken = token;
  }

  #assertIntake(entry: Intake): void {
    if (!this.durable.ownership) return;
    const current = this.durable.ownership.intake(entry.runtime.sessionID);
    if (!entry.intakeToken || current?.token !== entry.intakeToken || current.state !== 'pending')
      throw new Error('The native preflight question is no longer owned by this intake.');
  }

  #slot(entry: Intake, slot: Slot, reissued = false): void {
    if (slot.kind === 'preflight') this.#claimIntake(entry);
    const next = structuredClone(slot);
    // Ownership compares envelope values across all parents. Equal wording and options must not
    // let another session's first registered question claim this one.
    if (slot.kind === 'clarification' && !reissued) {
      next.args.questions[0]!.question += ` [MDD clarification ${randomUUID()}]`;
    }
    this.#persistQuestion(entry, 'prepared', undefined, next);
    entry.slot = next;
    entry.state = 'question-ready';
    this.#questionOwners.set(entry.slot.args, entry.runtime.sessionID);
  }

  #unresolved(sessionID: string): QuestionRecord | undefined {
    const record = this.durable.questions?.read(sessionID);
    return record && !['settled', 'cancelled', 'withdrawn'].includes(record.state) ? record : undefined;
  }

  #persistQuestion(entry: Intake, state: QuestionRecord['state'], answer?: string[][], slot = entry.slot): void {
    if (!this.durable.questions || !slot) return;
    const parent = entry.runtime.sessionID;
    const old = this.durable.questions.read(parent);
    const status = this.runner.status(parent);
    const runID = slot.kind === 'preflight' ? undefined : 'runID' in status ? status.runID as string : undefined;
    if (slot.kind !== 'preflight' && !runID) throw new Error('Native question cannot be bound to a live run.');
    // A question that holds the writer records which run and settled state it reserved, including
    // a re-preflight of an existing run, which has no runID of its own.
    const reservation = entry.reserved && !['prepared', 'withdrawn'].includes(state) ? entry.reserved : undefined;
    // The outcome of an issued question keeps the binding it was issued against; only preparing or
    // issuing a question binds it to the checkpoint as it is now.
    const inherited = !['prepared', 'withdrawn', 'pending'].includes(state) && old?.callID !== undefined && old.callID === slot.callID;
    let binding: QuestionRecord['checkpoint'];
    if (inherited) binding = old!.checkpoint;
    else {
      const bound = runID ?? reservation?.runID;
      const checkpoint = bound ? this.durable.checkpoint?.read(parent)?.checkpoint : undefined;
      // A run whose checkpoint was degraded to data-only has nothing to bind; its question still records.
      const unbound = !!bound && !checkpoint && this.runner.resumable?.(parent) === false;
      if (bound && this.durable.checkpoint && !unbound && (checkpoint?.version !== STABLE_CHECKPOINT_VERSION || checkpoint.runID !== bound)) {
        throw new Error('Native question cannot be bound to the current durable run checkpoint.');
      }
      binding = checkpoint && checkpoint.version === STABLE_CHECKPOINT_VERSION ? { sequence: checkpoint.sequence, digest: checkpoint.dataDigest } : undefined;
    }
    const held = inherited ? old!.reservation : reservation;
    const record: QuestionRecord = {
      version: 1, parent, sequence: (old?.sequence ?? -1) + 1,
      requirements: entry.requirements, known: structuredClone(entry.known),
      ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}),
      ...(entry.context ? { context: { ...entry.context } } : {}),
      ...(runID ? { runID } : {}),
      ...(held ? { reservation: { ...held } } : {}),
      ...(binding ? { checkpoint: { ...binding } } : {}),
      state, slot: (({ callID: _callID, ...data }) => structuredClone(data))(slot), clarifications: structuredClone(entry.clarifications),
      deferred: structuredClone(entry.deferred), clarificationAnswers: structuredClone(entry.clarificationAnswers),
      ...(!['prepared', 'withdrawn'].includes(state) ? { callID: slot.callID! } : {}),
      ...(state === 'answered' ? { answer: structuredClone(answer!) } : {}),
      ...((old?.retiredCalls?.length || (state === 'prepared' && old?.callID))
        ? { retiredCalls: [...(old?.retiredCalls ?? []), ...(state === 'prepared' && old?.callID && !old.retiredCalls?.includes(old.callID) ? [old.callID] : [])] } : {}),
    };
    this.durable.questions.write(parent, record);
  }

  async #startRunner(entry: Intake, selections: unknown, source: 'startup-profile' | 'native-question'): Promise<void> {
    const expectedState = entry.state;
    const engram = entry.memory;
    // Handed over before the run exists, so the record the runner writes at start already carries
    // the guards rather than waiting for the first phase to close.
    this.#recordConsent(entry);
    await this.runner.start({ requirements: entry.requirements, preflight: { answers: answersFromLabels(entry.known, selections) },
      ...(entry.context ? { context: entry.context } : {}),
      ...(engram ? { engramEndpoint: engram.endpoint, project: engram.project } : {}) }, entry.runtime, { requirementsConfirmed: true, ...(entry.replacing ? { replace: true } : {}), ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}), ...(entry.slot?.callID ? { authorityCallID: entry.slot.callID } : {}) });
    if (entry.intakeToken) this.durable.ownership?.settleIntake(entry.runtime.sessionID, entry.intakeToken);
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
