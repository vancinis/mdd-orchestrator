import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { WorkerFence } from '../dist/worker-fence.js';
import { defaultSettings } from '../dist/settings.js';
import { createInspector } from '../dist/opencode-plugin.js';

const digest = text => createHash('sha256').update(text).digest('hex');
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-adaptive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'own.txt'), 'before');
  writeFileSync(join(root, 'other.txt'), 'outside');
  const runtime = { sessionID: 'adaptive-parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const scope = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
  const contract = {
    contractVersion: 1, objective: 'Replace the bounded text.',
    acceptance: { goal: 'Replace the text', requirements: [{ id: 'R1', description: 'Bounded replacement',
      scenarios: [{ id: 'S1', given: 'Original text', when: 'Replaced', then: 'Updated text' }] }] },
    exclusions: ['Do not change other files'], decisions: [], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'The single source and its dependencies were inspected.',
      fingerprints: [{ path: 'own.txt', digest: digest('before') }] },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', description: 'Replace the text', path: 'own.txt', scenarios: ['S1'], decisions: [],
      dependsOn: [], scope, obligations: { source: [{ id: 'E1', description: 'Read back the replacement', paths: ['own.txt'] }], checks: [] } }],
  };
  const progress = new ProgressGuard(root), ownership = new RunOwnershipStore(root), checkpoint = new CheckpointStore(root);
  const inspections = [];
  const inspect = { parent: async () => {}, intake: async (_runtime, text, messageID) => {
    inspections.push({ text, messageID });
    if (text !== 'Replace the bounded text.' || messageID !== 'native-message') throw new Error('No exact native objective proof.');
    return 'genuine-user';
  }, result: async (_runtime, _call, _actor, output) => output, stopped: async () => true, ...overrides };
  const options = { progress, ownership, checkpoint,
    workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true } };
  const runner = new PhaseRunner(inspect, options);
  const settings = defaultSettings(); settings.profiles.default.answers.mode = 'automatic';
  const intake = new NativeIntake(runner, inspect, settings);
  const admit = () => intake.admitAdaptiveInternal({ contract }, runtime, 'native-message');
  const select = (actor = 'mdd-apply', extra = {}) => runner.selectAdaptiveInternal({
    handle: runner.status(runtime.sessionID).selection.handle, actor, assignmentID: 'A1',
    purpose: 'Perform only the next necessary bounded work.', ...extra,
  }, runtime);
  const call = { sessionID: runtime.sessionID, callID: 'adaptive-call' };
  const report = (extra = {}) => JSON.stringify({ outcome: 'passed', evidenceSummary: 'Assigned work settled.',
    artifact: 'The assigned source was inspected.', completed: ['A1'], changes: ['own.txt'], checks: [], ...extra });
  return { root, runtime, contract, runner, intake, inspect, options, progress, ownership, checkpoint, inspections, settings, admit, select, call, report };
}

function nativeHistory(f, verdict) {
  const parent = { id: f.runtime.sessionID, directory: f.root, projectID: 'project', agent: 'mdd-orchestrator' };
  const child = { id: 'bound-native-child', parentID: parent.id, directory: f.root, projectID: 'project', agent: 'general' };
  const current = { info: { id: 'native-message', sessionID: parent.id, role: 'assistant', agent: parent.agent,
    path: { cwd: f.root, root: f.root } }, parts: [] };
  const history = [{ info: { id: 'genuine-user', sessionID: parent.id, role: 'user' },
    parts: [{ type: 'text', text: f.contract.objective, sessionID: parent.id, messageID: 'genuine-user' }] }, current];
  const terminal = { info: { id: 'child-message', sessionID: child.id, role: 'assistant', time: { completed: 1 }, finish: 'stop' }, parts: [] };
  const input = { directory: f.root, worktree: f.root, project: { id: 'project' }, client: { session: {
    get: async ({ path }) => ({ data: path.id === child.id ? child : parent }),
    messages: async ({ path }) => ({ data: path.id === child.id ? [terminal] : history }),
    status: async () => ({ data: { [child.id]: { type: verdict === 'running' ? 'busy' : verdict === 'stopped' ? 'idle' : 'unknown' } } }),
    abort: async () => ({ data: true }), // Request acknowledgment does not establish termination.
  } } };
  return { inspector: createInspector(input), dispatch(args) {
    current.parts.push({ type: 'tool', tool: 'task', sessionID: parent.id, messageID: current.info.id, callID: f.call.callID,
      state: { status: 'running', input: args, metadata: { sessionId: child.id } } });
  }, stopped() { verdict = 'stopped'; current.parts[0].state.status = 'error'; } };
}

