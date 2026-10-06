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

function transferSource(directory, parent, id) {
  const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex' } };
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const data = { directory, worktree: directory, userMessageID: `user-${parent}`, requirements: 'Plan a safe change.',
    context: [], dependencies: [], contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: [], usedMessages: [`user-${parent}`], proposed: [] };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const events = new Workflow(request).history();
  const checkpoint = { version: 3, parent, runID: id, sequence: 0, request, events, data, stable,
    dataDigest: sealResumeData(data, id, parent, events, stable) };
  new CheckpointStore(directory).write(parent, checkpoint);
  const owners = new RunOwnershipStore(directory);
  owners.claimParent(parent, id);
  owners.claim({ runID: id, sessionID: parent, directory, worktree: directory });
  return checkpoint;
}

function publishTarget(directory, source, targetParent) {
  const data = { ...source.data, userMessageID: `user-${targetParent}`, usedMessages: [`user-${targetParent}`], proposed: [] };
  const target = { ...source, parent: targetParent, sequence: 0, data,
    dataDigest: sealResumeData(data, source.runID, targetParent, source.events, source.stable) };
  new CheckpointStore(directory).write(targetParent, target);
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
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const data = { directory, worktree: directory, userMessageID: 'target-user', requirements: 'Continue safely.',
    context: [], dependencies: [], contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: [], usedMessages: [], proposed: [] };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const events = new Workflow(request).history();
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
