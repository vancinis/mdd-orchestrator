import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { installationPaths } from './installation-paths.js';
import { LocalFileError, LocalFiles, retryTransient } from './local-files.js';
import { scopedPath } from './safe-paths.js';
import type { IntegrationDeps } from './integrations.js';

/**
 * Owned store for the local tools MDD can install (Engram, CodeGraph): pinned official release
 * archives, versioned directories under `<configRoot>/mdd/integrations/`, and a strict provenance
 * manifest. It never reads, copies or migrates the tools' own data, never touches the version
 * manager lock or journal, and is not imported by the manager import graph.
 */

export type ToolId = 'engram' | 'codegraph';
export const TOOL_IDS: readonly ToolId[] = Object.freeze(['engram', 'codegraph'] as ToolId[]);
export type PlatformKey = 'win32-x64' | 'win32-arm64' | 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'linux-arm64';
export const PLATFORM_KEYS: readonly PlatformKey[] = Object.freeze(
  ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'] as PlatformKey[]);

export interface InstalledVersion {
  version: string; dir: string; platform: PlatformKey; source: string;
  sha256: string; format: string; launch: Record<string, string>;
  installedAt: string; origin: 'catalog' | 'lookup';
}
export interface ToolRecord {
  versions: Record<string, InstalledVersion>;
  registration: { file: 'opencode.json' | 'opencode.jsonc'; name: string } | null;
}
export interface Manifest { schema: 1; tools: Partial<Record<ToolId, ToolRecord>> }

export interface ToolRelease {
  tool: ToolId; version: string; asset: string; url: string; size: number; sha256: string;
  format: string; kind: 'zip' | 'tar.gz'; origin: 'catalog' | 'lookup';
}

export interface CatalogAsset { asset: string; size: number; sha256: string }
export interface CatalogTool {
  repo: string; version: string; format: string;
  /** Tagged source file and regex (one capture group) that carry the persistent-data format number. */
  formatFile: string; formatPattern: string;
  checksums: string; mcpArgs: string[]; versionArgs: string[];
  /** Exact expected output of the version command; `{version}` is replaced. */
  versionOutput: string;
  assets: Record<PlatformKey, CatalogAsset>;
}

/** Reviewed pins (Design section 3.3). Maintainers bump these in MDD releases. */
export const CATALOG: Record<ToolId, CatalogTool> = {
  engram: {
    repo: 'Gentleman-Programming/engram',
    version: '3.7.2',
    format: 'engram-store-schema:1',
    formatFile: 'internal/store/store.go',
    formatPattern: 'const\\s+schemaVersion\\s*=\\s*(\\d+)',
    checksums: 'checksums.txt',
    mcpArgs: ['mcp', '--tools=agent'],
    versionArgs: ['version'],
    versionOutput: 'engram {version}',
    assets: {
      'win32-x64': { asset: 'engram_3.7.2_windows_amd64.zip', size: 8582764, sha256: '515a716ce966202058d4b9f310626fde72583cfc64ccefbf0dcc81456260089c' },
      'win32-arm64': { asset: 'engram_3.7.2_windows_arm64.zip', size: 7780232, sha256: '01e4f5dab2f941cf810d1373e7c6998c014499bee9c2d5783e34da94c70ac7f2' },
      'darwin-x64': { asset: 'engram_3.7.2_darwin_amd64.tar.gz', size: 8488340, sha256: 'd35623443a5d85e8f78338cda5d0bb73b2f7ec6217a57e4abb71904a3e0d6287' },
      'darwin-arm64': { asset: 'engram_3.7.2_darwin_arm64.tar.gz', size: 8001813, sha256: 'f96e08db8f47ca49ebc034eba30e468db81eb56df98f9bf21a73366b510695e4' },
      'linux-x64': { asset: 'engram_3.7.2_linux_amd64.tar.gz', size: 8365851, sha256: '8db9d5db1c1574b8b830aac4ffbe86c024014aed6b9a3f0406ac3361a152cdf0' },
      'linux-arm64': { asset: 'engram_3.7.2_linux_arm64.tar.gz', size: 7712574, sha256: 'cdbbcb68d3e842d3e52e27edccef55e6fe98ce3cdbc90cd79894323b029efb50' },
    },
  },
  codegraph: {
    repo: 'colbymchenry/codegraph',
    version: '1.6.2',
    format: 'codegraph-index-schema:11',
    formatFile: 'src/db/migrations.ts',
    formatPattern: 'CURRENT_SCHEMA_VERSION\\s*=\\s*(\\d+)',
    checksums: 'SHA256SUMS',
    mcpArgs: ['serve', '--mcp'],
    versionArgs: ['--version'],
    versionOutput: '{version}',
    assets: {
      'win32-x64': { asset: 'codegraph-win32-x64.zip', size: 54260850, sha256: '7455e817ee8032666867a1badeb799b8a884c5f4fea9b444e088a02069b6deea' },
      'win32-arm64': { asset: 'codegraph-win32-arm64.zip', size: 50258514, sha256: '308f7bf92e7886f4d5f767a4755d703e92d5cae78ac042b8907f1e99db0fc071' },
      'darwin-x64': { asset: 'codegraph-darwin-x64.tar.gz', size: 59393903, sha256: '53d1a4d1a9af31d6cec11b346df2ae792087081e13f623f583e27783c1e7f9bc' },
      'darwin-arm64': { asset: 'codegraph-darwin-arm64.tar.gz', size: 58280485, sha256: 'd74d1bfb4060db63ec3c2b72c4e17f76c31978af3bad6ace4370d1501ac0662e' },
      'linux-x64': { asset: 'codegraph-linux-x64.tar.gz', size: 63433974, sha256: 'ef0af416092128fb1ccc723786000b7edf4a6971fe604acd08bf966e4f37b828' },
      'linux-arm64': { asset: 'codegraph-linux-arm64.tar.gz', size: 63017097, sha256: 'c8c6be292be21d00dea26bad8b28d434731cf612fb8cc475dc10f5b3038b5b64' },
    },
  },
};

export const MANIFEST_NAME = 'mdd/integrations/manifest.json' as const;
export const MANIFEST_LIMIT = 65536;

// Bounds. Every one is a deliberate cap on untrusted input.
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const DOWNLOAD_DEADLINE_MS = 10 * 60 * 1000;
export const EXTRACT_TIMEOUT_MS = 5 * 60 * 1000;
export const VERSION_TIMEOUT_MS = 30 * 1000;
export const VERSION_OUTPUT_LIMIT = 65536;
export const MAX_TREE_ENTRIES = 5000;
export const MAX_TREE_BYTES = 768 * 1024 * 1024;
export const STALE_STAGE_MS = 60 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 15 * 1000;
const RELEASES_LIMIT = 1024 * 1024;
const CHECKSUMS_LIMIT = 16 * 1024;
const FORMAT_SOURCE_LIMIT = 2 * 1024 * 1024;

const DOWNLOAD_HOSTS: ReadonlySet<string> = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const LOOKUP_HOSTS: ReadonlySet<string> = new Set([...DOWNLOAD_HOSTS, 'api.github.com', 'raw.githubusercontent.com']);

export type InstallStage = 'preflight' | 'download' | 'verify' | 'extract' | 'validate' | 'version' | 'place' | 'record';

/** Failure with the pipeline step that raised it, so the caller can report honestly what remains. */
export class IntegrationInstallError extends Error {
  readonly stage: InstallStage;
  /** Absolute directory that was placed before the failure (only for stage `record`). */
  readonly placed: string | undefined;
  constructor(stage: InstallStage, message: string, placed?: string) {
    super(message);
    this.name = 'IntegrationInstallError';
    this.stage = stage;
    this.placed = placed;
  }
}

type Runner = NonNullable<IntegrationDeps['run']>;

export function integrationPaths(paths: ReturnType<typeof installationPaths> = installationPaths()) {
  const root = join(paths.ownedRoot, 'integrations');
  return Object.freeze({
    configRoot: paths.configRoot,
    ownedRoot: paths.ownedRoot,
    root,
    stageRoot: join(root, '.stage'),
    manifestPath: join(root, 'manifest.json'),
    toolRoot: (tool: ToolId) => join(root, tool),
  });
}
export type IntegrationPaths = ReturnType<typeof integrationPaths>;

export function platformKey(platform: NodeJS.Platform, arch: NodeJS.Architecture): PlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return (PLATFORM_KEYS as readonly string[]).includes(key) ? key as PlatformKey : undefined;
}

