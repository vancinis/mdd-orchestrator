import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { ProgressGuard } from '../dist/progress.js';
import { answers, reportDocument } from './adapter-fixture.mjs';

function fixture(t, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-exploration-workers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(root, name), name);
  const runtime = { sessionID: 'parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const checkpoint = new CheckpointStore(root), ownership = new RunOwnershipStore(root);
  const inspect = { parent: async () => {}, result: async (_r, _c, _p, output) => output, stopped: async () => true };
  const options = { checkpoint, ownership, progress: new ProgressGuard(root), workers: { enabled },
    workerCapability: { phase: 'mdd-explore', readOnly: true } };
  const items = ['a', 'b'].map((name, index) => ({ id: `E${index + 1}`, purpose: `Inspect ${name} independently`,
    dependsOn: [], independent: true, complete: true, reads: [{ root, files: [`${name}.txt`] }] }));
  return { root, runtime, checkpoint, ownership, inspect, options, items, runner: new PhaseRunner(inspect, options) };
}

for (const contextual of [false, true]) test(`independent exploration overlaps and aggregates once (${contextual ? 'contextual' : 'main'})`, async t => {
  const f = fixture(t);
  if (contextual) await f.runner.explore({ purpose: 'Inspect both components', workItems: f.items }, f.runtime);
  else await f.runner.start({ requirements: 'Explore the two components', preflight: { answers: { ...answers, certainty: 'not-sure' } },
    exploration: { workItems: f.items } }, f.runtime, { requirementsConfirmed: true, userMessageID: 'user' });
  const ready = f.runner.status('parent');
  assert.equal(ready.tasks?.length, 2);
  const calls = ['one', 'two'].map(callID => ({ sessionID: 'parent', callID }));
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(calls[index], task)));
  assert.equal(f.runner.workerAssignment(calls[0]).phase, 'mdd-explore');
  await f.runner.after(calls[1], args[1], reportDocument({ evidenceSummary: 'Second findings', artifact: 'Second component findings.' }));
  assert.equal(f.runner.status('parent').phase, 'mdd-explore');
  assert.deepEqual(f.runner.status('parent').workerProgress.completed, ['E2']);
  await f.runner.after(calls[0], args[0], reportDocument({ evidenceSummary: 'First findings', artifact: 'First component findings.' }));
  const done = f.runner.status('parent');
  if (!contextual) assert.equal(done.workflow.results.filter(result => result.phase === 'mdd-explore').length, 1);
  assert.equal(f.checkpoint.readExploration('parent').state, 'settled');
  await assert.rejects(f.runner.after(calls[0], args[0], 'replay'));
});

for (const contextual of [false, true]) test(`ineligible exploration stays singular and preserves declared items (${contextual ? 'contextual' : 'main'})`, async t => {
  for (const kind of ['disabled', 'incomplete', 'dependent', 'legacy', 'legacy-store', 'read-only-store']) {
    const f = fixture(t, kind !== 'disabled');
    if (kind === 'incomplete') delete f.items[1].complete;
    if (kind === 'dependent') f.items[1].dependsOn = ['E1'];
    if (kind === 'legacy-store') f.checkpoint.readExploration = undefined;
    if (['legacy-store', 'read-only-store'].includes(kind)) f.checkpoint.writeExploration = undefined;
    const workItems = kind === 'legacy' ? undefined : f.items;
    if (contextual) await f.runner.explore({ purpose: 'Inspect both', ...(workItems ? { workItems } : {}) }, f.runtime);
    else await f.runner.start({ requirements: 'Explore both', preflight: { answers: { ...answers, certainty: 'not-sure' } },
      ...(workItems ? { exploration: { workItems } } : {}) }, f.runtime, { requirementsConfirmed: true, userMessageID: 'user' });
    assert.equal(f.runner.status('parent').tasks, undefined);
    assert.equal(f.runner.status('parent').task.subagent_type, 'mdd-explore');
    const args = await f.runner.before({ sessionID: 'parent', callID: 'serial' }, f.runner.status('parent').task);
    if (workItems) assert.ok(args.prompt.includes(JSON.stringify(workItems)));
  }
});

