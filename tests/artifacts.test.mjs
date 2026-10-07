import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArtifactStore, ArtifactWriteError, ARTIFACT_MAX_BYTES, PHASE_PATHS } from '../dist/artifacts.js';
import { EngramHttp } from '../dist/engram-http.js';
import { memoryServer } from './adapter-fixture.mjs';

const key = { runID: 'run-one', phase: 'mdd-plan' };
const text = '# Plan\n\nPreserve exact Unicode: café ✓\n';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdd-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
async function memory(t, root, change) {
  const server = await memoryServer(t, change);
  server.binding.directory = root;
  return { ...server, client: new EngramHttp(server.endpoint, server.binding) };
}

for (const mode of ['none', 'openspec', 'engram', 'both']) {
  test(`artifacts: ${mode} exact roundtrip and selected backends only`, async t => {
    const root = fixture(t);
    const { client, writes } = await memory(t, root);
    const store = new ArtifactStore(root, mode, client);
    assert.deepEqual(fs.readdirSync(root), []);
    const saved = await store.save(key, text);
    assert.equal(saved.content, text);
    assert.equal(await store.read(saved.ref), text);
    assert.equal(saved.ref.bytes, Buffer.byteLength(text));
    assert.match(saved.ref.digest, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(saved.ref), true);
    assert.equal(writes.length, ['engram', 'both'].includes(mode) ? 1 : 0);
    assert.equal(fs.existsSync(path.join(root, 'openspec')), ['openspec', 'both'].includes(mode));
    if (writes.length) {
      assert.equal(writes[0].type, 'mdd-artifact');
      assert.equal(writes[0].topic_key, undefined);
      assert.equal(writes[0].session_id, 'ses_parent');
      assert.equal(writes[0].project, 'mdd-test');
      assert.equal(JSON.parse(writes[0].content).content, text);
    }
    await assert.rejects(store.read({ ...saved.ref }), /Unissued/);
    await assert.rejects(store.read({ ...saved.ref, path: '../secret', observationID: 9 }), /Unissued/);
    await assert.rejects(new ArtifactStore(root, mode, client).read(saved.ref), /Unissued/);
  });
}

test('artifacts: none needs no existing root or memory client and retains only live handoff', async () => {
  const store = new ArtifactStore(path.join(os.tmpdir(), 'nonexistent-mdd-artifact-root'), 'none');
  const saved = await store.save(key, text);
  assert.equal(saved.ref.path, undefined);
  assert.equal(saved.ref.observationID, undefined);
  assert.equal(await store.read(saved.ref), text);
});

for (const [phase, name] of Object.entries(PHASE_PATHS)) {
  test(`artifacts: exact ${phase} path`, async t => {
    const root = fixture(t);
    const store = new ArtifactStore(root, 'openspec');
    const saved = await store.save({ runID: 'run-one', phase, ...(phase === 'mdd-spec' ? { domain: 'checkout' } : {}) }, text);
    assert.equal(saved.ref.path, `openspec/changes/run-one/${name.replace('{domain}', 'checkout')}`);
    assert.equal(fs.readFileSync(path.join(root, saved.ref.path), 'utf8'), text);
    assert.equal(await store.read(saved.ref), text);
  });
}

test('artifacts: side explorations are isolated and immutable content is idempotent', async t => {
  const root = fixture(t);
  const store = new ArtifactStore(root, 'openspec');
  const side = { runID: 'run-one', phase: 'mdd-explore', explorationID: 'side-one' };
  const saved = await store.save(side, text);
  assert.equal(saved.ref.path, 'openspec/changes/run-one/explorations/side-one/exploration.md');
  assert.equal((await store.save(side, text)).ref.path, saved.ref.path);
  await assert.rejects(store.save(side, 'different'), ArtifactWriteError);
  assert.equal(await store.read(saved.ref), text);
});

for (const mode of ['openspec', 'engram', 'both']) {
  test(`artifacts: ${mode} batches retain distinct immutable identities and matching envelopes`, async t => {
    const root = fixture(t);
    const { client, writes } = await memory(t, root);
    const store = new ArtifactStore(root, mode, client);
    const first = await store.save({ runID: 'run-one', phase: 'mdd-apply', batchID: 'batch-one' }, 'First batch.');
    const second = await store.save({ runID: 'run-one', phase: 'mdd-apply', batchID: 'batch-two' }, 'Second batch.');
    assert.equal(await store.read(first.ref), 'First batch.');
    assert.equal(await store.read(second.ref), 'Second batch.');
    if (mode !== 'engram') {
      assert.equal(first.ref.path, 'openspec/changes/run-one/apply/batch-one/apply-progress.md');
      assert.notEqual(first.ref.path, second.ref.path);
      await assert.rejects(store.save({ runID: 'run-one', phase: 'mdd-apply', batchID: 'batch-one' }, 'Overwrite.'), ArtifactWriteError);
    }
    if (mode !== 'openspec') {
      assert.notEqual(first.ref.observationID, second.ref.observationID);
      assert.deepEqual(writes.slice(0, 2).map(item => JSON.parse(item.content).batchID), ['batch-one', 'batch-two']);
    }
  });
}

