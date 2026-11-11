import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { launcherKind } from '../dist/command-link.js';
import { installationPaths } from '../dist/installation-paths.js';
import { defaultSettings } from '../dist/settings.js';
import { runSetupUI } from '../dist/setup-ui.js';
import { installManager, readCurrent } from '../dist/version-manager.js';
import { main } from '../dist/version-cli.js';
import { npmCli } from '../dist/version-source.js';
import { readState, versionPaths, withLock, writeState } from '../dist/version-store.js';
import { BASELINE } from '../dist/versions.js';
import { isolateHome } from './helpers.mjs';
import { REPO_ROOT, gitIn, makeOrigin, readTarball } from './version-fixtures.mjs';

/**
 * Tier 4 (faithful legacy): the real 0.2.0 code is rebuilt from the baseline commit's git objects
 * (read-only on the repository: no worktree, no tag, no ref is created) and used as the active package.
 * When the baseline commit is not available the tests skip with a reason; a skip is never a pass.
 *
 * Host limitation: the legacy `link` command is never run (it would edit the user's PATH); the legacy
 * launcher rewrite is reproduced by calling the legacy `writeLaunchers` itself.
 */

process.env.npm_config_offline = 'true';
const sha = data => createHash('sha256').update(data).digest('hex');
const git = (...args) => execFileSync('git', ['-C', REPO_ROOT, ...args], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

let legacy;
let scratch;

before(() => {
  try { git('cat-file', '-e', `${BASELINE.commit}^{commit}`); }
  catch { legacy = { skip: `the baseline commit ${BASELINE.commit.slice(0, 7)} is not available in this repository` }; return; }
  scratch = mkdtempSync(join(tmpdir(), 'mdd-legacy-'));
  const dir = join(scratch, 'v020');
  const names = git('ls-tree', '-r', '--name-only', BASELINE.commit, '--', 'src', 'assets', 'package.json', 'tsconfig.json').toString('utf8').split('\n').filter(Boolean);
  for (const name of names) {
    const target = join(dir, ...name.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, git('show', `${BASELINE.commit}:${name}`));
  }
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 });
  } catch (error) {
    legacy = { skip: `the historical 0.2.0 sources did not compile with this host's tsc: ${String(error.stdout ?? error.message).slice(0, 300)}` };
    return;
  }
  assert.ok(existsSync(join(dir, 'dist', 'cli.js')));
  legacy = { dir };
});
after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

const usable = t => { if (legacy.skip) { t.skip(legacy.skip); return false; } return true; };
const asModuleUrl = path => pathToFileURL(path).href;

function childEnv(home, extra = {}) {
  return { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, ...extra };
}

/** Runs a snippet as ESM in a child with the isolated home; `arg(n)` values come from `args`. */
function esm(home, body, ...args) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', body, ...args], { encoding: 'utf8', env: childEnv(home), timeout: 60000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result.stdout;
}

/** The historical installation: package prefix + assets + ledger + loader written by 0.2.0's own `initProject`. */
function installLegacy(home) {
  const paths = installationPaths();
  const owned = paths.ownedRoot;
  const pkg = paths.installedPackageRoot;
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(owned, 'package.json'), '{"private":true}\n');
  cpSync(join(legacy.dir, 'dist'), join(pkg, 'dist'), { recursive: true });
  cpSync(join(legacy.dir, 'assets'), join(pkg, 'assets'), { recursive: true });
  cpSync(join(legacy.dir, 'package.json'), join(pkg, 'package.json'));
  const scope = join(owned, 'node_modules', '@opencode');
  mkdirSync(scope, { recursive: true });
  const kind = process.platform === 'win32' ? 'junction' : 'dir';
  symlinkSync(join(REPO_ROOT, 'node_modules', '@opencode', 'plugin'), join(scope, 'plugin'), kind);
  symlinkSync(join(REPO_ROOT, 'node_modules', 'zod'), join(owned, 'node_modules', 'zod'), kind);
  esm(home, 'const { initProject } = await import(process.argv[1]); initProject(process.argv[2], true);', asModuleUrl(join(pkg, 'dist', 'setup.js')), paths.configRoot);
  return paths;
}

