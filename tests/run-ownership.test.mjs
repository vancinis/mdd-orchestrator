import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { LocalFiles } from '../dist/local-files.js';
import { CheckpointStore, sealResumeData } from '../dist/checkpoint.js';
import { Workflow } from '../dist/workflow.js';
import { ProgressGuard } from '../dist/progress.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { riskRecoveryEnvelope, routeEnvelope } from '../dist/native-intake.js';
import { assessTransfer } from '../dist/transfer.js';

const runID = 'run-owned';
const sourceID = 'ses-source';
const targetID = 'ses-target';
function root(t) { const path = mkdtempSync(join(tmpdir(), 'mdd-owner-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function ownerPath(root) { return join(root, '.mdd', `owner-${createHash('sha256').update(runID).digest('hex')}.json`); }
function claim(store, directory) { return store.claim({ runID, sessionID: sourceID, directory, worktree: directory }); }

test('worker reservation holds both calls through reverse settlement and rejects stale CAS', t => {
  const directory = root(t); const store = new RunOwnershipStore(directory);
  claim(store, directory);
  let owner = store.reserveWorkers(runID, sourceID, 'batch-1', ['T1', 'T2'], 0);
  owner = store.admitWorker(runID, sourceID, 'batch-1', 'T1', 'call-1', owner.epoch);
  assert.throws(() => store.admitWorker(runID, sourceID, 'batch-1', 'T2', 'call-2', owner.epoch - 1));
  owner = store.admitWorker(runID, sourceID, 'batch-1', 'T2', 'call-2', owner.epoch);
  assert.throws(() => store.admitWorker(runID, sourceID, 'batch-1', 'T2', 'call-3', owner.epoch));
  assert.throws(() => store.settleWorker(runID, sourceID, 'batch-1', 'wrong', owner.epoch));
  owner = store.settleWorker(runID, sourceID, 'batch-1', 'call-2', owner.epoch);
  assert.throws(() => store.release(runID, sourceID, 'batch-1', owner.epoch));
  assert.throws(() => store.handoff(runID, sourceID, 'batch-1', 'reset', owner.epoch,
    { sourceCallID: 'batch-1', kind: 'task', checkpointSequence: 0, checkpointDigest: 'a'.repeat(64) }));
  assert.throws(() => store.beginTransfer(runID, sourceID, { sessionID: targetID, directory, worktree: directory }, 'a'.repeat(64), owner.epoch));
  owner = store.settleWorker(runID, sourceID, 'batch-1', 'call-1', owner.epoch);
  assert.throws(() => store.settleWorker(runID, sourceID, 'batch-1', 'call-1', owner.epoch));
  assert.equal(store.release(runID, sourceID, 'batch-1', owner.epoch).state, 'idle');
});

/** A validated verdict and its diagnostic artifact reference, shaped as checkpoint.ts expects. */
function riskVerdict(route) {
  return { route, complexity: route, reason: 'The change is contained.',
    evidence: [{ source: 'exploration artifact', finding: 'The CLI boundary is the only touched area.' }],
    risks: [{ description: 'Exit codes could change.', evidence: 'exploration artifact', mitigation: 'Keep existing exit codes under test.' }] };
}
function riskRef(id) {
  const content = 'Risk assessment artifact.';
  return { runID: id, phase: 'mdd-risk', recordID: 'risk-record', digest: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content), store: 'none' };
}
/** Drives a fresh workflow through the mandatory exploration and risk stop every run now starts with. */
function throughRisk(workflow, route = 'low') {
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: `Risk is ${route}.`, route });
}

function transferSource(directory, parent, id) {
  const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex' } };
  const workflow = new Workflow(request);
  throughRisk(workflow, 'low');
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory, worktree: directory, userMessageID: `user-${parent}`, requirements: 'Plan a safe change.',
    context: [], dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: [], usedMessages: [`user-${parent}`], proposed: [], risk: { verdict: riskVerdict('low'), ref: riskRef(id) } };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const events = workflow.history();
  const checkpoint = { version: 3, parent, runID: id, sequence: 0, request, events, data, stable,
    dataDigest: sealResumeData(data, id, parent, events, stable) };
  new CheckpointStore(directory).write(parent, checkpoint);
  // A recorded exploration result needs a settled progress marker correlated to this run.
  new ProgressGuard(directory).write(parent, { runID: id, userMessageID: `user-${parent}`, state: 'settled',
    callID: 'task-risk', attemptID: 'task-risk' });
  const owners = new RunOwnershipStore(directory);
  owners.claimParent(parent, id);
  owners.claim({ runID: id, sessionID: parent, directory, worktree: directory });
  return checkpoint;
}

