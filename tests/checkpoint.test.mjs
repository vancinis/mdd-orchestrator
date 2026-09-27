import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Workflow } from '../dist/workflow.js';
import { CheckpointStore, reconcileProgress, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { ProgressGuard } from '../dist/progress.js';
import { memoryServer, request as nativeRequest, result as nativeResult, reportDocument, runtime, call, answers } from './adapter-fixture.mjs';

const parent = 'session-1';
const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'interactive', summary: 'low', complexity: 'not-complex' } };
const checkpoint = (workflow, sequence, attempt) => ({ version: 1, runID: 'run-1', parent, sequence, request,
  events: workflow.history(), ...(attempt ? { attempt } : {}) });
const marker = { runID: 'run-1', userMessageID: 'message-1', state: 'pending', attemptID: 'attempt-1' };

test('workflow replay derives approvals, failed verification, rework and the current action', () => {
  const workflow = new Workflow(request);
  for (const phase of ['mdd-plan', 'mdd-apply', 'mdd-verify']) {
    if (workflow.nextAction().kind === 'approve') workflow.approve(phase);
    workflow.start(phase);
    workflow.recordResult({ phase, outcome: phase === 'mdd-verify' ? 'failed' : 'passed', evidenceSummary: 'Evidence.' });
  }
  workflow.rework('mdd-apply');
  assert.deepEqual(Workflow.replay(request, workflow.history()).snapshot(), workflow.snapshot());
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-apply' });
  assert.throws(() => Workflow.replay(request, [{ kind: 'approve', phase: 'mdd-apply' }]));
  assert.throws(() => Workflow.replay(request, [{ kind: 'retry' }]));
});

test('durable checkpoint readback and crash windows never grant an unmatched pending attempt', () => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-checkpoint-'));
  try {
    const store = new CheckpointStore(root);
    const workflow = new Workflow(request);
    store.write(parent, checkpoint(workflow, 0));
    assert.equal(reconcileProgress(marker, store.read(parent).checkpoint), 'blocked'); // marker before intent
    workflow.start('mdd-plan');
    store.write(parent, checkpoint(workflow, 1, { id: 'attempt-1', phase: 'mdd-plan', state: 'pending' }));
    assert.equal(reconcileProgress(marker, store.read(parent).checkpoint), 'blocked'); // child may still run
    workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Evidence.' });
    const settled = checkpoint(workflow, 2, { id: 'attempt-1', phase: 'mdd-plan', state: 'settled' });
    store.write(parent, settled);
    assert.equal(reconcileProgress(marker, store.read(parent).checkpoint), 'clear'); // result before marker update
    assert.equal(reconcileProgress({ ...marker, attemptID: 'attempt-2' }, settled), 'blocked');
    assert.equal(reconcileProgress({ ...marker, runID: 'other' }, settled), 'blocked');
    assert.equal(reconcileProgress({ ...marker, attemptID: undefined }, settled), 'blocked'); // v1 progress
    assert.throws(() => store.write(parent, checkpoint(workflow, 1)));
    assert.throws(() => store.write(parent, { ...settled, runID: 'other', sequence: 3 }));
    assert.deepEqual(store.read(parent).checkpoint, settled);
    const name = `checkpoint-${createHash('sha256').update(parent).digest('hex')}.json`;
    writeFileSync(join(root, '.mdd', name), '{');
    assert.throws(() => store.read(parent), /cannot be read safely/);
    assert.equal(reconcileProgress(marker, undefined), 'blocked');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rejects unknown versions, extra keys, invented settlement and oversized history', () => {
  const workflow = new Workflow(request);
  assert.throws(() => validateCheckpoint({ ...checkpoint(workflow, 0), version: 2 }));
  assert.throws(() => validateCheckpoint({ ...checkpoint(workflow, 0), liveConsent: true }));
  assert.throws(() => validateCheckpoint(checkpoint(workflow, 0, { id: 'attempt-1', phase: 'mdd-plan', state: 'settled' })));
  assert.throws(() => validateCheckpoint({ ...checkpoint(workflow, 0), events: Array(513).fill({ kind: 'retry' }) }));
});

