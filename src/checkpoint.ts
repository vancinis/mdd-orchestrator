import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { LocalFiles } from './local-files.js';
import { Workflow } from './workflow.js';
import type { WorkflowEvent } from './workflow.js';
import { objectWithKeys, ValidationError } from './validation.js';
import type { Progress } from './progress.js';
import { acceptance, decisions, validatePlan, verification } from './acceptance.js';
import type { Acceptance, Decision, Verification } from './acceptance.js';
import { deliverables, delivered, executed } from './phase-evidence.js';
import type { ChangedFile, Check, Deliverable, Delivered } from './phase-evidence.js';
import { concerns } from './concerns.js';
import { evidenceCoverage, renderReport } from './reporting.js';
import type { Evidence, PhaseReport } from './reporting.js';
import type { Phase } from './policy.js';
import type { Concern } from './concerns.js';

export const CHECKPOINT_VERSION = 1;
export const RESUME_CHECKPOINT_VERSION = 2;
export const STABLE_CHECKPOINT_VERSION = 3;
export const CHECKPOINT_MAX_BYTES = 400000;
export type Checkpoint = {
  version: 1;
  runID: string;
  parent: string;
  sequence: number;
  request: unknown;
  events: WorkflowEvent[];
  attempt?: { id: string; phase: string; state: 'pending' | 'settled' };
};

/** Stored content is data, never a live ArtifactStore reference or a consent receipt. */
export type ResumeData = {
  directory: string; worktree: string; userMessageID: string; requirements: string;
  memoryProject?: string;
  context: { label: string; content: string; source: 'coordinator' }[];
  dependencies: { phase: Phase; content: string; digest: string }[];
  contexts: { explorationID: string; outcome: 'passed' | 'failed'; summary: string; concerns: ReturnType<typeof concerns>; content: string; digest: string }[];
  acceptance?: Acceptance; decisions: Decision[]; planned: Deliverable[]; evidence: Evidence;
  verification?: Verification; executedChecks: Check[]; changedFiles: number;
  calls: string[]; usedMessages: string[]; proposed: string[];
  rework?: { after: Phase; summary: string };
};
export type ResumeCheckpoint = Omit<Checkpoint, 'version'> & { version: typeof RESUME_CHECKPOINT_VERSION; data: ResumeData; dataDigest: string };
/** Process state, not a dispatch token or proof of a fresh native approval. */
export type StableRunnerState = {
  phase: Phase; state: 'ready' | 'await-approval' | 'await-result' | 'blocked' | 'complete';
  mode: 'delegate' | 'native' | 'inline'; attempts: number; spent: number; malformed: number;
  report: PhaseReport; changedList: ChangedFile[]; concerns: Concern[];
  delivered?: Delivered; nativeUsed?: true; fallbackExhausted?: true; reportRepairExhausted?: true;
  lastFailure?: string; reason?: string; rejected?: { reason: string; text: string };
};
export type StableCheckpoint = Omit<ResumeCheckpoint, 'version' | 'attempt'> & { version: typeof STABLE_CHECKPOINT_VERSION;
  stable: StableRunnerState; attempt?: { id: string; phase: Phase; state: 'pending' | 'settled' | 'released' } };
export type AnyCheckpoint = Checkpoint | ResumeCheckpoint | StableCheckpoint;

function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function sealResumeData(data: ResumeData, runID: string, parent: string, events: readonly WorkflowEvent[], stable?: StableRunnerState): string {
  return digest(JSON.stringify({ runID, parent, events, data, ...(stable ? { stable } : {}) }));
}

