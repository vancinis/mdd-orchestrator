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
  test(`AL-01: ${kind} transfer reseals and preserves an explicit fixed routing pin through target restart`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-routing-pin-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const source = kind === 'approval' ? approvalCheckpoint(root) : checkpoint(root);
    source.request.routingVersion = 2;
    source.dataDigest = sealResumeData(source.data, source.runID, source.parent, source.events, source.stable, source.request);
    validateCheckpoint(source);
    const target = { sessionID: 'routing-target', agent: 'mdd-orchestrator', directory: root, worktree: root };
    const marker = new ProgressGuard(root).read(sourceID);
    const projected = kind === 'approval' ? projectApprovalTransfer(source, marker, target, 'routing-target-user') :
      projectTargetTransfer(source, marker, target, { sessionID: target.sessionID, userMessageID: 'routing-target-user', latest: true,
        authored: true, userText: `Continue sourceSessionID=${source.parent} runID=${source.runID}` });
    assert.deepEqual(projected.checkpoint.request, source.request);
    assert.deepEqual(projected.checkpoint.events, source.events);
    const unmarked = structuredClone(projected.checkpoint);
    delete unmarked.request.routingVersion;
    assert.throws(() => validateCheckpoint(unmarked), /digest mismatch/);
    const store = new CheckpointStore(root); const progress = new ProgressGuard(root);
    store.write(target.sessionID, projected.checkpoint);
    progress.write(target.sessionID, projected.progress);
    const runner = new PhaseRunner({ parent: async () => {}, result: async (_r, _c, _p, output) => output }, { checkpoint: store, progress });
    assert.deepEqual(await runner.restore(target), { restored: true });
    assert.equal(store.read(target.sessionID).checkpoint.request.routingVersion, 2);
    const status = runner.status(target.sessionID);
    assert.equal(status.workflow.nextAction.phase, kind === 'approval' ? 'mdd-propose' : 'mdd-plan');
    assert.equal(status.state, kind === 'approval' ? 'await-approval' : 'ready');
  });
}

for (const backend of ['none', 'local']) for (const legacy of [false, true]) {
  test(`${backend}: transfer preserves the frozen ${legacy ? 'legacy' : 'structured'} held plan and target prompts`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-verification-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new CheckpointStore(root); const progress = new ProgressGuard(root);
    const source = { sessionID: 'source-contract', agent: 'mdd-orchestrator', directory: root, worktree: root };
    const target = { ...source, sessionID: 'target-contract' };
    const inspect = { parent: async () => {}, result: async (_r, _c, _p, output) => output, stopped: async () => true };
    const first = new PhaseRunner(inspect, { checkpoint: store, progress });
    await first.start({ preflight: { answers: { ...answers, artifactStore: backend } }, requirements: 'Transfer the exact held contract.' }, source,
      { requirementsConfirmed: true, userMessageID: 'source-message' });
    if (legacy) {
      const historical = store.read(source.sessionID).checkpoint;
      delete historical.data.verificationVersion;
      historical.dataDigest = sealResumeData(historical.data, historical.runID, historical.parent, historical.events, historical.stable);
      store.clear(source.sessionID); store.write(source.sessionID, historical);
    }
    const runner = new PhaseRunner(inspect, { checkpoint: store, progress });
    assert.deepEqual(await runner.restore(source), { restored: true });
    const ready = await throughRiskStop(runner, source.sessionID);
    const trace = legacy ? traceFixture() : structuredTraceFixture();
    const call = { sessionID: source.sessionID, callID: 'plan-contract' };
    await runner.after(call, await runner.before(call, ready.task), reportDocument({ evidenceSummary: 'Plan held.', artifact: 'Boundary plan.', ...trace }));
    if (backend === 'local') runner.recordConsent(source.sessionID, {
      questionReceipts: [{ kind: 'preflight', callID: 'source-preflight', answers: [['Original accepted answer']] }],
      usedMessages: ['source-message'], proposed: [],
    });
    const saved = store.read(source.sessionID).checkpoint;
    const proof = { sessionID: target.sessionID, userMessageID: 'target-message', latest: true, authored: true,
      userText: `Continue sourceSessionID=${source.sessionID} runID=${saved.runID}` };
    const projected = projectTargetTransfer(saved, progress.read(source.sessionID), target, proof);
    assert.equal(Workflow.replay(projected.checkpoint.request, projected.checkpoint.events).snapshot().answers.artifactStore, backend);
    if (backend === 'local') {
      assert.deepEqual(projected.checkpoint.data.task, saved.data.task);
      assert.equal(projected.checkpoint.data.task.originSessionID, source.sessionID);
      assert.deepEqual(projected.checkpoint.data.taskArtifacts, saved.data.taskArtifacts);
    }
    assert.equal(projected.checkpoint.data.verificationVersion, legacy ? undefined : 1);
    assert.deepEqual(projected.checkpoint.data.planned, trace.deliverables);
    store.write(target.sessionID, projected.checkpoint);
    progress.write(target.sessionID, projected.progress);
    const restored = new PhaseRunner(inspect, { checkpoint: store, progress });
    assert.deepEqual(await restored.restore(target), { restored: true });
    if (backend === 'local') {
      const directory = join(root, '.mdd/tasks', saved.data.task.name);
      const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
      const snapshots = manifest.records.filter(record => record.kind === 'snapshot')
        .map(record => JSON.parse(readFileSync(join(directory, `snapshot-${record.id}.json`), 'utf8')));
      assert.ok(snapshots.some(snapshot => snapshot.dossier.parent.sessionID === source.sessionID &&
        snapshot.dossier.questionReceipts[0]?.callID === 'source-preflight'));
      assert.equal(snapshots.at(-1).dossier.parent.sessionID, target.sessionID);
      assert.equal(snapshots.at(-1).dossier.userMessageID, proof.userMessageID);
      assert.equal(snapshots.at(-1).task.originSessionID, source.sessionID);
    }
    const args = await restored.before({ sessionID: target.sessionID, callID: 'target-apply' }, restored.status(target.sessionID).task);
    assert.equal(/verificationVersion=1/.test(args.prompt), !legacy);
    assert.deepEqual(JSON.parse(args.prompt.match(/^Applicable deliverables: (.*)$/m)[1]), trace.deliverables);
  });
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

