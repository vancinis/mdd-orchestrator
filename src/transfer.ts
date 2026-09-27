import type { CheckpointStore } from './checkpoint.js';
import { STABLE_CHECKPOINT_VERSION } from './checkpoint.js';
import type { ProgressGuard } from './progress.js';
import type { QuestionCheckpointStore } from './question-checkpoint.js';
import type { Runtime } from './phase-runner.js';
import { ValidationError } from './validation.js';

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
 * This API never transfers: no per-run owner CAS currently reserves every possible dispatch and
 * consent transition, so a source plugin could still act after a target copied its checkpoint.
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
      reason: 'The source plugin can still dispatch from its own parent. Durable exclusive run ownership is not implemented; no transfer occurred.' };
  } catch { return unavailable; }
}