function validateStable(value: unknown, workflow: Workflow, data: ResumeData): StableRunnerState {
  const item = objectWithKeys(value, 'stable runner state', ['phase', 'state', 'mode', 'attempts', 'spent', 'malformed',
    'report', 'changedList', 'concerns', 'delivered', 'nativeUsed', 'fallbackExhausted', 'reportRepairExhausted',
    'lastFailure', 'reason', 'rejected']);
  const next = workflow.nextAction();
  const phase = next.kind === 'finished' ? workflow.snapshot().results.at(-1)?.phase : next.phase;
  const state = { execute: 'ready', approve: 'await-approval', 'await-result': 'await-result', blocked: 'blocked', finished: 'complete' }[next.kind];
  if (item.phase !== phase || item.state !== state || !['delegate', 'native', 'inline'].includes(String(item.mode))) {
    throw new ValidationError('Stable runner state contradicts workflow.');
  }
  for (const key of ['attempts', 'spent', 'malformed'] as const) {
    if (!Number.isSafeInteger(item[key]) || (item[key] as number) < 0 || (item[key] as number) > 100000) throw new ValidationError('Invalid stable runner counter.');
  }
  if ((item.spent as number) < (item.attempts as number)) throw new ValidationError('Stable attempt counters contradict each other.');
  for (const key of ['nativeUsed', 'fallbackExhausted', 'reportRepairExhausted'] as const) {
    if (item[key] !== undefined && item[key] !== true) throw new ValidationError('Invalid stable runner flag.');
  }
  if (item.mode === 'native' && item.nativeUsed !== true) throw new ValidationError('Native mode needs a recorded fallback.');
  for (const key of ['lastFailure', 'reason'] as const) {
    if (item[key] !== undefined && !bounded(item[key], 8000)) throw new ValidationError('Invalid stable runner explanation.');
  }
  if (item.rejected !== undefined) {
    const rejected = objectWithKeys(item.rejected, 'rejected report', ['reason', 'text']);
    if (!bounded(rejected.reason, 8000) || !bounded(rejected.text, 20000)) throw new ValidationError('Invalid rejected report.');
  }
  const report = objectWithKeys(item.report, 'stable report', ['phase', 'summary', 'how', 'status', 'evidence']);
  const last = workflow.snapshot().results.at(-1);
  if (![phase, last?.phase].includes(report.phase as Phase) || !isDeepStrictEqual(report.evidence, data.evidence)) {
    throw new ValidationError('Stable report is not bound to this run.');
  }
  renderReport(workflow.snapshot().answers.summary, item.report as PhaseReport);
  const files = list(item.changedList, 64, 'changed files').map(value => {
    const file = objectWithKeys(value, 'changed file', ['path', 'reason']);
    if (!bounded(file.path, 400) || (file.reason !== undefined && !bounded(file.reason, 500))) throw new ValidationError('Invalid changed file.');
    return file;
  });
  if (new Set(files.map(file => file.path)).size !== files.length || files.length !== data.changedFiles) throw new ValidationError('Changed-file count does not match stable state.');
  const advisory = list(item.concerns, 64, 'stable concerns').map(value => concerns([value])[0]);
  if (!isDeepStrictEqual(advisory, item.concerns)) throw new ValidationError('Invalid stable concerns.');
  if (item.delivered !== undefined && !isDeepStrictEqual(delivered(item.delivered), item.delivered)) throw new ValidationError('Invalid delivered summary.');
  return structuredClone(value) as StableRunnerState;
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max &&
    Buffer.from(value).toString('utf8') === value && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value);
}
function list(value: unknown, max: number, subject: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new ValidationError(`Invalid checkpoint ${subject}.`);
  return value;
}
function body(value: unknown): void {
  const item = objectWithKeys(value, 'checkpoint dependency', ['content', 'digest']);
  if (!bounded(item.content, 16000) || typeof item.digest !== 'string' || digest(item.content) !== item.digest) {
    throw new ValidationError('Missing or corrupt checkpoint dependency bytes.');
  }
}

