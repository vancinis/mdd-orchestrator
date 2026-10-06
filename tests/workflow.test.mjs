import assert from 'node:assert/strict';
import test from 'node:test';
import { Workflow } from '../dist/workflow.js';
import { evaluate } from '../dist/kernel.js';
import { ValidationError } from '../dist/validation.js';

const answers = {
  certainty: 'very-sure', artifactStore: 'none', mode: 'automatic',
  summary: 'low', complexity: 'not-complex',
};
const low = ['mdd-plan', 'mdd-apply', 'mdd-verify'];
const high = ['mdd-explore', 'mdd-propose', 'mdd-spec', 'mdd-design',
  'mdd-tasks', 'mdd-apply', 'mdd-verify'];
const result = (phase, outcome = 'passed') => ({ phase, outcome, evidenceSummary: 'Simulated result.' });
function rejectsUnchanged(workflow, action) {
  const before = workflow.snapshot();
  assert.throws(action, ValidationError);
  assert.deepEqual(workflow.snapshot(), before);
}

for (const [name, request, phases] of [
  ['low', { answers }, low],
  ['high', { answers, config: { threshold: 0 }, explore: true }, high],
  ['mandatory exploration', { answers: { ...answers, certainty: 'not-sure',
    complexity: 'somewhat-complex' }, config: { threshold: 100 }, explore: false }, ['mdd-explore', ...low]],
  ['explicit exploration', { answers, explore: true }, ['mdd-explore', ...low]],
]) {
  test(`automatic ${name} runs the exact frozen route`, () => {
    const workflow = new Workflow(request);
    assert.deepEqual(workflow.snapshot().evaluation, evaluate(request));
    assert.deepEqual(workflow.snapshot().evaluation.phases, phases);
    for (const phase of phases) {
      assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase });
      workflow.start(phase);
      assert.deepEqual(workflow.nextAction(), { kind: 'await-result', phase });
      workflow.recordResult(result(phase));
    }
    assert.deepEqual(workflow.nextAction(), { kind: 'finished' });
    assert.deepEqual(workflow.snapshot().results, phases.map((phase) => result(phase)));
    rejectsUnchanged(workflow, () => workflow.start(phases[0]));
    rejectsUnchanged(workflow, () => workflow.approve('mdd-verify'));
    rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-verify')));
  });
}

test('rework returns a failed route to an earlier phase and keeps every recorded result', () => {
  const workflow = new Workflow({ answers: { ...answers, mode: 'interactive' } });
  rejectsUnchanged(workflow, () => workflow.rework('mdd-plan'));
  workflow.start('mdd-plan'); workflow.recordResult(result('mdd-plan'));
  workflow.approve('mdd-apply'); workflow.start('mdd-apply'); workflow.recordResult(result('mdd-apply'));
  workflow.approve('mdd-verify'); workflow.start('mdd-verify'); workflow.recordResult(result('mdd-verify', 'failed'));
  rejectsUnchanged(workflow, () => workflow.rework('mdd-verify'));
  rejectsUnchanged(workflow, () => workflow.rework('mdd-explore'));
  workflow.rework('mdd-apply');
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-apply' });
  workflow.start('mdd-apply'); workflow.recordResult(result('mdd-apply'));
  // Verification after the correction still goes through the ordinary interactive approval.
  assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase: 'mdd-verify' });
  workflow.approve('mdd-verify'); workflow.start('mdd-verify'); workflow.recordResult(result('mdd-verify'));
  assert.deepEqual(workflow.nextAction(), { kind: 'finished' });
  assert.deepEqual(workflow.snapshot().results.map(item => `${item.phase}:${item.outcome}`),
    ['mdd-plan:passed', 'mdd-apply:passed', 'mdd-verify:failed', 'mdd-apply:passed', 'mdd-verify:passed']);
});

test('interactive approvals authorize only the exact next phase, not the whole route', () => {
  const workflow = new Workflow({ answers: { ...answers, mode: 'interactive' } });
  for (const [index, phase] of low.entries()) {
    if (index > 0) {
      assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase });
      rejectsUnchanged(workflow, () => workflow.start(phase));
      rejectsUnchanged(workflow, () => workflow.approve(low[index - 1]));
      rejectsUnchanged(workflow, () => workflow.recordResult(result(phase)));
      workflow.approve(phase);
    }
    assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase });
    rejectsUnchanged(workflow, () => workflow.approve(phase));
    workflow.start(phase);
    rejectsUnchanged(workflow, () => workflow.approve(phase));
    workflow.recordResult(result(phase));
  }
  assert.deepEqual(workflow.nextAction(), { kind: 'finished' });
});

