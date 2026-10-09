import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore, CheckpointStorageError, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { validateWorkerState } from '../dist/worker-state.js';
import { projectTargetTransfer } from '../dist/transfer.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { ProgressGuard } from '../dist/progress.js';
import { answers, reportDocument, throughRiskStop, structuredTraceFixture as traceFixture, ARTIFACT_TEXT, SUMMARY_TEXT } from './adapter-fixture.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-worker-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.ts'), 'a'); writeFileSync(join(root, 'src/b.ts'), 'b');
  const runtime = { sessionID: 'workers-parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const checkpoint = new CheckpointStore(root); const ownership = new RunOwnershipStore(root); const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const options = { checkpoint, ownership, progress, workers: { enabled: true }, workerCapability: { confined: true }, ...extra };
  const runner = new PhaseRunner(inspect, options);
  await runner.start({ preflight: { answers }, requirements: 'Implement independent tasks.' }, runtime,
    { requirementsConfirmed: true, userMessageID: 'user-workers' });
  const ready = await throughRiskStop(runner, runtime.sessionID, 'low', { release: true });
  const planCall = { sessionID: runtime.sessionID, callID: 'plan' }; const args = await runner.before(planCall, ready.task);
  const trace = traceFixture(); const base = trace.deliverables[0];
  trace.deliverables = ['a', 'b'].map((name, index) => ({ ...base, id: `T${index + 1}`, path: `src/${name}.ts`, dependsOn: [],
    parallel: { complete: true, reads: [], writes: [`src/${name}.ts`] } }));
  if (extra.third || extra.unsafeThird) trace.deliverables.push({ ...base, id: 'T3', path: 'src/a.ts', dependsOn: ['T1', 'T2'],
    parallel: { complete: true, reads: [], writes: ['src/a.ts'] } });
  if (extra.unsafeThird) delete trace.deliverables.at(-1).parallel;
  if (extra.serialFirst) trace.deliverables.unshift({ ...base, id: 'T0', path: 'src/a.ts', dependsOn: [] });
  for (const step of trace.deliverables) step.checks = [{ id: `${step.id}-check`, command: 'npm test', requirement: 'required' }];
  await runner.after(planCall, args, reportDocument({ evidenceSummary: SUMMARY_TEXT, artifact: ARTIFACT_TEXT, ...trace }));
  runner.releaseSettled(runtime.sessionID, 'plan');
  const calls = ['one', 'two'].map(callID => ({ sessionID: runtime.sessionID, callID }));
  const text = (index, outcome = 'passed') => reportDocument({ outcome, evidenceSummary: `Finished task ${index + 1}.`,
    artifact: `Task ${index + 1} implementation evidence.`, completed: outcome === 'passed' ? [`T${index + 1}`] : [],
    changes: [`src/${index ? 'b' : 'a'}.ts`], checks: [] });
  return { root, runtime, checkpoint, ownership, progress, inspect, options, runner, calls, text };
}

