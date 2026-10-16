import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { parseAdaptiveRecord } from './adaptive-store.js';
import type { AdaptiveRecord, AdaptiveStore } from './adaptive-store.js';
import { AdaptiveLow } from './adaptive-low.js';
import type { RunOwner, RunOwnershipStore } from './run-ownership.js';
import type { ProgressGuard } from './progress.js';
import type { QuestionCheckpointStore } from './question-checkpoint.js';
import { objectWithKeys } from './validation.js';

const LIMIT = 20 * 1024 * 1024;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Archive = { version: 1; previous: AdaptiveRecord; next: AdaptiveRecord; owner: RunOwner;
  claim: NonNullable<ReturnType<RunOwnershipStore['parentClaim']>>;
  progress: ReturnType<ProgressGuard['read']> | null; question: ReturnType<QuestionCheckpointStore['read']> | null };
type Pointer = { version: 1; sessionID: string; runID: string; digest: string };

/** Data-only immutable archive plus one correlated replacement intent, never an authority token. */
export class AdaptiveRetirement {
  constructor(readonly store: AdaptiveStore) {}
  #archiveName(parent: string, runID: string): `.mdd/adaptive-archive-${string}.json` {
    return `.mdd/adaptive-archive-${hash([parent, runID])}.json`;
  }
  #pointerName(parent: string): `.mdd/adaptive-retirement-${string}.json` {
    return `.mdd/adaptive-retirement-${hash(parent)}.json`;
  }
  #parse(value: unknown, parent: string): Archive {
    const item = objectWithKeys(value, 'adaptive retirement archive', ['version', 'previous', 'next', 'owner', 'claim', 'progress', 'question']);
    const previous = parseAdaptiveRecord(JSON.stringify(item.previous), parent), next = parseAdaptiveRecord(JSON.stringify(item.next), parent);
    const archive = item as Archive;
    if (item.version !== 1 || previous.stage !== 'active' || !['completed', 'closed-unverified'].includes(previous.data.state) ||
        previous.attempt?.state === 'pending' || next.stage !== 'bootstrap' || next.sequence !== 0 || next.runID === previous.runID || next.transfer ||
        next.directory !== previous.directory || next.worktree !== previous.worktree || next.userMessageID === previous.userMessageID ||
        previous.history?.some(ref => ref.userMessageID === next.userMessageID) ||
        !isDeepStrictEqual(next.history, [...(previous.history ?? []), { runID: previous.runID, sessionID: previous.sessionID, userMessageID: previous.userMessageID, digest: previous.digest }]) ||
        archive.owner?.runID !== previous.runID || archive.owner.ownerSessionID !== parent || archive.owner.state !== 'idle' ||
        archive.owner.operation || archive.owner.recovery || archive.owner.recoveringTransfer || archive.owner.workers || archive.owner.policyQuestion ||
        archive.claim?.runID !== previous.runID || archive.claim.sessionID !== parent || archive.claim.retired ||
        archive.progress && (archive.progress.state !== 'settled' || archive.progress.runID !== previous.runID ||
          archive.progress.userMessageID !== previous.userMessageID || archive.progress.resumable !== false ||
          previous.attempt?.state !== 'settled' || archive.progress.callID !== previous.attempt.callID || archive.progress.attemptID !== previous.attempt.callID) ||
        archive.question && ['prepared', 'pending', 'answered'].includes(archive.question.state))
      throw new Error('Retirement archive contradicts terminal state, fresh request, history or idle ownership.');
    AdaptiveLow.restore(previous.data, previous.directory, false);
    AdaptiveLow.restore(next.data, next.directory, false);
    return structuredClone(archive);
  }
  read(parent: string, runID: string): Archive | undefined {
    const source = this.store.files.readStrict(this.#archiveName(parent, runID), LIMIT);
    return source === undefined ? undefined : this.#parse(JSON.parse(source), parent);
  }
  intent(parent: string): Archive | undefined {
    const live = this.store.read(parent), orphan = live && this.read(parent, live.runID);
    // An archive rename can precede pointer publication. Its immutable next bootstrap is the
    // only candidate cold reconciliation may finish; generating a different candidate is unsafe.
    if (orphan) return orphan;
    const source = this.store.files.readStrict(this.#pointerName(parent), 2048);
    if (source === undefined) {
      const prior = live?.history?.at(-1);
      if (!prior || prior.sessionID !== parent) return undefined;
      const archive = this.read(parent, prior.runID);
      if (!archive || archive.previous.digest !== prior.digest || archive.previous.userMessageID !== prior.userMessageID || archive.next.runID !== live!.runID)
        throw new Error('Retired history archive or live successor binding is missing.');
      return archive;
    }
    const pointer = objectWithKeys(JSON.parse(source), 'adaptive retirement pointer', ['version', 'sessionID', 'runID', 'digest']) as Pointer;
    if (pointer.version !== 1 || pointer.sessionID !== parent || typeof pointer.runID !== 'string') throw new Error('Invalid retirement pointer.');
    const archive = this.read(parent, pointer.runID);
    if (!archive || hash(archive) !== pointer.digest) throw new Error('Retirement archive readback differs.');
    return archive;
  }
  pending(parent: string): Archive | undefined {
    const archive = this.intent(parent), live = archive && this.store.read(parent);
    if (!archive) return undefined;
    if (live?.runID === archive.next.runID && live.stage === 'active') {
      if (!isDeepStrictEqual(live.history, archive.next.history) || live.admissionDigest !== archive.next.admissionDigest ||
          live.userMessageID !== archive.next.userMessageID || live.directory !== archive.next.directory || live.worktree !== archive.next.worktree)
        throw new Error('Live successor changed its immutable archived admission or consumed-message history.');
      return undefined;
    }
    if (!isDeepStrictEqual(live, archive.previous) && !isDeepStrictEqual(live, archive.next))
      throw new Error('Retirement live generation differs; do not retry or replace it.');
    return archive;
  }
  prepare(value: Archive): Archive {
    const parent = value.previous.sessionID, archive = this.#parse(value, parent), old = this.intent(parent);
    if (old && old.next.runID !== archive.previous.runID && !isDeepStrictEqual(old, archive)) throw new Error('An unrelated retirement intent remains fenced.');
    const text = JSON.stringify(archive), name = this.#archiveName(parent, archive.previous.runID);
    this.store.files.updateStrict(name, source => {
      if (source !== undefined && source !== text) throw new Error('Immutable archive already exists with different bytes.');
      return text;
    }, LIMIT);
    if (!isDeepStrictEqual(this.read(parent, archive.previous.runID), archive)) throw new Error('Immutable archive readback is unconfirmed.');
    this.publishPointer(archive);
    return archive;
  }
  publishPointer(value: Archive): void {
    const parent = value.previous.sessionID, archive = this.#parse(value, parent), source = this.store.files.readStrict(this.#pointerName(parent), 2048);
    if (source !== undefined) {
      const prior = objectWithKeys(JSON.parse(source), 'retirement pointer', ['version', 'sessionID', 'runID', 'digest']) as Pointer;
      const old = this.read(parent, prior.runID);
      if (prior.version !== 1 || prior.sessionID !== parent || !old || hash(old) !== prior.digest ||
          old.next.runID !== archive.previous.runID && !isDeepStrictEqual(old, archive)) throw new Error('Unrelated retirement pointer remains fenced.');
    }
    const pointer: Pointer = { version: 1, sessionID: parent, runID: archive.previous.runID, digest: hash(archive) };
    const expectedSource = source;
    this.store.files.updateStrict(this.#pointerName(parent), source => {
      if (source !== expectedSource) throw new Error('Retirement pointer CAS differs.');
      return JSON.stringify(pointer);
    }, 2048);
    if (this.store.files.readStrict(this.#pointerName(parent), 2048) !== JSON.stringify(pointer)) throw new Error('Retirement pointer readback is unconfirmed.');
    if (!isDeepStrictEqual(this.intent(parent), archive)) throw new Error('Retirement intent publication is unconfirmed.');
  }
}
