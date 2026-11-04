import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gitExecutable } from './judgment-day.js';
import { scopedPath } from './safe-paths.js';
import { retryTransient } from './local-files.js';
import { assertHeld, versionPaths } from './version-store.js';
import type { Identity, LockHandle, VersionState } from './version-store.js';
import { BASELINE, changelogSection, channelOf, compareVersions, isEligible, parseReleaseTag, resolveChannel, satisfiesEngines } from './versions.js';
import type { Channel } from './versions.js';

// Owned bare clone, tag discovery, release/dev preparation and the build cache. Nothing here writes the
// active installation: results are tarballs plus the identity they were built from.

export type SourceErrorCode =
  | 'cache' | 'fetch' | 'checkout' | 'identity' | 'prerequisites' | 'dependencies' | 'build' | 'pack' | 'store' | 'conflict' | 'dev-checkout' | 'origin';

const STAGES: Record<SourceErrorCode, string> = {
  cache: 'caché', fetch: 'descarga', checkout: 'extracción', identity: 'identidad', prerequisites: 'requisitos',
  dependencies: 'dependencias', build: 'compilación', pack: 'empaquetado', store: 'almacenamiento', conflict: 'conflicto',
  'dev-checkout': 'checkout de desarrollo', origin: 'origen',
};

/** A failed preparation stage; `code` is the stable key, `stage` the Spanish name shown to the owner. */
export class SourceError extends Error {
  readonly stage: string;
  constructor(readonly code: SourceErrorCode, label: string, detail: string) {
    const stage = STAGES[code];
    super(`Falló la preparación de ${label} en la etapa «${stage}»: ${detail} No se cambió la instalación activa.`);
    this.name = 'SourceError';
    this.stage = stage;
  }
}

export const FETCH_TIMEOUT_MS = 60000;
/** Deadline for the whole origin refresh done by doctor (clone setup + fetch); normal commands use FETCH_TIMEOUT_MS. */
export const DOCTOR_TIMEOUT_MS = 15000;
export const INSTALL_TIMEOUT_MS = 10 * 60000;
export const BUILD_TIMEOUT_MS = 5 * 60000;
export const PACK_TIMEOUT_MS = 2 * 60000;
export const TARBALL_MAX = 32 * 1024 * 1024;
export const PREVIEWS_KEPT = 3;
const OUTPUT_MAX = 16 * 1024 * 1024;
const DIAGNOSTIC_MAX = 2048;
const OBSERVED = 'refs/mdd/observed/';
const REFSPEC = `+refs/tags/v*:${OBSERVED}v*`;
const PACKAGE_NAME = 'my-driven-development';

export function sourcePaths(ownedRoot: string) {
  const base = versionPaths(ownedRoot);
  return Object.freeze({
    ...base,
    repoPath: join(base.versionsRoot, 'repo.git'),
    noHooks: join(base.versionsRoot, 'no-hooks'),
    cacheRoot: join(base.versionsRoot, 'cache'),
    buildRoot: join(base.versionsRoot, 'build'),
  });
}
export type SourcePaths = ReturnType<typeof sourcePaths>;

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function ensureDir(paths: SourcePaths, directory: string): void {
  const base = paths.ownedRoot;
  const parts = relative(base, resolve(directory)).split(sep).filter(Boolean);
  if (parts[0] === '..' || isAbsolute(parts[0] ?? '')) throw new Error('Directory is outside the owned root.');
  if (!fs.lstatSync(base, { throwIfNoEntry: false })) fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) fs.mkdirSync(current, { mode: 0o700 });
    scopedPath(base, current, true);
  }
}

function writeAtomic(paths: SourcePaths, path: string, data: Buffer | string): void {
  ensureDir(paths, dirname(path));
  const target = scopedPath(paths.ownedRoot, path);
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    retryTransient(() => fs.renameSync(temporary, target));
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Creates the owned directories (versions, no-hooks, cache, build). */
export function ensureLayout(paths: SourcePaths): void {
  for (const directory of [paths.versionsRoot, paths.noHooks, paths.cacheRoot, paths.buildRoot]) ensureDir(paths, directory);
}

// ---------------------------------------------------------------- process execution

const REMOVED_ENV = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
];

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of REMOVED_ENV) delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Bounded tail of a failed process's output (stderr first), at most 2 KiB. */
export function diagnostic(error: unknown): string {
  const raw = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const text = [raw?.stderr, raw?.stdout].map(part => (part ? part.toString() : '').trim()).find(Boolean) ?? (error instanceof Error ? error.message : String(error));
  const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
  const detail = clean.length > DIAGNOSTIC_MAX ? `…${clean.slice(-DIAGNOSTIC_MAX)}` : clean;
  return detail.endsWith('.') ? detail : `${detail}.`;
}

const gitCache = new Map<string, string>();