/** A settled risk-ready or risk-await-result source, with a marker that is settled either way
 *  so the ownership guard's own stable.state exclusion is what is being exercised, not a pending
 *  progress marker that would already refuse transfer on its own. */
function riskStopSource(directory, parent, id, state) {
  const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex' } };
  const workflow = new Workflow(request);
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  if (state === 'risk-await-result') workflow.startRisk();
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory, worktree: directory, userMessageID: `user-${parent}`, requirements: 'Plan a safe change.',
    context: [], dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: [], usedMessages: [`user-${parent}`], proposed: [] };
  const stable = { phase: 'mdd-explore', state, mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-explore', summary: 'Exploration recorded.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const events = workflow.history();
  const checkpoint = { version: 3, parent, runID: id, sequence: 0, request, events, data, stable,
    ...(state === 'risk-await-result' ? { attempt: { id: 'task-risk', phase: 'mdd-risk', state: 'pending' } } : {}),
    dataDigest: sealResumeData(data, id, parent, events, stable) };
  new CheckpointStore(directory).write(parent, checkpoint);
  new ProgressGuard(directory).write(parent, { runID: id, userMessageID: `user-${parent}`, state: 'settled',
    callID: 'task-risk', attemptID: 'task-risk' });
  const owners = new RunOwnershipStore(directory);
  owners.claimParent(parent, id);
  owners.claim({ runID: id, sessionID: parent, directory, worktree: directory });
  return checkpoint;
}

/** A settled risk-blocked source: mdd-risk failed, leaving an unresolved risk-recovery question
 *  the restart path would reissue fresh. Used to exercise transfer's own safe retirement. */
function riskBlockedSource(directory, parent, id) {
  const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'interactive', summary: 'low', complexity: 'not-complex' } };
  const workflow = new Workflow(request);
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Risk could not be substantiated.' });
  const evidence = { requirements: 'confirmed', plan: 'invalidated', implementation: 'invalidated', checks: 'invalidated' };
  const content = 'Exploration artifact.';
  const data = { directory, worktree: directory, userMessageID: `user-${parent}`, requirements: 'Plan a safe change.',
    context: [], dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [] };
  const stable = { phase: 'mdd-explore', state: 'risk-blocked', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-explore', summary: 'Risk could not be substantiated.', how: [], status: 'failed', evidence },
    changedList: [], concerns: [], reason: 'mdd-risk reported that the request and exploration findings cannot substantiate a route.' };
  const events = workflow.history();
  const checkpoint = { version: 3, parent, runID: id, sequence: 0, request, events, data, stable,
    dataDigest: sealResumeData(data, id, parent, events, stable) };
  new CheckpointStore(directory).write(parent, checkpoint);
  new ProgressGuard(directory).write(parent, { runID: id, userMessageID: `user-${parent}`, state: 'settled',
    callID: 'task-risk', attemptID: 'task-risk' });
  const owners = new RunOwnershipStore(directory);
  owners.claimParent(parent, id);
  owners.claim({ runID: id, sessionID: parent, directory, worktree: directory });
  return checkpoint;
}

/** Bound to the exact checkpoint above, the shape a real `NativeIntake` would write. */
function riskRecoveryQuestion(source, state) {
  const args = riskRecoveryEnvelope(source.runID, source.stable.reason ?? '');
  return { version: 1, parent: source.parent, sequence: 1, runID: source.runID, requirements: source.data.requirements,
    userMessageID: source.data.userMessageID, known: {}, reservation: { runID: source.runID, stable: 'risk-blocked' },
    checkpoint: { sequence: source.sequence, digest: source.dataDigest }, state,
    slot: { kind: 'risk-recovery', args }, clarifications: [], deferred: [], clarificationAnswers: [],
    callID: 'call-recovery-live', ...(state === 'answered' ? { answer: [[args.questions[0].options[0].label]] } : {}) };
}

/** A non-risk question kind (here, a route question) bound to the same checkpoint. */
function routeQuestion(source, state) {
  const args = routeEnvelope(source.runID, 'mdd-plan', { route: 'low', complexity: 'low', reason: 'Contained change.' });
  return { version: 1, parent: source.parent, sequence: 1, runID: source.runID, requirements: source.data.requirements,
    userMessageID: source.data.userMessageID, known: {}, reservation: { runID: source.runID, stable: 'blocked' },
    checkpoint: { sequence: source.sequence, digest: source.dataDigest }, state,
    slot: { kind: 'route', phase: 'mdd-plan', args }, clarifications: [], deferred: [], clarificationAnswers: [],
    callID: 'call-route-live', ...(state === 'answered' ? { answer: [[args.questions[0].options[0].label]] } : {}) };
}

