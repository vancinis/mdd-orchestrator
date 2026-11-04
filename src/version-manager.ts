import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { atomicWrite, commandPlan, launcherKind, writeEntry, writeLaunchers, type LauncherFile } from './command-link.js';
import { installationPaths } from './installation-paths.js';
import { retryTransient } from './local-files.js';
import { scopedPath } from './safe-paths.js';

/**
 * Identity and installation of the version manager. This module has no side effects at import time:
 * the target-package probe imports it only to read MANAGER_REVISION. It imports no CLI or UI module,
 * because inside the manager copy PACKAGE_ROOT points at the manager directory, not at a package.
 */

/** Monotonic integer. A manager is replaced only by a strictly higher revision (forward-only, DD5). */
export const MANAGER_REVISION = 1;

export type ManagerPaths = ReturnType<typeof installationPaths>;
export type ManagerSource = 'checkout' | 'release';
export interface ManagerMeta { revision: number; version: string; source: ManagerSource }
export interface ManagerCurrent extends ManagerMeta { dir: string; previous: string | null; digest: string; installedAt: string }

/** Router file every manager revision must ship; the stable entry imports it and calls `main(argv)`. */
export const ROUTER_FILE = 'version-cli.js';
export const MANAGER_DIR = /^r([0-9]+)-([0-9a-f]{8})$/;
const MANAGER_FILE_MAX = 4 * 1024 * 1024;

export class ManagerError extends Error {
  constructor(message: string) { super(message); this.name = 'ManagerError'; }
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

/** Reads `current.json`; anything unreadable or malformed is treated as "no manager" so it can be repaired. */
export function readCurrent(paths: ManagerPaths = installationPaths()): ManagerCurrent | undefined {
  try {
    const path = scopedPath(paths.ownedRoot, paths.managerCurrentPath);
    if (!fs.existsSync(path)) return undefined;
    const stat = fs.statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
    const value = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof value.dir !== 'string' || !MANAGER_DIR.test(value.dir) || !validRevision(value.revision)) return undefined;
    if (value.previous !== null && !(typeof value.previous === 'string' && MANAGER_DIR.test(value.previous))) return undefined;
    if (typeof value.version !== 'string' || (value.source !== 'checkout' && value.source !== 'release')) return undefined;
    if (typeof value.digest !== 'string' || typeof value.installedAt !== 'string') return undefined;
    return { dir: value.dir, previous: value.previous, revision: value.revision, version: value.version, source: value.source, digest: value.digest, installedAt: value.installedAt };
  } catch { return undefined; }
}

/** True when the revision directory still holds a router the entry can import. */
export function managerHealthy(current: ManagerCurrent | undefined, paths: ManagerPaths = installationPaths()): boolean {
  if (!current) return false;
  try {
    const router = scopedPath(paths.ownedRoot, join(paths.managerRoot, current.dir, 'dist', ROUTER_FILE));
    return fs.statSync(router).isFile();
  } catch { return false; }
}

/** The compiled files a manager revision consists of: top-level `*.js` of a package `dist` (no `.d.ts`, no maps). */
function distFiles(distDir: string): { name: string; bytes: Buffer }[] {
  const files = fs.readdirSync(distDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && !entry.isSymbolicLink() && /^[A-Za-z0-9._-]+\.js$/.test(entry.name))
    .map(entry => entry.name).sort();
  return files.map(name => {
    const path = join(distDir, name);
    if (fs.statSync(path).size > MANAGER_FILE_MAX) throw new ManagerError(`El archivo ${name} del gestor es demasiado grande.`);
    return { name, bytes: fs.readFileSync(path) };
  });
}