/** What 0.2.0's setup/update/link do to the launchers, by calling its own `writeLaunchers`. */
function legacyRewritesLaunchers(home, paths) {
  esm(home, 'const { writeLaunchers } = await import(process.argv[1]); writeLaunchers();', asModuleUrl(join(paths.installedPackageRoot, 'dist', 'command-link.js')));
}

function managerTree(paths) {
  const hash = createHash('sha256');
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(path.slice(paths.managerRoot.length));
      if (entry.isDirectory()) walk(path); else hash.update(readFileSync(path));
    }
  };
  walk(paths.managerRoot);
  return hash.digest('hex');
}

/** The checkout bootstrap for this repository, with the hand-off recorded instead of executed. */
async function bootstrap(handoffs = [], extra = {}) {
  const lines = ['apply'];
  const io = { isTTY: true, read: async () => lines.shift(), write: () => {} };
  return runSetupUI(process.cwd(), io, { handoff: (entry, args) => { handoffs.push({ entry, args }); return 0; }, ...extra });
}

function setState(vp, change) {
  withLock(vp, 'test', lock => { const state = readState(vp); change(state); writeState(lock, state); });
}

const bin = paths => join(paths.binRoot);
function entry(home, paths, args) {
  // The bin directory is on PATH so a `link` never tries to edit the user's real PATH.
  const env = childEnv(home);
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env.PATH = `${bin(paths)}${delimiter}${process.env.PATH ?? process.env.Path ?? ''}`;
  return spawnSync(process.execPath, [paths.managerEntry, ...args], { encoding: 'utf8', env, cwd: home, timeout: 120000 });
}

test('S27 adoption of the faithful 0.2.0 installation: edits and config stay, state says adopted, repeat changes nothing', async t => {
  if (!usable(t)) return;
  const home = isolateHome(t);
  const paths = installLegacy(home);
  const agent = join(paths.configRoot, 'agents', 'mdd-apply.md');
  assert.ok(existsSync(agent), 'the historical setup installed the agent');
  writeFileSync(agent, `${readFileSync(agent, 'utf8')}\nnota local\n`);
  const edited = readFileSync(agent);
  const config = `${JSON.stringify(defaultSettings(), null, 2)}\n`;
  writeFileSync(paths.settingsPath, config);
  const ledger = readFileSync(paths.manifestPath);
  const handoffs = [];
  // Default baseline reader: `git show 34a93f6:<path>` on the real repository (read-only, no network).
  assert.equal(await bootstrap(handoffs), 'ready');
  const state = readState(versionPaths(paths.ownedRoot));
  assert.equal(state.active.provenance, 'adopted');
  assert.equal(state.active.version, '0.2.0');
  assert.equal(state.active.commit, BASELINE.commit);
  assert.equal(state.active.channel, 'stable');
  assert.deepEqual(state.active.verified, { packageJson: true, packagedAssets: true, dist: false });
  assert.deepEqual(state.active.editedAssets, ['agents/mdd-apply.md']);
  assert.ok(readFileSync(agent).equals(edited));
  assert.equal(readFileSync(paths.settingsPath, 'utf8'), config);
  assert.ok(readFileSync(paths.manifestPath).equals(ledger));
  assert.equal(handoffs.length, 1);
  assert.deepEqual(handoffs[0].args, ['setup', '--checkout', resolve(REPO_ROOT)]);
  const stateBytes = readFileSync(versionPaths(paths.ownedRoot).statePath);
  assert.equal(await bootstrap(handoffs), 'ready');
  assert.ok(readFileSync(versionPaths(paths.ownedRoot).statePath).equals(stateBytes), 'repeat writes no history');
});

