import { changeProfile, runTerminalConfig } from './config-ui.js';
import { clearTelemetry, telemetryReport, telemetryStatus } from './telemetry.js';
import { clearLessons, markLessons, readLessons, renderLessonsReport } from './lessons.js';
import { mddDataRoot } from './engram-http.js';
import { retroReport } from './retro.js';
import { ValidationError } from './validation.js';
import { initProject } from './setup.js';
import { doctor } from './doctor.js';
import { runTerminalSetup } from './setup-ui.js';
import { loadGlobalSettings, saveGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import { COMMAND, commandPlan, registerPath, writeLaunchers } from './command-link.js';

/** Returns false for the existing proof-flag parser to handle. */
export async function settingsCommand(args: string[], root: string, write: (text: string) => void): Promise<boolean> {
  const [command, action, name] = args;
  if (command === 'setup' || (args.length === 0 && process.stdin.isTTY)) {
    if (args.length > 1) throw new ValidationError('Uso: mdd setup. Los directorios de destino ya no existen; setup instala una sola vez en el directorio global de OpenCode.');
    await runTerminalSetup(root);
    return true;
  }
  if (command === 'update') {
    if (args.length > 1) throw new ValidationError('Uso: mdd update. Ejecutalo desde el checkout de origen cuyo build debe reemplazar al paquete instalado.');
    await runTerminalSetup(root, 'update');
    return true;
  }
  if (command === 'link') {
    if (args.length > 1) throw new ValidationError(`Uso: mdd link. Instala el lanzador ${COMMAND} y agrega solo su propia carpeta al PATH de tu usuario.`);
    const paths = installationPaths();
    writeLaunchers(paths);
    const plan = commandPlan();
    if (plan.onPath) {
      write(`${COMMAND} ya está en tu PATH: ${plan.binRoot}\n`);
      return true;
    }
    if (registerPath(plan.binRoot) === 'registered') {
      write(`Se agregó al PATH de tu usuario: ${plan.binRoot}\nAbrí una terminal nueva y ejecutá ${COMMAND}.\nEl PATH de la máquina no se tocó.\n`);
    } else {
      write(`Lanzador instalado en ${plan.binRoot}\nAgregalo al perfil de tu shell para usar ${COMMAND} desde cualquier lado:\n  ${plan.manual}\n`);
    }
    return true;
  }
  if (command === 'init' || command === 'doctor') {
    if (args.length > 1) throw new ValidationError(`Uso: mdd ${command}. Los directorios de destino ya no existen; la instalación es global.`);
    const target = installationPaths().configRoot;
    if (command === 'init') {
      write(`${JSON.stringify(initProject(target))}\nReiniciá OpenCode para que las ejecuciones nuevas carguen los assets globales. No reinicies trabajo incierto como si fuera un reintento.\n`);
    } else {
      const report = await doctor(target);
      write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ready) process.exitCode = 1;
    }
    return true;
  }
  if (command === 'config') {
    if (args.length !== 1) throw new ValidationError('Uso: mdd config');
    await runTerminalConfig(root);
    return true;
  }
  if (command === 'workers') {
    if (args.length !== 2 || !['status', 'on', 'off'].includes(action ?? '')) {
      throw new ValidationError('Usage: mdd-ai workers status | on | off');
    }
    const settings = loadGlobalSettings();
    if (action === 'status') write(`${JSON.stringify(settings.workers)}\n`);
    else {
      settings.workers.enabled = action === 'on';
      saveGlobalSettings(settings);
      write(`Global worker preference: ${action === 'on' ? 'enabled' : 'disabled'}. Restart OpenCode to capture it. This sets a preference only; dispatch remains sequential.\n`);
    }
    return true;
  }
  if (command === 'profile') {
    if (action === 'list' && args.length === 2) {
      const settings = loadGlobalSettings();
      write(Object.keys(settings.profiles).sort().map(key => `${key === settings.activeProfile ? '*' : ' '} ${key}`).join('\n') + '\n');
    } else if ((action === 'create' || action === 'use') && name && args.length === 3) {
      saveGlobalSettings(changeProfile(loadGlobalSettings(), action, name));
      write(`Perfil global activo: ${name}. Reiniciá OpenCode para cargarlo.\n`);
    } else throw new ValidationError('Uso: mdd profile list | create <nombre> | use <nombre>');
    return true;
  }
  if (command === 'lessons') {
    if (args.length < 2 || args.length > 3 || !['list', 'report', 'clear', 'mark'].includes(action ?? '')) {
      throw new ValidationError('Uso: mdd lessons report | list [texto] | mark <id> | clear');
    }
    // Read from where a run wrote: a linked worktree's lessons live in the repository it belongs to,
    // so the CLI run from inside that worktree must look there, not at the worktree's empty .mdd.
    const dataRoot = mddDataRoot(root);
    if (action === 'clear') {
      if (args.length !== 2) throw new ValidationError('Uso: mdd lessons clear');
      const cleared = clearLessons(dataRoot);
      if (!cleared.ok) throw new Error(cleared.diagnostic);
      write('Se borraron las automejoras anotadas de este workspace.\n');
    } else if (action === 'mark') {
      if (!name) throw new ValidationError('Uso: mdd lessons mark <id>');
      const marked = markLessons(dataRoot, [name], 'reviewed');
      if (!marked.ok) throw new Error(marked.diagnostic);
      write(marked.updated.length
        ? `Marcada como revisada: ${marked.updated.join(', ')}\n`
        : `No se encontró ninguna automejora con ese identificador: ${name}\n`);
    } else {
      const read = readLessons(dataRoot, name === undefined ? undefined : { text: name });
      if (!read.ok) throw new Error(read.diagnostic);
      write(action === 'report' ? renderLessonsReport(read.lessons, read.total) : `${JSON.stringify(read.lessons, null, 2)}\n`);
    }
    return true;
  }
  if (command === 'retro') {
    if (args.length !== 1) throw new ValidationError('Uso: mdd retro');
    // Reads the three records that already existed and were never read together: the run ledger,
    // the accumulated counters and the improvements nobody reviewed.
    write(retroReport(mddDataRoot(root)).text);
    return true;
  }
  if (command === 'telemetry') {
    if (args.length !== 2 || !['status', 'on', 'off', 'clear', 'report'].includes(action ?? '')) {
      throw new ValidationError('Uso: mdd telemetry status | report | on | off | clear');
    }
    if (action === 'on' || action === 'off') {
      const settings = loadGlobalSettings();
      settings.telemetry.enabled = action === 'on';
      saveGlobalSettings(settings);
      write(`Preferencia global de telemetría: ${action === 'on' ? 'activada' : 'desactivada'}. Los archivos de eventos siguen siendo locales al workspace; clear afecta solo al workspace actual.\n`);
    } else if (action === 'report') {
      const report = telemetryReport(mddDataRoot(root));
      if (!report.ok) throw new Error(report.diagnostic);
      write(report.text);
    } else {
      const dataRoot = mddDataRoot(root);
      const result = action === 'clear' ? clearTelemetry(dataRoot) : telemetryStatus(dataRoot);
      if (!result.ok) throw new Error(result.diagnostic);
      write(`${JSON.stringify(result)}\n`);
    }
    return true;
  }
  return false;
}
