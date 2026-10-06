import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import mutableFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerEdit } from '../dist/worker-edit.js';
import { WorkerFence } from '../dist/worker-fence.js';
import { applyScopeFiles } from '../dist/worker-batch.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-worker-edit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(join(root, 'a.txt'), 'before\n'); fs.writeFileSync(join(root, 'b.txt'), 'before\n');
  const scope = { complete: true, reads: ['b.txt'], writes: ['a.txt', 'nested/new.txt'] };
  const editor = new WorkerEdit(root);
  const fence = new WorkerFence(root, 'project', 1);
  let active = true;
  const child = { id: 'child', parentID: 'parent', projectID: 'project', location: { directory: root } };
  const progress = { sessionID: 'parent', assistantMessageID: 'message', id: 'call', metadata: { status: 'running', sessionID: child.id } };
  fence.admit('parent', 'message', 'call', { phase: 'mdd-apply', taskID: 'T1', scope, ownerEpoch: 4 }, () => active);
  fence.progress(progress);
  return { root, scope, editor, fence, child, progress, stop: () => { active = false; }, read: name => fs.readFileSync(join(root, name), 'utf8') };
}
const edit = (path, oldString, newString) => ({ path, kind: 'edit', oldString, newString });

test('bound Apply child can create, exact-edit, replace and delete without helper artifacts', async t => {
  const f = fixture(t);
  await f.fence.edit(f.child, { operations: [edit('a.txt', 'before', 'after'), { path: 'nested/new.txt', kind: 'create', content: 'new\n' }] });
  assert.equal(f.read('a.txt'), 'after\n'); assert.equal(f.read('nested/new.txt'), 'new\n');
  await f.fence.edit(f.child, { operations: [{ path: 'a.txt', kind: 'replace', expected: 'after\n', content: 'replaced\n' },
    { path: 'nested/new.txt', kind: 'delete', expected: 'new\n' }] });
  assert.equal(f.read('a.txt'), 'replaced\n'); assert.equal(fs.existsSync(join(f.root, 'nested/new.txt')), false);
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['a.txt', 'b.txt', 'nested']);
});

for (const kind of ['outside', 'absolute', 'traversal', 'case', 'duplicate', 'extra-authority', 'unknown', 'late-precondition'])
  test(`whole-request ${kind} refusal precedes every mutation`, async t => {
    const f = fixture(t);
    let second = edit('b.txt', 'before', 'bad');
    if (kind === 'absolute') second.path = join(f.root, 'a.txt');
    if (kind === 'traversal') second.path = '../a.txt';
    if (kind === 'case') second.path = 'A.txt';
    if (kind === 'duplicate') second.path = 'a.txt';
    if (kind === 'unknown') second = { path: 'a.txt', kind: 'execute', command: 'bad' };
    if (kind === 'late-precondition') { f.scope.writes.push('b.txt'); second = edit('b.txt', 'missing', 'bad'); }
    const args = { operations: [edit('a.txt', 'before', 'bad'), second] };
    if (kind === 'extra-authority') args.ownerEpoch = 4;
    await assert.rejects(f.editor.execute(f.scope, args, () => true));
    assert.equal(f.read('a.txt'), 'before\n'); assert.equal(f.read('b.txt'), 'before\n');
    assert.equal(fs.existsSync(join(f.root, 'nested')), false);
  });

for (const kind of ['parent', 'manual', 'unbound', 'stale', 'settled', 'quarantined', 'read-only', 'moved'])
  test(`${kind} identity cannot use the registered editor`, async t => {
    const f = fixture(t);
    if (kind === 'parent') delete f.child.parentID;
    if (['manual', 'unbound'].includes(kind)) f.child.id = kind;
    if (kind === 'stale') f.stop();
    if (kind === 'settled') f.fence.settle('call');
    if (kind === 'quarantined') f.fence.progress({ ...f.progress, metadata: { status: 'running', sessionID: 'other' } });
    if (kind === 'moved') f.child.location.directory = join(f.root, 'other');
    if (kind === 'read-only') {
      f.fence = new WorkerFence(f.root, 'project');
      f.fence.admit('parent', 'message', 'call', { phase: 'mdd-explore', taskID: 'E1', ownerEpoch: 4, reads: [{ root: f.root, files: ['a.txt'] }] }, () => true);
      f.fence.progress(f.progress);
    }
    await assert.rejects(f.fence.edit(f.child, { operations: [edit('a.txt', 'before', 'bad')] }));
    assert.equal(f.read('a.txt'), 'before\n');
  });

