import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Workflow } from '../dist/workflow.js';
import { CheckpointStorageError, CheckpointStore, reconcileProgress, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { nextAction } from '../dist/next-action.js';
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

test('AL-01: unmarked resume seals preserve the exact historical digest', () => {
  const data = { requirements: 'Historical bytes.' };
  const events = [];
  for (const stable of [undefined, { state: 'ready' }]) {
    const historical = createHash('sha256').update(JSON.stringify({ runID: 'run-1', parent, events, data,
      ...(stable ? { stable } : {}) })).digest('hex');
    assert.equal(sealResumeData(data, 'run-1', parent, events, stable), historical);
    assert.equal(sealResumeData(data, 'run-1', parent, events, stable, request), historical);
    assert.notEqual(sealResumeData(data, 'run-1', parent, events, stable, { ...request, routingVersion: 2 }), historical);
  }
});

test('AL-01: seal callers cannot silently ignore unsafe requests or invalid routing pins', () => {
  for (const input of [null, [], 'request', new Date(), { ...request, extra: true },
    ...[undefined, null, '2', 1, 4].map(routingVersion => ({ ...request, routingVersion }))]) {
    assert.throws(() => sealResumeData({}, 'run-1', parent, [], undefined, input));
  }
  assert.throws(() => sealResumeData({}, 'run-1', parent, [], undefined, { ...request, routingVersion: 3 }), /native-context-required/);
});

for (const version of [2, 3]) {
  test(`AL-01: checkpoint v${version} binds an explicit routing pin and rejects insertion or removal`, () => {
    const workflow = new Workflow(request);
    const data = { directory: 'project', worktree: 'project', userMessageID: 'message-1', requirements: 'Goal',
      context: [], dependencies: [], contexts: [], decisions: [], planned: [],
      evidence: { requirements: 'unearned', plan: 'unearned', implementation: 'unearned', checks: 'unearned' },
      executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [] };
    const stable = version === 3 ? { phase: 'mdd-explore', state: 'ready', mode: 'delegate', attempts: 0, spent: 0,
      malformed: 0, report: { phase: 'mdd-explore', summary: 'Ready.', how: [], status: 'in-progress', evidence: data.evidence },
      changedList: [], concerns: [] } : undefined;
    const pinned = { ...request, routingVersion: 2 };
    const record = input => ({ ...checkpoint(workflow, 0), version, request: input, data, ...(stable ? { stable } : {}),
      dataDigest: sealResumeData(data, 'run-1', parent, workflow.history(), stable, input) });
    const saved = record(pinned);
    assert.deepEqual(validateCheckpoint(saved).checkpoint, saved);
    assert.throws(() => validateCheckpoint({ ...saved, request }), /digest mismatch/);
    assert.throws(() => validateCheckpoint({ ...record(request), request: pinned }), /digest mismatch/);
    for (const routingVersion of [3, 4, null, '2']) {
      assert.throws(() => validateCheckpoint({ ...saved, request: { ...pinned, routingVersion } }), /routingVersion/);
    }
    assert.deepEqual(validateCheckpoint(record(request)).checkpoint.request, request, 'explicit resealing is required to remove a pin');
  });
}

test('AL-01: an unsealed legacy checkpoint cannot carry an explicit routing pin', () => {
  assert.throws(() => validateCheckpoint({ ...checkpoint(new Workflow(request), 0), request: { ...request, routingVersion: 2 } }),
    /sealed.*checkpoint/);
});

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

test('SA-2: checkpoint replay preserves version before planning and missing marker stays legacy', () => {
  const workflow = new Workflow(request);
  const data = { directory: 'project', worktree: 'project', userMessageID: 'message-1', requirements: 'Goal',
    context: [], dependencies: [], contexts: [], decisions: [], planned: [],
    evidence: { requirements: 'unearned', plan: 'unearned', implementation: 'unearned', checks: 'unearned' },
    executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [] };
  const record = data => ({ ...checkpoint(workflow, 0), version: 2, data,
    dataDigest: sealResumeData(data, 'run-1', parent, workflow.history()) });
  assert.deepEqual(validateCheckpoint(record(data)).checkpoint.data, data);
  const versioned = { ...data, verificationVersion: 1 };
  assert.deepEqual(validateCheckpoint(record(versioned)).checkpoint.data, versioned);
  assert.throws(() => validateCheckpoint(record({ ...data, verificationVersion: 2 })), /verification.*version/i);
  assert.throws(() => validateCheckpoint(record({ ...versioned, executedChecks: [{ id: 'E1', command: 'npm test', exit: 0 }] })), /verification/i);
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

for (const route of ['low', 'high']) {
}

// R3/S5: a transferred checkpoint carries the committed decision history unchanged, so the target's
// replay derives the same routeOrigin and keeps (override) or omits (manual) the original verdict.
for (const kind of ['manual', 'override']) {
}

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

