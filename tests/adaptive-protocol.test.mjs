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
import { decodeAdaptiveRequest } from '../dist/adaptive-protocol.js';

const wire = (kind, args = {}) => JSON.stringify({ routingVersion: 3, kind, args });
const hash = text => createHash('sha256').update(text).digest('hex');

function fixture(t, mode = 'automatic') {
  const root = mkdtempSync(join(tmpdir(), 'mdd-native-protocol-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'own.txt'), 'before');
  const runtime = { sessionID: 'parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const scope = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
  const contract = { contractVersion: 1, objective: 'Replace only the bounded source.',
    acceptance: { goal: 'Replace bounded source', requirements: [{ id: 'R1', description: 'Replacement', scenarios: [{ id: 'S1', given: 'Original', when: 'Replaced', then: 'Updated' }] }] },
    exclusions: [], decisions: [], productQuestions: [], scope,
    context: { technical: 'understood', dependencies: 'bounded', reason: 'Inspected source.', fingerprints: [{ path: 'own.txt', digest: hash('before') }] },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', path: 'own.txt', description: 'Replace source', scenarios: ['S1'], decisions: [], dependsOn: [], scope,
      obligations: { source: [{ id: 'E1', description: 'Read actual source', paths: ['own.txt'] }], checks: [] } }] };
  const store = new AdaptiveStore(root), questions = new QuestionCheckpointStore(root), ownership = new RunOwnershipStore(root);
  const inspected = [];
  const inspect = { parent: async () => {}, intake: async here => `${here.sessionID}-native-user`,
    question: async (here, call, args) => { assert.equal(here.sessionID, call.sessionID); inspected.push(structuredClone(args)); },
    result: async (_here, _call, _actor, output) => output, stopped: async () => true,
    liveness: async () => ({ verdict: 'stopped', detail: 'Local native runtime harness.' }),
    adaptiveTransferIdle: async () => {}, confirmAdaptiveTransfer: async () => {} };
  const options = { adaptiveStore: store, ownership, progress: new ProgressGuard(root),
    workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true } };
  const settings = defaultSettings();
  if (mode) settings.profiles.default.answers.mode = mode;
  const runner = new PhaseRunner(inspect, options);
  const gate = new NativeIntake(runner, inspect, settings, { questions, ownership });
  const send = (kind, args = {}, here = runtime) => gate.adaptiveInternal(wire(kind, args), here);
  const handle = () => runner.status('parent').selection.handle;
  const select = (extra = {}) => send('select', { handle: handle(), actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Perform the held replacement.', ...extra });
  const entry = () => send('entry', { contract, messageID: 'native-message' });
  let ordinal = 0;
  const answer = async (status, labels = [['Aprobar operación']], here = runtime, answeringGate = gate) => {
    const args = status.question ?? await detail(status.questionRef, here);
    const call = { sessionID: here.sessionID, callID: `native-question-${++ordinal}` };
    await answeringGate.beforeQuestion(call, args);
    await answeringGate.afterQuestion(call, args, { title: `Asked ${args.questions.length} question${args.questions.length === 1 ? '' : 's'}`,
      output: `User has answered your questions: ${args.questions.map((q, i) => `"${q.question}"="${labels[i].length ? labels[i].join(', ') : 'Unanswered'}"`).join(', ')}. You can now continue with the user's answers in mind.`,
      metadata: { answers: labels, truncated: false } });
    return call;
  };
  const detail = async (ref, here = runtime) => {
    let text = '', cursor = ref.args.cursor;
    while (cursor) {
      const page = await send('detail', { cursor }, here);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 46000);
      text += page.text; cursor = page.nextCursor;
    }
    return JSON.parse(text);
  };
  const apply = async (text = 'after', selection = {}) => {
    const status = await select(selection), call = { sessionID: 'parent', callID: `native-child-${++ordinal}` };
    const sent = await runner.before(call, status.task);
    writeFileSync(join(root, 'own.txt'), text);
    await runner.after(call, sent, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Changed only the assigned source.',
      artifact: 'Performed the bounded replacement.', completed: ['A1'], changes: ['own.txt'], checks: [] }));
    return call;
  };
  const evidence = snapshotID => ({ snapshotID,
    readback: { acceptance: contract.acceptance, scope, exclusions: [], decisions: [] },
    inventory: [{ path: 'own.txt', disposition: 'assignment', reason: 'Actual assigned replacement.' }], exclusions: [],
    sources: [{ id: 'E1', paths: ['own.txt'], status: 'verified', assessment: 'Read the actual final replacement.' }],
    assignments: [{ assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Assigned replacement exists.' }],
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1', status: 'verified', sources: ['E1'], checks: [], assessment: 'Final source satisfies the held scenario.' }],
    decisions: [], checks: [], checkResults: [], supplementalChecks: [], limits: [] });
  return { root, runtime, contract, store, questions, ownership, inspect, inspected, options, runner, gate, send, entry, handle, select, answer, detail, apply, evidence };
}

test('AL05b protocol: exact nested input contracts and held IDs are available through canonical references', async t => {
  const f = fixture(t); const status = await f.entry();
  const select = status.operations.find(item => item.kind === 'select');
  const inputs = await f.detail(select.inputRef);
  assert.deepEqual(inputs.operations.select.required, ['handle', 'actor', 'assignmentID', 'purpose']);
  assert.deepEqual(inputs.definitions.context.required, ['technical', 'dependencies', 'reason', 'fingerprints']);
  assert.deepEqual(inputs.definitions.fingerprint.required, ['path', 'digest']);
  assert.deepEqual(inputs.definitions.evidence.required, ['snapshotID', 'readback', 'inventory', 'exclusions', 'sources', 'assignments', 'scenarios', 'decisions', 'checks', 'checkResults', 'supplementalChecks', 'limits']);
  assert.deepEqual(inputs.definitions.scenarioEvidence.required, ['requirementID', 'scenarioID', 'assignmentID', 'status', 'sources', 'checks', 'assessment']);
  assert.deepEqual(inputs.bindings.scenarios, [{ requirementID: 'R1', scenarioID: 'S1', assignmentID: 'A1' }]);
  assert.deepEqual(inputs.bindings.sources, [{ id: 'E1', paths: ['own.txt'], assignmentID: 'A1' }]);
  assert.deepEqual(inputs.bindings.readback.acceptance, f.contract.acceptance);
  assert.ok(status.operations.every(item => item.inputRef));
});

test('AL05b protocol: invalid selection refuses before an interactive policy question or store write', async t => {
  const f = fixture(t, 'interactive'); await f.answer(await f.entry());
  const question = f.questions.read('parent'), record = f.store.read('parent');
  await assert.rejects(f.select({ handle: 'stale-handle' }), /handle/);
  assert.deepEqual(f.questions.read('parent'), question);
  assert.deepEqual(f.store.read('parent'), record);
});

for (const drift of ['source-before', 'source-during', 'epoch-during', 'workspace']) {
  test(`AL05b protocol: pending transfer detail fences ${drift} without consuming consent`, async t => {
    const f = fixture(t, 'interactive'); await f.answer(await f.entry());
    const target = { ...f.runtime, sessionID: 'target' }, source = f.store.read('parent');
    const status = await f.send('transfer', { sourceSessionID: 'parent', runID: source.runID, operationID: 'pending-hop', messageID: 'target-message' }, target);
    const before = f.questions.read('target'), owner = f.ownership.read(source.runID);
    if (drift === 'source-before') writeFileSync(join(f.root, 'own.txt'), 'external change');
    if (drift === 'source-during') f.inspect.parent = async () => { writeFileSync(join(f.root, 'own.txt'), 'external change'); };
    if (drift === 'epoch-during') {
      const read = f.ownership.read.bind(f.ownership); let changed = false;
      f.inspect.parent = async () => { changed = true; };
      t.mock.method(f.ownership, 'read', id => { const current = read(id); return changed && current ? { ...current, epoch: current.epoch + 1 } : current; });
    }
    const here = drift === 'workspace' ? { ...target, worktree: f.root + '-other' } : target;
    await assert.rejects(f.send('detail', status.proposedOperation.args, here), /source|generation|workspace|changed|cursor/i);
    assert.deepEqual(f.questions.read('target'), before);
    assert.equal(f.store.read('target'), undefined);
    if (drift !== 'epoch-during') assert.deepEqual(f.ownership.read(source.runID), owner);
  });
}

test('AL05b protocol: prepared snapshot, complete evidence, explicit repair and honest closure use real runner authority', async t => {
  const f = fixture(t); await f.entry(); await f.apply();
  const prepared = await f.send('prepare', { handle: f.handle() });
  const snapshot = await f.detail(prepared.details.snapshot);
  assert.deepEqual(snapshot.sources, [{ path: 'own.txt', digest: hash('after'), bytes: 5 }]);
  const staleRef = prepared.details.snapshot, failed = f.evidence(snapshot.id);
  failed.sources[0].status = 'not-verified'; failed.assignments[0].status = 'not-verified'; failed.scenarios[0].status = 'not-verified';
  const submitted = await f.send('submit', { handle: f.handle(), evidence: failed });
  assert.equal(submitted.evidence.matched, false);
  await assert.rejects(f.send('close', { handle: f.handle(), outcome: 'verified' }), /evidence|verified/);
  const receiptID = submitted.lastReceipt.id;
  await f.apply('repaired', { repairOf: receiptID });
  await assert.rejects(f.detail(staleRef), /stale|cursor/);
  const repaired = await f.send('prepare', { handle: f.handle() });
  await f.send('submit', { handle: f.handle(), evidence: f.evidence(repaired.evidence.snapshotID) });
  const closed = await f.send('close', { handle: f.handle(), outcome: 'verified' });
  assert.equal(closed.state, 'completed');
  assert.deepEqual(closed.completion, { outcome: 'verified', limits: [] });
  assert.equal(closed.task, undefined);
  assert.deepEqual(closed.operations.map(item => item.kind), ['status', 'detail']);
});

test('AL05b protocol: malformed nested evidence is rejected before questions and leaves prior match/history intact', async t => {
  const f = fixture(t); await f.entry(); await f.apply();
  const prepared = await f.send('prepare', { handle: f.handle() });
  const evidence = f.evidence(prepared.evidence.snapshotID);
  await f.send('submit', { handle: f.handle(), evidence });
  const before = f.store.read('parent'), question = f.questions.read('parent');
  for (const mutate of [e => { e.sources[0].approved = true; }, e => { delete e.scenarios[0].assessment; },
    e => { e.readback.runtime = f.runtime; }, e => { e.checks = [{ id: 'X1', command: 'npm test', exit: false }]; }, e => { delete e.checks; }]) {
    const malformed = structuredClone(evidence); mutate(malformed);
    await assert.rejects(f.send('submit', { handle: f.handle(), evidence: malformed }));
    assert.deepEqual(f.store.read('parent'), before);
    assert.deepEqual(f.questions.read('parent'), question);
  }
});

test('AL05b protocol: stopped recovery retains quarantine until inspected stopped and never retries automatically', async t => {
  const f = fixture(t); await f.entry();
  const selected = await f.select(), call = { sessionID: 'parent', callID: 'interrupted-child' };
  await f.runner.before(call, selected.task);
  f.inspect.liveness = async () => ({ verdict: 'unknown', detail: 'No stopped proof.' });
  let status = await f.send('recover');
  assert.equal(status.state, 'await-result');
  assert.equal(f.store.read('parent').data.receipts.length, 0);
  f.inspect.liveness = async () => ({ verdict: 'stopped', detail: 'Actual stopped child.' });
  status = await f.send('recover');
  assert.equal(status.state, 'await-selection');
  assert.equal(status.lastReceipt.callID, call.callID);
  assert.equal(status.lastReceipt.outcome, 'failed');
  assert.equal(status.task, undefined);
  await f.select({ repairOf: status.lastReceipt.id });
  assert.equal(f.runner.status('parent').state, 'authorized-actor');
});

for (const action of ['finish', 'abort']) test(`AL05b protocol: interrupted transfer exposes exact ${action} contract and fresh native approval`, async t => {
  const f = fixture(t, 'interactive'); await f.answer(await f.entry());
  const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
  const args = { sourceSessionID: 'parent', runID: source.runID, operationID: 'interrupted-hop', messageID: 'target-message' };
  const proposed = await f.send('transfer', args, target);
  assert.deepEqual(await f.detail(proposed.proposedOperation, target), { kind: 'transfer', args });
  const begin = f.ownership.beginAdaptiveTransfer.bind(f.ownership); let fail = true;
  t.mock.method(f.ownership, 'beginAdaptiveTransfer', (...values) => { if (fail) { fail = false; throw new Error('Injected transfer interruption.'); } return begin(...values); });
  await assert.rejects(f.answer(proposed, [['Aprobar operación']], target), /interruption/);
  const status = await f.send('status', {}, target);
  const recovery = status.operations.find(item => item.kind === 'transfer-recovery');
  assert.deepEqual(recovery.required, ['sourceSessionID', 'runID', 'operationID', 'messageID', 'action']);
  assert.equal(recovery.ids.operationID, args.operationID);
  const pending = await f.send('transfer-recovery', { ...args, action, messageID: 'fresh-recovery' }, target);
  await f.answer(pending, [['Aprobar operación']], target);
  assert.equal(f.ownership.read(source.runID).ownerSessionID, action === 'finish' ? 'target' : 'parent');
  if (action === 'finish') {
    const moved = await f.send('status', {}, target);
    assert.equal(moved.mode, 'interactive'); assert.equal(moved.route, 'low');
    await assert.rejects(f.send('status'), /fenced|stale|restore/);
  }
});

test('AL05b protocol: automatic transfer preserves policy without fabricated native consent', async t => {
  const f = fixture(t); await f.entry();
  const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
  const moved = await f.send('transfer', { sourceSessionID: 'parent', runID: source.runID, operationID: 'automatic-hop', messageID: 'target-message' }, target);
  assert.equal(moved.state, 'await-selection'); assert.equal(moved.mode, 'automatic');
  assert.deepEqual(f.store.read('target').nativePolicy.questions, []);
  assert.equal(f.runner.adaptiveNativeGenerationInternal('parent').handle, undefined, 'a former owner has no current selection capability');
});

// A snapshot names each file by digest and size; the file itself stays on disk for any reader.
test('AL05b protocol: a large prepared file is named by digest and size, bounded and snapshot-scoped', async t => {
  const f = fixture(t); const content = '🙂\\"'.repeat(20000);
  await f.entry(); await f.apply(content);
  const status = await f.send('prepare', { handle: f.handle() });
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 46000);
  const snapshot = await f.detail(status.details.snapshot);
  assert.deepEqual(snapshot.sources, [{ path: 'own.txt', digest: hash(content), bytes: Buffer.byteLength(content) }]);
  assert.equal(JSON.stringify(f.store.read('parent').data).includes(content), false, 'the lane record holds no file text');
  assert.equal(readFileSync(join(f.root, 'own.txt'), 'utf8'), content);
  const old = status.details.snapshot;
  await f.send('prepare', { handle: f.handle() });
  await assert.rejects(f.detail(old), /stale|cursor/);
});