test('same-child concurrent edits serialize and exact preconditions reject lost updates', async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([f.fence.edit(f.child, { operations: [edit('a.txt', 'before', 'first')] }),
    f.fence.edit(f.child, { operations: [edit('a.txt', 'before', 'second')] })]);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected']);
  assert.equal(f.read('a.txt'), 'first\n');
});

test('native tool cancellation revokes queued mutation even with an otherwise live owner', async t => {
  const f = fixture(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.fence.edit(f.child, { operations: [edit('a.txt', 'before', 'bad')] }, controller.signal), /authority/);
  assert.equal(f.read('a.txt'), 'before\n');
});

test('preserves BOM, CRLF, file mode and all untouched text', async t => {
  const f = fixture(t); const path = join(f.root, 'a.txt');
  fs.writeFileSync(path, '\ufeffbefore\r\nuntouched\r\n'); fs.chmodSync(path, 0o755);
  const mode = fs.statSync(path).mode & 0o777;
  await f.fence.edit(f.child, { operations: [edit('a.txt', 'before', 'after\ninserted')] });
  assert.equal(f.read('a.txt'), '\ufeffafter\r\ninserted\r\nuntouched\r\n');
  assert.equal(fs.statSync(path).mode & 0o777, mode);
});

test('rejects ambiguous matches, binary text and hardlink/root aliases', async t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, 'a.txt'), 'repeat repeat');
  await assert.rejects(f.fence.edit(f.child, { operations: [edit('a.txt', 'repeat', 'bad')] }), /exactly one/);
  fs.writeFileSync(join(f.root, 'a.txt'), Buffer.from([0xff, 0]));
  await assert.rejects(f.fence.edit(f.child, { operations: [{ path: 'a.txt', kind: 'replace', expected: '', content: 'bad' }] }));
  fs.writeFileSync(join(f.root, 'a.txt'), 'before'); fs.linkSync(join(f.root, 'a.txt'), join(f.root, 'alias.txt'));
  await assert.rejects(f.fence.edit(f.child, { operations: [edit('a.txt', 'before', 'bad')] }));
  const alias = join(f.root, 'linked'); fs.symlinkSync(f.root, alias, 'junction');
  assert.throws(() => applyScopeFiles(alias, f.scope));
});

test('live authority loss and human drift refuse publication without rollback', async t => {
  const f = fixture(t);
  let checks = 0;
  await assert.rejects(f.editor.execute(f.scope, { operations: [edit('a.txt', 'before', 'bad')] }, () => ++checks === 1), /authority/);
  checks = 0;
  await assert.rejects(f.editor.execute(f.scope, { operations: [edit('a.txt', 'before', 'bad')] }, () => {
    if (++checks === 2) fs.writeFileSync(join(f.root, 'a.txt'), 'human edit\n');
    return true;
  }), /changed before publication/);
  assert.equal(f.read('a.txt'), 'human edit\n');
});

test('partial publication reports retained files and never overwrites a later human edit', async t => {
  const f = fixture(t); f.scope.writes.push('b.txt');
  let checks = 0;
  await assert.rejects(f.editor.execute(f.scope, { operations: [edit('a.txt', 'before', 'first'), edit('b.txt', 'before', 'second')] }, () => {
    if (++checks === 6) fs.writeFileSync(join(f.root, 'b.txt'), 'human\n');
    return true;
  }), /retained changed files=\["a.txt"\]/);
  assert.equal(f.read('a.txt'), 'first\n'); assert.equal(f.read('b.txt'), 'human\n');
});

