import fs from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export class LocalFileError extends Error {
  constructor() { super('Local storage unavailable or unsafe. Check permissions and file types.'); }
}

/** The only files MDD writes through this class: the global settings and the install ledger. */
export const LOCAL_NAMES = Object.freeze(['mdd.config.json', 'mdd/setup-assets.json'] as const);
export type LocalName = typeof LOCAL_NAMES[number];

/**
 * A lock left by a writer that crashed is taken over after this long. Writes here are a single
 * small JSON file from an interactive CLI, so a minute is far longer than any real write.
 */
export const STALE_LOCK_MS = 60000;
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Synchronous backoff: every caller here is already synchronous, and waits are milliseconds. */
function pause(ms: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

/**
 * Windows reports a file briefly held by an indexer, antivirus or a concurrent reader as EPERM,
 * EACCES or EBUSY. Those are retried a bounded number of times; anything else fails at once.
 */
export function retryTransient<T>(work: () => T, attempts = 6): T {
  for (let attempt = 1; ; attempt++) {
    try { return work(); }
    catch (error) {
      if (attempt >= attempts || !TRANSIENT.has(String((error as NodeJS.ErrnoException).code))) throw error;
      pause(5 * 2 ** attempt);
    }
  }
}

/** True for an existing regular file; throws for links, hardlinks and anything that is not a file. */
function regular(path: string): boolean {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new LocalFileError();
  return true;
}

/** Every component of an existing directory path must be a real directory, never a link. */
function realDirectory(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalFileError();
  }
}

function acquire(lock: string): number {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt) throw new LocalFileError();
      const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
      if (stat && (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs < STALE_LOCK_MS)) throw new LocalFileError();
      try { fs.rmSync(lock, { force: true }); } catch { throw new LocalFileError(); }
    }
  }
  throw new LocalFileError();
}

/**
 * Reads and atomically replaces a fixed set of files under one root. Writes go to a temporary file
 * that is renamed over the target, so a reader sees the old or the new content, never a torn one,
 * and a failed write leaves the previous file intact. Links are refused.
 */
export class LocalFiles {
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }

  #path(name: LocalName, create: boolean): string {
    if (!LOCAL_NAMES.includes(name)) throw new LocalFileError();
    realDirectory(this.#root);
    const path = join(this.#root, name);
    let current = this.#root;
    for (const part of relative(this.#root, dirname(path)).split(sep).filter(Boolean)) {
      current = join(current, part);
      if (!fs.lstatSync(current, { throwIfNoEntry: false })) {
        if (!create) return path;
        fs.mkdirSync(current, { mode: 0o700 });
      }
      realDirectory(current);
    }
    regular(path);
    return path;
  }

  read(name: LocalName, limit: number): string | undefined {
    const path = this.#path(name, false);
    if (!regular(path)) return undefined;
    const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new LocalFileError();
      const bytes = fs.readFileSync(fd);
      if (bytes.length > limit) throw new LocalFileError();
      return bytes.toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  /** Replaces the file with `change(previous)` under a lock; `undefined` removes it. */
  update(name: LocalName, change: (previous: string | undefined) => string | undefined, limit: number): void {
    const path = this.#path(name, true);
    const lock = `${path}.lock`;
    const fd = acquire(lock);
    let temporary: string | undefined;
    try {
      const next = change(retryTransient(() => this.read(name, limit)));
      if (next === undefined) {
        if (regular(path)) retryTransient(() => fs.unlinkSync(path));
        return;
      }
      if (Buffer.byteLength(next) > limit) throw new LocalFileError();
      temporary = `${path}.${randomUUID()}.tmp`;
      const out = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(out, next, 'utf8'); fs.fsyncSync(out); }
      finally { fs.closeSync(out); }
      this.#path(name, false);
      const from = temporary;
      retryTransient(() => fs.renameSync(from, path));
      temporary = undefined;
    } finally {
      try { if (temporary && regular(temporary)) retryTransient(() => fs.unlinkSync(temporary!)); }
      finally {
        fs.closeSync(fd);
        try { retryTransient(() => fs.rmSync(lock, { force: true })); } catch { /* a leftover lock expires after STALE_LOCK_MS */ }
      }
    }
  }
}
