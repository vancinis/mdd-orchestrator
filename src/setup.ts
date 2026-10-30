import fs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { assetText, installedAsset, installedName, MDD_ASSETS, MDD_PACKAGED_ASSETS, PACKAGE_ROOT } from './project-assets.js';
import { scopedPath, fileDigest } from './safe-paths.js';
import { LocalFiles } from './local-files.js';

export const LOADER_PATH = 'plugins/mdd.ts';
export const LOADER_TEXT = "export { default } from '../mdd/node_modules/my-driven-development/dist/opencode-plugin.js';\n";
/** Earlier versions registered a terminal sidebar here. Setup removes that entry and nothing else. */
export const TUI_CONFIG_PATH = 'cli.json';
export const RETIRED_TUI_PLUGIN_SPEC = './mdd/node_modules/my-driven-development/dist/opencode-tui.js';
export const PRIVATE_IGNORE_PATH = 'mdd/.gitignore';
export const PRIVATE_IGNORE_TEXT = '*\n!.gitignore\n';
// Previously installed assets can exceed today's packaged-asset limit. Read them within a
// separate bounded migration budget, then require the recorded digest before any replacement.
const INSTALLED_ASSET_MAX_BYTES = 65536;
export function installedPlugin(root: string): string {
  const local = join(root, 'mdd/node_modules/my-driven-development');
  const pkg = JSON.parse(fs.readFileSync(join(local, 'package.json'), 'utf8'));
  if (pkg.name !== 'my-driven-development' || pkg.exports?.['./opencode-plugin'] !== './dist/opencode-plugin.js') throw new Error('MDD is not installed locally with the supported plugin export.');
  const resolved = createRequire(join(resolve(root), 'mdd/package.json')).resolve('my-driven-development/opencode-plugin');
  if (resolve(resolved) !== resolve(local, 'dist/opencode-plugin.js')) throw new Error('MDD must resolve from its owned prefix.');
  if (!fs.statSync(resolved).isFile()) throw new Error('MDD build is missing.');
  return resolved;
}
export function assertMatchingPackage(root: string): void {
  const installed = dirname(dirname(installedPlugin(root)));
  const files = [...MDD_PACKAGED_ASSETS, ...fs.readdirSync(join(PACKAGE_ROOT, 'dist')).filter(name => /\.(js|d\.ts)$/.test(name)).map(name => `dist/${name}`)];
  for (const name of files) {
    if (fileDigest(scopedPath(installed, name)) !== fileDigest(scopedPath(PACKAGE_ROOT, name))) throw new Error('Existing MDD package differs from this setup package. Run setup from that installation or explicitly reconcile the owned package first.');
  }
}

export const OWNED_PACKAGE = 'node_modules/my-driven-development';
export type PackageProvenance = { version: string; digest: string };
/** `outdated` is an owned, resolvable package that may be replaced after review; `foreign` never is. */
export type PackageState =
  | { state: 'absent' }
  | { state: 'foreign'; reason: string }
  | { state: 'matching'; installed: PackageProvenance }
  | { state: 'outdated'; installed: PackageProvenance; source: PackageProvenance };

function packageVersion(root: string): string {
  try {
    const value = JSON.parse(fs.readFileSync(join(root, 'package.json'), 'utf8')).version;
    return typeof value === 'string' && /^[0-9][a-zA-Z0-9.+-]{0,63}$/.test(value) ? value : 'unknown';
  } catch { return 'unknown'; }
}

/** Provenance for display only; assertMatchingPackage stays the single authority on equality. */
function packageDigest(root: string): string {
  const dist = join(root, 'dist');
  const built = fs.existsSync(dist) ? fs.readdirSync(dist).filter(name => /\.(js|d\.ts)$/.test(name)).map(name => `dist/${name}`) : [];
  const hash = createHash('sha256');
  for (const name of [...MDD_PACKAGED_ASSETS, ...built].sort()) hash.update(`${name}:${fileDigest(scopedPath(root, name))}\n`);
  return hash.digest('hex');
}

export function ownedLeftovers(root: string): boolean {
  const owned = join(projectRoot(root), 'mdd');
  for (const name of ['package.json', 'package-lock.json', 'node_modules/.mdd-safety-check', 'packages/.mdd-safety-check']) scopedPath(owned, name);
  if (fs.existsSync(join(owned, OWNED_PACKAGE))) return true;
  const metadata = join(owned, 'package.json');
  if (!fs.existsSync(metadata)) return false;
  const pkg = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  return !!(pkg.dependencies?.['my-driven-development'] || pkg.devDependencies?.['my-driven-development']);
}

export function packageState(root: string): PackageState {
  let resolved: string | undefined;
  try { resolved = installedPlugin(root); } catch { /* Inspect leftovers before proposing any action. */ }
  if (!resolved) {
    return ownedLeftovers(root)
      ? { state: 'foreign', reason: 'Existing MDD package is broken or unsupported. Repair that installation explicitly; setup will not replace it.' }
      : { state: 'absent' };
  }
  const installedRoot = dirname(dirname(resolved));
  const installed = { version: packageVersion(installedRoot), digest: packageDigest(installedRoot) };
  try { assertMatchingPackage(root); return { state: 'matching', installed }; }
  catch { return { state: 'outdated', installed, source: { version: packageVersion(PACKAGE_ROOT), digest: packageDigest(PACKAGE_ROOT) } }; }
}

