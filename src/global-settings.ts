import fs from 'node:fs';
import { installationPaths } from './installation-paths.js';
import type { InstallationEnvironment } from './installation-paths.js';
import { scopedPath } from './phase-policy.js';
import { defaultSettings, loadSettings, parseSettings, saveSettings } from './settings.js';
import type { Settings } from './settings.js';

export function loadGlobalSettings(environment?: InstallationEnvironment): Settings {
  const paths = installationPaths(environment);
  scopedPath(paths.configRoot, 'mdd/mdd.config.json');
  if (!fs.existsSync(paths.ownedRoot)) return defaultSettings();
  return loadSettings(paths.ownedRoot);
}

/** Explicit settings save only; reads and path resolution never create installation directories. */
export function saveGlobalSettings(value: unknown, environment?: InstallationEnvironment): Settings {
  const settings = parseSettings(value);
  const paths = installationPaths(environment);
  scopedPath(paths.configRoot, 'mdd/mdd.config.json');
  fs.mkdirSync(paths.ownedRoot, { recursive: true, mode: 0o700 });
  return saveSettings(paths.ownedRoot, settings);
}
