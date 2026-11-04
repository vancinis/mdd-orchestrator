import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename, delimiter, dirname, join } from 'node:path';
import { installationPaths } from './installation-paths.js';
import { retryTransient } from './local-files.js';
import { scopedPath } from './safe-paths.js';

export const COMMAND = 'mdd-ai';
/** Launchers target the version manager's stable entry (permanent contract), not the replaceable package. */
const RELATIVE_ENTRY = 'manager/entry.mjs';
/** What the 0.2.0 launchers target; recognised so a rewrite by historical software can be reported. */
const LEGACY_CLI = 'node_modules/my-driven-development/dist/cli.js';

/**
 * The launcher resolves the entry relative to itself, so the command keeps working if the home
 * directory moves. Node is taken from PATH rather than pinned to the interpreter that ran setup,
 * which would break the day that particular installation is removed.
 */
export function launcherFiles(): { name: string; content: string; mode: number }[] {
  return [
    { name: `${COMMAND}.cmd`, mode: 0o700, content: ['@echo off', 'setlocal', `node "%~dp0..\\${RELATIVE_ENTRY.replaceAll('/', '\\')}" %*`, ''].join('\r\n') },
    { name: COMMAND, mode: 0o700, content: ['#!/bin/sh', 'set -e', `exec node "$(dirname "$0")/../${RELATIVE_ENTRY}" "$@"`, ''].join('\n') },
  ];
}

/** Which program a launcher text reaches: the manager entry, the 0.2.0 package CLI, or something else. */
export function launcherKind(content: string): 'manager' | 'legacy' | 'other' {
  if (content.includes(RELATIVE_ENTRY) || content.includes(RELATIVE_ENTRY.replaceAll('/', '\\'))) return 'manager';
  if (content.includes(LEGACY_CLI) || content.includes(LEGACY_CLI.replaceAll('/', '\\'))) return 'legacy';
  return 'other';
}

/** Marker line of the entry text; a higher number replaces a lower one, never the reverse. */
const ENTRY_MARK = /^\/\/ mdd-entry: (\d+)\r?\n/;

/**
 * Stable bootstrap behind every launcher. It imports the router of the current manager revision
 * (then the previous one) and, when neither loads, runs the active package CLI so `config` and
 * `doctor` keep working. Plain ESM with Node built-ins only: it never depends on a package.
 */
export const ENTRY_TEXT = [
  '// mdd-entry: 1',
  '// Stable bootstrap of the MDD version manager. The launchers in ../bin call this file.',
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { spawnSync } from 'node:child_process';",
  "import { dirname, join } from 'node:path';",
  "import { fileURLToPath, pathToFileURL } from 'node:url';",
  '',
  'const here = dirname(fileURLToPath(import.meta.url));',
  'const argv = process.argv.slice(2);',
  'function candidates() {',
  '  try {',
  "    const current = JSON.parse(readFileSync(join(here, 'current.json'), 'utf8'));",
  '    return [current.dir, current.previous].filter(dir => typeof dir === \'string\' && /^r[0-9]+-[0-9a-f]{8}$/.test(dir));',
  '  } catch { return []; }',
  '}',
  'const dirs = candidates();',
  'let router;',
  'for (const dir of dirs) {',
  "  try { const loaded = await import(pathToFileURL(join(here, dir, 'dist', 'version-cli.js')).href); if (typeof loaded.main === 'function') { router = loaded; break; } } catch { /* try the previous revision */ }",
  '}',
  'if (router) {',
  '  try {',
  '    const code = await router.main(argv);',
  "    if (typeof code === 'number') process.exitCode = code;",
  '  } catch (error) {',
  '    console.error(error instanceof Error ? error.message : String(error));',
  '    process.exitCode = 1;',
  '  }',
  '} else {',
  "  if (dirs.length) console.error('El gestor de versiones está dañado; reinstalalo con npm run setup desde un checkout.');",
  "  const cli = join(here, '..', 'node_modules', 'my-driven-development', 'dist', 'cli.js');",
  '  if (existsSync(cli)) {',
  '    process.exitCode = spawnSync(process.execPath, [cli, ...argv], { stdio: \'inherit\' }).status ?? 1;',
  '  } else {',
  "    console.error('No hay una versión activa utilizable. Elegí una con mdd-ai use <versión> cuando el gestor esté disponible.');",
  '    process.exitCode = 1;',
  '  }',
  '}',
  '',
].join('\n');

