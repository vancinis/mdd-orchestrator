import { LocalFiles } from './local-files.js';
import { loadGlobalSettings } from './global-settings.js';
import type { InstallationEnvironment } from './installation-paths.js';
import { MODEL_ROLES } from './settings.js';
import type { Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LIMIT = 1024 * 1024;
const ROLLUP_LIMIT = 65536;
const MAX_EVENTS = 5000;
/** Counters are clamped rather than allowed to leave the exact-integer range after years of use. */
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_TOKENS = 1e12;
const MAX_COST = 1e9;

/**
 * What ended an attempt, named by the adapter at the point where it already knows. An actor never
 * proposes one of these: a taxonomy is only worth recording if the same word means the same thing
 * in every row, which free text reported by a model cannot promise.
 */
export const FAILURE_CLASSES = Object.freeze([
  // `result-malformed` is deliberately separate from `result-rejected`: one says the report could
  // not be read, the other says the work behind it could not be accepted. Counting them together
  // hid the single most common and cheapest-to-fix reason a phase had to be run twice.
  'phase-failed', 'result-rejected', 'result-malformed', 'dispatch-mismatch', 'native-error', 'route-blocked', 'stopped',
] as const);
export type FailureClass = typeof FAILURE_CLASSES[number];
const PHASES = MODEL_ROLES.filter((role): role is Phase => role !== 'orchestrator');

/**
 * Provider-reported usage of one delegated attempt: counts and a price, never text. `partial` is
 * the honest part. A child that talked past the read window, or a message whose usage had not
 * settled when the phase reported, produces an undercount, and an undercount presented as a
 * measurement is worse than no measurement at all.
 */
export type TelemetryUsage = {
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number;
  cost: number; messages: number; partial?: true;
};
export type TelemetryEvent = {
  timestamp: number;
  /**
   * `retry` and `handover` record what a failed attempt did next: delegate the same phase again,
   * or hand it to the coordinator. Without them a local log shows repeated blocked phases and no
   * way to tell a route that recovered from one that quietly stopped being delegated at all.
   */
  event: 'preflight' | 'phase-start' | 'phase-end' | 'approval' | 'report' | 'retry' | 'handover' | 'reset';
  phase?: Phase;
  duration?: number;
  route?: 'low' | 'high';
  outcome?: 'passed' | 'failed' | 'blocked' | 'cancelled';
  /**
   * Which run these rows belong to. Validated as a UUID and nothing else, so this field cannot
   * become the hole through which requirements, paths or any other text reach a metadata-only log.
   */
  runID?: string;
  /** The run's attempt counter when this phase began: 1 on a first try, higher after a failure. */
  attempt?: number;
  mode?: 'delegate' | 'inline';
  failure?: FailureClass;
  usage?: TelemetryUsage;
};
export type TelemetryResult =
  | { ok: true; enabled: boolean; count: number; retentionDays: 30; rollup?: 'unavailable' }
  | { ok: false; diagnostic: 'telemetry-unavailable' | 'invalid-event' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function counter(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new ValidationError('Invalid telemetry count.');
  return value as number;
}

function amount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_COST) throw new ValidationError('Invalid telemetry cost.');
  return value;
}

