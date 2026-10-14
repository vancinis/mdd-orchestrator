import fs from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname, uptime } from 'node:os';

export class LocalFileError extends Error {
  constructor() { super('Local storage unavailable or unsafe. Check project permissions and local file types.'); }
}

type LocalName = 'mdd.config.json' | 'mdd/setup-assets.json' | '.mdd/.gitignore' | '.mdd/knowledge-cache.json' | '.mdd/telemetry.jsonl' | '.mdd/telemetry-rollup.json' | '.mdd/lessons.jsonl' | '.mdd/sessions.jsonl' | '.mdd/runs.jsonl' | `.mdd/progress-${string}.json` | `.mdd/run-${string}.json` | `.mdd/checkpoint-${string}.json` | `.mdd/question-${string}.json` | `.mdd/owner-${string}.json` | `.mdd/parent-owner-${string}.json` | `.mdd/intake-${string}.json` | `.mdd/preferences-${string}.json`;

/**
 * A lock is only a cooperation hint between concurrent writers; atomicity comes from the
 * temp-file-plus-rename below, which needs no lock at all. That matters because a `wx` lock is
 * removed only by the `finally` of the process that took it: a process killed mid-write leaves
 * the file behind and every later write to that name fails with EEXIST permanently.
 *
 * Every lock therefore names its holder (pid, host, platform, boot, nonce). A lock whose holder is
 * provably gone — on this machine, from a previous boot or with a pid the OS says does not exist
 * (ESRCH) — is reclaimed. Ordinary data files
 * additionally keep the age rule for unnamed legacy locks; ownership locks are never reclaimed by
 * age alone, because an old timestamp says nothing about whether the writer is still alive.
 */
const STALE_LOCK_MS = 60000;
const HOST = hostname();
/**
 * WSL and Windows can share one hostname and one repository, while a pid on one is meaningless
 * on the other. Platform (with WSL told apart from native Linux) and boot time pin a pid to the
 * one kernel that can answer whether it is alive.
 */
const PLATFORM = (() => {
  if (process.platform !== 'linux') return process.platform;
  try { return process.env.WSL_DISTRO_NAME || /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8')) ? 'linux-wsl' : 'linux'; }
  catch { return 'linux'; }
})();
/** Linux names each boot exactly; elsewhere boot time is derived from the monotonic uptime. */
function bootID(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() || undefined; } catch { return undefined; }
}
const BOOT_ID = bootID();
/**
 * Boot time is computed when a lock is written, not once per process, so a wall-clock correction
 * after a long-lived process started cannot make its fresh locks look like a previous boot's. Two
 * computations within one boot differ by clock jitter only.
 */
function bootTime(): number { return Math.round(Date.now() / 1000 - uptime()); }
const BOOT_TOLERANCE_SECONDS = 120;
export function lockIdentity(): { pid: number; host: string; platform: string; boot: number; bootID?: string } {
  return { pid: process.pid, host: HOST, platform: PLATFORM, boot: bootTime(), ...(BOOT_ID ? { bootID: BOOT_ID } : {}) };
}const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
type Held = { fd: number; nonce: string };

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

type LockBody = { pid: number; host: string; nonce: string; platform?: string; boot?: number; bootID?: string };
function lockBody(path: string): LockBody | undefined {
  try {
    const stat = fs.lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) return undefined;
    const body = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    return Number.isSafeInteger(body.pid) && (body.pid as number) > 0 && typeof body.host === 'string' &&
      typeof body.nonce === 'string' && body.nonce.length > 0 ? body as LockBody : undefined;
  } catch { return undefined; }
}

