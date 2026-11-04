import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { hostname as osHostname } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { retryTransient } from './local-files.js';
import { scopedPath } from './safe-paths.js';
import { parseReleaseTag } from './versions.js';

// Durable storage for the version manager: state.json, the owner lock, the switch journal and
// backup sets. Everything lives under the MDD-owned root (`<opencode>/mdd`). Recovery decisions
// belong to the switch; this module only stores, validates and prunes.

export type StoreErrorCode = 'busy' | 'unsafe' | 'corrupt' | 'backup' | 'lock-lost';

export class VersionStoreError extends Error {
  constructor(readonly code: StoreErrorCode, message: string) { super(message); this.name = 'VersionStoreError'; }
}

export interface Identity { kind: 'release' | 'dev'; version: string; commit: string }

export const STORE_FILE_MAX = 1024 * 1024;
export const BACKUP_FILE_MAX = 1024 * 1024;
export const BACKUPS_KEPT = 10;
/** An unreadable or empty lock is taken over only after it has been untouched this long. */
export const UNREADABLE_LOCK_MS = 30000;

export function versionPaths(ownedRoot: string) {
  const root = resolve(ownedRoot);
  const versionsRoot = join(root, 'versions');
  return Object.freeze({
    ownedRoot: root,
    versionsRoot,
    statePath: join(versionsRoot, 'state.json'),
    lockPath: join(versionsRoot, 'lock.json'),
    journalPath: join(versionsRoot, 'journal.json'),
    txRoot: join(versionsRoot, 'tx'),
    backupsRoot: join(root, 'backups'),
  });
}
export type VersionPaths = ReturnType<typeof versionPaths>;

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const codeOf = (error: unknown): string => String((error as NodeJS.ErrnoException)?.code);

// ---------------------------------------------------------------- identity

/** Identities match when kind, version and commit are equal. */
export function sameIdentity(a: Identity | null | undefined, b: Identity | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.kind === b.kind && a.version === b.version && a.commit === b.commit;
}

/** Backup-directory label: a release uses its version, dev uses `dev-<commit7>`, no source uses `none`. */
export function identityLabel(identity: Identity | null | undefined): string {
  if (!identity) return 'none';
  if (!/^[0-9a-f]{7,64}$/.test(identity.commit)) throw new VersionStoreError('corrupt', 'Invalid commit in version identity.');
  if (identity.kind === 'dev') return `dev-${identity.commit.slice(0, 7)}`;
  const parsed = identity.kind === 'release' ? parseReleaseTag(identity.version) : undefined;
  if (!parsed || parsed.text !== identity.version) throw new VersionStoreError('corrupt', 'Invalid release version in identity.');
  return parsed.text;
}

function parseIdentity(value: unknown): Identity | null {
  if (value === null) return null;
  if (!isRecord(value) || (value.kind !== 'release' && value.kind !== 'dev') || typeof value.version !== 'string' || typeof value.commit !== 'string') {
    throw new VersionStoreError('corrupt', 'Invalid version identity.');
  }
  const identity: Identity = { kind: value.kind, version: value.version, commit: value.commit };
  identityLabel(identity);
  return identity;
}

// ---------------------------------------------------------------- safe file helpers

function ensureDirectory(root: string, directory: string): void {
  const base = resolve(root);
  const target = resolve(directory);
  const parts = target.slice(base.length).split(/[\\/]/).filter(Boolean);
  let current = base;
  if (!fs.lstatSync(base, { throwIfNoEntry: false })) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const part of parts) {
    current = join(current, part);
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) fs.mkdirSync(current, { mode: 0o700 });
    scopedPath(root, current, true);
  }
}

function safe<T>(work: () => T): T {
  try { return work(); }
  catch (error) {
    if (error instanceof VersionStoreError) throw error;
    if (error instanceof Error && /scoped|outside the approved|Linked or nonregular|Invalid scoped/.test(error.message)) throw new VersionStoreError('unsafe', `Ruta insegura en el almacén de versiones: ${error.message}`);
    throw error;
  }
}

