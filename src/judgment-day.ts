import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { objectWithKeys } from './validation.js';

export const JD_JUDGES = Object.freeze(['mdd-jd-judge-a', 'mdd-jd-judge-b'] as const);
export const JD_FIX = 'mdd-jd-fix';
export const JD_INSPECT = 'mdd_jd_inspect';
export const isJudge = (value: unknown): boolean => JD_JUDGES.includes(value as typeof JD_JUDGES[number]);
export const isJudgmentActor = (value: unknown): boolean => isJudge(value) || value === JD_FIX;

/** Exact standalone foreground transport, not a workflow dispatch handle or model override. */
export function judgmentTask(value: unknown): { subagent_type: string; description: string; prompt: string } | undefined {
  if (!value || typeof value !== 'object' || !isJudgmentActor((value as Record<string, unknown>).subagent_type)) return undefined;
  const args = objectWithKeys(value, 'standalone foreground task', ['subagent_type', 'description', 'prompt']);
  for (const key of ['subagent_type', 'description', 'prompt']) {
    if (typeof args[key] !== 'string' || !args[key].trim() || Buffer.byteLength(args[key]) > 96000) {
      throw new Error('Standalone foreground tasks require exactly three nonempty bounded strings.');
    }
  }
  return args as { subagent_type: string; description: string; prompt: string };
}

const execute = promisify(execFile);
const LIMIT = 128 * 1024;
function gitExecutable(root: string): string {
  const checkout = realpathSync(root);
  const outside = (base: string, path: string) => {
    const fromRoot = relative(base, path);
    return fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot);
  };
  // Never use cwd search, relative PATH entries, scripts, or an executable contributed by the target.
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, process.platform === 'win32' ? 'git.exe' : 'git');
    if (!outside(resolve(root), resolve(candidate))) continue;
    try {
      const executable = realpathSync(candidate);
      if (!outside(checkout, executable) || !statSync(executable).isFile()) continue;
      accessSync(executable, constants.X_OK);
      return executable;
    } catch { /* Try the next absolute native executable on the trusted host PATH. */ }
  }
  throw new Error('Immutable inspection requires a native Git executable outside the target checkout.');
}
function objectID(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new Error('Inspection requires a full lowercase Git commit object ID.');
  return value;
}
function gitPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1024 || !/^[\p{L}\p{N}_.@+ -]+(?:\/[\p{L}\p{N}_.@+ -]+)*$/u.test(value) ||
      value.startsWith('-') || value.split('/').some(part => ['.', '..', '.git'].includes(part.toLowerCase()))) {
    throw new Error('Inspection requires an exact safe repository-relative path.');
  }
  return value;
}

/** Read Git objects through fixed argv only. No shell, live source files, filters, pager or fetch. */
export async function inspectJudgmentTarget(root: string, value: unknown, signal?: AbortSignal) {
  const input = objectWithKeys(value, 'immutable inspection', ['operation', 'commit', 'base', 'path']);
  if (!['tree', 'blob', 'diff'].includes(String(input.operation))) throw new Error('Unknown immutable inspection operation.');
  const operation = input.operation as 'tree' | 'blob' | 'diff';
  const commit = objectID(input.commit);
  const base = input.base === undefined ? undefined : objectID(input.base);
  const path = input.path === undefined ? undefined : gitPath(input.path);
  if ((operation === 'diff') !== (base !== undefined) || (operation === 'blob' && path === undefined)) throw new Error('Diff requires base; blob requires path; base is only valid for diff.');
  const executable = gitExecutable(root);
  // An allowlist prevents inherited Git config/objects/exec-path/SSH/environment injection.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', GIT_ATTR_NOSYSTEM: '1' });
  const git = async (args: string[]) => {
    signal?.throwIfAborted();
    try {
      const result = await execute(executable, ['--no-pager', '--no-replace-objects', '--no-lazy-fetch',
        `--attr-source=${commit}`,
        '-c', 'core.fsmonitor=false', '-c', 'core.pager=', ...args],
      { cwd: root, env, shell: false, windowsHide: true, timeout: 5000, maxBuffer: LIMIT, encoding: 'buffer', signal });
      return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    } catch { throw new Error('Immutable Git inspection failed, was cancelled, or exceeded its 128 KiB / 5 second limit. No partial output is evidence.'); }
  };
  for (const id of base ? [base, commit] : [commit]) {
    if ((await git(['cat-file', '-t', id])).trim() !== 'commit') throw new Error('Inspection target must be a commit object.');
  }
  const args = operation === 'tree' ? ['ls-tree', '-r', '-z', '--full-tree', commit, ...(path ? ['--', path] : [])] :
    operation === 'blob' ? ['cat-file', 'blob', `${commit}:${path}`] :
      ['diff', '--no-ext-diff', '--no-textconv', '--text', '--ignore-submodules=none', '--submodule=short', '--no-renames', '--no-color', '--no-relative', '--src-prefix=a/', '--dst-prefix=b/', base!, commit, '--', ...(path ? [path] : [])];
  const content = await git(args);
  if (operation !== 'tree' && content.includes('\0')) throw new Error('Binary blobs are not textual inspection evidence.');
  return { operation, commit, ...(base ? { base } : {}), ...(path ? { path } : {}), content };
}
