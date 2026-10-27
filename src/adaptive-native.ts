import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { adaptiveContract, adaptiveQuestionsEnvelope } from './adaptive-low.js';
import type { AdaptiveContract } from './adaptive-low.js';
import { openQuestions } from './open-questions.js';
import { answerFromLabel, parsePartialAnswers, questionEnvelope } from './preflight.js';
import type { QuestionEnvelope } from './preflight.js';
import { validateQuestionRecord } from './question-checkpoint.js';
import type { AdaptiveQuestionBinding, QuestionCheckpointStore, QuestionRecord } from './question-checkpoint.js';
import type { AdaptiveStore } from './adaptive-store.js';
import type { PhaseRunner, Runtime, TaskCall } from './phase-runner.js';
import type { IntakeInspect } from './native-intake.js';
import { nativeQuestionAnswers, UnselectedAnswer } from './native-intake.js';
import type { StartupProfile } from './settings.js';
import type { Answers } from './policy.js';
import { objectWithKeys } from './validation.js';

export type NativePolicy = {
  profile: string; configured: Partial<Answers>; answers: Partial<Answers> & Pick<Answers, 'mode'>;
  /** Actual inspected native answers, retained as history rather than reusable consent. */
  questions: QuestionRecord[];
};
export type NativeOperation = { kind: string; args: Record<string, unknown> };
const KINDS = ['entry', 'select', 'prepare', 'submit', 'close', 'escalate', 'recover', 'transfer', 'transfer-recovery', 'questions'];

/** Canonical JSON binds the complete proposed payload, including scope, purpose and evidence. */
export function nativeOperation(value: unknown): NativeOperation {
  const item = objectWithKeys(value, 'internal native operation', ['kind', 'args']);
  if (!KINDS.includes(String(item.kind)) || !item.args || typeof item.args !== 'object' || Array.isArray(item.args))
    throw new Error('Unsupported internal native operation.');
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
      return Object.fromEntries(Object.getOwnPropertyNames(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined)
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]));
    throw new Error('Native operations require plain JSON data, not caller authority.');
  };
  const operation = canonical(item) as NativeOperation;
  if (Buffer.byteLength(JSON.stringify(operation)) > 160000) throw new Error('Native operation exceeds the question journal budget.');
  return operation;
}

export function validateNativePolicy(value: unknown): NativePolicy {
  const item = objectWithKeys(value, 'frozen native policy', ['profile', 'configured', 'answers', 'questions']);
  const configured = parsePartialAnswers(item.configured), answers = parsePartialAnswers(item.answers);
  if (typeof item.profile !== 'string' || !item.profile.trim() || item.profile.length > 64 || !answers.mode ||
      !Array.isArray(item.questions) || item.questions.length > 64 ||
      !isDeepStrictEqual(configured, item.configured) || !isDeepStrictEqual(answers, item.answers)) throw new Error('Invalid frozen native policy.');
  const questions = item.questions.map(validateQuestionRecord);
  if (questions.some(question => question.version !== 2 || question.state !== 'answered') ||
      new Set(questions.map(question => `${question.parent}:${question.callID}`)).size !== questions.length ||
      Object.entries(configured).some(([key, value]) => answers[key as keyof Answers] !== value) ||
      Object.keys(answers).some(key => key !== 'mode' && !Object.hasOwn(configured, key))) throw new Error('Native policy invents preferences or question provenance.');
  if (!configured.mode && !questions.some(question => question.adaptive?.purpose === 'mode' && question.answer?.[0]?.length === 1 &&
      answerFromLabel('mode', question.answer[0][0]) === answers.mode)) throw new Error('Unset mode requires its actual native mode answer.');
  return { profile: item.profile, configured, answers: answers as NativePolicy['answers'], questions };
}