function validateData(value: unknown, workflow: Workflow): ResumeData {
  const data = objectWithKeys(value, 'checkpoint data', ['directory', 'worktree', 'userMessageID', 'requirements', 'memoryProject', 'context',
    'dependencies', 'contexts', 'acceptance', 'decisions', 'planned', 'evidence', 'verification', 'executedChecks',
    'changedFiles', 'calls', 'usedMessages', 'proposed', 'rework']);
  if (![data.directory, data.worktree].every(item => bounded(item, 4096)) || !identifier(data.userMessageID) ||
      !bounded(data.requirements, 12000)) throw new ValidationError('Invalid checkpoint identity or requirements.');
  if (data.memoryProject !== undefined && (typeof data.memoryProject !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(data.memoryProject))) throw new ValidationError('Invalid checkpoint memory project.');
  if (['engram', 'both'].includes(workflow.snapshot().answers.artifactStore) && data.memoryProject === undefined) throw new ValidationError('Engram artifact backend needs a bound memory project.');
  for (const entry of list(data.context, 16, 'context')) {
    const item = objectWithKeys(entry, 'checkpoint context', ['label', 'content', 'source']);
    if (!bounded(item.label, 1000) || !bounded(item.content, 96000) || item.source !== 'coordinator') throw new ValidationError('Invalid checkpoint context.');
  }
  const results = workflow.snapshot().results;
  const dependencies = list(data.dependencies, 256, 'dependencies');
  if (dependencies.length !== results.length) throw new ValidationError('Missing checkpoint dependency bytes.');
  for (const [index, entry] of dependencies.entries()) {
    const item = objectWithKeys(entry, 'checkpoint dependency', ['phase', 'content', 'digest']);
    if (item.phase !== results[index]!.phase) throw new ValidationError('Checkpoint dependency phase mismatch.');
    body({ content: item.content, digest: item.digest });
  }
  for (const entry of list(data.contexts, 32, 'contextual findings')) {
    const item = objectWithKeys(entry, 'checkpoint finding', ['explorationID', 'outcome', 'summary', 'concerns', 'content', 'digest']);
    if (!identifier(item.explorationID) || !['passed', 'failed'].includes(String(item.outcome)) || !bounded(item.summary, 8000)) throw new ValidationError('Invalid checkpoint finding.');
    concerns(item.concerns);
    body({ content: item.content, digest: item.digest });
  }
  const accepted = data.acceptance === undefined ? undefined : acceptance(data.acceptance);
  if (!accepted && (list(data.decisions, 32, 'decisions').length || list(data.planned, 32, 'plan').length || data.verification !== undefined)) throw new ValidationError('Checkpoint plan has no acceptance.');
  const choices = accepted ? decisions(data.decisions, accepted) : [];
  const planned = list(data.planned, 32, 'plan').length ? deliverables(data.planned) : [];
  if (planned.length) validatePlan(accepted!, choices, planned);
  if (results.some(result => result.outcome === 'passed' && ['mdd-plan', 'mdd-spec'].includes(result.phase)) && !accepted) {
    throw new ValidationError('Checkpoint omits earned acceptance.');
  }
  if (results.some(result => result.outcome === 'passed' && ['mdd-plan', 'mdd-tasks'].includes(result.phase)) && !planned.length) {
    throw new ValidationError('Checkpoint omits the held plan.');
  }
  if (results.some(result => result.phase === 'mdd-verify') && data.verification === undefined) {
    throw new ValidationError('Checkpoint omits verification findings.');
  }
  evidenceCoverage(data.evidence as Evidence);
  const checks = executed(data.executedChecks);
  if (data.verification !== undefined) {
    if (!accepted || !planned.length) throw new ValidationError('Checkpoint verification has no held plan.');
    const item = objectWithKeys(data.verification, 'checkpoint verification', ['scenarios', 'steps', 'decisions', 'changes', 'limits', 'matched']);
    const { matched, ...report } = item;
    const checked = verification(report, accepted, choices, planned, checks.map(check => check.command), checks.filter(check => check.exit === 0).map(check => check.command));
    if (matched !== checked.matched) throw new ValidationError('Checkpoint verification match is inconsistent.');
  }
  if (!Number.isSafeInteger(data.changedFiles) || (data.changedFiles as number) < 0 || (data.changedFiles as number) > 100000) throw new ValidationError('Invalid checkpoint changed-file count.');
  for (const key of ['calls', 'usedMessages', 'proposed'] as const) {
    const entries = list(data[key], 512, key);
    if (new Set(entries).size !== entries.length || entries.some(item => !identifier(item))) throw new ValidationError('Invalid checkpoint replay guards.');
  }
  if (data.rework !== undefined) {
    const item = objectWithKeys(data.rework, 'checkpoint rework', ['after', 'summary']);
    if (item.after !== 'mdd-verify' || !bounded(item.summary, 8000)) throw new ValidationError('Invalid checkpoint rework.');
  }
  return structuredClone(value) as ResumeData;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
}

