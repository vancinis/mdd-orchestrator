import { LocalFiles } from './local-files.js';
import { evidenceCoverage } from './reporting.js';
import type { Evidence } from './reporting.js';
import { MODEL_ROLES } from './settings.js';
import type { Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

/**
 * What happened, run by run, kept after the run is gone.
 *
 * The dossier already preserves a run in full, but it holds exactly one slot per conversation and
 * is overwritten the moment that conversation starts its next objective. It answers "can this run
 * be picked up again", which is a question about one run. Nobody could ask the other question —
 * "how has this repository's work been going" — because the evidence for it was deleted on every
 * new start, and telemetry, which does survive, counts events without ever saying which run they
 * belonged to or what it was trying to do.
 *
 * This is that missing row: one compact record per finished run, appended where the dossier is
 * replaced. It holds outcome, route, coverage, checks and the limits the verification recorded —
 * no artifacts, no prompts, no source — so a few hundred runs cost a few hundred kilobytes and a
 * review has something to read that is neither a single run nor an anonymous counter.
 */
export const RUN_LEDGER_VERSION = 1;
const LIMIT = 512 * 1024;
/** Enough to see a quarter of work in an active repository; small enough to stay a local file. */
export const MAX_RUNS = 200;
const GOAL_MAX = 300;
const LIMIT_MAX = 300;
const MAX_LIMITS = 4;
const PHASES = MODEL_ROLES.filter((role): role is Phase => role !== 'orchestrator');
const CONTROL = /[\x00-\x1f\x7f]/;

export const RUN_STATES = Object.freeze(['complete', 'blocked'] as const);
export type RunState = typeof RUN_STATES[number];

export type RunRecord = {
  version: typeof RUN_LEDGER_VERSION;
  runID: string;
  timestamp: number;
  state: RunState;
  /** The checkout the run happened in. Post-worktree-anchoring, rows from many arrive together. */
  directory: string;
  route: Phase[];
  /** The phase it was in when it finished, which for a blocked run is where it stopped. */
  phase: Phase;
  coverage: number;
  evidence: Evidence;
  changedFiles: number;
  checks: { total: number; passed: number; failed: number };
  concerns: number;
  /** The requested outcome, as the planning phase recorded it. Actor prose, kept verbatim. */
  goal?: string;
  limits: string[];
};

export type RunLedgerInput = {
  runID: string; state: RunState; directory: string; route: readonly Phase[]; phase: Phase;
  evidence: Evidence; changedFiles: number; checks: { total: number; passed: number; failed: number };
  concerns: number; goal?: string; limits?: readonly string[];
};

export type RunLedgerResult =
  | { ok: true; recorded: RunRecord; total: number; pruned: number }
  | { ok: false; diagnostic: 'runs-unavailable' | 'invalid-run' };

function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new ValidationError('Invalid clock.');
}

function text(value: unknown, subject: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) {
    throw new ValidationError(`${subject} must be bounded plain text.`);
  }
  return value.trim();
}

function count(value: unknown, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new ValidationError(`${subject} must be a nonnegative integer.`);
  return value as number;
}

function phase(value: unknown, subject: string): Phase {
  if (!PHASES.includes(value as Phase)) throw new ValidationError(`Invalid ${subject}.`);
  return value as Phase;
}

/** Written by this module, so parsing only has to fail closed on a damaged or foreign row. */
function parseRecord(value: unknown): RunRecord {
  const input = objectWithKeys(value, 'run', ['version', 'runID', 'timestamp', 'state', 'directory',
    'route', 'phase', 'coverage', 'evidence', 'changedFiles', 'checks', 'concerns', 'goal', 'limits']);
  if (input.version !== RUN_LEDGER_VERSION) throw new ValidationError('Unknown run ledger version.');
  clock(input.timestamp as number);
  if (!RUN_STATES.includes(input.state as RunState)) throw new ValidationError('Invalid run state.');
  if (!Array.isArray(input.route) || !Array.isArray(input.limits)) throw new ValidationError('Invalid run row.');
  const checks = objectWithKeys(input.checks, 'run.checks', ['total', 'passed', 'failed']);
  const record: RunRecord = {
    version: RUN_LEDGER_VERSION,
    runID: text(input.runID, 'run id', 128),
    timestamp: input.timestamp as number,
    state: input.state as RunState,
    directory: text(input.directory, 'run directory', 4096),
    route: input.route.map(item => phase(item, 'route phase')),
    phase: phase(input.phase, 'run phase'),
    coverage: count(input.coverage, 'run coverage'),
    evidence: input.evidence as Evidence,
    changedFiles: count(input.changedFiles, 'changed file count'),
    checks: { total: count(checks.total, 'check total'), passed: count(checks.passed, 'checks passed'), failed: count(checks.failed, 'checks failed') },
    concerns: count(input.concerns, 'concern count'),
    limits: input.limits.slice(0, MAX_LIMITS).map(item => text(item, 'recorded limit', LIMIT_MAX)),
  };
  if (input.goal !== undefined) record.goal = text(input.goal, 'run goal', GOAL_MAX);
  // Coverage is derived, so a row claiming a different one is a damaged row, not a disagreement.
  if (record.coverage !== evidenceCoverage(record.evidence)) throw new ValidationError('Run coverage does not match its evidence.');
  return record;
}

