import { objectWithKeys } from './validation.js';
import { references, shortText } from './acceptance.js';

export type Deliverable = { id: string; description: string; path: string; check: string; scenarios: string[]; decisions: string[]; dependsOn: string[] };
export type Check = { command: string; exit: number | null };

export function deliverables(value: unknown): Deliverable[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Planning requires 1–32 explicit deliverables.');
  const ids = new Set<string>();
  return value.map(item => {
    const entry = objectWithKeys(item, 'deliverable', ['id', 'description', 'path', 'check', 'scenarios', 'decisions', 'dependsOn']);
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id)) throw new Error(`Deliverable id ${JSON.stringify(String(entry.id).slice(0, 64))} must be a stable short identifier of 1–64 letters, digits, underscores or hyphens.`);
    if (ids.has(entry.id)) throw new Error(`Deliverable id ${entry.id} is used more than once.`);
    ids.add(entry.id);
    return { id: entry.id, description: shortText(entry.description, `description of deliverable ${entry.id}`),
      path: shortText(entry.path, `implementation target of deliverable ${entry.id}`, 400), check: shortText(entry.check, `planned check command of deliverable ${entry.id}`, 500),
      scenarios: references(entry.scenarios, `scenarios of deliverable ${entry.id}`), decisions: references(Object.hasOwn(entry, 'decisions') ? entry.decisions : [], `decisions of deliverable ${entry.id}`, true), dependsOn: references(Object.hasOwn(entry, 'dependsOn') ? entry.dependsOn : [], `dependencies of deliverable ${entry.id}`, true) };
  });
}

/**
 * Executed checks as the actor reports them. MDD records the claim and shows it as a claim; it
 * neither re-runs the command nor presents an exit code as proof of behaviour.
 */
export function executed(value: unknown): Check[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error('Report executed checks as a list of at most 32 entries.');
  return value.map(item => {
    const entry = objectWithKeys(item, 'executed check', ['command', 'exit']);
    const exit = entry.exit ?? null;
    if (exit !== null && !Number.isInteger(exit)) throw new Error('An executed check reports an integer exit code, or null when it did not finish.');
    return { command: shortText(entry.command, 'executed command', 500), exit: exit as number | null };
  });
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
