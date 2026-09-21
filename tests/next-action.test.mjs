import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextAction, withNextAction } from '../dist/next-action.js';

const task = { description: 'MDD plan phase', subagent_type: 'mdd-plan', prompt: 'mdd:dispatch:token' };
const question = { questions: [{ header: 'Aprobación', question: '¿Continuar?', multiple: false, options: [] }] };

test('next action: a pending question outranks everything the run could otherwise do', () => {
  const action = nextAction({ state: 'ready', question, task, mode: 'delegate' });
  assert.equal(action.tool, 'question');
  assert.deepEqual(action.args, question);
});

// The report was refused for its wording, not its work. Dispatching here pays for the phase twice.
test('next action: a rejected report is restated, never re-dispatched', () => {
  const action = nextAction({ state: 'ready', task, mode: 'inline', rejected: { reason: 'Missing heading.', text: '## MDD Outcome' } });
  assert.equal(action.tool, 'mdd_phase_result');
  assert.equal(action.args, undefined, 'a restatement has to be composed, so no arguments are invented');
  assert.match(action.why, /costs no attempt/);
});

test('next action: native fallback dispatches exact child work, never coordinator execution', () => {
  const native = { ...task, subagent_type: 'general' };
  const action = nextAction({ state: 'ready', task: native, mode: 'native' });
  assert.equal(action.tool, 'task');
  assert.deepEqual(action.args, native);
});

test('next action: a ready delegated phase carries the exact dispatchable task', () => {
  const action = nextAction({ state: 'ready', task, mode: 'delegate' });
  assert.equal(action.tool, 'task');
  assert.deepEqual(action.args, task);
  assert.notEqual(action.args, task, 'the action must not alias the status object');
});

test('next action: recovery states point at the narrower reset first', () => {
  assert.deepEqual(nextAction({ state: 'recovery-blocked' }).args, { scope: 'run' });
  assert.deepEqual(nextAction({ state: 'blocked', recoverable: true }).args, { scope: 'phase' });
  assert.match(nextAction({ state: 'blocked' }).why, /before scope run/);
});

test('next action: work in flight is waited for, never redispatched', () => {
  assert.equal(nextAction({ state: 'await-result' }).tool, 'mdd_status');
  assert.equal(nextAction({ state: 'await-result' }).args, undefined);
  assert.match(nextAction({ state: 'await-answer' }).why, /never infer an answer from prose/i);
});

test('next action: a pending objective is offered with its own exact arguments', () => {
  const action = nextAction({ state: 'not-started', pendingStart: { requirements: 'Ship the thing.' } });
  assert.equal(action.tool, 'mdd_start');
  assert.deepEqual(action.args, { requirements: 'Ship the thing.' });
  assert.match(action.why, /only if the user is continuing that same objective/);
});

test('next action: an idle conversation is never told to start implementation blindly', () => {
  const action = nextAction({ state: 'not-started' });
  assert.equal(action.tool, 'mdd_start');
  assert.equal(action.args, undefined, 'requirements are the user\'s text and are never invented here');
  assert.match(action.why, /mdd_contextual_explore/);
});

test('next action: a finished run proposes nothing, and unknown shapes are left alone', () => {
  assert.equal(nextAction({ state: 'complete' }), undefined);
  assert.equal(nextAction(undefined), undefined);
  assert.equal(nextAction('not a status'), undefined);
  assert.equal(withNextAction({ state: 'complete' }).nextAction, undefined);
});

test('next action: attaching it never touches what the tool already decided', () => {
  const status = { state: 'ready', task, mode: 'delegate', evidence: { plan: 'confirmed' } };
  const attached = withNextAction(status);
  assert.deepEqual({ ...attached, nextAction: undefined }, { ...status, nextAction: undefined });
  assert.equal(attached.nextAction.tool, 'task');
  assert.equal(status.nextAction, undefined, 'the original status is not mutated');
});