for (const request of [wire('entry', { approved: true }), wire('status', { runtime: {} }), wire('recover', { stopped: true }),
  JSON.stringify({ routingVersion: 3, kind: 'status', args: {}, agent: 'mdd-orchestrator' }),
  JSON.stringify({ routingVersion: 3, kind: 'status', args: {}, sessionID: 'parent' }), '{', ' '.repeat(160001)]) {
  test(`AL05b protocol: malformed or spoofed request ${request.slice(0, 90)} refuses before native inspection`, async t => {
    const f = fixture(t, 'interactive');
    f.inspect.parent = async () => assert.fail('Invalid input reached native inspection');
    await assert.rejects(f.gate.adaptiveInternal(request, f.runtime));
    assert.equal(f.questions.read('parent'), undefined); assert.equal(f.store.read('parent'), undefined);
  });
}

test('AL05b protocol: decoder accepts only versioned string data, not serialized native capabilities', () => {
  assert.deepEqual(decodeAdaptiveRequest(wire('recover')), { kind: 'recover', args: {} });
  for (const value of [{ routingVersion: 3, kind: 'recover', args: {} }, wire('recover', { token: {} }), wire('status', { approval: true })])
    assert.throws(() => decodeAdaptiveRequest(value));
});

for (const depth of ['medium', 'high']) test(`AL05b protocol: ${depth} executes actual frozen planning and snapshot-bound Verify before closure`, async t => {
  const f = fixture(t); await f.entry();
  const request = { handle: f.handle(), depth, rationale: 'Structured technical coordination is needed.',
    assessment: { assessmentVersion: 1, complexity: depth, impact: 'low' }, context: f.contract.context };
  let status = await f.send('escalate', request);
  const assignment = f.contract.assignments[0];
  const deliverables = [{ id: assignment.id, description: assignment.description, path: assignment.path, scenarios: assignment.scenarios,
    decisions: [], dependsOn: [], parallel: assignment.scope, checks: [{ id: 'C1', command: 'node --check own.txt', requirement: 'required' }] }];
  const stages = depth === 'medium' ? [['mdd-plan', { acceptance: f.contract.acceptance, decisions: [], deliverables }]] :
    [['mdd-propose', {}], ['mdd-spec', { domain: 'project', acceptance: f.contract.acceptance }], ['mdd-design', { decisions: [] }], ['mdd-tasks', { deliverables }]];
  let ordinal = 0;
  for (const [actor, fields] of stages) {
    assert.equal(status.route, depth); assert.equal(status.continuation.next, actor);
    const descriptor = status.operations.find(item => item.kind === 'select');
    assert.deepEqual(descriptor.ids.actor, [actor]);
    const selected = await f.select({ actor });
    const call = { sessionID: 'parent', callID: `planning-${depth}-${++ordinal}` };
    const args = await f.runner.before(call, selected.task);
    await f.runner.after(call, args, JSON.stringify({ verificationVersion: 1, outcome: 'passed', evidenceSummary: 'Actual structured stage.', artifact: 'Actual held stage report.', ...fields }));
    status = await f.send('status');
    assert.equal(status.lastReceipt.outcome, 'passed');
  }
  const held = await f.detail(status.details.held);
  assert.deepEqual(held.contract.assignments[0].obligations.checks, deliverables[0].checks);
  assert.deepEqual(held.data.continuation.reports.at(-1).fields.deliverables, deliverables);
  assert.deepEqual(held.data.receipts.at(-1).accepted.fields.deliverables, deliverables);
  await f.apply();
  status = await f.send('status');
  assert.equal(status.continuation.next, 'mdd-verify');
  assert.equal(status.next.internal, 'prepare', 'Verify cannot be selected before real parent evidence');
  const prepared = await f.send('prepare', { handle: f.handle() });
  const evidence = f.evidence(prepared.evidence.snapshotID);
  evidence.checks = [{ id: 'X1', command: 'node --check own.txt', exit: 0 }];
  evidence.checkResults = [{ checkID: 'C1', disposition: 'passed', executions: ['X1'] }];
  await f.send('submit', { handle: f.handle(), evidence });
  const selected = await f.select({ actor: 'mdd-verify' }), call = { sessionID: 'parent', callID: `verify-${depth}` };
  const sent = await f.runner.before(call, selected.task);
  assert.deepEqual(f.store.read('parent').data.pending.verifyContext, { snapshotID: evidence.snapshotID, checks: evidence.checks });
  const verification = { scenarios: [{ requirementID: 'R1', scenarioID: 'S1', stepID: 'A1', status: 'verified', checks: ['X1'], assessment: 'Actual final source satisfies the held scenario.' }],
    steps: [{ stepID: 'A1', status: 'verified', checks: ['X1'], assessment: 'Actual assigned replacement.' }], decisions: [],
    changes: 'The held replacement is present.', limits: [], checkResults: evidence.checkResults, supplementalChecks: [] };
  await f.runner.after(call, sent, JSON.stringify({ verificationVersion: 1, outcome: 'passed', evidenceSummary: 'Actual snapshot review.', artifact: 'Reviewed held acceptance and actual command history.', checks: evidence.checks, verification }));
  status = await f.send('status');
  assert.equal(status.lastReceipt.outcome, 'passed');
  assert.equal(status.next.internal, 'close');
  assert.equal(status.operations.some(item => item.kind === 'select'), false, 'completed continuation never advertises ordinary low actors');
  assert.deepEqual(f.store.read('parent').data.receipts.at(-1).accepted.verifyContext, { snapshotID: evidence.snapshotID, checks: evidence.checks });
  assert.equal((await f.send('close', { handle: f.handle(), outcome: 'verified' })).state, 'completed');
});

