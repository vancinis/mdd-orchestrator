import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { installationPaths } from './installation-paths.js';
import { gitExecutable } from './judgment-day.js';
import {
  classify, planServerEdit, readLayers, writeGlobalConfig,
  type Classification, type IntegrationId, type LayerEntry, type Layers,
} from './integration-config.js';
import {
  CATALOG, IntegrationInstallError, catalogRelease, compareVersions, defaultRun, integrationPaths, isolatedEnv, launchCommand,
  lookupLatest, managedCommands, managedVersionForCommand, mcpCommand, platformKey, pruneVersions, readManifest,
  retainedVersions, setRegistration, stageRelease, verifyInstalled, versionDirectory,
  type InstalledVersion, type IntegrationPaths, type Manifest, type PlatformKey, type ToolId, type ToolRelease,
} from './integration-install.js';

/**
 * Engine of the optional integrations (Context7, Engram, CodeGraph). It composes the OpenCode
 * config editor and the owned install store, and is driven by the UI, doctor and tests alone
 * through `IntegrationDeps`. It never takes the version-manager lock, never opens Engram or
 * CodeGraph data, and is not imported by the manager import graph.
 */

// ---------------------------------------------------------------------------------------------
// Shared seam
// ---------------------------------------------------------------------------------------------

export interface RunOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; stdio?: 'pipe' | 'inherit' }
export interface RunResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type Runner = (file: string, args: string[], options: RunOptions) => RunResult;

export interface IntegrationDeps {
  fetch?: typeof fetch;
  run?: Runner;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => Date;
  id?: () => string;
  catalog?: typeof CATALOG;
  extract?: (archive: string, dest: string, kind: string) => void;
}

export type IntegrationState = 'managed' | 'external' | 'absent' | 'disabled' | 'conflict' | 'unknown';
export type ActionOutcome = 'completed' | 'unchanged' | 'failed' | 'not-attempted';
export type Evidence = 'yes' | 'no' | 'unknown' | 'not-tested';
export interface Dimension { value: Evidence; detail: string }

/** Exact CodeGraph launcher an init was reviewed against; `evidence` digests the registration, manifest record and file facts behind it. */
export type InitLauncher = {
  command: string[];
  origin: 'registered-managed' | 'registered-external' | 'unused-managed' | 'queued-install';
  evidence: string;
};

export type InitFingerprint = {
  root: string; top: string; dotGit: 'dir' | 'file'; entries: string[]; hooks: string[];
  /** Launcher resolved at review; `null` when none is launchable. Absent only in hand-made fixtures. */
  launcher?: InitLauncher | null;
};

/** Digest of every external input an action was reviewed against (config layer files and the manifest). */
export type Digests = Record<string, string>;

export type IntegrationAction =
  | { kind: 'configure'; tool: 'context7'; digests: Digests }
  | { kind: 'install' | 'update'; tool: ToolId; release: ToolRelease; digests: Digests }
  | { kind: 'register-external'; tool: ToolId; executable: string; digests: Digests }
  | { kind: 'init'; tool: 'codegraph'; target: InitFingerprint };

export interface ToolStatus {
  id: IntegrationId;
  label: string;
  state: IntegrationState;
  reason: string;
  installed: Dimension;
  configured: Dimension;
  connected: Dimension;
  usable: Dimension;
  /** Version of the managed install that the registration points at. */
  version?: string;
  /** Pending, reviewable actions; empty when nothing is useful or allowed. */
  offers: IntegrationAction[];
  /** Why an expected action is not offered (format change, tampered binary, unreadable manifest...). */
  notices: string[];
}

export interface IntegrationSnapshot {
  tools: ToolStatus[];
  platform: PlatformKey | undefined;
  blockers: string[];
  notes: string[];
  limits: string;
  digests: Digests;
}

export interface ActionResult {
  tool: IntegrationId;
  kind: IntegrationAction['kind'];
  outcome: ActionOutcome;
  reason: string;
  /** What did change, even when the action as a whole failed. */
  effects: string[];
  /** Partial effects or leftovers the user may need to know about. */
  residual: string[];
  /** An existing MCP process may need reconnecting to pick up an updated binary. */
  restart: boolean;
}

export interface ApplyReport { results: ActionResult[]; restartNote?: string }

export type Connection = 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'unknown';
export interface ProbeToolReport { version: Dimension; connected: Dimension & { status: Connection }; usable: Dimension }
export interface ProbeReport {
  disclosure: string;
  opencode: { ran: boolean; detail: string };
  tools: Record<IntegrationId, ProbeToolReport>;
}

export interface DoctorIntegrationSummary {
  check: 'integrations';
  status: 'info';
  message: string;
  tools: { id: IntegrationId; state: IntegrationState; detail: string }[];
}

export interface ReviewItem {
  tool: IntegrationId;
  kind: IntegrationAction['kind'];
  version?: string;
  source?: string;
  sha256?: string;
  destination?: string;
  configFile?: string;
  server?: string;
  command?: string[];
  notes: string[];
}

const LABELS: Record<IntegrationId, string> = { context7: 'Context7', engram: 'Engram', codegraph: 'CodeGraph' };
const CONTEXT7_URL = 'https://mcp.context7.com/mcp';
const RESTART_NOTE = 'Los cambios de configuración se recargan automáticamente. Si un proceso MCP sigue con el binario anterior, reconectá el servidor desde `/mcps`; MDD no detiene procesos.';
const CODEGRAPH_NOTE = 'Los daemons antiguos de CodeGraph pueden quedar hasta que estén inactivos; MDD no detiene procesos.';
export const PROBE_DISCLOSURE = 'La comprobación puede iniciar el servicio de OpenCode y conectar a servidores remotos; solo se ejecuta si la pedís.';
const INIT_TIMEOUT_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30 * 1000;
const PROBE_OUTPUT_LIMIT = 256 * 1024;

