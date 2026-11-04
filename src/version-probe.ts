#!/usr/bin/env node
// Target-package probe: `node version-probe.js <packageRoot> <op> [arg]` prints one JSON document.
// It imports the TARGET package's own dist modules (all present in 0.2.0) and never writes anything.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

type Json = Record<string, unknown>;
type Mod = Record<string, unknown>;

const load = (root: string, name: string): Promise<Mod> =>
  import(pathToFileURL(path.join(root, 'dist', `${name}.js`)).href) as Promise<Mod>;

function pick<T>(mod: Mod, key: string, check: (value: unknown) => value is T, from: string): T {
  const value = mod[key];
  if (!check(value)) throw new Error(`Target package does not export ${key} from ${from}.`);
  return value;
}
const isString = (value: unknown): value is string => typeof value === 'string';
const isFunction = (value: unknown): value is (...args: never[]) => unknown => typeof value === 'function';
const isList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every(isString);

export async function probe(root: string, op: string, arg?: string): Promise<Json> {
  root = path.resolve(root);
  if (op === 'assets') {
    const assets = await load(root, 'project-assets');
    const setup = await load(root, 'setup');
    const list = pick(assets, 'MDD_ASSETS', isList, 'project-assets.js');
    const installed = pick(assets, 'installedAsset', isFunction, 'project-assets.js') as unknown as (root: string, name: string) => { content: string };
    const named = pick(assets, 'installedName', isFunction, 'project-assets.js') as unknown as (name: string) => string;
    const files = list.map(name => ({ path: named(name), content: installed(root, name).content }));
    files.push({ path: pick(setup, 'LOADER_PATH', isString, 'setup.js'), content: pick(setup, 'LOADER_TEXT', isString, 'setup.js') });
    files.push({ path: pick(setup, 'PRIVATE_IGNORE_PATH', isString, 'setup.js'), content: pick(setup, 'PRIVATE_IGNORE_TEXT', isString, 'setup.js') });
    return { files };
  }
  if (op === 'packaged') {
    const assets = await load(root, 'project-assets');
    return { files: [...pick(assets, 'MDD_PACKAGED_ASSETS', isList, 'project-assets.js')] };
  }
  if (op === 'config') {
    if (!arg) throw new Error('The config operation needs a directory.');
    const settings = await load(root, 'settings');
    const loadSettings = pick(settings, 'loadSettings', isFunction, 'settings.js') as unknown as (dir: string) => unknown;
    try { loadSettings(path.resolve(arg)); return { ok: true }; }
    catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) }; }
  }
  if (op === 'manager') {
    let manager: Mod;
    try { manager = await load(root, 'version-manager'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String((error as Error).message).includes('version-manager')) return { revision: null };
      throw error;
    }
    const revision = manager['MANAGER_REVISION'];
    return { revision: Number.isInteger(revision) ? revision : null };
  }
  throw new Error(`Unknown probe operation: ${op}.`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  const [root, op, arg] = process.argv.slice(2);
  probe(root ?? '', op ?? '', arg).then(
    result => { process.stdout.write(`${JSON.stringify(result)}\n`); },
    (error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; },
  );
}