for (const state of ['pending', 'answered']) test(
  `claimTargetForTransfer retires a ${state} risk-recovery source question only after the target claim is confirmed`, t => {
  const directory = root(t);
  const source = riskBlockedSource(directory, sourceID, runID);
  const questions = new QuestionCheckpointStore(directory);
  questions.write(sourceID, riskRecoveryQuestion(source, state));
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: `recovery-${state}`, nativeUserMessageID: `user-${targetID}`, requestDigest: 'a'.repeat(64) };
  const claim = owners.claimTargetForTransfer(runID, sourceID, target,
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent);
  assert.equal(claim.sessionID, targetID);
  // Retired only once the target claim is itself durably confirmed: the historical call and any
  // answer it carried can never be mistaken for the target's own fresh recovery question later.
  assert.equal(questions.read(sourceID), undefined);
  assert.equal(owners.read(runID).state, 'idle');
});

test('a non-risk-recovery question kind still fences claimTargetForTransfer even though risk-recovery would not', t => {
  const directory = root(t);
  const source = riskBlockedSource(directory, sourceID, runID);
  const questions = new QuestionCheckpointStore(directory);
  questions.write(sourceID, routeQuestion(source, 'pending'));
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: 'route-fences', nativeUserMessageID: `user-${targetID}`, requestDigest: 'b'.repeat(64) };
  assert.throws(() => owners.claimTargetForTransfer(runID, sourceID, target,
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent), /not idle|target is occupied/);
  // The unresolved non-risk question survives exactly because the claim was refused.
  assert.equal(questions.read(sourceID)?.state, 'pending');
  assert.equal(owners.parent(targetID), undefined);
});

test('a failed target claim write leaves a pending risk-recovery source question intact', t => {
  const directory = root(t);
  const source = riskBlockedSource(directory, sourceID, runID);
  const questions = new QuestionCheckpointStore(directory);
  questions.write(sourceID, riskRecoveryQuestion(source, 'pending'));
  const owners = new RunOwnershipStore(directory);
  // An unrelated run already holds this exact target parent (not retired): the target claim
  // write below is guaranteed to fail before any source retirement could ever happen.
  owners.claimParent(targetID, 'unrelated-run');
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: 'claim-write-fails', nativeUserMessageID: `user-${targetID}`, requestDigest: 'c'.repeat(64) };
  assert.throws(() => owners.claimTargetForTransfer(runID, sourceID, target,
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent), /unconfirmed/);
  assert.equal(questions.read(sourceID)?.state, 'pending');
  assert.equal(owners.read(runID).state, 'idle');
  assert.equal(owners.parent(targetID), 'unrelated-run');
});

// R2/S4: only a risk-recovery question bound to this exact run and source checkpoint is retirable.
// A stale, foreign or unbound one fences the claim and the reservation, and survives untouched.
for (const [name, forge] of [
  ['foreign run', (q) => ({ ...q, runID: 'run-foreign', reservation: { runID: 'run-foreign', stable: 'risk-blocked' } })],
  ['stale checkpoint digest', (q) => ({ ...q, checkpoint: { ...q.checkpoint, digest: 'e'.repeat(64) } })],
  ['mismatched checkpoint sequence', (q) => ({ ...q, checkpoint: { ...q.checkpoint, sequence: q.checkpoint.sequence + 1 } })],
  ['no checkpoint binding', (q) => { const { checkpoint: _checkpoint, ...rest } = q; return rest; }],
]) test(`a risk-recovery source question with a ${name} fences the transfer claim and is never retired`, t => {
  const directory = root(t);
  const source = riskBlockedSource(directory, sourceID, runID);
  const questions = new QuestionCheckpointStore(directory);
  const forged = forge(riskRecoveryQuestion(source, 'pending'));
  questions.write(sourceID, forged);
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: `stale-${name.replaceAll(' ', '-')}`, nativeUserMessageID: `user-${targetID}`, requestDigest: 'e'.repeat(64) };
  const expected = { sequence: source.sequence, digest: source.dataDigest };
  assert.throws(() => owners.claimTargetForTransfer(runID, sourceID, target, expected, 0, intent), /not idle|target is occupied/);
  assert.throws(() => owners.reserveVerifiedTransfer(runID, sourceID, target, expected, 0, intent), /unresolved work or a native question/);
  assert.deepEqual(questions.read(sourceID), forged);
  assert.equal(owners.parent(targetID), undefined);
  assert.equal(owners.read(runID).state, 'idle');
  const assessed = assessTransfer({ sourceSessionID: sourceID, runID, userText: `sourceSessionID=${sourceID} runID=${runID}` },
    { sessionID: targetID, agent: 'mdd-orchestrator', directory, worktree: directory },
    new CheckpointStore(directory), new ProgressGuard(directory), questions);
  assert.equal(assessed.diagnostic, 'pending-unknown');
});