/** Reads a regular file below `root` (no links, no hardlinks) with a size cap; `undefined` when absent. */
function readBounded(root: string, path: string, limit: number): Buffer | undefined {
  return safe(() => {
    const checked = scopedPath(root, path);
    if (!fs.existsSync(checked)) return undefined;
    const fd = fs.openSync(checked, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new VersionStoreError('unsafe', `Archivo inseguro o demasiado grande: ${basename(path)}`);
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  });
}

/** Temp file in the same directory, fsync, then rename: a reader sees the old or the new content. */
function writeAtomic(root: string, path: string, data: Buffer | string): void {
  safe(() => {
    ensureDirectory(root, dirname(path));
    const target = scopedPath(root, path);
    const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      scopedPath(root, target);
      retryTransient(() => fs.renameSync(temporary, target));
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  });
}

function readJson(paths: VersionPaths, path: string): unknown {
  const bytes = readBounded(paths.ownedRoot, path, STORE_FILE_MAX);
  if (!bytes) return undefined;
  try { return JSON.parse(bytes.toString('utf8')) as unknown; }
  catch { throw new VersionStoreError('corrupt', `${basename(path)} no es JSON válido.`); }
}

// ---------------------------------------------------------------- lock

export interface LockOwner { token: string; pid: number; host: string; command: string; startedAt: string }
export interface LockSeams { isAlive?: (pid: number) => boolean; hostname?: () => string; now?: () => Date }
export interface LockHandle { readonly token: string; readonly paths: VersionPaths; release(): void }

/** `process.kill(pid, 0)`; EPERM means the process exists. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return codeOf(error) === 'EPERM'; }
}

function parseOwner(bytes: Buffer): LockOwner | undefined {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (isRecord(value) && typeof value.token === 'string' && Number.isInteger(value.pid) && typeof value.host === 'string'
      && typeof value.command === 'string' && typeof value.startedAt === 'string') return value as unknown as LockOwner;
  } catch { /* unreadable owner */ }
  return undefined;
}

function busy(owner: LockOwner | undefined): VersionStoreError {
  return new VersionStoreError('busy', owner
    ? `Otra operación de MDD está en curso (pid ${owner.pid}, \`${owner.command}\`, desde ${owner.startedAt}). Esperá o reintentá.`
    : 'Otra operación de MDD está en curso (dueño desconocido). Esperá o reintentá.');
}

/** Describes the current lock owner without taking it (doctor, versions); `undefined` when idle. */
export function readLockOwner(paths: VersionPaths): LockOwner | undefined {
  const bytes = readBounded(paths.ownedRoot, paths.lockPath, 64 * 1024);
  return bytes ? parseOwner(bytes) : undefined;
}

function tryCreate(paths: VersionPaths, owner: LockOwner): boolean {
  let fd: number;
  try { fd = fs.openSync(paths.lockPath, 'wx', 0o600); }
  catch (error) { if (codeOf(error) === 'EEXIST') return false; throw error; }
  try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); try { fs.rmSync(paths.lockPath, { force: true }); } catch { /* best effort */ } throw error; }
  fs.closeSync(fd);
  return true;
}

/**
 * Takes the exclusive owner lock. An existing lock is stale only when its owner is on this host and
 * its pid is dead (age is never consulted), or when it is empty or unreadable and untouched for 30 s.
 * A stale lock is renamed away, then creation is retried once. Otherwise: busy.
 */
