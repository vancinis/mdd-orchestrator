import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMMAND, ENTRY_TEXT, launcherFiles, writeLaunchers } from '../dist/command-link.js';
import { installationPaths } from '../dist/installation-paths.js';
import {
  MANAGER_DIR, MANAGER_REVISION, ManagerError, ensureRouting, installManager, managerDigest, readCurrent, recoveryCommand,
} from '../dist/version-manager.js';
import { isolateHome } from './helpers.mjs';

function fixture(t) {
  const home = isolateHome(t);
  const paths = installationPaths({ home, env: { XDG_CONFIG_HOME: home } });
  fs.mkdirSync(paths.ownedRoot, { recursive: true });
  const scratch = fs.mkdtempSync(join(tmpdir(), 'mdd-manager-src-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  return { home, paths, scratch };
}

/** A stand-in for a package `dist`: the router prints who it is and what it received. */
function makeDist(scratch, label, { router = true } = {}) {
  const dir = fs.mkdtempSync(join(scratch, `dist-${label}-`));
  fs.writeFileSync(join(dir, 'version-manager.js'), `export const MANAGER_REVISION = 0; // ${label}\n`);
  if (router) {
    fs.writeFileSync(join(dir, 'version-cli.js'), [
      'export async function main(argv) {',
      `  console.log(JSON.stringify({ label: ${JSON.stringify(label)}, argv, cwd: process.cwd() }));`,
      "  return argv.includes('fail') ? 3 : 0;",
      '}', ''].join('\n'));
  }
  fs.writeFileSync(join(dir, 'ignored.d.ts'), 'export {};\n');
  return dir;
}

function plantPackageCli(paths, label = 'active-cli') {
  fs.mkdirSync(join(paths.installedPackageRoot, 'dist'), { recursive: true });
  fs.writeFileSync(join(paths.installedPackageRoot, 'dist', 'cli.js'), `console.log(JSON.stringify({ label: ${JSON.stringify(label)}, argv: process.argv.slice(2) })); process.exitCode = process.argv.includes('fail') ? 5 : 0;\n`);
}

function runEntry(paths, args, cwd) {
  const result = spawnSync(process.execPath, [paths.managerEntry, ...args], { encoding: 'utf8', cwd, timeout: 30000 });
  return { status: result.status, out: result.stdout, err: result.stderr, json: (() => { try { return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)); } catch { return undefined; } })() };
}

function treeDigest(root) {
  const hash = createHash('sha256');
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      hash.update(path.slice(root.length));
      if (entry.isDirectory()) walk(path); else hash.update(fs.readFileSync(path));
    }
  };
  walk(root);
  return hash.digest('hex');
}

test('the installation paths expose the permanent manager, versions and backups layout', t => {
  const { paths } = fixture(t);
  assert.equal(paths.managerRoot, join(paths.ownedRoot, 'manager'));
  assert.equal(paths.managerEntry, join(paths.managerRoot, 'entry.mjs'));
  assert.equal(paths.managerCurrentPath, join(paths.managerRoot, 'current.json'));
  assert.equal(paths.versionsRoot, join(paths.ownedRoot, 'versions'));
  assert.equal(paths.backupsRoot, join(paths.ownedRoot, 'backups'));
  assert.equal(Number.isInteger(MANAGER_REVISION) && MANAGER_REVISION >= 1, true);
});

test('installing a manager copies only the dist js, records current.json and writes the stable entry', t => {
  const { paths, scratch } = fixture(t);
  const result = installManager(makeDist(scratch, 'one'), { revision: 1, version: '0.3.0-preview.1', source: 'checkout' }, paths, () => new Date('2026-11-03T14:00:00Z'));
  assert.equal(result.action, 'installed');
  const current = readCurrent(paths);
  assert.match(current.dir, MANAGER_DIR);
  assert.deepEqual({ ...current, digest: undefined, dir: undefined }, {
    dir: undefined, previous: null, revision: 1, version: '0.3.0-preview.1', source: 'checkout', digest: undefined, installedAt: '2026-11-03T14:00:00.000Z',
  });
  assert.deepEqual(fs.readdirSync(join(paths.managerRoot, current.dir, 'dist')).sort(), ['version-cli.js', 'version-manager.js']);
  assert.equal(fs.readFileSync(join(paths.managerRoot, current.dir, 'package.json'), 'utf8').trim(), '{"private":true,"type":"module"}');
  assert.equal(fs.readFileSync(paths.managerEntry, 'utf8'), ENTRY_TEXT);
  assert.equal(current.dir, `r1-${current.digest.slice(0, 8)}`);
  assert.deepEqual(fs.readdirSync(paths.managerRoot).sort(), ['current.json', current.dir, 'entry.mjs'].sort(), 'no temporary leftovers');
});

