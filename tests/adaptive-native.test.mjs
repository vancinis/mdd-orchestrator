import './isolate-home.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { NativeIntake } from '../dist/native-intake.js';
import { AdaptiveStore } from '../dist/adaptive-store.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { defaultSettings } from '../dist/settings.js';
import { createInspector } from '../dist/opencode-plugin.js';
import { consumeNativeOperation, validateNativePolicy } from '../dist/adaptive-native.js';
import { validateQuestionRecord } from '../dist/question-checkpoint.js';
import { approvesOperation } from '../dist/preflight.js';
import { adaptiveQuestionsEnvelope, UNRESOLVED_PRODUCT_ANSWER } from '../dist/adaptive-low.js';
import { LocalFiles } from '../dist/local-files.js';
import { nextAction } from '../dist/next-action.js';

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

for (const echo of [undefined, 'phase', 'runID', 'callID']) test(`incident regression: native Apply ${echo ? `rejects explicit wrong ${echo}` : 'accepts omitted identity echoes'}`, async t => {
  const f = fixture(t, 'automatic'); await f.admit(); await f.gate.adaptiveInternal(f.operation(), f.runtime);
  const call = { sessionID: 'parent', callID: 'incident-child' }, args = await f.runner.before(call, f.runner.status('parent').task);
  assert.match(args.prompt, /Omit optional phase, runID and callID echoes; never guess/);
  assert.match(args.prompt, /delivered\?:\{what,implies\}/);
  const report = { outcome: 'passed', evidenceSummary: 'The held text was updated.', artifact: 'Only the assigned replacement.',
    completed: ['A1'], changes: ['own.txt'], checks: [], delivered: { what: 'Text updated.', implies: 'Replacement available.' },
    ...(echo ? { [echo]: 'wrong-native-identity' } : {}) };
  await f.runner.after(call, args, JSON.stringify(report));
  const status = f.runner.status('parent');
  assert.equal(status.lastReceipt.outcome, echo ? 'failed' : 'passed', status.lastReceipt.failure);
  if (echo) assert.match(status.lastReceipt.failure, /another actor, run or native call/);
  assert.deepEqual(status.selection.completed, echo ? [] : ['A1']);
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
  await f.gate.afterQuestion({ sessionID: 'parent', callID: 'wire-approval' }, args, output(args, [['Aprobar operación']]));
  assert.equal(f.store.read('parent').nativePolicy.questions[0].callID, 'wire-approval');
});

// A long request makes a long brief. Past its inline share it travels whole behind a paged
// reference, and the form the user answers stays one short question.
test('regression: a brief past its inline share is paged whole while the approval form stays short', async t => {
  const f = fixture(t, 'interactive');
  f.contract.objective = 'Long user request line.\n'.repeat(700).trim();
  const status = await f.gate.adaptiveInternal(wire('entry', { contract: f.contract, messageID: 'native-message' }), f.runtime);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 46000);
  assert.equal(status.questionBrief, undefined);
  assert.equal(status.next.present, 'questionBriefRef');
  assert.ok(Buffer.byteLength(status.question.questions[0].question) < 200, 'the form stays short');
  const brief = await readDetail(f, status.questionBriefRef);
  assert.equal(brief, f.gate.status('parent').questionBrief);
  assert.ok(brief.includes(f.contract.objective.split('\n').map(line => `> ${line}`).join('\n')), 'the request is quoted line for line');
  assert.match(nextAction(status).why, /^First read questionBriefRef with the detail operation/);
});

// The approval used to read "Authorize only this exact adaptive operation?" followed by the raw
// operation JSON. It is Spanish now and says what the operation does; the binding is unchanged.
// Its detail then filled the form, which cannot scroll, so the user could not see the choices: the
// form keeps one sentence and the detail travels as questionBrief, for the chat.
test('regression: the interactive entry approval asks one short question and briefs the entry for the chat', async t => {
  const f = fixture(t, 'interactive'); f.contract.exclusions = ['No se toca ningún otro archivo.'];
  await f.admit();
  const status = f.gate.status('parent'), [question] = status.question.questions, brief = status.questionBrief;
  assert.equal(question.header, 'Aprobación de operación');
  assert.deepEqual(question.options.map(option => option.label), ['Aprobar operación', 'Pausar', 'Rechazar']);
  assert.match(question.question, /^¿Autorizás esta operación de MDD\? Admitir este pedido para implementarlo con MDD\. \[MDD adaptive [0-9a-f-]{36}\]$/);
  assert.ok(!question.question.includes(f.contract.objective), 'the request is not in the form');
  assert.ok(brief.includes(`**Pedido:**\n> ${f.contract.objective}`));
  assert.ok(brief.includes(`**Resultado buscado:** ${f.contract.acceptance.goal}`));
  assert.match(brief, /\*\*Requisitos:\*\* 1, con 1 escenario\(s\)\. \*\*Tareas:\*\* 1\./);
  assert.match(brief, /\*\*Evaluación:\*\* complejidad baja, impacto bajo\./);
  assert.match(brief, /\*\*Archivos que puede escribir:\*\*\n- `own\.txt`/);
  assert.match(brief, /\*\*Queda fuera:\*\*\n- No se toca ningún otro archivo\./);
  assert.match(brief, /los permisos nativos de las herramientas siguen aplicando\.$/);
  assert.doesNotMatch(brief, /"kind"|"args"|"contract"|Authorize/);
  const bound = f.questions.read('parent');
  assert.equal(bound.slot.brief, brief, 'the brief is kept with the question record');
  assert.equal(bound.adaptive.operation.kind, 'entry');
  assert.equal(bound.adaptive.operation.args.contract.objective, f.contract.objective, 'the record still binds the exact proposed operation');
  const action = nextAction(status);
  assert.equal(action.tool, 'question');
  assert.match(action.why, /^A native question is pending\. First write questionBrief in the chat/);
});

test('regression: a select approval names the actor, assignment, purpose and the files Apply may change', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  await f.gate.adaptiveInternal(f.operation(), f.runtime);
  const status = f.gate.status('parent'), [question] = status.question.questions, brief = status.questionBrief;
  assert.match(question.question, /^¿Autorizás esta operación de MDD\? Lanzar el agente mdd-apply para la tarea A1\. \[MDD adaptive /);
  assert.match(brief, /^\*\*Aprobación de operación:\*\* Lanzar el agente mdd-apply para la tarea A1\./);
  assert.match(brief, /\*\*Propósito:\*\* Perform bounded replacement\./);
  assert.match(brief, /\*\*Archivos que puede modificar:\*\*\n- `own\.txt`/);
  assert.doesNotMatch(brief, /"handle"|"assignmentID"/);
  await f.answer([['Aprobar operación']]);
  assert.deepEqual(f.store.read('parent').nativePolicy.questions.at(-1).answer, [['Aprobar operación']]);
  assert.ok(f.runner.status('parent').task, 'the approved selection is ready to dispatch');
});

// Every interactive approval is kept with the run, and every re-asked question retires its call. A
// cap of 64 on either broke a long interactive run at its 65th approval.
test('regression: a long interactive run keeps more than 64 approvals and retired calls', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  const saved = f.store.read('parent'), approval = saved.nativePolicy.questions.at(-1);
  const many = Array.from({ length: 70 }, (_, index) => ({ ...structuredClone(approval), callID: `approval-${index}` }));
  assert.equal(validateNativePolicy({ ...saved.nativePolicy, questions: many }).questions.length, 70);
  const settled = f.questions.read('parent');
  const retired = { ...settled, retiredCalls: Array.from({ length: 70 }, (_, index) => `retired-${index}`) };
  assert.equal(validateQuestionRecord(retired).retiredCalls.length, 70);
});

