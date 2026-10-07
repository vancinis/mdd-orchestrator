import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Workflow } from '../dist/workflow.js';
import { CheckpointStorageError, CheckpointStore, reconcileProgress, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { ProgressGuard } from '../dist/progress.js';
import { projectTargetTransfer } from '../dist/transfer.js';
import { memoryServer, request as nativeRequest, result as nativeResult, reportDocument, riskReport, runtime, call, answers } from './adapter-fixture.mjs';

const parent = 'session-1';
const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'interactive', summary: 'low', complexity: 'not-complex' } };
const checkpoint = (workflow, sequence, attempt) => ({ version: 1, runID: 'run-1', parent, sequence, request,
  events: workflow.history(), ...(attempt ? { attempt } : {}) });
const marker = { runID: 'run-1', userMessageID: 'message-1', state: 'pending', attemptID: 'attempt-1' };

/** Drives a fresh workflow through exploration and a passed mdd-risk verdict for `route`. */
function throughRisk(workflow, route) {
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Evidence.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Risk evidence.', route });
}

test('workflow replay derives approvals, failed verification, rework and the current action', () => {
  const workflow = new Workflow(request);
  throughRisk(workflow, 'low');
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
    workflow.start('mdd-explore');
    store.write(parent, checkpoint(workflow, 1, { id: 'attempt-1', phase: 'mdd-explore', state: 'pending' }));
    assert.equal(reconcileProgress(marker, store.read(parent).checkpoint), 'blocked'); // child may still run
    workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Evidence.' });
    const settled = checkpoint(workflow, 2, { id: 'attempt-1', phase: 'mdd-explore', state: 'settled' });
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
  // The ceiling is a sanity bound now, far above any real route; past it a record is still refused.
  const oversized = { ...data, context: Array.from({ length: 180 }, (_, index) => ({ label: `source-${index}`, content: 'x'.repeat(95000), source: 'coordinator' })) };
  assert.throws(() => validateCheckpoint({ ...record, data: oversized, dataDigest: sealResumeData(oversized, 'run-1', parent, workflow.history()) }));
  // Text the runtime accepts — carriage returns, tabs, ANSI escapes — is recorded losslessly.
  const escaped = { ...data, requirements: 'Colour \u001b[1mbold\u001b[0m\r\n\ttext', dependencies: [{ phase: 'mdd-explore', content: 'Body \u001b[31mred\u001b[0m\r\n',
    digest: createHash('sha256').update('Body \u001b[31mred\u001b[0m\r\n').digest('hex') }] };
  const accepted = { ...record, data: escaped, dataDigest: sealResumeData(escaped, 'run-1', parent, workflow.history()) };
  assert.deepEqual(validateCheckpoint(accepted).checkpoint, accepted);
});