for (const bad of [
  { ...key, runID: '../escape' }, { ...key, runID: 'CON' }, { ...key, runID: 'con' },
  { ...key, runID: 'run.' }, { ...key, runID: 'a/b' }, { ...key, runID: 'a\\b' },
  { ...key, runID: 'a:b' }, { ...key, runID: 'a'.repeat(65) }, { ...key, phase: 'toString' },
  { ...key, phase: 'mdd-spec' }, { ...key, domain: 'checkout' },
  { ...key, explorationID: 'side' }, { ...key, extra: true },
  { ...key, phase: 'mdd-spec', domain: '../escape' },
  { ...key, phase: 'mdd-explore', explorationID: '../escape' },
  { ...key, batchID: 'batch-one' }, { ...key, phase: 'mdd-apply', batchID: '../escape' },
]) {
  test(`artifacts: reject invalid identity ${JSON.stringify(bad)}`, async t => {
    const root = fixture(t);
    await assert.rejects(new ArtifactStore(root, 'openspec').save(bad, text));
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

test('artifacts: bound content size, encoding and constructor validation', async t => {
  const root = fixture(t);
  const store = new ArtifactStore(root, 'openspec');
  for (const value of ['', ' \n', undefined, '\ud800', 'é'.repeat(ARTIFACT_MAX_BYTES / 2 + 1)]) {
    await assert.rejects(store.save(key, value));
  }
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal((await store.save(key, 'x'.repeat(ARTIFACT_MAX_BYTES))).ref.bytes, ARTIFACT_MAX_BYTES);
  assert.throws(() => new ArtifactStore(root, 'other'));
  assert.throws(() => new ArtifactStore(root, 'engram'));
  assert.throws(() => new ArtifactStore(root, 'both'));
  const { client } = await memory(t, root);
  assert.throws(() => new ArtifactStore(path.join(root, 'other'), 'engram', client), /binding/);
});

test('artifacts: disk divergence cannot be hidden by valid Engram in both', async t => {
  const root = fixture(t);
  const { client } = await memory(t, root);
  const store = new ArtifactStore(root, 'both', client);
  const saved = await store.save(key, text);
  fs.writeFileSync(path.join(root, saved.ref.path), 'tampered');
  await assert.rejects(store.read(saved.ref), /mismatch/);
});

test('artifacts: Engram divergence cannot be hidden by valid disk in both', async t => {
  const root = fixture(t);
  const { client, writes } = await memory(t, root);
  const store = new ArtifactStore(root, 'both', client);
  const saved = await store.save(key, text);
  writes[0].content = 'tampered';
  await assert.rejects(store.read(saved.ref), /mismatch/);
});

for (const field of ['project', 'session_id', 'type', 'scope', 'title', 'deleted_at']) {
  test(`artifacts: persisted read rejects changed observation ${field}`, async t => {
    const root = fixture(t);
    const { client, writes } = await memory(t, root);
    const store = new ArtifactStore(root, 'engram', client);
    const saved = await store.save(key, text);
    writes[0][field] = 'wrong';
    await assert.rejects(store.read(saved.ref), /binding/);
  });
}

test('artifacts: session binding is rechecked on reads and dedicated saves never upsert', async t => {
  const root = fixture(t);
  const { client, binding, writes } = await memory(t, root);
  const store = new ArtifactStore(root, 'engram', client);
  const first = await store.save(key, text);
  const second = await store.save(key, text);
  assert.notEqual(first.ref.recordID, second.ref.recordID);
  assert.notEqual(first.ref.observationID, second.ref.observationID);
  assert.notEqual(writes[0].title, writes[1].title);
  binding.project = 'wrong';
  await assert.rejects(store.read(first.ref), /binding/);
  await assert.rejects(store.save(key, text), ArtifactWriteError);
  assert.equal(writes.length, 2);
});

for (const fault of ['write', 'unknown', 'readback']) {
  test(`artifacts: both reports disk confirmation and Engram ${fault} without retry`, async t => {
    const root = fixture(t);
    const { client, writes } = await memory(t, root, (req, reply) => {
      if (req.method === 'POST' && fault === 'write') reply.status = 500;
      if (req.method === 'POST' && fault === 'unknown') reply.data.status = 'pending';
      if (req.url.startsWith('/observations/') && fault === 'readback') reply.data.content = 'wrong';
    });
    await assert.rejects(new ArtifactStore(root, 'both', client).save(key, text), error => {
      assert.ok(error instanceof ArtifactWriteError);
      assert.deepEqual(error.attempts.map(a => [a.backend, a.status]), [['openspec', 'confirmed'], ['engram', 'unknown']]);
      assert.equal(error.attempts[1].ref.observationID, fault === 'write' ? undefined : 1);
      assert.equal(fs.readFileSync(path.join(root, error.attempts[0].ref.path), 'utf8'), text);
      assert.equal(writes.length, 1);
      assert.ok(!error.message.includes(text));
      return true;
    });
  });
}

test('artifacts: both stops on disk conflict without contacting Engram', async t => {
  const root = fixture(t);
  const { client, writes } = await memory(t, root);
  await new ArtifactStore(root, 'openspec').save(key, text);
  await assert.rejects(new ArtifactStore(root, 'both', client).save(key, 'different'), error => {
    assert.equal(error.attempts.length, 1);
    assert.equal(error.attempts[0].backend, 'openspec');
    return true;
  });
  assert.equal(writes.length, 0);
});

test('artifacts: rejects linked directories including root ancestors', async t => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.symlinkSync(outside, path.join(root, 'openspec'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(new ArtifactStore(root, 'openspec').save(key, text), ArtifactWriteError);
  assert.deepEqual(fs.readdirSync(outside), []);
  const linked = path.join(root, 'linked');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  fs.mkdirSync(path.join(outside, 'nested'));
  await assert.rejects(new ArtifactStore(path.join(linked, 'nested'), 'openspec').save(key, text));
  assert.deepEqual(fs.readdirSync(path.join(outside, 'nested')), []);
});

test('artifacts: rejects hardlinks, nonregular files and oversized disk reads', async t => {
  const root = fixture(t);
  const store = new ArtifactStore(root, 'openspec');
  const saved = await store.save(key, text);
  const target = path.join(root, saved.ref.path);
  fs.linkSync(target, path.join(root, 'hardlink'));
  await assert.rejects(store.read(saved.ref), /Unsafe/);
  await assert.rejects(store.save(key, text));
  fs.unlinkSync(path.join(root, 'hardlink'));
  fs.writeFileSync(target, 'x'.repeat(ARTIFACT_MAX_BYTES + 1));
  await assert.rejects(store.read(saved.ref), /Unsafe/);
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  await assert.rejects(store.save(key, text));
});

test('artifacts: rejects a symlink artifact file without modifying its target', async t => {
  const root = fixture(t);
  const store = new ArtifactStore(root, 'openspec');
  const saved = await store.save(key, text);
  const target = path.join(root, saved.ref.path);
  const original = path.join(root, 'original.md');
  fs.renameSync(target, original);
  try { fs.symlinkSync(original, target, 'file'); }
  catch (error) {
    if (error.code === 'EPERM') { t.skip('File symlink creation requires Windows privilege.'); return; }
    throw error;
  }
  await assert.rejects(store.read(saved.ref), /Unsafe/);
  await assert.rejects(store.save(key, text));
  assert.equal(fs.readFileSync(original, 'utf8'), text);
});

test('artifacts: maximum escaped content roundtrips through bounded HTTP envelopes', async t => {
  const root = fixture(t);
  const { client } = await memory(t, root);
  const store = new ArtifactStore(root, 'engram', client);
  const content = 'x' + '\u0000'.repeat(ARTIFACT_MAX_BYTES - 1);
  const saved = await store.save(key, content);
  assert.equal(await store.read(saved.ref), content);
});

test('artifacts: bounded isolated storage smoke with all phases and both backends', async t => {
  const root = fixture(t);
  const { client, writes } = await memory(t, root);
  const store = new ArtifactStore(root, 'both', client);
  for (const phase of Object.keys(PHASE_PATHS)) {
    const result = await store.save({ runID: 'smoke', phase, ...(phase === 'mdd-spec' ? { domain: 'product' } : {}) }, `${phase}\n${text}`);
    assert.equal(await store.read(result.ref), result.content);
  }
  // The eight phases plus the mdd-risk assessment, which is persisted like a phase artifact.
  assert.equal(writes.length, Object.keys(PHASE_PATHS).length);
  assert.equal(writes.length, 9);
});
