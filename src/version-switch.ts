import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalFiles, retryTransient } from './local-files.js';
import { scopedPath } from './safe-paths.js';
import { installedPlugin, ownedLeftovers } from './setup.js';
import { npmCli, pruneCache } from './version-source.js';
import {
  assertHeld, clearJournal, configCandidates, createBackup, identityLabel, journalBackupName, listBackups, pruneBackups,
  readBackupAsset, readBackupConfig, readJournal, readState, sameIdentity, validateBackup, versionPaths, writeJournal, writeState,
} from './version-store.js';
import type { BackupSet, Identity, Journal, JournalPhase, LockHandle } from './version-store.js';
import { installManager, ensureRouting, readCurrent } from './version-manager.js';
import type { ManagerPaths } from './version-manager.js';
import { BASELINE } from './versions.js';

// Transactional switch of the active MDD package + managed assets + config. Everything is staged and
// verified before the installation is touched; one backup set doubles as rollback material; writing
// state.json is the commit point; recovery looks at the actual bytes. Ordinary planProject/initProject
// are not used here: a switch backs up and replaces edited owned assets, setup keeps refusing them.

export type SwitchErrorCode =
  | 'refused' | 'collision' | 'unsafe' | 'stage' | 'probe' | 'verify' | 'config' | 'backup' | 'changed' | 'blocked' | 'activation' | 'cancelled';

export class SwitchError extends Error {
  constructor(readonly code: SwitchErrorCode, message: string) { super(message); this.name = 'SwitchError'; }
}

export const RESTART_COMMAND = 'opencode service restart';
export const PROBE_TIMEOUT_MS = 60000;
export const PROBE_OUTPUT_MAX = 8 * 1024 * 1024;
export const STAGE_TIMEOUT_MS = 10 * 60000;
export const LEDGER_MAX = 16384;
export const INSTALLED_ASSET_MAX = 65536;
const FILE_MAX = 1024 * 1024;
const PACKAGE_NAME = 'my-driven-development';
const LEDGER_NAME = 'mdd/setup-assets.json';
const KEPT_PACKAGES = 3;
const PROBE_SCRIPT = fileURLToPath(new URL('./version-probe.js', import.meta.url));

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const short = (text: string, limit = 2048): string => (text.length > limit ? `${text.slice(0, limit)}...` : text);

// ---------------------------------------------------------------- layout

function layout(paths: ManagerPaths) {
  const owned = paths.ownedRoot;
  return {
    root: paths.configRoot,
    owned,
    vp: versionPaths(owned),
    nodeModules: join(owned, 'node_modules'),
    pkgRoot: paths.installedPackageRoot,
    pkgJson: join(owned, 'package.json'),
    lockJson: join(owned, 'package-lock.json'),
    packages: paths.packagesRoot,
    config: paths.settingsPath,
    ledger: paths.manifestPath,
  };
}
type Layout = ReturnType<typeof layout>;

// ---------------------------------------------------------------- safe file helpers

function guard<T>(work: () => T, code: SwitchErrorCode = 'unsafe'): T {
  try { return work(); }
  catch (error) {
    if (error instanceof SwitchError) throw error;
    if (error instanceof Error && /scoped|outside the approved|Linked or nonregular|Invalid scoped|not a safe|exceeds|unsafe|symbolic|Local storage/i.test(error.message)) {
      throw new SwitchError(code, `Ruta o archivo inseguro: ${error.message}`);
    }
    throw error;
  }
}

/** Reads a regular file under `base` (no links, no hardlinks) with a size cap; `undefined` when absent. */
function readSafe(base: string, path: string, max: number): Buffer | undefined {
  return guard(() => {
    const checked = scopedPath(base, path);
    if (!fs.lstatSync(checked, { throwIfNoEntry: false })) return undefined;
    const fd = fs.openSync(checked, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new SwitchError('unsafe', `Archivo no regular o enlazado: ${relative(base, checked)}`);
      if (stat.size > max) throw new SwitchError('unsafe', `Archivo demasiado grande: ${relative(base, checked)}`);
      return fs.readFileSync(fd);
    } finally { fs.closeSync(fd); }
  });
}

const digestOf = (bytes: Buffer | undefined): string | null => (bytes ? sha256(bytes) : null);
const label = (digest: string | null): string => digest ?? 'absent';