const isWindows = (platform: PlatformKey) => platform.startsWith('win32');
const SEMVER = /^\d+\.\d+\.\d+$/;

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return (left[i] ?? 0) < (right[i] ?? 0) ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Layout, launch commands and ownership
// ---------------------------------------------------------------------------------------------

/** Files whose digests prove the tool is intact (relative, forward slashes). */
export function launchFiles(tool: ToolId, platform: PlatformKey): string[] {
  if (tool === 'engram') return [isWindows(platform) ? 'engram.exe' : 'engram'];
  return isWindows(platform) ? ['node.exe', 'lib/dist/bin/codegraph.js'] : ['bin/codegraph', 'node'];
}

const absoluteOf = (dir: string, rel: string) => join(dir, ...rel.split('/'));

/** Command that runs the tool itself (no MCP arguments). */
export function launchCommand(tool: ToolId, dir: string, platform: PlatformKey): string[] {
  if (tool === 'engram') return [absoluteOf(dir, launchFiles(tool, platform)[0]!)];
  if (isWindows(platform)) {
    return [absoluteOf(dir, 'node.exe'), '--liftoff-only', '--disable-warning=ExperimentalWarning', absoluteOf(dir, 'lib/dist/bin/codegraph.js')];
  }
  return [absoluteOf(dir, 'bin/codegraph')];
}

/** Command written to the OpenCode registration: launch plus the catalog's MCP arguments. */
export function mcpCommand(tool: ToolId, dir: string, platform: PlatformKey, catalog: Record<ToolId, CatalogTool> = CATALOG): string[] {
  return [...launchCommand(tool, dir, platform), ...catalog[tool].mcpArgs];
}

/** Absolute directory of a recorded version; throws when the record's `dir` is not the canonical shape. */
export function versionDirectory(paths: IntegrationPaths, tool: ToolId, record: InstalledVersion): string {
  if (record.dir !== versionDirName(tool, record)) throw new IntegrationInstallError('validate', 'El registro de la versión instalada no es canónico.');
  return join(paths.root, ...record.dir.split('/'));
}