test('S28 refusals against the faithful installation: other version and packaged-content difference, nothing else written', async t => {
  if (!usable(t)) return;
  const home = isolateHome(t);
  const paths = installLegacy(home);
  const manifest = join(paths.installedPackageRoot, 'package.json');
  const original = readFileSync(manifest, 'utf8');
  writeFileSync(manifest, original.replace(`"version": "${BASELINE.version}"`, '"version": "0.2.1"'));
  const before = readFileSync(paths.manifestPath);
  assert.equal(await bootstrap(), 'ready');
  let state = readState(versionPaths(paths.ownedRoot));
  assert.equal(state.active, null);
  assert.match(state.adoption.reason, /0\.2\.1/);
  assert.match(state.adoption.reason, /mdd-ai use 0\.2\.0/);
  writeFileSync(manifest, original);
  const contract = join(paths.installedPackageRoot, 'assets', 'opencode', 'contracts', 'workflow.md');
  writeFileSync(contract, `${readFileSync(contract, 'utf8')}\nmodificado\n`);
  assert.equal(await bootstrap(), 'ready');
  state = readState(versionPaths(paths.ownedRoot));
  assert.equal(state.active, null);
  assert.match(state.adoption.reason, /difieren de la línea base[\s\S]*workflow\.md/);
  assert.ok(readFileSync(paths.manifestPath).equals(before));
  assert.ok(readCurrent(paths), 'the manager is installed even when adoption is refused');
});

test('S8/S1 with the faithful 0.2.0 active: doctor is merged through the entry, nothing switches; profile list reaches 0.2.0', async t => {
  if (!usable(t)) return;
  const home = isolateHome(t);
  const paths = installLegacy(home);
  const fixture = makeOrigin(t, [{ version: '0.3.0', realPackage: true, files: { '.gitignore': '/dist\n/node_modules\n' } }, { version: '0.4.0-preview.1', realPackage: true, files: { '.gitignore': '/dist\n/node_modules\n' } }]);
  assert.equal(await bootstrap(), 'ready');
  const vp = versionPaths(paths.ownedRoot);
  setState(vp, state => { state.origin = fixture.url; });
  const before = readFileSync(vp.statePath, 'utf8');
  const report = entry(home, paths, ['doctor']);
  const merged = JSON.parse(report.stdout);
  const names = merged.checks.map(item => item.check);
  for (const expected of ['installed-package', 'package-freshness', 'version-manager', 'active-version', 'available-versions']) assert.ok(names.includes(expected), expected);
  assert.equal(merged.checks.find(item => item.check === 'installed-package').status, 'ok', 'the historical doctor ran');
  assert.match(merged.checks.find(item => item.check === 'active-version').message, /estable 0\.2\.0/);
  assert.match(merged.checks.find(item => item.check === 'available-versions').message, /Hay versiones más nuevas: estable 0\.3\.0, preview 0\.4\.0-preview\.1\./);
  assert.equal(readFileSync(vp.statePath, 'utf8'), before, 'doctor never writes state');
  assert.equal(readState(vp).active.version, '0.2.0');
  const listed = entry(home, paths, ['profile', 'list']);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, '* default\n');
});