function parseUsage(value: unknown): TelemetryUsage {
  const input = objectWithKeys(value, 'usage', ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cost', 'messages', 'partial']);
  const usage: TelemetryUsage = {
    input: counter(input.input, MAX_TOKENS), output: counter(input.output, MAX_TOKENS),
    reasoning: counter(input.reasoning, MAX_TOKENS), cacheRead: counter(input.cacheRead, MAX_TOKENS),
    cacheWrite: counter(input.cacheWrite, MAX_TOKENS), cost: amount(input.cost),
    messages: counter(input.messages, MAX_EVENTS),
  };
  if (Object.hasOwn(input, 'partial')) {
    if (input.partial !== true) throw new ValidationError('Invalid usage completeness.');
    usage.partial = true;
  }
  return usage;
}

function parseEvent(value: unknown): TelemetryEvent {
  const input = objectWithKeys(value, 'event', ['timestamp', 'event', 'phase', 'duration', 'route', 'outcome', 'runID', 'attempt', 'mode', 'failure', 'usage']);
  if (!Number.isSafeInteger(input.timestamp) || (input.timestamp as number) < 0 || (input.timestamp as number) > 8640000000000000 ||
      !['preflight', 'phase-start', 'phase-end', 'approval', 'report', 'retry', 'handover', 'reset'].includes(input.event as string)) {
    throw new ValidationError('Invalid telemetry event.');
  }
  const result: TelemetryEvent = { timestamp: input.timestamp as number, event: input.event as TelemetryEvent['event'] };
  if (Object.hasOwn(input, 'phase')) {
    if (!MODEL_ROLES.includes(input.phase as Phase) || input.phase === 'orchestrator') throw new ValidationError('Invalid phase.');
    result.phase = input.phase as Phase;
  }
  if (Object.hasOwn(input, 'duration')) {
    if (!Number.isSafeInteger(input.duration) || (input.duration as number) < 0 || (input.duration as number) > 86400000) {
      throw new ValidationError('Invalid duration.');
    }
    result.duration = input.duration as number;
  }
  if (Object.hasOwn(input, 'route')) {
    if (input.route !== 'low' && input.route !== 'high') throw new ValidationError('Invalid route.');
    result.route = input.route;
  }
  if (Object.hasOwn(input, 'outcome')) {
    if (!['passed', 'failed', 'blocked', 'cancelled'].includes(input.outcome as string)) throw new ValidationError('Invalid outcome.');
    result.outcome = input.outcome as TelemetryEvent['outcome'] & string;
  }
  if (Object.hasOwn(input, 'runID')) {
    if (typeof input.runID !== 'string' || !UUID.test(input.runID)) throw new ValidationError('Invalid run identity.');
    result.runID = input.runID;
  }
  if (Object.hasOwn(input, 'attempt')) result.attempt = counter(input.attempt, 1000);
  if (Object.hasOwn(input, 'mode')) {
    if (input.mode !== 'delegate' && input.mode !== 'inline') throw new ValidationError('Invalid mode.');
    result.mode = input.mode;
  }
  if (Object.hasOwn(input, 'failure')) {
    if (!FAILURE_CLASSES.includes(input.failure as FailureClass)) throw new ValidationError('Invalid failure class.');
    result.failure = input.failure as FailureClass;
  }
  if (Object.hasOwn(input, 'usage')) result.usage = parseUsage(input.usage);
  return result;
}

/**
 * Events expire after 30 days, which is enough to inspect a bad week and far too little to learn
 * from. The rollup is the part that survives: fixed keys, counters only, no identity and no text,
 * so keeping it forever costs a few hundred bytes and answers what a pruned log no longer can.
 */
export const ROLLUP_VERSION = 1;
type PhaseRollup = {
  starts: number; passed: number; failed: number; blocked: number; retries: number; handovers: number;
  duration: number; timed: number;
  input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number;
  cost: number; measured: number; partial: number;
};
export type TelemetryRollup = {
  version: typeof ROLLUP_VERSION;
  since: number; updated: number; events: number;
  runs: { started: number; completed: number; blocked: number; reset: number };
  routes: { low: number; high: number };
  failures: Record<FailureClass, number>;
  phases: { [Key in Phase]?: PhaseRollup };
};
const PHASE_KEYS = ['starts', 'passed', 'failed', 'blocked', 'retries', 'handovers', 'duration', 'timed',
  'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cost', 'measured', 'partial'] as const;

function emptyPhase(): PhaseRollup {
  return { starts: 0, passed: 0, failed: 0, blocked: 0, retries: 0, handovers: 0, duration: 0, timed: 0,
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, measured: 0, partial: 0 };
}

export function emptyRollup(now: number): TelemetryRollup {
  return { version: ROLLUP_VERSION, since: now, updated: now, events: 0,
    runs: { started: 0, completed: 0, blocked: 0, reset: 0 }, routes: { low: 0, high: 0 },
    failures: Object.fromEntries(FAILURE_CLASSES.map(name => [name, 0])) as Record<FailureClass, number>,
    phases: {} };
}

/** Written by this module, so validation only has to fail closed on a damaged or foreign file. */
function parseRollup(value: unknown): TelemetryRollup {
  const input = objectWithKeys(value, 'rollup', ['version', 'since', 'updated', 'events', 'runs', 'routes', 'failures', 'phases']);
  if (input.version !== ROLLUP_VERSION) throw new ValidationError('Unknown rollup version.');
  const rollup = emptyRollup(counter(input.since, 8640000000000000));
  rollup.updated = counter(input.updated, 8640000000000000);
  rollup.events = counter(input.events, MAX_COUNT);
  const runs = objectWithKeys(input.runs, 'rollup.runs', Object.keys(rollup.runs));
  for (const key of Object.keys(rollup.runs) as (keyof TelemetryRollup['runs'])[]) rollup.runs[key] = counter(runs[key], MAX_COUNT);
  const routes = objectWithKeys(input.routes, 'rollup.routes', Object.keys(rollup.routes));
  for (const key of ['low', 'high'] as const) rollup.routes[key] = counter(routes[key], MAX_COUNT);
  const failures = objectWithKeys(input.failures, 'rollup.failures', FAILURE_CLASSES);
  for (const key of FAILURE_CLASSES) rollup.failures[key] = counter(failures[key], MAX_COUNT);
  const phases = objectWithKeys(input.phases, 'rollup.phases', PHASES);
  for (const phase of PHASES) {
    if (!Object.hasOwn(phases, phase)) continue;
    const stored = objectWithKeys(phases[phase], `rollup.phases.${phase}`, PHASE_KEYS);
    const entry = emptyPhase();
    for (const key of PHASE_KEYS) entry[key] = key === 'cost' ? amount(stored[key]) : counter(stored[key], MAX_COUNT);
    rollup.phases[phase] = entry;
  }
  return rollup;
}

const add = (total: number, value: number, max = MAX_COUNT) => Math.min(total + value, max);

function fold(rollup: TelemetryRollup, event: TelemetryEvent): TelemetryRollup {
  rollup.events = add(rollup.events, 1);
  rollup.updated = Math.max(rollup.updated, event.timestamp);
  if (event.event === 'preflight' && event.outcome === 'passed') {
    rollup.runs.started = add(rollup.runs.started, 1);
    if (event.route) rollup.routes[event.route] = add(rollup.routes[event.route], 1);
  }
  if (event.event === 'report' && event.outcome === 'passed') rollup.runs.completed = add(rollup.runs.completed, 1);
  if (event.event === 'report' && event.outcome === 'blocked') rollup.runs.blocked = add(rollup.runs.blocked, 1);
  if (event.event === 'reset') rollup.runs.reset = add(rollup.runs.reset, 1);
  // An ended attempt and an ended run are both counted, because they are different facts: one
  // route dying after a rejected result is two things worth knowing. The `retry` and `handover`
  // rows repeat the class of the attempt they follow, so counting those too would inflate it.
  if (event.failure && (event.event === 'phase-end' || event.event === 'report')) {
    rollup.failures[event.failure] = add(rollup.failures[event.failure], 1);
  }
  if (event.phase) {
    const phase = rollup.phases[event.phase] ??= emptyPhase();
    if (event.event === 'phase-start') phase.starts = add(phase.starts, 1);
    if (event.event === 'retry') phase.retries = add(phase.retries, 1);
    if (event.event === 'handover') phase.handovers = add(phase.handovers, 1);
    if (event.event === 'phase-end') {
      if (event.outcome === 'passed') phase.passed = add(phase.passed, 1);
      if (event.outcome === 'failed') phase.failed = add(phase.failed, 1);
      if (event.outcome === 'blocked') phase.blocked = add(phase.blocked, 1);
      if (event.duration !== undefined) { phase.duration = add(phase.duration, event.duration); phase.timed = add(phase.timed, 1); }
    }
    if (event.usage) {
      phase.input = add(phase.input, event.usage.input, MAX_TOKENS);
      phase.output = add(phase.output, event.usage.output, MAX_TOKENS);
      phase.reasoning = add(phase.reasoning, event.usage.reasoning, MAX_TOKENS);
      phase.cacheRead = add(phase.cacheRead, event.usage.cacheRead, MAX_TOKENS);
      phase.cacheWrite = add(phase.cacheWrite, event.usage.cacheWrite, MAX_TOKENS);
      phase.cost = add(phase.cost, event.usage.cost, MAX_COST);
      phase.measured = add(phase.measured, 1);
      if (event.usage.partial) phase.partial = add(phase.partial, 1);
    }
  }
  return rollup;
}

function retained(text: string | undefined, now: number): TelemetryEvent[] {
  if (text === undefined || text === '') return [];
  const lines = text.trimEnd().split('\n');
  if (lines.length > MAX_EVENTS) throw new Error('Invalid local telemetry.');
  return lines.map(line => parseEvent(JSON.parse(line))).filter(event => event.timestamp > now - RETENTION_MS && event.timestamp <= now);
}

function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error('Invalid clock.');
}

