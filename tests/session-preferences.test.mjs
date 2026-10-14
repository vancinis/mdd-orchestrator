import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPreferenceStore } from '../dist/session-preferences.js';
import { LocalFiles } from '../dist/local-files.js';
import { NativeIntake, CHANGE_LABELS } from '../dist/native-intake.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { defaultSettings } from '../dist/settings.js';
import { Workflow } from '../dist/workflow.js';

const choices = { mode: 'interactive', summary: 'detailed' };
function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-preferences-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = { sessionID: '../opaque:parent?', directory: root, worktree: root, agent: 'mdd-orchestrator' };
  const store = new SessionPreferenceStore(root);
  const file = join(root, '.mdd', `preferences-${createHash('sha256').update(runtime.sessionID).digest('hex')}.json`);
  return { root, runtime, store, file };
}

test('session preferences persist only versioned bound mode/summary at a hashed fixed destination', t => {
  const f = fixture(t);
  assert.equal(f.store.read(f.runtime), undefined);
  assert.equal(fs.existsSync(join(f.root, '.mdd')), false, 'reads do not create storage');
  f.store.write(f.runtime, choices);
  const record = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(record, { version: 1, parent: f.runtime.sessionID, directory: f.root, worktree: f.root, ...choices });
  assert.deepEqual(new SessionPreferenceStore(f.root).read(f.runtime), choices);
  assert.equal(f.store.read({ ...f.runtime, sessionID: 'other-parent' }), undefined);
  const detached = f.store.read(f.runtime); detached.mode = 'automatic';
  assert.deepEqual(f.store.read(f.runtime), choices);
  f.store.write(f.runtime, { mode: 'automatic', summary: 'medium' });
  assert.deepEqual(f.store.read(f.runtime), { mode: 'automatic', summary: 'medium' });
});

test('preferences reject foreign parent/worktree, corrupt versions and receipt-shaped data', t => {
  const f = fixture(t); f.store.write(f.runtime, choices);
  for (const key of ['directory', 'worktree']) {
    const foreign = { ...f.runtime, [key]: join(f.root, 'other') };
    assert.throws(() => f.store.read(foreign), /no defaults were reused/);
    assert.throws(() => f.store.write(foreign, choices), /not confirmed durable/);
  }
  const original = fs.readFileSync(f.file, 'utf8');
  for (const patch of [{ version: 2 }, { parent: 'another-parent' }, { mode: 'forged' }, { summary: null },
    { certainty: 'very-sure' }, { answer: [['Interactivo']] }, { approval: true }]) {
    fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(original), ...patch }));
    assert.throws(() => f.store.read(f.runtime), /no defaults were reused/);
  }
  fs.writeFileSync(f.file, original);
  for (const sessionID of ['', ' ', 'x'.repeat(257), 'line\nbreak', 'null\0byte'])
    assert.throws(() => f.store.write({ ...f.runtime, sessionID }, choices));
  assert.throws(() => new LocalFiles(f.root).update('.mdd/preferences-../escape.json', () => '{}', 100));
});