test('S18/S39 manager survival: a historical launcher rewrite is repaired by the entry, and a newer manager revision is never downgraded', async t => {
  if (!usable(t)) return;
  const home = isolateHome(t);
  const paths = installLegacy(home);
  assert.equal(await bootstrap(), 'ready');
  // A revision-2 manager (a patched copy of this build) supersedes the checkout's revision 1.
  const newer = join(scratch, 'dist-r2');
  rmSync(newer, { recursive: true, force: true });
  cpSync(join(REPO_ROOT, 'dist'), newer, { recursive: true });
  const managerFile = join(newer, 'version-manager.js');
  writeFileSync(managerFile, readFileSync(managerFile, 'utf8').replace('MANAGER_REVISION = 1', 'MANAGER_REVISION = 2'));
  installManager(newer, { revision: 2, version: '0.4.0', source: 'release' }, paths);
  const stable = { current: readFileSync(paths.managerCurrentPath, 'utf8'), tree: managerTree(paths) };
  assert.equal(readCurrent(paths).revision, 2);

  legacyRewritesLaunchers(home, paths);
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')), 'legacy', `${name} reaches 0.2.0 after the rewrite`);
  assert.equal(managerTree(paths), stable.tree, 'the historical software cannot touch the manager');
  // Recovery without reinstalling: any direct manager invocation re-asserts routing.
  const linked = entry(home, paths, ['link']);
  assert.equal(linked.status, 0, linked.stderr);
  assert.match(linked.stdout, /ya está en tu PATH/);
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')), 'manager', name);

  // The checkout bootstrap (revision 1) keeps the newer manager; use and versions keep working.
  assert.equal(await bootstrap(), 'ready');
  assert.equal(readFileSync(paths.managerCurrentPath, 'utf8'), stable.current);
  assert.equal(managerTree(paths), stable.tree);
  const versions = entry(home, paths, ['versions']);
  assert.equal(versions.status, 0, versions.stderr);
  assert.match(versions.stdout, /revisión 2/);
  assert.match(versions.stdout, /estable 0\.2\.0/);
  assert.equal(entry(home, paths, ['use']).status, 2);
});

test('S1/S2/S5/S27 from the adopted 0.2.0, use preview picks the numerically highest preview and keeps the user edits in the backup', async t => {
  if (!usable(t)) return;
  const home = isolateHome(t);
  const paths = installLegacy(home);
  const agent = join(paths.configRoot, 'agents', 'mdd-apply.md');
  writeFileSync(agent, `${readFileSync(agent, 'utf8')}\nnota local\n`);
  const edited = readFileSync(agent);
  const config = `${JSON.stringify(defaultSettings(), null, 2)}\n`;
  writeFileSync(paths.settingsPath, config);
  const REAL = { realPackage: true, files: { '.gitignore': '/dist\n/node_modules\n' } };
  // Published in shuffled order on purpose: .10 first, then .9.
  const fixture = makeOrigin(t, [{ version: '0.3.0-preview.10', marker: 'ten', ...REAL }, { version: '0.3.0-preview.9', marker: 'nine', ...REAL }]);
  assert.equal(await bootstrap(), 'ready');
  setState(versionPaths(paths.ownedRoot), state => { state.origin = fixture.url; });

  const out = []; const err = [];
  const code = await main(['use', 'preview', '--yes'], { paths, cwd: home, out: text => out.push(text), err: text => err.push(text) });
  assert.equal(code, 0, err.join('') + out.join(''));
  const text = out.join('');
  assert.match(text, /Listo: 0\.3\.0-preview\.10 activa \(preview/);
  assert.match(text, /Editado a mano\s+agents\/mdd-apply\.md/);
  assert.match(text, /opencode service restart/);
  const state = readState(versionPaths(paths.ownedRoot));
  assert.equal(state.active.version, '0.3.0-preview.10');
  assert.equal(state.active.selectedAs, 'preview');
  const pkg = JSON.parse(readFileSync(join(paths.installedPackageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.version, '0.3.0-preview.10');
  const backup = /Respaldo {5}(\S.*)/.exec(text.slice(text.indexOf('Listo:')))[1].trim();
  assert.ok(readFileSync(join(backup, 'assets', 'agents', 'mdd-apply.md')).equals(edited), 'the hand-edited bytes are in the backup');
  assert.equal(readFileSync(paths.settingsPath, 'utf8'), config, 'a compatible configuration is kept byte-for-byte');
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')), 'manager');
  const listed = entry(home, paths, ['versions']);
  assert.match(listed.stdout, /preview 0\.3\.0-preview\.10/);
});

// ---------------------------------------------------------------- G5: the historical release through the manager

const fileHashes = (dir, base = dir, out = {}) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) fileHashes(path, base, out);
    else out[path.slice(base.length + 1).replaceAll('\\', '/')] = sha(readFileSync(path));
  }
  return out;
};
const only = (map, pattern) => Object.fromEntries(Object.entries(map).filter(([key]) => pattern.test(key)));

