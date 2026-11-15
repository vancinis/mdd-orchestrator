import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAutoGit, publishRelease } from '../scripts/release-auto.mjs';
import { USAGE, main, packageJsonOf, parseArgs, runSmoke, validateOwnedRoot, validateTag } from '../scripts/release-smoke.mjs';
import { REPO_ROOT, gitIn, makeOrigin, readTarball, snapshotTree, tempDir } from './version-fixtures.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/release-smoke.mjs', import.meta.url));
const TIMEOUT = 600000;

/** Runs the real CLI in a child process; the child inherits the isolated test HOME (it must not write there). */
function smoke(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: TIMEOUT, windowsHide: true });
  return { code: result.status, out: result.stdout, err: result.stderr };
}
const args = (origin, tag, root) => ['--origin', origin, '--tag', tag, '--owned-root', root];
const sha = text => text.trim();

describe('argument and root validation (no I/O beyond the checks)', () => {
  test('the module is import-safe and exposes the maintained contract', () => {
    assert.equal(typeof main, 'function');
    assert.equal(typeof runSmoke, 'function');
    assert.match(USAGE, /--origin .* --tag .* --owned-root/);
  });

  test('parseArgs requires each argument exactly once and rejects anything else', () => {
    assert.deepEqual(parseArgs(['--origin', '/o', '--tag', 'v1.0.0', '--owned-root', '/r']), { origin: '/o', tag: 'v1.0.0', ownedRoot: '/r' });
    assert.deepEqual(parseArgs(['--origin=/o', '--tag=v1.0.0', '--owned-root=/r']), { origin: '/o', tag: 'v1.0.0', ownedRoot: '/r' });
    for (const bad of [
      [], ['--origin', '/o', '--tag', 'v1.0.0'], ['--origin', '/o', '--owned-root', '/r'], ['--tag', 'v1.0.0', '--owned-root', '/r'],
      ['--origin', '--tag', 'v1.0.0', '--owned-root', '/r'], ['--origin', '/o', '--tag', 'v1.0.0', '--owned-root'], ['--origin', '', '--tag', 'v1.0.0', '--owned-root', '/r'],
      ['--origin', '/o', '--origin', '/p', '--tag', 'v1.0.0', '--owned-root', '/r'], ['--origin', '/o', '--tag', 'v1.0.0', '--owned-root', '/r', '--force'], ['v1.0.0'],
    ]) assert.throws(() => parseArgs(bad), error => error.code === 2 && /Falta|no reconocido|repetido/.test(error.message), JSON.stringify(bad));
  });

  test('validateTag accepts only vX.Y.Z and vX.Y.Z-preview.N', () => {
    for (const good of ['v0.4.0', 'v10.20.30', 'v0.4.0-preview.1', 'v1.0.0-preview.0']) assert.equal(validateTag(good), good);
    for (const bad of ['0.4.0', 'v01.0.0', 'v1.0', 'v1.0.0-rc.1', 'v1.0.0-preview', 'v1.0.0-preview.01', 'v1.0.0+build', 'v1.0.0-preview.1-x', ' v1.0.0', 'v1.0.0\n', 'V1.0.0', '']) {
      assert.throws(() => validateTag(bad), error => error.code === 2, JSON.stringify(bad));
    }
  });

  test('validateOwnedRoot accepts new or empty roots inside the temp directory and RUNNER_TEMP', t => {
    const base = tempDir(t, 'mdd-smoke-root-');
    assert.equal(validateOwnedRoot(join(base, 'new', 'deeper')), join(base, 'new', 'deeper'));
    mkdirSync(join(base, 'empty'));
    assert.equal(validateOwnedRoot(join(base, 'empty')), join(base, 'empty'));
    const runner = tempDir(t, 'mdd-smoke-runner-');
    const elsewhere = join(REPO_ROOT, '.mdd-smoke-never');
    assert.equal(validateOwnedRoot(join(runner, 'x'), { RUNNER_TEMP: runner }), join(runner, 'x'));
    assert.throws(() => validateOwnedRoot(elsewhere, { RUNNER_TEMP: runner }), error => error.code === 2);
    assert.equal(existsSync(elsewhere), false);
  });

  test('validateOwnedRoot refuses unsafe roots and writes nothing', t => {
    const base = tempDir(t, 'mdd-smoke-root-');
    const outside = join(REPO_ROOT, '.mdd-smoke-never');
    const refused = (value, pattern, env) => assert.throws(() => validateOwnedRoot(value, env), error => error.code === 2 && pattern.test(error.message), String(value));
    refused(outside, /fuera del directorio temporal/);
    refused(tmpdir(), /fuera del directorio temporal/);
    refused(join(tmpdir(), '..'), /fuera del directorio temporal/);
    refused(join(base, '..', '..', 'escape'), /fuera del directorio temporal/);
    refused('relative/root', /absoluta/);
    refused('', /no es válida/);
    refused(`${join(base, 'x')}\u0000y`, /no es válida/);
    refused(undefined, /no es válida/);
    assert.equal(existsSync(outside), false);
    // A symlink (junction on Windows) anywhere below the approved root is refused, even when it leads inside temp.
    const real = join(base, 'real');
    mkdirSync(real);
    symlinkSync(real, join(base, 'link'), 'junction');
    refused(join(base, 'link'), /enlace simbólico/);
    refused(join(base, 'link', 'child'), /enlace simbólico/);
    assert.deepEqual(readdirSync(real), []);
    // A foreign file or a reused root is refused.
    writeFileSync(join(base, 'file'), 'x');
    refused(join(base, 'file'), /no es un directorio|ya tiene contenido/);
    refused(join(base, 'file', 'child'), /no es un directorio/);
    mkdirSync(join(base, 'used', 'versions'), { recursive: true });
    refused(join(base, 'used'), /ya tiene contenido/);
  });

  test('main reports usage (2) without touching the file system', async () => {
    const lines = { out: [], err: [] };
    const io = { out: line => lines.out.push(line), err: line => lines.err.push(line) };
    assert.equal(await main([], io), 2);
    assert.equal(await main(['--origin', '/o', '--tag', 'v1.0', '--owned-root', join(tmpdir(), 'mdd-smoke-never-created')], io), 2);
    assert.equal(await main(['--origin', '/o', '--tag', 'v1.0.0', '--owned-root', join(REPO_ROOT, '.mdd-smoke-never')], io), 2);
    assert.equal(existsSync(join(tmpdir(), 'mdd-smoke-never-created')), false);
    assert.equal(existsSync(join(REPO_ROOT, '.mdd-smoke-never')), false);
    assert.equal(lines.out.length, 0);
    assert.ok(lines.err.every(line => /^Error: /.test(line) && line.includes(USAGE)));
  });
});