test('both foreground members admit before results; reverse completion retains one phase and owner', async t => {
  const f = await fixture(t); const status = f.runner.status(f.runtime.sessionID);
  assert.equal(status.tasks.length, 2);
  assert.equal(status.task, undefined);
  const dispatched = await Promise.all(status.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  const assignment = f.runner.workerAssignment(f.calls[0]);
  assert.equal(assignment.taskID, 'T1'); assignment.scope.writes.push('unsafe');
  assert.deepEqual(f.runner.workerAssignment(f.calls[0]).scope.writes, ['src/a.ts']);
  const barrier = deferred(); const inspecting = deferred();
  f.inspect.result = async (_runtime, call, _phase, output) => { if (call.callID === 'two') { inspecting.resolve(); await barrier.promise; } return output; };
  const second = f.runner.after(f.calls[1], dispatched[1], f.text(1));
  await inspecting.promise;
  assert.equal(f.ownership.read(status.runID).workers.filter(member => member.state === 'pending').length, 2);
  barrier.resolve(); await second;
  assert.equal(f.runner.workerAssignment(f.calls[1]), undefined);
  f.runner.releaseSettled(f.runtime.sessionID, 'two');
  assert.equal(f.runner.status(f.runtime.sessionID).phase, 'mdd-apply');
  assert.equal(f.runner.status(f.runtime.sessionID).workflow.results.length, 2);
  assert.equal(f.ownership.read(status.runID).state, 'reserved');
  await assert.rejects(f.runner.after(f.calls[1], dispatched[1], f.text(1)), /match|settled|consumed/);
  await assert.rejects(f.runner.after(f.calls[0], { ...dispatched[0], prompt: 'wrong' }, f.text(0)), /match/);
  await f.runner.after(f.calls[0], dispatched[0], f.text(0));
  const done = f.runner.status(f.runtime.sessionID);
  assert.equal(done.phase, 'mdd-verify');
  assert.equal(done.workflow.results.length, 4);
  const results = done.workflow.results.filter(result => result.phase === 'mdd-apply');
  assert.deepEqual(results.map(result => result.completed), [['T1'], ['T2']]);
  assert.equal(new Set(results.map(result => result.batchID)).size, 2);
  const saved = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  // Exploration and plan artifacts precede the two Apply batch artifacts.
  assert.deepEqual(saved.data.dependencies.slice(2).map(item => item.batchID), results.map(result => result.batchID));
  assert.ok(saved.data.dependencies[2].content.includes('Task 1'));
  assert.ok(saved.data.dependencies[3].content.includes('Task 2'));
  assert.equal(f.ownership.read(status.runID).state, 'idle');
});

test('each parallel prompt assigns only its own held deliverable without contradictory context', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  for (const [index, task] of ready.tasks.entries()) {
    const args = await f.runner.before(f.calls[index], task);
    const applicable = JSON.parse(args.prompt.match(/^Applicable deliverables: (.+)$/m)[1]);
    assert.deepEqual(applicable.map(step => step.id), [`T${index + 1}`]);
    assert.match(args.prompt, new RegExp(`completed=\\["T${index + 1}"\\]`));
  }
});

test('serial fallback selects exactly one step and preserves the full plan as context', async t => {
  const f = await fixture(t, { workers: { enabled: false } });
  const first = f.runner.status(f.runtime.sessionID);
  const args = await f.runner.before(f.calls[0], first.task);
  assert.deepEqual(JSON.parse(args.prompt.match(/^Applicable deliverables: (.+)$/m)[1]).map(step => step.id), ['T1']);
  await f.runner.after(f.calls[0], args, f.text(0));
  f.runner.releaseSettled(f.runtime.sessionID, f.calls[0].callID);
  const next = f.runner.status(f.runtime.sessionID);
  assert.equal(next.phase, 'mdd-apply'); assert.equal(next.tasks, undefined);
  const second = await f.runner.before(f.calls[1], next.task);
  assert.deepEqual(JSON.parse(second.prompt.match(/^Applicable deliverables: (.+)$/m)[1]).map(step => step.id), ['T2']);
  await f.runner.after(f.calls[1], second, f.text(1));
  assert.equal(f.runner.status(f.runtime.sessionID).phase, 'mdd-verify');
});

test('ordered publication fault retains both reports without publishing a partial workflow prefix', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.after(f.calls[1], args[1], f.text(1));
  const write = f.checkpoint.write.bind(f.checkpoint);
  f.checkpoint.write = (parent, checkpoint, ...rest) => {
    if (checkpoint.events.some(event => event.kind === 'result' && event.result.phase === 'mdd-apply'))
      throw new CheckpointStorageError('Injected final publication refusal.');
    return write(parent, checkpoint, ...rest);
  };
  await assert.rejects(f.runner.after(f.calls[0], args[0], f.text(0)), /publication|checkpoint|unconfirmed/i);
  const blocked = f.runner.status(f.runtime.sessionID);
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.tasks, undefined); assert.equal(blocked.task, undefined);
  assert.equal(blocked.workflow.results.length, 2);
  const saved = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  assert.deepEqual(saved.data.workerState.completed.map(member => member.text), [f.text(0), f.text(1)]);
  assert.equal(saved.events.filter(event => event.kind === 'result').length, 2);
  assert.equal(saved.attempt.id, saved.data.workerState.batch.id);
  assert.throws(() => f.runner.reset(f.runtime.sessionID, 'phase'), /durability|checkpoint|unconfirmed/i);
});