test('v2 binds every result to complete dependency bytes and rejects corruption or silent omission', () => {
  const preflight = { ...request, explore: true };
  const workflow = new Workflow(preflight);
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Evidence.' });
  const data = { directory: 'project', worktree: 'project', userMessageID: 'message-1', requirements: 'Goal',
    context: [], dependencies: [{ phase: 'mdd-explore', content: 'Exploration body', digest: createHash('sha256').update('Exploration body').digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence: { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' },
    executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [] };
  const record = { ...checkpoint(workflow, 2, { id: 'attempt-1', phase: 'mdd-explore', state: 'settled' }),
    request: preflight, version: 2, data, dataDigest: sealResumeData(data, 'run-1', parent, workflow.history()) };
  assert.deepEqual(validateCheckpoint(record).checkpoint, record);
  for (const damaged of [
    { ...data, dependencies: [] },
    { ...data, dependencies: [{ ...data.dependencies[0], content: 'Corrupted body' }] },
    { ...data, dependencies: [{ ...data.dependencies[0], content: undefined }] },
    { ...data, dependencies: [{ ...data.dependencies[0], content: 'x'.repeat(16001) }] },
  ]) assert.throws(() => validateCheckpoint({ ...record, data: damaged, dataDigest: sealResumeData(damaged, 'run-1', parent, workflow.history()) }));
  assert.throws(() => validateCheckpoint({ ...record, data: { ...data, requirements: 'Tampered' } }));
  assert.throws(() => validateCheckpoint({ ...record, runID: 'other' }));
  assert.throws(() => validateCheckpoint({ ...record, parent: 'other' }));
  const oversized = { ...data, context: Array.from({ length: 5 }, (_, index) => ({ label: `source-${index}`, content: 'x'.repeat(95000), source: 'coordinator' })) };
  assert.throws(() => validateCheckpoint({ ...record, data: oversized, dataDigest: sealResumeData(oversized, 'run-1', parent, workflow.history()) }));
});

test('checkpoint write failure after a phase result leaves its marker pending and cannot authorize retry', async t => {
  const memory = await memoryServer(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-durability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new CheckpointStore(root);
  const checkpointStore = { write(parent, value) {
    if (value.sequence === 2) throw new Error('Simulated disk fault after result.');
    durable.write(parent, value);
  }, read: parent => durable.read(parent), clear: parent => durable.clear(parent) };
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const runner = new PhaseRunner(inspect, { checkpoint: checkpointStore, progress: new ProgressGuard(root) });
  const ready = await runner.start(nativeRequest(memory.endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  assert.equal(durable.read(runtime.sessionID).checkpoint.attempt.state, 'pending');
  await assert.rejects(runner.after(call, dispatched, nativeResult(ready)), /Checkpoint outcome is unconfirmed/);
  const status = runner.status(runtime.sessionID);
  assert.equal(status.state, 'blocked');
  assert.equal(status.uncertain, true);
  assert.equal(status.workflow.results.length, 0);
  assert.equal(status.workflow.nextAction.kind, 'await-result');
  assert.equal(status.task, undefined);
  assert.equal(durable.read(runtime.sessionID).checkpoint.events.at(-1).kind, 'start');
  assert.equal(new ProgressGuard(root).read(runtime.sessionID).state, 'pending');
  await assert.rejects(runner.before({ ...call, callID: 'next' }, ready.task));
  assert.throws(() => runner.reset(runtime.sessionID, 'phase'), /Checkpoint durability/);
});

test('checkpoint-ready plan records complete bytes and held acceptance before approving Apply', async t => {
  const memory = await memoryServer(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-plan-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const runner = new PhaseRunner({ parent: async () => {}, result: async (_runtime, _call, _phase, output) => output },
    { checkpoint: store, progress: new ProgressGuard(root) });
  const input = nativeRequest(memory.endpoint);
  input.preflight.answers = { ...answers, mode: 'interactive' };
  const ready = await runner.start(input, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  const { checkpoint: saved, workflow } = store.read(runtime.sessionID);
  assert.equal(saved.version, 3);
  assert.equal(saved.stable.state, 'await-approval');
  assert.equal(saved.stable.phase, 'mdd-apply');
  assert.equal(saved.stable.mode, 'delegate');
  assert.equal(saved.stable.report.phase, 'mdd-plan');
  assert.equal(saved.stable.attempts, 0);
  assert.equal(saved.stable.spent, 0);
  const tamper = change => {
    const stable = { ...saved.stable, ...change };
    return { ...saved, stable, dataDigest: sealResumeData(saved.data, saved.runID, saved.parent, saved.events, stable) };
  };
  assert.throws(() => validateCheckpoint(tamper({ phase: 'mdd-verify' })));
  assert.throws(() => validateCheckpoint(tamper({ state: 'ready' })));
  assert.throws(() => validateCheckpoint(tamper({ attempts: 2, spent: 1 })));
  assert.throws(() => validateCheckpoint(tamper({ mode: 'native' })));
  assert.throws(() => validateCheckpoint(tamper({ report: { ...saved.stable.report, evidence: { ...saved.stable.report.evidence, plan: 'unearned' } } })));
  assert.throws(() => validateCheckpoint(tamper({ changedList: [{ path: 'invented.ts' }] })));
  assert.throws(() => validateCheckpoint({ ...saved, stable: undefined }));
  assert.equal(workflow.nextAction().kind, 'approve');
  assert.equal(saved.data.dependencies.length, 1);
  assert.match(saved.data.dependencies[0].content, /Acceptance and plan links/);
  assert.equal(saved.data.planned.length, 1);
  assert.equal(saved.data.acceptance.requirements.length, 1);
  assert.equal(saved.data.evidence.plan, 'confirmed');
  assert.equal(new ProgressGuard(root).read(runtime.sessionID).state, 'settled');
  runner.approveNative(runtime.sessionID, 'mdd-apply');
  assert.equal(store.read(runtime.sessionID).workflow.nextAction().kind, 'execute');
});

test('checkpoint-ready Verify receives complete plan and Apply dependencies without serialized capabilities', async t => {
  const memory = await memoryServer(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-verify-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const runner = new PhaseRunner({ parent: async () => {}, result: async (_runtime, _call, _phase, output) => output },
    { checkpoint: store, progress: new ProgressGuard(root) });
  await runner.start(nativeRequest(memory.endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  for (const [phase, data] of [
    ['mdd-plan', undefined], ['mdd-apply', { changes: [{ path: 'src/cli.ts', reason: 'Validate input at the boundary.' }] }],
  ]) {
    const status = runner.status(runtime.sessionID);
    assert.equal(status.phase, phase);
    const taskCall = { ...call, callID: `call-${phase}` };
    const dispatched = await runner.before(taskCall, status.task);
    await runner.after(taskCall, dispatched, data ? reportDocument({ evidenceSummary: 'Implemented input validation.', artifact: 'Apply body', ...data }) : nativeResult(status));
  }
  const saved = store.read(runtime.sessionID);
  assert.equal(saved.workflow.nextAction().phase, 'mdd-verify');
  assert.equal(saved.checkpoint.data.dependencies.length, 2);
  assert.match(saved.checkpoint.data.dependencies[0].content, /Acceptance and plan links/);
  assert.equal(saved.checkpoint.data.dependencies[1].content, 'Apply body');
  assert.equal(saved.checkpoint.data.planned.length, 1);
  assert.equal(saved.checkpoint.data.evidence.implementation, 'confirmed');
  assert.equal(JSON.stringify(saved.checkpoint).includes('recordID'), false);
  assert.equal(JSON.stringify(saved.checkpoint).includes('questionReceipts'), false);
});

test('failed approval checkpoint cannot expose an approved task', async t => {
  const memory = await memoryServer(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-approval-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new CheckpointStore(root);
  const store = { write(parent, value) {
    if (value.sequence === 3) throw new Error('Approval readback fault.');
    durable.write(parent, value);
  }, read: parent => durable.read(parent), clear: parent => durable.clear(parent) };
  const runner = new PhaseRunner({ parent: async () => {}, result: async (_runtime, _call, _phase, output) => output },
    { checkpoint: store, progress: new ProgressGuard(root) });
  const input = nativeRequest(memory.endpoint);
  input.preflight.answers = { ...answers, mode: 'interactive' };
  const ready = await runner.start(input, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  assert.equal(durable.read(runtime.sessionID).workflow.nextAction().kind, 'approve');
  assert.throws(() => runner.approveNative(runtime.sessionID, 'mdd-apply'), /Checkpoint durability/);
  assert.equal(runner.status(runtime.sessionID).state, 'blocked');
  assert.equal(runner.status(runtime.sessionID).task, undefined);
  assert.equal(durable.read(runtime.sessionID).workflow.nextAction().kind, 'approve');
});

test('rejected result commits its retry before settling and restores the same phase', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-rejected-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const input = { preflight: { answers }, requirements: 'Plan a safe change.' };
  const runner = new PhaseRunner({ parent: async () => {}, result: async () => { throw new Error('Result rejected by host.'); }, stopped: async () => true },
    { checkpoint: store, progress });
  const ready = await runner.start(input, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await assert.rejects(runner.after(call, dispatched, nativeResult(ready)), /Result rejected/);
  assert.equal(runner.status(runtime.sessionID).state, 'ready');
  assert.equal(progress.read(runtime.sessionID).state, 'settled');
  const restarted = new PhaseRunner({ parent: async () => {}, result: async (_runtime, _call, _phase, output) => output },
    { checkpoint: store, progress });
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
  const status = restarted.status(runtime.sessionID);
  assert.equal(status.phase, 'mdd-plan');
  assert.equal(status.state, 'ready');
  assert.equal(status.attempts, 1);
  assert.equal(status.workflow.results.length, 0);
  assert.match(status.task.subagent_type, /mdd-plan/);
});

test('malformed completed report restores only restatement, never a fresh actor dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-malformed-retry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const input = { preflight: { answers }, requirements: 'Plan a safe change.' };
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const ready = await runner.start(input, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  const malformed = 'The work is done, but this is not a phase report.';
  await assert.rejects(runner.after(call, dispatched, malformed), /could not read/);
  assert.equal(runner.status(runtime.sessionID).state, 'ready');
  assert.equal(progress.read(runtime.sessionID).state, 'settled');
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress });
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
  const status = restarted.status(runtime.sessionID);
  assert.equal(status.mode, 'inline');
  assert.equal(status.task, undefined);
  assert.equal(status.rejected.text, malformed);
  const settled = await restarted.submit({ result: nativeResult({ phase: 'mdd-plan' }) }, runtime);
  assert.equal(settled.state, 'ready');
  assert.equal(settled.phase, 'mdd-apply');
  assert.equal(settled.workflow.results.length, 1);
});

test('rejected-result checkpoint failure cannot settle progress or expose a retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-rejected-write-fault-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new CheckpointStore(root);
  const store = { read: parent => durable.read(parent), clear: parent => durable.clear(parent),
    write(parent, value) { if (value.attempt?.state === 'released') throw new Error('Retry checkpoint fault.'); durable.write(parent, value); } };
  const progress = new ProgressGuard(root);
  const runner = new PhaseRunner({ parent: async () => {}, result: async () => { throw new Error('Rejected result.'); }, stopped: async () => true },
    { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime,
    { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await assert.rejects(runner.after(call, dispatched, nativeResult(ready)), /Checkpoint durability/);
  assert.equal(runner.status(runtime.sessionID).state, 'blocked');
  assert.equal(runner.status(runtime.sessionID).task, undefined);
  assert.equal(progress.read(runtime.sessionID).state, 'pending');
  assert.equal(durable.read(runtime.sessionID).checkpoint.attempt.state, 'pending');
  const restarted = new PhaseRunner({ parent: async () => {}, result: async () => '', stopped: async () => true },
    { checkpoint: durable, progress });
  assert.equal((await restarted.restore(runtime)).restored, false);
});

test('crash after durable retry but before progress settlement still requires explicit child release', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-retry-marker-fault-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const real = new ProgressGuard(root);
  const progress = { read: parent => real.read(parent), clear: parent => real.clear(parent),
    write(parent, value) { if (value.state === 'settled') throw new Error('Progress settlement fault.'); real.write(parent, value); } };
  const inspect = { parent: async () => {}, result: async () => { throw new Error('Rejected result.'); }, stopped: async () => true };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime,
    { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await assert.rejects(runner.after(call, dispatched, nativeResult(ready)), /progress settlement is unconfirmed/);
  assert.equal(runner.status(runtime.sessionID).state, 'blocked');
  assert.equal(runner.status(runtime.sessionID).task, undefined);
  assert.equal(store.read(runtime.sessionID).checkpoint.attempt.state, 'released');
  assert.equal(real.read(runtime.sessionID).state, 'pending');
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress: real });
  assert.equal((await restarted.restore(runtime)).restored, false);
  assert.equal((await restarted.confirmStopped(runtime.sessionID, runtime)).verdict, 'stopped');
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
  assert.equal(restarted.status(runtime.sessionID).state, 'ready');
});

test('unfinished inline restatement has no child liveness and cannot consume the prior retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-inline-unknown-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const real = new ProgressGuard(root);
  const progress = { read: parent => real.read(parent), clear: parent => real.clear(parent),
    write(parent, value) { real.write(parent, value); } };
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime,
    { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await assert.rejects(runner.after(call, dispatched, 'Not a report.'));
  // Simulate a crash in the coordinator's inline report after its pending marker was written.
  const interrupted = new ProgressGuard(root);
  interrupted.write(runtime.sessionID, { runID: ready.runID, state: 'pending', userMessageID: 'message-1',
    attemptID: 'inline-unknown' });
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress: interrupted });
  assert.equal((await restarted.restore(runtime)).restored, false);
  assert.equal((await restarted.confirmStopped(runtime.sessionID, runtime)).verdict, 'unknown');
  assert.equal(interrupted.read(runtime.sessionID).state, 'pending');
  await restarted.confirmStopped(runtime.sessionID, runtime, true);
  assert.equal((await restarted.restore(runtime)).restored, false);
});
