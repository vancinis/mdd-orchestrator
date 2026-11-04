import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { recordReleases, readState } from '../dist/version-store.js';
import {
  DEV_NOTES, DOCTOR_TIMEOUT_MS, FETCH_TIMEOUT_MS, SourceError, discover, ensureClone, fetchTags, firstSeen, listCache, notesFor, npmCli, observedTags, prepareDev,
  prepareRelease, pruneCache, readCache, resolveAlias, resolveExact, showAt, validateOrigin,
} from '../dist/version-source.js';
import { BASELINE } from '../dist/versions.js';
import { gitIn, makeCheckout, makeOrigin, ownedFixture, readTarball, snapshotTree, stateFor, tempDir } from './version-fixtures.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
const byVersion = (list, version) => list.find(item => item.version === version);
const throwsSource = (work, code) => assert.throws(work, error => error instanceof SourceError && error.code === code, `expected SourceError ${code}`);
const eligible = (version, commit = 'ab'.repeat(20)) => ({ tag: `v${version}`, version, commit, status: 'eligible' });

/** Real npm for ci/build; the wrapper may replace individual commands. */
function realNpm(args, cwd, timeout) {
  return execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}
const npmWith = override => (args, cwd, timeout) => override(args, cwd, timeout) ?? realNpm(args, cwd, timeout);

/** Writes a complete cache entry by hand (fast retention fixtures). */
function putCache(paths, version, { commit = 'cd'.repeat(20), mtime, bytes = Buffer.from(`tgz ${version}`) } = {}) {
  const dir = join(paths.cacheRoot, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `my-driven-development-${version}.tgz`), bytes);
  writeFileSync(join(dir, 'entry.json'), JSON.stringify({ schema: 1, version, commit, sha256: sha(bytes), size: bytes.length, builtAt: '2026-11-03T00:00:00.000Z', node: '26.0.0' }));
  if (mtime) for (const name of readdirSync(dir)) utimesSync(join(dir, name), mtime, mtime);
  if (mtime) utimesSync(dir, mtime, mtime);
}

test('validateOrigin accepts the supported forms and rejects options and control characters', () => {
  for (const good of ['https://github.com/o/r.git', 'ssh://git@host/o/r.git', 'git@github.com:o/r.git', 'file:///tmp/r.git', process.platform === 'win32' ? 'C:\\repos\\r.git' : '/repos/r.git']) {
    assert.equal(validateOrigin(good), good);
  }
  for (const bad of ['', '--upload-pack=evil', '-c', 'http://insecure/r.git', 'relative/path', 'https://h/r\n.git', 'ftp://h/r', null, 7]) {
    throwsSource(() => validateOrigin(bad), 'origin');
  }
});

test('S15 owned clone: discovery and the build come from the tag, independent of the origin working clone and the cwd', async t => {
  const origin = makeOrigin(t, [
    { version: '0.2.0', marker: 'old' },
    { version: '0.3.0', marker: 'tag-content', changelog: '## [0.3.0] - 2026-11-03\n\nNotas.\n' },
  ]);
  origin.commitOnMain({ version: '0.9.9', marker: 'LATEST-MAIN' });
  const { ownedRoot, paths, lock } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] });

  const found = discover(paths, state);
  assert.equal(found.stale, false);
  assert.ok(found.fetchedAt instanceof Date);
  assert.deepEqual(found.tags.map(tag => `${tag.version}:${tag.status}`).sort(), ['0.2.0:eligible', '0.3.0:eligible']);
  assert.ok(existsSync(join(ownedRoot, 'versions', 'repo.git', 'HEAD')));

  // The original checkout is gone and the process runs somewhere unrelated.
  rmSync(origin.work, { recursive: true, force: true });
  const cwd = process.cwd();
  process.chdir(tmpdir());
  t.after(() => process.chdir(cwd));

  const resolved = resolveExact(found, state, 'v0.3.0');
  assert.ok(resolved.ok);
  const prepared = prepareRelease(lock, resolved.tag);
  assert.equal(prepared.cached, false);
  assert.deepEqual(prepared.identity, { kind: 'release', version: '0.3.0', commit: origin.commits['0.3.0'] });
  const files = readTarball(prepared.tarball);
  assert.deepEqual(JSON.parse(files.get('dist/built.json').toString()), { version: '0.3.0', marker: 'tag-content' });
  assert.ok(files.has('assets/opencode/agents/mdd-fixture.md'));
  assert.ok(!files.get('dist/built.json').toString().includes('LATEST-MAIN'));

  // Stored artifact: entry.json is complete and the temporary worktree is gone.
  const entry = readCache(paths, '0.3.0');
  assert.equal(entry.status, 'valid');
  assert.equal(entry.entry.commit, origin.commits['0.3.0']);
  assert.equal(entry.entry.sha256, prepared.sha256);
  assert.deepEqual(readdirSync(paths.buildRoot), []);
  assert.doesNotMatch(gitIn(paths.repoPath, 'worktree', 'list'), /build/);

  // A second preparation reuses the verified cache entry.
  assert.equal(prepareRelease(lock, resolved.tag).cached, true);
  // The origin working clone is the only source that has the later main; the notes come from the tag.
  assert.match(notesFor(paths, found, '0.3.0').text, /Notas\./);
});

