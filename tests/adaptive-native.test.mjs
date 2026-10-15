import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { defaultSettings } from '../dist/settings.js';
import { createInspector } from '../dist/opencode-plugin.js';
import { validateQuestionRecord } from '../dist/question-checkpoint.js';

function fixture(t, mode) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-native-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'own.txt'), 'before');
  const runtime = { sessionID: 'parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const scope = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
  const contract = { contractVersion: 1, objective: 'Replace bounded text.',
    acceptance: { goal: 'Replace text', requirements: [{ id: 'R1', description: 'Replacement', scenarios: [{ id: 'S1', given: 'Original', when: 'Replaced', then: 'Updated' }] }] },
    exclusions: [], decisions: [], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'Inspected local source.', fingerprints: [{ path: 'own.txt', digest: createHash('sha256').update('before').digest('hex') }] },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', path: 'own.txt', description: 'Replace text', scenarios: ['S1'], decisions: [], dependsOn: [], scope, obligations: { source: [{ id: 'E1', description: 'Read source', paths: ['own.txt'] }], checks: [] } }] };
  const store = new AdaptiveStore(root), questions = new QuestionCheckpointStore(root), ownership = new RunOwnershipStore(root);
  const inspected = [];
  const inspect = { parent: async () => {}, intake: async (_runtime, text) => {
    assert.equal(text, contract.objective); return 'native-user';
  }, question: async (here, call, args) => {
    assert.equal(here.sessionID, call.sessionID); inspected.push({ call: { ...call }, args: structuredClone(args) });
  }, result: async (_runtime, _call, _actor, output) => output, stopped: async () => true,
    liveness: async () => ({ verdict: 'stopped', detail: 'Local native harness.' }) };
  const options = { adaptiveStore: store, ownership, progress: new ProgressGuard(root), workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true } };
  const settings = defaultSettings(); if (mode) settings.profiles.default.answers.mode = mode;
  const runner = new PhaseRunner(inspect, options);
  const makeGate = (r = runner) => new NativeIntake(r, inspect, settings, { questions, ownership });
  const gate = makeGate();
  const admit = () => gate.adaptiveInternal({ kind: 'entry', args: { contract, messageID: 'native-message' } }, runtime);
  let ordinal = 0;
  const answer = async (labels, g = gate, change = {}) => {
    const args = g.status('parent').question, call = { sessionID: 'parent', callID: `question-${++ordinal}`, ...change };
    await g.beforeQuestion(call, args);
    await g.afterQuestion(call, args, output(args, labels));
    return call;
  };
  const operation = () => ({ kind: 'select', args: { handle: runner.status('parent').selection.handle, actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Perform bounded replacement.' } });
  return { root, runtime, contract, store, questions, ownership, settings, runner, gate, inspect, inspected, options, makeGate, admit, answer, operation };
}
function output(args, answers) {
  return { title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`,
    output: `User has answered your questions: ${args.questions.map((q, i) => `"${q.question}"="${answers[i].length ? answers[i].join(', ') : 'Unanswered'}"`).join(', ')}. You can now continue with the user's answers in mind.`,
    metadata: { answers, truncated: false } };
}

const wire = (kind, args = {}) => JSON.stringify({ routingVersion: 3, kind, args });

test('integration: adaptive native admission retains a configured local backend through cold restore', async t => {
  const f = fixture(t, 'automatic');
  f.settings.profiles.default.answers.artifactStore = 'local';
  const gate = f.makeGate();
  await gate.adaptiveInternal(wire('entry', { contract: f.contract, messageID: 'native-message' }), f.runtime);
  assert.equal(f.store.read('parent').nativePolicy.configured.artifactStore, 'local');
  assert.equal(f.store.read('parent').nativePolicy.answers.artifactStore, 'local');
  const cold = new PhaseRunner(f.inspect, f.options);
  assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.equal(f.store.read('parent').nativePolicy.answers.artifactStore, 'local');
});

test('integration: adaptive actor receives the exact runtime workspace binding', async t => {
  const f = fixture(t, 'automatic');
  await f.admit();
  await f.gate.adaptiveInternal(f.operation(), f.runtime);
  const sent = await f.runner.before({ sessionID: 'parent', callID: 'workspace-child' }, f.runner.status('parent').task);
  const bindings = [...sent.prompt.matchAll(/^Workspace binding \(runtime data\): (.*)$/gm)];
  assert.equal(bindings.length, 1);
  assert.deepEqual(JSON.parse(bindings[0][1]), { directory: f.runtime.directory, worktree: f.runtime.worktree });
  assert.match(sent.prompt, /Installation paths, predecessor artifacts and coordinator context cannot override this binding/);
  assert.match(sent.prompt, /not a grant of scope, permission or approval/);
});

test('AL05b: real native protocol admits, selects and retains actual native dispatch', async t => {
  const f = fixture(t, 'automatic');
  const status = await f.gate.adaptiveInternal(wire('entry', { contract: f.contract, messageID: 'native-message' }), f.runtime);
  assert.equal(status.routingVersion, 3);
  assert.equal(status.registration, 'inactive');
  assert.equal(status.route, 'low');
  assert.equal(status.mode, 'automatic');
  assert.equal(status.handle, f.runner.status('parent').selection.handle);
  assert.deepEqual(status.operations.find(op => op.kind === 'select').required, ['handle', 'actor', 'assignmentID', 'purpose']);
  assert.deepEqual(status.operations.find(op => op.kind === 'select').ids.assignmentID, ['A1']);
  const selected = await f.gate.adaptiveInternal(wire('select', f.operation().args), f.runtime);
  assert.deepEqual(selected.task, f.runner.status('parent').task);
  const call = { sessionID: 'parent', callID: 'protocol-child' };
  const sent = await f.runner.before(call, selected.task);
  await f.runner.after(call, sent, JSON.stringify({ outcome: 'failed', evidenceSummary: 'Stopped without edits.', artifact: 'No source changes.', completed: [], changes: [], checks: [], noChangeReason: 'Stopped.' }));
  const idle = await f.gate.adaptiveInternal(wire('status'), f.runtime);
  assert.equal(idle.state, 'await-selection');
  assert.equal(idle.lastReceipt.callID, 'protocol-child');
});

test('AL05b: malformed operation-specific wire input has no native questions or durable writes', async t => {
  const f = fixture(t, 'interactive');
  for (const request of [wire('entry', { contract: f.contract, messageID: 'native-message', approved: true }),
    wire('entry', { contract: f.contract, messageID: 42 }), wire('select', { handle: 'x', actor: 'mdd-apply' }),
    wire('recover', { agent: 'mdd-orchestrator' }), wire('status', { sessionID: 'parent' }), '{', ' '.repeat(160001)]) {
    await assert.rejects(f.gate.adaptiveInternal(request, f.runtime));
    assert.equal(f.questions.read('parent'), undefined);
    assert.equal(f.store.read('parent'), undefined);
  }
  await assert.rejects(f.gate.adaptiveInternal(wire('status'), { ...f.runtime, agent: 'general' }), /coordinator/);
});

test('AL05b: large native approval is complete through guarded paged detail and actual hooks', async t => {
  const f = fixture(t, 'interactive');
  f.contract.objective = 'Bounded objective '.repeat(600);
  const status = await f.gate.adaptiveInternal(wire('entry', { contract: f.contract, messageID: 'native-message' }), f.runtime);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 46000);
  const args = status.question ?? await readDetail(f, status.questionRef);
  assert.deepEqual(args, f.gate.status('parent').question);
  const before = f.questions.read('parent');
  await f.gate.adaptiveInternal(wire('status'), f.runtime);
  assert.deepEqual(f.questions.read('parent'), before, 'status cannot answer or consume consent');
  await f.gate.beforeQuestion({ sessionID: 'parent', callID: 'wire-approval' }, args);
  await f.gate.afterQuestion({ sessionID: 'parent', callID: 'wire-approval' }, args, output(args, [['Approve operation']]));
  assert.equal(f.store.read('parent').nativePolicy.questions[0].callID, 'wire-approval');
});

async function readDetail(f, ref, runtime = f.runtime) {
  let text = '', cursor = ref.args.cursor;
  while (cursor) {
    const page = await f.gate.adaptiveInternal(wire('detail', { cursor }), runtime);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 46000);
    text += page.text; cursor = page.nextCursor;
  }
  return JSON.parse(text);
}

