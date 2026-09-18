import fs from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export class LocalFileError extends Error {
  constructor() { super('Local storage unavailable or unsafe. Check project permissions and local file types.'); }
}

type LocalName = 'mdd.config.json' | 'mdd/setup-assets.json' | '.mdd/.gitignore' | '.mdd/telemetry.jsonl' | `.mdd/progress-${string}.json` | `.mdd/run-${string}.json`;

/**
 * A lock is only a cooperation hint between concurrent writers; atomicity comes from the
 * temp-file-plus-rename below, which needs no lock at all. That matters because a `wx` lock is
 * removed only by the `finally` of the process that took it: a process killed mid-write leaves
 * the file behind and every later write to that name fails with EEXIST permanently. Reclaiming a
 * lock nothing has touched for this long restores writes instead of sealing the file forever. No
 * write here copies more than a few hundred kilobytes, so a minute cannot be a live writer.
 */
const STALE_LOCK_MS = 60000;
function lock(path: string): number {
  try { return fs.openSync(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    // Only a plain, unlinked, genuinely old lock is reclaimable. A live writer keeps its slot.
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
        Date.now() - stat.mtimeMs < STALE_LOCK_MS) throw new LocalFileError();
    fs.unlinkSync(path);
    return fs.openSync(path, 'wx', 0o600);
  }
}

function regular(path: string): boolean {
  const stat = fs.lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new LocalFileError();
  return true;
}

function directory(path: string): void {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalFileError();
  }
}

/** Fixed destinations only. Refuses links; no filesystem writes during construction. */
export class LocalFiles {
  readonly #root: string;
  constructor(root: string) { this.#root = resolve(root); }

  #path(name: LocalName, create: boolean): string {
    if (name !== 'mdd.config.json' && name !== 'mdd/setup-assets.json' && name !== '.mdd/.gitignore' && name !== '.mdd/telemetry.jsonl' &&
        !/^\.mdd\/progress-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/run-[a-f0-9]{64}(\.discarded)?\.json$/.test(name)) throw new LocalFileError();
    directory(this.#root);
    const path = join(this.#root, name);
    const parent = dirname(path);
    if (parent !== this.#root) {
      if (!fs.lstatSync(parent, { throwIfNoEntry: false })) {
        if (!create) return path;
        fs.mkdirSync(parent, { mode: 0o700 });
      }
      directory(parent);
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
      const buffer = Buffer.alloc(limit + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > limit) throw new LocalFileError();
      return buffer.subarray(0, size).toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  remove(name: LocalName): void {
    const path = this.#path(name, false);
    if (!regular(path)) return;
    const guard = `${path}.lock`;
    const fd = lock(guard);
    try {
      if (regular(this.#path(name, false))) fs.unlinkSync(path);
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(guard);
    }
  }

  /** Locks cooperating writers. A failed replacement leaves the previous file intact. */
  update(name: LocalName, change: (previous: string | undefined) => string | undefined, limit: number): void {
    if (name.startsWith('.mdd/') && name !== '.mdd/.gitignore' && this.read('.mdd/.gitignore', 65536) === undefined) {
      this.update('.mdd/.gitignore', previous => previous ?? '*\n', 65536);
    }
    const path = this.#path(name, true);
    const guard = `${path}.lock`;
    const lockFD = lock(guard);
    let temporary: string | undefined;
    try {
      const next = change(this.read(name, limit));
      if (next === undefined) {
        if (regular(this.#path(name, false))) fs.unlinkSync(path);
        return;
      }
      if (Buffer.byteLength(next) > limit) throw new LocalFileError();
      temporary = `${path}.${randomUUID()}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, next, 'utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      this.#path(name, false);
      fs.renameSync(temporary, path);
      temporary = undefined;
    } finally {
      if (temporary && regular(temporary)) fs.unlinkSync(temporary);
      fs.closeSync(lockFD);
      fs.unlinkSync(guard);
    }
  }
}