test('git ignores repository-selecting environment variables of the caller', t => {
  const origin = makeOrigin(t, [{ version: '0.3.0' }]);
  const { paths } = ownedFixture(t);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(tempDir(t), 'nonexistent.git');
  process.env.GIT_WORK_TREE = tempDir(t);
  t.after(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const found = discover(paths, stateFor(origin.url));
  assert.equal(found.stale, false);
  assert.equal(found.tags.length, 1);
});

test('S36 offline: stale data is disclosed; aliases refuse; recorded exact versions proceed; unrecorded ones do not', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0' }, { version: '0.4.0-preview.1' }]);
  const { paths } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.3.0': origin.commits['0.3.0'], '0.2.0': origin.commits['0.2.0'] });
  const fresh = discover(paths, state);
  assert.equal(fresh.stale, false);
  assert.ok(resolveAlias(fresh, 'stable').ok);

  origin.remove();
  const stale = discover(paths, state);
  assert.equal(stale.stale, true);
  assert.ok(stale.error);
  assert.ok(stale.fetchedAt instanceof Date, 'the last successful fetch time is still reported');
  assert.equal(stale.tags.length, 3, 'last observed refs are used');

  for (const channel of ['stable', 'preview']) {
    const refused = resolveAlias(stale, channel);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'stale');
    assert.doesNotMatch(refused.message, /no hay versiones nuevas/i);
  }
  const exact = resolveExact(stale, state, '0.3.0');
  assert.ok(exact.ok);
  assert.equal(exact.stale, true);
  const unrecorded = resolveExact(stale, state, '0.4.0-preview.1');
  assert.equal(unrecorded.ok, false);
  assert.equal(unrecorded.code, 'unrecorded');
  // Reading without fetching is also stale and never claims freshness.
  assert.equal(discover(paths, state, { fetch: false }).stale, true);
});

test('S16 moved tag with a recorded commit: conflict, refused (exact and alias, no fallback), cleared when restored', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.2.5' }, { version: '0.3.0' }]);
  const { paths, lock } = ownedFixture(t);
  const original = origin.commits['0.3.0'];
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'], '0.2.5': origin.commits['0.2.5'], '0.3.0': original });
  const before = JSON.stringify(state);

  const moved = origin.moveTag('0.3.0');
  const found = discover(paths, state);
  const tag = byVersion(found.tags, '0.3.0');
  assert.equal(tag.status, 'conflict');
  assert.match(tag.reason, new RegExp(original.slice(0, 7)));
  const exact = resolveExact(found, state, '0.3.0');
  assert.equal(exact.ok, false);
  assert.equal(exact.code, 'refused');
  const alias = resolveAlias(found, 'stable');
  assert.equal(alias.ok, false, 'the next stable (0.2.5) is not substituted');
  assert.equal(alias.code, 'refused');
  throwsSource(() => prepareRelease(lock, tag), 'conflict');
  assert.equal(JSON.stringify(state), before, 'recorded identity is never replaced');
  assert.notEqual(moved, original);

  origin.retag('0.3.0', original);
  assert.equal(byVersion(discover(paths, state).tags, '0.3.0').status, 'eligible');
});

