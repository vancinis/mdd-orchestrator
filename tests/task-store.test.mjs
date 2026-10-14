import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TaskStore, TaskWriteError, validateTaskIdentity } from '../dist/task-store.js';
import { ArtifactStore, ArtifactWriteError } from '../dist/artifacts.js';
import { LocalFiles } from '../dist/local-files.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-task-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binding = { directory: root, worktree: root, runID: randomUUID(), sessionID: 'parent', userMessageID: 'user', requirements: 'Preserve exact task evidence.' };
  return { root, binding, task: TaskStore.create(binding) };
}

test('PF-2: readable task directories disambiguate identical objectives and refuse occupied identity', t => {
  const { root, binding, task } = fixture(t);
  const second = TaskStore.create({ ...binding, runID: randomUUID() });
  assert.notEqual(task.identity.name, second.identity.name);
  assert.match(task.identity.name, /^preserve-exact-task-evidence-/);
  assert.equal(Object.isFrozen(task.identity), true);
  assert.throws(() => TaskStore.create(binding), TaskWriteError);
  assert.equal(TaskStore.open(task.identity, binding).identity.name, task.identity.name);
  for (const key of ['directory', 'worktree', 'runID', 'project']) {
    assert.throws(() => TaskStore.open(task.identity, { ...binding, [key]: 'different' }));
  }
  assert.throws(() => TaskStore.open({ ...task.identity, root: join(root, 'foreign') }, binding));
  assert.equal(fs.existsSync(join(root, 'foreign')), false);
});

for (const objective of ['CON', 'nul', '../escape', 'a\\b', 'a:b', '...', 'é'.repeat(100)]) {
  test(`PF-2: task objective cannot become a path: ${objective}`, t => {
    const { binding } = fixture(t);
    const task = TaskStore.create({ ...binding, runID: randomUUID(), requirements: objective });
    assert.match(task.identity.name, /^[a-z0-9][a-z0-9-]{0,95}$/);
    assert.equal(task.identity.name.endsWith(`-${task.identity.runID}`), true);
    for (const name of ['../escape', 'CON', 'con', 'nul', 'a/b', 'a\\b', 'a:b', '.hidden', 'a'.repeat(97)]) {
      assert.throws(() => validateTaskIdentity({ ...task.identity, name }, binding));
    }
  });
}

test('PF-2: local records preserve every repeated phase, batch, risk and contextual artifact', async t => {
  const { root, binding, task } = fixture(t);
  const store = new ArtifactStore(root, 'local', undefined, task);
  const identities = [
    { phase: 'mdd-risk' }, { phase: 'mdd-risk' }, { phase: 'mdd-verify' }, { phase: 'mdd-verify' },
    { phase: 'mdd-apply', batchID: 'batch-one' }, { phase: 'mdd-apply', batchID: 'batch-one' },
    { phase: 'mdd-explore', explorationID: 'context-one' }, { phase: 'mdd-spec', domain: 'project' },
  ];
  const saved = [];
  for (const [index, identity] of identities.entries()) {
    saved.push(await store.save({ runID: binding.runID, ...identity }, `Full attempt ${index}: café ✓\n${'x'.repeat(450000)}`));
  }
  assert.equal(new Set(saved.map(item => item.ref.path)).size, identities.length);
  const restored = TaskStore.open(task.identity, binding);
  for (const item of saved) {
    assert.equal(await store.read(item.ref), item.content);
    assert.equal(restored.readArtifact(JSON.parse(JSON.stringify(item.ref))), item.content);
    await assert.rejects(store.read({ ...item.ref }), /Unissued/);
    assert.throws(() => restored.readArtifact({ ...item.ref, path: '../secret' }));
  }
  assert.throws(() => task.publishArtifact(saved[0].ref, saved[0].content), TaskWriteError);
  assert.equal(task.readArtifact(saved[0].ref), saved[0].content);
  await assert.rejects(store.save({ runID: randomUUID(), phase: 'mdd-plan' }, 'Different run.'), ArtifactWriteError);
});