export function acquireLock(paths: VersionPaths, command: string, seams: LockSeams = {}): LockHandle {
  const isAlive = seams.isAlive ?? pidAlive;
  const host = (seams.hostname ?? osHostname)();
  const now = seams.now ?? (() => new Date());
  safe(() => ensureDirectory(paths.ownedRoot, paths.versionsRoot));
  const token = randomBytes(12).toString('hex');
  const owner: LockOwner = { token, pid: process.pid, host, command, startedAt: now().toISOString() };

  if (!tryCreate(paths, owner)) {
    const lock = safe(() => scopedPath(paths.ownedRoot, paths.lockPath));
    const stat = fs.lstatSync(lock, { throwIfNoEntry: false });
    const bytes = stat ? readBounded(paths.ownedRoot, lock, 64 * 1024) : undefined;
    const current = bytes ? parseOwner(bytes) : undefined;
    const stale = !stat ? true : current
      ? current.host === host && !isAlive(current.pid)
      : now().getTime() - stat.mtimeMs > UNREADABLE_LOCK_MS;
    if (!stale) throw busy(current);
    if (stat) {
      const moved = join(paths.versionsRoot, `lock.stale-${token}.json`);
      try { fs.renameSync(lock, moved); }
      catch (error) { if (codeOf(error) !== 'ENOENT') throw error; }
      // A racing process may have replaced the stale lock with a live one between the read and the rename.
      const taken = readBounded(paths.ownedRoot, moved, 64 * 1024);
      const takenOwner = taken ? parseOwner(taken) : undefined;
      if (taken && (takenOwner?.token ?? null) !== (current?.token ?? null)) {
        try { if (!fs.existsSync(lock)) fs.renameSync(moved, lock); } catch { /* best effort */ }
        throw busy(takenOwner);
      }
    }
    if (!tryCreate(paths, owner)) throw busy(readLockOwner(paths));
  }

  let released = false;
  return {
    token, paths,
    release() {
      if (released) return;
      released = true;
      const bytes = readBounded(paths.ownedRoot, paths.lockPath, 64 * 1024);
      if (bytes && parseOwner(bytes)?.token === token) retryTransient(() => fs.unlinkSync(paths.lockPath));
    },
  };
}

/** Runs `work` holding the lock and always releases it (except when the process dies). */
export function withLock<T>(paths: VersionPaths, command: string, work: (lock: LockHandle) => T, seams?: LockSeams): T {
  const lock = acquireLock(paths, command, seams);
  try { return work(lock); } finally { lock.release(); }
}

/** Throws unless `lock` is still the lock on disk. Every mutation of stored data calls this. */
export function assertHeld(lock: LockHandle): void {
  const bytes = readBounded(lock.paths.ownedRoot, lock.paths.lockPath, 64 * 1024);
  if (!bytes || parseOwner(bytes)?.token !== lock.token) throw new VersionStoreError('lock-lost', 'El bloqueo de MDD ya no pertenece a esta operación.');
}

// ---------------------------------------------------------------- state.json

export interface VersionState {
  schema: 1;
  origin: string | null;
  devCheckout: string | null;
  active: (Identity & Record<string, unknown>) | null;
  adoption: Record<string, unknown> | null;
  releases: Record<string, { commit: string; firstSeen: string }>;
}

export const emptyState = (): VersionState => ({ schema: 1, origin: null, devCheckout: null, active: null, adoption: null, releases: {} });

function validState(value: unknown): VersionState {
  if (!isRecord(value) || value.schema !== 1) throw new VersionStoreError('corrupt', 'state.json tiene un esquema desconocido.');
  const state: VersionState = { ...emptyState(), ...(value as Partial<VersionState>) } as VersionState;
  if (state.origin !== null && typeof state.origin !== 'string') throw new VersionStoreError('corrupt', 'state.json: origin inválido.');
  if (state.devCheckout !== null && typeof state.devCheckout !== 'string') throw new VersionStoreError('corrupt', 'state.json: devCheckout inválido.');
  if (state.active !== null) parseIdentity(state.active);
  if (!isRecord(state.releases)) throw new VersionStoreError('corrupt', 'state.json: releases inválido.');
  for (const [version, entry] of Object.entries(state.releases)) {
    if (parseReleaseTag(version)?.text !== version || !isRecord(entry) || typeof entry.commit !== 'string') throw new VersionStoreError('corrupt', 'state.json: release inválido.');
  }
  return state;
}

/** Reads state.json (read-only, no lock needed); a missing file is the empty state. */
export function readState(paths: VersionPaths): VersionState {
  const value = readJson(paths, paths.statePath);
  return value === undefined ? emptyState() : validState(value);
}

