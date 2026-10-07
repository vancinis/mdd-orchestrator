import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createLegacyPlugin as plugin } from '../dist/opencode-plugin.js';
import { CheckpointStorageError, CheckpointStore, sealResumeData } from '../dist/checkpoint.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { Workflow } from '../dist/workflow.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome, memoryServer, reportDocument, traceFixture } from './adapter-fixture.mjs';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { EngramHttp } from '../dist/engram-http.js';
import { ArtifactStore } from '../dist/artifacts.js';
import { LocalFiles } from '../dist/local-files.js';

const sourceID = 'ses_source';
const runID = 'run_explicit';
const userText = `Continue MDD sourceSessionID=${sourceID} runID=${runID} here.`;
const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };

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

test('two target plugin instances cannot claim a live source without exclusive writer ownership', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const record = checkpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  const targetA = await plugin(input);
  const targetB = await plugin(input);
  const request = { sourceSessionID: sourceID, runID, userText };
  const [a, b] = await Promise.all([
    targetA.tool.mdd_transfer.execute(request, context('ses_target_a')),
    targetB.tool.mdd_transfer.execute(request, context('ses_target_b')),
  ]);
  assert.equal(JSON.parse(a).diagnostic, 'ownership-unproven');
  assert.equal(JSON.parse(b).diagnostic, 'ownership-unproven');
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({ detail: 'full' }, context(sourceID))).state, 'ready');
  assert.deepEqual(new CheckpointStore(root).read(sourceID).checkpoint, record);
  assert.equal(new CheckpointStore(root).read('ses_target_a'), undefined);
  assert.equal(new CheckpointStore(root).read('ses_target_b'), undefined);
  await assert.rejects(targetA.tool.mdd_transfer.execute({ ...request, userText: 'A model-authored transfer request.' }, context('ses_target_a')));
  await assert.rejects(targetA.tool.mdd_transfer.execute({ ...request, runID: 'run_other' }, context('ses_target_a')));
});

test('transfer publishes a receipt and restores a fresh target without source callbacks', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-native-transfer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  const previous = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(previous.state, 'ready');
  const target = await plugin(input);
  const result = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(result.runID, runID);
  assert.equal(new RunOwnershipStore(root).confirmReceipt(runID, 'ses_target_a').nativeUserMessageID, 'user-ses_target_a');
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-task', tool: 'task' }, { args: previous.task }));
  const restarted = await plugin(input);
  const restored = JSON.parse(await restarted.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(restored.state, 'ready');
  assert.equal(restored.transfer.state, 'confirmed');
  // The low route was selected by mdd-risk on the source; the target's first tail prompt (here
  // mdd-plan, since 'low' resumes at mdd-plan) must still carry the risk summary, verdict reason
  // and diagnostic artifact reference, not just the bare route. `task.prompt` is only a dispatch
  // handle until the native tool call resolves it, so the real text is read the same way other
  // transfer tests already do: through `tool.execute.before` against the dispatched task args.
  assert.equal(restored.task.subagent_type, 'mdd-plan');
  const planTask = structuredClone(restored.task);
  await restarted['tool.execute.before']({ sessionID: 'ses_target_a', callID: 'task-plan-prompt', tool: 'task' }, { args: planTask });
  assert.match(planTask.prompt, /Validated mdd-risk assessment that selected this route/);
  assert.match(planTask.prompt, /"recordID":"risk-record"/);
  assert.match(planTask.prompt, /"route":"low"/);
  assert.match(planTask.prompt, /"reason":"The change is contained\."/);
});

for (const [label, fixture, expectState] of [
  ['risk-ready', riskReadyCheckpoint, 'ready'], ['risk-blocked', riskBlockedCheckpoint, 'question-ready'],
]) test(`transfer gives a ${label} risk stop the same fence, receipt and fresh-consent parity as a phase boundary`, async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), `mdd-transfer-${label}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  fixture(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  const previous = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(previous.state, expectState);
  assert.equal(previous.stage, 'mdd-risk');
  // A settled blocked-risk stop reads its own fresh risk-recovery question on the very first
  // status read (the restart-reissue path, which this status call also exercises); it is a
  // re-askable native decision, not consent, so it does not fence the transfer below.
  const sourceQuestion = label === 'risk-blocked' ? new QuestionCheckpointStore(root).read(sourceID) : undefined;
  if (label === 'risk-blocked') assert.equal(sourceQuestion?.slot.kind, 'risk-recovery');
  const target = await plugin(input);
  const result = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(result.runID, runID);
  assert.equal(result.stage, 'mdd-risk');
  assert.equal(result.state, expectState);
  // The source is fenced the moment the target claims it: no late callback can reach it.
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-task', tool: 'task' }, { args: previous.task ?? { description: 'old work', subagent_type: 'mdd-risk', prompt: 'old work' } }));
  const restarted = await plugin(input);
  const restored = JSON.parse(await restarted.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(restored.state, expectState);
  assert.equal(restored.stage, 'mdd-risk');
  assert.equal(restored.transfer.state, 'confirmed');
  if (label === 'risk-blocked') {
    // The source's bound call is durably retired; the target asked a brand new question only
    // after its own ownership was confirmed, and it never carries the old call or answer.
    assert.equal(new QuestionCheckpointStore(root).read(sourceID), undefined);
    const targetQuestion = new QuestionCheckpointStore(root).read('ses_target_a');
    assert.equal(targetQuestion?.slot.kind, 'risk-recovery');
    assert.notDeepEqual(targetQuestion?.slot.args, sourceQuestion?.slot.args);
  }
});

test('an answered risk-recovery source question transfers to a fresh, unanswered target question; the old answer is never replayed', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-risk-answered-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  riskBlockedCheckpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  const previous = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(previous.state, 'question-ready');
  const args = previous.question;
  assert.equal(args.questions[0].options[0].label, 'Reintentar evaluación de riesgo');
  // A native answer races the window between the native tool recording it and MDD settling the
  // decision: the question record is briefly `answered` and durable before anything acts on it.
  // That exact race window is reproduced directly rather than through the synchronous call chain
  // (which would settle the decision immediately), to exercise transfer against it.
  const prepared = new QuestionCheckpointStore(root).read(sourceID);
  assert.equal(prepared.state, 'prepared');
  const questions = new QuestionCheckpointStore(root);
  const pending = { ...prepared, state: 'pending', sequence: prepared.sequence + 1,
    reservation: { runID, stable: 'risk-blocked' }, checkpoint: { sequence: 0, digest: new CheckpointStore(root).read(sourceID).checkpoint.dataDigest },
    callID: 'call-source-answer' };
  questions.write(sourceID, pending);
  const answered = { ...pending, state: 'answered', sequence: pending.sequence + 1, answer: [[args.questions[0].options[0].label]] };
  questions.write(sourceID, answered);
  assert.equal(questions.read(sourceID).state, 'answered');
  // Transfer still proceeds: an answered recovery question is re-askable, not consent, and this
  // adapter retires it durably as part of the confirmed target claim, never carrying it forward.
  const target = await plugin(input);
  const result = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(new QuestionCheckpointStore(root).read(sourceID), undefined);
  const targetQuestion = new QuestionCheckpointStore(root).read('ses_target_a');
  assert.equal(targetQuestion?.slot.kind, 'risk-recovery');
  // The fresh target question is a brand new, unanswered record: the source's old answer is not
  // present anywhere on it, and its text differs from the one the source actually answered.
  assert.equal(targetQuestion.state, 'prepared');
  assert.equal(targetQuestion.answer, undefined);
  assert.notDeepEqual(targetQuestion.slot.args, answered.slot.args);
});

test('an unconfirmed risk attempt refuses transfer; only the settled boundary after explicit release can move', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-risk-pending-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const saved = riskPendingCheckpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const target = await plugin(input);
  const blocked = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a')));
  assert.equal(blocked.diagnostic, 'pending-unknown');
  assert.equal(new CheckpointStore(root).read('ses_target_a'), undefined);
  // Once the attempt is explicitly released, the stop is risk-ready again and transfer proceeds.
  const workflow = Workflow.replay(saved.request, saved.events);
  workflow.retry();
  const evidence = saved.data.evidence;
  const released = { ...saved, sequence: saved.sequence + 1, events: workflow.history(),
    stable: { ...saved.stable, state: 'risk-ready', report: { ...saved.stable.report, status: 'in-progress', evidence } }, attempt: undefined,
    dataDigest: sealResumeData(saved.data, runID, sourceID, workflow.history(), { ...saved.stable, state: 'risk-ready' }) };
  delete released.attempt;
  new CheckpointStore(root).write(sourceID, released);
  new ProgressGuard(root).write(sourceID, { runID, userMessageID: 'user-source', state: 'settled', callID: 'task-risk', attemptID: 'task-risk' });
  const result = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_b')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(result.state, 'ready');
  assert.equal(result.stage, 'mdd-risk');
});

test('explicit transferred-target discard frees a new objective without reviving source', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-target-discard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const targetID = 'ses_target_a';
  const target = await plugin(input);
  const transferred = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context(targetID)));
  assert.equal(transferred.transfer.state, 'confirmed');
  await assert.rejects(target.tool.mdd_reset.execute({ scope: 'run' }, context(targetID)), /exact latest native user request/);
  const recoveryText = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${transferred.transfer.operationID}`;
  appendUser(histories, targetID, 'user-finished-recovery', recoveryText);
  const notAborted = JSON.parse(await target.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: transferred.transfer.operationID, action: 'abort-fenced', userText: recoveryText }, context(targetID)));
  assert.equal(notAborted.diagnostic, 'target-occupied');
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, targetID);
  const discardText = 'Discard this transferred target without reactivating the source.';
  appendUser(histories, targetID, 'user-discard', discardText);
  const discarded = JSON.parse(await target.tool.mdd_reset.execute({ scope: 'run', userText: discardText }, context(targetID)));
  assert.equal(discarded.reset.scope, 'run');
  assert.equal(new RunOwnershipStore(root).parent(targetID), undefined);
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, targetID);
  assert.equal(new CheckpointStore(root).read(targetID), undefined);
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'source-after-target-discard', tool: 'task' },
    { args: { description: 'old work', subagent_type: 'mdd-plan', prompt: 'old work' } }));
  const newText = 'Build a new independent target objective.';
  appendUser(histories, targetID, 'user-new-target', newText);
  const started = JSON.parse(await target.tool.mdd_start.execute({ requirements: newText }, context(targetID)));
  assert.equal(started.state, 'question-ready');
  assert.notEqual(new RunOwnershipStore(root).parent(targetID), runID);
});