test('a risk-recovery source question bound to this exact run and checkpoint does not fence the transfer preflight', t => {
  const directory = root(t);
  const source = riskBlockedSource(directory, sourceID, runID);
  const questions = new QuestionCheckpointStore(directory);
  questions.write(sourceID, riskRecoveryQuestion(source, 'pending'));
  const assessed = assessTransfer({ sourceSessionID: sourceID, runID, userText: `sourceSessionID=${sourceID} runID=${runID}` },
    { sessionID: targetID, agent: 'mdd-orchestrator', directory, worktree: directory },
    new CheckpointStore(directory), new ProgressGuard(directory), questions);
  assert.notEqual(assessed.diagnostic, 'pending-unknown');
});

test('clearIf removes a question record only while it is exactly the one that was read', t => {
  const directory = root(t);
  const source = riskBlockedSource(directory, sourceID, runID);
  const questions = new QuestionCheckpointStore(directory);
  const pending = riskRecoveryQuestion(source, 'pending');
  questions.write(sourceID, pending);
  const answered = { ...riskRecoveryQuestion(source, 'answered'), sequence: 2 };
  questions.write(sourceID, answered);
  // A stale expectation (the pending record) never deletes the answered one that replaced it.
  assert.throws(() => questions.clearIf(sourceID, pending), /changed since it was read/);
  assert.deepEqual(questions.read(sourceID), answered);
  questions.clearIf(sourceID, answered);
  assert.equal(questions.read(sourceID), undefined);
  // Nothing to clear is a change too: the caller expected a record that is gone.
  assert.throws(() => questions.clearIf(sourceID, answered), /changed since it was read/);
});

test('a source answer landing between the confirmed claim and retirement is never discarded', t => {
  const directory = root(t);
  const source = riskBlockedSource(directory, sourceID, runID);
  const questions = new QuestionCheckpointStore(directory);
  questions.write(sourceID, riskRecoveryQuestion(source, 'pending'));
  const answered = { ...riskRecoveryQuestion(source, 'answered'), sequence: 2 };
  // Interleave deterministically: the source's own answer is written after the target claim was
  // confirmed and immediately before the conditional retirement runs.
  const original = QuestionCheckpointStore.prototype.clearIf;
  t.mock.method(QuestionCheckpointStore.prototype, 'clearIf', function (parent, expected) {
    new QuestionCheckpointStore(directory).write(sourceID, answered);
    return original.call(this, parent, expected);
  });
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: 'race-answer', nativeUserMessageID: `user-${targetID}`, requestDigest: 'd'.repeat(64) };
  assert.throws(() => owners.claimTargetForTransfer(runID, sourceID, target,
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent), /reconcile explicitly/);
  // The concurrent answer survives intact; the source still owns the run; the confirmed claim
  // remains only for explicit recovery, and recovery refuses while the answer is unresolved.
  assert.deepEqual(questions.read(sourceID), answered);
  assert.equal(owners.read(runID).ownerSessionID, sourceID);
  assert.equal(owners.read(runID).state, 'idle');
  assert.equal(owners.parentClaim(targetID)?.transfer?.operationID, 'race-answer');
});

function publishTarget(directory, source, targetParent) {
  const data = { ...source.data, userMessageID: `user-${targetParent}`, usedMessages: [`user-${targetParent}`], proposed: [] };
  const target = { ...source, parent: targetParent, sequence: 0, data,
    dataDigest: sealResumeData(data, source.runID, targetParent, source.events, source.stable) };
  new CheckpointStore(directory).write(targetParent, target);
  const sourceMarker = new ProgressGuard(directory).read(source.parent);
  if (sourceMarker) new ProgressGuard(directory).write(targetParent, { ...sourceMarker, userMessageID: `user-${targetParent}` });
  return target;
}