test('two OS processes running the transfer plugin cannot confirm two targets', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-process-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const results = await Promise.all([transferChild(root, 'ses_target_a'), transferChild(root, 'ses_target_b')]);
  assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
  const reported = results.map(result => JSON.parse(result.output));
  assert.ok(reported.filter(result => result.transfer?.state === 'confirmed').length <= 1);
  const owner = new RunOwnershipStore(root).read(runID);
  assert.ok(['idle', 'transferring'].includes(owner.state));
  if (owner.ownerSessionID !== sourceID) {
    assert.ok(['ses_target_a', 'ses_target_b'].includes(owner.ownerSessionID));
    const target = await plugin(input);
    assert.equal(JSON.parse(await target.tool.mdd_status.execute({}, context(owner.ownerSessionID))).transfer.state, 'confirmed');
    await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-process-task', tool: 'task' },
      { args: { description: 'old work', subagent_type: 'mdd-plan', prompt: 'mdd:dispatch:old work' } }));
  }
});

test('two plugin processes cannot dispatch concurrently or transfer during a reserved child', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-dispatch-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context } = host(root);
  const a = await plugin(input);
  const b = await plugin(input);
  const task = JSON.parse(await a.tool.mdd_status.execute({}, context(sourceID))).task;
  await b.tool.mdd_status.execute({}, context(sourceID));
  const calls = [a, b].map((instance, index) => instance['tool.execute.before'](
    { sessionID: sourceID, callID: `call-${index}`, tool: 'task' }, { args: { ...task } }));
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  const owner = new RunOwnershipStore(root).read(runID);
  assert.equal(owner.state, 'reserved');
  assert.throws(() => new RunOwnershipStore(root).beginTransfer(runID, sourceID,
    { sessionID: 'ses_target_a', directory: root, worktree: root }, 'a'.repeat(64), owner.epoch));
  await assert.rejects(a.tool.mdd_reset.execute({ scope: 'run' }, context(sourceID)), /child may still be running/);
});

test('crashed coordinator operation exposes exact checkpoint drift and is released only on the user\'s word', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-operation-crash-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const saved = checkpoint(root);
  const { input, context, histories } = host(root);
  const original = await plugin(input);
  assert.equal(JSON.parse(await original.tool.mdd_status.execute({}, context(sourceID))).state, 'ready');
  const store = new RunOwnershipStore(root);
  store.reserve(runID, sourceID, 'operation-crashed', 0,
    { name: 'mdd_context', checkpointSequence: saved.sequence, checkpointDigest: saved.dataDigest });
  const restarted = await plugin(input);
  const blocked = JSON.parse(await restarted.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(blocked.state, 'recovery-blocked');
  assert.match(blocked.reason, /mdd_context.*unchanged/);
  // Blind reset is still refused: the user's exact latest message is the only release.
  await assert.rejects(restarted.tool.mdd_reset.execute({ scope: 'phase' }, context(sourceID)), /mdd_context.*userText/);
  await assert.rejects(restarted.tool.mdd_reset.execute({ scope: 'phase', userText: 'A model-authored claim.' }, context(sourceID)), /exact latest message/);
  assert.equal(store.read(runID).callID, 'operation-crashed');
  const stopped = 'The context tool crashed and nothing is running any more.';
  appendUser(histories, sourceID, 'user-operation-stopped', stopped);
  const released = JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'phase', userText: stopped }, context(sourceID)));
  assert.equal(released.state, 'ready');
  assert.equal(released.runID, runID);
  assert.equal(store.read(runID).state, 'idle');
  // A second crash after the checkpoint moved on only permits run discard, never a phase replay.
  const current = new CheckpointStore(root).read(sourceID).checkpoint;
  store.reserve(runID, sourceID, 'operation-crashed-again', store.read(runID).epoch,
    { name: 'mdd_context', checkpointSequence: current.sequence, checkpointDigest: current.dataDigest });
  new CheckpointStore(root).write(sourceID, { ...current, sequence: current.sequence + 1 });
  const again = await plugin(input);
  const drift = JSON.parse(await again.tool.mdd_status.execute({}, context(sourceID)));
  assert.match(drift.reason, /mdd_context.*different/);
  const discard = 'Discard the run; the crashed context tool is not running.';
  appendUser(histories, sourceID, 'user-operation-discard', discard);
  await assert.rejects(again.tool.mdd_reset.execute({ scope: 'phase', userText: discard }, context(sourceID)), /only.*scope run/);
  assert.equal(store.read(runID).state, 'reserved');
  const discarded = JSON.parse(await again.tool.mdd_reset.execute({ scope: 'run', userText: discard }, context(sourceID)));
  assert.equal(discarded.reset.scope, 'run');
  assert.equal(store.read(runID).state, 'idle');
  assert.equal(store.parent(sourceID), undefined);
});

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
