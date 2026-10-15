import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalFiles } from './local-files.js';
import { objectWithKeys, ValidationError } from './validation.js';
import { CheckpointStore, STABLE_CHECKPOINT_VERSION } from './checkpoint.js';
import type { StableCheckpoint, StableRunnerState } from './checkpoint.js';
import { ProgressGuard } from './progress.js';
import { QuestionCheckpointStore, retirableRiskRecovery, unresolvedQuestion } from './question-checkpoint.js';
import type { QuestionRecord } from './question-checkpoint.js';
import { Workflow } from './workflow.js';
import { AdaptiveStore } from './adaptive-store.js';
import type { AdaptiveRecord } from './adaptive-store.js';
import { validateAdaptivePublication } from './adaptive-transfer.js';
import type { AdaptiveReceipt } from './adaptive-transfer.js';
import { AdaptiveLow } from './adaptive-low.js';
import { AdaptiveRetirement } from './adaptive-retirement.js';
import { questionEnvelope, answerFromLabel } from './preflight.js';

export const RUN_OWNER_VERSION = 1;
const LIMIT = 4096;
type Identity = { runID: string; sessionID: string; directory: string; worktree: string };
type PolicyQuestion = { parent: string; nonce: string; sequence: number; digest: string; epoch: number;
  operationDigest: string; generationDigest: string; state: 'prepared' | 'consumed'; receiptDigest?: string; callID?: string };
const policyDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function nativePolicyDecision(question: QuestionRecord): boolean {
  if (question.adaptive?.purpose === 'operation')
    return isDeepStrictEqual(question.nativeReceipt, { callID: question.callID, answers: [['Approve operation']] });
  if (question.adaptive?.purpose !== 'mode') return false;
  const mode = questionEnvelope().questions.find(question => question.header === 'Modo')!;
  mode.question += ` [MDD adaptive ${question.adaptive.nonce}]`;
  const selected = question.nativeReceipt?.answers;
  return isDeepStrictEqual(question.slot.args, { questions: [mode] }) && question.nativeReceipt?.callID === question.callID &&
    selected?.length === 1 && selected[0]?.length === 1 && answerFromLabel('mode', selected[0][0]) === 'automatic';
}
export type RunOwner = {
  version: 1; runID: string; ownerSessionID: string; directory: string; worktree: string; epoch: number;
  originSessionID?: string;
  /**
   * Every conversation that owned this run before a finished transfer moved it on, oldest first.
   * A former owner is fenced for good; the newest receipt alone describes the current hand-off.
   */
  formerOwners?: string[];
  state: 'idle' | 'reserved' | 'transferring';
  policyQuestion?: PolicyQuestion;
  callID?: string;
  workers?: { taskID: string; state: 'ready' | 'pending' | 'settled'; callID?: string }[];
  operation?: { name: string; checkpointSequence: number; checkpointDigest: string };
  recovery?: { sourceCallID: string; kind: 'task' | 'question'; checkpointSequence: number; checkpointDigest: string };
  recoveringTransfer?: TargetTransferClaim & { targetSessionID: string; action: 'release-claim' | 'abort-fenced' };
  recoveredTransfer?: { operationID: string; targetSessionID: string; sourceSequence: number; sourceDigest: string;
    action: 'release-claim' | 'abort-fenced' };
  transfer?: { targetSessionID: string; sourceDigest: string; sourceSequence?: number;
    intent?: { operationID: string; nativeUserMessageID: string; requestDigest: string; assistantMessageID?: string;
      adaptive?: { targetDigest: string; admissionDigest: string } } };
  adaptiveReceipt?: AdaptiveReceipt;
  receipt?: { operationID: string; nativeUserMessageID: string; requestDigest: string;
    sourceSessionID: string; sourceSequence: number; sourceDigest: string;
    targetSessionID: string; targetSequence: number; targetDigest: string; targetEventCount: number; targetEventDigest: string;
    assistantMessageID?: string;
    /** Owner epoch the verified receipt was committed at; the receipt alone proves ownership from then on. */
    verifiedEpoch?: number };
};
export type IntakeOwner = { version: 1; sessionID: string; token: string; userMessageID: string; state: 'pending' | 'settled' | 'retired' };
export type TargetTransferClaim = { sourceSessionID: string; sourceSequence: number; sourceDigest: string;
  ownerEpoch: number; operationID: string; nativeUserMessageID: string; requestDigest: string; assistantMessageID?: string;
  adaptive?: { targetDigest: string; admissionDigest: string } };