test('AL05b: canonical held journal detail rejects cross-parent, forged and stale cursors without writes', async t => {
  const f = fixture(t, 'automatic'); await f.admit();
  const status = await f.gate.adaptiveInternal(wire('status'), f.runtime);
  const before = f.store.read('parent');
  const held = await readDetail(f, status.details.journal);
  assert.deepEqual(held, before);
  await assert.rejects(readDetail(f, status.details.journal, { ...f.runtime, sessionID: 'foreign' }), /cursor|parent/);
  await assert.rejects(f.gate.adaptiveInternal(wire('detail', { cursor: 'forged:0' }), f.runtime), /cursor/);
  await assert.rejects(f.gate.adaptiveInternal(wire('detail', { cursor: status.details.journal.args.cursor.replace(/:0$/, ':1') }), f.runtime), /cursor/);
  assert.deepEqual(f.store.read('parent'), before);
  await f.gate.adaptiveInternal(f.operation(), f.runtime);
  await assert.rejects(readDetail(f, status.details.journal), /stale|cursor/);
});

test('AL05b: readback guards native awaits and workspace without changing authority', async t => {
  const f = fixture(t, 'automatic'); await f.admit();
  await assert.rejects(f.gate.adaptiveInternal(wire('status'), { ...f.runtime, directory: f.root + '-other' }), /workspace/);
  const parent = f.inspect.parent;
  f.inspect.parent = async () => { f.inspect.parent = parent; await f.gate.adaptiveInternal(f.operation(), f.runtime); };
  await assert.rejects(f.gate.adaptiveInternal(wire('status'), f.runtime), /changed|stale/);
  f.inspect.parent = parent;
});

test('AL05b: escalation projection uses actual medium depth, never historical low relabeling', async t => {
  const f = fixture(t, 'automatic'); await f.admit();
  const status = await f.gate.adaptiveInternal(wire('escalate', { handle: f.operation().args.handle, depth: 'medium',
    rationale: 'Structured remaining plan.', assessment: { assessmentVersion: 1, complexity: 'medium', impact: 'low' }, context: f.contract.context }), f.runtime);
  assert.equal(status.route, 'medium');
  assert.equal(status.continuation.next, 'mdd-plan');
  assert.deepEqual(status.operations.find(op => op.kind === 'select').ids.actor, ['mdd-plan']);
});

test('AL05a: configured interactive entry asks exact operation approval before admission', async t => {
  const f = fixture(t, 'interactive'); const result = await f.admit();
  assert.equal(result.state, 'question-ready'); assert.equal(f.store.read('parent'), undefined);
  assert.equal(result.question.questions.length, 1);
  await f.answer([['Approve operation']]);
  assert.equal(f.runner.status('parent').state, 'await-selection');
  assert.equal(f.store.read('parent').nativePolicy.answers.mode, 'interactive');
  assert.equal(f.inspected.length, 2);
});

test('AL05a: automatic profile persists only configured preferences without invented consent', async t => {
  const f = fixture(t, 'automatic'); await f.admit();
  assert.deepEqual(f.store.read('parent').nativePolicy.answers, { mode: 'automatic' });
  assert.deepEqual(f.store.read('parent').nativePolicy.questions, []);
  assert.equal(f.gate.status('parent').question, undefined);
});

test('AL05a: unset mode asks only existing mode question and never infers automatic', async t => {
  const f = fixture(t); const result = await f.admit();
  assert.equal(result.state, 'question-ready'); assert.equal(result.question.questions.length, 1);
  assert.equal(result.question.questions[0].header, 'Modo');
  assert.deepEqual(result.question.questions[0].options.map(q => q.label), ['Interactivo', 'Automático']);
  assert.equal(f.store.read('parent'), undefined);
  await f.answer([['Automático']]);
  assert.equal(f.store.read('parent').nativePolicy.answers.mode, 'automatic');
  assert.equal(f.store.read('parent').nativePolicy.questions[0].callID, 'question-1');
});