/** Validate the complete record and derive its state from replay, not from stored authority. */
export function validateCheckpoint(value: unknown): { checkpoint: AnyCheckpoint; workflow: Workflow } {
  const item = objectWithKeys(value, 'checkpoint', ['version', 'runID', 'parent', 'sequence', 'request', 'events', 'attempt', 'data', 'dataDigest', 'stable']);
  if (![CHECKPOINT_VERSION, RESUME_CHECKPOINT_VERSION, STABLE_CHECKPOINT_VERSION].includes(item.version as number) || !identifier(item.runID) || !identifier(item.parent) ||
      !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 0 ||
      Buffer.byteLength(JSON.stringify(value) ?? '') > CHECKPOINT_MAX_BYTES) throw new ValidationError('Invalid checkpoint.');
  if (item.version === 1 && (item.data !== undefined || item.dataDigest !== undefined || item.stable !== undefined)) throw new ValidationError('Invalid legacy checkpoint.');
  if (item.version === RESUME_CHECKPOINT_VERSION && item.stable !== undefined) throw new ValidationError('Unexpected v2 runner state.');
  if (item.version !== 1 && (!Object.hasOwn(item, 'data') || !Object.hasOwn(item, 'dataDigest'))) throw new ValidationError('Missing checkpoint data.');
  if (item.version === STABLE_CHECKPOINT_VERSION && !Object.hasOwn(item, 'stable')) throw new ValidationError('Missing stable runner state.');
  const workflow = Workflow.replay(item.request, item.events as WorkflowEvent[]);
  if (item.attempt !== undefined) {
    const attempt = objectWithKeys(item.attempt, 'checkpoint attempt', ['id', 'phase', 'state']);
    if (!identifier(attempt.id) || !identifier(attempt.phase) ||
        !['pending', 'settled', ...(item.version === STABLE_CHECKPOINT_VERSION ? ['released'] : [])].includes(String(attempt.state))) throw new ValidationError('Invalid checkpoint attempt.');
    const next = workflow.nextAction();
    const results = workflow.snapshot().results;
    if (attempt.state === 'pending' ? next.kind !== 'await-result' || next.phase !== attempt.phase :
      attempt.state === 'released' ? next.kind !== 'execute' || next.phase !== attempt.phase || workflow.history().at(-1)?.kind !== 'retry' :
      results.at(-1)?.phase !== attempt.phase || workflow.history().at(-1)?.kind !== 'result') throw new ValidationError('Checkpoint attempt contradicts workflow.');
  } else if (workflow.nextAction().kind === 'await-result') throw new ValidationError('Running phase needs an attempt.');
  if (item.version !== 1) {
    if (typeof item.dataDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.dataDigest) ||
        sealResumeData(item.data as ResumeData, item.runID as string, item.parent as string, item.events as WorkflowEvent[],
          item.version === STABLE_CHECKPOINT_VERSION ? item.stable as StableRunnerState : undefined) !== item.dataDigest) throw new ValidationError('Checkpoint data digest mismatch.');
    const data = validateData(item.data, workflow);
    if (item.version === STABLE_CHECKPOINT_VERSION) validateStable(item.stable, workflow, data);
  }
  return { checkpoint: structuredClone(value) as AnyCheckpoint, workflow };
}

export class CheckpointStore {
  readonly #files: LocalFiles;
  constructor(root: string) { this.#files = new LocalFiles(root); }
  #name(parent: string): `.mdd/checkpoint-${string}.json` {
    if (!identifier(parent)) throw new ValidationError('Invalid checkpoint parent.');
    return `.mdd/checkpoint-${createHash('sha256').update(parent).digest('hex')}.json`;
  }
  read(parent: string): ReturnType<typeof validateCheckpoint> | undefined {
    try {
      const text = this.#files.read(this.#name(parent), CHECKPOINT_MAX_BYTES);
      if (text === undefined) return undefined;
      const result = validateCheckpoint(JSON.parse(text));
      if (result.checkpoint.parent !== parent) throw new Error('Parent mismatch.');
      return result;
    } catch { throw new Error('Checkpoint cannot be read safely; do not resume or dispatch.'); }
  }
  /** Only explicit run discard releases the durable slot. */
  clear(parent: string): void {
    try { this.#files.remove(this.#name(parent)); }
    catch { throw new Error('Checkpoint could not be cleared; the run remains reserved.'); }
  }
  write(parent: string, value: AnyCheckpoint): void {
    try {
      const { checkpoint } = validateCheckpoint(value);
      if (checkpoint.parent !== parent) throw new Error('Parent mismatch.');
      const text = JSON.stringify(checkpoint);
      this.#files.update(this.#name(parent), previous => {
        if (previous !== undefined) {
          const old = validateCheckpoint(JSON.parse(previous)).checkpoint;
          if (old.parent !== parent || old.runID !== checkpoint.runID || old.sequence > checkpoint.sequence ||
              (old.version > checkpoint.version) ||
              (old.sequence === checkpoint.sequence && !isDeepStrictEqual(old, checkpoint))) throw new Error('Checkpoint conflict.');
        }
        return text;
      }, CHECKPOINT_MAX_BYTES);
      if (!isDeepStrictEqual(this.read(parent)?.checkpoint, checkpoint)) throw new Error('Checkpoint readback mismatch.');
    } catch { throw new Error('Checkpoint could not be confirmed; do not dispatch or advance.'); }
  }
}

/** A stale pending marker is cleared only by a checkpoint proving that exact attempt settled. */
export function reconcileProgress(marker: Progress | undefined, checkpoint: AnyCheckpoint | undefined): 'clear' | 'blocked' {
  if (!marker || marker.state !== 'pending' || !checkpoint) return 'blocked';
  try {
    const { checkpoint: valid } = validateCheckpoint(checkpoint);
    return marker.runID === valid.runID && marker.attemptID !== undefined &&
      marker.attemptID === valid.attempt?.id && valid.attempt.state === 'settled' ? 'clear' : 'blocked';
  } catch { return 'blocked'; }
}
