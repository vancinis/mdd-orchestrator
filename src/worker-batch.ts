import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { objectWithKeys } from './validation.js';
import type { Deliverable } from './phase-evidence.js';

/** Missing attestation or arrays are valid incomplete data, never proof of independence. */
export type ParallelScope = { complete?: boolean; reads?: string[]; writes?: string[] };
type CompleteScope = { complete: true; reads: string[]; writes: string[] };

function scopePath(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 400 ||
      /[^\x20-\x7e]|[\\:*?"<>|\[\]{}~]/.test(value) || value.split('/').some(part =>
        !part || part === '.' || part === '..' || part.trim() !== part || part.endsWith('.') ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Parallel scope requires canonical exact root-relative file paths, not directories, aliases or globs.');
  }
  return value;
}

/** Syntax validation is strict even when the footprint will not qualify for parallel work. */
export function parseParallelScope(value: unknown): ParallelScope {
  const entry = objectWithKeys(value, 'parallel scope', ['complete', 'reads', 'writes']);
  const result: ParallelScope = {};
  if (Object.hasOwn(entry, 'complete')) {
    if (typeof entry.complete !== 'boolean') throw new Error('Parallel scope complete must be a boolean.');
    result.complete = entry.complete;
  }
  for (const key of ['reads', 'writes'] as const) {
    if (!Object.hasOwn(entry, key)) continue;
    const paths = entry[key];
    if (!Array.isArray(paths) || paths.length > 64) throw new Error(`Parallel scope ${key} requires 0–64 file paths.`);
    const parsed = Array.from(paths, scopePath);
    if (new Set(parsed.map(path => path.toLowerCase())).size !== parsed.length) throw new Error(`Parallel scope ${key} repeats a path or case alias.`);
    result[key] = parsed;
  }
  return result;
}

function overlap(a: string, b: string): boolean {
  a = a.toLowerCase(); b = b.toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function ambiguousCase(paths: string[]): boolean {
  const spellings = new Map<string, string>();
  for (const path of paths) {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join('/');
      const key = prefix.toLowerCase();
      if (spellings.has(key) && spellings.get(key) !== prefix) return true;
      spellings.set(key, prefix);
    }
  }
  return false;
}

function completeScope(value: unknown): CompleteScope | undefined {
  try {
    const parsed = parseParallelScope(value);
    if (parsed.complete !== true || !parsed.reads || !parsed.writes) return undefined;
    const paths = [...parsed.reads, ...parsed.writes];
    if (ambiguousCase(paths) || paths.some((path, index) => paths.slice(index + 1).some(other =>
      path !== other && overlap(path, other)))) return undefined;
    return parsed as CompleteScope;
  } catch { return undefined; }
}

/** Pure conflict check; shared reads are safe. Unknown footprints always conflict. */
export function scopesConflict(a: unknown, b: unknown): boolean {
  const left = completeScope(a); const right = completeScope(b);
  if (!left || !right || ambiguousCase([...left.reads, ...left.writes, ...right.reads, ...right.writes])) return true;
  return left.writes.some(path => [...right.reads, ...right.writes].some(other => overlap(path, other))) ||
    right.writes.some(path => left.reads.some(other => overlap(path, other)));
}

/** Read-only filesystem snapshot, not an edit fence. Reject aliases rather than resolving them. */
function exactFiles(root: string, scope: CompleteScope): boolean {
  try {
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) return false;
    const canonicalRoot = realpathSync(root);
    for (const path of [...scope.reads, ...scope.writes]) {
      let current = canonicalRoot;
      const parts = path.split('/');
      for (const [index, part] of parts.entries()) {
        const names = readdirSync(current);
        const matches = names.filter(name => name.toLowerCase() === part.toLowerCase());
        if (!matches.length) break; // Remaining components are new, below a verified real parent.
        if (matches.length !== 1 || matches[0] !== part) return false;
        current = join(current, part);
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || realpathSync(current) !== current) return false;
        if (index === parts.length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) return false;
      }
    }
    return true;
  } catch { return false; }
}

/**
 * Select at most two Apply candidates, never dispatch them. Consume a validated/normalized plan;
 * the parser drops opt-in metadata when dependsOn was omitted. Recheck graph/completion claims
 * here because persisted data can be damaged. Completed IDs must include their prerequisites.
 */
export function selectWorkerBatch(root: string, planned: readonly Deliverable[], completed: readonly string[]): Deliverable[] {
  if (!Array.isArray(planned) || !planned.length || planned.length > 32 || !Array.isArray(completed)) return [];
  const previous = new Set<string>();
  for (const item of planned) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) || previous.has(item.id) ||
        !Array.isArray(item.dependsOn) || new Set(item.dependsOn).size !== item.dependsOn.length) return [];
    for (const dependency of item.dependsOn) if (!previous.has(dependency)) return [];
    previous.add(item.id);
  }
  const done = new Set(completed);
  if (done.size !== completed.length) return [];
  for (const id of completed) if (!previous.has(id)) return [];
  if (planned.some(item => done.has(item.id) && item.dependsOn.some((id: string) => !done.has(id)))) return [];
  const ready = planned.filter(item => !done.has(item.id) && item.dependsOn.every((id: string) => done.has(id)));
  const first = ready[0];
  if (!first) return [];
  const eligible = (item: Deliverable): boolean => {
    const scope = completeScope(item.parallel);
    return !!scope && scope.writes.length > 0 && typeof root === 'string' && exactFiles(resolve(root), scope);
  };
  if (!eligible(first)) return [first];
  const second = ready.slice(1).find(item => eligible(item) && !scopesConflict(first.parallel, item.parallel));
  return second ? [first, second] : [first];
}