type ParentOwner = { sessionID: string; runID: string; retired?: true; transfer?: TargetTransferClaim };

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function adaptiveBinding(value: unknown): void {
  if (value === undefined) return;
  const binding = objectWithKeys(value, 'adaptive publication binding', ['targetDigest', 'admissionDigest']);
  if ([binding.targetDigest, binding.admissionDigest].some(item => typeof item !== 'string' || !/^[a-f0-9]{64}$/.test(item)))
    throw new Error('Invalid adaptive publication binding.');
}
function parseParent(value: unknown, sessionID: string): ParentOwner {
  const item = objectWithKeys(value, 'parent owner', ['sessionID', 'runID', 'retired', 'transfer']);
  if (item.sessionID !== sessionID || !text(item.runID, 256) ||
      (item.retired !== undefined && item.retired !== true) || (item.retired && item.transfer))
    throw new ValidationError('Invalid parent owner.');
  if (item.transfer !== undefined) {
    const claim = objectWithKeys(item.transfer, 'target transfer claim', ['sourceSessionID', 'sourceSequence', 'sourceDigest',
      'ownerEpoch', 'operationID', 'nativeUserMessageID', 'requestDigest', 'assistantMessageID', 'adaptive']);
    adaptiveBinding(claim.adaptive);
    if (!text(claim.sourceSessionID, 256) || claim.sourceSessionID === sessionID || !text(claim.operationID, 256) ||
        !text(claim.nativeUserMessageID, 256) || !Number.isSafeInteger(claim.sourceSequence) ||
        (claim.sourceSequence as number) < 0 || !Number.isSafeInteger(claim.ownerEpoch) || (claim.ownerEpoch as number) < 0 ||
        (claim.assistantMessageID !== undefined && !text(claim.assistantMessageID, 256)) ||
        [claim.sourceDigest, claim.requestDigest].some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
      throw new ValidationError('Invalid target transfer claim.');
  }
  return structuredClone(value) as ParentOwner;
}
function parse(value: unknown): RunOwner {
  const item = objectWithKeys(value, 'run owner', ['version', 'runID', 'ownerSessionID', 'originSessionID', 'formerOwners', 'directory', 'worktree', 'epoch', 'state', 'callID', 'workers', 'transfer', 'operation', 'recovery', 'receipt', 'adaptiveReceipt', 'recoveringTransfer', 'recoveredTransfer', 'policyQuestion']);
  if (item.policyQuestion !== undefined) {
    const question = objectWithKeys(item.policyQuestion, 'adaptive policy question fence', ['parent', 'nonce', 'sequence', 'digest', 'epoch', 'operationDigest', 'generationDigest', 'state', 'receiptDigest', 'callID']);
    if (!text(question.parent, 256) || !text(question.nonce, 256) || !['prepared', 'consumed'].includes(String(question.state)) ||
        [question.sequence, question.epoch].some(number => !Number.isSafeInteger(number) || (number as number) < 0) ||
        [question.digest, question.operationDigest, question.generationDigest].some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) ||
        (question.state === 'consumed' ? !text(question.callID, 256) || typeof question.receiptDigest !== 'string' || !/^[a-f0-9]{64}$/.test(question.receiptDigest)
          : question.callID !== undefined || question.receiptDigest !== undefined)) throw new ValidationError('Invalid adaptive policy question fence.');
  }
  if (item.formerOwners !== undefined && (!Array.isArray(item.formerOwners) || item.formerOwners.length > 64 ||
      item.formerOwners.some(entry => !text(entry, 256)) || new Set(item.formerOwners).size !== item.formerOwners.length ||
      item.formerOwners.includes(item.ownerSessionID))) throw new ValidationError('Invalid former owners.');
  if (item.version !== RUN_OWNER_VERSION || !text(item.runID, 256) || !text(item.ownerSessionID, 256) ||
      !text(item.directory, 2048) || !text(item.worktree, 2048) || !Number.isSafeInteger(item.epoch) ||
      (item.epoch as number) < 0 || !['idle', 'reserved', 'transferring'].includes(String(item.state))) throw new ValidationError('Invalid durable run owner.');
  if (item.state === 'reserved') {
    if (!text(item.callID, 256) || item.transfer !== undefined) throw new ValidationError('Invalid reserved owner.');
  } else if (item.callID !== undefined) throw new ValidationError('An idle/transferring owner cannot hold a task.');
  if (item.workers !== undefined) {
    if (item.state !== 'reserved' || item.operation || item.recovery || !Array.isArray(item.workers) || !item.workers.length || item.workers.length > 2)
      throw new ValidationError('Invalid worker reservation.');
    const tasks = new Set(); const calls = new Set();
    for (const value of item.workers) {
      const member = objectWithKeys(value, 'worker reservation member', ['taskID', 'state', 'callID']);
      if (!text(member.taskID, 64) || tasks.has(member.taskID) || !['ready', 'pending', 'settled'].includes(String(member.state)) ||
          (member.state === 'ready' ? member.callID !== undefined : !text(member.callID, 256)) ||
          (member.callID !== undefined && (calls.has(member.callID) || member.callID === item.callID)))
        throw new ValidationError('Invalid worker reservation member.');
      tasks.add(member.taskID); if (member.callID !== undefined) calls.add(member.callID);
    }
  }
  if (item.operation !== undefined) {
    const operation = objectWithKeys(item.operation, 'owner operation', ['name', 'checkpointSequence', 'checkpointDigest']);
    if (item.state !== 'reserved' || item.recovery !== undefined || !text(operation.name, 128) ||
        !Number.isSafeInteger(operation.checkpointSequence) || (operation.checkpointSequence as number) < 0 ||
        typeof operation.checkpointDigest !== 'string' || !/^[a-f0-9]{64}$/.test(operation.checkpointDigest)) throw new ValidationError('Invalid owner operation.');
  }
  if (item.recovery !== undefined) {
    const recovery = objectWithKeys(item.recovery, 'owner recovery', ['sourceCallID', 'kind', 'checkpointSequence', 'checkpointDigest']);
    if (item.state !== 'reserved' || item.operation !== undefined || !text(recovery.sourceCallID, 256) ||
        !['task', 'question'].includes(String(recovery.kind)) || !Number.isSafeInteger(recovery.checkpointSequence) ||
        (recovery.checkpointSequence as number) < 0 || typeof recovery.checkpointDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(recovery.checkpointDigest)) throw new ValidationError('Invalid owner recovery.');
  }
  if (item.state !== 'reserved' && (item.operation !== undefined || item.recovery !== undefined)) throw new ValidationError('Unreserved owner holds an operation.');
  if (item.recoveringTransfer !== undefined) {
    const recovery = objectWithKeys(item.recoveringTransfer, 'transfer recovery', ['sourceSessionID', 'sourceSequence', 'sourceDigest',
      'ownerEpoch', 'operationID', 'nativeUserMessageID', 'requestDigest', 'assistantMessageID', 'targetSessionID', 'action', 'adaptive']);
    adaptiveBinding(recovery.adaptive);
    if (item.state !== 'reserved' || item.operation === undefined || !text(item.callID, 256) ||
        item.callID !== `transfer-recovery-${recovery.operationID}` || recovery.sourceSessionID !== item.ownerSessionID ||
        !text(recovery.targetSessionID, 256) || !['release-claim', 'abort-fenced'].includes(String(recovery.action)) ||
        !Number.isSafeInteger(recovery.sourceSequence) || (recovery.sourceSequence as number) < 0 ||
        !Number.isSafeInteger(recovery.ownerEpoch) || (recovery.ownerEpoch as number) < 0 ||
        !text(recovery.operationID, 256) || !text(recovery.nativeUserMessageID, 256) ||
        (recovery.assistantMessageID !== undefined && !text(recovery.assistantMessageID, 256)) ||
        [recovery.sourceDigest, recovery.requestDigest].some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
      throw new ValidationError('Invalid transfer recovery identity.');
  }
  if (item.recoveredTransfer !== undefined) {
    const recovered = objectWithKeys(item.recoveredTransfer, 'settled transfer recovery', ['operationID', 'targetSessionID',
      'sourceSequence', 'sourceDigest', 'action']);
    if (!text(recovered.operationID, 256) || !text(recovered.targetSessionID, 256) ||
        !Number.isSafeInteger(recovered.sourceSequence) || (recovered.sourceSequence as number) < 0 ||
        typeof recovered.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(recovered.sourceDigest) ||
        !['release-claim', 'abort-fenced'].includes(String(recovered.action)))
      throw new ValidationError('Invalid settled recovery receipt.');
  }
  if (item.originSessionID !== undefined && (!text(item.originSessionID, 256) || item.originSessionID === item.ownerSessionID && item.receipt !== undefined))
    throw new ValidationError('Invalid original owner.');
  if (item.receipt !== undefined) {
    const receipt = objectWithKeys(item.receipt, 'transfer receipt', ['operationID', 'nativeUserMessageID', 'requestDigest', 'sourceSessionID', 'sourceSequence', 'sourceDigest', 'targetSessionID', 'targetSequence', 'targetDigest', 'targetEventCount', 'targetEventDigest', 'assistantMessageID', 'verifiedEpoch']);
    // A re-transfer (B -> C) begins while the previous receipt (A -> B) still describes how B came
    // to own the run; the finished re-transfer replaces it. So a transferring owner may hold one.
    if (!text(receipt.operationID, 256) || !text(receipt.nativeUserMessageID, 256) ||
        (receipt.verifiedEpoch !== undefined && (!Number.isSafeInteger(receipt.verifiedEpoch) || (receipt.verifiedEpoch as number) < 1)) ||
        !text(receipt.sourceSessionID, 256) || receipt.sourceSessionID !== item.originSessionID ||
        receipt.targetSessionID !== item.ownerSessionID || !Number.isSafeInteger(receipt.sourceSequence) ||
        (receipt.sourceSequence as number) < 0 || !Number.isSafeInteger(receipt.targetSequence) || (receipt.targetSequence as number) < 0 ||
        !Number.isSafeInteger(receipt.targetEventCount) || (receipt.targetEventCount as number) < 0 ||
        (receipt.assistantMessageID !== undefined && !text(receipt.assistantMessageID, 256)) ||
        [receipt.sourceDigest, receipt.targetDigest, receipt.targetEventDigest, receipt.requestDigest].some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
      throw new ValidationError('Invalid transfer receipt.');
  }
  if (item.adaptiveReceipt !== undefined) {
    const receipt = objectWithKeys(item.adaptiveReceipt, 'adaptive ownership receipt', ['sourceSessionID', 'sourceSequence', 'sourceDigest',
      'ownerEpoch', 'operationID', 'nativeUserMessageID', 'requestDigest', 'targetSessionID', 'targetSequence', 'targetDigest', 'admissionDigest', 'verifiedEpoch']);
    if (item.receipt !== undefined || !text(receipt.operationID, 256) || !text(receipt.nativeUserMessageID, 256) ||
        receipt.sourceSessionID !== item.originSessionID || receipt.targetSessionID !== item.ownerSessionID ||
        receipt.sourceSessionID === receipt.targetSessionID || !text(receipt.sourceSessionID, 256) ||
        [receipt.sourceSequence, receipt.ownerEpoch, receipt.targetSequence, receipt.verifiedEpoch].some(number => !Number.isSafeInteger(number) || (number as number) < 0) ||
        receipt.verifiedEpoch !== (receipt.ownerEpoch as number) + 2 ||
        [receipt.sourceDigest, receipt.requestDigest, receipt.targetDigest, receipt.admissionDigest].some(digest => typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)))
      throw new Error('Invalid adaptive ownership receipt.');
  }
  if (item.originSessionID !== undefined && item.originSessionID !== item.ownerSessionID && item.receipt === undefined && item.adaptiveReceipt === undefined)
    throw new ValidationError('Transferred owner lacks a receipt.');
  if (item.state === 'transferring') {
    const transfer = objectWithKeys(item.transfer, 'run transfer', ['targetSessionID', 'sourceDigest', 'sourceSequence', 'intent']);
    if (!text(transfer.targetSessionID, 256) || transfer.targetSessionID === item.ownerSessionID ||
        typeof transfer.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(transfer.sourceDigest)) throw new ValidationError('Invalid transfer reservation.');
    if (transfer.sourceSequence !== undefined && (!Number.isSafeInteger(transfer.sourceSequence) || (transfer.sourceSequence as number) < 0))
      throw new ValidationError('Invalid transfer checkpoint sequence.');
    if (transfer.intent !== undefined) {
      const intent = objectWithKeys(transfer.intent, 'transfer intent', ['operationID', 'nativeUserMessageID', 'requestDigest', 'assistantMessageID', 'adaptive']);
      adaptiveBinding(intent.adaptive);
      if (!text(intent.operationID, 256) || !text(intent.nativeUserMessageID, 256) ||
          (intent.assistantMessageID !== undefined && !text(intent.assistantMessageID, 256)) ||
          typeof intent.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(intent.requestDigest))
        throw new ValidationError('Invalid native transfer intent.');
    }
  } else if (item.transfer !== undefined) throw new ValidationError('Unexpected transfer reservation.');
  return structuredClone(value) as RunOwner;
}

/**
 * A strict, monotonic owner journal. A killed process may leave a .lock: never reclaim it by age.
 * A transferring owner deliberately grants neither parent execution authority. There is no finish
 * operation until checkpoint publication and every native dispatch/consent path are fenced.
 */
export class RunOwnershipStore {
  readonly #files: Pick<LocalFiles, 'readStrict' | 'updateStrict'>;
  readonly #root: string;
  constructor(root: string, files: Pick<LocalFiles, 'readStrict' | 'updateStrict'> = new LocalFiles(root)) { this.#root = root; this.#files = files; }
  #name(runID: string): `.mdd/owner-${string}.json` {
    if (!text(runID, 256)) throw new ValidationError('Invalid run owner identity.');
    return `.mdd/owner-${createHash('sha256').update(runID).digest('hex')}.json`;
  }
  #parentName(sessionID: string): `.mdd/parent-owner-${string}.json` {
    if (!text(sessionID, 256)) throw new ValidationError('Invalid parent identity.');
    return `.mdd/parent-owner-${createHash('sha256').update(sessionID).digest('hex')}.json`;
  }
  #intakeName(sessionID: string): `.mdd/intake-${string}.json` {
    if (!text(sessionID, 256)) throw new ValidationError('Invalid intake parent.');
    return `.mdd/intake-${createHash('sha256').update(sessionID).digest('hex')}.json`;
  }
  intake(sessionID: string): IntakeOwner | undefined {
    try {
      const source = this.#files.readStrict(this.#intakeName(sessionID), LIMIT);
      if (source === undefined) return undefined;
      const item = objectWithKeys(JSON.parse(source), 'intake owner', ['version', 'sessionID', 'token', 'userMessageID', 'state']);
      if (item.version !== 1 || item.sessionID !== sessionID || !text(item.token, 256) ||
          !text(item.userMessageID, 256) || !['pending', 'settled', 'retired'].includes(String(item.state))) throw new Error('Invalid intake owner.');
      return item as IntakeOwner;
    } catch { throw new Error('Native intake owner cannot be confirmed; no question may be exposed.'); }
  }
  #intakeWrite(sessionID: string, next: (old: IntakeOwner | undefined) => IntakeOwner): IntakeOwner {
    try {
      let result: IntakeOwner | undefined;
      this.#files.updateStrict(this.#intakeName(sessionID), source => {
        const old = source === undefined ? undefined : this.intakeFromSource(sessionID, source);
        result = next(old);
        return JSON.stringify(result);
      }, LIMIT);
      if (!result || !isDeepStrictEqual(this.intake(sessionID), result)) throw new Error('Intake readback mismatch.');
      return result;
    } catch { throw new Error('Native intake reservation is unconfirmed; no question may be exposed.'); }
  }
  private intakeFromSource(sessionID: string, source: string): IntakeOwner {
    const item = objectWithKeys(JSON.parse(source), 'intake owner', ['version', 'sessionID', 'token', 'userMessageID', 'state']);
    if (item.version !== 1 || item.sessionID !== sessionID || !text(item.token, 256) || !text(item.userMessageID, 256) ||
        !['pending', 'settled', 'retired'].includes(String(item.state))) throw new Error('Invalid intake owner.');
    return item as IntakeOwner;
  }
  claimIntake(sessionID: string, token: string, userMessageID: string): IntakeOwner {
    if (!text(token, 256) || !text(userMessageID, 256)) throw new ValidationError('Invalid native intake claim.');
    return this.#intakeWrite(sessionID, old => {
      if (old?.state === 'pending') throw new Error('Another intake owns this parent.');
      return { version: 1, sessionID, token, userMessageID, state: 'pending' };
    });
  }
  settleIntake(sessionID: string, token: string): void {
    this.#intakeWrite(sessionID, old => {
      if (!old || old.token !== token || old.state !== 'pending') throw new Error('Intake changed.');
      return { ...old, state: 'settled' };
    });
  }
  retireIntake(sessionID: string, token: string): void {
    this.#intakeWrite(sessionID, old => {
      if (!old || old.token !== token || old.state === 'retired') throw new Error('Intake changed.');
      return { ...old, state: 'retired' };
    });
  }
  parent(sessionID: string): string | undefined {
    const claim = this.parentClaim(sessionID);
    return claim?.retired ? undefined : claim?.runID;
  }
  parentClaim(sessionID: string): ParentOwner | undefined {
    try {
      const source = this.#files.readStrict(this.#parentName(sessionID), LIMIT);
      if (source === undefined) return undefined;
      return parseParent(JSON.parse(source), sessionID);
    } catch { throw new Error('Parent run owner cannot be confirmed; no run may start or dispatch.'); }
  }
  /** Atomic per-parent CAS prevents different run IDs from both claiming the same conversation. */
  claimParent(sessionID: string, runID: string, previous?: string): void {
    if (!text(sessionID, 256) || !text(runID, 256)) throw new ValidationError('Invalid parent owner claim.');
    try {
      this.#files.updateStrict(this.#parentName(sessionID), source => {
        if (new AdaptiveStore(this.#root).occupied(sessionID)) throw new Error('Adaptive data occupies this parent.');
        const old = source === undefined ? undefined : parseParent(JSON.parse(source), sessionID);
        if (old?.transfer) throw new Error('Target transfer claim cannot become a fresh run.');
        if (old?.retired === true ? previous !== undefined : old?.runID !== previous) throw new Error('Parent already has another run.');
        return JSON.stringify({ sessionID, runID });
      }, LIMIT);
      if (this.parent(sessionID) !== runID) throw new Error('Parent owner readback mismatch.');
    } catch { throw new Error('Parent run claim is unconfirmed; no new run may dispatch.'); }
  }
  bindParent(sessionID: string, runID: string): void {
    if (!text(sessionID, 256) || !text(runID, 256)) throw new ValidationError('Invalid parent binding.');
    try {
      this.#files.updateStrict(this.#parentName(sessionID), source => {
        if (new AdaptiveStore(this.#root).occupied(sessionID)) throw new Error('Adaptive data cannot bind a fixed run.');
        if (source !== undefined) {
          const old = parseParent(JSON.parse(source), sessionID);
          if (old.sessionID !== sessionID || old.runID !== runID || old.retired !== undefined) throw new Error('Parent binding differs.');
          if (old.transfer) return source;
        }
        return JSON.stringify({ sessionID, runID });
      }, LIMIT);
      if (this.parent(sessionID) !== runID) throw new Error('Parent binding readback mismatch.');
    } catch { throw new Error('Parent run binding is unconfirmed; no task may be exposed.'); }
  }
  /** Parent-lock ordering makes bootstrap intent visible before either lane can claim a writer. */
  bootstrapAdaptive(sessionID: string, runID: string, intent: () => void): void {
    this.#files.updateStrict(this.#parentName(sessionID), source => {
      const old = source === undefined ? undefined : parseParent(JSON.parse(source), sessionID);
      if (old && !old.retired || new CheckpointStore(this.#root).read(sessionID) || new AdaptiveStore(this.#root).occupied(sessionID))
        throw new Error('A fixed or adaptive run already occupies this parent.');
      intent();
      return JSON.stringify({ sessionID, runID });
    }, LIMIT);
    if (this.parent(sessionID) !== runID) throw new Error('Adaptive bootstrap binding is unconfirmed.');
  }
  /** Parent -> run -> journal locks, matching adaptive bootstrap/publication ordering. */
  replaceClosedAdaptive(store: AdaptiveStore, previous: AdaptiveRecord, next: AdaptiveRecord): void {
    const sessionID = previous.sessionID;
    this.#files.updateStrict(this.#parentName(sessionID), source => {
      const claim = source === undefined ? undefined : parseParent(JSON.parse(source), sessionID), owner = this.read(previous.runID);
      const progress = new ProgressGuard(this.#root).read(sessionID), question = new QuestionCheckpointStore(this.#root).read(sessionID);
      if (!claim || claim.retired || claim.runID !== previous.runID || !owner || owner.ownerSessionID !== sessionID || owner.state !== 'idle' ||
          owner.operation || owner.recovery || owner.recoveringTransfer || owner.workers || owner.policyQuestion ||
          this.intake(sessionID)?.state === 'pending' || new CheckpointStore(this.#root).read(sessionID) ||
          !isDeepStrictEqual(store.read(sessionID), previous)) throw new Error('Terminal replacement lost idle ownership or exact generation.');
      if (previous.transfer) this.confirmAdaptiveReceipt(previous.runID, sessionID, store);
      const retirement = new AdaptiveRetirement(store);
      if (retirement.pending(sessionID)) throw new Error('Retirement publication is pending; exact cold reconciliation is required.');
      const archive = retirement.prepare({ version: 1, previous, next, owner, claim, progress: progress ?? null, question: question ?? null });
      this.#finishAdaptiveReplacement(store, archive);
      return JSON.stringify({ sessionID, runID: next.runID });
    }, LIMIT);
    if (this.parent(sessionID) !== next.runID || !isDeepStrictEqual(store.read(sessionID), next))
      throw new Error('Terminal replacement publication is unconfirmed; exact cold reconciliation is required.');
  }
  #finishAdaptiveReplacement(store: AdaptiveStore, archive: NonNullable<ReturnType<AdaptiveRetirement['intent']>>): void {
    const { previous, next, owner } = archive, parent = previous.sessionID;
    const fenced: RunOwner = { ...owner, state: 'reserved', epoch: owner.epoch + 1, callID: `retire-${next.runID}`,
      operation: { name: 'adaptive-retirement', checkpointSequence: previous.sequence, checkpointDigest: previous.digest } };
    this.#write(previous.runID, current => {
      if (!isDeepStrictEqual(current, owner) && !isDeepStrictEqual(current, fenced)) throw new Error('Retirement owner CAS differs.');
      if (!isDeepStrictEqual(new AdaptiveRetirement(store).intent(parent), archive)) throw new Error('Retirement archive changed.');
      const live = store.read(parent);
      if (!isDeepStrictEqual(live, previous) && !isDeepStrictEqual(live, next)) throw new Error('Retirement record generation changed.');
      return fenced;
    });
    // The durable run reservation now fences every old-process writer and transfer callback.
    const marker = new ProgressGuard(this.#root).read(parent);
    if (marker) {
      if (!isDeepStrictEqual(marker, archive.progress)) throw new Error('Retirement progress differs from its preserved archive.');
      new ProgressGuard(this.#root).clear(parent);
      if (new ProgressGuard(this.#root).read(parent)) throw new Error('Retirement marker cleanup is unconfirmed.');
    }
    if (isDeepStrictEqual(store.read(parent), previous)) store.replaceClosedIf(parent, previous, next);
    if (!isDeepStrictEqual(store.read(parent), next)) throw new Error('Retirement bootstrap readback differs.');
  }
  /** Called only after cold native inspection confirms the exact archived fresh admission. */
  reconcileAdaptiveReplacement(store: AdaptiveStore, expected: NonNullable<ReturnType<AdaptiveRetirement['pending']>>): void {
    const parent = expected.previous.sessionID;
    this.#files.updateStrict(this.#parentName(parent), source => {
      const claim = source === undefined ? undefined : parseParent(JSON.parse(source), parent);
      if (!isDeepStrictEqual(new AdaptiveRetirement(store).intent(parent), expected) ||
          !isDeepStrictEqual(claim, expected.claim) && !isDeepStrictEqual(claim, { sessionID: parent, runID: expected.next.runID }) ||
          this.intake(parent)?.state === 'pending' || new CheckpointStore(this.#root).read(parent)) throw new Error('Cold retirement binding, occupancy or generation differs.');
      const nextOwner = this.read(expected.next.runID);
      if (nextOwner && (!isDeepStrictEqual(claim, { sessionID: parent, runID: expected.next.runID }) ||
          !isDeepStrictEqual(nextOwner, { version: RUN_OWNER_VERSION, runID: expected.next.runID, ownerSessionID: parent, originSessionID: parent,
            directory: expected.next.directory, worktree: expected.next.worktree, epoch: 0, state: 'idle' })))
        throw new Error('Cold replacement bootstrap owner is not the exact initial idle claim.');
      const question = new QuestionCheckpointStore(this.#root).read(parent);
      if (!isDeepStrictEqual(question ?? null, expected.question)) throw new Error('Cold retirement question generation changed.');
      new AdaptiveRetirement(store).publishPointer(expected);
      this.#finishAdaptiveReplacement(store, expected);
      return JSON.stringify({ sessionID: parent, runID: expected.next.runID });
    }, LIMIT);
    if (this.parent(parent) !== expected.next.runID || !isDeepStrictEqual(store.read(parent), expected.next))
      throw new Error('Cold retirement readback is unconfirmed.');
  }
  bindAdaptive(sessionID: string, runID: string): void {
    this.#files.updateStrict(this.#parentName(sessionID), source => {
      const old = source === undefined ? undefined : parseParent(JSON.parse(source), sessionID);
      const record = new AdaptiveStore(this.#root).read(sessionID);
      if (!record || record.runID !== runID || old && (old.retired || old.transfer || old.runID !== runID) || new CheckpointStore(this.#root).read(sessionID))
        throw new Error('Adaptive bootstrap or parent binding differs.');
      return JSON.stringify({ sessionID, runID });
    }, LIMIT);
    if (this.parent(sessionID) !== runID) throw new Error('Adaptive parent readback differs.');
  }
  retireParent(sessionID: string, runID: string): void {
    if (new AdaptiveStore(this.#root).occupied(sessionID)) throw new Error('Adaptive state cannot be discarded through fixed recovery.');
    try {
      this.#files.updateStrict(this.#parentName(sessionID), source => {
        const old = source === undefined ? undefined : parseParent(JSON.parse(source), sessionID);
        if (!old || old.runID !== runID || old.retired || old.transfer) throw new Error('Parent owner changed or transfer claim is unresolved.');
        return JSON.stringify({ sessionID, runID, retired: true });
      }, LIMIT);
      if (this.parent(sessionID) !== undefined) throw new Error('Parent retirement readback mismatch.');
    } catch { throw new Error('Parent retirement is unconfirmed; no new run may start.'); }
  }
  /** Discard only the transferred target's live slot under its reserved reset writer. Never change source ownership. */
  retireTransferredParent(sessionID: string, runID: string, callID: string, epoch: number): void {
    const receipt = this.confirmReceipt(runID, sessionID);
    const owner = this.read(runID);
    const marker = new ProgressGuard(this.#root).read(sessionID);
    const question = new QuestionCheckpointStore(this.#root).read(sessionID);
    if (!receipt || !owner || owner.ownerSessionID !== sessionID || owner.state !== 'reserved' ||
        owner.callID !== callID || owner.epoch !== epoch ||
        (owner.operation?.name !== 'mdd_reset' && owner.recovery === undefined) ||
        marker?.state === 'pending' || (question && ['pending', 'answered'].includes(question.state)))
      throw new Error('Transferred target discard is not confirmed; owner and native work remain fenced.');
    try {
      this.#files.updateStrict(this.#parentName(sessionID), source => {
        const old = source === undefined ? undefined : parseParent(JSON.parse(source), sessionID);
        if (!old || old.retired || old.runID !== runID || !old.transfer ||
            old.transfer.sourceSessionID !== receipt.sourceSessionID ||
            old.transfer.operationID !== receipt.operationID || old.transfer.nativeUserMessageID !== receipt.nativeUserMessageID ||
            old.transfer.sourceSequence !== receipt.sourceSequence || old.transfer.sourceDigest !== receipt.sourceDigest ||
            old.transfer.ownerEpoch >= epoch) throw new Error('Transfer claim changed before target discard.');
        return JSON.stringify({ sessionID, runID, retired: true });
      }, LIMIT);
      if (this.parent(sessionID) !== undefined || this.read(runID)?.ownerSessionID !== sessionID)
        throw new Error('Target discard readback mismatch.');
    } catch { throw new Error('Transferred target discard is unconfirmed; source ownership was not restored.'); }
  }
  read(runID: string): RunOwner | undefined {
    try {
      const source = this.#files.readStrict(this.#name(runID), LIMIT);
      if (source === undefined) return undefined;
      const record = parse(JSON.parse(source));
      if (record.runID !== runID) throw new Error('Owner identity mismatch.');
      return record;
    } catch { throw new Error('Run owner cannot be confirmed. Both parents must remain blocked until explicit reconciliation.'); }
  }
  #write(runID: string, update: (old: RunOwner | undefined) => RunOwner): RunOwner {
    try {
      let next: RunOwner | undefined;
      this.#files.updateStrict(this.#name(runID), previous => {
        const old = previous === undefined ? undefined : parse(JSON.parse(previous));
        if (old && old.runID !== runID) throw new Error('Owner identity mismatch.');
        next = parse(update(old));
        return JSON.stringify(next);
      }, LIMIT);
      if (!next || !isDeepStrictEqual(this.read(runID), next)) throw new Error('Owner readback mismatch.');
      return next;
    } catch { throw new Error('Run owner commit is unconfirmed. Neither parent may dispatch; inspect and reconcile explicitly.'); }
  }
  claim(value: Identity): RunOwner {
    if (![value.runID, value.sessionID].every(item => text(item, 256)) ||
        !text(value.directory, 2048) || !text(value.worktree, 2048)) throw new ValidationError('Invalid run owner claim.');
    const adaptive = new AdaptiveStore(this.#root);
    if (adaptive.occupied(value.sessionID) && adaptive.read(value.sessionID)?.runID !== value.runID) throw new Error('Adaptive data occupies this parent.');
    return this.#write(value.runID, old => {
      if (old) throw new Error('Run already has an owner.');
      return { version: RUN_OWNER_VERSION, runID: value.runID, ownerSessionID: value.sessionID, originSessionID: value.sessionID,
        directory: value.directory, worktree: value.worktree, epoch: 0, state: 'idle' };
    });
  }
  reserve(runID: string, sessionID: string, callID: string, epoch: number, operation?: RunOwner['operation']): RunOwner {
    if (!text(callID, 256)) throw new ValidationError('Invalid task call ID.');
    const current = this.read(runID);
    if (current?.originSessionID && current.originSessionID !== current.ownerSessionID) {
      if (current.adaptiveReceipt) this.confirmAdaptiveReceipt(runID, sessionID, new AdaptiveStore(this.#root));
      else this.confirmReceipt(runID, sessionID);
    }
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'idle' || old.policyQuestion || old.epoch !== epoch) throw new Error('No idle owner at this epoch; a policy question may fence it.');
      return { ...old, state: 'reserved', callID, epoch: epoch + 1, ...(operation ? { operation } : {}) };
    });
  }
  handoff(runID: string, sessionID: string, oldCallID: string, resetCallID: string, epoch: number,
    recovery: RunOwner['recovery']): RunOwner {
    if (!text(resetCallID, 256) || !recovery || !text(recovery.sourceCallID, 256) || recovery.sourceCallID !== oldCallID)
      throw new ValidationError('Invalid owner handoff.');
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'reserved' || old.callID !== oldCallID ||
          old.operation || old.recovery || old.workers?.some(member => member.state === 'pending') || old.epoch !== epoch) throw new Error('Original reservation no longer owns this run.');
      const { workers: _workers, ...rest } = old;
      return { ...rest, callID: resetCallID, recovery, epoch: epoch + 1 };
    });
  }
  release(runID: string, sessionID: string, callID: string, epoch: number): RunOwner {
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'reserved' || old.callID !== callID || old.epoch !== epoch ||
          old.workers?.some(member => member.state === 'pending')) throw new Error('Reserved writer does not match or workers remain pending.');
      const { callID: _callID, workers: _workers, operation: _operation, recovery: _recovery, ...rest } = old;
      return { ...rest, state: 'idle', epoch: epoch + 1 };
    });
  }
  reserveWorkers(runID: string, sessionID: string, batchID: string, taskIDs: readonly string[], epoch: number): RunOwner {
    if (!text(batchID, 256) || !taskIDs.length || taskIDs.length > 2 || new Set(taskIDs).size !== taskIDs.length || taskIDs.some(id => !text(id, 64)))
      throw new ValidationError('Invalid worker batch reservation.');
    const current = this.read(runID);
    if (current?.originSessionID && current.originSessionID !== current.ownerSessionID) this.confirmReceipt(runID, sessionID);
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'idle' || old.policyQuestion || old.epoch !== epoch) throw new Error('No idle worker owner.');
      return { ...old, state: 'reserved', callID: batchID, epoch: epoch + 1,
        workers: taskIDs.map(taskID => ({ taskID, state: 'ready' })) };
    });
  }
  admitWorker(runID: string, sessionID: string, batchID: string, taskID: string, callID: string, epoch: number): RunOwner {
    if (!text(callID, 256)) throw new ValidationError('Invalid native worker call.');
    return this.#write(runID, old => {
      const member = old?.workers?.find(member => member.taskID === taskID);
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'reserved' || old.callID !== batchID || old.epoch !== epoch ||
          member?.state !== 'ready' || old.workers!.some(member => member.callID === callID)) throw new Error('Worker admission changed.');
      return { ...old, epoch: epoch + 1, workers: old.workers!.map(member => member.taskID === taskID ? { taskID, callID, state: 'pending' } : member) };
    });
  }
  settleWorker(runID: string, sessionID: string, batchID: string, callID: string, epoch: number): RunOwner {
    return this.#write(runID, old => {
      const member = old?.workers?.find(member => member.callID === callID);
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'reserved' || old.callID !== batchID || old.epoch !== epoch ||
          member?.state !== 'pending') throw new Error('Pending worker does not match.');
      return { ...old, epoch: epoch + 1, workers: old.workers!.map(member => member.callID === callID ? { ...member, state: 'settled' } : member) };
    });
  }
  /** Adaptive writers share the owner lock with transfer fencing, not only a record CAS. */
  publishAdaptiveUpdate(store: AdaptiveStore, previous: AdaptiveRecord, body: Parameters<AdaptiveStore['commit']>[2]): AdaptiveRecord {
    return this.#underOwnerLock(previous.runID, owner => {
      if (store.root !== this.#root || !owner || owner.ownerSessionID !== previous.sessionID ||
          owner.state === 'transferring' || owner.policyQuestion || owner.recoveringTransfer || owner.operation || owner.recovery || owner.workers ||
          this.parent(previous.sessionID) !== previous.runID || owner.directory !== previous.directory || owner.worktree !== previous.worktree)
        throw new Error('Adaptive publication authority is fenced.');
      if (previous.transfer) this.confirmAdaptiveReceipt(previous.runID, previous.sessionID, store);
      return store.commit(previous.sessionID, previous, body);
    });
  }

  /** A target-side question also fences its source under the existing owner lock. Epoch is unchanged:
   * the question binds that epoch, while the new latch invalidates concurrent owner snapshots. */
  prepareAdaptivePolicyQuestion(store: AdaptiveStore, source: AdaptiveRecord, question: QuestionRecord): void {
    const binding = question.adaptive, generation = binding?.generation, operation = binding?.operation;
    this.#write(source.runID, owner => {
      const prior = owner?.policyQuestion;
      const completed = operation?.kind === 'transfer-recovery' && owner?.ownerSessionID === question.parent &&
        owner.adaptiveReceipt?.sourceSessionID === source.sessionID && owner.adaptiveReceipt.operationID === operation.args.operationID;
      if (store.root !== this.#root || !owner || owner.ownerSessionID !== source.sessionID && !completed ||
          owner.directory !== source.directory || owner.worktree !== source.worktree ||
          !isDeepStrictEqual(store.read(source.sessionID), source) || question.version !== 2 || question.state !== 'prepared' ||
          !binding || !['operation', 'mode'].includes(binding.purpose) || !generation || generation.runID !== source.runID ||
          generation.sequence !== source.sequence || generation.digest !== source.digest || generation.epoch !== owner.epoch ||
          binding.directory !== source.directory || binding.worktree !== source.worktree || !generation.sources ||
          !isDeepStrictEqual(generation.sources, AdaptiveLow.restore(source.data, source.directory, false).policySources()) ||
          !operation || !['transfer', 'transfer-recovery'].includes(operation.kind) || operation.args.sourceSessionID !== source.sessionID ||
          operation.args.runID !== source.runID || question.parent === source.sessionID ||
          !isDeepStrictEqual(new QuestionCheckpointStore(this.#root).read(question.parent), question) ||
          (operation.kind === 'transfer' ? owner.state !== 'idle' || owner.operation || owner.recovery || owner.workers || prior !== undefined
            : prior !== undefined && (prior.state !== 'consumed' || prior.parent !== question.parent || !question.retiredCalls?.includes(prior.callID!))))
        throw new Error('Adaptive policy question source or target binding changed.');
      const fence: PolicyQuestion = { parent: question.parent, nonce: binding.nonce, sequence: source.sequence, digest: source.digest,
        epoch: owner.epoch, operationDigest: policyDigest(operation), generationDigest: policyDigest(generation), state: 'prepared' };
      return { ...owner, policyQuestion: fence };
    });
  }
  assertAdaptivePolicyAvailable(sessionID: string, operation?: unknown): void {
    const runID = this.parent(sessionID), fence = runID ? this.read(runID)?.policyQuestion : undefined;
    if (fence && !(fence.state === 'consumed' && operation !== undefined && fence.operationDigest === policyDigest(operation)))
      throw new Error('An adaptive policy question fences this source parent.');
  }
  assertAdaptivePolicyProposalAvailable(sessionID: string, operation: { kind: string; args: Record<string, unknown> }, targetSessionID: string): void {
    const runID = this.parent(sessionID), owner = runID ? this.read(runID) : undefined, fence = owner?.policyQuestion;
    if (!fence) return;
    const prior = new QuestionCheckpointStore(this.#root).read(targetSessionID), parent = this.parentClaim(targetSessionID), claim = parent?.transfer;
    const source = new AdaptiveStore(this.#root).read(sessionID);
    const unclaimedAbort = operation.args.action === 'abort' && source && this.unclaimedAdaptivePolicyProposal(source, targetSessionID, String(operation.args.operationID));
    // Retirement removes the claim before abort settlement. Only that exact reserved cleanup
    // may propose a fresh question; an older receipt cannot bypass its current reservation.
    const retiredReservation = parent?.retired && owner?.recoveringTransfer;
    const knownOperation = retiredReservation ? !!(source && prior && owner && parent &&
      this.#retiredAdaptiveAbortProposal(source, owner, parent, prior, operation, targetSessionID))
      : unclaimedAbort || claim?.sourceSessionID === sessionID && claim.operationID === operation.args.operationID ||
      owner?.adaptiveReceipt?.sourceSessionID === sessionID && owner.adaptiveReceipt.targetSessionID === targetSessionID && owner.adaptiveReceipt.operationID === operation.args.operationID ||
      owner?.recoveredTransfer?.targetSessionID === targetSessionID && owner.recoveredTransfer.operationID === operation.args.operationID;
    if (operation.kind !== 'transfer-recovery' || operation.args.sourceSessionID !== sessionID || operation.args.runID !== runID ||
        fence.state !== 'consumed' || fence.parent !== targetSessionID || !prior || fence.receiptDigest !== policyDigest(prior) || !knownOperation)
      throw new Error('An adaptive policy question fences this source parent.');
  }
  #retiredAdaptiveAbortProposal(source: AdaptiveRecord, owner: RunOwner, parent: ParentOwner, question: QuestionRecord,
    operation: { kind: string; args: Record<string, unknown> }, targetSessionID: string): boolean {
    const recovery = owner.recoveringTransfer, fence = owner.policyQuestion, binding = question.adaptive, generation = binding?.generation;
    if (!recovery?.adaptive || !parent.retired || parent.runID !== source.runID || owner.runID !== source.runID ||
        owner.state !== 'reserved' || owner.ownerSessionID !== source.sessionID || owner.directory !== source.directory || owner.worktree !== source.worktree ||
        recovery.sourceSessionID !== source.sessionID || recovery.targetSessionID !== targetSessionID || recovery.operationID !== operation.args.operationID ||
        operation.kind !== 'transfer-recovery' || operation.args.action !== 'abort' ||
        owner.callID !== `transfer-recovery-${recovery.operationID}` || owner.operation?.name !== 'adaptive-transfer-abort' ||
        owner.operation.checkpointSequence !== recovery.sourceSequence || owner.operation.checkpointDigest !== recovery.sourceDigest ||
        owner.epoch !== recovery.ownerEpoch + (recovery.action === 'abort-fenced' ? 2 : 1) ||
        !fence || fence.state !== 'consumed' || owner.epoch !== fence.epoch + 1 || fence.parent !== targetSessionID ||
        question.version !== 2 || question.state !== 'settled' || question.runID !== source.runID || question.parent !== targetSessionID ||
        !binding || binding.purpose !== 'operation' || binding.directory !== source.directory || binding.worktree !== source.worktree ||
        binding.operation.kind !== 'transfer-recovery' || binding.operation.args.action !== 'abort' ||
        binding.operation.args.sourceSessionID !== source.sessionID || binding.operation.args.runID !== source.runID ||
        binding.operation.args.operationID !== recovery.operationID || !nativePolicyDecision(question) ||
        fence.nonce !== binding.nonce || fence.callID !== question.callID || fence.receiptDigest !== policyDigest(question) ||
        fence.operationDigest !== policyDigest(binding.operation) || fence.generationDigest !== policyDigest(generation) ||
        !generation || generation.runID !== source.runID || generation.sequence !== recovery.sourceSequence || generation.digest !== recovery.sourceDigest ||
        generation.epoch !== fence.epoch || fence.sequence !== recovery.sourceSequence || fence.digest !== recovery.sourceDigest ||
        source.sequence !== recovery.sourceSequence + 1 || source.admissionDigest !== recovery.adaptive.admissionDigest ||
        new AdaptiveStore(this.#root).occupied(targetSessionID) || new CheckpointStore(this.#root).read(targetSessionID) ||
        new ProgressGuard(this.#root).read(targetSessionID) || this.intake(targetSessionID)) return false;
    const { version: _version, sequence: _sequence, digest: _digest, admissionDigest: _admission, ...body } = source;
    const original = new AdaptiveStore(this.#root).prepare(source.sessionID, { ...source, sequence: recovery.sourceSequence - 1 }, body);
    return original.digest === recovery.sourceDigest;
  }
  unclaimedAdaptivePolicyProposal(source: AdaptiveRecord, targetSessionID: string, operationID: string): boolean {
    const owner = this.read(source.runID), fence = owner?.policyQuestion, question = new QuestionCheckpointStore(this.#root).read(targetSessionID);
    const operation = question?.adaptive?.operation;
    return !!(owner?.state === 'idle' && owner.ownerSessionID === source.sessionID && fence?.state === 'consumed' &&
      fence.parent === targetSessionID && question?.state === 'settled' && fence.receiptDigest === policyDigest(question) &&
      question.runID === source.runID && operation?.args.sourceSessionID === source.sessionID && operation.args.operationID === operationID &&
      !this.parentClaim(targetSessionID) && !new AdaptiveStore(this.#root).occupied(targetSessionID) &&
      !new CheckpointStore(this.#root).read(targetSessionID) && !new ProgressGuard(this.#root).read(targetSessionID) && !this.intake(targetSessionID));
  }
  abortAdaptivePolicyProposal(store: AdaptiveStore, source: AdaptiveRecord, targetSessionID: string, operationID: string): RunOwner {
    return this.#write(source.runID, owner => {
      const question = new QuestionCheckpointStore(this.#root).read(targetSessionID);
      if (!owner || !this.unclaimedAdaptivePolicyProposal(source, targetSessionID, operationID) ||
          !this.matchingAdaptivePolicyQuestion(store, source, targetSessionID, operationID) ||
          question?.adaptive?.operation.kind !== 'transfer-recovery' || question.adaptive.operation.args.action !== 'abort')
        throw new Error('Unclaimed adaptive proposal requires a fresh exact native abort receipt.');
      const { policyQuestion: _question, ...rest } = owner;
      return { ...rest, epoch: owner.epoch + 1, recoveredTransfer: { operationID, targetSessionID,
        sourceSequence: source.sequence, sourceDigest: source.digest, action: 'release-claim' } };
    });
  }
  finishAdaptivePolicyQuestion(runID: string, targetSessionID: string, operationID: string): void {
    const owner = this.read(runID);
    if (!owner?.policyQuestion) return;
    this.#write(runID, current => {
      if (!current || !isDeepStrictEqual(current, owner) || current.policyQuestion?.state !== 'consumed' || current.policyQuestion.parent !== targetSessionID ||
          !(current.adaptiveReceipt?.operationID === operationID && current.adaptiveReceipt.targetSessionID === targetSessionID ||
            current.recoveredTransfer?.operationID === operationID && current.recoveredTransfer.targetSessionID === targetSessionID))
        throw new Error('Native policy fence cannot settle an unfinished transfer.');
      const { policyQuestion: _question, ...rest } = current; return rest;
    });
  }
  consumeAdaptivePolicyQuestion(store: AdaptiveStore, source: AdaptiveRecord, question: QuestionRecord): void {
    this.#write(source.runID, owner => {
      const fence = owner?.policyQuestion, binding = question.adaptive;
      if (!owner || !fence || fence.state !== 'prepared' || !binding || fence.parent !== question.parent || fence.nonce !== binding.nonce ||
          fence.sequence !== source.sequence || fence.digest !== source.digest || fence.epoch !== owner.epoch ||
          fence.operationDigest !== policyDigest(binding.operation) || fence.generationDigest !== policyDigest(binding.generation) ||
          !isDeepStrictEqual(store.read(source.sessionID), source) || question.state !== 'settled' || question.version !== 2 ||
          !nativePolicyDecision(question) ||
          !isDeepStrictEqual(new QuestionCheckpointStore(this.#root).read(question.parent), question))
        throw new Error('The exact settled native policy answer cannot be consumed.');
      return { ...owner, policyQuestion: { ...fence, state: 'consumed', callID: question.callID!, receiptDigest: policyDigest(question) } };
    });
  }
  releaseAdaptivePolicyQuestion(question: QuestionRecord): void {
    if (!question.runID) return;
    this.#write(question.runID, owner => {
      const fence = owner?.policyQuestion;
      if (!owner || !fence || fence.parent !== question.parent || fence.nonce !== question.adaptive?.nonce ||
          fence.state !== 'prepared' || !['cancelled', 'settled'].includes(question.state) ||
          !isDeepStrictEqual(new QuestionCheckpointStore(this.#root).read(question.parent), question))
        throw new Error('A different adaptive policy question owns this source fence.');
      const { policyQuestion: _question, ...rest } = owner; return rest;
    });
  }
  /** Narrow occupancy exception: a retained exact receipt is data, not a reusable approval flag. */
  matchingAdaptivePolicyQuestion(store: AdaptiveStore, source: AdaptiveRecord, targetSessionID: string, operationID: string): boolean {
    const owner = this.read(source.runID), fence = owner?.policyQuestion;
    const question = new QuestionCheckpointStore(this.#root).read(targetSessionID), binding = question?.adaptive;
    const actual = store.read(source.sessionID);
    return !!(store.root === this.#root && owner && fence?.state === 'consumed' && actual &&
      owner.directory === source.directory && owner.worktree === source.worktree && actual.runID === source.runID &&
      (owner.ownerSessionID === source.sessionID || owner.ownerSessionID === targetSessionID &&
        owner.adaptiveReceipt?.sourceSessionID === source.sessionID && owner.adaptiveReceipt.operationID === operationID) &&
      question?.version === 2 && question.state === 'settled' && question.runID === source.runID && binding && nativePolicyDecision(question) &&
      question.parent === targetSessionID && fence.parent === targetSessionID && fence.nonce === binding.nonce &&
      (owner.state === 'idle' && owner.epoch === fence.epoch || owner.state === 'transferring' &&
        [fence.epoch, fence.epoch + 1].includes(owner.epoch) || owner.recoveringTransfer && owner.epoch >= fence.epoch && owner.epoch <= fence.epoch + 1) &&
      fence.receiptDigest === policyDigest(question) && fence.callID === question.callID &&
      binding.directory === source.directory && binding.worktree === source.worktree &&
      binding.generation?.sequence === actual.sequence && binding.generation.digest === actual.digest && binding.generation.runID === source.runID &&
      fence.sequence === binding.generation.sequence && fence.digest === binding.generation.digest &&
      isDeepStrictEqual(binding.generation.sources, AdaptiveLow.restore(actual.data, actual.directory, false).policySources()) &&
      fence.generationDigest === policyDigest(binding.generation) && fence.epoch === binding.generation.epoch &&
      fence.operationDigest === policyDigest(binding.operation) && ['transfer', 'transfer-recovery'].includes(binding.operation.kind) &&
      binding.operation.args.sourceSessionID === source.sessionID && binding.operation.args.runID === source.runID &&
      binding.operation.args.operationID === operationID);
  }

  #adaptiveSource(store: AdaptiveStore, source: AdaptiveRecord): void {
    const marker = new ProgressGuard(this.#root).read(source.sessionID);
    const question = new QuestionCheckpointStore(this.#root).read(source.sessionID);
    if (store.root !== this.#root || !isDeepStrictEqual(store.read(source.sessionID), source) || source.stage !== 'active' ||
        !['await-selection', 'completed', 'closed-unverified'].includes(source.data.state) || source.attempt?.state === 'pending' ||
        this.parent(source.sessionID) !== source.runID || new CheckpointStore(this.#root).read(source.sessionID) ||
        this.intake(source.sessionID)?.state === 'pending' || unresolvedQuestion(question) ||
        (marker && (marker.state !== 'settled' || marker.runID !== source.runID || marker.userMessageID !== source.userMessageID ||
          marker.callID !== source.attempt?.callID || marker.attemptID !== source.attempt?.callID || marker.resumable !== false)) ||
        (source.attempt?.state === 'settled' && !marker)) throw new Error('Adaptive source generation or native idle boundary differs.');
  }
  #adaptiveTargetControls(sessionID: string, store: AdaptiveStore, source: AdaptiveRecord, operationID: string): void {
    const question = new QuestionCheckpointStore(this.#root).read(sessionID), fence = this.read(source.runID)?.policyQuestion;
    if (new CheckpointStore(this.#root).read(sessionID) ||
        new ProgressGuard(this.#root).read(sessionID) || this.intake(sessionID) ||
        (question || fence) && !this.matchingAdaptivePolicyQuestion(store, source, sessionID, operationID))
      throw new Error('Adaptive transfer target is occupied.');
  }
  #adaptiveTargetEmpty(sessionID: string, store: AdaptiveStore, source: AdaptiveRecord, operationID: string): void {
    this.#adaptiveTargetControls(sessionID, store, source, operationID);
    if (store.occupied(sessionID)) throw new Error('Adaptive transfer target is occupied.');
  }
  claimAdaptiveTarget(store: AdaptiveStore, source: AdaptiveRecord, target: AdaptiveRecord, epoch: number): void {
    this.#adaptiveSource(store, source); this.#adaptiveTargetEmpty(target.sessionID, store, source, target.transfer!.operationID);
    validateAdaptivePublication(store, source, target, target.transfer!);
    const owner = this.read(source.runID);
    if (!owner || owner.ownerSessionID !== source.sessionID || owner.state !== 'idle' || owner.epoch !== epoch ||
        owner.directory !== source.directory || owner.worktree !== source.worktree || target.transfer?.ownerEpoch !== epoch)
      throw new Error('Adaptive source owner changed before target claim.');
    if (source.transfer) this.confirmAdaptiveReceipt(source.runID, source.sessionID, store);
    const claim = { sessionID: target.sessionID, runID: source.runID, transfer: { ...target.transfer!,
      adaptive: { targetDigest: target.digest, admissionDigest: target.admissionDigest } } };
    this.#files.updateStrict(this.#parentName(target.sessionID), previous => {
      if (previous !== undefined) throw new Error('Adaptive target parent claim is occupied, including closed legacy state.');
      this.#adaptiveSource(store, source); this.#adaptiveTargetEmpty(target.sessionID, store, source, target.transfer!.operationID);
      if (!isDeepStrictEqual(this.read(source.runID), owner)) throw new Error('Adaptive source owner changed.');
      return JSON.stringify(claim);
    }, LIMIT);
    if (!isDeepStrictEqual(this.parentClaim(target.sessionID), claim)) throw new Error('Adaptive target claim readback is unconfirmed.');
  }
  #adaptiveClaim(store: AdaptiveStore, source: AdaptiveRecord, targetSessionID: string, operationID: string): TargetTransferClaim {
    this.#adaptiveSource(store, source);
    const parent = this.parentClaim(targetSessionID), claim = parent?.transfer;
    if (!parent || parent.retired || parent.runID !== source.runID || !claim?.adaptive || claim.operationID !== operationID ||
        claim.sourceSessionID !== source.sessionID || claim.sourceSequence !== source.sequence || claim.sourceDigest !== source.digest ||
        claim.adaptive.admissionDigest !== source.admissionDigest)
      throw new Error('Adaptive transfer claim or native occupancy differs; keep both parents fenced.');
    this.#adaptiveTargetControls(targetSessionID, store, source, operationID);
    return claim;
  }
  beginAdaptiveTransfer(store: AdaptiveStore, source: AdaptiveRecord, targetSessionID: string, operationID: string): RunOwner {
    return this.#write(source.runID, old => {
      const claim = this.#adaptiveClaim(store, source, targetSessionID, operationID);
      if (!old || old.ownerSessionID !== source.sessionID || old.state !== 'idle' || old.epoch !== claim.ownerEpoch ||
          old.directory !== source.directory || old.worktree !== source.worktree) throw new Error('Adaptive source CAS differs.');
      const { sourceSessionID: _session, sourceSequence, sourceDigest, ownerEpoch: _epoch, ...intent } = claim;
      const { recoveredTransfer: _recovered, ...rest } = old;
      return { ...rest, state: 'transferring', epoch: old.epoch + 1, transfer: { targetSessionID, sourceSequence, sourceDigest, intent } };
    });
  }
  #adaptiveFenced(store: AdaptiveStore, source: AdaptiveRecord, targetSessionID: string, operationID: string): { owner: RunOwner; claim: TargetTransferClaim } {
    const claim = this.#adaptiveClaim(store, source, targetSessionID, operationID), owner = this.read(source.runID);
    const { sourceSessionID: _source, sourceSequence, sourceDigest, ownerEpoch, ...intent } = claim;
    if (!owner || owner.ownerSessionID !== source.sessionID || owner.state !== 'transferring' || owner.epoch !== ownerEpoch + 1 ||
        !isDeepStrictEqual(owner.transfer, { targetSessionID, sourceSequence, sourceDigest, intent }))
      throw new Error('Adaptive transfer owner is no longer fenced for this exact operation.');
    return { owner, claim };
  }
  publishAdaptiveTransfer(store: AdaptiveStore, source: AdaptiveRecord, target: AdaptiveRecord): AdaptiveRecord {
    return this.#underOwnerLock(source.runID, () => {
      const { claim } = this.#adaptiveFenced(store, source, target.sessionID, target.transfer!.operationID);
      validateAdaptivePublication(store, source, target, target.transfer!);
      if (target.digest !== claim.adaptive!.targetDigest) throw new Error('Adaptive target projection changed since claim.');
      const actual = store.read(target.sessionID);
      if (actual) {
        if (!isDeepStrictEqual(actual, target)) throw new Error('Divergent adaptive target publication; nothing was replaced.');
        return actual;
      }
      const { version: _version, sequence: _sequence, digest: _digest, admissionDigest: _admission, ...body } = target;
      return store.commit(target.sessionID, undefined, body);
    });
  }
  finishAdaptiveTransfer(store: AdaptiveStore, source: AdaptiveRecord, target: AdaptiveRecord): RunOwner {
    const receipt: AdaptiveReceipt = { ...target.transfer!, targetSessionID: target.sessionID, targetSequence: target.sequence,
      targetDigest: target.digest, admissionDigest: target.admissionDigest, verifiedEpoch: target.transfer!.ownerEpoch + 2 };
    const current = this.read(source.runID);
    if (current?.adaptiveReceipt?.operationID === receipt.operationID && isDeepStrictEqual(current.adaptiveReceipt, receipt)) {
      this.confirmAdaptiveReceipt(source.runID, target.sessionID, store); return current;
    }
    return this.#write(source.runID, old => {
      const fenced = this.#adaptiveFenced(store, source, target.sessionID, receipt.operationID);
      validateAdaptivePublication(store, source, target, target.transfer!);
      if (!isDeepStrictEqual(old, fenced.owner) || target.digest !== fenced.claim.adaptive!.targetDigest ||
          !isDeepStrictEqual(store.read(target.sessionID), target)) throw new Error('Adaptive publication readback differs before ownership commit.');
      const { transfer: _transfer, adaptiveReceipt: _prior, policyQuestion: _question, ...rest } = old!;
      return { ...rest, originSessionID: source.sessionID, ownerSessionID: target.sessionID, epoch: receipt.verifiedEpoch,
        state: 'idle', adaptiveReceipt: receipt, formerOwners: [...new Set([...(old!.formerOwners ?? []), source.sessionID])] };
    });
  }
  confirmAdaptiveReceipt(runID: string, sessionID: string, store: AdaptiveStore): AdaptiveReceipt {
    const owner = this.read(runID), receipt = owner?.adaptiveReceipt, parent = this.parentClaim(sessionID), record = store.read(sessionID);
    if (store.root !== this.#root || !owner || !receipt || owner.ownerSessionID !== sessionID || owner.state === 'transferring' || owner.recoveringTransfer ||
        receipt.targetSessionID !== sessionID || receipt.sourceSessionID !== owner.originSessionID || owner.epoch < receipt.verifiedEpoch ||
        !parent || parent.retired || parent.runID !== runID || !record || record.runID !== runID ||
        record.userMessageID !== receipt.nativeUserMessageID || record.admissionDigest !== receipt.admissionDigest ||
        record.directory !== owner.directory || record.worktree !== owner.worktree ||
        record.sequence < receipt.targetSequence || record.sequence === receipt.targetSequence && record.digest !== receipt.targetDigest)
      throw new Error('Adaptive receipt cannot confirm target authority or record generation.');
    const { targetSessionID: _target, targetSequence: _sequence, targetDigest, admissionDigest, verifiedEpoch: _verified, ...lineage } = receipt;
    if (!isDeepStrictEqual(record.transfer, lineage) || !isDeepStrictEqual(parent.transfer, { ...lineage, adaptive: { targetDigest, admissionDigest } }))
      throw new Error('Adaptive receipt lineage differs from the parent claim or durable record.');
    return receipt;
  }

  /** Reserve abort authority BEFORE retiring target bytes; late finish callbacks lose their CAS. */
  abortAdaptiveTransfer(store: AdaptiveStore, source: AdaptiveRecord, targetSessionID: string, operationID: string): RunOwner {
    let owner = this.read(source.runID);
    if (owner?.recoveredTransfer?.operationID === operationID && owner.recoveredTransfer.targetSessionID === targetSessionID &&
        owner.recoveredTransfer.sourceDigest === source.digest && this.parentClaim(targetSessionID)?.retired) return owner;
    if (!owner?.recoveringTransfer) {
      owner = this.#write(source.runID, old => {
        const claim = this.#adaptiveClaim(store, source, targetSessionID, operationID);
        if (!old || old.ownerSessionID !== source.sessionID ||
            !(old.state === 'idle' && old.epoch === claim.ownerEpoch || old.state === 'transferring' &&
              isDeepStrictEqual(old, this.#adaptiveFenced(store, source, targetSessionID, operationID).owner)))
          throw new Error('Adaptive abort cannot reserve this owner.');
        const { transfer: _transfer, ...rest } = old;
        return { ...rest, state: 'reserved', epoch: old.epoch + 1, callID: `transfer-recovery-${operationID}`,
          operation: { name: 'adaptive-transfer-abort', checkpointSequence: source.sequence, checkpointDigest: source.digest },
          recoveringTransfer: { ...claim, targetSessionID, action: old.state === 'idle' ? 'release-claim' : 'abort-fenced' } };
      });
    }
    const recovery = owner.recoveringTransfer;
    if (!recovery?.adaptive || recovery.operationID !== operationID || recovery.targetSessionID !== targetSessionID ||
        recovery.sourceDigest !== source.digest || recovery.sourceSequence !== source.sequence || owner.ownerSessionID !== source.sessionID ||
        owner.operation?.name !== 'adaptive-transfer-abort') throw new Error('Adaptive abort reservation differs; no cleanup occurred.');
    this.#underOwnerLock(source.runID, current => {
      if (!isDeepStrictEqual(current, owner)) throw new Error('Adaptive abort authority changed.');
      this.#adaptiveTargetControls(targetSessionID, store, source, operationID);
      const actual = store.read(source.sessionID);
      if (!actual) throw new Error('Adaptive abort source generation is absent.');
      const { version: _version, sequence: _sequence, digest: _digest, admissionDigest: _admission, ...body } = source;
      if (!isDeepStrictEqual(actual, source) && !isDeepStrictEqual(actual, store.prepare(source.sessionID, source, body)))
        throw new Error('Adaptive abort source generation or bytes diverged.');
      this.#adaptiveSource(store, actual);
      const parent = this.parentClaim(targetSessionID);
      const { targetSessionID: _target, action: _action, ...claim } = recovery;
      if (!parent || parent.runID !== source.runID || !parent.retired && !isDeepStrictEqual(parent.transfer, claim))
        throw new Error('Adaptive target claim changed before retirement.');
      const target = store.read(targetSessionID);
      if (target) {
        if (target.sequence !== 0 || target.digest !== recovery.adaptive!.targetDigest || target.runID !== source.runID)
          throw new Error('Divergent target cannot be retired.');
        store.retireIf(targetSessionID, target);
      }
      if (store.occupied(targetSessionID)) throw new Error('Adaptive target retirement readback failed.');
      this.#adaptiveTargetEmpty(targetSessionID, store, source, operationID);
      this.#files.updateStrict(this.#parentName(targetSessionID), previous => {
        if (!isDeepStrictEqual(previous === undefined ? undefined : parseParent(JSON.parse(previous), targetSessionID), parent))
          throw new Error('Adaptive parent retirement CAS differs.');
        return JSON.stringify({ sessionID: targetSessionID, runID: source.runID, retired: true });
      }, LIMIT);
      if (!this.parentClaim(targetSessionID)?.retired) throw new Error('Adaptive parent retirement readback failed.');
      // The source generation also rotates: a process holding the pre-transfer record cannot revive.
      if (actual.sequence === source.sequence) {
        store.commit(source.sessionID, source, body);
      }
    });
    return this.#write(source.runID, old => {
      if (!isDeepStrictEqual(old, owner)) throw new Error('Adaptive abort settlement CAS differs.');
      const { callID: _call, operation: _operation, recoveringTransfer: _recovery, policyQuestion: _question, ...rest } = old!;
      return { ...rest, state: 'idle', epoch: old!.epoch + 1, recoveredTransfer: { operationID, targetSessionID,
        sourceSequence: source.sequence, sourceDigest: source.digest, action: recovery.action } };
    });
  }
  beginTransfer(runID: string, sourceSessionID: string, target: { sessionID: string; directory: string; worktree: string },
    sourceDigest: string, epoch: number, sourceSequence?: number, intent?: NonNullable<RunOwner['transfer']>['intent']): RunOwner {
    if (!text(target.sessionID, 256) || target.sessionID === sourceSessionID ||
        typeof sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(sourceDigest)) throw new ValidationError('Invalid transfer request.');
    if (intent && sourceSequence !== undefined) {
      const claim = this.parentClaim(target.sessionID)?.transfer;
      const saved = new CheckpointStore(this.#root).read(sourceSessionID)?.checkpoint;
      if (!claim || !isDeepStrictEqual(claim, { sourceSessionID, sourceSequence, sourceDigest, ownerEpoch: epoch, ...intent }) ||
          saved?.version !== STABLE_CHECKPOINT_VERSION || saved.runID !== runID || saved.sequence !== sourceSequence ||
          saved.dataDigest !== sourceDigest) throw new Error('Target claim or exact source checkpoint changed before fencing.');
    }
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sourceSessionID || old.state !== 'idle' || old.epoch !== epoch ||
          old.directory !== target.directory || old.worktree !== target.worktree) throw new Error('Source owner or workspace does not match.');
      const { recoveredTransfer: _recoveredTransfer, ...rest } = old;
      return { ...rest, state: 'transferring', transfer: { targetSessionID: target.sessionID, sourceDigest,
        ...(sourceSequence === undefined ? {} : { sourceSequence }), ...(intent ? { intent } : {}) }, epoch: epoch + 1 };
    });
  }

  /** The first durable transfer write claims the target; the source stays runnable until its owner CAS. */
  claimTargetForTransfer(runID: string, sourceSessionID: string,
    target: { sessionID: string; directory: string; worktree: string }, expected: { sequence: number; digest: string },
    epoch: number, intent: NonNullable<RunOwner['transfer']>['intent']): ParentOwner {
    if (new AdaptiveStore(this.#root).occupied(target.sessionID) || new AdaptiveStore(this.#root).occupied(sourceSessionID))
      throw new Error('Adaptive data cannot participate in fixed transfer.');
    if (!intent || !text(intent.operationID, 256) || !text(intent.nativeUserMessageID, 256) ||
        typeof intent.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(intent.requestDigest) ||
        (intent.assistantMessageID !== undefined && !text(intent.assistantMessageID, 256)) ||
        !text(target.sessionID, 256) || target.sessionID === sourceSessionID) throw new ValidationError('Invalid target transfer request.');
    const source = new CheckpointStore(this.#root).read(sourceSessionID)?.checkpoint;
    const owner = this.read(runID);
    const sourceQuestion = new QuestionCheckpointStore(this.#root).read(sourceSessionID);
    // A bound risk-recovery question is re-askable, not consent: it never fences a claim here,
    // because `claimTargetForTransfer` is the point this adapter actually retires it (see below)
    // and the target is reissued a fresh one only once its own ownership is confirmed. Every
    // other outstanding native question kind still fences the move.
    // Only a risk-recovery question bound to exactly this run and source checkpoint is exempt; a
    // stale, foreign or unbound one fences the claim like any other unresolved question.
    const retirable = source?.version === STABLE_CHECKPOINT_VERSION && retirableRiskRecovery(sourceQuestion, source);
    const sourceQuestionFences = unresolvedQuestion(sourceQuestion) && !retirable;
    if (source?.version !== STABLE_CHECKPOINT_VERSION || source.runID !== runID || source.parent !== sourceSessionID ||
        source.sequence !== expected.sequence || source.dataDigest !== expected.digest || source.data.directory !== target.directory ||
        source.data.worktree !== target.worktree || ['await-result', 'risk-await-result'].includes(source.stable.state) ||
        !owner || owner.ownerSessionID !== sourceSessionID || owner.state !== 'idle' || owner.epoch !== epoch ||
        this.parent(sourceSessionID) !== runID || new ProgressGuard(this.#root).read(sourceSessionID)?.state === 'pending' ||
        sourceQuestionFences ||
        new CheckpointStore(this.#root).read(target.sessionID) || new ProgressGuard(this.#root).read(target.sessionID) ||
        new QuestionCheckpointStore(this.#root).read(target.sessionID) || this.intake(target.sessionID)?.state === 'pending')
      throw new Error('The source is not idle or the target is occupied; no target claim was made.');
    const claim: ParentOwner = { sessionID: target.sessionID, runID,
      transfer: { sourceSessionID, sourceSequence: expected.sequence, sourceDigest: expected.digest, ownerEpoch: epoch, ...intent } };
    let confirmed: ParentOwner;
    try {
      this.#files.updateStrict(this.#parentName(target.sessionID), previous => {
        if (new AdaptiveStore(this.#root).occupied(target.sessionID)) throw new Error('Adaptive target intent appeared.');
        const old = previous === undefined ? undefined : parseParent(JSON.parse(previous), target.sessionID);
        if (old && !old.retired) throw new Error('Target already has a parent claim.');
        return JSON.stringify(claim);
      }, LIMIT);
      const readBack = this.parentClaim(target.sessionID);
      if (!readBack || !isDeepStrictEqual(readBack, claim)) throw new Error('Target claim readback differs.');
      confirmed = readBack;
    } catch { throw new Error('Target claim is unconfirmed; inspect the parent owner before any retry.'); }
    // Retired only now, after the target claim is durably written and read back: a failed claim
    // above leaves the source question intact, and no concurrent source answer taken before this
    // point can ever be mistaken for the target's own fresh recovery question later. The claim
    // already correlates this retirement to the exact same run/checkpoint/operation via `intent`.
    // The delete is compare-and-set against the record inspected above: a source answer or
    // re-issue that landed in between is never discarded; the claim then stays for explicit recovery.
    if (retirable && sourceQuestion) {
      try { new QuestionCheckpointStore(this.#root).clearIf(sourceSessionID, sourceQuestion); }
      catch { throw new Error('The target claim is confirmed but the source native question could not be retired; reconcile explicitly before any retry.'); }
    }
    return confirmed;
  }

  /** Explicit recovery of a claim with no target publication. Never adopts a target or replays a phase. */
  recoverUnpublishedTransfer(runID: string, targetSessionID: string, operationID: string,
    expected: TargetTransferClaim, action: 'release-claim' | 'abort-fenced'): RunOwner {
    const claim = this.parentClaim(targetSessionID);
    const source = new CheckpointStore(this.#root).read(expected.sourceSessionID)?.checkpoint;
    const target = new CheckpointStore(this.#root).read(targetSessionID);
    const owner = this.read(runID);
    const sourceMarker = new ProgressGuard(this.#root).read(expected.sourceSessionID);
    const sourceQuestion = new QuestionCheckpointStore(this.#root).read(expected.sourceSessionID);
    if (!claim?.transfer || claim.retired || claim.runID !== runID || claim.transfer.operationID !== operationID ||
        !isDeepStrictEqual(claim.transfer, expected) || this.parent(expected.sourceSessionID) !== runID ||
        source?.version !== STABLE_CHECKPOINT_VERSION || source.runID !== runID || source.parent !== expected.sourceSessionID ||
        source.sequence !== expected.sourceSequence || source.dataDigest !== expected.sourceDigest ||
        sourceMarker?.state === 'pending' || (sourceMarker && (sourceMarker.runID !== runID || sourceMarker.userMessageID !== source.data.userMessageID)) ||
        (sourceQuestion && ['prepared', 'pending', 'answered'].includes(sourceQuestion.state)) ||
        target || new ProgressGuard(this.#root).read(targetSessionID) ||
        new QuestionCheckpointStore(this.#root).read(targetSessionID) || this.intake(targetSessionID)?.state === 'pending' ||
        !owner || owner.ownerSessionID !== expected.sourceSessionID ||
        (action === 'release-claim' ? owner.state !== 'idle' || owner.epoch !== expected.ownerEpoch :
          owner.state !== 'transferring' || owner.epoch !== expected.ownerEpoch + 1 ||
          owner.transfer?.targetSessionID !== targetSessionID || owner.transfer.sourceSequence !== expected.sourceSequence ||
          owner.transfer.sourceDigest !== expected.sourceDigest ||
          !isDeepStrictEqual(owner.transfer.intent, { operationID, nativeUserMessageID: expected.nativeUserMessageID,
            requestDigest: expected.requestDigest, ...(expected.assistantMessageID ? { assistantMessageID: expected.assistantMessageID } : {}) })))
      throw new Error('Transfer recovery cannot correlate all owners, checkpoints and native work; keep both parents blocked.');
    const callID = `transfer-recovery-${operationID}`;
    const operation = { name: 'transfer-recovery', checkpointSequence: source.sequence, checkpointDigest: source.dataDigest };
    this.#write(runID, old => {
      if (!old || !isDeepStrictEqual(old, owner)) throw new Error('Source fence changed before recovery.');
      const { transfer: _transfer, recoveredTransfer: _recoveredTransfer, ...rest } = old;
      return { ...rest, state: 'reserved', callID, operation,
        recoveringTransfer: { ...expected, targetSessionID, action }, epoch: old.epoch + 1 };
    });
    // A concurrent old transfer callback cannot finish: the owner is no longer idle/transferring.
    return this.reconcileTransferRecovery(runID, targetSessionID, operationID, action);
  }

  /** Explicit idempotent continuation of the SAME interrupted recovery; no orphan lock is stolen. */
  reconcileTransferRecovery(runID: string, targetSessionID: string, operationID: string,
    action: 'release-claim' | 'abort-fenced'): RunOwner {
    const owner = this.read(runID);
    const parent = this.parentClaim(targetSessionID);
    if (owner?.recoveredTransfer?.operationID === operationID &&
        owner.recoveredTransfer.targetSessionID === targetSessionID && owner.recoveredTransfer.action === action &&
        owner.ownerSessionID === owner.originSessionID && parent?.retired && parent.runID === runID) return owner;
    const recovery = owner?.recoveringTransfer;
    if (!owner || owner.state !== 'reserved' || !recovery || owner.callID !== `transfer-recovery-${operationID}` ||
        owner.operation?.name !== 'transfer-recovery' || recovery.operationID !== operationID ||
        recovery.targetSessionID !== targetSessionID || recovery.action !== action ||
        owner.ownerSessionID !== recovery.sourceSessionID || this.parent(recovery.sourceSessionID) !== runID ||
        owner.epoch !== recovery.ownerEpoch + (action === 'release-claim' ? 1 : 2) ||
        owner.operation.checkpointSequence !== recovery.sourceSequence || owner.operation.checkpointDigest !== recovery.sourceDigest ||
        !parent || parent.runID !== runID || (parent.retired ? !!parent.transfer :
          !isDeepStrictEqual(parent.transfer, { sourceSessionID: recovery.sourceSessionID, sourceSequence: recovery.sourceSequence,
            sourceDigest: recovery.sourceDigest, ownerEpoch: recovery.ownerEpoch, operationID, nativeUserMessageID: recovery.nativeUserMessageID,
            requestDigest: recovery.requestDigest, ...(recovery.assistantMessageID ? { assistantMessageID: recovery.assistantMessageID } : {}) })))
      throw new Error('Interrupted recovery intent or owner epoch differs; keep the reservation.');
    try {
      const currentSource = new CheckpointStore(this.#root).read(recovery.sourceSessionID)?.checkpoint;
      const sourceMarker = new ProgressGuard(this.#root).read(recovery.sourceSessionID);
      const sourceQuestion = new QuestionCheckpointStore(this.#root).read(recovery.sourceSessionID);
      if (new CheckpointStore(this.#root).read(targetSessionID) || new ProgressGuard(this.#root).read(targetSessionID) ||
          new QuestionCheckpointStore(this.#root).read(targetSessionID) || this.intake(targetSessionID)?.state === 'pending' ||
          currentSource?.version !== STABLE_CHECKPOINT_VERSION || currentSource.sequence !== recovery.sourceSequence ||
          currentSource.dataDigest !== recovery.sourceDigest || sourceMarker?.state === 'pending' ||
          (sourceMarker && (sourceMarker.runID !== runID || sourceMarker.userMessageID !== currentSource.data.userMessageID)) ||
          (sourceQuestion && ['prepared', 'pending', 'answered'].includes(sourceQuestion.state)))
        throw new Error('Publication or native work appeared during recovery.');
      if (!parent.retired) this.#files.updateStrict(this.#parentName(targetSessionID), previous => {
        const old = previous === undefined ? undefined : parseParent(JSON.parse(previous), targetSessionID);
        if (!old || !isDeepStrictEqual(old, parent) || this.read(runID)?.callID !== owner.callID)
          throw new Error('Target claim or source fence changed.');
        return JSON.stringify({ sessionID: targetSessionID, runID, retired: true });
      }, LIMIT);
      if (this.parent(targetSessionID) !== undefined) throw new Error('Target claim retirement is unconfirmed.');
      return this.#write(runID, old => {
        if (!old || !isDeepStrictEqual(old, owner)) throw new Error('Recovery reservation changed before settlement.');
        const { callID: _callID, operation: _operation, recoveringTransfer: _recovering, ...rest } = old;
        return { ...rest, state: 'idle', epoch: old.epoch + 1,
          recoveredTransfer: { operationID, targetSessionID, sourceSequence: recovery.sourceSequence,
            sourceDigest: recovery.sourceDigest, action } };
      });
    } catch { throw new Error('Transfer recovery is unconfirmed; inspect owner and target claim before any retry.'); }
  }

  /** Experimental fenced reservation only. No plugin invokes this until publication is end-to-end proven. */
  reserveVerifiedTransfer(runID: string, sourceSessionID: string,
    target: { sessionID: string; directory: string; worktree: string }, expected: { sequence: number; digest: string }, epoch: number,
    intent?: NonNullable<RunOwner['transfer']>['intent']): RunOwner {
    if (!intent) throw new ValidationError('Verified transfer needs an exact native target intent.');
    const checkpoints = new CheckpointStore(this.#root);
    const progress = new ProgressGuard(this.#root);
    const questions = new QuestionCheckpointStore(this.#root);
    const source = checkpoints.read(sourceSessionID)?.checkpoint;
    if (source?.version !== STABLE_CHECKPOINT_VERSION || source.runID !== runID || source.parent !== sourceSessionID ||
        source.sequence !== expected.sequence || source.dataDigest !== expected.digest || source.data.directory !== target.directory ||
        source.data.worktree !== target.worktree || ['await-result', 'risk-await-result'].includes(source.stable.state) ||
        this.parent(sourceSessionID) !== runID || this.parent(target.sessionID) !== undefined ||
        checkpoints.read(target.sessionID) || progress.read(target.sessionID) || questions.read(target.sessionID) ||
        this.intake(target.sessionID)?.state === 'pending') throw new Error('Source or target is not an idle, unoccupied transfer boundary.');
    const marker = progress.read(sourceSessionID);
    const question = questions.read(sourceSessionID);
    // A bound risk-recovery question is re-askable, not consent: it is safely retired by the
    // claim below and reissued fresh on the target once ownership is confirmed, exactly like a
    // restart would. Every other kind of outstanding native question still fences the move.
    if (marker?.state === 'pending' || (marker && (marker.runID !== runID || marker.userMessageID !== source.data.userMessageID)) ||
        (unresolvedQuestion(question) && !retirableRiskRecovery(question, source)))
      throw new Error('Source has unresolved work or a native question.');
    this.claimTargetForTransfer(runID, sourceSessionID, target, expected, epoch, intent);
    // A failed source CAS leaves the target claimed and blocked; source may still be runnable.
    return this.beginTransfer(runID, sourceSessionID, target, expected.digest, epoch, expected.sequence, intent);
  }

  /** CAS finalization requires two readable, correlated checkpoints and a reserved target parent. */
  finishVerifiedTransfer(runID: string, sourceSessionID: string, targetSessionID: string, epoch: number,
    expected: { sourceSequence: number; sourceDigest: string; targetSequence: number; targetDigest: string },
    confirmation?: NonNullable<RunOwner['transfer']>['intent']): RunOwner {
    const progress = new ProgressGuard(this.#root);
    const checkpoints = new CheckpointStore(this.#root);
    const owner = this.read(runID);
    const target = checkpoints.read(targetSessionID)?.checkpoint;
    const completedReceipt = confirmation ? { ...confirmation, sourceSessionID, sourceSequence: expected.sourceSequence,
      sourceDigest: expected.sourceDigest, targetSessionID, targetSequence: expected.targetSequence,
      targetDigest: expected.targetDigest,
      targetEventCount: owner?.receipt?.targetEventCount ?? target?.events.length ?? 0,
      targetEventDigest: owner?.receipt?.targetEventDigest ?? createHash('sha256').update(JSON.stringify(target?.events ?? [])).digest('hex'),
      verifiedEpoch: epoch + 1 } : undefined;
    if (owner?.state === 'idle' && owner.ownerSessionID === targetSessionID && owner.epoch >= epoch + 1 &&
        completedReceipt && isDeepStrictEqual(owner.receipt, completedReceipt)) {
      this.confirmReceipt(runID, targetSessionID);
      return owner;
    }
    // Decided and committed under the owner lock: a concurrent abort cannot remove the bytes this
    // commit is about to vouch for, and a concurrent finish cannot commit twice.
    return this.#write(runID, old => {
      const published = this.#publication(runID, sourceSessionID, targetSessionID, epoch, expected, confirmation);
      if (!isDeepStrictEqual(progress.read(targetSessionID), published.progress))
        throw new Error('Target progress is not correlated with the published checkpoint.');
      if (!old || !isDeepStrictEqual(old, published.owner)) throw new Error('Transfer owner changed before finalization.');
      const { transfer: _transfer, ...rest } = old;
      // The new receipt supersedes the previous one; everyone who owned the run before stays fenced.
      const former = [...(old.formerOwners ?? (old.originSessionID && old.originSessionID !== old.ownerSessionID ? [old.originSessionID] : [])),
        sourceSessionID].filter((entry, index, all) => entry !== targetSessionID && all.indexOf(entry) === index).slice(-64);
      return { ...rest, originSessionID: sourceSessionID, ownerSessionID: targetSessionID, state: 'idle', epoch: epoch + 1,
        receipt: completedReceipt!, formerOwners: former };
    });
  }

  /**
   * A fenced transfer whose target checkpoint was published but whose progress marker was not.
   * The marker is the source marker re-addressed to the target's native request — deterministic,
   * so it is regenerated only after the published checkpoint is proven to be that exact projection.
   */
  completePartialPublication(runID: string, sourceSessionID: string, targetSessionID: string, epoch: number,
    expected: { sourceSequence: number; sourceDigest: string; targetSequence: number; targetDigest: string },
    confirmation: NonNullable<RunOwner['transfer']>['intent']): void {
    this.#underOwnerLock(runID, () => {
      const published = this.#publication(runID, sourceSessionID, targetSessionID, epoch, expected, confirmation);
      const progress = new ProgressGuard(this.#root);
      const marker = progress.read(targetSessionID);
      if (isDeepStrictEqual(marker, published.progress)) return;
      if (marker !== undefined || published.progress === undefined) throw new Error('Target progress differs from the projection; nothing was regenerated.');
      progress.write(targetSessionID, published.progress);
      if (!isDeepStrictEqual(progress.read(targetSessionID), published.progress)) throw new Error('Regenerated target progress is unconfirmed.');
    });
  }

  /**
   * Removes a published but unfinished target, only when every byte on disk is exactly the
   * deterministic projection of the fenced source. Anything else might be real work: kept, fenced.
   */
  removeUnfinishedPublication(runID: string, sourceSessionID: string, targetSessionID: string, epoch: number,
    confirmation: NonNullable<RunOwner['transfer']>['intent']): void {
    // Under the owner lock: a finish that commits first leaves this looking at an idle owner with
    // a receipt, which #publication refuses before a single byte is removed.
    this.#underOwnerLock(runID, owner => {
      if (owner?.state !== 'transferring') throw new Error('The transfer is no longer fenced; nothing was removed.');
      this.#removeUnfinished(runID, sourceSessionID, targetSessionID, epoch, confirmation);
    });
  }

  #removeUnfinished(runID: string, sourceSessionID: string, targetSessionID: string, epoch: number,
    confirmation: NonNullable<RunOwner['transfer']>['intent']): void {
    const checkpoints = new CheckpointStore(this.#root);
    const progress = new ProgressGuard(this.#root);
    const source = checkpoints.read(sourceSessionID)?.checkpoint;
    const target = checkpoints.read(targetSessionID)?.checkpoint;
    if (!target) {
      const marker = progress.read(targetSessionID);
      const sourceMarker = progress.read(sourceSessionID);
      if (marker && (!sourceMarker || !isDeepStrictEqual(marker, { ...sourceMarker, userMessageID: confirmation?.nativeUserMessageID })))
        throw new Error('Target progress is not the projection; nothing was removed.');
      if (marker) progress.clear(targetSessionID);
      return;
    }
    if (source?.version !== STABLE_CHECKPOINT_VERSION || target.version !== STABLE_CHECKPOINT_VERSION || target.sequence !== 0)
      throw new Error('The target checkpoint is not an unmodified projection; nothing was removed.');
    const published = this.#publication(runID, sourceSessionID, targetSessionID, epoch,
      { sourceSequence: source.sequence, sourceDigest: source.dataDigest, targetSequence: target.sequence, targetDigest: target.dataDigest }, confirmation);
    const marker = progress.read(targetSessionID);
    if (marker !== undefined && !isDeepStrictEqual(marker, published.progress)) throw new Error('Target progress is not the projection; nothing was removed.');
    checkpoints.clear(targetSessionID);
    if (marker !== undefined) progress.clear(targetSessionID);
  }

  /** Every check that proves the target checkpoint is the exact projection of the fenced source. */
  #publication(runID: string, sourceSessionID: string, targetSessionID: string, epoch: number,
    expected: { sourceSequence: number; sourceDigest: string; targetSequence: number; targetDigest: string },
    confirmation?: NonNullable<RunOwner['transfer']>['intent']): { owner: RunOwner; progress: ReturnType<ProgressGuard['read']> } {
    const checkpoints = new CheckpointStore(this.#root);
    const progress = new ProgressGuard(this.#root);
    const questions = new QuestionCheckpointStore(this.#root);
    const source = checkpoints.read(sourceSessionID)?.checkpoint;
    const target = checkpoints.read(targetSessionID)?.checkpoint;
    const owner = this.read(runID);
    const { userMessageID: _sourceUser, usedMessages: _sourceUsed, proposed: _sourceProposed, ...sourceData } =
      source?.version === STABLE_CHECKPOINT_VERSION ? source.data : { userMessageID: '', usedMessages: [], proposed: [] };
    const { userMessageID: _targetUser, usedMessages: _targetUsed, proposed: _targetProposed, ...targetData } =
      target?.version === STABLE_CHECKPOINT_VERSION ? target.data : { userMessageID: '', usedMessages: [], proposed: [] };
    const reaskedApproval = source?.version === STABLE_CHECKPOINT_VERSION && target?.version === STABLE_CHECKPOINT_VERSION &&
      source.stable.state === 'ready' && target.stable.state === 'await-approval' &&
      Workflow.replay(source.request, source.events).snapshot().answers.mode === 'interactive' &&
      source.events.at(-1)?.kind === 'approve' &&
      isDeepStrictEqual(target.events, source.events.slice(0, -1)) &&
      isDeepStrictEqual(target.stable, { ...source.stable, state: 'await-approval' }) &&
      Workflow.replay(target.request, target.events).nextAction().kind === 'approve';
    const lastEvent = source?.events.at(-1);
    const failedVerify = lastEvent?.kind === 'result' && lastEvent.result.phase === 'mdd-verify' && lastEvent.result.outcome === 'failed';
    const requestedRework = source?.version === STABLE_CHECKPOINT_VERSION && target?.version === STABLE_CHECKPOINT_VERSION &&
      source.stable.state === 'blocked' && Workflow.replay(source.request, source.events).nextAction().kind === 'blocked' &&
      failedVerify &&
      isDeepStrictEqual(target.events, [...source.events, { kind: 'rework', phase: 'mdd-apply' }]) &&
      target.stable.state === 'ready' && target.stable.phase === 'mdd-apply' && target.stable.mode === 'delegate' &&
      target.stable.attempts === 0 && target.stable.malformed === 0 && target.stable.report.phase === 'mdd-apply' &&
      target.stable.report.status === 'in-progress' && isDeepStrictEqual(target.stable.report.evidence, source.data.evidence) &&
      isDeepStrictEqual(target.data.rework, { after: 'mdd-verify', summary: lastEvent.result.evidenceSummary }) &&
      target.attempt === undefined;
    const { rework: _sourceRework, ...sourceWithoutRework } = sourceData as Record<string, unknown>;
    const { rework: _targetRework, ...targetWithoutRework } = targetData as Record<string, unknown>;
    const stableRemainder = (stable: StableRunnerState) => {
      const { phase: _phase, state: _state, mode: _mode, attempts: _attempts, malformed: _malformed,
        report: _report, nativeUsed: _nativeUsed, fallbackExhausted: _fallbackExhausted,
        reportRepairExhausted: _reportRepairExhausted, lastFailure: _lastFailure, reason: _reason,
        rejected: _rejected, ...rest } = stable;
      return rest;
    };
    if (!owner || owner.state !== 'transferring' || owner.ownerSessionID !== sourceSessionID || owner.epoch !== epoch ||
        !confirmation || !isDeepStrictEqual(owner.transfer?.intent, confirmation) ||
        owner.transfer?.targetSessionID !== targetSessionID || owner.transfer.sourceSequence !== expected.sourceSequence ||
        owner.transfer.sourceDigest !== expected.sourceDigest || this.parent(sourceSessionID) !== runID || this.parent(targetSessionID) !== runID ||
        !isDeepStrictEqual(this.parentClaim(targetSessionID)?.transfer, { sourceSessionID, sourceSequence: expected.sourceSequence,
          sourceDigest: expected.sourceDigest, ownerEpoch: epoch - 1, ...confirmation }) ||
        source?.version !== STABLE_CHECKPOINT_VERSION || target?.version !== STABLE_CHECKPOINT_VERSION ||
        source.runID !== runID || target.runID !== runID || source.parent !== sourceSessionID || target.parent !== targetSessionID ||
        source.sequence !== expected.sourceSequence || source.dataDigest !== expected.sourceDigest ||
        target.sequence !== expected.targetSequence || target.dataDigest !== expected.targetDigest ||
        target.data.directory !== owner.directory || target.data.worktree !== owner.worktree ||
        target.data.userMessageID === source.data.userMessageID || target.data.userMessageID !== confirmation.nativeUserMessageID ||
        !(requestedRework ? isDeepStrictEqual(targetWithoutRework, sourceWithoutRework) : isDeepStrictEqual(targetData, sourceData)) ||
        !(isDeepStrictEqual(target.events, source.events) && isDeepStrictEqual(target.stable, source.stable) || reaskedApproval ||
          requestedRework && isDeepStrictEqual(stableRemainder(target.stable), stableRemainder(source.stable))) ||
        !isDeepStrictEqual(target.request, source.request) || !isDeepStrictEqual(target.data.usedMessages, [target.data.userMessageID]) ||
        target.data.proposed.length || questions.read(targetSessionID) || this.intake(targetSessionID)?.state === 'pending' ||
        ['prepared', 'pending', 'answered'].includes(questions.read(sourceSessionID)?.state ?? ''))
      throw new Error('Transfer publication cannot be correlated; both parents remain fenced.');
    // The target marker is the source marker re-addressed to the target request (projectTargetTransfer).
    const sourceMarker = progress.read(sourceSessionID);
    const projected = sourceMarker ? { ...sourceMarker, userMessageID: target.data.userMessageID } : undefined;
    if ((target.events.length > 0 || sourceMarker) && (!projected || projected.runID !== runID ||
        projected.state !== (target.stable.state === 'complete' ? 'complete' : 'settled')))
      throw new Error('Source progress cannot project a correlated target marker.');
    return { owner, progress: projected };
  }

  /**
   * A receipt is written only after finishVerifiedTransfer proved both checkpoints correlated,
   * under the owner lock. From then on it is self-contained: the digests it recorded and the owner
   * epoch it was committed at are the proof, so confirming ownership reads the owner record and
   * the target's claim — never the current checkpoint bytes, which may have moved on, been
   * degraded to data-only, or been removed, and never the source, which may have started over.
   */
  confirmReceipt(runID: string, targetSessionID: string): RunOwner['receipt'] {
    const owner = this.read(runID);
    const receipt = owner?.receipt;
    if (!owner || !receipt || owner.ownerSessionID !== targetSessionID || owner.originSessionID !== receipt.sourceSessionID ||
        receipt.targetSessionID !== targetSessionID || this.parent(targetSessionID) !== runID || owner.state === 'transferring' ||
        (receipt.verifiedEpoch !== undefined && owner.epoch < receipt.verifiedEpoch))
      throw new Error('Transfer receipt cannot confirm this target parent.');
    return receipt;
  }

  /**
   * Restoring target bytes needs more than ownership: the checkpoint being restored must be the
   * published target or a later descendant of it (same prefix of events the receipt sealed).
   */
  confirmReceiptLineage(runID: string, targetSessionID: string, target: StableCheckpoint): void {
    const receipt = this.confirmReceipt(runID, targetSessionID)!;
    const owner = this.read(runID)!;
    const lineage = target.sequence === receipt.targetSequence ? target.dataDigest === receipt.targetDigest :
      target.sequence > receipt.targetSequence && target.events.length >= receipt.targetEventCount &&
      createHash('sha256').update(JSON.stringify(target.events.slice(0, receipt.targetEventCount))).digest('hex') === receipt.targetEventDigest;
    if (target.runID !== runID || target.parent !== targetSessionID || !lineage || target.data.userMessageID !== receipt.nativeUserMessageID ||
        target.data.directory !== owner.directory || target.data.worktree !== owner.worktree)
      throw new Error('Transfer receipt and checkpoint bytes differ; no target task may be exposed.');
  }

  /**
   * The run this parent claims has moved to another conversation by a finished transfer: the
   * owner holds a receipt and a different owner. The claim is inert — this parent can never act
   * on that run again — and may be retired so the conversation can start over.
   */
  movedAway(sessionID: string): { runID: string; targetSessionID: string } | undefined {
    const claim = this.parentClaim(sessionID);
    if (!claim || claim.retired) return undefined;
    const owner = this.read(claim.runID);
    return owner && this.#movedFrom(sessionID, owner) ? { runID: claim.runID, targetSessionID: owner.ownerSessionID } : undefined;
  }

  /**
   * Only a conversation that actually owned the run and handed it on is moved away. A conversation
   * holding just a pending target claim never owned it, so it stays an (ambiguous) claim instead.
   */
  #movedFrom(sessionID: string, owner: RunOwner | undefined): boolean {
    if (!owner || owner.ownerSessionID === sessionID) return false;
    return !!owner.formerOwners?.includes(sessionID) || (!!owner.receipt && owner.receipt.sourceSessionID === sessionID && owner.state !== 'transferring') ||
      (!!owner.adaptiveReceipt && owner.adaptiveReceipt.sourceSessionID === sessionID && owner.state !== 'transferring');
  }

  retireMovedAwayParent(sessionID: string, runID: string): void {
    try {
      this.#files.updateStrict(this.#parentName(sessionID), source => {
        const old = source === undefined ? undefined : parseParent(JSON.parse(source), sessionID);
        if (!old || old.retired || old.runID !== runID || !this.#movedFrom(sessionID, this.read(runID))) throw new Error('The parent still owns this run.');
        return JSON.stringify({ sessionID, runID, retired: true });
      }, LIMIT);
      if (this.parent(sessionID) !== undefined) throw new Error('Moved-away parent retirement readback mismatch.');
    } catch { throw new Error('The moved-away run claim could not be retired; nothing else was changed.'); }
  }

  /** Decide and mutate while holding the owner lock, so no concurrent finish/abort interleaves. */
  #underOwnerLock<T>(runID: string, work: (owner: RunOwner | undefined) => T): T {
    let result: T | undefined;
    let done = false;
    this.#files.updateStrict(this.#name(runID), previous => {
      result = work(previous === undefined ? undefined : parse(JSON.parse(previous)));
      done = true;
      return previous;
    }, LIMIT);
    if (!done) throw new Error('Owner lock was not held.');
    return result as T;
  }
}