test('preferences refuse unsafe file types and preserve old choices on failed publication', t => {
  const f = fixture(t); f.store.write(f.runtime, choices);
  const original = fs.readFileSync(f.file, 'utf8');
  const lock = `${f.file}.lock`;
  fs.writeFileSync(lock, 'live lock');
  assert.throws(() => f.store.write(f.runtime, { mode: 'automatic', summary: 'low' }), /not confirmed durable/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  fs.unlinkSync(lock);
  const target = join(f.root, 'hardlink-target.json');
  fs.linkSync(f.file, target);
  assert.throws(() => f.store.read(f.runtime), /no defaults were reused/);
  assert.throws(() => f.store.write(f.runtime, choices), /not confirmed durable/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('preferences require exact publication readback before reporting durability', t => {
  const f = fixture(t);
  t.mock.method(f.store, 'read', () => ({ mode: 'automatic', summary: 'low' }));
  assert.throws(() => f.store.write(f.runtime, choices), /not confirmed durable/);
});

function output(args, answers) {
  const formatted = args.questions.map((q, i) => `"${q.question}"="${answers[i].join(', ')}"`).join(', ');
  return { title: `Asked ${args.questions.length} question${args.questions.length === 1 ? '' : 's'}`,
    output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`, metadata: { answers, truncated: false } };
}

function nativeFixture(t) {
  const f = fixture(t);
  const questions = new QuestionCheckpointStore(f.root);
  const settings = defaultSettings();
  settings.profiles.default.answers = { certainty: 'very-sure', artifactStore: 'none' };
  let workflow, blocked = false;
  const runner = {
    async start(input) { workflow = new Workflow(input.preflight); blocked = false; },
    status() { return workflow ? { state: blocked ? 'blocked' : 'ready', runID: 'preference-run', workflow: workflow.snapshot() } : { state: 'not-started' }; },
    block() { blocked = true; }, approveNative() {},
    reset() { workflow = undefined; return { scope: 'run' }; },
  };
  const inspect = { async intake(_runtime, _text, id) { return id; }, async question() {} };
  const gate = () => new NativeIntake(runner, inspect, settings, { questions, preferences: f.store });
  let index = 0;
  const answer = async (intake, selections) => {
    const args = intake.status(f.runtime.sessionID).question;
    const call = { sessionID: f.runtime.sessionID, callID: `native-choice-${++index}` };
    await intake.beforeQuestion(call, args);
    await intake.afterQuestion(call, args, output(args, selections));
    return { args, call };
  };
  return { ...f, questions, settings, runner, gate, answer };
}

test('cancelled redo and rejected change preserve accepted defaults and current run answers', async t => {
  const f = nativeFixture(t), gate = f.gate();
  await gate.start({ requirements: 'Original objective.' }, f.runtime, 'original');
  await f.answer(gate, [['Interactivo'], ['Detallado'], ['Nada que agregar']]);
  const original = gate.status(f.runtime.sessionID).workflow;
  const writes = t.mock.method(f.store, 'write');
  await gate.changeRequest({ kind: 'material', userText: 'Consider a replacement.', requirements: 'Replacement objective.' }, f.runtime, 'reject');
  await f.answer(gate, [[CHANGE_LABELS.keep]]);
  assert.deepEqual(gate.status(f.runtime.sessionID).workflow, original);
  assert.equal(writes.mock.callCount(), 0, 'rejecting a change publishes no choices');
  await gate.changeRequest({ kind: 'material', userText: 'Cancel this replacement.', requirements: 'Replacement objective.' }, f.runtime, 'cancel-change');
  const confirmation = gate.status(f.runtime.sessionID).question;
  const cancellation = { sessionID: f.runtime.sessionID, callID: 'cancel-change' };
  await gate.beforeQuestion(cancellation, confirmation); gate.nativeError(cancellation);
  assert.deepEqual(gate.status(f.runtime.sessionID).workflow, original);
  await gate.changeRequest({ kind: 'rerun', userText: 'Redo all preflight fields.' }, f.runtime, 'redo');
  await f.answer(gate, [[CHANGE_LABELS.confirm]]);
  const args = gate.status(f.runtime.sessionID).question;
  assert.deepEqual(args.questions.map(q => q.header), ['Certeza', 'Modo', 'Resumen', 'Notas']);
  const call = { sessionID: f.runtime.sessionID, callID: 'cancel-redo' };
  await gate.beforeQuestion(call, args); gate.nativeError(call);
  assert.deepEqual(gate.status(f.runtime.sessionID).workflow, original);
  assert.deepEqual(f.store.read(f.runtime), choices);
  assert.equal(writes.mock.callCount(), 0, 'cancelling a change or redo publishes no choices');
  gate.reset(f.runtime, 'run');
  await f.gate().start({ requirements: 'Next objective.' }, f.runtime, 'next');
  assert.deepEqual(f.runner.status().workflow.answers, { certainty: 'very-sure', artifactStore: 'local', ...choices });
});

for (const failure of ['runner', 'clarification', 'settlement']) test(`answered but unapplied ${failure} callback never publishes preferences`, async t => {
  const f = nativeFixture(t), gate = f.gate();
  await gate.start({ requirements: 'Original objective.' }, f.runtime, 'original');
  if (failure === 'runner') f.runner.start = async () => { throw new Error('Runner application failed.'); };
  if (failure === 'clarification') f.runner.contribute = () => { throw new Error('Clarification application failed.'); };
  if (failure === 'settlement') {
    const write = f.questions.write.bind(f.questions);
    t.mock.method(f.questions, 'write', (parent, record) => {
      if (record.state === 'settled') throw new Error('Question settlement failed.');
      write(parent, record);
    });
  }
  await assert.rejects(f.answer(gate, [['Interactivo'], ['Detallado'], ['A custom objective note.']]), /failed/i);
  assert.equal(gate.status(f.runtime.sessionID).state, 'blocked');
  assert.doesNotMatch(gate.status(f.runtime.sessionID).notice ?? '', /planned run is ready/i, 'post-start application/settlement failure cannot retain a success notice');
  assert.equal(f.questions.read(f.runtime.sessionID).state, 'answered');
  assert.equal(f.store.read(f.runtime), undefined);
  const restarted = f.gate();
  assert.equal(restarted.status(f.runtime.sessionID).state, 'recovery-blocked');
  await assert.rejects(restarted.start({ requirements: 'Replacement.' }, f.runtime, 'replacement'), /unresolved outcome/);
});

test('stale preflight callbacks cannot overwrite accepted preference defaults', async t => {
  const f = nativeFixture(t), gate = f.gate();
  await gate.start({ requirements: 'Original objective.' }, f.runtime, 'original');
  const old = await f.answer(gate, [['Interactivo'], ['Detallado'], ['Nada que agregar']]);
  await assert.rejects(gate.afterQuestion(old.call, old.args, output(old.args, [['Automático'], ['Bajo'], ['Nada que agregar']])));
  assert.deepEqual(f.store.read(f.runtime), choices);
});

for (const failure of ['write', 'readback']) test(`native ${failure} failure reports no durable reusable defaults`, async t => {
  const f = nativeFixture(t), gate = f.gate();
  await gate.start({ requirements: 'Original objective.' }, f.runtime, 'original');
  if (failure === 'write') t.mock.method(f.store, 'write', () => { throw new Error('Preference publication failed; not confirmed durable.'); });
  else t.mock.method(f.store, 'read', () => undefined);
  await assert.rejects(f.answer(gate, [['Interactivo'], ['Detallado'], ['Nada que agregar']]), /not confirmed durable/);
  assert.equal(gate.status(f.runtime.sessionID).state, 'blocked');
  assert.match(gate.status(f.runtime.sessionID).reason, /not confirmed durable/);
  assert.match(gate.status(f.runtime.sessionID).notice, /could not be confirmed as reusable defaults/);
  if (failure === 'write') assert.equal(fs.existsSync(f.file), false);
});

test('unreadable preferences block fresh intake instead of silently falling back to a profile', async t => {
  const f = nativeFixture(t); f.store.write(f.runtime, choices);
  fs.writeFileSync(f.file, '{broken');
  await assert.rejects(f.gate().start({ requirements: 'New objective.' }, f.runtime, 'new'), /no defaults were reused/);
  assert.equal(f.runner.status().state, 'not-started');
});

for (const changed of [false, true]) test(`PF-1 P1: fresh-start error restores predecessor only when runner is unchanged (changed=${changed})`, async t => {
  const f = nativeFixture(t);
  f.settings.profiles.default.answers = { certainty: 'very-sure', artifactStore: 'none', ...choices };
  const gate = f.gate();
  await gate.start({ requirements: 'Original objective.' }, f.runtime, 'original');
  const status = f.runner.status.bind(f.runner), start = f.runner.start.bind(f.runner);
  let runID = 'original-run', requirements = 'Original objective.';
  t.mock.method(f.runner, 'status', () => ({ ...status(), runID, requirements,
    ...(runID === 'original-run' ? { state: 'complete' } : {}) }));
  t.mock.method(f.runner, 'start', async input => {
    if (changed) { await start(input); runID = 'replacement-run'; requirements = input.requirements; }
    throw new Error('Runner start failed.');
  });
  await assert.rejects(gate.start({ requirements: 'Replacement objective.' }, f.runtime, 'replacement'), /Runner start failed/);
  const failed = gate.status(f.runtime.sessionID);
  assert.equal(failed.state, changed ? 'blocked' : 'complete');
  assert.equal(failed.runID, runID);
  assert.equal(failed.requirements, requirements);
  assert.equal(failed.task, undefined);
  if (changed) assert.doesNotMatch(failed.notice ?? '', /planned run is ready/i);
  assert.deepEqual(f.store.read(f.runtime), choices);
  const confirmation = await gate.changeRequest({ kind: 'rerun', userText: 'Redo the current objective.' }, f.runtime, 'redo');
  assert.ok(confirmation.question.questions[0].question.includes(requirements), 'intake and runner retain the same objective');
});

test('recovered transfer material change uses target defaults rather than inherited held choices', async t => {
  const f = nativeFixture(t);
  f.settings.profiles.default.answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };
  let workflow = new Workflow({ answers: { certainty: 'not-sure', artifactStore: 'none', ...choices } });
  workflow.start('mdd-explore'); workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored.' });
  workflow.startRisk(); workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Low risk.', route: 'low' });
  let runID = 'transferred-run';
  const runner = { ...f.runner,
    status() { return { state: workflow.nextAction().kind === 'approve' ? 'await-approval' : 'ready', runID, workflow: workflow.snapshot() }; },
    async start(input) { workflow = new Workflow(input.preflight); runID = 'replacement-run'; },
  };
  const checkpoint = { read: () => ({ checkpoint: { version: 3, runID: 'transferred-run', parent: f.runtime.sessionID,
    data: { requirements: 'Source objective.', directory: f.root, worktree: f.root, usedMessages: [], proposed: [], userMessageID: 'target-user' } } }) };
  const ownership = { read: () => ({ receipt: { sourceSessionID: 'source-parent', targetSessionID: f.runtime.sessionID } }) };
  const gate = new NativeIntake(runner, { async intake(_runtime, _text, id) { return id; }, async question() {} }, f.settings,
    { preferences: f.store, checkpoint, ownership });
  gate.recover(f.runtime);
  assert.equal(f.store.read(f.runtime), undefined, 'recovery never publishes source preferences');
  await gate.changeRequest({ kind: 'material', userText: 'Replace the transferred objective.', requirements: 'Target objective.' }, f.runtime, 'replacement');
  await f.answer(gate, [[CHANGE_LABELS.confirm]]);
  assert.deepEqual(gate.status(f.runtime.sessionID).workflow.answers, { ...f.settings.profiles.default.answers, artifactStore: 'local' });
  assert.deepEqual(f.store.read(f.runtime), { mode: 'automatic', summary: 'low' });
});
