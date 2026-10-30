import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalFiles, LOCAL_NAMES, STALE_LOCK_MS } from '../dist/local-files.js';

const NAME = 'mdd.config.json';

function seed(t, content = '{"state":"committed"}') {
  const directory = fs.mkdtempSync(join(tmpdir(), 'mdd-local-files-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = new LocalFiles(directory);
  if (content !== null) files.update(NAME, () => content, 4096);
  return { directory, files, path: join(directory, NAME), lock: join(directory, `${NAME}.lock`) };
}

test('only the fixed MDD files are reachable', t => {
  const { files } = seed(t, null);
  assert.deepEqual([...LOCAL_NAMES], ['mdd.config.json', 'mdd/setup-assets.json']);
  for (const name of ['../outside.json', '.mdd/telemetry.jsonl', 'mdd/other.json', 'package.json']) {
    assert.throws(() => files.read(name, 100), name);
    assert.throws(() => files.update(name, () => '{}', 100), name);
  }
});

test('update creates parent directories, replaces atomically and removes the lock', t => {
  const { directory, files, lock } = seed(t, null);
  files.update('mdd/setup-assets.json', previous => `${previous ?? ''}first\n`, 4096);
  files.update('mdd/setup-assets.json', previous => `${previous}second\n`, 4096);
  assert.equal(files.read('mdd/setup-assets.json', 4096), 'first\nsecond\n');
  assert.deepEqual(fs.readdirSync(join(directory, 'mdd')), ['setup-assets.json']);
  assert.equal(fs.existsSync(lock), false);
});

test('returning undefined removes the file; reading a missing file gives undefined', t => {
  const { files, path } = seed(t);
  files.update(NAME, () => undefined, 4096);
  assert.equal(fs.existsSync(path), false);
  assert.equal(files.read(NAME, 4096), undefined);
});

test('size limits are enforced on read and write without touching the file', t => {
  const { files, path } = seed(t);
  assert.throws(() => files.read(NAME, 4));
  assert.throws(() => files.update(NAME, () => 'x'.repeat(5000), 4096));
  assert.equal(fs.readFileSync(path, 'utf8'), '{"state":"committed"}');
});

test('a fresh lock refuses a competing writer; a stale one is taken over', t => {
  const { files, lock } = seed(t);
  fs.writeFileSync(lock, 'another writer');
  assert.throws(() => files.update(NAME, () => '{"state":"blocked"}', 4096));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'another writer');
  const old = new Date(Date.now() - STALE_LOCK_MS - 1000);
  fs.utimesSync(lock, old, old);
  files.update(NAME, () => '{"state":"after-stale"}', 4096);
  assert.equal(files.read(NAME, 4096), '{"state":"after-stale"}');
  assert.equal(fs.existsSync(lock), false);
});

test('transient Windows EPERM/EBUSY on rename is retried, not fatal', t => {
  const { files } = seed(t);
  const rename = fs.renameSync;
  let renames = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (++renames <= 2) throw Object.assign(new Error('busy'), { code: renames === 1 ? 'EPERM' : 'EBUSY' });
    return rename(from, to);
  });
  files.update(NAME, () => '{"state":"after-retry"}', 4096);
  t.mock.restoreAll();
  assert.equal(files.read(NAME, 4096), '{"state":"after-retry"}');
  assert.ok(renames >= 3);
});

test('a rename that keeps failing leaves the committed file and no temporary or lock behind', t => {
  const { directory, files, lock } = seed(t);
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); });
  assert.throws(() => files.update(NAME, () => '{"state":"lost"}', 4096));
  t.mock.restoreAll();
  assert.equal(files.read(NAME, 4096), '{"state":"committed"}');
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.tmp')), []);
  assert.equal(fs.existsSync(lock), false);
});

test('links are refused: a linked parent directory, a hardlinked file and a linked root', t => {
  const { directory, files } = seed(t, null);
  const outside = fs.mkdtempSync(join(tmpdir(), 'mdd-local-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, join(directory, 'mdd'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => files.update('mdd/setup-assets.json', () => '{}', 100));
  assert.deepEqual(fs.readdirSync(outside), []);
  const target = join(outside, 'protected');
  fs.writeFileSync(target, 'protected');
  fs.linkSync(target, join(directory, NAME));
  assert.throws(() => files.read(NAME, 100));
  assert.throws(() => files.update(NAME, () => '{}', 100));
  assert.equal(fs.readFileSync(target, 'utf8'), 'protected');
  const linkedRoot = join(directory, 'linked-root');
  fs.symlinkSync(outside, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => new LocalFiles(linkedRoot).update(NAME, () => '{}', 100));
});