test('S16 moved tag known only through the cache is a conflict; the pre-recorded baseline is protected from day one', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0' }]);
  const { paths, lock } = ownedFixture(t);
  const empty = stateFor(origin.url);

  // Baseline: the fixture's v0.2.0 is not the real baseline commit, so with an empty state it is a conflict.
  const baseline = byVersion(discover(paths, empty).tags, '0.2.0');
  assert.equal(baseline.status, 'conflict');
  assert.match(baseline.reason, new RegExp(BASELINE.commit.slice(0, 7)));

  // Cache only (nothing recorded in state): build, move the tag, refresh.
  const built = prepareRelease(lock, byVersion(discover(paths, empty).tags, '0.3.0'));
  assert.equal(built.cached, false);
  origin.moveTag('0.3.0');
  const found = discover(paths, empty);
  const tag = byVersion(found.tags, '0.3.0');
  assert.equal(tag.status, 'conflict');
  assert.equal(resolveExact(found, empty, '0.3.0').ok, false);
  assert.equal(readCache(paths, '0.3.0').status, 'valid', 'the cache entry itself is untouched');
});

test('missing-remote: a recorded version that disappeared after a successful fetch is not selectable', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0' }, { version: '0.4.0' }]);
  const { paths } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'], '0.3.0': origin.commits['0.3.0'], '0.4.0': origin.commits['0.4.0'] });
  origin.deleteTag('0.4.0');
  const found = discover(paths, state);
  assert.equal(byVersion(found.tags, '0.4.0').status, 'missing-remote');
  assert.equal(resolveExact(found, state, '0.4.0').ok, false);
  const alias = resolveAlias(found, 'stable');
  assert.ok(alias.ok);
  assert.equal(alias.tag.version, '0.3.0');
});

test('S38/S14 classification: package mismatch, foreign package, unsupported tags and numeric preview ordering', t => {
  const origin = makeOrigin(t, [
    { version: '0.2.0' },
    { version: '0.4.0', packageVersion: '0.3.9' },
    { version: '0.5.0', name: 'something-else' },
    { version: '0.1.0' },
    { version: '0.3.0-rc.1', tag: 'v0.3.0-rc.1' },
    { version: '0.6.0', tag: 'v0.06.0', lightweight: true },
    { version: '0.7.0-preview.9' },
    { version: '0.7.0-preview.10' },
    { version: '0.7.0-preview.2', lightweight: true },
  ]);
  const { paths, lock } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] });
  const found = discover(paths, state);

  const mismatch = byVersion(found.tags, '0.4.0');
  assert.equal(mismatch.status, 'invalid-identity');
  assert.match(mismatch.reason, /0\.3\.9/);
  assert.equal(byVersion(found.tags, '0.5.0').status, 'invalid-identity');
  assert.equal(resolveExact(found, state, '0.4.0').ok, false);
  throwsSource(() => prepareRelease(lock, mismatch), 'identity');
  assert.deepEqual(readdirSync(paths.cacheRoot), [], 'nothing was cached');

  const unsupported = found.tags.filter(tag => tag.status === 'unsupported').map(tag => tag.tag).sort();
  assert.deepEqual(unsupported, ['v0.06.0', 'v0.1.0', 'v0.3.0-rc.1']);
  assert.equal(resolveExact(found, state, '0.1.0').code, 'unsupported');
  assert.equal(resolveExact(found, state, 'main').code, 'unsupported');

  // Preview ordering is numeric (.10 above .9 above .2); the stable alias only sees stable tags.
  const preview = resolveAlias(found, 'preview');
  assert.ok(preview.ok);
  assert.equal(preview.tag.version, '0.7.0-preview.10');
  const stable = resolveAlias(found, 'stable');
  assert.equal(stable.ok, false, 'the newest stable 0.5.0 has a foreign package: refused, 0.2.0 is not substituted');
  assert.equal(stable.code, 'refused');
  assert.equal(resolveExact(found, state, 'v0.7.0-preview.2').ok, true, 'lightweight tags are supported');
});