describe('real manager preparation of published tags', { timeout: TIMEOUT }, () => {
  const cleanups = [];
  const world = {};

  /** A local bare origin with baseline v0.3.2, then stable v0.4.0 and preview v0.4.0-preview.1 published by the T2 engine. */
  before(async () => {
    const t = { after: fn => cleanups.push(fn) };
    const origin = makeOrigin(t, [{ version: '0.3.2' }]);
    writeFileSync(join(origin.work, 'feature.txt'), 'feature\n');
    gitIn(origin.work, 'add', '-A');
    gitIn(origin.work, 'commit', '--quiet', '-m', 'feat: add a small feature');
    gitIn(origin.work, 'push', '--quiet', 'origin', 'main');
    const source = gitIn(origin.work, 'rev-parse', 'HEAD');
    const git = createAutoGit(origin.work);
    const preview = await publishRelease(git, { source, channel: 'preview', date: '2026-11-13' });
    const stable = await publishRelease(git, { source, channel: 'stable', date: '2026-11-13' });
    Object.assign(world, { origin, source, preview, stable });
  });
  after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

  test('engine fixtures publish the expected tags', () => {
    assert.equal(world.preview.tag, 'v0.4.0-preview.1');
    assert.equal(world.stable.tag, 'v0.4.0');
    assert.deepEqual(gitIn(world.origin.url, 'tag', '--list').split('\n').sort(), ['v0.3.2', 'v0.4.0', 'v0.4.0-preview.1']);
  });

  for (const key of ['stable', 'preview']) {
    test(`the manager discovers, resolves and packs the ${key} tag built by the engine, writing only the owned root`, t => {
      const tag = world[key].tag;
      const dir = tempDir(t, 'mdd-smoke-run-');
      const root = join(dir, 'owned');
      const home = process.env.HOME;
      const homeBefore = snapshotTree(home);
      const refsBefore = gitIn(world.origin.url, 'for-each-ref');
      const workBefore = gitIn(world.origin.work, 'status', '--porcelain=v1', '--untracked-files=all');

      const result = smoke(args(world.origin.url, tag, root));
      assert.equal(result.code, 0, `${result.out}\n${result.err}`);
      assert.match(result.out, new RegExp(`Verificando ${tag.replaceAll('.', '\\.')} \\(${key}\\)`));
      assert.match(result.out, /descubrimiento: elegible/);
      assert.match(result.out, new RegExp(`alias ${key}: ${tag.slice(1).replaceAll('.', '\\.')}`));
      assert.match(result.out, /Humo correcto/);

      // The package was really built and packed from the tagged commit: metadata commit, version, build marker.
      const version = tag.slice(1);
      const cache = join(root, 'versions', 'cache', version);
      const files = readTarball(join(cache, `my-driven-development-${version}.tgz`));
      assert.equal(JSON.parse(files.get('package.json')).version, version);
      assert.equal(JSON.parse(files.get('dist/built.json')).version, version);
      // The engine's metadata commit (3 files, CHANGELOG section) is what the manager accepted.
      assert.match(gitIn(world.origin.url, 'show', `${tag}^{commit}:CHANGELOG.md`), new RegExp(`## \\[${version.replaceAll('.', '\\.')}\\]`));
      assert.equal(gitIn(world.origin.url, 'rev-parse', `${tag}^{commit}^`), world.source);
      assert.equal(packageJsonOf(join(cache, `my-driven-development-${version}.tgz`)).version, version);
      const entry = JSON.parse(readFileSync(join(cache, 'entry.json'), 'utf8'));
      assert.equal(entry.commit, sha(gitIn(world.origin.url, 'rev-parse', `${tag}^{commit}`)));

      // Footprint: the manager's own layout and the isolated HOME only; no state, journal, lock, launcher or activation.
      assert.deepEqual(readdirSync(root).sort(), ['home', 'versions']);
      for (const name of ['state.json', 'journal.json', 'lock.json']) assert.equal(existsSync(join(root, 'versions', name)), false, name);
      assert.deepEqual(readdirSync(join(root, 'versions')).sort(), ['build', 'cache', 'no-hooks', 'repo.git']);
      assert.deepEqual(readdirSync(join(root, 'versions', 'build')), []);
      assert.deepEqual(snapshotTree(home), homeBefore, 'the test HOME must not change: HOME is isolated inside the owned root');
      assert.equal(existsSync(join(root, 'home', 'npm-cache')), true);
      assert.equal(gitIn(world.origin.url, 'for-each-ref'), refsBefore);
      assert.equal(gitIn(world.origin.work, 'status', '--porcelain=v1', '--untracked-files=all'), workBefore);

      // A used root is refused instead of being reused.
      const again = smoke(args(world.origin.url, tag, root));
      assert.equal(again.code, 2);
      assert.match(again.err, /ya tiene contenido/);
    });
  }

  // One reconcile may publish a batch before the smoke runs: the alias is then newer than the requested tag.
  const batch = [
    ['stable', 'v0.3.2', '0.3.4', [{ version: '0.3.2' }, { version: '0.3.3' }, { version: '0.3.4' }]],
    ['preview', 'v0.4.0-preview.1', '0.4.0-preview.3', [{ version: '0.3.2' }, { version: '0.4.0-preview.1' }, { version: '0.4.0-preview.2' }, { version: '0.4.0-preview.3' }]],
  ];
  for (const [channel, tag, aliasVersion, specs] of batch) {
    test(`an earlier ${channel} tag is built and packed exactly while a newer ${channel} alias exists`, t => {
      const origin = makeOrigin(t, specs);
      const root = join(tempDir(t, 'mdd-smoke-run-'), 'owned');
      const result = smoke(args(origin.url, tag, root));
      assert.equal(result.code, 0, `${result.out}\n${result.err}`);
      const version = tag.slice(1);
      assert.match(result.out, new RegExp(`Verificando ${tag.replaceAll('.', '\\.')} \\(${channel}\\)`));
      assert.match(result.out, new RegExp(`alias ${channel}: ${aliasVersion.replaceAll('.', '\\.')}`));
      assert.match(result.out, new RegExp(`paquete: my-driven-development@${version.replaceAll('.', '\\.')} `));
      // The requested exact tag (not the alias) was really prepared and packed.
      const cache = join(root, 'versions', 'cache');
      assert.deepEqual(readdirSync(cache), [version]);
      const tarball = join(cache, version, `my-driven-development-${version}.tgz`);
      assert.equal(packageJsonOf(tarball).version, version);
      assert.equal(JSON.parse(readTarball(tarball).get('dist/built.json')).version, version);
      const entry = JSON.parse(readFileSync(join(cache, version, 'entry.json'), 'utf8'));
      assert.equal(entry.commit, sha(gitIn(origin.url, 'rev-parse', `${tag}^{commit}`)));
      assert.equal(existsSync(join(root, 'versions', 'lock.json')), false);
    });
  }

  test('invalid exact tag, missing tag and an unusable alias channel are still rejected', t => {
    const origin = makeOrigin(t, [{ version: '0.3.2' }, { version: '0.3.3' }]);
    const root = join(tempDir(t, 'mdd-smoke-run-'), 'owned');
    // A preview request with no eligible preview alias must fail without preparing anything.
    const result = smoke(args(origin.url, 'v0.3.3-preview.1', root));
    assert.equal(result.code, 1);
    assert.deepEqual(readdirSync(join(root, 'versions', 'cache')), []);
    assert.equal(existsSync(join(root, 'versions', 'lock.json')), false, 'the lock is released on failure');
  });

  test('invalid package version, missing tag and unreachable origin fail closed and release the lock', t => {
    const origin = makeOrigin(t, [{ version: '0.3.2' }, { version: '0.4.0', packageVersion: '0.4.1' }]);
    const run = (originUrl, tag) => {
      const root = join(tempDir(t, 'mdd-smoke-run-'), 'owned');
      const result = smoke(args(originUrl, tag, root));
      assert.equal(existsSync(join(root, 'versions', 'lock.json')), false, 'the lock is released on failure');
      if (existsSync(join(root, 'versions', 'cache'))) assert.deepEqual(readdirSync(join(root, 'versions', 'cache')), []);
      return result;
    };
    const mismatch = run(origin.url, 'v0.4.0');
    assert.equal(mismatch.code, 1);
    assert.match(mismatch.err, /no es seleccionable: package\.json declara 0\.4\.1, no 0\.4\.0/);
    const missing = run(origin.url, 'v0.9.0');
    assert.equal(missing.code, 1);
    assert.match(missing.err, /no existe en el origen/);
    const unreachable = run(join(tempDir(t, 'mdd-smoke-gone-'), 'nope.git'), 'v0.3.2');
    assert.equal(unreachable.code, 1);
    assert.match(unreachable.err, /No se pudo consultar el origen/);
    const malformed = run(origin.url, 'v1.0');
    assert.equal(malformed.code, 2);
  });

  test('an unusable root is refused by the CLI before any write', t => {
    const outside = join(REPO_ROOT, '.mdd-smoke-never');
    const result = smoke(args(world.origin.url, 'v0.4.0', outside));
    assert.equal(result.code, 2);
    assert.match(result.err, /fuera del directorio temporal/);
    assert.equal(existsSync(outside), false);
    const base = tempDir(t, 'mdd-smoke-link-');
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'), 'junction');
    const linked = smoke(args(world.origin.url, 'v0.4.0', join(base, 'link', 'owned')));
    assert.equal(linked.code, 2);
    assert.deepEqual(readdirSync(join(base, 'real')), []);
  });
});