test('regression: only the Spanish approval or the legacy receipt token approves an operation', () => {
  assert.equal(approvesOperation('Aprobar operación'), true);
  assert.equal(approvesOperation('Approve operation'), true, 'receipts settled before the change keep their meaning');
  for (const label of ['Pausar', 'Rechazar', 'Pause', 'Decline', 'Aprobar', 'aprobar operación', 'Aprobar operación ', undefined])
    assert.equal(approvesOperation(label), false, String(label));
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
  await f.answer([['Aprobar operación']]);
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
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  const operation = f.operation();
  await assert.rejects(f.runner.selectAdaptiveInternal(operation.args, f.runtime), /native operation authority/);
  const status = await f.gate.adaptiveInternal(operation, f.runtime);
  assert.match(status.questionBrief, /Perform bounded replacement/);
  assert.deepEqual(f.questions.read('parent').adaptive.operation, operation);
  await assert.rejects(f.gate.adaptiveInternal({ ...operation, approved: true }, f.runtime), /unknown/);
  const args = status.question, call = { sessionID: 'parent', callID: 'actual-selection-answer' };
  await f.gate.beforeQuestion(call, args);
  await assert.rejects(f.gate.afterQuestion({ ...call, callID: 'forged' }, args, output(args, [['Aprobar operación']])));
  assert.equal(f.questions.read('parent').state, 'pending');
  await assert.rejects(f.gate.afterQuestion({ ...call, sessionID: 'foreign' }, args, output(args, [['Aprobar operación']])), /another parent/);
  await f.gate.afterQuestion(call, args, output(args, [['Aprobar operación']]));
  assert.equal(f.runner.status('parent').state, 'authorized-actor');
  const saved = f.store.read('parent');
  assert.equal(saved.nativePolicy.questions.at(-1).callID, call.callID);
  assert.deepEqual(saved.nativePolicy.questions.at(-1).answer, [['Aprobar operación']]);
  await assert.rejects(f.gate.afterQuestion(call, args, output(args, [['Aprobar operación']])));
  await assert.rejects(f.runner.executeAdaptiveNativeInternal({ approved: true }, f.runtime), /single-use/);
  const taskCall = { sessionID: 'parent', callID: 'actual-child' };
  const sent = await f.runner.before(taskCall, f.runner.status('parent').task);
  await f.runner.after(taskCall, sent, JSON.stringify({ outcome: 'failed', evidenceSummary: 'No edits.', artifact: 'The child stopped without changes.', completed: [], changes: [], noChangeReason: 'Stopped.', checks: [] }));
  await assert.rejects(f.runner.selectAdaptiveInternal(f.operation().args, f.runtime), /native operation authority/);
});

for (const label of ['Pausar', 'Rechazar', 'Please do something else']) test(`AL05a: ${label} never authorizes an interactive operation`, async t => {
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
  const result = output(args, [['Aprobar operación']]); result.output = 'Caller claims user approved';
  await assert.rejects(f.gate.afterQuestion(call, args, result), /output/);
  assert.equal(f.store.read('parent'), undefined);
});

test('AL05a: generation drift rejects reply without consuming another parent question', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  const status = await f.gate.adaptiveInternal(f.operation(), f.runtime), args = status.question;
  const call = { sessionID: 'parent', callID: 'before-restore' }; await f.gate.beforeQuestion(call, args);
  const cold = new PhaseRunner(f.inspect, f.options); await cold.restore(f.runtime);
  await assert.rejects(f.gate.afterQuestion(call, args, output(args, [['Aprobar operación']])), /generation/);
  assert.equal(f.questions.read('parent').state, 'pending');
  assert.equal(cold.status('parent').task, undefined);
});

for (const phase of ['prepared', 'pending']) test(`AL05a: restart ${phase} question stays blocked and never becomes old live consent`, async t => {
  const f = fixture(t, 'interactive'); const status = await f.admit();
  const call = { sessionID: 'parent', callID: 'interrupted' };
  if (phase === 'pending') await f.gate.beforeQuestion(call, status.question);
  const gate = f.makeGate(new PhaseRunner(f.inspect, f.options));
  assert.equal(gate.status('parent').state, 'blocked');
  await assert.rejects(gate.afterQuestion(call, status.question, output(status.question, [['Aprobar operación']])), /Interrupted/);
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
  await f.admit(); await f.answer([['Aprobar operación']]);
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

test('regression: product questions ask only the question and brief why it matters; records with the earlier frames still restore', async t => {
  const f = fixture(t, 'automatic'); await f.admit();
  const operation = f.operation(); operation.args.actor = 'mdd-explore'; await f.gate.adaptiveInternal(operation, f.runtime);
  const call = { sessionID: 'parent', callID: 'frame-question-child' }, sent = await f.runner.before(call, f.runner.status('parent').task);
  const questions = [{ question: 'Keep the bounded format?', why: 'A user decision is needed.', options: [{ label: 'Keep', description: 'Keep the original bounded format.' }] }];
  await f.runner.after(call, sent, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Found a decision.', artifact: 'Source investigation only.', questions }));
  const pending = f.runner.status('parent').productQuestions;
  const status = await f.gate.adaptiveInternal({ kind: 'questions', args: { receiptID: pending.receiptID, callID: pending.callID } }, f.runtime);
  const [asked] = status.question.questions;
  assert.equal(asked.header, 'Decisión de producto');
  assert.match(asked.question, /^Keep the bounded format\? \[MDD adaptive [0-9a-f-]{36}\]$/);
  assert.equal(status.questionBrief, '**Decisión de producto:** Keep the bounded format?\n\nPor qué importa: A user decision is needed.');
  await f.answer([['Keep']]);
  // Records answered earlier carry the frame they were asked with: Spanish with the why inside the
  // question, or English. Both must still restore, and neither ever had a brief.
  for (const [frame, why] of [['inline', /\nPor qué importa: /], ['legacy', /\nWhy: /]]) {
    const saved = f.store.read('parent'), native = saved.data.questionAnswers[0].native;
    const earlier = adaptiveQuestionsEnvelope(pending.questions, native.adaptive.nonce, frame);
    assert.equal(earlier.questions[0].header, frame === 'legacy' ? 'Product decision' : 'Decisión de producto');
    for (const record of [native, saved.nativePolicy.questions.find(item => item.callID === native.callID)]) {
      record.slot.args = structuredClone(earlier); delete record.slot.brief;
    }
    const { digest: _digest, ...body } = saved; saved.digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    new LocalFiles(f.root).updateStrict(`.mdd/adaptive-${createHash('sha256').update('parent').digest('hex')}.json`, () => JSON.stringify(saved), 8 * 1024 * 1024);
    assert.match(f.store.read('parent').data.questionAnswers[0].native.slot.args.questions[0].question, why);
    const cold = new PhaseRunner(f.inspect, f.options), restored = await cold.restore(f.runtime);
    assert.equal(restored.restored, true, `${frame}: ${restored.reason}`);
  }
  // An open-ended product question offers Pausar, which leaves it unresolved in either language.
  const open = adaptiveQuestionsEnvelope([{ question: '¿Qué formato usamos?', why: 'Cambia la salida.', options: [] }], 'nonce');
  assert.deepEqual(open.questions[0].options, [{ label: 'Pausar', description: 'Dejar esta decisión de producto sin resolver.' }]);
  for (const label of ['Pausar', 'Rechazar', 'Detener', 'Pause', 'Decline', 'Stop']) assert.ok(UNRESOLVED_PRODUCT_ANSWER.test(label), label);
});

test('AL05a: an open policy question excludes an already selected native actor', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  await f.gate.adaptiveInternal(f.operation(), f.runtime); await f.answer([['Aprobar operación']]);
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
    await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Aprobar operación']])), /publication/);
  }
  assert.equal(f.store.read('parent'), undefined);
  const gate = f.makeGate(new PhaseRunner(f.inspect, f.options));
  assert.equal(gate.status('parent').state, 'blocked');
});

test('AL05a: interrupted approved bootstrap restores policy but never restores the old operation approval', async t => {
  const f = fixture(t, 'interactive'); await f.admit();
  const claim = f.ownership.claim.bind(f.ownership); let fail = true;
  t.mock.method(f.ownership, 'claim', (...args) => { if (fail) { fail = false; throw new Error('Injected bootstrap interruption.'); } return claim(...args); });
  await assert.rejects(f.answer([['Aprobar operación']]), /bootstrap/);
  assert.equal(f.store.read('parent').stage, 'bootstrap');
  assert.equal(f.store.read('parent').nativePolicy.answers.mode, 'interactive');
  const cold = new PhaseRunner(f.inspect, f.options); assert.equal((await cold.restore(f.runtime)).restored, true);
  const gate = f.makeGate(cold);
  const status = await gate.adaptiveInternal({ kind: 'select', args: { handle: cold.status('parent').selection.handle, actor: 'mdd-explore', assignmentID: 'A1', purpose: 'Read remaining source.' } }, f.runtime);
  assert.equal(status.state, 'question-ready'); assert.equal(cold.status('parent').task, undefined);
});

for (const alteration of ['epoch', 'workspace', 'scope', 'purpose']) test(`AL05a: ${alteration} cannot rebind an issued native approval`, async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
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
  await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Aprobar operación']])), /generation/);
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
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  const settled = f.questions.read('parent'), changed = structuredClone(settled); changed.sequence++;
  if (field === 'result') changed.nativeReceipt.answers = [['Pausar']];
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
  await f.gate.afterQuestion(call, status.question, output(status.question, [['Aprobar operación']]));
  assert.equal(f.store.read('parent').nativePolicy.questions[0].callID, call.callID);
});