test('empty channels are refused without falling back to the other channel', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0' }]);
  const { paths } = ownedFixture(t);
  const found = discover(paths, stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] }));
  const refused = resolveAlias(found, 'preview');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'empty');
  assert.match(refused.message, /No hay versiones preview publicadas en el origen/);
  assert.equal(resolveExact(found, stateFor(origin.url), '9.9.9').code, 'missing');
});

test('first-seen tags are recorded only through the store, and a recorded commit is never rewritten', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0' }]);
  const { paths, lock } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] });
  const found = discover(paths, state);
  const fresh = firstSeen(found, state);
  assert.deepEqual(fresh, [{ version: '0.3.0', commit: origin.commits['0.3.0'] }]);
  assert.ok(recordReleases(lock, fresh, new Date('2026-11-03T00:00:00Z')));
  const stored = readState(paths);
  assert.equal(stored.releases['0.3.0'].commit, origin.commits['0.3.0']);
  assert.deepEqual(firstSeen(found, { ...state, releases: { ...state.releases, ...stored.releases } }), []);
});

test('notes: the tag CHANGELOG first, then the newest tag, otherwise an explicit absence; dev has its own text', t => {
  const origin = makeOrigin(t, [
    { version: '0.2.0' },
    { version: '0.3.0', changelog: '## [0.3.0] - 2026-11-03\n\nCambios 0.3.0\n\n## [0.2.0] - 2026-10-30\n\nHistórica.\n' },
    { version: '0.4.0', changelog: '## [0.4.0] - 2026-11-10\n\nSolo 0.4.0\n' },
  ]);
  const { paths } = ownedFixture(t);
  const found = discover(paths, stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] }));
  const own = notesFor(paths, found, '0.4.0');
  assert.deepEqual([own.found, /Solo 0\.4\.0/.test(own.text)], [true, true]);
  const fallback = notesFor(paths, found, '0.2.0');
  assert.equal(fallback.found, true, 'the 0.2.0 tag has no CHANGELOG; the newest tag that has the section answers');
  assert.match(fallback.text, /Histórica/);
  const none = notesFor(paths, found, '0.3.5');
  assert.deepEqual([none.found, /Sin notas de versión para 0\.3\.5 \(versión histórica sin CHANGELOG\)\./.test(none.text)], [false, true]);
  assert.match(DEV_NOTES, /dev: sin notas de versión/);
  assert.equal(showAt(paths, found.tags[0].commit, '../package.json'), undefined, 'unsafe paths are not read');
  assert.equal(showAt(paths, 'not-a-commit', 'package.json'), undefined);
});