test('the manager only moves forward: an equal or lower revision is kept, a higher one keeps the previous as fallback', t => {
  const { paths, scratch } = fixture(t);
  const first = installManager(makeDist(scratch, 'r1'), { revision: 1, version: '0.3.0', source: 'release' }, paths).current;
  const same = installManager(makeDist(scratch, 'r1b'), { revision: 1, version: '0.4.0', source: 'release' }, paths);
  assert.equal(same.action, 'kept');
  assert.deepEqual(readCurrent(paths), first, 'equal revision changes nothing');
  const second = installManager(makeDist(scratch, 'r2'), { revision: 2, version: '0.4.0', source: 'release' }, paths).current;
  assert.equal(second.revision, 2);
  assert.equal(second.previous, first.dir);
  const before = treeDigest(paths.managerRoot);
  const lower = installManager(makeDist(scratch, 'old'), { revision: 1, version: '0.2.5', source: 'release' }, paths);
  assert.equal(lower.action, 'kept');
  assert.match(lower.reason, /revisión 2/);
  assert.equal(treeDigest(paths.managerRoot), before, 'a lower revision leaves every manager file untouched');
  const third = installManager(makeDist(scratch, 'r3'), { revision: 3, version: '0.5.0', source: 'checkout' }, paths).current;
  assert.equal(third.previous, second.dir);
  assert.equal(fs.existsSync(join(paths.managerRoot, first.dir)), false, 'only current and previous are retained');
  assert.equal(fs.existsSync(join(paths.managerRoot, second.dir)), true);
});

test('a damaged newer manager is never downgraded by an older source (P2)', t => {
  const { paths, scratch } = fixture(t);
  const second = installManager(makeDist(scratch, 'r2'), { revision: 2, version: '0.4.0', source: 'release' }, paths).current;
  fs.rmSync(join(paths.managerRoot, second.dir, 'dist', 'version-cli.js'));
  const before = treeDigest(paths.managerRoot);
  assert.throws(() => installManager(makeDist(scratch, 'old'), { revision: 1, version: '0.3.0', source: 'checkout' }, paths), error => error instanceof ManagerError && /revisión 2/.test(error.message) && /dañado/.test(error.message));
  assert.equal(readCurrent(paths)?.revision, 2, 'the recorded revision floor is kept');
  assert.equal(treeDigest(paths.managerRoot), before, 'nothing was written');
  const repaired = installManager(makeDist(scratch, 'r3'), { revision: 3, version: '0.5.0', source: 'release' }, paths);
  assert.equal(repaired.action, 'installed');
  assert.equal(repaired.current.revision, 3);
});

test('invalid or incomplete sources are refused before anything is written', t => {
  const { paths, scratch } = fixture(t);
  assert.throws(() => installManager(makeDist(scratch, 'norouter', { router: false }), { revision: 1, version: '1', source: 'release' }, paths), ManagerError);
  for (const revision of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => installManager(makeDist(scratch, 'x'), { revision, version: '1', source: 'release' }, paths), ManagerError);
  }
  assert.equal(fs.existsSync(paths.managerRoot), false);
});

test('a manager whose router file disappeared is repaired even at the same revision', t => {
  const { paths, scratch } = fixture(t);
  const dist = makeDist(scratch, 'heal');
  const first = installManager(dist, { revision: 1, version: '0.3.0', source: 'release' }, paths).current;
  fs.rmSync(join(paths.managerRoot, first.dir, 'dist', 'version-cli.js'));
  const again = installManager(dist, { revision: 1, version: '0.3.0', source: 'release' }, paths);
  assert.equal(again.action, 'installed');
  assert.equal(fs.existsSync(join(paths.managerRoot, again.current.dir, 'dist', 'version-cli.js')), true);
  assert.equal(again.current.previous, null, 'a broken directory is never recorded as the fallback');
});