test('AL05a: interactive selection uses inspected native call/result once and binds the complete operation', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  const operation = f.operation();
  await assert.rejects(f.runner.selectAdaptiveInternal(operation.args, f.runtime), /native operation authority/);
  const status = await f.gate.adaptiveInternal(operation, f.runtime);
  assert.match(status.question.questions[0].question, /Perform bounded replacement/);
  assert.deepEqual(f.questions.read('parent').adaptive.operation, operation);
  await assert.rejects(f.gate.adaptiveInternal({ ...operation, approved: true }, f.runtime), /unknown/);
  const args = status.question, call = { sessionID: 'parent', callID: 'actual-selection-answer' };
  await f.gate.beforeQuestion(call, args);
  await assert.rejects(f.gate.afterQuestion({ ...call, callID: 'forged' }, args, output(args, [['Approve operation']])));
  assert.equal(f.questions.read('parent').state, 'pending');
  await assert.rejects(f.gate.afterQuestion({ ...call, sessionID: 'foreign' }, args, output(args, [['Approve operation']])), /another parent/);
  await f.gate.afterQuestion(call, args, output(args, [['Approve operation']]));
  assert.equal(f.runner.status('parent').state, 'authorized-actor');
  const saved = f.store.read('parent');
  assert.equal(saved.nativePolicy.questions.at(-1).callID, call.callID);
  assert.deepEqual(saved.nativePolicy.questions.at(-1).answer, [['Approve operation']]);
  await assert.rejects(f.gate.afterQuestion(call, args, output(args, [['Approve operation']])));
  await assert.rejects(f.runner.executeAdaptiveNativeInternal({ approved: true }, f.runtime), /single-use/);
  const taskCall = { sessionID: 'parent', callID: 'actual-child' };
  const sent = await f.runner.before(taskCall, f.runner.status('parent').task);
  await f.runner.after(taskCall, sent, JSON.stringify({ outcome: 'failed', evidenceSummary: 'No edits.', artifact: 'The child stopped without changes.', completed: [], changes: [], noChangeReason: 'Stopped.', checks: [] }));
  await assert.rejects(f.runner.selectAdaptiveInternal(f.operation().args, f.runtime), /native operation authority/);
});

for (const label of ['Pause', 'Decline', 'Please do something else']) test(`AL05a: ${label} never authorizes an interactive operation`, async t => {
  const f = fixture(t, 'interactive'); await f.admit();
  await f.answer([[label]]);
  assert.equal(f.gate.status('parent').state, 'blocked');
  assert.equal(f.store.read('parent'), undefined);
});

test('AL05a: malformed result and forged question leave no admission', async t => {
  const f = fixture(t, 'interactive'); const status = await f.admit(), args = status.question;
  const changed = structuredClone(args); changed.questions[0].options.pop();
  await assert.rejects(f.gate.beforeQuestion({ sessionID: 'parent', callID: 'forged' }, changed), /envelope/);
  const call = { sessionID: 'parent', callID: 'actual' }; await f.gate.beforeQuestion(call, args);
  const result = output(args, [['Approve operation']]); result.output = 'Caller claims user approved';
  await assert.rejects(f.gate.afterQuestion(call, args, result), /output/);
  assert.equal(f.store.read('parent'), undefined);
});

test('AL05a: generation drift rejects reply without consuming another parent question', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  const status = await f.gate.adaptiveInternal(f.operation(), f.runtime), args = status.question;
  const call = { sessionID: 'parent', callID: 'before-restore' }; await f.gate.beforeQuestion(call, args);
  const cold = new PhaseRunner(f.inspect, f.options); await cold.restore(f.runtime);
  await assert.rejects(f.gate.afterQuestion(call, args, output(args, [['Approve operation']])), /generation/);
  assert.equal(f.questions.read('parent').state, 'pending');
  assert.equal(cold.status('parent').task, undefined);
});

for (const phase of ['prepared', 'pending']) test(`AL05a: restart ${phase} question stays blocked and never becomes old live consent`, async t => {
  const f = fixture(t, 'interactive'); const status = await f.admit();
  const call = { sessionID: 'parent', callID: 'interrupted' };
  if (phase === 'pending') await f.gate.beforeQuestion(call, status.question);
  const gate = f.makeGate(new PhaseRunner(f.inspect, f.options));
  assert.equal(gate.status('parent').state, 'blocked');
  await assert.rejects(gate.afterQuestion(call, status.question, output(status.question, [['Approve operation']])), /Interrupted/);
  await assert.rejects(gate.adaptiveInternal({ kind: 'entry', args: { contract: f.contract, messageID: 'native-message' } }, f.runtime), /unresolved/);
  assert.equal(f.store.read('parent'), undefined);
});

test('AL05a: existing native intake cannot overlap asynchronous adaptive objective inspection', async t => {
  const f = fixture(t, 'automatic'); let release;
  const held = new Promise(resolve => { release = resolve; });
  const inspect = f.inspect.intake; let first = true;
  f.inspect.intake = async (...args) => { if (first) { first = false; await held; } return inspect(...args); };
  const admitting = f.admit();
  try { await assert.rejects(f.gate.start({ requirements: f.contract.objective }, f.runtime, 'native-message'), /native policy|adaptive/); }
  finally { release(); await admitting.catch(() => {}); }
});

test('AL05a: configured policy survives settings changes and cold restore without reusing approval', async t => {
  const f = fixture(t, 'interactive'); f.settings.profiles.default.answers.summary = 'low';
  await f.admit(); await f.answer([['Approve operation']]);
  f.settings.profiles.default.answers.mode = 'automatic';
  const proposed = f.operation();
  const cold = new PhaseRunner(f.inspect, f.options); assert.equal((await cold.restore(f.runtime)).restored, true);
  const gate = f.makeGate(cold), op = { ...proposed, args: { ...proposed.args, handle: cold.status('parent').selection.handle } };
  const status = await gate.adaptiveInternal(op, f.runtime);
  assert.equal(status.state, 'question-ready');
  assert.deepEqual(f.store.read('parent').nativePolicy.answers, { mode: 'interactive' });
  assert.equal(f.store.read('parent').nativePolicy.questions.length, 1);
});