test('S17 stage-specific failures name the stage, leave no reusable cache entry and clean the worktree', async t => {
  const origin = makeOrigin(t, [
    { version: '0.2.0' },
    { version: '0.3.0', engines: '<20' },
    { version: '0.3.1', brokenLock: true },
    { version: '0.3.2', brokenBuild: true },
    { version: '0.3.3' },
    { version: '0.3.4' },
  ]);
  const { paths, lock } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] });
  const found = discover(paths, state);
  const tagOf = version => byVersion(found.tags, version);
  const failing = (version, code, stage, deps = {}) => {
    assert.throws(() => prepareRelease(lock, tagOf(version), deps), error => {
      assert.ok(error instanceof SourceError, String(error));
      assert.equal(error.code, code);
      assert.equal(error.stage, stage);
      assert.match(error.message, new RegExp(`Falló la preparación de ${version.replace(/\./g, '\\.')} en la etapa «${stage}»`));
      assert.match(error.message, /No se cambió la instalación activa\./);
      return true;
    });
    assert.notEqual(readCache(paths, version).status, 'valid');
    assert.ok(!existsSync(join(paths.cacheRoot, version, 'entry.json')), `${version}: no entry.json`);
    assert.deepEqual(readdirSync(paths.buildRoot), [], `${version}: temporary worktree removed`);
  };

  failing('0.3.0', 'prerequisites', 'requisitos');
  failing('0.3.1', 'dependencies', 'dependencias');
  failing('0.3.2', 'build', 'compilación');
  failing('0.3.3', 'pack', 'empaquetado', { npm: npmWith(args => { if (args[0] === 'pack') throw Object.assign(new Error('pack failed'), { stderr: 'ENOSPC injected' }); }) });
  failing('0.3.4', 'store', 'almacenamiento', { now: () => { throw new Error('disk full'); } });

  // Fetch: the commit is not in the clone and the origin is unreachable.
  origin.remove();
  throwsSource(() => prepareRelease(lock, eligible('9.9.9')), 'fetch');
  assert.deepEqual(readdirSync(paths.buildRoot), []);
});

test('S17 prerequisites: an unparseable engines range warns and a missing npm CLI is a prerequisite failure', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0', engines: '>=1 || weird' }, { version: '0.3.1' }]);
  const { paths, lock } = ownedFixture(t);
  const found = discover(paths, stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] }));
  const prepared = prepareRelease(lock, byVersion(found.tags, '0.3.0'));
  assert.equal(prepared.warnings.length, 1);
  assert.match(prepared.warnings[0], /engines\.node/);
  const saved = process.env.npm_execpath;
  t.after(() => { if (saved === undefined) delete process.env.npm_execpath; else process.env.npm_execpath = saved; });
  // With the real runner and no npm_execpath the beside-Node layout is used; deleting the variable must still resolve here.
  delete process.env.npm_execpath;
  const resolved = npmCli();
  assert.ok(resolved === undefined || existsSync(resolved));
});

test('S40 corrupt or partial cache entries are detected, rebuilt from the tag, and never reused when the rebuild fails', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0', marker: 'good' }]);
  const { paths, lock } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] });
  const tag = byVersion(discover(paths, state).tags, '0.3.0');
  const first = prepareRelease(lock, tag);
  assert.equal(first.cached, false);

  // Damaged tarball.
  writeFileSync(first.tarball, Buffer.from('corrupted'));
  const damaged = readCache(paths, '0.3.0');
  assert.equal(damaged.status, 'corrupt');
  assert.match(damaged.reason, /sha256/);
  const second = prepareRelease(lock, tag);
  assert.equal(second.cached, false, 'rebuilt, not reused');
  assert.equal(readCache(paths, '0.3.0').status, 'valid');
  assert.equal(JSON.parse(readTarball(second.tarball).get('dist/built.json').toString()).marker, 'good');

  // Missing entry.json with a stray tarball.
  rmSync(join(paths.cacheRoot, '0.3.0', 'entry.json'));
  assert.equal(readCache(paths, '0.3.0').status, 'corrupt');
  assert.equal(prepareRelease(lock, tag).cached, false);
  assert.equal(readCache(paths, '0.3.0').status, 'valid');

  // Corrupt and the rebuild fails: the entry is gone, nothing reusable remains.
  writeFileSync(join(paths.cacheRoot, '0.3.0', 'my-driven-development-0.3.0.tgz'), 'x');
  throwsSource(() => prepareRelease(lock, tag, { npm: () => { throw new Error('registry unreachable'); } }), 'dependencies');
  assert.equal(readCache(paths, '0.3.0').status, 'absent');
});