function versionDirName(tool: ToolId, record: Pick<InstalledVersion, 'version' | 'sha256'>): string {
  return `${tool}/${record.version}-${record.sha256.slice(0, 8)}`;
}

function sameCommand(left: unknown, right: readonly string[], windows: boolean): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false;
  return left.every((part, index) => {
    if (typeof part !== 'string') return false;
    const other = right[index]!;
    if (part === other) return true;
    // Only filesystem paths compare case-insensitively; arguments are exact.
    return windows && isAbsolute(part) && isAbsolute(other) && normalize(part).toLowerCase() === normalize(other).toLowerCase();
  });
}

/**
 * Ownership: a registration command is MDD's only when it equals the launch-plus-MCP command of a
 * version recorded in the manifest. The config file is the single source of truth for "active".
 */
export function managedVersionForCommand(paths: IntegrationPaths, tool: ToolId, manifest: Manifest, command: unknown, catalog: Record<ToolId, CatalogTool> = CATALOG): InstalledVersion | undefined {
  for (const record of Object.values(manifest.tools[tool]?.versions ?? {})) {
    let dir: string;
    try { dir = versionDirectory(paths, tool, record); } catch { continue; }
    if (sameCommand(command, mcpCommand(tool, dir, record.platform, catalog), isWindows(record.platform))) return record;
  }
  return undefined;
}

/** Every launch-plus-MCP command MDD would own for this tool (input of the config classifier). */
export function managedCommands(paths: IntegrationPaths, tool: ToolId, manifest: Manifest, catalog: Record<ToolId, CatalogTool> = CATALOG): string[][] {
  const commands: string[][] = [];
  for (const record of Object.values(manifest.tools[tool]?.versions ?? {})) {
    try { commands.push(mcpCommand(tool, versionDirectory(paths, tool, record), record.platform, catalog)); } catch { /* not canonical: not owned */ }
  }
  return commands;
}

function fileSha256(path: string): string {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe file');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1 << 20);
    for (let read = fs.readSync(fd, buffer, 0, buffer.length, null); read > 0; read = fs.readSync(fd, buffer, 0, buffer.length, null)) hash.update(buffer.subarray(0, read));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

function launchDigests(dir: string, tool: ToolId, platform: PlatformKey): Record<string, string> {
  return Object.fromEntries(launchFiles(tool, platform).map(rel => [rel, fileSha256(absoluteOf(dir, rel))]));
}

/** `intact` only when every launch file exists as a plain file with the recorded digest. */
export function verifyInstalled(paths: IntegrationPaths, tool: ToolId, record: InstalledVersion): 'intact' | 'missing' | 'tampered' {
  let dir: string;
  try { dir = versionDirectory(paths, tool, record); } catch { return 'tampered'; }
  const expected = launchFiles(tool, record.platform);
  const recorded = Object.keys(record.launch);
  if (recorded.length !== expected.length || !expected.every(rel => rel in record.launch)) return 'tampered';
  try { scopedPath(paths.root, record.dir, true); }
  catch { return fs.lstatSync(dir, { throwIfNoEntry: false }) ? 'tampered' : 'missing'; }
  let missing = false;
  for (const rel of expected) {
    const file = absoluteOf(dir, rel);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) { missing = true; continue; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return 'tampered';
    try { if (fileSha256(file) !== record.launch[rel]) return 'tampered'; } catch { return 'tampered'; }
  }
  return missing ? 'missing' : 'intact';
}

/**
 * What an update keeps: the new referenced version plus the version the registration actually
 * launched before the update. Never inferred from install time or version order, so an unused
 * staged candidate (a failed earlier update) cannot displace the real previous launch.
 */
export function retainedVersions(manifest: Manifest, tool: ToolId, referenced: string | undefined, previous?: string): string[] {
  const recorded = manifest.tools[tool]?.versions ?? {};
  const keep = referenced ? [referenced] : [];
  if (previous && previous !== referenced && previous in recorded) keep.push(previous);
  return keep;
}

// ---------------------------------------------------------------------------------------------
// Manifest (strict, through LocalFiles)
// ---------------------------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/;
const FORMAT = /^[a-z0-9-]+:\d+$/;
const KEYS = (value: object, keys: string[]) => {
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const plain = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function parseVersion(tool: ToolId, key: string, value: unknown): InstalledVersion | undefined {
  if (!plain(value) || !KEYS(value, ['version', 'dir', 'platform', 'source', 'sha256', 'format', 'launch', 'installedAt', 'origin'])) return undefined;
  const { version, dir, platform, source, sha256, format, launch, installedAt, origin } = value;
  if (typeof version !== 'string' || !SEMVER.test(version) || version !== key) return undefined;
  if (typeof platform !== 'string' || !(PLATFORM_KEYS as readonly string[]).includes(platform)) return undefined;
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) return undefined;
  if (dir !== `${tool}/${version}-${sha256.slice(0, 8)}`) return undefined;
  if (typeof source !== 'string' || !source.startsWith('https://') || source.length > 512) return undefined;
  if (typeof format !== 'string' || !FORMAT.test(format)) return undefined;
  if (!plain(launch)) return undefined;
  const files: Record<string, string> = {};
  for (const [rel, digest] of Object.entries(launch)) {
    if (typeof digest !== 'string' || !HEX64.test(digest) || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rel) || rel.split('/').includes('..')) return undefined;
    files[rel] = digest;
  }
  if (typeof installedAt !== 'string' || Number.isNaN(Date.parse(installedAt))) return undefined;
  if (origin !== 'catalog' && origin !== 'lookup') return undefined;
  return { version, dir, platform: platform as PlatformKey, source, sha256, format, launch: files, installedAt, origin };
}