test('AL05b protocol: repair selector names only the latest actual Apply receipt for each assignment', async t => {
  const f = fixture(t); await f.entry();
  const fail = async repairOf => {
    const selected = await f.select(repairOf ? { repairOf } : {}), call = { sessionID: 'parent', callID: repairOf ? 'failed-second' : 'failed-first' };
    const args = await f.runner.before(call, selected.task);
    await f.runner.after(call, args, JSON.stringify({ outcome: 'failed', evidenceSummary: 'Stopped without edits.', artifact: 'No completion claimed.', completed: [], changes: [], noChangeReason: 'Stopped.', checks: [] }));
    return (await f.send('status')).lastReceipt.id;
  };
  const first = await fail(), second = await fail(first), status = await f.send('status');
  assert.deepEqual(status.operations.find(item => item.kind === 'select').ids.repairOf, [second]);
  await assert.rejects(f.select({ repairOf: first }), /latest|last actual/);
});

test('AL05b protocol: missing mode asks only its native question and actor clarification retains actual answers', async t => {
  const f = fixture(t, undefined); // fixture default is automatic; explicitly clear the frozen profile below through a fresh gate.
  const settings = defaultSettings(), gate = new NativeIntake(f.runner, f.inspect, settings, { questions: f.questions, ownership: f.ownership });
  const send = (kind, args = {}) => gate.adaptiveInternal(wire(kind, args), f.runtime);
  const pending = await send('entry', { contract: f.contract, messageID: 'native-message' });
  assert.equal(pending.question.questions.length, 1); assert.equal(pending.question.questions[0].header, 'Modo');
  const call = { sessionID: 'parent', callID: 'native-mode' }, args = pending.question;
  await gate.beforeQuestion(call, args);
  await gate.afterQuestion(call, args, { title: 'Asked 1 question',
    output: `User has answered your questions: "${args.questions[0].question}"="Automático". You can now continue with the user's answers in mind.`, metadata: { answers: [['Automático']], truncated: false } });
  let status = await send('status'); assert.equal(status.mode, 'automatic');
  const selected = await send('select', { handle: status.handle, actor: 'mdd-explore', assignmentID: 'A1', purpose: 'Inspect a held decision.' });
  const child = { sessionID: 'parent', callID: 'native-clarifying-child' }, sent = await f.runner.before(child, selected.task);
  await f.runner.after(child, sent, JSON.stringify({ outcome: 'passed', evidenceSummary: 'A bounded choice is needed.', artifact: 'Read held source.',
    questions: [{ question: 'Keep the held format?', why: 'Clarify without scope expansion.', options: [{ label: 'Keep', description: 'Retain the held format.' }] }] }));
  status = await send('status'); const descriptor = status.operations.find(item => item.kind === 'questions');
  const question = await send('questions', descriptor.ids), reply = { sessionID: 'parent', callID: 'native-product-answer' };
  await gate.beforeQuestion(reply, question.question);
  await gate.afterQuestion(reply, question.question, { title: 'Asked 1 question',
    output: `User has answered your questions: "${question.question.questions[0].question}"="Keep". You can now continue with the user's answers in mind.`, metadata: { answers: [['Keep']], truncated: false } });
  assert.deepEqual(f.store.read('parent').data.questionAnswers[0].native.answer, [['Keep']]);
  assert.deepEqual(f.store.read('parent').data.contract, f.contract);
});

