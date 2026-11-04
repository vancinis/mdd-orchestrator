import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  VersionStoreError, acquireLock, assertHeld, clearJournal, configCandidates, createBackup, identityLabel, listBackups,
  pruneBackups, readBackupAsset, readBackupConfig, readJournal, readLockOwner, readState, recordReleases, sameIdentity,
  validateBackup, versionPaths, withLock, writeJournal, writeState,
} from '../dist/version-store.js';

const sha = data => createHash('sha256').update(data).digest('hex');
const COMMIT = 'a'.repeat(40);
const rel = (version, commit = COMMIT) => ({ kind: 'release', version, commit });
const SEAMS = { hostname: () => 'host-a', isAlive: () => true };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return versionPaths(join(root, 'mdd'));
}
const throwsCode = (work, code) => assert.throws(work, error => error instanceof VersionStoreError && error.code === code, `expected ${code}`);
const file = (text) => ({ bytes: Buffer.from(text), sha256: sha(text) });
const asset = (path, text, extra = {}) => ({ path, bytes: Buffer.from(text), sha256: sha(text), edited: false, action: 'replace', ...extra });
const clockAt = (iso) => () => new Date(iso);
const input = (source, extra = {}) => ({ source, target: rel('9.9.9'), config: file('{"version":1}'), assets: [], now: clockAt('2026-11-03T14:25:01Z'), ...extra });

test('identity helpers: equality and backup labels', () => {
  assert.ok(sameIdentity(rel('0.2.0'), rel('0.2.0')));
  assert.ok(!sameIdentity(rel('0.2.0'), rel('0.2.0', 'b'.repeat(40))));
  assert.ok(!sameIdentity(rel('0.2.0'), { ...rel('0.2.0'), kind: 'dev' }));
  assert.ok(sameIdentity(null, null) && !sameIdentity(null, rel('0.2.0')));
  assert.equal(identityLabel(rel('0.3.0-preview.1')), '0.3.0-preview.1');
  assert.equal(identityLabel({ kind: 'dev', version: '0.2.0', commit: COMMIT }), 'dev-aaaaaaa');
  assert.equal(identityLabel(null), 'none');
  for (const bad of [rel('../x'), rel('v1.0.0'), rel('1.0.0', 'zz'), rel('1.0.0', '../..')]) throwsCode(() => identityLabel(bad), 'corrupt');
});

test('lock: exclusive, records the owner, busy names pid and command, release is token-guarded', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use stable', SEAMS);
  const owner = readLockOwner(paths);
  assert.equal(owner.pid, process.pid);
  assert.equal(owner.command, 'use stable');
  assert.equal(owner.host, 'host-a');
  assert.throws(() => acquireLock(paths, 'versions', SEAMS), error => error.code === 'busy' && error.message.includes(`pid ${process.pid}`) && error.message.includes('use stable'));
  assertHeld(lock);
  lock.release();
  assert.equal(existsSync(paths.lockPath), false);
  lock.release();
  // A release by a handle that no longer owns the lock leaves the new owner's lock alone.
  const first = acquireLock(paths, 'a', SEAMS);
  rmSync(paths.lockPath);
  const second = acquireLock(paths, 'b', SEAMS);
  first.release();
  assert.equal(readLockOwner(paths).command, 'b');
  throwsCode(() => assertHeld(first), 'lock-lost');
  second.release();
});

test('lock: takeover only for a dead owner on the same host, never by age alone', t => {
  const paths = fixture(t);
  const stale = (owner) => { mkdirSync(paths.versionsRoot, { recursive: true }); writeFileSync(paths.lockPath, JSON.stringify(owner)); const old = new Date(Date.now() - 3600e3); utimesSync(paths.lockPath, old, old); };
  const owner = { token: 'deadbeef', pid: 4242, host: 'host-a', command: 'use dev', startedAt: '2026-01-01T00:00:00.000Z' };

  stale(owner);
  throwsCode(() => acquireLock(paths, 'next', { ...SEAMS, isAlive: () => true }), 'busy');
  assert.equal(readLockOwner(paths).token, 'deadbeef', 'a live owner is never taken over even when the lock is old');

  stale({ ...owner, host: 'other-host' });
  throwsCode(() => acquireLock(paths, 'next', { ...SEAMS, isAlive: () => false }), 'busy');

  stale(owner);
  const lock = acquireLock(paths, 'next', { ...SEAMS, isAlive: pid => pid !== 4242 });
  assert.equal(readLockOwner(paths).command, 'next');
  assert.ok(readdirSync(paths.versionsRoot).some(name => name.startsWith('lock.stale-')));
  lock.release();
});

