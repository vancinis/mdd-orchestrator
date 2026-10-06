import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerFence } from '../dist/worker-fence.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-read-fence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'own.txt'), 'own'); writeFileSync(join(root, 'other.txt'), 'other');
  const fence = new WorkerFence(root, 'project', 20);
  let active = true;
  const assignment = { phase: 'mdd-explore', taskID: 'E1', ownerEpoch: 3, reads: [{ root, files: ['own.txt'] }] };
  fence.admit('parent', 'message', 'native', assignment, () => active);
  const child = { id: 'child', parentID: 'parent', projectID: 'project', location: { directory: root } };
  const progress = { sessionID: 'parent', assistantMessageID: 'message', id: 'native', metadata: { sessionID: 'child', status: 'running' } };
  return { root, fence, child, progress, assignment, stop: () => { active = false; } };
}

test('delayed exact progress releases a pre-action gate; scope remains exact', async t => {
  const f = fixture(t);
  const pending = f.fence.guard(f.child, 'read', { path: join(f.root, 'own.txt') }, true);
  f.fence.progress(f.progress);
  await pending;
  await f.fence.guard(f.child, 'grep', { path: 'own.txt', pattern: 'own', literal: true }, true);
  await assert.rejects(f.fence.guard(f.child, 'read', { path: 'other.txt' }, true), /scope/);
});

for (const tool of ['write', 'edit', 'patch', 'shell', 'execute', 'format', 'subagent', 'opencode_session_move', 'custom', 'mcp_read', 'glob'])
  test(`native ${tool} is denied despite progress and caller permissions`, async t => {
    const f = fixture(t); f.fence.progress(f.progress);
    await assert.rejects(f.fence.guard(f.child, tool, { path: 'own.txt' }, true), /denies/);
  });

for (const kind of ['dropped', 'wrong-parent', 'wrong-message', 'wrong-call', 'stale', 'conflict', 'manual', 'stream-failed', 'reload', 'moved-project', 'moved-location'])
  test(`${kind} progress never authorizes a read`, async t => {
    const f = fixture(t); const event = structuredClone(f.progress);
    if (kind === 'wrong-parent') event.sessionID = 'other';
    if (kind === 'wrong-message') event.assistantMessageID = 'other';
    if (kind === 'wrong-call') event.id = 'other';
    if (kind === 'stale') f.stop();
    if (kind !== 'dropped' && kind !== 'reload') f.fence.progress(event);
    if (kind === 'conflict') f.fence.progress({ ...event, metadata: { status: 'running', sessionID: 'another-child' } });
    if (kind === 'manual') f.child.id = 'manual';
    if (kind === 'stream-failed') f.fence.close();
    if (kind === 'reload') f.fence = new WorkerFence(f.root, 'project', 1);
    if (kind === 'moved-project') f.child.projectID = 'other';
    if (kind === 'moved-location') f.child.location.directory = dirnameFixture(f.root);
    await assert.rejects(f.fence.guard(f.child, 'read', { path: 'own.txt' }, true));
  });
function dirnameFixture(root) { return join(root, 'elsewhere'); }

test('one child cannot bind two admitted native calls; settled tombstones refuse late actions', async t => {
  const f = fixture(t); f.fence.progress(f.progress);
  f.fence.admit('parent', 'message', 'second', f.assignment, () => true);
  f.fence.progress({ ...f.progress, id: 'second' });
  await assert.rejects(f.fence.guard(f.child, 'read', { path: 'own.txt' }, true));
  f.fence.settle('native'); f.fence.progress(f.progress);
  await assert.rejects(f.fence.guard(f.child, 'read', { path: 'own.txt' }, true));
});

test('a timed-out unknown child remains quarantined after late progress and parent release', async t => {
  const f = fixture(t);
  await assert.rejects(f.fence.guard(f.child, 'read', { path: 'own.txt' }, true), /binding/);
  f.fence.progress(f.progress);
  await assert.rejects(f.fence.guard(f.child, 'read', { path: 'own.txt' }, false), /binding/);
  assert.throws(() => f.fence.complete('parent', 'message', 'native', 'child'));
});

test('conflicting progress quarantines both named children after parent release', async t => {
  const f = fixture(t); f.fence.progress(f.progress);
  f.fence.progress({ ...f.progress, metadata: { status: 'running', sessionID: 'other-child' } });
  for (const id of ['child', 'other-child'])
    await assert.rejects(f.fence.guard({ ...f.child, id }, 'read', { path: 'own.txt' }, false));
});

test('unknown paging, directory/escaped queries, hardlink aliases and undeclared instruction reads deny', async t => {
  const f = fixture(t); f.fence.progress(f.progress);
  for (const args of [{ path: 'own.txt', arbitrary: true }, { path: 'own.txt', offset: '1' }, { path: '.' }, { path: '../own.txt' }])
    await assert.rejects(f.fence.guard(f.child, 'read', args, true));
  for (const args of [{ path: 'own.txt', pattern: '.', literal: false }, { path: '.', pattern: 'own', literal: true },
    { path: 'own.txt', pattern: '-e', literal: true }, { path: 'own.txt', pattern: 'own', include: '*', literal: true }])
    await assert.rejects(f.fence.guard(f.child, 'grep', args, true));
  linkSync(join(f.root, 'own.txt'), join(f.root, 'alias.txt'));
  await assert.rejects(f.fence.guard(f.child, 'read', { path: 'own.txt' }, true), /exact/);
  mkdirSync(join(f.root, 'nested')); writeFileSync(join(f.root, 'nested', 'file.txt'), 'file');
  writeFileSync(join(f.root, 'nested', 'AGENTS.md'), 'not in scope');
  const nested = new WorkerFence(f.root, 'project');
  nested.admit('parent', 'message', 'nested', { ...f.assignment, reads: [{ root: f.root, files: ['nested/file.txt'] }] }, () => true);
  nested.progress({ ...f.progress, id: 'nested' });
  await assert.rejects(nested.guard(f.child, 'read', { path: 'nested/file.txt' }, true), /instruction discovery/);
});