test('two store instances reserve one writer; transfer never steals a pending task or stale epoch', t => {
  const directory = root(t);
  const first = new RunOwnershipStore(directory);
  const second = new RunOwnershipStore(directory);
  assert.equal(claim(first, directory).epoch, 0);
  assert.throws(() => second.claim({ runID, sessionID: targetID, directory, worktree: directory }));
  assert.equal(first.reserve(runID, sourceID, 'call-1', 0).state, 'reserved');
  assert.throws(() => second.reserve(runID, targetID, 'call-2', 1));
  assert.throws(() => second.beginTransfer(runID, sourceID, { sessionID: targetID, directory, worktree: directory }, 'a'.repeat(64), 1));
  assert.throws(() => first.release(runID, sourceID, 'other-call', 1));
  assert.equal(first.release(runID, sourceID, 'call-1', 1).epoch, 2);
  assert.throws(() => second.reserve(runID, sourceID, 'call-1', 0));
  assert.throws(() => second.beginTransfer(runID, sourceID, { sessionID: targetID, directory: root(t), worktree: directory }, 'a'.repeat(64), 2));
  const transferring = second.beginTransfer(runID, sourceID, { sessionID: targetID, directory, worktree: directory }, 'a'.repeat(64), 2);
  assert.equal(transferring.state, 'transferring');
  assert.equal(transferring.ownerSessionID, sourceID);
  assert.equal(transferring.transfer.targetSessionID, targetID);
  assert.throws(() => first.reserve(runID, sourceID, 'late-source', 3));
  assert.throws(() => second.reserve(runID, targetID, 'early-target', 3));
  assert.equal(new RunOwnershipStore(directory).read(runID).state, 'transferring');
});

test('orphaned owner lock is never reclaimed by timestamp; both writers remain blocked', t => {
  const directory = root(t);
  const store = new RunOwnershipStore(directory);
  claim(store, directory);
  const guard = `${ownerPath(directory)}.lock`;
  writeFileSync(guard, 'uncertain writer');
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(guard, longAgo, longAgo);
  // The committed record stays readable (replacement is an atomic rename); only writes wait.
  assert.equal(store.read(runID).state, 'idle');
  assert.throws(() => new RunOwnershipStore(directory).reserve(runID, sourceID, 'call', 0), /cannot be confirmed|unconfirmed/);
  assert.throws(() => store.reserve(runID, sourceID, 'call', 0), /unconfirmed/);
  assert.equal(existsSync(guard), true);
});

test('crash after owner reservation or target checkpoint publication grants neither parent authority', t => {
  const directory = root(t);
  const store = new RunOwnershipStore(directory);
  claim(store, directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  store.beginTransfer(runID, sourceID, target, 'b'.repeat(64), 0);
  const restarted = new RunOwnershipStore(directory);
  assert.equal(new CheckpointStore(directory).read(targetID), undefined);
  assert.equal(restarted.read(runID).state, 'transferring');
  assert.throws(() => restarted.reserve(runID, sourceID, 'source-after-crash', 1));
  const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex' } };
  const workflow = new Workflow(request);
  throughRisk(workflow, 'low');
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory, worktree: directory, userMessageID: 'target-user', requirements: 'Continue safely.',
    context: [], dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: [], usedMessages: [], proposed: [], risk: { verdict: riskVerdict('low'), ref: riskRef(runID) } };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const events = workflow.history();
  new CheckpointStore(directory).write(targetID, { version: 3, parent: targetID, runID, sequence: 0,
    request, events, data, stable, dataDigest: sealResumeData(data, runID, targetID, events, stable) });
  assert.equal(restarted.read(runID).state, 'transferring');
  assert.throws(() => restarted.reserve(runID, targetID, 'target-after-publication', 1));
});

test('uncertain owner write after atomic rename leaves a transferring fence, never an automatic takeover', t => {
  const directory = root(t);
  const files = new LocalFiles(directory);
  const store = new RunOwnershipStore(directory);
  claim(store, directory);
  const faulty = new RunOwnershipStore(directory, {
    readStrict: (name, limit) => files.readStrict(name, limit),
    updateStrict: (name, change, limit) => { files.updateStrict(name, change, limit); throw new Error('Connection lost after rename.'); },
  });
  assert.throws(() => faulty.beginTransfer(runID, sourceID,
    { sessionID: targetID, directory, worktree: directory }, 'c'.repeat(64), 0), /unconfirmed/);
  assert.equal(store.read(runID).state, 'transferring');
  assert.throws(() => store.reserve(runID, sourceID, 'late-source', 1));
  assert.throws(() => store.reserve(runID, targetID, 'early-target', 1));
});

test('distinct run IDs race for one parent across actual child processes', async t => {
  const directory = root(t);
  new RunOwnershipStore(directory).claimParent('ses-bootstrap', 'run-bootstrap');
  const moduleURL = pathToFileURL(join(process.cwd(), 'dist', 'run-ownership.js')).href;
  const source = `import { RunOwnershipStore } from ${JSON.stringify(moduleURL)}; try { new RunOwnershipStore(process.argv[1]).claimParent('ses-racing', process.argv[2]); process.stdout.write('won'); } catch { process.stdout.write('blocked'); }`;
  const launch = runID => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, runID], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
  });
  const results = await Promise.all([launch('run-a'), launch('run-b')]);
  assert.ok(results.filter(result => result === 'won').length <= 1);
  assert.ok(['run-a', 'run-b'].includes(new RunOwnershipStore(directory).parent('ses-racing')));
});

