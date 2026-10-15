import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalFiles } from './local-files.js';
import { objectWithKeys } from './validation.js';
import type { AdaptiveData } from './adaptive-low.js';

const LIMIT = 8 * 1024 * 1024;
export type AdaptiveRecord = {
  version: 1; sequence: number; digest: string; admissionDigest: string;
  runID: string; sessionID: string; directory: string; worktree: string; agent: 'mdd-orchestrator'; userMessageID: string;
  stage: 'bootstrap' | 'active'; data: AdaptiveData;
  attempt?: { callID: string; state: 'pending' | 'settled' };
  calls: string[];
};
type Body = Omit<AdaptiveRecord, 'version' | 'sequence' | 'digest' | 'admissionDigest'>;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function text(value: unknown, max = 256): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function parse(source: string, sessionID: string): AdaptiveRecord {
  const item = objectWithKeys(JSON.parse(source), 'adaptive record', ['version', 'sequence', 'digest', 'admissionDigest', 'runID', 'sessionID',
    'directory', 'worktree', 'agent', 'userMessageID', 'stage', 'data', 'attempt', 'calls']);
  if (item.version !== 1 || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0 || item.sessionID !== sessionID ||
      !text(item.runID) || !item.runID.startsWith('adaptive-internal-') || !text(item.userMessageID) ||
      !text(item.directory, 2048) || !text(item.worktree, 2048) || item.agent !== 'mdd-orchestrator' ||
      !['bootstrap', 'active'].includes(String(item.stage)) || !Array.isArray(item.calls) || item.calls.length > 64 ||
      item.calls.some(call => !text(call)) || new Set(item.calls).size !== item.calls.length)
    throw new Error('Unsupported or invalid adaptive record.');
  const data = item.data as AdaptiveData;
  if (!data || typeof data !== 'object' || item.admissionDigest !== hash(data.contract)) throw new Error('Adaptive admission bytes were changed.');
  if (item.attempt !== undefined) {
    const attempt = objectWithKeys(item.attempt, 'adaptive attempt', ['callID', 'state']);
    if (!text(attempt.callID) || !item.calls.includes(attempt.callID) || !['pending', 'settled'].includes(String(attempt.state)) ||
        (attempt.state === 'pending') !== (data.state === 'await-result')) throw new Error('Adaptive attempt and private state disagree.');
    if (attempt.state === 'settled' && data.receipts?.at(-1)?.callID !== attempt.callID) throw new Error('Settled attempt lacks its actual receipt.');
  } else if (data.state === 'await-result') throw new Error('Pending adaptive state lacks a correlated native attempt.');
  const calls = item.calls as string[];
  if (!Array.isArray(data.receipts) || data.receipts.some(receipt => !receipt.callID || !calls.includes(receipt.callID)) ||
      item.stage === 'bootstrap' && (item.sequence !== 0 || item.calls.length || data.state !== 'await-selection')) throw new Error('Adaptive receipt or bootstrap correlation differs.');
  const { digest, ...body } = item;
  if (digest !== hash(body)) throw new Error('Adaptive record digest differs.');
  return structuredClone(item) as AdaptiveRecord;
}

export class AdaptiveCommitError extends Error {
  constructor(readonly uncertain: boolean) { super(uncertain
    ? 'Adaptive publication is unconfirmed; authority is fenced until readback reconciliation. Never retry blindly.'
    : 'Adaptive write did not commit; original authority is unchanged.'); }
}

/** Separate bounded data journal; unsupported/tampered bytes remain occupied, never absent. */
export class AdaptiveStore {
  constructor(readonly root: string, readonly files: Pick<LocalFiles, 'readStrict' | 'updateStrict'> = new LocalFiles(root)) {}
  #name(sessionID: string): `.mdd/adaptive-${string}.json` {
    if (!text(sessionID)) throw new Error('Invalid adaptive parent identity.');
    return `.mdd/adaptive-${createHash('sha256').update(sessionID).digest('hex')}.json`;
  }
  occupied(sessionID: string): boolean { return this.files.readStrict(this.#name(sessionID), LIMIT) !== undefined; }
  read(sessionID: string): AdaptiveRecord | undefined {
    const source = this.files.readStrict(this.#name(sessionID), LIMIT);
    return source === undefined ? undefined : parse(source, sessionID);
  }
  commit(sessionID: string, previous: AdaptiveRecord | undefined, value: Body): AdaptiveRecord {
    const body = { version: 1 as const, sequence: (previous?.sequence ?? -1) + 1,
      admissionDigest: hash(value.data.contract), ...structuredClone(value) };
    const next = parse(JSON.stringify({ ...body, digest: hash(body) }), sessionID);
    if (previous && (next.admissionDigest !== previous.admissionDigest ||
        ['runID', 'sessionID', 'directory', 'worktree', 'agent', 'userMessageID'].some(key =>
          next[key as keyof AdaptiveRecord] !== previous[key as keyof AdaptiveRecord]))) throw new Error('Adaptive immutable binding changed.');
    try {
      this.files.updateStrict(this.#name(sessionID), source => {
        const current = source === undefined ? undefined : parse(source, sessionID);
        if (!isDeepStrictEqual(current, previous)) throw new Error('Adaptive CAS lost to another writer.');
        return JSON.stringify(next);
      }, LIMIT);
    } catch {
      // A rename may have committed before unlock failed. Only exact readback reconciles it.
      let actual: AdaptiveRecord | undefined;
      try { actual = this.read(sessionID); } catch { throw new AdaptiveCommitError(true); }
      if (isDeepStrictEqual(actual, next)) return next;
      throw new AdaptiveCommitError(!isDeepStrictEqual(actual, previous));
    }
    try { if (isDeepStrictEqual(this.read(sessionID), next)) return next; } catch { /* fenced below */ }
    throw new AdaptiveCommitError(true);
  }
}
