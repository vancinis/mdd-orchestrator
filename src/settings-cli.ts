import { changeProfile, runTerminalConfig } from './config-ui.js';
import { ValidationError } from './validation.js';
import { doctor } from './doctor.js';
import { runTerminalSetup } from './setup-ui.js';
import { loadGlobalSettings, saveGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import { COMMAND, commandPlan, registerPath, writeLaunchers } from './command-link.js';

/** Runs one CLI command. Returns false when the arguments name no known command. */
export async function settingsCommand(args: string[], root: string, write: (text: string) => void): Promise<boolean> {
  const [command, action, name] = args;
  if (command === 'setup' || (args.length === 0 && process.stdin.isTTY)) {
    if (args.length > 1) throw new ValidationError('Uso: mdd-ai setup. La instalación es global, en el directorio de configuración de OpenCode.');
    await runTerminalSetup(root);
    return true;
  }
  if (command === 'update') {
    if (args.length > 1) throw new ValidationError('Uso: mdd-ai update. Ejecutalo desde el checkout cuyo build querés instalar.');
    await runTerminalSetup(root, 'update');
    return true;
  }
  if (command === 'link') {
    if (args.length > 1) throw new ValidationError(`Uso: mdd-ai link. Instala el lanzador ${COMMAND} y agrega solo su carpeta al PATH de tu usuario.`);
    writeLaunchers(installationPaths());
    const plan = commandPlan();
    if (plan.onPath) write(`${COMMAND} ya está en tu PATH: ${plan.binRoot}\n`);
    else if (registerPath(plan.binRoot) === 'registered') write(`Se agregó al PATH de tu usuario: ${plan.binRoot}\nAbrí una terminal nueva y ejecutá ${COMMAND}.\nEl PATH de la máquina no se tocó.\n`);
    else write(`Lanzador instalado en ${plan.binRoot}\nAgregalo al perfil de tu shell para usar ${COMMAND} desde cualquier lado:\n  ${plan.manual}\n`);
    return true;
  }
  if (command === 'doctor') {
    if (args.length > 1) throw new ValidationError('Uso: mdd-ai doctor');
    const report = await doctor(root);
    write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ready) process.exitCode = 1;
    return true;
  }
  if (command === 'config') {
    if (args.length !== 1) throw new ValidationError('Uso: mdd-ai config');
    await runTerminalConfig(root);
    return true;
  }
  if (command === 'profile') {
    if (action === 'list' && args.length === 2) {
      const settings = loadGlobalSettings();
      write(Object.keys(settings.profiles).sort().map(key => `${key === settings.activeProfile ? '*' : ' '} ${key}`).join('\n') + '\n');
    } else if ((action === 'create' || action === 'use') && name && args.length === 3) {
      saveGlobalSettings(changeProfile(loadGlobalSettings(), action, name));
      write(`Perfil global activo: ${name}. Reiniciá OpenCode para cargarlo.\n`);
    } else throw new ValidationError('Uso: mdd-ai profile list | create <nombre> | use <nombre>');
    return true;
  }
  return false;
}