/** Temp file next to the target, fsync, rename. The temp name is dot-prefixed with `.tmp` so OpenCode never sees an `.md`. */
function writeAtomic(base: string, path: string, data: Buffer | string, mode = 0o600): void {
  guard(() => {
    const target = scopedPath(base, path);
    mkdirs(base, dirname(target));
    const temporary = join(dirname(target), `.${target.split(sep).pop()}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fd = fs.openSync(temporary, 'wx', mode);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      scopedPath(base, target);
      retryTransient(() => fs.renameSync(temporary, target));
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
      throw error;
    }
  });
}

function mkdirs(base: string, directory: string): void {
  const root = resolve(base);
  const parts = relative(root, resolve(directory)).split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) fs.mkdirSync(current, { mode: 0o700 });
    scopedPath(root, current, true);
  }
}

function unlinkSafe(base: string, path: string): void {
  const checked = guard(() => scopedPath(base, path));
  retryTransient(() => fs.rmSync(checked, { force: true }));
}

const rename = (from: string, to: string): void => { retryTransient(() => fs.renameSync(from, to)); };
const exists = (path: string): boolean => !!fs.lstatSync(path, { throwIfNoEntry: false });

/** Removes empty directories below skills/ after a managed file is removed; never agents/, plugins/ or the root. */
function pruneEmptySkillDirs(root: string, assetPath: string): void {
  const parts = assetPath.split('/');
  if (parts[0] !== 'skills') return;
  for (let length = parts.length - 1; length >= 2; length--) {
    const directory = join(root, ...parts.slice(0, length));
    try {
      if (fs.readdirSync(directory).length) return;
      fs.rmdirSync(directory);
    } catch { return; }
  }
}

// ---------------------------------------------------------------- package digest

/** Digest of every regular file under a package root (paths and bytes). Links are refused. */
export function treeDigest(root: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string, prefix: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new SwitchError('unsafe', `El paquete contiene un enlace: ${rel}`);
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.isFile()) throw new SwitchError('unsafe', `El paquete contiene un archivo no regular: ${rel}`);
      const bytes = fs.readFileSync(full);
      hash.update(`${rel}\0${bytes.length}\0`).update(bytes);
    }
  };
  walk(root, '');
  return hash.digest('hex');
}

/** Digest recorded in `state.active.packageDigest`; the manager compares it to detect an external change. */
export function installedPackageDigest(paths: ManagerPaths): string | null {
  const root = paths.installedPackageRoot;
  return fs.existsSync(root) ? treeDigest(root) : null;
}

// ---------------------------------------------------------------- probe

export type ProbeFn = (packageRoot: string, op: 'assets' | 'packaged' | 'config' | 'manager', arg?: string) => unknown;

/** Runs the target's probe in a subprocess: 60 s timeout, 8 MiB output cap. */
export const runProbe: ProbeFn = (packageRoot, op, arg) => {
  try {
    const out = execFileSync(process.execPath, [PROBE_SCRIPT, packageRoot, op, ...(arg ? [arg] : [])], {
      encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: PROBE_OUTPUT_MAX, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out) as unknown;
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    const detail = stderr ? stderr.toString().trim() : message(error);
    throw new SwitchError('probe', `No se pudo leer el paquete destino (${op}): ${short(detail)} No se cambi\u00f3 la instalaci\u00f3n activa.`);
  }
};

interface ProbeFile { path: string; content: string }

function probeFiles(value: unknown, what: string): ProbeFile[] {
  if (!isRecord(value) || !Array.isArray(value.files)) throw new SwitchError('probe', `Respuesta inv\u00e1lida del paquete destino (${what}).`);
  return value.files.map(item => {
    if (!isRecord(item) || typeof item.path !== 'string' || typeof item.content !== 'string') throw new SwitchError('probe', `Respuesta inv\u00e1lida del paquete destino (${what}).`);
    return { path: assetPathOk(item.path), content: item.content };
  });
}

function probePaths(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.files) || !value.files.every(item => typeof item === 'string')) {
    throw new SwitchError('probe', 'Respuesta inv\u00e1lida del paquete destino (packaged).');
  }
  return (value.files as string[]).map(path => assetPathOk(path));
}

function assetPathOk(path: string): string {
  if (!path || path.length > 240 || path.startsWith('/') || path.includes('\\') || path.includes(':') || /[\x00-\x1f*?]/.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new SwitchError('unsafe', `Ruta de activo insegura: ${path.slice(0, 80)}`);
  }
  return path;
}

/** Managed removals are limited to the names MDD ever installs; anything else in a ledger fails closed. */
function managedPath(path: string): boolean {
  return /^agents\/mdd-[A-Za-z0-9._-]+\.md$/.test(path) || /^skills\/mdd-[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(path)
    || path === 'plugins/mdd.ts' || path === 'mdd/.gitignore';
}

// ---------------------------------------------------------------- types

export interface PreparedLike {
  tarball: string;
  sha256: string;
  warnings?: string[];
  dirty?: boolean;
  checkout?: string;
}

export interface SwitchTarget {
  identity: Identity;
  channel: 'stable' | 'preview' | 'dev';
  /** What the owner asked for (`stable`, `0.3.0`, ...); informational, never followed. */
  selectedAs: string;
  /** Cache hit, release build or dev build; called holding the lock after the already-active check. */
  prepare(): PreparedLike;
  /** Source bytes of a packaged file: `git show <commit>:<path>` for releases, the checkout file for dev. */
  packagedSource(path: string): Buffer | undefined;
}

export interface SwitchDeps {
  now?: () => Date;
  id?: () => string;
  /** Replaces the npm install into the stage. `tarball` is the absolute path inside `<stage>/packages`. */
  installStage?: (stageDir: string, tarball: string) => void;
  probe?: ProbeFn;
  /** Decides after the review is built. Absent means confirmed. A `false` cancels without touching anything. */
  confirm?: (plan: SwitchPlan) => boolean | Promise<boolean>;
  /** Test hook: runs between confirmation and the first input re-check. */
  afterReview?: (plan: SwitchPlan) => void;
  /** Called at named points of the transaction; tests throw or exit the process to inject failures. */
  fault?: (point: string) => void;
}

export interface AssetStep {
  path: string;
  action: 'create' | 'replace' | 'remove' | 'keep' | 'drop';
  before: string | null;
  after: string | null;
  edited: boolean;
}

export interface ConfigStep {
  decision: 'keep' | 'restore' | 'remove';
  before: string | null;
  after: string | null;
  bytes: Buffer | null;
  restoredFrom?: string;
}

export interface SwitchPlan {
  id: string;
  txDir: string;
  stageDir: string;
  source: Identity | null;
  target: Identity;
  channel: SwitchTarget['channel'];
  selectedAs: string;
  tarballName: string;
  tarballSha256: string;
  targetTreeDigest: string;
  targetInstalledJson: string;
  targetPackageJson: string;
  targetLock: string | null;
  before: { installedJson: string | null; packageJson: string | null; lock: string | null; hadPackage: boolean };
  assets: AssetStep[];
  targetFiles: Map<string, Buffer>;
  ledgerAfterText: string;
  ledgerBefore: string | null;
  ledgerAfter: string;
  config: ConfigStep;
  managerRevision: number | null;
  snapshot: Record<string, string>;
  editedAssets: string[];
  warnings: string[];
  dirty?: boolean | undefined;
  checkout?: string | undefined;
  review: string[];
}

export interface SwitchResult {
  target: Identity;
  channel: SwitchTarget['channel'];
  backup: string;
  backupName: string;
  /** Hand-edited files that were replaced or removed, with the path of their backup copy. */
  edited: { path: string; backup: string }[];
  config: { decision: ConfigStep['decision']; detail: string };
  warnings: string[];
  restartCommand: string;
}

export type SwitchOutcome =
  | { status: 'switched'; result: SwitchResult }
  | { status: 'already'; identity: Identity }
  | { status: 'cancelled' };

// ---------------------------------------------------------------- input snapshot

const CONFIG_KEY = 'mdd.config.json';
const SPECIAL_KEYS = [CONFIG_KEY, 'setup-assets.json', 'package.json', 'package-lock.json', 'installedPackageJson', 'installedPackage'];

interface Inputs { digests: Record<string, string>; bytes: Map<string, Buffer | undefined> }

function readConfig(L: Layout): Buffer | undefined {
  try { return readSafe(L.owned, L.config, FILE_MAX); }
  catch (error) {
    if (error instanceof SwitchError && error.code === 'unsafe') throw new SwitchError('backup', `No se puede respaldar la configuraci\u00f3n: ${error.message} No se cambi\u00f3 nada.`);
    throw error;
  }
}

/** Digest of every input a switch depends on, read fresh from disk. Unsafe paths throw. */
function captureInputs(L: Layout, assetPaths: readonly string[]): Inputs {
  const digests: Record<string, string> = {};
  const bytes = new Map<string, Buffer | undefined>();
  for (const path of assetPaths) {
    const data = readSafe(L.root, path, INSTALLED_ASSET_MAX);
    bytes.set(path, data);
    digests[path] = label(digestOf(data));
  }
  const config = readConfig(L);
  bytes.set(CONFIG_KEY, config);
  digests[CONFIG_KEY] = label(digestOf(config));
  digests['setup-assets.json'] = label(digestOf(readSafe(L.root, LEDGER_NAME, LEDGER_MAX)));
  digests['package.json'] = label(digestOf(readSafe(L.owned, L.pkgJson, FILE_MAX)));
  digests['package-lock.json'] = label(digestOf(readSafe(L.owned, L.lockJson, 16 * FILE_MAX)));
  digests['installedPackageJson'] = label(digestOf(readSafe(L.pkgRoot, join(L.pkgRoot, 'package.json'), FILE_MAX)));
  digests['installedPackage'] = fs.existsSync(L.pkgRoot) ? treeDigest(L.pkgRoot) : 'absent';
  return { digests, bytes };
}

function sameSnapshot(a: Record<string, string>, b: Record<string, string>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(key => a[key] !== b[key]);
}

// ---------------------------------------------------------------- ledger

function readLedger(L: Layout): { text: string | undefined; map: Record<string, string> } {
  let text: string | undefined;
  try { text = new LocalFiles(L.root).read(LEDGER_NAME, LEDGER_MAX); }
  catch { throw new SwitchError('unsafe', 'El registro de activos (mdd/setup-assets.json) es inseguro; no se cambi\u00f3 nada.'); }
  if (text === undefined) return { text, map: {} };
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new SwitchError('unsafe', 'El registro de activos no es JSON v\u00e1lido; no se cambi\u00f3 nada.'); }
  if (!isRecord(value)) throw new SwitchError('unsafe', 'El registro de activos tiene un formato desconocido; no se cambi\u00f3 nada.');
  const map: Record<string, string> = {};
  for (const [path, digest] of Object.entries(value)) {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new SwitchError('unsafe', 'El registro de activos tiene un digest inv\u00e1lido; no se cambi\u00f3 nada.');
    map[assetPathOk(path)] = digest;
  }
  return { text, map };
}

// ---------------------------------------------------------------- stage

function defaultInstallStage(stageDir: string, tarball: string): void {
  const cli = npmCli();
  if (!cli) throw new SwitchError('stage', 'No se encontr\u00f3 el CLI de npm junto a Node (npm_execpath o node_modules/npm).');
  try {
    execFileSync(process.execPath, [cli, 'install', tarball, '--prefix', stageDir, '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline', '--workspaces=false'], {
      cwd: stageDir, encoding: 'utf8', timeout: STAGE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: string | Buffer }).stderr;
    throw new SwitchError('stage', `Fall\u00f3 la instalaci\u00f3n en la etapa de preparaci\u00f3n: ${short((stderr ? stderr.toString() : message(error)).trim())}`);
  }
}

/** The current mdd/package.json minus the MDD dependency, as the stage's starting point. */
function stagePackageJson(L: Layout): string {
  const bytes = readSafe(L.owned, L.pkgJson, FILE_MAX);
  let pkg: Record<string, unknown> = { private: true };
  if (bytes) {
    try { const parsed: unknown = JSON.parse(bytes.toString('utf8')); if (isRecord(parsed)) pkg = parsed; } catch { /* start clean */ }
  }
  for (const field of ['dependencies', 'devDependencies']) {
    const deps = pkg[field];
    if (!isRecord(deps)) continue;
    delete deps[PACKAGE_NAME];
    if (!Object.keys(deps).length) delete pkg[field];
  }
  return `${JSON.stringify(pkg)}\n`;
}

// ---------------------------------------------------------------- planning

/** Plans a switch without changing the installation: stage, verify, probe, classify assets and config. */
export function planSwitch(lock: LockHandle, paths: ManagerPaths, target: SwitchTarget, prepared: PreparedLike, deps: SwitchDeps = {}): SwitchPlan {
  assertHeld(lock);
  const L = layout(paths);
  const probe = deps.probe ?? runProbe;
  const id = (deps.id ?? (() => randomBytes(4).toString('hex')))();
  const txDir = join(L.vp.txRoot, id);
  const stageDir = join(txDir, 'stage');
  const warnings = [...(prepared.warnings ?? [])];
  const state = readState(L.vp);
  const source: Identity | null = state.active ? { kind: state.active.kind, version: state.active.version, commit: state.active.commit } : null;

  // 1. stage install of the verified tarball
  const tarBytes = guard(() => fs.readFileSync(prepared.tarball), 'stage');
  const tarSha = sha256(tarBytes);
  if (tarSha !== prepared.sha256) throw new SwitchError('stage', 'El paquete preparado no coincide con su digest; no se cambi\u00f3 la instalaci\u00f3n activa.');
  const tarballName = `${PACKAGE_NAME}-${tarSha}.tgz`;
  mkdirs(L.owned, join(stageDir, 'packages'));
  const stagedTarball = join(stageDir, 'packages', tarballName);
  fs.writeFileSync(stagedTarball, tarBytes, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(join(stageDir, 'package.json'), stagePackageJson(L), { mode: 0o600 });
  (deps.installStage ?? defaultInstallStage)(stageDir, stagedTarball);
  deps.fault?.('staged');

  // 2. verify the staged package
  const stagedRoot = join(stageDir, 'node_modules', PACKAGE_NAME);
  let resolved: string;
  try { resolved = createRequire(join(stageDir, 'package.json')).resolve('my-driven-development/opencode-plugin'); }
  catch (error) { throw new SwitchError('verify', `El paquete preparado no expone opencode-plugin: ${short(message(error))}`); }
  const realStage = fs.realpathSync(stagedRoot);
  if (!fs.realpathSync(resolved).startsWith(realStage + sep)) throw new SwitchError('verify', 'El paquete preparado no resuelve dentro de la etapa.');
  const installedJson = readSafe(stagedRoot, join(stagedRoot, 'package.json'), FILE_MAX);
  let installedPkg: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(installedJson?.toString('utf8') ?? ''); if (isRecord(parsed)) installedPkg = parsed; } catch { /* checked next */ }
  if (installedPkg.name !== PACKAGE_NAME || installedPkg.version !== target.identity.version) {
    throw new SwitchError('verify', `El paquete preparado declara ${String(installedPkg.name)}@${String(installedPkg.version)}, no ${PACKAGE_NAME}@${target.identity.version}.`);
  }
  const packaged = probePaths(probe(stagedRoot, 'packaged'));
  const differing: string[] = [];
  for (const path of packaged) {
    const staged = readSafe(stagedRoot, join(stagedRoot, ...path.split('/')), FILE_MAX);
    const origin = target.packagedSource(path);
    if (!staged || !origin || !staged.equals(origin)) differing.push(path);
  }
  if (differing.length) throw new SwitchError('verify', `Archivos empaquetados distintos de la fuente (${differing.slice(0, 5).join(', ')}); no se cambi\u00f3 la instalaci\u00f3n activa.`);
  const targetPackageJson = digestOf(readSafe(stageDir, join(stageDir, 'package.json'), FILE_MAX));
  const targetLock = digestOf(readSafe(stageDir, join(stageDir, 'package-lock.json'), 16 * FILE_MAX));
  if (!targetPackageJson || !installedJson) throw new SwitchError('verify', 'La etapa no produjo package.json.');
  const targetTreeDigest = treeDigest(stagedRoot);

  // 3. target facts
  const files = probeFiles(probe(stagedRoot, 'assets'), 'assets');
  const targetFiles = new Map<string, Buffer>();
  for (const file of files) {
    if (targetFiles.has(file.path)) throw new SwitchError('unsafe', `Activo repetido en el destino: ${file.path}`);
    targetFiles.set(file.path, Buffer.from(file.content, 'utf8'));
  }
  const managerReply = probe(stagedRoot, 'manager');
  const managerRevision = isRecord(managerReply) && Number.isInteger(managerReply.revision) ? (managerReply.revision as number) : null;

  // 4. asset classification (3.11)
  const ledger = readLedger(L);
  const paths_ = [...new Set([...targetFiles.keys(), ...Object.keys(ledger.map)])].sort();
  for (const path of Object.keys(ledger.map)) {
    if (!targetFiles.has(path) && !managedPath(path)) throw new SwitchError('unsafe', `El registro menciona una ruta que MDD no instala: ${path}; no se cambi\u00f3 nada.`);
  }
  const inputs = captureInputs(L, paths_);
  const steps: AssetStep[] = [];
  const collisions: string[] = [];
  for (const path of paths_) {
    const current = digestOf(inputs.bytes.get(path));
    const wanted = targetFiles.get(path);
    const after = wanted ? sha256(wanted) : null;
    const recorded = ledger.map[path];
    if (wanted) {
      if (current === null) steps.push({ path, action: 'create', before: null, after, edited: false });
      else if (current === after) steps.push({ path, action: 'keep', before: current, after, edited: false });
      else if (recorded === undefined) collisions.push(path);
      else steps.push({ path, action: 'replace', before: current, after, edited: current !== recorded });
    } else if (current === null) steps.push({ path, action: 'drop', before: null, after: null, edited: false });
    else steps.push({ path, action: 'remove', before: current, after: null, edited: current !== recorded });
  }
  if (collisions.length) {
    throw new SwitchError('collision', `Estos archivos existen pero MDD no los registr\u00f3; mov\u00e9los y repet\u00ed: ${collisions.join(', ')}. No se cambi\u00f3 nada.`);
  }
  const ledgerAfterMap: Record<string, string> = {};
  for (const [path, bytes] of [...targetFiles.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) ledgerAfterMap[path] = sha256(bytes);
  const ledgerAfterText = `${JSON.stringify(ledgerAfterMap)}\n`;
  if (Buffer.byteLength(ledgerAfterText) > LEDGER_MAX) throw new SwitchError('unsafe', 'El registro de activos del destino supera 16 KiB; no se cambi\u00f3 nada.');

  // 5. config gate (3.12)
  const configBytes = inputs.bytes.get(CONFIG_KEY);
  const configBefore = digestOf(configBytes);
  const probeConfig = (bytes: Buffer | null): { ok: boolean; message?: string } => {
    const dir = join(txDir, 'probe');
    fs.rmSync(dir, { recursive: true, force: true });
    mkdirs(L.owned, dir);
    if (bytes) fs.writeFileSync(join(dir, 'mdd.config.json'), bytes, { mode: 0o600 });
    const reply = probe(stagedRoot, 'config', dir);
    if (!isRecord(reply) || typeof reply.ok !== 'boolean') throw new SwitchError('probe', 'Respuesta inv\u00e1lida del paquete destino (config).');
    return reply.ok ? { ok: true } : { ok: false, message: typeof reply.message === 'string' ? reply.message : 'configuraci\u00f3n inv\u00e1lida' };
  };
  let config: ConfigStep;
  if (probeConfig(configBytes ?? null).ok) config = { decision: 'keep', before: configBefore, after: configBefore, bytes: configBytes ?? null };
  else {
    const found = configCandidates(L.vp, target.identity).map(set => ({ set, bytes: readBackupConfig(L.vp, set) })).find(candidate => probeConfig(candidate.bytes).ok);
    if (!found) {
      throw new SwitchError('config', `La configuraci\u00f3n actual no es compatible con ${target.identity.version} y no hay un respaldo hecho con ${target.identity.version}. No se cambi\u00f3 nada.`);
    }
    config = found.bytes
      ? { decision: 'restore', before: configBefore, after: sha256(found.bytes), bytes: found.bytes, restoredFrom: found.set.name }
      : { decision: 'remove', before: configBefore, after: null, bytes: null, restoredFrom: found.set.name };
  }
  fs.rmSync(join(txDir, 'probe'), { recursive: true, force: true });

  const editedAssets = steps.filter(step => step.edited).map(step => step.path);
  const plan: SwitchPlan = {
    id, txDir, stageDir, source, target: target.identity, channel: target.channel, selectedAs: target.selectedAs,
    tarballName, tarballSha256: tarSha, targetTreeDigest, targetInstalledJson: sha256(installedJson), targetPackageJson, targetLock,
    before: {
      installedJson: inputs.digests['installedPackageJson'] === 'absent' ? null : inputs.digests['installedPackageJson']!,
      packageJson: inputs.digests['package.json'] === 'absent' ? null : inputs.digests['package.json']!,
      lock: inputs.digests['package-lock.json'] === 'absent' ? null : inputs.digests['package-lock.json']!,
      hadPackage: fs.existsSync(L.pkgRoot),
    },
    assets: steps, targetFiles, ledgerAfterText, ledgerBefore: digestOf(ledger.text === undefined ? undefined : Buffer.from(ledger.text, 'utf8')),
    ledgerAfter: sha256(ledgerAfterText), config, managerRevision, snapshot: inputs.digests, editedAssets, warnings,
    dirty: prepared.dirty, checkout: prepared.checkout, review: [],
  };
  plan.review = reviewLines(plan);
  return plan;
}

function reviewLines(plan: SwitchPlan): string[] {
  const count = (action: AssetStep['action']): number => plan.assets.filter(step => step.action === action).length;
  const lines = [
    `Destino        ${plan.target.kind === 'dev' ? `dev ${plan.target.version} \u00b7 ${plan.target.commit.slice(0, 7)}${plan.dirty ? ' (con cambios sin confirmar)' : ''}` : `${plan.target.version} \u00b7 ${plan.target.commit.slice(0, 7)}`}`,
    `Activos        ${count('create')} nuevos, ${count('replace')} reemplazados, ${count('remove')} eliminados, ${count('keep')} sin cambios`,
  ];
  if (plan.editedAssets.length) lines.push(`Editados       ${plan.editedAssets.join(', ')} (se respaldan antes de reemplazar)`);
  lines.push(`Configuraci\u00f3n  ${plan.config.decision === 'keep' ? 'compatible: se conserva (respaldada antes)' : plan.config.decision === 'restore' ? `incompatible: se restaura el respaldo ${plan.config.restoredFrom}` : `incompatible: se quita (el respaldo ${plan.config.restoredFrom} no tiene configuraci\u00f3n)`}`);
  lines.push('Respaldo       la configuraci\u00f3n y todo activo reemplazado o eliminado se copian a mdd/backups antes de cambiar nada');
  for (const warning of plan.warnings) lines.push(`Aviso          ${warning}`);
  return lines;
}

// ---------------------------------------------------------------- journal helpers

interface SwitchJournal extends Journal {
  tarballName?: string;
  activeRecord?: Record<string, unknown>;
  managerRevision?: number | null;
  ledgerAfterText?: string;
  warnings?: string[];
}

function journalBase(plan: SwitchPlan, phase: JournalPhase): SwitchJournal {
  return {
    schema: 1, id: plan.id, phase, owner: { pid: process.pid, host: hostname() }, source: plan.source, target: plan.target,
  };
}

function itemsFor(plan: SwitchPlan): Record<string, unknown>[] {
  return [
    { kind: 'package', hadPackage: plan.before.hadPackage, beforeInstalledJson: plan.before.installedJson, beforePackageJson: plan.before.packageJson, beforeLock: plan.before.lock,
      afterInstalledJson: plan.targetInstalledJson, afterPackageJson: plan.targetPackageJson, afterLock: plan.targetLock },
    ...plan.assets.filter(step => step.action === 'create' || step.action === 'replace' || step.action === 'remove')
      .map(step => ({ kind: 'asset', path: step.path, action: step.action, before: step.before, after: step.after })),
    { kind: 'config', action: plan.config.decision, before: plan.config.before, after: plan.config.after },
    { kind: 'ledger', before: plan.ledgerBefore, after: plan.ledgerAfter },
    { kind: 'state' },
  ];
}

function activeRecord(plan: SwitchPlan, now: Date): Record<string, unknown> {
  return {
    kind: plan.target.kind, version: plan.target.version, commit: plan.target.commit, channel: plan.channel, selectedAs: plan.selectedAs,
    checkout: plan.target.kind === 'dev' ? plan.checkout ?? null : null, dirty: plan.target.kind === 'dev' ? plan.dirty ?? null : null,
    provenance: 'installed', packageDigest: plan.targetTreeDigest, tarballSha256: plan.tarballSha256, editedAssets: [], activatedAt: now.toISOString(),
  };
}

// ---------------------------------------------------------------- activation

/** Applies a confirmed plan: re-check inputs, back up, swap, commit, post-commit. Holds the lock throughout. */
export function activate(lock: LockHandle, paths: ManagerPaths, plan: SwitchPlan, deps: SwitchDeps = {}): SwitchResult {
  assertHeld(lock);
  const L = layout(paths);
  const now = deps.now ?? (() => new Date());
  const fault = deps.fault ?? (() => {});
  const assetPaths = Object.keys(plan.snapshot).filter(key => !SPECIAL_KEYS.includes(key));

  deps.afterReview?.(plan);
  // Re-snapshot: any difference since the review aborts before anything is written (S37).
  let inputs = captureInputs(L, assetPaths);
  const changed = sameSnapshot(inputs.digests, plan.snapshot);
  if (changed.length) throw new SwitchError('changed', `La instalaci\u00f3n cambi\u00f3 durante la revisi\u00f3n (${changed.slice(0, 5).join(', ')}). No se cambi\u00f3 nada; repet\u00ed el comando.`);

  const record = activeRecord(plan, now());
  const journal: SwitchJournal = {
    ...journalBase(plan, 'backing-up'), tarballName: plan.tarballName, activeRecord: record, managerRevision: plan.managerRevision,
    ledgerAfterText: plan.ledgerAfterText, warnings: plan.warnings, snapshot: plan.snapshot, items: itemsFor(plan),
  };
  writeJournal(lock, journal);
  fault('journal:backing-up');

  // Backup set from bytes read just now, each digest checked against the plan.
  const toBackup = plan.assets.filter(step => step.action === 'replace' || step.action === 'remove');
  let set: BackupSet;
  try {
    const configBytes = inputs.bytes.get(CONFIG_KEY);
    set = createBackup(lock, {
      source: plan.source, target: plan.target, now,
      config: configBytes ? { bytes: configBytes, sha256: sha256(configBytes) } : null,
      assets: toBackup.map(step => {
        const bytes = inputs.bytes.get(step.path);
        if (!bytes || sha256(bytes) !== step.before) throw new SwitchError('changed', `${step.path} cambi\u00f3 antes de respaldarlo. No se cambi\u00f3 nada.`);
        return { path: step.path, bytes, sha256: step.before!, edited: step.edited, action: step.action as 'replace' | 'remove' };
      }),
    });
  } catch (error) {
    abandon(lock, L);
    if (error instanceof SwitchError) throw error;
    throw new SwitchError('backup', `No se pudo crear el respaldo: ${message(error)} No se cambi\u00f3 nada.`);
  }
  fault('backup:written');
  // The inputs must still be what was backed up (an edit during the copy window).
  inputs = captureInputs(L, assetPaths);
  const late = sameSnapshot(inputs.digests, plan.snapshot);
  if (late.length) {
    abandon(lock, L);
    throw new SwitchError('changed', `La instalaci\u00f3n cambi\u00f3 durante el respaldo (${late.slice(0, 5).join(', ')}). No se cambi\u00f3 nada; el respaldo queda por si lo necesit\u00e1s.`);
  }

  journal.backup = `backups/${set.name}`;
  journal.phase = 'activating';
  fs.writeFileSync(join(plan.txDir, plan.ledgerBefore === null ? 'ledger.before.absent' : 'ledger.before.json'), plan.ledgerBefore === null ? '' : readSafe(L.root, LEDGER_NAME, LEDGER_MAX) ?? '', { mode: 0o600 });
  writeJournal(lock, journal);
  fault('journal:activating');

  try {
    swapPackage(L, plan, fault);
    writeAssets(L, plan, fault);
    writeConfigStep(L, plan, set, fault);
    fault('ledger');
    new LocalFiles(L.root).update(LEDGER_NAME, () => plan.ledgerAfterText, LEDGER_MAX);
    verifyActivated(paths, L, plan);
    fault('state');
    commitState(lock, L, plan, record);
    fault('committed');
  } catch (error) {
    // Failure: recovery decides from the bytes. Before the commit it restores the previous installation; once the
    // target is recorded it finishes or blocks, and the report says so instead of claiming a restoration.
    const outcome = recoverJournal(lock, paths, journal, deps);
    const targetActive = outcome.status === 'finished' || outcome.status === 'rolled-forward' || (outcome.status === 'blocked' && stateCommitted(L, journal));
    if (targetActive && outcome.status !== 'blocked') {
      return resultOf(L, plan, set, [...plan.warnings, `Se interrumpi\u00f3 el cierre tras confirmar (${message(error)}); la versi\u00f3n nueva sigue activa. ${outcome.message}`]);
    }
    if (targetActive) throw new SwitchError('blocked', `La versi\u00f3n nueva qued\u00f3 registrada como activa, pero su verificaci\u00f3n fall\u00f3 (${message(error)}). La instalaci\u00f3n anterior NO se restaur\u00f3: ${outcome.message}`);
    if (outcome.status === 'blocked') throw new SwitchError('blocked', `La activaci\u00f3n fall\u00f3 (${message(error)}) y no se pudo revertir sola: ${outcome.message}`);
    throw new SwitchError('activation', `La activaci\u00f3n fall\u00f3 y se restaur\u00f3 la instalaci\u00f3n anterior: ${message(error)}`);
  }
  journal.phase = 'committed';
  writeJournal(lock, journal);
  const warnings = [...plan.warnings, ...postCommit(lock, paths, journal, deps)];
  return resultOf(L, plan, set, warnings);
}

function resultOf(L: Layout, plan: SwitchPlan, set: BackupSet, warnings: string[]): SwitchResult {
  const detail = plan.config.decision === 'keep' ? 'compatible: se conserv\u00f3 (respaldada antes)'
    : plan.config.decision === 'restore' ? `incompatible: se restaur\u00f3 el respaldo ${plan.config.restoredFrom}` : `incompatible: se quit\u00f3 (el respaldo ${plan.config.restoredFrom} no ten\u00eda configuraci\u00f3n)`;
  void L;
  return {
    target: plan.target, channel: plan.channel, backup: set.dir, backupName: set.name,
    edited: plan.assets.filter(step => step.edited).map(step => ({ path: step.path, backup: join(set.dir, 'assets', ...step.path.split('/')) })),
    config: { decision: plan.config.decision, detail }, warnings, restartCommand: RESTART_COMMAND,
  };
}

/** A refusal before any active change: clear the journal and the transaction directory. */
function abandon(lock: LockHandle, L: Layout): void {
  const journal = readJournal(L.vp);
  try { clearJournal(lock); } catch { /* the next lock-taking command recovers */ }
  if (journal) try { fs.rmSync(join(L.vp.txRoot, journal.id), { recursive: true, force: true }); } catch { /* swept later */ }
}

function swapPackage(L: Layout, plan: SwitchPlan, fault: (point: string) => void): void {
  const previous = join(plan.txDir, 'previous');
  mkdirs(L.owned, previous);
  if (exists(L.nodeModules)) rename(L.nodeModules, join(previous, 'node_modules'));
  fault('package-out');
  if (exists(L.pkgJson)) rename(L.pkgJson, join(previous, 'package.json'));
  if (exists(L.lockJson)) rename(L.lockJson, join(previous, 'package-lock.json'));
  rename(join(plan.stageDir, 'node_modules'), L.nodeModules);
  fault('package-in');
  rename(join(plan.stageDir, 'package.json'), L.pkgJson);
  if (exists(join(plan.stageDir, 'package-lock.json'))) rename(join(plan.stageDir, 'package-lock.json'), L.lockJson);
  fs.mkdirSync(L.packages, { recursive: true, mode: 0o700 });
  guard(() => scopedPath(L.owned, L.packages, true));
  const artifact = join(L.packages, plan.tarballName);
  if (!exists(artifact)) {
    const temporary = join(L.packages, `.${plan.tarballName}.${randomBytes(4).toString('hex')}.tmp`);
    fs.copyFileSync(join(plan.stageDir, 'packages', plan.tarballName), temporary, fs.constants.COPYFILE_EXCL);
    rename(temporary, artifact);
  }
  fault('package-done');
}

function currentDigest(L: Layout, path: string): string | null {
  return digestOf(readSafe(L.root, path, INSTALLED_ASSET_MAX));
}

function writeAssets(L: Layout, plan: SwitchPlan, fault: (point: string) => void): void {
  const seen = new Set<string>();
  for (const step of plan.assets) {
    if (step.action === 'keep' || step.action === 'drop') continue;
    // The file must still be exactly what the plan saw; anything else aborts and rolls back.
    if (currentDigest(L, step.path) !== step.before) throw new SwitchError('changed', `${step.path} cambi\u00f3 durante la activaci\u00f3n.`);
    if (step.action === 'remove') {
      unlinkSafe(L.root, step.path);
      pruneEmptySkillDirs(L.root, step.path);
    } else {
      writeAtomic(L.root, step.path, plan.targetFiles.get(step.path)!);
    }
    if (!seen.has(step.action)) { seen.add(step.action); fault(`asset-${step.action}`); }
  }
}

function writeConfigStep(L: Layout, plan: SwitchPlan, set: BackupSet, fault: (point: string) => void): void {
  void set;
  if (plan.config.decision === 'keep') return;
  if (label(digestOf(readSafe(L.owned, L.config, FILE_MAX))) !== label(plan.config.before)) throw new SwitchError('changed', 'mdd.config.json cambi\u00f3 durante la activaci\u00f3n.');
  if (plan.config.decision === 'restore') writeAtomic(L.owned, L.config, plan.config.bytes!);
  else unlinkSafe(L.owned, L.config);
  fault('config');
}

function verifyActivated(paths: ManagerPaths, L: Layout, plan: SwitchPlan): void {
  try { installedPlugin(paths.configRoot); } catch (error) { throw new SwitchError('verify', `El paquete activo no resuelve: ${message(error)}`); }
  if (treeDigest(L.pkgRoot) !== plan.targetTreeDigest) throw new SwitchError('verify', 'El paquete activo no coincide con el preparado.');
  for (const step of plan.assets) {
    if (step.action === 'drop') continue;
    if (currentDigest(L, step.path) !== step.after) throw new SwitchError('verify', `${step.path} no qued\u00f3 con el contenido esperado.`);
  }
  if (label(digestOf(readSafe(L.owned, L.config, FILE_MAX))) !== label(plan.config.after)) throw new SwitchError('verify', 'La configuraci\u00f3n no qued\u00f3 como se planific\u00f3.');
  if (digestOf(readSafe(L.root, LEDGER_NAME, LEDGER_MAX)) !== plan.ledgerAfter) throw new SwitchError('verify', 'El registro de activos no qued\u00f3 como se planific\u00f3.');
}

function commitState(lock: LockHandle, L: Layout, plan: SwitchPlan, record: Record<string, unknown>): void {
  const state = readState(L.vp);
  state.active = record as Identity & Record<string, unknown>;
  if (plan.target.kind === 'release' && !state.releases[plan.target.version]) {
    state.releases[plan.target.version] = { commit: plan.target.commit, firstSeen: String(record.activatedAt) };
  }
  writeState(lock, state);
  const back = readState(L.vp).active;
  if (!back || !sameIdentity(back, plan.target)) throw new SwitchError('verify', 'state.json no refleja la versi\u00f3n activada.');
}

/** Idempotent steps after the commit. Failures become warnings; the journal stays so the next command finishes. */
function postCommit(lock: LockHandle, paths: ManagerPaths, journal: SwitchJournal, deps: SwitchDeps): string[] {
  const fault = deps.fault ?? (() => {});
  const L = layout(paths);
  const warnings: string[] = [];
  let clean = true;
  const attempt = (what: string, work: () => void): void => {
    try { work(); } catch (error) { clean = false; warnings.push(`${what}: ${short(message(error), 300)}`); }
  };
  attempt('enrutamiento del lanzador', () => { fault('post-commit:routing'); ensureRouting(paths); fault('post-commit:routed'); });
  attempt('actualizaci\u00f3n del gestor', () => {
    const revision = journal.managerRevision;
    if (journal.target.kind !== 'release' || revision == null) return;
    if (revision > (readCurrent(paths)?.revision ?? 0)) {
      const result = installManager(join(L.pkgRoot, 'dist'), { revision, version: journal.target.version, source: 'release' }, paths);
      if (result.action === 'installed') warnings.push(`Gestor de versiones actualizado a la revisi\u00f3n ${revision}.`);
    }
  });
  attempt('limpieza de la transacci\u00f3n', () => { fs.rmSync(join(L.vp.txRoot, journal.id), { recursive: true, force: true }); });
  attempt('limpieza de paquetes', () => { pruneOwnedPackages(L); });
  attempt('retenci\u00f3n de respaldos', () => {
    const name = journalBackupName(journal);
    pruneBackups(lock, { protect: name ? [name] : [] });
  });
  attempt('retenci\u00f3n de la cach\u00e9', () => {
    pruneCache(lock, { active: journal.target.kind === 'release' ? journal.target : null });
  });
  if (clean) clearJournal(lock);
  return warnings;
}

/** Keeps the referenced tarball and the newest few; mirrors the historical pruning for `mdd/packages`. */
function pruneOwnedPackages(L: Layout): void {
  if (!fs.existsSync(L.packages)) return;
  const pkgText = readSafe(L.owned, L.pkgJson, FILE_MAX)?.toString('utf8');
  const pkg = pkgText ? (JSON.parse(pkgText) as Record<string, unknown>) : {};
  const referenced = ['dependencies', 'devDependencies'].map(field => (isRecord(pkg[field]) ? (pkg[field] as Record<string, unknown>)[PACKAGE_NAME] : undefined))
    .filter((value): value is string => typeof value === 'string' && value.startsWith('file:')).map(value => value.slice(5).replaceAll('\\', '/').split('/').at(-1));
  const entries = fs.readdirSync(L.packages).filter(name => /^my-driven-development-[0-9a-f]{64}\.tgz$/.test(name))
    .map(name => ({ name, time: fs.statSync(join(L.packages, name)).mtimeMs })).sort((a, b) => b.time - a.time);
  entries.forEach((entry, index) => {
    if (index < KEPT_PACKAGES || referenced.includes(entry.name)) return;
    fs.rmSync(scopedPath(L.owned, `packages/${entry.name}`), { force: true });
  });
}

// ---------------------------------------------------------------- recovery

export interface RecoverResult {
  status: 'none' | 'rolled-back' | 'rolled-forward' | 'finished' | 'blocked';
  message: string;
}

type ItemState = 'before' | 'after' | 'partial' | 'foreign';

function observeItems(L: Layout, journal: SwitchJournal): { states: ItemState[]; items: Record<string, unknown>[] } {
  const items = journal.items ?? [];
  const txDir = join(L.vp.txRoot, journal.id);
  const states = items.map((item): ItemState => {
    const kind = item.kind;
    if (kind === 'asset') {
      const cur = currentDigest(L, String(item.path));
      if (cur === item.before) return 'before';
      if (cur === item.after) return 'after';
      return 'foreign';
    }
    if (kind === 'config') {
      if (item.action === 'keep') return 'before';
      const cur = digestOf(readSafe(L.owned, L.config, FILE_MAX));
      if (cur === item.before) return 'before';
      if (cur === item.after) return 'after';
      return 'foreign';
    }
    if (kind === 'ledger') {
      const cur = digestOf(readSafe(L.root, LEDGER_NAME, LEDGER_MAX));
      if (cur === item.before) return 'before';
      if (cur === item.after) return 'after';
      return 'foreign';
    }
    if (kind === 'package') {
      const nm = digestOf(readSafe(L.pkgRoot, join(L.pkgRoot, 'package.json'), FILE_MAX));
      const pj = digestOf(readSafe(L.owned, L.pkgJson, FILE_MAX));
      const lk = digestOf(readSafe(L.owned, L.lockJson, 16 * FILE_MAX));
      if (nm === item.afterInstalledJson && pj === item.afterPackageJson && lk === item.afterLock) return 'after';
      if (nm === item.beforeInstalledJson && pj === item.beforePackageJson && lk === item.beforeLock) return 'before';
      const previous = join(txDir, 'previous');
      const moved = exists(previous) && fs.readdirSync(previous).length > 0;
      const known = (value: string | null, ...options: unknown[]): boolean => options.includes(value);
      if (moved && known(nm, item.afterInstalledJson, item.beforeInstalledJson, null) && known(pj, item.afterPackageJson, item.beforePackageJson, null) && known(lk, item.afterLock, item.beforeLock, null)) return 'partial';
      return 'foreign';
    }
    return 'before'; // the state item is judged by state.json itself
  });
  return { states, items };
}

function stateCommitted(L: Layout, journal: SwitchJournal): boolean {
  const active = readState(L.vp).active;
  const record = journal.activeRecord;
  return !!active && !!record && JSON.stringify(active) === JSON.stringify(record);
}

/** Full check of a committed target: tree digest vs the recorded one, retained config accepted by the target, ledger. */
function verifyCommittedTarget(paths: ManagerPaths, L: Layout, journal: SwitchJournal, deps: SwitchDeps): string | undefined {
  const record = journal.activeRecord;
  try {
    if (typeof record?.packageDigest === 'string' && treeDigest(L.pkgRoot) !== record.packageDigest) return 'el paquete instalado no coincide con el preparado (bytes ajenos)';
    const ledger = (journal.items ?? []).find(item => item.kind === 'ledger');
    if (ledger && digestOf(readSafe(L.root, LEDGER_NAME, LEDGER_MAX)) !== ledger.after) return 'el registro de activos no coincide con el del destino';
    const dir = join(L.vp.txRoot, journal.id, 'probe-recovery');
    fs.rmSync(dir, { recursive: true, force: true });
    mkdirs(L.owned, dir);
    try {
      const bytes = readSafe(L.owned, L.config, FILE_MAX);
      if (bytes) fs.writeFileSync(join(dir, 'mdd.config.json'), bytes, { mode: 0o600 });
      const reply = (deps.probe ?? runProbe)(L.pkgRoot, 'config', dir);
      if (!isRecord(reply) || reply.ok !== true) return 'la configuraci\u00f3n conservada no es compatible con la versi\u00f3n activa';
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } catch (error) {
    return `no se pudo verificar el destino (${short(message(error), 200)})`;
  }
  void paths;
  return undefined;
}

function block(lock: LockHandle, L: Layout, journal: SwitchJournal, reason: string): RecoverResult {
  const txDir = join(L.vp.txRoot, journal.id);
  const text = `Cambio de versi\u00f3n incompleto: ${reason} Datos de recuperaci\u00f3n: ${txDir}${journal.backup ? `, ${journal.backup}` : ''}. No los borres; volv\u00e9 a ejecutar cualquier comando mdd-ai para reintentar.`;
  try { writeJournal(lock, { ...journal, phase: 'blocked', blocked: { reason, at: new Date().toISOString() } }); } catch { /* keep the existing journal */ }
  return { status: 'blocked', message: text };
}

/** Recovery of an interrupted switch, looking at actual bytes; call at the start of every lock-taking command. */
export function recover(lock: LockHandle, paths: ManagerPaths, deps: SwitchDeps = {}): RecoverResult {
  assertHeld(lock);
  const L = layout(paths);
  let journal: SwitchJournal | undefined;
  try { journal = readJournal(L.vp) as SwitchJournal | undefined; }
  catch (error) { return { status: 'blocked', message: `El journal de cambio de versi\u00f3n est\u00e1 da\u00f1ado (${message(error)}); no se modific\u00f3 nada.` }; }
  if (!journal) {
    sweepTx(L);
    return { status: 'none', message: '' };
  }
  return recoverJournal(lock, paths, journal, deps);
}

function sweepTx(L: Layout): void {
  try { for (const name of fs.readdirSync(L.vp.txRoot)) fs.rmSync(scopedPath(L.owned, join(L.vp.txRoot, name), true), { recursive: true, force: true }); } catch { /* none */ }
}

function recoverJournal(lock: LockHandle, paths: ManagerPaths, journal: SwitchJournal, deps: SwitchDeps): RecoverResult {
  const L = layout(paths);
  const txDir = join(L.vp.txRoot, journal.id);
  const finishClean = (status: RecoverResult['status'], text: string): RecoverResult => {
    try { fs.rmSync(txDir, { recursive: true, force: true }); } catch { /* swept later */ }
    clearJournal(lock);
    try { pruneBackups(lock); } catch { /* retention is best effort */ }
    return { status, message: text };
  };
  try {
    if (journal.phase === 'preparing' || journal.phase === 'backing-up') {
      return finishClean('rolled-back', 'Se cancel\u00f3 un cambio de versi\u00f3n que no lleg\u00f3 a modificar la instalaci\u00f3n.');
    }
    const { states, items } = observeItems(L, journal);
    const foreign = items.filter((_, index) => states[index] === 'foreign').map(item => String(item.path ?? item.kind));
    if (foreign.length) return block(lock, L, journal, `hay cambios ajenos que no se pueden revertir ni completar (${foreign.join(', ')}).`);

    if (stateCommitted(L, journal)) {
      // The target is recorded as active: its whole prepared tree and the retained config must be what the record says
      // before any transaction evidence is discarded (R9, invariants 2, 4, 7).
      const wrong = verifyCommittedTarget(paths, L, journal, deps);
      if (wrong) return block(lock, L, journal, `la versi\u00f3n figura como activa pero ${wrong}.`);
      if (items.every((item, index) => item.kind === 'state' || (item.kind === 'config' && item.action === 'keep') || states[index] === 'after')) {
        const warnings = postCommit(lock, paths, journal, deps);
        return { status: 'finished', message: warnings.length ? `Se complet\u00f3 un cambio confirmado (${warnings.join('; ')}).` : 'Se complet\u00f3 un cambio de versi\u00f3n ya confirmado.' };
      }
      return block(lock, L, journal, 'la versi\u00f3n figura como activa pero la instalaci\u00f3n no coincide.');
    }
    if (journal.phase === 'committed') return block(lock, L, journal, 'el journal figura confirmado pero state.json no coincide.');

    const nothingDone = items.every((item, index) => item.kind === 'state' || states[index] === 'before');
    if (nothingDone) return finishClean('rolled-back', 'Se cancel\u00f3 un cambio de versi\u00f3n que no lleg\u00f3 a modificar la instalaci\u00f3n.');

    const missing = rollbackMaterialMissing(L, journal, items, states);
    if (missing) {
      const allAfter = items.every((item, index) => item.kind === 'state' || item.kind === 'config' && item.action === 'keep' || states[index] === 'after');
      if (allAfter && forwardPossible(paths, L, journal, deps)) return rollForward(lock, paths, L, journal, deps);
      return block(lock, L, journal, `falta material para revertir (${missing}).`);
    }
    rollback(L, journal, items, states);
    const now = captureInputs(L, Object.keys(journal.snapshot ?? {}).filter(key => !SPECIAL_KEYS.includes(key)));
    const wrong = sameSnapshot(now.digests, journal.snapshot ?? {});
    if (wrong.length) return block(lock, L, journal, `tras revertir, la instalaci\u00f3n no coincide con la anterior (${wrong.slice(0, 5).join(', ')}).`);
    return finishClean('rolled-back', 'Se revirti\u00f3 un cambio de versi\u00f3n incompleto; la instalaci\u00f3n qued\u00f3 como estaba.');
  } catch (error) {
    if (error instanceof SwitchError && error.code === 'blocked') return block(lock, L, journal, error.message);
    return block(lock, L, journal, `no se pudo recuperar solo (${short(message(error), 300)}).`);
  }
}

function backupSet(L: Layout, journal: SwitchJournal): BackupSet | undefined {
  const name = journalBackupName(journal);
  return name ? validateBackup(L.vp, name) : undefined;
}

function rollbackMaterialMissing(L: Layout, journal: SwitchJournal, items: Record<string, unknown>[], states: ItemState[]): string | undefined {
  const set = backupSet(L, journal);
  const needsBackup = items.some((item, index) => states[index] !== 'before' && ((item.kind === 'asset' && item.action !== 'create') || (item.kind === 'config' && item.action !== 'keep')));
  if (needsBackup && !set) return 'el respaldo no es v\u00e1lido';
  const package_ = items.findIndex(item => item.kind === 'package');
  const pkg = items[package_];
  if (pkg && states[package_] !== 'before' && pkg.hadPackage === true && !exists(join(L.vp.txRoot, journal.id, 'previous', 'node_modules')) && states[package_] === 'after') {
    return 'falta el paquete anterior';
  }
  const ledger = items.findIndex(item => item.kind === 'ledger');
  if (ledger >= 0 && states[ledger] !== 'before' && !exists(join(L.vp.txRoot, journal.id, 'ledger.before.json')) && !exists(join(L.vp.txRoot, journal.id, 'ledger.before.absent'))) return 'falta el registro anterior';
  return undefined;
}

function rollback(L: Layout, journal: SwitchJournal, items: Record<string, unknown>[], states: ItemState[]): void {
  const txDir = join(L.vp.txRoot, journal.id);
  const set = backupSet(L, journal);
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    const state = states[index]!;
    if (state === 'before') continue;
    if (item.kind === 'ledger') {
      const saved = join(txDir, 'ledger.before.json');
      if (exists(saved)) writeAtomic(L.root, LEDGER_NAME, fs.readFileSync(saved));
      else unlinkSafe(L.root, LEDGER_NAME);
    } else if (item.kind === 'config') {
      const original = set ? readBackupConfig(L.vp, set) : null;
      if (original) writeAtomic(L.owned, L.config, original); else unlinkSafe(L.owned, L.config);
    } else if (item.kind === 'asset') {
      const path = String(item.path);
      if (item.action === 'create') { unlinkSafe(L.root, path); pruneEmptySkillDirs(L.root, path); }
      else {
        const bytes = set ? readBackupAsset(L.vp, set, path) : undefined;
        if (!bytes || sha256(bytes) !== item.before) throw new SwitchError('blocked', `falta el respaldo de ${path}.`);
        writeAtomic(L.root, path, bytes);
      }
    } else if (item.kind === 'package') rollbackPackage(L, txDir, item);
  }
}

function rollbackPackage(L: Layout, txDir: string, item: Record<string, unknown>): void {
  const previous = join(txDir, 'previous');
  const restore = (from: string, to: string, directory: boolean): void => {
    if (exists(to)) fs.rmSync(to, { recursive: directory, force: true });
    rename(from, to);
  };
  const dropTarget = (path: string, expected: unknown, directory: boolean, probePath: string): void => {
    if (!exists(path)) return;
    const digest = directory ? digestOf(readSafe(path, probePath, FILE_MAX)) : digestOf(readSafe(L.owned, path, 16 * FILE_MAX));
    if (digest !== expected) throw new SwitchError('blocked', `${path} no es el paquete destino ni el anterior.`);
    fs.rmSync(path, { recursive: directory, force: true });
  };
  if (exists(join(previous, 'node_modules'))) restore(join(previous, 'node_modules'), L.nodeModules, true);
  else if (item.hadPackage !== true) dropTarget(L.nodeModules, item.afterInstalledJson, true, join(L.pkgRoot, 'package.json'));
  if (exists(join(previous, 'package.json'))) restore(join(previous, 'package.json'), L.pkgJson, false);
  else if (item.beforePackageJson == null) dropTarget(L.pkgJson, item.afterPackageJson, false, L.pkgJson);
  if (exists(join(previous, 'package-lock.json'))) restore(join(previous, 'package-lock.json'), L.lockJson, false);
  else if (item.beforeLock == null) dropTarget(L.lockJson, item.afterLock, false, L.lockJson);
}

function forwardPossible(paths: ManagerPaths, L: Layout, journal: SwitchJournal, deps: SwitchDeps): boolean {
  if (!journal.activeRecord || !journal.ledgerAfterText) return false;
  try {
    installedPlugin(paths.configRoot);
    const reply = (deps.probe ?? runProbe)(L.pkgRoot, 'assets');
    return isRecord(reply) && Array.isArray(reply.files);
  } catch { return false; }
}

function rollForward(lock: LockHandle, paths: ManagerPaths, L: Layout, journal: SwitchJournal, deps: SwitchDeps): RecoverResult {
  const state = readState(L.vp);
  state.active = journal.activeRecord as Identity & Record<string, unknown>;
  if (journal.target.kind === 'release' && !state.releases[journal.target.version]) {
    state.releases[journal.target.version] = { commit: journal.target.commit, firstSeen: String(journal.activeRecord?.activatedAt) };
  }
  writeState(lock, state);
  writeJournal(lock, { ...journal, phase: 'committed' });
  const warnings = postCommit(lock, paths, journal, deps);
  return { status: 'rolled-forward', message: `Se complet\u00f3 hacia adelante un cambio incompleto porque no hab\u00eda material para revertirlo${warnings.length ? ` (${warnings.join('; ')})` : ''}.` };
}

// ---------------------------------------------------------------- orchestration

/** True when the target is already installed from its own tag, untouched since (S32). Dev is never "already". */
export function isAlreadyActive(paths: ManagerPaths, identity: Identity): boolean {
  const L = layout(paths);
  const active = readState(L.vp).active;
  if (!active || identity.kind !== 'release' || !sameIdentity(active, identity) || active.provenance !== 'installed') return false;
  try { return installedPackageDigest(paths) === active.packageDigest; } catch { return false; }
}

/**
 * The whole flow: recover, already-active check, prepare, stage, verify, plan, confirm, activate.
 * The caller holds the lock and prints the target identity and notes before calling.
 */
export async function switchTo(lock: LockHandle, paths: ManagerPaths, target: SwitchTarget, deps: SwitchDeps = {}): Promise<SwitchOutcome> {
  assertHeld(lock);
  const L = layout(paths);
  const recovered = recover(lock, paths, deps);
  if (recovered.status === 'blocked') throw new SwitchError('blocked', recovered.message);
  if (isAlreadyActive(paths, target.identity)) return { status: 'already', identity: target.identity };

  const id = (deps.id ?? (() => randomBytes(4).toString('hex')))();
  const pinned: SwitchDeps = { ...deps, id: () => id };
  writeJournal(lock, { schema: 1, id, phase: 'preparing', owner: { pid: process.pid, host: hostname() }, source: readState(L.vp).active ? identityOf(readState(L.vp).active!) : null, target: target.identity });
  const dropPreparation = (): void => {
    try { clearJournal(lock); } catch { /* recovered next time */ }
    try { fs.rmSync(join(L.vp.txRoot, id), { recursive: true, force: true }); } catch { /* swept later */ }
  };
  let plan: SwitchPlan;
  try {
    const prepared = target.prepare();
    plan = planSwitch(lock, paths, target, prepared, pinned);
    if (deps.confirm && !(await deps.confirm(plan))) {
      dropPreparation();
      return { status: 'cancelled' };
    }
  } catch (error) {
    dropPreparation();
    throw error;
  }
  try {
    return { status: 'switched', result: activate(lock, paths, plan, pinned) };
  } catch (error) {
    // `activate` has already cleaned up or recovered; make sure a pre-activation refusal leaves no journal behind.
    const left = readJournal(L.vp);
    if (left && left.id === id && left.phase !== 'blocked' && left.phase !== 'committed' && left.phase !== 'activating') dropPreparation();
    throw error;
  }
}

const identityOf = (value: Identity): Identity => ({ kind: value.kind, version: value.version, commit: value.commit });

/** Spanish success text (R15); the restart command is printed, never executed. Only for completed switches. */
export function formatSwitchResult(result: SwitchResult): string[] {
  const kind = result.channel === 'dev' ? `dev \u00b7 ${result.target.commit.slice(0, 7)}` : `${result.channel === 'stable' ? 'estable' : 'preview'} \u00b7 ${result.target.commit.slice(0, 7)}`;
  const lines = [
    `Listo: ${result.target.version} activa (${kind}).`,
    `  Respaldo     ${result.backup}`,
    ...result.edited.map(item => `  Editado a mano  ${item.path} \u2192 ${item.backup}`),
    `  Configuraci\u00f3n   ${result.config.detail}`,
    ...result.warnings.map(warning => `  Aviso        ${warning}`),
    `  Reinici\u00e1 el servicio cuando no haya trabajo en curso: ${result.restartCommand}`,
    '  El servicio en ejecuci\u00f3n puede tener cargados los m\u00f3dulos de la versi\u00f3n anterior.',
  ];
  return lines;
}

// ---------------------------------------------------------------- adoption (3.16)

export interface AdoptionOptions {
  /** `git show <baseline>:<path>`; absent or returning `undefined` leaves that file "unverified". */
  readBaselineFile?: (path: string) => Buffer | undefined;
  probe?: ProbeFn;
  now?: () => Date;
}

export interface AdoptionResult {
  status: 'adopted' | 'already' | 'absent' | 'refused';
  message: string;
  editedAssets: string[];
  differing: string[];
  verified?: { packageJson: boolean; packagedAssets: boolean; dist: false };
  ledgerMissing?: boolean;
  configValid?: boolean | null;
}

/** Adopts an existing unmanaged 0.2.0 installation as stable 0.2.0 (adoptada). Changes only state.json. */
export function adoptInstallation(lock: LockHandle, paths: ManagerPaths, options: AdoptionOptions = {}): AdoptionResult {
  assertHeld(lock);
  const L = layout(paths);
  const probe = options.probe ?? runProbe;
  const now = (options.now ?? (() => new Date()))();
  const state = readState(L.vp);
  const none = { editedAssets: [] as string[], differing: [] as string[] };
  if (state.active) return { status: 'already', message: 'La instalaci\u00f3n ya est\u00e1 adoptada; no se cambi\u00f3 nada.', ...none };

  const refuse = (reason: string, differing: string[] = []): AdoptionResult => {
    state.adoption = { status: 'refused', reason, at: now.toISOString() };
    writeState(lock, state);
    return { status: 'refused', message: reason, editedAssets: [], differing };
  };
  let resolved: string | undefined;
  try { resolved = installedPlugin(L.root); } catch { /* inspected below */ }
  if (!resolved) {
    if (!ownedLeftovers(L.root)) return { status: 'absent', message: 'No hay una instalaci\u00f3n de MDD para adoptar; instalaci\u00f3n nueva.', ...none };
    return refuse('Hay restos de un paquete MDD que no resuelven. No se adopta; repar\u00e1lo a mano o eleg\u00ed una versi\u00f3n con mdd-ai use.');
  }
  const root = dirname(dirname(resolved));
  let installedPkg: Record<string, unknown> = {};
  try { const parsed: unknown = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')); if (isRecord(parsed)) installedPkg = parsed; } catch { /* mismatch below */ }
  if (installedPkg.name !== PACKAGE_NAME || installedPkg.version !== BASELINE.version) {
    return refuse(`La instalaci\u00f3n es ${String(installedPkg.name)}@${String(installedPkg.version)} y se esperaba ${PACKAGE_NAME}@${BASELINE.version}. No se adopta; us\u00e1 mdd-ai use ${BASELINE.version} (reinstala con respaldos) o mdd-ai use dev.`);
  }
  // Raw packaged files against the baseline blobs.
  const list = probePaths(probe(root, 'packaged'));
  const differing: string[] = [];
  let unverified = 0;
  for (const path of list) {
    const base = options.readBaselineFile?.(path);
    if (!base) { unverified++; continue; }
    const installed = readSafe(root, join(root, ...path.split('/')), FILE_MAX);
    if (!installed || !installed.equals(base)) differing.push(path);
  }
  if (differing.length) {
    return refuse(`Los archivos empaquetados difieren de la l\u00ednea base ${BASELINE.commit.slice(0, 7)} (${differing.slice(0, 5).join(', ')}). No se adopta; us\u00e1 mdd-ai use ${BASELINE.version}.`, differing);
  }
  // Deployed assets: edited ones are listed and kept.
  const targets = probeFiles(probe(root, 'assets'), 'assets');
  const editedAssets: string[] = [];
  for (const file of targets) {
    const current = readSafe(L.root, join(L.root, ...file.path.split('/')), INSTALLED_ASSET_MAX);
    if (current && !current.equals(Buffer.from(file.content, 'utf8'))) editedAssets.push(file.path);
  }
  const ledgerMissing = readSafe(L.root, join(L.root, ...LEDGER_NAME.split('/')), LEDGER_MAX) === undefined;
  let configValid: boolean | null = null;
  try {
    const configBytes = readConfig(L);
    const dir = join(L.vp.txRoot, `adopt-${randomBytes(3).toString('hex')}`);
    mkdirs(L.owned, dir);
    try {
      if (configBytes) fs.writeFileSync(join(dir, 'mdd.config.json'), configBytes, { mode: 0o600 });
      const reply = probe(root, 'config', dir);
      configValid = isRecord(reply) && typeof reply.ok === 'boolean' ? reply.ok : null;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  } catch { configValid = null; }

  const verified = { packageJson: true, packagedAssets: unverified === 0, dist: false as const };
  state.active = {
    kind: 'release', version: BASELINE.version, commit: BASELINE.commit, checkout: null, dirty: null, channel: 'stable', selectedAs: BASELINE.version,
    provenance: 'adopted', packageDigest: treeDigest(root), verified, editedAssets, activatedAt: now.toISOString(),
  };
  state.adoption = { status: 'adopted', reason: '', at: now.toISOString() };
  if (!state.releases[BASELINE.version]) state.releases[BASELINE.version] = { commit: BASELINE.commit, firstSeen: now.toISOString() };
  writeState(lock, state);
  const notes = ['build no verificado'];
  if (unverified) notes.push(`${unverified} archivos empaquetados sin verificar`);
  if (ledgerMissing) notes.push('falta el registro de activos');
  if (editedAssets.length) notes.push(`editados a mano y conservados: ${editedAssets.join(', ')}`);
  return { status: 'adopted', message: `estable ${BASELINE.version} (adoptada) \u00b7 ${notes.join(' \u00b7 ')}`, editedAssets, differing: [], verified, ledgerMissing, configValid };
}

/** Labels for the listing of backups made for a source version (used by doctor and `versions`). */
export function backupSummary(paths: ManagerPaths): { name: string; seq: number; source: string; target: string }[] {
  return listBackups(layout(paths).vp).valid.map(set => ({ name: set.name, seq: set.seq, source: identityLabel(set.source), target: identityLabel(set.target) }));
}