test('retiring a parent invalidates the old run before another run is claimed', t => {
  const directory = root(t);
  const first = new RunOwnershipStore(directory);
  const second = new RunOwnershipStore(directory);
  first.claimParent(sourceID, runID);
  assert.throws(() => second.claimParent(sourceID, 'other-run'));
  first.retireParent(sourceID, runID);
  assert.equal(second.parent(sourceID), undefined);
  second.claimParent(sourceID, 'other-run');
  assert.equal(first.parent(sourceID), 'other-run');
  assert.throws(() => first.bindParent(sourceID, runID));
});

test('native intake preflight slot admits one writer across actual child processes', async t => {
  const directory = root(t);
  // The race under test is the same-parent CAS, not initial .mdd directory creation.
  new RunOwnershipStore(directory).claimIntake('ses-bootstrap', 'bootstrap', 'native-user');
  const moduleURL = pathToFileURL(join(process.cwd(), 'dist', 'run-ownership.js')).href;
  const source = `import { RunOwnershipStore } from ${JSON.stringify(moduleURL)}; try { new RunOwnershipStore(process.argv[1]).claimIntake('ses-preflight', process.argv[2], 'native-user'); process.stdout.write('won'); } catch (error) { process.stdout.write('blocked:' + error.message); }`;
  const launch = token => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, token], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
  });
  const results = await Promise.all([launch('intake-a'), launch('intake-b')]);
  assert.ok(results.filter(result => result === 'won').length <= 1, results.join(' | '));
  const intake = new RunOwnershipStore(directory).intake('ses-preflight');
  assert.equal(intake.state, 'pending');
  assert.ok(['intake-a', 'intake-b'].includes(intake.token));
});

test('native and coordinator reservations race for one run across actual child processes', async t => {
  const directory = root(t);
  const store = new RunOwnershipStore(directory);
  claim(store, directory);
  store.bindParent(sourceID, runID);
  const moduleURL = pathToFileURL(join(process.cwd(), 'dist', 'run-ownership.js')).href;
  const source = `import { RunOwnershipStore } from ${JSON.stringify(moduleURL)}; try { new RunOwnershipStore(process.argv[1]).reserve(${JSON.stringify(runID)}, ${JSON.stringify(sourceID)}, process.argv[2], 0); process.stdout.write('won'); } catch (error) { process.stdout.write('blocked:' + error.message); }`;
  const launch = callID => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, directory, callID], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(error)));
  });
  const results = await Promise.all([launch('native-task'), launch('operation-context')]);
  assert.ok(results.filter(result => result === 'won').length <= 1, results.join(' | '));
  const owner = store.read(runID);
  assert.equal(owner.state, 'reserved');
  assert.ok(['native-task', 'operation-context'].includes(owner.callID));
  assert.throws(() => store.beginTransfer(runID, sourceID, { sessionID: targetID, directory, worktree: directory }, 'a'.repeat(64), owner.epoch));
});

test('reset handoff keeps the owner reserved while old callback and transfer are fenced', t => {
  const directory = root(t);
  const source = new RunOwnershipStore(directory);
  const rival = new RunOwnershipStore(directory);
  claim(source, directory);
  source.bindParent(sourceID, runID);
  source.reserve(runID, sourceID, 'task-old', 0);
  const recovery = { sourceCallID: 'task-old', kind: 'task', checkpointSequence: 2, checkpointDigest: 'a'.repeat(64) };
  const held = source.handoff(runID, sourceID, 'task-old', 'reset-new', 1, recovery);
  assert.equal(held.state, 'reserved');
  assert.equal(held.callID, 'reset-new');
  assert.deepEqual(rival.read(runID).recovery, recovery);
  assert.throws(() => rival.release(runID, sourceID, 'task-old', held.epoch));
  assert.throws(() => rival.beginTransfer(runID, sourceID,
    { sessionID: targetID, directory, worktree: directory }, 'b'.repeat(64), held.epoch));
  assert.throws(() => rival.handoff(runID, sourceID, 'task-old', 'reset-rival', held.epoch, recovery));
  source.release(runID, sourceID, 'reset-new', held.epoch);
  assert.equal(source.read(runID).state, 'idle');
});

test('verified reservation admits a risk-ready source but refuses an unconfirmed risk-await-result one', t => {
  const directory = root(t);
  const ready = riskStopSource(directory, sourceID, runID, 'risk-ready');
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: 'risk-stop-transfer', nativeUserMessageID: `user-${targetID}`, requestDigest: 'd'.repeat(64) };
  const reserved = owners.reserveVerifiedTransfer(runID, sourceID, target,
    { sequence: ready.sequence, digest: ready.dataDigest }, 0, intent);
  assert.equal(reserved.state, 'transferring');
  assert.equal(owners.parent(targetID), runID);
});