test('a checkpoint write that keeps failing after exploration degrades the run to data-only instead of blocking it', async t => {
  const memory = await memoryServer(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-durability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new CheckpointStore(root);
  let refused = 0;
  const checkpointStore = { write(parent, value) {
    if (value.sequence === 2) { refused++; throw new CheckpointStorageError('Simulated disk fault after result.'); }
    durable.write(parent, value);
  }, read: parent => durable.read(parent), clear: parent => durable.clear(parent) };
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const runner = new PhaseRunner(inspect, { checkpoint: checkpointStore, progress: new ProgressGuard(root) });
  const ready = await runner.start(nativeRequest(memory.endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  assert.equal(durable.read(runtime.sessionID).checkpoint.attempt.state, 'pending');
  // Exploration leads to the risk stop, not to an Apply writer, so the ordinary bounded retry and
  // data-only degradation apply here, not the single-attempt guard for an uncertain Apply transition.
  await runner.after(call, dispatched, nativeResult(ready));
  assert.ok(refused > 1, 'the result checkpoint was retried before degrading');
  const status = runner.status(runtime.sessionID);
  // The result stands: the progress marker is its durable record and the live run moves on,
  // straight into the mandatory risk stop that always follows a passed exploration.
  assert.equal(status.workflow.results.length, 1);
  assert.equal(status.state, 'ready');
  assert.equal(status.phase, 'mdd-explore');
  assert.equal(status.stage, 'mdd-risk');
  const marker = new ProgressGuard(root).read(runtime.sessionID);
  assert.equal(marker.state, 'settled');
  // The old dispatch handle can never run the recorded phase again.
  await assert.rejects(runner.before({ ...call, callID: 'next' }, ready.task));
  // A restart never resumes the stale pending-attempt checkpoint.
  const restarted = new PhaseRunner(inspect, { checkpoint: durable, progress: new ProgressGuard(root) });
  const restored = await restarted.restore(runtime);
  if (marker.resumable === false) assert.equal(restored.restored, false);
  else assert.equal(durable.read(runtime.sessionID).checkpoint.sequence > 2, true, 'resumable again only after a newer full checkpoint');
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
  // Exploration always leads to the mandatory risk stop before any route is selected.
  const riskReady = runner.status(runtime.sessionID);
  const riskCall = { ...call, callID: 'call-risk' };
  const riskDispatched = await runner.before(riskCall, riskReady.task);
  await runner.after(riskCall, riskDispatched, riskReport('low'));
  runner.approveNative(runtime.sessionID, 'mdd-plan');
  const planReady = runner.status(runtime.sessionID);
  const planCall = { ...call, callID: 'call-plan' };
  const planDispatched = await runner.before(planCall, planReady.task);
  await runner.after(planCall, planDispatched, nativeResult(planReady));
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
  assert.equal(saved.data.dependencies.length, 2);
  assert.match(saved.data.dependencies[1].content, /Acceptance and plan links/);
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
  const exploreReady = await runner.start(nativeRequest(memory.endpoint), runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const exploreDispatched = await runner.before({ ...call, callID: 'call-mdd-explore' }, exploreReady.task);
  await runner.after({ ...call, callID: 'call-mdd-explore' }, exploreDispatched, nativeResult(exploreReady));
  // Exploration always leads to the mandatory risk stop before any route is selected.
  const riskReady = runner.status(runtime.sessionID);
  const riskDispatched = await runner.before({ ...call, callID: 'call-risk' }, riskReady.task);
  await runner.after({ ...call, callID: 'call-risk' }, riskDispatched, riskReport('low'));
  for (const [phase, data] of [
    ['mdd-plan', undefined], ['mdd-apply', { completed: ['cli-validation'], changes: [{ path: 'src/cli.ts', reason: 'Validate input at the boundary.' }] }],
  ]) {
    const status = runner.status(runtime.sessionID);
    assert.equal(status.phase, phase);
    const taskCall = { ...call, callID: `call-${phase}` };
    const dispatched = await runner.before(taskCall, status.task);
    await runner.after(taskCall, dispatched, data ? reportDocument({ evidenceSummary: 'Implemented input validation.', artifact: 'Apply body', ...data }) : nativeResult(status));
  }
  const saved = store.read(runtime.sessionID);
  assert.equal(saved.workflow.nextAction().phase, 'mdd-verify');
  assert.equal(saved.checkpoint.data.dependencies.length, 3);
  assert.match(saved.checkpoint.data.dependencies[1].content, /Acceptance and plan links/);
  assert.equal(saved.checkpoint.data.dependencies[2].content, 'Apply body');
  assert.equal(saved.checkpoint.data.planned.length, 1);
  assert.equal(saved.checkpoint.data.evidence.implementation, 'confirmed');
  // Ordinary phase dependencies never serialize a capability; the one diagnostic exception is the
  // risk artifact reference the plan deliberately persists so restore/transfer keep the route.
  assert.equal(JSON.stringify(saved.checkpoint.data.dependencies).includes('recordID'), false);
  assert.equal(JSON.stringify(saved.checkpoint.data.contexts).includes('recordID'), false);
  assert.equal(typeof saved.checkpoint.data.risk.ref.recordID, 'string');
  assert.equal(JSON.stringify(saved.checkpoint).includes('questionReceipts'), false);
});

test('a failed approval checkpoint blocks Apply and fences the stale pre-approval record', async t => {
  const memory = await memoryServer(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-approval-checkpoint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new CheckpointStore(root);
  // Sequence 8 is the checkpoint the final interactive approval of mdd-apply writes, once
  // exploration, the mandatory risk stop and the approved mdd-plan phase have all settled.
  const store = { write(parent, value) {
    if (value.sequence === 8) throw new CheckpointStorageError('Approval write fault.');
    durable.write(parent, value);
  }, read: parent => durable.read(parent), clear: parent => durable.clear(parent) };
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress: new ProgressGuard(root) });
  const input = nativeRequest(memory.endpoint);
  input.preflight.answers = { ...answers, mode: 'interactive' };
  const ready = await runner.start(input, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  // Exploration always leads to the mandatory risk stop before any route is selected.
  const riskReady = runner.status(runtime.sessionID);
  const riskCall = { ...call, callID: 'call-risk' };
  const riskDispatched = await runner.before(riskCall, riskReady.task);
  await runner.after(riskCall, riskDispatched, riskReport('low'));
  runner.approveNative(runtime.sessionID, 'mdd-plan');
  const planReady = runner.status(runtime.sessionID);
  const planCall = { ...call, callID: 'call-plan' };
  const planDispatched = await runner.before(planCall, planReady.task);
  await runner.after(planCall, planDispatched, nativeResult(planReady));
  assert.equal(durable.read(runtime.sessionID).workflow.nextAction().kind, 'approve');
  assert.throws(() => runner.approveNative(runtime.sessionID, 'mdd-apply'), /Apply checkpoint outcome is unconfirmed/);
  // Approval cannot expose a writer without a confirmed durable transition.
  assert.equal(runner.status(runtime.sessionID).state, 'blocked');
  assert.equal(runner.status(runtime.sessionID).phase, 'mdd-apply');
  // The approval was never checkpointed: a restart must not resume from the stale pre-approval
  // record as though nothing happened, nor from an approval it cannot prove.
  assert.equal(new ProgressGuard(root).read(runtime.sessionID).state, 'pending');
  assert.equal(durable.read(runtime.sessionID).workflow.nextAction().kind, 'approve');
  const restarted = new PhaseRunner(inspect, { checkpoint: durable, progress: new ProgressGuard(root) });
  assert.equal((await restarted.restore(runtime)).restored, false);
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
  assert.equal(status.phase, 'mdd-explore');
  assert.equal(status.state, 'ready');
  assert.equal(status.attempts, 1);
  assert.equal(status.workflow.results.length, 0);
  assert.match(status.task.subagent_type, /mdd-explore/);
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
  const settled = await restarted.submit({ result: nativeResult({ phase: 'mdd-explore' }) }, runtime);
  assert.equal(settled.state, 'ready');
  assert.equal(settled.phase, 'mdd-explore');
  assert.equal(settled.stage, 'mdd-risk');
  assert.equal(settled.workflow.results.length, 1);
});

test('a rejected-result checkpoint failure settles the stopped attempt data-only and never resumes it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-rejected-write-fault-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new CheckpointStore(root);
  const store = { read: parent => durable.read(parent), clear: parent => durable.clear(parent),
    write(parent, value) { if (value.attempt?.state === 'released') throw new CheckpointStorageError('Retry checkpoint fault.'); durable.write(parent, value); } };
  const progress = new ProgressGuard(root);
  const runner = new PhaseRunner({ parent: async () => {}, result: async () => { throw new Error('Rejected result.'); }, stopped: async () => true },
    { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime,
    { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await assert.rejects(runner.after(call, dispatched, nativeResult(ready)), /Rejected result/);
  // The child is confirmed stopped, so the live run offers the ordinary retry.
  assert.equal(runner.status(runtime.sessionID).state, 'ready');
  assert.equal(progress.read(runtime.sessionID).state, 'settled');
  assert.equal(progress.read(runtime.sessionID).resumable, false);
  // The stale pending-attempt checkpoint is gone or withdrawn: a restart cannot resume it.
  assert.equal(durable.read(runtime.sessionID), undefined);
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

test('a risk-ready checkpoint restores by re-preparing the risk stop, never redispatching it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-risk-ready-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  const riskReady = runner.status(runtime.sessionID);
  assert.equal(riskReady.stage, 'mdd-risk');
  assert.equal(store.read(runtime.sessionID).checkpoint.stable.state, 'risk-ready');
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress });
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
  const status = restarted.status(runtime.sessionID);
  assert.equal(status.state, 'ready');
  assert.equal(status.stage, 'mdd-risk');
  assert.match(status.task.subagent_type, /mdd-risk/);
  assert.equal(status.workflow.results.length, 1);
  // Restoring a ready risk stop only rebuilds its prompt from replay; it never dispatches a child.
  assert.equal(progress.read(runtime.sessionID).state, 'settled');
});

test('a risk-await-result checkpoint cannot redispatch an unconfirmed attempt, only release it explicitly', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-risk-await-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  const riskReady = runner.status(runtime.sessionID);
  const riskCall = { ...call, callID: 'call-risk' };
  await runner.before(riskCall, riskReady.task);
  assert.equal(store.read(runtime.sessionID).checkpoint.stable.state, 'risk-await-result');
  // An unconfirmed risk attempt is gated exactly like an unconfirmed phase attempt: no automatic
  // redispatch on restore.
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress });
  assert.deepEqual(await restarted.restore(runtime), { restored: false, reason: 'A pending phase attempt is unconfirmed. Confirm its child stopped or provide explicit user attestation; no task was reissued.' });
  // No task was reissued while the attempt stayed unconfirmed.
  assert.equal(store.read(runtime.sessionID).checkpoint.stable.state, 'risk-await-result');
  assert.equal((await restarted.confirmStopped(runtime.sessionID, runtime)).verdict, 'stopped');
  // Only after the explicit, correlated release does restoration proceed, same as an ordinary
  // phase's unconfirmed attempt: the run comes back recoverable, never auto-redispatched.
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
});

test('a risk-blocked checkpoint restores blocked and recoverable without a selected route', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-risk-blocked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  const riskReady = runner.status(runtime.sessionID);
  const riskCall = { ...call, callID: 'call-risk' };
  const riskDispatched = await runner.before(riskCall, riskReady.task);
  await runner.after(riskCall, riskDispatched, riskReport('low', 'failed'));
  const blocked = store.read(runtime.sessionID).checkpoint;
  assert.equal(blocked.stable.state, 'risk-blocked');
  assert.equal(blocked.data.risk, undefined);
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress });
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
  const status = restarted.status(runtime.sessionID);
  assert.equal(status.state, 'blocked');
  assert.equal(status.stage, 'mdd-risk');
  assert.equal(status.risk, undefined);
  assert.equal(status.next.kind, 'blocked-risk');
});

