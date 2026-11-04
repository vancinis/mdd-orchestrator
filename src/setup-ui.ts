import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { Cancelled, choose, createTerminalIO, heading, note, rows } from './tui.js';
import type { ConfigIO } from './tui.js';
import { loadGlobalSettings, saveGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import { doctor } from './doctor.js';
import { initProject, installedPlugin, packageState, planProject, projectRoot } from './setup.js';
import { PACKAGE_ROOT } from './project-assets.js';
import { COMMAND, commandPlan, registerPath, writeLaunchers } from './command-link.js';
import { fileDigest, scopedPath } from './safe-paths.js';
import { ValidationError } from './validation.js';
import { gitExecutable } from './judgment-day.js';
import { acquireLock, readState, versionPaths, writeState } from './version-store.js';
import { showAt, sourcePaths, validateOrigin } from './version-source.js';
import { MANAGER_REVISION, installManager, managerHealthy, readCurrent } from './version-manager.js';
import { adoptInstallation, recover } from './version-switch.js';
import type { AdoptionResult } from './version-switch.js';
import { BASELINE } from './versions.js';

type Dependencies = {
  check: typeof doctor;
  commandPlan: typeof commandPlan; writeLaunchers: typeof writeLaunchers; registerPath: typeof registerPath;
  /** True when this code runs from a source checkout instead of the installed active package. */
  fromCheckout: (installedPackageRoot: string) => boolean;
  /** Runs `node <managerEntry> <args>` with the terminal inherited; returns the exit code. */
  handoff: (managerEntry: string, args: string[]) => number;
  /** `git show <baseline>:<path>`; `undefined` leaves a file unverified. */
  readBaselineFile: (path: string) => Buffer | undefined;
};

const realPath = (path: string): string => {
  let real: string;
  try { real = fs.realpathSync(path); } catch { real = resolve(path); }
  return process.platform === 'win32' ? real.toLowerCase() : real;
};

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT']) delete env[name];
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/** Local and offline: the baseline commit from the checkout, then (if present) the owned clone. */
function baselineFromGit(ownedRoot: string): (path: string) => Buffer | undefined {
  return path => {
    try {
      return execFileSync(gitExecutable(ownedRoot), ['-C', PACKAGE_ROOT, 'show', `${BASELINE.commit}:${path}`], {
        env: gitEnv(), maxBuffer: 8 * 1024 * 1024, timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch { /* try the owned clone */ }
    try { return showAt(sourcePaths(ownedRoot), BASELINE.commit, path); } catch { return undefined; }
  };
}

function checkoutOrigin(ownedRoot: string): string | undefined {
  try {
    const url = execFileSync(gitExecutable(ownedRoot), ['-C', PACKAGE_ROOT, 'remote', 'get-url', 'origin'], {
      env: gitEnv(), encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return validateOrigin(url);
  } catch { return undefined; }
}

const defaults = (ownedRoot: string): Dependencies => ({
  check: doctor, commandPlan, writeLaunchers, registerPath,
  fromCheckout: installed => realPath(PACKAGE_ROOT) !== realPath(installed),
  handoff: (entry, args) => spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' }).status ?? 1,
  readBaselineFile: baselineFromGit(ownedRoot),
});

export type SetupMode = 'setup' | 'update';
const STEPS: Record<SetupMode, readonly string[]> = {
  setup: ['Instalación global', 'Revisión de cambios', 'Aplicar y verificar'],
  update: ['Instalación existente', 'Revisión de cambios', 'Aplicar y verificar'],
};
function step(mode: SetupMode, index: number): string {
  return heading(`Paso ${index}/${STEPS[mode].length} \u00b7 ${STEPS[mode][index - 1]}`);
}
const BOOTSTRAP_STEPS = ['Gestor de versiones', 'Revisión de cambios', 'Aplicar y abrir el asistente'] as const;
const bootstrapStep = (index: number): string => heading(`Paso ${index}/${BOOTSTRAP_STEPS.length} \u00b7 ${BOOTSTRAP_STEPS[index - 1]}`);

export interface SetupOptions {
  mode?: SetupMode;
  /** Frees the terminal before the hand-off child inherits it. */
  release?: () => void;
}

function managerPlan(paths: ReturnType<typeof installationPaths>): { action: 'install' | 'upgrade' | 'keep'; text: string } {
  const current = readCurrent(paths);
  if (!current || !managerHealthy(current, paths)) return { action: 'install', text: `instalar el gestor (revisión ${MANAGER_REVISION})` };
  if (current.revision < MANAGER_REVISION) return { action: 'upgrade', text: `actualizar el gestor de la revisión ${current.revision} a la ${MANAGER_REVISION}` };
  return { action: 'keep', text: `se conserva el gestor instalado (revisión ${current.revision}); solo avanza` };
}

function hasInstalledPackage(root: string): boolean {
  try { installedPlugin(root); return true; } catch { return false; }
}

function adoptionLine(result: AdoptionResult): string {
  if (result.status === 'adopted') return result.message;
  if (result.status === 'refused') return `no se adoptó: ${result.message}`;
  return result.message;
}

/**
 * `npm run setup` from a checkout (DD17): bootstrap or upgrade the manager, record origin and dev checkout,
 * adopt an existing 0.2.0 installation, then hand off to the installed manager's wizard. Nothing here
 * activates a package; every activation goes through the switch transaction.
 */
async function bootstrapFromCheckout(cwd: string, io: ConfigIO, deps: Dependencies, mode: SetupMode, options: SetupOptions): Promise<'ready' | 'issues' | 'cancelled'> {
  const paths = installationPaths();
  const root = projectRoot(paths.configRoot);
  const vp = versionPaths(paths.ownedRoot);
  const manager = managerPlan(paths);
  const command = deps.commandPlan();
  let state: ReturnType<typeof readState> | undefined;
  try { state = readState(vp); } catch { state = undefined; }
  const origin = checkoutOrigin(paths.ownedRoot);
  const checkout = resolve(PACKAGE_ROOT);
  const unmanaged = hasInstalledPackage(root);
  const adoptable = !state?.active && (unmanaged || state?.adoption?.status === 'refused');
  const upToDate = manager.action === 'keep' && command.files.every(file => file.action === 'keep') && !!state && !adoptable
    && (origin === undefined || state.origin === origin) && state.devCheckout === checkout;

  const handoff = (): 'ready' | 'issues' => {
    options.release?.();
    return deps.handoff(paths.managerEntry, [mode, '--checkout', checkout]) === 0 ? 'ready' : 'issues';
  };
  io.write(`${heading(mode === 'update' ? 'MDD · Actualizar desde este checkout' : 'MDD · Instalación para OpenCode')}${note(
    'Este checkout instala o actualiza el gestor de versiones y abre su asistente. Nada se aplica sin tu confirmación explícita.')}`);
  io.write(`${bootstrapStep(1)}${rows([
    ['OpenCode', root], ['Carpeta propia de MDD', paths.ownedRoot], ['Checkout', checkout],
    ['Workspace activo', `${resolve(cwd)}  (no se modifica)`],
    ['Gestor de versiones', manager.text],
    ['Origen', origin ?? 'sin origen Git: solo estará disponible dev'],
  ])}`);
  if (upToDate) {
    io.write(note('El gestor, los lanzadores y el registro del checkout ya están al día: se abre el asistente de versiones.'));
    return handoff();
  }
  io.write(`${bootstrapStep(2)}${rows([
    ['gestor', manager.text],
    ...command.files.map(file => [file.action, file.path] as const),
    ['registrar', `origen y checkout dev en ${vp.statePath}`],
    ['adopción', state?.active ? 'ya hay una versión activa identificada: no se cambia'
      : unmanaged ? 'se intentará adoptar la instalación 0.2.0 existente (no se toca ningún archivo; si difiere de la línea base se rechaza)'
        : 'no hay instalación previa: el asistente te deja elegir (dev preseleccionado)'],
  ])}`);
  io.write(note(`El comando ${COMMAND} queda en ${command.binRoot} y pasa por el gestor, que sobrevive a cualquier cambio de versión. Este paso no usa la red ni instala ningún paquete.`));
  io.write(note('Los modelos heredan la selección nativa salvo que ya estén configurados; se cambian con mdd-ai config.'));
  try {
    if (await choose(io, '¿Aplicamos exactamente estos cambios?', [
      { value: 'apply', label: 'Aplicar', hint: 'Instala el gestor y abre el asistente de versiones' },
      { value: 'cancel', label: 'Cancelar', hint: 'No se escribe nada' },
    ], { initial: 1, unknownCancels: true }) !== 'apply') throw new Cancelled();
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.write('\n  Cancelado. No se aplicó ningún cambio ni descarga.\n');
    return 'cancelled';
  }
  io.write(bootstrapStep(3));
  const lock = acquireLock(vp, 'setup');
  let adoption: AdoptionResult | undefined;
  try {
    const recovered = recover(lock, paths);
    if (recovered.status === 'blocked') throw new Error(recovered.message);
    const pkg = JSON.parse(fs.readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
    const installed = installManager(join(PACKAGE_ROOT, 'dist'), { revision: MANAGER_REVISION, version: typeof pkg.version === 'string' ? pkg.version : 'dev', source: 'checkout' }, paths);
    deps.writeLaunchers(paths);
    const next = readState(vp);
    next.devCheckout = checkout;
    if (origin !== undefined) next.origin = origin;
    writeState(lock, next);
    adoption = adoptInstallation(lock, paths, { readBaselineFile: deps.readBaselineFile });
    io.write(rows([['Gestor', installed.action === 'installed' ? `revisión ${installed.current.revision} instalada` : installed.reason],
      ['Instalación existente', adoptionLine(adoption)]]));
  } finally { lock.release(); }
  io.write(note('Se abre el asistente de versiones del gestor instalado.'));
  return handoff();
}

export async function runSetupUI(cwd: string, io: ConfigIO, dependencies: Partial<Dependencies> = {}, options: SetupOptions = {}): Promise<'ready' | 'issues' | 'cancelled'> {
  if (!io.isTTY) throw new ValidationError('mdd setup necesita una terminal interactiva. No se hizo ningún cambio.');
  const paths = installationPaths();
  const deps = { ...defaults(paths.ownedRoot), ...dependencies };
  const mode = options.mode ?? 'setup';
  if (deps.fromCheckout(paths.installedPackageRoot)) return bootstrapFromCheckout(cwd, io, deps, mode, options);
  try {
    const root = projectRoot(paths.configRoot);
    io.write(`${heading(mode === 'update' ? 'MDD · Reparar la instalación global' : 'MDD · Instalación para OpenCode')}${note(mode === 'update'
      ? 'Reaplica los assets del paquete instalado. No cambia de versión, no toca tu configuración, la memoria ni otros agentes. Nada se aplica sin tu confirmación explícita.'
      : 'Repara la instalación global con la versión activa. Nada se aplica sin tu confirmación explícita.')}`);
    io.write(`${step(mode, 1)}${rows([
      ['OpenCode', root],
      ['Carpeta propia de MDD', paths.ownedRoot],
      ['Workspace activo', `${resolve(cwd)}  (no se modifica)`],
    ])}`);
    const draft = loadGlobalSettings();
    const before = JSON.stringify(draft);
    const changes = planProject(root, true);
    const state = packageState(root);
    if (state.state === 'foreign') throw new Error(state.reason);
    if (state.state === 'absent') {
      throw new ValidationError('No hay un paquete de MDD instalado desde el cual reparar. Ejecutá npm run setup desde un checkout o elegí una versión con mdd-ai use.');
    }
    if (state.state === 'outdated') {
      throw new ValidationError('El paquete instalado no coincide con el que ejecuta este comando. Cambiá de versión con mdd-ai use; setup no reemplaza paquetes.');
    }
    io.write(rows([['Paquete instalado', `v${state.installed.version} \u00b7 ${state.installed.digest.slice(0, 12)}`],
      ['Estado', 'al día: coincide con el paquete de origen']]));
    const packageSnapshot = ['mdd/package.json', 'mdd/package-lock.json'].map(name => fileDigest(scopedPath(root, name)));
    const command = deps.commandPlan();
    const review = 2;
    io.write(`${step(mode, review)}${rows([...changes.map(file => [file.action, file.name] as const),
      ['record', 'mdd/setup-assets.json'],
      ...command.files.map(file => [file.action, file.path] as const),
      [before !== JSON.stringify(draft) || !fs.existsSync(paths.settingsPath) ? 'save' : 'keep', paths.settingsPath]])}`);
    io.write(note(`El comando ${COMMAND} queda en ${command.binRoot} y abre esta misma instalación desde cualquier carpeta.`));
    if (changes.every(file => file.action === 'keep')) io.write(`\n${note('Todo está al día: no hay ningún cambio pendiente que aplicar.')}`);
    io.write(`\n${note('Los modelos heredan la selección nativa salvo que ya estén configurados; se cambian con mdd-ai config. Se preservan otros agentes, skills y default_agent.')}`);
    if (await choose(io, '¿Aplicamos exactamente estos cambios?', [
      { value: 'apply', label: 'Aplicar', hint: 'Aprueba exactamente lo listado arriba' },
      { value: 'cancel', label: 'Cancelar', hint: 'No se escribe ni se descarga nada' },
    ], { initial: 1, unknownCancels: true }) !== 'apply') throw new Cancelled();
    // Recheck the complete preflight before the first target write.
    if (JSON.stringify(loadGlobalSettings()) !== before || JSON.stringify(planProject(root, true)) !== JSON.stringify(changes) || packageState(root).state !== state.state ||
        JSON.stringify(['mdd/package.json', 'mdd/package-lock.json'].map(name => fileDigest(scopedPath(root, name)))) !== JSON.stringify(packageSnapshot)) throw new Error('Installation changed during review. Run setup again.');
    io.write(step(mode, review + 1));
    initProject(root, true);
    // The launcher lives in MDD's own folder, so the approved repair covers it. The PATH is the
    // user's environment: it changes only through the explicit link command, never as a side effect.
    deps.writeLaunchers(paths);
    if (before !== JSON.stringify(draft) || !fs.existsSync(paths.settingsPath)) saveGlobalSettings(draft);
    const report = await deps.check(cwd);
    if (!report.ready) {
      io.write(`\n  Quedan cosas por resolver:\n${rows(report.checks.filter(item => item.status === 'action').map(item => [item.check, item.message] as const))}${note('Los cambios ya aplicados quedan en la instalación global de MDD. La instalación no arrancó OpenCode ni ningún modelo.')}`);
      return 'issues';
    }
    const reachable = deps.commandPlan().onPath;
    io.write(`\n  Listo: las verificaciones de la instalación global pasaron.\n${note('Si OpenCode ya estaba abierto, ejecutá opencode service restart para cargar el plugin actualizado. Reiniciar solo la interfaz o ejecutar opencode reload puede conservar módulos anteriores en caché. El reinicio del servicio puede interrumpir ejecuciones activas; hacelo cuando no haya trabajo en curso.')}${note('La integración con los ajustes nativos globales y la aceptación de modelos todavía no están verificadas.')}${rows([
      ['Cambiar de versión', reachable ? `${COMMAND} use <versión>` : `node "${paths.managerEntry}" use <versión>`],
      ['Configuración', reachable ? `${COMMAND} config` : `node "${paths.managerEntry}" config`],
      ['Verificación', reachable ? `${COMMAND} doctor` : `node "${paths.managerEntry}" doctor`]])}${
      reachable ? note(`${COMMAND} ya está en tu PATH.`)
        : note(`Para ejecutar ${COMMAND} desde cualquier carpeta: node "${paths.managerEntry}" link`)}${note('Las instalaciones antiguas por proyecto quedan intactas; reconciliá sus assets propios explícitamente antes de usarlas.')}`);
    return 'ready';
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    io.write('\n  Cancelado. No se aplicó ningún cambio ni descarga.\n'); return 'cancelled';
  }
}

export async function runTerminalSetup(root: string, mode: SetupMode = 'setup'): Promise<void> {
  const { io, close } = createTerminalIO();
  if (!io.isTTY) throw new ValidationError(`mdd ${mode} necesita una terminal interactiva. No se hizo ningún cambio.`);
  try {
    if (await runSetupUI(root, io, {}, { mode, release: close }) === 'issues') process.exitCode = 1;
  } finally { close(); }
}
