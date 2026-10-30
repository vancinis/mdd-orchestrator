import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'node:fs';
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

import { assessTransfer } from '../dist/transfer.js';
import { AdaptiveLow } from '../dist/adaptive-low.js';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { projectAdaptiveTransfer, adaptiveTransferRequest } from '../dist/adaptive-transfer.js';
import { nativeOperation } from '../dist/adaptive-native.js';

const runID = 'run-owned';
const sourceID = 'ses-source';
const targetID = 'ses-target';
function root(t) { const path = mkdtempSync(join(tmpdir(), 'mdd-owner-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function ownerPath(root) { return join(root, '.mdd', `owner-${createHash('sha256').update(runID).digest('hex')}.json`); }
function claim(store, directory) { return store.claim({ runID, sessionID: sourceID, directory, worktree: directory }); }

function policyTransfer(t) {
  const directory = root(t); writeFileSync(join(directory, 'own.txt'), 'original');
  const scope = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
  const contract = { contractVersion: 1, objective: 'Replace bounded text.',
    acceptance: { goal: 'Replacement', requirements: [{ id: 'R1', description: 'Replace text', scenarios: [{ id: 'S1', given: 'Original', when: 'Replaced', then: 'Updated' }] }] },
    exclusions: [], decisions: [], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'Inspected source.', fingerprints: [{ path: 'own.txt', digest: createHash('sha256').update('original').digest('hex') }] },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', path: 'own.txt', description: 'Replace text', scenarios: ['S1'], decisions: [], dependsOn: [], scope,
      obligations: { source: [{ id: 'E1', description: 'Read source', paths: ['own.txt'] }], checks: [] } }] };
  const low = new AdaptiveLow(contract, directory), store = new AdaptiveStore(directory), ownership = new RunOwnershipStore(directory), questions = new QuestionCheckpointStore(directory);
  const id = 'adaptive-internal-policy-unit';
  const source = store.commit(sourceID, undefined, { runID: id, sessionID: sourceID, directory, worktree: directory, agent: 'mdd-orchestrator', userMessageID: 'source-user', stage: 'active', data: low.serialize(), calls: [] });
  ownership.claim({ runID: id, sessionID: sourceID, directory, worktree: directory }); ownership.bindAdaptive(sourceID, id);
  const operation = nativeOperation({ kind: 'transfer', args: { sourceSessionID: sourceID, runID: id, operationID: 'policy-hop', messageID: 'target-message' } });
  let record = { version: 2, parent: targetID, sequence: 0, runID: id, requirements: contract.objective, known: { mode: 'interactive' },
    adaptive: { directory, worktree: directory, nonce: 'exact-policy-question', purpose: 'operation', operation,
      generation: { runID: id, sequence: source.sequence, digest: source.digest, epoch: 0, handle: low.status().selection.handle, sources: low.policySources() } },
    state: 'prepared', slot: { kind: 'adaptive', args: { questions: [{ header: 'Approval', question: 'Authorize this exact bounded transfer?', multiple: false, options: [{ label: 'Approve operation', description: 'Authorize only this operation.' }] }] } }, clarifications: [], deferred: [], clarificationAnswers: [] };
  questions.write(targetID, record); ownership.prepareAdaptivePolicyQuestion(store, source, record);
  record = { ...record, sequence: 1, state: 'pending', callID: 'native-question-call' }; questions.write(targetID, record);
  record = { ...record, sequence: 2, state: 'answered', answer: [['Approve operation']] }; questions.write(targetID, record);
  const { answer, ...rest } = record; record = { ...rest, sequence: 3, state: 'settled', nativeReceipt: { callID: rest.callID, answers: answer } }; questions.write(targetID, record);
  const lineage = { sourceSessionID: sourceID, sourceSequence: source.sequence, sourceDigest: source.digest, ownerEpoch: 0,
    operationID: 'policy-hop', nativeUserMessageID: 'target-user', requestDigest: createHash('sha256').update(adaptiveTransferRequest(source)).digest('hex') };
  const target = projectAdaptiveTransfer(store, source, { sessionID: targetID, directory, worktree: directory, agent: 'mdd-orchestrator' }, lineage);
  return { directory, store, ownership, questions, source, target, record };
}