function success(enabled: boolean, count: number, rollup?: 'unavailable'): TelemetryResult {
  return { ok: true, enabled, count, retentionDays: 30, ...(rollup ? { rollup } : {}) };
}

function readRollup(files: LocalFiles): TelemetryRollup | undefined {
  const text = files.read('.mdd/telemetry-rollup.json', ROLLUP_LIMIT);
  return text === undefined ? undefined : parseRollup(JSON.parse(text));
}

/**
 * A rollup that quietly stops accumulating would leave the report looking healthy while the only
 * record that outlives retention goes stale, so the failure is reported instead of swallowed. It
 * never blocks the event itself: an event already written is worth keeping.
 */
function updateRollup(files: LocalFiles, event: TelemetryEvent): boolean {
  try {
    files.update('.mdd/telemetry-rollup.json', previous => JSON.stringify(
      fold(previous === undefined ? emptyRollup(event.timestamp) : parseRollup(JSON.parse(previous)), event),
    ), ROLLUP_LIMIT);
    return true;
  } catch { return false; }
}

/** No background timers, import side effects, network calls, or implicit startup writes. */
export function recordTelemetry(root: string, value: unknown, now = Date.now(), environment?: InstallationEnvironment): TelemetryResult {
  let event: TelemetryEvent;
  try {
    clock(now);
    event = parseEvent(value);
    if (event.timestamp > now || event.timestamp <= now - RETENTION_MS) throw new Error('Out of retention window.');
  } catch { return { ok: false, diagnostic: 'invalid-event' }; }
  try {
    if (!loadGlobalSettings(environment).telemetry.enabled) return success(false, 0);
    let count = 0;
    const files = new LocalFiles(root);
    files.update('.mdd/telemetry.jsonl', previous => {
      const events = [...retained(previous, now), event].slice(-MAX_EVENTS);
      count = events.length;
      return `${events.map(item => JSON.stringify(item)).join('\n')}\n`;
    }, LIMIT);
    return success(true, count, updateRollup(files, event) ? undefined : 'unavailable');
  } catch { return { ok: false, diagnostic: 'telemetry-unavailable' }; }
}

