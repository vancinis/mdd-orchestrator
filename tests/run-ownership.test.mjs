import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.throws(() => store.read(runID), /cannot be confirmed/);
  assert.throws(() => new RunOwnershipStore(directory).reserve(runID, sourceID, 'call', 0), /unconfirmed/);
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