test('AL05a ownership: only a consumed exact policy receipt is exempt from target occupancy', t => {
  const f = policyTransfer(t);
  assert.throws(() => f.ownership.claimAdaptiveTarget(f.store, f.source, f.target, 0), /occupied/);
  f.ownership.consumeAdaptivePolicyQuestion(f.store, f.source, f.record);
  assert.equal(f.ownership.matchingAdaptivePolicyQuestion(f.store, f.source, targetID, 'policy-hop'), true);
  f.ownership.claimAdaptiveTarget(f.store, f.source, f.target, 0);
  f.ownership.beginAdaptiveTransfer(f.store, f.source, targetID, 'policy-hop');
  f.ownership.publishAdaptiveTransfer(f.store, f.source, f.target);
  f.ownership.finishAdaptiveTransfer(f.store, f.source, f.target);
  assert.equal(f.ownership.read(f.source.runID).policyQuestion, undefined);
  assert.deepEqual(f.questions.read(targetID), f.record, 'consumed approval receipt must never be swept or deleted');
});

function retiredPolicyAbort(t) {
  const f = policyTransfer(t), id = f.source.runID;
  f.ownership.consumeAdaptivePolicyQuestion(f.store, f.source, f.record);
  f.ownership.claimAdaptiveTarget(f.store, f.source, f.target, 0);
  f.ownership.beginAdaptiveTransfer(f.store, f.source, targetID, 'policy-hop');
  f.ownership.publishAdaptiveTransfer(f.store, f.source, f.target);
  const operation = nativeOperation({ kind: 'transfer-recovery', args: { sourceSessionID: sourceID, runID: id,
    operationID: 'policy-hop', action: 'abort', messageID: 'native-abort-message' } });
  const { callID: _call, nativeReceipt: _receipt, ...previous } = f.record;
  let record = { ...previous, sequence: 4, state: 'prepared', retiredCalls: [f.record.callID],
    adaptive: { ...previous.adaptive, nonce: 'exact-abort-question', operation,
      generation: { ...previous.adaptive.generation, epoch: f.ownership.read(id).epoch } },
    slot: { kind: 'adaptive', args: { questions: [{ header: 'Abort approval', question: 'Authorize only this exact abort recovery?', multiple: false,
      options: [{ label: 'Approve operation', description: 'Authorize this abort operation only.' }] }] } } };
  f.questions.write(targetID, record); f.ownership.prepareAdaptivePolicyQuestion(f.store, f.source, record);
  record = { ...record, sequence: 5, state: 'pending', callID: 'native-abort-call' }; f.questions.write(targetID, record);
  record = { ...record, sequence: 6, state: 'answered', answer: [['Approve operation']] }; f.questions.write(targetID, record);
  const { answer, ...settled } = record;
  record = { ...settled, sequence: 7, state: 'settled', nativeReceipt: { callID: settled.callID, answers: answer } }; f.questions.write(targetID, record);
  f.ownership.consumeAdaptivePolicyQuestion(f.store, f.source, record);
  const commit = f.store.commit.bind(f.store); let interrupted = false;
  t.mock.method(f.store, 'commit', (...args) => {
    const result = commit(...args);
    if (!interrupted && args[0] === sourceID) { interrupted = true; throw new Error('Injected after abort source rotation.'); }
    return result;
  });
  assert.throws(() => f.ownership.abortAdaptiveTransfer(f.store, f.source, targetID, 'policy-hop'), /source rotation/);
  assert.equal(f.ownership.parentClaim(targetID).retired, true);
  assert.equal(f.store.read(sourceID).sequence, f.source.sequence + 1);
  assert.equal(f.store.read(targetID), undefined);
  const proposal = nativeOperation({ ...operation, args: { ...operation.args, messageID: 'fresh-native-abort-message' } });
  const path = join(f.directory, '.mdd', `owner-${createHash('sha256').update(id).digest('hex')}.json`);
  return { ...f, record, proposal, path };
}

test('AL05b ownership: exact reserved abort permits only a fresh proposal after retired claim and source rotation', t => {
  const f = retiredPolicyAbort(t), before = f.ownership.read(f.source.runID), source = f.store.read(sourceID);
  assert.doesNotThrow(() => f.ownership.assertAdaptivePolicyProposalAvailable(sourceID, f.proposal, targetID));
  assert.deepEqual(f.ownership.read(f.source.runID), before, 'proposal eligibility does not consume or replace approval');
  assert.deepEqual(f.store.read(sourceID), source); assert.deepEqual(f.questions.read(targetID), f.record);
  assert.throws(() => f.ownership.assertAdaptivePolicyAvailable(sourceID, f.proposal), /fences/);
});