function dead(pid: number): boolean {
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

/**
 * Whether a holder is certainly gone. Only this machine (same host and platform) can judge; a
 * holder with an incomplete identity is never judged. On this machine, a holder from a previous
 * boot is dead whatever its pid — the pid may belong to an unrelated process now — and a holder
 * from this boot is dead only when the OS says its pid does not exist.
 */
function holderGone(holder: LockBody): boolean {
  if (holder.host !== HOST || holder.platform !== PLATFORM || typeof holder.boot !== 'number') return false;
  const current = lockIdentity();
  const sameBoot = holder.bootID && current.bootID ? holder.bootID === current.bootID
    : Math.abs(holder.boot - current.boot) <= BOOT_TOLERANCE_SECONDS;
  return !sameBoot || dead(holder.pid);
}

/**
 * The exclusive slot that grants the right to reclaim the lock (or slot) whose holder wrote
 * `nonce`. It is named for that dead holder, so a slot left behind never blocks any other lock:
 * once the dead lock is gone, nothing ever asks for that name again.
 */
export function reclaimSlot(path: string, nonce: string): string {
  return `${path}.reclaim-${createHash('sha256').update(nonce).digest('hex').slice(0, 16)}`;
}

/**
 * Reclaims a dead lock. Only the process that exclusively creates the slot named for that dead
 * holder may remove it, so the lock cannot change between the check that it is still the dead one
 * and its removal: no racing reclaimer can delete a lock a live writer has just taken. If the
 * slot itself was orphaned by a reclaimer that died, the same rule applies one level up: its
 * successor takes the slot named for the dead reclaimer. Slot removal is retried and a failure is
 * reported, never ignored.
 */
function reclaim(path: string, nonce: string): boolean {
  const owed: string[] = [];
  let holderNonce = nonce;
  let won = false;
  for (let depth = 0; depth < 8 && !won; depth++) {
    const slot = reclaimSlot(path, holderNonce);
    let fd: number;
    try { fd = fs.openSync(slot, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') break;
      const reclaimer = lockBody(slot);
      // A live (or still-writing) reclaimer owns this dead lock: back off and leave it to them.
      if (!reclaimer || !holderGone(reclaimer)) break;
      owed.push(slot);
      holderNonce = reclaimer.nonce;
      continue;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ ...lockIdentity(), nonce: randomUUID() }), 'utf8'); }
    finally { fs.closeSync(fd); }
    owed.push(slot);
    won = true;
  }
  if (!won) return false;
  let reclaimed = false;
  let failed = false;
  try {
    if (lockBody(path)?.nonce === nonce) { retryTransient(() => fs.unlinkSync(path)); reclaimed = true; }
  } catch { failed = true; }
  for (const slot of owed.reverse()) {
    try { retryTransient(() => fs.unlinkSync(slot)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failed = true; }
  }
  if (failed) throw new LocalFileError();
  return reclaimed;
}

function acquire(path: string, strict: boolean): Held {
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try { fd = fs.openSync(path, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || attempt) throw new LocalFileError();
      const holder = lockBody(path);
      if (holder && holderGone(holder)) {
        if (!reclaim(path, holder.nonce)) throw new LocalFileError();
        continue;
      }
      const stat = fs.lstatSync(path, { throwIfNoEntry: false });
      // Legacy data locks without a holder may still expire by age; ownership locks never do.
      if (strict || holder || !stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
          Date.now() - stat.mtimeMs < STALE_LOCK_MS) throw new LocalFileError();
      try { fs.unlinkSync(path); } catch { throw new LocalFileError(); }
      continue;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ ...lockIdentity(), nonce }), 'utf8'); }
    catch (error) { fs.closeSync(fd); try { fs.unlinkSync(path); } catch { /* inert */ } throw error; }
    return { fd, nonce };
  }
  throw new LocalFileError();
}