test('S26 an evicted exact preview is rebuilt from the same tag; with dependencies unavailable it fails and nothing else is chosen', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.4.0-preview.1', marker: 'p1' }, { version: '0.4.0-preview.2', marker: 'p2' }]);
  const { paths, lock } = ownedFixture(t);
  const state = stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] });
  const found = discover(paths, state);
  const tag = byVersion(found.tags, '0.4.0-preview.1');
  const first = prepareRelease(lock, tag);

  rmSync(join(paths.cacheRoot, '0.4.0-preview.1'), { recursive: true, force: true });
  assert.ok(resolveExact(found, state, '0.4.0-preview.1').ok, 'still listed from the tag');
  const rebuilt = prepareRelease(lock, tag);
  assert.equal(rebuilt.cached, false);
  assert.deepEqual(rebuilt.identity, first.identity);
  assert.equal(JSON.parse(readTarball(rebuilt.tarball).get('dist/built.json').toString()).marker, 'p1');
  assert.deepEqual(readTarball(rebuilt.tarball).get('assets/opencode/agents/mdd-fixture.md'), readTarball(first.tarball).get('assets/opencode/agents/mdd-fixture.md'));

  rmSync(join(paths.cacheRoot, '0.4.0-preview.1'), { recursive: true, force: true });
  assert.throws(() => prepareRelease(lock, tag, { npm: npmWith(args => { if (args[0] === 'ci') throw Object.assign(new Error('ci'), { stderr: 'ENOTFOUND registry' }); }) }), error => error instanceof SourceError && error.code === 'dependencies' && /ENOTFOUND/.test(error.message));
  assert.equal(readCache(paths, '0.4.0-preview.1').status, 'absent');
  assert.equal(readCache(paths, '0.4.0-preview.2').status, 'absent', 'no other preview was built as a substitute');
});

test('S25 cache retention: all stable, the three highest previews by SemVer and the active one; mtimes are ignored', t => {
  const { paths, lock } = ownedFixture(t);
  const old = new Date('2020-01-01T00:00:00Z');
  const recent = new Date('2026-11-01T00:00:00Z');
  // Misleading mtimes: the lowest previews are the newest on disk.
  putCache(paths, '0.2.0', { mtime: recent });
  putCache(paths, '0.3.0', { mtime: old });
  putCache(paths, '0.4.0-preview.1', { mtime: recent });
  putCache(paths, '0.4.0-preview.2', { mtime: recent });
  putCache(paths, '0.4.0-preview.3', { mtime: old });
  putCache(paths, '0.4.0-preview.9', { mtime: old });
  putCache(paths, '0.4.0-preview.10', { mtime: old });
  const active = { kind: 'release', version: '0.4.0-preview.1', commit: 'cd'.repeat(20) };

  const first = pruneCache(lock, { active });
  assert.deepEqual(first.removed, ['0.4.0-preview.2']);
  assert.deepEqual(listCache(paths).map(entry => entry.version), ['0.4.0-preview.10', '0.4.0-preview.9', '0.4.0-preview.3', '0.4.0-preview.1', '0.3.0', '0.2.0']);
  assert.ok(listCache(paths).every(entry => entry.state.status === 'valid'));

  // After switching away, the older preview is evicted; stable entries stay.
  const second = pruneCache(lock, { active: { kind: 'release', version: '0.3.0', commit: 'cd'.repeat(20) } });
  assert.deepEqual(second.removed, ['0.4.0-preview.1']);
  assert.deepEqual(listCache(paths).map(entry => entry.version), ['0.4.0-preview.10', '0.4.0-preview.9', '0.4.0-preview.3', '0.3.0', '0.2.0']);
});

test('cache retention: incomplete and corrupt entries go unless a journal protects them; dev and unknown names are left alone', t => {
  const { paths, lock } = ownedFixture(t);
  putCache(paths, '0.3.0');
  putCache(paths, '0.3.1');
  writeFileSync(join(paths.cacheRoot, '0.3.1', 'my-driven-development-0.3.1.tgz'), 'tampered');
  mkdirSync(join(paths.cacheRoot, '0.4.0-preview.1'), { recursive: true });
  writeFileSync(join(paths.cacheRoot, '0.4.0-preview.1', 'my-driven-development-0.4.0-preview.1.tgz'), 'partial');
  putCache(paths, '0.4.0-preview.2');
  mkdirSync(join(paths.cacheRoot, 'not-a-version'));
  assert.equal(readCache(paths, '0.3.1').status, 'corrupt');

  const result = pruneCache(lock, { protect: ['0.3.1'], active: { kind: 'dev', version: '0.3.9', commit: 'ab'.repeat(20) } });
  assert.deepEqual(result.removed, ['0.4.0-preview.1']);
  assert.ok(existsSync(join(paths.cacheRoot, '0.3.1')), 'a corrupt entry referenced by a journal survives');
  assert.ok(existsSync(join(paths.cacheRoot, 'not-a-version')));
  assert.deepEqual(pruneCache(lock).removed, ['0.3.1']);
});

