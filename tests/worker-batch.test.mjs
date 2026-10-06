import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectWorkerBatch, scopesConflict } from '../dist/worker-batch.js';
import { deliverables } from '../dist/phase-evidence.js';

const scope = (writes, reads = []) => ({ complete: true, reads, writes });
const step = (id, writes = [`src/${id}.ts`], reads = [], dependsOn = []) => ({
  id, description: 'Implement a bounded change.', path: 'Descriptive target remains unchanged.',
  check: 'npm test', scenarios: ['S1'], decisions: [], dependsOn, parallel: scope(writes, reads),
});
const ids = batch => batch.map(item => item.id);
function root(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mdd-worker-batch-'));
  mkdirSync(join(directory, 'src'));
  writeFileSync(join(directory, 'src/shared.ts'), 'shared');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('selection is deterministic, plan ordered, capped at two and does not mutate input', t => {
  const directory = root(t);
  const planned = deliverables([step('a'), step('b'), step('c')]);
  const before = structuredClone(planned);
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, [])), ['a', 'b']);
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, ['a'])), ['b', 'c']);
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, ['a', 'b', 'c'])), []);
  assert.deepEqual(planned, before);
});

test('dependencies must be completed, including transitive prerequisites', t => {
  const directory = root(t);
  const planned = [step('a'), step('b', undefined, [], ['a']), step('c', undefined, [], ['b']), step('d')];
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, [])), ['a', 'd']);
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, ['a'])), ['b', 'd']);
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, ['a', 'b'])), ['c', 'd']);
  assert.deepEqual(selectWorkerBatch(directory, planned, ['b']), [], 'corrupt completion cannot waive a prerequisite');
});

for (const completed of [['unknown'], ['a', 'a'], [null], new Array(1), 'a']) {
  test(`corrupt completion claims block selection: ${JSON.stringify(completed)}`, t => {
    assert.deepEqual(selectWorkerBatch(root(t), [step('a'), step('b')], completed), []);
  });
}

for (const planned of [[step('a', undefined, [], ['missing']), step('b')],
  [step('a'), step('a')], [step('a', undefined, [], ['a'])],
  [step('a', undefined, [], ['b']), step('b', undefined, [], ['a'])]]) {
  test(`invalid dependency graph cannot yield a pair: ${JSON.stringify(planned.map(item => item.id))}`, t => {
    assert.deepEqual(selectWorkerBatch(root(t), planned, []), []);
  });
}

for (const parallel of [undefined, {}, { complete: false, reads: [], writes: ['src/a.ts'] },
  { complete: true, writes: ['src/a.ts'] }, scope([]), { complete: true, reads: [], writes: null }]) {
  test(`unknown/incomplete first footprint retains sequential fallback: ${JSON.stringify(parallel)}`, t => {
    assert.deepEqual(ids(selectWorkerBatch(root(t), [{ ...step('a'), parallel }, step('b')], [])), ['a']);
  });
}

test('legacy plans and omitted dependencies stay serial after JSON reconstruction', t => {
  const directory = root(t);
  const raw = [step('a'), step('b')];
  delete raw[0].dependsOn;
  const planned = deliverables(JSON.parse(JSON.stringify(deliverables(raw))));
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, [])), ['a']);
  delete raw[0].parallel; delete raw[1].parallel;
  assert.deepEqual(ids(selectWorkerBatch(directory, deliverables(raw), [])), ['a']);
});

test('write/write, either write/read, shared test/docs/lockfile and case aliases conflict', t => {
  const directory = root(t);
  for (const path of ['tests/shared.test.mjs', 'docs/shared.md', 'package-lock.json']) {
    assert.deepEqual(ids(selectWorkerBatch(directory, [step('a', [path]), step('b', [path])], [])), ['a']);
    assert.deepEqual(ids(selectWorkerBatch(directory, [step('a', [path]), step('b', undefined, [path])], [])), ['a']);
    assert.deepEqual(ids(selectWorkerBatch(directory, [step('a', undefined, [path]), step('b', [path])], [])), ['a']);
  }
  assert.equal(scopesConflict(scope(['src/A.ts']), scope(['src/a.ts'])), true);
  assert.equal(scopesConflict(scope(['new/path']), scope(['new/path/child.ts'])), true);
  assert.equal(scopesConflict(scope(['New/a.ts']), scope(['new/b.ts'])), true, 'ambiguous parent casing fails closed');
});

test('shared reads are safe and a conflicting second candidate can be skipped', t => {
  const directory = root(t);
  const planned = [step('a', undefined, ['src/shared.ts']), step('b', ['src/a.ts']), step('c', undefined, ['src/shared.ts'])];
  assert.equal(scopesConflict(planned[0].parallel, planned[2].parallel), false);
  assert.deepEqual(ids(selectWorkerBatch(directory, planned, [])), ['a', 'c']);
  assert.equal(scopesConflict(undefined, scope(['a.ts'])), true);
});

test('existing directory scopes, file-as-parent and disk case aliases fall back to one', t => {
  const directory = root(t);
  for (const path of ['src', 'src/shared.ts/child.ts', 'SRC/new.ts']) {
    assert.deepEqual(ids(selectWorkerBatch(directory, [step('a', [path]), step('b')], [])), ['a']);
  }
});

test('absent files and absent parents are safe only under verified real ancestors', t => {
  const directory = root(t);
  assert.deepEqual(ids(selectWorkerBatch(directory, [step('a', ['new/a.ts']), step('b', ['new/b.ts'])], [])), ['a', 'b']);
  assert.deepEqual(ids(selectWorkerBatch(join(directory, 'missing-root'), [step('a'), step('b')], [])), ['a']);
  assert.deepEqual(ids(selectWorkerBatch(join(directory, 'src/shared.ts'), [step('a'), step('b')], [])), ['a']);
});

test('symlink directory aliases and escapes are ineligible even for not-yet-created files', t => {
  const directory = root(t);
  const outside = root(t);
  // Windows junction creation needs no symlink privilege; other platforms use directory links.
  symlinkSync(join(directory, 'src'), join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(outside, join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['alias/new.ts', 'escape/new.ts']) {
    assert.deepEqual(ids(selectWorkerBatch(directory, [step('a', [path]), step('b')], [])), ['a']);
  }
});

test('hard-linked files cannot masquerade as independent exact paths', t => {
  const directory = root(t);
  linkSync(join(directory, 'src/shared.ts'), join(directory, 'src/alias.ts'));
  assert.deepEqual(ids(selectWorkerBatch(directory, [step('a', ['src/shared.ts']), step('b', ['src/alias.ts'])], [])), ['a']);
});

test('read-only footprints can reuse conflict checking, not Apply batch admission', t => {
  assert.equal(scopesConflict(scope([], ['src/shared.ts']), scope([], ['src/shared.ts'])), false);
  assert.deepEqual(ids(selectWorkerBatch(root(t), [step('a', [], ['src/shared.ts']), step('b', [], ['src/shared.ts'])], [])), ['a']);
});