/** Strict parser: any unknown key or shape makes the whole manifest unreadable. */
export function parseManifest(text: string): { manifest: Manifest } | { unreadable: string } {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { unreadable: 'el manifiesto de integraciones no es JSON válido' }; }
  const bad = { unreadable: 'el manifiesto de integraciones tiene un formato desconocido' };
  if (!plain(data) || !KEYS(data, ['schema', 'tools']) || data.schema !== 1) return bad;
  const toolsRaw = data.tools;
  if (!plain(toolsRaw)) return bad;
  const tools: Manifest['tools'] = {};
  for (const [id, entry] of Object.entries(toolsRaw)) {
    if (!(TOOL_IDS as readonly string[]).includes(id) || !plain(entry) || !KEYS(entry, ['versions', 'registration'])) return bad;
    const versionsRaw = entry.versions;
    if (!plain(versionsRaw)) return bad;
    const versions: Record<string, InstalledVersion> = {};
    for (const [key, raw] of Object.entries(versionsRaw)) {
      const parsed = parseVersion(id as ToolId, key, raw);
      if (!parsed) return bad;
      versions[key] = parsed;
    }
    const registration = entry.registration;
    if (registration !== null) {
      if (!plain(registration) || !KEYS(registration, ['file', 'name'])) return bad;
      if ((registration.file !== 'opencode.json' && registration.file !== 'opencode.jsonc') || typeof registration.name !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(registration.name)) return bad;
    }
    tools[id as ToolId] = { versions, registration: registration === null ? null : { file: registration.file as 'opencode.json' | 'opencode.jsonc', name: registration.name as string } };
  }
  return { manifest: { schema: 1, tools } };
}

export function readManifest(paths: IntegrationPaths): { manifest: Manifest } | { unreadable: string } {
  if (!fs.existsSync(paths.configRoot)) return { manifest: { schema: 1, tools: {} } };
  try {
    const text = new LocalFiles(paths.configRoot).read(MANIFEST_NAME, MANIFEST_LIMIT);
    return text === undefined ? { manifest: { schema: 1, tools: {} } } : parseManifest(text);
  } catch (error) {
    if (error instanceof LocalFileError) return { unreadable: 'el manifiesto de integraciones no se puede leer de forma segura' };
    return { unreadable: 'el manifiesto de integraciones no está disponible' };
  }
}

/** Read-modify-write under the LocalFiles lock. Never rewrites an unreadable manifest. */
function updateManifest(paths: IntegrationPaths, change: (manifest: Manifest) => void): void {
  fs.mkdirSync(paths.configRoot, { recursive: true });
  try {
    new LocalFiles(paths.configRoot).update(MANIFEST_NAME, previous => {
      const state = previous === undefined ? { manifest: { schema: 1 as const, tools: {} } } : parseManifest(previous);
      if ('unreadable' in state) throw new IntegrationInstallError('record', state.unreadable);
      change(state.manifest);
      return `${JSON.stringify(state.manifest, null, 2)}\n`;
    }, MANIFEST_LIMIT);
  } catch (error) {
    if (error instanceof IntegrationInstallError) throw error;
    throw new IntegrationInstallError('record', 'No se pudo actualizar el manifiesto de integraciones.');
  }
}

const toolRecord = (manifest: Manifest, tool: ToolId): ToolRecord => manifest.tools[tool] ??= { versions: {}, registration: null };

export function recordInstalled(paths: IntegrationPaths, tool: ToolId, record: InstalledVersion): void {
  updateManifest(paths, manifest => { toolRecord(manifest, tool).versions[record.version] = record; });
}

export function setRegistration(paths: IntegrationPaths, tool: ToolId, registration: ToolRecord['registration']): void {
  updateManifest(paths, manifest => { toolRecord(manifest, tool).registration = registration; });
}

// ---------------------------------------------------------------------------------------------
// Process and filesystem helpers
// ---------------------------------------------------------------------------------------------

export const defaultRun: Runner = (file, args, options) => {
  const result = spawnSync(file, args, {
    cwd: options.cwd, env: options.env, timeout: options.timeout,
    stdio: options.stdio === 'inherit' ? 'inherit' : 'pipe',
    encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: false,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
};

const SAFE_ENV = new Set(['path', 'systemroot', 'windir', 'comspec', 'pathext', 'lang', 'lc_all']);

/** Minimal environment for staged binaries: everything user-specific points inside the stage. */
export function isolatedEnv(base: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) if (value !== undefined && SAFE_ENV.has(name.toLowerCase())) env[name] = value;
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'TEMP', 'TMP', 'TMPDIR', 'ENGRAM_DATA_DIR']) env[name] = home;
  env.CODEGRAPH_TELEMETRY = '0';
  env.DO_NOT_TRACK = '1';
  return env;
}