for (const route of ['low', 'high']) {
  test(`restoring a passed ${route} risk result keeps the verdict and the artifact reference through restart`, async t => {
    const root = mkdtempSync(join(tmpdir(), `mdd-risk-${route}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new CheckpointStore(root);
    const progress = new ProgressGuard(root);
    const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
    const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
    const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
    const dispatched = await runner.before(call, ready.task);
    await runner.after(call, dispatched, nativeResult(ready));
    const riskReady = runner.status(runtime.sessionID);
    const riskCall = { ...call, callID: 'call-risk' };
    const riskDispatched = await runner.before(riskCall, riskReady.task);
    await runner.after(riskCall, riskDispatched, riskReport(route));
    const saved = store.read(runtime.sessionID).checkpoint;
    assert.equal(saved.stable.phase, route === 'high' ? 'mdd-propose' : 'mdd-plan');
    assert.equal(saved.data.risk.verdict.route, route);
    const restarted = new PhaseRunner(inspect, { checkpoint: store, progress });
    assert.deepEqual(await restarted.restore(runtime), { restored: true });
    const status = restarted.status(runtime.sessionID);
    assert.equal(status.phase, route === 'high' ? 'mdd-propose' : 'mdd-plan');
    assert.equal(status.risk.route, route);
    assert.equal(status.risk.ref.recordID, saved.data.risk.ref.recordID);
  });
}

test('a manual risk-recovery route choice persists through a CheckpointStore restart and rejects a forged verdict', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-risk-recovery-roundtrip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  const riskReady = runner.status(runtime.sessionID);
  const riskCall = { ...call, callID: 'call-risk' };
  const riskDispatched = await runner.before(riskCall, riskReady.task);
  await runner.after(riskCall, riskDispatched, riskReport('low', 'failed'));
  // The manual choice itself authorizes the chosen tail's first phase; no RiskVerdict is invented.
  runner.chooseManualRoute(runtime.sessionID, 'low');
  const saved = store.read(runtime.sessionID).checkpoint;
  assert.equal(saved.stable.phase, 'mdd-plan');
  assert.equal(saved.stable.state, 'ready');
  assert.equal(saved.data.risk, undefined);
  assert.equal(saved.events.at(-1).kind, 'risk-recovery');
  assert.equal(saved.events.at(-1).route, 'low');
  // The CheckpointStore roundtrip alone (a fresh restart) reproduces the exact same manual route.
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress });
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
  const status = restarted.status(runtime.sessionID);
  assert.equal(status.phase, 'mdd-plan');
  assert.equal(status.workflow.evaluation.route, 'low');
  assert.equal(Workflow.replay(saved.request, saved.events).snapshot().routeOrigin, 'manual');
  // A forged verdict stapled onto a manual recovery, or a second manual choice replayed on top
  // of an already-authorized tail, are both contradictions a restart must refuse, never resume.
  const forgedVerdict = { ...saved.data, risk: { verdict: { route: 'low', complexity: 'low', reason: 'Forged.',
    evidence: [{ source: 'none', finding: 'none' }], risks: [{ description: 'none', evidence: 'none', mitigation: 'none' }] },
    ref: { runID: saved.runID, phase: 'mdd-risk', recordID: 'forged', digest: 'a'.repeat(64), bytes: 1, store: 'none' } } };
  assert.throws(() => validateCheckpoint({ ...saved, data: forgedVerdict,
    dataDigest: sealResumeData(forgedVerdict, saved.runID, saved.parent, saved.events, saved.stable) }), /only recorded once a risk assessment passed/);
  assert.throws(() => Workflow.replay(saved.request, [...saved.events, { kind: 'risk-recovery', route: 'high' }]));
});

test('an override route persists its own provenance through a CheckpointStore restart and rejects a duplicate forged override', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-route-override-roundtrip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
  const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
  const input = { preflight: { answers: { ...answers, mode: 'interactive' } }, requirements: 'Plan a safe change.' };
  const ready = await runner.start(input, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  const riskReady = runner.status(runtime.sessionID);
  const riskCall = { ...call, callID: 'call-risk' };
  const riskDispatched = await runner.before(riskCall, riskReady.task);
  await runner.after(riskCall, riskDispatched, riskReport('low'));
  assert.equal(store.read(runtime.sessionID).workflow.nextAction().kind, 'approve');
  // Forcing the other tail never discards or rewrites the original suggested verdict.
  runner.forceRoute(runtime.sessionID);
  const saved = store.read(runtime.sessionID).checkpoint;
  assert.equal(saved.stable.phase, 'mdd-propose');
  assert.equal(saved.stable.state, 'ready');
  assert.equal(saved.data.risk.verdict.route, 'low');
  assert.equal(saved.events.at(-1).kind, 'route-override');
  // The CheckpointStore roundtrip reproduces the override tail, not the suggested one, while the
  // original verdict route stays exactly as the risk stop recorded it.
  const restarted = new PhaseRunner(inspect, { checkpoint: store, progress });
  assert.deepEqual(await restarted.restore(runtime), { restored: true });
  const status = restarted.status(runtime.sessionID);
  assert.equal(status.phase, 'mdd-propose');
  assert.equal(status.workflow.evaluation.route, 'high');
  assert.equal(status.risk.route, 'low');
  assert.equal(Workflow.replay(saved.request, saved.events).snapshot().routeOrigin, 'override');
  // A duplicate override replayed after the overridden tail's phase already ran is a forgery:
  // `overrideRoute()` only ever applies once, before its own first tail phase is approved.
  assert.throws(() => Workflow.replay(saved.request, [...saved.events, { kind: 'route-override' }]));
});

// R3/S5: a transferred checkpoint carries the committed decision history unchanged, so the target's
// replay derives the same routeOrigin and keeps (override) or omits (manual) the original verdict.
for (const kind of ['manual', 'override']) {
  test(`a transferred ${kind} route checkpoint keeps its routeOrigin and verdict through target write and readback`, async t => {
    const root = mkdtempSync(join(tmpdir(), `mdd-transfer-${kind}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new CheckpointStore(root);
    const progress = new ProgressGuard(root);
    const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
    const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
    const input = { preflight: { answers: kind === 'override' ? { ...answers, mode: 'interactive' } : answers }, requirements: 'Plan a safe change.' };
    const ready = await runner.start(input, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
    const dispatched = await runner.before(call, ready.task);
    await runner.after(call, dispatched, nativeResult(ready));
    const riskCall = { ...call, callID: 'call-risk' };
    const riskDispatched = await runner.before(riskCall, runner.status(runtime.sessionID).task);
    await runner.after(riskCall, riskDispatched, riskReport('low', kind === 'manual' ? 'failed' : 'passed'));
    if (kind === 'manual') runner.chooseManualRoute(runtime.sessionID, 'high');
    else runner.forceRoute(runtime.sessionID);
    const source = store.read(runtime.sessionID).checkpoint;
    const target = { ...runtime, sessionID: 'ses-transfer-target' };
    const proof = { sessionID: target.sessionID, userMessageID: 'user-transfer-target', latest: true, authored: true,
      userText: `Continuar sourceSessionID=${source.parent} runID=${source.runID}` };
    const projected = projectTargetTransfer(source, progress.read(runtime.sessionID), target, proof);
    assert.deepEqual(projected.checkpoint.events, source.events, 'the committed decision history is carried, never rewritten');
    store.write(target.sessionID, projected.checkpoint);
    const readBack = store.read(target.sessionID).checkpoint;
    validateCheckpoint(readBack);
    const snapshot = Workflow.replay(readBack.request, readBack.events).snapshot();
    assert.equal(snapshot.routeOrigin, kind);
    assert.equal(snapshot.evaluation.route, 'high');
    if (kind === 'override') assert.equal(readBack.data.risk.verdict.route, 'low', 'the original suggested verdict survives transfer');
    else assert.equal(readBack.data.risk, undefined, 'a manual choice gains no verdict through transfer');
    // A verdict stapled onto the transferred manual history is still refused on the target.
    if (kind === 'manual') {
      const forged = { ...readBack.data, risk: { verdict: { route: 'high', complexity: 'high', reason: 'Forged.',
        evidence: [{ source: 'none', finding: 'none' }], risks: [{ description: 'none', evidence: 'none', mitigation: 'none' }] },
        ref: { runID: readBack.runID, phase: 'mdd-risk', recordID: 'forged', digest: 'a'.repeat(64), bytes: 1, store: 'none' } } };
      assert.throws(() => validateCheckpoint({ ...readBack, data: forged,
        dataDigest: sealResumeData(forged, readBack.runID, readBack.parent, readBack.events, readBack.stable) }));
    }
  });
}

test('a primary-only checkpoint write fault during a manual recovery choice degrades to data-only, proven by independent disk readback', async t => {
  const root = mkdtempSync(join(tmpdir(), 'mdd-primary-write-fault-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const durable = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  // Only the primary checkpoint write is broken; CheckpointStore.clear and ProgressGuard.write
  // (the fallback and the marker degrade depends on) are both the real, unmocked implementations.
  let attempts = 0;
  const faulting = { write(parent, value, replaces) { attempts++; throw new CheckpointStorageError('Simulated primary write fault.'); },
    read: parent => durable.read(parent), clear: parent => durable.clear(parent) };
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output };
  const runner = new PhaseRunner(inspect, { checkpoint: durable, progress });
  const ready = await runner.start({ preflight: { answers }, requirements: 'Plan a safe change.' }, runtime, { requirementsConfirmed: true, userMessageID: 'message-1' });
  const dispatched = await runner.before(call, ready.task);
  await runner.after(call, dispatched, nativeResult(ready));
  const riskReady = runner.status(runtime.sessionID);
  const riskCall = { ...call, callID: 'call-risk' };
  const riskDispatched = await runner.before(riskCall, riskReady.task);
  await runner.after(riskCall, riskDispatched, riskReport('low', 'failed'));
  // Swap only the checkpoint writer under the live run: the manual choice itself is the native
  // decision this attempts to persist, so this is the exact write the fault must hit.
  runner.options.checkpoint = faulting;
  // The choice itself is never lost or silently dropped: it degrades the run to data-only
  // instead of stopping it, exactly as an ordinary result's checkpoint fault already does.
  runner.chooseManualRoute(runtime.sessionID, 'low');
  assert.ok(attempts > 1, 'the primary write was retried before degrading');
  const live = runner.status(runtime.sessionID);
  assert.equal(live.state, 'ready');
  assert.equal(live.phase, 'mdd-plan');
  // Independent disk readback, through a fresh store instance that never saw the fault: the
  // stale checkpoint was withdrawn, never left half-written or ambiguous.
  assert.equal(new CheckpointStore(root).read(runtime.sessionID), undefined);
  const marker = new ProgressGuard(root).read(runtime.sessionID);
  assert.equal(marker.resumable, false);
  // A restart (fresh runner, real unfaulted store) can never resume this degraded state, and
  // therefore can never duplicate the dispatch the live, still-running run already made.
  const restarted = new PhaseRunner(inspect, { checkpoint: durable, progress });
  const restored = await restarted.restore(runtime);
  assert.equal(restored.restored, false);
  assert.equal(restarted.status(runtime.sessionID).task, undefined);
});

test('checkpoint validation rejects a risk verdict that contradicts, forges or omits the replayed risk result', () => {
  const workflow = new Workflow(request);
  throughRisk(workflow, 'low');
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const verdict = { route: 'low', complexity: 'low', reason: 'Contained change.',
    evidence: [{ source: 'exploration artifact', finding: 'Only the CLI boundary is touched.' }],
    risks: [{ description: 'Exit codes could change.', evidence: 'exploration artifact', mitigation: 'Keep existing exit codes under test.' }] };
  const ref = { runID: 'run-1', phase: 'mdd-risk', recordID: 'risk-record', digest: createHash('sha256').update('Risk body').digest('hex'),
    bytes: Buffer.byteLength('Risk body'), store: 'none' };
  const exploreBody = 'Exploration body.';
  const data = { directory: 'project', worktree: 'project', userMessageID: 'message-1', requirements: 'Goal', context: [],
    dependencies: [{ phase: 'mdd-explore', content: exploreBody, digest: createHash('sha256').update(exploreBody).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence,
    executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [], risk: { verdict, ref } };
  const record = { ...checkpoint(workflow, 2), version: 2, data, dataDigest: sealResumeData(data, 'run-1', parent, workflow.history()) };
  // A route that agrees with the replayed risk-result is accepted.
  assert.deepEqual(validateCheckpoint(record).checkpoint, record);
  const tamper = damagedData => ({ ...record, data: damagedData, dataDigest: sealResumeData(damagedData, 'run-1', parent, workflow.history()) });
  // A verdict whose route contradicts the one passed risk-result is a forgery.
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict: { ...verdict, route: 'high', complexity: 'high' }, ref } })), /contradicts/);
  // An unsupported artifact store is not a legacy field; it is an invalid reference.
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, store: 'invented' } } })), /Invalid checkpoint risk artifact reference/);
  // A `mdd-risk` reference never carries a spec domain or an exploration side identity; the
  // store never mints one for this phase, so either field present is a forgery.
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, domain: 'billing' } } })), /Invalid checkpoint risk artifact reference/);
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, explorationID: 'exploration-1' } } })), /Invalid checkpoint risk artifact reference/);
  // An optional path must be a bounded nonempty string, not an object, array or empty value.
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, path: '' } } })), /Invalid checkpoint risk artifact reference/);
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, path: 42 } } })), /Invalid checkpoint risk artifact reference/);
  // An optional observationID must be a positive safe integer, never zero, negative or a float.
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, observationID: 0 } } })), /Invalid checkpoint risk artifact reference/);
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, observationID: -1 } } })), /Invalid checkpoint risk artifact reference/);
  assert.throws(() => validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, observationID: 1.5 } } })), /Invalid checkpoint risk artifact reference/);
  // A valid path and observationID stay accepted; the reference is otherwise the same shape a
  // live engram-backed store would have minted.
  assert.deepEqual(validateCheckpoint(tamper({ ...data, risk: { verdict, ref: { ...ref, store: 'engram', observationID: 7 } } })).checkpoint.data.risk.ref.observationID, 7);
  // A risk verdict with no passed risk-result at all cannot be invented out of nothing.
  const noRisk = new Workflow(request);
  noRisk.start('mdd-explore');
  noRisk.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Evidence.' });
  const beforeRiskRecord = { ...checkpoint(noRisk, 1), version: 2, data, dataDigest: sealResumeData(data, 'run-1', parent, noRisk.history()) };
  assert.throws(() => validateCheckpoint(beforeRiskRecord), /only recorded once a risk assessment passed/);
  // Before any risk result, the absence of the optional field is still compatible.
  const { risk: _dropped, ...withoutRisk } = data;
  const beforeRiskOk = { ...beforeRiskRecord, data: withoutRisk, dataDigest: sealResumeData(withoutRisk, 'run-1', parent, noRisk.history()) };
  assert.deepEqual(validateCheckpoint(beforeRiskOk).checkpoint, beforeRiskOk);
  // A failed risk result cannot have selected a route or kept an artifact.
  const failedWorkflow = new Workflow(request);
  failedWorkflow.start('mdd-explore');
  failedWorkflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Evidence.' });
  failedWorkflow.startRisk();
  failedWorkflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Risk evidence.' });
  const failedRecord = { ...checkpoint(failedWorkflow, 2), version: 2, data, dataDigest: sealResumeData(data, 'run-1', parent, failedWorkflow.history()) };
  assert.throws(() => validateCheckpoint(failedRecord), /only recorded once a risk assessment passed/);
  const failedOk = { ...failedRecord, data: withoutRisk, dataDigest: sealResumeData(withoutRisk, 'run-1', parent, failedWorkflow.history()) };
  assert.deepEqual(validateCheckpoint(failedOk).checkpoint, failedOk);
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