test('lock: an unreadable lock is stale only after 30 seconds', t => {
  const paths = fixture(t);
  mkdirSync(paths.versionsRoot, { recursive: true });
  writeFileSync(paths.lockPath, '');
  throwsCode(() => acquireLock(paths, 'x', SEAMS), 'busy');
  const old = new Date(Date.now() - 60e3);
  utimesSync(paths.lockPath, old, old);
  writeFileSync(paths.lockPath, 'not json');
  utimesSync(paths.lockPath, old, old);
  acquireLock(paths, 'x', SEAMS).release();
});

test('lock: withLock returns the result and releases on error', t => {
  const paths = fixture(t);
  assert.throws(() => withLock(paths, 'a', () => { throw new Error('boom'); }, SEAMS), /boom/);
  assert.equal(existsSync(paths.lockPath), false);
  assert.equal(withLock(paths, 'a', () => 7, SEAMS), 7);
});

test('state: missing file is empty, writes need the lock, content is validated, first-seen is not overwritten', t => {
  const paths = fixture(t);
  assert.deepEqual(readState(paths), { schema: 1, origin: null, devCheckout: null, active: null, adoption: null, releases: {} });
  const lock = acquireLock(paths, 'use', SEAMS);
  const state = readState(paths);
  state.origin = 'https://example.test/r.git';
  state.active = { ...rel('0.2.0'), channel: 'stable', provenance: 'adopted' };
  writeState(lock, state);
  assert.deepEqual(readState(paths), state);
  const at = new Date('2026-11-03T00:00:00Z');
  assert.equal(recordReleases(lock, [{ version: '0.3.0', commit: 'b'.repeat(40) }], at), true);
  assert.equal(recordReleases(lock, [{ version: '0.3.0', commit: 'c'.repeat(40) }], new Date()), false);
  assert.equal(readState(paths).releases['0.3.0'].commit, 'b'.repeat(40));
  assert.throws(() => recordReleases(lock, [{ version: '../x', commit: 'b' }], at), VersionStoreError);
  lock.release();
  assert.throws(() => writeState(lock, state), error => error.code === 'lock-lost');

  writeFileSync(paths.statePath, '{"schema": 2}');
  throwsCode(() => readState(paths), 'corrupt');
  writeFileSync(paths.statePath, '{nope');
  throwsCode(() => readState(paths), 'corrupt');
  assert.deepEqual(readdirSync(paths.versionsRoot).filter(name => name.endsWith('.tmp')), [], 'no temp files left behind');
});

test('state: a directory where state.json belongs is refused as unsafe', t => {
  const paths = fixture(t);
  mkdirSync(paths.statePath, { recursive: true });
  assert.throws(() => readState(paths), error => error instanceof VersionStoreError && error.code === 'unsafe');
});

test('journal: round trip, phases, corrupt content, clear', t => {
  const paths = fixture(t);
  assert.equal(readJournal(paths), undefined);
  const lock = acquireLock(paths, 'use', SEAMS);
  const journal = { schema: 1, id: 'a1b2c3d4', phase: 'backing-up', owner: { pid: 1, host: 'h' }, source: rel('0.2.0'), target: rel('0.3.0'), backup: 'backups/x', snapshot: { 'mdd.config.json': 'absent' }, items: [{ kind: 'package' }] };
  writeJournal(lock, journal);
  assert.deepEqual(readJournal(paths), journal);
  assert.throws(() => writeJournal(lock, { ...journal, phase: 'weird' }), error => error.code === 'corrupt');
  assert.throws(() => writeJournal(lock, { ...journal, id: '../../x' }), error => error.code === 'corrupt');
  assert.deepEqual(readJournal(paths), journal, 'a rejected write leaves the journal untouched');
  writeFileSync(paths.journalPath, '{broken');
  throwsCode(() => readJournal(paths), 'corrupt');
  writeJournal(lock, { ...journal, phase: 'blocked', blocked: { reason: 'x', at: 'y' } });
  clearJournal(lock);
  assert.equal(readJournal(paths), undefined);
  clearJournal(lock);
  lock.release();
  assert.throws(() => clearJournal(lock), error => error.code === 'lock-lost');
});