export function projectRoot(root: string): string {
  root = resolve(root);
  scopedPath(root, 'mdd/setup-assets.json');
  return root;
}

/**
 * Removes only the retired MDD sidebar entry from cli.json. Returns undefined when there is
 * nothing to change, so a cli.json MDD never touched stays out of the plan entirely. A file that
 * cannot be parsed is left alone: it is the user's, and MDD has nothing to remove from it.
 */
export function unregisterTuiPlugin(previous: string | undefined): string | undefined {
  if (previous === undefined) return undefined;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(previous);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    value = parsed as Record<string, unknown>;
  } catch { return undefined; }
  if (!Array.isArray(value.plugins)) return undefined;
  const isMdd = (entry: unknown) => entry === RETIRED_TUI_PLUGIN_SPEC ||
    (!!entry && typeof entry === 'object' && (entry as Record<string, unknown>).package === RETIRED_TUI_PLUGIN_SPEC);
  if (!value.plugins.some(isMdd)) return undefined;
  value.plugins = value.plugins.filter(entry => !isMdd(entry));
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function planProject(root: string, updateOwned = false) {
  root = projectRoot(root);
  const storage = new LocalFiles(root);
  const previous = fs.existsSync(root) ? storage.read('mdd/setup-assets.json', 16384) : undefined;
  const manifest: Record<string, string> = previous ? JSON.parse(previous) : {};
  const tuiBefore = fs.existsSync(scopedPath(root, TUI_CONFIG_PATH)) ? assetText(root, TUI_CONFIG_PATH, 65536).content : undefined;
  const tuiAfter = unregisterTuiPlugin(tuiBefore);
  const files = [...MDD_ASSETS.map(name => ({ name: installedName(name), content: installedAsset(PACKAGE_ROOT, name).content })), { name: LOADER_PATH, content: LOADER_TEXT }, { name: PRIVATE_IGNORE_PATH, content: PRIVATE_IGNORE_TEXT },
    ...(tuiAfter === undefined ? [] : [{ name: TUI_CONFIG_PATH, content: tuiAfter }])];
  return files.map(file => {
    const path = scopedPath(root, file.name);
    const before = fs.existsSync(path) ? assetText(root, file.name, INSTALLED_ASSET_MAX_BYTES) : undefined;
    const knownLoader = file.name === LOADER_PATH && ["export { default } from 'my-driven-development/opencode-plugin';\n", "export { default } from '../../dist/opencode-plugin.js';\n"].includes(before?.content ?? '');
    const digest = createHash('sha256').update(file.content).digest('hex');
    if (before && before.digest !== digest && file.name !== TUI_CONFIG_PATH && (!updateOwned || (!knownLoader && manifest[file.name] !== before.digest))) throw new Error(`MDD init refuses to overwrite different content: ${file.name}. User edits or unrecorded assets must be reconciled explicitly.`);
    return { ...file, digest, before: before?.digest, action: !before ? 'create' : before.digest === digest ? 'keep' : 'update' };
  });
}

export function initProject(root: string, updateOwned = false): { created: number; unchanged: number; restartRequired: true } {
  root = projectRoot(root);
  try {
    if (!fs.existsSync(scopedPath(root, 'mdd/package.json'))) throw new Error('Owned package metadata is missing.');
    assertMatchingPackage(root);
  } catch { throw new Error('Run mdd setup to install the built package in the global MDD prefix. From source, use npm run setup.'); }
  const files = planProject(root, updateOwned);
  let created = 0;
  let unchanged = 0;
  for (const file of files) {
    const path = scopedPath(root, file.name);
    if (fs.existsSync(path)) {
      if (assetText(root, file.name, INSTALLED_ASSET_MAX_BYTES).digest !== file.before) throw new Error('An owned setup file changed during initialization; no overwrite was performed.');
      if (file.action === 'keep') { unchanged++; continue; }
      const fd = fs.openSync(path, 'r+');
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe asset: ${file.name}`);
        fs.writeFileSync(fd, file.content, 'utf8'); fs.ftruncateSync(fd, Buffer.byteLength(file.content)); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      continue;
    }
    fs.mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    scopedPath(root, file.name);
    const fd = fs.openSync(path, 'wx', 0o600);
    try { fs.writeFileSync(fd, file.content, 'utf8'); fs.fsyncSync(fd); created++; }
    finally { fs.closeSync(fd); }
  }
  // cli.json belongs to the user; MDD only removes its retired entry, so it is never recorded as owned.
  const owned = files.filter(file => file.name !== TUI_CONFIG_PATH);
  new LocalFiles(root).update('mdd/setup-assets.json', () => JSON.stringify(Object.fromEntries(owned.map(file => [file.name, file.digest]))) + '\n', 16384);
  return { created, unchanged, restartRequired: true };
}