test('AL05a: transferred policy retains frozen interactive preferences and needs fresh operation approval', async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
  f.inspect.intake = async (here, text, _messageID, scope) => {
    assert.deepEqual(here, target); assert.equal(scope, 'latest'); assert.match(text, /^Transfer sourceSessionID=parent/); return 'target-native-user';
  };
  f.inspect.adaptiveTransferIdle = async () => {}; f.inspect.confirmAdaptiveTransfer = async () => {};
  const result = await f.gate.adaptiveInternal({ kind: 'transfer', args: { sourceSessionID: 'parent', runID: source.runID, operationID: 'native-hop', messageID: 'target-message' } }, target);
  assert.equal(result.state, 'question-ready');
  const call = { sessionID: 'target', callID: 'target-transfer-question' };
  await f.gate.beforeQuestion(call, result.question);
  await f.gate.afterQuestion(call, result.question, output(result.question, [['Aprobar operación']]));
  const saved = f.store.read('target');
  assert.equal(saved.nativePolicy.answers.mode, 'interactive');
  assert.equal(saved.nativePolicy.questions.at(-1).callID, call.callID);
  assert.equal(saved.admissionDigest, source.admissionDigest);
  const status = await f.gate.adaptiveInternal({ kind: 'select', args: { handle: f.runner.status('target').selection.handle, actor: 'mdd-explore', assignmentID: 'A1', purpose: 'Read transferred scope.' } }, target);
  assert.equal(status.state, 'question-ready'); assert.equal(f.runner.status('target').task, undefined);
});

async function proposedTransfer(t) {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
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

for (const label of ['Pausar', 'Rechazar']) test(`AL05a transfer fence: ${label} retains the receipt and releases only its own source fence`, async t => {
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
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Aprobar operación']])), /generation|source.*changed|drift/i);
  assert.equal(f.store.read('target'), undefined);
  assert.equal(f.questions.read('target').state, 'pending');
});

test('AL05a transfer fence: changed source operation during asynchronous native proof cannot use the consumed answer', async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: 'proof-race-answer' };
  await f.gate.beforeQuestion(call, f.question);
  f.inspect.adaptiveTransferIdle = async (_here, role) => {
    if (role === 'target') writeFileSync(join(f.root, 'own.txt'), 'raced during proof');
  };
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Aprobar operación']])), /source|generation|drift/i);
  assert.equal(f.store.read('target'), undefined);
  assert.deepEqual(f.questions.read('target').nativeReceipt.answers, [['Aprobar operación']]);
});

for (const action of ['finish', 'abort']) test(`AL05a transfer fence: interrupted claim requires a fresh native ${action} decision`, async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: 'interrupted-transfer-answer' };
  const begin = f.ownership.beginAdaptiveTransfer.bind(f.ownership); let fail = true;
  t.mock.method(f.ownership, 'beginAdaptiveTransfer', (...args) => { if (fail) { fail = false; throw new Error('Injected claimed-transfer interruption.'); } return begin(...args); });
  await f.gate.beforeQuestion(call, f.question);
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Aprobar operación']])), /interruption/);
  const recovery = { kind: 'transfer-recovery', args: { ...f.transferOperation.args, action, messageID: 'fresh-recovery-message' } };
  const status = await f.gate.adaptiveInternal(recovery, f.target);
  assert.equal(status.state, 'question-ready');
  const fresh = { sessionID: 'target', callID: `fresh-native-${action}` };
  await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Aprobar operación']])));
  await f.gate.beforeQuestion(fresh, status.question);
  await f.gate.afterQuestion(fresh, status.question, output(status.question, [['Aprobar operación']]));
  assert.equal(f.ownership.read(f.source.runID).policyQuestion, undefined);
  assert.equal(f.ownership.read(f.source.runID).ownerSessionID, action === 'finish' ? 'target' : 'parent');
  assert.equal(f.questions.read('target').nativeReceipt.callID, fresh.callID);
});

for (const occupancy of ['fixed question', 'native intake']) test(`AL05a transfer fence: ${occupancy} is protected before a target policy question is prepared`, async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
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
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([['Aprobar operación']]);
  await f.gate.adaptiveInternal(f.operation(), f.runtime); await f.answer([['Aprobar operación']]);
  f.inspect.adaptiveTransferIdle = async () => {}; f.inspect.confirmAdaptiveTransfer = async () => {};
  await assert.rejects(f.gate.adaptiveInternal({ kind: 'transfer', args: { sourceSessionID: 'parent', runID: f.store.read('parent').runID, operationID: 'selected-source', messageID: 'target-message' } }, { ...f.runtime, sessionID: 'target' }), /actorless/);
  assert.equal(f.questions.read('target'), undefined);
});

