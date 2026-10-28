import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
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
            !target.files.length) throw new Error('Read targets require a local absolute root and exact file paths.');
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
    if (!Array.isArray(paths)) throw new Error(`Parallel scope ${key} requires a list of file paths.`);
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

/** A configuration file is inspected whole; past this size it is reported rather than parsed. */
const CONFIG_INSPECTION_BYTES = 4 * 1024 * 1024;
const slashes = (path: string) => path.replace(/\\/g, '/');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Glob as OpenCode instruction patterns use it: `**` crosses directories, `*` and `?` do not. */
function globMatcher(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*' && pattern[index + 1] === '*') {
      index++;
      if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?'; } else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      const end = pattern.indexOf('}', index);
      if (end < 0) { source += '\\{'; continue; }
      source += `(?:${pattern.slice(index + 1, end).split(',').map(escapeRegExp).join('|')})`;
      index = end;
    } else source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, 'i');
}

/**
 * Why OpenCode's own configuration could read or run a declared write, or undefined when it
 * provably cannot. Agent prompts, descriptions and other prose are not file references: only
 * `{file:…}` substitutions, `{env:…}` values, `file:` URLs, path-like values and `instructions`
 * patterns are, and each is resolved and compared with the writes. Reasons name the file, the
 * JSON location and the write, never a configuration value, so a token cannot leak through them.
 */
function bootstrapIssue(root: string, writes: string[]): string | undefined {
  for (const name of ['plugins', 'plugin']) {
    if (lstatSync(join(root, '.opencode', name), { throwIfNoEntry: false }))
      return `project plugins in .opencode/${name} can read or run any file, so no write footprint is provable there`;
  }
  const home = homedir();
  const label = (file: string) => { const relativeHome = relative(home, file); return relativeHome && !relativeHome.startsWith('..') && !isAbsolute(relativeHome) ? `~/${slashes(relativeHome)}` : slashes(file); };
  const targets = writes.map(path => ({ absolute: slashes(path).toLowerCase(), name: slashes(relative(root, path)) }));
  const hit = (candidate: string) => targets.find(target => overlap(target.absolute, slashes(candidate).toLowerCase()));
  const named = (value: string) => targets.find(target => new RegExp(`(?:^|[/\\s"'(=:])${escapeRegExp(target.name.toLowerCase())}(?:$|[\\s"'),;])`)
    .test(slashes(value).toLowerCase()));
  const local = (reference: string, base: string) => resolve(base, reference.startsWith('~/') ? join(home, reference.slice(2)) : reference);
  const text = (value: string, base: string, at: string, substitutions = true): string | undefined => {
    if (substitutions) {
      for (const match of value.matchAll(/\{file:([^}]*)\}/g)) {
        const reference = match[1]!.trim();
        if (!reference) return `${at} has an empty {file:} substitution`;
        const target = hit(local(reference, base));
        if (target) return `${at} reads the write ${target.name} through a {file:} substitution`;
      }
      // An environment value is substituted once, as text; it is not expanded again.
      for (const match of value.matchAll(/\{env:([^}]*)\}/g)) {
        const issue = text(process.env[match[1]!.trim()] ?? '', base, `${at} {env:${match[1]!.trim()}}`, false);
        if (issue) return issue;
      }
    }
    const rest = (substitutions ? value.replace(/\{(?:file|env):[^}]*\}/g, '') : value).trim();
    if (!rest || /^[*?]+$/.test(rest)) return undefined;
    if (/[\x00-\x1f]/.test(rest)) {
      // Prose (prompts, descriptions, multi-line text) is not a path declaration. A multi-line value
      // of something the host executes (an MCP, formatter or LSP server) still runs what it names.
      const target = /\.(?:mcp|formatter|lsp)\./i.test(at) ? named(rest) : undefined;
      return target ? `${at} runs a command that names the write ${target.name}` : undefined;
    }
    if (/^file:/i.test(rest)) {
      let path: string;
      try { path = rest.startsWith('file://') ? fileURLToPath(rest) : local(rest.slice(5), base); }
      catch { return `${at} is a file: URL that cannot be resolved`; }
      const target = hit(path);
      return target ? `${at} loads the write ${target.name} as a file: URL` : undefined;
    }
    const target = hit(local(slashes(rest).split(/[*?]/)[0]!, base)) ?? named(rest);
    return target ? `${at} names the write ${target.name}` : undefined;
  };
  const instructions = (value: unknown, base: string, at: string): string | undefined => {
    const patterns = Array.isArray(value) ? value : [value];
    for (const [index, pattern] of patterns.entries()) {
      const where = Array.isArray(value) ? `${at}[${index}]` : at;
      if (typeof pattern !== 'string') return `${where} is not an instruction path`;
      if (/^https?:\/\//i.test(pattern.trim())) continue;
      // Substitutions are checked as anywhere else; the pattern itself is matched, not prefixed.
      if (/\{(?:file|env):/.test(pattern)) {
        const issue = text(pattern.match(/\{(?:file|env):[^}]*\}/g)!.join(''), base, where);
        if (issue) return issue;
      }
      const plain = pattern.replace(/\{(?:file|env):[^}]*\}/g, '').trim();
      if (!plain) continue;
      for (const scopeBase of new Set([base, root])) {
        const matcher = globMatcher(slashes(local(plain, scopeBase)));
        const target = targets.find(target => matcher.test(target.absolute));
        if (target) return `${where} loads the write ${target.name} as agent instructions`;
      }
    }
    return undefined;
  };
  const visit = (value: unknown, base: string, at: string): string | undefined => {
    if (typeof value === 'string') return text(value, base, at);
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) { const issue = visit(item, base, `${at}[${index}]`); if (issue) return issue; }
      return undefined;
    }
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      const issue = key === 'instructions' ? instructions(item, base, `${at}.${key}`) : visit(item, base, `${at}.${key}`);
      if (issue) return issue;
    }
    return undefined;
  };
  const files = new Set<string>();
  const add = (dir: string) => { for (const name of ['opencode.json', 'opencode.jsonc']) files.add(join(dir, name)); };
  add(join(home, '.config', 'opencode'));
  if (process.env.XDG_CONFIG_HOME) add(join(process.env.XDG_CONFIG_HOME, 'opencode'));
  if (process.env.OPENCODE_CONFIG_DIR) add(resolve(process.env.OPENCODE_CONFIG_DIR));
  if (process.env.OPENCODE_CONFIG) {
    if (!isAbsolute(process.env.OPENCODE_CONFIG)) return 'OPENCODE_CONFIG is a relative path, so the configuration it loads cannot be located';
    files.add(process.env.OPENCODE_CONFIG);
  }
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    add(dir); add(join(dir, '.opencode'));
    if (dirname(dir) === dir) break;
  }
  if (process.env.OPENCODE_CONFIG_CONTENT) {
    let parsed: unknown;
    try { parsed = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); }
    catch { return 'OPENCODE_CONFIG_CONTENT is not plain JSON, so its file references cannot be inspected'; }
    const issue = visit(parsed, root, '$');
    if (issue) return `OPENCODE_CONFIG_CONTENT: ${issue}`;
  }
  for (const file of files) {
    let stat;
    try { stat = lstatSync(file, { throwIfNoEntry: false }); } catch { return `${label(file)} cannot be inspected`; }
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return `${label(file)} is a link or not a plain regular file`;
    if (stat.size > CONFIG_INSPECTION_BYTES) return `${label(file)} exceeds the ${CONFIG_INSPECTION_BYTES / 1024 / 1024} MiB configuration inspection budget`;
    const own = hit(resolve(file));
    if (own) return `the write ${own.name} is the OpenCode configuration ${label(file)}`;
    let parsed: unknown;
    // JSONC comments, trailing commas and unreadable bytes cannot be inspected: report, never guess.
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); }
    catch { return `${label(file)} is not plain JSON (comments or trailing commas), so its file references cannot be inspected`; }
    const issue = visit(parsed, dirname(file), '$');
    if (issue) return `${label(file)}: ${issue}`;
  }
  return undefined;
}

