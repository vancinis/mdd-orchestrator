import type { CheckpointStore, StableCheckpoint } from './checkpoint.js';
import { sealResumeData, STABLE_CHECKPOINT_VERSION, validateCheckpoint } from './checkpoint.js';
import type { ProgressGuard } from './progress.js';
import type { QuestionCheckpointStore } from './question-checkpoint.js';
import type { Runtime } from './phase-runner.js';
import { ValidationError } from './validation.js';
import { Workflow } from './workflow.js';
import { createHash } from 'node:crypto';
import { canonicalNativeText } from './native-text.js';

export type TransferAssessment = {
  state: 'transfer-blocked';
  diagnostic: 'source-unavailable' | 'pending-unknown' | 'target-occupied' | 'ownership-unproven';
  reason: string;
};

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 &&
    !/[\x00-\x1f\x7f]/.test(value);
}

/**
 * A native user's explicit source names are necessary, not sufficient, for moving a live writer.
 * This preflight never transfers. Durable ownership exists, but native target consent, memory
 * binding and every publication/crash boundary have not been proven together in this adapter.
 */
export function assessTransfer(input: { sourceSessionID: string; runID: string; userText: string },
  target: Runtime, checkpoint: CheckpointStore, progress: ProgressGuard, questions: QuestionCheckpointStore): TransferAssessment {
  const tokens = typeof input.userText === 'string' ? input.userText.trim().split(/\s+/) : [];
  if (!identifier(input.sourceSessionID) || !identifier(input.runID) ||
      typeof input.userText !== 'string' || !input.userText.trim() || Buffer.byteLength(input.userText) > 12000 ||
      input.sourceSessionID === target.sessionID || !tokens.includes(`sourceSessionID=${input.sourceSessionID}`) ||
      !tokens.includes(`runID=${input.runID}`)) {
    throw new ValidationError('The native request must explicitly name a different sourceSessionID and runID. Nothing was transferred.');
  }
  const unavailable: TransferAssessment = { state: 'transfer-blocked', diagnostic: 'source-unavailable',
    reason: 'The named v3 run could not be validated in this exact workspace. No source data was transferred.' };
  try {
    if (checkpoint.read(target.sessionID)) return { state: 'transfer-blocked', diagnostic: 'target-occupied',
      reason: 'The target parent already has a durable run. No transfer occurred.' };
    const source = checkpoint.read(input.sourceSessionID);
    if (!source || source.checkpoint.version !== STABLE_CHECKPOINT_VERSION ||
        source.checkpoint.runID !== input.runID || source.checkpoint.parent !== input.sourceSessionID ||
        source.checkpoint.data.directory !== target.directory || source.checkpoint.data.worktree !== target.worktree) return unavailable;
    const marker = progress.read(input.sourceSessionID);
    const question = questions.read(input.sourceSessionID);
    if (marker?.state === 'pending' || source.checkpoint.stable.state === 'await-result' ||
        (question && ['prepared', 'pending', 'answered'].includes(question.state))) {
      return { state: 'transfer-blocked', diagnostic: 'pending-unknown',
        reason: 'The source may have an unresolved task or native question. No transfer occurred.' };
    }
    if (marker && (marker.runID !== input.runID || marker.userMessageID !== source.checkpoint.data.userMessageID ||
        (source.checkpoint.attempt?.state === 'settled' && marker.attemptID !== source.checkpoint.attempt.id))) return unavailable;
    return { state: 'transfer-blocked', diagnostic: 'ownership-unproven',
      reason: 'The native target consent and checkpoint publication transaction is not enabled. No transfer occurred.' };
  } catch { return unavailable; }
}

/** Pure, non-authorizing projection. Only an unconsumed interactive approval can be re-asked. */
export function projectApprovalTransfer(source: StableCheckpoint, marker: ReturnType<ProgressGuard['read']>,
  target: Runtime, nativeUserMessageID: string): { checkpoint: StableCheckpoint; progress?: NonNullable<typeof marker> } {
  validateCheckpoint(source);
  const next = Workflow.replay(source.request, source.events).nextAction();
  if (next.kind !== 'approve' || source.stable.state !== 'await-approval' ||
      source.parent === target.sessionID || source.data.directory !== target.directory || source.data.worktree !== target.worktree ||
      !identifier(nativeUserMessageID) || nativeUserMessageID === source.data.userMessageID ||
      (marker && (marker.state !== 'settled' || marker.runID !== source.runID || marker.userMessageID !== source.data.userMessageID)) ||
      (Workflow.replay(source.request, source.events).snapshot().results.length > 0 && !marker)) {
    throw new ValidationError('Only a settled interactive approval can be projected for a fresh target question.');
  }
  const data = { ...structuredClone(source.data), userMessageID: nativeUserMessageID, usedMessages: [nativeUserMessageID], proposed: [] };
  const checkpoint: StableCheckpoint = { ...structuredClone(source), parent: target.sessionID, sequence: 0, data,
    dataDigest: sealResumeData(data, source.runID, target.sessionID, source.events, source.stable) };
  validateCheckpoint(checkpoint);
  return { checkpoint, ...(marker ? { progress: { ...marker, userMessageID: nativeUserMessageID } } : {}) };
}

