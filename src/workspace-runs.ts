import type { CheckpointStore } from './checkpoint.js';
import { STABLE_CHECKPOINT_VERSION } from './checkpoint.js';
import type { ProgressGuard } from './progress.js';
import type { Phase } from './policy.js';
import type { Runtime } from './phase-runner.js';
import type { RunDossier, RunDossierStore } from './run-dossier.js';
import type { RunOwnershipStore } from './run-ownership.js';
import { projectTargetTransfer } from './transfer.js';

/**
 * A conversation used to see only its own run. Asked to "continue issue #433" in a new one, the
 * coordinator found nothing, started a second run from the bare sentence, and its exploration had
 * nothing to explore — while the run that had already explored, specified, designed and planned
 * that issue sat blocked at Apply one file away in the same `.mdd` directory.
 *
 * These rows are the index that was missing: which runs this workspace already holds, where each
 * stopped, and how it can be resumed. They are data, never authority. A row approves nothing,
 * resumes nothing and is never a reason to skip a question; the user still decides, in their own
 * words, whether to continue a recorded run or start a new one.
 */
export const WORKSPACE_RUNS_SCANNED = 12;
export const WORKSPACE_RUNS_SHOWN = 6;

/**
 * How a recorded run can go on, as far as local files can tell:
 * - `transfer`: its checkpoint is settled at a boundary a transfer projects, so this conversation
 *   can take it over once the user's own message names `sourceSessionID=<id> runID=<id>`.
 * - `transfer-rework`: the same, after a failed verification; that message must also say `rework`.
 * - `source-conversation`: it can only be recovered where it lives (for example `mdd_reset` scope
 *   phase there for a blocked phase), or its evidence can seed a new run started with new consent.
 * - `finished`: it completed; new work is a new objective.
 */
export type WorkspaceRunResume = 'transfer' | 'transfer-rework' | 'source-conversation' | 'finished';

export type WorkspaceRun = {
  capability: 'data-only';
  runID: string;
  sessionID: string;
  file: string;
  updatedAt: string;
  requirements: string;
  goal?: string;
  providedContext?: string[];
  route: Phase[];
  phase: Phase;
  lastState: RunDossier['lastState'];
  passed: Phase[];
  last?: { phase: Phase; outcome: 'passed' | 'failed'; summary: string };
  resume: WorkspaceRunResume;
  directory?: string;
};

export type WorkspaceRunSources = {
  dossier: RunDossierStore;
  checkpoint?: CheckpointStore;
  progress?: ProgressGuard;
  ownership?: RunOwnershipStore;
};

/** A message ID no native message can carry, so the eligibility probe can never match a real one. */
const PROBE_MESSAGE = 'mdd-workspace-runs-probe';

function clip(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let kept = Buffer.from(text).subarray(0, max - 3).toString('utf8').replace(/\uFFFD$/, '');
  while (Buffer.byteLength(kept) > max - 3) kept = kept.slice(0, -1);
  return `${kept}…`;
}

/**
 * Answered by the transfer projection itself rather than by a second copy of its rules: a hint
 * that disagreed with `mdd_transfer` would send the user to type an identifier for nothing. The
 * projection is pure, so probing it moves nothing. What it cannot see — memory binding, a live
 * writer racing it — `mdd_transfer` still checks and reports when it is actually called.
 */
function resumeOf(dossier: RunDossier, target: Runtime, sources: WorkspaceRunSources): WorkspaceRunResume {
  if (dossier.lastState === 'complete') return 'finished';
  const source = dossier.parent.sessionID;
  if (!sources.checkpoint || !sources.ownership || dossier.parent.directory !== target.directory ||
      dossier.parent.worktree !== target.worktree) return 'source-conversation';
  try {
    const owner = sources.ownership.read(dossier.runID);
    if (!owner || owner.ownerSessionID !== source || owner.state !== 'idle') return 'source-conversation';
    const saved = sources.checkpoint.read(source)?.checkpoint;
    if (!saved || saved.version !== STABLE_CHECKPOINT_VERSION || saved.runID !== dossier.runID) return 'source-conversation';
    const marker = sources.progress?.read(source);
    for (const [suffix, resume] of [['', 'transfer'], [' rework', 'transfer-rework']] as const) {
      try {
        projectTargetTransfer(saved, marker, target, { sessionID: target.sessionID, userMessageID: PROBE_MESSAGE,
          userText: `sourceSessionID=${source} runID=${dossier.runID}${suffix}`, latest: true, authored: true });
        return resume;
      } catch { /* Not projectable this way; try the next, then fall back to its own conversation. */ }
    }
  } catch { /* An unreadable owner, checkpoint or marker is decided where the run lives. */ }
  return 'source-conversation';
}

function row(dossier: RunDossier, file: string, resume: WorkspaceRunResume, target: Runtime): WorkspaceRun {
  const last = dossier.results.at(-1);
  const passed = [...new Set(dossier.results.filter(item => item.outcome === 'passed').map(item => item.phase))];
  return {
    capability: 'data-only', runID: dossier.runID, sessionID: dossier.parent.sessionID, file,
    updatedAt: new Date(dossier.timestamp).toISOString(),
    requirements: clip(dossier.requirements, 600),
    ...(dossier.acceptance?.goal ? { goal: clip(dossier.acceptance.goal, 400) } : {}),
    ...(dossier.context.length ? { providedContext: dossier.context.slice(0, 6).map(item => clip(item.label, 160)) } : {}),
    route: [...dossier.route], phase: dossier.phase, lastState: dossier.lastState, passed,
    ...(last ? { last: { phase: last.phase, outcome: last.outcome, summary: clip(last.evidenceSummary, 500) } } : {}),
    resume,
    ...(dossier.parent.directory !== target.directory ? { directory: dossier.parent.directory } : {}),
  };
}

/**
 * Earlier runs of other conversations in this workspace, newest first. Never throws: a workspace
 * whose records cannot be listed simply reports none, because this is a pointer for the
 * coordinator and must never stand between a user and a new run.
 *
 * Left out on purpose: this conversation's own record (that is `priorRun`), records holding no
 * phase result and no investigation (nothing to continue), and a run that moved to another
 * conversation, which is listed there instead — the copy left behind is not where it lives.
 */
export function workspaceRuns(target: Runtime, sources: WorkspaceRunSources): WorkspaceRun[] {
  let records: { file: string; dossier: RunDossier }[];
  try { records = sources.dossier.recent(WORKSPACE_RUNS_SCANNED); } catch { return []; }
  const seen = new Set<string>();
  const runs: WorkspaceRun[] = [];
  for (const { file, dossier } of records) {
    if (runs.length >= WORKSPACE_RUNS_SHOWN) break;
    if (dossier.parent.sessionID === target.sessionID || seen.has(dossier.runID) || dossier.discardedAt !== undefined) continue;
    if (!dossier.results.length && !dossier.contexts.length) continue;
    try {
      const owner = sources.ownership?.read(dossier.runID);
      if (owner && owner.ownerSessionID !== dossier.parent.sessionID) continue;
    } catch { /* An owner that cannot be confirmed is reported as recoverable only where it lives. */ }
    seen.add(dossier.runID);
    runs.push(row(dossier, file, resumeOf(dossier, target, sources), target));
  }
  return runs;
}