function parseAll(content: string | undefined): RunRecord[] {
  if (content === undefined || content === '') return [];
  const lines = content.trimEnd().split('\n');
  if (lines.length > MAX_RUNS * 2) throw new Error('Invalid local run ledger.');
  return lines.map(line => parseRecord(JSON.parse(line)));
}

function serialize(runs: readonly RunRecord[]): string | undefined {
  return runs.length ? `${runs.map(run => JSON.stringify(run)).join('\n')}\n` : undefined;
}

function parseInput(value: RunLedgerInput, now: number): RunRecord {
  const input = objectWithKeys(value, 'run', ['runID', 'state', 'directory', 'route', 'phase',
    'evidence', 'changedFiles', 'checks', 'concerns', 'goal', 'limits']);
  return parseRecord({
    version: RUN_LEDGER_VERSION, timestamp: now,
    runID: input.runID, state: input.state, directory: input.directory,
    route: input.route, phase: input.phase,
    coverage: evidenceCoverage(input.evidence as Evidence), evidence: input.evidence,
    changedFiles: input.changedFiles, checks: input.checks, concerns: input.concerns,
    ...(input.goal === undefined ? {} : { goal: String(input.goal).slice(0, GOAL_MAX) }),
    limits: ((input.limits ?? []) as readonly string[]).slice(0, MAX_LIMITS).map(item => String(item).slice(0, LIMIT_MAX)),
  });
}

/**
 * One row per run, replaced in place when the same run reaches a further state. A run that was
 * blocked and later finished is one run that finished, and appending both would make a repository
 * look like it did twice the work and abandoned half of it.
 */
export function recordRun(root: string, value: RunLedgerInput, now = Date.now()): RunLedgerResult {
  let record: RunRecord;
  try {
    clock(now);
    record = parseInput(value, now);
  } catch { return { ok: false, diagnostic: 'invalid-run' }; }
  try {
    const files = new LocalFiles(root);
    let total = 0;
    let pruned = 0;
    files.update('.mdd/runs.jsonl', previous => {
      const existing = parseAll(previous).filter(item => item.runID !== record.runID);
      const kept = [...existing, record];
      pruned = Math.max(0, kept.length - MAX_RUNS);
      // Oldest first: the runs worth keeping are the recent ones, exactly as for the event log.
      total = kept.length - pruned;
      return serialize(kept.slice(-MAX_RUNS));
    }, LIMIT);
    return { ok: true, recorded: record, total, pruned };
  } catch { return { ok: false, diagnostic: 'runs-unavailable' }; }
}

/** Recording must never be able to stop the run it is describing. */
export function recordRunQuietly(root: string, value: RunLedgerInput, now = Date.now()): void {
  try { recordRun(root, value, now); } catch { /* A ledger row is never worth a route. */ }
}

export function readRuns(root: string, query?: { limit?: number }): { ok: true; runs: RunRecord[]; total: number } | { ok: false; diagnostic: 'runs-unavailable' } {
  try {
    const runs = parseAll(new LocalFiles(root).read('.mdd/runs.jsonl', LIMIT));
    const limit = query?.limit ?? runs.length;
    if (!Number.isInteger(limit) || limit < 0) throw new ValidationError('Invalid run limit.');
    // Newest first: a review starts from what just happened.
    return { ok: true, runs: runs.slice(-limit).reverse(), total: runs.length };
  } catch { return { ok: false, diagnostic: 'runs-unavailable' }; }
}

export function clearRuns(root: string): { ok: true } | { ok: false; diagnostic: 'runs-unavailable' } {
  try { new LocalFiles(root).remove('.mdd/runs.jsonl'); return { ok: true }; }
  catch { return { ok: false, diagnostic: 'runs-unavailable' }; }
}