interface GitOptions { cwd?: string; timeout?: number }
function runGit(paths: SourcePaths, args: readonly string[], options: GitOptions = {}): string {
  return runGitRaw(paths, args, options, 'utf8') as string;
}
function runGitRaw(paths: SourcePaths, args: readonly string[], options: GitOptions, encoding: 'utf8' | 'buffer'): string | Buffer {
  let executable = gitCache.get(paths.versionsRoot);
  if (!executable) { executable = gitExecutable(paths.versionsRoot); gitCache.set(paths.versionsRoot, executable); }
  return execFileSync(executable, [
    '-c', `core.hooksPath=${paths.noHooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.symlinks=false', ...args,
  ], { cwd: options.cwd ?? paths.versionsRoot, env: gitEnv(), encoding, timeout: options.timeout ?? FETCH_TIMEOUT_MS, maxBuffer: OUTPUT_MAX, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Runs a git command that talks to the origin with a hard deadline. Output goes to files, not pipes: on a
 * timeout only `git` itself is killed and its `git-remote-*` helper may linger holding inherited pipes, which
 * would keep a piped `spawnSync` waiting far beyond the deadline. The helper also gets a low-speed abort so a
 * silent server cannot keep an orphan alive.
 */
function runGitNetwork(paths: SourcePaths, args: readonly string[], timeout: number): void {
  let executable = gitCache.get(paths.versionsRoot);
  if (!executable) { executable = gitExecutable(paths.versionsRoot); gitCache.set(paths.versionsRoot, executable); }
  const scratch = fs.mkdtempSync(join(os.tmpdir(), 'mdd-git-'));
  const errPath = join(scratch, 'stderr');
  const errFd = fs.openSync(errPath, 'w');
  try {
    const result = spawnSync(executable, [
      '-c', `core.hooksPath=${paths.noHooks}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.symlinks=false',
      '-c', 'http.lowSpeedLimit=1', '-c', `http.lowSpeedTime=${Math.max(1, Math.ceil(timeout / 1000))}`, ...args,
    ], { cwd: paths.versionsRoot, env: gitEnv(), timeout, windowsHide: true, stdio: ['ignore', 'ignore', errFd] });
    if (result.error || result.status !== 0) {
      let stderr = '';
      try { stderr = fs.readFileSync(errPath, 'utf8').slice(-DIAGNOSTIC_MAX); } catch { /* no output */ }
      const failure = result.error ?? new Error(`git terminó con código ${String(result.status)}`);
      throw Object.assign(new Error(failure.message), { stderr });
    }
  } finally {
    fs.closeSync(errFd);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** npm CLI beside Node: `npm_execpath`, then the Windows layout, then the POSIX `lib/node_modules` layout. */
export function npmCli(): string | undefined {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find((path): path is string => !!path && /^npm/i.test(basename(path)) && fs.existsSync(path));
}

export interface SourceDeps {
  /** Replaces the npm runner (`ci`, `run build`, `pack`); receives the arguments after the npm CLI. Returns stdout. */
  npm?: (args: readonly string[], cwd: string, timeout: number) => string;
  nodeVersion?: string;
  now?: () => Date;
  id?: () => string;
}

function npmRunner(deps: SourceDeps): ((args: readonly string[], cwd: string, timeout: number) => string) | undefined {
  if (deps.npm) return deps.npm;
  const cli = npmCli();
  if (!cli) return undefined;
  return (args, cwd, timeout) => execFileSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', timeout, maxBuffer: OUTPUT_MAX, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------- origin, clone, fetch

/** Accepts https, ssh, scp-like `git@host:path`, file URLs and absolute paths; rejects options and control characters. */
export function validateOrigin(origin: unknown): string {
  if (typeof origin !== 'string' || !origin || origin.length > 2048 || origin.startsWith('-') || /[\x00-\x1f\x7f]/.test(origin)) {
    throw new SourceError('origin', 'el origen', 'La URL del origen no es válida.');
  }
  if (!/^(?:https:\/\/|ssh:\/\/|file:\/\/|git@[^\s:]+:)/.test(origin) && !isAbsolute(origin)) {
    throw new SourceError('origin', 'el origen', 'El origen debe ser https, ssh, file, git@host:ruta o una ruta absoluta.');
  }
  return origin;
}

/** Creates (or reuses) the owned bare clone and points `origin` at the recorded URL. */
export function ensureClone(paths: SourcePaths, origin: string, timeout: number = FETCH_TIMEOUT_MS): void {
  validateOrigin(origin);
  ensureLayout(paths);
  try {
    if (!fs.existsSync(join(paths.repoPath, 'HEAD'))) runGit(paths, ['init', '--bare', '--quiet', paths.repoPath], { timeout });
    scopedPath(paths.ownedRoot, paths.repoPath, true);
    runGit(paths, ['-C', paths.repoPath, 'config', 'remote.origin.url', origin], { timeout });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError('fetch', 'el clon propio', diagnostic(error));
  }
}

export interface FetchResult { ok: boolean; fetchedAt: Date | undefined; error?: string }

/** Time of the last successful fetch (mtime of FETCH_HEAD), so no state write is needed. */
export function lastFetchTime(paths: SourcePaths): Date | undefined {
  const stat = fs.statSync(join(paths.repoPath, 'FETCH_HEAD'), { throwIfNoEntry: false });
  return stat ? new Date(stat.mtimeMs) : undefined;
}

/** Fetches every `v*` tag into `refs/mdd/observed/`. Failure is a result (stale data), never a throw. */
export function fetchTags(paths: SourcePaths, origin: string, timeout: number = FETCH_TIMEOUT_MS): FetchResult {
  try {
    ensureClone(paths, origin, timeout);
    runGitNetwork(paths, ['-C', paths.repoPath, 'fetch', '--quiet', '--no-tags', '--prune', 'origin', REFSPEC], timeout);
    return { ok: true, fetchedAt: lastFetchTime(paths) };
  } catch (error) {
    return { ok: false, fetchedAt: lastFetchTime(paths), error: error instanceof SourceError ? error.message : diagnostic(error) };
  }
}

/** Raw bytes of `path` at `commit` in the owned clone, or `undefined` when the object or path is missing. */
export function showAt(paths: SourcePaths, commit: string, path: string): Buffer | undefined {
  if (!COMMIT_ID.test(commit) || !/^[\w.@+-]+(?:\/[\w.@+-]+)*$/.test(path)) return undefined;
  try { return runGitRaw(paths, ['-C', paths.repoPath, 'cat-file', 'blob', `${commit}:${path}`], {}, 'buffer') as Buffer; }
  catch { return undefined; }
}

// ---------------------------------------------------------------- observed tags

export type TagStatus = 'eligible' | 'unsupported' | 'invalid-identity' | 'conflict' | 'missing-remote';

export interface ObservedTag {
  tag: string;
  /** Present when the tag grammar parsed as an eligible version. */
  version?: string;
  commit?: string;
  status: TagStatus;
  reason?: string;
}

const short = (commit: string): string => commit.slice(0, 7);

function recordedCommit(state: VersionState, version: string): string | undefined {
  return state.releases[version]?.commit ?? (version === BASELINE.version ? BASELINE.commit : undefined);
}

function readList(paths: SourcePaths): { tag: string; commit: string }[] {
  if (!fs.existsSync(join(paths.repoPath, 'HEAD'))) return [];
  let out: string;
  try { out = runGit(paths, ['-C', paths.repoPath, 'for-each-ref', '--format=%(refname:strip=3)%00%(objectname)%00%(*objectname)', OBSERVED]); }
  catch { return []; }
  const list: { tag: string; commit: string }[] = [];
  for (const line of out.split('\n')) {
    const [tag, object, peeled] = line.replace(/\r$/, '').split('\0');
    if (tag && object) list.push({ tag, commit: peeled || object });
  }
  return list;
}

/**
 * Classifies the observed tags. `conflict`: the recorded commit or the cache entry's commit differs from the
 * observed one. `invalid-identity`: package.json at the tag disagrees with the tag. `missing-remote`: recorded
 * but gone after a successful fetch (`fetchOk`).
 */
export function observedTags(paths: SourcePaths, state: VersionState, options: { fetchOk?: boolean } = {}): ObservedTag[] {
  const tags: ObservedTag[] = [];
  const seen = new Set<string>();
  for (const { tag, commit } of readList(paths)) {
    const parsed = tag.startsWith('v') ? parseReleaseTag(tag) : undefined;
    if (!parsed || !isEligible(parsed)) {
      tags.push({ tag, commit, status: 'unsupported', reason: parsed ? 'anterior a 0.2.0' : 'formato no soportado' });
      continue;
    }
    const version = parsed.text;
    seen.add(version);
    const recorded = recordedCommit(state, version);
    const cached = readCacheCommit(paths, version);
    if ((recorded && recorded !== commit) || (cached && cached !== commit)) {
      const was = recorded && recorded !== commit ? recorded : cached!;
      tags.push({ tag, version, commit, status: 'conflict', reason: `la etiqueta cambió de commit (conocido ${short(was)}, observado ${short(commit)})` });
      continue;
    }
    let identity: Record<string, unknown> | undefined;
    try {
      const raw = showAt(paths, commit, 'package.json');
      const value = raw ? JSON.parse(raw.toString('utf8')) as unknown : undefined;
      identity = isRecord(value) ? value : undefined;
    } catch { identity = undefined; }
    if (!identity) tags.push({ tag, version, commit, status: 'invalid-identity', reason: 'no se pudo leer package.json en la etiqueta' });
    else if (identity.name !== PACKAGE_NAME) tags.push({ tag, version, commit, status: 'invalid-identity', reason: `el paquete se llama ${String(identity.name)}` });
    else if (identity.version !== version) tags.push({ tag, version, commit, status: 'invalid-identity', reason: `package.json declara ${String(identity.version)}, no ${version}` });
    else tags.push({ tag, version, commit, status: 'eligible' });
  }
  if (options.fetchOk) {
    for (const [version, entry] of Object.entries(state.releases)) {
      if (!seen.has(version)) tags.push({ tag: `v${version}`, version, commit: entry.commit, status: 'missing-remote', reason: 'ya no existe en el origen' });
    }
  }
  return tags;
}

export interface Discovery {
  origin: string;
  /** Time of the last successful fetch, even when this run's fetch failed. */
  fetchedAt: Date | undefined;
  /** True unless a fetch succeeded in this run: data may be out of date and must be disclosed. */
  stale: boolean;
  error?: string;
  tags: ObservedTag[];
}

/** Fetches (unless `fetch:false`) and classifies. Offline falls back to the last observed refs, flagged stale. */
export function discover(paths: SourcePaths, state: VersionState, options: { fetch?: boolean; timeout?: number } = {}): Discovery {
  const origin = state.origin;
  if (!origin) throw new SourceError('origin', 'las versiones', 'No hay un origen registrado; ejecutá npm run setup desde un checkout.');
  let fetched: FetchResult;
  const timeout = options.timeout ?? FETCH_TIMEOUT_MS;
  if (options.fetch === false) { ensureClone(paths, origin, timeout); fetched = { ok: false, fetchedAt: lastFetchTime(paths) }; }
  else fetched = fetchTags(paths, origin, timeout);
  const result: Discovery = { origin, fetchedAt: fetched.fetchedAt, stale: !fetched.ok, tags: observedTags(paths, state, { fetchOk: fetched.ok }) };
  if (fetched.error) result.error = fetched.error;
  return result;
}

/** Eligible tags not recorded yet: pass to `recordReleases` while holding the lock. */
export function firstSeen(discovery: Discovery, state: VersionState): { version: string; commit: string }[] {
  return discovery.tags
    .filter(tag => tag.status === 'eligible' && tag.version && tag.commit && !state.releases[tag.version])
    .map(tag => ({ version: tag.version!, commit: tag.commit! }));
}

export type Resolution =
  | { ok: true; tag: ObservedTag; stale: boolean }
  | { ok: false; code: 'empty' | 'stale' | 'missing' | 'unsupported' | 'refused' | 'unrecorded'; message: string };

/**
 * `stable` / `preview` resolve once to the highest SemVer of the channel. A conflicted or invalid top candidate
 * is refused, never replaced by the next one; stale data never resolves an alias.
 */
export function resolveAlias(discovery: Discovery, channel: Channel): Resolution {
  if (discovery.stale) {
    return { ok: false, code: 'stale', message: `No se pudo consultar el origen${discovery.error ? ` (${discovery.error.replace(/\s+/g, ' ').trim()})` : ''}; ${channel} necesita datos frescos. Usá una versión exacta o reintentá con conexión.` };
  }
  const candidates = discovery.tags.filter(tag => tag.version && tag.status !== 'unsupported' && tag.status !== 'missing-remote');
  const top = resolveChannel(candidates.map(tag => tag.version!), channel);
  if (!top) return { ok: false, code: 'empty', message: `No hay versiones ${channel === 'stable' ? 'estables' : 'preview'} publicadas en el origen.` };
  const tag = candidates.find(item => item.version === top.text)!;
  if (tag.status !== 'eligible') return { ok: false, code: 'refused', message: `La versión más nueva (${top.text}) no es seleccionable: ${tag.reason ?? tag.status}. No se elige otra.` };
  return { ok: true, tag, stale: false };
}

/** Exact version (`0.3.0` or `v0.3.0`). Stale data is accepted only for a version whose identity was recorded earlier. */
export function resolveExact(discovery: Discovery, state: VersionState, text: string): Resolution {
  const parsed = parseReleaseTag(text);
  if (!parsed) return { ok: false, code: 'unsupported', message: `«${text}» no es una versión válida (X.Y.Z o X.Y.Z-preview.N).` };
  if (!isEligible(parsed)) return { ok: false, code: 'unsupported', message: `${text.replace(/^v/, '')} es anterior a 0.2.0 y no se puede instalar.` };
  const tag = discovery.tags.find(item => item.version === parsed.text);
  if (!tag) return { ok: false, code: 'missing', message: `La versión ${parsed.text} no existe en el origen${discovery.stale ? ' (datos locales posiblemente desactualizados)' : ''}.` };
  if (tag.status !== 'eligible') return { ok: false, code: 'refused', message: `${parsed.text} no es seleccionable: ${tag.reason ?? tag.status}.` };
  if (discovery.stale && !recordedCommit(state, parsed.text)) {
    return { ok: false, code: 'unrecorded', message: `Sin conexión: ${parsed.text} nunca se verificó contra el origen. Reintentá con conexión.` };
  }
  return { ok: true, tag, stale: discovery.stale };
}

export interface Notes { found: boolean; text: string }

/** Release notes from the tag's CHANGELOG, then the newest eligible tag's CHANGELOG; otherwise an explicit absence. */
export function notesFor(paths: SourcePaths, discovery: Discovery, version: string): Notes {
  const parsed = parseReleaseTag(version);
  const eligible = discovery.tags.filter(tag => tag.status === 'eligible' && tag.version && tag.commit);
  const tag = eligible.find(item => item.version === parsed?.text);
  const newest = [...eligible].sort((a, b) => compareVersions(parseReleaseTag(b.version!)!, parseReleaseTag(a.version!)!));
  for (const candidate of [tag, ...newest]) {
    if (!candidate?.commit || !parsed) continue;
    const text = showAt(paths, candidate.commit, 'CHANGELOG.md')?.toString('utf8');
    const section = text === undefined ? undefined : changelogSection(text, parsed.text);
    if (section) return { found: true, text: section };
  }
  return { found: false, text: `Sin notas de versión para ${parsed?.text ?? version} (versión histórica sin CHANGELOG).` };
}

export const DEV_NOTES = 'dev: sin notas de versión; revisá git log en el checkout.';

// ---------------------------------------------------------------- cache

export interface CacheEntry { schema: 1; version: string; commit: string; sha256: string; size: number; builtAt: string; node: string }
export type CacheState =
  | { status: 'absent' }
  | { status: 'valid'; entry: CacheEntry; tarball: string }
  | { status: 'corrupt'; reason: string; commit?: string };

const cacheDir = (paths: SourcePaths, version: string): string => join(paths.cacheRoot, parseReleaseTag(version)!.text);
const tarballName = (version: string): string => `my-driven-development-${version}.tgz`;

function parseEntry(bytes: Buffer, version: string): CacheEntry | undefined {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (isRecord(value) && value.schema === 1 && value.version === version && typeof value.commit === 'string' && COMMIT_ID.test(value.commit)
      && typeof value.sha256 === 'string' && /^[0-9a-f]{64}$/.test(value.sha256) && Number.isSafeInteger(value.size)
      && typeof value.builtAt === 'string' && typeof value.node === 'string') return value as unknown as CacheEntry;
  } catch { /* corrupt entry */ }
  return undefined;
}

function readRegular(path: string, limit: number): Buffer | undefined {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) return undefined;
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/** The commit recorded in a cache entry, even if the tarball is damaged; used only to detect a moved tag. */
export function readCacheCommit(paths: SourcePaths, version: string): string | undefined {
  try {
    const bytes = readRegular(join(cacheDir(paths, version), 'entry.json'), 64 * 1024);
    return bytes ? parseEntry(bytes, version)?.commit : undefined;
  } catch { return undefined; }
}

/** A cache entry is reusable only when `entry.json` (written last) parses and the tarball matches its size and sha256. */
export function readCache(paths: SourcePaths, version: string): CacheState {
  const directory = cacheDir(paths, version);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return { status: 'absent' };
  try {
    scopedPath(paths.ownedRoot, directory, true);
    const entryPath = join(directory, 'entry.json');
    if (!fs.existsSync(entryPath)) return { status: 'corrupt', reason: 'entrada incompleta (sin entry.json)' };
    const bytes = readRegular(scopedPath(paths.ownedRoot, entryPath), 64 * 1024);
    const entry = bytes ? parseEntry(bytes, parseReleaseTag(version)!.text) : undefined;
    if (!entry) return { status: 'corrupt', reason: 'entry.json inválido' };
    const tarball = join(directory, tarballName(entry.version));
    if (!fs.existsSync(tarball)) return { status: 'corrupt', reason: 'falta el paquete', commit: entry.commit };
    const data = readRegular(scopedPath(paths.ownedRoot, tarball), TARBALL_MAX);
    if (!data || data.length !== entry.size || sha256(data) !== entry.sha256) return { status: 'corrupt', reason: 'el paquete no coincide con su sha256', commit: entry.commit };
    return { status: 'valid', entry, tarball };
  } catch (error) {
    return { status: 'corrupt', reason: error instanceof Error ? error.message : String(error) };
  }
}

function removeCacheEntry(paths: SourcePaths, version: string): void {
  const directory = cacheDir(paths, version);
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) return;
  scopedPath(paths.ownedRoot, directory, true);
  retryTransient(() => fs.rmSync(directory, { recursive: true, force: true }));
}