test('AL05a: actual closed product answers rebuild only a bounded pre-admission draft', async t => {
  const f = fixture(t, 'automatic'); f.contract.productQuestions = ['Which format?'];
  const questions = [{ question: 'Which format?', why: 'Choose before admission.', options: [
    { label: 'Keep format', description: 'Retain the original format.', recommended: true },
    { label: 'Compact format', description: 'Compact the bounded replacement.' }] }];
  const status = await f.gate.adaptiveInternal({ kind: 'entry', args: { contract: f.contract, messageID: 'native-message', questions } }, f.runtime);
  assert.deepEqual(status.question.questions[0].options, questions[0].options.map(({ label, description }) => ({ label, description })));
  await f.answer([['Keep format']]); assert.equal(f.gate.status('parent').state, 'await-contract');
  assert.equal(f.store.read('parent'), undefined);
  const revised = structuredClone(f.contract); revised.productQuestions = []; revised.acceptance.goal = 'Expanded business purpose';
  await assert.rejects(f.gate.adaptiveInternal({ kind: 'entry', args: { contract: revised, messageID: 'native-message' } }, f.runtime), /business authorization/);
  // A rejected revision must not discard the original bound draft or its actual native answer.
  revised.acceptance = f.contract.acceptance;
  await f.gate.adaptiveInternal({ kind: 'entry', args: { contract: revised, messageID: 'native-message' } }, f.runtime);
  assert.deepEqual(f.store.read('parent').data.contract.acceptance, f.contract.acceptance);
  assert.equal(f.store.read('parent').nativePolicy.questions.at(-1).answer[0][0], 'Keep format');
  const selection = f.operation(); selection.args.actor = 'mdd-explore'; await f.gate.adaptiveInternal(selection, f.runtime);
  const call = { sessionID: 'parent', callID: 'clarified-source-reader' }, sent = await f.runner.before(call, f.runner.status('parent').task);
  assert.match(sent.prompt, /Keep format/);
  await f.runner.after(call, sent, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Read the clarified bounded request.', artifact: 'Inspected source without changing business scope.' }));
});

test('AL05a: actual actor question answers are linked durably without changing held business scope', async t => {
  const f = fixture(t, 'automatic'); await f.admit();
  const operation = f.operation(); operation.args.actor = 'mdd-explore'; await f.gate.adaptiveInternal(operation, f.runtime);
  const call = { sessionID: 'parent', callID: 'source-question-child' }, sent = await f.runner.before(call, f.runner.status('parent').task);
  const questions = [{ question: 'Keep the bounded format?', why: 'A user decision is needed.', options: [{ label: 'Keep', description: 'Keep the original bounded format.' }, { label: 'Stop', description: 'Do not continue.' }] }];
  await f.runner.after(call, sent, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Found a decision.', artifact: 'Source investigation only.', questions }));
  await assert.rejects(f.gate.adaptiveInternal(f.operation(), f.runtime), /question/);
  const pending = f.runner.status('parent').productQuestions;
  const ask = { kind: 'questions', args: { receiptID: pending.receiptID, callID: pending.callID } };
  const status = await f.gate.adaptiveInternal(ask, f.runtime);
  assert.deepEqual(status.question.questions[0].options, questions[0].options);
  await f.answer([['Keep']]);
  const saved = f.store.read('parent');
  assert.equal(saved.data.questionAnswers[0].native.callID, 'question-1');
  assert.equal(saved.data.questionAnswers[0].receiptID, pending.receiptID);
  assert.deepEqual(saved.data.contract, f.contract);
  const cold = new PhaseRunner(f.inspect, f.options); assert.equal((await cold.restore(f.runtime)).restored, true);
  assert.equal(cold.status('parent').productQuestions, undefined);
});

test('AL05a: an open policy question excludes an already selected native actor', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  await f.gate.adaptiveInternal(f.operation(), f.runtime); await f.answer([['Approve operation']]);
  const task = f.runner.status('parent').task;
  await assert.rejects(f.gate.adaptiveInternal({ kind: 'prepare', args: { handle: 'obsolete' } }, f.runtime), /actorless/);
  assert.equal(f.gate.status('parent').question, undefined);
  assert.equal(f.questions.read('parent').state, 'settled');
  assert.ok(task);
});

for (const boundary of ['pending', 'answered', 'settled']) test(`AL05a: failed ${boundary} publication never bootstraps an approved run`, async t => {
  const f = fixture(t, 'interactive'); const status = await f.admit(), call = { sessionID: 'parent', callID: 'faulted-question' };
  const write = f.questions.write.bind(f.questions);
  t.mock.method(f.questions, 'write', (parent, record) => { if (record.state === boundary) throw new Error('Injected question publication failure.'); write(parent, record); });
  if (boundary === 'pending') await assert.rejects(f.gate.beforeQuestion(call, status.question), /publication/);
  else {
    await f.gate.beforeQuestion(call, status.question);
    await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Approve operation']])), /publication/);
  }
  assert.equal(f.store.read('parent'), undefined);
  const gate = f.makeGate(new PhaseRunner(f.inspect, f.options));
  assert.equal(gate.status('parent').state, 'blocked');
});

test('AL05a: interrupted approved bootstrap restores policy but never restores the old operation approval', async t => {
  const f = fixture(t, 'interactive'); await f.admit();
  const claim = f.ownership.claim.bind(f.ownership); let fail = true;
  t.mock.method(f.ownership, 'claim', (...args) => { if (fail) { fail = false; throw new Error('Injected bootstrap interruption.'); } return claim(...args); });
  await assert.rejects(f.answer([['Approve operation']]), /bootstrap/);
  assert.equal(f.store.read('parent').stage, 'bootstrap');
  assert.equal(f.store.read('parent').nativePolicy.answers.mode, 'interactive');
  const cold = new PhaseRunner(f.inspect, f.options); assert.equal((await cold.restore(f.runtime)).restored, true);
  const gate = f.makeGate(cold);
  const status = await gate.adaptiveInternal({ kind: 'select', args: { handle: cold.status('parent').selection.handle, actor: 'mdd-explore', assignmentID: 'A1', purpose: 'Read remaining source.' } }, f.runtime);
  assert.equal(status.state, 'question-ready'); assert.equal(cold.status('parent').task, undefined);
});

for (const alteration of ['epoch', 'workspace', 'scope', 'purpose']) test(`AL05a: ${alteration} cannot rebind an issued native approval`, async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  const operation = f.operation(), status = await f.gate.adaptiveInternal(operation, f.runtime);
  const call = { sessionID: 'parent', callID: 'bound-exactly' }; await f.gate.beforeQuestion(call, status.question);
  if (alteration === 'epoch') {
    const owner = f.runner.owner('parent'); f.ownership.reserve(owner.runID, 'parent', 'other-operation', owner.epoch);
  } else {
    const record = f.questions.read('parent');
    const changed = structuredClone(record);
    if (alteration === 'workspace') changed.adaptive.directory += '-foreign';
    if (alteration === 'scope') changed.adaptive.operation.args.scope = { writes: ['outside.txt'] };
    if (alteration === 'purpose') changed.adaptive.operation.args.purpose = 'Perform an expanded operation.';
    changed.sequence++;
    assert.throws(() => f.questions.write('parent', changed), /durability/);
    // CAS refusal must leave the exact original question pending.
    assert.deepEqual(f.questions.read('parent'), record);
    return;
  }
  await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Approve operation']])), /generation/);
  assert.equal(f.questions.read('parent').state, 'pending');
});

