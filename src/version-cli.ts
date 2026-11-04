import fs from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { Cancelled, ask, choose, createTerminalIO, heading, note, rows } from './tui.js';
import type { ConfigIO } from './tui.js';
import { ValidationError } from './validation.js';
import { COMMAND, commandPlan, registerPath } from './command-link.js';
import { gitExecutable } from './judgment-day.js';
import { installationPaths } from './installation-paths.js';
import { acquireLock, identityLabel, readJournal, readLockOwner, readState, recordReleases, VersionStoreError } from './version-store.js';
import type { Identity, LockHandle, VersionState } from './version-store.js';
import {
  DEV_NOTES, DOCTOR_TIMEOUT_MS, SourceError, discover, ensureLayout, firstSeen, notesFor, prepareDev, prepareRelease, readCache, resolveAlias, resolveExact,
  showAt, sourcePaths,
} from './version-source.js';
import type { Discovery, ObservedTag, SourceDeps, SourcePaths } from './version-source.js';
import { SwitchError, formatSwitchResult, installedPackageDigest, isAlreadyActive, recover, switchTo } from './version-switch.js';
import type { SwitchDeps, SwitchPlan, SwitchTarget } from './version-switch.js';
import { ensureRouting, readCurrent, recoveryCommand } from './version-manager.js';
import type { ManagerCurrent, ManagerPaths } from './version-manager.js';
import { channelOf, compareVersions, parseReleaseTag } from './versions.js';

/**
 * Router of the version manager (`mdd/manager/entry.mjs` calls `main(argv)`).
 * It handles `use`, `versions`, `link`, the version wizard and the doctor merge itself, and delegates every
 * other command to the active package CLI. The manager copy never uses PACKAGE_ROOT-based helpers.
 */

export interface RouterDeps {
  paths?: ManagerPaths;
  io?: ConfigIO;
  cwd?: string;
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => Date;
  /** Test seams for the switch transaction and the release/dev preparation. */
  switch?: SwitchDeps;
  source?: SourceDeps;
  /** Edits the user's PATH on Windows; tests replace it so no environment is ever touched. */
  registerPath?: typeof registerPath;
  /** Replaces the child process that runs the active package CLI; receives the argv and returns its exit code. */
  delegate?: (args: string[], options: { capture: boolean }) => Promise<{ code: number; stdout: string }>;
}

export interface Ctx {
  paths: ManagerPaths;
  sp: SourcePaths;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
  now: () => Date;
  deps: RouterDeps;
}

export function makeCtx(deps: RouterDeps): Ctx {
  const paths = deps.paths ?? installationPaths();
  return {
    paths, sp: sourcePaths(paths.ownedRoot), cwd: deps.cwd ?? process.cwd(), deps,
    out: deps.out ?? (text => { process.stdout.write(text); }),
    err: deps.err ?? (text => { process.stderr.write(text); }),
    now: deps.now ?? (() => new Date()),
  };
}

const MANAGER_HELP = `Versiones (gestor):
  mdd-ai versions              lista versiones, identidad activa y canales
  mdd-ai use <destino>         cambia de versión: 0.2.0 | v0.3.0-preview.1 | stable | preview | dev
                               opciones: --checkout <ruta> (solo dev), --yes (sin pregunta)
`;
const NO_ACTIVE = 'No hay una versión activa utilizable. Elegí una con mdd-ai use <versión>.';

// ---------------------------------------------------------------- helpers