test('AL05a transfer fence: an unclaimed failed proposal releases only on a fresh native abort decision and idle proof', async t => {
  const f = await proposedTransfer(t), call = { sessionID: 'target', callID: 'unclaimed-transfer-answer' };
  f.inspect.adaptiveTransferIdle = async (_here, role) => { if (role === 'target') writeFileSync(join(f.root, 'own.txt'), 'external drift'); };
  await f.gate.beforeQuestion(call, f.question);
  await assert.rejects(f.gate.afterQuestion(call, f.question, output(f.question, [['Aprobar operación']])), /source.*changed/i);
  assert.equal(f.ownership.parentClaim('target'), undefined);
  f.inspect.adaptiveTransferIdle = async () => {};
  const recovery = { kind: 'transfer-recovery', args: { ...f.transferOperation.args, action: 'abort', messageID: 'explicit-abort-message' } };
  const status = await f.gate.adaptiveInternal(recovery, f.target);
  const fresh = { sessionID: 'target', callID: 'explicit-unclaimed-abort' };
  await f.gate.beforeQuestion(fresh, status.question);
  await f.gate.afterQuestion(fresh, status.question, output(status.question, [['Aprobar operación']]));
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
    assert.equal(approval.questions[0].header, 'Aprobación de operación');
    await gate.beforeQuestion(approve, approval); await gate.afterQuestion(approve, approval, output(approval, [['Aprobar operación']]));
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
  const f = fixture(t, 'interactive'), native = inspectedTransfer(f); await f.admit(); await f.answer([['Aprobar operación']]);
  const source = f.store.read('parent'), status = await f.gate.adaptiveInternal(native.operation(), native.target);
  const call = { sessionID: 'target', callID: 'current-interactive-transfer' };
  await f.gate.beforeQuestion(call, status.question);
  f.inspect.adaptiveTransferIdle = async (here, role) => {
    await native.inspector.adaptiveTransferIdle(here, role);
    if (role === 'target') writeFileSync(join(f.root, 'own.txt'), 'preserved interactive drift');
  };
  await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, [['Aprobar operación']])), /source.*changed|generation/i);
  assert.equal(f.store.read('target'), undefined); assert.equal(f.ownership.parentClaim('target'), undefined);
  assert.equal(f.ownership.read(source.runID).ownerSessionID, 'parent');
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), 'preserved interactive drift');
  assert.deepEqual(f.questions.read('target').nativeReceipt.answers, [['Aprobar operación']]);
});

// Admission stuck after a pre-bootstrap rejection (ADM-01..ADM-07).
const SERIAL = /Apply scope has unproven paths or implicit runtime\/instruction effects: project plugins in \.opencode\/plugins/;
const AUTO = [['Autom\u00e1tico']];
const blockPlugins = f => mkdirSync(join(f.root, '.opencode', 'plugins'), { recursive: true });
const unblockPlugins = f => rmSync(join(f.root, '.opencode'), { recursive: true, force: true });

test('ADM-01/02/05: mode answer then scope rejection is fenced; reset releases only that fence and fresh admission re-asks', async t => {
  const f = fixture(t); blockPlugins(f);
  await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  // ADM-01-S01: real diagnostic retained, question settled, nothing fabricated.
  assert.equal(f.gate.status('parent').state, 'blocked');
  assert.match(f.gate.status('parent').reason, SERIAL);
  assert.equal(f.questions.read('parent').state, 'settled');
  assert.equal(f.store.read('parent'), undefined); assert.equal(f.ownership.parent('parent'), undefined);
  // ADM-02-S01: the applied run reset releases exactly that bridge fence.
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.scope, 'run'); assert.deepEqual(reset.reset.nativeEntry, { released: true });
  assert.equal(f.store.read('parent'), undefined); assert.equal(f.ownership.parent('parent'), undefined);
  // ADM-05-S03: the unchanged invalid scope is still rejected and the old mode answer is not reused (mode is asked again).
  const again = await f.admit(); assert.equal(again.state, 'question-ready'); assert.equal(again.question.questions[0].header, 'Modo');
  await assert.rejects(f.answer(AUTO), SERIAL);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  unblockPlugins(f);
  // ADM-02-S02 / ADM-05-S01: fresh admission goes through the ordinary path and reaches actor selection.
  const fresh = await f.admit(); assert.equal(fresh.question.questions[0].header, 'Modo');
  await f.answer(AUTO);
  assert.ok(f.store.read('parent'));
  assert.equal(f.runner.status('parent').state, 'await-selection');
});

test('ADM-06-S01: repeating an applied reset is idle and omits the bridge report', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  const second = f.gate.reset(f.runtime, 'run');
  assert.equal(second.reset.scope, 'run'); assert.equal(second.reset.nativeEntry, undefined);
  assert.equal(f.store.read('parent'), undefined);
});

test('ADM-01-S02: a blocked entry without attempt-bound proof keeps its fence', async t => {
  const f = fixture(t, 'automatic');
  t.mock.method(f.inspect, 'intake', async () => { throw new Error('Generic inspection failure.'); });
  await assert.rejects(f.admit(), /Generic inspection failure/);
  assert.equal(f.gate.status('parent').state, 'blocked');
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.nativeEntry.released, false); assert.match(reset.reset.nativeEntry.reason, /attempt-bound proof/);
  assert.equal(f.gate.status('parent').state, 'blocked');
});

test('ADM-03: bootstrap interruption keeps durable data and the fence; reset refuses', async t => {
  const f = fixture(t, 'interactive'); await f.admit();
  const claim = f.ownership.claim.bind(f.ownership); let fail = true;
  t.mock.method(f.ownership, 'claim', (...args) => { if (fail) { fail = false; throw new Error('Injected bootstrap interruption.'); } return claim(...args); });
  await assert.rejects(f.answer([['Aprobar operación']]), /bootstrap/);
  const before = f.store.read('parent');
  assert.throws(() => f.gate.reset(f.runtime, 'run'), /Adaptive records cannot enter fixed reset/);
  assert.deepEqual(f.store.read('parent'), before); assert.equal(f.gate.status('parent').state, 'blocked');
});

test('ADM-04-S01: an unresolved question keeps its checkpoint bytes and fence through reset and stays answerable', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  const before = structuredClone(f.questions.read('parent')), bytes = readFileSync(checkpointFile(f, 'question'));
  assert.ok(['prepared', 'pending'].includes(before.state));
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.nativeEntry.released, false);
  assert.match(reset.reset.nativeEntry.reason, /question is unresolved/);
  assert.deepEqual(f.questions.read('parent'), before);
  assert.ok(readFileSync(checkpointFile(f, 'question')).equals(bytes), 'raw checkpoint bytes are unchanged');
  assert.ok(f.gate.status('parent').question);
  // The retained question is still the one the user can answer; the real scope rejection then follows.
  await assert.rejects(f.answer(AUTO), SERIAL);
  assert.equal(f.questions.read('parent').state, 'settled');
});

test('ADM-04-S01/ADM-03-S02: an unreadable question is held, never cleared, by reset', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  const clear = t.mock.method(f.questions, 'clear'), bytes = readFileSync(checkpointFile(f, 'question'));
  t.mock.method(f.questions, 'read', () => { throw new Error('Injected unreadable question.'); });
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.nativeEntry.released, false);
  assert.equal(clear.mock.callCount(), 0);
  assert.ok(readFileSync(checkpointFile(f, 'question')).equals(bytes), 'raw checkpoint bytes are unchanged');
  assert.equal(f.store.read('parent'), undefined); assert.equal(f.ownership.parent('parent'), undefined);
});

