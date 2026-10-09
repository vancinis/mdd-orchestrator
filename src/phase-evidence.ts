import { objectWithKeys } from './validation.js';
import { raise, readVerification, references, shortText } from './acceptance.js';
import type { HeldPlan, Verification } from './acceptance.js';
import { parseParallelScope } from './worker-batch.js';
import type { ParallelScope } from './worker-batch.js';

export type Deliverable = { id: string; description: string; path: string; check: string; scenarios: string[]; decisions: string[]; dependsOn: string[]; parallel?: ParallelScope };
export type Check = { command: string; exit: number | null };

export function deliverables(value: unknown): Deliverable[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Planning requires 1–32 explicit deliverables.');
  const ids = new Set<string>();
  return value.map(item => {
    const entry = objectWithKeys(item, 'deliverable', ['id', 'description', 'path', 'check', 'scenarios', 'decisions', 'dependsOn', 'parallel']);
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id)) throw new Error(`Deliverable id ${JSON.stringify(String(entry.id).slice(0, 64))} must be a stable short identifier of 1–64 letters, digits, underscores or hyphens.`);
    if (ids.has(entry.id)) throw new Error(`Deliverable id ${entry.id} is used more than once.`);
    ids.add(entry.id);
    const parallel = Object.hasOwn(entry, 'parallel') ? parseParallelScope(entry.parallel) : undefined;
    return { id: entry.id, description: shortText(entry.description, `description of deliverable ${entry.id}`),
      path: shortText(entry.path, `implementation target of deliverable ${entry.id}`, 400), check: shortText(entry.check, `planned check command of deliverable ${entry.id}`, Infinity),
      scenarios: references(entry.scenarios, `scenarios of deliverable ${entry.id}`), decisions: references(Object.hasOwn(entry, 'decisions') ? entry.decisions : [], `decisions of deliverable ${entry.id}`, true), dependsOn: references(Object.hasOwn(entry, 'dependsOn') ? entry.dependsOn : [], `dependencies of deliverable ${entry.id}`, true),
      // An omitted dependency declaration is not an attestation, even after JSON/checkpoint replay.
      ...(parallel && Object.hasOwn(entry, 'dependsOn') ? { parallel } : {}) };
  });
}

/**
 * Executed checks as the actor reports them, with every problem in the list rather than the first.
 *
 * A command has no length limit. A verification legitimately runs a long inline script, the PR body
 * already shows only short commands, and a limit here once rejected a finished 33 KB verification
 * over one 1019-character `node -e` probe. It must still be one line: it is cited back verbatim by
 * the assessments and rendered as one bullet.
 *
 * Each problem is named by its position, `checks[9].command`, because the coordinator that restates
 * the report fixes it by hand and cannot find which of twelve commands an unlabelled message meant.
 * `reported`/`passed` keep the commands as stated, so assessments citing them are judged against
 * what the report says it ran even when another entry of the list is malformed.
 */
function readExecuted(value: unknown): { checks: Check[]; problems: string[]; reported?: string[]; passed?: string[] } {
  if (value === undefined) return { checks: [], problems: [], reported: [], passed: [] };
  if (!Array.isArray(value) || value.length > 32) {
    return { checks: [], problems: [`Report executed checks as a list of at most 32 entries${Array.isArray(value) ? `; this report lists ${value.length}` : ''}.`] };
  }
  const checks: Check[] = [];
  const problems: string[] = [];
  const reported: string[] = [];
  const passed: string[] = [];
  value.forEach((item, index) => {
    let entry: Record<string, unknown>;
    try { entry = objectWithKeys(item, `checks[${index}]`, ['command', 'exit']); }
    catch (error) { problems.push(error instanceof Error ? error.message : String(error)); return; }
    const exit = entry.exit ?? null;
    if (typeof entry.command === 'string') {
      reported.push(entry.command.trim());
      if (exit === 0) passed.push(entry.command.trim());
    }
    const own: string[] = [];
    if (exit !== null && !Number.isInteger(exit)) own.push(`checks[${index}].exit must be an integer exit code, or null when the command did not finish; it read ${JSON.stringify(exit) ?? String(exit)}.`);
    let command: string | undefined;
    try { command = shortText(entry.command, `checks[${index}].command`, Infinity); }
    catch (error) { own.push(error instanceof Error ? error.message : String(error)); }
    problems.push(...own);
    if (!own.length) checks.push({ command: command!, exit: exit as number | null });
  });
  return { checks, problems, reported, passed };
}

