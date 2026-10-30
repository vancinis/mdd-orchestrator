import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Workflow } from '../dist/workflow.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore, CheckpointStorageError, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { EngramHttp } from '../dist/engram-http.js';
import { applyPlan, completeStep, selectedStep, taskIDs } from '../dist/apply-batches.js';
import { memoryServer, reportDocument, throughRiskStop, structuredTraceFixture as traceFixture } from './adapter-fixture.mjs';

const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };
const planned = () => {
  const trace = traceFixture('src/first.ts', 'first');
  trace.deliverables[0].scenarios = ['S1'];
  trace.deliverables.push({ ...trace.deliverables[0], id: 'second', path: 'src/second.ts', scenarios: ['S2'], dependsOn: ['first'],
    checks: [{ id: 'second-check', command: 'npm test', requirement: 'required' }] });
  return trace;
};
const report = data => reportDocument({ evidenceSummary: 'Scoped batch evidence.', artifact: 'Scoped batch artifact.', ...data });
const applied = (id, changes = [`src/${id}.ts`]) => ({ completed: [id], changes });

async function fixture(t, { mode = 'automatic', store = 'none', checkpointFault, progressFault, memoryFault, reader = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-apply-batches-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = { sessionID: 'ses_batches', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const memory = ['engram', 'both'].includes(store) ? await memoryServer(t, memoryFault) : undefined;
  if (memory) { memory.binding.id = runtime.sessionID; memory.binding.directory = root; }
  const durable = new CheckpointStore(root);
  const realProgress = new ProgressGuard(root);
  const checkpoint = checkpointFault ? { read: parent => durable.read(parent), clear: parent => durable.clear(parent),
    write(parent, value) { checkpointFault(value, () => durable.write(parent, value)); } } : durable;
  const progress = progressFault ? { read: parent => realProgress.read(parent), clear: parent => realProgress.clear(parent),
    write(parent, value) { progressFault(value, () => realProgress.write(parent, value)); } } : realProgress;
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  let binding;
  const child = { ...runtime, sessionID: 'ses-batch-reader', agent: 'mdd-verify', messageID: 'reader-message', callID: 'reader-call' };
  if (reader) inspect.artifactCaller = async caller => {
    assert.deepEqual(caller, child);
    assert.ok(binding, 'reads require an actually dispatched native task');
    return structuredClone(binding);
  };
  let runner = new PhaseRunner(inspect, { checkpoint, progress });
  let ordinal = 0;
  const f = { root, runtime, durable, realProgress, inspect, memory, child,
    get runner() { return runner; },
    status: () => runner.status(runtime.sessionID),
    async dispatch() {
      const status = f.status();
      const call = { sessionID: runtime.sessionID, callID: `call-${++ordinal}` };
      const args = await runner.before(call, status.task);
      binding = { parent: runtime.sessionID, callID: call.callID, args };
      return { call, args };
    },
    async finish(data) {
      const { call, args } = await f.dispatch();
      await runner.after(call, args, report(data));
      return { call, args };
    },
    async restart() {
      runner = new PhaseRunner(inspect, { checkpoint: durable, progress: realProgress });
      return runner.restore(runtime, memory ? async project => new EngramHttp(memory.endpoint, { id: runtime.sessionID, project, directory: root }) : undefined);
    },
  };
  await runner.start({ preflight: { answers: { ...answers, mode, artifactStore: store } }, requirements: 'Implement two dependent deliverables.',
    ...(memory ? { engramEndpoint: memory.endpoint, project: 'mdd-test' } : {}) }, runtime,
    { requirementsConfirmed: true, userMessageID: 'user-batches' });
  await throughRiskStop(runner, runtime.sessionID);
  await f.finish(planned());
  return f;
}

for (const store of ['engram', 'both']) {
}

test('batch selection validates plan IDs, dependency order and exact progress', () => {
  for (const value of [[], null, [{ id: 'first', dependsOn: ['first'] }], [{ id: 'first', dependsOn: [] }, { id: 'first', dependsOn: [] }]]) assert.throws(() => applyPlan(value));
  for (const value of [undefined, ['bad/id'], ['first', 'first'], Array(33).fill('first'), new Array(1)]) assert.throws(() => taskIDs(value));
  const progress = { epoch: 1, planned: applyPlan(planned().deliverables.map(({ id, dependsOn }) => ({ id, dependsOn }))), completed: [] };
  assert.equal(selectedStep(progress).id, 'first');
  assert.equal(selectedStep(completeStep(progress, ['first'])).id, 'second');
  assert.throws(() => completeStep(progress, []));
  assert.deepEqual(progress.completed, [], 'selection/completion never mutates caller state');
});

for (const store of ['openspec', 'local']) for (const mode of ['automatic', 'interactive']) {
}

for (const completed of [undefined, [], ['second'], ['unknown'], ['first', 'second'], ['first', 'first']]) {
}

for (const stopped of [true, false]) {
}

for (const store of ['none', 'local']) for (const landed of [false, true]) {
}

test('settled legacy histories stay without a batch plan; explicit rework binds a fresh batch plan', () => {
  const workflow = new Workflow({ answers });
  workflow.start('mdd-explore');
  workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Legacy settled evidence.' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Risk is low.', route: 'low' });
  for (const phase of ['mdd-plan', 'mdd-apply', 'mdd-verify']) {
    workflow.start(phase);
    workflow.recordResult({ phase, outcome: phase === 'mdd-verify' ? 'failed' : 'passed', evidenceSummary: 'Legacy settled evidence.' });
  }
  assert.equal(Workflow.replay({ answers }, workflow.history()).applyProgress(), undefined);
  workflow.rework('mdd-apply');
  workflow.bindApplyPlan(planned().deliverables.map(({ id, dependsOn }) => ({ id, dependsOn })));
  assert.deepEqual(workflow.applyProgress().completed, []);
  assert.equal(selectedStep(workflow.applyProgress()).id, 'first');
});

