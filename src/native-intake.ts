import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { EngramHttp, KnowledgeWriteUnknownError, LESSON_TITLE_PREFIX, mddDataRoot } from './engram-http.js';
import { KNOWLEDGE_NOTE, captureKnowledgeDependencies, knowledgeFreshness, knowledgeObservation, knowledgeSummary, parseKnowledgeQuery, parseKnowledgeRequest, queryKnowledge, selectKnowledge } from './project-knowledge.js';
import { emptyKnowledgeLookup, type KnowledgeLookup, type KnowledgeSelection } from './project-knowledge.js';
import { readKnowledgeCatalog } from './knowledge-catalog.js';
import { KnowledgeCache } from './knowledge-cache.js';
import { readLessons, recordLesson, renderLessonsReport } from './lessons.js';
import type { LessonState } from './lessons.js';
import { boundedText, nonemptyText, runContext } from './phase-runner.js';
import type { PhaseRunner, Runtime, TaskCall } from './phase-runner.js';
import { answersFromLabels, questionEnvelope } from './preflight.js';
import type { QuestionEnvelope } from './preflight.js';
import type { Answers, Phase } from './policy.js';
import { freezeProfile, parseSettings } from './settings.js';
import { ManagedMemory } from './managed-memory.js';
import { objectWithKeys } from './validation.js';
import { concerns } from './concerns.js';
import type { Concern } from './concerns.js';
import { bullets, quoted, section, WHY_PREFIX, whyBrief } from './question-brief.js';
import { STABLE_CHECKPOINT_VERSION } from './checkpoint.js';
import type { CheckpointStore } from './checkpoint.js';
import { CLARIFICATION_ANSWERS_MAX, CLARIFICATIONS_MAX } from './question-checkpoint.js';
import type { Clarification, QuestionCheckpointStore, QuestionRecord } from './question-checkpoint.js';
import type { RunOwnershipStore } from './run-ownership.js';
import { typedSelections } from './typed-answer.js';
import type { TypedEvidence } from './typed-answer.js';
import { adaptiveContract } from './adaptive-low.js';
import { AdaptiveNative } from './adaptive-native.js';
import { AdaptiveProtocol } from './adaptive-protocol.js';
import type { SessionPreferences, SessionPreferenceStore } from './session-preferences.js';

/**
 * Which user text may prove a request: the latest message; any message in this conversation; the
 * latest message answered by the current native coordinator turn; or, for adaptive entry, any
 * message in this conversation answered from the current native coordinator turn.
 */