test('ADM-02-S01 control: releasing a proven orphan still clears its settled question exactly once', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  const clear = t.mock.method(f.questions, 'clear');
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(f.questions.read('parent'), undefined);
});

test('ADM-07-S01: resetting another parent leaves this parent\'s unresolved question and fence untouched', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  const before = structuredClone(f.questions.read('parent'));
  f.gate.reset({ ...f.runtime, sessionID: 'other' }, 'run');
  assert.deepEqual(f.questions.read('parent'), before);
  assert.ok(f.gate.status('parent').question);
});

test('ADM-06-S03: a runner that cannot confirm release leaves the fence in place', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  const mock = t.mock.method(f.runner, 'consumeAdaptiveEntryRejectionInternal', () => 'Injected occupancy.');
  const reset = f.gate.reset(f.runtime, 'run');
  assert.deepEqual(reset.reset.nativeEntry, { released: false, reason: 'Injected occupancy.' });
  assert.equal(f.gate.status('parent').state, 'blocked');
  // The refusal was temporary: once it lifts, a retried reset still releases the exact retained orphan.
  mock.mock.restore();
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
});

test('ADM-06-S03: a failed question clear keeps the fence and a retry releases it', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  const before = f.questions.read('parent');
  const mock = t.mock.method(f.questions, 'clear', () => { throw new Error('Injected clear fault.'); });
  assert.throws(() => f.gate.reset(f.runtime, 'run'), /clear fault/);
  assert.equal(f.gate.status('parent').state, 'blocked'); assert.deepEqual(f.questions.read('parent'), before);
  mock.mock.restore();
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
});

for (const state of ['pending', 'answered', 'settled']) test(`ADM-04-S01: reset preserves the checkpoint after a failed ${state} publication`, async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  const write = f.questions.write.bind(f.questions);
  const mock = t.mock.method(f.questions, 'write', (id, record) => {
    if (record.state === state) throw new Error('Injected publication fault.'); return write(id, record);
  });
  await assert.rejects(f.answer(AUTO), /publication fault/);
  mock.mock.restore();
  const before = structuredClone(f.questions.read('parent')), bytes = readFileSync(checkpointFile(f, 'question'));
  const result = f.gate.reset(f.runtime, 'run');
  assert.equal(result.reset.nativeEntry.released, false);
  assert.deepEqual(f.questions.read('parent'), before);
  assert.ok(readFileSync(checkpointFile(f, 'question')).equals(bytes), 'raw checkpoint bytes are unchanged');
  assert.equal(f.store.read('parent'), undefined);
});

test('ADM-06-S02: a newer admission replaces the entry; the old proof cannot release it', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  const fresh = await f.admit(); assert.equal(fresh.state, 'question-ready');
  assert.equal(f.gate.reset(f.runtime, 'run').reset.nativeEntry.released, false);
});

const checkpointFile = (f, kind, id = 'parent') => join(f.root, '.mdd', `${kind}-${createHash('sha256').update(id).digest('hex')}.json`);

test('ADM-06-S02: a replacement admission started at questions.clear cannot be released by the old reset', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  const clear = f.questions.clear.bind(f.questions); let next;
  t.mock.method(f.questions, 'clear', id => { clear(id); next = f.admit(); });
  const reset = f.gate.reset(f.runtime, 'run');
  assert.deepEqual(reset.reset.nativeEntry, { released: false, reason: 'The native entry changed before release.' });
  const fresh = await next;
  assert.equal(fresh.state, 'question-ready');
  assert.equal(f.questions.read('parent').state, 'prepared');
  assert.equal(f.store.read('parent'), undefined);
});

test('ADM-06-S02/ADM-03-S02: durable occupancy appearing at questions.clear prevents the final release and stays byte-identical', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  await assert.rejects(f.answer(AUTO), SERIAL);
  const clear = f.questions.clear.bind(f.questions);
  t.mock.method(f.questions, 'clear', id => { clear(id); writeFileSync(checkpointFile(f, 'adaptive', id), 'occupied-corrupt'); });
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.nativeEntry.released, false);
  assert.equal(readFileSync(checkpointFile(f, 'adaptive'), 'utf8'), 'occupied-corrupt');
  assert.equal(f.gate.status('parent').state, 'blocked');
});

test('ADM-05-S01: an old reply replayed after safe reset cannot authorize the fresh question', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  const old = f.gate.status('parent').question;
  await assert.rejects(f.answer(AUTO), SERIAL);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  await f.admit(); const before = f.questions.read('parent');
  await assert.rejects(f.gate.afterQuestion({ sessionID: 'parent', callID: 'question-1' }, old, output(old, AUTO)));
  assert.deepEqual(f.questions.read('parent'), before);
  assert.equal(f.store.read('parent'), undefined);
});

for (const choice of ['Pausar', 'Rechazar']) test(`ADM-04-S03: ${choice} then reset supplies no retry authority`, async t => {
  const f = fixture(t, 'interactive'); await f.admit(); await f.answer([[choice]]);
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.nativeEntry.released, false);
  assert.equal(f.store.read('parent'), undefined); assert.equal(f.ownership.parent('parent'), undefined);
});

test('ADM-07-S01: resetting a rejected parent preserves another admitted parent and its owner', async t => {
  const f = fixture(t, 'automatic'); blockPlugins(f);
  await assert.rejects(f.admit(), SERIAL);
  unblockPlugins(f);
  const other = { ...f.runtime, sessionID: 'other' };
  await f.gate.adaptiveInternal({ kind: 'entry', args: { contract: f.contract, messageID: 'other-message' } }, other);
  const record = structuredClone(f.store.read('other')), owner = structuredClone(f.ownership.read(record.runID));
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  assert.deepEqual(f.store.read('other'), record); assert.deepEqual(f.ownership.read(record.runID), owner);
  assert.equal(f.runner.status('other').state, 'await-selection');
  assert.equal(f.store.read('parent'), undefined);
});

test('ADM-05-S02/ADM-05-S03: after safe reset a failed native identity check admits nothing, and an unchanged invalid scope is still rejected', async t => {
  const f = fixture(t, 'automatic'); blockPlugins(f);
  await assert.rejects(f.admit(), SERIAL);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  const intake = t.mock.method(f.inspect, 'intake', async () => { throw new Error('Forged native identity.'); });
  await assert.rejects(f.admit(), /Forged native identity/);
  assert.equal(f.store.read('parent'), undefined); assert.equal(f.ownership.parent('parent'), undefined);
  intake.mock.restore();
  await assert.rejects(f.admit(), SERIAL);
  assert.equal(f.store.read('parent'), undefined); assert.equal(f.ownership.parent('parent'), undefined);
});

