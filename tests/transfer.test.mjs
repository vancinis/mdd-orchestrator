import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from '../dist/opencode-plugin.js';
import { CheckpointStore, sealResumeData } from '../dist/checkpoint.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { Workflow } from '../dist/workflow.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome } from './adapter-fixture.mjs';

const sourceID = 'ses_source';
const runID = 'run_explicit';
const userText = `Continue MDD sourceSessionID=${sourceID} runID=${runID} here.`;
const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex' };

function checkpoint(root) {
  const request = { answers };
  const workflow = new Workflow(request);
  const evidence = { requirements: 'confirmed', plan: 'unearned', implementation: 'unearned', checks: 'unearned' };
  const data = { directory: root, worktree: root, userMessageID: 'user-source', requirements: 'Plan a safe change.', context: [],
    dependencies: [], contexts: [], decisions: [], planned: [], evidence, executedChecks: [], changedFiles: 0,
    calls: [], usedMessages: [], proposed: [] };
  const stable = { phase: 'mdd-plan', state: 'ready', mode: 'delegate', attempts: 0, spent: 0, malformed: 0,
    report: { phase: 'mdd-plan', summary: 'Ready to plan.', how: [], status: 'in-progress', evidence },
    changedList: [], concerns: [] };
  const record = { version: 3, parent: sourceID, runID, sequence: 0, request, events: workflow.history(), data, stable,
    dataDigest: sealResumeData(data, runID, sourceID, workflow.history(), stable) };
  new CheckpointStore(root).write(sourceID, record);
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
      status: async () => ({ data: {} }) },
  } };
  const context = id => ({ sessionID: id, agent: 'mdd-orchestrator', directory: root, worktree: root,
    messageID: `assistant-${id}`, abort: new AbortController().signal });
  return { input, context };
}

test('two target plugin instances cannot claim a live source without exclusive writer ownership', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prior = process.env.MDD_EXPERIMENTAL_RESUME;
  process.env.MDD_EXPERIMENTAL_RESUME = '1';
  t.after(() => { if (prior === undefined) delete process.env.MDD_EXPERIMENTAL_RESUME; else process.env.MDD_EXPERIMENTAL_RESUME = prior; });
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

test('wrong root, missing/corrupt source, pending child and unresolved approval all fail closed', async t => {
  isolateHome(t);
  const root = mkdtempSync(join(tmpdir(), 'mdd-transfer-root-'));
  const other = mkdtempSync(join(tmpdir(), 'mdd-transfer-other-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
  const prior = process.env.MDD_EXPERIMENTAL_RESUME;
  process.env.MDD_EXPERIMENTAL_RESUME = '1';
  t.after(() => { if (prior === undefined) delete process.env.MDD_EXPERIMENTAL_RESUME; else process.env.MDD_EXPERIMENTAL_RESUME = prior; });
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
  files.write(sourceID, { version: 2, parent: sourceID, runID, sequence: 0, request: record.request, events: [],
    data: record.data, dataDigest: sealResumeData(record.data, runID, sourceID, []) });
  assert.equal((await invoke()).diagnostic, 'source-unavailable');
  const path = join(root, '.mdd', `checkpoint-${createHash('sha256').update(sourceID).digest('hex')}.json`);
  writeFileSync(path, '{broken');
  assert.equal((await invoke()).diagnostic, 'source-unavailable');
});