test('backup: config bytes, assets, absence record, and manifest written last', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  const writes = [];
  const set = createBackup(lock, input(rel('0.3.0-preview.1'), {
    assets: [asset('agents/mdd-apply.md', 'edited', { edited: true }), asset('skills/mdd-x/SKILL.md', 'skill', { action: 'remove' })],
    beforeWrite: what => writes.push(what),
  }));
  assert.deepEqual(writes, ['mdd.config.json', 'agents/mdd-apply.md', 'skills/mdd-x/SKILL.md', 'backup.json']);
  assert.match(set.name, /^20261103-142501-0\.3\.0-preview\.1$/);
  assert.equal(set.seq, 1);
  assert.equal(readBackupConfig(paths, set).toString(), '{"version":1}');
  assert.equal(readBackupAsset(paths, set, 'agents/mdd-apply.md').toString(), 'edited');
  assert.deepEqual(set.assets.map(a => [a.path, a.edited, a.action]), [['agents/mdd-apply.md', true, 'replace'], ['skills/mdd-x/SKILL.md', false, 'remove']]);
  assert.deepEqual(validateBackup(paths, set.name), set);

  const absent = createBackup(lock, input(null, { config: null, now: clockAt('2026-11-03T14:26:00Z') }));
  assert.match(absent.name, /-none$/);
  assert.equal(absent.seq, 2);
  assert.deepEqual(absent.config, { present: false });
  assert.equal(readBackupConfig(paths, absent), null);
  assert.ok(!existsSync(join(absent.dir, 'mdd.config.json')), 'absence is recorded, no config bytes are invented');
  assert.ok(validateBackup(paths, absent.name), 'absence is a completed set');
  lock.release();
});

test('backup: a timestamp collision gets a unique directory and never overwrites', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  const a = createBackup(lock, input(rel('0.2.0'), { config: file('first') }));
  const b = createBackup(lock, input(rel('0.2.0'), { config: file('second') }));
  const c = createBackup(lock, input(rel('0.2.0'), { config: file('third') }));
  assert.deepEqual([a.name, b.name, c.name].map(n => n.replace(/^\d{8}-\d{6}-/, '')), ['0.2.0', '0.2.0-2', '0.2.0-3']);
  assert.equal(readBackupConfig(paths, a).toString(), 'first');
  assert.equal(readBackupConfig(paths, b).toString(), 'second');
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  lock.release();
});

test('backup: write failure removes the partial set and leaves existing sets byte-identical (S24)', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  const good = createBackup(lock, input(rel('0.2.0'), { config: file('keep me') }));
  const before = readFileSync(join(good.dir, 'backup.json'));
  for (const failAt of ['mdd.config.json', 'agents/b.md', 'backup.json']) {
    const names = readdirSync(paths.backupsRoot);
    throwsCode(() => createBackup(lock, input(rel('0.3.0'), {
      assets: [asset('agents/a.md', 'a'), asset('agents/b.md', 'b')],
      beforeWrite: what => { if (what === failAt) throw new Error('disk full'); },
    })), 'backup');
    assert.deepEqual(readdirSync(paths.backupsRoot), names, `partial set removed after failing at ${failAt}`);
  }
  assert.deepEqual(readFileSync(join(good.dir, 'backup.json')), before);
  assert.equal(readBackupConfig(paths, good).toString(), 'keep me');
  lock.release();
});

test('backup: planned digest mismatch (changed after planning) and bad asset paths are refused (S37)', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  throwsCode(() => createBackup(lock, input(rel('0.2.0'), { config: { bytes: Buffer.from('changed'), sha256: sha('planned') } })), 'backup');
  for (const path of ['../escape.md', '/abs.md', 'a\\b.md', 'a//b.md', '', 'a/./b.md']) {
    throwsCode(() => createBackup(lock, input(rel('0.2.0'), { assets: [asset(path, 'x')] })), 'backup');
  }
  throwsCode(() => createBackup(lock, input(rel('0.2.0'), { assets: [asset('a.md', 'x'), asset('a.md', 'y')] })), 'backup');
  assert.deepEqual(readdirSync(paths.backupsRoot), []);
  lock.release();
  throwsCode(() => createBackup(lock, input(rel('0.2.0'))), 'lock-lost');
});

test('validation rejects partial, tampered, wrong-schema and incomplete sets', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  const make = (version, config = '{"version":1}') => createBackup(lock, input(rel(version), { config: file(config), assets: [asset('agents/a.md', 'asset')], now: clockAt(`2026-11-03T14:2${version.length % 10}:00Z`) }));
  const ok = make('1.0.0');
  const tamperedConfig = make('1.0.10');
  const tamperedAsset = make('1.0.100');
  const noManifest = make('1.0.1000');
  const incomplete = make('1.0.10000');
  writeFileSync(join(tamperedConfig.dir, 'mdd.config.json'), 'evil');
  writeFileSync(join(tamperedAsset.dir, 'assets', 'agents', 'a.md'), 'evil');
  rmSync(join(noManifest.dir, 'backup.json'));
  const manifestPath = join(incomplete.dir, 'backup.json');
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(readFileSync(manifestPath, 'utf8')), complete: false }));
  const listing = listBackups(paths);
  assert.deepEqual(listing.valid.map(s => s.name), [ok.name]);
  assert.deepEqual(listing.invalid.sort(), [tamperedConfig.name, tamperedAsset.name, noManifest.name, incomplete.name].sort());
  writeFileSync(manifestPath, JSON.stringify({ schema: 7 }));
  assert.equal(validateBackup(paths, incomplete.name), undefined);
  lock.release();
});