/** Creates `rel` below `base` component by component and proves every component is a real directory. */
function ensureDirectory(base: string, rel: string): string {
  let current = base;
  for (const part of rel.split('/').filter(Boolean)) {
    current = join(current, part);
    if (!fs.lstatSync(current, { throwIfNoEntry: false })) fs.mkdirSync(current, { mode: 0o700 });
  }
  return scopedPath(base, rel, true);
}

function removeTree(path: string): void {
  retryTransient(() => fs.rmSync(path, { recursive: true, force: true }));
}

function stageId(deps: IntegrationDeps): string {
  const id = deps.id?.() ?? randomUUID().replaceAll('-', '').slice(0, 8);
  if (!/^[A-Za-z0-9]{4,32}$/.test(id)) throw new IntegrationInstallError('preflight', 'Identificador de preparación no válido.');
  return id;
}

function cleanStale(paths: IntegrationPaths, now: number): void {
  try {
    for (const name of fs.readdirSync(paths.stageRoot)) {
      const path = join(paths.stageRoot, name);
      const stat = fs.lstatSync(path);
      if (now - stat.mtimeMs > STALE_STAGE_MS) removeTree(path);
    }
  } catch { /* best effort: a leftover stage is only disk space */ }
}

// ---------------------------------------------------------------------------------------------
// Bounded download
// ---------------------------------------------------------------------------------------------

function fail(stage: InstallStage, message: string): never { throw new IntegrationInstallError(stage, message); }