for (const field of ['operation', 'target', 'source', 'run', 'finish', 'epoch', 'fence epoch', 'receipt', 'nonce', 'operation digest',
  'generation digest', 'call', 'reservation operation', 'checkpoint', 'source generation', 'historical receipt with wrong epoch', 'historical receipt with foreign reservation',
  'pending question', 'foreign question', 'changed answer', 'fixed question', 'stale question generation']) {
  test(`AL05b ownership: retired abort proposal rejects ${field} without authority mutation`, t => {
    const f = retiredPolicyAbort(t), owner = f.ownership.read(f.source.runID), proposal = structuredClone(f.proposal);
    if (field === 'operation') proposal.args.operationID = 'foreign-operation';
    if (field === 'target') owner.recoveringTransfer.targetSessionID = 'foreign-target';
    if (field === 'source') proposal.args.sourceSessionID = 'foreign-source';
    if (field === 'run') proposal.args.runID = 'foreign-run';
    if (field === 'finish') proposal.args.action = 'finish';
    if (field === 'epoch') owner.epoch++;
    if (field === 'fence epoch') owner.policyQuestion.epoch++;
    if (field === 'receipt') owner.policyQuestion.receiptDigest = 'f'.repeat(64);
    if (field === 'nonce') owner.policyQuestion.nonce = 'foreign-nonce';
    if (field === 'operation digest') owner.policyQuestion.operationDigest = 'f'.repeat(64);
    if (field === 'generation digest') owner.policyQuestion.generationDigest = 'f'.repeat(64);
    if (field === 'call') owner.policyQuestion.callID = 'foreign-call';
    if (field === 'reservation operation') owner.operation.name = 'unrelated-reservation';
    if (field === 'checkpoint') owner.operation.checkpointDigest = 'f'.repeat(64);
    if (field === 'source generation') {
      const current = f.store.read(sourceID), { version, sequence, digest, admissionDigest, ...body } = current;
      f.store.commit(sourceID, current, body);
    }
    if (field.startsWith('historical receipt')) {
      owner.recoveredTransfer = { operationID: 'policy-hop', targetSessionID: targetID, sourceSequence: 0, sourceDigest: f.source.digest, action: 'abort-fenced' };
      if (field.endsWith('epoch')) owner.epoch++;
      else owner.recoveringTransfer.targetSessionID = 'foreign-target';
    }
    if (['pending question', 'foreign question', 'changed answer', 'fixed question', 'stale question generation'].includes(field)) {
      let question = structuredClone(f.record);
      if (field === 'pending question') { question.state = 'pending'; delete question.nativeReceipt; }
      if (field === 'foreign question') question.adaptive.operation.args.sourceSessionID = 'foreign-source';
      if (field === 'changed answer') {
        question.slot.args.questions[0].options.push({ label: 'Pause', description: 'Keep the operation unauthorized.' });
        question.nativeReceipt.answers = [['Pause']];
      }
      if (field === 'stale question generation') question.adaptive.generation.epoch++;
      if (field === 'fixed question') question = { version: 1, parent: targetID, sequence: 8, requirements: 'Fixed request', known: {}, state: 'prepared',
        slot: { kind: 'preflight', args: f.record.slot.args }, clarifications: [], deferred: [], clarificationAnswers: [] };
      new LocalFiles(f.directory).update(`.mdd/question-${createHash('sha256').update(targetID).digest('hex')}.json`, () => JSON.stringify(question), 160000);
      // Even a matching historical checksum cannot make a foreign/non-approving question consent.
      owner.policyQuestion.receiptDigest = createHash('sha256').update(JSON.stringify(question)).digest('hex');
      owner.recoveredTransfer = { operationID: 'policy-hop', targetSessionID: targetID, sourceSequence: 0, sourceDigest: f.source.digest, action: 'abort-fenced' };
    }
    writeFileSync(f.path, JSON.stringify(owner));
    const before = readFileSync(f.path, 'utf8'), source = f.store.read(sourceID), question = f.questions.read(targetID);
    assert.throws(() => f.ownership.assertAdaptivePolicyProposalAvailable(sourceID, proposal, targetID), /fences|generation|reservation/);
    assert.equal(readFileSync(f.path, 'utf8'), before); assert.deepEqual(f.store.read(sourceID), source);
    assert.deepEqual(f.questions.read(targetID), question);
  });
}