function inIsolatedHome<T>(fn: (home: string) => T): T {
  const home = fs.mkdtempSync(join(tmpdir(), 'mdd-probe-'));
  try { return fn(home); } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
const isWin = (platform: NodeJS.Platform): boolean => platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Context and reading
// ---------------------------------------------------------------------------------------------

interface Ctx {
  deps: IntegrationDeps;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  cwd: string;
  pkey: PlatformKey | undefined;
  catalog: typeof CATALOG;
  paths: IntegrationPaths;
  run: Runner;
}

function context(deps: IntegrationDeps): Ctx {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  return {
    deps, env, platform, cwd: deps.cwd ?? process.cwd(),
    pkey: platformKey(platform, deps.arch ?? process.arch),
    catalog: deps.catalog ?? CATALOG,
    paths: integrationPaths(installationPaths({ env })),
    run: deps.run ?? defaultRun,
  };
}

interface Read {
  ctx: Ctx;
  layers: Layers;
  manifest: Manifest | undefined;
  manifestProblem: string | undefined;
  digests: Digests;
}

function manifestDigest(paths: IntegrationPaths): string {
  try { return sha256(fs.readFileSync(paths.manifestPath)); } catch { return 'absent'; }
}

function read(ctx: Ctx): Read {
  const layers = readLayers({ cwd: ctx.cwd, env: ctx.env, platform: ctx.platform });
  const state = readManifest(ctx.paths);
  const digests: Digests = { manifest: manifestDigest(ctx.paths) };
  for (const layer of layers.layers) digests[layer.path] = layer.digest;
  digests[layers.target.path] = layers.target.beforeDigest;
  if (layers.blockers.length) digests.blockers = sha256(JSON.stringify(layers.blockers));
  return {
    ctx, layers, digests,
    manifest: 'manifest' in state ? state.manifest : undefined,
    manifestProblem: 'unreadable' in state ? state.unreadable : undefined,
  };
}

/** First reviewed input that differs from the current one, honoring the digests this run itself wrote. */
type Carry = Map<string, { before: string; after: string }>;
function stale(expected: Digests, current: Digests, carry: Carry): string | undefined {
  for (const [key, digest] of Object.entries(expected)) {
    const now = current[key], own = carry.get(key);
    if (now === digest || (own && digest === own.before && now === own.after)) continue;
    return key;
  }
  for (const [key, digest] of Object.entries(current)) if (!(key in expected) && digest !== 'absent') return key;
  return undefined;
}

function classifyTool(r: Read, id: IntegrationId): Classification {
  const commands = id === 'context7' || !r.manifest ? [] : managedCommands(r.ctx.paths, id, r.manifest, r.ctx.catalog);
  return classify(id, r.layers, commands);
}

/** First native executable called `name` on PATH (`.exe` on Windows, executable file elsewhere). */
export function findNative(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? '';
  const sep = platform === 'win32' ? ';' : delimiter;
  for (const directory of pathValue.split(sep)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, isWin(platform) ? `${name}.exe` : name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (isWin(platform) || (stat.mode & 0o111) !== 0)) return candidate;
    } catch { /* not here */ }
  }
  return undefined;
}

const effectiveEntry = (layers: Layers, file: string, name: string): LayerEntry | undefined => {
  let found: LayerEntry | undefined;
  for (const layer of [...layers.layers].sort((a, b) => a.rank - b.rank)) for (const entry of layer.entries) if (entry.name === name) found = entry;
  return found && found.file === file ? found : undefined;
};

const commandOf = (entry: LayerEntry | undefined): string[] | undefined =>
  entry && Array.isArray(entry.value.command) && entry.value.command.every((p) => typeof p === 'string') ? entry.value.command as string[] : undefined;

// ---------------------------------------------------------------------------------------------
// inspect and offers
// ---------------------------------------------------------------------------------------------

function indexEvidence(ctx: Ctx): Dimension {
  const own = join(ctx.cwd, '.codegraph', 'codegraph.db');
  const present = fs.existsSync(own);
  const ancestor = ancestorIndex(ctx.cwd);
  const detail = present ? 'índice presente en este directorio (no abierto)' : 'sin índice en este directorio';
  return { value: present ? 'unknown' : 'no', detail: ancestor ? `${detail}; ${ancestor}` : detail };
}

/** Warning when an ancestor already holds an index that CodeGraph's MCP server would walk up to. */
export function ancestorIndex(root: string): string | undefined {
  for (let dir = dirname(resolve(root)), previous = ''; dir !== previous; previous = dir, dir = dirname(dir)) {
    if (fs.existsSync(join(dir, '.codegraph', 'codegraph.db'))) return `un directorio superior (${dir}) tiene un índice que CodeGraph usaría hasta inicializar este checkout`;
  }
  return undefined;
}

function toolStatus(r: Read, id: IntegrationId): ToolStatus {
  const { ctx } = r;
  const cls = classifyTool(r, id);
  const remote = id === 'context7';
  const status: ToolStatus = {
    id, label: LABELS[id], state: 'unknown', reason: cls.reason,
    installed: { value: 'unknown', detail: '' },
    configured: { value: 'no', detail: cls.reason },
    connected: { value: 'not-tested', detail: 'sin comprobar' },
    usable: remote || id === 'engram'
      ? { value: 'unknown', detail: 'solo verificable en una sesión nueva de OpenCode' }
      : indexEvidence(ctx),
    offers: [], notices: [],
  };
  if (cls.state === 'blocked') {
    status.state = cls.why;
    status.installed = remote ? { value: 'yes', detail: 'servicio remoto · sin versión local' } : installedFromPath(ctx, id, r.manifest);
    status.configured = { value: cls.why === 'unknown' ? 'unknown' : 'no', detail: cls.reason };
    return status;
  }
  if (cls.state === 'absent') {
    status.state = 'absent';
    status.installed = remote ? { value: 'yes', detail: 'servicio remoto · sin versión local' } : installedFromPath(ctx, id, r.manifest);
    if (remote) status.offers.push({ kind: 'configure', tool: 'context7', digests: r.digests });
    else offerInstall(r, id as ToolId, status);
    return status;
  }
  // reuse
  status.configured = { value: 'yes', detail: cls.reason };
  if (remote) {
    status.state = 'external';
    status.installed = { value: 'yes', detail: 'servicio remoto · sin versión local' };
    return status;
  }
  const entry = effectiveEntry(r.layers, cls.file, cls.name);
  const command = commandOf(entry);
  if (cls.source === 'managed' && r.manifest && command) {
    status.state = 'managed';
    const record = managedVersionForCommand(ctx.paths, id as ToolId, r.manifest, command, ctx.catalog);
    if (record) {
      status.version = record.version;
      const integrity = verifyInstalled(ctx.paths, id as ToolId, record);
      status.installed = integrity === 'intact'
        ? { value: 'yes', detail: `gestionada por MDD, versión ${record.version}` }
        : { value: 'no', detail: `la versión gestionada ${record.version} está ${integrity === 'missing' ? 'incompleta' : 'alterada'}; MDD no la actualiza` };
      offerUpdate(r, id as ToolId, record, integrity, status);
    }
    return status;
  }
  status.state = 'external';
  const head = command?.[0];
  const exists = head ? (isAbsolute(head) ? fs.existsSync(head) : findNative(basename(head).replace(/\.exe$/i, ''), ctx.env, ctx.platform) !== undefined) : false;
  status.installed = { value: exists ? 'yes' : 'unknown', detail: exists ? `externa: ${head}` : 'configuración externa; el ejecutable no se pudo localizar' };
  return status;
}

