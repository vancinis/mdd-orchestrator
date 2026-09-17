import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type InstallationEnvironment = {
  home?: string;
  env?: Readonly<NodeJS.ProcessEnv>;
};

function absolute(path: string): string {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('MDD installation requires absolute home and XDG_CONFIG_HOME paths; relative roots depend on the active workspace.');
  return path;
}

/** Standard native Global.Path.config, not the extra OPENCODE_CONFIG_DIR search/service override. No I/O. */
export function installationPaths({ home = homedir(), env = process.env }: InstallationEnvironment = {}) {
  const configRoot = join(absolute(env.XDG_CONFIG_HOME || join(absolute(home), '.config')), 'opencode');
  const ownedRoot = join(configRoot, 'mdd');
  const installedPackageRoot = join(ownedRoot, 'node_modules', 'my-driven-development');
  return Object.freeze({
    configRoot,
    ownedRoot,
    installedPackageRoot,
    settingsPath: join(ownedRoot, 'mdd.config.json'),
    cliPath: join(installedPackageRoot, 'dist', 'cli.js'),
    loaderPath: join(configRoot, 'plugins', 'mdd.ts'),
    manifestPath: join(ownedRoot, 'setup-assets.json'),
    packagesRoot: join(ownedRoot, 'packages'),
    binRoot: join(ownedRoot, 'bin'),
    memoryRoot: join(ownedRoot, 'memory'),
  });
}