async function selectedDependency(t) {
  const f = fixture(t);
  writeFileSync(join(f.root, 'support.txt'), 'eligibility source'); writeFileSync(join(f.root, 'later.txt'), 'unrelated source');
  f.contract.scope = { complete: true, reads: ['own.txt', 'other.txt', 'support.txt', 'later.txt'], writes: ['own.txt', 'other.txt', 'later.txt'] };
  f.contract.assignments[0].scope = { complete: true, reads: ['own.txt', 'support.txt'], writes: ['own.txt'] };
  for (const [id, path, dependsOn] of [['A2', 'other.txt', ['A1']], ['A3', 'later.txt', []]])
    f.contract.assignments.push({ id, description: 'Bounded follow-up', path, scenarios: ['S1'], decisions: [], dependsOn,
      scope: { complete: true, reads: [path], writes: [path] }, obligations: { source: [{ id: `E-${id}`, description: 'Read back the target', paths: [path] }], checks: [] } });
  f.contract.context.fingerprints = f.contract.scope.reads.map(path => ({ path, digest: digest(readFileSync(join(f.root, path))) }));
  await f.admit(); await f.select(); const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  const fence = new WorkerFence(f.root, 'project');
  fence.admit(f.runtime.sessionID, 'native-message', f.call.callID, f.runner.workerAssignment(f.call), () => !!f.runner.workerAssignment(f.call));
  fence.progress({ sessionID: f.runtime.sessionID, assistantMessageID: 'native-message', id: f.call.callID,
    metadata: { status: 'running', sessionID: 'prerequisite-child' } });
  await fence.edit({ id: 'prerequisite-child', parentID: f.runtime.sessionID, projectID: 'project', location: { directory: f.root } },
    { operations: [{ kind: 'replace', path: 'own.txt', expected: 'before', content: 'after' }] });
  await f.runner.after(f.call, args, f.report());
  const context = { ...f.contract.context, fingerprints: f.contract.scope.reads.map(path => ({ path, digest: digest(readFileSync(join(f.root, path))) })) };
  await f.select('mdd-apply', { assignmentID: 'A2', context });
  return { ...f, nextCall: { ...f.call, callID: 'dependent-call' }, task: f.runner.status(f.runtime.sessionID).task };
}

test('AL-02: Apply-only uses an exact native handle and returns actorless selection, never Plan or Verify', async t => {
  const f = fixture(t); const admitted = await f.admit();
  assert.equal(admitted.state, 'await-selection');
  for (const key of ['phase', 'workflow', 'resultFormat', 'task']) assert.equal(admitted[key], undefined);
  await f.select(); const ready = f.runner.status(f.runtime.sessionID);
  const args = await f.runner.before(f.call, ready.task);
  assert.match(args.prompt, /mdd_worker_edit/);
  assert.equal(f.progress.read(f.runtime.sessionID).resumable, false);
  assert.equal(f.checkpoint.read(f.runtime.sessionID), undefined);
  assert.equal(f.runner.workerAssignment(f.call).phase, 'mdd-apply');
  await f.runner.after(f.call, args, f.report());
  const settled = f.runner.status(f.runtime.sessionID);
  assert.equal(settled.state, 'await-selection'); assert.equal(settled.task, undefined);
  assert.deepEqual(settled.selection.completed, ['A1']);
  assert.equal(settled.lastReceipt.actor, 'mdd-apply'); assert.equal(settled.lastReceipt.outcome, 'passed');
  for (const key of ['phase', 'workflow', 'resultFormat', 'visual']) assert.equal(settled[key], undefined);
});