export type IntakeScope = 'latest' | 'objective' | 'native-current' | 'native-current-objective';
export type IntakeInspect = {
  setupPending?(runtime: Runtime, requirements?: string, messageID?: string): Promise<{ requirements: string; userMessageID: string } | undefined>;
  intake(runtime: Runtime, requirements: string, messageID: string, scope?: IntakeScope): Promise<void | string>;
  /**
   * The user turn the current native assistant caller answers. Adaptive entry compares it with the
   * message that carries the objective: an earlier request needs fresh native confirmation.
   */
  currentUser?(runtime: Runtime, callerMessageID: string): Promise<string>;
  /** Resolves to the assistant message running the exact question call, when the host can say. */
  question(runtime: Runtime, call: TaskCall, args: QuestionEnvelope): Promise<void | string>;
  /** Read-only identity check for an ordinary question; never supplies consent. */
  questionInput?(call: TaskCall): Promise<unknown>;
  /**
   * Proves `text` is exactly the user's latest message and, when `after` names question calls,
   * that it was written after one of them was shown. Returns that message's ID.
   */
  typed?(runtime: Runtime, text: string, messageID: string, after: readonly string[]): Promise<string>;
  transferLiveness?(runtime: Runtime, sourceSessionID: string, runID: string, requestDigest: string,
    assistantMessageID?: string): Promise<'running' | 'stopped' | 'unknown'>;
};
type Runner = Pick<PhaseRunner, 'start' | 'status' | 'approveNative' | 'block'> & Partial<Pick<PhaseRunner, 'admitAdaptiveInternal' | 'transferAdaptiveInternal' | 'recoverAdaptiveTransferInternal' | 'approvalStopped' | 'assertChangeable' | 'assertFreshStart' | 'closeForFreshStart' | 'contribute' | 'explore' | 'movedAway' | 'priorGuards' | 'recordConsent' | 'reset' | 'failedVerification' | 'resumable' | 'submit' | 'owner' | 'reserve' | 'release' | 'handoffRecoveredQuestion' | 'forceRoute' | 'retryRisk' | 'chooseManualRoute' | 'openQuestions' | 'takeOpenQuestions' | 'adaptiveClosed' | 'assertCoordinatorQuestionIdle'>>;
/** The run and settled state a native question reserved the durable writer against. */
type Reservation = NonNullable<QuestionRecord['reservation']>;
/** `fields` counts a preflight envelope's leading field questions; the rest are its clarifications. */
/** `brief` is the context the short form leaves out; the coordinator writes it in the chat first. */
type Slot = { kind: 'preflight' | 'approval' | 'change' | 'clarification' | 'route' | 'risk-recovery'; args: QuestionEnvelope; phase?: Phase; callID?: string; requirements?: string; fields?: number; brief?: string };
/** An answer the user gave in their own words: typed inside the form, or in a chat message. */
type Written = { source: 'form' | 'chat'; userMessageID?: string };
type Intake = {
  runtime: Runtime; requirements: string;
  intakeToken?: string;
  state: 'starting' | 'question-ready' | 'review-ready' | 'paused' | 'await-answer' | 'accepting' | 'active' | 'blocked' | 'stopped';
  slot?: Slot; reason?: string;
  provenance?: { requirements: 'native-user'; preflight: 'startup-profile' | 'session-preference' | 'native-question' | 'typed-answer'; profile: string };
  receipts: { kind: Slot['kind']; phase?: Phase; callID: string; answers: string[][]; cancelled?: true; typed?: Written }[];
  /** The native calls that showed exactly this envelope. A chat answer counts only after one of them. */
  shown?: { args: QuestionEnvelope; calls: string[] };
  /** What the user typed inside the form for each question, kept while the same question stays open. */
  typed?: { args: QuestionEnvelope; given: string[][] };
  known: Partial<Answers>; userMessageID?: string; usedMessages: Set<string>; proposed: Set<string>; replacing?: true; notice?: string;
  restore?: { state: Intake['state']; slot?: Slot; requirements: string; known: Partial<Answers>; userMessageID?: string; context?: { label: string; content: string }; clarifications: Clarification[]; deferred: Clarification[]; clarificationAnswers: { question: string; answer: string; phase: Phase; disposition: 'answered' | 'deferred' }[] };
  preferenceDefaults?: true; inherited?: true;
  memory?: { endpoint: string; project: string }; context?: { label: string; content: string };
  exploration?: { workItems: unknown[] };
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
export const CLARIFICATION_LABELS = Object.freeze({ defer: 'Dejar para más adelante', delegate: 'Que decida el agente', nothing: 'Nada que agregar' });
const CONFIGURED_STORAGE_BLOCK = 'Configured Engram persistence is unconfirmed. No local fallback, automatic retry or advancement is permitted; inspect retained records and request explicit recovery.';
/** Shown in the brief before a clarification, so the user sees what depends on the answer before giving it. */
export const CLARIFICATION_WHY_PREFIX = WHY_PREFIX;
/** A clarification header is the short topic the native question shows above it. */
const CLARIFICATION_HEADER_MAX = 30;
/**
 * Offered with every preflight that is actually asked: before any phase runs, the user can add
 * whatever the request left out, in their own words. A complete profile still starts straight
 * away; only genuine doubts from the coordinator stop it.
 */
export const PREFLIGHT_NOTE: Clarification = Object.freeze({
  header: 'Notas',
  question: '¿Hay algo más que el agente deba saber antes de empezar (dudas, restricciones, preferencias)? Escribilo con tu propia respuesta.',
  options: [{ label: CLARIFICATION_LABELS.nothing, description: 'Seguir solo con el pedido original.', recommended: false }],
  deferrable: false, note: true,
}) as Clarification;
/**
 * Offered once, exactly at the first interactive approval that follows a passed mdd-risk verdict,
 * in place of the generic approval question. `continue` authorizes only the suggested route's
 * first phase (an ordinary `approveNative`); `force` calls `Workflow.overrideRoute()` through
 * `PhaseRunner.forceRoute()` and authorizes the other tail's first phase instead; `stop` reuses
 * the existing pause semantics without authorizing or rejecting anything.
 */
export const ROUTE_LABELS = Object.freeze({ continue: 'Continuar con la ruta sugerida', force: 'Forzar la otra ruta', stop: 'Detener' });
const clarificationOptionLabel = (option: Clarification['options'][number]): string => `${option.label}${option.recommended ? ' (Recomendada)' : ''}`;

export function approvalEnvelope(runID: string, phase: Phase, detail = false): QuestionEnvelope {
  return { questions: [{ header: 'Aprobación', question: `¿Continuar con ${phase} en el run MDD ${runID}? Esto autoriza solo esta fase; los pedidos de permiso nativos siguen aplicando.`, multiple: false,
    options: [{ label: APPROVAL_LABELS.proceed, description: 'Autorizar únicamente esta fase.' }, { label: APPROVAL_LABELS.pause, description: 'Pausar sin rechazar la fase ni perder el plan.' },
      ...(detail ? [{ label: APPROVAL_LABELS.detail, description: 'Ver más información antes de tomar una decisión.' }] : [])] }] };
}

/**
 * The one native question offered instead of the generic approval, at the exact boundary where
 * `Workflow.overrideRoute()` itself is still legal: the suggested route's first tail phase awaits
 * approval and no other tail phase has run yet. `other` is the tail the verdict did not suggest.
 * The verdict and its reason are the brief: a reason of a few sentences hid the choices.
 */
export function routeEnvelope(runID: string, phase: Phase, risk: { route: 'low' | 'high'; complexity: 'low' | 'high'; reason: string }): QuestionEnvelope {
  const other = risk.route === 'low' ? 'high' : 'low';
  // The run ID stays in the question: ownership tells envelopes of different conversations apart by value.
  return { questions: [{ header: 'Ruta', question: `La evaluación de riesgo del run MDD ${runID} sugiere la ruta ${risk.route}, que empieza con ${phase}. ¿Cómo seguimos?`, multiple: false,
    options: [
      { label: ROUTE_LABELS.continue, description: `Autorizar únicamente ${phase}, el inicio de la ruta ${risk.route} sugerida.` },
      { label: ROUTE_LABELS.force, description: `Forzar la ruta ${other} en su lugar, conservando esta evaluación de riesgo tal como fue informada.` },
      { label: ROUTE_LABELS.stop, description: 'Pausar sin autorizar ni descartar ninguna ruta.' },
    ] }] };
}

export function routeBrief(risk: { complexity: 'low' | 'high'; reason: string }): string {
  return [`**Evaluación de riesgo:** complejidad ${risk.complexity}.`, `**Razón:** ${risk.reason}`].join('\n\n');
}

/**
 * Offered exactly once, only after a `blocked-risk` assessment settles (a valid failed verdict or
 * an exhausted fallback), never while the assessment is still in flight or for an unrelated block.
 * `retry` reuses `Workflow.retry()` through `PhaseRunner.retryRisk()` for a fresh `mdd-risk`
 * dispatch with no old verdict; `low`/`high` call `PhaseRunner.chooseManualRoute()`, which records
 * `routeOrigin: 'manual'` and never fabricates a `RiskVerdict`; `stop` leaves the run blocked.
 */
export const RISK_RECOVERY_LABELS = Object.freeze({
  retry: 'Reintentar evaluación de riesgo', low: 'Ruta low', high: 'Ruta high', stop: 'Detener',
});

export function riskRecoveryEnvelope(runID: string): QuestionEnvelope {
  return { questions: [{ header: 'Recuperación', question: `La evaluación de riesgo del run MDD ${runID} no pudo seleccionar una ruta. ¿Cómo seguimos?`, multiple: false,
    options: [
      { label: RISK_RECOVERY_LABELS.retry, description: 'Descartar este resultado y volver a intentar la evaluación de riesgo desde cero, sin un veredicto previo.' },
      { label: RISK_RECOVERY_LABELS.low, description: 'Elegir manualmente la ruta low (plan, apply, verify) sin una nueva evaluación de riesgo.' },
      { label: RISK_RECOVERY_LABELS.high, description: 'Elegir manualmente la ruta high (propose, spec, design, tasks, apply, verify) sin una nueva evaluación de riesgo.' },
      { label: RISK_RECOVERY_LABELS.stop, description: 'Pausar sin reintentar la evaluación ni elegir ninguna ruta.' },
    ] }] };
}

/** Why the assessment could not choose, which can be a whole diagnostic: the chat shows it whole. */
export function riskRecoveryBrief(reason: string): string | undefined {
  return reason.trim() ? `**Por qué no pudo elegir una ruta:** ${reason}` : undefined;
}

/** The form asks the question alone; why it matters is in the brief, which the form cannot hold. */
function clarificationPrompt(item: Clarification): QuestionEnvelope['questions'][number] {
  return { header: item.header ?? 'Detalle', question: item.question,
    multiple: item.multiple === true,
    options: [...item.options.map(option => ({ label: clarificationOptionLabel(option), description: option.description })),
      // The note asks for the user's own words; delegating or deferring it would mean nothing.
      ...(item.note ? [] : [
        ...(item.deferrable ? [{ label: CLARIFICATION_LABELS.defer, description: 'Resolver esto en una fase posterior; no se considera decidido.' }] : []),
        { label: CLARIFICATION_LABELS.delegate, description: 'Delegar esta decisión al agente de la próxima fase.' }])] };
}

/**
 * Every pending clarification goes out in one native interaction, the way preflight does. Asking
 * them one at a time made the user answer, wait, and answer again for questions that were all
 * known at once.
 */
function clarificationEnvelope(items: readonly Clarification[]): QuestionEnvelope {
  return { questions: items.map(clarificationPrompt) };
}

const CONCERN_CATEGORIES: Record<Concern['category'], string> = { objective: 'Objetivo', integrations: 'Integraciones', 'sensitive-data': 'Datos sensibles', permissions: 'Permisos' };

/**
 * What a change confirmation is about: the requirements it would start from and the evidence that
 * backs it. The requirements are the user's own words and may be long, so they go in the chat.
 */
function changeBrief(requirements: string, advisory: readonly Concern[]): string {
  return ['Los artefactos y la memoria actuales se conservan.', section('Requisitos propuestos:', quoted(requirements)),
    ...(advisory.length ? [section('Evidencia advertida:', bullets(advisory.map(item =>
      `**${CONCERN_CATEGORIES[item.category]}** (\`${item.category}\`): ${item.evidence} Impacto: ${item.impact}`)))] : [])].join('\n\n');
}

/** Why each clarification matters, named by its header, for the chat before the form. */
function clarificationBrief(items: readonly Clarification[]): string | undefined {
  return whyBrief(items.map(item => ({ label: item.header ?? 'Detalle', question: item.question, why: item.why })));
}

/**
 * The coordinator's questions, from mdd_prepare_advance or from mdd_start. User-visible prose has
 * no individual ceiling; the counts are bounded and the rendered labels must stay unambiguous.
 */
function parseClarifications(value: unknown): Clarification[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('Provide up to eight clarification questions, or an empty array when none remain.');
  return value.map(raw => {
    const item = objectWithKeys(raw, 'clarification', ['question', 'header', 'why', 'options', 'multiple', 'deferrable']);
    const question = nonemptyText(item.question, 'clarification question');
    if (!Array.isArray(item.options) || item.options.length > 6 ||
        (['multiple', 'deferrable'] as const).some(key => item[key] !== undefined && typeof item[key] !== 'boolean')) {
      throw new Error('Clarifications take zero to six options (none for an open-ended answer) and boolean multiple and deferrable flags.');
    }
    const header = item.header === undefined ? undefined : nonemptyText(item.header, 'clarification header').trim();
    if (header !== undefined && [...header].length > CLARIFICATION_HEADER_MAX) throw new Error(`A clarification header is a short topic of at most ${CLARIFICATION_HEADER_MAX} characters; put the detail in why.`);
    const why = item.why === undefined ? undefined : nonemptyText(item.why, 'clarification why');
    const options = item.options.map(rawOption => {
      const option = objectWithKeys(rawOption, 'clarification option', ['label', 'description', 'recommended']);
      if (option.recommended !== undefined && typeof option.recommended !== 'boolean') throw new Error('recommended must be boolean.');
      return { label: nonemptyText(option.label, 'option label'), description: nonemptyText(option.description, 'option description'), recommended: option.recommended === true };
    });
    const labels = options.map(clarificationOptionLabel);
    if (new Set([...labels, CLARIFICATION_LABELS.defer, CLARIFICATION_LABELS.delegate]).size !== labels.length + 2) throw new Error('Clarification option labels must be unique and not reserved.');
    return { question, ...(header ? { header } : {}), ...(why ? { why } : {}), options,
      ...(item.multiple === true ? { multiple: true } : {}), deferrable: item.deferrable === true };
  });
}

/**
 * The user typed their own text instead of choosing one of the offered options. Nothing is
 * selected, so nothing is approved, accepted or changed — but a person answering in their own
 * words is ordinary, not a protocol violation, and it is carried separately so the caller can
 * keep the run alive and deal with what was actually said.
 */
export class UnselectedAnswer extends Error {
  /** `answers` is everything the form returned, so the user's words can still be read as an answer. */
  constructor(readonly text: string, readonly answers: readonly string[][] = []) {
    super('The user answered with their own text instead of choosing one of the offered options.');
  }
}

/**
 * Reads what the user chose. Questions from `openFrom` on are clarifications: they may be left
 * unanswered, answered in the user's own words, or answered with several choices when they allow
 * it. Every earlier question maps to an exact token and takes exactly one listed label.
 */
export function nativeQuestionAnswers(args: QuestionEnvelope, raw: unknown, openFrom = args.questions.length): string[][] {
  const result = objectWithKeys(raw, 'native question output', ['title', 'output', 'metadata', 'attachments']);
  const metadata = objectWithKeys(result.metadata, 'native question metadata', ['answers', 'truncated']);
  if (metadata.truncated !== false || (result.attachments !== undefined && (!Array.isArray(result.attachments) || result.attachments.length))) {
    throw new Error('Unknown or truncated native question result.');
  }
  const answers = metadata.answers;
  if (!Array.isArray(answers) || answers.length !== args.questions.length) throw new Error('Native question answer count mismatch.');
  const given = args.questions.map((question, index) => {
    const selected: unknown = answers[index];
    if (!Array.isArray(selected) || selected.some(entry => typeof entry !== 'string')) throw new Error('Invalid native question answer label.');
    if (index >= openFrom ? !question.multiple && selected.length > 1 : selected.length !== 1) throw new Error('Invalid native question answer label.');
    return selected as string[];
  });
  // The host writes an empty answer as "Unanswered"; anything else would be a rewritten result.
  const formatted = args.questions.map((q, i) => `"${q.question}"="${given[i]!.length ? given[i]!.join(', ') : 'Unanswered'}"`).join(', ');
  if (result.title !== `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}` ||
      result.output !== `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`) {
    throw new Error('Native question output does not match its answer metadata.');
  }
  // Only an envelope that agrees with itself can have its labels read as what the user chose, so
  // an unlisted one is their own words here, rather than a result that was rewritten on the way.
  const unlisted = args.questions.findIndex((question, index) => index < openFrom && !question.options.some(option => option.label === given[index]![0]));
  if (unlisted >= 0) throw new UnselectedAnswer(given[unlisted]![0]!, given.map(selected => [...selected]));
  return given.map((selected, index) => index < openFrom ? [selected[0]!] : selected.filter(entry => entry.trim()));
}

export class NativeIntake {
  readonly #sessions = new Map<string, Intake>();
  readonly #adaptiveTransfers = new Set<string>();
  readonly #reissued = new Set<string>();
  readonly #questionOwners = new Map<QuestionEnvelope, string>();
  readonly #settings;
  readonly #profile;
  readonly #managed;
  readonly #adaptiveNative?: AdaptiveNative;
  readonly #adaptiveProtocol?: AdaptiveProtocol;
  readonly #preferences = new Map<string, { directory: string; worktree: string; choices: SessionPreferences }>();
  constructor(readonly runner: Runner, readonly inspect: IntakeInspect, settings: unknown,
    readonly durable: { questions?: QuestionCheckpointStore; checkpoint?: CheckpointStore; ownership?: RunOwnershipStore; preferences?: SessionPreferenceStore } = {}) {
    this.#settings = parseSettings(settings);
    this.#profile = freezeProfile(this.#settings);
    this.#managed = this.#settings.engram && 'mode' in this.#settings.engram ? new ManagedMemory(this.#settings.engram) : undefined;
    const nativeRunner = runner as PhaseRunner;
    if (durable.questions && nativeRunner.options?.adaptiveStore && typeof nativeRunner.executeAdaptiveNativeInternal === 'function') {
      this.#adaptiveNative = new AdaptiveNative(nativeRunner, inspect, this.#profile, durable.questions, nativeRunner.options.adaptiveStore);
      this.#adaptiveProtocol = new AdaptiveProtocol(nativeRunner, this.#adaptiveNative);
    }
  }

  async close(): Promise<void> { await this.#managed?.close(); }

  /** Internal only: AL-02 cannot bypass an interactive approval or an unresolved native question. */
  async admitAdaptiveInternal(value: unknown, runtime: Runtime, messageID: string): Promise<unknown> {
    if (this.#adaptiveNative?.busy(runtime.sessionID)) throw new Error('A native policy intake is pending.');
    const input = objectWithKeys(value, 'internal adaptive intake', ['contract']);
    const contract = adaptiveContract(input.contract), here = { ...runtime };
    const nativeMessage = boundedText(messageID, 'native messageID', 256);
    if (this.#adaptiveTransfers.has(here.sessionID)) throw new Error('Adaptive transfer owns this native intake boundary.');
    if (here.agent !== 'mdd-orchestrator' || this.#profile.answers.mode !== 'automatic')
      throw new Error('Internal adaptive intake requires the coordinator and an explicitly automatic native profile; interactive approval is not bypassed.');
    if (this.#sessions.has(here.sessionID) || this.#unresolved(here.sessionID)) throw new Error('A native intake or question already occupies this parent.');
    if (!this.runner.admitAdaptiveInternal) throw new Error('Internal adaptive runner admission is unavailable.');
    const identity = await this.inspect.intake(here, contract.objective, nativeMessage, 'objective');
    if (this.#adaptiveTransfers.has(here.sessionID)) throw new Error('Adaptive transfer claimed this intake during native inspection.');
    if (typeof identity !== 'string') throw new Error('Exact native objective proof is required; caller-supplied provenance is insufficient.');
    if (this.#sessions.has(here.sessionID) || this.#unresolved(here.sessionID)) throw new Error('Native intake changed during objective inspection.');
    // Runner independently inspects the same native text/message, ownership and current source.
    return this.runner.admitAdaptiveInternal({ contract, messageID: nativeMessage }, here);
  }

  /** The public adapter supplies the actual assistant caller separately from untrusted JSON. */
  async adaptiveInternal(value: unknown, runtime: Runtime, callerMessageID?: string): Promise<unknown> {
    if (!this.#adaptiveNative) throw new Error('Durable native policy bridge is unavailable.');
    if (this.#adaptiveTransfers.has(runtime.sessionID) || this.#sessions.has(runtime.sessionID))
      throw new Error('A native intake or transfer already occupies this parent.');
    return typeof value === 'string' ? this.#adaptiveProtocol!.run(value, runtime, callerMessageID) : this.#adaptiveNative.run(value, { ...runtime });
  }

  async adaptiveStatus(runtime: Runtime): Promise<unknown> {
    if (!this.#adaptiveProtocol) throw new Error('Durable native policy bridge is unavailable.');
    return this.#adaptiveProtocol.run(JSON.stringify({ routingVersion: 3, kind: 'status', args: {} }), runtime, undefined, true);
  }

  /** Internal only. The runner independently proves both parents and the latest target request. */
  transferAdaptiveInternal(value: unknown, runtime: Runtime): Promise<unknown> {
    return this.#adaptiveTransfer(value, runtime, false);
  }
  recoverAdaptiveTransferInternal(value: unknown, runtime: Runtime): Promise<unknown> {
    return this.#adaptiveTransfer(value, runtime, true);
  }
  async #adaptiveTransfer(value: unknown, runtime: Runtime, recover: boolean): Promise<unknown> {
    const input = objectWithKeys(value, 'internal adaptive transfer intake', ['sourceSessionID', 'runID', 'operationID', 'messageID', ...(recover ? ['action'] : [])]);
    const source = boundedText(input.sourceSessionID, 'sourceSessionID', 256);
    if (runtime.agent !== 'mdd-orchestrator' || this.#profile.answers.mode !== 'automatic' ||
        [source, runtime.sessionID].some(id => this.#adaptiveTransfers.has(id) || this.#sessions.has(id) || this.#unresolved(id)))
      throw new Error('Adaptive transfer requires idle native intakes and the existing automatic coordinator profile.');
    const method = recover ? this.runner.recoverAdaptiveTransferInternal : this.runner.transferAdaptiveInternal;
    if (!method) throw new Error('Internal adaptive transfer is unavailable.');
    this.#adaptiveTransfers.add(source); this.#adaptiveTransfers.add(runtime.sessionID);
    try { return await method.call(this.runner, structuredClone(input), { ...runtime }); }
    finally { this.#adaptiveTransfers.delete(source); this.#adaptiveTransfers.delete(runtime.sessionID); }
  }

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


  /**
   * Reissue only the question envelope, never its historical answer or approval. A settled
   * `blocked-risk` stop is recovered the same way an ordinary pending approval is: never from the
   * old record's answer, only from the current replayed action and a freshly minted four-choice
   * envelope (`riskRecoveryEnvelope`), so a historical `retry`/`low`/`high`/`stop` answer can never
   * be treated as a fresh decision.
   */
  recover(runtime: Runtime): void {
    if (this.#adaptiveTransfers.has(runtime.sessionID)) throw new Error('Adaptive transfer owns this native intake boundary.');
    if (this.#sessions.has(runtime.sessionID)) return;
    const status = this.runner.status(runtime.sessionID);
    if (!('workflow' in status)) return;
    // The runner rebuilds ready tasks from workflow events; restore this negative storage fence
    // from its sealed checkpoint instead of treating a retry-ready workflow as successful publication.
    const storageStop = status.workflow.answers.artifactStore === 'engram' ? this.durable.checkpoint?.read(runtime.sessionID)?.checkpoint : undefined;
    if (storageStop?.version === STABLE_CHECKPOINT_VERSION && storageStop.runID === status.runID &&
        storageStop.parent === runtime.sessionID && storageStop.data.directory === runtime.directory &&
        storageStop.data.worktree === runtime.worktree && storageStop.stable.reason === CONFIGURED_STORAGE_BLOCK) {
      this.runner.block(runtime.sessionID, CONFIGURED_STORAGE_BLOCK);
      return;
    }
    const nextAction = status.workflow.nextAction;
    const blockedRisk = nextAction.kind === 'blocked-risk' && status.state === 'blocked';
    const boundary = nextAction.kind === 'execute' && status.state === 'ready';
    if (nextAction.kind !== 'approve' && !blockedRisk && !boundary) return;
    if (nextAction.kind === 'approve' && status.state !== 'await-approval') return;
    let reported = false;
    if (boundary) {
      // A ready phase has no approval to ask again. Only a clarification interrupted before it
      // was dispatched, or questions its predecessor reported that nobody asked yet, hold it back.
      const held = this.durable.questions?.read(runtime.sessionID);
      const interrupted = held?.runID === status.runID && ['prepared', 'pending', 'answered'].includes(held.state);
      // Any other unresolved question here is not this boundary's to reissue; status reports it.
      if (interrupted && held.slot.kind !== 'clarification') return;
      reported = !!this.runner.openQuestions?.(runtime.sessionID);
      if (!interrupted && !reported) return;
    }
    const checkpoint = this.durable.checkpoint?.read(runtime.sessionID)?.checkpoint;
    if (checkpoint?.version !== STABLE_CHECKPOINT_VERSION || checkpoint.runID !== status.runID ||
        checkpoint.data.directory !== runtime.directory || checkpoint.data.worktree !== runtime.worktree) {
      throw new Error('The native question cannot be bound to a validated same-parent checkpoint.');
    }
    let recorded = this.durable.questions?.read(runtime.sessionID);
    if (recorded?.version === 2) throw new Error('Adaptive native questions cannot be recovered as fixed phase consent.');
    // At a ready boundary, a settled record of an earlier run, or of the preflight that started
    // this one, answers nothing and must not keep the run from asking its own questions.
    if (boundary && recorded && recorded.runID !== status.runID && ['settled', 'cancelled', 'withdrawn'].includes(recorded.state)) recorded = undefined;
    if (recorded && (recorded.runID !== status.runID ||
        (recorded.checkpoint && recorded.checkpoint.sequence > checkpoint.sequence))) throw new Error('The native question belongs to a different or newer run.');
    // Same rule the reservation hand-off applies: a record bound to this exact checkpoint sequence
    // must carry its digest. A mismatch is a foreign or corrupted binding, never something to overwrite.
    if (recorded?.checkpoint && ['prepared', 'pending', 'answered'].includes(recorded.state) &&
        recorded.checkpoint.sequence === checkpoint.sequence && recorded.checkpoint.digest !== checkpoint.dataDigest) {
      throw new Error('The native question is bound to a different checkpoint; nothing was reissued.');
    }
    if (blockedRisk) {
      if (recorded && recorded.slot.kind !== 'risk-recovery' &&
          !['settled', 'cancelled', 'withdrawn'].includes(recorded.state)) throw new Error('A different native question is unresolved; no risk recovery was reissued.');
    } else if (nextAction.kind === 'approve' || nextAction.kind === 'execute') {
      if (recorded && !['approval', 'clarification', 'route'].includes(recorded.slot.kind) &&
          !['settled', 'cancelled', 'withdrawn'].includes(recorded.state)) throw new Error('A different native question is unresolved; no approval was reissued.');
      const phase = nextAction.phase;
      if (recorded && ['prepared', 'pending', 'answered'].includes(recorded.state) && recorded.slot.phase !== phase) {
        throw new Error('The native question names another phase; no approval was reissued.');
      }
    }
    const entry: Intake = {
      runtime: { ...runtime }, requirements: checkpoint.data.requirements, state: 'review-ready',
      receipts: [], known: { ...status.workflow.answers }, userMessageID: checkpoint.data.userMessageID,
      usedMessages: new Set(checkpoint.data.usedMessages), proposed: new Set(checkpoint.data.proposed),
      clarifications: structuredClone(recorded?.clarifications ?? []), deferred: structuredClone(recorded?.deferred ?? []),
      clarificationAnswers: structuredClone(recorded?.clarificationAnswers ?? []),
    };
    const receipt = this.durable.ownership?.read(status.runID)?.receipt;
    if (receipt?.targetSessionID === runtime.sessionID && receipt.sourceSessionID !== runtime.sessionID) entry.inherited = true;
    this.#sessions.set(runtime.sessionID, entry);
    try {
      if (blockedRisk) {
        // Never rehydrate from recorded.slot/answer: mint a brand new envelope every time, exactly
        // as the first `blocked-risk` arming would, so a stale answered record cannot look like a
        // fresh decision. Any unresolved prior record is retired by `#slot`'s own `prepared` write.
        const args = riskRecoveryEnvelope(status.runID), brief = riskRecoveryBrief(status.reason ?? '');
        args.questions[0]!.question += ` [MDD re-present ${randomUUID()}]`;
        this.#slot(entry, { kind: 'risk-recovery', args, ...(brief ? { brief } : {}) }, true);
        entry.notice = 'The earlier native question is not consent. Ask this newly issued question and use only its fresh native answer.';
        if (recorded && ['prepared', 'pending', 'answered', 'cancelled'].includes(recorded.state)) this.#reissued.add(runtime.sessionID);
      } else if (recorded && ['prepared', 'pending', 'answered'].includes(recorded.state)) {
        if (recorded.slot.kind === 'adaptive') throw new Error('Adaptive question is not a fixed phase question.');
        const slot: Slot = structuredClone({ ...recorded.slot, kind: recorded.slot.kind });
        slot.args.questions[0]!.question += ` [MDD re-present ${randomUUID()}]`;
        this.#slot(entry, slot, true);
        entry.notice = 'The earlier native question is not consent. Ask this newly issued question and use only its fresh native answer.';
        this.#reissued.add(runtime.sessionID);
      } else {
        if (recorded?.state === 'cancelled') this.#reissued.add(runtime.sessionID);
        if (reported) entry.notice = 'The phase reported open questions (openQuestions) that were not asked yet. Present them translated into Spanish with mdd_prepare_advance before the next phase is dispatched.';
      }
    } catch (error) { this.#sessions.delete(runtime.sessionID); throw error; }
  }

  async start(value: unknown, runtime: Runtime, messageID: string): Promise<unknown> {
    if (this.#adaptiveNative?.busy(runtime.sessionID)) throw new Error('A native policy intake is pending.');
    if (this.#adaptiveTransfers.has(runtime.sessionID)) throw new Error('Adaptive transfer owns this native intake boundary.');
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only mdd-orchestrator may start MDD.');
    // The intake of a run that moved to another conversation governs nothing here any more.
    if (this.runner.movedAway?.(runtime.sessionID)) this.#forget(runtime.sessionID);
    if (!this.#sessions.has(runtime.sessionID) && this.#unresolved(runtime.sessionID)) throw new Error('A native question in this parent has an unresolved outcome. Inspect mdd_status and explicitly discard the run before starting another.');
    this.runner.assertFreshStart?.(runtime.sessionID);
    const previous = this.#sessions.get(runtime.sessionID);
    const previousRunner = this.runner.status?.(runtime.sessionID) ?? { state: 'not-started' };
    const failedTarget = this.runner.failedVerification?.(runtime.sessionID);
    if (failedTarget) this.assertContinuationIdle(runtime.sessionID);
    if (previous) {
      // An intake that never reached a run has nothing to protect. Refusing it would strand the
      // conversation: change requests need a run, so a failed intake could never be replaced.
      const state = previousRunner.state;
      const replaceable = state === 'complete' || !!failedTarget ||
        (state === 'not-started' && ['blocked', 'stopped'].includes(previous.state));
      if (!replaceable) throw new Error('This parent already has an MDD intake; use mdd_status or request a confirmed change.');
    }
    const input = objectWithKeys(value, 'start', ['requirements', 'context', 'exploration', 'questions']);
    const exploration = input.exploration === undefined ? undefined : objectWithKeys(input.exploration, 'exploration', ['workItems']);
    if (exploration && (!Array.isArray(exploration.workItems) || exploration.workItems.length > 2)) throw new Error('Invalid exploration work items.');
    const requirements = nonemptyText(input.requirements, 'requirements');
    // Doubts about the request itself, asked together with preflight rather than after it.
    const startup = input.questions === undefined ? [] : parseClarifications(input.questions);
    // Validated at intake so bad context fails here, not later when the first phase is prepared.
    // Only the pair is held: the runner attributes provenance itself when the run is created.
    const context = input.context === undefined ? undefined : (({ label, content }) => ({ label, content }))(runContext(input.context));
    const pending = !failedTarget && !previous && this.runner.status?.(runtime.sessionID).state !== 'complete' ? await this.inspect.setupPending?.(runtime, requirements, boundedText(messageID, 'native messageID', 256)) : undefined;
    if (this.#adaptiveTransfers.has(runtime.sessionID)) throw new Error('Adaptive transfer claimed this intake during setup inspection.');
    if (pending && pending.requirements !== requirements) throw new Error('The original objective is pending. Resubmit its exact pendingStart arguments, not continuation text. For a different objective, use a fresh parent.');
    this.runner.owner?.(runtime.sessionID);
    if (this.#sessions.get(runtime.sessionID) !== previous) throw new Error('Intake changed during setup inspection; read mdd_status.');
    // A restarted process has no previous intake, but the run it lost may have consumed user
    // messages and change proposals. Those guards are restored; the receipts that recorded actual
    // consent are not, because their call IDs would look like approvals this run never received.
    const guards = previous ? undefined : this.runner.priorGuards?.(runtime.sessionID);
    const defaults = this.#defaults(runtime);
    const entry: Intake = { runtime: { ...runtime }, requirements, state: 'starting', receipts: previous?.receipts ?? [], known: defaults.known, ...(defaults.reused ? { preferenceDefaults: true } : {}), usedMessages: new Set(previous?.usedMessages ?? guards?.usedMessages), proposed: new Set(previous?.proposed ?? guards?.proposed), clarifications: [], deferred: [], clarificationAnswers: [], ...(context ? { context } : {}), ...(previous ? { replacing: true } : {}) };
    if (previous) entry.restore = { state: previous.state, requirements: previous.requirements, known: previous.known, clarifications: previous.clarifications, deferred: previous.deferred, clarificationAnswers: previous.clarificationAnswers, ...(previous.context ? { context: previous.context } : {}), ...(previous.slot ? { slot: previous.slot } : {}), ...(previous.userMessageID ? { userMessageID: previous.userMessageID } : {}) };
    this.#sessions.set(runtime.sessionID, entry);
    if (exploration) entry.exploration = { workItems: structuredClone(exploration.workItems) as unknown[] };
    let continued = false;
    try {
      // An objective may be older than the last thing the user said: a continuation message never
      // replaces the request it continues. Consent paths keep requiring the latest user text.
      const userID = pending?.userMessageID ?? await this.inspect.intake(entry.runtime, requirements, boundedText(messageID, 'native messageID', 256), failedTarget ? 'latest' : 'objective');
      this.runner.owner?.(runtime.sessionID);
      if (typeof userID === 'string') {
        if (entry.usedMessages.has(userID)) throw new Error('This user message was already used; wait for an actual new request.');
        if (failedTarget) {
          // The existing writer binds this request to the failed target captured before inspection.
          // Preservation must succeed before fresh preflight or implementation can own the parent.
          if (this.#unresolved(runtime.sessionID)) throw new Error('A native question is unresolved; nothing was released.');
          this.runner.reset!(runtime.sessionID, 'continue', { runID: failedTarget, userMessageID: userID, userText: requirements, kind: 'new-task' });
          continued = true;
          delete entry.replacing; delete entry.restore;
        }
        entry.userMessageID = userID; entry.usedMessages.add(userID);
        // A finished run a restart left unloaded is closed now, as the same run would be replaced
        // in process: the new objective is proven native, and the old evidence is set aside.
        if (!previous || continued) this.runner.closeForFreshStart?.(runtime.sessionID);
        this.runner.assertFreshStart?.(runtime.sessionID, userID);
      } else if (previous || failedTarget) throw new Error('A fresh native user identity is required for another run.');
      entry.known.artifactStore = await this.#newRunStorage(entry);
      if (entry.state !== 'starting') throw new Error('Intake became uncertain during initialization.');
      if (previous && ['blocked', 'stopped'].includes(previous.state)) this.#releaseIntake(previous);
      const slot = this.#preflightSlot(entry, startup, 'intake');
      if (slot) this.#slot(entry, slot);
      else { await this.#startRunner(entry, [], this.#defaultSource(entry)); this.#savePreferences(entry); }
      return this.status(runtime.sessionID);
    } catch (error) {
      const current = this.runner.status?.(runtime.sessionID) ?? { state: 'not-started' };
      const unchanged = ('runID' in current ? current.runID : undefined) === ('runID' in previousRunner ? previousRunner.runID : undefined);
      if (failedTarget && !continued && unchanged) {
        if (previous) this.#sessions.set(runtime.sessionID, previous);
        else this.#sessions.delete(runtime.sessionID);
        throw error;
      }
      if (continued) return this.#fail(entry, error);
      // Once the runner accepted the new objective, restoring only its intake would split them.
      if (previous && entry.restore && unchanged) { this.#sessions.set(runtime.sessionID, previous); throw error; }
      delete entry.restore; delete entry.replacing;
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
    const userText = nonemptyText(input.userText, 'actual user request');
    const advisory = concerns(input.concerns);
    const requirements = input.kind === 'rerun' ? entry.requirements : nonemptyText(input.requirements, 'proposed requirements');
    if (input.kind === 'rerun' && (input.requirements !== undefined || advisory.length)) throw new Error('A preflight rerun retains requirements; use material change for a new objective.');
    if (input.kind === 'material' && requirements.trim() === entry.requirements.trim()) throw new Error('A material change needs requirements that differ from the current ones. Ordinary plan choices do not require this path.');
    const saved = { state: entry.state, requirements: entry.requirements, known: entry.known, clarifications: [...entry.clarifications], deferred: [...entry.deferred], clarificationAnswers: [...entry.clarificationAnswers], ...(entry.context ? { context: entry.context } : {}), ...(entry.slot ? { slot: entry.slot } : {}), ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}) };
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
      const question = `${input.kind === 'rerun' ? '¿Volver a hacer las preguntas de preflight para un run planificado nuevo?' : '¿Confirmás este cambio material de alcance, con los requisitos que se muestran arriba, y un run planificado nuevo?'} [MDD change ${randomUUID()}]`;
      this.#slot(entry, { kind: 'change', requirements, brief: changeBrief(requirements, advisory),
        args: { questions: [{ header: 'Cambio', question, multiple: false, options: [{ label: CHANGE_LABELS.confirm, description: 'Responder el preflight una vez y arrancar un run planificado nuevo.' }, { label: CHANGE_LABELS.keep, description: 'No cambiar el run actual, sus respuestas ni su aprobación.' }] }] } });
      return this.status(runtime.sessionID);
    } catch (error) { entry.state = saved.state; throw error; }
  }

  /** Read-only investigation needs no accepted run; it only waits for a pending native interaction. */
  async explore(value: unknown, runtime: Runtime): Promise<unknown> {
    if (this.#adaptiveNative?.busy(runtime.sessionID)) throw new Error('A native policy question or intake is pending.');
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

  /**
   * Review must finish before the native phase approval is ever offered. The same call stops a
   * ready phase before it is dispatched — the boundary automatic mode has instead of an approval —
   * so a decision only the user can make is asked in either mode, all questions at once.
   */
  prepareAdvance(value: unknown, runtime: Runtime): unknown {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may prepare phase advancement.');
    const entry = this.#sessions.get(runtime.sessionID);
    const status = this.runner.status(runtime.sessionID);
    const next = 'workflow' in status ? status.workflow.nextAction : undefined;
    // A ready phase nobody dispatched yet may still wait for an answer; one in flight may not.
    const beforeDispatch = entry?.state === 'active' && next?.kind === 'execute' && status.state === 'ready' &&
      !('contextual' in status && status.contextual);
    if (!entry || (!['review-ready', 'paused'].includes(entry.state) && !beforeDispatch)) throw new Error('Phase review is not ready; no approval was changed.');
    if (!next || (next.kind !== 'approve' && next.kind !== 'execute')) throw new Error('No phase is awaiting approval or dispatch.');
    const input = objectWithKeys(value, 'advance preparation', ['questions']);
    const questions = parseClarifications(input.questions);
    if (beforeDispatch && !questions.length) return this.status(runtime.sessionID);
    // A question explicitly re-offered by the coordinator replaces its pending copy.
    const named = new Set(questions.map(item => item.question));
    const pending = [...entry.clarifications.filter(item => !named.has(item.question)), ...questions];
    if (pending.length + entry.deferred.length > CLARIFICATIONS_MAX) {
      throw new Error(`At most ${CLARIFICATIONS_MAX} clarifications can be pending at once and ${entry.clarifications.length + entry.deferred.length} already are. Submit fewer new questions; nothing was changed.`);
    }
    // The phase's own questions are being asked now, translated, or were found already answered.
    this.runner.takeOpenQuestions?.(runtime.sessionID);
    entry.clarifications = pending;
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

  /**
   * The user answered an MDD question in their own words instead of choosing in the form: typed
   * inside the form itself, or written in a chat message after the form was shown and then closed
   * or interrupted. The form is still how MDD asks; this only keeps a real answer from being thrown
   * away and asked again. The coordinator reads the words and `typedSelections` checks that reading
   * against what the user actually wrote. A chat message must also be provably theirs: their exact
   * latest message, not used by MDD before, and written after this question was shown (a preflight
   * only needs to be past the request that started it, which MDD already marks as used). Anything
   * short of that records nothing.
   */
  async answer(value: unknown, runtime: Runtime, messageID: string): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may record an answer.');
    if (this.runner.movedAway?.(runtime.sessionID)) throw new Error('This conversation\'s run moved to another conversation; nothing can be answered here.');
    const input = objectWithKeys(value, 'written answer', ['userText', 'answers']);
    const entry = this.#sessions.get(runtime.sessionID);
    const slot = entry?.slot;
    // An open question, or one whose form was closed without recording anything. A change
    // confirmation that was closed already kept the plan, so there is nothing left to confirm.
    const closed = !!entry && !!slot?.callID && entry.receipts.some(receipt => receipt.callID === slot.callID && receipt.cancelled) &&
      ((entry.state === 'paused' && ['approval', 'clarification', 'route'].includes(slot.kind)) ||
       (entry.state === 'stopped' && ['preflight', 'risk-recovery'].includes(slot.kind)));
    if (!entry || !slot || (entry.state !== 'question-ready' && !closed)) {
      throw new Error('No MDD question is waiting for an answer in this conversation. Nothing was recorded.');
    }
    const status = this.runner.status(runtime.sessionID);
    if ('contextual' in status && status.contextual) throw new Error('Wait for the contextual exploration before answering the main question. Nothing was recorded.');
    const openFrom = slot.kind === 'clarification' ? 0 : slot.kind === 'preflight' ? slot.fields ?? slot.args.questions.length : slot.args.questions.length;
    if (slot.args.questions.length - openFrom !== (slot.kind === 'clarification' || slot.kind === 'preflight' ? entry.clarifications.length : 0)) {
      throw new Error('The pending clarifications no longer match the issued question. Nothing was recorded.');
    }
    let evidence: (index: number) => TypedEvidence;
    let userText: string | undefined;
    if (input.userText !== undefined) {
      userText = nonemptyText(input.userText, 'the user\'s written answer');
      evidence = () => ({ text: userText!, own: false });
    } else {
      const typed = entry.typed;
      if (!typed || !isDeepStrictEqual(typed.args, slot.args)) {
        throw new Error('The user typed nothing of their own into this question\'s form. When they answered in a chat message, pass userText with their exact latest message. Nothing was recorded.');
      }
      evidence = index => ({ text: typed.given[index]!.join('\n'), own: true });
    }
    // The reading is checked first: it needs nothing but the text, and a wrong reading has to be
    // refused before anything is inspected, reserved or written.
    const selections = typedSelections(slot.args, openFrom, input.answers, evidence);
    let userMessageID: string | undefined;
    if (userText !== undefined) {
      const shown = entry.shown && isDeepStrictEqual(entry.shown.args, slot.args) ? entry.shown.calls : [];
      if (slot.kind !== 'preflight' && !shown.length) {
        throw new Error('This question was not shown to the user yet. Ask it with the native question tool first; a written answer counts only once they have seen the question. Nothing was recorded.');
      }
      if (!this.inspect.typed) throw new Error('This host cannot prove a written answer. Ask the question with the native question tool. Nothing was recorded.');
      userMessageID = await this.inspect.typed(entry.runtime, userText, boundedText(messageID, 'native messageID', 256), shown);
      this.runner.owner?.(runtime.sessionID);
      if (this.#sessions.get(runtime.sessionID) !== entry || entry.slot !== slot) throw new Error('The question changed while the answer was checked. Read mdd_status. Nothing was recorded.');
      if (entry.usedMessages.has(userMessageID)) {
        throw new Error('MDD already used this message for something else. A written answer has to be a new message from the user. Nothing was recorded.');
      }
    }
    // A closed form is reopened first, so the answer follows the same record transitions as a
    // fresh native one: prepared, pending, answered, settled.
    if (entry.state !== 'question-ready') {
      const reopened: Slot = { ...slot };
      delete reopened.callID;
      delete entry.reason;
      this.#slot(entry, reopened, true);
    }
    const current = entry.slot!;
    if (current.kind === 'preflight') this.#assertIntake(entry);
    const callID = `typed-${randomUUID()}`;
    entry.state = 'accepting';
    current.callID = callID;
    try {
      this.#persistQuestion(entry, 'pending');
      if (userMessageID) entry.usedMessages.add(userMessageID);
      await this.#accept(entry, current, selections, callID, { source: userMessageID ? 'chat' : 'form', ...(userMessageID ? { userMessageID } : {}) });
      delete entry.typed;
    } catch (error) {
      try {
        const record = this.durable.questions?.read(runtime.sessionID);
        if (record?.callID === callID && record.state === 'pending') this.durable.questions!.write(runtime.sessionID, { ...record, state: 'cancelled', sequence: record.sequence + 1 });
      } catch { /* An unconfirmed record keeps fencing; reset needs the user's word. */ }
      this.#fail(entry, error);
    }
    return this.status(runtime.sessionID);
  }

  #nextReviewQuestion(entry: Intake): void {
    const status = this.runner.status(entry.runtime.sessionID);
    const next = 'workflow' in status ? status.workflow.nextAction : undefined;
    if (!('workflow' in status) || !next || (next.kind !== 'approve' && next.kind !== 'execute')) throw new Error('No phase is awaiting approval or dispatch.');
    const phase = next.phase;
    const pending = entry.clarifications.length > 0;
    if (!pending && next.kind === 'execute') {
      // Nothing left to ask and no approval to give: the ready phase, whose prompt now carries
      // every answer, goes out as it is. The settled question stays as the slot of record.
      this.#reissued.delete(entry.runtime.sessionID);
      entry.state = 'active';
      entry.notice = 'The clarifications are recorded and travel to the next phase. Dispatch the ready task exactly as mdd_status returns it; no approval is needed.';
      return;
    }
    // The route question replaces the generic approval exactly once: at the suggested route's
    // first tail phase, while it is still the only recorded phase result and the route has not
    // already been forced — the same boundary `Workflow.overrideRoute()` itself still accepts.
    // Pending clarifications still take precedence, exactly as they do for an ordinary approval.
    const risking = !pending && 'risk' in status && status.risk && status.workflow.routeOrigin === 'suggested' && status.workflow.results.length === 1;
    const risk = risking ? status.risk as { route: 'low' | 'high'; complexity: 'low' | 'high'; reason: string } : undefined;
    const args = pending ? clarificationEnvelope(entry.clarifications)
      : risk ? routeEnvelope(status.runID, phase, risk)
      : approvalEnvelope(status.runID, phase, status.reportDetail !== 'detailed');
    const brief = pending ? clarificationBrief(entry.clarifications) : risk ? routeBrief(risk) : undefined;
    if (this.#reissued.delete(entry.runtime.sessionID)) args.questions[0]!.question += ` [MDD re-present ${randomUUID()}]`;
    this.#slot(entry, { kind: pending ? 'clarification' : risking ? 'route' : 'approval', phase, args, ...(brief ? { brief } : {}) });
  }

  /** The coordinator reports a phase it carried out itself instead of delegating it. */
  async submit(value: unknown, runtime: Runtime): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator' || !this.runner.submit) throw new Error('Only the coordinator may report a phase result.');
    const entry = this.#sessions.get(runtime.sessionID);
    if (entry && entry.state !== 'active') throw new Error('A phase cannot be reported before accepted preflight or its exact phase approval.');
    let status: unknown;
    // A rejected restatement (malformed, exhausted, or otherwise) may still have settled the
    // workflow at a state with its own native recovery, such as blocked-risk after an exhausted
    // mdd-risk fallback; that recovery is armed here too, not only when the report is accepted.
    try { status = await this.runner.submit(value, runtime); }
    catch (error) { this.storageFailed(runtime.sessionID); throw error; }
    finally { try { this.phaseRecorded(runtime.sessionID); } catch { /* best effort re-arm; the original outcome still propagates. */ } }
    return entry ? this.status(runtime.sessionID) : status;
  }

  /**
   * Explicit recovery for the conversation. Phase scope releases the current attempt; run scope
   * forgets the run and its intake so a new objective can start here without a new conversation.
   */
  assertContinuationIdle(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    if (this.#unresolved(sessionID) || (entry && (entry.restore || ['starting', 'accepting', 'question-ready', 'await-answer'].includes(entry.state))) ||
        this.durable.ownership?.intake(sessionID)?.state === 'pending')
      throw new Error('A native question or intake is unresolved; continuation cannot release it.');
  }

  reset(runtime: Runtime, scope: 'phase' | 'run' | 'rework' | 'continue', consent?: Parameters<PhaseRunner['reset']>[2], target?: Parameters<PhaseRunner['reset']>[3]): unknown {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may reset MDD state.');
    if (scope === 'continue') this.assertContinuationIdle(runtime.sessionID);
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
    const applied = this.runner.reset?.(runtime.sessionID, scope, consent, target) ?? { scope: 'run' as const };
    let nativeEntry: ReturnType<AdaptiveNative['releaseFence']>;
    if (applied.scope === 'run' || applied.scope === 'continue') {
      if (intakeToken) {
        const current = this.durable.ownership?.intake(runtime.sessionID);
        if (current?.state !== 'retired') this.durable.ownership?.retireIntake(runtime.sessionID, intakeToken);
      }
      const fence = applied.scope === 'run' ? this.#adaptiveNative?.resetFence(runtime) : undefined;
      // An unresolved (or unreadable) checkpoint held by a live bridge entry is kept with its fence.
      if (!this.#adaptiveNative?.holdsQuestion(runtime.sessionID)) this.durable.questions?.clear(runtime.sessionID);
      this.#forget(runtime.sessionID);
      if (applied.scope === 'run') nativeEntry = this.#adaptiveNative?.releaseFence(runtime, fence);
    }
    else if (entry) {
      delete entry.slot; delete entry.reason; delete entry.restore; delete entry.replacing;
      entry.state = 'active';
      entry.notice = applied.scope === 'rework'
        ? (applied.phase ?? 'mdd-apply') === 'mdd-apply'
          ? `Verification failed and the user chose to correct it: mdd-apply is ready again with the verification findings as its newest input, as one correction pass that owns every finding. Verification follows it through the route's ordinary approval. Previous evidence is retained.`
          : `A phase failed and the user chose to rework the route from ${applied.phase}: it is ready again with the failure as its newest input, and every later phase plans and runs again through the route's ordinary approvals. The plan and verification held before were released; artifacts and changed files are retained.`
        : applied.approval
        ? `The run was released at its approval boundary: ${applied.phase ?? 'the next phase'} is waiting for the same approval question again. Nothing was approved and previous evidence is retained.`
        : `The ${applied.phase ?? 'current'} phase was released and is ready to run again. Previous evidence is retained.`;
      // A run released while it waited for approval still needs that approval, so its question is
      // re-armed here instead of leaving the conversation with nothing to answer.
      this.phaseRecorded(runtime.sessionID);
    }
    return { ...this.status(runtime.sessionID), reset: nativeEntry ? { ...applied, nativeEntry } : applied };
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

  readonly #knowledgeAttempts = new Set<string>();
  #knowledgeCache?: { root: string; store: KnowledgeCache };

  /** Internal resolver: optional provider failure cannot change native dispatch authority. */
  async resolveKnowledge(selection: KnowledgeSelection, runtime: Runtime, bound?: EngramHttp): Promise<KnowledgeLookup> {
    const result = emptyKnowledgeLookup();
    if (!this.#settings.knowledge.enabled) return result;
    result.skills = readKnowledgeCatalog(runtime.directory, selection, result.metrics);
    try {
      const client = bound ?? await this.#memory(runtime);
      if (!client) return result;
      const root = mddDataRoot(runtime.directory);
      if (this.#knowledgeCache?.root !== root) this.#knowledgeCache = { root, store: new KnowledgeCache(root) };
      result.observations = await selectKnowledge(client, selection, runtime.directory, this.#knowledgeCache.store, result.metrics);
    } catch { /* Explicit local catalog remains available when canonical observations are unavailable. */ }
    return result;
  }

  async knowledge(input: unknown, runtime: Runtime): Promise<unknown> {
    if (!this.#settings.knowledge.enabled) return { state: 'disabled', entries: [] };
    const query = parseKnowledgeQuery(input);
    try {
      const client = await this.#memory(runtime);
      if (client) {
        const root = mddDataRoot(runtime.directory);
        if (this.#knowledgeCache?.root !== root) this.#knowledgeCache = { root, store: new KnowledgeCache(root) };
        return { state: 'available', entries: await queryKnowledge(client, query, runtime.directory, this.#knowledgeCache.store), note: KNOWLEDGE_NOTE };
      }
    } catch { /* Optional knowledge has no offline authority or cached fallback. */ }
    return { state: 'unavailable', entries: [], note: 'Knowledge provider is unavailable or unbound; no observations were returned.' };
  }

  async recordKnowledge(input: unknown, runtime: Runtime, messageID: string): Promise<unknown> {
    if (!this.#settings.knowledge.enabled) return { state: 'disabled' };
    const request = parseKnowledgeRequest(input);
    const userMessageID = await this.inspect.intake(runtime, request.userText, messageID);
    if (!userMessageID) throw new Error('Knowledge recording requires a proven native user message.');
    this.runner.owner?.(runtime.sessionID);
    const key = JSON.stringify([runtime.sessionID, userMessageID, request.requestDigest, request.observationDigest]);
    const repeated = { state: 'already-attempted', note: 'This observation already attempted a write for this native request. Inspect canonical memory; never retry blindly.' };
    if (this.#knowledgeAttempts.has(key)) return repeated;
    const dependencies = captureKnowledgeDependencies(runtime.directory, request.draft.sources);
    let client: EngramHttp | undefined;
    try { client = await this.#memory(runtime); } catch { /* No observation POST has been attempted. */ }
    if (!client) return { state: 'unavailable', note: 'Knowledge provider is unavailable or unbound; nothing was recorded.' };
    this.runner.owner?.(runtime.sessionID);
    // Recheck after asynchronous binding so concurrent calls cannot post the same finding twice.
    if (this.#knowledgeAttempts.has(key)) return repeated;
    if (this.#knowledgeAttempts.size >= 512) throw new Error('Knowledge recording attempt budget reached; inspect canonical memory.');
    const entry = knowledgeObservation(request.draft, client.project, runtime.sessionID, userMessageID, messageID, request.requestDigest, dependencies);
    this.#knowledgeAttempts.add(key);
    try {
      const id = await client.saveKnowledge(JSON.stringify(entry));
      return { state: 'recorded', entry: knowledgeSummary(id, entry, knowledgeFreshness(entry, runtime.directory)), note: KNOWLEDGE_NOTE };
    } catch (error) {
      if (error instanceof KnowledgeWriteUnknownError) return { state: 'write-unknown',
        ...(error.observationID ? { ref: `engram:${error.observationID}` } : {}), note: error.message };
      return { state: 'unavailable', note: 'Knowledge binding failed before writing. Inspect canonical memory before any new recording request.' };
    }
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
    const adaptive = this.#adaptiveNative?.status(sessionID);
    if (adaptive) return adaptive;
    const entry = this.#sessions.get(sessionID);
    const status = this.runner.status?.(sessionID) ?? { state: 'not-started' };
    const memory = this.#settings.engram ? 'enabled' : 'off';
    // A restored run's frozen answers win over today's settings, even when memory is now off.
    const backend = 'workflow' in status ? status.workflow.answers.artifactStore : entry?.known.artifactStore;
    const checkpoint = backend === 'local' && 'runID' in status ? this.durable.checkpoint?.read(sessionID)?.checkpoint : undefined;
    const task = checkpoint?.version === STABLE_CHECKPOINT_VERSION && 'runID' in status && checkpoint.runID === status.runID ? checkpoint.data?.task : undefined;
    const storage = backend ? { backend, ...(task ? { taskDirectory: join(task.root, '.mdd', 'tasks', task.name) } : {}) } : undefined;
    if (!entry) {
      const unresolved = this.#unresolved(sessionID);
      if (unresolved) return { ...status, state: 'recovery-blocked', memory, storage, question: undefined, task: undefined,
        provenance: undefined, questionReceipts: [], reason: 'A native question outcome is unconfirmed. Do not ask again or infer an answer. Reinspect native history before any future restoration; explicit run discard remains available.' +
          (unresolved.slot.kind === 'preflight' ? ' Its frozen preflight field order and any unapplied answer are retained, never interpreted as a new preflight. Explicit run discard permits a fresh intake with automatic storage, without replaying the old answer.' : '') };
      return { ...status, memory, storage, question: undefined, provenance: undefined, questionReceipts: [] };
    }
    const side = 'contextual' in status && status.contextual;
    const state = entry.state === 'active' || side ? status.state : entry.state;
    return { ...status, state, memory, storage, ...(entry.reason ? { reason: entry.reason } : {}),
      task: (entry.state === 'active' || side) && 'task' in status ? status.task : undefined,
      ...(entry.state !== 'active' && !side ? { next: { kind: entry.state === 'question-ready' ? 'question' : entry.state === 'review-ready' ? 'review' : 'wait', ...(entry.slot?.phase ? { phase: entry.slot.phase } : {}) } } : {}),
      question: entry.state === 'question-ready' && !side ? structuredClone(entry.slot!.args) : undefined,
      questionBrief: entry.state === 'question-ready' && !side ? entry.slot!.brief : undefined,
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
    if (await this.#adaptiveNative?.before(call, args)) return;
    this.#refuseMovedAway(call, args);
    this.runner.owner?.(call.sessionID);
    if (await this.#coordinatorQuestion(call, args)) return;
    const entry = this.#entry(call, args);
    if (!entry) throw new Error('Native question has no restored intake; no answer is authorized.');
    if (entry.slot?.kind === 'preflight') this.#assertIntake(entry);
    // While MDD has a question pending, that one is the only question that may run: anything else
    // leaves the user answering two things at once, and an altered copy of it is a forgery.
    // Otherwise a question MDD never issued belongs to the coordinator, and asking the user
    // something of its own is ordinary work: treating that as MDD's own turned a clarification
    // between phases into a blocked run.
    if (entry.state === 'question-ready') {
      if (!isDeepStrictEqual(args, entry.slot!.args)) throw new Error('Question arguments differ from the pending question; no answer was accepted.');
    }
    const status = this.runner.status(call.sessionID);
    if ('contextual' in status && status.contextual) throw new Error('Wait for the contextual exploration before answering the main approval.');
    if (entry.state !== 'question-ready') return this.#fail(entry, new Error('Unexpected, duplicate, or changed native question.'));
    const reserved = this.runner.reserve?.(call.sessionID, call.callID);
    const afterReserve = this.runner.status(call.sessionID);
    const held = afterReserve.state;
    // The risk stop shares the 'ready'/'blocked' Run states with an ordinary phase; `stage`
    // is what tells the two apart, so a settled risk boundary is recorded under its own label.
    const risking = 'stage' in afterReserve && afterReserve.stage === 'mdd-risk';
    const stable = risking && held === 'ready' ? 'risk-ready' : risking && held === 'blocked' ? 'risk-blocked' : held;
    // Recorded with the question so a restart can prove which run and settled state it holds.
    if (reserved && ['ready', 'await-approval', 'blocked', 'complete', 'risk-ready', 'risk-blocked'].includes(stable))
      entry.reserved = { runID: reserved.runID, stable: stable as Reservation['stable'] };
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
      // The user has now seen exactly this question, so an answer they write afterwards can be
      // read against it. Words typed into an earlier showing belong to that showing only.
      const args = entry.slot!.args;
      entry.shown = entry.shown && isDeepStrictEqual(entry.shown.args, args)
        ? { args: entry.shown.args, calls: [...entry.shown.calls, call.callID] }
        : { args: structuredClone(args), calls: [call.callID] };
      delete entry.typed;
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
    if (await this.#adaptiveNative?.after(call, args, output)) return;
    this.#refuseMovedAway(call, args);
    this.runner.owner?.(call.sessionID, call.callID);
    if (await this.#coordinatorQuestion(call, args)) return;
    const entry = this.#entry(call, args);
    if (!entry || !this.#owned(args)) {
      throw new Error('Native question callback has no current issued question; no answer was accepted.');
    }
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
      // Clarifications accept the user's own words, several choices or none at all; a token
      // question (a preflight field, approval, route or change) still needs one listed label.
      const openFrom = slot.kind === 'clarification' ? 0 : slot.kind === 'preflight' ? slot.fields ?? slot.args.questions.length : slot.args.questions.length;
      if (slot.args.questions.length - openFrom !== (slot.kind === 'clarification' || slot.kind === 'preflight' ? entry.clarifications.length : 0)) {
        throw new Error('The pending clarifications no longer match the issued question.');
      }
      const selections = nativeQuestionAnswers(slot.args, output, openFrom);
      await this.#accept(entry, slot, selections, call.callID);
      this.runner.release?.(call.sessionID, call.callID);
      delete entry.reserved;
    } catch (error) {
      if (error instanceof UnselectedAnswer) { this.#unanswered(entry, slot, call, error.answers); this.runner.release?.(call.sessionID, call.callID); delete entry.reserved; return; }
      this.#abandonQuestion(entry, call);
      this.#fail(entry, error);
    }
  }

  /**
   * Applies an answer the user gave, whichever way they gave it. A native callback and a written
   * answer that passed its checks reach exactly the same transitions, receipts and records: the
   * channel changes how the answer was proven, never what it is allowed to do.
   */
  async #accept(entry: Intake, slot: Slot, selections: string[][], callID: string, typed?: Written): Promise<void> {
    const sessionID = entry.runtime.sessionID;
    let settled = false;
    // An answer is evidence of what the user chose, not replayable consent. Persist its exact
    // selections before any approval or plan transition; an incomplete write blocks the route.
    this.#persistQuestion(entry, 'answered', selections);
    if (slot.kind === 'change') {
      if (selections[0]![0] === CHANGE_LABELS.keep) this.#restore(entry, 'Kept the current plan, answers and approval unchanged.');
      else {
        // A material change replaces the objective, so context gathered for the old one is no
        // longer trustworthy data. A plain preflight rerun keeps the same objective and its context.
        const material = slot.requirements!.trim() !== entry.requirements.trim();
        if (material) {
          delete entry.context;
          entry.clarifications = []; entry.deferred = []; entry.clarificationAnswers = [];
          entry.known = { ...entry.known };
          delete entry.known.certainty;
          if (this.#profile.answers.certainty) entry.known.certainty = this.#profile.answers.certainty;
          // A transferred run's held choices remain immutable, but are not this parent's defaults.
          if (entry.inherited) {
            const defaults = this.#defaults(entry.runtime);
            delete entry.known.mode; delete entry.known.summary;
            if (defaults.known.mode) entry.known.mode = defaults.known.mode;
            if (defaults.known.summary) entry.known.summary = defaults.known.summary;
            delete entry.preferenceDefaults;
            if (defaults.reused) entry.preferenceDefaults = true;
          }
        } else { entry.known = {}; delete entry.preferenceDefaults; }
        entry.known.artifactStore = await this.#newRunStorage(entry);
        entry.requirements = slot.requirements!; entry.replacing = true;
        const preflight = this.#preflightSlot(entry, [], 're-preflight');
        if (preflight) this.#slot(entry, preflight);
        else {
          // Settle scope consent against the old run before replacing it; it approves no phase.
          this.#persistQuestion(entry, 'settled'); settled = true;
          await this.#startRunner(entry, [], this.#defaultSource(entry));
        }
      }
    } else if (slot.kind === 'preflight') {
      const fields = slot.fields ?? slot.args.questions.length;
      const startup = entry.clarifications;
      await this.#startRunner(entry, selections.slice(0, fields), !fields ? this.#defaultSource(entry) : typed ? 'typed-answer' : 'native-question');
      // The run exists now, so the answers ride with its first phase like any later clarification.
      if (startup.length) this.#settleClarifications(entry, startup, selections.slice(fields), this.#boundaryPhase(entry));
      entry.clarifications = [];
    } else if (slot.kind === 'clarification') {
      this.#settleClarifications(entry, entry.clarifications, selections, slot.phase!);
      entry.clarifications = [];
      this.#nextReviewQuestion(entry);
    } else if (slot.kind === 'route') {
      const answer = selections[0]![0];
      if (answer === ROUTE_LABELS.stop) {
        entry.state = 'paused';
        entry.reason = 'The user stopped before either route was authorized. No phase was authorized or rejected.';
        this.runner.approvalStopped?.(sessionID);
      } else if (answer === ROUTE_LABELS.force) {
        this.runner.forceRoute?.(sessionID);
        entry.state = 'active';
        delete entry.notice;
      } else {
        this.runner.approveNative(sessionID, slot.phase!);
        entry.state = 'active';
        delete entry.notice;
      }
    } else if (slot.kind === 'risk-recovery') {
      const answer = selections[0]![0];
      if (answer === RISK_RECOVERY_LABELS.stop) {
        entry.state = 'paused';
        entry.reason = 'The user stopped without retrying the risk assessment or choosing a route. The run remains blocked at blocked-risk.';
        this.runner.approvalStopped?.(sessionID);
      } else if (answer === RISK_RECOVERY_LABELS.retry) {
        this.runner.retryRisk?.(sessionID);
        entry.state = 'active';
        delete entry.notice;
      } else if (answer === RISK_RECOVERY_LABELS.low) {
        this.runner.chooseManualRoute?.(sessionID, 'low');
        entry.state = 'active';
        delete entry.notice;
      } else {
        this.runner.chooseManualRoute?.(sessionID, 'high');
        entry.state = 'active';
        delete entry.notice;
      }
    } else if (selections[0]![0] === APPROVAL_LABELS.pause) {
      entry.state = 'paused';
      entry.reason = 'The user paused before the next phase. No phase was authorized or rejected.';
      this.runner.approvalStopped?.(sessionID);
    } else if (selections[0]![0] === APPROVAL_LABELS.detail) {
      const current = this.runner.status(sessionID);
      if (!('runID' in current) || !slot.phase) throw new Error('Phase detail is no longer available.');
      this.#slot(entry, { kind: 'approval', phase: slot.phase, args: approvalEnvelope(current.runID, slot.phase) });
      entry.notice = 'Show expandedReport, the full phase report with every narrative section the actor wrote, and the relevant artifact from mdd_status(detail="full") before asking this approval again. Nothing was approved.';
    } else {
      this.runner.approveNative(sessionID, slot.phase!);
      entry.state = 'active';
      delete entry.notice;
    }
    entry.receipts.push({ kind: slot.kind, ...(slot.phase ? { phase: slot.phase } : {}), callID, answers: selections, ...(typed ? { typed } : {}) });
    this.#recordConsent(entry);
    if (!settled && entry.slot === slot) this.#persistQuestion(entry, 'settled');
    if (slot.kind === 'preflight' || (slot.kind === 'change' && selections[0]![0] === CHANGE_LABELS.confirm && entry.state === 'active')) this.#savePreferences(entry);
  }

  /**
   * Nothing was selected, so nothing is approved, accepted or changed and the same question stays
   * open. The coordinator still receives the user's actual words in the question output, so it can
   * answer them and ask again. Ending the run here instead used to throw away a whole route, its
   * evidence and its approvals over one sentence typed in place of a click. What they typed is kept
   * with the reopened question: when their words name one of its options, mdd_answer records it
   * without asking them again.
   */
  #unanswered(entry: Intake, slot: Slot, call: TaskCall, given: readonly string[][]): void {
    this.#persistQuestion(entry, 'cancelled');
    entry.receipts.push({ kind: slot.kind, ...(slot.phase ? { phase: slot.phase } : {}), callID: call.callID, answers: [], cancelled: true });
    this.#recordConsent(entry);
    const pending: Slot = { ...slot };
    delete pending.callID;
    this.#slot(entry, pending, true);
    if (given.length === slot.args.questions.length) entry.typed = { args: structuredClone(entry.slot!.args), given: given.map(selected => [...selected]) };
    const written = ' When their words name one of the offered options, record that with mdd_answer (omit userText) instead of asking again.';
    entry.notice = (slot.kind === 'approval'
      ? 'The user answered in their own words instead of choosing an option, so no phase was approved and nothing was recorded. Read what they actually said and respond to it; when the phase should still go ahead, ask the same approval question again exactly as mdd_status returns it. If their message changes the objective, use mdd_change_request instead.'
      : slot.kind === 'route'
      ? 'The user answered in their own words instead of choosing continue, force or stop, so no route decision was made and nothing was recorded. Read what they actually said and respond to it; when a route choice is still needed, ask the same route question again exactly as mdd_status returns it.'
      : slot.kind === 'risk-recovery'
      ? 'The user answered in their own words instead of choosing retry, a route, or stop, so no risk recovery decision was made and nothing was recorded. Read what they actually said and respond to it; when a recovery choice is still needed, ask the same risk-recovery question again exactly as mdd_status returns it.'
      : slot.kind === 'clarification'
      ? 'The phase was not approved. Read the user\'s words and respond to them; this clarification remains pending. Ask the same clarification question again exactly as mdd_status returns it.'
      : slot.kind === 'change'
      ? 'The user answered the change confirmation in their own words instead of choosing an option, so nothing changed yet: the current run, its answers and its approval stay as they are while the confirmation stays open. Read what they actually said and respond to it; ask the same confirmation again exactly as mdd_status returns it.'
      : 'The user answered in their own words instead of choosing an option, so the run has not started and no answer was recorded. Respond to what they said, then ask the same preflight question again exactly as mdd_status returns it.') + written;
  }

  phaseRecorded(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    if (!entry || entry.state !== 'active') return;
    const status = this.runner.status(sessionID);
    if (!('workflow' in status)) return;
    const next = status.workflow.nextAction;
    if (status.state === 'blocked') {
      // Only a settled blocked-risk offers recovery here; an in-flight assessment never reaches
      // this state, and an unrelated blocked phase keeps its ordinary mdd_reset recovery instead.
      if (next.kind !== 'blocked-risk') return;
      const brief = riskRecoveryBrief(status.reason ?? '');
      this.#slot(entry, { kind: 'risk-recovery', args: riskRecoveryEnvelope(status.runID), ...(brief ? { brief } : {}) });
      return;
    }
    // Automatic mode asks no approval, but a decision the phase could not make on the user's
    // behalf still has to reach them before the next phase builds on a guess.
    const reported = !!this.runner.openQuestions?.(sessionID);
    const asking = next.kind === 'execute' && reported;
    if (next.kind === 'approve' || asking) {
      const old = entry.slot;
      entry.state = 'review-ready'; delete entry.slot; delete entry.notice;
      // Only a completed subsequent phase makes deferred questions eligible again. Never re-offer
      // them at the approval immediately following the original deferral.
      entry.clarifications = entry.deferred;
      entry.deferred = [];
      if (reported) entry.notice = `The phase reported open questions (openQuestions). Present the phase, translate each question into Spanish and submit them with mdd_prepare_advance, together with any of your own, ${asking
        ? 'before the next phase is dispatched. Automatic mode needs no approval afterwards.' : 'before the approval is offered.'}`;
      if (old?.callID) this.#persistQuestion(entry, 'settled', undefined, old);
    }
  }

  /** Configured storage uncertainty is not an actor retry; ordinary report failures still are. */
  storageFailed(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    const status = this.runner.status(sessionID);
    if (!entry || !this.#settings.engram || !('workflow' in status) || status.workflow.answers.artifactStore !== 'engram') return;
    const artifactUnknown = 'artifactAttempts' in status && status.artifactAttempts?.some(attempt => attempt.backend === 'engram' && attempt.status === 'unknown');
    const memoryFailure = 'reason' in status && status.reason?.startsWith('Engram');
    if (!artifactUnknown && !memoryFailure) return;
    entry.state = 'blocked';
    entry.reason = CONFIGURED_STORAGE_BLOCK;
    this.runner.block(sessionID, entry.reason);
    // Seal the blocked state through existing publication, carrying history unchanged, never new consent.
    this.#recordConsent(entry);
  }

  guardTask(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    const status = this.runner.status(sessionID);
    if ('contextual' in status && status.contextual) return;
    if (entry && entry.state !== 'active') throw new Error('A task cannot execute before accepted preflight or its exact phase approval.');
  }

  /** Inspection only: never recover, withdraw or answer an interaction to make an audit fit. */
  guardSecurity(sessionID: string): void {
    const entry = this.#sessions.get(sessionID);
    const question = this.durable.questions?.read(sessionID);
    if ((question && ['prepared', 'pending', 'answered'].includes(question.state)) ||
        (entry && (entry.restore || ['starting', 'accepting', 'await-answer', 'question-ready'].includes(entry.state)))) {
      throw new Error('Finish the pending native interaction before a standalone security audit.');
    }
    this.guardStandalone(sessionID);
  }

  /** A standalone judgment spends no phase approval and must not replace a pending interaction. */
  guardStandalone(sessionID: string): void {
    if (this.#adaptiveNative?.busy(sessionID)) throw new Error('A native policy question or intake is pending.');
    const entry = this.#sessions.get(sessionID);
    if (this.durable.ownership?.intake(sessionID)?.state === 'pending' || this.#unresolved(sessionID) ||
        (entry && (entry.restore || !['active', 'review-ready', 'paused'].includes(entry.state)))) {
      throw new Error('Finish the pending native intake interaction before standalone Judgment Day work.');
    }
  }

  nativeError(call: TaskCall): void {
    if (this.#adaptiveNative?.cancel(call)) return;
    this.runner.owner?.(call.sessionID, call.callID);
    const entry = this.#sessions.get(call.sessionID);
    if (!entry || entry.slot?.callID !== call.callID || !['accepting', 'await-answer'].includes(entry.state)) return;
    this.#persistQuestion(entry, 'cancelled');
    entry.receipts.push({ kind: entry.slot.kind, callID: call.callID, answers: [], cancelled: true });
    this.#recordConsent(entry);
    this.runner.release?.(call.sessionID, call.callID);
    delete entry.reserved;
    if (entry.restore) { this.#restore(entry, 'Change cancelled; the current plan and approval are unchanged.'); return; }
    // A closed form is not a refusal, and the user may answer it in their next message instead.
    const written = ' If the user answers it in a message of their own, record that with mdd_answer and their exact message.';
    // The route question stands in for the phase approval, so closing it pauses exactly like an
    // approval does. Stopping here used to block the run and discard the evidence it was about.
    if (['approval', 'clarification', 'route'].includes(entry.slot.kind)) {
      entry.state = 'paused';
      entry.reason = `The native phase question was dismissed. The run and unresolved questions remain; no phase was authorized.${written}`;
      return;
    }
    entry.state = 'stopped';
    entry.reason = `The native question failed or was dismissed. No approval was recorded; do not repeat or dispatch.${written}`;
    // A preflight nobody is answering any more owns nothing: its durable claim is let go, so a
    // fresh start in a restarted process is not refused by a question that already ended.
    if (entry.slot.kind === 'preflight') this.#releaseIntake(entry);
    this.runner.block(call.sessionID, entry.reason);
  }

  #entry(call: TaskCall, args: unknown): Intake | undefined {
    const owner = [...this.#questionOwners].find(([question]) => isDeepStrictEqual(question, args))?.[1];
    if (owner !== undefined && owner !== call.sessionID) throw new Error('MDD question belongs to another parent.');
    return this.#sessions.get(call.sessionID);
  }

  /**
   * Whether MDD issued this native question or still holds its call: a registered envelope, the
   * durable record's question or call, or a call this conversation already showed or answered.
   * With guards off everything else is the coordinator's own question and never reaches MDD.
   */
  claimsQuestion(call: TaskCall, args: unknown): boolean {
    const entry = this.#sessions.get(call.sessionID);
    // An unreadable record proves no claim; in free mode it must not turn into a refusal either.
    let held: QuestionRecord | undefined;
    try { held = this.durable.questions?.read(call.sessionID); } catch { held = undefined; }
    return this.#owned(args) || !!held && (isDeepStrictEqual(args, held.slot.args) || held.callID === call.callID ||
      !!held.retiredCalls?.includes(call.callID)) || !!entry && (entry.slot?.callID === call.callID ||
      !!entry.shown?.calls.includes(call.callID) || entry.receipts.some(receipt => receipt.callID === call.callID));
  }

  /** Both hooks recheck the same facts. Ordinary answers create no MDD authority or state. */
  async #coordinatorQuestion(call: TaskCall, args: unknown): Promise<boolean> {
    const claimed = (value: unknown): boolean => {
      const entry = this.#entry(call, value), held = this.durable.questions?.read(call.sessionID);
      return this.#owned(value) || !!held && (isDeepStrictEqual(value, held.slot.args) || held.callID === call.callID ||
        !!held.retiredCalls?.includes(call.callID)) || !!entry && (entry.slot?.callID === call.callID ||
        !!entry.shown?.calls.includes(call.callID) || entry.receipts.some(receipt => receipt.callID === call.callID));
    };
    if (claimed(args)) return false;
    if (this.inspect.questionInput) {
      const actual = await this.inspect.questionInput(call);
      if (claimed(actual) || !isDeepStrictEqual(actual, args))
        throw new Error('Native question identity differs; an issued call cannot become a coordinator question.');
    }
    // Native inspection yields: eligibility must be checked again after it, not cached per call.
    if (claimed(args)) throw new Error('Native question ownership changed during inspection.');
    this.#refuseMovedAway(call, args);
    const owner = this.runner.owner?.(call.sessionID), entry = this.#sessions.get(call.sessionID);
    const adaptive = this.#adaptiveNative?.status(call.sessionID);
    if (entry?.state === 'question-ready') throw new Error('Question arguments differ from the pending question; a native MDD question is already pending.');
    if (adaptive && ['starting', 'question-ready', 'await-answer', 'await-contract'].includes(String(adaptive.state)) || this.#adaptiveTransfers.has(call.sessionID) ||
        this.durable.ownership?.intake(call.sessionID)?.state === 'pending' || this.#unresolved(call.sessionID) ||
        entry && (entry.restore || ['starting', 'accepting', 'await-answer', 'question-ready'].includes(entry.state)))
      throw new Error('A native MDD question or intake is already pending; no unrelated question may run.');
    if (this.runner.assertCoordinatorQuestionIdle) this.runner.assertCoordinatorQuestionIdle(call.sessionID);
    else if (owner && !this.#closedAdaptive(call.sessionID)) throw new Error('Coordinator question requires proven idle ownership.');
    return true;
  }

  /**
   * A closed version-3 run keeps its parent until a fresh request replaces it, and refusing every
   * question there left the coordinator unable to ask anything before that request: a second
   * question session in the same conversation was impossible. Such a run issues no question of its
   * own, and every question MDD did issue was already matched by the adaptive gate, so a question
   * reaching this point is the coordinator's. An unresolved durable record still refuses: that one
   * may be MDD's own, interrupted, and it is never re-admitted as somebody else's question.
   */
  #closedAdaptive(sessionID: string): boolean {
    if (!this.runner.adaptiveClosed?.(sessionID)) return false;
    const held = this.durable.questions?.read(sessionID);
    return !held || !['prepared', 'pending', 'answered'].includes(held.state);
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

  /**
   * The grouped preflight interaction: the missing fields, then the coordinator's doubts about the
   * request, then the free-form note. The note only rides on a preflight that is asked anyway, so a
   * complete profile still starts at once unless there are genuine doubts. Undefined: nothing to ask.
   */
  #preflightSlot(entry: Intake, startup: Clarification[], tag: 'intake' | 're-preflight'): Slot | undefined {
    const fields = questionEnvelope(entry.known);
    entry.clarifications = [...startup, ...(fields.questions.length ? [structuredClone(PREFLIGHT_NOTE)] : [])];
    if (!fields.questions.length && !entry.clarifications.length) return undefined;
    const args: QuestionEnvelope = { questions: [...fields.questions, ...clarificationEnvelope(entry.clarifications).questions] };
    const id = randomUUID(), brief = clarificationBrief(entry.clarifications);
    for (const question of args.questions) question.question += tag === 'intake' ? ` [MDD intake ${id}]` : ` [MDD re-preflight ${randomUUID()}]`;
    return { kind: 'preflight', fields: fields.questions.length, args, ...(brief ? { brief } : {}) };
  }

  /** The phase the pending interaction belongs to: the one awaiting approval or dispatch. */
  #boundaryPhase(entry: Intake): Phase {
    const status = this.runner.status(entry.runtime.sessionID);
    const next = 'workflow' in status ? status.workflow.nextAction : undefined;
    if (next && 'phase' in next && next.phase) return next.phase;
    if (entry.slot?.phase) return entry.slot.phase;
    throw new Error('Clarification answers have no phase to travel to.');
  }

  /**
   * Hands every answer of one grouped interaction to the next phase as a single context entry,
   * then records them. Deferred and unanswered questions stay unresolved and come back at a later
   * boundary; a deferral picked together with real choices is not a deferral, the choices are.
   */
  #settleClarifications(entry: Intake, items: readonly Clarification[], selections: string[][], phase: Phase): void {
    if (items.length !== selections.length) throw new Error('Clarification answers do not match the pending questions.');
    const parts: string[] = [];
    const answers: Intake['clarificationAnswers'] = [];
    const deferrals: Clarification[] = [];
    items.forEach((item, index) => {
      const chosen = selections[index]!;
      const lone = chosen.length === 1 ? chosen[0] : undefined;
      // Nothing to add is an answer in itself: the request stands as written.
      if (item.note && (!chosen.length || lone === CLARIFICATION_LABELS.nothing)) return;
      const unanswered = !chosen.length && !item.note;
      const deferred = unanswered || (!item.note && lone === CLARIFICATION_LABELS.defer);
      const picked = chosen.length > 1 ? chosen.filter(label => label !== CLARIFICATION_LABELS.defer) : chosen;
      const answer = unanswered ? 'Sin respuesta' : picked.join(', ');
      parts.push(`Question: ${item.question}\n${picked.length > 1 ? `Answers:\n${picked.map(label => `- ${label}`).join('\n')}` : `Answer: ${answer}`}${
        unanswered ? '\nLeft unanswered by the user; unresolved. Do not assume a choice. Continue only with work safe without this decision.'
        : deferred ? '\nDeferred by the user; unresolved. Do not assume a choice. Continue only with work safe without this decision.' : ''}`);
      answers.push({ question: item.question, answer, phase, disposition: deferred ? 'deferred' : 'answered' });
      if (deferred) deferrals.push(item);
    });
    // Keep prose in content, not the bounded label. One entry per interaction, not per question.
    if (parts.length) this.runner.contribute?.({ label: 'Clarification', content: parts.join('\n\n') }, entry.runtime);
    entry.clarificationAnswers = [...entry.clarificationAnswers, ...answers].slice(-CLARIFICATION_ANSWERS_MAX);
    entry.deferred.push(...deferrals);
  }

  async #startRunner(entry: Intake, selections: unknown, source: NonNullable<Intake['provenance']>['preflight']): Promise<void> {
    const expectedState = entry.state;
    // Handed over before the run exists, so the record the runner writes at start already carries
    // the guards rather than waiting for the first phase to close.
    this.#recordConsent(entry);
    // Decode the frozen vector first. Even a historical storage answer cannot select a new backend.
    const answers = { ...answersFromLabels(entry.known, selections), artifactStore: await this.#newRunStorage(entry) };
    const engram = entry.memory;
    await this.runner.start({ requirements: entry.requirements, preflight: { answers },
      ...(entry.context ? { context: entry.context } : {}),
      ...(entry.exploration ? { exploration: entry.exploration } : {}),
      ...(engram ? { engramEndpoint: engram.endpoint, project: engram.project } : {}) }, entry.runtime, { requirementsConfirmed: true, ...(entry.replacing ? { replace: true } : {}), ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}), ...(entry.slot?.callID ? { authorityCallID: entry.slot.callID } : {}) });
    // Runner acceptance ends rollback eligibility, even if local settlement/publication fails.
    entry.known = { ...answers };
    delete entry.inherited; delete entry.restore; delete entry.replacing; delete entry.notice;
    if (entry.intakeToken) this.durable.ownership?.settleIntake(entry.runtime.sessionID, entry.intakeToken);
    if (entry.state !== expectedState) throw new Error('Intake became uncertain during runner initialization.');
    entry.provenance = { requirements: 'native-user', preflight: source, profile: this.#profile.name };
    entry.state = 'active';
    delete entry.reason;
  }

  #restore(entry: Intake, notice: string): void {
    const saved = entry.restore;
    if (!saved) throw new Error('No unchanged run is available to restore.');
    delete entry.slot; delete entry.userMessageID; delete entry.context;
    Object.assign(entry, saved);
    delete entry.restore; delete entry.replacing; delete entry.reason;
    entry.notice = notice;
  }

  #defaults(runtime: Runtime): { known: Partial<Answers>; reused: boolean } {
    const cached = this.#preferences.get(runtime.sessionID);
    if (cached && (cached.directory !== runtime.directory || cached.worktree !== runtime.worktree))
      throw new Error('Session preferences belong to another worktree; no defaults were reused.');
    const choices = this.durable.preferences ? this.durable.preferences.read(runtime) : cached?.choices;
    const known = { ...this.#profile.answers, ...choices };
    delete known.artifactStore;
    return { known, reused: choices !== undefined };
  }

  /** Only explicit MDD settings activate HTTP memory; configured failures propagate, never fall back. */
  async #newRunStorage(entry: Intake): Promise<'engram' | 'local'> {
    const engram = this.#settings.engram;
    if (!engram) return 'local';
    if (!entry.memory) {
      const endpoint = 'endpoint' in engram ? engram.endpoint : await this.#managed!.endpoint();
      const client = new EngramHttp(endpoint, { id: entry.runtime.sessionID, project: '', directory: entry.runtime.directory });
      await client.bootstrap();
      if ('project' in engram && engram.project) entry.notice = 'The deprecated Engram project setting is ignored. Memory is bound to the provider-resolved active workspace; remove project from global settings using mdd config.';
      entry.memory = { endpoint, project: client.project };
    }
    return 'engram';
  }

  #defaultSource(entry: Intake): 'startup-profile' | 'session-preference' {
    return entry.preferenceDefaults ? 'session-preference' : 'startup-profile';
  }

  #savePreferences(entry: Intake): void {
    const choices = { mode: entry.known.mode!, summary: entry.known.summary! };
    try { this.durable.preferences?.write(entry.runtime, choices); }
    catch (error) {
      entry.notice = 'Accepted run choices could not be confirmed as reusable defaults. Inspect the local preference record before retrying.';
      throw error;
    }
    this.#preferences.set(entry.runtime.sessionID, { directory: entry.runtime.directory, worktree: entry.runtime.worktree, choices });
    entry.preferenceDefaults = true;
    entry.notice = 'The planned run is ready. Previous run evidence is retained.';
  }

  /**
   * An intake that stopped or failed exposes nothing any more, so the durable claim it took for its
   * preflight is released. Only this intake's own pending claim is touched; one another process
   * holds keeps fencing. Best effort: an unreadable claim stays, and an explicit reset clears it.
   */
  #releaseIntake(entry: Intake): void {
    const token = entry.intakeToken;
    if (!token || !this.durable.ownership) return;
    try {
      const current = this.durable.ownership.intake(entry.runtime.sessionID);
      if (current?.state === 'pending' && current.token === token) this.durable.ownership.retireIntake(entry.runtime.sessionID, token);
    } catch { /* The claim cannot be confirmed; it keeps fencing until an explicit reset. */ }
  }

  #fail(entry: Intake, error: unknown): never {
    entry.state = 'blocked';
    entry.reason = error instanceof Error ? error.message : 'Unknown native intake outcome.';
    // "Nothing is locked" below has to be true across a restart too.
    this.#releaseIntake(entry);
    this.runner.block(entry.runtime.sessionID, entry.reason);
    throw new Error(`MDD intake stopped: ${entry.reason} Nothing is locked: read mdd_status, then use mdd_reset to start over, or send a fresh request.`);
  }
}