test('AL05b protocol: native parent rejection happens before preparing any interactive question', async t => {
  const f = fixture(t, 'interactive');
  f.inspect.parent = async () => { throw new Error('Native host rejected coordinator context.'); };
  await assert.rejects(f.entry(), /Native host rejected/);
  assert.equal(f.questions.read('parent'), undefined);
  assert.equal(f.store.read('parent'), undefined);
});

test('AL05b protocol: large canonical product choices and proposed operation survive reference readback unchanged', async t => {
  const f = fixture(t); f.contract.productQuestions = ['Which held format?'];
  const options = [{ label: 'Keep '.repeat(1500), description: 'Retain the exact original format. '.repeat(600) }];
  const questions = [{ question: f.contract.productQuestions[0], why: 'Choose within the held scope.', options }];
  const status = await f.send('entry', { contract: f.contract, messageID: 'native-message', questions });
  assert.equal(status.question, undefined); assert.ok(status.questionRef);
  assert.ok(Buffer.byteLength(JSON.stringify(status)) <= 46000);
  const canonical = await f.detail(status.questionRef), proposed = await f.detail(status.proposedOperation);
  assert.deepEqual(canonical.questions[0].options, options);
  assert.deepEqual(proposed, decodeAdaptiveRequest(wire('entry', { contract: f.contract, messageID: 'native-message', questions })));
  const before = f.questions.read('parent');
  await f.send('status'); assert.deepEqual(f.questions.read('parent'), before);
  await f.answer(status, [[options[0].label]]);
  assert.equal((await f.send('status')).state, 'await-contract');
  assert.equal(f.store.read('parent'), undefined, 'clarification never invents immutable admission');
});

test('AL05b protocol: cold recovery rotates generation and rejects old detail and callbacks', async t => {
  const f = fixture(t); await f.entry();
  const status = await f.send('status'), selected = await f.select();
  const call = { sessionID: 'parent', callID: 'cold-interrupted' }, args = await f.runner.before(call, selected.task);
  const cold = new PhaseRunner(f.inspect, f.options);
  const restored = await cold.restore(f.runtime);
  assert.equal(restored.restored, false); assert.match(restored.reason, /quarantined/);
  const settings = defaultSettings(); settings.profiles.default.answers.mode = 'automatic';
  const gate = new NativeIntake(cold, f.inspect, settings, { questions: f.questions, ownership: f.ownership });
  await assert.rejects(gate.adaptiveInternal(wire('detail', status.details.journal.args), f.runtime), /cursor|stale/);
  await assert.rejects(f.runner.after(call, args, '{}'), /stale|publication|authority/);
  const recovered = await gate.adaptiveInternal(wire('recover'), f.runtime);
  assert.equal(recovered.state, 'await-selection'); assert.equal(recovered.lastReceipt.callID, call.callID);
  assert.equal(recovered.lastReceipt.outcome, 'failed'); assert.equal(recovered.task, undefined);
});

test('AL05b protocol: source drift is disclosed read-only rather than projecting a stale verified match', async t => {
  const f = fixture(t); await f.entry(); await f.apply();
  const prepared = await f.send('prepare', { handle: f.handle() });
  await f.send('submit', { handle: f.handle(), evidence: f.evidence(prepared.evidence.snapshotID) });
  const saved = f.store.read('parent'); writeFileSync(join(f.root, 'own.txt'), 'external drift');
  const status = await f.send('status');
  assert.equal(status.evidence.recordedMatch, true); assert.equal(status.evidence.matched, false);
  assert.deepEqual(status.evidence.gaps.staleAssignments, ['A1']);
  assert.deepEqual(status.operations.find(item => item.kind === 'close').ids.outcome, ['unverified']);
  assert.deepEqual(f.store.read('parent'), saved, 'ordinary read cannot rewrite completion or consume policy authority');
});