test('reserveVerifiedTransfer refuses an unsettled risk-await-result source even with no pending marker', t => {
  const otherDirectory = root(t);
  const pending = riskStopSource(otherDirectory, sourceID, 'run-risk-pending', 'risk-await-result');
  const owners = new RunOwnershipStore(otherDirectory);
  const target = { sessionID: targetID, directory: otherDirectory, worktree: otherDirectory };
  const intent = { operationID: 'risk-stop-pending', nativeUserMessageID: `user-${targetID}`, requestDigest: 'e'.repeat(64) };
  assert.throws(() => owners.reserveVerifiedTransfer('run-risk-pending', sourceID, target,
    { sequence: pending.sequence, digest: pending.dataDigest }, 0, intent), /not an idle, unoccupied transfer boundary/);
  assert.equal(owners.parent(targetID), undefined);
  assert.equal(owners.read('run-risk-pending').state, 'idle');
});

test('verified reservation fences both parents until correlated target publication and finish CAS', t => {
  const directory = root(t);
  const source = transferSource(directory, sourceID, runID);
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: 'transfer-request-1', nativeUserMessageID: `user-${targetID}`, requestDigest: 'f'.repeat(64) };
  const reserved = owners.reserveVerifiedTransfer(runID, sourceID, target,
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent);
  assert.equal(reserved.state, 'transferring');
  assert.equal(reserved.transfer.sourceSequence, source.sequence);
  assert.equal(owners.parent(targetID), runID);
  assert.throws(() => owners.reserve(runID, sourceID, 'old-source', reserved.epoch));
  assert.throws(() => owners.reserve(runID, targetID, 'early-target', reserved.epoch));
  assert.throws(() => owners.finishVerifiedTransfer(runID, sourceID, targetID, reserved.epoch,
    { sourceSequence: source.sequence, sourceDigest: source.dataDigest, targetSequence: 0, targetDigest: 'a'.repeat(64) }, intent));
  const published = publishTarget(directory, source, targetID);
  const finished = owners.finishVerifiedTransfer(runID, sourceID, targetID, reserved.epoch,
    { sourceSequence: source.sequence, sourceDigest: source.dataDigest, targetSequence: published.sequence, targetDigest: published.dataDigest }, intent);
  assert.equal(finished.ownerSessionID, targetID);
  assert.equal(finished.state, 'idle');
  assert.equal(owners.confirmReceipt(runID, targetID).operationID, intent.operationID);
  assert.deepEqual(owners.finishVerifiedTransfer(runID, sourceID, targetID, reserved.epoch,
    { sourceSequence: source.sequence, sourceDigest: source.dataDigest, targetSequence: published.sequence, targetDigest: published.dataDigest }, intent), finished);
  assert.throws(() => owners.reserve(runID, sourceID, 'late-source', finished.epoch));
  assert.equal(owners.reserve(runID, targetID, 'target-task', finished.epoch).state, 'reserved');
});

test('two targets cannot fence one source and two sources cannot claim one target', t => {
  const directory = root(t);
  const source = transferSource(directory, sourceID, runID);
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: 'target-race', nativeUserMessageID: `user-${targetID}`, requestDigest: 'a'.repeat(64) };
  owners.reserveVerifiedTransfer(runID, sourceID, target, { sequence: source.sequence, digest: source.dataDigest }, 0, intent);
  assert.throws(() => owners.reserveVerifiedTransfer(runID, sourceID,
    { sessionID: 'ses-other-target', directory, worktree: directory }, { sequence: source.sequence, digest: source.dataDigest }, 1,
    { ...intent, nativeUserMessageID: 'user-ses-other-target' }));
  assert.equal(owners.parent('ses-other-target'), undefined);
  const other = transferSource(directory, 'ses-other-source', 'run-other-source');
  assert.throws(() => owners.reserveVerifiedTransfer(other.runID, other.parent, target,
    { sequence: other.sequence, digest: other.dataDigest }, 0, { ...intent, operationID: 'other-source' }));
  assert.equal(owners.read(other.runID).state, 'idle');
  assert.equal(owners.read(runID).state, 'transferring');
});