export interface CacheListing { version: string; state: CacheState }

/** Cache entries by version name (SemVer descending); unknown directory names are ignored. */
export function listCache(paths: SourcePaths): CacheListing[] {
  if (!fs.lstatSync(paths.cacheRoot, { throwIfNoEntry: false })) return [];
  const names = fs.readdirSync(paths.cacheRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name);
  return names
    .map(name => ({ name, parsed: parseReleaseTag(name) }))
    .filter(item => item.parsed && item.parsed.text === item.name)
    .sort((a, b) => compareVersions(b.parsed!, a.parsed!))
    .map(item => ({ version: item.name, state: readCache(paths, item.name) }));
}

export interface PruneInput {
  /** The active installation: its cache entry is kept while it is active. */
  active?: Identity | null;
  /** Extra versions to keep (source and target of an incomplete journal). */
  protect?: readonly string[];
}

/**
 * Retention after a commit, holding the lock: every complete stable entry, the three highest-SemVer complete
 * previews, and the active/protected versions. Everything else (other previews, incomplete or corrupt entries)
 * is deleted. Timestamps are never consulted.
 */
export function pruneCache(lock: LockHandle, input: PruneInput = {}): { kept: string[]; removed: string[] } {
  assertHeld(lock);
  const paths = sourcePaths(lock.paths.ownedRoot);
  const keep = new Set<string>(input.protect ?? []);
  if (input.active?.kind === 'release') keep.add(input.active.version);
  let previews = 0;
  const kept: string[] = [];
  const removed: string[] = [];
  for (const { version, state } of listCache(paths)) {
    const complete = state.status === 'valid';
    let retain = keep.has(version);
    if (complete && channelOf(parseReleaseTag(version)!) === 'stable') retain = true;
    if (complete && channelOf(parseReleaseTag(version)!) === 'preview' && previews < PREVIEWS_KEPT) retain = true;
    if (complete && channelOf(parseReleaseTag(version)!) === 'preview') previews += 1;
    if (retain) kept.push(version); else { removeCacheEntry(paths, version); removed.push(version); }
  }
  return { kept, removed };
}