const short = (commit: string): string => commit.slice(0, 7);
const stamp = (date: Date | undefined): string => (date ? `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'nunca');
const channelName = (version: string): string => (parseReleaseTag(version)?.preview === null ? 'estable' : 'preview');

function describeActive(active: VersionState['active']): string {
  if (!active) return 'sin identificar';
  const commit = short(active.commit);
  if (active.kind === 'dev') {
    return `dev ${active.version} · ${commit}${active.dirty ? ' · con cambios locales' : ''}${typeof active.checkout === 'string' ? ` · ${active.checkout}` : ''}`;
  }
  const verified = active.verified as { dist?: boolean } | undefined;
  const parts = [`${channelName(active.version)} ${active.version} · ${commit}`];
  if (active.provenance === 'adopted') parts.push(verified?.dist === false ? 'adoptada (build no verificado)' : 'adoptada');
  if (typeof active.selectedAs === 'string') parts.push(`elegida como «${active.selectedAs}»`);
  return parts.join(' · ');
}

function eligibleTags(discovery: Discovery | undefined): ObservedTag[] {
  return (discovery?.tags ?? []).filter(tag => tag.status === 'eligible' && tag.version)
    .sort((a, b) => compareVersions(parseReleaseTag(b.version!)!, parseReleaseTag(a.version!)!));
}

function topOf(tags: ObservedTag[], channel: 'stable' | 'preview'): ObservedTag | undefined {
  return tags.find(tag => channelOf(parseReleaseTag(tag.version!)!) === channel);
}

function driftNote(paths: ManagerPaths, state: VersionState): string | undefined {
  if (!state.active || typeof state.active.packageDigest !== 'string') return undefined;
  try {
    return installedPackageDigest(paths) === state.active.packageDigest ? undefined
      : 'external-change: el paquete instalado cambió fuera del gestor (por ejemplo una instalación manual). Para volver a una versión conocida: mdd-ai use <versión>.';
  } catch { return 'external-change: no se pudo comprobar el paquete instalado.'; }
}

/** Takes the lock, recovers an interrupted switch and re-asserts routing afterwards. Blocked recovery refuses mutations. */
async function locked<T>(ctx: Ctx, command: string, work: (lock: LockHandle) => Promise<T>): Promise<T> {
  const lock = acquireLock(ctx.sp, command);
  try {
    const recovered = recover(lock, ctx.paths, ctx.deps.switch);
    if (recovered.status === 'blocked') throw new SwitchError('blocked', recovered.message);
    if (recovered.status !== 'none') ctx.err(`${recovered.message}\n`);
    return await work(lock);
  } finally {
    try { ensureRouting(ctx.paths); } catch { /* routing is re-asserted by the next command */ }
    lock.release();
  }
}

function git(ctx: Ctx, cwd: string, args: string[]): string {
  ensureLayout(ctx.sp);
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync(gitExecutable(ctx.sp.versionsRoot), ['-c', `core.hooksPath=${ctx.sp.noHooks}`, '-c', 'core.fsmonitor=false', ...args], {
    cwd, env, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Dev identity known before the build (needed for the journal); `prepareDev` repeats the full validation. */
function devIdentity(ctx: Ctx, checkout: string): Identity {
  const fail = (detail: string): SourceError => new SourceError('dev-checkout', 'dev', detail);
  if (!isAbsolute(checkout)) throw fail('La ruta del checkout debe ser absoluta.');
  if (!fs.statSync(checkout, { throwIfNoEntry: false })?.isDirectory()) throw fail(`No existe el directorio ${checkout}.`);
  let pkg: { name?: unknown; version?: unknown };
  try { pkg = JSON.parse(fs.readFileSync(join(checkout, 'package.json'), 'utf8')) as typeof pkg; } catch { throw fail(`${checkout} no contiene un package.json legible.`); }
  if (pkg.name !== 'my-driven-development') throw fail(`El paquete de ${checkout} no es my-driven-development.`);
  if (typeof pkg.version !== 'string' || !pkg.version) throw fail('package.json no declara una versión.');
  let commit: string;
  try { commit = git(ctx, checkout, ['rev-parse', 'HEAD']).trim(); } catch { throw fail(`${checkout} no es un repositorio Git con commits.`); }
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw fail('No se pudo leer el commit del checkout.');
  return { kind: 'dev', version: pkg.version, commit };
}

// ---------------------------------------------------------------- discovery

function disclose(ctx: Ctx): void { ctx.out('Consultando el origen (git fetch de las etiquetas v*)…\n'); }

/** Fetches and classifies. Returns the reason instead of throwing when no origin is registered. */
function tryDiscover(ctx: Ctx, state: VersionState): { discovery?: Discovery; reason?: string } {
  if (!state.origin) return { reason: 'No hay un origen registrado; ejecutá npm run setup desde un checkout.' };
  disclose(ctx);
  try { return { discovery: discover(ctx.sp, state) }; }
  catch (error) { return { reason: error instanceof Error ? error.message : String(error) }; }
}

// ---------------------------------------------------------------- versions

export function renderVersions(input: {
  paths: ManagerPaths; sp: SourcePaths; state: VersionState; discovery?: Discovery | undefined; reason?: string | undefined; notes?: string[] | undefined;
}): string {
  const { state, discovery } = input;
  const current = readCurrent(input.paths);
  const list = eligibleTags(discovery);
  const stable = topOf(list, 'stable');
  const preview = topOf(list, 'preview');
  const origin = discovery
    ? `${discovery.origin} · ${discovery.stale ? `sin conexión: datos del ${stamp(discovery.fetchedAt)}` : `consultado ${stamp(discovery.fetchedAt)}`}`
    : input.reason ?? 'no configurado';
  const head: [string, string][] = [
    ['Gestor de versiones', current ? `revisión ${current.revision} · instalado desde ${current.version} (${current.source === 'release' ? 'release' : 'checkout'})` : 'no instalado'],
    ['Activa', describeActive(state.active)],
  ];
  const drift = driftNote(input.paths, state);
  if (drift) head.push(['Aviso', drift]);
  if (state.adoption?.status === 'refused') head.push(['Adopción', `rechazada: ${String(state.adoption.reason)}`]);
  head.push(['Origen', origin]);
  head.push(['Canales', `stable → ${stable?.version ?? 'ninguna'} · preview → ${preview?.version ?? 'ninguna'} · dev → ${state.devCheckout ?? 'no configurado'}`]);
  let text = `${heading('MDD · Versiones')}${rows(head)}`;
  if (list.length) {
    text += '  Versiones\n';
    for (const tag of list) {
      const active = state.active?.kind === 'release' && state.active.version === tag.version;
      const cached = readCache(input.sp, tag.version!).status === 'valid' ? 'en caché' : 'sin compilar';
      text += `    ${active ? '*' : ' '} ${tag.version!.padEnd(18)} ${channelName(tag.version!).padEnd(8)} ${short(tag.commit!)}  ${cached}\n`;
    }
  }
  if (state.active?.kind === 'dev') text += `    * ${'dev'.padEnd(18)} ${'dev'.padEnd(8)} ${short(state.active.commit)}  compila en el checkout\n`;
  const rejected = (discovery?.tags ?? []).filter(tag => tag.status !== 'eligible');
  if (rejected.length) text += `  No seleccionables  ${rejected.map(tag => `${tag.tag} (${tag.reason ?? tag.status})`).join(' · ')}\n`;
  for (const line of input.notes ?? []) text += `  ${line}\n`;
  text += '  stable y preview se resuelven una sola vez al elegir; la instalación no sigue el canal.\n';
  return text;
}

async function versionsCommand(ctx: Ctx): Promise<number> {
  readState(ctx.sp); // a corrupt state.json fails before anything else
  let lock: LockHandle | undefined;
  const notes: string[] = [];
  try { lock = acquireLock(ctx.sp, 'versions'); }
  catch (error) {
    if (!(error instanceof VersionStoreError) || error.code !== 'busy') throw error;
    notes.push(`${error.message} Se muestra la lista sin registrar cambios.`);
  }
  try {
    if (lock) {
      const recovered = recover(lock, ctx.paths, ctx.deps.switch);
      if (recovered.status !== 'none') notes.push(recovered.message);
    } else {
      const journal = readJournal(ctx.sp);
      if (journal) notes.push(`Hay un cambio de versión en curso o incompleto (${journal.phase}).`);
    }
    const found = tryDiscover(ctx, readState(ctx.sp));
    if (lock && found.discovery && !found.discovery.stale) {
      recordReleases(lock, firstSeen(found.discovery, readState(ctx.sp)), ctx.now());
    }
    ctx.out(renderVersions({ paths: ctx.paths, sp: ctx.sp, state: readState(ctx.sp), discovery: found.discovery, reason: found.reason, notes }));
    return 0;
  } finally {
    if (lock) { try { ensureRouting(ctx.paths); } catch { /* next command */ } lock.release(); }
  }
}

// ---------------------------------------------------------------- use

export interface SwitchRequest { target: string; checkout?: string | undefined; yes: boolean }

const USE_USAGE = 'Uso: mdd-ai use <0.2.0|v0.3.0-preview.1|stable|preview|dev> [--checkout <ruta>] [--yes]';

export function parseUse(args: string[]): SwitchRequest {
  let target: string | undefined;
  let checkout: string | undefined;
  let yes = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--yes') yes = true;
    else if (arg === '--checkout') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new ValidationError(USE_USAGE);
      checkout = value;
    } else if (arg.startsWith('-') || target !== undefined) throw new ValidationError(USE_USAGE);
    else target = arg;
  }
  if (!target) throw new ValidationError(USE_USAGE);
  if (checkout !== undefined && target !== 'dev') throw new ValidationError('--checkout solo se usa con dev. ' + USE_USAGE);
  if (target !== 'dev' && target !== 'stable' && target !== 'preview' && !parseReleaseTag(target)) {
    throw new ValidationError(`«${target}» no es un destino válido (X.Y.Z, X.Y.Z-preview.N, stable, preview o dev). ${USE_USAGE}`);
  }
  return { target, checkout, yes };
}

async function confirmReview(ctx: Ctx, io: ConfigIO | undefined, request: SwitchRequest, plan: SwitchPlan): Promise<boolean> {
  ctx.out(`${heading('Revisión del cambio')}${plan.review.map(line => note(line)).join('')}`);
  if (request.yes) return true;
  if (!io?.isTTY) return false;
  try {
    return await choose(io, '¿Aplicamos este cambio de versión?', [
      { value: 'apply', label: 'Aplicar', hint: 'Respalda y reemplaza exactamente lo listado' },
      { value: 'cancel', label: 'Cancelar', hint: 'No se cambia nada' },
    ], { initial: 1, unknownCancels: true }) === 'apply';
  } catch (error) { if (error instanceof Cancelled) return false; throw error; }
}

/**
 * The single switch flow used by `use` and by the wizard (R6): resolve, print identity and notes BEFORE any
 * preparation, confirm, then `switchTo`. The caller holds the lock and has already recovered.
 */
export async function runSwitch(ctx: Ctx, lock: LockHandle, io: ConfigIO | undefined, request: SwitchRequest, known?: Discovery): Promise<number> {
  if (!request.yes && !io?.isTTY) throw new ValidationError('Hace falta una terminal interactiva para confirmar el cambio, o pasá --yes. No se cambió nada.');
  let state = readState(ctx.sp);
  let target: SwitchTarget;
  let notes: string;
  let after = (): void => {};
  const info: [string, string][] = [];

  if (request.target === 'dev') {
    const checkout = request.checkout ? resolve(request.checkout) : state.devCheckout;
    if (!checkout) throw new ValidationError('No hay un checkout dev configurado. Usá mdd-ai use dev --checkout <ruta> o ejecutá npm run setup desde un checkout.');
    const identity = devIdentity(ctx, checkout);
    const outDir = join(ctx.sp.txRoot, `dev-${randomBytes(4).toString('hex')}`);
    after = () => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* swept later */ } };
    target = {
      identity, channel: 'dev', selectedAs: 'dev',
      prepare: () => prepareDev(lock, { checkout, outDir }, ctx.deps.source),
      packagedSource: path => { try { return fs.readFileSync(join(checkout, ...path.split('/'))); } catch { return undefined; } },
    };
    info.push(['Destino', `dev ${identity.version} · ${short(identity.commit)} · ${checkout}`],
      ['Build', 'compila en el checkout: dist/ (npm run build --ignore-scripts; instala dependencias solo si faltan)']);
    notes = DEV_NOTES;
  } else {
    const found = known ? { discovery: known } : tryDiscover(ctx, state);
    const discovery = found.discovery;
    if (!discovery) throw new SourceError('origin', 'las versiones', 'reason' in found && found.reason ? found.reason : 'No se pudo consultar el origen.');
    if (!discovery.stale) recordReleases(lock, firstSeen(discovery, state), ctx.now());
    state = readState(ctx.sp);
    const resolution = request.target === 'stable' || request.target === 'preview' ? resolveAlias(discovery, request.target) : resolveExact(discovery, state, request.target);
    if (!resolution.ok) {
      if (resolution.code === 'stale' || resolution.code === 'unrecorded') throw new SourceError('fetch', 'la consulta del origen', resolution.message);
      throw new ValidationError(resolution.message);
    }
    const tag = resolution.tag;
    const identity: Identity = { kind: 'release', version: tag.version!, commit: tag.commit! };
    if (isAlreadyActive(ctx.paths, identity)) {
      ctx.out(`${describeActive(state.active)}\n${identity.version} ya activa; no se cambió nada.\n`);
      return 0;
    }
    target = {
      identity, channel: channelOf(parseReleaseTag(identity.version)!), selectedAs: request.target,
      prepare: () => prepareRelease(lock, tag, ctx.deps.source),
      packagedSource: path => showAt(ctx.sp, identity.commit, path),
    };
    info.push(['Destino', `${channelName(identity.version)} ${identity.version} · ${short(identity.commit)}`],
      ['Origen', `${discovery.origin} · ${discovery.stale ? `sin conexión: datos del ${stamp(discovery.fetchedAt)}` : `consultado ${stamp(discovery.fetchedAt)}`}`],
      ['Build', readCache(ctx.sp, identity.version).status === 'valid' ? 'desde la caché local verificada'
        : 'se compila la etiqueta en un clon propio (npm ci y build con --ignore-scripts; puede descargar dependencias)']);
    notes = notesFor(ctx.sp, discovery, identity.version).text;
  }
  ctx.out(`${heading('MDD · Cambiar de versión')}${rows(info)}`);
  ctx.out(`  Notas de versión\n${notes.split(/\r?\n/).map(line => `    ${line}`).join('\n')}\n`);
  ctx.out(note('Preparando la versión elegida; la instalación activa no se toca hasta que confirmes.'));
  try {
    const outcome = await switchTo(lock, ctx.paths, target, { ...ctx.deps.switch, confirm: plan => confirmReview(ctx, io, request, plan) });
    if (outcome.status === 'already') { ctx.out(`${identityLabel(outcome.identity)} ya activa; no se cambió nada.\n`); return 0; }
    if (outcome.status === 'cancelled') { ctx.out('Cancelado. No se cambió nada.\n'); return 0; }
    ctx.out(`\n${formatSwitchResult(outcome.result).join('\n')}\n`);
    return 0;
  } finally { after(); }
}

async function useCommand(ctx: Ctx, args: string[]): Promise<number> {
  const request = parseUse(args);
  const io = ctx.deps.io ?? createTerminalIO().io;
  return locked(ctx, 'use', lock => runSwitch(ctx, lock, io, request));
}

// ---------------------------------------------------------------- wizard

export type VersionChoice = { kind: 'keep' } | { kind: 'switch'; request: SwitchRequest };

export interface WizardContext {
  state: VersionState;
  discovery?: Discovery | undefined;
  /** Why the origin could not be queried; shown instead of availability. */
  unavailable?: string | undefined;
  checkout?: string | undefined;
  mode: 'setup' | 'update';
  manager?: ManagerCurrent | undefined;
}

/** The one wizard step. Keep and cancel never switch; every other choice goes through `runSwitch` like the CLI. */
export async function chooseVersion(io: ConfigIO, context: WizardContext): Promise<VersionChoice> {
  const { state, discovery } = context;
  const list = eligibleTags(discovery);
  const stable = topOf(list, 'stable');
  const preview = topOf(list, 'preview');
  const checkout = context.checkout ?? state.devCheckout ?? undefined;
  const current = context.manager;
  io.write(`${heading(context.mode === 'update' ? 'MDD · Actualizar versión' : 'MDD · Elegir versión')}${rows([
    ['Gestor de versiones', current ? `revisión ${current.revision} (${current.version})` : 'no instalado'],
    ['Activa', describeActive(state.active)],
    ['Disponibles', discovery
      ? `estable ${stable?.version ?? 'ninguna'} · preview ${preview?.version ?? 'ninguna'}${discovery.stale ? ` (sin conexión: datos del ${stamp(discovery.fetchedAt)})` : ''}`
      : context.unavailable ?? 'sin datos del origen']])}`);
  const choices: { value: string; label: string; hint?: string }[] = [];
  if (state.active) choices.push({ value: 'keep', label: `Conservar ${state.active.version}`, hint: 'repara la instalación activa sin cambiar de versión' });
  if (stable) choices.push({ value: 'stable', label: `Estable → ${stable.version}`, hint: 'la más nueva estable; se resuelve una sola vez' });
  if (preview) choices.push({ value: 'preview', label: `Preview → ${preview.version}`, hint: 'la preview más nueva; se resuelve una sola vez' });
  if (list.length) choices.push({ value: 'other', label: 'Otra versión…', hint: 'elegir de la lista' });
  choices.push({ value: 'dev', label: checkout ? `dev → ${checkout}` : 'dev → elegir checkout…', hint: 'compila el checkout local' });
  choices.push({ value: 'cancel', label: 'Cancelar', hint: 'no se cambia nada' });
  const activeVersion = state.active?.kind === 'release' ? parseReleaseTag(state.active.version) : undefined;
  const newer = [stable, preview].find(tag => tag && (!activeVersion || compareVersions(parseReleaseTag(tag.version!)!, activeVersion) > 0));
  let initial = 0;
  if (context.checkout && (!state.active || context.mode === 'update')) initial = choices.findIndex(choice => choice.value === 'dev');
  else if (context.mode === 'update' && newer) initial = choices.findIndex(choice => choice.value === (newer === stable ? 'stable' : 'preview'));
  const picked = await choose(io, '¿Qué versión querés usar?', choices, { initial: Math.max(initial, 0), unknownCancels: true });
  if (picked === 'cancel') throw new Cancelled();
  if (picked === 'keep') return { kind: 'keep' };
  if (picked === 'stable' || picked === 'preview') return { kind: 'switch', request: { target: picked, yes: false } };
  if (picked === 'dev') {
    const path = checkout ?? await ask(io, 'Ruta absoluta del checkout de MDD', 'Debe ser la raíz de un repositorio Git de my-driven-development.');
    return { kind: 'switch', request: { target: 'dev', checkout: path, yes: false } };
  }
  const version = await choose(io, 'Versiones disponibles', list.map(tag => ({ value: tag.version!, label: tag.version!, hint: `${channelName(tag.version!)} · ${short(tag.commit!)}` })), { unknownCancels: true });
  return { kind: 'switch', request: { target: version, yes: false } };
}

async function wizardCommand(ctx: Ctx, mode: 'setup' | 'update', args: string[]): Promise<number> {
  let checkout: string | undefined;
  if (args.length === 2 && args[0] === '--checkout' && args[1]) checkout = resolve(args[1]);
  else if (args.length) throw new ValidationError(`Uso: mdd-ai ${mode}. Abre el asistente de versiones; desde un checkout: npm run setup.`);
  const terminal = ctx.deps.io ? undefined : createTerminalIO();
  const io = ctx.deps.io ?? terminal!.io;
  if (!io.isTTY) throw new ValidationError(`mdd ${mode} necesita una terminal interactiva. No se hizo ningún cambio.`);
  return locked(ctx, mode, async lock => {
    const state = readState(ctx.sp);
    const found = tryDiscover(ctx, state);
    if (found.discovery && !found.discovery.stale) recordReleases(lock, firstSeen(found.discovery, state), ctx.now());
    let choice: VersionChoice;
    try {
      choice = await chooseVersion(io, { state: readState(ctx.sp), discovery: found.discovery, unavailable: found.reason, checkout, mode, manager: readCurrent(ctx.paths) });
    } catch (error) {
      if (error instanceof Cancelled) { ctx.out('\n  Cancelado. No se cambió nada.\n'); return 0; }
      throw error;
    }
    if (choice.kind === 'keep') {
      terminal?.close();
      return (await delegate(ctx, [mode], false)).code;
    }
    return runSwitch(ctx, lock, io, choice.request, found.discovery);
  });
}

// ---------------------------------------------------------------- delegation

/** Runs the active package CLI as a child with inherited stdio (or captured stdout). Routing is restored afterwards. */
async function delegate(ctx: Ctx, args: string[], capture: boolean): Promise<{ code: number; stdout: string }> {
  try {
    if (ctx.deps.delegate) return await ctx.deps.delegate(args, { capture });
    const cli = ctx.paths.cliPath;
    if (!fs.existsSync(cli)) { ctx.err(`${NO_ACTIVE}\n`); return { code: 1, stdout: '' }; }
    if (!capture && (args[0] === 'setup' || args[0] === 'update') && !fs.existsSync(join(ctx.paths.installedPackageRoot, 'dist', 'version-manager.js'))) {
      ctx.err(`Nota: la versión activa no conoce el gestor. Si se interrumpe a la fuerza, restaurá el enrutamiento con: ${recoveryCommand(ctx.paths)}\n`);
    }
    return await new Promise(done => {
      const child = spawn(process.execPath, [cli, ...args], { cwd: ctx.cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', windowsHide: true });
      let stdout = '';
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      const ignore = (): void => { /* the child handles Ctrl+C; the parent must survive to restore routing */ };
      const hangup = (): void => { try { ensureRouting(ctx.paths); } catch { /* best effort */ } process.exit(129); };
      process.on('SIGINT', ignore);
      process.on('SIGHUP', hangup);
      const finish = (code: number): void => { process.off('SIGINT', ignore); process.off('SIGHUP', hangup); done({ code, stdout }); };
      child.on('error', error => { ctx.err(`No se pudo ejecutar la versión activa: ${error.message}\n`); finish(1); });
      child.on('close', code => finish(code ?? 1));
    });
  } finally {
    try { ensureRouting(ctx.paths); } catch { /* the next command re-asserts it */ }
  }
}

// ---------------------------------------------------------------- doctor

type DoctorCheck = { check: string; status: 'ok' | 'action' | 'info'; message: string };
export interface DoctorReport { ready: boolean; scope: string; checks: DoctorCheck[] }

/** Pure merge: ready is the child's readiness AND no manager action. */
export function mergeDoctor(child: DoctorReport | undefined, manager: DoctorCheck[]): DoctorReport {
  const checks = [...(child?.checks ?? []), ...manager];
  const ready = (child?.ready ?? false) && !manager.some(item => item.status === 'action');
  return { ready, scope: child?.scope ?? 'global-installation-only', checks };
}

export function managerChecks(ctx: Ctx, options: { fetch?: boolean; timeout?: number } = {}): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const current = readCurrent(ctx.paths);
  checks.push({ check: 'version-manager', status: 'info', message: current ? `Gestor de versiones revisión ${current.revision} (desde ${current.version}).` : 'El gestor de versiones no está instalado; ejecutá npm run setup desde un checkout.' });
  let state: VersionState;
  try { state = readState(ctx.sp); }
  catch (error) { checks.push({ check: 'active-version', status: 'action', message: `El estado de versiones es ilegible: ${error instanceof Error ? error.message : String(error)}` }); return checks; }
  let journal: ReturnType<typeof readJournal>;
  try { journal = readJournal(ctx.sp); } catch { journal = undefined; checks.push({ check: 'active-version', status: 'action', message: 'El journal de cambios de versión es ilegible. Ejecutá cualquier comando mdd-ai para reintentar la recuperación.' }); }
  const owner = readLockOwner(ctx.sp);
  const drift = driftNote(ctx.paths, state);
  if (journal) {
    const blocked = journal.phase === 'blocked' ? ` ${journal.blocked?.reason ?? ''}` : '';
    checks.push({ check: 'active-version', status: 'action', message: `Cambio de versión incompleto (${journal.phase}).${blocked} No borres los datos de recuperación; volvé a ejecutar cualquier comando mdd-ai para reintentar.` });
  } else if (owner) {
    checks.push({ check: 'active-version', status: 'action', message: `Hay otra operación de MDD en curso (pid ${owner.pid}, ${owner.command}). Esperá a que termine.` });
  } else if (drift) {
    checks.push({ check: 'active-version', status: 'action', message: drift });
  } else if (state.active) {
    checks.push({ check: 'active-version', status: 'ok', message: `Versión activa: ${describeActive(state.active)}.` });
  } else {
    const refused = state.adoption?.status === 'refused' ? ` La adopción fue rechazada: ${String(state.adoption.reason)}` : '';
    checks.push({ check: 'active-version', status: 'info', message: `No hay una versión activa identificada.${refused} Elegí una con mdd-ai use <versión>.` });
  }
  if (!state.origin) {
    checks.push({ check: 'available-versions', status: 'info', message: 'No hay un origen registrado; no se consultaron versiones nuevas.' });
    return checks;
  }
  let found: Discovery;
  try { found = discover(ctx.sp, state, { fetch: options.fetch !== false, timeout: options.timeout ?? DOCTOR_TIMEOUT_MS }); }
  catch (error) {
    checks.push({ check: 'available-versions', status: 'info', message: `No se pudo consultar el origen (${error instanceof Error ? error.message : String(error)}); puede haber versiones más nuevas.` });
    return checks;
  }
  const list = eligibleTags(found);
  const active = state.active?.kind === 'release' ? parseReleaseTag(state.active.version) : undefined;
  const newer = (channel: 'stable' | 'preview'): ObservedTag | undefined => {
    const top = topOf(list, channel);
    return top && (!active || compareVersions(parseReleaseTag(top.version!)!, active) > 0) ? top : undefined;
  };
  const stable = newer('stable');
  const preview = newer('preview');
  const conflicts = found.tags.filter(tag => tag.status === 'conflict').map(tag => `${tag.tag} (${tag.reason})`);
  const tail = conflicts.length ? ` No seleccionables por conflicto: ${conflicts.join('; ')}.` : '';
  if (found.stale) {
    checks.push({ check: 'available-versions', status: 'info', message: `No se pudo consultar el origen${found.error ? ` (${found.error.replace(/\s+/g, ' ').trim()})` : ''}; datos locales del ${stamp(found.fetchedAt)}; puede haber versiones más nuevas.${tail}` });
  } else if (stable || preview) {
    const parts = [stable ? `estable ${stable.version}` : '', preview ? `preview ${preview.version}` : ''].filter(Boolean).join(', ');
    checks.push({ check: 'available-versions', status: 'info', message: `Hay versiones más nuevas: ${parts}. Para cambiar: mdd-ai use stable | preview. No se instala nada automáticamente.${tail}` });
  } else {
    checks.push({ check: 'available-versions', status: 'info', message: `Al día con el origen (consultado ${stamp(found.fetchedAt)}).${tail}` });
  }
  return checks;
}

async function doctorCommand(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length) throw new ValidationError('Uso: mdd-ai doctor');
  const manager = managerChecks(ctx);
  const result = await delegate(ctx, ['doctor'], true);
  let child: DoctorReport | undefined;
  try {
    const parsed = JSON.parse(result.stdout) as DoctorReport;
    if (Array.isArray(parsed?.checks) && typeof parsed.ready === 'boolean') child = parsed;
  } catch { /* handled below */ }
  if (!child && result.stdout.trim()) {
    // The active doctor printed something we cannot merge: pass it through, report the manager separately.
    ctx.out(result.stdout);
    ctx.err(`${JSON.stringify({ manager }, null, 2)}\n`);
    return result.code || (manager.some(item => item.status === 'action') ? 1 : 0);
  }
  const merged = child ? mergeDoctor(child, manager)
    : mergeDoctor({ ready: false, scope: 'global-installation-only', checks: [{ check: 'active-cli', status: 'action', message: NO_ACTIVE }] }, manager);
  ctx.out(`${JSON.stringify(merged, null, 2)}\n`);
  return merged.ready ? 0 : 1;
}

// ---------------------------------------------------------------- link and help

async function linkCommand(ctx: Ctx, args: string[]): Promise<number> {
  if (args.length) throw new ValidationError(`Uso: mdd-ai link. Instala el lanzador ${COMMAND} y agrega solo su carpeta al PATH de tu usuario.`);
  return locked(ctx, 'link', async () => {
    ensureRouting(ctx.paths);
    const plan = commandPlan(process.env, ctx.paths);
    if (plan.onPath) ctx.out(`${COMMAND} ya está en tu PATH: ${plan.binRoot}\n`);
    else if ((ctx.deps.registerPath ?? registerPath)(plan.binRoot) === 'registered') ctx.out(`Se agregó al PATH de tu usuario: ${plan.binRoot}\nAbrí una terminal nueva y ejecutá ${COMMAND}.\nEl PATH de la máquina no se tocó.\n`);
    else ctx.out(`Lanzador instalado en ${plan.binRoot}\nAgregalo al perfil de tu shell para usar ${COMMAND} desde cualquier lado:\n  ${plan.manual}\n`);
    return 0;
  });
}

async function helpCommand(ctx: Ctx): Promise<number> {
  const result = await delegate(ctx, ['--help'], true);
  ctx.out(`${MANAGER_HELP}\n${result.stdout}`);
  return 0;
}

// ---------------------------------------------------------------- entry

async function route(ctx: Ctx, argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined) return wizardCommand(ctx, 'setup', []);
  if (argv.length === 1 && (command === '--help' || command === '-h' || command === 'help')) return helpCommand(ctx);
  if (command === 'versions') {
    if (rest.length) throw new ValidationError('Uso: mdd-ai versions');
    return versionsCommand(ctx);
  }
  if (command === 'use') return useCommand(ctx, rest);
  if (command === 'link') return linkCommand(ctx, rest);
  if (command === 'setup' || command === 'update') return wizardCommand(ctx, command, rest);
  if (command === 'doctor') return doctorCommand(ctx, rest);
  const writes = command === 'config' || (command === 'profile' && (rest[0] === 'create' || rest[0] === 'use'));
  if (writes) return locked(ctx, command, async () => (await delegate(ctx, argv, false)).code);
  return (await delegate(ctx, argv, false)).code;
}

/** Called by the stable entry; returns the process exit code. */
export async function main(argv: string[], deps: RouterDeps = {}): Promise<number> {
  const ctx = makeCtx(deps);
  try { return await route(ctx, argv); }
  catch (error) {
    if (error instanceof Cancelled) { ctx.out('\n  Cancelado. No se cambió nada.\n'); return 0; }
    ctx.err(`Error de MDD: ${error instanceof Error ? error.message : 'Falla inesperada.'}\n`);
    return error instanceof ValidationError ? 2 : 1;
  }
}
