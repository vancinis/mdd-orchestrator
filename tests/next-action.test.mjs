import assert from 'node:assert/strict';
import { test } from 'node:test';

test('plural foreground tasks preserve exact objects and cannot advance a phase early', () => {
  const tasks = [{ description: 'first', subagent_type: 'mdd-apply', prompt: 'handle-one' },
    { description: 'second', subagent_type: 'mdd-apply', prompt: 'handle-two' }];
  const action = nextAction({ state: 'await-result', tasks });
  assert.equal(action.tool, 'task'); assert.deepEqual(action.calls, tasks); assert.equal(action.args, undefined);
  action.calls[0].prompt = 'changed'; assert.equal(tasks[0].prompt, 'handle-one');
  assert.equal(nextAction({ state: 'await-result', tasks: [] }).tool, 'mdd_status');
});
import { nextAction, withNextAction } from '../dist/next-action.js';

const task = { description: 'MDD plan phase', subagent_type: 'mdd-plan', prompt: 'mdd:dispatch:token' };
const question = { questions: [{ header: 'Aprobación', question: '¿Continuar?', multiple: false, options: [] }] };

test('SA-3: failed Verify offers explicit actions without fabricating the next phase or consent', () => {
  const action = nextAction({ state: 'blocked', reworkable: 'mdd-apply', runID: 'failed' });
  assert.equal(action.tool, 'mdd_reset');
  assert.equal(action.args, undefined);
  for (const hint of [/scope rework/, /scope phase/, /scope continue/, /runID/, /mdd_start/, /no next phase/i]) assert.match(action.why, hint);
  const continued = nextAction({ state: 'continued-with-failed-verification' });
  assert.equal(continued.tool, 'mdd_status');
  assert.equal(continued.args, undefined);
  assert.match(continued.why, /no work/i);
});

test('next action: a pending question outranks everything the run could otherwise do', () => {
  const action = nextAction({ state: 'ready', question, task, mode: 'delegate' });
  assert.equal(action.tool, 'question');
  assert.deepEqual(action.args, question);
});

test('next action: review resolves uncertainties first and pause never advances automatically', () => {
  const review = nextAction({ state: 'review-ready' });
  assert.equal(review.tool, 'mdd_prepare_advance');
  assert.equal(review.args, undefined);
  assert.match(review.why, /before asking to advance/);
  const paused = nextAction({ state: 'paused' });
  assert.equal(paused.tool, 'mdd_prepare_advance');
  assert.match(paused.why, /Wait for their request to resume/);
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

// "Te interrumpí, continúa" used to end in scope run, a fresh preflight and a second exploration
// and plan for work that was already recorded. An interrupted attempt keeps its run.
test('next action: recovery states point at the narrower reset first', () => {
  const unknown = nextAction({ state: 'recovery-blocked' });
  assert.equal(unknown.tool, 'mdd_reset');
  assert.equal(unknown.args, undefined, 'the user\'s confirmation has to be composed, never invented');
  assert.match(unknown.why, /scope phase and userText/);
  assert.match(unknown.why, /no new preflight/);
  const stopped = nextAction({ state: 'recovery-blocked', liveness: { verdict: 'stopped' } });
  assert.deepEqual(stopped.args, { scope: 'phase' });
  assert.match(stopped.why, /completed phases are not repeated/);
  const running = nextAction({ state: 'recovery-blocked', liveness: { verdict: 'running' } });
  assert.equal(running.tool, 'mdd_status');
  for (const action of [unknown, stopped, running]) assert.notDeepEqual(action.args, { scope: 'run' });
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