test('AL-02: Explore resolves technical context before Apply without a Plan receipt', async t => {
  const f = fixture(t); f.contract.context.technical = 'uncertain';
  await f.admit(); await assert.rejects(f.select(), /technical/);
  await f.select('mdd-explore');
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.after(f.call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Source understood.', artifact: 'own.txt has no indirect readers.' }));
  assert.equal(f.runner.status(f.runtime.sessionID).lastReceipt.actor, 'mdd-explore');
  await f.select('mdd-apply', { context: f.contract.context = { ...f.contract.context, technical: 'understood' } });
  const applyCall = { ...f.call, callID: 'apply-after-explore' };
  await f.runner.after(applyCall, await f.runner.before(applyCall, f.runner.status(f.runtime.sessionID).task), f.report());
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, ['A1']);
});

for (const change of [
  contract => { contract.contractVersion = 2; },
  contract => { contract.acceptance.requirements[0].scenarios[0].id = 'R1'; },
  contract => { contract.assignments.push(structuredClone(contract.assignments[0])); },
  contract => { contract.assessment.assessmentVersion = 2; },
  contract => { contract.context.technical = ['uncertain']; },
  contract => { contract.context.dependencies = ['bounded']; },
  contract => { contract.assignments[0].scope.writes = ['other.txt']; },
  contract => { contract.assignments[0].dependsOn = ['missing']; },
  contract => { contract.context.fingerprints[0].digest = digest('stale'); },
]) test(`AL-02: invalid contract ${change.toString()} creates no authority`, async t => {
  const f = fixture(t); change(f.contract);
  await assert.rejects(f.admit());
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'not-started');
  assert.equal(f.ownership.parent(f.runtime.sessionID), undefined);
});

test('AL-02: native proof rejects invented text, supplied approval and provenance IDs', async t => {
  const f = fixture(t); f.contract.objective = 'Invented objective';
  await assert.rejects(f.admit(), /native objective/);
  await assert.rejects(f.intake.admitAdaptiveInternal({ contract: f.contract, approved: true, userMessageID: 'genuine-user' }, f.runtime, 'native-message'), /unknown/);
  await assert.rejects(f.runner.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime), /native objective/);
});

test('AL-02: admission and selection snapshot caller-owned objects across native inspection', async t => {
  const f = fixture(t); let release;
  f.inspect.intake = async () => { await new Promise(resolve => { release = resolve; }); return 'genuine-user'; };
  const pending = f.runner.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime);
  while (!release) await Promise.resolve();
  f.contract.assignments[0].scope.writes.push('other.txt'); release(); await pending;
  await f.select(); const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  assert.deepEqual(f.runner.workerAssignment(f.call).scope.writes, ['own.txt']);
  assert.ok(!args.prompt.includes('other.txt'));
});

test('AL-02: product ambiguity pauses all actors; tiny high-impact work cannot Apply', async t => {
  const f = fixture(t); f.contract.productQuestions = ['Which behavior should replace the text?'];
  await f.admit(); await assert.rejects(f.select('mdd-explore'), /product/);
  assert.equal(f.runner.status(f.runtime.sessionID).selection.blocked, 'product-ambiguity');
  const g = fixture(t); g.runtime.sessionID = 'high-impact'; g.contract.assessment.impact = 'high';
  await g.admit(); await assert.rejects(g.select(), /impact/);
});

test('AL-02: stale context, unknown dependencies and premature prerequisites refuse Apply', async t => {
  const f = fixture(t); await f.admit(); writeFileSync(join(f.root, 'own.txt'), 'drift');
  await assert.rejects(f.select(), /fingerprint|stale/);
  const g = fixture(t); g.contract.context.dependencies = 'unknown'; await g.admit(); await assert.rejects(g.select(), /dependencies/);
  const h = fixture(t); const second = structuredClone(h.contract.assignments[0]); second.id = 'A2'; second.dependsOn = ['A1']; second.obligations.source[0].id = 'E2';
  h.contract.assignments.push(second); await h.admit(); await assert.rejects(h.select('mdd-apply', { assignmentID: 'A2' }), /prerequisites|dependencies/);
});