test('prepare operations require the held lock', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0' }]);
  const { paths, lock } = ownedFixture(t);
  const found = discover(paths, stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] }));
  const tag = byVersion(found.tags, '0.3.0');
  lock.release();
  assert.throws(() => prepareRelease(lock, tag), error => error.code === 'lock-lost');
  assert.throws(() => pruneCache(lock), error => error.code === 'lock-lost');
});

test('S29 dev: identity with dirty flag, checkout tags untouched, in-place build packed into the caller directory', t => {
  const checkout = makeCheckout(t, { version: '0.3.0', marker: 'dev-marker', engines: '>=1' });
  const { ownedRoot, lock } = ownedFixture(t);
  const outDir = join(ownedRoot, 'versions', 'tx', 'abcd', 'dev');
  const tagsBefore = checkout.tags();

  const clean = prepareDev(lock, { checkout: checkout.dir, outDir });
  assert.deepEqual(clean.identity, { kind: 'dev', version: '0.3.0', commit: checkout.head() });
  assert.equal(clean.dirty, false, 'ignored build output does not make the checkout dirty');
  assert.equal(clean.cached, false);
  assert.equal(clean.checkout, checkout.dir);
  assert.ok(clean.tarball.startsWith(outDir));
  assert.equal(JSON.parse(readTarball(clean.tarball).get('dist/built.json').toString()).marker, 'dev-marker');
  assert.equal(sha(readFileSync(clean.tarball)), clean.sha256);
  assert.equal(existsSync(join(ownedRoot, 'versions', 'cache', '0.3.0')), false, 'dev is never cached');

  checkout.makeDirty();
  writeFileSync(join(checkout.dir, 'marker.txt'), 'edited-locally\n');
  const dirty = prepareDev(lock, { checkout: checkout.dir, outDir: join(ownedRoot, 'versions', 'tx', 'abcd', 'dev2') });
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.identity.commit, clean.identity.commit);
  assert.equal(JSON.parse(readTarball(dirty.tarball).get('dist/built.json').toString()).marker, 'edited-locally', 'local changes are included');
  assert.equal(checkout.tags(), tagsBefore, 'dev never creates or moves tags');
});

test('S30 dev checkout validation is actionable and never falls back', t => {
  const good = makeCheckout(t, { version: '0.3.0' });
  const foreign = makeCheckout(t, { version: '0.3.0', name: 'something-else' });
  const broken = makeCheckout(t, { version: '0.3.0', brokenBuild: true });
  const plain = tempDir(t);
  writeFileSync(join(plain, 'package.json'), JSON.stringify({ name: 'my-driven-development', version: '1.0.0' }));
  const { ownedRoot, lock } = ownedFixture(t);
  const outDir = join(ownedRoot, 'versions', 'tx', 'x', 'dev');
  const dev = checkout => () => prepareDev(lock, { checkout, outDir });
  const failsWith = (work, code, pattern) => assert.throws(work, error => error instanceof SourceError && error.code === code && pattern.test(error.message), String(pattern));

  failsWith(dev('relative/path'), 'dev-checkout', /absoluta/);
  failsWith(dev(join(plain, 'missing')), 'dev-checkout', /No existe/);
  failsWith(dev(plain), 'dev-checkout', /repositorio Git/);
  failsWith(dev(join(good.dir, 'assets')), 'dev-checkout', /raíz de su repositorio/);
  failsWith(dev(foreign.dir), 'dev-checkout', /no es my-driven-development/);
  failsWith(dev(ownedRoot), 'dev-checkout', /dentro de la instalación/);
  failsWith(() => prepareDev(lock, { checkout: good.dir, outDir: join(plain, 'out') }), 'dev-checkout', /dentro de la instalación/);
  failsWith(dev(broken.dir), 'build', /Falló la preparación de dev en la etapa «compilación»/);
  assert.equal(readdirSync(join(ownedRoot, 'versions')).includes('cache') && readdirSync(join(ownedRoot, 'versions', 'cache')).length, 0);
});