test('PF-2: local task data survives deletion of its originating linked worktree', async t => {
  const { root } = fixture(t);
  const linked = join(root, 'linked');
  const admin = join(root, '.git', 'worktrees', 'linked');
  fs.mkdirSync(linked); fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(join(linked, '.git'), `gitdir: ${admin}\n`);
  fs.writeFileSync(join(admin, 'commondir'), '../..\n');
  const binding = { directory: linked, worktree: linked, runID: randomUUID(), sessionID: 'linked-parent', userMessageID: 'linked-user', requirements: 'Durable worktree task.' };
  const task = TaskStore.create(binding);
  const store = new ArtifactStore(linked, 'local', undefined, task);
  const saved = await store.save({ runID: binding.runID, phase: 'mdd-risk' }, 'Surviving risk assessment.');
  assert.equal(task.identity.root, root);
  fs.rmSync(linked, { recursive: true });
  assert.equal(task.readArtifact(saved.ref), saved.content);
  assert.equal(fs.readFileSync(join(root, saved.ref.path), 'utf8'), saved.content);
  assert.throws(() => TaskStore.open(task.identity, { ...binding, directory: root, worktree: root }));
});

test('PF-2: linked task directories and hardlinked records are refused without following targets', async t => {
  const { root, binding, task } = fixture(t);
  const store = new ArtifactStore(root, 'local', undefined, task);
  const saved = await store.save({ runID: binding.runID, phase: 'mdd-plan' }, 'Exact plan.');
  fs.linkSync(join(root, saved.ref.path), join(root, 'hardlinked.md'));
  assert.throws(() => task.readArtifact(saved.ref), /Unsafe/);
  fs.unlinkSync(join(root, 'hardlinked.md'));
  const outside = join(root, 'outside'); fs.mkdirSync(outside);
  const taskDirectory = join(root, '.mdd/tasks', task.identity.name);
  fs.renameSync(taskDirectory, join(root, 'original-task'));
  fs.symlinkSync(outside, taskDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.save({ runID: binding.runID, phase: 'mdd-plan' }, 'New plan.'), ArtifactWriteError);
  assert.deepEqual(fs.readdirSync(outside), []);
});

for (const fault of ['partial-write', 'manifest-write', 'readback']) {
  test(`PF-2: ${fault} leaves evidence inspectable but never confirms an unknown publication`, async t => {
    const { root, binding, task } = fixture(t);
    const manifestFile = join(root, '.mdd/tasks', task.identity.name, 'manifest.json');
    const originalManifest = fs.readFileSync(manifestFile, 'utf8');
    const write = fs.writeFileSync; const update = LocalFiles.prototype.update; const read = fs.readFileSync;
    let mutations = 0;
    let artifactFD;
    const open = fs.openSync;
    fs.openSync = function (file, ...args) {
      const fd = open.call(this, file, ...args);
      if (String(file).includes('artifact-') && args[0] === 'wx') artifactFD = fd;
      return fd;
    };
    if (fault === 'partial-write') fs.writeFileSync = function (file, content, ...args) {
      if (file === artifactFD) { mutations++; write.call(this, file, 'Partial bytes.', ...args); throw new Error('Disk full.'); }
      return write.call(this, file, content, ...args);
    };
    if (fault === 'manifest-write') LocalFiles.prototype.update = function (name, ...args) {
      if (name.endsWith('/manifest.json')) { mutations++; throw new Error('Manifest refused.'); }
      return update.call(this, name, ...args);
    };
    if (fault === 'readback') fs.readFileSync = function (file, ...args) {
      if (file === artifactFD) { mutations++; return Buffer.from('Readback differs.'); }
      return read.call(this, file, ...args);
    };
    try {
      await assert.rejects(new ArtifactStore(root, 'local', undefined, task).save({ runID: binding.runID, phase: 'mdd-plan' }, 'Exact complete content.'), error => {
        assert.ok(error instanceof ArtifactWriteError);
        assert.deepEqual(error.attempts.map(item => [item.backend, item.status]), [['local', 'unknown']]);
        assert.equal(fs.existsSync(join(root, error.attempts[0].ref.path)), true);
        return true;
      });
    } finally {
      fs.openSync = open; fs.writeFileSync = write; fs.readFileSync = read; LocalFiles.prototype.update = update;
    }
    assert.equal(mutations, 1, 'unclear mutation never retries');
    assert.equal(fs.readFileSync(manifestFile, 'utf8'), originalManifest);
  });
}