/** Package, assets, config and ledger of the installation as plain comparable data. */
function contents(paths) {
  const ledger = existsSync(paths.manifestPath) ? JSON.parse(readFileSync(paths.manifestPath, 'utf8')) : {};
  const files = Object.fromEntries(Object.keys(ledger).sort().map(path => [path, existsSync(join(paths.configRoot, path)) ? sha(readFileSync(join(paths.configRoot, path))) : 'absent']));
  return {
    package: fileHashes(paths.installedPackageRoot),
    assets: { ledger, files },
    config: existsSync(paths.settingsPath) ? sha(readFileSync(paths.settingsPath)) : 'absent',
  };
}

/** Contents plus the recorded identity and the launcher routing. */
function installation(paths) {
  const active = readState(versionPaths(paths.ownedRoot)).active;
  return {
    ...contents(paths),
    identity: active && { kind: active.kind, version: active.version, commit: active.commit, channel: active.channel, selectedAs: active.selectedAs, provenance: active.provenance },
    routing: {
      launchers: ['mdd-ai.cmd', 'mdd-ai'].map(name => launcherKind(readFileSync(join(paths.binRoot, name), 'utf8'))),
      manager: readFileSync(paths.managerCurrentPath, 'utf8'),
    },
  };
}

const junction = process.platform === 'win32' ? 'junction' : 'dir';
function linkDependency(nodeModules, name) {
  const target = join(nodeModules, ...name.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'node_modules', ...name.split('/')), target, junction);
}

/** npm for the historical release without a registry: `ci` links the host's current dependencies, `build` runs the host's tsc. */
function historicalNpm() {
  const real = (args, cwd, timeout) => execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return (args, cwd, timeout) => {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (pkg.version !== BASELINE.version || !existsSync(join(cwd, 'tsconfig.json'))) return real(args, cwd, timeout);
    if (args[0] === 'ci') {
      for (const name of ['zod', '@opencode/plugin', '@types/node']) linkDependency(join(cwd, 'node_modules'), name);
      return '';
    }
    if (args[0] === 'run' && args[1] === 'build') {
      rmSync(join(cwd, 'dist'), { recursive: true, force: true });
      execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cwd], { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
      return '';
    }
    try { return real(args, cwd, timeout); } finally { if (args[0] === 'pack') rmSync(join(cwd, 'node_modules'), { recursive: true, force: true }); }
  };
}