for (const mode of ['automatic', 'interactive']) {
  for (const failedPhase of low) {
    test(`${mode}: failure in ${failedPhase} blocks permanently, including verify`, () => {
      const workflow = new Workflow({ answers: { ...answers, mode } });
      for (const phase of low) {
        if (workflow.nextAction().kind === 'approve') workflow.approve(phase);
        workflow.start(phase);
        workflow.recordResult(result(phase, phase === failedPhase ? 'failed' : 'passed'));
        if (phase === failedPhase) break;
      }
      assert.deepEqual(workflow.nextAction(), { kind: 'blocked', phase: failedPhase });
      for (const phase of low) {
        rejectsUnchanged(workflow, () => workflow.start(phase));
        rejectsUnchanged(workflow, () => workflow.approve(phase));
        rejectsUnchanged(workflow, () => workflow.recordResult(result(phase)));
      }
      assert.equal(workflow.snapshot().results.at(-1).outcome, 'failed');
    });
  }
}

test('premature, duplicate, wrong-phase and malformed actions never change state', () => {
  const workflow = new Workflow({ answers });
  rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-plan')));
  for (const phase of ['mdd-apply', 'mdd-verify', 'unknown', null, undefined, {}, true]) {
    rejectsUnchanged(workflow, () => workflow.start(phase));
    rejectsUnchanged(workflow, () => workflow.approve(phase));
  }
  workflow.start('mdd-plan');
  for (const phase of low) rejectsUnchanged(workflow, () => workflow.start(phase));
  for (const value of [
    null, [], true, new Date(), {}, result('mdd-apply'), result('unknown'),
    { ...result('mdd-plan'), extra: true }, { ...result('mdd-plan'), [Symbol('extra')]: 1 },
    ...[undefined, null, true, 1, 'success', 'PASSED'].map((outcome) => ({ ...result('mdd-plan'), outcome })),
    ...[undefined, null, true, 1, '', ' \n\t '].map((evidenceSummary) => ({ ...result('mdd-plan'), evidenceSummary })),
  ]) rejectsUnchanged(workflow, () => workflow.recordResult(value));
  workflow.recordResult(result('mdd-plan'));
  rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-plan')));
  workflow.start('mdd-apply');
  rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-plan')));
});

test('explicit and profile controllers remain equivalent through execution', () => {
  const options = { config: { threshold: 0 }, explore: true };
  const direct = new Workflow({ answers, ...options });
  const profile = new Workflow({ profile: { answers }, ...options });
  for (const phase of high) {
    assert.deepEqual(direct.snapshot(), profile.snapshot());
    for (const workflow of [direct, profile]) {
      workflow.start(phase);
      workflow.recordResult(result(phase));
    }
  }
  assert.deepEqual(direct.snapshot(), profile.snapshot());
});

test('preflight is read once; status reads have no effects throughout the lifecycle', () => {
  let reads = 0;
  const workflow = new Workflow({ get answers() {
    assert.equal(++reads, 1, 'preflight must not be read again');
    return answers;
  } });
  function checkStatus() {
    const before = workflow.snapshot();
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(workflow.snapshot(), before);
      assert.deepEqual(workflow.nextAction(), before.nextAction);
    }
    assert.equal(reads, 1);
  }
  for (const phase of low) {
    checkStatus();
    workflow.start(phase);
    checkStatus();
    workflow.recordResult(result(phase));
  }
  checkStatus();
});

