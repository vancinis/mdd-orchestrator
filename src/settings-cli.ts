import { changeProfile, runTerminalConfig } from './config-ui.js';
import { clearTelemetry, telemetryReport, telemetryStatus } from './telemetry.js';
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
    if (args.length > 1) throw new ValidationError('Usage: mdd setup. Target directories are retired; setup installs once in the global OpenCode directory.');
    await runTerminalSetup(root);
    return true;
  }
  if (command === 'update') {
    if (args.length > 1) throw new ValidationError('Usage: mdd update. Run it from the source checkout whose build should replace the installed package.');
    await runTerminalSetup(root, 'update');
    return true;
  }
  if (command === 'link') {
    if (args.length > 1) throw new ValidationError(`Usage: mdd link. It installs the ${COMMAND} launcher and adds only its own folder to your user PATH.`);
    const paths = installationPaths();
    writeLaunchers(paths);
    const plan = commandPlan();
    if (plan.onPath) {
      write(`${COMMAND} is already on your PATH: ${plan.binRoot}\n`);
      return true;
    }
    if (registerPath(plan.binRoot) === 'registered') {
      write(`Added to your user PATH: ${plan.binRoot}\nOpen a new terminal, then run ${COMMAND}.\nYour machine PATH was not touched.\n`);
    } else {
      write(`Launcher installed in ${plan.binRoot}\nAdd it to your shell profile to use ${COMMAND} anywhere:\n  ${plan.manual}\n`);
    }
    return true;
  }
  if (command === 'init' || command === 'doctor') {
    if (args.length > 1) throw new ValidationError(`Usage: mdd ${command}. Target directories are retired; installation is global.`);
    const target = installationPaths().configRoot;
    if (command === 'init') {
      write(`${JSON.stringify(initProject(target))}\nRestart OpenCode for new runs to load global assets. Do not restart uncertain work as a retry.\n`);
    } else {
      const report = await doctor(target);
      write(`${JSON.stringify(report, null, 2)}\n`);
      if (!report.ready) process.exitCode = 1;
    }
    return true;
  }
  if (command === 'config') {
    if (args.length !== 1) throw new ValidationError('Usage: mdd config');
    await runTerminalConfig(root);
    return true;
  }
  if (command === 'profile') {
    if (action === 'list' && args.length === 2) {
      const settings = loadGlobalSettings();
      write(Object.keys(settings.profiles).sort().map(key => `${key === settings.activeProfile ? '*' : ' '} ${key}`).join('\n') + '\n');
    } else if ((action === 'create' || action === 'use') && name && args.length === 3) {
      saveGlobalSettings(changeProfile(loadGlobalSettings(), action, name));
      write(`Active global profile: ${name}. Restart OpenCode to load it.\n`);
    } else throw new ValidationError('Usage: mdd profile list | create <name> | use <name>');
    return true;
  }
  if (command === 'telemetry') {
    if (args.length !== 2 || !['status', 'on', 'off', 'clear', 'report'].includes(action ?? '')) {
      throw new ValidationError('Usage: mdd telemetry status | report | on | off | clear');
    }
    if (action === 'on' || action === 'off') {
      const settings = loadGlobalSettings();
      settings.telemetry.enabled = action === 'on';
      saveGlobalSettings(settings);
      write(`Global telemetry preference ${action}. Event files remain workspace-local; clear affects only the current workspace.\n`);
    } else if (action === 'report') {
      const report = telemetryReport(root);
      if (!report.ok) throw new Error(report.diagnostic);
      write(report.text);
    } else {
      const result = action === 'clear' ? clearTelemetry(root) : telemetryStatus(root);
      if (!result.ok) throw new Error(result.diagnostic);
      write(`${JSON.stringify(result)}\n`);
    }
    return true;
  }
  return false;
}
