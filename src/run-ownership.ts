import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalFiles } from './local-files.js';
import { objectWithKeys, ValidationError } from './validation.js';

export const RUN_OWNER_VERSION = 1;
const LIMIT = 4096;
type Identity = { runID: string; sessionID: string; directory: string; worktree: string };
export type RunOwner = {
  version: 1; runID: string; ownerSessionID: string; directory: string; worktree: string; epoch: number;
  state: 'idle' | 'reserved' | 'transferring';
  callID?: string;
  transfer?: { targetSessionID: string; sourceDigest: string };
};

function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function parse(value: unknown): RunOwner {
  const item = objectWithKeys(value, 'run owner', ['version', 'runID', 'ownerSessionID', 'directory', 'worktree', 'epoch', 'state', 'callID', 'transfer']);
  if (item.version !== RUN_OWNER_VERSION || !text(item.runID, 256) || !text(item.ownerSessionID, 256) ||
      !text(item.directory, 2048) || !text(item.worktree, 2048) || !Number.isSafeInteger(item.epoch) ||
      (item.epoch as number) < 0 || !['idle', 'reserved', 'transferring'].includes(String(item.state))) throw new ValidationError('Invalid durable run owner.');
  if (item.state === 'reserved') {
    if (!text(item.callID, 256) || item.transfer !== undefined) throw new ValidationError('Invalid reserved owner.');
  } else if (item.callID !== undefined) throw new ValidationError('An idle/transferring owner cannot hold a task.');
  if (item.state === 'transferring') {
    const transfer = objectWithKeys(item.transfer, 'run transfer', ['targetSessionID', 'sourceDigest']);
    if (!text(transfer.targetSessionID, 256) || transfer.targetSessionID === item.ownerSessionID ||
        typeof transfer.sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(transfer.sourceDigest)) throw new ValidationError('Invalid transfer reservation.');
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
  constructor(root: string, files: Pick<LocalFiles, 'readStrict' | 'updateStrict'> = new LocalFiles(root)) { this.#files = files; }
  #name(runID: string): `.mdd/owner-${string}.json` {
    if (!text(runID, 256)) throw new ValidationError('Invalid run owner identity.');
    return `.mdd/owner-${createHash('sha256').update(runID).digest('hex')}.json`;
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
    return this.#write(value.runID, old => {
      if (old) throw new Error('Run already has an owner.');
      return { version: RUN_OWNER_VERSION, runID: value.runID, ownerSessionID: value.sessionID,
        directory: value.directory, worktree: value.worktree, epoch: 0, state: 'idle' };
    });
  }
  reserve(runID: string, sessionID: string, callID: string, epoch: number): RunOwner {
    if (!text(callID, 256)) throw new ValidationError('Invalid task call ID.');
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'idle' || old.epoch !== epoch) throw new Error('No idle owner at this epoch.');
      return { ...old, state: 'reserved', callID, epoch: epoch + 1 };
    });
  }
  release(runID: string, sessionID: string, callID: string, epoch: number): RunOwner {
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sessionID || old.state !== 'reserved' || old.callID !== callID || old.epoch !== epoch) throw new Error('Reserved writer does not match.');
      const { callID: _callID, ...rest } = old;
      return { ...rest, state: 'idle', epoch: epoch + 1 };
    });
  }
  beginTransfer(runID: string, sourceSessionID: string, target: { sessionID: string; directory: string; worktree: string },
    sourceDigest: string, epoch: number): RunOwner {
    if (!text(target.sessionID, 256) || target.sessionID === sourceSessionID ||
        typeof sourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(sourceDigest)) throw new ValidationError('Invalid transfer request.');
    return this.#write(runID, old => {
      if (!old || old.ownerSessionID !== sourceSessionID || old.state !== 'idle' || old.epoch !== epoch ||
          old.directory !== target.directory || old.worktree !== target.worktree) throw new Error('Source owner or workspace does not match.');
      return { ...old, state: 'transferring', transfer: { targetSessionID: target.sessionID, sourceDigest }, epoch: epoch + 1 };
    });
  }
}