function installedFromPath(ctx: Ctx, id: IntegrationId, manifest: Manifest | undefined): Dimension {
  const found = findNative(id, ctx.env, ctx.platform);
  const recorded = Object.keys(manifest?.tools[id as ToolId]?.versions ?? {});
  if (recorded.length) return { value: 'yes', detail: `versiones de MDD instaladas sin usar: ${recorded.join(', ')}` };
  return found ? { value: 'yes', detail: `ejecutable en PATH: ${found}` } : { value: 'no', detail: 'no encontrado' };
}

function offerInstall(r: Read, tool: ToolId, status: ToolStatus): void {
  const { ctx } = r;
  if (!ctx.pkey) { status.notices.push('Plataforma no compatible con los paquetes oficiales.'); return; }
  if (r.manifestProblem) { status.notices.push(`${r.manifestProblem}; MDD no instala hasta resolverlo.`); return; }
  const release = catalogRelease(tool, ctx.pkey, ctx.deps);
  if ('rejected' in release) status.notices.push(release.rejected);
  else status.offers.push({ kind: 'install', tool, release, digests: r.digests });
  const found = findNative(tool, ctx.env, ctx.platform);
  if (found) status.offers.push({ kind: 'register-external', tool, executable: found, digests: r.digests });
}

function offerUpdate(r: Read, tool: ToolId, record: InstalledVersion, integrity: string, status: ToolStatus): void {
  const { ctx } = r;
  if (integrity !== 'intact') { status.notices.push('No se ofrece actualizar una versión incompleta o alterada.'); return; }
  if (!ctx.pkey) return;
  if (r.layers.blockers.length) { status.notices.push(blockedText(r)); return; }
  const release = catalogRelease(tool, ctx.pkey, ctx.deps);
  if ('rejected' in release || compareVersions(release.version, record.version) <= 0) return;
  const gate = formatGate(record, release);
  if (gate) status.notices.push(gate); else status.offers.push({ kind: 'update', tool, release, digests: r.digests });
}

const blockedText = (r: Read): string => `No se puede modificar la configuración con seguridad: ${r.layers.blockers.join(' ')}`;

function formatGate(record: InstalledVersion, release: ToolRelease): string | undefined {
  if (record.format === release.format) return undefined;
  return `Cambia el formato de ${release.tool === 'engram' ? 'la memoria' : 'el índice'} (${record.format} → ${release.format}); MDD no actualiza cuando hay migración.`;
}

export function inspect(deps: IntegrationDeps): IntegrationSnapshot {
  const ctx = context(deps);
  const r = read(ctx);
  const tools = (['context7', 'engram', 'codegraph'] as IntegrationId[]).map((id) => toolStatus(r, id));
  return { tools, platform: ctx.pkey, blockers: r.layers.blockers, notes: r.layers.notes, limits: r.layers.limits, digests: r.digests };
}

/** Explicit, opt-in lookup of a newer stable release for a managed install (read-only metadata GET). */
export async function lookupOffer(tool: ToolId, deps: IntegrationDeps): Promise<{ offer: IntegrationAction } | { rejected: string }> {
  const ctx = context(deps);
  const r = read(ctx);
  if (!ctx.pkey) return { rejected: 'Plataforma no compatible con los paquetes oficiales.' };
  const cls = classifyTool(r, tool);
  const command = cls.state === 'reuse' && cls.source === 'managed' ? commandOf(effectiveEntry(r.layers, cls.file, cls.name)) : undefined;
  const record = command && r.manifest ? managedVersionForCommand(ctx.paths, tool, r.manifest, command, ctx.catalog) : undefined;
  if (r.layers.blockers.length) return { rejected: blockedText(r) };
  if (!record) return { rejected: 'Solo se busca una versión más nueva para una instalación gestionada por MDD.' };
  if (verifyInstalled(ctx.paths, tool, record) !== 'intact') return { rejected: 'La versión gestionada está incompleta o alterada.' };
  const release = await lookupLatest(tool, ctx.pkey, deps, record.version);
  if ('rejected' in release) return release;
  const gate = formatGate(record, release);
  return gate ? { rejected: gate } : { offer: { kind: 'update', tool, release, digests: r.digests } };
}