// ---- D16 reset liveness and authorization matrix (N01-N20) ----
const BUSY = 'A native policy intake is pending.';
const startError = async (f, gate = f.gate, id = 'fresh-message') => {
  try { await gate.start({ requirements: f.contract.objective }, f.runtime, id); return 'ok'; } catch (error) { return error.message; }
};
const restart = f => f.makeGate(new PhaseRunner(f.inspect, f.options));
const entryOp = f => ({ kind: 'entry', args: { contract: f.contract, messageID: 'native-message' } });
const noRun = f => { assert.equal(f.store.read('parent'), undefined); assert.equal(f.ownership.parent('parent'), undefined); };
const raw = (f, kind = 'question') => readFileSync(checkpointFile(f, kind));
/** Parks the next call of an inspector method until released; later calls use the original. */
function hold(target, method) {
  const original = target[method]; let release, reach;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { reach = resolve; });
  target[method] = async (...args) => { reach(); await gate; return original.apply(target, args); };
  return { reached, release: () => { release(); target[method] = original; } };
}
/** Records each single-use execution token together with the original executor. */
function captureAttempts(f) {
  const attempts = [], original = f.runner.executeAdaptiveNativeInternal.bind(f.runner);
  f.runner.executeAdaptiveNativeInternal = (token, runtime) => { attempts.push({ token, original }); return original(token, runtime); };
  return attempts;
}
const orphan = async (f, labels = AUTO) => { blockPlugins(f); await f.admit(); await assert.rejects(f.answer(labels), SERIAL); };

test('ADM-07-S02/ADM-02-S01: N01 stale-busy symptom - start is refused until the applied reset, then no longer busy', async t => {
  const f = fixture(t); await orphan(f);
  assert.equal(await startError(f), BUSY);
  const reset = f.gate.reset(f.runtime, 'run');
  // The stale-busy symptom is asserted first: it is the observable failure, independent of the new response field.
  assert.notEqual(await startError(f), BUSY);
  assert.deepEqual(reset.reset.nativeEntry, { released: true });
});

test('ADM-04-S01: N02 permanent Verify probe - an unresolved question keeps its record and raw bytes through reset', async t => {
  const f = fixture(t); blockPlugins(f); await f.admit();
  noRun(f); assert.equal(f.questions.read('parent').state, 'prepared');
  const record = structuredClone(f.questions.read('parent')), bytes = raw(f);
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.nativeEntry.released, false);
  assert.deepEqual(f.questions.read('parent'), record); assert.ok(raw(f).equals(bytes));
  assert.equal(await startError(f), BUSY); noRun(f);
});

for (const phase of ['prepared', 'pending', 'answered']) test(`ADM-04-S01/ADM-05-S01: N04 restart after interrupted ${phase} question stays fenced, then a reset gives fresh Modo [parity]`, async t => {
  const f = fixture(t); await f.admit();
  const status = f.gate.status('parent'), call = { sessionID: 'parent', callID: 'interrupted-mode' };
  if (phase !== 'prepared') await f.gate.beforeQuestion(call, status.question);
  if (phase === 'answered') {
    const write = f.questions.write.bind(f.questions);
    t.mock.method(f.questions, 'write', (id, record) => { if (record.state === 'settled') throw new Error('Injected question publication failure.'); return write(id, record); });
    await assert.rejects(f.gate.afterQuestion(call, status.question, output(status.question, AUTO)), /publication/);
    t.mock.restoreAll();
    assert.equal(f.questions.read('parent').state, 'answered');
  }
  const gate = restart(f);
  assert.equal(gate.status('parent').state, 'blocked');
  assert.equal(gate.status('parent').reason, 'Interrupted native question is not consent. Its unresolved outcome remains fenced.');
  await assert.rejects(gate.afterQuestion(call, status.question, output(status.question, AUTO)), /Interrupted native question cannot resume as live consent/);
  await assert.rejects(gate.adaptiveInternal(entryOp(f), f.runtime), { message: 'A native question is unresolved; no overlapping intake or actor operation.' });
  noRun(f);
  assert.deepEqual(gate.reset(f.runtime, 'run').reset, { scope: 'run' }); noRun(f);
  const fresh = await gate.adaptiveInternal(entryOp(f), f.runtime);
  assert.equal(fresh.question.questions[0].header, 'Modo'); assert.notDeepEqual(fresh.question, status.question);
});

test('ADM-04-S02: N05 a starting admission stays exclusive against reset, overlap and start, then yields one run [parity]', async t => {
  const f = fixture(t, 'automatic'); const parked = hold(f.inspect, 'parent');
  const admitting = f.admit(); await parked.reached;
  assert.throws(() => f.gate.reset(f.runtime, 'run'), { message: 'Live internal adaptive selection cannot enter public fixed-phase reset.' });
  await assert.rejects(f.admit(), { message: 'A native policy operation is already pending.' });
  assert.equal(await startError(f), BUSY);
  parked.release(); await admitting;
  assert.ok(f.store.read('parent')); assert.equal(f.runner.status('parent').state, 'await-selection');
});

test('ADM-04-S02/ADM-06-S02: N06 a bridge entry still starting is not releasable and admits exactly once', async t => {
  const f = fixture(t, 'automatic'); const parked = hold(f.inspect, 'intake');
  const admitting = f.admit(); await parked.reached;
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: false, reason: 'Only a blocked entry rejected before bootstrap can be released.' });
  await assert.rejects(f.admit(), { message: 'A native policy operation is already pending.' });
  assert.equal(await startError(f), BUSY);
  parked.release(); await admitting;
  assert.ok(f.store.read('parent')); assert.equal(f.runner.status('parent').state, 'await-selection');
});

test('ADM-04-S02: N07 a dispatched child keeps the run exclusive; an overlapping attempt cannot be released', async t => {
  const f = fixture(t, 'automatic'); const attempts = captureAttempts(f);
  await f.admit(); await f.gate.adaptiveInternal(f.operation(), f.runtime);
  await f.runner.before({ sessionID: 'parent', callID: 'live-child' }, f.runner.status('parent').task);
  assert.equal(f.runner.status('parent').state, 'await-result');
  const stored = structuredClone(f.store.read('parent'));
  assert.throws(() => f.gate.reset(f.runtime, 'run'), { message: 'Adaptive records cannot enter fixed reset or discard.' });
  await assert.rejects(f.admit(), { message: 'An existing or unfinished native run occupies this parent; internal admission requires idle ownership.' });
  assert.deepEqual(f.store.read('parent'), stored); assert.equal(f.runner.status('parent').state, 'await-result');
  assert.equal(f.runner.consumeAdaptiveEntryRejectionInternal(attempts.at(-1).token, f.runtime), 'Live or in-memory run state occupies this parent.');
});

test('ADM-04-S02/ADM-06-S03: N08 unconfirmed child liveness (pending progress) keeps an orphan fenced until cleared', async t => {
  const f = fixture(t); await orphan(f);
  f.options.progress.write('parent', { runID: 'mdd-run-older', callID: 'older-child', attemptID: 'older-child', state: 'pending', userMessageID: 'older-user' });
  assert.throws(() => f.gate.reset(f.runtime, 'run'), /unconfirmed liveness/);
  assert.equal(f.gate.status('parent').state, 'blocked'); assert.equal(await startError(f), BUSY);
  f.options.progress.clear('parent');
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  assert.notEqual(await startError(f), BUSY);
});

test('ADM-03-S01/ADM-01-S02: N09 a failed bootstrap publication has no rejection proof and stays fenced, also after restart', async t => {
  const f = fixture(t, 'automatic');
  t.mock.method(f.ownership, 'bootstrapAdaptive', () => { throw new Error('Injected bootstrap publication failure.'); });
  await assert.rejects(f.admit(), { message: 'Injected bootstrap publication failure.' });
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: false, reason: 'No attempt-bound proof that bootstrap was never reached.' });
  assert.equal(await startError(f), BUSY); noRun(f);
  assert.deepEqual(restart(f).reset(f.runtime, 'run').reset, { scope: 'run' });
});