test('the digest depends on names and bytes, not on read order', () => {
  const a = { name: 'a.js', bytes: Buffer.from('1') }; const b = { name: 'b.js', bytes: Buffer.from('2') };
  assert.equal(managerDigest([a, b]), managerDigest([a, b]));
  assert.notEqual(managerDigest([a, b]), managerDigest([{ ...a, bytes: Buffer.from('3') }, b]));
  assert.notEqual(managerDigest([a]), managerDigest([{ ...a, name: 'c.js' }]));
});

test('the stable entry routes to the current router with argv, cwd and exit code', t => {
  const { paths, scratch, home } = fixture(t);
  installManager(makeDist(scratch, 'router'), { revision: 1, version: '0.3.0', source: 'release' }, paths);
  const cwd = fs.mkdtempSync(join(home, 'cwd-'));
  const run = runEntry(paths, ['use', 'preview', '--yes'], cwd);
  assert.equal(run.status, 0);
  assert.deepEqual({ label: run.json.label, argv: run.json.argv }, { label: 'router', argv: ['use', 'preview', '--yes'] });
  assert.equal(fs.realpathSync(run.json.cwd), fs.realpathSync(cwd));
  assert.equal(runEntry(paths, ['fail'], cwd).status, 3, 'the router exit code is propagated');
});

test('the entry falls back to the previous revision when the current one cannot load', t => {
  const { paths, scratch, home } = fixture(t);
  installManager(makeDist(scratch, 'first'), { revision: 1, version: '0.3.0', source: 'release' }, paths);
  const second = installManager(makeDist(scratch, 'second'), { revision: 2, version: '0.4.0', source: 'release' }, paths).current;
  assert.equal(runEntry(paths, ['versions'], home).json.label, 'second');
  fs.writeFileSync(join(paths.managerRoot, second.dir, 'dist', 'version-cli.js'), 'export const broken = ;\n');
  const run = runEntry(paths, ['versions'], home);
  assert.equal(run.status, 0);
  assert.equal(run.json.label, 'first');
});

test('with no loadable manager the entry delegates to the active package CLI and says why', t => {
  const { paths, scratch, home } = fixture(t);
  plantPackageCli(paths);
  writeLaunchers(paths); // writes the stable entry as well
  // Never installed: silent delegation, so setup from a package still works before bootstrap.
  let run = runEntry(paths, ['doctor'], home);
  assert.equal(run.json.label, 'active-cli');
  assert.equal(run.err, '');
  // Installed, then both revisions break: damaged-manager message, then the same delegation.
  const dist = makeDist(scratch, 'doomed');
  const current = installManager(dist, { revision: 1, version: '0.3.0', source: 'release' }, paths).current;
  fs.writeFileSync(join(paths.managerRoot, current.dir, 'dist', 'version-cli.js'), 'throw new Error("boom");\n');
  run = runEntry(paths, ['config', 'fail'], home);
  assert.equal(run.status, 5);
  assert.equal(run.json.label, 'active-cli');
  assert.deepEqual(run.json.argv, ['config', 'fail']);
  assert.match(run.err, /gestor de versiones está dañado/);
});

test('a corrupt current.json or an unsafe directory name never reaches an import', t => {
  const { paths, scratch, home } = fixture(t);
  plantPackageCli(paths);
  installManager(makeDist(scratch, 'safe'), { revision: 1, version: '0.3.0', source: 'release' }, paths);
  fs.writeFileSync(paths.managerCurrentPath, JSON.stringify({ dir: '../../evil', previous: null, revision: 1 }));
  assert.equal(readCurrent(paths), undefined);
  assert.equal(runEntry(paths, ['x'], home).json.label, 'active-cli');
  fs.writeFileSync(paths.managerCurrentPath, '{not json');
  assert.equal(readCurrent(paths), undefined);
  assert.equal(runEntry(paths, ['x'], home).json.label, 'active-cli');
});

test('without any active package the entry reports it and exits 1', t => {
  const { paths, home } = fixture(t);
  writeLaunchers(paths);
  const run = runEntry(paths, ['doctor'], home);
  assert.equal(run.status, 1);
  assert.match(run.err, /No hay una versión activa utilizable/);
});