/** Temp file in the same directory, fsync, rename: a reader sees the old or the new content, never a part. */
export function atomicWrite(root: string, path: string, data: string, mode = 0o600): void {
  const target = scopedPath(root, path);
  fs.mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  scopedPath(root, target);
  const temporary = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    retryTransient(() => fs.renameSync(temporary, target));
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Writes `manager/entry.mjs` when absent or older. Forward-only: a package carrying an older entry
 * text can never replace a newer one, mirroring the manager revision rule.
 */
export function writeEntry(paths = installationPaths()): 'created' | 'updated' | 'keep' {
  const path = scopedPath(paths.ownedRoot, paths.managerEntry);
  const incoming = Number(ENTRY_MARK.exec(ENTRY_TEXT)![1]);
  const current = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
  if (current === ENTRY_TEXT) return 'keep';
  const installed = current === undefined ? undefined : ENTRY_MARK.exec(current);
  if (installed && Number(installed[1]) > incoming) return 'keep';
  atomicWrite(paths.ownedRoot, path, ENTRY_TEXT);
  return current === undefined ? 'created' : 'updated';
}
export type LauncherFile = { name: string; path: string; action: 'create' | 'update' | 'keep' };
export type CommandPlan = {
  binRoot: string; onPath: boolean; windows: boolean;
  files: LauncherFile[];
  /** The exact line a user adds by hand when MDD must not edit their environment. */
  manual: string;
};

export function commandPlan(env: Readonly<NodeJS.ProcessEnv> = process.env, paths = installationPaths({ env })): CommandPlan {
  const binRoot = paths.binRoot;
  const windows = process.platform === 'win32';
  const entries = (env.PATH ?? '').split(delimiter).filter(Boolean)
    .map(entry => entry.replace(/[\\/]+$/, ''));
  const target = binRoot.replace(/[\\/]+$/, '');
  const onPath = entries.some(entry => windows ? entry.toLowerCase() === target.toLowerCase() : entry === target);
  const files = launcherFiles().map(file => {
    const path = join(binRoot, file.name);
    const current = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : undefined;
    return { name: file.name, path, action: current === undefined ? 'create' : current === file.content ? 'keep' : 'update' } as LauncherFile;
  });
  return { binRoot, onPath, windows, files,
    manual: windows ? `$env:PATH += ";${binRoot}"` : `export PATH="$PATH:${binRoot}"` };
}

/** Writes the manager entry (if absent or older) and the two launcher files, all inside MDD's own directory. */
export function writeLaunchers(paths = installationPaths()): LauncherFile[] {
  writeEntry(paths);
  const plan = commandPlan(process.env, paths);
  fs.mkdirSync(plan.binRoot, { recursive: true, mode: 0o700 });
  for (const file of launcherFiles()) {
    const path = scopedPath(plan.binRoot, file.name);
    if (fs.existsSync(path) && fs.readFileSync(path, 'utf8') === file.content) continue;
    fs.writeFileSync(path, file.content, { mode: file.mode });
    fs.chmodSync(path, file.mode);
  }
  return commandPlan(process.env, paths).files;
}

/**
 * Registers the directory in the user's own PATH, never the machine PATH, and never replaces
 * what is already there. Outside Windows the environment belongs to the user's shell profile,
 * so the exact line is reported instead of edited.
 */
export function registerPath(binRoot: string, execute = execFileSync): 'registered' | 'manual' {
  if (process.platform !== 'win32') return 'manual';
  const script = [
    '$bin = $env:MDD_BIN_PATH',
    "if (-not $bin) { throw 'Missing MDD bin path.' }",
    "$current = [Environment]::GetEnvironmentVariable('Path', 'User')",
    "$entries = @($current -split ';' | Where-Object { $_ })",
    'if ($entries -contains $bin) { exit 0 }',
    "[Environment]::SetEnvironmentVariable('Path', (($entries + $bin) -join ';'), 'User')",
  ].join('; ');
  execute('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: { ...process.env, MDD_BIN_PATH: binRoot }, timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return 'registered';
}