test('ADM-03-S01: N10 interrupted claim then restart keeps durable data; a fresh approval cannot take the parent [parity]', async t => {
  const f = fixture(t, 'interactive'); await f.admit();
  const claim = f.ownership.claim.bind(f.ownership); let fail = true;
  t.mock.method(f.ownership, 'claim', (...args) => { if (fail) { fail = false; throw new Error('Injected bootstrap interruption.'); } return claim(...args); });
  await assert.rejects(f.answer([['Aprobar operación']]), /bootstrap/);
  const gate = restart(f), stored = structuredClone(f.store.read('parent')), owner = f.ownership.parent('parent');
  assert.throws(() => gate.reset(f.runtime, 'run'), /Adaptive records cannot enter fixed reset/);
  const status = await gate.adaptiveInternal(entryOp(f), f.runtime);
  assert.equal(status.question.questions[0].header, 'Aprobación de operación');
  await assert.rejects(f.answer([['Aprobar operación']], gate), /existing or unfinished native run occupies this parent/);
  assert.deepEqual(f.store.read('parent'), stored); assert.equal(f.ownership.parent('parent'), owner);
});

for (const injection of ['foreign owner', 'occupied read throws', 'malformed retirement pointer']) test(`ADM-03-S02/ADM-06-S02: N11 occupancy appearing at questions.clear (${injection}) blocks release and keeps the injected state`, async t => {
  const f = fixture(t); await orphan(f);
  const pointer = join(f.root, '.mdd', `adaptive-retirement-${createHash('sha256').update(JSON.stringify('parent')).digest('hex')}.json`);
  const clear = f.questions.clear.bind(f.questions);
  t.mock.method(f.questions, 'clear', id => {
    clear(id);
    if (injection === 'foreign owner') f.ownership.claimParent('parent', 'mdd-run-foreign');
    else if (injection === 'occupied read throws') f.store.occupied = () => { throw new Error('Injected unreadable store.'); };
    else writeFileSync(pointer, 'malformed');
  });
  const reset = f.gate.reset(f.runtime, 'run');
  assert.equal(reset.reset.nativeEntry.released, false);
  assert.equal(reset.reset.nativeEntry.reason, injection === 'foreign owner' ? 'Ownership, intake, checkpoint or progress state occupies this parent.' : 'Occupancy could not be established reliably.');
  assert.equal(f.gate.status('parent').state, 'blocked'); assert.equal(await startError(f), BUSY);
  if (injection === 'foreign owner') assert.equal(f.ownership.parent('parent'), 'mdd-run-foreign');
  if (injection === 'malformed retirement pointer') assert.equal(readFileSync(pointer, 'utf8'), 'malformed');
});

for (const dismissal of ['free text', 'nativeError']) test(`ADM-04-S03: N12 ${dismissal} dismissal supplies no release proof`, async t => {
  const f = fixture(t, 'interactive'); const status = await f.admit(), call = { sessionID: 'parent', callID: 'dismissed-approval' };
  await f.gate.beforeQuestion(call, status.question);
  if (dismissal === 'free text') await f.gate.afterQuestion(call, status.question, output(status.question, [['Please do something else']]));
  else f.gate.nativeError(call);
  assert.equal(f.questions.read('parent').state, 'cancelled');
  assert.equal(f.gate.status('parent').reason, 'Native question ended without authorization. Free text, pause and dismissal do not approve operations.');
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: false, reason: 'No attempt-bound proof that bootstrap was never reached.' });
  noRun(f);
});

test('ADM-04-S03: N13 an automatic product question answered Pause supplies no release proof', async t => {
  const f = fixture(t, 'automatic'); f.contract.productQuestions = ['Keep the bounded format?'];
  const questions = [{ question: 'Keep the bounded format?', why: 'A decision is needed.', options: [{ label: 'Keep', description: 'Keep the format.' }, { label: 'Stop', description: 'Do not continue.' }] }];
  await f.gate.adaptiveInternal({ kind: 'entry', args: { contract: f.contract, messageID: 'native-message', questions } }, f.runtime);
  await f.answer([['Stop']]);
  assert.equal(f.gate.status('parent').reason, 'The native product question remains unresolved; no operation was authorized.');
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: false, reason: 'No attempt-bound proof that bootstrap was never reached.' });
  noRun(f);
});

test('ADM-05-S01: N14 interactive consent is asked again after reset; the old reply cannot authorize it', async t => {
  const f = fixture(t, 'interactive'); blockPlugins(f); const first = await f.admit();
  await assert.rejects(f.answer([['Aprobar operación']]), SERIAL);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true }); unblockPlugins(f);
  const fresh = await f.admit(); assert.equal(fresh.question.questions[0].header, 'Aprobación de operación');
  assert.notDeepEqual(fresh.question, first.question);
  await assert.rejects(f.gate.afterQuestion({ sessionID: 'parent', callID: 'question-1' }, first.question, output(first.question, [['Aprobar operación']])), { message: 'Question differs from the exact proposed native envelope.' });
  assert.equal(f.store.read('parent'), undefined);
  await f.answer([['Aprobar operación']]);
  assert.ok(f.store.read('parent')); assert.equal(f.store.read('parent').nativePolicy.questions.at(-1).callID, 'question-2');
});

test('ADM-05-S01: N15 explicitly automatic profile is admitted after reset with no extra question', async t => {
  const f = fixture(t, 'automatic'); blockPlugins(f);
  await assert.rejects(f.admit(), SERIAL);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true }); unblockPlugins(f);
  const count = f.inspected.length; await f.admit();
  assert.equal(f.inspected.length, count); assert.equal(f.questions.read('parent'), undefined);
  assert.deepEqual(f.store.read('parent').nativePolicy.answers, { mode: 'automatic' });
  assert.equal(f.runner.status('parent').state, 'await-selection');
});

test('ADM-05-S01: N16 the consumed single-use rejection proof cannot be replayed or reused', async t => {
  const f = fixture(t, 'automatic'); const attempts = captureAttempts(f); blockPlugins(f);
  await assert.rejects(f.admit(), SERIAL);
  const { token, original } = attempts[0];
  assert.throws(() => consumeNativeOperation(token, f.runtime), { message: 'Actual single-use native operation proof is required.' });
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  await assert.rejects(original(token, f.runtime), { message: 'Actual single-use native operation proof is required.' });
  assert.equal(f.runner.consumeAdaptiveEntryRejectionInternal(token, f.runtime), 'No attempt-bound proof that bootstrap was never reached.');
  noRun(f);
});