test('mixed ordinary serial and scoped parallel progress keeps strict plan order and the full file union', async t => {
  const f = await fixture(t, { serialFirst: true, unsafeThird: true });
  const call = { sessionID: f.runtime.sessionID, callID: 'serial-first' };
  const first = await f.runner.before(call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.after(call, first, reportDocument({ completed: ['T0'], evidenceSummary: 'First serial step.', artifact: 'First evidence.',
    changes: ['src/a.ts'], checks: [] }));
  f.runner.releaseSettled(f.runtime.sessionID, call.callID);
  const ready = f.runner.status(f.runtime.sessionID); assert.equal(ready.tasks.length, 2);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.after(f.calls[1], args[1], f.text(1));
  await f.runner.after(f.calls[0], args[0], f.text(0));
  const next = f.runner.status(f.runtime.sessionID); assert.equal(next.tasks, undefined); assert.equal(next.phase, 'mdd-apply');
  const last = { sessionID: f.runtime.sessionID, callID: 'serial-last' };
  const third = await f.runner.before(last, next.task);
  assert.deepEqual(JSON.parse(third.prompt.match(/^Applicable deliverables: (.+)$/m)[1]).map(step => step.id), ['T3']);
  await f.runner.after(last, third, reportDocument({ completed: ['T3'], evidenceSummary: 'Last serial step.', artifact: 'Last evidence.',
    changes: ['src/a.ts'], checks: [] }));
  const saved = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  assert.equal(saved.stable.phase, 'mdd-verify');
  assert.deepEqual(saved.events.filter(event => event.kind === 'result' && event.result.phase === 'mdd-apply').map(event => event.result.completed),
    [['T0'], ['T1'], ['T2'], ['T3']]);
  // Main retains the newest reported files first, without dropping the earlier file union.
  assert.deepEqual(saved.stable.changedList.map(file => file.path), ['src/b.ts', 'src/a.ts']);
  assert.equal(saved.data.changedFiles, 2);
});

test('checkpoint refuses published worker evidence whose native call differs from its result artifact', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.after(f.calls[1], args[1], f.text(1)); await f.runner.after(f.calls[0], args[0], f.text(0));
  const corrupt = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  corrupt.data.workerState.completed[0].callID = 'plan';
  corrupt.dataDigest = sealResumeData(corrupt.data, corrupt.runID, corrupt.parent, corrupt.events, corrupt.stable);
  assert.throws(() => validateCheckpoint(corrupt), /identity|workflow result/);
});

test('failed member cannot release a live sibling; explicit retry excludes durable successes', async t => {
  const f = await fixture(t); const status = f.runner.status(f.runtime.sessionID);
  const dispatched = await Promise.all(status.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.after(f.calls[1], dispatched[1], f.text(1, 'failed'));
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'blocked');
  assert.throws(() => f.runner.reset(f.runtime.sessionID, 'phase'), /running|pending/);
  await f.runner.after(f.calls[0], dispatched[0], f.text(0));
  assert.deepEqual(f.checkpoint.read(f.runtime.sessionID).checkpoint.data.workerState.completed.map(item => item.taskID), ['T1']);
  assert.equal(f.runner.status(f.runtime.sessionID).workflow.results.length, 2);
  f.runner.reset(f.runtime.sessionID, 'phase');
  assert.equal(f.runner.status(f.runtime.sessionID).tasks.length, 1);
  const next = { sessionID: f.runtime.sessionID, callID: 'retry-two' };
  const args = await f.runner.before(next, f.runner.status(f.runtime.sessionID).tasks[0]);
  assert.match(args.prompt, /Assigned worker task:.*T2/);
  assert.doesNotMatch(args.prompt, /Assigned worker task:.*T1/);
  await f.runner.after(next, args, f.text(1));
  assert.equal(f.runner.status(f.runtime.sessionID).phase, 'mdd-verify');
});

