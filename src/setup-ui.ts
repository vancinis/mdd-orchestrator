import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Cancelled, choose, createTerminalIO, heading, note, rows } from './tui.js';
import type { Choice, ConfigIO } from './tui.js';
import { loadGlobalSettings, saveGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import { doctor } from './doctor.js';
import { initProject, OWNED_PACKAGE, packageState, planProject, projectRoot } from './setup.js';
import { PACKAGE_ROOT } from './project-assets.js';
import { detectEngram, engramOffer, installEngram } from './engram-install.js';
import { COMMAND, commandPlan, registerPath, writeLaunchers } from './command-link.js';
import { fileDigest, scopedPath } from './safe-paths.js';
import { ValidationError } from './validation.js';

export function installLocalPackage(root: string, execute = execFileSync): void {
  root = join(projectRoot(root), 'mdd');
  const npm = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
    .find(path => path && fs.existsSync(path));
  if (!npm) throw new Error('npm CLI is unavailable beside Node. Launch setup with npm run setup from the trusted source checkout.');
  const scratch = fs.mkdtempSync(join(tmpdir(), 'mdd-package-'));
  try {
    const result = execute(process.execPath, [npm, 'pack', PACKAGE_ROOT, '--ignore-scripts', '--json', '--pack-destination', scratch], {
      cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true,
    });
    const name = JSON.parse(result.toString())[0]?.filename;
    if (typeof name !== 'string' || !/^my-driven-development-[0-9][a-zA-Z0-9.-]*\.tgz$/.test(name)) throw new Error('Unexpected local package output.');
    const packed = join(scratch, name);
    if (fs.statSync(packed).size > 32 * 1024 * 1024) throw new Error('Local MDD package exceeds its size limit.');
    const digest = createHash('sha256').update(fs.readFileSync(packed)).digest('hex');
    const artifact = scopedPath(root, `packages/my-driven-development-${digest}.tgz`);
    fs.mkdirSync(dirname(artifact), { recursive: true, mode: 0o700 });
    scopedPath(root, artifact);
    if (fs.existsSync(artifact)) {
      if (createHash('sha256').update(fs.readFileSync(artifact)).digest('hex') !== digest) throw new Error('Existing local MDD artifact has different content.');
    } else fs.copyFileSync(packed, artifact, fs.constants.COPYFILE_EXCL);
    const metadata = scopedPath(root, 'package.json');
    if (!fs.existsSync(metadata)) fs.writeFileSync(metadata, '{"private":true}\n', { flag: 'wx', mode: 0o600 });
    execute(process.execPath, [npm, 'install', artifact, '--prefix', root, '--workspaces=false', '--save-dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: root, timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

export const KEPT_PACKAGES = 3;

/**
 * Removes only an owned, outdated package so the reviewed reinstall can proceed.
 * Settings, memory, artifacts and deployed assets are never touched here.
 */
export function reconcileOwnedPackage(root: string): void {
  if (packageState(root).state !== 'outdated') throw new Error('Only an owned outdated MDD package can be reconciled.');
  const owned = join(projectRoot(root), 'mdd');
  fs.rmSync(scopedPath(owned, OWNED_PACKAGE, true), { recursive: true, force: true });
  const metadata = scopedPath(owned, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  for (const field of ['dependencies', 'devDependencies'] as const) {
    if (!pkg[field]) continue;
    delete pkg[field]['my-driven-development'];
    if (!Object.keys(pkg[field]).length) delete pkg[field];
  }
  fs.writeFileSync(metadata, `${JSON.stringify(pkg)}\n`, 'utf8');
}

/** Keeps the referenced tarball and the newest few, so a previous build stays restorable. */
export function pruneOwnedPackages(root: string, keep = KEPT_PACKAGES): string[] {
  const owned = join(projectRoot(root), 'mdd');
  const directory = join(owned, 'packages');
  if (!fs.existsSync(directory)) return [];
  const metadata = scopedPath(owned, 'package.json');
  const pkg = fs.existsSync(metadata) ? JSON.parse(fs.readFileSync(metadata, 'utf8')) : {};
  const referenced = [pkg.dependencies?.['my-driven-development'], pkg.devDependencies?.['my-driven-development']]
    .filter((value): value is string => typeof value === 'string' && value.startsWith('file:'))
    .map(value => value.slice(5).replaceAll('\\', '/').split('/').at(-1));
  const entries = fs.readdirSync(directory)
    .filter(name => /^my-driven-development-[0-9a-f]{64}\.tgz$/.test(name))
    .map(name => ({ name, time: fs.statSync(join(directory, name)).mtimeMs }))
    .sort((left, right) => right.time - left.time);
  const removed: string[] = [];
  for (const [index, entry] of entries.entries()) {
    if (index < keep || referenced.includes(entry.name)) continue;
    fs.rmSync(scopedPath(owned, `packages/${entry.name}`), { force: true });
    removed.push(entry.name);
  }
  return removed;
}

type Dependencies = {
  detect: typeof detectEngram; installMemory: typeof installEngram;
  installPackage: typeof installLocalPackage; check: typeof doctor;
  commandPlan: typeof commandPlan; writeLaunchers: typeof writeLaunchers; registerPath: typeof registerPath;
};
const defaults: Dependencies = { detect: detectEngram, installMemory: installEngram, installPackage: installLocalPackage, check: doctor, commandPlan, writeLaunchers, registerPath };
const DETECTION_TEXT: Record<string, string> = {
  compatible: 'encontrado y compatible', incompatible: 'encontrado con versión no soportada',
  broken: 'encontrado pero no respondió la prueba de versión', 'not-found': 'no encontrado',
};
export type SetupMode = 'setup' | 'update';
const STEPS: Record<SetupMode, readonly string[]> = {
  setup: ['Instalación global', 'Memoria opcional', 'Revisión de cambios', 'Aplicar y verificar'],
  update: ['Instalación existente', 'Revisión de cambios', 'Aplicar y verificar'],
};
function step(mode: SetupMode, index: number): string {
  return heading(`Paso ${index}/${STEPS[mode].length} \u00b7 ${STEPS[mode][index - 1]}`);
}

export async function runSetupUI(cwd: string, io: ConfigIO, dependencies: Partial<Dependencies> = {}, options: { mode?: SetupMode } = {}): Promise<'ready' | 'issues' | 'cancelled'> {
  if (!io.isTTY) throw new ValidationError('mdd setup necesita una terminal interactiva. No se hizo ningún cambio.');
  const deps = { ...defaults, ...dependencies };
  const mode = options.mode ?? 'setup';
  try {
    const paths = installationPaths();
    const root = projectRoot(paths.configRoot);
    io.write(`${heading(mode === 'update' ? 'MDD \u00b7 Actualizar la instalación global' : 'MDD \u00b7 Instalación para OpenCode')}${note(mode === 'update'
      ? 'Reemplaza el paquete instalado y sus assets. No toca tu configuración, la memoria ni otros agentes. Nada se aplica sin tu confirmación explícita.'
      : 'Se instala una sola vez, de forma global. Nada se aplica sin tu confirmación explícita.')}`);
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
    if (mode === 'update' && state.state === 'absent') {
      throw new ValidationError('No hay una instalación de MDD en la carpeta propia. Usá mdd setup para instalarla por primera vez.');
    }
    if (state.state !== 'absent') {
      io.write(rows([['Paquete instalado', `v${state.installed.version} \u00b7 ${state.installed.digest.slice(0, 12)}`],
        ...(state.state === 'outdated' ? [['Paquete de origen', `v${state.source.version} \u00b7 ${state.source.digest.slice(0, 12)}`] as const] : []),
        ['Estado', state.state === 'outdated' ? 'desactualizado: se puede actualizar en esta corrida' : 'al día: coincide con el paquete de origen']]));
    }
    const packageSnapshot = ['mdd/package.json', 'mdd/package-lock.json'].map(name => fileDigest(scopedPath(root, name)));
    let install = false;
    let detection: ReturnType<typeof detectEngram> | undefined;
    let offer: ReturnType<typeof engramOffer> | undefined;
    if (mode === 'setup') {
      io.write(`${step(mode, 2)}${note('La memoria es opcional: MDD funciona completo sin ella.')}${note('La detección ejecuta una prueba de versión aislada y acotada; su chequeo de actualizaciones se redirige a un proxy loopback cerrado. Esto no es un sandbox para binarios arbitrarios.')}`);
      let ownedOffer: ReturnType<typeof engramOffer> | undefined;
      try { ownedOffer = engramOffer(paths.ownedRoot); } catch { /* Platform availability is reported below. */ }
      detection = deps.detect(draft.engram && 'mode' in draft.engram ? { binary: draft.engram.binary } :
        ownedOffer && fs.existsSync(ownedOffer.binary) ? { binary: ownedOffer.binary } : {});
      io.write(rows([['Engram', `${DETECTION_TEXT[detection.status] ?? detection.status}${detection.version ? ` v${detection.version}` : ''}${detection.binary ? ` \u2014 ${detection.binary}` : ''}`]]));
      if (detection.status !== 'compatible') {
        try { offer = engramOffer(paths.ownedRoot); } catch { io.write(note('La instalación automática de memoria no está soportada en este sistema/arquitectura. Seguir sin memoria es una opción válida.')); }
      }
      const options: Choice[] = [{ value: 'keep', label: draft.engram ? 'Mantener la memoria ya activada' : 'Seguir sin memoria', hint: 'Es la opción por defecto' }];
      if (draft.engram) options.push({ value: 'off', label: 'Apagar la memoria', hint: 'MDD sigue funcionando completo' });
      if (detection.status === 'compatible' && detection.binary) options.push({ value: 'use', label: 'Usar el Engram encontrado', hint: 'Sin descargas ni actualizaciones' });
      if (offer) options.push({ value: 'install', label: 'Instalar Engram 1.20.0', hint: 'Agrega un binario propio y fijado, sin tocar el existente' });
      const choice = await choose(io, '¿Qué hacemos con la memoria opcional?', options);
      if (choice === 'off') delete draft.engram;
      else if (choice === 'use' && detection.status === 'compatible' && detection.binary) {
        draft.engram = { mode: 'local', binary: detection.binary, dataDirectory: paths.memoryRoot };
      } else if (choice === 'install' && offer) {
        if (fs.existsSync(resolve(offer.binary, '..'))) throw new Error(`Installation destination exists: ${resolve(offer.binary, '..')}`);
        draft.engram = { mode: 'local', binary: offer.binary, dataDirectory: paths.memoryRoot }; install = true;
      }
      if (draft.engram && 'mode' in draft.engram) io.write(`${rows([['Datos de memoria', draft.engram.dataDirectory]])}${note('La instalación nunca arranca el servicio de memoria ni crea una sesión.')}`);
    }
    const command = deps.commandPlan();
    const review = mode === 'update' ? 2 : 3;
    io.write(`${step(mode, review)}${rows([...changes.map(file => [file.action, file.name] as const),
      ['record', 'mdd/setup-assets.json'],
      ...command.files.map(file => [file.action, file.path] as const),
      [before !== JSON.stringify(draft) || !fs.existsSync(paths.settingsPath) ? 'save' : 'keep', paths.settingsPath]])}`);
    io.write(note(`El comando ${COMMAND} queda en ${command.binRoot} y abre esta misma instalación desde cualquier carpeta.`));
    if (state.state === 'absent') io.write(`\n${note(`Instalar MDD local y confiable desde ${PACKAGE_ROOT} en ${paths.ownedRoot}`)}${note('Guarda un tarball local direccionado por contenido en mdd/packages, actualiza solo package.json/package-lock.json y node_modules de la carpeta propia, y puede descargar dependencias fijadas vía npm. Los scripts de ciclo de vida quedan desactivados (--ignore-scripts). Los archivos raíz de OpenCode no se tocan.')}`);
    if (state.state === 'outdated') io.write(`\n${note(`Actualizar el paquete MDD instalado usando ${PACKAGE_ROOT}`)}${note(`Quita ${OWNED_PACKAGE} y su entrada de dependencias en la carpeta propia, y reinstala desde un tarball local direccionado por contenido. Puede descargar dependencias fijadas vía npm; los scripts de ciclo de vida quedan desactivados (--ignore-scripts).`)}${note(`No se tocan mdd.config.json, la carpeta memory, los artefactos ni otros agentes. Se conservan los ${KEPT_PACKAGES} tarballs más recientes y el referenciado en mdd/packages; el resto se borra.`)}`);
    if (install) io.write(`\n${note('Instalar Engram v1.20.0 del proveedor Gentleman-Programming')}${rows([['Descarga', offer!.url], ['Destino', offer!.binary]])}${note('Se verifican el SHA-256 fijado y checksums.txt antes de extraer.')}${note('No se reemplaza ningún Engram existente ni se cambia el PATH global.')}`);
    if (state.state === 'matching' && changes.every(file => file.action === 'keep')) io.write(`\n${note('Todo está al día: no hay ningún cambio pendiente que aplicar.')}`);
    io.write(`\n${rows([['Memoria', `${draft.engram ? 'activada (opt-in explícito)' : 'apagada'}${mode === 'update' ? '; mdd update no la modifica' : ''}`]])}${note('Los modelos heredan la selección nativa salvo que ya estén configurados. Las respuestas de perfil sin responder siguen sin responder. Los ajustes avanzados son opcionales con mdd config. Se preservan otros agentes, skills y default_agent.')}`);
    if (await choose(io, '¿Aplicamos exactamente estos cambios y las descargas listadas?', [
      { value: 'apply', label: 'Aplicar', hint: 'Aprueba exactamente lo listado arriba' },
      { value: 'cancel', label: 'Cancelar', hint: 'No se escribe ni se descarga nada' },
    ], { initial: 1, unknownCancels: true }) !== 'apply') throw new Cancelled();
    // Recheck the complete preflight before the first target write or network request.
    if (JSON.stringify(loadGlobalSettings()) !== before || JSON.stringify(planProject(root, true)) !== JSON.stringify(changes) || packageState(root).state !== state.state ||
        JSON.stringify(['mdd/package.json', 'mdd/package-lock.json'].map(name => fileDigest(scopedPath(root, name)))) !== JSON.stringify(packageSnapshot)) throw new Error('Installation changed during review. Run setup again.');
    io.write(step(mode, review + 1));
    if (state.state === 'outdated') reconcileOwnedPackage(root);
    if (state.state !== 'matching') deps.installPackage(root);
    if (install) await deps.installMemory(paths.ownedRoot);
    initProject(root, true);
    // The launcher lives in MDD's own folder, so the approved install covers it. The PATH is the
    // user's environment: it changes only through the explicit link command, never as a side effect.
    deps.writeLaunchers(paths);
    if (before !== JSON.stringify(draft) || !fs.existsSync(paths.settingsPath)) saveGlobalSettings(draft);
    const pruned = state.state === 'matching' ? [] : pruneOwnedPackages(root);
    if (pruned.length) io.write(rows([['Tarballs borrados', String(pruned.length)]]));
    const report = await deps.check(cwd, false);
    if (detection && draft.engram && 'mode' in draft.engram && !install && detection.status !== 'compatible') {
      report.ready = false;
      report.checks.push({ check: 'engram-version', status: 'action', message: 'The configured local binary did not pass the supported v1.20.0 version probe. Its setting was preserved; select off or an explicit separate install in setup.' });
    }
    if (!report.ready) {
      io.write(`\n  Quedan cosas por resolver:\n${rows(report.checks.filter(item => item.status === 'action').map(item => [item.check, item.message] as const))}${note('Los cambios ya aplicados quedan en la instalación global de MDD. La instalación no arrancó OpenCode ni ningún modelo.')}`);
      return 'issues';
    }
    const reachable = deps.commandPlan().onPath;
    io.write(`\n  Listo: las verificaciones de la instalación global pasaron.\n${note('Cerrá y reiniciá OpenCode para que cargue los assets.')}${note('La integración con los ajustes nativos globales y la aceptación de modelos todavía no están verificadas.')}${rows([
      ['Instalar o actualizar', reachable ? COMMAND : `node "${paths.cliPath}"`],
      ['Configuración', reachable ? `${COMMAND} config` : `node "${paths.cliPath}" config`],
      ['Verificación', reachable ? `${COMMAND} doctor` : `node "${paths.cliPath}" doctor`]])}${
      reachable ? note(`${COMMAND} ya está en tu PATH.`)
        : note(`Para ejecutar ${COMMAND} desde cualquier carpeta: node "${paths.cliPath}" link`)}${note('Las instalaciones antiguas por proyecto quedan intactas; reconciliá sus assets propios explícitamente antes de usarlas.')}`);
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
    if (await runSetupUI(root, io, {}, { mode }) === 'issues') process.exitCode = 1;
  } finally { close(); }
}