// ---------------------------------------------------------------- building

export interface PreparedPackage {
  identity: Identity;
  /** Absolute path of the packed tarball (cache entry for releases, caller's `outDir` for dev). */
  tarball: string;
  sha256: string;
  size: number;
  /** True when a verified cache entry was reused. */
  cached: boolean;
  warnings: string[];
  dirty?: boolean;
  checkout?: string;
}

function readPackageJson(directory: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(join(directory, 'package.json'), 'utf8')) as unknown;
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function checkPrerequisites(label: string, pkg: Record<string, unknown>, deps: SourceDeps, warnings: string[]): ((args: readonly string[], cwd: string, timeout: number) => string) {
  const engines = isRecord(pkg.engines) && typeof pkg.engines.node === 'string' ? pkg.engines.node : undefined;
  const node = deps.nodeVersion ?? process.versions.node;
  if (engines) {
    const fits = satisfiesEngines(engines, node);
    if (fits === false) throw new SourceError('prerequisites', label, `Requiere Node ${engines} y este equipo tiene ${node}.`);
    if (fits === undefined) warnings.push(`No se pudo interpretar engines.node («${engines}»); se continúa.`);
  }
  const run = npmRunner(deps);
  if (!run) throw new SourceError('prerequisites', label, 'No se encontró el CLI de npm junto a Node (npm_execpath o node_modules/npm).');
  return run;
}