type Proof = { runtime: Runtime; operation: NativeOperation; policy: NativePolicy; binding?: AdaptiveQuestionBinding['generation']; question?: QuestionRecord; callerMessageID?: string };
const proofs = new WeakMap<object, Proof>();
/** Only the native lifecycle below can mint a proof; caller IDs and serialized flags cannot. */
export function consumeNativeOperation(token: object, runtime: Runtime): Proof {
  const proof = proofs.get(token);
  if (!proof || !isDeepStrictEqual(proof.runtime, runtime)) throw new Error('Actual single-use native operation proof is required.');
  proofs.delete(token); return structuredClone(proof);
}
export type Entry = {
  runtime: Runtime; operation: NativeOperation; policy: NativePolicy; draft?: AdaptiveContract;
  state: 'starting' | 'question-ready' | 'await-answer' | 'await-contract' | 'active' | 'blocked';
  record?: QuestionRecord; reason?: string;
  /** Single-use token of the last execution attempt; identity for rejection proof only, never authority. */
  attempt?: object;
  userMessageID?: string;
  callerMessageID?: string;
  /** The objective is an earlier user message than the turn being answered; it needs fresh confirmation. */
  earlierObjective?: boolean;
};

/**
 * Fresh native confirmation for an earlier request. The labels are the existing operation consent
 * tokens; the question shows the exact objective the user wrote, in Spanish.
 */
function earlierObjectiveEnvelope(objective: string): QuestionEnvelope {
  return { questions: [{ header: 'Pedido anterior',
    question: `Tu último mensaje no repite el pedido. ¿Autorizás implementar este pedido anterior, tal como lo escribiste?\n«${objective}»`,
    multiple: false, options: [{ label: 'Approve operation', description: 'Autorizar la implementación de ese pedido con el contrato presentado.' },
      { label: 'Pause', description: 'Conservar el borrador sin autorizar nada.' }, { label: 'Decline', description: 'No implementar ese pedido.' }] }] };
}

/** Native policy bridge. It selects guarded runner operations; it never executes commands. */
export class AdaptiveNative {
  readonly #entries = new Map<string, Entry>();
  constructor(readonly runner: PhaseRunner, readonly inspect: IntakeInspect, readonly profile: StartupProfile,
    readonly questions: QuestionCheckpointStore, readonly store: AdaptiveStore) {}

  busy(parent: string): boolean {
    const entry = this.#entries.get(parent);
    return !!entry && entry.state !== 'active';
  }