test('ADM-05-S02: N17 reset and fresh admission keep coordinator, workspace, caller and real native-identity guards', async t => {
  const f = fixture(t, 'automatic'); blockPlugins(f);
  await assert.rejects(f.admit(), SERIAL);
  assert.throws(() => f.gate.reset({ ...f.runtime, agent: 'general' }, 'run'), { message: 'Only the coordinator may reset MDD state.' });
  const foreign = f.root + '-foreign';
  assert.deepEqual(f.gate.reset({ ...f.runtime, directory: foreign, worktree: foreign }, 'run').reset.nativeEntry, { released: false, reason: 'Native coordinator or workspace differs from the rejected attempt.' });
  assert.equal(f.gate.status('parent').state, 'blocked');
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  const entry = id => wire('entry', { contract: f.contract, messageID: id });
  await assert.rejects(f.gate.adaptiveInternal(entry('old-message'), f.runtime, 'host-turn'), { message: 'Entry messageID must be the user message whose exact text is the objective (normally the current native user turn); a caller-chosen old identity is refused. Omit messageID and the host binds it.' }); noRun(f);
  await assert.rejects(f.gate.adaptiveInternal(entryOp(f), { ...f.runtime, agent: 'general' }), { message: 'Only the native coordinator may propose adaptive operations.' }); noRun(f);
  // A non-canonical workspace spelling is refused by the runner on a separate parent (a blocked entry keeps its own runtime).
  const h = fixture(t, 'automatic'), dotted = h.root + sep + '.';
  await assert.rejects(h.gate.adaptiveInternal(entryOp(h), { ...h.runtime, directory: dotted, worktree: dotted }), { message: 'Internal adaptive admission requires the exact coordinator workspace.' }); noRun(h);
  unblockPlugins(f);
  const parent = { id: 'parent', directory: f.root, projectID: 'project', agent: 'mdd-orchestrator' };
  const current = { info: { id: 'native-message', sessionID: 'parent', role: 'assistant', agent: 'mdd-orchestrator', parentID: 'native-user', path: { cwd: f.root, root: f.root } }, parts: [] };
  const history = [{ info: { id: 'native-user', sessionID: 'parent', role: 'user' }, parts: [{ type: 'text', text: f.contract.objective, sessionID: 'parent', messageID: 'native-user' }] }, current];
  const inspector = createInspector({ directory: f.root, worktree: f.root, project: { id: 'project' }, client: { session: { get: async () => ({ data: parent }), messages: async () => ({ data: history }) } } });
  f.inspect.intake = inspector.intake; f.inspect.parent = inspector.parent; f.inspect.question = inspector.question;
  await assert.rejects(f.gate.adaptiveInternal(entry('native-user'), f.runtime, 'forged-message'), { message: 'Start does not match the actual native caller message.' }); noRun(f);
  await f.gate.adaptiveInternal(entry('native-user'), f.runtime, 'native-message');
  assert.equal(f.store.read('parent').userMessageID, 'native-user'); assert.equal(f.runner.status('parent').state, 'await-selection');
});

test('regression: public entry binds the host-resolved user turn without messageID; internal entry still needs exact identity', async t => {
  const f = fixture(t, 'automatic');
  await assert.rejects(f.gate.adaptiveInternal(wire('entry', { contract: f.contract }), f.runtime), { message: 'Native entry requires its exact original user authorization.' });
  noRun(f);
  const status = await f.gate.adaptiveInternal(wire('entry', { contract: f.contract }), f.runtime, 'host-turn');
  assert.equal(status.state, 'await-selection');
  assert.equal(f.store.read('parent').userMessageID, 'native-user');
});

test('regression: an earlier request answered from the current turn is admitted only after one native confirmation', async t => {
  const f = fixture(t, 'automatic');
  const parent = { id: 'parent', directory: f.root, projectID: 'project', agent: 'mdd-orchestrator' };
  const user = (id, text) => ({ info: { id, sessionID: 'parent', role: 'user' }, parts: [{ type: 'text', text, sessionID: 'parent', messageID: id }] });
  const current = { info: { id: 'native-message', sessionID: 'parent', role: 'assistant', agent: 'mdd-orchestrator', parentID: 'confirm-user', path: { cwd: f.root, root: f.root } }, parts: [] };
  const history = [user('request-user', f.contract.objective), user('confirm-user', 'sí, confirmo las recomendaciones'), current];
  const inspector = createInspector({ directory: f.root, worktree: f.root, project: { id: 'project' }, client: { session: { get: async () => ({ data: parent }), messages: async () => ({ data: history }) } } });
  Object.assign(f.inspect, { intake: inspector.intake, parent: inspector.parent, currentUser: inspector.currentUser });
  const status = await f.gate.adaptiveInternal(wire('entry', { contract: f.contract }), f.runtime, 'native-message');
  assert.equal(status.state, 'question-ready');
  assert.equal(status.question.questions[0].header, 'Pedido anterior');
  assert.doesNotMatch(status.question.questions[0].question, /Replace bounded text\./, 'the form asks; the request is quoted in the brief');
  assert.equal(status.questionBrief, '**Pedido anterior, tal como lo escribiste:**\n> Replace bounded text.');
  noRun(f);
  await f.answer([['Aprobar operación']]);
  assert.equal(f.store.read('parent').userMessageID, 'request-user', 'the run binds the message that carries the objective');
  assert.equal(f.runner.status('parent').state, 'await-selection');
});

test('ADM-05-S02: N18 a consumed request identity and a drifted question generation are refused after reset', async t => {
  const f = fixture(t, 'automatic'); blockPlugins(f);
  await assert.rejects(f.admit(), SERIAL);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  unblockPlugins(f);
  f.options.progress.write('parent', { runID: 'mdd-run-older', callID: 'older-child', attemptID: 'older-child', state: 'settled', userMessageID: 'native-user' });
  await assert.rejects(f.admit(), { message: 'This exact request already ran in this conversation. Send a new request, or use mdd_reset to start it over deliberately.' });
  noRun(f); f.options.progress.clear('parent');
  const g = fixture(t, 'interactive'); const status = await g.admit(), call = { sessionID: 'parent', callID: 'drifted-answer' };
  await g.gate.beforeQuestion(call, status.question);
  const record = g.questions.read('parent');
  const read = t.mock.method(g.questions, 'read', () => ({ ...record, adaptive: { ...record.adaptive, directory: record.adaptive.directory + '-foreign' } }));
  await assert.rejects(g.gate.afterQuestion(call, status.question, output(status.question, [['Aprobar operación']])), { message: 'Native question or proposed operation generation changed; no authority was consumed.' });
  read.mock.restore();
  assert.equal(g.questions.read('parent').state, 'pending'); assert.equal(g.store.read('parent'), undefined);
});

test('ADM-06-S03: N19 a retained fence refuses start and automatic internal admission until the retried release succeeds', async t => {
  const f = fixture(t, 'automatic'); blockPlugins(f);
  await assert.rejects(f.admit(), SERIAL);
  const mock = t.mock.method(f.runner, 'consumeAdaptiveEntryRejectionInternal', () => 'Injected occupancy.');
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: false, reason: 'Injected occupancy.' });
  assert.equal(await startError(f), BUSY);
  await assert.rejects(f.gate.admitAdaptiveInternal({ contract: f.contract }, f.runtime, 'native-message'), /A native policy intake is pending/);
  mock.mock.restore();
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true });
  assert.notEqual(await startError(f), BUSY);
});

test('ADM-02-S02: N20 a fresh run after reset records only its own question and native user', async t => {
  const f = fixture(t); await orphan(f);
  assert.deepEqual(f.gate.reset(f.runtime, 'run').reset.nativeEntry, { released: true }); unblockPlugins(f);
  await f.admit(); await f.answer(AUTO);
  const saved = f.store.read('parent');
  assert.equal(saved.userMessageID, 'native-user');
  assert.ok(!saved.nativePolicy.questions.some(q => q.callID === 'question-1'));
  assert.deepEqual(saved.nativePolicy.questions.map(q => q.callID), ['question-2']);
});