/** `npm ci` (when needed), `npm run build` and `npm pack` in `cwd`; returns the packed tarball path in `outDir`. */
function buildAndPack(label: string, cwd: string, outDir: string, run: ReturnType<typeof checkPrerequisites>, options: { install: boolean }): string {
  const attempt = (code: SourceErrorCode, args: string[], timeout: number): string => {
    try { return run(args, cwd, timeout); }
    catch (error) { throw new SourceError(code, label, diagnostic(error)); }
  };
  if (options.install) attempt('dependencies', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], INSTALL_TIMEOUT_MS);
  attempt('build', ['run', 'build', '--ignore-scripts'], BUILD_TIMEOUT_MS);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const out = attempt('pack', ['pack', '--ignore-scripts', '--json', '--pack-destination', outDir], PACK_TIMEOUT_MS);
  let name: unknown;
  try { name = (JSON.parse(out) as { filename?: unknown }[])[0]?.filename; } catch { name = undefined; }
  if (typeof name !== 'string' || !/^my-driven-development-[0-9][a-zA-Z0-9.-]*\.tgz$/.test(name)) throw new SourceError('pack', label, 'npm pack devolvió un nombre de paquete inesperado.');
  const packed = join(outDir, name);
  const stat = fs.statSync(packed, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw new SourceError('pack', label, 'npm pack no produjo el paquete.');
  if (stat.size > TARBALL_MAX) throw new SourceError('pack', label, 'El paquete supera el límite de 32 MiB.');
  return packed;
}

