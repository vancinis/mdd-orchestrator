// Shared fixtures for the version-manager tests (T6 first; T8 and T10 reuse them).
// Everything is local and offline: bare origins in temp directories, fake packages without dependencies,
// so `npm ci`, `npm run build` and `npm pack` run without a registry.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { acquireLock } from '../dist/version-store.js';
import { sourcePaths } from '../dist/version-source.js';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IDENTITY = {
  GIT_AUTHOR_NAME: 'MDD Test', GIT_AUTHOR_EMAIL: 'mdd@example.test', GIT_COMMITTER_NAME: 'MDD Test', GIT_COMMITTER_EMAIL: 'mdd@example.test',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const GIT_FLAGS = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgSign=false', '-c', 'core.autocrlf=false', '-c', 'init.defaultBranch=main'];

/** Runs real git in `cwd` with a fixed identity and no user configuration; returns trimmed stdout. */
export function gitIn(cwd, ...args) {
  const env = { ...process.env, ...IDENTITY, GIT_CONFIG_GLOBAL: join(tmpdir(), 'mdd-fixture-empty.gitconfig') };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[name];
  return execFileSync('git', [...GIT_FLAGS, ...args], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

export function tempDir(t, prefix = 'mdd-fixture-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = data => createHash('sha256').update(data).digest('hex');

const BUILD_SCRIPT = `import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('fail-build.flag')) { console.error('fixture build failure'); process.exit(1); }
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('dist', { recursive: true });
if (existsSync('vendor/dist')) cpSync('vendor/dist', 'dist', { recursive: true });
writeFileSync('dist/built.json', JSON.stringify({ version: pkg.version, marker: readFileSync('marker.txt', 'utf8').trim() }));
writeFileSync('dist/cli.js', '#!/usr/bin/env node\\nconsole.log("fixture cli " + ' + JSON.stringify(pkg.version) + ');\\n');
writeFileSync('dist/opencode-plugin.js', 'export default async () => ({});\\n');
`;

/**
 * Files of one fake release.
 * spec: { version, marker?, packageVersion?, name?, engines?, brokenBuild?, brokenLock?, changelog?, realPackage?, files? }
 *  - packageVersion: package.json version that disagrees with the tag (S38).
 *  - brokenBuild / brokenLock: build exits 1 / package-lock.json is not JSON (so `npm ci` fails offline).
 *  - realPackage: also vendors the repository's compiled probe-contract modules and `assets/opencode/**`.
 *  - files: extra `{ path: text | null }` (null removes the file); applied last.
 */
export function packageFiles(spec) {
  const version = spec.packageVersion ?? spec.version;
  const pkg = {
    name: spec.name ?? 'my-driven-development', version, private: true, type: 'module',
    exports: { './opencode-plugin': './dist/opencode-plugin.js' },
    bin: { 'mdd-ai': 'dist/cli.js' },
    files: ['dist', 'assets'],
    scripts: { build: 'node build.mjs' },
    ...(spec.engines ? { engines: { node: spec.engines } } : {}),
  };
  const lock = spec.brokenLock ? '{ this is not json' : `${JSON.stringify({ name: pkg.name, version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version, ...(spec.engines ? { engines: { node: spec.engines } } : {}) } } }, null, 2)}\n`;
  const files = {
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
    'package-lock.json': lock,
    'build.mjs': BUILD_SCRIPT,
    'marker.txt': `${spec.marker ?? `tag-${spec.version}`}\n`,
    '.gitignore': 'dist\nnode_modules\n',
    'assets/opencode/agents/mdd-fixture.md': `# fixture agent ${spec.version}\n`,
  };
  if (spec.brokenBuild) files['fail-build.flag'] = 'x\n';
  if (spec.changelog !== undefined) files['CHANGELOG.md'] = spec.changelog;
  for (const [path, text] of Object.entries(spec.files ?? {})) {
    if (text === null) delete files[path]; else files[path] = text;
  }
  return files;
}

function writeFiles(dir, files) {
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
  }
}

function copyRealPackage(dir) {
  const vendor = join(dir, 'vendor', 'dist');
  mkdirSync(vendor, { recursive: true });
  for (const name of ['project-assets', 'settings', 'setup', 'safe-paths', 'local-files', 'validation']) {
    const source = join(REPO_ROOT, 'dist', `${name}.js`);
    if (existsSync(source)) cpSync(source, join(vendor, `${name}.js`));
  }
  const assets = join(REPO_ROOT, 'assets', 'opencode');
  if (existsSync(assets)) cpSync(assets, join(dir, 'assets', 'opencode'), { recursive: true });
}

function clearWorkTree(dir) {
  for (const entry of readdirSync(dir)) if (entry !== '.git') rmSync(join(dir, entry), { recursive: true, force: true });
}

/**
 * An isolated bare origin plus a working clone. Each `release(spec)` commits that package to `main`, tags it
 * `v<version>` (annotated unless `lightweight`) and pushes branch and tags to the origin.
 * Returns { dir, url, work, commits, release, commitOnMain, moveTag, retag, deleteTag, remove }.
 */
export function makeOrigin(t, specs = []) {
  const dir = tempDir(t, 'mdd-origin-');
  const url = join(dir, 'origin.git');
  const work = join(dir, 'work');
  gitIn(dir, 'init', '--bare', '--quiet', url);
  gitIn(dir, 'clone', '--quiet', url, work);
  gitIn(work, 'checkout', '--quiet', '-B', 'main');
  const commits = {};

  const commit = (spec, message) => {
    clearWorkTree(work);
    writeFiles(work, packageFiles(spec));
    if (spec.realPackage) copyRealPackage(work);
    gitIn(work, 'add', '-A');
    gitIn(work, 'commit', '--quiet', '--allow-empty', '-m', message);
    return gitIn(work, 'rev-parse', 'HEAD');
  };
  const push = () => gitIn(work, 'push', '--quiet', '--force', 'origin', 'main', '--tags');

  const origin = {
    dir, url, work, commits,
    /** Commits and tags one release; returns the commit id. */
    release(spec) {
      const sha1 = commit(spec, `release ${spec.version}`);
      const tag = spec.tag ?? `v${spec.version}`;
      if (spec.lightweight) gitIn(work, 'tag', '-f', tag, sha1); else gitIn(work, 'tag', '-f', '-a', tag, '-m', `MDD ${spec.version}`, sha1);
      commits[spec.version] = sha1;
      push();
      return sha1;
    },
    /** A later commit on main without a tag (the "latest checkout" that must never leak into a tag build). */
    commitOnMain(spec) { const sha1 = commit(spec, 'latest main'); push(); return sha1; },
    /** Force-moves an existing tag to a new commit (different content) in the origin; returns the new commit. */
    moveTag(version, change = {}) {
      const sha1 = commit({ version, marker: `moved-${version}`, ...change }, `moved ${version}`);
      gitIn(work, 'tag', '-f', '-a', `v${version}`, '-m', 'moved', sha1);
      push();
      return sha1;
    },
    /** Points a tag at a given commit again (restoring a moved tag). */
    retag(version, sha1) { gitIn(work, 'tag', '-f', '-a', `v${version}`, '-m', 'restored', sha1); push(); },
    deleteTag(version) { gitIn(work, 'tag', '-d', `v${version}`); gitIn(work, 'push', '--quiet', 'origin', `:refs/tags/v${version}`); },
    /** Makes the origin unreachable (offline / unavailable remote). */
    remove() { rmSync(url, { recursive: true, force: true }); },
  };
  for (const spec of specs) origin.release(spec);
  return origin;
}

/** A standalone checkout (the owner's working tree for `dev`): one commit, ignored dist and node_modules. */
export function makeCheckout(t, spec = { version: '0.3.0', marker: 'dev-marker' }) {
  const dir = tempDir(t, 'mdd-checkout-');
  const work = join(dir, 'checkout');
  mkdirSync(work);
  gitIn(work, 'init', '--quiet');
  gitIn(work, 'checkout', '--quiet', '-B', 'main');
  writeFiles(work, packageFiles(spec));
  gitIn(work, 'add', '-A');
  gitIn(work, 'commit', '--quiet', '-m', 'dev checkout');
  return {
    dir: work, spec,
    head: () => gitIn(work, 'rev-parse', 'HEAD'),
    makeDirty() { writeFileSync(join(work, 'wip.txt'), 'uncommitted\n'); },
    tags: () => gitIn(work, 'tag', '--list'),
  };
}

/** An empty owned root (`<tmp>/mdd`) with a held lock. `lock.release()` is called automatically at test end. */
export function ownedFixture(t) {
  const base = tempDir(t, 'mdd-owned-');
  const ownedRoot = join(base, 'mdd');
  mkdirSync(ownedRoot, { recursive: true });
  const paths = sourcePaths(ownedRoot);
  const lock = acquireLock(paths, 'test');
  t.after(() => { try { lock.release(); } catch { /* already released */ } });
  return { base, ownedRoot, paths, lock };
}

/** A state.json value for the owned clone; `releases` maps version → commit already recorded. */
export function stateFor(originUrl, releases = {}) {
  return {
    schema: 1, origin: originUrl, devCheckout: null, active: null, adoption: null,
    releases: Object.fromEntries(Object.entries(releases).map(([version, commit]) => [version, { commit, firstSeen: '2026-11-03T00:00:00.000Z' }])),
  };
}

/** Reads a .tgz written by `npm pack` into a Map of package-relative path → bytes (no external tar needed). */
export function readTarball(path) {
  const tar = gunzipSync(readFileSync(path));
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    offset += 512;
    if (type === '0') files.set(name.replace(/^package\//, ''), Buffer.from(tar.subarray(offset, offset + size)));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Bytes (as sha256) of every file under `dir`, keyed by relative path; directories are `'dir'`. */
export function snapshotTree(dir, ignore = /^\.git(?:\/|$)/) {
  const result = {};
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignore.test(rel)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) { result[rel] = 'dir'; walk(full, rel); }
      else if (statSync(full).isFile()) result[rel] = sha(readFileSync(full));
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return result;
}