/** Everything the final review shows for an action (no effects). */
export function reviewOf(action: IntegrationAction, deps: IntegrationDeps): ReviewItem {
  const ctx = context(deps);
  const configFile = action.kind === 'init' ? undefined : read(ctx).layers.target.path;
  const base = { tool: action.tool as IntegrationId, kind: action.kind, notes: [] as string[] };
  if (action.kind === 'configure') {
    return { ...base, server: 'context7', command: ['remote', CONTEXT7_URL], source: CONTEXT7_URL, configFile: configFile!,
      notes: ['Servicio remoto, sin versión local. Si pide iniciar sesión, abrí `/mcps`, seleccioná Context7 y autorizalo. No se escriben credenciales.'] };
  }
  if (action.kind === 'init') {
    const launcher = action.target.launcher;
    const origin = { 'registered-managed': 'instalación gestionada registrada', 'registered-external': 'ejecutable nativo externo registrado (MDD no lo gestiona)',
      'unused-managed': 'instalación gestionada sin registrar', 'queued-install': 'la instalación puesta en cola en esta misma revisión' };
    return { ...base, destination: action.target.root, ...(launcher ? { command: [...launcher.command, 'init', action.target.root, '--yes'] } : {}), notes: [
      launcher ? `Ejecutable: ${origin[launcher.origin]}. Si cambia el registro, el manifiesto o el archivo, hay que revisar de nuevo.`
        : 'No hay un CodeGraph ejecutable gestionado o registrado; no se ejecutará nada sin instalarlo o registrarlo.',
      'Indexa todo el checkout; puede tardar minutos y no se puede deshacer una vez iniciado.',
      'Crea `.codegraph/` (con `.gitignore`, `codegraph.db` y posiblemente `errors.log`).',
      'La telemetría de CodeGraph queda desactivada para esta ejecución.',
      ...(ancestorIndex(action.target.root) ? [ancestorIndex(action.target.root)!] : []),
    ] };
  }
  if (action.kind === 'register-external') {
    return { ...base, destination: action.executable, server: action.tool, configFile: configFile!,
      command: [action.executable, ...ctx.catalog[action.tool].mcpArgs],
      notes: ['Ejecutable externo: MDD solo lo registra y nunca lo actualiza ni lo quita.'] };
  }
  const dir = join(ctx.paths.root, action.tool, `${action.release.version}-${action.release.sha256.slice(0, 8)}`);
  const platform = ctx.pkey ?? 'linux-x64';
  const notes = action.release.origin === 'lookup'
    ? ['Integridad según los metadatos de GitHub al consultar; no revisado por MDD.'] : [];
  if (action.tool === 'engram') notes.push('Engram abre cualquier ~/.engram (o ENGRAM_DATA_DIR) existente y puede repararlo o migrarlo según su política; MDD no lo lee ni lo respalda.');
  if (action.kind === 'update') {
    const current = inspect(deps).tools.find(tool => tool.id === action.tool)?.version ?? 'desconocida';
    notes.push(`Versión actual: ${current}; candidata: ${action.release.version}.`);
    notes.push('Volver a la versión anterior es solo de binarios; no revierte cambios en los datos.', RESTART_NOTE);
  }
  return { ...base, version: action.release.version, source: action.release.url, sha256: action.release.sha256, destination: dir,
    configFile: configFile!, server: action.tool, command: mcpCommand(action.tool, dir, platform, ctx.catalog), notes };
}

// ---------------------------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------------------------

const result = (a: IntegrationAction, outcome: ActionOutcome, reason: string, extra: Partial<ActionResult> = {}): ActionResult =>
  ({ tool: a.tool, kind: a.kind, outcome, reason, effects: [], residual: [], restart: false, ...extra });
const notAttempted = (a: IntegrationAction, reason: string): ActionResult => result(a, 'not-attempted', reason);
const STALE = 'Cambió desde la revisión; revisá de nuevo.';

type Commit = { ok: true; digest: string } | { ok: false; attempted: boolean; reason: string; residual?: string };

/** Revalidate against the reviewed digests, plan the narrow edit and write it atomically. */
async function commitServer(
  ctx: Ctx, expected: Digests, carry: Carry, name: string,
  change: Parameters<typeof planServerEdit>[2], check: (server: unknown) => boolean,
): Promise<Commit> {
  const fresh = read(ctx);
  if (fresh.layers.blockers.length) return { ok: false, attempted: false, reason: blockedText(fresh) };
  const changed = stale(expected, fresh.digests, carry);
  if (changed) return { ok: false, attempted: false, reason: STALE };
  const plan = planServerEdit(fresh.layers.target.text, name, change);
  if ('refused' in plan) return { ok: false, attempted: false, reason: plan.refused };
  const target = fresh.layers.target;
  const written = await writeGlobalConfig({ path: target.path, beforeDigest: target.beforeDigest }, plan.next, (parsed) => {
    const mcp = (parsed as { mcp?: { servers?: Record<string, unknown> } } | null)?.mcp;
    return check(mcp?.servers?.[name]);
  });
  if (written.status === 'failed') {
    return { ok: false, attempted: true, reason: written.reason, ...(written.residual ? { residual: written.residual } : {}) };
  }
  const own = carry.get(target.path);
  carry.set(target.path, { before: own?.before ?? target.beforeDigest, after: written.digest });
  return { ok: true, digest: written.digest };
}

const sameServer = (value: unknown) => (server: unknown) => isDeepStrictEqual(server, value);
const sameCommandOf = (command: string[]) => (server: unknown) =>
  isDeepStrictEqual((server as { command?: unknown } | undefined)?.command, command);

function commitFailure(a: IntegrationAction, commit: Extract<Commit, { ok: false }>, effects: string[], residual: string[]): ActionResult {
  if (!commit.attempted) return result(a, effects.length ? 'failed' : 'not-attempted', commit.reason, { effects, residual });
  return result(a, 'failed', commit.reason, { effects, residual: [...residual, ...(commit.residual ? [commit.residual] : [])] });
}

async function runConfigure(a: Extract<IntegrationAction, { kind: 'configure' }>, ctx: Ctx, carry: Carry): Promise<ActionResult> {
  const before = read(ctx);
  const changed = stale(a.digests, before.digests, carry);
  if (changed) return notAttempted(a, STALE);
  const cls = classifyTool(before, 'context7');
  if (cls.state === 'reuse') return result(a, 'unchanged', cls.reason);
  if (cls.state !== 'absent') return notAttempted(a, cls.reason);
  const value = { type: 'remote', url: CONTEXT7_URL };
  const commit = await commitServer(ctx, a.digests, carry, 'context7', { add: value }, sameServer(value));
  if (!commit.ok) return commitFailure(a, commit, [], []);
  return result(a, 'completed', 'Context7 quedó registrado como servicio remoto.', { effects: [`mcp.servers.context7 en ${before.layers.target.path}`] });
}