/**
 * Prepares an eligible release tag, holding the lock: reuse a verified cache entry, or build the tag's own
 * source (a detached worktree of the owned clone, its lockfile, never the invoking checkout) and store the
 * tarball with `entry.json` last. A corrupt or partial cache entry is deleted and rebuilt. Errors name the stage.
 */
export function prepareRelease(lock: LockHandle, tag: ObservedTag, deps: SourceDeps = {}): PreparedPackage {
  assertHeld(lock);
  const paths = sourcePaths(lock.paths.ownedRoot);
  const label = tag.version ?? tag.tag;
  if (tag.status === 'conflict') throw new SourceError('conflict', label, `${tag.reason ?? 'La etiqueta cambió de commit'}; se rechaza.`);
  if (tag.status !== 'eligible' || !tag.version || !tag.commit) throw new SourceError('identity', label, `${tag.reason ?? 'La etiqueta no es seleccionable'}.`);
  const { version, commit } = tag;
  const identity: Identity = { kind: 'release', version, commit };
  ensureLayout(paths);

  const cached = readCache(paths, version);
  if (cached.status === 'valid') {
    if (cached.entry.commit !== commit) throw new SourceError('conflict', label, `La caché pertenece a otro commit (${short(cached.entry.commit)}, no ${short(commit)}).`);
    return { identity, tarball: cached.tarball, sha256: cached.entry.sha256, size: cached.entry.size, cached: true, warnings: [] };
  }
  if (cached.status === 'corrupt') {
    if (cached.commit && cached.commit !== commit) throw new SourceError('conflict', label, `La caché pertenece a otro commit (${short(cached.commit)}, no ${short(commit)}).`);
    try { removeCacheEntry(paths, version); } catch (error) { throw new SourceError('cache', label, diagnostic(error)); }
  }

  const warnings: string[] = [];
  const id = (deps.id ?? (() => randomBytes(4).toString('hex')))();
  const worktree = join(paths.buildRoot, id);
  const outDir = join(paths.buildRoot, `${id}-out`);
  sweepBuilds(paths);
  try {
    try { runGit(paths, ['-C', paths.repoPath, 'cat-file', '-e', `${commit}^{commit}`]); }
    catch {
      const origin = readOrigin(paths);
      try { runGitNetwork(paths, ['-C', paths.repoPath, 'fetch', '--quiet', '--no-tags', 'origin', REFSPEC], FETCH_TIMEOUT_MS); runGit(paths, ['-C', paths.repoPath, 'cat-file', '-e', `${commit}^{commit}`]); }
      catch (error) { throw new SourceError('fetch', label, `No está el commit ${short(commit)} en el clon propio (${origin ?? 'sin origen'}): ${diagnostic(error)}`); }
    }
    try { runGit(paths, ['-C', paths.repoPath, 'worktree', 'add', '--detach', '--quiet', worktree, commit]); }
    catch (error) { throw new SourceError('checkout', label, diagnostic(error)); }
    const pkg = readPackageJson(worktree);
    if (!pkg || pkg.name !== PACKAGE_NAME) throw new SourceError('identity', label, `El paquete en la etiqueta no es ${PACKAGE_NAME}.`);
    if (pkg.version !== version) throw new SourceError('identity', label, `package.json declara ${String(pkg.version)}, no ${version}.`);
    if (!fs.existsSync(join(worktree, 'package-lock.json'))) throw new SourceError('identity', label, 'La etiqueta no incluye package-lock.json.');
    const run = checkPrerequisites(label, pkg, deps, warnings);
    const packed = buildAndPack(label, worktree, outDir, run, { install: true });
    return store(paths, label, identity, packed, deps, warnings);
  } finally {
    try { runGit(paths, ['-C', paths.repoPath, 'worktree', 'remove', '--force', worktree]); } catch { /* removed below */ }
    try { fs.rmSync(worktree, { recursive: true, force: true }); fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* swept on the next locked run */ }
    try { runGit(paths, ['-C', paths.repoPath, 'worktree', 'prune']); } catch { /* best effort */ }
  }
}