for (const mode of ['automatic', 'interactive']) for (const action of ['finish', 'abort']) for (const cold of [false, true]) {
  test(`AL05b protocol: ${mode} ${action} recovers published target data ${cold ? 'after restart' : 'in process'} without restoring dispatch`, async t => {
    const f = fixture(t, mode), entry = await f.entry();
    if (mode === 'interactive') await f.answer(entry);
    const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
    const args = { sourceSessionID: 'parent', runID: source.runID, operationID: 'published-hop', messageID: 'native-transfer' };
    const finish = f.ownership.finishAdaptiveTransfer.bind(f.ownership); let fail = true;
    t.mock.method(f.ownership, 'finishAdaptiveTransfer', (...values) => { if (fail) { fail = false; throw new Error('Injected published-target interruption.'); } return finish(...values); });
    if (mode === 'automatic') await assert.rejects(f.send('transfer', args, target), /published-target/);
    else await assert.rejects(f.answer(await f.send('transfer', args, target), [['Aprobar operación']], target), /published-target/);
    assert.ok(f.store.read('target'));
    assert.equal(f.ownership.read(source.runID).state, 'transferring');
    const settings = defaultSettings(); settings.profiles.default.answers.mode = mode;
    const gate = cold ? new NativeIntake(new PhaseRunner(f.inspect, f.options), f.inspect, settings, { questions: f.questions, ownership: f.ownership }) : f.gate;
    const status = await gate.adaptiveInternal(wire('status'), target);
    assert.equal(status.task, undefined); assert.equal(status.handle, undefined);
    const recovery = status.operations.find(item => item.kind === 'transfer-recovery');
    assert.equal(recovery.ids.sourceSessionID, 'parent'); assert.equal(recovery.ids.operationID, args.operationID);
    const pending = await gate.adaptiveInternal(wire('transfer-recovery', { ...args, action, messageID: 'fresh-target-recovery' }), target);
    if (mode === 'interactive') await f.answer(pending, [['Aprobar operación']], target, gate);
    assert.equal(f.ownership.read(source.runID).ownerSessionID, action === 'finish' ? 'target' : 'parent');
    assert.equal(f.store.read('target') === undefined, action === 'abort');
  });
}

test('AL05b protocol: unloaded source generation has stable declared-byte proof but no invented selection handle', async t => {
  const f = fixture(t); await f.entry();
  const cold = new PhaseRunner(f.inspect, f.options);
  const first = cold.adaptiveNativeGenerationInternal('parent'), second = cold.adaptiveNativeGenerationInternal('parent');
  assert.equal(first.handle, undefined);
  assert.deepEqual(first, second);
  assert.deepEqual(first.sources, [{ path: 'own.txt', digest: hash('before') }]);
});

// The 24000-byte contract, 12000-byte objective and 16-entry prose lists made coordinators abbreviate
// what the user reads in the approval. None of them protected anything the request bound does not.
test('regression: a long objective, many exclusions and full prose are admitted without a byte budget', async t => {
  const f = fixture(t, 'interactive');
  f.contract.objective = 'Reemplazá el texto del archivo indicado y conservá todo lo demás tal como está. '.repeat(200);
  f.contract.exclusions = Array.from({ length: 20 }, (_, index) => `No se modifica la sección ${index + 1} del documento.`);
  f.contract.assignments[0].description = 'Reemplaza el texto del archivo asignado, explicado en oraciones completas. '.repeat(400);
  assert.ok(Buffer.byteLength(f.contract.objective) > 12000, 'the objective is past the old 12000-byte cap');
  assert.ok(Buffer.byteLength(JSON.stringify(f.contract)) > 24000, 'the contract is past the old 24000-byte budget');
  await f.answer(await f.entry(), [['Aprobar operación']]);
  const held = f.store.read('parent').data.contract;
  assert.equal(held.objective, f.contract.objective);
  assert.equal(held.exclusions.length, 20);
  assert.equal(held.assignments[0].description, f.contract.assignments[0].description.trim());
});

test('regression: evidence past the old 48000-byte budget is accepted whole', async t => {
  const f = fixture(t); await f.entry(); await f.apply();
  const prepared = await f.send('prepare', { handle: f.handle() }), evidence = f.evidence(prepared.evidence.snapshotID);
  evidence.sources[0].assessment = 'Leí el archivo final y confirmé el reemplazo pedido, línea por línea. '.repeat(1000);
  evidence.limits = Array.from({ length: 20 }, (_, index) => `Límite ${index + 1}: no se revisó en un dispositivo real.`);
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) > 48000);
  await f.send('submit', { handle: f.handle(), evidence });
  const report = f.store.read('parent').data.report;
  assert.equal(report.sources[0].assessment, evidence.sources[0].assessment.trim());
  assert.equal(report.limits.length, 20);
});

// Contract lists have no entry count: 70 scenarios, 40 assignments and 140 declared files are admitted,
// an interactive selection binds every declared file, and status still fits its budget.
test('regression: a contract past the old 64-scenario, 32-assignment and 64-path counts is admitted', async t => {
  const f = fixture(t, 'interactive');
  const reads = Array.from({ length: 100 }, (_, i) => `r${i + 1}.txt`), writes = Array.from({ length: 40 }, (_, i) => `w${i + 1}.txt`);
  for (const path of reads) writeFileSync(join(f.root, path), `read ${path}`);
  const scenarios = Array.from({ length: 70 }, (_, i) => ({ id: `S${i + 1}`, given: `Estado ${i + 1}`, when: 'Se aplica el cambio', then: `Resultado ${i + 1}` }));
  f.contract.acceptance = { goal: 'Un cambio grande', requirements: [{ id: 'R1', description: 'Un cambio grande', scenarios }] };
  f.contract.scope = { complete: true, reads, writes };
  f.contract.context.fingerprints = [...reads.map(path => ({ path, digest: hash(`read ${path}`) })), ...writes.map(path => ({ path, digest: null }))];
  f.contract.assignments = writes.map((path, i) => ({ id: `A${i + 1}`, path, description: `Escribe ${path}`,
    scenarios: [`S${i + 1}`, ...(i + 41 <= 70 ? [`S${i + 41}`] : [])], decisions: [], dependsOn: [],
    scope: { complete: true, reads: ['r1.txt'], writes: [path] },
    obligations: { source: [{ id: `E${i + 1}`, description: 'Lee el archivo final', paths: [path] }], checks: [] } }));
  const proposed = await f.entry();
  assert.ok(Buffer.byteLength(JSON.stringify(proposed)) <= 46000);
  await f.answer(proposed, [['Aprobar operación']]);
  const held = f.store.read('parent').data.contract;
  assert.equal(held.assignments.length, 40);
  assert.equal(held.acceptance.requirements[0].scenarios.length, 70);
  const selected = await f.send('select', { handle: f.handle(), actor: 'mdd-apply', assignmentID: 'A1', purpose: 'Escribir el primer archivo.' });
  assert.ok(Buffer.byteLength(JSON.stringify(selected)) <= 46000);
  assert.equal(f.questions.read('parent').adaptive.generation.sources.length, 140);
  await f.answer(selected, [['Aprobar operación']]);
  assert.ok(f.runner.status('parent').task, 'the approved selection is ready to dispatch');
});