test('two target claims before fencing admit only one executable owner', t => {
  const directory = root(t);
  const source = transferSource(directory, sourceID, runID);
  const owners = new RunOwnershipStore(directory);
  const first = { sessionID: targetID, directory, worktree: directory };
  const second = { sessionID: 'ses-second-target', directory, worktree: directory };
  const intent = { operationID: 'two-targets', nativeUserMessageID: `user-${targetID}`, requestDigest: 'c'.repeat(64) };
  owners.claimTargetForTransfer(runID, sourceID, first, { sequence: source.sequence, digest: source.dataDigest }, 0, intent);
  owners.claimTargetForTransfer(runID, sourceID, second, { sequence: source.sequence, digest: source.dataDigest }, 0,
    { ...intent, nativeUserMessageID: 'user-ses-second-target' });
  const winner = owners.beginTransfer(runID, sourceID, first, source.dataDigest, 0, source.sequence, intent);
  assert.throws(() => owners.beginTransfer(runID, sourceID, second, source.dataDigest, 0, source.sequence,
    { ...intent, nativeUserMessageID: 'user-ses-second-target' }));
  assert.equal(owners.read(runID).transfer.targetSessionID, targetID);
  assert.equal(owners.parent(second.sessionID), runID);
  assert.throws(() => owners.claimParent(second.sessionID, 'unrelated-run'));
  assert.throws(() => owners.reserve(runID, first.sessionID, 'early-first', winner.epoch));
  assert.throws(() => owners.reserve(runID, second.sessionID, 'early-second', winner.epoch));
});

test('crash between target claim and source fence blocks target while source remains idle', t => {
  const directory = root(t);
  const source = transferSource(directory, sourceID, runID);
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: 'before-source-fence', nativeUserMessageID: `user-${targetID}`, requestDigest: 'b'.repeat(64) };
  const claim = owners.claimTargetForTransfer(runID, sourceID, target,
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent);
  assert.equal(claim.transfer.ownerEpoch, 0);
  assert.equal(owners.read(runID).state, 'idle');
  assert.equal(owners.parent(targetID), runID);
  assert.throws(() => owners.claimParent(targetID, 'unrelated-run'));
  assert.throws(() => owners.retireParent(targetID, runID));
  assert.throws(() => owners.finishVerifiedTransfer(runID, sourceID, targetID, 0,
    { sourceSequence: source.sequence, sourceDigest: source.dataDigest, targetSequence: 0, targetDigest: 'c'.repeat(64) }, intent));
  const fenced = owners.beginTransfer(runID, sourceID, target, source.dataDigest, 0, source.sequence, intent);
  assert.equal(fenced.state, 'transferring');
  assert.throws(() => owners.reserve(runID, sourceID, 'late-source', fenced.epoch));
  assert.throws(() => owners.reserve(runID, targetID, 'early-target', fenced.epoch));
});

for (const stage of ['before-source-cas', 'after-source-cas']) test(`verified reservation crash ${stage} never exposes target`, t => {
  const directory = root(t);
  const source = transferSource(directory, sourceID, runID);
  const owners = new RunOwnershipStore(directory);
  const target = { sessionID: targetID, directory, worktree: directory };
  const intent = { operationID: stage, nativeUserMessageID: `user-${targetID}`, requestDigest: 'd'.repeat(64) };
  const original = owners.beginTransfer.bind(owners);
  owners.beginTransfer = (...args) => { if (stage === 'after-source-cas') original(...args); throw new Error('Injected process stop.'); };
  assert.throws(() => owners.reserveVerifiedTransfer(runID, sourceID, target,
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent), /Injected process stop/);
  const current = new RunOwnershipStore(directory);
  assert.equal(current.parentClaim(targetID).transfer.operationID, stage);
  assert.equal(current.read(runID).state, stage === 'before-source-cas' ? 'idle' : 'transferring');
  assert.throws(() => current.claimParent(targetID, 'another-run'));
  assert.throws(() => current.retireParent(targetID, runID));
  assert.throws(() => current.reserve(runID, targetID, 'early-target', current.read(runID).epoch));
});

test('source checkpoint drift after reservation leaves published target fenced', t => {
  const directory = root(t);
  const source = transferSource(directory, sourceID, runID);
  const owners = new RunOwnershipStore(directory);
  const intent = { operationID: 'transfer-drift', nativeUserMessageID: `user-${targetID}`, requestDigest: 'f'.repeat(64) };
  const reserved = owners.reserveVerifiedTransfer(runID, sourceID,
    { sessionID: targetID, directory, worktree: directory }, { sequence: source.sequence, digest: source.dataDigest }, 0, intent);
  const published = publishTarget(directory, source, targetID);
  new CheckpointStore(directory).write(sourceID, { ...source, sequence: source.sequence + 1 });
  assert.throws(() => owners.finishVerifiedTransfer(runID, sourceID, targetID, reserved.epoch,
    { sourceSequence: source.sequence, sourceDigest: source.dataDigest, targetSequence: published.sequence, targetDigest: published.dataDigest }, intent));
  assert.equal(owners.read(runID).state, 'transferring');
  assert.throws(() => owners.reserve(runID, targetID, 'not-authorized', reserved.epoch));
});
