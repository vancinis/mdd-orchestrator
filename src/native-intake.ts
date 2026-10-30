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
import { boundedText } from './phase-runner.js';
import type { PhaseRunner, Runtime, TaskCall } from './phase-runner.js';
import type { QuestionEnvelope } from './preflight.js';
import type { Phase } from './policy.js';
import { freezeProfile, parseSettings } from './settings.js';
import { ManagedMemory } from './managed-memory.js';
import { objectWithKeys } from './validation.js';
import { STABLE_CHECKPOINT_VERSION } from './checkpoint.js';
import type { CheckpointStore } from './checkpoint.js';
import type { QuestionCheckpointStore, QuestionRecord } from './question-checkpoint.js';
import type { RunOwnershipStore } from './run-ownership.js';
import { adaptiveContract } from './adaptive-low.js';
import { AdaptiveNative } from './adaptive-native.js';
import { AdaptiveProtocol } from './adaptive-protocol.js';
import type { SessionPreferenceStore } from './session-preferences.js';

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
type Runner = Pick<PhaseRunner, 'status'> & Partial<Pick<PhaseRunner, 'admitAdaptiveInternal' | 'transferAdaptiveInternal' | 'recoverAdaptiveTransferInternal' | 'explore' | 'movedAway' | 'reset' | 'owner' | 'handoffRecoveredQuestion' | 'adaptiveClosed' | 'assertCoordinatorQuestionIdle'>>;
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
  readonly #adaptiveTransfers = new Set<string>();
  readonly #settings;
  readonly #profile;
  readonly #managed;
  readonly #adaptiveNative?: AdaptiveNative;
  readonly #adaptiveProtocol?: AdaptiveProtocol;
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
    if (this.#unresolved(here.sessionID)) throw new Error('A native intake or question already occupies this parent.');
    if (!this.runner.admitAdaptiveInternal) throw new Error('Internal adaptive runner admission is unavailable.');
    const identity = await this.inspect.intake(here, contract.objective, nativeMessage, 'objective');
    if (this.#adaptiveTransfers.has(here.sessionID)) throw new Error('Adaptive transfer claimed this intake during native inspection.');
    if (typeof identity !== 'string') throw new Error('Exact native objective proof is required; caller-supplied provenance is insufficient.');
    if (this.#unresolved(here.sessionID)) throw new Error('Native intake changed during objective inspection.');
    // Runner independently inspects the same native text/message, ownership and current source.
    return this.runner.admitAdaptiveInternal({ contract, messageID: nativeMessage }, here);
  }

  /** The public adapter supplies the actual assistant caller separately from untrusted JSON. */
  async adaptiveInternal(value: unknown, runtime: Runtime, callerMessageID?: string): Promise<unknown> {
    if (!this.#adaptiveNative) throw new Error('Durable native policy bridge is unavailable.');
    if (this.#adaptiveTransfers.has(runtime.sessionID))
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
        [source, runtime.sessionID].some(id => this.#adaptiveTransfers.has(id) || this.#unresolved(id)))
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
      const orphan = this.#orphanQuestion(sessionID);
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

  /** Read-only investigation needs no accepted run; it only waits for a pending native interaction. */
  async explore(value: unknown, runtime: Runtime): Promise<unknown> {
    if (this.#adaptiveNative?.busy(runtime.sessionID)) throw new Error('A native policy question or intake is pending.');
    if (runtime.agent !== 'mdd-orchestrator' || !this.runner.explore) throw new Error('Only the coordinator may request read-only investigation.');
    await this.runner.explore(value, runtime);
    return this.status(runtime.sessionID);
  }

  reset(runtime: Runtime, scope: 'phase' | 'run'): unknown {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the coordinator may reset MDD state.');
    const intakeToken = this.durable.ownership?.intake(runtime.sessionID)?.token;
    const applied = this.runner.reset?.(runtime.sessionID, scope) ?? { scope: 'run' as const };
    let nativeEntry: ReturnType<AdaptiveNative['releaseFence']>;
    if (applied.scope === 'run') {
      if (intakeToken) {
        const current = this.durable.ownership?.intake(runtime.sessionID);
        if (current?.state !== 'retired') this.durable.ownership?.retireIntake(runtime.sessionID, intakeToken);
      }
      const fence = this.#adaptiveNative?.resetFence(runtime);
      // An unresolved (or unreadable) checkpoint held by a live bridge entry is kept with its fence.
      if (!this.#adaptiveNative?.holdsQuestion(runtime.sessionID)) this.durable.questions?.clear(runtime.sessionID);
      nativeEntry = this.#adaptiveNative?.releaseFence(runtime, fence);
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
    const status = this.runner.status?.(sessionID) ?? { state: 'not-started' };
    const memory = this.#settings.engram ? 'enabled' : 'off';
    // A restored run's frozen answers win over today's settings, even when memory is now off.
    const backend = 'workflow' in status ? status.workflow.answers.artifactStore : undefined;
    const checkpoint = backend === 'local' && 'runID' in status ? this.durable.checkpoint?.read(sessionID)?.checkpoint : undefined;
    const task = checkpoint?.version === STABLE_CHECKPOINT_VERSION && 'runID' in status && checkpoint.runID === status.runID ? checkpoint.data?.task : undefined;
    const storage = backend ? { backend, ...(task ? { taskDirectory: join(task.root, '.mdd', 'tasks', task.name) } : {}) } : undefined;
    if (this.#unresolved(sessionID)) return { ...status, state: 'recovery-blocked', memory, storage, question: undefined, task: undefined,
      provenance: undefined, questionReceipts: [], reason: 'A native question outcome is unconfirmed. Do not ask again or infer an answer. Reinspect native history before any future restoration; explicit run discard remains available.' };
    return { ...status, memory, storage, question: undefined, provenance: undefined, questionReceipts: [] };
  }

  /** An MDD question of a run that moved to another conversation can never answer anything here. */
  #refuseMovedAway(call: TaskCall, args: unknown): void {
    if (!this.runner.movedAway?.(call.sessionID)) return;
    if (this.#claimed(call, args))
      throw new Error('This conversation\'s run moved to another conversation; its native questions cannot approve or answer anything here.');
  }

  /**
   * Version-3 questions are answered by the adaptive bridge. Anything else MDD still claims (a
   * durable record of an earlier question) has no intake left to answer it, so it is refused; every
   * other question is the coordinator's own.
   */
  async beforeQuestion(call: TaskCall, args: unknown): Promise<void> {
    if (await this.#adaptiveNative?.before(call, args)) return;
    this.#refuseMovedAway(call, args);
    this.runner.owner?.(call.sessionID);
    if (await this.#coordinatorQuestion(call, args)) return;
    throw new Error('Native question has no restored intake; no answer is authorized.');
  }

  async afterQuestion(call: TaskCall, args: unknown, output: unknown): Promise<void> {
    if (await this.#adaptiveNative?.after(call, args, output)) return;
    this.#refuseMovedAway(call, args);
    this.runner.owner?.(call.sessionID, call.callID);
    if (await this.#coordinatorQuestion(call, args)) return;
    throw new Error('Native question callback has no current issued question; no answer was accepted.');
  }

  /** Inspection only: never recover, withdraw or answer an interaction to make an audit fit. */
  guardSecurity(sessionID: string): void {
    const question = this.durable.questions?.read(sessionID);
    if (question && ['prepared', 'pending', 'answered'].includes(question.state))
      throw new Error('Finish the pending native interaction before a standalone security audit.');
    this.guardStandalone(sessionID);
  }

  /** A standalone judgment spends no phase approval and must not replace a pending interaction. */
  guardStandalone(sessionID: string): void {
    if (this.#adaptiveNative?.busy(sessionID)) throw new Error('A native policy question or intake is pending.');
    if (this.durable.ownership?.intake(sessionID)?.state === 'pending' || this.#unresolved(sessionID))
      throw new Error('Finish the pending native intake interaction before standalone Judgment Day work.');
  }

  nativeError(call: TaskCall): void {
    if (this.#adaptiveNative?.cancel(call)) return;
    this.runner.owner?.(call.sessionID, call.callID);
  }

  /**
   * Whether MDD issued this native question or still holds its call: the durable record's question
   * or call, or one of its retired calls. With guards off everything else is the coordinator's own
   * question and never reaches MDD.
   */
  claimsQuestion(call: TaskCall, args: unknown): boolean {
    // An unreadable record proves no claim; in free mode it must not turn into a refusal either.
    try { return this.#claimed(call, args); } catch { return false; }
  }

  #claimed(call: TaskCall, args: unknown): boolean {
    const held = this.durable.questions?.read(call.sessionID);
    return !!held && (isDeepStrictEqual(args, held.slot.args) || held.callID === call.callID || !!held.retiredCalls?.includes(call.callID));
  }

  /** Both hooks recheck the same facts. Ordinary answers create no MDD authority or state. */
  async #coordinatorQuestion(call: TaskCall, args: unknown): Promise<boolean> {
    if (this.#claimed(call, args)) return false;
    if (this.inspect.questionInput) {
      const actual = await this.inspect.questionInput(call);
      if (this.#claimed(call, actual) || !isDeepStrictEqual(actual, args))
        throw new Error('Native question identity differs; an issued call cannot become a coordinator question.');
    }
    // Native inspection yields: eligibility must be checked again after it, not cached per call.
    if (this.#claimed(call, args)) throw new Error('Native question ownership changed during inspection.');
    this.#refuseMovedAway(call, args);
    const owner = this.runner.owner?.(call.sessionID);
    const adaptive = this.#adaptiveNative?.status(call.sessionID);
    if (adaptive && ['starting', 'question-ready', 'await-answer', 'await-contract'].includes(String(adaptive.state)) || this.#adaptiveTransfers.has(call.sessionID) ||
        this.durable.ownership?.intake(call.sessionID)?.state === 'pending' || this.#unresolved(call.sessionID))
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

  #unresolved(sessionID: string): QuestionRecord | undefined {
    const record = this.durable.questions?.read(sessionID);
    return record && !['settled', 'cancelled', 'withdrawn'].includes(record.state) ? record : undefined;
  }

}
