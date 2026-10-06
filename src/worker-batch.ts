import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { objectWithKeys } from './validation.js';
import type { Deliverable } from './phase-evidence.js';

/** Missing attestation or arrays are valid incomplete data, never proof of independence. */
export type ParallelScope = { complete?: boolean; reads?: string[]; writes?: string[] };
/** A local read target is a narrowing declaration, not a permission grant. */
export type ReadTarget = { root: string; files: string[] };
export type ExplorationWorkItem = { id: string; purpose: string; dependsOn?: string[];
  independent?: boolean; complete?: boolean; reads?: ReadTarget[] };

export function explorationItems(value: unknown): ExplorationWorkItem[] {
  if (!Array.isArray(value) || value.length > 2) throw new Error('Exploration requires at most two explicit work items.');
  return value.map(value => {
    const item = objectWithKeys(value, 'exploration work item', ['id', 'purpose', 'dependsOn', 'independent', 'complete', 'reads']);
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id) ||
        typeof item.purpose !== 'string' || !item.purpose.trim() || Buffer.byteLength(item.purpose) > 2000)
      throw new Error('Exploration work items need distinct IDs and explicit purposes.');
    for (const key of ['complete', 'independent']) if (item[key] !== undefined && typeof item[key] !== 'boolean')
      throw new Error('Exploration declarations must be booleans.');
    if (item.dependsOn !== undefined && (!Array.isArray(item.dependsOn) || item.dependsOn.length > 2 ||
        item.dependsOn.some(id => typeof id !== 'string'))) throw new Error('Invalid exploration dependencies.');
    if (item.reads !== undefined) {
      if (!Array.isArray(item.reads) || !item.reads.length || item.reads.length > 8) throw new Error('Invalid exploration read targets.');
      item.reads = item.reads.map(value => {
        const target = objectWithKeys(value, 'local read target', ['root', 'files']);
        if (typeof target.root !== 'string' || !isAbsolute(target.root) || target.root.length > 2048 ||
            /^[\\/]{2}|[\x00-\x1f]|:\/\//.test(target.root) || !Array.isArray(target.files) ||
            !target.files.length || target.files.length > 64) throw new Error('Read targets require a local absolute root and exact file paths.');
        return { root: target.root, files: target.files.map(scopePath) };
      });
    }
    return structuredClone(item) as ExplorationWorkItem;
  });
}

/** Revalidate before every read. No aliases, directories, hard links or newly missing files. */
export function explorationFiles(targets: readonly ReadTarget[]): string[] {
  const files: string[] = [];
  for (const target of targets) {
    const root = resolve(target.root);
    if (realpathSync(root) !== root || lstatSync(root).isSymbolicLink()) throw new Error('Read root is aliased.');
    for (const file of target.files) {
      const path = resolve(root, scopePath(file));
      if (!exactFiles(root, { complete: true, reads: [file], writes: [] }) || !lstatSync(path).isFile())
        throw new Error('Read target is not an exact existing file.');
      files.push(path);
    }
  }
  if (new Set(files.map(file => file.toLowerCase())).size !== files.length) throw new Error('Read targets repeat aliases.');
  return files;
}

export function independentExploration(value: readonly ExplorationWorkItem[]): boolean {
  try {
    const items = explorationItems(value);
    if (items.length !== 2 || new Set(items.map(item => item.id)).size !== 2 ||
        new Set(items.map(item => item.purpose.trim())).size !== 2) return false;
    return items.every(item => item.complete === true && item.independent === true && item.dependsOn?.length === 0 &&
      !!item.reads && explorationFiles(item.reads).length > 0);
  } catch { return false; }
}
type CompleteScope = { complete: true; reads: string[]; writes: string[] };