test('regression: a source file past the old 256 KiB inspection cap is fingerprinted and admitted', async t => {
  const f = fixture(t);
  const large = 'línea de código\n'.repeat(20000);
  assert.ok(Buffer.byteLength(large) > 256 * 1024);
  writeFileSync(join(f.root, 'own.txt'), large);
  f.contract.context.fingerprints = [{ path: 'own.txt', digest: hash(large) }];
  await f.entry();
  assert.equal(f.store.read('parent').data.contract.context.fingerprints[0].digest, hash(large));
});

test('AL05b protocol: incorrect actual actor-question IDs do not replace the held intake state', async t => {
  const f = fixture(t); await f.entry();
  const selected = await f.select({ actor: 'mdd-explore' }), call = { sessionID: 'parent', callID: 'held-question-child' };
  const args = await f.runner.before(call, selected.task);
  await f.runner.after(call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'A native product answer is needed.', artifact: 'Inspected held source.',
    questions: [{ question: 'Keep the held format?', why: 'Clarify a bounded decision.', options: [{ label: 'Keep', description: 'Retain held scope.' }] }] }));
  const before = await f.send('status'), pending = before.operations.find(item => item.kind === 'questions');
  const record = f.store.read('parent'), question = f.questions.read('parent');
  await assert.rejects(f.send('questions', { ...pending.ids, receiptID: 'foreign-receipt' }), /receipt|question/i);
  assert.equal((await f.send('status')).state, before.state);
  assert.deepEqual(f.store.read('parent'), record); assert.deepEqual(f.questions.read('parent'), question);
});

for (const mode of ['automatic', 'interactive']) for (const cold of [false, true]) {
  test(`AL05b protocol: ${mode} completed ownership without a loaded target needs fresh native finish ${cold ? 'after restart' : 'in process'}`, async t => {
    const f = fixture(t, mode), entry = await f.entry();
    if (mode === 'interactive') await f.answer(entry);
    const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
    const args = { sourceSessionID: 'parent', runID: source.runID, operationID: 'committed-hop', messageID: 'native-transfer' };
    const finish = f.ownership.finishAdaptiveTransfer.bind(f.ownership); let fail = true;
    t.mock.method(f.ownership, 'finishAdaptiveTransfer', (...values) => { const result = finish(...values); if (fail) { fail = false; throw new Error('Injected after ownership commit.'); } return result; });
    if (mode === 'automatic') await assert.rejects(f.send('transfer', args, target), /ownership commit/);
    else await assert.rejects(f.answer(await f.send('transfer', args, target), [['Aprobar operación']], target), /ownership commit/);
    const settings = defaultSettings(); settings.profiles.default.answers.mode = mode;
    const gate = cold ? new NativeIntake(new PhaseRunner(f.inspect, f.options), f.inspect, settings, { questions: f.questions, ownership: f.ownership }) : f.gate;
    const status = await gate.adaptiveInternal(wire('status'), target);
    assert.equal(status.task, undefined); assert.equal(status.handle, undefined);
    assert.deepEqual(status.operations.find(item => item.kind === 'transfer-recovery').ids.action, ['finish']);
    const pending = await gate.adaptiveInternal(wire('transfer-recovery', { ...args, action: 'finish', messageID: 'fresh-finish-message' }), target);
    if (mode === 'interactive') await f.answer(pending, [['Aprobar operación']], target, gate);
    const ready = await gate.adaptiveInternal(wire('status'), target);
    assert.equal(ready.state, 'await-selection'); assert.ok(ready.handle);
    assert.equal(f.ownership.read(source.runID).ownerSessionID, 'target');
  });
}

for (const mode of ['automatic', 'interactive']) for (const action of ['finish', 'abort']) for (const boundary of ['claim', 'source-fence']) {
  test(`AL05b protocol: cold ${mode} ${action} discovers the exact ${boundary} recovery before target publication`, async t => {
    const f = fixture(t, mode), entry = await f.entry();
    if (mode === 'interactive') await f.answer(entry);
    const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
    const args = { sourceSessionID: 'parent', runID: source.runID, operationID: 'claimed-hop', messageID: 'native-transfer' };
    const method = boundary === 'claim' ? 'beginAdaptiveTransfer' : 'publishAdaptiveTransfer', original = f.ownership[method].bind(f.ownership); let fail = true;
    t.mock.method(f.ownership, method, (...values) => { if (fail) { fail = false; throw new Error('Injected before target publication.'); } return original(...values); });
    if (mode === 'automatic') await assert.rejects(f.send('transfer', args, target), /before target publication/);
    else await assert.rejects(f.answer(await f.send('transfer', args, target), [['Aprobar operación']], target), /before target publication/);
    assert.equal(f.store.read('target'), undefined);
    const settings = defaultSettings(); settings.profiles.default.answers.mode = mode;
    const gate = new NativeIntake(new PhaseRunner(f.inspect, f.options), f.inspect, settings, { questions: f.questions, ownership: f.ownership });
    const status = await gate.adaptiveInternal(wire('status'), target);
    assert.equal(status.handle, undefined); assert.equal(status.task, undefined);
    const recovery = status.operations.find(item => item.kind === 'transfer-recovery');
    assert.equal(recovery.ids.operationID, args.operationID); assert.equal(recovery.ids.sourceSessionID, 'parent');
    const pending = await gate.adaptiveInternal(wire('transfer-recovery', { ...args, action, messageID: 'fresh-recovery' }), target);
    if (mode === 'interactive') await f.answer(pending, [['Aprobar operación']], target, gate);
    assert.equal(f.ownership.read(source.runID).ownerSessionID, action === 'finish' ? 'target' : 'parent');
  });
}

