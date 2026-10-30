import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionPreferenceStore } from '../dist/session-preferences.js';
import { LocalFiles } from '../dist/local-files.js';
import { NativeIntake } from '../dist/native-intake.js';
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

