import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createLegacyPlugin as plugin } from '../dist/opencode-plugin.js';
import { CheckpointStorageError, CheckpointStore, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { Workflow } from '../dist/workflow.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome, memoryServer, reportDocument, traceFixture, structuredTraceFixture, throughRiskStop } from './adapter-fixture.mjs';
import { projectApprovalTransfer, projectTargetTransfer } from '../dist/transfer.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { EngramHttp } from '../dist/engram-http.js';
import { ArtifactStore } from '../dist/artifacts.js';
import { LocalFiles } from '../dist/local-files.js';

const sourceID = 'ses_source';
const runID = 'run_explicit';
const userText = `Continue MDD sourceSessionID=${sourceID} runID=${runID} here.`;
const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };

for (const kind of ['approval', 'target']) {
}

for (const backend of ['none', 'local']) for (const legacy of [false, true]) {
}

/** A validated verdict and its diagnostic artifact reference, shaped as checkpoint.ts expects. */
function riskVerdict(route) {
  return { route, complexity: route, reason: `The change is ${route === 'high' ? 'cross-cutting' : 'contained'}.`,
    evidence: [{ source: 'exploration artifact', finding: 'The CLI boundary is the only touched area.' }],
    risks: [{ description: 'Exit codes could change.', evidence: 'exploration artifact', mitigation: 'Keep existing exit codes under test.' }] };
}
function riskRef(id) {
  const content = 'Risk assessment artifact.';
  return { runID: id, phase: 'mdd-risk', recordID: 'risk-record', digest: createHash('sha256').update(content).digest('hex'),
    bytes: Buffer.byteLength(content), store: 'none' };
}
/** Drives a fresh workflow through the mandatory exploration and risk stop every run now starts with. */
function throughRisk(workflow, route) {
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: `Risk is ${route}.`, route });
}

function checkpoint(root) {
  const request = { answers };
  const workflow = new Workflow(request);
  throughRisk(workflow, 'low');
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory: root, worktree: root, userMessageID: 'user-source', requirements: 'Plan a safe change.', context: [],
    dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: [], usedMessages: [], proposed: [], risk: { verdict: riskVerdict('low'), ref: riskRef(runID) } };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence },
    changedList: [], concerns: [] };
  const record = { version: 3, parent: sourceID, runID, sequence: 0, request, events: workflow.history(), data, stable,
    dataDigest: sealResumeData(data, runID, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, record);
  // A recorded exploration result needs a settled progress marker correlated to this run.
  new ProgressGuard(root).write(sourceID, { runID, userMessageID: 'user-source', state: 'settled',
    callID: 'task-risk', attemptID: 'task-risk' });
  return record;
}

function memoryCheckpoint(root, id, backend) {
  const request = { answers: { ...answers, artifactStore: backend } };
  const workflow = new Workflow(request);
  throughRisk(workflow, 'low');
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory: root, worktree: root, userMessageID: 'user-source', requirements: 'Plan a safe change.',
    memoryProject: 'mdd-test', context: [],
    dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence,
    executedChecks: [], changedFiles: 0, calls: [], usedMessages: ['user-source'], proposed: [], risk: { verdict: riskVerdict('low'), ref: riskRef(id) } };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const saved = { version: 3, parent: sourceID, runID: id, sequence: 0, request, events: workflow.history(), data, stable,
    dataDigest: sealResumeData(data, id, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, saved);
  new ProgressGuard(root).write(sourceID, { runID: id, userMessageID: 'user-source', state: 'settled',
    callID: 'task-risk', attemptID: 'task-risk' });
  return saved;
}

function approvalCheckpoint(root) {
  const request = { answers: { ...answers, mode: 'interactive', summary: 'detailed', complexity: 'very-complex' } };
  const workflow = new Workflow(request);
  throughRisk(workflow, 'high');
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory: root, worktree: root, userMessageID: 'user-source', requirements: 'Plan a safe change.', context: [],
    dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: ['task-explore', 'task-risk'], usedMessages: ['user-source'], proposed: [], risk: { verdict: riskVerdict('high'), ref: riskRef(runID) } };
  const stable = { phase: 'mdd-propose', state: 'await-approval', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-explore', summary: 'Exploration recorded.', how: [], status: 'in-progress', evidence },
    changedList: [], concerns: [] };
  const record = { version: 3, parent: sourceID, runID, sequence: 0, request, events: workflow.history(), data, stable,
    // The risk stop's own attempt is the one that just settled and selected this route; the
    // earlier exploration attempt is no longer the tail of this history.
    attempt: { id: 'task-risk', phase: 'mdd-risk', state: 'settled' },
    dataDigest: sealResumeData(data, runID, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, record);
  new ProgressGuard(root).write(sourceID, { runID, userMessageID: 'user-source', state: 'settled',
    callID: 'task-risk', attemptID: 'task-risk' });
  return record;
}