for (const mode of ['automatic', 'interactive']) for (const boundary of ['before-retirement', 'after-source-rotation']) {
  test(`AL05b protocol: cold ${mode} abort resumes only its exact ${boundary} cleanup reservation`, async t => {
    const f = fixture(t, mode), entry = await f.entry(); if (mode === 'interactive') await f.answer(entry);
    const source = f.store.read('parent'), target = { ...f.runtime, sessionID: 'target' };
    const args = { sourceSessionID: 'parent', runID: source.runID, operationID: 'abort-hop', messageID: 'native-transfer' };
    const finish = f.ownership.finishAdaptiveTransfer.bind(f.ownership); let failTransfer = true;
    t.mock.method(f.ownership, 'finishAdaptiveTransfer', (...values) => { if (failTransfer) { failTransfer = false; throw new Error('Injected publication stop.'); } return finish(...values); });
    if (mode === 'automatic') await assert.rejects(f.send('transfer', args, target), /publication stop/);
    else await assert.rejects(f.answer(await f.send('transfer', args, target), [['Aprobar operación']], target), /publication stop/);
    const method = boundary === 'before-retirement' ? 'retireIf' : 'commit', original = f.store[method].bind(f.store); let failAbort = true;
    t.mock.method(f.store, method, (...values) => {
      if (failAbort && (method === 'retireIf' || values[0] === 'parent')) {
        failAbort = false;
        if (method === 'commit') original(...values);
        throw new Error('Injected abort cleanup interruption.');
      }
      return original(...values);
    });
    const abort = { ...args, action: 'abort', messageID: 'native-abort' };
    if (mode === 'automatic') await assert.rejects(f.send('transfer-recovery', abort, target), /abort cleanup/);
    else await assert.rejects(f.answer(await f.send('transfer-recovery', abort, target), [['Aprobar operación']], target), /abort cleanup/);
    assert.ok(f.ownership.read(source.runID).recoveringTransfer);
    const interruptedQuestion = f.questions.read('target');
    const settings = defaultSettings(); settings.profiles.default.answers.mode = mode;
    const gate = new NativeIntake(new PhaseRunner(f.inspect, f.options), f.inspect, settings, { questions: f.questions, ownership: f.ownership });
    const status = await gate.adaptiveInternal(wire('status'), target);
    assert.equal(status.handle, undefined); assert.equal(status.task, undefined);
    assert.deepEqual(status.operations.find(item => item.kind === 'transfer-recovery').ids.action, ['abort']);
    const pending = await gate.adaptiveInternal(wire('transfer-recovery', { ...abort, messageID: 'fresh-abort' }), target);
    if (mode === 'interactive') {
      assert.equal(pending.state, 'question-ready'); assert.equal(f.ownership.read(source.runID).state, 'reserved');
      const freshQuestion = f.questions.read('target');
      await assert.rejects(gate.beforeQuestion({ sessionID: 'target', callID: interruptedQuestion.callID }, interruptedQuestion.slot.args), /envelope|stale|retired/);
      assert.deepEqual(f.questions.read('target'), freshQuestion, 'old consent cannot answer the fresh proposal');
      const read = f.ownership.read.bind(f.ownership);
      const stale = t.mock.method(f.ownership, 'read', id => { const current = read(id); return current ? { ...current, epoch: current.epoch + 1 } : current; });
      await assert.rejects(gate.beforeQuestion({ sessionID: 'target', callID: 'stale-new-proposal' }, pending.question), /generation|changed/);
      stale.mock.restore();
      assert.deepEqual(f.questions.read('target'), freshQuestion, 'stale proposal cannot publish a pending question');
      await f.answer(pending, [['Aprobar operación']], target, gate);
    }
    assert.equal(f.ownership.read(source.runID).state, 'idle');
    assert.equal(f.ownership.read(source.runID).ownerSessionID, 'parent');
    assert.equal(f.store.read('target'), undefined);
  });
}