test('AL05a: explicit adaptive question version never weakens fixed phase binding', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); const record = f.questions.read('parent');
  assert.equal(record.version, 2); assert.equal(record.checkpoint, undefined); assert.equal(record.slot.phase, undefined);
  assert.throws(() => validateQuestionRecord({ ...record, version: 1 }));
  assert.throws(() => validateQuestionRecord({ ...record, slot: { ...record.slot, kind: 'approval' } }));
  assert.throws(() => validateQuestionRecord({ ...record, checkpoint: { sequence: 0, digest: 'a'.repeat(64) } }));
  assert.throws(() => validateQuestionRecord({ ...record, slot: { ...record.slot, phase: 'mdd-plan' } }));
});

for (const field of ['result', 'operation binding']) test(`AL05a: settled native ${field} cannot be rewritten by a later journal update`, async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  const settled = f.questions.read('parent'), changed = structuredClone(settled); changed.sequence++;
  if (field === 'result') changed.nativeReceipt.answers = [['Pause']];
  else changed.adaptive.operation.args.contract.acceptance.goal = 'Changed business authorization';
  assert.throws(() => f.questions.write('parent', changed), /durability/);
  assert.deepEqual(f.questions.read('parent'), settled);
});

for (const change of ['legitimate', 'foreign input']) test(`AL05a: real native inspector requires the actual running question call (${change})`, async t => {
  const f = fixture(t, 'interactive');
  const parent = { id: 'parent', directory: f.root, projectID: 'project', agent: 'mdd-orchestrator' };
  const current = { info: { id: 'native-message', sessionID: 'parent', role: 'assistant', agent: 'mdd-orchestrator', path: { cwd: f.root, root: f.root } }, parts: [] };
  const history = [{ info: { id: 'native-user', sessionID: 'parent', role: 'user' }, parts: [{ type: 'text', text: f.contract.objective, sessionID: 'parent', messageID: 'native-user' }] }, current];
  const inspector = createInspector({ directory: f.root, worktree: f.root, project: { id: 'project' }, client: { session: {
    get: async () => ({ data: parent }), messages: async () => ({ data: history }),
  } } });
  f.inspect.intake = inspector.intake; f.inspect.parent = inspector.parent; f.inspect.question = inspector.question;
  const status = await f.admit(), call = { sessionID: 'parent', callID: 'actual-native-question' };
  current.parts.push({ type: 'tool', tool: 'question', sessionID: 'parent', messageID: current.info.id, callID: call.callID,
    state: { status: 'running', input: change === 'legitimate' ? status.question : { questions: [] } } });
  if (change !== 'legitimate') {
    await assert.rejects(f.gate.beforeQuestion(call, status.question), /native question history/);
    assert.equal(f.store.read('parent'), undefined); return;
  }
  await f.gate.beforeQuestion(call, status.question);
  await f.gate.afterQuestion(call, status.question, output(status.question, [['Approve operation']]));
  assert.equal(f.store.read('parent').nativePolicy.questions[0].callID, call.callID);
});

test('AL05a: transferred policy retains frozen interactive preferences and needs fresh operation approval', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
  f.inspect.intake = async (here, text, _messageID, scope) => {
    assert.deepEqual(here, target); assert.equal(scope, 'latest'); assert.match(text, /^Transfer sourceSessionID=parent/); return 'target-native-user';
  };
  f.inspect.adaptiveTransferIdle = async () => {}; f.inspect.confirmAdaptiveTransfer = async () => {};
  const result = await f.gate.adaptiveInternal({ kind: 'transfer', args: { sourceSessionID: 'parent', runID: source.runID, operationID: 'native-hop', messageID: 'target-message' } }, target);
  assert.equal(result.state, 'question-ready');
  const call = { sessionID: 'target', callID: 'target-transfer-question' };
  await f.gate.beforeQuestion(call, result.question);
  await f.gate.afterQuestion(call, result.question, output(result.question, [['Approve operation']]));
  const saved = f.store.read('target');
  assert.equal(saved.nativePolicy.answers.mode, 'interactive');
  assert.equal(saved.nativePolicy.questions.at(-1).callID, call.callID);
  assert.equal(saved.admissionDigest, source.admissionDigest);
  const status = await f.gate.adaptiveInternal({ kind: 'select', args: { handle: f.runner.status('target').selection.handle, actor: 'mdd-explore', assignmentID: 'A1', purpose: 'Read transferred scope.' } }, target);
  assert.equal(status.state, 'question-ready'); assert.equal(f.runner.status('target').task, undefined);
});