test('config candidates: exact source identity only, newest by seq regardless of name or SemVer (S22)', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  const at = (n) => clockAt(`2026-11-03T14:2${n}:00Z`);
  // Capture order differs from name order and from SemVer order.
  createBackup(lock, input(rel('0.3.0'), { config: file('older exact'), now: at(5) }));
  createBackup(lock, input(rel('0.4.0'), { config: file('wrong version, newer'), now: at(4) }));
  createBackup(lock, input(rel('0.3.0'), { config: file('newest exact'), now: at(1) }));
  createBackup(lock, input(rel('0.3.0', 'b'.repeat(40)), { config: file('same version, other commit'), now: at(9) }));
  const bad = createBackup(lock, input(rel('0.3.0'), { config: file('corrupt exact'), now: at(8) }));
  writeFileSync(join(bad.dir, 'mdd.config.json'), 'tampered');
  const found = configCandidates(paths, rel('0.3.0'));
  assert.deepEqual(found.map(s => readBackupConfig(paths, s).toString()), ['newest exact', 'older exact']);
  assert.deepEqual(configCandidates(paths, rel('0.9.0')), []);
  lock.release();
});

test('retention keeps the newest 10 completed by seq, protects the journal set, removes partial sets (S23)', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  const versions = ['0.9.0', '0.2.0', '0.10.0', '0.3.0', '0.2.1', '0.8.0', '0.4.0', '0.7.0', '0.5.0', '0.6.0', '0.2.2', '0.2.3'];
  const sets = versions.map((v, i) => createBackup(lock, input(rel(v), { now: clockAt('2026-11-03T14:25:01Z'), config: file(`c${i}`) })));
  assert.equal(new Set(sets.map(s => s.name)).size, 12, 'identical timestamps never collide');
  const partial = join(paths.backupsRoot, 'partial-set');
  mkdirSync(join(partial, 'assets'), { recursive: true });
  writeFileSync(join(partial, 'mdd.config.json'), 'half written');
  const referenced = join(paths.backupsRoot, 'in-flight');
  mkdirSync(referenced);
  writeJournal(lock, { schema: 1, id: 'abcd1234', phase: 'backing-up', owner: { pid: 1, host: 'h' }, source: null, target: rel('0.9.0'), backup: 'backups/in-flight' });

  const result = pruneBackups(lock);
  const keptValid = listBackups(paths).valid;
  assert.deepEqual(keptValid.map(s => s.seq), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3], 'the 10 newest by capture order, not by name or SemVer');
  assert.deepEqual(result.removed.filter(n => n !== 'partial-set').sort(), sets.slice(0, 2).map(s => s.name).sort());
  assert.ok(!existsSync(partial), 'an unreferenced partial set is deleted');
  assert.ok(existsSync(referenced), 'a set referenced by the journal is never deleted');

  // The evicted set is no longer a restore candidate: a downgrade needing it has none.
  assert.deepEqual(configCandidates(paths, rel('0.9.0')), []);
  assert.equal(configCandidates(paths, rel('0.2.3')).length, 1);

  // A referenced completed set outside the newest 10 is protected as well.
  const lowest = keptValid.at(-1);
  writeJournal(lock, { schema: 1, id: 'abcd1234', phase: 'activating', owner: { pid: 1, host: 'h' }, source: null, target: rel('0.9.0'), backup: lowest.dir });
  pruneBackups(lock, { keep: 3 });
  assert.ok(existsSync(lowest.dir));
  assert.equal(listBackups(paths).valid.length, 4);
  lock.release();
  assert.throws(() => pruneBackups(lock), error => error.code === 'lock-lost');
});

test('the next seq follows the highest existing set even after lower ones were deleted', t => {
  const paths = fixture(t);
  const lock = acquireLock(paths, 'use', SEAMS);
  const a = createBackup(lock, input(rel('0.2.0')));
  const b = createBackup(lock, input(rel('0.2.1')));
  rmSync(a.dir, { recursive: true });
  assert.equal(createBackup(lock, input(rel('0.2.2'))).seq, b.seq + 1);
  lock.release();
});