export function scopePath(value: unknown): string {
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
export function exactFiles(root: string, scope: CompleteScope): boolean {
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

/** Runtime/bootstrap inputs have implicit readers and side effects, not a proven file footprint. */
export function safeApplyWrite(path: string): boolean {
  return !path.split('/').some(part => part.startsWith('.') || /^(?:AGENTS\.md|CLAUDE\.md|GEMINI\.md|node_modules|vendor)$/i.test(part)) &&
    !/(?:^|\/)(?:package(?:-lock)?\.json|[^/]*lock(?:file)?|[^/]*config[^/]*|[^/]*instructions?[^/]*)$/i.test(path) &&
    !/\.(?:json[cl]?|ya?ml|toml|ini|lock|env)$/i.test(path);
}

/** Unknown bootstrap references/effects are serial, even when declared filenames are disjoint. */
function safeApplyBootstrap(root: string, writes: string[]): boolean {
  try {
    for (const name of ['plugins', 'plugin']) {
      const path = join(root, '.opencode', name);
      if (lstatSync(path, { throwIfNoEntry: false })) return false;
    }
    const files = new Set<string>();
    const add = (dir: string) => { for (const name of ['opencode.json', 'opencode.jsonc']) files.add(join(dir, name)); };
    add(join(homedir(), '.config', 'opencode'));
    if (process.env.XDG_CONFIG_HOME) add(join(process.env.XDG_CONFIG_HOME, 'opencode'));
    if (process.env.OPENCODE_CONFIG_DIR) add(resolve(process.env.OPENCODE_CONFIG_DIR));
    if (process.env.OPENCODE_CONFIG) {
      if (!isAbsolute(process.env.OPENCODE_CONFIG)) return false;
      files.add(process.env.OPENCODE_CONFIG);
    }
    for (let dir = resolve(root); ; dir = dirname(dir)) {
      add(dir); add(join(dir, '.opencode'));
      if (dirname(dir) === dir) break;
    }
    const known = (value: unknown, base: string): boolean => {
      if (typeof value === 'string') {
        if (/\{(?:file|env):|^file:|[\x00-\x1f]/.test(value)) return false;
        if (!value || /^[*?]+$/.test(value)) return true; // Generic policy values, not local path declarations.
        // Treat local path/glob-like config values conservatively; bootstrap may import or read them.
        const candidate = resolve(base, value.replace(/\\/g, '/').split(/[*?]/)[0]!).replace(/\\/g, '/');
        return !writes.some(path => overlap(path.replace(/\\/g, '/'), candidate) ||
          value.replace(/\\/g, '/').toLowerCase().includes(relative(root, path).replace(/\\/g, '/').toLowerCase()));
      }
      if (Array.isArray(value)) return value.every(item => known(item, base));
      if (value && typeof value === 'object') return Object.entries(value).every(([key, item]) =>
        key !== 'instructions' && known(item, base));
      return true;
    };
    if (process.env.OPENCODE_CONFIG_CONTENT && !known(JSON.parse(process.env.OPENCODE_CONFIG_CONTENT), root)) return false;
    for (const file of files) {
      const stat = lstatSync(file, { throwIfNoEntry: false });
      if (!stat) continue;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 * 1024 ||
          writes.some(path => overlap(path.replace(/\\/g, '/'), resolve(file).replace(/\\/g, '/')))) return false;
      // Opaque JSONC/substitution/custom bootstrap falls back rather than inventing implicit reads.
      if (!known(JSON.parse(readFileSync(file, 'utf8')), dirname(file))) return false;
    }
    return true;
  } catch { return false; }
}

/** Used only by production scoped editing; legacy synthetic hosts keep their existing semantics. */
export function applyScopeFiles(root: string, scope: ParallelScope | undefined): { reads: string[]; writes: string[] } {
  const complete = completeScope(scope);
  if (!complete || !complete.writes.length || realpathSync(root) !== resolve(root) ||
      !complete.writes.every(safeApplyWrite) || !exactFiles(root, complete) ||
      !safeApplyBootstrap(root, complete.writes.map(path => resolve(root, path))))
    throw new Error('Apply scope has unproven paths or implicit runtime/instruction effects; use serial execution.');
  return { reads: [...new Set([...complete.reads, ...complete.writes])].map(path => resolve(root, path)),
    writes: complete.writes.map(path => resolve(root, path)) };
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
