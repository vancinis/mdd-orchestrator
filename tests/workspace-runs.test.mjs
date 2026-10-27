import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunDossierStore, DOSSIER_VERSION } from '../dist/run-dossier.js';
import { CheckpointStore, sealResumeData } from '../dist/checkpoint.js';
import { Workflow } from '../dist/workflow.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { workspaceRuns, WORKSPACE_RUNS_SHOWN } from '../dist/workspace-runs.js';
import { nextAction } from '../dist/next-action.js';
import { statusPayload } from '../dist/status-budget.js';

function root(t) { const path = mkdtempSync(join(tmpdir(), 'mdd-workspace-runs-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
function file(path, parent) { return join(path, '.mdd', `run-${createHash('sha256').update(parent).digest('hex')}.json`); }
function dossier(path, change = {}) {
  return {
    version: DOSSIER_VERSION, runID: 'run-one',
    parent: { sessionID: 'ses_source', directory: path, worktree: path },
    userMessageID: 'user-1', requirements: 'Continúa el issue #433',
    context: [{ label: 'Issue #433 body', content: 'Custom date ranges and stock coverage.', source: 'coordinator' }],
    answers: { certainty: 'somewhat-sure', artifactStore: 'none', mode: 'automatic', summary: 'detailed' },
    route: ['mdd-explore', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify'], phase: 'mdd-apply', lastState: 'blocked',
    results: [
      { phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored the issue.' },
      { phase: 'mdd-tasks', outcome: 'passed', evidenceSummary: 'Planned three deliverables.' },
      { phase: 'mdd-apply', outcome: 'failed', evidenceSummary: 'T433-01 was not implemented: the scoped editor was unavailable.' },
    ],
    evidence: { requirements: 'confirmed', plan: 'confirmed', implementation: 'invalidated', checks: 'invalidated' },
    acceptance: { goal: 'Custom profitability windows, revenue ordering and stock coverage.' },
    decisions: [], planned: [], executedChecks: [], changedFiles: 0, concerns: [],
    artifacts: [], contexts: [], calls: ['task-1'], questionReceipts: [],
    usedMessages: ['user-1'], proposed: [], timestamp: 1790000000000, ...change,
  };
}
const target = path => ({ sessionID: 'ses_new', agent: 'mdd-orchestrator', directory: path, worktree: path });
function age(path, parent, seconds) { const when = new Date(Date.now() - seconds * 1000); utimesSync(file(path, parent), when, when); }

test('a new conversation sees the runs other conversations recorded here, newest first', t => {
  const path = root(t); const store = new RunDossierStore(path);
  assert.deepEqual(workspaceRuns(target(path), { dossier: store }), [], 'an empty workspace lists nothing and never throws');
  store.write('ses_source', dossier(path));
  store.write('ses_done', dossier(path, { runID: 'run-done', parent: { sessionID: 'ses_done', directory: path, worktree: path }, lastState: 'complete', requirements: 'An older finished objective.' }));
  age(path, 'ses_done', 600);
  const runs = workspaceRuns(target(path), { dossier: store });
  assert.deepEqual(runs.map(run => run.runID), ['run-one', 'run-done']);
  const [blocked, finished] = runs;
  assert.equal(blocked.capability, 'data-only');
  assert.equal(blocked.sessionID, 'ses_source');
  assert.equal(blocked.requirements, 'Continúa el issue #433');
  assert.equal(blocked.goal, 'Custom profitability windows, revenue ordering and stock coverage.');
  assert.deepEqual(blocked.providedContext, ['Issue #433 body']);
  assert.deepEqual(blocked.passed, ['mdd-explore', 'mdd-tasks']);
  assert.deepEqual(blocked.last, { phase: 'mdd-apply', outcome: 'failed', summary: 'T433-01 was not implemented: the scoped editor was unavailable.' });
  assert.equal(blocked.lastState, 'blocked');
  assert.match(blocked.file, /^\.mdd\/run-[a-f0-9]{64}\.json$/);
  // Without a projectable checkpoint the run can only go on where it lives.
  assert.equal(blocked.resume, 'source-conversation');
  assert.equal(finished.resume, 'finished');
  assert.equal(blocked.directory, undefined, 'the same checkout is not repeated');
});

test('the listing leaves out this conversation, empty and discarded records, moved runs and damaged files', t => {
  const path = root(t); const store = new RunDossierStore(path);
  store.write('ses_new', dossier(path, { runID: 'run-own', parent: { sessionID: 'ses_new', directory: path, worktree: path } }));
  store.write('ses_empty', dossier(path, { runID: 'run-empty', parent: { sessionID: 'ses_empty', directory: path, worktree: path }, results: [] }));
  store.write('ses_set_aside', dossier(path, { runID: 'run-aside', parent: { sessionID: 'ses_set_aside', directory: path, worktree: path } }));
  store.discard('ses_set_aside', Date.now());
  store.write('ses_moved', dossier(path, { runID: 'run-moved', parent: { sessionID: 'ses_moved', directory: path, worktree: path } }));
  const ownership = new RunOwnershipStore(path);
  ownership.claim({ sessionID: 'ses_elsewhere', agent: 'mdd-orchestrator', directory: path, worktree: path, runID: 'run-moved' });
  store.write('ses_broken', dossier(path));
  writeFileSync(file(path, 'ses_broken'), 'private damaged content');
  store.write('ses_source', dossier(path));
  const runs = workspaceRuns(target(path), { dossier: store, ownership });
  assert.deepEqual(runs.map(run => run.runID), ['run-one']);
  assert.ok(!JSON.stringify(runs).includes('private damaged content'));
});

test('the listing stays bounded however many conversations recorded a run', t => {
  const path = root(t); const store = new RunDossierStore(path);
  for (let index = 0; index < 10; index++) {
    const sessionID = `ses_${index}`;
    store.write(sessionID, dossier(path, { runID: `run-${index}`, parent: { sessionID, directory: path, worktree: path }, requirements: 'r'.repeat(20000) }));
  }
  const runs = workspaceRuns(target(path), { dossier: store });
  assert.equal(runs.length, WORKSPACE_RUNS_SHOWN);
  for (const run of runs) assert.ok(Buffer.byteLength(run.requirements) <= 600);
  // The compact view a coordinator reads by default still carries them.
  const payload = JSON.parse(statusPayload({ state: 'not-started', sessionID: 'ses_new', workspaceRuns: runs }, 'compact'));
  assert.equal(payload.workspaceRuns.length, WORKSPACE_RUNS_SHOWN);
});

test('an idle conversation is told to recall recorded work before starting', () => {
  const plain = nextAction({ state: 'not-started' });
  assert.equal(plain.tool, 'mdd_adapt');
  assert.deepEqual(plain.args, { payload: JSON.stringify({ routingVersion: 3, kind: 'status', args: {} }) });
  assert.match(plain.why, /search project memory/);
  assert.match(plain.why, /continues recorded work, it is not a new objective: do not call mdd_start/);
  assert.doesNotMatch(plain.why, /workspaceRuns/);
  const recorded = nextAction({ state: 'not-started', workspaceRuns: [{ runID: 'run-one' }] });
  assert.match(recorded.why, /workspaceRuns lists earlier runs/);
  assert.match(recorded.why, /sourceSessionID=<id> runID=<id>/);
  assert.match(recorded.why, /source-conversation/);
});

// The positive case, a settled run that mdd_transfer then really takes over, is driven end to end
// in full-native.test.mjs; here the hint must not promise a transfer the projection would refuse.
test('an idle owner without a projectable checkpoint is never offered as a transfer', t => {
  const path = root(t);
  const store = new RunDossierStore(path);
  const checkpoint = new CheckpointStore(path);
  const progress = new ProgressGuard(path);
  const ownership = new RunOwnershipStore(path);
  store.write('ses_source', dossier(path, { lastState: 'ready', phase: 'mdd-plan' }));
  ownership.claim({ sessionID: 'ses_source', agent: 'mdd-orchestrator', directory: path, worktree: path, runID: 'run-one' });
  assert.equal(workspaceRuns(target(path), { dossier: store, checkpoint, progress, ownership })[0].resume, 'source-conversation');
});

/** A settled checkpoint ready at mdd-plan, shaped exactly as the transfer tests build one. */
function readyCheckpoint(path) {
  const request = { answers: { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' } };
  const workflow = new Workflow(request);
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Risk is low.', route: 'low' });
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const riskContent = 'Risk assessment artifact.';
  const data = { directory: path, worktree: path, userMessageID: 'user-1', requirements: 'Continúa el issue #433', context: [],
    dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [],
    risk: { verdict: { route: 'low', complexity: 'low', reason: 'The change is contained.',
      evidence: [{ source: 'exploration artifact', finding: 'One module is touched.' }],
      risks: [{ description: 'Ordering could change.', evidence: 'exploration artifact', mitigation: 'Keep ordering under test.' }] },
    ref: { runID: 'run-one', phase: 'mdd-risk', recordID: 'risk-record', digest: createHash('sha256').update(riskContent).digest('hex'), bytes: Buffer.byteLength(riskContent), store: 'none' } } };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  new CheckpointStore(path).write('ses_source', { version: 3, parent: 'ses_source', runID: 'run-one', sequence: 0, request,
    events: workflow.history(), data, stable, dataDigest: sealResumeData(data, 'run-one', 'ses_source', workflow.history(), stable) });
  new ProgressGuard(path).write('ses_source', { runID: 'run-one', userMessageID: 'user-1', state: 'settled', callID: 'task-risk', attemptID: 'task-risk' });
}

test('a run settled where a transfer projects is offered as one, only while its owner is idle there', t => {
  const path = root(t);
  const store = new RunDossierStore(path);
  const sources = { dossier: store, checkpoint: new CheckpointStore(path), progress: new ProgressGuard(path), ownership: new RunOwnershipStore(path) };
  store.write('ses_source', dossier(path, { lastState: 'ready', phase: 'mdd-plan' }));
  readyCheckpoint(path);
  // No owner record: mdd_transfer would refuse it, so the hint does not promise it either.
  assert.equal(workspaceRuns(target(path), sources)[0].resume, 'source-conversation');
  sources.ownership.claim({ sessionID: 'ses_source', agent: 'mdd-orchestrator', directory: path, worktree: path, runID: 'run-one' });
  assert.equal(workspaceRuns(target(path), sources)[0].resume, 'transfer');
  // Another checkout of the same repository cannot take it over; it continues where it lives.
  const elsewhere = { ...target(path), directory: join(path, 'linked'), worktree: join(path, 'linked') };
  const [far] = workspaceRuns(elsewhere, sources);
  assert.equal(far.resume, 'source-conversation');
  assert.equal(far.directory, path);
});