  status(parent: string): Record<string, unknown> | undefined {
    const entry = this.#entries.get(parent);
    // A live entry projects its own state; an unreadable checkpoint must not make that projection (or reset's report) throw.
    const record = entry ? undefined : this.questions.read(parent);
    if (!entry) return record?.version === 2 && ['prepared', 'pending', 'answered'].includes(record.state)
      ? { ...this.runner.status(parent), state: 'blocked', reason: 'Interrupted native question is not consent. Its unresolved outcome remains fenced.' } : undefined;
    return { ...this.runner.status(parent), ...(entry.state !== 'active' ? { state: entry.state } : {}),
      ...(entry.state === 'question-ready' ? { question: structuredClone(entry.record!.slot.args) } : {}),
      ...(entry.reason ? { reason: entry.reason } : {}), nativePolicy: structuredClone(entry.policy),
      ...(entry.state === 'await-contract' ? { clarificationAnswers: structuredClone(entry.policy.questions.at(-1)?.answer) } : {}) };
  }
  /** A projection may read a proposal, never silently rebind it to a newer source or fence. */
  readbackInternal(runtime: Runtime) {
    const entry = this.#entries.get(runtime.sessionID), questionRecord = this.questions.read(runtime.sessionID);
    if (entry && !isDeepStrictEqual(entry.runtime, runtime) || questionRecord?.adaptive &&
        (questionRecord.adaptive.directory !== runtime.directory || questionRecord.adaptive.worktree !== runtime.worktree))
      throw new Error('Native protocol question parent or workspace differs.');
    const pending = entry && ['question-ready', 'await-answer', 'await-contract'].includes(entry.state);
    if (pending) this.#current(entry);
    const transfer = entry && ['transfer', 'transfer-recovery'].includes(entry.operation.kind);
    const sourceRecord = transfer ? this.store.read(String(entry.operation.args.sourceSessionID)) : undefined;
    const sourceOwner = sourceRecord ? this.runner.options.ownership?.read(sourceRecord.runID) : undefined;
    const generation = transfer ? this.#binding(entry.operation, runtime) : undefined;
    if (pending && transfer) {
      const binding = questionRecord!.adaptive!, held = binding.generation!;
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const expected = { parent: runtime.sessionID, nonce: binding.nonce, sequence: held.sequence, digest: held.digest,
        epoch: held.epoch, operationDigest: digest(binding.operation), generationDigest: digest(held), state: 'prepared' };
      if (!isDeepStrictEqual(sourceOwner?.policyQuestion, expected)) throw new Error('Native protocol source policy fence changed.');
    }
    return { native: this.status(runtime.sessionID), questionRecord, proposal: entry ? structuredClone(entry.operation) : undefined,
      sourceRecord, sourceOwner, generation, sourceClaim: sourceRecord ? this.runner.options.ownership?.parentClaim(sourceRecord.sessionID) : undefined };
  }
  #binding(operation: NativeOperation, runtime: Runtime): AdaptiveQuestionBinding['generation'] {
    if (operation.kind === 'entry') return undefined;
    const parent = ['transfer', 'transfer-recovery'].includes(operation.kind) ? String(operation.args.sourceSessionID) : runtime.sessionID;
    const saved = this.store.read(parent), owner = saved && this.runner.options.ownership?.read(saved.runID);
    if (!saved || !owner) throw new Error('A durable native run and owner are required.');
    const native = this.runner.adaptiveNativeGenerationInternal(parent);
    return { runID: saved.runID, sequence: saved.sequence, digest: saved.digest, epoch: owner.epoch,
      ...(['transfer', 'transfer-recovery'].includes(operation.kind) ? native : typeof operation.args.handle === 'string' ? { handle: operation.args.handle } : {}),
      sources: native.sources };
  }
  #current(entry: Entry, record = entry.record): void {
    if (record && (!isDeepStrictEqual(this.questions.read(entry.runtime.sessionID), record) ||
        !isDeepStrictEqual(record.adaptive?.generation, this.#binding(entry.operation, entry.runtime))))
      throw new Error('Native question or proposed operation generation changed; no authority was consumed.');
  }
  async run(value: unknown, runtime: Runtime, callerMessageID?: string): Promise<unknown> {
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the native coordinator may propose adaptive operations.');
    const operation = nativeOperation(value), parent = runtime.sessionID, previous = this.#entries.get(parent);
    const held = this.questions.read(parent);
    if (held && ['prepared', 'pending', 'answered'].includes(held.state)) throw new Error('A native question is unresolved; no overlapping intake or actor operation.');
    if (previous && ['starting', 'question-ready', 'await-answer'].includes(previous.state)) throw new Error('A native policy operation is already pending.');
    const source = ['transfer', 'transfer-recovery'].includes(operation.kind) ? String(operation.args.sourceSessionID) : parent;
    const saved = operation.kind === 'entry' ? undefined : this.store.read(source);
    this.runner.options.ownership?.assertAdaptivePolicyProposalAvailable(source, operation, parent);
    if (['transfer', 'transfer-recovery'].includes(operation.kind)) this.runner.assertAdaptiveNativeTransferProposalInternal(operation, runtime);
    const configured = structuredClone(this.profile.answers);
    const policy: NativePolicy = saved?.nativePolicy ? validateNativePolicy(saved.nativePolicy)
      : { profile: this.profile.name, configured, answers: { ...configured } as NativePolicy['answers'], questions: [] };
    if (operation.kind !== 'entry' && held?.version === 2 && held.state === 'settled' && held.nativeReceipt &&
        !policy.questions.some(question => question.parent === held.parent && question.callID === held.callID)) {
      const { nativeReceipt, ...historical } = held;
      policy.questions.push(validateQuestionRecord({ ...historical, state: 'answered', answer: nativeReceipt.answers }));
    }
    const entry: Entry = { runtime: { ...runtime }, operation, policy, state: 'starting', ...(callerMessageID ? { callerMessageID } : {}) };
    this.#entries.set(parent, entry);
    try {
      if (operation.kind === 'entry') {
        const input = objectWithKeys(operation.args, 'native adaptive entry', ['contract', 'messageID', 'questions']);
        const draft = adaptiveContract(input.contract); entry.draft = draft;
        // The host binds the user message itself from the actual caller; a supplied messageID is
        // only an assertion it checks. Without a host caller the exact identity stays required.
        const userID = callerMessageID || typeof input.messageID === 'string' ? await this.inspect.intake(runtime, draft.objective,
          callerMessageID ?? String(input.messageID), callerMessageID ? 'native-current-objective' : 'objective') : undefined;
        if (callerMessageID && input.messageID !== undefined && userID !== input.messageID)
          throw new Error('Entry messageID must be the user message whose exact text is the objective (normally the current native user turn); a caller-chosen old identity is refused. Omit messageID and the host binds it.');
        if (typeof userID !== 'string')
          throw new Error('Native entry requires its exact original user authorization.');
        entry.userMessageID = userID;
        if (input.messageID === undefined) entry.operation = nativeOperation({ kind: 'entry', args: { ...operation.args, messageID: userID } });
        if (callerMessageID && this.inspect.currentUser) entry.earlierObjective = await this.inspect.currentUser(runtime, callerMessageID) !== userID;
        if (held?.version === 2 && held.adaptive?.purpose === 'product' && held.adaptive.operation.kind === 'entry' &&
            previous?.state !== 'await-contract' && held.userMessageID === userID)
          throw new Error('The original pre-admission draft is not restored as authority; an explicit revised native user request is required.');
        if (previous?.state === 'await-contract') {
          if (!previous.draft || draft.productQuestions.length || ['objective', 'acceptance', 'scope', 'exclusions', 'decisions'].some(key =>
            !isDeepStrictEqual(draft[key as keyof AdaptiveContract], previous.draft![key as keyof AdaptiveContract])))
            throw new Error('Clarification cannot expand or rewrite held business authorization; obtain an explicit revised native request.');
          entry.policy = previous.policy;
        }
        if (draft.productQuestions.length) {
          const questions = openQuestions(input.questions ?? draft.productQuestions.map(question => ({ question, why: 'Resolve the product decision before immutable admission.', options: [] })));
          if (!isDeepStrictEqual(questions.map(question => question.question), draft.productQuestions)) throw new Error('Native product questions must cover the complete draft question set.');
          // Mode is the only missing preference that must be asked; genuine product questions follow it.
          if (entry.policy.answers.mode) return this.#ask(entry, 'product', adaptiveQuestionsEnvelope(questions, 'pending'));
        }
      } else {
        if (!saved) throw new Error('Restore the durable native run before proposing an operation.');
        if (runtime.directory !== saved.directory || runtime.worktree !== saved.worktree) throw new Error('Exact native workspace differs.');
        if (!['transfer', 'transfer-recovery', 'recover'].includes(operation.kind) && this.runner.status(parent).state !== 'await-selection')
          throw new Error('Native policy questions require an actorless idle selection boundary.');
      }
      return await this.#next(entry);
    } catch (error) {
      if (previous?.state === 'await-contract') this.#entries.set(parent, previous);
      else { entry.state = 'blocked'; entry.reason = error instanceof Error ? error.message : String(error); }
      throw error;
    }
  }
  async #next(entry: Entry): Promise<unknown> {
    if (!entry.policy.answers.mode) {
      const mode = questionEnvelope().questions.find(question => question.header === 'Modo')!;
      return this.#ask(entry, 'mode', { questions: [mode] });
    }
    if (entry.draft?.productQuestions.length) {
      const questions = openQuestions(entry.operation.args.questions ?? entry.draft.productQuestions.map(question => ({ question, why: 'Resolve the product decision before immutable admission.', options: [] })));
      return this.#ask(entry, 'product', adaptiveQuestionsEnvelope(questions, 'pending'));
    }
    if (entry.operation.kind === 'questions') {
      const status = this.runner.status(entry.runtime.sessionID);
      if (!('productQuestions' in status) || !status.productQuestions) throw new Error('No actual actor questions are pending.');
      const pending = status.productQuestions;
      if (entry.operation.args.receiptID !== pending.receiptID || entry.operation.args.callID !== pending.callID) throw new Error('Question receipt or actual native actor call differs.');
      return this.#ask(entry, 'product', adaptiveQuestionsEnvelope(pending.questions, 'pending'));
    }
    if (entry.policy.answers.mode === 'interactive') return this.#ask(entry, 'operation', { questions: [{ header: 'Operation approval',
      question: `Authorize only this exact adaptive operation? Native tool permissions still apply.\n${JSON.stringify(entry.operation)}`,
      multiple: false, options: [{ label: 'Approve operation', description: 'Authorize only the operation shown above.' },
        { label: 'Pause', description: 'Keep the work without authorizing this operation.' }, { label: 'Decline', description: 'Do not authorize this operation.' }] }] });
    // Automatic mode skips operation approval, so an earlier request is never admitted on the
    // strength of an unrelated latest turn: the user confirms it natively, once, in this turn.
    if (entry.operation.kind === 'entry' && entry.earlierObjective && entry.draft) return this.#ask(entry, 'operation', earlierObjectiveEnvelope(entry.draft.objective));
    return this.#execute(entry);
  }
  #ask(entry: Entry, purpose: AdaptiveQuestionBinding['purpose'], envelope: QuestionEnvelope): unknown {
    const parent = entry.runtime.sessionID, old = this.questions.read(parent), nonce = randomUUID();
    const args = structuredClone(envelope);
    args.questions[0]!.question = args.questions[0]!.question.replace(' [MDD adaptive pending]', '') + ` [MDD adaptive ${nonce}]`;
    const generation = this.#binding(entry.operation, entry.runtime);
    const record: QuestionRecord = { version: 2, parent, sequence: (old?.sequence ?? -1) + 1,
      requirements: entry.draft?.objective ?? this.store.read(['transfer', 'transfer-recovery'].includes(entry.operation.kind)
        ? String(entry.operation.args.sourceSessionID) : parent)!.data.contract.objective,
      known: structuredClone(entry.policy.answers), ...(generation ? { runID: generation.runID } : {}),
      ...(entry.userMessageID ? { userMessageID: entry.userMessageID } : {}),
      adaptive: { directory: entry.runtime.directory, worktree: entry.runtime.worktree, nonce, purpose,
        operation: structuredClone(entry.operation), ...(generation ? { generation } : {}) },
      state: 'prepared', slot: { kind: 'adaptive', args }, clarifications: [], deferred: [], clarificationAnswers: [],
      ...(old?.callID ? { retiredCalls: [...(old.retiredCalls ?? []), old.callID] } : {}) };
    this.questions.write(parent, record); entry.record = record; entry.state = 'question-ready';
    if (['mode', 'operation'].includes(purpose) && ['transfer', 'transfer-recovery'].includes(entry.operation.kind))
      this.runner.prepareAdaptiveNativeQuestionInternal(record);
    return this.status(parent);
  }
  #find(call: TaskCall, args: unknown): Entry | undefined {
    for (const entry of this.#entries.values()) if (entry.record && isDeepStrictEqual(entry.record.slot.args, args) && entry.runtime.sessionID !== call.sessionID)
      throw new Error('Adaptive native question belongs to another parent.');
    const entry = this.#entries.get(call.sessionID);
    if (!entry?.record) {
      const saved = this.questions.read(call.sessionID);
      if (saved?.version === 2 && ['prepared', 'pending', 'answered'].includes(saved.state)) throw new Error('Interrupted native question cannot resume as live consent.');
      return undefined;
    }
    if (!isDeepStrictEqual(args, entry.record.slot.args)) {
      if (['question-ready', 'await-answer'].includes(entry.state)) throw new Error('Question differs from the exact proposed native envelope.');
      return undefined;
    }
    return entry;
  }
  async before(call: TaskCall, args: unknown): Promise<boolean> {
    const entry = this.#find(call, args); if (!entry) return false;
    if (entry.state !== 'question-ready') throw new Error('Stale or replayed adaptive native question.');
    this.#current(entry);
    const old = entry.record!;
    if (old.retiredCalls?.includes(call.callID)) throw new Error('Native question call was retired.');
    const record = { ...old, sequence: old.sequence + 1, state: 'pending' as const, callID: call.callID };
    this.questions.write(call.sessionID, record); entry.record = record; entry.state = 'await-answer';
    try { await this.inspect.question(entry.runtime, call, record.slot.args); this.#current(entry); }
    catch (error) { entry.state = 'blocked'; throw error; }
    return true;
  }
  async after(call: TaskCall, args: unknown, output: unknown): Promise<boolean> {
    const entry = this.#find(call, args); if (!entry) return false;
    if (entry.state !== 'await-answer' || entry.record!.callID !== call.callID) throw new Error('Native answer call does not match the current question.');
    this.#current(entry);
    await this.inspect.question(entry.runtime, call, entry.record!.slot.args); this.#current(entry);
    let answer: string[][];
    try { answer = nativeQuestionAnswers(entry.record!.slot.args, output, entry.record!.adaptive!.purpose === 'product' ? 0 : undefined); }
    catch (error) {
      this.cancel(call); if (error instanceof UnselectedAnswer) return true; throw error;
    }
    const answered: QuestionRecord = { ...entry.record!, sequence: entry.record!.sequence + 1, state: 'answered', answer };
    this.questions.write(call.sessionID, answered); entry.record = answered;
    const policy = { ...entry.policy, questions: [...entry.policy.questions, structuredClone(answered)] };
    const purpose = answered.adaptive!.purpose;
    if (purpose === 'mode') policy.answers = { ...policy.answers, mode: answerFromLabel('mode', answer[0]![0]) };
    entry.policy = policy;
    const { answer: _answer, ...settled } = answered;
    const record = { ...settled, sequence: answered.sequence + 1, state: 'settled' as const, nativeReceipt: { callID: call.callID, answers: answer } };
    this.questions.write(call.sessionID, record); entry.record = record;
    if (purpose === 'operation' && answer[0]![0] !== 'Approve operation') {
      if (['transfer', 'transfer-recovery'].includes(entry.operation.kind)) this.runner.options.ownership!.releaseAdaptivePolicyQuestion(record);
      entry.state = 'blocked'; entry.reason = 'The native answer did not authorize this operation.'; return true;
    }
    if (purpose === 'product' && answer.some(selections => !selections.length || selections.some(label => /^(pause|decline|stop)$/i.test(label.trim())))) {
      entry.state = 'blocked'; entry.reason = 'The native product question remains unresolved; no operation was authorized.'; return true;
    }
    if (purpose === 'product' && entry.operation.kind === 'entry') {
      entry.state = 'await-contract'; entry.reason = 'Rebuild the compact draft from the actual answers without expanding original native business authorization.'; return true;
    }
    if (purpose === 'mode') {
      if (entry.policy.answers.mode === 'interactive' && ['transfer', 'transfer-recovery'].includes(entry.operation.kind))
        this.runner.options.ownership!.releaseAdaptivePolicyQuestion(record);
      await this.#next(entry);
    }
    else await this.#execute(entry);
    return true;
  }
  cancel(call: TaskCall): boolean {
    const entry = this.#entries.get(call.sessionID);
    if (!entry?.record || entry.record.callID !== call.callID || entry.record.state !== 'pending') return false;
    this.#current(entry);
    const record = { ...entry.record, sequence: entry.record.sequence + 1, state: 'cancelled' as const };
    this.questions.write(call.sessionID, record); entry.record = record; entry.state = 'blocked';
    if (['transfer', 'transfer-recovery'].includes(entry.operation.kind)) this.runner.options.ownership!.releaseAdaptivePolicyQuestion(record);
    entry.reason = 'Native question ended without authorization. Free text, pause and dismissal do not approve operations.'; return true;
  }
  async #execute(entry: Entry): Promise<unknown> {
    this.#current(entry);
    const token = {}, policy = validateNativePolicy(entry.policy), binding = this.#binding(entry.operation, entry.runtime);
    proofs.set(token, { runtime: entry.runtime, operation: entry.operation, policy, ...(binding ? { binding } : {}),
      ...(entry.callerMessageID ? { callerMessageID: entry.callerMessageID } : {}),
      ...(entry.record ? { question: structuredClone(entry.record) } : {}) });
    entry.state = 'starting'; entry.attempt = token;
    try { await this.runner.executeAdaptiveNativeInternal(token, entry.runtime); entry.state = 'active'; delete entry.attempt; return this.status(entry.runtime.sessionID); }
    catch (error) { proofs.delete(token); entry.state = 'blocked'; entry.reason = error instanceof Error ? error.message : String(error); throw error; }
  }

  /**
   * True while a non-active bridge entry's durable question is unresolved (prepared, pending, answered) or
   * cannot be read. Synchronous, non-throwing and read-only: reset must then keep both checkpoint and fence.
   */
  holdsQuestion(parent: string): boolean {
    const entry = this.#entries.get(parent);
    if (!entry || entry.state === 'active') return false;
    try {
      const durable = this.questions.read(parent);
      return !!durable && ['prepared', 'pending', 'answered'].includes(durable.state);
    } catch { return true; }
  }

  /** Side-effect-free classification of a blocked entry for fixed reset; a string is the reason the fence stays. */
  resetFence(runtime: Runtime): { entry: Entry; attempt: object } | string | undefined {
    const parent = runtime.sessionID, entry = this.#entries.get(parent);
    if (!entry || entry.state === 'active') return undefined;
    if (this.holdsQuestion(parent)) return 'A native question is unresolved; its checkpoint and fence were retained.';
    try {
      if (entry.operation.kind !== 'entry' || entry.state !== 'blocked') return 'Only a blocked entry rejected before bootstrap can be released.';
      if (!entry.attempt) return 'No attempt-bound proof that bootstrap was never reached.';
      if (!isDeepStrictEqual(entry.runtime, runtime)) return 'Native coordinator or workspace differs from the rejected attempt.';
      const durable = this.questions.read(parent);
      if (entry.record) {
        if (entry.record.state !== 'settled') return 'The native question is not settled.';
        // An earlier reset may already have cleared the settled checkpoint before a refused release; that retry stays eligible.
        if (durable !== undefined && !isDeepStrictEqual(durable, entry.record)) return 'The durable native question differs from the rejected attempt.';
      } else if (durable && !['settled', 'cancelled'].includes(durable.state)) return 'A native question is unresolved.';
      return { entry, attempt: entry.attempt };
    } catch { return 'Native question state could not be read reliably.'; }
  }

  /** Final reset step: revalidates the exact entry, consumes the runner proof, and only then drops the volatile fence. */
  releaseFence(runtime: Runtime, fence: ReturnType<AdaptiveNative['resetFence']>): { released: true } | { released: false; reason: string } | undefined {
    if (fence === undefined) return undefined;
    if (typeof fence === 'string') return { released: false, reason: fence };
    const { entry, attempt } = fence;
    if (this.#entries.get(runtime.sessionID) !== entry || entry.state !== 'blocked' || entry.attempt !== attempt)
      return { released: false, reason: 'The native entry changed before release.' };
    let reason: string | undefined;
    try { reason = this.runner.consumeAdaptiveEntryRejectionInternal(attempt, runtime); }
    catch { reason = 'Release could not be confirmed.'; }
    if (reason) return { released: false, reason };
    this.#entries.delete(runtime.sessionID);
    return { released: true };
  }
}