/** Executed checks as reported. MDD records the claim and shows it as a claim; it neither re-runs the command nor presents an exit code as proof of behaviour. */
export function executed(value: unknown): Check[] {
  const read = readExecuted(value);
  raise(read.problems, 'The executed checks');
  return read.checks;
}

/**
 * Verify's two fields read as one report, so a restatement is told everything at once: the checks it
 * ran and the verification that cites them are written together and fixed together. With a held
 * plan this is the real validation; without one it is the form `mdd_check_report` can answer.
 */
export function verifyReport(checks: unknown, report: unknown, held?: HeldPlan): { ran: Check[]; verification?: Verification } {
  const ran = readExecuted(checks);
  const read = readVerification(report, held, ran.reported, ran.passed);
  raise([...ran.problems, ...read.problems], 'The verification report');
  return { ran: ran.checks, ...(read.verification ? { verification: read.verification } : {}) };
}

export type Delivered = { what: string; implies?: string };

/**
 * What the change is, told the way the person reviewing it needs to hear it: what is now possible
 * or different, and what that enables. It is deliberately not a description of how the work was
 * done — the per-file reasons already carry the mechanics, and a summary that repeats them tells
 * a reviewer about the diff they are already looking at instead of about the change.
 *
 * A malformed summary is dropped rather than fatal, and the phase is told the field was ignored.
 * Apply reports it after the implementation is finished, and no summary is worth discarding
 * finished work over; the body falls back to the recorded goal and says that it did.
 */
export function delivered(value: unknown): Delivered | undefined {
  if (value === undefined) return undefined;
  try {
    const entry = objectWithKeys(value, 'delivered summary', ['what', 'implies']);
    const summary: Delivered = { what: shortText(entry.what, 'what the change delivers', 400) };
    if (entry.implies !== undefined) summary.implies = shortText(entry.implies, 'what the change implies', 300);
    return summary;
  } catch { return undefined; }
}

export type ChangedFile = { path: string; reason?: string };

/**
 * Apply reports the files it changed, or states why nothing changed. A file may be reported as a
 * bare path or as `{ path, reason }`, and the reason is what a reviewer actually needs: a list of
 * paths says a diff exists, which the diff already said. Both forms are accepted because the
 * reason is worth asking for and never worth failing a finished implementation over.
 */
export function changed(value: unknown, noChangeReason: unknown): { paths: string[]; files: ChangedFile[]; reason?: string } {
  if (value !== undefined && !Array.isArray(value)) throw new Error('Report changes as a list of changed paths, or of {path, reason} entries.');
  const files: ChangedFile[] = Array.isArray(value) ? value.map(item => {
    if (typeof item === 'string') return { path: shortText(item, 'changed path', 400) };
    const entry = objectWithKeys(item, 'changed file', ['path', 'reason']);
    const file: ChangedFile = { path: shortText(entry.path, 'changed path', 400) };
    if (entry.reason !== undefined) file.reason = shortText(entry.reason, 'reason a file changed', 500);
    return file;
  }) : [];
  if (files.length > 64) throw new Error('Report at most 64 changed paths.');
  if (files.length) return { paths: files.map(file => file.path), files };
  return { paths: [], files: [], reason: shortText(noChangeReason, 'no-change reason', 2000) };
}