/** Removes only the lock this writer holds, retrying the transient Windows sharing errors. */
function unlock(path: string, held: Held): void {
  fs.closeSync(held.fd);
  if (lockBody(path)?.nonce !== held.nonce) return;
  try { retryTransient(() => fs.unlinkSync(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
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
    if (name !== 'mdd.config.json' && name !== 'mdd/setup-assets.json' && name !== '.mdd/.gitignore' && name !== '.mdd/telemetry.jsonl' && name !== '.mdd/telemetry-rollup.json' &&
        name !== '.mdd/lessons.jsonl' && name !== '.mdd/sessions.jsonl' && name !== '.mdd/runs.jsonl' && name !== '.mdd/knowledge-cache.json' &&
        !/^\.mdd\/progress-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/run-[a-f0-9]{64}(\.(discarded|continued))?\.json$/.test(name) && !/^\.mdd\/checkpoint-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/question-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/(?:parent-)?owner-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/intake-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/preferences-[a-f0-9]{64}\.json$/.test(name)) throw new LocalFileError();
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
      // Sized to the file, not the ceiling: one extra byte still detects growth past the limit.
      const buffer = Buffer.alloc(Math.min(limit, stat.size + 65536) + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      // Filling the buffer means the file is larger than it was when opened, or than the limit.
      if (size > limit || size === buffer.length) throw new LocalFileError();
      return buffer.subarray(0, size).toString('utf8');
    } finally { fs.closeSync(fd); }
  }

  /**
   * The live run records of every conversation in this workspace, newest first. It is the only
   * listing this class offers, and it yields only names `read` already accepts: the same fixed
   * pattern, never a discarded copy, never a link. Listing therefore reaches nothing a known
   * conversation ID did not already reach; it only removes the need to know that ID in advance.
   */
  runRecords(): { name: `.mdd/run-${string}.json`; modified: number }[] {
    directory(this.#root);
    const parent = join(this.#root, '.mdd');
    if (!fs.lstatSync(parent, { throwIfNoEntry: false })) return [];
    directory(parent);
    const records: { name: `.mdd/run-${string}.json`; modified: number }[] = [];
    for (const entry of fs.readdirSync(parent)) {
      if (!/^run-[a-f0-9]{64}\.json$/.test(entry)) continue;
      const stat = fs.lstatSync(join(parent, entry), { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue;
      records.push({ name: `.mdd/${entry}` as `.mdd/run-${string}.json`, modified: stat.mtimeMs });
    }
    return records.sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
  }

  /**
   * Ownership reads return the last committed bytes. A writer's lock does not hide them: its
   * replacement is an atomic rename, so a reader sees either the old or the new record, never a
   * torn one. Every ownership decision is still made under the writer lock by updateStrict.
   */
  readStrict(name: LocalName, limit: number): string | undefined {
    if (!/^\.mdd\/(?:parent-)?owner-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/intake-[a-f0-9]{64}\.json$/.test(name)) throw new LocalFileError();
    return retryTransient(() => this.read(name, limit));
  }

  remove(name: LocalName): void {
    const path = this.#path(name, false);
    if (!regular(path)) return;
    const guard = `${path}.lock`;
    const held = acquire(guard, false);
    try {
      if (regular(this.#path(name, false))) retryTransient(() => fs.unlinkSync(path));
    } finally { unlock(guard, held); }
  }

  /** Locks cooperating writers. A failed replacement leaves the previous file intact. */
  update(name: LocalName, change: (previous: string | undefined) => string | undefined, limit: number): void {
    this.#update(name, change, limit, false);
  }

  /** For single-writer ownership: no stale-lock timeout, no age-based takeover. */
  updateStrict(name: LocalName, change: (previous: string | undefined) => string | undefined, limit: number): void {
    if (!/^\.mdd\/(?:parent-)?owner-[a-f0-9]{64}\.json$/.test(name) && !/^\.mdd\/intake-[a-f0-9]{64}\.json$/.test(name)) throw new LocalFileError();
    this.#update(name, change, limit, true);
  }

  #update(name: LocalName, change: (previous: string | undefined) => string | undefined, limit: number, strict: boolean): void {
    if (name.startsWith('.mdd/') && name !== '.mdd/.gitignore' && this.read('.mdd/.gitignore', 65536) === undefined) {
      this.update('.mdd/.gitignore', previous => previous ?? '*\n', 65536);
    }
    const path = this.#path(name, true);
    const guard = `${path}.lock`;
    const held = acquire(guard, strict);
    let temporary: string | undefined;
    try {
      const next = change(retryTransient(() => this.read(name, limit)));
      if (next === undefined) {
        if (regular(this.#path(name, false))) retryTransient(() => fs.unlinkSync(path));
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
      const from = temporary;
      retryTransient(() => fs.renameSync(from, path));
      temporary = undefined;
    } finally {
      try { if (temporary && regular(temporary)) retryTransient(() => fs.unlinkSync(temporary!)); }
      finally { unlock(guard, held); }
    }
  }
}