test('default host, disabled preference and legacy snapshots remain serial', async t => {
  for (const extra of [{ workerCapability: undefined }, { workers: { enabled: false } }]) {
    const f = await fixture(t, extra);
    assert.equal(f.runner.status(f.runtime.sessionID).tasks, undefined);
    assert.equal(f.runner.status(f.runtime.sessionID).task.subagent_type, 'mdd-apply');
  }
  const f = await fixture(t, { workerCapability: undefined });
  const saved = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  delete saved.data.workerPolicy; saved.sequence++;
  saved.dataDigest = sealResumeData(saved.data, saved.runID, saved.parent, saved.events, saved.stable);
  f.checkpoint.write(f.runtime.sessionID, saved);
  const restored = new PhaseRunner(f.inspect, { ...f.options, workerCapability: { confined: true } });
  assert.deepEqual(await restored.restore(f.runtime), { restored: true });
  assert.equal(restored.status(f.runtime.sessionID).tasks, undefined);
  assert.equal(restored.status(f.runtime.sessionID).task.subagent_type, 'mdd-apply');
});

test('settled batches persist before the next dependent task and survive restart without replay', async t => {
  const f = await fixture(t, { third: true }); const ready = f.runner.status(f.runtime.sessionID);
  f.options.workers.enabled = false; // Preference is detached at run start, not read again at Apply.
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await Promise.all([f.runner.after(f.calls[1], args[1], f.text(1)), f.runner.after(f.calls[0], args[0], f.text(0))]);
  const saved = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  assert.equal(saved.stable.phase, 'mdd-apply'); assert.equal(saved.attempt.state, 'settled');
  assert.deepEqual(saved.data.workerState.completed.map(member => member.taskID), ['T1', 'T2']);
  assert.equal(f.ownership.read(ready.runID).state, 'idle');
  const unsupported = new PhaseRunner(f.inspect, { ...f.options, workerCapability: undefined });
  assert.equal((await unsupported.restore(f.runtime)).restored, true);
  const serial = unsupported.status(f.runtime.sessionID);
  assert.equal(serial.tasks, undefined); assert.equal(serial.task.subagent_type, 'mdd-apply');
  const restored = new PhaseRunner(f.inspect, f.options);
  assert.deepEqual(await restored.restore(f.runtime), { restored: true });
  const next = restored.status(f.runtime.sessionID); assert.equal(next.tasks.length, 1);
  const third = { sessionID: f.runtime.sessionID, callID: 'third' };
  const dispatched = await restored.before(third, next.tasks[0]);
  assert.match(dispatched.prompt, /Assigned worker task:.*T3/);
  await restored.after(third, dispatched, reportDocument({ completed: ['T3'], evidenceSummary: 'Finished dependent task.',
    artifact: 'Dependent implementation evidence.', changes: ['src/a.ts'], checks: [] }));
  assert.equal(restored.status(f.runtime.sessionID).phase, 'mdd-verify');
});

for (const kind of ['malformed', 'scope', 'checks', 'wrong-call', 'missing', 'transport', 'running', 'unknown']) {
  test(`${kind} member result blocks without releasing or replaying its successful sibling`, async t => {
    const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
    const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
    await f.runner.after(f.calls[0], args[0], f.text(0));
    let output = f.text(1);
    if (kind === 'malformed') output = 'Not an MDD report.';
    if (kind === 'scope') output = f.text(0);
    if (kind === 'checks') output = reportDocument({ evidenceSummary: SUMMARY_TEXT, artifact: ARTIFACT_TEXT, changes: ['src/b.ts'], checks: [{ command: 'npm test', exit: 0 }] });
    if (kind === 'wrong-call') output = JSON.stringify({ outcome: 'passed', callID: 'stranger', evidenceSummary: SUMMARY_TEXT, artifact: ARTIFACT_TEXT, changes: ['src/b.ts'] });
    if (kind === 'missing') output = undefined;
    if (kind === 'transport') f.inspect.result = async () => { throw new Error('transport failed'); };
    if (kind === 'running' || kind === 'unknown') {
      f.inspect.stopped = async () => false;
      f.inspect.liveness = async () => ({ verdict: kind, detail: kind });
    }
    await assert.rejects(f.runner.after(f.calls[1], args[1], output));
    const status = f.runner.status(f.runtime.sessionID);
    assert.equal(status.state, 'blocked'); assert.equal(status.tasks, undefined);
    assert.deepEqual(status.workerProgress.completed, ['T1']);
    assert.equal(f.ownership.read(ready.runID).state, 'reserved');
    assert.throws(() => f.runner.reset(f.runtime.sessionID, 'phase'), /running|pending/);
    await assert.rejects(f.runner.before({ ...f.calls[1], callID: 'replay' }, ready.tasks[1]));
    assert.equal((await new PhaseRunner(f.inspect, f.options).restore(f.runtime)).restored, false);
  });
}