async function proposedTransfer(t) {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  const target = { ...f.runtime, sessionID: 'target' }, source = f.store.read('parent');
  f.inspect.intake = async () => 'target-native-user';
  f.inspect.adaptiveTransferIdle = async () => {}; f.inspect.confirmAdaptiveTransfer = async () => {};
  const operation = { kind: 'transfer', args: { sourceSessionID: 'parent', runID: source.runID, operationID: 'policy-hop', messageID: 'target-message' } };
  const status = await f.gate.adaptiveInternal(operation, target);
  return { ...f, target, source, transferOperation: operation, question: status.question };
}

test('AL05a transfer fence: target approval excludes a source-side policy proposal before the answer', async t => {
  const f = await proposedTransfer(t), other = f.makeGate(new PhaseRunner(f.inspect, f.options));
  await assert.rejects(other.adaptiveInternal(f.operation(), f.runtime), /policy.*question|question.*fence/i);
  assert.equal(f.questions.read('parent').state, 'settled');
  assert.equal(f.questions.read('target').state, 'prepared');
});

for (const label of ['Pause', 'Decline']) test(`AL05a transfer fence: ${label} retains the receipt and releases only its own source fence`, async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: `native-${label}` };
  await f.gate.beforeQuestion(call, f.question);
  await f.gate.afterQuestion(call, f.question, output(f.question, [[label]]));
  assert.equal(f.ownership.read(f.source.runID).policyQuestion, undefined);
  assert.deepEqual(f.questions.read('target').nativeReceipt.answers, [[label]]);
  assert.equal(f.store.read('target'), undefined);
  const status = await f.gate.adaptiveInternal(f.transferOperation, f.target);
  assert.equal(status.state, 'question-ready');
  assert.notDeepEqual(status.question, f.question);
});

test('AL05a transfer fence: source byte drift invalidates the displayed proposal rather than obtaining fresh consent', async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: 'drifted-native-answer' };
  await f.gate.beforeQuestion(call, f.question);
  writeFileSync(join(f.root, 'own.txt'), 'external source drift');
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Approve operation']])), /generation|source.*changed|drift/i);
  assert.equal(f.store.read('target'), undefined);
  assert.equal(f.questions.read('target').state, 'pending');
});

test('AL05a transfer fence: changed source operation during asynchronous native proof cannot use the consumed answer', async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: 'proof-race-answer' };
  await f.gate.beforeQuestion(call, f.question);
  f.inspect.adaptiveTransferIdle = async (_here, role) => {
    if (role === 'target') writeFileSync(join(f.root, 'own.txt'), 'raced during proof');
  };
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Approve operation']])), /source|generation|drift/i);
  assert.equal(f.store.read('target'), undefined);
  assert.deepEqual(f.questions.read('target').nativeReceipt.answers, [['Approve operation']]);
});

for (const action of ['finish', 'abort']) test(`AL05a transfer fence: interrupted claim requires a fresh native ${action} decision`, async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: 'interrupted-transfer-answer' };
  const begin = f.ownership.beginAdaptiveTransfer.bind(f.ownership); let fail = true;
  t.mock.method(f.ownership, 'beginAdaptiveTransfer', (...args) => { if (fail) { fail = false; throw new Error('Injected claimed-transfer interruption.'); } return begin(...args); });
  await f.gate.beforeQuestion(call, f.question);
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Approve operation']])), /interruption/);
  const recovery = { kind: 'transfer-recovery', args: { ...f.transferOperation.args, action, messageID: 'fresh-recovery-message' } };
  const status = await f.gate.adaptiveInternal(recovery, f.target);
  assert.equal(status.state, 'question-ready');
  const fresh = { sessionID: 'target', callID: `fresh-native-${action}` };
  await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Approve operation']])));
  await f.gate.beforeQuestion(fresh, status.question);
  await f.gate.afterQuestion(fresh, status.question, output(status.question, [['Approve operation']]));
  assert.equal(f.ownership.read(f.source.runID).policyQuestion, undefined);
  assert.equal(f.ownership.read(f.source.runID).ownerSessionID, action === 'finish' ? 'target' : 'parent');
  assert.equal(f.questions.read('target').nativeReceipt.callID, fresh.callID);
});

for (const occupancy of ['fixed question', 'native intake']) test(`AL05a transfer fence: ${occupancy} is protected before a target policy question is prepared`, async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  const target = { ...f.runtime, sessionID: 'target' }, source = f.store.read('parent');
  let fixed;
  if (occupancy === 'fixed question') {
    fixed = { version: 1, parent: 'target', sequence: 0, requirements: 'Fixed native request', known: {}, state: 'prepared',
      slot: { kind: 'preflight', args: { questions: [{ header: 'Mode', question: 'Choose mode', multiple: false, options: [{ label: 'Automatic', description: 'Continue automatically.' }] }] } }, clarifications: [], deferred: [], clarificationAnswers: [] };
    f.questions.write('target', fixed);
    fixed = { ...fixed, sequence: 1, state: 'pending', callID: 'fixed-native-question' }; f.questions.write('target', fixed);
    fixed = { ...fixed, sequence: 2, state: 'answered', answer: [['Automatic']] }; f.questions.write('target', fixed);
    const { answer, ...rest } = fixed; fixed = { ...rest, sequence: 3, state: 'settled' }; f.questions.write('target', fixed);
  } else f.ownership.claimIntake('target', 'existing-native-intake', 'existing-user');
  f.inspect.adaptiveTransferIdle = async () => {}; f.inspect.confirmAdaptiveTransfer = async () => {};
  await assert.rejects(f.gate.adaptiveInternal({ kind: 'transfer', args: { sourceSessionID: 'parent', runID: source.runID, operationID: 'protected-target', messageID: 'target-message' } }, target), /occupied|fixed/i);
  assert.deepEqual(f.questions.read('target'), fixed);
  assert.equal(f.ownership.read(source.runID).policyQuestion, undefined);
});