test('AL05a ownership: the durable prepared source fence prevents actor reservation and unapproved publication', t => {
  const f = policyTransfer(t), owner = f.ownership.read(f.source.runID);
  const cold = new RunOwnershipStore(f.directory);
  assert.throws(() => cold.reserve(f.source.runID, sourceID, 'competing-actor', owner.epoch), /unconfirmed/);
  assert.throws(() => cold.publishAdaptiveUpdate(f.store, f.source, { ...f.source }));
  const foreign = { ...f.record, adaptive: { ...f.record.adaptive, nonce: 'another-question' } };
  assert.throws(() => cold.releaseAdaptivePolicyQuestion(foreign), /unconfirmed/);
  assert.deepEqual(cold.read(f.source.runID), owner);
});

for (const field of ['digest', 'sequence', 'owner', 'workspace']) test(`AL05a ownership: a changed source fence ${field} cannot match a retained receipt`, t => {
  const f = policyTransfer(t); f.ownership.consumeAdaptivePolicyQuestion(f.store, f.source, f.record);
  const path = join(f.directory, '.mdd', `owner-${createHash('sha256').update(f.source.runID).digest('hex')}.json`);
  const owner = JSON.parse(readFileSync(path, 'utf8'));
  if (field === 'digest') owner.policyQuestion.digest = 'f'.repeat(64);
  if (field === 'sequence') owner.policyQuestion.sequence++;
  if (field === 'owner') owner.ownerSessionID = 'foreign-owner';
  if (field === 'workspace') owner.directory += '-foreign';
  writeFileSync(path, JSON.stringify(owner));
  if (field === 'owner') assert.throws(() => f.ownership.matchingAdaptivePolicyQuestion(f.store, f.source, targetID, 'policy-hop'), /cannot be confirmed/);
  else assert.equal(f.ownership.matchingAdaptivePolicyQuestion(f.store, f.source, targetID, 'policy-hop'), false);
  assert.throws(() => f.ownership.claimAdaptiveTarget(f.store, f.source, f.target, 0));
  assert.equal(f.ownership.parentClaim(targetID), undefined);
});

for (const kind of ['pending', 'unrelated', 'stale', 'foreign', 'fixed', 'changed workspace', 'changed handle', 'changed answer', 'changed call'])
  test(`AL05a ownership: ${kind} question never receives the consumed-approval occupancy exception`, t => {
    const f = policyTransfer(t); f.ownership.consumeAdaptivePolicyQuestion(f.store, f.source, f.record);
    let record = structuredClone(f.record);
    if (kind === 'pending') { record.state = 'pending'; delete record.nativeReceipt; }
    if (kind === 'unrelated') record.adaptive.operation.args.operationID = 'other-operation';
    if (kind === 'stale') record.adaptive.generation.sequence++;
    if (kind === 'foreign') record.adaptive.operation.args.sourceSessionID = 'another-source';
    if (kind === 'changed workspace') record.adaptive.directory += '-foreign';
    if (kind === 'changed handle') record.adaptive.generation.handle = 'another-handle';
    if (kind === 'changed answer') record.nativeReceipt.answers = [['Pause']];
    if (kind === 'changed call') { record.callID = 'other-call'; record.nativeReceipt.callID = 'other-call'; }
    if (kind === 'fixed') record = { version: 1, parent: targetID, sequence: 4, requirements: 'Legacy preflight', known: {}, state: 'prepared', slot: { kind: 'preflight', args: f.record.slot.args }, clarifications: [], deferred: [], clarificationAnswers: [] };
    const name = `.mdd/question-${createHash('sha256').update(targetID).digest('hex')}.json`;
    new LocalFiles(f.directory).update(name, () => JSON.stringify(record), 160000);
    assert.throws(() => f.ownership.claimAdaptiveTarget(f.store, f.source, f.target, 0));
    assert.equal(f.ownership.parentClaim(targetID), undefined);
  });

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