function readOrigin(paths: SourcePaths): string | undefined {
  try { return runGit(paths, ['-C', paths.repoPath, 'config', '--get', 'remote.origin.url']).trim() || undefined; } catch { return undefined; }
}

/** Removes leftovers of crashed builds; safe because the caller holds the lock. */
function sweepBuilds(paths: SourcePaths): void {
  try {
    for (const entry of fs.readdirSync(paths.buildRoot)) fs.rmSync(scopedPath(paths.ownedRoot, join(paths.buildRoot, entry), true), { recursive: true, force: true });
    runGit(paths, ['-C', paths.repoPath, 'worktree', 'prune']);
  } catch { /* best effort */ }
}

function store(paths: SourcePaths, label: string, identity: Identity, packed: string, deps: SourceDeps, warnings: string[]): PreparedPackage {
  try {
    const bytes = fs.readFileSync(packed);
    const directory = cacheDir(paths, identity.version);
    ensureDir(paths, paths.cacheRoot);
    removeCacheEntry(paths, identity.version);
    fs.mkdirSync(directory, { mode: 0o700 });
    const target = join(directory, tarballName(identity.version));
    fs.copyFileSync(packed, target, fs.constants.COPYFILE_EXCL);
    const entry: CacheEntry = {
      schema: 1, version: identity.version, commit: identity.commit, sha256: sha256(bytes), size: bytes.length,
      builtAt: (deps.now ?? (() => new Date()))().toISOString(), node: process.versions.node,
    };
    writeAtomic(paths, join(directory, 'entry.json'), `${JSON.stringify(entry, null, 2)}\n`);
    return { identity, tarball: target, sha256: entry.sha256, size: entry.size, cached: false, warnings };
  } catch (error) {
    try { removeCacheEntry(paths, identity.version); } catch { /* an entry without entry.json is never reusable */ }
    throw new SourceError('store', label, diagnostic(error));
  }
}