for (const action of ['release-claim', 'abort-fenced']) test(`two target plugins race explicit ${action} recovery without duplicate ownership`, async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-recover-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const saved = checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const owners = new RunOwnershipStore(root);
  const targetID = 'ses_target_a';
  const intent = { operationID: `recovery-${action}`, nativeUserMessageID: `user-${targetID}`,
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  const target = { sessionID: targetID, directory: root, worktree: root };
  owners.claimTargetForTransfer(runID, sourceID, target, { sequence: saved.sequence, digest: saved.dataDigest }, 0, intent);
  if (action === 'abort-fenced') owners.beginTransfer(runID, sourceID, target, saved.dataDigest, 0, saved.sequence, intent);
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${intent.operationID}`;
  appendUser(histories, targetID, `user-recover-${action}`, text);
  const plugins = await Promise.all([plugin(input), plugin(input)]);
  const request = { sourceSessionID: sourceID, runID, operationID: intent.operationID, action, userText: text };
  const results = await Promise.allSettled(plugins.map(instance => instance.tool.mdd_transfer_recover.execute(request, context(targetID))));
  const recovered = results.filter(item => item.status === 'fulfilled' && JSON.parse(item.value).state === 'transfer-recovered');
  assert.ok(recovered.length <= 1);
  const current = owners.read(runID);
  assert.equal(current.ownerSessionID, sourceID);
  if (recovered.length) {
    assert.equal(current.state, 'idle');
    assert.equal(owners.parent(targetID), undefined);
    assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'ready');
    assert.throws(() => owners.beginTransfer(runID, sourceID, target, saved.dataDigest, 0, saved.sequence, intent));
  } else {
    assert.ok(current.state === 'reserved' || current.state === 'transferring');
    assert.equal(owners.parent(targetID), runID);
  }
});

for (const stage of ['after-recovery-owner', 'after-target-retirement']) test(`interrupted ${stage} recovery reconciles only the same native operation`, async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-recovery-interrupted-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const saved = checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const owners = new RunOwnershipStore(root);
  const targetID = 'ses_target_a';
  const intent = { operationID: stage, nativeUserMessageID: `user-${targetID}`, assistantMessageID: `assistant-${targetID}`,
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  owners.claimTargetForTransfer(runID, sourceID, { sessionID: targetID, directory: root, worktree: root },
    { sequence: saved.sequence, digest: saved.dataDigest }, 0, intent);
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${intent.operationID}`;
  appendUser(histories, targetID, `user-${stage}`, text);
  let injected = false;
  if (stage === 'after-recovery-owner') {
    const original = RunOwnershipStore.prototype.reconcileTransferRecovery;
    t.mock.method(RunOwnershipStore.prototype, 'reconcileTransferRecovery', function (...args) {
      if (!injected) { injected = true; throw new Error('Interrupted after owner reservation.'); }
      return original.apply(this, args);
    });
  } else {
    const original = LocalFiles.prototype.updateStrict;
    const name = `.mdd/owner-${createHash('sha256').update(runID).digest('hex')}.json`;
    t.mock.method(LocalFiles.prototype, 'updateStrict', function (...args) {
      if (!injected && args[0] === name && owners.parentClaim(targetID)?.retired && owners.read(runID)?.recoveringTransfer) {
        injected = true; throw new Error('Interrupted after target retirement.');
      }
      return original.apply(this, args);
    });
  }
  const request = { sourceSessionID: sourceID, runID, operationID: intent.operationID, action: 'release-claim', userText: text };
  const first = await plugin(input);
  const refused = JSON.parse(await first.tool.mdd_transfer_recover.execute(request, context(targetID)));
  assert.equal(refused.diagnostic, 'pending-unknown');
  assert.equal(injected, true);
  assert.equal(owners.read(runID).state, 'reserved');
  assert.equal(owners.read(runID).recoveringTransfer.operationID, intent.operationID);
  assert.equal(owners.parent(targetID), stage === 'after-recovery-owner' ? runID : undefined);
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'stale-recovery-task', tool: 'task' },
    { args: { description: 'old task', subagent_type: 'mdd-plan', prompt: 'old task' } }));
  const second = await plugin(input);
  const confirmed = JSON.parse(await second.tool.mdd_transfer_recover.execute(request, context(targetID)));
  assert.equal(confirmed.state, 'transfer-recovered', JSON.stringify(confirmed));
  assert.equal(owners.parent(targetID), undefined);
  assert.equal(owners.read(runID).state, 'idle');
  assert.equal(owners.read(runID).recoveredTransfer.operationID, intent.operationID);
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'ready');
  assert.throws(() => owners.beginTransfer(runID, sourceID,
    { sessionID: targetID, directory: root, worktree: root }, saved.dataDigest, 0, saved.sequence, intent));
  const third = await plugin(input);
  const repeated = JSON.parse(await third.tool.mdd_transfer_recover.execute(request, context(targetID)));
  assert.equal(repeated.state, 'transfer-recovered');
  assert.equal(owners.read(runID).epoch, confirmed.ownerEpoch);
});

test('running or published transfer cannot be cleared by a recovery request', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-recover-blocked-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const saved = checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const owners = new RunOwnershipStore(root);
  const targetID = 'ses_target_a';
  const intent = { operationID: 'running-transfer', nativeUserMessageID: `user-${targetID}`,
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  const target = { sessionID: targetID, directory: root, worktree: root };
  owners.claimTargetForTransfer(runID, sourceID, target, { sequence: saved.sequence, digest: saved.dataDigest }, 0, intent);
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${intent.operationID}`;
  appendUser(histories, targetID, 'user-recover-running', text);
  const recovery = await plugin(input);
  const request = { sourceSessionID: sourceID, runID, operationID: intent.operationID, action: 'release-claim', userText: text };
  const status = input.client.session.status;
  input.client.session.status = async () => ({ data: { [targetID]: { type: 'busy' } } });
  assert.equal(JSON.parse(await recovery.tool.mdd_transfer_recover.execute(request, context(targetID))).diagnostic, 'pending-unknown');
  assert.equal(owners.parent(targetID), runID);
  input.client.session.status = status;
  owners.beginTransfer(runID, sourceID, target, saved.dataDigest, 0, saved.sequence, intent);
  const data = { ...saved.data, userMessageID: `user-${targetID}`, usedMessages: [`user-${targetID}`], proposed: [] };
  new CheckpointStore(root).write(targetID, { ...saved, parent: targetID, sequence: 0, data,
    dataDigest: sealResumeData(data, runID, targetID, saved.events, saved.stable) });
  // Published bytes are never removed while OpenCode still reports the transfer running.
  input.client.session.status = async () => ({ data: { [targetID]: { type: 'busy' } } });
  assert.equal(JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ ...request, action: 'abort-fenced' }, context(targetID))).diagnostic, 'pending-unknown');
  input.client.session.status = status;
  assert.equal(owners.read(runID).state, 'transferring');
  assert.equal(owners.parent(targetID), runID);
  assert.ok(new CheckpointStore(root).read(targetID));
});

test('explicit recovery finishes complete publication but never invents missing progress', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-finish-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  approvalCheckpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const intercept = t.mock.method(RunOwnershipStore.prototype, 'finishVerifiedTransfer', function () { throw new Error('Injected crash before finish.'); });
  const target = await plugin(input);
  const targetID = 'ses_target_a';
  const uncertain = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context(targetID)));
  assert.equal(uncertain.diagnostic, 'publication-unknown');
  intercept.mock.restore();
  assert.equal(new RunOwnershipStore(root).read(runID).state, 'transferring');
  assert.equal(new ProgressGuard(root).read(targetID).state, 'settled');
  const claim = new RunOwnershipStore(root).parentClaim(targetID).transfer;
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${claim.operationID}`;
  appendUser(histories, targetID, 'user-finish-recovery', text);
  const recovery = await plugin(input);
  const result = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: claim.operationID, action: 'finish-published', userText: text }, context(targetID)));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(result.state, 'question-ready');
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, targetID);
  assert.equal(new RunOwnershipStore(root).read(runID).receipt.operationID, claim.operationID);
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-after-recovery', tool: 'task' },
    { args: { description: 'old work', subagent_type: 'mdd-propose', prompt: 'old work' } }));
});

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