for (const persistent of [false, true]) test(`${persistent ? 'persistent' : 'one-shot'} temporary cleanup failure reports every published path`, async t => {
  const f = fixture(t);
  f.scope.writes.push('b.txt', 'c.txt');
  fs.writeFileSync(join(f.root, 'c.txt'), 'unpublished\n');
  const unlink = fs.unlinkSync;
  let cleanupCalls = 0;
  t.mock.method(mutableFs, 'unlinkSync', path => {
    if (String(path).startsWith(f.root) && String(path).includes('.mdd-worker-')) {
      cleanupCalls++;
      if (persistent || cleanupCalls === 1) throw new Error(`injected cleanup failure ${cleanupCalls}`);
    }
    return unlink(path);
  });
  syncBuiltinESMExports();
  try {
    const operations = persistent ? [
      { path: 'a.txt', kind: 'replace', expected: 'before\n', content: 'published replacement\n' },
      { path: 'b.txt', kind: 'delete', expected: 'before\n' },
      { path: 'nested/new.txt', kind: 'create', content: 'published create\n' },
      { path: 'c.txt', kind: 'replace', expected: 'unpublished\n', content: 'must not publish\n' },
    ] : [{ path: 'nested/new.txt', kind: 'create', content: 'published create\n' }];
    const result = await f.editor.execute(f.scope, { operations }, () => true).then(
      () => assert.fail('Cleanup failure must report the retained publication'), error => error);
    assert.equal(f.read('nested/new.txt'), 'published create\n');
    assert.equal(f.read('c.txt'), 'unpublished\n');
    assert.match(result.message, /injected cleanup failure 1/);
    const retained = JSON.parse(result.message.match(/retained changed files=(\[[^\]]*\])/)[1]);
    assert.deepEqual(retained, persistent ? ['a.txt', 'b.txt', 'nested/new.txt'] : ['nested/new.txt']);
    if (persistent) {
      assert.equal(f.read('a.txt'), 'published replacement\n');
      assert.equal(fs.existsSync(join(f.root, 'b.txt')), false);
      assert.match(result.message, /Temporary cleanup failed for nested\/new\.txt: injected cleanup failure 2/);
      assert.match(result.message, /Temporary cleanup failed for c\.txt: injected cleanup failure 3/);
      assert.equal(cleanupCalls, 3);
      assert.equal(fs.readdirSync(f.root).filter(name => name.startsWith('.mdd-worker-')).length, 1);
      assert.equal(fs.readdirSync(join(f.root, 'nested')).filter(name => name.startsWith('.mdd-worker-')).length, 1);
    } else {
      assert.equal(f.read('a.txt'), 'before\n'); assert.equal(f.read('b.txt'), 'before\n');
      assert.equal(cleanupCalls, 2);
      assert.deepEqual(fs.readdirSync(join(f.root, 'nested')), ['new.txt']);
    }
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('implicit runtime/config/instruction writes and symlink parents remain unsafe', async t => {
  const f = fixture(t);
  for (const path of ['AGENTS.md', 'nested/AGENTS.md', '.opencode/plugin.ts', '.git/config', 'package.json', 'opencode.json', 'tsconfig.json', 'config.ts'])
    assert.throws(() => applyScopeFiles(f.root, { complete: true, reads: [], writes: [path] }));
  const outside = fs.mkdtempSync(join(tmpdir(), 'mdd-worker-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, join(f.root, 'nested'), 'junction');
  await assert.rejects(f.fence.edit(f.child, { operations: [{ path: 'nested/new.txt', kind: 'create', content: 'bad' }] }));
  assert.deepEqual(fs.readdirSync(outside), []);
});

for (const config of [
  { agents: { custom: { system: '{file:a.txt}' } } },
  { instructions: ['*.txt'] },
  { plugins: ['./a.txt'] },
]) test(`bootstrap configuration references keep Apply serial: ${JSON.stringify(config)}`, t => {
  const f = fixture(t);
  fs.writeFileSync(join(f.root, 'opencode.json'), JSON.stringify(config));
  assert.throws(() => applyScopeFiles(f.root, f.scope), /bootstrap|implicit/);
});

test('project-local plugin effects cannot be inferred from disjoint declared files', t => {
  const f = fixture(t);
  fs.mkdirSync(join(f.root, '.opencode/plugins'), { recursive: true });
  fs.writeFileSync(join(f.root, '.opencode/plugins/custom.ts'), 'export {default} from "../../a.txt";');
  assert.throws(() => applyScopeFiles(f.root, f.scope), /bootstrap|implicit/);
});