// ---------------------------------------------------------------- dev

const sameFile = (a: string, b: string): boolean => {
  const norm = (path: string): string => { const real = fs.realpathSync.native(path); return process.platform === 'win32' ? real.toLowerCase() : real; };
  return norm(a) === norm(b);
};

/**
 * Prepares the owner's checkout as the `dev` channel: validates it, reads its identity and dirty flag (before the
 * build), then builds and packs in place into `outDir` (under the owned root, created by the caller's transaction).
 * Nothing is cached and no ref is touched.
 */
export function prepareDev(lock: LockHandle, input: { checkout: string; outDir: string }, deps: SourceDeps = {}): PreparedPackage {
  assertHeld(lock);
  const paths = sourcePaths(lock.paths.ownedRoot);
  ensureLayout(paths);
  const fail = (detail: string): SourceError => new SourceError('dev-checkout', 'dev', detail);
  if (typeof input.checkout !== 'string' || !input.checkout.trim() || !isAbsolute(input.checkout)) throw fail('La ruta del checkout debe ser absoluta.');
  const checkout = resolve(input.checkout);
  if (!fs.statSync(checkout, { throwIfNoEntry: false })?.isDirectory()) throw fail(`No existe el directorio ${checkout}.`);
  const fromOwned = relative(paths.ownedRoot, checkout);
  if (!fromOwned || (!fromOwned.startsWith('..') && !isAbsolute(fromOwned))) throw fail('El checkout no puede estar dentro de la instalación de MDD.');
  let top: string;
  try { top = runGit(paths, ['rev-parse', '--show-toplevel'], { cwd: checkout }).trim(); }
  catch { throw fail(`${checkout} no es un repositorio Git.`); }
  if (!top || !sameFile(top, checkout)) throw fail(`${checkout} no es la raíz de su repositorio Git.`);
  const pkg = readPackageJson(checkout);
  if (!pkg || pkg.name !== PACKAGE_NAME) throw fail(`El paquete de ${checkout} no es ${PACKAGE_NAME}.`);
  if (typeof pkg.version !== 'string' || !pkg.version) throw fail('package.json no declara una versión.');
  let commit: string;
  try { commit = runGit(paths, ['rev-parse', 'HEAD'], { cwd: checkout }).trim(); }
  catch { throw fail('El checkout no tiene ningún commit.'); }
  if (!COMMIT_ID.test(commit)) throw fail('No se pudo leer el commit del checkout.');
  let dirty: boolean;
  try { dirty = runGit(paths, ['status', '--porcelain'], { cwd: checkout }).trim().length > 0; }
  catch (error) { throw fail(diagnostic(error)); }
  const outDir = resolve(input.outDir);
  const outRelative = relative(paths.ownedRoot, outDir);
  if (!outRelative || outRelative.startsWith('..') || isAbsolute(outRelative)) throw fail('El directorio de salida debe estar dentro de la instalación de MDD.');
  const warnings: string[] = [];
  const run = checkPrerequisites('dev', pkg, deps, warnings);
  if (!fs.existsSync(join(checkout, 'package-lock.json'))) throw new SourceError('dependencies', 'dev', 'El checkout no incluye package-lock.json.');
  const install = !fs.existsSync(join(checkout, 'node_modules', '@opencode', 'plugin'));
  const packed = buildAndPack('dev', checkout, outDir, run, { install });
  const bytes = fs.readFileSync(packed);
  return {
    identity: { kind: 'dev', version: pkg.version, commit }, tarball: packed, sha256: sha256(bytes), size: bytes.length,
    cached: false, warnings, dirty, checkout,
  };
}