test('caller inputs, results and returned snapshots cannot mutate held state', () => {
  const request = { profile: { answers: { ...answers } }, explore: false,
    config: { threshold: 50, weights: { certainty: { 'very-sure': 10 } } } };
  const workflow = new Workflow(request);
  const initial = workflow.snapshot();
  request.profile.answers.mode = 'interactive';
  request.profile.answers.certainty = 'not-sure';
  request.config.threshold = 0;
  request.config.weights.certainty['very-sure'] = 100;
  request.explore = true;
  const exposed = workflow.snapshot();
  exposed.answers.mode = 'interactive';
  exposed.evaluation.phases.length = 0;
  exposed.evaluation.contributions[0].points = 999;
  exposed.evaluation.reasons.length = 0;
  exposed.nextAction.kind = 'finished';
  exposed.results.push(result('mdd-verify'));
  workflow.nextAction().phase = 'mdd-verify';
  assert.deepEqual(workflow.snapshot(), initial);
  workflow.start('mdd-plan');
  const supplied = result('mdd-plan');
  workflow.recordResult(supplied);
  supplied.outcome = 'failed';
  supplied.evidenceSummary = 'Changed';
  workflow.snapshot().results[0].outcome = 'failed';
  assert.deepEqual(workflow.snapshot().results, [result('mdd-plan')]);
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-apply' });
});

test('construction shares strict kernel validation, including incomplete profiles', () => {
  for (const request of [
    undefined, null, [], {}, { answers, profile: { answers } },
    { profile: {} }, { profile: { answers: { mode: 'automatic' } } },
    { profile: { answers, models: {} } }, { answers: { ...answers, mode: true } },
    { answers, extra: true }, { answers, explore: undefined },
    { answers, config: { threshold: -1 } },
  ]) assert.throws(() => new Workflow(request), ValidationError);
});

// A run keeps the route it started on. Commit 57b0857 stopped scoring complexity, and every
// checkpoint written before it whose answers now route differently became unreadable: the
// replayed "start mdd-explore" no longer matched the route today's policy chose.
test('replay follows the route a run recorded, not the one today\'s policy would choose', () => {
  const lowExplore = ['mdd-explore', ...low];
  const events = [{ kind: 'start', phase: 'mdd-explore' }, { kind: 'result', result: result('mdd-explore') },
    { kind: 'start', phase: 'mdd-plan' }];
  // Today these answers route to plan, apply and verify, without exploration.
  assert.deepEqual(evaluate({ answers }).phases, low);
  assert.throws(() => new Workflow({ answers }).start('mdd-explore'), ValidationError);
  const recorded = Workflow.replay({ answers, route: lowExplore }, events);
  assert.deepEqual(recorded.snapshot().evaluation.phases, lowExplore);
  assert.deepEqual(recorded.nextAction(), { kind: 'await-result', phase: 'mdd-plan' });
  assert.match(recorded.snapshot().evaluation.reasons.at(-1), /keeps the route it started with/);
  // The record is the request plus the evaluated route, and replays to the same state.
  const started = new Workflow({ answers, explore: true });
  const request = Workflow.recordedRequest({ answers, explore: true }, started);
  assert.deepEqual(request, { answers, explore: true, route: lowExplore });
  assert.deepEqual(Workflow.replay(request, []).snapshot(), started.snapshot());
});

test('a record without its route is replayed on the only known route its history fits', () => {
  const events = [{ kind: 'start', phase: 'mdd-explore' }, { kind: 'result', result: result('mdd-explore') },
    { kind: 'start', phase: 'mdd-plan' }];
  const legacy = Workflow.replay({ answers }, events);
  assert.deepEqual(legacy.snapshot().evaluation.phases, ['mdd-explore', ...low]);
  assert.deepEqual(legacy.snapshot().results, [result('mdd-explore')]);
  // Exploration alone fits the high route and the explored low route: that is never guessed.
  assert.throws(() => Workflow.replay({ answers }, [{ kind: 'start', phase: 'mdd-explore' }]), ValidationError);
  // A recorded route is authoritative: it is never swapped for another one that would fit.
  assert.throws(() => Workflow.replay({ answers, route: low }, events), ValidationError);
});

test('a recorded route must be a route the policy can choose', () => {
  for (const route of [[], ['mdd-apply'], ['mdd-plan', 'mdd-verify'], [...low, 'mdd-verify'], 'mdd-plan', null,
    ['mdd-explore', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply']]) {
    assert.throws(() => new Workflow({ answers, route }), ValidationError, JSON.stringify(route));
  }
  assert.deepEqual(new Workflow({ answers, route: high }).snapshot().evaluation.route, 'high');
});
