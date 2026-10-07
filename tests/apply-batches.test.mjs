import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workflow } from '../dist/workflow.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore, CheckpointStorageError, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { EngramHttp } from '../dist/engram-http.js';
import { applyPlan, completeStep, selectedStep, taskIDs } from '../dist/apply-batches.js';
import { memoryServer, reportDocument, traceFixture } from './adapter-fixture.mjs';

const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };
const planned = () => {
  const trace = traceFixture('src/first.ts', 'first');
  trace.deliverables[0].scenarios = ['S1'];
  trace.deliverables.push({ ...trace.deliverables[0], id: 'second', path: 'src/second.ts', scenarios: ['S2'], dependsOn: ['first'] });
  return trace;
};
const report = data => reportDocument({ evidenceSummary: 'Scoped batch evidence.', artifact: 'Scoped batch artifact.', ...data });
const applied = (id, changes = [`src/${id}.ts`]) => ({ completed: [id], changes });

async function fixture(t, { mode = 'automatic', store = 'none', checkpointFault, progressFault, memoryFault } = {}) {
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
  let runner = new PhaseRunner(inspect, { checkpoint, progress });
  let ordinal = 0;
  const f = { root, runtime, durable, realProgress, inspect, memory,
    get runner() { return runner; },
    status: () => runner.status(runtime.sessionID),
    async dispatch() {
      const status = f.status();
      const call = { sessionID: runtime.sessionID, callID: `call-${++ordinal}` };
      return { call, args: await runner.before(call, status.task) };
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
  await f.finish(planned());
  return f;
}

for (const store of ['engram', 'both']) {
  test(`${store} batches preserve matching completion receipts and immutable artifacts across restart`, async t => {
    const f = await fixture(t, { store });
    await f.finish(applied('first'));
    assert.deepEqual(await f.restart(), { restored: true });
    await f.finish({ ...applied('second'), artifact: 'Second immutable batch.' });
    const results = f.memory.writes.map(item => JSON.parse(item.content)).filter(item => item.kind === 'agent-evidence' && item.phase === 'mdd-apply');
    assert.deepEqual(results.map(item => item.completed), [['first'], ['second']]);
    assert.notEqual(results[0].artifactRef.recordID, results[1].artifactRef.recordID);
    assert.notEqual(results[0].artifactRef.batchID, results[1].artifactRef.batchID);
    const artifacts = f.memory.writes.filter(item => item.type === 'mdd-artifact').map(item => JSON.parse(item.content));
    for (const result of results) {
      assert.equal(artifacts.find(item => item.recordID === result.artifactRef.recordID).batchID, result.artifactRef.batchID);
    }
    assert.equal(f.status().phase, 'mdd-verify');
  });
}

test('unknown general result receipt after confirmed Apply artifact never reissues the writer', async t => {
  let refused = 0;
  const f = await fixture(t, { store: 'both', memoryFault(req, reply, writes) {
    const record = writes.at(-1);
    if (req.method === 'POST' && record && JSON.parse(record.content).kind === 'agent-evidence' && JSON.parse(record.content).phase === 'mdd-apply') {
      refused++;
      reply.status = 500;
    }
  } });
  await assert.rejects(f.finish(applied('first')), /No automatic retry/);
  assert.equal(refused, 1);
  assert.equal(f.status().state, 'blocked');
  assert.equal(f.status().task, undefined);
  assert.equal(f.realProgress.read(f.runtime.sessionID).state, 'pending');
  assert.equal((await f.restart()).restored, false);
});

test('batch selection validates plan IDs, dependency order and exact progress', () => {
  for (const value of [[], null, [{ id: 'first', dependsOn: ['first'] }], [{ id: 'first', dependsOn: [] }, { id: 'first', dependsOn: [] }]]) assert.throws(() => applyPlan(value));
  for (const value of [undefined, ['bad/id'], ['first', 'first'], Array(33).fill('first'), new Array(1)]) assert.throws(() => taskIDs(value));
  const progress = { epoch: 1, planned: applyPlan(planned().deliverables.map(({ id, dependsOn }) => ({ id, dependsOn }))), completed: [] };
  assert.equal(selectedStep(progress).id, 'first');
  assert.equal(selectedStep(completeStep(progress, ['first'])).id, 'second');
  assert.throws(() => completeStep(progress, []));
  assert.deepEqual(progress.completed, [], 'selection/completion never mutates caller state');
});

for (const mode of ['automatic', 'interactive']) {
  test(`${mode} batches persist first completion, restart with only the dependent assignment, then advance Verify`, async t => {
    const f = await fixture(t, { mode, store: 'openspec' });
    if (mode === 'interactive') {
      assert.equal(f.status().state, 'await-approval');
      f.runner.approveNative(f.runtime.sessionID, 'mdd-apply');
    }
    const first = await f.dispatch();
    assert.deepEqual(JSON.parse(first.args.prompt.match(/^Applicable deliverables: (.*)$/m)[1]).map(step => step.id), ['first']);
    await f.runner.after(first.call, first.args, report(applied('first')));
    assert.equal(f.status().state, 'ready', 'no additional phase approval inside an approved Apply');
    assert.equal(f.status().phase, 'mdd-apply');
    const saved = f.durable.read(f.runtime.sessionID);
    assert.deepEqual(saved.workflow.applyProgress().completed, ['first']);
    assert.equal(saved.checkpoint.attempt.id, first.call.callID);
    assert.equal(saved.checkpoint.attempt.state, 'settled');
    const firstRef = f.status().artifacts.at(-1).ref;
    const firstBytes = readFileSync(join(f.root, firstRef.path), 'utf8');
    assert.deepEqual(await f.restart(), { restored: true });
    const second = await f.dispatch();
    assert.notEqual(first.call.callID, second.call.callID);
    assert.deepEqual(Object.keys(second.args).sort(), ['description', 'prompt', 'subagent_type']);
    assert.deepEqual(JSON.parse(second.args.prompt.match(/^Applicable deliverables: (.*)$/m)[1]).map(step => step.id), ['second']);
    assert.match(second.args.prompt, /"completed":\["first"\]/);
    await assert.rejects(f.runner.after(first.call, first.args, report(applied('first'))), /current dispatch/);
    await f.runner.after(second.call, second.args, report({ ...applied('second'), artifact: 'Distinct second batch.' }));
    assert.equal(f.status().workflow.nextAction.phase, 'mdd-verify');
    assert.equal(f.status().state, mode === 'automatic' ? 'ready' : 'await-approval');
    const secondRef = f.status().artifacts.at(-1).ref;
    assert.notEqual(firstRef.batchID, secondRef.batchID);
    assert.notEqual(firstRef.path, secondRef.path);
    assert.equal(readFileSync(join(f.root, firstRef.path), 'utf8'), firstBytes);
    if (mode === 'interactive') f.runner.approveNative(f.runtime.sessionID, 'mdd-verify');
    const verify = await f.dispatch();
    assert.deepEqual(JSON.parse(verify.args.prompt.match(/^Applicable deliverables: (.*)$/m)[1]).map(step => step.id), ['first', 'second']);
    assert.deepEqual(JSON.parse(verify.args.prompt.match(/^All changed-file evidence from every Apply batch: (.*)$/m)[1]).map(file => file.path), ['src/first.ts', 'src/second.ts']);
    const assessment = { status: 'verified', checks: ['npm test'], assessment: 'Source and focused checks support the full plan.' };
    await f.runner.after(verify.call, verify.args, report({ checks: [{ command: 'npm test', exit: 0 }], verification: {
      scenarios: ['S1', 'S2'].map((scenarioID, i) => ({ requirementID: 'R1', scenarioID, stepID: i ? 'second' : 'first', ...assessment })),
      steps: ['first', 'second'].map(stepID => ({ stepID, ...assessment })), decisions: [{ decisionID: 'D1', ...assessment }],
      changes: 'Both dependent deliverables are implemented.', limits: [],
    } }));
    assert.equal(f.status().state, 'complete');
    assert.deepEqual(await f.restart(), { restored: true });
    assert.equal(f.status().state, 'complete');
  });
}

for (const completed of [undefined, [], ['second'], ['unknown'], ['first', 'second'], ['first', 'first']]) {
  test(`invalid completed IDs ${JSON.stringify(completed)} permit only report restatement, never another writer`, async t => {
    const f = await fixture(t);
    const attempt = await f.dispatch();
    await assert.rejects(f.runner.after(attempt.call, attempt.args, report({ changes: ['src/first.ts'], ...(completed === undefined ? {} : { completed }) })), /could not read/);
    assert.equal(f.status().mode, 'inline');
    assert.equal(f.status().task, undefined);
    assert.deepEqual(f.durable.read(f.runtime.sessionID).workflow.applyProgress().completed, []);
    assert.deepEqual(await f.restart(), { restored: true });
    assert.equal(f.status().task, undefined);
    await f.runner.submit({ result: report(applied('first')) }, f.runtime);
    assert.equal(f.status().phase, 'mdd-apply');
    assert.equal(f.status().mode, 'delegate');
    assert.deepEqual(f.durable.read(f.runtime.sessionID).workflow.applyProgress().completed, ['first']);
  });
}

test('failed second batch blocks and preserves first completion plus reported partial files', async t => {
  const f = await fixture(t);
  await f.finish(applied('first'));
  await f.finish({ outcome: 'failed', changes: ['src/partial-second.ts'] });
  assert.equal(f.status().state, 'blocked');
  assert.equal(f.status().task, undefined);
  assert.deepEqual(f.durable.read(f.runtime.sessionID).workflow.applyProgress().completed, ['first']);
  assert.deepEqual(await f.restart(), { restored: true });
  assert.equal(f.status().state, 'blocked');
  assert.equal(f.runner.prFacts(f.runtime.sessionID).changedFiles, 2);
});

for (const stopped of [true, false]) {
  test(`interrupted Apply with stopped=${stopped} never retries and retains pending recovery`, async t => {
    const f = await fixture(t);
    const attempt = await f.dispatch();
    f.inspect.stopped = async () => stopped;
    await f.runner.nativeError(f.runtime.sessionID, attempt.call.callID);
    assert.equal(f.status().state, stopped ? 'blocked' : 'await-result');
    assert.equal(f.status().task, undefined);
    assert.equal(f.realProgress.read(f.runtime.sessionID).state, 'pending');
    assert.equal(f.durable.read(f.runtime.sessionID).checkpoint.attempt.state, 'pending');
    assert.equal((await f.restart()).restored, false);
  });
}

test('explicit second-batch recovery keeps complete Spanish clarification, first completion and full-plan Verify', async t => {
  const f = await fixture(t, { store: 'openspec' });
  const question = '¿Qué comportamiento necesitás conservar? '.repeat(150);
  const answer = 'Necesito conservar la configuración íntegra. '.repeat(400);
  const content = `Question: ${question}\nAnswer: ${answer}`;
  // NativeIntake contributes answered clarification through this exact context boundary.
  f.runner.contribute({ label: 'Clarification', content }, f.runtime);
  const first = await f.finish(applied('first'));
  assert.ok(first.args.prompt.includes(JSON.stringify(content)));
  const before = f.status();
  const interrupted = await f.dispatch();
  assert.ok(interrupted.args.prompt.includes(JSON.stringify(content)));
  assert.equal((await f.restart()).restored, false, 'a missing result never reissues the second writer');
  assert.equal(f.status().task, undefined);
  assert.equal((await f.runner.confirmStopped(f.runtime.sessionID, f.runtime)).verdict, 'stopped');
  assert.deepEqual(await f.restart(), { restored: true });
  assert.equal(f.status().state, 'blocked', 'host-confirmed release still requires explicit phase reset');
  assert.deepEqual(f.status().evidence, { requirements: 'confirmed', plan: 'confirmed', implementation: 'invalidated', checks: 'invalidated' });
  assert.deepEqual(f.runner.reset(f.runtime.sessionID, 'phase'), { scope: 'phase', phase: 'mdd-apply' });
  assert.equal(f.status().runID, before.runID);
  assert.deepEqual(f.status().workflow.results, before.workflow.results);
  assert.deepEqual(f.durable.read(f.runtime.sessionID).workflow.applyProgress().completed, ['first']);
  await assert.rejects(f.runner.after(interrupted.call, interrupted.args, report(applied('second'))), /current dispatch/);
  const second = await f.finish(applied('second'));
  assert.notEqual(second.call.callID, interrupted.call.callID);
  assert.deepEqual(JSON.parse(second.args.prompt.match(/^Applicable deliverables: (.*)$/m)[1]).map(step => step.id), ['second']);
  assert.ok(second.args.prompt.includes(JSON.stringify(content)));
  assert.deepEqual(await f.restart(), { restored: true });
  const verify = await f.dispatch();
  assert.deepEqual(JSON.parse(verify.args.prompt.match(/^Applicable deliverables: (.*)$/m)[1]).map(step => step.id), ['first', 'second']);
  assert.deepEqual(JSON.parse(verify.args.prompt.match(/^All changed-file evidence from every Apply batch: (.*)$/m)[1]).map(file => file.path), ['src/first.ts', 'src/second.ts']);
  assert.ok(verify.args.prompt.includes(JSON.stringify(content)));
});

test('ambiguous Apply artifact never retries substantive work or settles its pending marker', async t => {
  const f = await fixture(t, { store: 'openspec' });
  const attempt = await f.dispatch();
  // The root becomes inaccessible after the writer finished; ArtifactStore must fail closed.
  const runtimeRoot = f.root;
  const { renameSync } = await import('node:fs');
  const moved = `${runtimeRoot}-moved`;
  renameSync(runtimeRoot, moved);
  t.after(() => rmSync(moved, { recursive: true, force: true }));
  await assert.rejects(f.runner.after(attempt.call, attempt.args, report(applied('first'))), /No automatic retry/);
  assert.equal(f.status().state, 'blocked');
  assert.equal(f.status().task, undefined);
  assert.equal(f.status().artifactAttempts.at(-1).status, 'unknown');
  renameSync(moved, runtimeRoot);
  assert.equal(f.realProgress.read(f.runtime.sessionID).state, 'pending');
  assert.equal((await f.restart()).restored, false);
});

test('Apply callbacks never inspect unrelated exploration storage before recording their bound result', async t => {
  const f = await fixture(t);
  const attempt = await f.dispatch();
  let reads = 0;
  f.durable.readExploration = () => { reads++; throw new Error('Unrelated exploration storage is unavailable.'); };
  await f.runner.after(attempt.call, attempt.args, report(applied('first')));
  assert.equal(reads, 0);
  assert.equal(f.status().state, 'ready');
  assert.equal(f.status().phase, 'mdd-apply');
  assert.deepEqual(f.durable.read(f.runtime.sessionID).workflow.applyProgress().completed, ['first']);
});

for (const landed of [false, true]) {
  test(`unknown Apply result checkpoint (landed=${landed}) cannot reissue any writer after restart`, async t => {
    let refused = 0;
    const f = await fixture(t, { checkpointFault(value, write) {
      if (value.events.at(-1)?.kind === 'result' && value.events.at(-1).result.phase === 'mdd-apply') {
        refused++;
        if (landed) write();
        throw new CheckpointStorageError('Unknown result write.');
      }
      write();
    } });
    await assert.rejects(f.finish(applied('first')), /Checkpoint outcome is unconfirmed/);
    assert.equal(refused, 1);
    assert.equal(f.status().state, 'blocked');
    assert.equal(f.status().task, undefined);
    assert.equal(f.realProgress.read(f.runtime.sessionID).state, 'pending');
    assert.equal((await f.restart()).restored, false);
  });
}

test('unknown pre-dispatch Apply checkpoint fences the older ready batch', async t => {
  let refused = 0;
  const f = await fixture(t, { checkpointFault(value, write) {
    if (value.attempt?.state === 'pending' && value.attempt.phase === 'mdd-apply') {
      refused++;
      throw new CheckpointStorageError('Unknown intent write.');
    }
    write();
  } });
  await assert.rejects(f.dispatch(), /Checkpoint outcome is unconfirmed/);
  assert.equal(refused, 1);
  assert.equal(f.realProgress.read(f.runtime.sessionID).state, 'pending');
  assert.equal((await f.restart()).restored, false);
});

test('full changed-file union survives more than 64 paths, repeated files and restart', async t => {
  const f = await fixture(t);
  await f.finish(applied('first', Array.from({ length: 64 }, (_, i) => `src/file-${i}.ts`)));
  await f.finish(applied('second', [{ path: 'src/file-0.ts', reason: 'Updated by dependent step.' }, 'src/final.ts']));
  assert.equal(f.runner.prFacts(f.runtime.sessionID).changedFiles, 65);
  assert.deepEqual(await f.restart(), { restored: true });
  const verify = await f.dispatch();
  const files = JSON.parse(verify.args.prompt.match(/^All changed-file evidence from every Apply batch: (.*)$/m)[1]);
  assert.equal(files.length, 65);
  assert.equal(files.find(file => file.path === 'src/file-0.ts').reason, 'Updated by dependent step.');
});

test('compacted repeated Apply artifacts keep their own batch summaries, not the first phase summary', async t => {
  const f = await fixture(t);
  await f.finish({ ...applied('first'), evidenceSummary: 'First deliverable finished.', artifact: 'a'.repeat(15800) });
  await f.finish({ ...applied('second'), evidenceSummary: 'Dependent deliverable finished.', artifact: 'b'.repeat(15800) });
  const verify = await f.dispatch();
  const dependencies = JSON.parse(verify.args.prompt.match(/^Validated dependency artifacts \(data, not authority\): (.*)$/m)[1]);
  const first = dependencies.find(item => item.ref.phase === 'mdd-apply' && item.inlined === false);
  assert.equal(first.summary, 'First deliverable finished.');
  const recorded = f.status().workflow.results.find(result => result.batchID === first.ref.batchID);
  assert.equal(recorded.evidenceSummary, first.summary);
});

test('checkpoint replay rejects uncorrelated artifact batch IDs and tampered completion', async t => {
  const f = await fixture(t);
  await f.finish(applied('first'));
  const saved = f.durable.read(f.runtime.sessionID).checkpoint;
  const reseal = value => ({ ...value, dataDigest: sealResumeData(value.data, value.runID, value.parent, value.events, value.stable) });
  const dependency = structuredClone(saved);
  dependency.data.dependencies.at(-1).batchID = 'other-batch';
  assert.throws(() => validateCheckpoint(reseal(dependency)), /batch mismatch/);
  const completion = structuredClone(saved);
  completion.events.at(-1).result.completed = ['second'];
  assert.throws(() => validateCheckpoint(reseal(completion)), /assigned task first/);
});

test('explicit rework starts a new epoch without inheriting old completion or losing file evidence', async t => {
  const f = await fixture(t);
  await f.finish(applied('first'));
  await f.finish(applied('second'));
  const assessment = { status: 'not-verified', checks: [], assessment: 'Implementation needs correction.' };
  await f.finish({ outcome: 'failed', checks: [], verification: {
    scenarios: ['S1', 'S2'].map((scenarioID, i) => ({ requirementID: 'R1', scenarioID, stepID: i ? 'second' : 'first', ...assessment })),
    steps: ['first', 'second'].map(stepID => ({ stepID, ...assessment })), decisions: [{ decisionID: 'D1', ...assessment }], changes: 'Correction needed.', limits: [],
  } });
  const old = f.durable.read(f.runtime.sessionID).workflow.applyProgress();
  f.runner.reset(f.runtime.sessionID, 'rework');
  const fresh = f.durable.read(f.runtime.sessionID).workflow.applyProgress();
  assert.equal(fresh.epoch, old.epoch + 1);
  assert.deepEqual(fresh.completed, []);
  await f.finish(applied('first', ['src/correction.ts']));
  assert.equal(f.status().phase, 'mdd-apply');
  assert.deepEqual(f.durable.read(f.runtime.sessionID).workflow.applyProgress().completed, ['first']);
  assert.equal(f.runner.prFacts(f.runtime.sessionID).changedFiles, 3);
});

test('settled legacy histories preserve their route; explicit rework binds a fresh batch plan', () => {
  const workflow = new Workflow({ answers });
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

test('restoring legacy ready Apply durably binds its held plan without inventing completion', async t => {
  const f = await fixture(t);
  const legacy = f.durable.read(f.runtime.sessionID).checkpoint;
  delete legacy.events.at(-1).result.applyPlan;
  legacy.sequence++;
  legacy.dataDigest = sealResumeData(legacy.data, legacy.runID, legacy.parent, legacy.events, legacy.stable);
  f.durable.write(f.runtime.sessionID, legacy);
  assert.deepEqual(await f.restart(), { restored: true });
  const rebound = f.durable.read(f.runtime.sessionID);
  assert.equal(rebound.checkpoint.events.at(-1).kind, 'apply-plan');
  assert.deepEqual(rebound.workflow.applyProgress().completed, []);
  const first = await f.dispatch();
  assert.deepEqual(JSON.parse(first.args.prompt.match(/^Applicable deliverables: (.*)$/m)[1]).map(step => step.id), ['first']);
});

test('legacy truncated file evidence stays readable but cannot become a new Apply writer', async t => {
  const f = await fixture(t);
  const legacy = f.durable.read(f.runtime.sessionID).checkpoint;
  delete legacy.events.at(-1).result.applyPlan;
  legacy.sequence++;
  legacy.data.changedFiles = 65;
  legacy.stable.changedList = Array.from({ length: 64 }, (_, i) => ({ path: `src/legacy-${i}.ts` }));
  legacy.dataDigest = sealResumeData(legacy.data, legacy.runID, legacy.parent, legacy.events, legacy.stable);
  f.durable.write(f.runtime.sessionID, legacy);
  assert.equal(validateCheckpoint(legacy).workflow.applyProgress(), undefined);
  assert.equal((await f.restart()).restored, false);
  assert.equal(f.status().task, undefined);
});