/** Follows redirects manually; every hop must be https on an allowed host, with no credentials. */
async function request(stage: InstallStage, url: string, deps: IntegrationDeps, signal: AbortSignal, hosts: ReadonlySet<string>): Promise<Response> {
  const doFetch = deps.fetch ?? fetch;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { return fail(stage, 'URL de descarga no válida.'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !hosts.has(parsed.hostname)) {
      return fail(stage, `Origen de descarga no permitido: ${parsed.hostname || 'desconocido'}.`);
    }
    let response: Response;
    try {
      response = await doFetch(current, { redirect: 'manual', credentials: 'omit', signal, headers: { 'user-agent': 'mdd-ai', accept: '*/*' } });
    } catch (error) {
      return fail(stage, signal.aborted ? 'La descarga superó el tiempo máximo.' : `No se pudo descargar: ${(error as Error).message}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) return fail(stage, 'Redirección sin destino.');
      try { current = new URL(location, current).href; } catch { return fail(stage, 'Redirección no válida.'); }
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return fail(stage, `El servidor respondió HTTP ${response.status}.`);
    }
    return response;
  }
  return fail(stage, `Demasiadas redirecciones (máximo ${MAX_REDIRECTS}).`);
}

async function* chunks(response: Response, limit: number, stage: InstallStage, message: string): AsyncGenerator<Uint8Array> {
  if (!response.body) return fail(stage, 'Respuesta sin contenido.');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body.cancel().catch(() => undefined);
    return fail(stage, message);
  }
  const reader = response.body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      total += value.length;
      if (total > limit) { await reader.cancel().catch(() => undefined); return fail(stage, message); }
      yield value;
    }
  } finally { reader.releaseLock?.(); }
}

async function readText(stage: InstallStage, url: string, limit: number, deps: IntegrationDeps): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await request(stage, url, deps, controller.signal, LOOKUP_HOSTS);
    const parts: Buffer[] = [];
    try {
      for await (const part of chunks(response, limit, stage, 'La respuesta supera el tamaño permitido.')) parts.push(Buffer.from(part));
    } catch (error) {
      if (error instanceof IntegrationInstallError) throw error;
      return fail(stage, controller.signal.aborted ? 'La consulta superó el tiempo máximo.' : 'No se pudo leer la respuesta.');
    }
    return Buffer.concat(parts).toString('utf8');
  } finally { clearTimeout(timer); }
}

/** Streams to `file` while hashing; aborts as soon as more than the pinned size arrives. */
async function download(release: ToolRelease, file: string, deps: IntegrationDeps): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_DEADLINE_MS);
  try {
    const response = await request('download', release.url, deps, controller.signal, DOWNLOAD_HOSTS);
    const fd = fs.openSync(file, 'wx', 0o600);
    const hash = createHash('sha256');
    let total = 0;
    try {
      for await (const part of chunks(response, release.size, 'download', 'La descarga supera el tamaño esperado.')) {
        hash.update(part);
        fs.writeSync(fd, part);
        total += part.length;
      }
    } catch (error) {
      if (error instanceof IntegrationInstallError) throw error;
      return fail('download', controller.signal.aborted ? 'La descarga superó el tiempo máximo.' : 'Se interrumpió la descarga.');
    } finally { fs.closeSync(fd); }
    if (total !== release.size || hash.digest('hex') !== release.sha256) fail('verify', 'La integridad no coincide con la versión revisada; no se instaló nada.');
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------------------------------------
// Extraction, preflight and post-extract validation
// ---------------------------------------------------------------------------------------------

/**
 * Archive listing check done before extracting: no absolute, drive, traversal or control-character
 * names, and only regular files and directories (no symbolic or hard links, devices or pipes).
 * `verbose` lines are `tar -tv` output, whose first character is the entry type.
 */
export function preflightListing(names: string[], verbose: string[]): string | undefined {
  if (names.length > MAX_TREE_ENTRIES || verbose.length > MAX_TREE_ENTRIES) return 'El archivo contiene demasiadas entradas.';
  for (const name of names) {
    const unified = name.replaceAll('\\', '/');
    if (!unified || /[\x00-\x1f]/.test(unified) || unified.startsWith('/') || /^[A-Za-z]:/.test(unified) || unified.split('/').includes('..')) {
      return `El archivo contiene una ruta no permitida: ${JSON.stringify(name.slice(0, 80))}.`;
    }
  }
  for (const line of verbose) if (line && !'-d'.includes(line[0]!)) return 'El archivo contiene enlaces o entradas especiales.';
  return undefined;
}

function systemTar(deps: IntegrationDeps, windows: boolean): string | undefined {
  const env = deps.env ?? process.env;
  const path = windows ? join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32', 'tar.exe') : '/usr/bin/tar';
  return fs.existsSync(path) ? path : undefined;
}

function extractWithTar(archive: string, dest: string, kind: string, deps: IntegrationDeps, windows: boolean, home: string): void {
  const tar = systemTar(deps, windows);
  if (!tar) fail('extract', windows ? 'Falta %SystemRoot%\\System32\\tar.exe; esta versión de Windows no es compatible.' : 'Falta /usr/bin/tar; la plataforma no es compatible.');
  const run = deps.run ?? defaultRun;
  const flag = kind === 'tar.gz' ? 'z' : '';
  const env = isolatedEnv(deps.env ?? process.env, home);
  const call = (args: string[]) => run(tar!, args, { cwd: dest, env, timeout: EXTRACT_TIMEOUT_MS, stdio: 'pipe' });
  const names = call([`-${flag}tf`, archive]);
  const verbose = call([`-${flag}tvf`, archive]);
  if (names.error || names.status !== 0 || verbose.error || verbose.status !== 0) fail('extract', 'No se pudo leer el archivo descargado.');
  const reason = preflightListing(names.stdout.split(/\r?\n/).filter(Boolean), verbose.stdout.split(/\r?\n/).filter(Boolean));
  if (reason) fail('extract', reason);
  const extracted = call([`-${flag}xf`, archive, '-C', dest]);
  if (extracted.error || extracted.status !== 0) fail('extract', 'No se pudo extraer el archivo descargado.');
}

/** lstat walk over the extracted tree: plain files and directories only, bounded in count and size. */
export function validateTree(root: string): string | undefined {
  const top = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!top || !top.isDirectory() || top.isSymbolicLink()) return 'La carpeta extraída no es válida.';
  let entries = 0, bytes = 0;
  const pending = [root];
  while (pending.length) {
    const dir = pending.pop()!;
    for (const name of fs.readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return 'El archivo extraído salió de su carpeta.';
      const stat = fs.lstatSync(path);
      if (++entries > MAX_TREE_ENTRIES) return 'El archivo contiene demasiadas entradas.';
      if (stat.isSymbolicLink()) return 'El archivo extraído contiene enlaces.';
      if (stat.isDirectory()) { pending.push(path); continue; }
      if (!stat.isFile() || stat.nlink !== 1) return 'El archivo extraído contiene entradas no permitidas.';
      bytes += stat.size;
      if (bytes > MAX_TREE_BYTES) return 'El contenido extraído supera el tamaño permitido.';
    }
  }
  return undefined;
}

/** Locates the content root: Engram is flat, CodeGraph has exactly one `codegraph-<platform>` directory. */
function contentRoot(tool: ToolId, platform: PlatformKey, extractDir: string): string | undefined {
  if (tool === 'engram') return extractDir;
  const entries = fs.readdirSync(extractDir);
  if (entries.length !== 1 || entries[0] !== `codegraph-${platform}`) return undefined;
  return join(extractDir, entries[0]);
}

function checkLaunchFiles(dir: string, tool: ToolId, platform: PlatformKey): string | undefined {
  for (const rel of launchFiles(tool, platform)) {
    const stat = fs.lstatSync(absoluteOf(dir, rel), { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) return `Falta ${rel} en el archivo descargado (el antivirus pudo eliminarlo).`;
    if (process.platform !== 'win32' && !isWindows(platform) && rel !== 'lib/dist/bin/codegraph.js' && !(stat.mode & 0o111)) return `${rel} no es ejecutable.`;
  }
  return undefined;
}

/** Runs the version command in an isolated environment and requires the exact catalog output. */
function checkVersion(dir: string, tool: ToolId, platform: PlatformKey, release: ToolRelease, deps: IntegrationDeps, home: string): void {
  const catalog = (deps.catalog ?? CATALOG)[tool];
  const [file, ...head] = launchCommand(tool, dir, platform);
  const run = deps.run ?? defaultRun;
  const result = run(file!, [...head, ...catalog.versionArgs], { cwd: home, env: isolatedEnv(deps.env ?? process.env, home), timeout: VERSION_TIMEOUT_MS, stdio: 'pipe' });
  const blocked = 'No se pudo ejecutar el binario; el sistema o el antivirus pudo bloquearlo.';
  if (result.error || result.status !== 0) fail('version', blocked);
  if (result.stdout.length > VERSION_OUTPUT_LIMIT) fail('version', 'La salida de la comprobación de versión es demasiado grande.');
  if (result.stdout.trim() !== catalog.versionOutput.replace('{version}', release.version)) fail('version', `El binario no informa la versión esperada ${release.version}.`);
}

// ---------------------------------------------------------------------------------------------
// Candidate releases
// ---------------------------------------------------------------------------------------------

const kindOf = (asset: string): 'zip' | 'tar.gz' => asset.endsWith('.zip') ? 'zip' : 'tar.gz';
const assetUrl = (repo: string, version: string, asset: string) => `https://github.com/${repo}/releases/download/v${version}/${asset}`;

/** The reviewed catalog pin for this tool and platform. */
export function catalogRelease(tool: ToolId, platform: PlatformKey, deps: IntegrationDeps = {}): ToolRelease | { rejected: string } {
  const entry = (deps.catalog ?? CATALOG)[tool];
  const asset = entry?.assets[platform];
  if (!asset) return { rejected: 'No hay un paquete oficial para esta plataforma.' };
  return { tool, version: entry.version, asset: asset.asset, url: assetUrl(entry.repo, entry.version, asset.asset), size: asset.size, sha256: asset.sha256, format: entry.format, kind: kindOf(asset.asset), origin: 'catalog' };
}

/**
 * Explicit lookup of a newer stable release. Needs digest, size, checksum-file line and data format
 * from official GitHub metadata; any missing item rejects the candidate. Downloads no binaries.
 * A candidate must have the catalog's major version and exceed both the pin and `installed`.
 */
export async function lookupLatest(tool: ToolId, platform: PlatformKey, deps: IntegrationDeps, installed?: string): Promise<ToolRelease | { rejected: string }> {
  const entry = (deps.catalog ?? CATALOG)[tool];
  const pinned = entry?.assets[platform];
  if (!entry || !pinned) return { rejected: 'No hay un paquete oficial para esta plataforma.' };
  try {
    const listed: unknown = JSON.parse(await readText('download', `https://api.github.com/repos/${entry.repo}/releases?per_page=30`, RELEASES_LIMIT, deps));
    if (!Array.isArray(listed)) return { rejected: 'La lista de versiones no tiene el formato esperado.' };
    const floor = installed && compareVersions(installed, entry.version) > 0 ? installed : entry.version;
    const major = entry.version.split('.')[0];
    const candidates = listed.filter((release): release is Record<string, unknown> => plain(release)
      && release.draft === false && release.prerelease === false
      && typeof release.tag_name === 'string' && /^v\d+\.\d+\.\d+$/.test(release.tag_name)
      && release.tag_name.slice(1).split('.')[0] === major && compareVersions(release.tag_name.slice(1), floor) > 0)
      .sort((a, b) => compareVersions((b.tag_name as string).slice(1), (a.tag_name as string).slice(1)));
    const chosen = candidates[0];
    if (!chosen) return { rejected: 'No hay una versión estable más nueva compatible.' };
    const version = (chosen.tag_name as string).slice(1);
    const name = pinned.asset.split(entry.version).join(version);
    const asset = Array.isArray(chosen.assets) ? chosen.assets.find((item): item is Record<string, unknown> => plain(item) && item.name === name) : undefined;
    if (!asset) return { rejected: `La versión ${version} no publica ${name}.` };
    const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1] : undefined;
    if (!digest) return { rejected: `La versión ${version} no publica un digest SHA-256.` };
    if (typeof asset.size !== 'number' || !Number.isInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) return { rejected: `El tamaño publicado de ${name} no es aceptable.` };
    const sums = await readText('download', assetUrl(entry.repo, version, entry.checksums), CHECKSUMS_LIMIT, deps);
    const listedDigest = sums.split(/\r?\n/).map(line => /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line.trim())).find(match => match?.[2] === name)?.[1]?.toLowerCase();
    if (listedDigest !== digest) return { rejected: `El archivo de sumas no confirma el digest de ${name}.` };
    const source = await readText('download', `https://raw.githubusercontent.com/${entry.repo}/v${version}/${entry.formatFile}`, FORMAT_SOURCE_LIMIT, deps);
    const number = new RegExp(entry.formatPattern).exec(source)?.[1];
    if (!number) return { rejected: `No se pudo determinar el formato de datos de ${version}.` };
    return { tool, version, asset: name, url: assetUrl(entry.repo, version, name), size: asset.size, sha256: digest, format: `${entry.format.split(':')[0]}:${number}`, kind: kindOf(name), origin: 'lookup' };
  } catch (error) {
    return { rejected: error instanceof Error ? error.message : 'La consulta de versiones falló.' };
  }
}

// ---------------------------------------------------------------------------------------------
// Install pipeline
// ---------------------------------------------------------------------------------------------

/**
 * Downloads, verifies, extracts, validates and version-checks a release in an isolated stage, then
 * places it in `integrations/<tool>/<version>-<sha8>/` and records it. It never activates anything:
 * registering the command is a separate, later step. Throws IntegrationInstallError (with the failing
 * stage) and leaves earlier versions untouched; the stage is always removed.
 */
export async function stageRelease(paths: IntegrationPaths, release: ToolRelease, platform: PlatformKey, deps: IntegrationDeps): Promise<{ record: InstalledVersion; reused: boolean }> {
  const { tool } = release;
  const entry = (deps.catalog ?? CATALOG)[tool];
  if (!entry || !SEMVER.test(release.version) || !HEX64.test(release.sha256) || !FORMAT.test(release.format)
    || !Number.isInteger(release.size) || release.size <= 0 || release.size > MAX_ASSET_BYTES) {
    fail('preflight', 'La versión candidata no es válida.');
  }
  const state = readManifest(paths);
  if ('unreadable' in state) fail('preflight', `${state.unreadable}; no se instalará nada.`);
  const manifest = (state as { manifest: Manifest }).manifest;
  const name = versionDirName(tool, release);
  const existing = manifest.tools[tool]?.versions[release.version];
  if (existing && existing.sha256 === release.sha256 && existing.platform === platform && verifyInstalled(paths, tool, existing) === 'intact') {
    return { record: existing, reused: true };
  }

  fs.mkdirSync(paths.configRoot, { recursive: true });
  ensureDirectory(paths.configRoot, 'mdd/integrations/.stage');
  cleanStale(paths, (deps.now?.() ?? new Date()).getTime());
  const stage = join(paths.stageRoot, `${tool}-${stageId(deps)}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    const extractDir = join(stage, 'extract'), home = join(stage, 'home'), archive = join(stage, 'asset');
    fs.mkdirSync(extractDir, { mode: 0o700 });
    fs.mkdirSync(home, { mode: 0o700 });
    await download(release, archive, deps);
    if (deps.extract) deps.extract(archive, extractDir, release.kind);
    else extractWithTar(archive, extractDir, release.kind, deps, isWindows(platform), home);
    const content = contentRoot(tool, platform, extractDir);
    if (!content) return fail('validate', 'El archivo no tiene la estructura esperada.');
    const invalid = validateTree(content) ?? checkLaunchFiles(content, tool, platform);
    if (invalid) return fail('validate', invalid);
    const launch = launchDigests(content, tool, platform);
    checkVersion(content, tool, platform, release, deps, home);

    const toolDir = ensureDirectory(paths.root, tool);
    const dest = join(toolDir, name.slice(tool.length + 1));
    let reused = false;
    if (fs.lstatSync(dest, { throwIfNoEntry: false })) {
      let matches = false;
      try { matches = JSON.stringify(launchDigests(dest, tool, platform)) === JSON.stringify(launch); } catch { /* not comparable */ }
      if (!matches) return fail('place', 'El directorio existente no coincide con la versión revisada; no se reemplazó.');
      reused = true;
    } else {
      try { retryTransient(() => fs.renameSync(content, dest)); }
      catch { return fail('place', 'No se pudo colocar la versión en su carpeta final.'); }
    }
    const record: InstalledVersion = {
      version: release.version, dir: name, platform, source: release.url, sha256: release.sha256, format: release.format,
      launch, installedAt: (deps.now?.() ?? new Date()).toISOString(), origin: release.origin,
    };
    try { recordInstalled(paths, tool, record); }
    catch (error) { throw new IntegrationInstallError('record', error instanceof Error ? error.message : 'No se pudo registrar la versión.', dest); }
    return { record, reused };
  } finally {
    try { removeTree(stage); } catch { /* reported by the next stale cleanup */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------------------------

/**
 * Removes recorded versions that are not in `keep`. A directory that cannot be removed (for example
 * EBUSY while a process runs it) stays recorded and is reported. Unrecorded directories are never touched.
 */
export function pruneVersions(paths: IntegrationPaths, tool: ToolId, keep: string[], options: { remove?: (path: string) => void } = {}): { removed: string[]; kept: { version: string; reason: string }[] } {
  const state = readManifest(paths);
  if ('unreadable' in state) return { removed: [], kept: [{ version: '*', reason: state.unreadable }] };
  const removed: string[] = [], kept: { version: string; reason: string }[] = [];
  const remove = options.remove ?? removeTree;
  for (const record of Object.values(state.manifest.tools[tool]?.versions ?? {})) {
    if (keep.includes(record.version)) { kept.push({ version: record.version, reason: 'versión en uso o anterior conservada' }); continue; }
    try {
      const dir = versionDirectory(paths, tool, record);
      scopedPath(paths.root, record.dir, true);
      remove(dir);
      removed.push(record.version);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /does not exist/.test((error as Error).message)) removed.push(record.version);
      else kept.push({ version: record.version, reason: `no se pudo eliminar: ${(error as NodeJS.ErrnoException).code ?? 'error'}` });
    }
  }
  if (removed.length) {
    try { updateManifest(paths, manifest => { for (const version of removed) delete manifest.tools[tool]?.versions[version]; }); }
    catch { kept.push(...removed.splice(0).map(version => ({ version, reason: 'se eliminó el directorio pero no se pudo actualizar el manifiesto' }))); }
  }
  return { removed, kept };
}