function approvedCheckpoint(root) {
  const prior = approvalCheckpoint(root);
  const workflow = Workflow.replay(prior.request, prior.events);
  workflow.approve('mdd-propose');
  const stable = { ...prior.stable, state: 'ready', report: { ...prior.stable.report, phase: 'mdd-propose' } };
  const { attempt: _attempt, ...saved } = prior;
  const checkpoint = { ...saved, sequence: prior.sequence + 1, events: workflow.history(), stable,
    dataDigest: sealResumeData(prior.data, runID, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, checkpoint);
  return checkpoint;
}

/** A risk-ready checkpoint: exploration passed, the mandatory risk stop is ready but never run. */
function riskReadyCheckpoint(root) {
  const request = { answers };
  const workflow = new Workflow(request);
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory: root, worktree: root, userMessageID: 'user-source', requirements: 'Plan a safe change.', context: [],
    dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [] };
  const stable = { phase: 'mdd-explore', state: 'risk-ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-explore', summary: 'Exploration recorded.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const record = { version: 3, parent: sourceID, runID, sequence: 0, request, events: workflow.history(), data, stable,
    dataDigest: sealResumeData(data, runID, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, record);
  new ProgressGuard(root).write(sourceID, { runID, userMessageID: 'user-source', state: 'settled', callID: 'task-explore', attemptID: 'task-explore' });
  return record;
}

/** A risk-blocked checkpoint: the risk assessment failed and left the run blocked without a route. */
function riskBlockedCheckpoint(root) {
  const request = { answers };
  const workflow = new Workflow(request);
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Risk could not be substantiated.' });
  const evidence = { requirements: 'confirmed', plan: 'invalidated', implementation: 'invalidated', checks: 'invalidated' };
  const content = 'Exploration artifact.';
  const data = { directory: root, worktree: root, userMessageID: 'user-source', requirements: 'Plan a safe change.', context: [],
    dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [] };
  const stable = { phase: 'mdd-explore', state: 'risk-blocked', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-explore', summary: 'Risk could not be substantiated.', how: [], status: 'failed', evidence },
    changedList: [], concerns: [], reason: 'mdd-risk reported that the request and exploration findings cannot substantiate a route.' };
  const record = { version: 3, parent: sourceID, runID, sequence: 0, request, events: workflow.history(), data, stable,
    dataDigest: sealResumeData(data, runID, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, record);
  new ProgressGuard(root).write(sourceID, { runID, userMessageID: 'user-source', state: 'settled', callID: 'task-risk', attemptID: 'task-risk' });
  return record;
}

/** The risk stop's own unconfirmed attempt: never a settled boundary, so transfer must refuse it. */
function riskPendingCheckpoint(root) {
  const request = { answers };
  const workflow = new Workflow(request);
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'The question was explored.' });
  workflow.startRisk();
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const content = 'Exploration artifact.';
  const data = { directory: root, worktree: root, userMessageID: 'user-source', requirements: 'Plan a safe change.', context: [],
    dependencies: [{ phase: 'mdd-explore', content, digest: createHash('sha256').update(content).digest('hex') }],
    contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0, calls: [], usedMessages: [], proposed: [] };
  const stable = { phase: 'mdd-explore', state: 'risk-await-result', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-explore', summary: 'Exploration recorded.', how: [], status: 'in-progress', evidence }, changedList: [], concerns: [] };
  const record = { version: 3, parent: sourceID, runID, sequence: 0, request, events: workflow.history(), data, stable,
    attempt: { id: 'task-risk', phase: 'mdd-risk', state: 'pending' },
    dataDigest: sealResumeData(data, runID, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, record);
  new ProgressGuard(root).write(sourceID, { runID, userMessageID: 'user-source', state: 'pending', callID: 'task-risk', attemptID: 'task-risk' });
  return record;
}

function host(root, ids = [sourceID, 'ses_target_a', 'ses_target_b'], text = userText) {
  const sessions = new Map(ids.map(id => [id, { id, agent: 'mdd-orchestrator', directory: root, projectID: 'project' }]));
  const histories = new Map(ids.map(id => [id, [
    { info: { id: `user-${id}`, sessionID: id, role: 'user' }, parts: [{ type: 'text', text, sessionID: id, messageID: `user-${id}` }] },
    { info: { id: `assistant-${id}`, sessionID: id, role: 'assistant', agent: 'mdd-orchestrator', path: { cwd: root, root } }, parts: [] },
  ]]));
  const input = { directory: root, worktree: root, project: { id: 'project' }, client: {
    session: { get: async ({ path }) => ({ data: sessions.get(path.id) }), messages: async ({ path }) => ({ data: histories.get(path.id) }),
      message: async ({ path }) => ({ data: histories.get(path.id)?.find(item => item.info.id === path.messageID) }),
      status: async () => ({ data: {} }) },
  } };
  const context = id => ({ sessionID: id, agent: 'mdd-orchestrator', directory: root, worktree: root,
    messageID: `assistant-${id}`, abort: new AbortController().signal });
  return { input, context, histories, sessions };
}

function appendUser(histories, sessionID, id, text) {
  const history = histories.get(sessionID);
  history.splice(history.length - 1, 0, { info: { id, sessionID, role: 'user' },
    parts: [{ type: 'text', text, sessionID, messageID: id }] });
}

function transferChild(root, targetID, mode = 'normal') {
  const pluginURL = pathToFileURL(join(process.cwd(), 'dist', 'opencode-plugin.js')).href;
  const checkpointURL = pathToFileURL(join(process.cwd(), 'dist', 'checkpoint.js')).href;
  const script = `import { createLegacyPlugin as plugin } from ${JSON.stringify(pluginURL)};
    import { CheckpointStore } from ${JSON.stringify(checkpointURL)};
    const root = process.argv[1], target = process.argv[2], mode = process.argv[3];
    const source = ${JSON.stringify(sourceID)}, run = ${JSON.stringify(runID)}, text = ${JSON.stringify(userText)};
    const sessions = new Map([source, target].map(id => [id, { id, agent: 'mdd-orchestrator', directory: root, projectID: 'project' }]));
    const histories = new Map([source, target].map(id => [id, [
      { info: { id: 'user-' + id, sessionID: id, role: 'user' }, parts: [{ type: 'text', text, sessionID: id, messageID: 'user-' + id }] },
      { info: { id: 'assistant-' + id, sessionID: id, role: 'assistant', agent: 'mdd-orchestrator', path: { cwd: root, root } }, parts: [] },
    ]]));
    const input = { directory: root, worktree: root, project: { id: 'project' }, client: { session: {
      get: async ({ path }) => ({ data: sessions.get(path.id) }), messages: async ({ path }) => ({ data: histories.get(path.id) }),
      message: async ({ path }) => ({ data: histories.get(path.id)?.find(item => item.info.id === path.messageID) }),
      status: async () => ({ data: {} }),
    } } };
    if (mode === 'crash-checkpoint') {
      const original = CheckpointStore.prototype.write;
      CheckpointStore.prototype.write = function(parent, value) { original.call(this, parent, value); if (parent === target) process.exit(72); };
    }
    const hooks = await plugin(input);
    const context = { sessionID: target, agent: 'mdd-orchestrator', directory: root, worktree: root,
      messageID: 'assistant-' + target, abort: new AbortController().signal };
    try { process.stdout.write(await hooks.tool.mdd_transfer.execute({ sourceSessionID: source, runID: run, userText: text }, context)); }
    catch (error) { process.stdout.write(JSON.stringify({ error: error.message })); }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root, targetID, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output, error }));
  });
}

/** Crash the transfer after the target checkpoint is published but before its progress marker. */
async function partialPublication(t, prefix) {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  approvalCheckpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const original = CheckpointStore.prototype.write;
  const intercept = t.mock.method(CheckpointStore.prototype, 'write', function (...args) {
    original.apply(this, args); if (args[0] === 'ses_target_a') throw new Error('Injected crash after checkpoint.');
  });
  const target = await plugin(input);
  assert.equal(JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a'))).diagnostic, 'publication-unknown');
  intercept.mock.restore();
  const owners = new RunOwnershipStore(root);
  const claim = owners.parentClaim('ses_target_a').transfer;
  assert.ok(new CheckpointStore(root).read('ses_target_a'), 'the target checkpoint was published');
  assert.equal(new ProgressGuard(root).read('ses_target_a'), undefined, 'its progress marker was not');
  assert.equal(owners.read(runID).state, 'transferring');
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${claim.operationID}`;
  appendUser(histories, 'ses_target_a', 'user-incomplete-recovery', text);
  return { root, input, context, owners, claim, text, source };
}

for (const stage of ['before-claim', 'after-claim', 'after-source-fence', 'after-checkpoint', 'after-progress', 'after-finish', 'after-restore']) {
}

// ---------------------------------------------------------------------------------------------
// Re-audit: a confirmed transfer must survive a degraded target checkpoint, and the source
// conversation must get a fresh start without ever acting on the run it handed over.
// ---------------------------------------------------------------------------------------------
async function confirmedTransfer(t, prefix) {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  const sourceTask = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).task;
  const target = await plugin(input);
  const targetID = 'ses_target_a';
  const transferred = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context(targetID)));
  assert.equal(transferred.transfer?.state, 'confirmed', JSON.stringify(transferred));
  return { root, input, context, histories, source, sourceTask, target, targetID };
}
function degradeNextCheckpointWrites(t) {
  return t.mock.method(CheckpointStore.prototype, 'write', function () { throw new CheckpointStorageError('injected EPERM'); });
}

// ---------------------------------------------------------------------------------------------
// Chained transfers: A -> B -> C. The newest receipt supersedes the old one; every former owner
// stays fenced; the conversation that holds only a pending claim is never mistaken for one.
// ---------------------------------------------------------------------------------------------
async function chain(t, prefix) {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const A = sourceID, B = 'ses_target_a', C = 'ses_target_b';
  const { input, context, histories } = host(root);
  const p = await plugin(input);
  const aTask = JSON.parse(await p.tool.mdd_status.execute({}, context(A))).task;
  const ab = JSON.parse(await p.tool.mdd_transfer.execute({ sourceSessionID: A, runID, userText }, context(B)));
  assert.equal(ab.transfer?.state, 'confirmed', JSON.stringify(ab));
  return { root, input, context, histories, p, A, B, C, aTask, bTask: ab.task };
}