export function writeState(lock: LockHandle, state: VersionState): void {
  assertHeld(lock);
  validState(state);
  writeAtomic(lock.paths.ownedRoot, lock.paths.statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/** Records first-seen eligible tags that are not recorded yet; never changes a recorded commit. Returns whether it wrote. */
export function recordReleases(lock: LockHandle, found: readonly { version: string; commit: string }[], at: Date): boolean {
  const state = readState(lock.paths);
  let changed = false;
  for (const { version, commit } of found) {
    if (state.releases[version]) continue;
    state.releases[version] = { commit, firstSeen: at.toISOString() };
    changed = true;
  }
  if (changed) writeState(lock, state);
  return changed;
}

// ---------------------------------------------------------------- journal

export type JournalPhase = 'preparing' | 'backing-up' | 'activating' | 'committed' | 'blocked';
export const JOURNAL_PHASES: readonly JournalPhase[] = ['preparing', 'backing-up', 'activating', 'committed', 'blocked'];

export interface Journal {
  schema: 1;
  id: string;
  phase: JournalPhase;
  owner: { pid: number; host: string };
  source: Identity | null;
  target: Identity;
  backup?: string | null;
  snapshot?: Record<string, string>;
  items?: Record<string, unknown>[];
  blocked?: { reason: string; at: string };
}

function validJournal(value: unknown): Journal {
  if (!isRecord(value) || value.schema !== 1 || typeof value.id !== 'string' || !/^[0-9a-f]{4,32}$/.test(value.id)
    || !JOURNAL_PHASES.includes(value.phase as JournalPhase) || !isRecord(value.owner) || !isRecord(value.target)) {
    throw new VersionStoreError('corrupt', 'journal.json tiene un formato desconocido.');
  }
  parseIdentity(value.source ?? null);
  if (parseIdentity(value.target) === null) throw new VersionStoreError('corrupt', 'journal.json: destino inválido.');
  if (value.backup != null && typeof value.backup !== 'string') throw new VersionStoreError('corrupt', 'journal.json: respaldo inválido.');
  return value as unknown as Journal;
}

/** The in-flight switch, or `undefined` when idle. Corrupt content throws `corrupt` (the caller blocks). */
export function readJournal(paths: VersionPaths): Journal | undefined {
  const value = readJson(paths, paths.journalPath);
  return value === undefined ? undefined : validJournal(value);
}

export function writeJournal(lock: LockHandle, journal: Journal): void {
  assertHeld(lock);
  validJournal(journal);
  writeAtomic(lock.paths.ownedRoot, lock.paths.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
}

export function clearJournal(lock: LockHandle): void {
  assertHeld(lock);
  safe(() => {
    const path = scopedPath(lock.paths.ownedRoot, lock.paths.journalPath);
    retryTransient(() => fs.rmSync(path, { force: true }));
  });
}

/** Name of the backup set a journal references (relative `backups/<name>` or a bare name). */
export function journalBackupName(journal: Journal | undefined): string | undefined {
  return journal?.backup ? journal.backup.split(/[\\/]/).pop() : undefined;
}

// ---------------------------------------------------------------- backups

export interface BackupAssetInput { path: string; bytes: Buffer; sha256: string; edited: boolean; action: 'replace' | 'remove' }
export interface BackupInput {
  source: Identity | null;
  target: Identity;
  /** Config bytes with their planned digest, or `null` when the file is absent. */
  config: { bytes: Buffer; sha256: string } | null;
  assets: readonly BackupAssetInput[];
  now?: () => Date;
  /** Seam for failure tests: called before each file is written (`config`, an asset path, `backup.json`). */
  beforeWrite?: (what: string) => void;
}

export interface BackupManifest {
  schema: 1;
  seq: number;
  capturedAt: string;
  source: Identity | null;
  target: Identity;
  config: { present: boolean; sha256?: string };
  assets: { path: string; sha256: string; edited: boolean; action: 'replace' | 'remove' }[];
  complete: true;
}
export interface BackupSet extends BackupManifest { name: string; dir: string }

const CONFIG_FILE = 'mdd.config.json';

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
}

function assetRelative(path: string): string {
  if (typeof path !== 'string' || !path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new VersionStoreError('backup', `Ruta de activo inválida para el respaldo: ${String(path)}`);
  }
  return path;
}

function backupDirs(paths: VersionPaths): string[] {
  if (!fs.lstatSync(paths.backupsRoot, { throwIfNoEntry: false })) return [];
  safe(() => scopedPath(paths.ownedRoot, paths.backupsRoot, true));
  return fs.readdirSync(paths.backupsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort();
}

/** Parses and fully validates a set: known schema, `complete:true`, and every listed file's digest. */
export function validateBackup(paths: VersionPaths, name: string): BackupSet | undefined {
  try {
    const dir = join(paths.backupsRoot, name);
    const raw = readBounded(paths.ownedRoot, join(dir, 'backup.json'), STORE_FILE_MAX);
    if (!raw) return undefined;
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (!isRecord(value) || value.schema !== 1 || value.complete !== true || !Number.isSafeInteger(value.seq) || (value.seq as number) < 1
      || typeof value.capturedAt !== 'string' || !isRecord(value.config) || !Array.isArray(value.assets)) return undefined;
    const source = parseIdentity(value.source ?? null);
    const target = parseIdentity(value.target);
    if (!target) return undefined;
    const config = value.config as { present?: unknown; sha256?: unknown };
    const configBytes = readBounded(paths.ownedRoot, join(dir, CONFIG_FILE), BACKUP_FILE_MAX);
    if (config.present === true) {
      if (!configBytes || typeof config.sha256 !== 'string' || sha256(configBytes) !== config.sha256) return undefined;
    } else if (config.present !== false || configBytes) return undefined;
    const assets: BackupManifest['assets'] = [];
    for (const item of value.assets as unknown[]) {
      if (!isRecord(item) || typeof item.sha256 !== 'string' || typeof item.edited !== 'boolean' || (item.action !== 'replace' && item.action !== 'remove')) return undefined;
      const path = assetRelative(item.path as string);
      const bytes = readBounded(paths.ownedRoot, join(dir, 'assets', ...path.split('/')), BACKUP_FILE_MAX);
      if (!bytes || sha256(bytes) !== item.sha256) return undefined;
      assets.push({ path, sha256: item.sha256, edited: item.edited, action: item.action });
    }
    return {
      schema: 1, seq: value.seq as number, capturedAt: value.capturedAt, source, target, assets, complete: true,
      config: config.present === true ? { present: true, sha256: config.sha256 as string } : { present: false },
      name, dir,
    };
  } catch { return undefined; }
}

export interface BackupListing { valid: BackupSet[]; invalid: string[] }

/** Completed sets newest first by capture `seq` (never by name or SemVer), plus names that are partial or invalid. */
export function listBackups(paths: VersionPaths): BackupListing {
  const valid: BackupSet[] = [];
  const invalid: string[] = [];
  for (const name of backupDirs(paths)) {
    const set = validateBackup(paths, name);
    if (set) valid.push(set); else invalid.push(name);
  }
  valid.sort((a, b) => b.seq - a.seq);
  return { valid, invalid };
}

/** Next capture number: highest existing completed `seq` plus one. Compute while holding the lock. */
export function nextBackupSeq(paths: VersionPaths): number {
  return (listBackups(paths).valid[0]?.seq ?? 0) + 1;
}

/**
 * Creates one backup set: config (or the record of its absence), then every replaced or removed
 * asset, then `backup.json` last. Each copied digest must equal the planned one. Any failure removes
 * the partial directory (best effort; without backup.json it is invalid anyway) and throws `backup`.
 * Existing sets are never touched, and a name collision gets a `-2`, `-3`, ... suffix.
 */
export function createBackup(lock: LockHandle, input: BackupInput): BackupSet {
  assertHeld(lock);
  const paths = lock.paths;
  const date = (input.now ?? (() => new Date()))();
  const base = `${stamp(date)}-${identityLabel(input.source)}`;
  identityLabel(input.target);
  const seq = nextBackupSeq(paths);
  let dir: string | undefined;
  try {
    safe(() => ensureDirectory(paths.ownedRoot, paths.backupsRoot));
    for (let n = 1; !dir; n++) {
      const candidate = join(paths.backupsRoot, n === 1 ? base : `${base}-${n}`);
      try { fs.mkdirSync(candidate, { mode: 0o700 }); dir = candidate; }
      catch (error) { if (codeOf(error) !== 'EEXIST' || n > 1000) throw error; }
    }
    const put = (what: string, relative: string, bytes: Buffer, planned: string): void => {
      input.beforeWrite?.(what);
      if (sha256(bytes) !== planned) throw new VersionStoreError('backup', `El contenido de ${what} cambió antes de respaldarlo.`);
      writeAtomic(paths.ownedRoot, join(dir!, ...relative.split('/')), bytes);
      const copied = readBounded(paths.ownedRoot, join(dir!, ...relative.split('/')), BACKUP_FILE_MAX);
      if (!copied || sha256(copied) !== planned) throw new VersionStoreError('backup', `La copia de ${what} no coincide con lo planificado.`);
    };
    if (input.config) put(CONFIG_FILE, CONFIG_FILE, input.config.bytes, input.config.sha256);
    const seen = new Set<string>();
    for (const asset of input.assets) {
      const path = assetRelative(asset.path);
      if (seen.has(path)) throw new VersionStoreError('backup', `Activo repetido en el respaldo: ${path}`);
      seen.add(path);
      put(path, `assets/${path}`, asset.bytes, asset.sha256);
    }
    const manifest: BackupManifest = {
      schema: 1, seq, capturedAt: date.toISOString(), source: input.source, target: input.target,
      config: input.config ? { present: true, sha256: input.config.sha256 } : { present: false },
      assets: input.assets.map(a => ({ path: a.path, sha256: a.sha256, edited: a.edited, action: a.action })),
      complete: true,
    };
    input.beforeWrite?.('backup.json');
    writeAtomic(paths.ownedRoot, join(dir, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const set = validateBackup(paths, basename(dir));
    if (!set) throw new VersionStoreError('backup', 'El respaldo recién escrito no se pudo validar.');
    return set;
  } catch (error) {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still invalid without backup.json */ } }
    if (error instanceof VersionStoreError && error.code === 'backup') throw error;
    throw new VersionStoreError('backup', `No se pudo crear el respaldo: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Reads the bytes of a validated set's config (`null` = recorded absence) or one of its assets. */
export function readBackupConfig(paths: VersionPaths, set: BackupSet): Buffer | null {
  return set.config.present ? readBounded(paths.ownedRoot, join(set.dir, CONFIG_FILE), BACKUP_FILE_MAX) ?? null : null;
}
export function readBackupAsset(paths: VersionPaths, set: BackupSet, path: string): Buffer | undefined {
  return readBounded(paths.ownedRoot, join(set.dir, 'assets', ...assetRelative(path).split('/')), BACKUP_FILE_MAX);
}

/** Restore candidates for `target`: completed sets whose source is exactly that identity, newest first by `seq`. */
export function configCandidates(paths: VersionPaths, target: Identity): BackupSet[] {
  return listBackups(paths).valid.filter(set => sameIdentity(set.source, target));
}

export interface PruneResult { kept: string[]; removed: string[] }

/**
 * Retention after a commit or completed recovery, holding the lock: keeps the newest `keep` completed
 * sets by `seq`, never a set the journal references, and deletes partial or invalid sets only when
 * the journal does not reference them.
 */
export function pruneBackups(lock: LockHandle, options: { keep?: number; protect?: readonly string[] } = {}): PruneResult {
  assertHeld(lock);
  const paths = lock.paths;
  const journal = readJournal(paths);
  const protectedNames = new Set<string>([...(options.protect ?? []), ...(journalBackupName(journal) ? [journalBackupName(journal)!] : [])]);
  const { valid, invalid } = listBackups(paths);
  const keep = options.keep ?? BACKUPS_KEPT;
  const removed: string[] = [];
  const kept: string[] = [];
  const remove = (name: string): void => {
    safe(() => scopedPath(paths.ownedRoot, join(paths.backupsRoot, name), true));
    fs.rmSync(join(paths.backupsRoot, name), { recursive: true, force: true });
    removed.push(name);
  };
  valid.forEach((set, index) => {
    if (index < keep || protectedNames.has(set.name)) kept.push(set.name); else remove(set.name);
  });
  for (const name of invalid) {
    if (protectedNames.has(name)) kept.push(name); else remove(name);
  }
  return { kept, removed };
}