test('partial publication finishes on explicit request by regenerating the deterministic target progress', async t => {
  const { root, input, context, owners, claim, text, source } = await partialPublication(t, 'mdd-transfer-partial-finish-');
  const recovery = await plugin(input);
  const result = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: claim.operationID, action: 'finish-published', userText: text }, context('ses_target_a')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(owners.read(runID).ownerSessionID, 'ses_target_a');
  assert.deepEqual(new ProgressGuard(root).read('ses_target_a'),
    { ...new ProgressGuard(root).read(sourceID), userMessageID: claim.nativeUserMessageID });
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-after-partial', tool: 'task' },
    { args: { description: 'old work', subagent_type: 'mdd-propose', prompt: 'old work' } }));
});

test('partial publication aborts on explicit request by removing only the exact projected target bytes', async t => {
  const { root, input, context, owners, claim, text, source } = await partialPublication(t, 'mdd-transfer-partial-abort-');
  const recovery = await plugin(input);
  const result = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: claim.operationID, action: 'abort-fenced', userText: text }, context('ses_target_a')));
  assert.equal(result.state, 'transfer-recovered', JSON.stringify(result));
  assert.equal(new CheckpointStore(root).read('ses_target_a'), undefined);
  assert.equal(owners.parent('ses_target_a'), undefined);
  assert.equal(owners.read(runID).ownerSessionID, sourceID);
  assert.equal(owners.read(runID).state, 'idle');
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).workflow?.nextAction.kind, 'approve');
});

test('a partial publication whose target bytes differ from the projection stays fenced', async t => {
  const { root, input, context, owners, claim, text } = await partialPublication(t, 'mdd-transfer-partial-tampered-');
  const published = new CheckpointStore(root).read('ses_target_a').checkpoint;
  const data = { ...published.data, requirements: 'A different objective slipped into the target.' };
  new CheckpointStore(root).write('ses_target_a', { ...published, sequence: published.sequence + 1, data,
    dataDigest: sealResumeData(data, runID, 'ses_target_a', published.events, published.stable) });
  const recovery = await plugin(input);
  for (const action of ['finish-published', 'abort-fenced']) {
    const result = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
      operationID: claim.operationID, action, userText: text }, context('ses_target_a')));
    assert.equal(result.state, 'transfer-blocked', action);
  }
  assert.equal(owners.read(runID).state, 'transferring');
  assert.equal(owners.parent('ses_target_a'), runID);
  assert.ok(new CheckpointStore(root).read('ses_target_a'));
  assert.equal(new ProgressGuard(root).read('ses_target_a'), undefined);
});

test('exact SDK message lookup validates the original transfer request after 150 messages', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-long-receipt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const target = await plugin(input);
  assert.equal(JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a'))).transfer.state, 'confirmed');
  const history = histories.get('ses_target_a');
  for (let index = 0; index < 150; index++) history.push({ info: { id: `filler-${index}`, sessionID: 'ses_target_a', role: 'assistant' }, parts: [] });
  const messages = input.client.session.messages;
  input.client.session.messages = async args => ({ data: (await messages(args)).data.slice(-args.query.limit) });
  const restarted = await plugin(input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(status.state, 'ready');
  assert.equal(status.transfer.state, 'confirmed');
  assert.ok(status.task);
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, 'ses_target_a');
  input.client.session.message = undefined;
  const unavailable = await plugin(input);
  const blocked = JSON.parse(await unavailable.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(blocked.state, 'recovery-blocked');
  assert.equal(blocked.transfer.stage, 'finished-unconfirmed');
  assert.match(blocked.reason, /Exact native message lookup is unavailable/);
  assert.equal(blocked.task, undefined);
});

test('long native transfer liveness history does not mean the old call stopped', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-long-liveness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const source = checkpoint(root);
  const { input, context, histories } = host(root);
  const sourcePlugin = await plugin(input);
  await sourcePlugin.tool.mdd_status.execute({}, context(sourceID));
  const owners = new RunOwnershipStore(root);
  const targetID = 'ses_target_a';
  const intent = { operationID: 'long-liveness', nativeUserMessageID: `user-${targetID}`, assistantMessageID: `assistant-${targetID}`,
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  owners.claimTargetForTransfer(runID, sourceID, { sessionID: targetID, directory: root, worktree: root },
    { sequence: source.sequence, digest: source.dataDigest }, 0, intent);
  const history = histories.get(targetID);
  for (let index = 0; index < 150; index++) history.splice(history.length - 1, 0,
    { info: { id: `filler-${index}`, sessionID: targetID, role: 'assistant' }, parts: [] });
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${intent.operationID}`;
  appendUser(histories, targetID, 'user-long-recovery', text);
  const messages = input.client.session.messages;
  input.client.session.messages = async args => ({ data: (await messages(args)).data.slice(-args.query.limit) });
  history.at(-1).parts = [{ type: 'tool', tool: 'mdd_transfer', callID: 'call-long-transfer',
    sessionID: targetID, messageID: `assistant-${targetID}`,
    state: { status: 'running', input: { sourceSessionID: sourceID, runID, userText } } }];
  const recovery = await plugin(input);
  const result = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: intent.operationID, action: 'release-claim', userText: text }, context(targetID)));
  assert.equal(result.diagnostic, 'pending-unknown');
  assert.match(result.reason, /still reports the transfer running/);
  assert.equal(owners.parent(targetID), runID);
  assert.equal(owners.read(runID).state, 'idle');
  history.at(-1).parts[0].state.status = 'completed';
  history.at(-1).parts[0].sessionID = sourceID;
  const spoofed = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: intent.operationID, action: 'release-claim', userText: text }, context(targetID)));
  assert.equal(spoofed.diagnostic, 'pending-unknown');
  assert.equal(owners.parent(targetID), runID);
  history.at(-1).parts[0].sessionID = targetID;
  const stopped = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: intent.operationID, action: 'release-claim', userText: text }, context(targetID)));
  assert.equal(stopped.state, 'transfer-recovered');
  assert.equal(owners.parent(targetID), undefined);
});

test('malformed exact native message responses never validate receipt or transfer liveness', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-malformed-lookup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const targetID = 'ses_target_a';
  const target = await plugin(input);
  assert.equal(JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context(targetID))).transfer.state, 'confirmed');
  const original = input.client.session.message;
  input.client.session.message = async args => ({ data: { info: { id: args.path.messageID, sessionID: sourceID, role: 'user' }, parts: [] } });
  const wrongParent = await plugin(input);
  assert.equal(JSON.parse(await wrongParent.tool.mdd_status.execute({}, context(targetID))).state, 'recovery-blocked');
  input.client.session.message = async args => {
    const response = await original(args);
    return { data: { ...response.data, parts: [{ type: 'text', text: userText, synthetic: true,
      sessionID: targetID, messageID: args.path.messageID }] } };
  };
  const synthetic = await plugin(input);
  assert.equal(JSON.parse(await synthetic.tool.mdd_status.execute({}, context(targetID))).state, 'recovery-blocked');
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, targetID);
  const claimRoot = mkdtempSync(join(tmpdir(), 'mdd-transfer-malformed-call-'));
  t.after(() => rmSync(claimRoot, { recursive: true, force: true }));
  checkpoint(claimRoot);
  const other = host(claimRoot);
  const claimSource = await plugin(other.input);
  await claimSource.tool.mdd_status.execute({}, other.context(sourceID));
  const owners = new RunOwnershipStore(claimRoot);
  const intent = { operationID: 'malformed-call', nativeUserMessageID: `user-${targetID}`, assistantMessageID: `assistant-${targetID}`,
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  owners.claimTargetForTransfer(runID, sourceID, { sessionID: targetID, directory: claimRoot, worktree: claimRoot },
    { sequence: 0, digest: new CheckpointStore(claimRoot).read(sourceID).checkpoint.dataDigest }, 0, intent);
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${intent.operationID}`;
  appendUser(other.histories, targetID, 'user-malformed-recovery', text);
  other.input.client.session.message = async args => ({ data: { info: { id: args.path.messageID,
    sessionID: targetID, role: 'assistant', agent: 'mdd-orchestrator', path: { cwd: claimRoot, root: claimRoot } }, parts: 'bad' } });
  const recovery = await plugin(other.input);
  const blocked = JSON.parse(await recovery.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: intent.operationID, action: 'release-claim', userText: text }, other.context(targetID)));
  assert.equal(blocked.diagnostic, 'pending-unknown');
  assert.equal(owners.parent(targetID), runID);
  assert.equal(owners.read(runID).state, 'idle');
});