async function runRegisterExternal(a: Extract<IntegrationAction, { kind: 'register-external' }>, ctx: Ctx, carry: Carry): Promise<ActionResult> {
  const before = read(ctx);
  if (stale(a.digests, before.digests, carry)) return notAttempted(a, STALE);
  const cls = classifyTool(before, a.tool);
  if (cls.state === 'reuse') return result(a, 'unchanged', cls.reason);
  if (cls.state !== 'absent') return notAttempted(a, cls.reason);
  const found = findNative(a.tool, ctx.env, ctx.platform);
  if (!found || normalize(found).toLowerCase() !== normalize(a.executable).toLowerCase()) return notAttempted(a, 'El ejecutable en PATH cambió desde la revisión.');
  const entry = ctx.catalog[a.tool];
  const check = inIsolatedHome((home) => ctx.run(a.executable, entry.versionArgs, { cwd: home, env: isolatedEnv(ctx.env, home), timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' }));
  if (check.error || check.status !== 0) return notAttempted(a, 'El ejecutable externo no respondió a la comprobación de versión; no se registró.');
  const value = { type: 'local', command: [a.executable, ...entry.mcpArgs] };
  const commit = await commitServer(ctx, a.digests, carry, a.tool, { add: value }, sameServer(value));
  if (!commit.ok) return commitFailure(a, commit, [], []);
  return result(a, 'completed', `${LABELS[a.tool]} externo registrado; MDD no lo actualiza ni lo quita.`, { effects: [`mcp.servers.${a.tool} en ${before.layers.target.path}`] });
}

async function runInstall(a: Extract<IntegrationAction, { kind: 'install' | 'update' }>, ctx: Ctx, carry: Carry): Promise<ActionResult> {
  const { tool, release } = a;
  if (!ctx.pkey) return notAttempted(a, 'Plataforma no compatible con los paquetes oficiales.');
  const before = read(ctx);
  if (before.manifestProblem || !before.manifest) return notAttempted(a, `${before.manifestProblem ?? 'Manifiesto ilegible'}; no se instaló nada.`);
  if (release.tool !== tool) return notAttempted(a, 'La versión revisada no corresponde a esta herramienta.');
  if (before.layers.blockers.length) return notAttempted(a, blockedText(before));
  if (stale(a.digests, before.digests, carry)) return notAttempted(a, STALE);
  const cls = classifyTool(before, tool);

  let from: string[] | undefined, current: InstalledVersion | undefined;
  if (a.kind === 'install') {
    if (cls.state === 'reuse') return result(a, 'unchanged', cls.reason);
    if (cls.state !== 'absent') return notAttempted(a, cls.reason);
  } else {
    if (cls.state !== 'reuse' || cls.source !== 'managed') return notAttempted(a, 'El registro ya no es una instalación gestionada por MDD (editado o externo); no se actualiza.');
    if (cls.legacy || cls.file !== before.layers.target.path) return notAttempted(a, 'El registro no está en el archivo global editable; no se actualiza.');
    from = commandOf(effectiveEntry(before.layers, cls.file, cls.name));
    current = from ? managedVersionForCommand(ctx.paths, tool, before.manifest, from, ctx.catalog) : undefined;
    if (!from || !current) return notAttempted(a, 'El registro no coincide con ninguna versión instalada por MDD; no se actualiza.');
    if (verifyInstalled(ctx.paths, tool, current) !== 'intact') return notAttempted(a, 'La versión instalada está incompleta o alterada; no se actualiza.');
    const gate = formatGate(current, release);
    if (gate) return notAttempted(a, gate);
    const order = compareVersions(release.version, current.version);
    if (order === 0) return result(a, 'unchanged', `La versión ${current.version} ya está en uso.`);
    if (order < 0) return notAttempted(a, 'La versión revisada es anterior a la instalada; MDD no retrocede.');
  }

  let staged: { record: InstalledVersion; reused: boolean };
  try { staged = await stageRelease(ctx.paths, release, ctx.pkey, ctx.deps); }
  catch (error) {
    const placed = error instanceof IntegrationInstallError && error.placed ? [`Directorio colocado sin registrar: ${error.placed}`] : [];
    const stage = error instanceof IntegrationInstallError ? ` (${error.stage})` : '';
    return result(a, 'failed', `${error instanceof Error ? error.message : 'La instalación falló'}${stage}; no se activó nada.`, { residual: placed });
  }
  const track = () => {
    const now = manifestDigest(ctx.paths), own = carry.get('manifest');
    if (now !== (own?.after ?? before.digests.manifest)) carry.set('manifest', { before: own?.before ?? before.digests.manifest!, after: now });
  };
  track();

  const dir = versionDirectory(ctx.paths, tool, staged.record);
  const command = mcpCommand(tool, dir, ctx.pkey, ctx.catalog);
  const installed = [`${LABELS[tool]} ${staged.record.version} en ${dir}${staged.reused ? ' (ya presente)' : ''}`];
  const unused = ['La versión nueva quedó instalada y sin usar; el registro de OpenCode no cambió.'];
  const commit = a.kind === 'install'
    ? await commitServer(ctx, a.digests, carry, tool, { add: { type: 'local', command } }, (s) => isDeepStrictEqual((s as { command?: unknown } | undefined)?.command, command))
    : await commitServer(ctx, a.digests, carry, tool, { command: { from: from!, to: command } }, sameCommandOf(command));
  if (!commit.ok) return commitFailure(a, commit, installed, unused);

  const effects = [...installed, `mcp.servers.${tool} en ${before.layers.target.path}`];
  const residual: string[] = [];
  try { setRegistration(ctx.paths, tool, { file: basename(before.layers.target.path) as 'opencode.json' | 'opencode.jsonc', name: tool }); }
  catch { residual.push('No se pudo anotar el registro en el manifiesto; la configuración de OpenCode es la fuente de verdad.'); }
  track();
  if (a.kind === 'update') {
    const state = readManifest(ctx.paths);
    if ('manifest' in state) {
      const keep = retainedVersions(state.manifest, tool, release.version, current?.version);
      const pruned = pruneVersions(ctx.paths, tool, keep);
      if (pruned.removed.length) effects.push(`Versiones antiguas eliminadas: ${pruned.removed.join(', ')}`);
      for (const kept of pruned.kept) if (!keep.includes(kept.version)) residual.push(`${kept.version}: ${kept.reason}`);
      track();
    }
  }
  const reconnect = a.kind === 'update';
  const note = reconnect ? ` ${tool === 'codegraph' ? `${RESTART_NOTE} ${CODEGRAPH_NOTE}` : RESTART_NOTE}` : '';
  return result(a, 'completed', `${LABELS[tool]} ${a.kind === 'install' ? 'instalado y registrado' : 'actualizado'}.${note}`, { effects, residual, restart: reconnect });
}

export async function apply(actions: IntegrationAction[], deps: IntegrationDeps): Promise<ApplyReport> {
  const ctx = context(deps);
  const rank = (a: IntegrationAction) => (a.kind === 'configure' ? 0 : a.kind === 'init' ? 3 : a.tool === 'engram' ? 1 : 2);
  const ordered = actions.map((a, i) => ({ a, i })).sort((x, y) => rank(x.a) - rank(y.a) || x.i - y.i).map((e) => e.a);
  const carry: Carry = new Map();
  const results: ActionResult[] = [];
  let codegraphBlocked: string | undefined;
  for (const a of ordered) {
    let out: ActionResult;
    try {
      if (a.kind === 'configure') out = await runConfigure(a, ctx, carry);
      else if (a.kind === 'register-external') out = await runRegisterExternal(a, ctx, carry);
      else if (a.kind === 'init') out = codegraphBlocked ? notAttempted(a, codegraphBlocked) : await initCodeGraph(a.target, deps);
      else out = await runInstall(a, ctx, carry);
    } catch (error) {
      out = result(a, 'failed', `Error inesperado: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (a.tool === 'codegraph' && a.kind !== 'init' && (out.outcome === 'failed' || out.outcome === 'not-attempted')) {
      codegraphBlocked = 'CodeGraph no quedó disponible en esta ejecución; no se inicializó el repositorio.';
    }
    results.push(out);
  }
  const restart = results.some((x) => x.restart);
  const codegraph = results.some((x) => x.restart && x.tool === 'codegraph');
  return { results, ...(restart ? { restartNote: codegraph ? `${RESTART_NOTE} ${CODEGRAPH_NOTE}` : RESTART_NOTE } : {}) };
}

// ---------------------------------------------------------------------------------------------
// CodeGraph init (exact Git root)
// ---------------------------------------------------------------------------------------------

const samePath = (a: string, b: string, platform: NodeJS.Platform): boolean => {
  const left = normalize(resolve(a)), right = normalize(resolve(b));
  return platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
};

function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !name.toUpperCase().startsWith('GIT_')) clean[name] = value;
  return clean;
}

const codegraphEntries = (root: string): string[] =>
  fs.readdirSync(root).filter((name) => name.toLowerCase().startsWith('.codegraph')).sort();

function hookNames(directory: string): string[] {
  try { return fs.readdirSync(directory).sort(); } catch { return []; }
}

export function checkInitTarget(path: string, deps: IntegrationDeps, queued?: IntegrationAction): { ok: InitFingerprint } | { refused: string } {
  const ctx = context(deps);
  let real: string;
  try { real = fs.realpathSync(resolve(ctx.cwd, path)); } catch { return { refused: 'La ruta no existe.' }; }
  if (!fs.statSync(real).isDirectory()) return { refused: 'La ruta no es un directorio.' };
  if (dirname(real) === real) return { refused: 'No se inicializa la raíz del sistema de archivos.' };
  const home = ctx.env.HOME ?? ctx.env.USERPROFILE ?? homedir();
  try { if (samePath(real, fs.realpathSync(home), ctx.platform)) return { refused: 'No se inicializa el directorio personal.' }; } catch { /* no home to compare */ }
  if (ctx.env.CODEGRAPH_DIR) return { refused: 'CODEGRAPH_DIR está definida; el índice no quedaría en el repositorio.' };
  if (ctx.env.CODEGRAPH_NO_WATCH) return { refused: 'CODEGRAPH_NO_WATCH está definida; CodeGraph instalaría hooks de Git.' };
  if (ctx.platform === 'linux' && real.startsWith('/mnt/')) {
    let version = '';
    try { version = fs.readFileSync('/proc/version', 'utf8'); } catch { /* not linux proc */ }
    if (/microsoft/i.test(version)) return { refused: 'En WSL sobre /mnt/ CodeGraph instalaría hooks de Git.' };
  }
  let git: string;
  try { git = gitExecutable(real); } catch { return { refused: 'No se encontró un Git ejecutable de confianza.' }; }
  const env = gitEnv(ctx.env);
  const ask = (args: string[]) => ctx.run(git, ['-C', real, '-c', 'core.fsmonitor=false', ...args], { cwd: real, env, timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' });
  const toplevel = ask(['rev-parse', '--show-toplevel']);
  if (toplevel.error || toplevel.status !== 0) return { refused: 'No es un repositorio Git con árbol de trabajo (o es bare).' };
  const top = toplevel.stdout.trim();
  let topReal: string;
  try { topReal = fs.realpathSync(top); } catch { return { refused: 'Git informó una raíz inaccesible.' }; }
  if (!samePath(topReal, real, ctx.platform)) return { refused: `La ruta no es la raíz del repositorio (${topReal}); MDD no sustituye el directorio padre.` };
  const dotGitStat = fs.lstatSync(join(real, '.git'), { throwIfNoEntry: false });
  if (!dotGitStat || !(dotGitStat.isDirectory() || dotGitStat.isFile())) return { refused: 'No existe .git en la raíz.' };
  const entries = codegraphEntries(real);
  if (entries.length) return { refused: `Ya existe ${entries.join(', ')} en la raíz; MDD no reinicializa.` };
  const common = ask(['rev-parse', '--git-common-dir']);
  const commonDir = common.status === 0 && !common.error ? resolve(real, common.stdout.trim()) : join(real, '.git');
  const dependency = queued?.tool !== 'codegraph' ? undefined
    : queued.kind === 'install' || queued.kind === 'update' ? queuedLauncher(queued, ctx)
      : queued.kind === 'register-external' ? { command: [queued.executable], origin: 'queued-install' as const, evidence: digestOf(['queued', queued.executable]) } : undefined;
  const launcher = dependency ?? codegraphLauncher(read(ctx)) ?? null;
  return { ok: { root: real, top: topReal, dotGit: dotGitStat.isDirectory() ? 'dir' : 'file', entries, hooks: hookNames(join(commonDir, 'hooks')), launcher } };
}

function hookDir(root: string, ctx: Ctx): string {
  const git = gitExecutable(root);
  const out = ctx.run(git, ['-C', root, 'rev-parse', '--git-common-dir'], { cwd: root, env: gitEnv(ctx.env), timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' });
  return join(out.status === 0 ? resolve(root, out.stdout.trim()) : join(root, '.git'), 'hooks');
}

const exeBase = (path: string): string => basename(path).toLowerCase().replace(/\.exe$/, '');
const digestOf = (value: unknown): string => sha256(JSON.stringify(value));

/**
 * A plain native `codegraph` executable behind an external registration (`<exe> serve --mcp`),
 * absolute or found on PATH. Package-manager shims and scripts are never launched.
 */
function externalCodegraph(command: string[], ctx: Ctx): InitLauncher | undefined {
  if (command.indexOf('serve') !== 1 || !command.includes('--mcp')) return undefined;
  const head = command[0]!;
  if (exeBase(head) !== 'codegraph') return undefined;
  let file: string | undefined;
  if (isAbsolute(head)) file = head;
  else if (!/[\\/]/.test(head)) file = findNative('codegraph', ctx.env, ctx.platform);
  if (!file) return undefined;
  if (isWin(ctx.platform) && !/\.exe$/i.test(file)) return undefined;
  try {
    const real = fs.realpathSync(file), stat = fs.statSync(real);
    if (!stat.isFile() || (!isWin(ctx.platform) && (stat.mode & 0o111) === 0)) return undefined;
    if (/(^|[\\/])node_modules[\\/]/i.test(real) || /\.(?:[cm]?js|cmd|bat|ps1)$/i.test(real)) return undefined;
    return { command: [file], origin: 'registered-external', evidence: digestOf(['external', command, file, real, stat.size, stat.mtimeMs]) };
  } catch { return undefined; }
}

function managedLauncher(r: Read, record: InstalledVersion, origin: InitLauncher['origin'], registered?: string[]): InitLauncher | undefined {
  const { ctx } = r;
  if (verifyInstalled(ctx.paths, 'codegraph', record) !== 'intact') return undefined;
  const dir = versionDirectory(ctx.paths, 'codegraph', record);
  return { command: launchCommand('codegraph', dir, record.platform), origin, evidence: digestOf([origin, registered ?? null, record]) };
}

/**
 * The CodeGraph launcher an init uses: the effective registration's (managed record or native
 * external), or the newest intact unused managed install when nothing is registered. Uncertain
 * effective configuration (environment/MDM overrides) resolves nothing.
 */
function codegraphLauncher(r: Read): InitLauncher | undefined {
  const { ctx } = r;
  if (r.layers.blockers.length) return undefined;
  const cls = classifyTool(r, 'codegraph');
  if (cls.state === 'reuse') {
    const command = commandOf(effectiveEntry(r.layers, cls.file, cls.name));
    if (!command) return undefined;
    const record = cls.source === 'managed' && r.manifest ? managedVersionForCommand(ctx.paths, 'codegraph', r.manifest, command, ctx.catalog) : undefined;
    if (record) return managedLauncher(r, record, 'registered-managed', command);
    return cls.source === 'external' ? externalCodegraph(command, ctx) : undefined;
  }
  if (cls.state !== 'absent') return undefined;
  const newest = Object.values(r.manifest?.tools.codegraph?.versions ?? {})
    .filter((v) => verifyInstalled(ctx.paths, 'codegraph', v) === 'intact')
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  return newest ? managedLauncher(r, newest, 'unused-managed') : undefined;
}

/** Launcher the explicitly queued install/update will register, so init is bound to that dependency. */
function queuedLauncher(queued: Extract<IntegrationAction, { kind: 'install' | 'update' }>, ctx: Ctx): InitLauncher | undefined {
  if (queued.tool !== 'codegraph' || !ctx.pkey) return undefined;
  const dir = join(ctx.paths.root, 'codegraph', `${queued.release.version}-${queued.release.sha256.slice(0, 8)}`);
  return { command: launchCommand('codegraph', dir, ctx.pkey), origin: 'queued-install', evidence: digestOf(['queued', queued.release.version, queued.release.sha256]) };
}

export async function initCodeGraph(target: InitFingerprint, deps: IntegrationDeps): Promise<ActionResult> {
  const action: IntegrationAction = { kind: 'init', tool: 'codegraph', target };
  const ctx = context(deps);
  const recheck = checkInitTarget(target.root, deps);
  if ('refused' in recheck) return notAttempted(action, recheck.refused);
  const { launcher: reviewed, ...reviewedBase } = target, { launcher: current, ...currentBase } = recheck.ok;
  if (!isDeepStrictEqual(currentBase, reviewedBase)) return notAttempted(action, STALE);
  // A queued install dependency is bound by its exact command (it only exists after that install);
  // every other launcher must match the reviewed registration, record and file evidence.
  const same = reviewed?.origin === 'queued-install'
    ? isDeepStrictEqual(current?.command, reviewed.command)
    : isDeepStrictEqual(current ?? null, reviewed ?? null);
  if (!same) return notAttempted(action, STALE);
  if (!current) return notAttempted(action, 'No hay un CodeGraph ejecutable gestionado o registrado; instalalo o registralo primero.');
  const hooksPath = hookDir(target.root, ctx);
  const hooksBefore = hookNames(hooksPath);
  const [file, ...head] = current.command;
  const env = { ...ctx.env, CODEGRAPH_TELEMETRY: '0' };
  const out = ctx.run(file!, [...head, 'init', target.root, '--yes'], { cwd: target.root, env, timeout: INIT_TIMEOUT_MS, stdio: 'inherit' });
  const created = codegraphEntries(target.root);
  const hooksAfter = hookNames(hooksPath);
  const newHooks = hooksAfter.filter((name) => !hooksBefore.includes(name));
  const residual = [...created.map((name) => `Creado: ${join(target.root, name)}`), ...newHooks.map((name) => `Hook de Git nuevo: ${join(hooksPath, name)}`)];
  const database = fs.existsSync(join(target.root, '.codegraph', 'codegraph.db'));
  if (!out.error && out.status === 0 && database) {
    return result(action, 'completed', 'Índice creado (no verificado). Reiniciá OpenCode para que CodeGraph lo use.', { effects: residual, restart: true });
  }
  const why = out.error ? 'no se pudo ejecutar o superó el tiempo máximo' : out.status === 0 ? 'terminó sin crear codegraph.db' : `terminó con estado ${out.status}`;
  return result(action, 'failed', `La inicialización de CodeGraph falló: ${why}. MDD no limpia, repara ni reintenta.`, {
    residual: residual.length ? residual : ['No se detectaron artefactos parciales.'], effects: residual,
  });
}

// ---------------------------------------------------------------------------------------------
// Probe and doctor
// ---------------------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function parseMcpList(output: string, names: Record<IntegrationId, string>): Record<IntegrationId, Connection> {
  const lines = output.replace(ANSI, '').split(/\r?\n/);
  const out = {} as Record<IntegrationId, Connection>;
  for (const id of Object.keys(names) as IntegrationId[]) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])${names[id].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_.-])`, 'i');
    const line = lines.find((l) => pattern.test(l));
    out[id] = !line ? 'unknown'
      : /needs[ _-]?auth|requires?[ _-]?auth|autenticaci/i.test(line) ? 'needs-auth'
        : /fail|error|falla|disconnect/i.test(line) ? 'failed'
          : /disabled|desactiv/i.test(line) ? 'disabled'
            : /connected|conectado/i.test(line) ? 'connected' : 'unknown';
  }
  return out;
}

const CONNECTION_TEXT: Record<Connection, string> = {
  connected: 'conectado', 'needs-auth': 'requiere autenticación', failed: 'falla', disabled: 'desactivado', unknown: 'desconocido',
};

export async function probe(deps: IntegrationDeps): Promise<ProbeReport> {
  const ctx = context(deps);
  const r = read(ctx);
  const names = { context7: 'context7', engram: 'engram', codegraph: 'codegraph' } as Record<IntegrationId, string>;
  const heads: Partial<Record<ToolId, string[]>> = {};
  for (const id of ['context7', 'engram', 'codegraph'] as IntegrationId[]) {
    const cls = classifyTool(r, id);
    if (cls.state === 'reuse') names[id] = cls.name;
    if (id === 'context7' || cls.state !== 'reuse') continue;
    const command = commandOf(effectiveEntry(r.layers, cls.file, cls.name));
    const at = id === 'codegraph' ? command?.indexOf('serve') : command?.indexOf('mcp');
    if (command && at && at > 0 && isAbsolute(command[0]!)) heads[id] = command.slice(0, at);
  }

  const opencode = findNative('opencode', ctx.env, ctx.platform);
  let listed: Record<IntegrationId, Connection> | undefined;
  let detail = 'No se encontró un ejecutable nativo de opencode en PATH; conexión desconocida.';
  if (opencode) {
    const out = ctx.run(opencode, ['mcp', 'list'], { cwd: ctx.cwd, env: ctx.env, timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' });
    if (out.error || out.status !== 0) detail = 'opencode mcp list no terminó correctamente; conexión desconocida.';
    else if (out.stdout.length > PROBE_OUTPUT_LIMIT) detail = 'La salida de opencode mcp list es demasiado grande; conexión desconocida.';
    else { listed = parseMcpList(out.stdout, names); detail = 'Estado leído de `opencode mcp list`.'; }
  }

  const tools = {} as Record<IntegrationId, ProbeToolReport>;
  for (const id of ['context7', 'engram', 'codegraph'] as IntegrationId[]) {
    const status = listed?.[id] ?? 'unknown';
    const head = id === 'context7' ? undefined : heads[id];
    let version: Dimension = { value: 'not-tested', detail: id === 'context7' ? 'servicio remoto · sin versión local' : 'sin ejecutable registrado que comprobar' };
    if (head) {
      const entry = ctx.catalog[id as ToolId];
      const out = inIsolatedHome((home) => ctx.run(head[0]!, [...head.slice(1), ...entry.versionArgs], { cwd: home, env: isolatedEnv(ctx.env, home), timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' }));
      version = out.error || out.status !== 0 ? { value: 'no', detail: 'el ejecutable no respondió a la comprobación de versión' } : { value: 'yes', detail: out.stdout.slice(0, 2048).trim() };
    }
    tools[id] = {
      version,
      connected: { value: status === 'connected' ? 'yes' : status === 'unknown' ? 'unknown' : 'no', status, detail: CONNECTION_TEXT[status] },
      usable: id === 'codegraph' ? indexEvidence(ctx) : { value: 'unknown', detail: 'solo verificable en una sesión nueva de OpenCode' },
    };
  }
  return { disclosure: PROBE_DISCLOSURE, opencode: { ran: opencode !== undefined, detail }, tools };
}

export function doctorSummary(deps: IntegrationDeps): DoctorIntegrationSummary {
  try {
    const snapshot = inspect(deps);
    const tools = snapshot.tools.map((tool) => ({ id: tool.id, state: tool.state, detail: tool.version ? `${tool.state} (${tool.version})` : tool.state }));
    return { check: 'integrations', status: 'info', message: `Integraciones opcionales: ${tools.map((t) => `${t.id} ${t.detail}`).join('; ')}.`, tools };
  } catch (error) {
    return {
      check: 'integrations', status: 'info', tools: [],
      message: `Integraciones opcionales: no se pudo evaluar (${error instanceof Error ? error.message : 'error'}). El núcleo de MDD no depende de ellas.`,
    };
  }
}