test('AL-02: raced selection/admission and replayed dispatch handles cannot create another writer', async t => {
  const f = fixture(t); const admissions = await Promise.allSettled([f.admit(), f.admit()]);
  assert.equal(admissions.filter(item => item.status === 'fulfilled').length, 1);
  const handle = f.runner.status(f.runtime.sessionID).selection.handle;
  const choices = await Promise.allSettled([f.select(), f.select()]);
  assert.equal(choices.filter(item => item.status === 'fulfilled').length, 1);
  const task = f.runner.status(f.runtime.sessionID).task;
  const args = await f.runner.before(f.call, task);
  await assert.rejects(f.runner.before({ ...f.call, callID: 'concurrent' }, task), /in flight|ready/);
  await f.runner.after(f.call, args, f.report({ outcome: 'failed', completed: [] }));
  await assert.rejects(f.select('mdd-apply', { handle }), /handle/);
  await assert.rejects(f.runner.before({ ...f.call, callID: 'replay' }, task), /ready|selection/);
  await assert.rejects(f.runner.after(f.call, args, f.report()), /dispatch/);
  await assert.rejects(f.select(), /repair/);
  await f.select('mdd-apply', { repairOf: f.runner.status(f.runtime.sessionID).lastReceipt.id });
  await assert.rejects(f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task), /consumed/);
});

test('AL-02: failed/malformed receipts return selection without progress or automatic writer retries', async t => {
  for (const output of ['unparseable receipt', JSON.stringify({ outcome: 'passed', evidenceSummary: 'Invalid broadening', artifact: 'Wrong', acceptance: {} }),
    JSON.stringify({ outcome: 'passed', evidenceSummary: 'Wrong completion', artifact: 'Wrong', completed: ['A2'], changes: ['own.txt'], checks: [] }),
    JSON.stringify({ outcome: 'passed', evidenceSummary: 'Invented checks', artifact: 'Wrong', completed: ['A1'], changes: ['own.txt'], checks: [{ id: 'X', command: 'npm test', exit: 0 }] })]) {
    const f = fixture(t); await f.admit(); await f.select();
    await f.runner.after(f.call, await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task), output);
    const status = f.runner.status(f.runtime.sessionID);
    assert.equal(status.state, 'await-selection'); assert.equal(status.lastReceipt.outcome, 'failed');
    assert.deepEqual(status.selection.completed, []); assert.equal(status.task, undefined);
  }
});

test('AL-02: report receipt cannot release a child with unknown termination', async t => {
  const f = fixture(t, { stopped: async () => false }); await f.admit(); await f.select();
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await assert.rejects(f.runner.after(f.call, args, f.report()), /termination|stopped/);
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  assert.equal(f.progress.read(f.runtime.sessionID).state, 'pending');
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, []);
  await assert.rejects(f.select(), /selection|in flight/);
});

test('AL-02: real native scoped edit succeeds; generic editor, shell and broadened writes remain fenced', async t => {
  const f = fixture(t); await f.admit(); await f.select(); await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  const fence = new WorkerFence(f.root, 'project');
  fence.admit(f.runtime.sessionID, 'native-message', f.call.callID, f.runner.workerAssignment(f.call), () => !!f.runner.workerAssignment(f.call));
  fence.progress({ sessionID: f.runtime.sessionID, assistantMessageID: 'native-message', id: f.call.callID, metadata: { status: 'running', sessionID: 'apply-child' } });
  const child = { id: 'apply-child', parentID: f.runtime.sessionID, projectID: 'project', location: { directory: f.root } };
  for (const tool of ['edit', 'shell']) await assert.rejects(fence.guard(child, tool, {}, f.runner.scopedWorkers(f.runtime.sessionID)));
  await assert.rejects(fence.edit(child, { operations: [{ kind: 'replace', path: 'other.txt', expected: 'outside', content: 'bad' }] }), /writes/);
  await fence.edit(child, { operations: [{ kind: 'replace', path: 'own.txt', expected: 'before', content: 'after' }] });
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), 'after');
  assert.equal(readFileSync(join(f.root, 'other.txt'), 'utf8'), 'outside');
});

test('AL-02: no synthetic capability or unsafe config footprint gets an unfenced serial fallback', async t => {
  const f = fixture(t); f.options.workerCapability = { confined: true };
  await assert.rejects(f.admit(), /capability|scoped/);
  const g = fixture(t); writeFileSync(join(g.root, 'package.json'), '{}');
  g.contract.scope.writes = ['package.json']; g.contract.assignments[0].path = 'package.json';
  g.contract.assignments[0].obligations.source[0].paths = ['package.json'];
  g.contract.context.fingerprints.push({ path: 'package.json', digest: digest('{}') });
  await assert.rejects(g.admit(), /scope|runtime|instruction/);
});

