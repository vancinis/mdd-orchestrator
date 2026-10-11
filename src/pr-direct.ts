import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitExecutable } from './judgment-day.js';

/**
 * What a direct edit changed, as git sees it. A direct edit is a precise change the coordinator
 * makes without a run, so no phase recorded which files it touched — but git did. Taking the file
 * list from here rather than from the coordinator is what lets such a change have a PR body at
 * all: the coordinator still writes why each file changed, yet it can neither leave a changed file
 * out nor add one that did not change.
 */
export type DirectChanges = { baseRef: string; baseCommit: string; files: string[] };
/** One table row per file; a change this wide is not the small edit a direct one is. */
export const DIRECT_FILE_LIMIT = 128;

const execute = promisify(execFile);
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function targetRef(value: string): string {
  const ref = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new Error('baseRef must name the PR target branch as a plain ref, such as staging or origin/staging.');
  }
  return ref;
}

/**
 * The PR target branch against the working tree: committed, staged, unstaged and untracked work
 * alike, because a direct edit is usually drafted before it is committed. The remote branch wins
 * over a local one of the same name: it is what the PR is opened against, and a stale local copy
 * would sweep work other people already merged into the table.
 *
 * Global Git configuration stays on, unlike the audit readers: it holds the user's global ignore
 * file, and a file ignored there but listed here would demand a reason for something the PR will
 * never carry. Everything that could run a program from that configuration is switched off.
 */
export async function directChanges(root: string, baseRef: string, signal?: AbortSignal): Promise<DirectChanges> {
  const ref = targetRef(baseRef);
  let executable: string;
  try { executable = gitExecutable(root); }
  catch { throw new Error('No native Git executable outside this checkout was found, so the files of a direct edit cannot be listed.'); }
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'XDG_CONFIG_HOME']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' });
  let cwd = root;
  const git = async (args: string[]): Promise<string> => {
    signal?.throwIfAborted();
    const result = await execute(executable, ['--no-pager', '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.pager=', ...args],
      { cwd, env, shell: false, windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024, encoding: 'buffer', signal });
    return new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
  };
  const commit = async (name: string): Promise<string | undefined> => {
    try {
      const id = (await git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${name}^{commit}`])).trim();
      return OID.test(id) ? id : undefined;
    } catch { signal?.throwIfAborted(); return undefined; }
  };
  try { cwd = (await git(['rev-parse', '--show-toplevel'])).trim(); }
  catch { signal?.throwIfAborted(); throw new Error('This workspace is not a readable Git checkout, so the files of a direct edit cannot be listed.'); }
  const remote = ref.startsWith('origin/') ? ref : `origin/${ref}`;
  const lookups = [{ name: remote, spec: `refs/remotes/${remote}` }, ...(remote === ref ? [] : [{ name: ref, spec: ref }])];
  let target: { name: string; id: string } | undefined;
  for (const lookup of lookups) {
    const id = await commit(lookup.spec);
    if (id) { target = { name: lookup.name, id }; break; }
  }
  if (!target) throw new Error(`${lookups.map(lookup => lookup.name).join(' / ')} is not a branch in this checkout. Fetch it, or pass the exact PR target branch as baseRef.`);
  const head = await commit('HEAD');
  if (!head) throw new Error('This checkout has no commit yet, so there is no branch to open a PR from.');
  let base: string;
  try { base = (await git(['merge-base', target.id, head])).trim(); }
  catch { signal?.throwIfAborted(); base = ''; }
  if (!OID.test(base)) throw new Error(`${target.name} and HEAD share no history, so a PR between them has nothing to compare.`);
  let listed: string[];
  try {
    const tracked = await git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none', '--no-relative', base, '--']);
    const untracked = await git(['ls-files', '--others', '--exclude-standard', '--full-name', '-z']);
    listed = `${tracked}${untracked}`.split('\0').filter(Boolean);
  } catch {
    signal?.throwIfAborted();
    throw new Error('Git could not list the changed files within its limits; no file list was produced.');
  }
  const files = [...new Set(listed)].sort();
  if (!files.length) throw new Error(`Nothing differs from ${target.name}: there is no change for a PR to describe.`);
  if (files.length > DIRECT_FILE_LIMIT) {
    throw new Error(`${files.length} files differ from ${target.name}, more than one body lists (${DIRECT_FILE_LIMIT}). Check that baseRef is the PR target branch; a change this wide is a run, not a direct edit.`);
  }
  return { baseRef: target.name, baseCommit: base, files };
}