test('replacing settled exploration archives every complete member report', async t => {
  const f = fixture(t);
  await f.runner.explore({ purpose: 'Inspect both', workItems: f.items }, f.runtime);
  const ready = f.runner.status('parent');
  const calls = ['one', 'two'].map(callID => ({ sessionID: 'parent', callID }));
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(calls[index], task)));
  for (const index of [1, 0]) await f.runner.after(calls[index], args[index], reportDocument({
    evidenceSummary: `Findings ${index}`, artifact: `Complete evidence ${index}: ${'x'.repeat(9000)}` }));
  const old = f.checkpoint.readExploration('parent');
  assert.match(old.aggregate, /Complete member evidence is retained/);
  await f.runner.explore({ purpose: 'Another investigation', workItems: f.items }, f.runtime);
  const hash = createHash('sha256').update(`exploration-result:${old.id}`).digest('hex');
  const archived = JSON.parse(readFileSync(join(f.root, '.mdd', `checkpoint-${hash}.json`), 'utf8'));
  assert.deepEqual(archived, old);
  assert.deepEqual(archived.workerState.completed.map(member => member.taskID), ['E1', 'E2']);
  assert.notEqual(f.checkpoint.readExploration('parent').id, old.id);
});

for (const contextual of [false, true]) for (const kind of ['failure', 'unknown', 'transport', 'malformed', 'checkpoint', 'owner'])
  test(`exploration ${kind} retains success and refuses restart/replay (${contextual ? 'contextual' : 'main'})`, async t => {
    const f = fixture(t);
    if (contextual) await f.runner.explore({ purpose: 'Inspect both components', workItems: f.items }, f.runtime);
    else await f.runner.start({ requirements: 'Explore both', preflight: { answers: { ...answers, certainty: 'not-sure' } },
      exploration: { workItems: f.items } }, f.runtime, { requirementsConfirmed: true, userMessageID: 'user' });
    const ready = f.runner.status('parent');
    const calls = ['one', 'two'].map(callID => ({ sessionID: 'parent', callID }));
    const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(calls[index], task)));
    await f.runner.after(calls[0], args[0], reportDocument({ evidenceSummary: 'First findings', artifact: 'Retained first findings.' }));
    if (kind === 'unknown') f.inspect.stopped = async () => false;
    if (kind === 'transport') f.inspect.result = async () => { throw new Error('transport'); };
    const originalWrite = f.checkpoint.writeExploration.bind(f.checkpoint);
    if (kind === 'checkpoint') f.checkpoint.writeExploration = () => { throw new Error('disk full'); };
    if (kind === 'owner') f.ownership.settleWorker = () => { throw new Error('owner fault'); };
    const text = kind === 'malformed' ? 'not a report' : reportDocument({ outcome: kind === 'failure' ? 'failed' : 'passed',
      evidenceSummary: 'Second findings', artifact: 'Second findings.' });
    if (kind === 'failure') await f.runner.after(calls[1], args[1], text);
    else await assert.rejects(f.runner.after(calls[1], args[1], text));
    f.checkpoint.writeExploration = originalWrite;
    assert.equal(f.runner.status('parent').state, 'blocked');
    assert.ok(f.checkpoint.readExploration('parent').workerState.completed.some(member => member.taskID === 'E1'));
    const restarted = new PhaseRunner(f.inspect, f.options);
    assert.equal((await restarted.restore(f.runtime)).restored, false);
    assert.equal(restarted.status('parent').state, 'recovery-blocked');
    await assert.rejects(restarted.before({ sessionID: 'parent', callID: 'replay' }, ready.tasks[0]), /replay|authority/);
    await assert.rejects(restarted.explore({ purpose: 'Again', workItems: f.items }, f.runtime), /Retained/);
  });

test('contextual exploration on an accepted run leaves the main plan and approval unchanged', async t => {
  const f = fixture(t);
  await f.runner.start({ requirements: 'Implement later', preflight: { answers } }, f.runtime,
    { requirementsConfirmed: true, userMessageID: 'user' });
  const initial = f.runner.status('parent').workflow;
  await f.runner.explore({ purpose: 'Inspect both first', workItems: f.items }, f.runtime);
  const ready = f.runner.status('parent');
  const calls = ['one', 'two'].map(callID => ({ sessionID: 'parent', callID }));
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(calls[index], task)));
  for (const index of [1, 0]) await f.runner.after(calls[index], args[index], reportDocument({ evidenceSummary: 'Findings', artifact: 'Contextual findings.' }));
  assert.deepEqual(f.runner.status('parent').workflow, initial);
  // Every run opens with its own main exploration; a contextual one never consumes or moves it.
  assert.equal(f.runner.status('parent').phase, 'mdd-explore');
  assert.equal(f.runner.status('parent').contexts.length, 1);
});