test('AL-02: restart preserves pending non-resumable child protection but never replays the contract', async t => {
  const f = fixture(t); await f.admit(); await f.select(); await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  const cold = new PhaseRunner(f.inspect, f.options);
  assert.equal((await cold.restore(f.runtime)).restored, false);
  assert.equal(cold.status(f.runtime.sessionID).state, 'recovery-blocked');
  assert.equal(cold.scopedWorkers(f.runtime.sessionID), true, 'lost adaptive authority must still quarantine the old native child');
  const fence = new WorkerFence(f.root, 'project', 1);
  const child = { id: 'lost-child', parentID: f.runtime.sessionID, projectID: 'project', location: { directory: f.root } };
  await assert.rejects(fence.guard(child, 'edit', {}, cold.scopedWorkers(f.runtime.sessionID)), /binding/);
  await assert.rejects(cold.admitAdaptiveInternal({ contract: f.contract, messageID: 'native-message' }, f.runtime), /pending|previous|occup|unfinished/);
  await cold.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await cold.confirmStopped(f.runtime.sessionID, f.runtime, false, resetID)).verdict, 'stopped');
    cold.reset(f.runtime.sessionID, 'run');
  }, true);
  assert.equal(cold.status(f.runtime.sessionID).state, 'not-started');
  assert.equal(f.checkpoint.read(f.runtime.sessionID), undefined);
  await assert.rejects(fence.guard(child, 'shell', {}, cold.scopedWorkers(f.runtime.sessionID)), /binding/);
});

test('AL-02: a stopped native transport failure records honest failure and requires selected repair', async t => {
  const f = fixture(t); await f.admit(); await f.select();
  await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.nativeError(f.runtime.sessionID, 'unrelated');
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  await f.runner.nativeError(f.runtime.sessionID, f.call.callID);
  const status = f.runner.status(f.runtime.sessionID);
  assert.equal(status.state, 'await-selection'); assert.equal(status.lastReceipt.outcome, 'failed');
  assert.deepEqual(status.selection.completed, []); assert.equal(status.task, undefined);
  await assert.rejects(f.select(), /repair/);
});

test('AL-02: post-selection drift and lost ownership never admit a writer', async t => {
  const f = fixture(t); await f.admit(); await f.select();
  const task = f.runner.status(f.runtime.sessionID).task;
  writeFileSync(join(f.root, 'own.txt'), 'changed after selection');
  await assert.rejects(f.runner.before(f.call, task), /stale/);
  assert.equal(f.progress.read(f.runtime.sessionID), undefined);
  assert.equal(f.runner.status(f.runtime.sessionID).lastReceipt, undefined, 'no actor actually ran');
  const g = fixture(t); await g.admit(); await g.select();
  const owner = g.runner.owner(g.runtime.sessionID);
  g.ownership.reserve(owner.runID, g.runtime.sessionID, 'other-process', owner.epoch);
  await assert.rejects(g.runner.before(g.call, g.runner.status(g.runtime.sessionID).task), /ownership/);
});

test('AL-02: Risk uses independent future assessment and retains real command obligations without execution claims', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = [{ id: 'C1', command: 'npm test', requirement: 'required' }];
  await f.admit(); await f.select('mdd-risk');
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  assert.match(args.prompt, /assessmentVersion/); assert.match(args.prompt, /NOT a historical Risk verdict/);
  assert.match(args.prompt, /"command":"npm test","requirement":"required"/);
  await f.runner.after(f.call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Impact exceeds low.', artifact: 'External readers were found.',
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'high' } }));
  assert.equal(f.runner.status(f.runtime.sessionID).lastReceipt.outcome, 'passed');
  await assert.rejects(f.select(), /impact/);
});

test('AL-02: genuine multiline objective text is preserved exactly through both native proof checks', async t => {
  const f = fixture(t); const objective = '  Replace the bounded text.\nPreserve the surrounding content.  ';
  f.contract.objective = objective;
  f.inspect.intake = async (_runtime, text, messageID) => {
    assert.equal(text, objective); assert.equal(messageID, 'native-message'); f.inspections.push(text); return 'genuine-user';
  };
  await f.admit(); await f.select();
  assert.equal(f.inspections.length, 2);
  const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  assert.equal(JSON.parse(args.prompt.split('Contract-authored links (no Plan actor is implied): ')[1].split('\n')[0]).objective, objective);
});