export function managerDigest(files: readonly { name: string; bytes: Buffer }[]): string {
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file.name}\0${file.bytes.length}\0`).update(file.bytes);
  return hash.digest('hex');
}

export type ManagerInstall =
  | { action: 'installed'; current: ManagerCurrent }
  | { action: 'kept'; current: ManagerCurrent; reason: string };

/**
 * Installs a manager revision from a package `dist`, forward-only. The caller holds the version lock.
 *
 * 1. An installed healthy revision >= the incoming one is kept (the manager only advances).
 * 2. Files are copied to a temporary directory, then renamed to `r<rev>-<digest8>`.
 * 3. `current.json` is written atomically, recording the old directory as `previous` (fallback).
 * 4. The stable entry is written if absent or older.
 * 5. Revision directories other than current and previous are removed.
 */
export function installManager(distDir: string, meta: ManagerMeta, paths: ManagerPaths = installationPaths(), now: () => Date = () => new Date()): ManagerInstall {
  if (!validRevision(meta.revision)) throw new ManagerError('Revisión de gestor inválida.');
  const existing = readCurrent(paths);
  if (existing && managerHealthy(existing, paths) && existing.revision >= meta.revision) {
    writeEntry(paths);
    return { action: 'kept', current: existing, reason: `se conserva el gestor instalado (revisión ${existing.revision}); solo avanza` };
  }
  if (existing && existing.revision > meta.revision) {
    // Forward-only floor (R8, DD5): an unhealthy newer manager is never replaced by an older source.
    throw new ManagerError(`El gestor instalado (revisión ${existing.revision}) está dañado y este origen trae la revisión ${meta.revision}, más antigua; no se instaló nada. Reparalo desde un origen con revisión ${existing.revision} o superior (por ejemplo, actualizá el checkout y ejecutá npm run setup).`);
  }
  const files = distFiles(distDir);
  for (const required of [ROUTER_FILE, 'version-manager.js']) {
    if (!files.some(file => file.name === required)) throw new ManagerError(`El origen del gestor no incluye ${required}; no se instaló nada.`);
  }
  const digest = managerDigest(files);
  const dir = `r${meta.revision}-${digest.slice(0, 8)}`;
  fs.mkdirSync(paths.managerRoot, { recursive: true, mode: 0o700 });
  scopedPath(paths.ownedRoot, paths.managerRoot, true);
  const finalDir = join(paths.managerRoot, dir);
  const complete = (): boolean => files.every(file => {
    try { return fs.readFileSync(join(finalDir, 'dist', file.name)).equals(file.bytes); } catch { return false; }
  });
  if (fs.existsSync(finalDir) && !complete()) fs.rmSync(finalDir, { recursive: true, force: true });
  if (!fs.existsSync(finalDir)) {
    const temporary = join(paths.managerRoot, `${dir}.tmp-${randomBytes(4).toString('hex')}`);
    try {
      fs.mkdirSync(join(temporary, 'dist'), { recursive: true, mode: 0o700 });
      for (const file of files) fs.writeFileSync(join(temporary, 'dist', file.name), file.bytes, { mode: 0o600 });
      fs.writeFileSync(join(temporary, 'package.json'), '{"private":true,"type":"module"}\n', { mode: 0o600 });
      retryTransient(() => fs.renameSync(temporary, finalDir));
    } catch (error) {
      try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
  }
  const previous = existing && existing.dir !== dir && managerHealthy(existing, paths) ? existing.dir : existing?.dir === dir ? existing.previous : null;
  const current: ManagerCurrent = { dir, previous, revision: meta.revision, version: meta.version, source: meta.source, digest, installedAt: now().toISOString() };
  atomicWrite(paths.ownedRoot, paths.managerCurrentPath, `${JSON.stringify(current, null, 2)}\n`);
  writeEntry(paths);
  pruneManagers(paths, current);
  return { action: 'installed', current };
}

/** Removes revision directories and leftover temporaries that are neither current nor previous. */
export function pruneManagers(paths: ManagerPaths, current: ManagerCurrent): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(paths.managerRoot)) return removed;
  for (const entry of fs.readdirSync(paths.managerRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (!/^r[0-9]+-[0-9a-f]{8}(\.tmp-[0-9a-f]+)?$/.test(entry.name)) continue;
    if (entry.name === current.dir || entry.name === current.previous) continue;
    try {
      scopedPath(paths.ownedRoot, join(paths.managerRoot, entry.name), true);
      fs.rmSync(join(paths.managerRoot, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* best effort: a locked old revision is retried on the next install */ }
  }
  return removed;
}

export interface RoutingResult {
  entry: 'created' | 'updated' | 'keep';
  launchers: LauncherFile[];
  /** True when at least one launcher differed from the manager-aware text (for example a 0.2.0 rewrite). */
  restored: boolean;
  /** What the launchers reached before the repair, for diagnostics. */
  before: Record<string, 'manager' | 'legacy' | 'other' | 'absent'>;
}

/**
 * Re-asserts the stable entry and both launchers. Idempotent and cheap, so the router calls it after every
 * delegation and on every lock-taking command (R8): old setup/update/link that rewrote the launchers is undone.
 */
export function ensureRouting(paths: ManagerPaths = installationPaths()): RoutingResult {
  const before: RoutingResult['before'] = {};
  for (const file of commandPlan(process.env, paths).files) {
    before[file.name] = file.action === 'create' ? 'absent' : launcherKind(fs.readFileSync(file.path, 'utf8'));
  }
  const entry = writeEntry(paths);
  const launchers = writeLaunchers(paths);
  return { entry, launchers, restored: Object.values(before).some(kind => kind !== 'manager'), before };
}

/** Command a person runs to re-assert routing after a hard kill left the 0.2.0 launchers in place. */
export function recoveryCommand(paths: Pick<ReturnType<typeof installationPaths>, 'managerEntry'> = installationPaths()): string {
  return `node "${paths.managerEntry}" link`;
}

/** Contract the stable entry expects from the router module (`version-cli.js`). */
export interface ManagerRouter { main(argv: string[]): Promise<number | void> | number | void }