test('transfer publishes progress but requires a new target-native phase approval', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-approval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  approvalCheckpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'review-ready');
  const target = await plugin(input);
  const result = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(result.state, 'question-ready');
  // The high route's first tail phase, mdd-propose, is still only its suggested route's first
  // approval: the one native route question (3a) replaces the generic approval here.
  assert.equal(result.question.questions[0].header, 'Ruta');
  assert.equal(result.task, undefined);
  const marker = new ProgressGuard(root).read('ses_target_a');
  assert.equal(marker.userMessageID, 'user-ses_target_a');
  assert.equal(marker.state, 'settled');
  const restarted = await plugin(input);
  const fresh = JSON.parse(await restarted.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(fresh.workflow.nextAction.kind, 'approve');
  assert.equal(fresh.task, undefined);
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'stale-question', tool: 'question' },
    { args: result.question }));
  const call = { sessionID: 'ses_target_a', callID: 'fresh-target-approval', tool: 'question' };
  histories.get('ses_target_a')[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID,
    sessionID: call.sessionID, messageID: 'assistant-ses_target_a', state: { status: 'running', input: structuredClone(fresh.question) } }];
  await restarted['tool.execute.before'](call, { args: fresh.question });
  const formatted = `"${fresh.question.questions[0].question}"="Continuar con la ruta sugerida"`;
  await restarted['tool.execute.after']({ ...call, args: fresh.question }, {
    title: 'Asked 1 question', output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
    metadata: { answers: [['Continuar con la ruta sugerida']], truncated: false },
  });
  const approved = JSON.parse(await restarted.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(approved.state, 'ready');
  assert.equal(approved.task.subagent_type, 'mdd-propose');
  const resumed = await plugin(input);
  const resumedStatus = JSON.parse(await resumed.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(resumedStatus.state, 'ready');
  // The high route was selected by mdd-risk on the source and required a fresh target approval
  // above (the stale source question was rejected, and the target had to answer its own); the
  // tail prompt dispatched after that fresh approval must still carry the risk summary, verdict
  // reason and diagnostic artifact reference through the transfer. `task.prompt` is a dispatch
  // handle until the native tool call resolves it, so resolve it last, the same way other
  // transfer tests do: through `tool.execute.before` against the dispatched task args.
  const proposeTask = structuredClone(resumedStatus.task);
  await resumed['tool.execute.before']({ sessionID: 'ses_target_a', callID: 'task-propose-prompt', tool: 'task' }, { args: proposeTask });
  assert.match(proposeTask.prompt, /Validated mdd-risk assessment that selected this route/);
  assert.match(proposeTask.prompt, /"recordID":"risk-record"/);
  assert.match(proposeTask.prompt, /"route":"high"/);
  assert.match(proposeTask.prompt, /"reason":"The change is cross-cutting\."/);
});

test('transfer revokes source-parent terminal approval before target exposure', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-reask-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  approvedCheckpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  const old = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(old.state, 'ready');
  const target = await plugin(input);
  const result = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(result.state, 'question-ready');
  assert.equal(result.workflow.nextAction.kind, 'approve');
  assert.equal(result.task, undefined);
  assert.equal(new CheckpointStore(root).read(sourceID).workflow.nextAction().kind, 'execute');
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'old-approved-task', tool: 'task' }, { args: old.task }));
});

for (const stage of ['before-claim', 'after-claim', 'after-source-fence', 'after-checkpoint', 'after-progress', 'after-finish', 'after-restore']) {
  test(`transfer crash ${stage} never reports false success`, async t => {
    isolateHome(t);
    const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-crash-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    saveGlobalSettings(defaultSettings());
    approvalCheckpoint(root);
    const { input, context } = host(root);
    const source = await plugin(input);
    await source.tool.mdd_status.execute({}, context(sourceID));
    const target = await plugin(input);
    const targetID = 'ses_target_a';
    const fault = () => { throw new Error(`Injected crash ${stage}`); };
    if (stage === 'before-claim' || stage === 'after-claim') {
      const original = RunOwnershipStore.prototype.claimTargetForTransfer;
      t.mock.method(RunOwnershipStore.prototype, 'claimTargetForTransfer', function (...args) {
        if (stage === 'before-claim') fault();
        original.apply(this, args); fault();
      });
    } else if (stage === 'after-source-fence') {
      const original = RunOwnershipStore.prototype.beginTransfer;
      t.mock.method(RunOwnershipStore.prototype, 'beginTransfer', function (...args) { original.apply(this, args); fault(); });
    } else if (stage === 'after-checkpoint') {
      const original = CheckpointStore.prototype.write;
      t.mock.method(CheckpointStore.prototype, 'write', function (...args) {
        original.apply(this, args); if (args[0] === targetID) fault();
      });
    } else if (stage === 'after-progress') {
      const original = ProgressGuard.prototype.write;
      t.mock.method(ProgressGuard.prototype, 'write', function (...args) {
        original.apply(this, args); if (args[0] === targetID) fault();
      });
    } else if (stage === 'after-finish') {
      const original = RunOwnershipStore.prototype.finishVerifiedTransfer;
      t.mock.method(RunOwnershipStore.prototype, 'finishVerifiedTransfer', function (...args) { original.apply(this, args); fault(); });
    } else {
      const original = PhaseRunner.prototype.restore;
      let injected = false;
      t.mock.method(PhaseRunner.prototype, 'restore', async function (...args) {
        const result = await original.apply(this, args);
        if (!injected && args[0].sessionID === targetID) { injected = true; fault(); }
        return result;
      });
    }
    const result = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context(targetID)));
    assert.equal(result.diagnostic, 'publication-unknown');
    const owners = new RunOwnershipStore(root);
    const owner = owners.read(runID);
    const targetClaim = owners.parentClaim(targetID);
    const targetCheckpoint = new CheckpointStore(root).read(targetID);
    const targetProgress = new ProgressGuard(root).read(targetID);
    if (stage === 'before-claim') {
      assert.equal(owner.state, 'idle'); assert.equal(targetClaim, undefined);
    } else {
      assert.equal(targetClaim.transfer.sourceSessionID, sourceID);
      assert.equal(owner.state, stage === 'after-claim' ? 'idle' : ['after-finish', 'after-restore'].includes(stage) ? 'idle' : 'transferring');
    }
    assert.equal(!!targetCheckpoint, ['after-checkpoint', 'after-progress', 'after-finish', 'after-restore'].includes(stage));
    assert.equal(!!targetProgress, ['after-progress', 'after-finish', 'after-restore'].includes(stage));
    const fresh = await plugin(input);
    const status = JSON.parse(await fresh.tool.mdd_status.execute({}, context(targetID)));
    if (['after-finish', 'after-restore'].includes(stage)) assert.equal(status.transfer?.state, 'confirmed');
    else if (stage === 'before-claim') assert.equal(status.state, 'not-started');
    else {
      assert.equal(status.state, 'recovery-blocked'); assert.equal(status.transfer?.state, 'ambiguous');
      assert.equal(status.transfer.stage, stage === 'after-claim' ? 'claim-only' :
        stage === 'after-source-fence' ? 'owner-fenced' : 'published');
      assert.equal(status.task, undefined);
    }
  });
}