/** Stage install without a registry: unpack the real tarball and link the host's dependencies beside it. */
function historicalStage(stageDir, tarball) {
  const root = join(stageDir, 'node_modules', 'my-driven-development');
  for (const [path, bytes] of readTarball(tarball)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  for (const name of ['zod', '@opencode/plugin']) linkDependency(join(stageDir, 'node_modules'), name);
}

/** An isolated origin whose `v0.2.0` is the real historical commit (objects fetched read-only), plus a newer preview. */
function historicalOrigin(t) {
  const origin = makeOrigin(t, []);
  gitIn(origin.work, 'fetch', '--quiet', REPO_ROOT, BASELINE.commit);
  gitIn(origin.work, 'checkout', '--quiet', '-B', 'main', BASELINE.commit);
  gitIn(origin.work, 'tag', '-a', 'v0.2.0', '-m', 'MDD 0.2.0', BASELINE.commit);
  gitIn(origin.work, 'push', '--quiet', '--force', 'origin', 'main', '--tags');
  origin.release({ version: '0.3.0-preview.1', marker: 'preview-one', realPackage: true, files: { '.gitignore': '/dist\n/node_modules\n' } });
  return origin;
}

async function manage(paths, home, args, deps = {}) {
  const out = []; const err = [];
  const code = await main(args, {
    paths, cwd: home, out: text => out.push(text), err: text => err.push(text),
    registerPath: () => assert.fail('the test must never edit a PATH'), ...deps,
  });
  return { code, out: out.join(''), err: err.join('') };
}

test('G5 S1/S5: use 0.2.0 from the historical tag, then preview, then stable returns to the same faithful installation', async t => {
  if (!usable(t)) return;
  const home = isolateHome(t);
  const paths = installLegacy(home);
  // The reference is what the historical code itself writes: its own initProject over its own build.
  const reference = contents(paths);
  assert.ok(Object.keys(reference.package).length > 0 && Object.keys(reference.assets.files).length > 0);
  rmSync(paths.configRoot, { recursive: true, force: true });
  const hostDependency = join(REPO_ROOT, 'node_modules', 'zod', 'package.json');
  assert.ok(existsSync(hostDependency), 'removing the reference installation never reaches the host dependencies');

  const origin = historicalOrigin(t);
  assert.equal(origin.commits['0.3.0-preview.1'] === BASELINE.commit, false);
  assert.equal(gitIn(origin.work, 'rev-parse', 'v0.2.0^{commit}'), BASELINE.commit, 'the isolated tag peels to the historical commit');
  assert.equal(await bootstrap(), 'ready');
  mkdirSync(paths.configRoot, { recursive: true });
  const config = `${JSON.stringify(defaultSettings(), null, 2)}\n`;
  writeFileSync(paths.settingsPath, config);
  setState(versionPaths(paths.ownedRoot), state => { state.origin = origin.url; });
  const routing = installation(paths).routing;
  assert.deepEqual(routing.launchers, ['manager', 'manager']);

  // 1. use 0.2.0: built from the historical objects by the owned clone, installed with the manager.
  const historical = { source: { npm: historicalNpm() }, switch: { installStage: historicalStage } };
  const first = await manage(paths, home, ['use', '0.2.0', '--yes'], historical);
  assert.equal(first.code, 0, first.err + first.out);
  assert.match(first.out, /Listo: 0\.2\.0 activa/);
  const atStable = installation(paths);
  assert.deepEqual(atStable.identity, { kind: 'release', version: '0.2.0', commit: BASELINE.commit, channel: 'stable', selectedAs: '0.2.0', provenance: 'installed' });
  assert.equal(atStable.package['package.json'], reference.package['package.json'], 'package.json is the historical one');
  assert.deepEqual(only(atStable.package, /^(?:dist|assets)\//), only(reference.package, /^(?:dist|assets)\//), 'dist and assets equal what the historical code installs');
  assert.deepEqual(atStable.assets, reference.assets, 'agents, skills, loader and ledger equal the historical installation');
  assert.equal(atStable.config, sha(config), 'the compatible configuration is kept byte-for-byte');
  assert.deepEqual(atStable.routing, routing);
  assert.match(first.out, /opencode service restart/);

  // 2. use preview: the newer preview replaces it; 0.2.0 stays reachable.
  const second = await manage(paths, home, ['use', 'preview', '--yes']);
  assert.equal(second.code, 0, second.err + second.out);
  assert.match(second.out, /Listo: 0\.3\.0-preview\.1 activa/);
  const atPreview = installation(paths);
  assert.deepEqual(atPreview.identity, { kind: 'release', version: '0.3.0-preview.1', commit: origin.commits['0.3.0-preview.1'], channel: 'preview', selectedAs: 'preview', provenance: 'installed' });
  assert.equal(JSON.parse(readFileSync(join(paths.installedPackageRoot, 'package.json'), 'utf8')).version, '0.3.0-preview.1');
  assert.notDeepEqual(atPreview.package, atStable.package);
  assert.equal(atPreview.config, atStable.config);
  assert.deepEqual(atPreview.routing, routing);

  // 3. use stable: back to the historical release, identical to step 1 (and so to the reference).
  const third = await manage(paths, home, ['use', 'stable', '--yes'], historical);
  assert.equal(third.code, 0, third.err + third.out);
  assert.match(third.out, /Listo: 0\.2\.0 activa/);
  const back = installation(paths);
  assert.equal(back.identity.selectedAs, 'stable', 'only how it was selected differs');
  assert.deepEqual({ ...back, identity: { ...back.identity, selectedAs: '0.2.0' } }, atStable, 'preview -> stable restores the same package, assets, ledger, config, identity and routing');
  assert.deepEqual(only(back.package, /^(?:dist|assets)\//), only(reference.package, /^(?:dist|assets)\//));
  assert.ok(existsSync(hostDependency), 'building the historical release never touched the host dependencies');
  assert.equal(statSync(hostDependency).isFile(), true);
});

// ---------------------------------------------------------------- G6: the historical setup/update under the managed router

/**
 * Runs the historical `runSetupUI` (the code behind 0.2.0's `setup`/`update`) from the active package, in a child
 * process with a scripted terminal: `isTTY` is true, answers come from `lines`, and the PATH is never edited.
 */
const HISTORICAL_SETUP = `
const [, setupUrl, mode, answer, fail] = process.argv;
const { runSetupUI } = await import(setupUrl);
const lines = [answer];
const io = { isTTY: true, read: async prompt => { process.stdout.write(prompt); return lines.shift(); }, write: text => process.stdout.write(text) };
const deps = { registerPath: () => { throw new Error('the PATH must not be edited'); } };
if (fail === 'issues') deps.check = async () => ({ ready: false, checks: [{ check: 'controlled', status: 'action', message: 'fallo controlado' }] });
try {
  const result = await runSetupUI(process.cwd(), io, deps, { mode });
  process.exitCode = result === 'issues' ? 1 : 0;
} catch (error) {
  process.stderr.write('Error de MDD: ' + error.message + '\\n');
  process.exitCode = error.name === 'ValidationError' ? 2 : 1;
}
`;

/** The router's version wizard with a scripted terminal; option 1 keeps the active version and delegates to its own setup. */
const keepWizard = () => ({ isTTY: true, read: async () => '1', write: () => {} });

function historicalDelegate(home, paths, { answer = 'apply', fail = '' } = {}) {
  const calls = [];
  const delegate = async (args, { capture }) => {
    calls.push({ args, capture });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', HISTORICAL_SETUP, asModuleUrl(join(paths.installedPackageRoot, 'dist', 'setup-ui.js')), args[0], answer, fail], {
      encoding: 'utf8', env: childEnv(home), cwd: home, timeout: 120000,
    });
    calls.at(-1).output = result.stdout + result.stderr;
    calls.at(-1).launchers = ['mdd-ai.cmd', 'mdd-ai'].map(name => launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')));
    return { code: result.status ?? 1, stdout: result.stdout + result.stderr };
  };
  return { delegate, calls };
}

async function adoptedLegacy(t) {
  const home = isolateHome(t);
  const paths = installLegacy(home);
  assert.equal(await bootstrap(), 'ready');
  // Delegation tests must not fetch the developer's origin or record newly discovered tags.
  setState(versionPaths(paths.ownedRoot), state => { state.origin = null; });
  assert.equal(readState(versionPaths(paths.ownedRoot)).active.provenance, 'adopted');
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')), 'manager');
  return { home, paths };
}

test('G6 S18 the historical setup and update, successful and failing, run under the managed router and routing is restored each time', async t => {
  if (!usable(t)) return;
  const { home, paths } = await adoptedLegacy(t);
  const reachable = () => ['mdd-ai.cmd', 'mdd-ai'].map(name => launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')));
  const stateBytes = () => readFileSync(versionPaths(paths.ownedRoot).statePath);
  const state = stateBytes();
  const manager = readFileSync(paths.managerCurrentPath, 'utf8');

  for (const command of ['update', 'setup']) {
    const run = historicalDelegate(home, paths);
    const ok = await manage(paths, home, [command], { delegate: run.delegate, io: keepWizard() });
    assert.equal(run.calls.length, 1, `${command} reached the active package once`);
    assert.deepEqual(run.calls[0].args, [command]);
    assert.equal(ok.code, 0, `${command}: ${ok.err}${ok.out}${run.calls[0].output}`);
    assert.deepEqual(run.calls[0].launchers, ['legacy', 'legacy'], `${command}: the historical code rewrote the launchers before the router restored them`);
    assert.deepEqual(reachable(), ['manager', 'manager'], `${command} success: routing restored after the historical launcher rewrite`);
  }
  assert.equal(readFileSync(paths.managerCurrentPath, 'utf8'), manager, 'the manager is untouched');
  assert.ok(stateBytes().equals(state), 'the historical commands never write the version state');

  // The failing variants: the historical doctor reports issues after it already rewrote the launchers (exit 1);
  // the user declines (exit 0, nothing applied).
  const issues = historicalDelegate(home, paths, { fail: 'issues' });
  const failed = await manage(paths, home, ['update'], { delegate: issues.delegate, io: keepWizard() });
  assert.equal(failed.code, 1, failed.err + failed.out);
  assert.deepEqual(issues.calls[0].launchers, ['legacy', 'legacy'], 'the failing run had already rewritten the launchers');
  assert.deepEqual(reachable(), ['manager', 'manager'], 'failure: routing restored');
  const declined = historicalDelegate(home, paths, { answer: 'cancel' });
  const cancelled = await manage(paths, home, ['update'], { delegate: declined.delegate, io: keepWizard() });
  assert.equal(cancelled.code, 0, cancelled.err + cancelled.out);
  assert.deepEqual(reachable(), ['manager', 'manager']);
  assert.ok(stateBytes().equals(state));

  // Without a terminal the router itself refuses before delegating anything.
  const refused = spawnSync(process.execPath, [paths.managerEntry, 'setup'], { encoding: 'utf8', env: childEnv(home), cwd: home, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(refused.status, 2, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /necesita una terminal interactiva/);
  assert.deepEqual(reachable(), ['manager', 'manager']);
  assert.ok(stateBytes().equals(state));
});

const INTERRUPTED_ROUTER = `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [, versionCli, rewrite, marker] = process.argv;
const { main } = await import(versionCli);
await main(['setup'], {
  io: { isTTY: true, read: async () => '1', write: () => {} },
  registerPath: () => { throw new Error('the PATH must not be edited'); },
  delegate: async () => {
    // What the historical setup does to the launchers, then the router is killed before it can restore them.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', rewrite], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    writeFileSync(marker, 'rewritten');
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  },
});
`;

test('G6 S18 an interrupted delegation leaves the historical launchers and the direct manager entry repairs them without reinstalling', async t => {
  if (!usable(t)) return;
  const { home, paths } = await adoptedLegacy(t);
  const marker = join(scratch, `interrupted-${process.pid}-${Date.now()}`);
  const rewrite = `const { writeLaunchers } = await import(${JSON.stringify(asModuleUrl(join(paths.installedPackageRoot, 'dist', 'command-link.js')))}); writeLaunchers();`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', INTERRUPTED_ROUTER, asModuleUrl(join(REPO_ROOT, 'dist', 'version-cli.js')), rewrite, marker], {
    env: childEnv(home), cwd: home, stdio: 'ignore', windowsHide: true,
  });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } });
  const deadline = Date.now() + 60000;
  while (!existsSync(marker) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(existsSync(marker), 'the historical launcher rewrite happened under the router');
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')), 'legacy', `${name} was left pointing at 0.2.0 by the killed router`);
  const manager = readFileSync(paths.managerCurrentPath, 'utf8');

  const repaired = entry(home, paths, ['link']);
  assert.equal(repaired.status, 0, repaired.stderr);
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(paths.binRoot, name), 'utf8')), 'manager', name);
  assert.equal(readFileSync(paths.managerCurrentPath, 'utf8'), manager, 'recovery did not reinstall the manager');
  assert.equal(readState(versionPaths(paths.ownedRoot)).active.version, '0.2.0');
  assert.equal(entry(home, paths, ['versions']).status, 0);
});