test('AL05a transfer fence: a selected source actor prevents even preparing a target approval', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Approve operation']]);
  await f.gate.adaptiveInternal(f.operation(), f.runtime); await f.answer([['Approve operation']]);
  f.inspect.adaptiveTransferIdle = async () => {}; f.inspect.confirmAdaptiveTransfer = async () => {};
  await assert.rejects(f.gate.adaptiveInternal({ kind: 'transfer', args: { sourceSessionID: 'parent', runID: f.store.read('parent').runID, operationID: 'selected-source', messageID: 'target-message' } }, { ...f.runtime, sessionID: 'target' }), /actorless/);
  assert.equal(f.questions.read('target'), undefined);
});

test('AL05a transfer fence: an unclaimed failed proposal releases only on a fresh native abort decision and idle proof', async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: 'unclaimed-transfer-answer' };
  f.inspect.adaptiveTransferIdle = async (_here, role) => { if (role === 'target') writeFileSync(join(f.root, 'own.txt'), 'external drift'); };
  await f.gate.beforeQuestion(call, f.question);
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Approve operation']])), /source.*changed/i);
  assert.equal(f.ownership.parentClaim('target'), undefined);
  f.inspect.adaptiveTransferIdle = async () => {};
  const recovery = { kind: 'transfer-recovery', args: { ...f.transferOperation.args, action: 'abort', messageID: 'explicit-abort-message' } };
  const status = await f.gate.adaptiveInternal(recovery, f.target);
  const fresh = { sessionID: 'target', callID: 'explicit-unclaimed-abort' };
  await f.gate.beforeQuestion(fresh, status.question);
  await f.gate.afterQuestion(fresh, status.question, output(status.question, [['Approve operation']]));
  const owner = f.ownership.read(f.source.runID);
  assert.equal(owner.state, 'idle'); assert.equal(owner.policyQuestion, undefined); assert.equal(owner.epoch, 1);
  assert.equal(f.store.read('target'), undefined);
  assert.equal(f.questions.read('target').nativeReceipt.callID, fresh.callID);
});

for (const mode of ['Automático', 'Interactivo']) test(`AL05a transfer fence: legacy data with unset mode uses the actual ${mode} policy answer without invented consent`, async t => {
  const f = fixture(t, 'automatic'); await f.gate.admitAdaptiveInternal({ contract: f.contract }, f.runtime, 'native-message');
  f.settings.profiles.default.answers = {};
  const gate = f.makeGate(), target = { ...f.runtime, sessionID: 'target' }, source = f.store.read('parent');
  f.inspect.intake = async () => 'target-native-user'; f.inspect.adaptiveTransferIdle = async () => {}; f.inspect.confirmAdaptiveTransfer = async () => {};
  const status = await gate.adaptiveInternal({ kind: 'transfer', args: { sourceSessionID: 'parent', runID: source.runID, operationID: 'legacy-mode-hop', messageID: 'target-message' } }, target);
  assert.equal(status.question.questions.length, 1); assert.equal(status.question.questions[0].header, 'Modo');
  assert.equal(f.ownership.read(source.runID).policyQuestion.parent, 'target');
  const call = { sessionID: 'target', callID: 'actual-transfer-mode' };
  await gate.beforeQuestion(call, status.question); await gate.afterQuestion(call, status.question, output(status.question, [[mode]]));
  if (mode === 'Interactivo') {
    assert.equal(f.store.read('target'), undefined);
    const approval = gate.status('target').question, approve = { sessionID: 'target', callID: 'actual-transfer-approval' };
    assert.equal(approval.questions[0].header, 'Operation approval');
    await gate.beforeQuestion(approve, approval); await gate.afterQuestion(approve, approval, output(approval, [['Approve operation']]));
  }
  const policy = f.store.read('target').nativePolicy;
  assert.equal(policy.answers.mode, mode === 'Automático' ? 'automatic' : 'interactive');
  assert.equal(policy.questions[0].adaptive.purpose, 'mode');
  assert.equal(policy.questions.length, mode === 'Automático' ? 1 : 2);
});

function inspectedTransfer(f) {
  const target = { ...f.runtime, sessionID: 'target' };
  const parent = id => ({ id, directory: f.root, projectID: 'project', agent: 'mdd-orchestrator' });
  const assistant = (id, sessionID) => ({ info: { id, sessionID, role: 'assistant', agent: 'mdd-orchestrator', path: { cwd: f.root, root: f.root } }, parts: [] });
  const user = (id, sessionID, text) => ({ info: { id, sessionID, role: 'user' }, parts: [{ type: 'text', text, sessionID, messageID: id }] });
  const histories = new Map([['parent', [user('native-user', 'parent', f.contract.objective), assistant('native-message', 'parent')]]]);
  const sessions = new Map([['parent', parent('parent')], ['target', parent('target')]]);
  const statuses = { parent: { type: 'idle' }, target: { type: 'idle' } };
  const inspector = createInspector({ directory: f.root, worktree: f.root, project: { id: 'project' }, client: { session: {
    get: async ({ path }) => ({ data: sessions.get(path.id) }), messages: async ({ path }) => ({ data: histories.get(path.id) }),
    status: async () => ({ data: statuses }),
  } } });
  f.inspect.parent = inspector.parent; f.inspect.intake = inspector.intake; f.inspect.adaptiveTransferIdle = inspector.adaptiveTransferIdle;
  f.inspect.confirmAdaptiveTransfer = async () => {}; // Store-injected runtime; SDK admission/idle inspection is real, not live-host proof.
  const operation = () => {
    const source = f.store.read('parent');
    const request = `Transfer sourceSessionID=parent runID=${source.runID} admissionDigest=${source.admissionDigest}. Continue the unchanged objective, acceptance, scope, exclusions and decisions: ${JSON.stringify(source.data.contract.objective)}`;
    histories.set('target', [user('target-native-user', 'target', request), assistant('target-message', 'target')]);
    return { kind: 'transfer', args: { sourceSessionID: 'parent', runID: source.runID, operationID: 'current-proof-hop', messageID: 'target-message' } };
  };
  return { target, inspector, operation, histories, sessions, statuses };
}