test('AL-02: interactive and unspecified native profiles cannot admit a valid internal contract', async t => {
  for (const mode of ['interactive', undefined]) {
    const f = fixture(t); const settings = defaultSettings();
    if (mode) settings.profiles.default.answers.mode = mode;
    const intake = new NativeIntake(f.runner, f.inspect, settings);
    await assert.rejects(intake.admitAdaptiveInternal({ contract: f.contract }, f.runtime, 'native-message'), /automatic|interactive/);
    assert.equal(f.inspections.length, 0); assert.equal(f.ownership.parent(f.runtime.sessionID), undefined);
  }
});

test('AL-02: uncertain native termination retains the writer through errors and explicit probes', async t => {
  const f = fixture(t, { stopped: async () => false }); await f.admit(); await f.select();
  await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await f.runner.nativeError(f.runtime.sessionID, f.call.callID);
  assert.equal((await f.runner.probe(f.runtime.sessionID)).verdict, 'unknown');
  assert.equal((await f.runner.confirmStopped(f.runtime.sessionID, f.runtime, true)).verdict, 'unknown');
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  f.inspect.stopped = async () => true;
  assert.equal((await f.runner.confirmStopped(f.runtime.sessionID, f.runtime)).verdict, 'stopped');
  const status = f.runner.status(f.runtime.sessionID);
  assert.equal(status.state, 'await-selection'); assert.equal(status.lastReceipt.outcome, 'failed');
  assert.equal(status.task, undefined); assert.deepEqual(status.selection.completed, []);
});

test('AL-02: optional Plan and Verify are fenced source readers, not fabricated planning or completion', async t => {
  const f = fixture(t); await f.admit();
  for (const actor of ['mdd-plan', 'mdd-verify']) {
    await f.select(actor); const call = { ...f.call, callID: actor };
    const args = await f.runner.before(call, f.runner.status(f.runtime.sessionID).task);
    const assigned = f.runner.workerAssignment(call);
    assert.equal(assigned.phase, 'mdd-explore'); assert.equal(assigned.scope, undefined);
    assert.deepEqual(assigned.reads, [{ root: f.root, files: ['own.txt'] }]);
    await f.runner.after(call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Only source findings.', artifact: 'own.txt was inspected.' }));
    const status = f.runner.status(f.runtime.sessionID);
    assert.equal(status.lastReceipt.actor, actor); assert.equal(status.state, 'await-selection');
    assert.equal(status.workflow, undefined); assert.deepEqual(status.selection.completed, []);
  }
});

test('AL-02: duplicate evidence IDs and credential read footprints are refused without authority', async t => {
  const f = fixture(t); f.contract.assignments[0].obligations.checks = [{ id: 'E1', command: 'npm test', requirement: 'required' }];
  await assert.rejects(f.admit(), /more than once/);
  const g = fixture(t); writeFileSync(join(g.root, 'credentials.txt'), 'private');
  g.contract.scope.reads.push('credentials.txt'); g.contract.context.fingerprints.push({ path: 'credentials.txt', digest: digest('private') });
  await assert.rejects(g.admit(), /Credential/);
  assert.equal(g.ownership.parent(g.runtime.sessionID), undefined);
});

test('AL-02: positive running liveness outranks a receipt and a synthetic stopped flag', async t => {
  const f = fixture(t, { liveness: async () => ({ verdict: 'running', detail: 'The bound child is busy.' }) });
  await f.admit(); await f.select(); const args = await f.runner.before(f.call, f.runner.status(f.runtime.sessionID).task);
  await assert.rejects(f.runner.after(f.call, args, f.report()), /termination/);
  assert.equal(f.runner.status(f.runtime.sessionID).state, 'await-result');
  assert.equal(f.progress.read(f.runtime.sessionID).state, 'pending');
  assert.equal(f.runner.owner(f.runtime.sessionID).state, 'reserved');
});

for (const verdict of ['unknown', 'running']) test(`AL-02 correction P1: cold ${verdict} native termination cannot be released by attestation`, async t => {
  const f = fixture(t), native = nativeHistory(f, verdict);
  const runner = new PhaseRunner(native.inspector, f.options), intake = new NativeIntake(runner, native.inspector, f.settings);
  await intake.admitAdaptiveInternal({ contract: f.contract }, f.runtime, 'native-message');
  await runner.selectAdaptiveInternal({ handle: runner.status(f.runtime.sessionID).selection.handle,
    actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Bounded native work.' }, f.runtime);
  native.dispatch(await runner.before(f.call, runner.status(f.runtime.sessionID).task));
  const marker = f.progress.read(f.runtime.sessionID), owner = f.ownership.read(marker.runID);
  const cold = new PhaseRunner(native.inspector, f.options);
  assert.equal(await native.inspector.stopped(f.runtime, f.call), false);
  await cold.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await cold.confirmStopped(f.runtime.sessionID, f.runtime, true, resetID)).verdict, verdict);
  }, true);
  assert.deepEqual(f.ownership.read(marker.runID), owner, 'attestation must not release or rewrite the reserved native owner');
  assert.deepEqual(f.progress.read(f.runtime.sessionID), marker, 'unknown/running termination must preserve the exact pending marker');
  assert.equal(cold.scopedWorkers(f.runtime.sessionID), true);
  assert.equal(cold.status(f.runtime.sessionID).state, 'recovery-blocked');
  assert.equal(cold.workerAssignment(f.call), undefined, 'a cold marker is quarantine, never editing authority');
  native.stopped();
  assert.equal(await native.inspector.stopped(f.runtime, f.call), true);
  await cold.withReset(f.runtime.sessionID, async resetID => {
    assert.equal((await cold.confirmStopped(f.runtime.sessionID, f.runtime, false, resetID)).verdict, 'stopped');
  }, true);
  assert.equal(f.ownership.read(marker.runID).state, 'idle');
  assert.deepEqual(f.progress.read(f.runtime.sessionID), { ...marker, state: 'settled' });
  assert.equal(cold.scopedWorkers(f.runtime.sessionID), false);
  assert.equal(f.checkpoint.read(f.runtime.sessionID), undefined);
});