/**
 * Why a declared Apply footprint cannot be proven, or undefined when it can. The reason is
 * actionable: it names the path, write or configuration location that prevents the proof.
 */
export function applyScopeIssue(root: string, scope: ParallelScope | undefined): string | undefined {
  const complete = completeScope(scope);
  if (!complete) return 'the scope is not a complete exact read/write footprint, or two of its paths overlap or differ only by case';
  if (!complete.writes.length) return 'the scope declares no writes';
  if (realpathSync(root) !== resolve(root)) return 'the workspace root is reached through a link or alias';
  const unsafe = complete.writes.find(path => !safeApplyWrite(path));
  if (unsafe !== undefined) return `the write ${unsafe} is a hidden, dependency, lock, configuration or agent-instruction file that the runtime reads implicitly`;
  const aliased = [...complete.reads, ...complete.writes].find(path => !exactFiles(root, { complete: true, reads: [path], writes: [] }));
  if (aliased !== undefined) return `the path ${aliased} is a link, an alias, a case variant or not a regular file`;
  return bootstrapIssue(root, complete.writes.map(path => resolve(root, path)));
}

export const APPLY_SCOPE_UNPROVEN = 'Apply scope has unproven paths or implicit runtime/instruction effects';

/** Used only by production scoped editing; legacy synthetic hosts keep their existing semantics. */
export function applyScopeFiles(root: string, scope: ParallelScope | undefined): { reads: string[]; writes: string[] } {
  const issue = applyScopeIssue(root, scope);
  if (issue !== undefined) throw new Error(`${APPLY_SCOPE_UNPROVEN}: ${issue}. Correct the declared scope or that reference; a fixed run falls back to serial execution.`);
  const complete = completeScope(scope)!;
  return { reads: [...new Set([...complete.reads, ...complete.writes])].map(path => resolve(root, path)),
    writes: complete.writes.map(path => resolve(root, path)) };
}

/**
 * Select at most two Apply candidates, never dispatch them. Consume a validated/normalized plan;
 * the parser drops opt-in metadata when dependsOn was omitted. Recheck graph/completion claims
 * here because persisted data can be damaged. Completed IDs must include their prerequisites.
 */
export function selectWorkerBatch(root: string, planned: readonly Deliverable[], completed: readonly string[]): Deliverable[] {
  if (!Array.isArray(planned) || !planned.length || !Array.isArray(completed)) return [];
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