for (const boundary of ['target-idle', 'after-claim', 'after-fence']) test(`AL05a P1: automatic zero-question current proof rejects source drift at ${boundary}`, async t => {
  const f = fixture(t, 'automatic'), native = inspectedTransfer(f); await f.admit();
  assert.deepEqual(f.store.read('parent').nativePolicy.questions, []);
  const source = f.store.read('parent'), operation = native.operation(), changed = `preserved source drift at ${boundary}`;
  if (boundary === 'target-idle') f.inspect.adaptiveTransferIdle = async (here, role) => {
    await native.inspector.adaptiveTransferIdle(here, role);
    if (role === 'target') writeFileSync(join(f.root, 'own.txt'), changed);
  };
  else {
    const method = boundary === 'after-claim' ? 'claimAdaptiveTarget' : 'beginAdaptiveTransfer', original = f.ownership[method].bind(f.ownership);
    t.mock.method(f.ownership, method, (...args) => { const result = original(...args); writeFileSync(join(f.root, 'own.txt'), changed); return result; });
  }
  await assert.rejects(f.gate.adaptiveInternal(operation, native.target), /source.*changed|generation/i);
  assert.equal(f.store.read('target'), undefined);
  assert.equal(f.ownership.read(source.runID).ownerSessionID, 'parent');
  if (boundary === 'target-idle') assert.equal(f.ownership.parentClaim('target'), undefined);
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), changed);
  assert.deepEqual(f.store.read('parent').nativePolicy.questions, [], 'automatic mode must not manufacture a human approval');
});

test('AL05a P1: an irrelevant historical question generation does not replace the current automatic proof', async t => {
  const f = fixture(t, 'automatic'), native = inspectedTransfer(f); await f.admit();
  const explore = f.operation(); explore.args.actor = 'mdd-explore'; await f.gate.adaptiveInternal(explore, f.runtime);
  const call = { sessionID: 'parent', callID: 'historical-question-child' }, sent = await f.runner.before(call, f.runner.status('parent').task);
  await f.runner.after(call, sent, JSON.stringify({ outcome: 'passed', evidenceSummary: 'A bounded decision is needed.', artifact: 'Inspected the declared source.',
    questions: [{ question: 'Preserve format?', why: 'Choose within held business scope.', options: [{ label: 'Keep', description: 'Keep the held format.' }] }] }));
  const pending = f.runner.status('parent').productQuestions;
  await f.gate.adaptiveInternal({ kind: 'questions', args: { receiptID: pending.receiptID, callID: pending.callID } }, f.runtime); await f.answer([['Keep']]);
  const historical = f.store.read('parent').nativePolicy.questions.at(-1).adaptive.generation;
  await f.gate.adaptiveInternal(f.operation(), f.runtime);
  const apply = { sessionID: 'parent', callID: 'current-authorized-apply' }, args = await f.runner.before(apply, f.runner.status('parent').task);
  writeFileSync(join(f.root, 'own.txt'), 'after authorized Apply');
  await f.runner.after(apply, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Performed the held replacement.', artifact: 'Updated only the declared source.', completed: ['A1'], changes: ['own.txt'], checks: [] }));
  assert.notDeepEqual(historical.sources, f.runner.adaptiveNativeGenerationInternal('parent').sources);
  const result = await f.gate.adaptiveInternal(native.operation(), native.target);
  assert.equal(result.state, 'await-selection'); assert.deepEqual(result.selection.completed, ['A1']);
  assert.equal(f.store.read('target').nativePolicy.questions.length, 1, 'historical product context is not fresh operation consent');
});

for (const change of ['generation', 'epoch', 'unknown-child', 'busy-child']) test(`AL05a P1 control: current automatic transfer still fences ${change}`, async t => {
  const f = fixture(t, 'automatic'), native = inspectedTransfer(f); await f.admit();
  const source = f.store.read('parent'), operation = native.operation();
  if (change.endsWith('child')) {
    native.sessions.set('child', { id: 'child', parentID: 'parent', directory: f.root, projectID: 'project', agent: 'general' });
    native.statuses.child = { type: change === 'busy-child' ? 'busy' : 'unknown' };
    native.histories.get('parent').at(-1).parts.push({ type: 'tool', tool: 'task', sessionID: 'parent', messageID: 'native-message', callID: 'other-native-child',
      state: { status: 'completed', input: {}, metadata: { sessionId: 'child' } } });
  } else f.inspect.adaptiveTransferIdle = async (here, role) => {
    await native.inspector.adaptiveTransferIdle(here, role);
    if (role !== 'target') return;
    if (change === 'generation') assert.equal((await new PhaseRunner(f.inspect, f.options).restore(f.runtime)).restored, true);
    else f.ownership.reserve(source.runID, 'parent', 'competing-owner', f.ownership.read(source.runID).epoch);
  };
  await assert.rejects(f.gate.adaptiveInternal(operation, native.target), /source|generation|unknown|running/i);
  assert.equal(f.store.read('target'), undefined); assert.equal(f.ownership.parentClaim('target'), undefined);
  assert.equal(f.ownership.read(source.runID).ownerSessionID, 'parent');
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), 'before');
});

test('AL05a P1 control: current interactive approval still rejects drift after native target idle inspection', async t => {
  const f = fixture(t, 'interactive'), native = inspectedTransfer(f); await f.admit(); await f.answer([['Approve operation']]);
  const source = f.store.read('parent'), status = await f.gate.adaptiveInternal(native.operation(), native.target);
  const call = { sessionID: 'target', callID: 'current-interactive-transfer' };
  await f.gate.beforeQuestion(call, status.question);
  f.inspect.adaptiveTransferIdle = async (here, role) => {
    await native.inspector.adaptiveTransferIdle(here, role);
    if (role === 'target') writeFileSync(join(f.root, 'own.txt'), 'preserved interactive drift');
  };
  await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Approve operation']])), /source.*changed|generation/i);
  assert.equal(f.store.read('target'), undefined); assert.equal(f.ownership.parentClaim('target'), undefined);
  assert.equal(f.ownership.read(source.runID).ownerSessionID, 'parent');
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), 'preserved interactive drift');
  assert.deepEqual(f.questions.read('target').nativeReceipt.answers, [['Approve operation']]);
});