test('two fresh target plugin instances race one source without two confirmed owners', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-two-targets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  approvalCheckpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const targets = await Promise.all([plugin(input), plugin(input)]);
  const request = { sourceSessionID: sourceID, runID, userText };
  const outcomes = await Promise.allSettled(targets.map((instance, index) => instance.tool.mdd_transfer.execute(request,
    context(index === 0 ? 'ses_target_a' : 'ses_target_b'))));
  const confirmed = outcomes.filter(item => item.status === 'fulfilled' && JSON.parse(item.value).transfer?.state === 'confirmed');
  assert.ok(confirmed.length <= 1);
  const owner = new RunOwnershipStore(root).read(runID);
  assert.ok(['idle', 'transferring'].includes(owner.state));
  if (owner.ownerSessionID !== sourceID) {
    assert.equal(owner.receipt.targetSessionID, owner.ownerSessionID);
    assert.ok(['ses_target_a', 'ses_target_b'].includes(owner.ownerSessionID));
    await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-source', tool: 'task' },
      { args: { description: 'late', subagent_type: 'mdd-propose', prompt: 'late' } }));
  }
  const other = owner.ownerSessionID === 'ses_target_a' ? 'ses_target_b' : 'ses_target_a';
  if (new RunOwnershipStore(root).parentClaim(other)?.transfer) {
    const fresh = await plugin(input);
    const blocked = JSON.parse(await fresh.tool.mdd_status.execute({}, context(other)));
    assert.equal(blocked.state, 'recovery-blocked');
    assert.equal(blocked.task, undefined);
  }
});

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
      { args: { description: 'old work', subagent_type: 'mdd-plan', prompt: 'old work' } }));
  }
});

test('killed transfer process after checkpoint publication stays fenced until explicit finish', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-process-kill-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context, histories } = host(root);
  const source = await plugin(input);
  await source.tool.mdd_status.execute({}, context(sourceID));
  const killed = await transferChild(root, 'ses_target_a', 'crash-checkpoint');
  assert.equal(killed.code, 72, killed.error);
  const owners = new RunOwnershipStore(root);
  assert.equal(owners.read(runID).state, 'transferring');
  assert.ok(new CheckpointStore(root).read('ses_target_a'));
  const target = await plugin(input);
  const blocked = JSON.parse(await target.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(blocked.state, 'recovery-blocked');
  assert.equal(blocked.transfer.stage, 'published');
  assert.equal(blocked.task, undefined);
  const claim = owners.parentClaim('ses_target_a').transfer;
  const text = `Recover stopped transfer sourceSessionID=${sourceID} runID=${runID} operationID=${claim.operationID}`;
  appendUser(histories, 'ses_target_a', 'user-process-recovery', text);
  const recovered = await plugin(input);
  const result = JSON.parse(await recovered.tool.mdd_transfer_recover.execute({ sourceSessionID: sourceID, runID,
    operationID: claim.operationID, action: 'finish-published', userText: text }, context('ses_target_a')));
  assert.equal(result.transfer?.state, 'confirmed', JSON.stringify(result));
  assert.equal(owners.read(runID).ownerSessionID, 'ses_target_a');
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-killed-source', tool: 'task' },
    { args: { description: 'old work', subagent_type: 'mdd-plan', prompt: 'old work' } }));
});

test('target memory binding fails before transfer reservation when source needs Engram', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const source = checkpoint(root);
  const data = { ...source.data, memoryProject: 'bound-project' };
  new CheckpointStore(root).write(sourceID, { ...source, sequence: source.sequence + 1, data,
    dataDigest: sealResumeData(data, runID, sourceID, source.events, source.stable) });
  const owners = new RunOwnershipStore(root);
  owners.claimParent(sourceID, runID);
  owners.claim({ runID, sessionID: sourceID, directory: root, worktree: root });
  const { input, context } = host(root);
  const target = await plugin(input);
  const outcome = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context('ses_target_a')));
  assert.equal(outcome.diagnostic, 'memory-unavailable');
  assert.equal(owners.read(runID).state, 'idle');
  assert.equal(owners.parentClaim('ses_target_a'), undefined);
  assert.equal(new CheckpointStore(root).read('ses_target_a'), undefined);
});

for (const backend of ['engram', 'both']) test(`prebound ${backend} target transfer writes only in target Engram session`, async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-bound-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const targetID = 'ses_target_a';
  const server = await memoryServer(t, (req, reply) => {
    if (req.url.startsWith('/sessions/')) {
      const id = decodeURIComponent(req.url.split('/').at(-1));
      if (![sourceID, targetID].includes(id)) { reply.status = 404; reply.data = { error: 'missing' }; }
      else reply.data = { id, project: 'mdd-test', directory: root };
    }
    if (req.url.startsWith('/project/current?')) reply.data = { project: 'mdd-test', cwd: root, project_path: root, available_projects: [] };
  });
  const settings = defaultSettings();
  settings.engram = { endpoint: server.endpoint };
  saveGlobalSettings(settings);
  const id = 'run-valid';
  const request = `Continue MDD sourceSessionID=${sourceID} runID=${id} here.`;
  memoryCheckpoint(root, id, backend);
  const { input, context } = host(root, [sourceID, targetID], request);
  const source = await plugin(input);
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'ready');
  const sourceMemory = new EngramHttp(server.endpoint, { id: sourceID, project: 'mdd-test', directory: root });
  const oldRef = (await new ArtifactStore(root, 'engram', sourceMemory).save({ runID: id, phase: 'mdd-explore' }, 'Historical source artifact.')).ref;
  const targetMemory = new EngramHttp(server.endpoint, { id: targetID, project: 'mdd-test', directory: root });
  await assert.rejects(new ArtifactStore(root, 'engram', targetMemory).read(oldRef), /Unissued artifact reference/);
  const target = await plugin(input);
  const transferred = JSON.parse(await target.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID: id, userText: request }, context(targetID)));
  assert.equal(transferred.transfer?.state, 'confirmed', JSON.stringify(transferred));
  const priorWrites = server.writes.length;
  const task = structuredClone(transferred.task);
  const call = { sessionID: targetID, callID: `task-${backend}`, tool: 'task' };
  await target['tool.execute.before'](call, { args: task });
  assert.match(task.prompt, /Native callID/);
  const text = reportDocument({ outcome: 'passed', evidenceSummary: 'Plan recorded in target.',
    artifact: 'Implement the input boundary and verify it.', ...traceFixture() });
  await target['tool.execute.after']({ ...call, args: task }, {
    output: `<task id="ses_child" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`,
  });
  const newWrites = server.writes.slice(priorWrites);
  assert.ok(newWrites.length >= 3);
  assert.ok(newWrites.every(write => write.session_id === targetID));
  assert.ok(newWrites.some(write => write.type === 'mdd-artifact'));
  if (backend === 'both') assert.equal(existsSync(join(root, 'openspec', 'changes', id, 'plan.md')), true);
  const fresh = await plugin(input);
  assert.equal(JSON.parse(await fresh.tool.mdd_status.execute({}, context(targetID))).transfer.state, 'confirmed');
});

