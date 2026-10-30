import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { installationPaths } from './installation-paths.js';
import { scopedPath } from './safe-paths.js';

export const COMMAND = 'mdd-ai';
const RELATIVE_CLI = 'node_modules/my-driven-development/dist/cli.js';

/**
 * The launcher resolves the CLI relative to itself, so the command keeps working if the home
 * directory moves. Node is taken from PATH rather than pinned to the interpreter that ran setup,
 * which would break the day that particular installation is removed.
 */
export function launcherFiles(): { name: string; content: string; mode: number }[] {
  return [
    { name: `${COMMAND}.cmd`, mode: 0o700, content: ['@echo off', 'setlocal', `node "%~dp0..\\${RELATIVE_CLI.replaceAll('/', '\\')}" %*`, ''].join('\r\n') },
    { name: COMMAND, mode: 0o700, content: ['#!/bin/sh', 'set -e', `exec node "$(dirname "$0")/../${RELATIVE_CLI}" "$@"`, ''].join('\n') },
  ];
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

/** Writes only the two launcher files inside MDD's own bin directory. */
export function writeLaunchers(paths = installationPaths()): LauncherFile[] {
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
