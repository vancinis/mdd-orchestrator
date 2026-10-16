import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AdaptiveLow } from './adaptive-low.js';
import type { AdaptiveRecord, AdaptiveStore } from './adaptive-store.js';
import type { Runtime } from './phase-runner.js';

export type AdaptiveLineage = {
  sourceSessionID: string; sourceSequence: number; sourceDigest: string; ownerEpoch: number;
  operationID: string; nativeUserMessageID: string; requestDigest: string;
};
export type AdaptiveReceipt = AdaptiveLineage & {
  targetSessionID: string; targetSequence: number; targetDigest: string; admissionDigest: string; verifiedEpoch: number;
};

/** Exact native text, not caller-provided approval flags or inferred continuation consent. */
export function adaptiveTransferRequest(source: AdaptiveRecord): string {
  return `Transfer sourceSessionID=${source.sessionID} runID=${source.runID} admissionDigest=${source.admissionDigest}. Continue the unchanged objective, acceptance, scope, exclusions and decisions: ${JSON.stringify(source.data.contract.objective)}`;
}

/** Data only: restore validates actual receipts and selectively invalidates stale proof. */
export function projectAdaptiveTransfer(store: AdaptiveStore, source: AdaptiveRecord, target: Runtime, lineage: AdaptiveLineage): AdaptiveRecord {
  if (source.stage !== 'active' || !['await-selection', 'completed', 'closed-unverified'].includes(source.data.state) ||
      source.attempt?.state === 'pending' || source.sessionID === target.sessionID || target.agent !== 'mdd-orchestrator' ||
      source.directory !== target.directory || source.worktree !== target.worktree || lineage.sourceSessionID !== source.sessionID ||
      lineage.sourceSequence !== source.sequence || lineage.sourceDigest !== source.digest ||
      lineage.nativeUserMessageID === source.userMessageID ||
      lineage.requestDigest !== createHash('sha256').update(adaptiveTransferRequest(source)).digest('hex'))
    throw new Error('Adaptive transfer requires an actorless exact same-workspace source and fresh native target request.');
  const { version: _version, sequence: _sequence, digest: _digest, admissionDigest: _admissionDigest, transfer: _prior, ...body } = source;
  return store.prepare(target.sessionID, undefined, { ...body, sessionID: target.sessionID,
    userMessageID: lineage.nativeUserMessageID, data: AdaptiveLow.restore(source.data, target.directory).serialize(), transfer: lineage });
}

/** A distinct validator; adaptive bytes never enter the fixed checkpoint/event validator. */
export function validateAdaptivePublication(store: AdaptiveStore, source: AdaptiveRecord, target: AdaptiveRecord, lineage: AdaptiveLineage): void {
  const projected = projectAdaptiveTransfer(store, source, { sessionID: target.sessionID, directory: target.directory,
    worktree: target.worktree, agent: target.agent }, lineage);
  if (!isDeepStrictEqual(target, projected)) throw new Error('Adaptive publication differs from the exact deterministic projection.');
}