test('wrong root, missing/corrupt source, pending child and unresolved approval all fail closed', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-root-'));
  const other = mkdtempSync(join(tmpdir(), 'mdd-transfer-other-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  saveGlobalSettings(defaultSettings());
  const record = checkpoint(root);
  const local = host(root);
  const target = await plugin(local.input);
  const request = { sourceSessionID: sourceID, runID, userText };
  const invoke = () => target.tool.mdd_transfer.execute(request, local.context('ses_target_a')).then(JSON.parse);
  const remote = host(other);
  const wrongRoot = await plugin(remote.input);
  assert.equal(JSON.parse(await wrongRoot.tool.mdd_transfer.execute(request, remote.context('ses_target_a'))).diagnostic, 'source-unavailable');
  const missingText = `Continue sourceSessionID=ses_missing runID=${runID}`;
  const missing = host(root, ['ses_target_a'], missingText);
  const missingTarget = await plugin(missing.input);
  assert.equal(JSON.parse(await missingTarget.tool.mdd_transfer.execute({ sourceSessionID: 'ses_missing', runID, userText: missingText },
    missing.context('ses_target_a'))).diagnostic, 'source-unavailable');
  new ProgressGuard(root).write(sourceID, { runID, userMessageID: 'user-source', state: 'pending', callID: 'task-old', attemptID: 'task-old' });
  assert.equal((await invoke()).diagnostic, 'pending-unknown');
  new ProgressGuard(root).clear(sourceID);
  const questions = new QuestionCheckpointStore(root);
  questions.write(sourceID, { version: 1, parent: sourceID, sequence: 0, runID, requirements: record.data.requirements,
    userMessageID: 'user-source', known: answers, checkpoint: { sequence: 0, digest: record.dataDigest },
    state: 'prepared', slot: { kind: 'approval', phase: 'mdd-apply', args: { questions: [{ header: 'Approval', question: 'Approve Apply?', multiple: false,
      options: [{ label: 'Continue', description: 'Approve only Apply.' }] }] } }, clarifications: [], deferred: [], clarificationAnswers: [] });
  assert.equal((await invoke()).diagnostic, 'pending-unknown');
  const prepared = questions.read(sourceID);
  questions.write(sourceID, { ...prepared, sequence: 1, state: 'pending', callID: 'question-old' });
  questions.write(sourceID, { ...prepared, sequence: 2, state: 'answered', callID: 'question-old', answer: [['Continue']] });
  assert.equal((await invoke()).diagnostic, 'pending-unknown');
  questions.clear(sourceID);
  const files = new CheckpointStore(root);
  files.clear(sourceID);
  files.write(sourceID, { version: 1, parent: sourceID, runID, sequence: 0, request: record.request, events: [] });
  assert.equal((await invoke()).diagnostic, 'source-unavailable');
  files.clear(sourceID);
  // A fresh, eventless v2 record: dependency counts must still agree with zero recorded results.
  const { risk: _risk, ...emptyData } = { ...record.data, dependencies: [], contexts: [] };
  files.write(sourceID, { version: 2, parent: sourceID, runID, sequence: 0, request: record.request, events: [],
    data: emptyData, dataDigest: sealResumeData(emptyData, runID, sourceID, []) });
  assert.equal((await invoke()).diagnostic, 'source-unavailable');
  const path = join(root, '.mdd', `checkpoint-${createHash('sha256').update(sourceID).digest('hex')}.json`);
  writeFileSync(path, '{broken');
  assert.equal((await invoke()).diagnostic, 'source-unavailable');
});

test('a source checkpoint alone cannot impersonate the native top-level source parent', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-source-sdk-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context } = host(root);
  const original = input.client.session.get;
  const request = { sourceSessionID: sourceID, runID, userText };
  for (const change of [
    { agent: 'general' }, { parentID: 'another-parent' }, { projectID: 'another-project' }, { directory: 'another-directory' },
  ]) {
    input.client.session.get = async args => {
      const response = await original(args);
      return args.path.id === sourceID ? { data: { ...response.data, ...change } } : response;
    };
    const target = await plugin(input);
    const result = JSON.parse(await target.tool.mdd_transfer.execute(request, context('ses_target_a')));
    assert.equal(result.diagnostic, 'source-unavailable');
    assert.equal(new CheckpointStore(root).read('ses_target_a'), undefined);
  }
});

test('target-first claim blocks native target startup before source is fenced', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-target-first-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const sourceRecord = checkpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  const target = await plugin(input);
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'ready');
  const owners = new RunOwnershipStore(root);
  const targetID = 'ses_target_a';
  const intent = { operationID: 'target-first', nativeUserMessageID: `user-${targetID}`, requestDigest: 'a'.repeat(64) };
  owners.claimTargetForTransfer(runID, sourceID, { sessionID: targetID, directory: root, worktree: root },
    { sequence: sourceRecord.sequence, digest: sourceRecord.dataDigest }, 0, intent);
  assert.equal(owners.read(runID).state, 'idle');
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'ready');
  const waiting = JSON.parse(await target.tool.mdd_status.execute({}, context(targetID)));
  assert.equal(waiting.state, 'recovery-blocked');
  assert.equal(waiting.transfer.state, 'ambiguous');
  assert.equal(waiting.task, undefined);
  await assert.rejects(target.tool.mdd_start.execute({ requirements: userText }, context(targetID)), /transfer claim/);
  await assert.rejects(target.tool.mdd_contextual_explore.execute({ purpose: 'another task' }, context(targetID)), /transfer claim/);
  const fenced = owners.beginTransfer(runID, sourceID, { sessionID: targetID, directory: root, worktree: root },
    sourceRecord.dataDigest, 0, sourceRecord.sequence, intent);
  assert.equal(fenced.state, 'transferring');
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'recovery-blocked');
  assert.equal(JSON.parse(await target.tool.mdd_status.execute({}, context(targetID))).state, 'recovery-blocked');
});

test('a transferring owner fences a restored source across coordinator tools and native callbacks', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-source-fence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  checkpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  const status = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(status.state, 'ready');
  const owners = new RunOwnershipStore(root);
  owners.beginTransfer(runID, sourceID, { sessionID: 'ses_target_a', directory: root, worktree: root }, 'a'.repeat(64), 0);
  const call = { sessionID: sourceID, callID: 'stale-task', tool: 'task' };
  await assert.rejects(source['tool.execute.before'](call, { args: { ...status.task } }), /durable run owner/);
  await assert.rejects(source['tool.execute.after']({ ...call, args: status.task }, { output: 'forged' }), /durable run owner/);
  await assert.rejects(source['tool.execute.before']({ ...call, tool: 'question' }, { args: { questions: [] } }), /durable run owner/);
  await assert.rejects(source['tool.execute.after']({ ...call, tool: 'question', args: { questions: [] } }, { output: 'forged' }), /durable run owner/);
  for (const [name, args] of [
    ['mdd_prepare_advance', { questions: [] }], ['mdd_revisit', {}], ['mdd_phase_result', { result: 'forged' }],
    ['mdd_reset', { scope: 'run' }], ['mdd_context', { label: 'source', content: 'forged' }],
    ['mdd_improve', { userText, title: 'Stale', detail: 'Must not write.' }],
    ['mdd_change_request', { kind: 'rerun', userText }], ['mdd_contextual_explore', { purpose: 'stale' }],
    ['mdd_start', { requirements: 'Plan a safe change.' }], ['mdd_pr_body', { userText }],
  ]) await assert.rejects(source.tool[name].execute(args, context(sourceID)), /durable run owner/, name);
  assert.equal(JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).state, 'recovery-blocked');
  assert.equal(owners.read(runID).state, 'transferring');
  assert.equal(new CheckpointStore(root).read(sourceID).checkpoint.sequence, 0);
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

test('two plugin instances cannot publish different fresh runs for the same parent', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-start-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = defaultSettings();
  settings.profiles.default.answers = answers;
  saveGlobalSettings(settings);
  const requirements = 'Plan a safe change.';
  const { input, context } = host(root, [sourceID], requirements);
  const instances = await Promise.all([plugin(input), plugin(input)]);
  const results = await Promise.allSettled(instances.map(instance => instance.tool.mdd_start.execute({ requirements }, context(sourceID))));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  const winner = JSON.parse(results.find(item => item.status === 'fulfilled').value);
  assert.equal(new RunOwnershipStore(root).parent(sourceID), winner.runID);
  assert.equal(new CheckpointStore(root).read(sourceID).checkpoint.runID, winner.runID);
});

test('two plugin instances cannot both expose a preflight question', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-intake-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const requirements = 'Plan a safe change.';
  const { input, context } = host(root, [sourceID], requirements);
  const instances = await Promise.all([plugin(input), plugin(input)]);
  const results = await Promise.allSettled(instances.map(instance => instance.tool.mdd_start.execute({ requirements }, context(sourceID))));
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  const winner = JSON.parse(results.find(item => item.status === 'fulfilled').value);
  assert.equal(winner.state, 'question-ready');
  assert.ok(winner.question);
  assert.equal(new RunOwnershipStore(root).intake(sourceID).state, 'pending');
  const restarted = await plugin(input);
  const blocked = JSON.parse(await restarted.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(blocked.state, 'recovery-blocked');
  assert.equal(blocked.question, undefined);
  await restarted.tool.mdd_reset.execute({ scope: 'run' }, context(sourceID));
  assert.equal(new RunOwnershipStore(root).intake(sourceID).state, 'retired');
  const retried = JSON.parse(await restarted.tool.mdd_start.execute({ requirements }, context(sourceID)));
  assert.equal(retried.state, 'question-ready');
});