test('pending restart probes every member, refuses one running child, and recovers only the missing task', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.after(f.calls[0], args[0], f.text(0));
  const restarted = new PhaseRunner(f.inspect, f.options);
  assert.equal((await restarted.restore(f.runtime)).restored, false);
  assert.equal(restarted.pendingOwner(f.runtime.sessionID).workers.length, 2);
  const seen = []; f.inspect.liveness = async (_runtime, call) => { seen.push(call.callID); return { verdict: 'running', detail: 'still live' }; };
  assert.equal((await restarted.probe(f.runtime.sessionID, f.runtime)).verdict, 'running');
  assert.deepEqual(seen, ['two']);
  await restarted.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await restarted.confirmStopped(f.runtime.sessionID, f.runtime, true, resetID)).verdict, 'running');
  });
  assert.equal(f.ownership.read(ready.runID).state, 'reserved');
  f.inspect.liveness = async () => ({ verdict: 'stopped', detail: 'host stopped' });
  await restarted.withReset(f.runtime.sessionID, async resetID => {
    await restarted.confirmStopped(f.runtime.sessionID, f.runtime, false, resetID);
    assert.deepEqual(await restarted.restore(f.runtime), { restored: true });
    restarted.reset(f.runtime.sessionID, 'phase');
  });
  const status = restarted.status(f.runtime.sessionID);
  assert.deepEqual(status.workerProgress.completed, ['T1']); assert.equal(status.tasks.length, 1);
  await assert.rejects(restarted.after(f.calls[0], args[0], f.text(0)), /match/);
  const retry = { ...f.calls[1], callID: 'recovered-two' };
  const task = await restarted.before(retry, status.tasks[0]);
  await restarted.after(retry, task, f.text(1));
  assert.equal(restarted.status(f.runtime.sessionID).phase, 'mdd-verify');
});

test('two unresolved children are both inspected before any recovery mutation', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  const before = f.checkpoint.read(f.runtime.sessionID).checkpoint; const seen = [];
  f.inspect.liveness = async (_runtime, call) => { seen.push(call.callID); return { verdict: call.callID === 'one' ? 'stopped' : 'running', detail: call.callID }; };
  await f.runner.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await f.runner.confirmStopped(f.runtime.sessionID, f.runtime, true, resetID)).verdict, 'running');
  });
  assert.deepEqual(seen.sort(), ['one', 'two']);
  assert.deepEqual(f.checkpoint.read(f.runtime.sessionID).checkpoint, before);
  assert.equal(f.ownership.read(ready.runID).workers.filter(member => member.state === 'pending').length, 2);
});

for (const boundary of ['admission', 'result', 'progress', 'owner']) {
  test(`${boundary} persistence failure is fail-closed and keeps successful evidence`, async t => {
    const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
    const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
    await f.runner.after(f.calls[0], args[0], f.text(0));
    if (boundary === 'result') f.checkpoint.write = () => { throw new CheckpointStorageError('disk full'); };
    if (boundary === 'progress') f.progress.write = () => { throw new Error('progress failed'); };
    if (boundary === 'owner') f.ownership.settleWorker = () => { throw new Error('owner failed'); };
    if (boundary === 'admission') {
      const g = await fixture(t); const next = g.runner.status(g.runtime.sessionID);
      g.checkpoint.write = () => { throw new CheckpointStorageError('disk full'); };
      await assert.rejects(g.runner.before(g.calls[0], next.tasks[0]));
      assert.equal(g.runner.status(g.runtime.sessionID).state, 'blocked');
      assert.equal(g.ownership.read(next.runID).state, 'reserved');
      await assert.rejects(g.runner.before(g.calls[1], next.tasks[1]));
      return;
    }
    await assert.rejects(f.runner.after(f.calls[1], args[1], f.text(1)));
    assert.equal(f.runner.status(f.runtime.sessionID).state, 'blocked');
    assert.ok(f.runner.status(f.runtime.sessionID).workerProgress.completed.includes('T1'));
    assert.equal(f.ownership.read(ready.runID).state, 'reserved');
    assert.throws(() => f.runner.reset(f.runtime.sessionID, 'phase'), /durability|running|pending/);
  });
}