test('owned layout is not disturbed by hostile origin repository config, and snapshots are stable across a no-op fetch', t => {
  const origin = makeOrigin(t, [{ version: '0.2.0' }, { version: '0.3.0' }]);
  const { ownedRoot, paths } = ownedFixture(t);
  ensureClone(paths, origin.url);
  const first = fetchTags(paths, origin.url);
  assert.ok(first.ok);
  const refs = () => gitIn(paths.repoPath, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/mdd/observed/');
  const before = refs();
  assert.ok(fetchTags(paths, origin.url).ok);
  assert.equal(refs(), before);
  assert.deepEqual(observedTags(paths, stateFor(origin.url, { '0.2.0': origin.commits['0.2.0'] })).map(tag => tag.status), ['eligible', 'eligible']);
  // Nothing outside the owned root was created for the clone.
  assert.ok(Object.keys(snapshotTree(ownedRoot)).every(path => path.startsWith('versions') || path === 'versions' || path === 'mdd.lock'));
});

/** A TCP server that accepts connections and never answers: an https origin whose TLS handshake hangs. */
async function hangingOrigin(t) {
  const sockets = new Set();
  const server = createServer(socket => { socket.unref(); sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.unref();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  t.after(close);
  return { url: `https://127.0.0.1:${server.address().port}/hang.git`, close };
}

test('G3 deadlines: normal fetch keeps 60 s, doctor 15 s, and a hanging origin ends within the bound as stale data without changing anything', async t => {
  assert.equal(FETCH_TIMEOUT_MS, 60000);
  assert.equal(DOCTOR_TIMEOUT_MS, 15000);
  const origin = makeOrigin(t, [{ version: '0.3.0' }]);
  const { paths } = ownedFixture(t);
  assert.equal(discover(paths, stateFor(origin.url)).stale, false);
  const before = snapshotTree(paths.repoPath, /^(?:\.git(?:\/|$)|FETCH_HEAD$)/);

  const hanging = await hangingOrigin(t);
  const state = stateFor(hanging.url);
  const started = Date.now();
  const result = discover(paths, state, { timeout: 2000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 30000, `the hung fetch ended within the bound (took ${elapsed} ms)`);
  assert.equal(result.stale, true);
  assert.ok(result.error, 'the failure is reported');
  assert.ok(result.fetchedAt, 'the earlier successful fetch time is still reported');
  assert.ok(result.tags.some(tag => tag.version === '0.3.0' && tag.status === 'eligible'), 'the last observed tags remain visible');
  assert.equal(resolveAlias(result, 'stable').ok, false, 'a stale alias is never resolved');
  const after = snapshotTree(paths.repoPath, /^(?:\.git(?:\/|$)|FETCH_HEAD$)/);
  for (const key of Object.keys(before)) if (!/config$/.test(key)) assert.equal(after[key], before[key], `${key} unchanged`);
  assert.equal(Object.keys(after).filter(key => !(key in before) && !/\.lock$/.test(key)).length, 0, 'no new objects or refs');
  // The killed git's transport helper may outlive it, with the clone directory as its working directory, until
  // the server drops the connection; closing the server lets it exit so the fixture can be removed on Windows.
  await new Promise(resolve => setTimeout(resolve, 500));
  hanging.close();
  await new Promise(resolve => setTimeout(resolve, 2500));
});