test('an async coordinator operation holds ownership until native inspection returns', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-operation-race-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settings = defaultSettings();
  settings.profiles.default.answers = answers;
  saveGlobalSettings(settings);
  const requirements = 'Plan a safe change.';
  const { input, context } = host(root, [sourceID], requirements);
  const source = await plugin(input);
  const rival = await plugin(input);
  const run = JSON.parse(await source.tool.mdd_start.execute({ requirements }, context(sourceID)));
  const messages = input.client.session.messages;
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let resume;
  const blocked = new Promise(resolve => { resume = resolve; });
  input.client.session.messages = async args => { entered(); await blocked; return messages(args); };
  // A mutating tool (a change request writes the question and consent records) holds the writer.
  const change = source.tool.mdd_change_request.execute({ kind: 'rerun', userText: requirements }, context(sourceID));
  await waiting;
  const owner = new RunOwnershipStore(root).read(run.runID);
  assert.equal(owner.state, 'reserved');
  assert.throws(() => new RunOwnershipStore(root).beginTransfer(run.runID, sourceID,
    { sessionID: 'ses_target_a', directory: root, worktree: root }, 'a'.repeat(64), owner.epoch));
  await assert.rejects(rival.tool.mdd_context.execute({ label: 'Issue', content: 'Cannot change during inspection.' }, context(sourceID)));
  resume();
  await change.catch(() => {});
  assert.equal(new RunOwnershipStore(root).read(run.runID).state, 'idle');
  // A read-only draft never takes the durable writer, even while it awaits native inspection.
  let enteredDraft;
  const draftWaiting = new Promise(resolve => { enteredDraft = resolve; });
  let resumeDraft;
  const draftBlocked = new Promise(resolve => { resumeDraft = resolve; });
  input.client.session.messages = async args => { enteredDraft(); await draftBlocked; return messages(args); };
  const draft = source.tool.mdd_pr_body.execute({ userText: requirements }, context(sourceID));
  await draftWaiting;
  assert.equal(new RunOwnershipStore(root).read(run.runID).state, 'idle');
  resumeDraft();
  await draft.catch(() => {});
  assert.equal(new RunOwnershipStore(root).read(run.runID).state, 'idle');
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

test('primitive finish fences late source callbacks without enabling the transfer tool', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-finish-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  const saved = checkpoint(root);
  const { input, context } = host(root);
  const source = await plugin(input);
  const oldTask = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID))).task;
  const owners = new RunOwnershipStore(root);
  const targetID = 'ses_target_a';
  const intent = { operationID: 'transfer-finished', nativeUserMessageID: `user-${targetID}`,
    requestDigest: createHash('sha256').update(userText).digest('hex') };
  const reserved = owners.reserveVerifiedTransfer(runID, sourceID,
    { sessionID: targetID, directory: root, worktree: root }, { sequence: saved.sequence, digest: saved.dataDigest }, 0, intent);
  const data = { ...saved.data, userMessageID: `user-${targetID}`, usedMessages: [`user-${targetID}`], proposed: [] };
  const target = { ...saved, parent: targetID, sequence: 0, data,
    dataDigest: sealResumeData(data, runID, targetID, saved.events, saved.stable) };
  new CheckpointStore(root).write(targetID, target);
  const sourceMarker = new ProgressGuard(root).read(sourceID);
  if (sourceMarker) new ProgressGuard(root).write(targetID, { ...sourceMarker, userMessageID: `user-${targetID}` });
  const beforeFinish = await plugin(input);
  const pending = JSON.parse(await beforeFinish.tool.mdd_status.execute({}, context(targetID)));
  assert.equal(pending.state, 'recovery-blocked');
  assert.equal(pending.transfer.state, 'ambiguous');
  assert.equal(pending.task, undefined);
  owners.finishVerifiedTransfer(runID, sourceID, targetID, reserved.epoch,
    { sourceSequence: saved.sequence, sourceDigest: saved.dataDigest, targetSequence: target.sequence, targetDigest: target.dataDigest }, intent);
  const call = { sessionID: sourceID, callID: 'late-source', tool: 'task' };
  await assert.rejects(source['tool.execute.before'](call, { args: { ...oldTask } }), /moved to conversation/);
  await assert.rejects(source['tool.execute.after']({ ...call, args: oldTask }, { output: 'stale' }), /moved to conversation/);
  await assert.rejects(source.tool.mdd_reset.execute({ scope: 'phase' }, context(sourceID)), /moved to conversation/);
  const moved = JSON.parse(await source.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(moved.state, 'transferred');
  assert.equal(moved.transfer.state, 'source-retired');
  assert.equal(moved.task, undefined);
  // The source may free itself for new work; that never reaches the transferred run.
  assert.equal(JSON.parse(await source.tool.mdd_reset.execute({ scope: 'run' }, context(sourceID))).reset.scope, 'run');
  assert.equal(owners.read(runID).ownerSessionID, targetID);
  const targetPlugin = await plugin(input);
  const recovered = JSON.parse(await targetPlugin.tool.mdd_status.execute({}, context(targetID)));
  assert.equal(recovered.state, 'ready');
  assert.equal(recovered.runID, runID);
  assert.equal(recovered.transfer.state, 'confirmed');
  const wrongNative = host(root, [sourceID, targetID], 'A different native request.');
  const wrongPlugin = await plugin(wrongNative.input);
  const ambiguous = JSON.parse(await wrongPlugin.tool.mdd_status.execute({}, wrongNative.context(targetID)));
  assert.equal(ambiguous.state, 'recovery-blocked');
  assert.equal(ambiguous.transfer.state, 'ambiguous');
  assert.equal(JSON.parse(await targetPlugin.tool.mdd_transfer.execute({ sourceSessionID: sourceID, runID, userText }, context(targetID))).state, 'transfer-blocked');
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

test('re-audit T1: a transferred target keeps working live after a degraded checkpoint write and can be discarded', async t => {
  const { root, context, histories, source, sourceTask, target, targetID } = await confirmedTransfer(t, 'mdd-transfer-degraded-live-');
  const fault = degradeNextCheckpointWrites(t);
  const contributed = JSON.parse(await target.tool.mdd_context.execute({ label: 'Issue', content: 'More context for the plan.' }, context(targetID)));
  fault.mock.restore();
  assert.equal(contributed.state, 'ready');
  assert.equal(new ProgressGuard(root).read(targetID).resumable, false);
  const live = JSON.parse(await target.tool.mdd_status.execute({}, context(targetID)));
  assert.equal(live.state, 'ready', JSON.stringify(live.reason));
  assert.ok(live.task, 'the degraded target still exposes its ready task');
  assert.equal(live.transfer?.state, 'confirmed');
  const discard = 'Discard this transferred run please.';
  appendUser(histories, targetID, 'user-discard-degraded', discard);
  const reset = JSON.parse(await target.tool.mdd_reset.execute({ scope: 'run', userText: discard }, context(targetID)));
  assert.equal(reset.reset.scope, 'run');
  const owners = new RunOwnershipStore(root);
  assert.equal(owners.parent(targetID), undefined);
  assert.equal(owners.read(runID).ownerSessionID, targetID, 'discarding the target never revives the source');
  await assert.rejects(source['tool.execute.before']({ sessionID: sourceID, callID: 'late-source-degraded', tool: 'task' }, { args: sourceTask }));
  const next = 'Plan a different safe change now.';
  appendUser(histories, targetID, 'user-next-degraded', next);
  assert.equal(JSON.parse(await target.tool.mdd_start.execute({ requirements: next }, context(targetID))).state, 'question-ready');
});

test('re-audit T1: after restart a degraded transferred target is data only, not ambiguous, and can be discarded', async t => {
  const { root, input, context, histories, targetID, target } = await confirmedTransfer(t, 'mdd-transfer-degraded-restart-');
  const fault = degradeNextCheckpointWrites(t);
  await target.tool.mdd_context.execute({ label: 'Issue', content: 'More context for the plan.' }, context(targetID));
  fault.mock.restore();
  const restarted = await plugin(input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, context(targetID)));
  assert.notEqual(status.state, 'recovery-blocked', status.reason);
  assert.equal(status.task, undefined, 'a non-resumable target is never dispatched from stale bytes');
  assert.equal(status.transfer?.state, 'confirmed');
  const discard = 'Discard this transferred run please.';
  appendUser(histories, targetID, 'user-discard-restart', discard);
  await assert.rejects(restarted.tool.mdd_reset.execute({ scope: 'run' }, context(targetID)), /userText/);
  assert.equal(JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run', userText: discard }, context(targetID))).reset.scope, 'run');
  assert.equal(new RunOwnershipStore(root).parent(targetID), undefined);
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, targetID);
  const next = 'Plan a different safe change now.';
  appendUser(histories, targetID, 'user-next-restart', next);
  assert.equal(JSON.parse(await restarted.tool.mdd_start.execute({ requirements: next }, context(targetID))).state, 'question-ready');
});

test('re-audit T1: a later target checkpoint descendant still confirms the receipt after restart', async t => {
  const { input, context, targetID, target } = await confirmedTransfer(t, 'mdd-transfer-descendant-');
  await target.tool.mdd_context.execute({ label: 'Issue', content: 'Context written after the transfer.' }, context(targetID));
  const restarted = await plugin(input);
  const status = JSON.parse(await restarted.tool.mdd_status.execute({}, context(targetID)));
  assert.equal(status.state, 'ready', status.reason);
  assert.equal(status.runID, runID);
  assert.equal(status.transfer.state, 'confirmed');
});