test('transfer refuses pending members and preserves completed task evidence once settled', async t => {
  const f = await fixture(t, { third: true }); const ready = f.runner.status(f.runtime.sessionID);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.after(f.calls[0], args[0], f.text(0));
  const target = { ...f.runtime, sessionID: 'target' }; const proof = { sessionID: 'target', userMessageID: 'user-target',
    userText: `Resume sourceSessionID=${f.runtime.sessionID} runID=${ready.runID}`, latest: true, authored: true };
  assert.throws(() => projectTargetTransfer(f.checkpoint.read(f.runtime.sessionID).checkpoint, f.progress.read(f.runtime.sessionID), target, proof));
  await f.runner.after(f.calls[1], args[1], f.text(1));
  const projected = projectTargetTransfer(f.checkpoint.read(f.runtime.sessionID).checkpoint, f.progress.read(f.runtime.sessionID), target, proof);
  assert.deepEqual(projected.checkpoint.data.workerState.completed.map(member => member.taskID), ['T1', 'T2']);
});

test('checkpoint rejects duplicate task/call evidence and contradictory worker authority', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.after(f.calls[0], args[0], f.text(0));
  const saved = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  for (const mutate of [
    data => data.workerState.completed.push(data.workerState.completed[0]),
    data => { data.workerState.batch.members[1].callID = 'one'; },
    data => { data.workerPolicy.enabled = false; },
    data => { data.workerState.batch.id = 'wrong-batch'; },
  ]) {
    const corrupt = structuredClone(saved); mutate(corrupt.data);
    corrupt.dataDigest = sealResumeData(corrupt.data, corrupt.runID, corrupt.parent, corrupt.events, corrupt.stable);
    assert.throws(() => validateCheckpoint(corrupt));
  }
  assert.throws(() => validateWorkerState({ completed: [{ taskID: 'T1', callID: 'invented', text: f.text(0) }] }, saved.data.planned, saved.data.calls));
});

test('large member artifacts remain durable with distinct bounded artifacts for every result', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  const texts = ['a', 'b'].map((name, index) => reportDocument({ completed: [`T${index + 1}`], evidenceSummary: `Finished ${name}.`, artifact: name.repeat(15000), changes: [`src/${name}.ts`], checks: [] }));
  await f.runner.after(f.calls[1], args[1], texts[1]);
  await f.runner.after(f.calls[0], args[0], texts[0]);
  const done = f.runner.status(f.runtime.sessionID);
  assert.equal(done.phase, 'mdd-verify'); assert.equal(done.artifact.content, 'b'.repeat(15000));
  const saved = f.checkpoint.read(f.runtime.sessionID).checkpoint;
  assert.deepEqual(saved.data.dependencies.slice(2).map(item => item.content), ['a'.repeat(15000), 'b'.repeat(15000)]);
  assert.deepEqual(f.checkpoint.read(f.runtime.sessionID).checkpoint.data.workerState.completed.map(member => member.text), texts);
});

test('native transport failure blocks even when its child stopped, and retains sibling completion', async t => {
  const f = await fixture(t); const ready = f.runner.status(f.runtime.sessionID);
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(f.calls[index], task)));
  await f.runner.nativeError(f.runtime.sessionID, 'two');
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'blocked');
  assert.equal(f.ownership.read(ready.runID).state, 'reserved');
  await f.runner.after(f.calls[0], args[0], f.text(0));
  assert.deepEqual(f.runner.status(f.runtime.sessionID).workerProgress.completed, ['T1']);
  assert.equal(f.ownership.read(ready.runID).state, 'idle');
  await assert.rejects(f.runner.nativeError(f.runtime.sessionID, 'two'), /pending/);
});