/** Native provenance is supplied by the adapter; projection itself grants no execution authority. */
export type TargetResumeProof = { sessionID: string; userMessageID: string; userText: string; latest: true; authored: true };
export function projectTargetTransfer(source: StableCheckpoint, marker: ReturnType<ProgressGuard['read']>,
  target: Runtime, proof: TargetResumeProof): { checkpoint: StableCheckpoint; progress?: NonNullable<typeof marker>;
    resumeConsent?: { sessionID: string; userMessageID: string; digest: string } } {
  validateCheckpoint(source);
  const text = canonicalNativeText(proof.userText);
  const tokens = text.split(/\s+/);
  if (proof.sessionID !== target.sessionID || proof.latest !== true || proof.authored !== true ||
      !identifier(proof.userMessageID) || !text || Buffer.byteLength(text) > 12000 ||
      !tokens.includes(`sourceSessionID=${source.parent}`) || !tokens.includes(`runID=${source.runID}`))
    throw new ValidationError('A fresh, exact target-authored resume request must name the source and run.');
  const workflow = Workflow.replay(source.request, source.events);
  const next = workflow.nextAction();
  const last = workflow.snapshot().results.at(-1);
  const rework = next.kind === 'blocked' && next.phase === 'mdd-verify' && last?.phase === 'mdd-verify' &&
    last.outcome === 'failed' && workflow.snapshot().evaluation.phases.includes('mdd-apply') &&
    text.split(/\s+/).some(token => /^rework[.!?]?$/i.test(token));
  if ((!['ready', 'await-approval'].includes(source.stable.state) && !(source.stable.state === 'blocked' && rework)) || source.stable.rejected ||
      source.attempt?.state === 'pending' || (next.kind !== 'execute' && next.kind !== 'approve' && !rework) ||
      (next.kind === 'execute' && source.stable.state !== 'ready') ||
      (next.kind === 'approve' && source.stable.state !== 'await-approval') ||
      source.parent === target.sessionID || source.data.directory !== target.directory || source.data.worktree !== target.worktree ||
      proof.userMessageID === source.data.userMessageID ||
      (marker && (marker.state !== 'settled' || marker.runID !== source.runID || marker.userMessageID !== source.data.userMessageID ||
        (source.attempt?.state === 'settled' && marker.attemptID !== source.attempt.id))) ||
      (workflow.snapshot().results.length > 0 && !marker) || (rework && !marker?.callID))
    throw new ValidationError('Only a settled, runnable or awaiting-approval checkpoint may be projected.');
  const events = structuredClone(source.events);
  const stable = structuredClone(source.stable);
  let freshApproval = next.kind === 'approve';
  if (rework) {
    workflow.rework('mdd-apply');
    events.push({ kind: 'rework', phase: 'mdd-apply' });
    stable.phase = 'mdd-apply'; stable.state = 'ready'; stable.mode = 'delegate'; stable.attempts = 0; stable.malformed = 0;
    stable.report = { phase: 'mdd-apply', summary: 'Target-requested rework is ready.', how: [], status: 'in-progress', evidence: source.data.evidence };
    delete stable.nativeUsed; delete stable.fallbackExhausted; delete stable.reportRepairExhausted;
    delete stable.lastFailure; delete stable.reason; delete stable.rejected;
  }
  if (workflow.snapshot().answers.mode === 'interactive' && next.kind === 'execute' &&
      events.at(-1)?.kind === 'approve') {
    const terminal = events.at(-1)!;
    const prior = Workflow.replay(source.request, events.slice(0, -1)).nextAction();
    if (prior.kind !== 'approve' || prior.phase !== next.phase || terminal.kind !== 'approve' || terminal.phase !== next.phase)
      throw new ValidationError('Only the terminal approval of this exact phase can be revoked.');
    events.pop();
    stable.state = 'await-approval';
    freshApproval = true;
  }
  const data = { ...structuredClone(source.data), userMessageID: proof.userMessageID, usedMessages: [proof.userMessageID], proposed: [],
    ...(rework ? { rework: { after: 'mdd-verify' as const, summary: last!.evidenceSummary } } : {}) };
  const checkpoint: StableCheckpoint = { ...structuredClone(source), parent: target.sessionID, sequence: 0, events, stable, data,
    dataDigest: sealResumeData(data, source.runID, target.sessionID, events, stable) };
  if (rework) delete checkpoint.attempt;
  validateCheckpoint(checkpoint);
  const digest = createHash('sha256').update(text).digest('hex');
  return { checkpoint, ...(marker ? { progress: { ...marker, userMessageID: proof.userMessageID } } : {}),
    ...(!freshApproval ? { resumeConsent: { sessionID: target.sessionID, userMessageID: proof.userMessageID, digest } } : {}) };
}