for (const restart of [false, true]) test(`re-audit T2: the source conversation starts a new objective after a transfer (${restart ? 'after restart' : 'same process'})`, async t => {
  const { root, input, context, histories, source, sourceTask } = await confirmedTransfer(t, 'mdd-transfer-source-fresh-');
  const conversation = restart ? await plugin(input) : source;
  const moved = JSON.parse(await conversation.tool.mdd_status.execute({}, context(sourceID)));
  assert.equal(moved.transfer?.state, 'source-retired');
  assert.equal(moved.task, undefined);
  const objective = 'Plan an unrelated safe change here.';
  appendUser(histories, sourceID, 'user-source-new', objective);
  const started = JSON.parse(await conversation.tool.mdd_start.execute({ requirements: objective }, context(sourceID)));
  assert.equal(started.state, 'question-ready', JSON.stringify(started.reason));
  const owners = new RunOwnershipStore(root);
  assert.notEqual(owners.parent(sourceID), runID);
  assert.equal(owners.read(runID).ownerSessionID, 'ses_target_a', 'the transferred run stays with its target');
  // The handed-over run can never be driven from here again.
  await assert.rejects(conversation['tool.execute.before']({ sessionID: sourceID, callID: 'late-source-task', tool: 'task' }, { args: sourceTask }));
  const target = await plugin(input);
  const targetStatus = JSON.parse(await target.tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(targetStatus.state, 'ready');
  assert.equal(targetStatus.runID, runID);
});

test('re-audit T2: mdd_reset run retires a transferred-away source claim without touching the run', async t => {
  const { root, input, context, histories, sourceTask } = await confirmedTransfer(t, 'mdd-transfer-source-reset-');
  const restarted = await plugin(input);
  await assert.rejects(restarted.tool.mdd_context.execute({ label: 'late', content: 'Must not reach the moved run.' }, context(sourceID)), /moved|durable run owner/);
  const reset = JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run' }, context(sourceID)));
  assert.equal(reset.reset.scope, 'run');
  const owners = new RunOwnershipStore(root);
  assert.equal(owners.parent(sourceID), undefined);
  assert.equal(owners.read(runID).ownerSessionID, 'ses_target_a');
  assert.equal(new CheckpointStore(root).read('ses_target_a').checkpoint.runID, runID);
  await assert.rejects(restarted['tool.execute.before']({ sessionID: sourceID, callID: 'late-after-source-reset', tool: 'task' }, { args: sourceTask }));
  const objective = 'Plan another unrelated safe change.';
  appendUser(histories, sourceID, 'user-source-after-reset', objective);
  assert.equal(JSON.parse(await restarted.tool.mdd_start.execute({ requirements: objective }, context(sourceID))).state, 'question-ready');
  const targetStatus = JSON.parse(await (await plugin(input)).tool.mdd_status.execute({}, context('ses_target_a')));
  assert.equal(targetStatus.state, 'ready');
});

test('re-audit f: an abort that validated before a finish commits cannot delete the finished target bytes', async t => {
  const { root, input, context, owners, claim, text } = await partialPublication(t, 'mdd-transfer-finish-abort-race-');
  const targetID = 'ses_target_a';
  const confirmation = { operationID: claim.operationID, nativeUserMessageID: claim.nativeUserMessageID, requestDigest: claim.requestDigest,
    ...(claim.assistantMessageID ? { assistantMessageID: claim.assistantMessageID } : {}) };
  const source = new CheckpointStore(root).read(sourceID).checkpoint;
  const published = new CheckpointStore(root).read(targetID).checkpoint;
  const expected = { sourceSequence: source.sequence, sourceDigest: source.dataDigest, targetSequence: published.sequence, targetDigest: published.dataDigest };
  // A concurrent finish lands exactly between the abort's decision and its deletion.
  const clear = CheckpointStore.prototype.clear;
  let raced = false;
  t.mock.method(CheckpointStore.prototype, 'clear', function (parent) {
    if (!raced && parent === targetID) {
      raced = true;
      try {
        owners.completePartialPublication(runID, sourceID, targetID, claim.ownerEpoch + 1, expected, confirmation);
        owners.finishVerifiedTransfer(runID, sourceID, targetID, claim.ownerEpoch + 1, expected, confirmation);
      } catch { /* The abort holds the owner: the finish must wait or fail. */ }
    }
    return clear.call(this, parent);
  });
  try { owners.removeUnfinishedPublication(runID, sourceID, targetID, claim.ownerEpoch + 1, confirmation); } catch { /* either side may win */ }
  t.mock.restoreAll();
  assert.equal(raced, true);
  const owner = owners.read(runID);
  // Never both: a committed receipt whose target bytes were deleted underneath it.
  assert.ok(!(owner.receipt && !new CheckpointStore(root).read(targetID)), 'finish committed but abort deleted its target');
  void input; void context; void text;
});

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

test('chained transfer A->B->C: C owns and dispatches, A and B stay fenced, statuses are correct', async t => {
  const { root, input, context, histories, p, A, B, C, aTask, bTask } = await chain(t, 'mdd-transfer-chain-');
  const textC = `Continue MDD sourceSessionID=${B} runID=${runID} here.`;
  appendUser(histories, C, 'user-c-continue', textC);
  const bc = JSON.parse(await p.tool.mdd_transfer.execute({ sourceSessionID: B, runID, userText: textC }, context(C)));
  assert.equal(bc.transfer?.state, 'confirmed', JSON.stringify(bc));
  assert.equal(bc.state, 'ready');
  const owner = new RunOwnershipStore(root).read(runID);
  assert.equal(owner.ownerSessionID, C);
  assert.equal(owner.originSessionID, B);
  assert.equal(owner.receipt.sourceSessionID, B);
  assert.equal(owner.receipt.targetSessionID, C);
  for (const instance of [p, await plugin(input)]) {
    for (const [sid, task] of [[A, aTask], [B, bTask]]) {
      await assert.rejects(instance['tool.execute.before']({ sessionID: sid, callID: `late-${sid}`, tool: 'task' }, { args: structuredClone(task) }), /moved to conversation/);
      await assert.rejects(instance['tool.execute.after']({ sessionID: sid, callID: `late-${sid}`, tool: 'task', args: task }, { output: 'late' }), /moved to conversation/);
      await assert.rejects(instance.tool.mdd_context.execute({ label: 'late', content: 'Must not reach the run.' }, context(sid)), /moved to conversation/);
      const moved = JSON.parse(await instance.tool.mdd_status.execute({}, context(sid)));
      assert.equal(moved.state, 'transferred', sid);
      assert.equal(moved.transfer.targetSessionID, C, sid);
    }
    const current = JSON.parse(await instance.tool.mdd_status.execute({}, context(C)));
    assert.equal(current.state, 'ready');
    assert.equal(current.runID, runID);
    assert.equal(current.transfer.state, 'confirmed');
    assert.equal(current.transfer.sourceSessionID, B);
  }
  const restarted = await plugin(input);
  const ready = JSON.parse(await restarted.tool.mdd_status.execute({}, context(C)));
  const history = histories.get(C);
  history[history.length - 1].parts = [{ type: 'tool', tool: 'task', callID: 'task-c', state: { status: 'running', input: structuredClone(ready.task) } }];
  await restarted['tool.execute.before']({ sessionID: C, callID: 'task-c', tool: 'task' }, { args: structuredClone(ready.task) });
  assert.equal(new RunOwnershipStore(root).read(runID).state, 'reserved');
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, C);
  for (const sid of [A, B]) assert.equal(JSON.parse(await restarted.tool.mdd_reset.execute({ scope: 'run' }, context(sid))).reset.scope, 'run');
  assert.equal(new RunOwnershipStore(root).read(runID).ownerSessionID, C);
  assert.equal(new RunOwnershipStore(root).parent(C), runID);
});

test('a re-transfer fences its source as soon as it begins and never mislabels the claiming conversation', async t => {
  const { root, context, p, A, B, C } = await chain(t, 'mdd-transfer-rechain-');
  const owners = new RunOwnershipStore(root);
  const saved = new CheckpointStore(root).read(B).checkpoint;
  const intent = { operationID: 'rechain', nativeUserMessageID: `user-${C}`,
    requestDigest: createHash('sha256').update(`Continue MDD sourceSessionID=${B} runID=${runID} here.`).digest('hex') };
  owners.reserveVerifiedTransfer(runID, B, { sessionID: C, directory: root, worktree: root },
    { sequence: saved.sequence, digest: saved.dataDigest }, owners.read(runID).epoch, intent);
  assert.equal(owners.read(runID).state, 'transferring');
  await assert.rejects(p.tool.mdd_context.execute({ label: 'late', content: 'B is fenced now.' }, context(B)), /durable run owner/);
  const claiming = JSON.parse(await p.tool.mdd_status.execute({}, context(C)));
  assert.notEqual(claiming.state, 'transferred');
  assert.equal(claiming.transfer?.state, 'ambiguous');
  assert.equal(claiming.task, undefined);
  assert.equal(JSON.parse(await p.tool.mdd_status.execute({}, context(A))).state, 'transferred');
});