/** Status prunes expired rows only when an existing file needs pruning. */
export function telemetryStatus(root: string, now = Date.now(), environment?: InstallationEnvironment): TelemetryResult {
  try {
    clock(now);
    const enabled = loadGlobalSettings(environment).telemetry.enabled;
    const files = new LocalFiles(root);
    const previous = files.read('.mdd/telemetry.jsonl', LIMIT);
    let events = retained(previous, now);
    const serialize = (items: TelemetryEvent[]) => items.length ? `${items.map(item => JSON.stringify(item)).join('\n')}\n` : undefined;
    if (previous !== undefined && previous !== serialize(events)) {
      files.update('.mdd/telemetry.jsonl', current => {
        events = retained(current, now);
        return serialize(events);
      }, LIMIT);
    }
    return success(enabled, events.length);
  } catch { return { ok: false, diagnostic: 'telemetry-unavailable' }; }
}

export function clearTelemetry(root: string, environment?: InstallationEnvironment): TelemetryResult {
  try {
    const enabled = loadGlobalSettings(environment).telemetry.enabled;
    const files = new LocalFiles(root);
    files.remove('.mdd/telemetry.jsonl');
    // Deleting telemetry means deleting it. A surviving rollup would keep answering questions
    // about runs the user just asked MDD to forget.
    files.remove('.mdd/telemetry-rollup.json');
    return success(enabled, 0);
  } catch { return { ok: false, diagnostic: 'telemetry-unavailable' }; }
}

function tokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}G`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function elapsed(value: number): string {
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

const COLUMNS: { head: string; width: number }[] = [
  { head: 'phase', width: 12 }, { head: 'runs', width: 6 }, { head: 'pass', width: 6 }, { head: 'fail', width: 6 },
  { head: 'retry', width: 6 }, { head: 'hand', width: 6 }, { head: 'avg', width: 8 },
  { head: 'in', width: 9 }, { head: 'out', width: 8 }, { head: 'cache', width: 9 }, { head: 'cost', width: 9 },
];
const row = (cells: string[]) => cells.map((cell, index) => cell.padEnd(COLUMNS[index]!.width)).join('').trimEnd();

/**
 * The first reader of MDD's own records. Everything here is arithmetic over the rollup: no model
 * is asked what the numbers mean, because a report that costs tokens to produce would be the
 * first thing to cut on a slow day, and then nothing would be read at all.
 */
export function renderTelemetryReport(rollup: TelemetryRollup | undefined, recent: number, enabled: boolean): string {
  const lines = ['MDD run ledger — local only, never exported.'];
  if (!enabled) lines.push('Telemetry is currently off, so nothing new is being recorded.');
  if (!rollup || !rollup.events) {
    // Events written before this workspace had an aggregate are still events. Reporting them as
    // nothing would be wrong, and rebuilding the aggregate here would make reading a write.
    lines.push(recent
      ? `No totals have been kept in this workspace yet, and ${recent} event(s) from the last 30 days are on file. Totals start accumulating with the next recorded phase.`
      : `No runs have been recorded yet in this workspace.${enabled ? ' The ledger fills as phases run.' : ''}`);
    return `${lines.join('\n')}\n`;
  }
  const days = Math.max(1, Math.round((rollup.updated - rollup.since) / 86400000));
  lines.push(`${rollup.events} event(s) since ${new Date(rollup.since).toISOString().slice(0, 10)} (${days} day(s)); ${recent} still inside the 30-day event window.`,
    '',
    `Runs: ${rollup.runs.started} started, ${rollup.runs.completed} completed, ${rollup.runs.blocked} blocked, ${rollup.runs.reset} reset. Routes: ${rollup.routes.low} low, ${rollup.routes.high} high.`,
    '',
    row(COLUMNS.map(column => column.head)));
  const totals = emptyPhase();
  for (const phase of PHASES) {
    const entry = rollup.phases[phase];
    if (!entry) continue;
    for (const key of PHASE_KEYS) totals[key] += entry[key];
    lines.push(row([phase.slice(4), String(entry.starts), String(entry.passed), String(entry.failed + entry.blocked),
      String(entry.retries), String(entry.handovers), entry.timed ? elapsed(entry.duration / entry.timed) : '-',
      tokens(entry.input), tokens(entry.output), tokens(entry.cacheRead + entry.cacheWrite), entry.cost.toFixed(4)]));
  }
  lines.push(row(['total', String(totals.starts), String(totals.passed), String(totals.failed + totals.blocked),
    String(totals.retries), String(totals.handovers), totals.timed ? elapsed(totals.duration / totals.timed) : '-',
    tokens(totals.input), tokens(totals.output), tokens(totals.cacheRead + totals.cacheWrite), totals.cost.toFixed(4)]));
  const failures = FAILURE_CLASSES.filter(name => rollup.failures[name]).map(name => `${name} ${rollup.failures[name]}`);
  lines.push('', failures.length ? `Failures: ${failures.join(', ')}.` : 'No failed attempt has been recorded.');
  lines.push(`Usage measured for ${totals.measured} of ${totals.starts} phase run(s)${totals.partial ? `, ${totals.partial} of them incomplete` : ''}. A phase the coordinator carries out itself reports no separate usage, because its tokens belong to the conversation.`,
    'Counts are what the provider reported, and cost is in the provider\u2019s own units. Coverage is not correctness.');
  return `${lines.join('\n')}\n`;
}

export function telemetryReport(root: string, now = Date.now(), environment?: InstallationEnvironment): { ok: true; text: string } | { ok: false; diagnostic: 'telemetry-unavailable' } {
  try {
    clock(now);
    const enabled = loadGlobalSettings(environment).telemetry.enabled;
    const files = new LocalFiles(root);
    return { ok: true, text: renderTelemetryReport(readRollup(files), retained(files.read('.mdd/telemetry.jsonl', LIMIT), now).length, enabled) };
  } catch { return { ok: false, diagnostic: 'telemetry-unavailable' }; }
}