for (const path of ['own.txt', 'support.txt']) for (const timing of ['before-hook', 'during-inspection'])
  test(`AL-02 correction P2: dependent admission rejects ${path} drift ${timing}`, async t => {
    const f = await selectedDependency(t);
    const marker = f.progress.read(f.runtime.sessionID), owner = f.runner.owner(f.runtime.sessionID);
    let published = false;
    const drift = () => writeFileSync(join(f.root, path), 'changed after dependent selection');
    if (timing === 'before-hook') drift();
    else f.inspect.parent = async (_runtime, callID) => { if (callID === f.nextCall.callID) drift(); };
    await assert.rejects(f.runner.before(f.nextCall, f.task, () => { published = true; }), /prerequisite.*stale|fingerprint.*stale/);
    assert.equal(published, false, 'no native child arguments may be published');
    assert.equal(f.runner.workerAssignment(f.nextCall), undefined);
    assert.equal(f.runner.nativePending(f.runtime.sessionID), false);
    const after = f.ownership.read(owner.runID);
    assert.equal(after.state, 'idle'); assert.equal(after.callID, undefined);
    if (timing === 'before-hook') assert.deepEqual(after, owner, 'preexisting drift must be refused before reserving');
    assert.deepEqual(f.progress.read(f.runtime.sessionID), marker, 'the settled prerequisite marker must not become a dependent intent');
    const status = f.runner.status(f.runtime.sessionID);
    assert.equal(status.state, 'await-selection'); assert.equal(status.task, undefined);
    assert.equal(status.lastReceipt.actor, 'mdd-apply'); assert.equal(status.lastReceipt.assignmentID, 'A1');
    assert.deepEqual(status.selection.completed, ['A1']);
  });

test('AL-02 correction P2: unrelated future assignment drift does not invalidate the selected dependency', async t => {
  const f = await selectedDependency(t); writeFileSync(join(f.root, 'later.txt'), 'unrelated newer source');
  const args = await f.runner.before(f.nextCall, f.task);
  assert.equal(f.runner.workerAssignment(f.nextCall).taskID, 'A2');
  await f.runner.after(f.nextCall, args, f.report({ completed: ['A2'], changes: ['other.txt'] }));
  assert.deepEqual(f.runner.status(f.runtime.sessionID).selection.completed, ['A1', 'A2']);
});