for (const depth of ['medium', 'high']) for (const gap of ['failed', 'stale']) {
  test(`AL05b descriptor repair: ${depth} ${gap} parent proof exposes only eligible receipt-bound repair before fresh Verify`, async t => {
    const f = fixture(t), own = { complete: true, reads: ['own.txt'], writes: ['own.txt'] };
    writeFileSync(join(f.root, 'other.txt'), 'before');
    f.contract.scope.reads.push('other.txt'); f.contract.scope.writes.push('other.txt');
    f.contract.context.fingerprints.push({ path: 'other.txt', digest: hash('before') });
    f.contract.assignments[0].scope = own;
    f.contract.assignments.push({ ...structuredClone(f.contract.assignments[0]), id: 'A2', path: 'other.txt',
      scope: { complete: true, reads: ['other.txt'], writes: ['other.txt'] },
      obligations: { source: [{ id: 'E2', description: 'Read retained source', paths: ['other.txt'] }], checks: [] } });
    let status = await f.entry(), ordinal = 0;
    const dispatch = async (selected, fields, edit) => {
      const call = { sessionID: 'parent', callID: `descriptor-${depth}-${gap}-${++ordinal}` };
      const args = await f.runner.before(call, selected.task);
      if (edit) writeFileSync(join(f.root, edit.path), edit.content);
      await f.runner.after(call, args, JSON.stringify({ outcome: 'passed', evidenceSummary: 'Actual held work in the native runtime harness.', artifact: 'Bounded source and report evidence.', ...fields }));
      const current = await f.send('status');
      assert.equal(current.lastReceipt.outcome, 'passed', f.store.read('parent').data.receipts.at(-1).failure);
      return current;
    };
    const select = (current, actor, assignmentID) => {
      const descriptor = current.operations.find(item => item.kind === 'select' && item.ids.actor.includes(actor));
      assert.ok(descriptor); assert.ok(descriptor.ids.assignmentID.includes(assignmentID));
      return f.send(descriptor.kind, { handle: descriptor.ids.handle, actor, assignmentID, purpose: 'Perform only the published held assignment.' });
    };
    status = await dispatch(await select(status, 'mdd-apply', 'A2'), { completed: ['A2'], changes: ['other.txt'], checks: [] }, { path: 'other.txt', content: 'retained' });
    status = await f.send('escalate', { handle: status.handle, depth, rationale: 'Remaining coordination needs a structured continuation.',
      assessment: { assessmentVersion: 1, complexity: depth, impact: 'low' },
      context: { ...f.contract.context, fingerprints: [{ path: 'own.txt', digest: hash('before') }, { path: 'other.txt', digest: hash('retained') }] } });
    const held = await f.detail(status.details.contract), assignment = held.assignments.find(item => item.id === 'A1');
    const deliverables = [{ id: assignment.id, description: assignment.description, path: assignment.path, scenarios: assignment.scenarios,
      decisions: [], dependsOn: [], parallel: assignment.scope, checks: [{ id: 'C1', command: 'node --check own.txt', requirement: 'required' }] }];
    const stages = depth === 'medium' ? [['mdd-plan', { acceptance: held.acceptance, decisions: held.decisions, deliverables }]] :
      [['mdd-propose', {}], ['mdd-spec', { domain: 'project', acceptance: held.acceptance }], ['mdd-design', { decisions: held.decisions }], ['mdd-tasks', { deliverables }]];
    for (const [actor, fields] of stages) status = await dispatch(await select(status, actor, assignment.id), { verificationVersion: 1, ...fields });
    status = await dispatch(await select(status, 'mdd-apply', assignment.id), { completed: [assignment.id], changes: [assignment.path], checks: [] }, { path: assignment.path, content: 'implemented' });
    const prepare = current => {
      const descriptor = current.operations.find(item => item.kind === 'prepare');
      return f.send(descriptor.kind, { handle: descriptor.ids.handle });
    };
    const evidence = async (prepared, executions, failed = false) => {
      const descriptor = prepared.operations.find(item => item.kind === 'submit'), inputs = await f.detail(descriptor.inputRef);
      const bindings = inputs.bindings, finding = assignmentID => ({ status: failed && assignmentID === assignment.id ? 'not-verified' : 'verified',
        sources: bindings.sources.filter(source => source.assignmentID === assignmentID).map(source => source.id), checks: [], assessment: 'Read the actual declared final source.' });
      return { snapshotID: descriptor.ids.snapshotID, readback: bindings.readback,
        inventory: bindings.readback.scope.writes.map(path => ({ path, disposition: 'assignment', reason: 'Actual held replacement.' })), exclusions: [],
        sources: bindings.sources.map(source => ({ id: source.id, paths: source.paths, status: finding(source.assignmentID).status, assessment: 'Inspected this exact source obligation.' })),
        assignments: bindings.assignments.map(item => ({ assignmentID: item.id, ...finding(item.id) })),
        scenarios: bindings.scenarios.map(item => ({ ...item, ...finding(item.assignmentID) })), decisions: [],
        checks: executions.map(id => ({ id, command: bindings.assignments.flatMap(item => item.obligations.checks)[0].command, exit: 0 })),
        checkResults: [{ checkID: 'C1', disposition: 'passed', executions, ...(executions.length > 1 ? { reason: 'Reported a fresh execution after the new snapshot.' } : {}) }], supplementalChecks: [], limits: [] };
    };
    const submit = (prepared, report) => {
      const descriptor = prepared.operations.find(item => item.kind === 'submit');
      return f.send(descriptor.kind, { handle: descriptor.ids.handle, evidence: report });
    };
    const verify = async (current, report) => {
      const inputs = await f.detail(current.operations.find(item => item.kind === 'select').inputRef);
      const finding = { status: 'verified', checks: [report.checks.at(-1).id], assessment: 'Read current source and the actual reported check history.' };
      return dispatch(await select(current, 'mdd-verify', assignment.id), { verificationVersion: 1, checks: report.checks,
        verification: { scenarios: inputs.bindings.scenarios.map(({ requirementID, scenarioID, assignmentID: stepID }) => ({ requirementID, scenarioID, stepID, ...finding })),
          steps: inputs.bindings.assignments.map(item => ({ stepID: item.id, ...finding })), decisions: [], changes: 'Reviewed both bounded replacements.', limits: [],
          checkResults: report.checkResults, supplementalChecks: [] } });
    };
    let prepared = await prepare(status), report = await evidence(prepared, ['X1']);
    status = await verify(await submit(prepared, report), report);
    assert.equal(f.store.read('parent').data.receipts.filter(item => item.actor === 'mdd-verify').length, 1);
    prepared = await prepare(status);
    assert.equal(prepared.operations.some(item => item.variant === 'repair'), false, 'preparing evidence never automatically reopens healthy completed writers');
    report = await evidence(prepared, ['X1', 'X2'], gap === 'failed');
    status = await submit(prepared, report);
    if (gap === 'stale') { writeFileSync(join(f.root, assignment.path), 'external drift'); status = await f.send('status'); }
    assert.equal(status.continuation.next, 'mdd-verify'); assert.equal(status.evidence.matched, false);
    const actual = f.store.read('parent').data, receipt = actual.receipts.findLast(item => item.actor === 'mdd-apply' && item.assignmentID === assignment.id);
    const currentContext = { ...actual.context, reason: 'Reinspected the exact bounded source for repair.',
      fingerprints: actual.context.fingerprints.map(file => ({ path: file.path, digest: hash(readFileSync(join(f.root, file.path))) })) };
    // Read-only oracle confirms the premise. The actual caller below constructs its repair only from published descriptors/details.
    assert.doesNotThrow(() => f.runner.validateAdaptiveProtocolInternal({ kind: 'select', args: { handle: status.handle, actor: 'mdd-apply',
      assignmentID: assignment.id, purpose: 'Validate existing model repair eligibility without authorizing it.', repairOf: receipt.id, context: currentContext } }, f.runtime));
    const repair = status.operations.find(item => item.kind === 'select' && item.variant === 'repair');
    assert.ok(repair, 'the real model permits this completed repair, so the protocol must publish its exact input contract');
    assert.deepEqual(repair.ids.actor, ['mdd-apply']); assert.deepEqual(repair.repairs, [{ assignmentID: assignment.id, repairOf: receipt.id }]);
    assert.equal(status.next.internal, repair.kind); assert.equal(status.next.variant, repair.variant);
    assert.ok(status.operations.filter(item => item.kind === 'select').every(item => !item.ids.actor.includes('mdd-verify')));
    const context = await f.detail(repair.contextRef);
    const repairArgs = { handle: repair.ids.handle, actor: repair.ids.actor[0], ...repair.repairs[0], purpose: 'Correct only the published failed or stale assignment.',
      context: { ...context.current, reason: 'Reinspected the exact bounded source for this repair.' } };
    for (const key of repair.required) assert.ok(Object.hasOwn(repairArgs, key));
    const before = f.store.read('parent');
    for (const [label, change] of [['missing receipt', args => { delete args.repairOf; }], ['forged receipt', args => { args.repairOf = 'forged-receipt'; }],
      ['missing current context', args => { delete args.context; }], ['forged current context', args => { args.context.fingerprints[0].digest = 'f'.repeat(64); }]]) {
      const invalid = structuredClone(repairArgs); change(invalid);
      await assert.rejects(f.send(repair.kind, invalid), undefined, label); assert.deepEqual(f.store.read('parent'), before);
    }
    status = await dispatch(await f.send(repair.kind, repairArgs), { completed: [repairArgs.assignmentID], changes: [assignment.path], checks: [] }, { path: assignment.path, content: 'repaired' });
    assert.equal(readFileSync(join(f.root, 'other.txt'), 'utf8'), 'retained');
    assert.equal(f.store.read('parent').data.receipts.filter(item => item.actor === 'mdd-apply' && item.assignmentID === 'A2').length, 1);
    assert.deepEqual(f.store.read('parent').data.invalidatedAssignments, [assignment.id]);
    prepared = await prepare(status); report = await evidence(prepared, ['X3']); status = await submit(prepared, report);
    await assert.rejects(f.send('close', { handle: status.handle, outcome: 'verified' }), /Verify|continuation/);
    status = await verify(status, report);
    const final = f.store.read('parent').data, accepted = final.receipts.at(-1).accepted.verifyContext;
    assert.equal(accepted.snapshotID, report.snapshotID); assert.deepEqual(accepted.checks, report.checks);
    assert.equal(final.receipts.filter(item => item.actor === 'mdd-verify').length, 2);
    assert.equal((await f.send('close', { handle: status.handle, outcome: 'verified' })).state, 'completed');
  });
}