test('the manager copy loads from a directory with no package and no side effects (probe contract)', t => {
  const { scratch, home } = fixture(t);
  const copy = fs.mkdtempSync(join(scratch, 'copy-'));
  fs.mkdirSync(join(copy, 'dist'));
  for (const name of ['version-manager.js', 'command-link.js', 'installation-paths.js', 'local-files.js', 'safe-paths.js']) fs.copyFileSync(join('dist', name), join(copy, 'dist', name));
  fs.writeFileSync(join(copy, 'package.json'), '{"private":true,"type":"module"}\n');
  const before = fs.readdirSync(home);
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', `import { MANAGER_REVISION } from ${JSON.stringify(new URL(`file:///${join(copy, 'dist', 'version-manager.js').replaceAll('\\', '/')}`).href)}; console.log(MANAGER_REVISION);`], { cwd: copy, encoding: 'utf8', timeout: 30000 });
  assert.equal(Number(out), MANAGER_REVISION);
  assert.deepEqual(fs.readdirSync(home), before, 'importing writes nothing');
});

test('old setup/update/link rewriting the launchers leaves the manager untouched and routing is restored (S18, S39)', t => {
  const { paths, scratch } = fixture(t);
  installManager(makeDist(scratch, 'm2'), { revision: 2, version: '0.4.0', source: 'release' }, paths);
  ensureRouting(paths);
  const managerBefore = treeDigest(paths.managerRoot);
  // What 0.2.0's writeLaunchers does: it rewrites only mdd/bin with its own text.
  const legacy = {
    [`${COMMAND}.cmd`]: ['@echo off', 'setlocal', 'node "%~dp0..\\node_modules\\my-driven-development\\dist\\cli.js" %*', ''].join('\r\n'),
    [COMMAND]: ['#!/bin/sh', 'set -e', 'exec node "$(dirname "$0")/../node_modules/my-driven-development/dist/cli.js" "$@"', ''].join('\n'),
  };
  for (const [name, text] of Object.entries(legacy)) fs.writeFileSync(join(paths.binRoot, name), text);
  assert.equal(treeDigest(paths.managerRoot), managerBefore, 'the old writer never touches the manager');
  const result = ensureRouting(paths);
  assert.equal(result.restored, true);
  assert.deepEqual(result.before, { [`${COMMAND}.cmd`]: 'legacy', [COMMAND]: 'legacy' });
  for (const file of launcherFiles()) assert.equal(fs.readFileSync(join(paths.binRoot, file.name), 'utf8'), file.content);
  assert.equal(treeDigest(paths.managerRoot), managerBefore, 'repair rewrites launchers only');
  assert.equal(ensureRouting(paths).restored, false, 'idempotent once routed');
  // Backwards switch: a package carrying revision 1 cannot downgrade the revision-2 manager.
  assert.equal(installManager(makeDist(scratch, 'm1'), { revision: 1, version: '0.2.5', source: 'release' }, paths).action, 'kept');
  assert.equal(readCurrent(paths).revision, 2);
  assert.equal(treeDigest(paths.managerRoot), managerBefore);
});

test('ensureRouting creates what is missing and reports absence', t => {
  const { paths } = fixture(t);
  const result = ensureRouting(paths);
  assert.deepEqual(result.before, { [`${COMMAND}.cmd`]: 'absent', [COMMAND]: 'absent' });
  assert.equal(result.entry, 'created');
  assert.equal(result.restored, true);
  assert.match(recoveryCommand(paths), new RegExp(`^node ".*entry\\.mjs" link$`));
});

test('the host launcher executes through the entry to the router (the other launcher form is checked as text only)', t => {
  const { paths, scratch, home } = fixture(t);
  installManager(makeDist(scratch, 'host'), { revision: 1, version: '0.3.0', source: 'release' }, paths);
  ensureRouting(paths);
  const windows = process.platform === 'win32';
  const launcher = join(paths.binRoot, windows ? `${COMMAND}.cmd` : COMMAND);
  const cwd = fs.mkdtempSync(join(home, 'host-'));
  const result = windows
    ? spawnSync('cmd', ['/d', '/c', launcher, 'versions', 'x y'], { encoding: 'utf8', cwd, timeout: 60000, windowsHide: true })
    : spawnSync(launcher, ['versions', 'x y'], { encoding: 'utf8', cwd, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(json.label, 'host');
  assert.deepEqual(json.argv, ['versions', 'x y']);
  const other = launcherFiles().find(file => file.name === (windows ? COMMAND : `${COMMAND}.cmd`));
  assert.match(other.content, /manager[\\/]entry\.mjs/);
});
