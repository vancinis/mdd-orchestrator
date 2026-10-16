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
const high = ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify'];
const result = (phase, outcome = 'passed') => ({ phase, outcome, evidenceSummary: 'Simulated result.' });
function rejectsUnchanged(workflow, action) {
  const before = workflow.snapshot();
  assert.throws(action, ValidationError);
  assert.deepEqual(workflow.snapshot(), before);
}

/** Drives a fresh workflow through exploration and a passed mdd-risk verdict for `route`. */
function throughRisk(workflow, route) {
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-explore' });
  workflow.start('mdd-explore');
  assert.deepEqual(workflow.nextAction(), { kind: 'await-result', phase: 'mdd-explore' });
  workflow.recordResult(result('mdd-explore'));
  assert.deepEqual(workflow.nextAction(), { kind: 'execute-risk' });
  workflow.startRisk();
  assert.deepEqual(workflow.nextAction(), { kind: 'await-risk-result' });
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Risk fixture.', route });
}

test('AL-01: explicit fixed routing is recorded without changing default or profile evaluation', () => {
  for (const base of [{ answers }, { profile: { answers }, explore: false }]) {
    const request = { ...base, routingVersion: 2 };
    const workflow = new Workflow(request);
    assert.deepEqual(evaluate(request), evaluate(base));
    assert.equal(workflow.snapshot().evaluation.policyVersion, 'mdd-routing-v2');
    assert.deepEqual(Workflow.recordedRequest(request, workflow), request);
    assert.deepEqual(Workflow.recordedRequest(base, new Workflow(base)), base, 'omission is never stamped');
  }
});

for (const legacy of [false, true]) {
  test(`AL-01 correction: non-enumerable fixed pin survives ${legacy ? 'legacy' : 'modern'} request recording`, () => {
    for (const base of [{ answers }, { profile: { answers } }]) {
      for (const route of legacy ? [low, ['mdd-explore', ...low], ['mdd-explore', ...high]] : [undefined]) {
        const request = Object.defineProperty({ ...base, ...(route ? { route } : {}) }, 'routingVersion', { value: 2 });
        const workflow = new Workflow(request);
        const saved = Workflow.recordedRequest(request, workflow);
        assert.equal(Object.hasOwn(saved, 'routingVersion'), true);
        assert.equal(saved.routingVersion, 2);
        assert.equal(Object.getOwnPropertyDescriptor(saved, 'routingVersion').enumerable, true, 'the pin survives subsequent JSON and clone boundaries');
        assert.deepEqual(saved, { ...base, ...(route ? { route } : {}), routingVersion: 2 });
        assert.deepEqual(Workflow.replay(saved, []).snapshot(), workflow.snapshot());
        if (!route) {
          assert.deepEqual(evaluate(request), evaluate(base));
          const planOnly = [{ kind: 'start', phase: 'mdd-plan' }];
          assert.throws(() => Workflow.replay(request, planOnly), /Only the current ready phase can start/);
          assert.throws(() => Workflow.replay(saved, planOnly), /Only the current ready phase can start/);
        }
      }
    }
  });
}

test('AL-01 correction: own inactive and unsupported pins cannot disappear through legacy route extraction', () => {
  for (const routingVersion of [3, undefined, null, '2', 4]) {
    for (const route of [undefined, low, ['mdd-explore', ...low], ['mdd-explore', ...high]]) {
      const request = Object.defineProperty({ answers, ...(route ? { route } : {}) }, 'routingVersion', { value: routingVersion });
      const error = routingVersion === 3 ? /native-context-required/ : /routingVersion.*unsupported/;
      assert.throws(() => new Workflow(request), error);
      assert.throws(() => Workflow.replay(request, []), error);
      assert.throws(() => Workflow.recordedRequest(request, new Workflow({ answers })), error);
    }
  }
});

test('AL05b: version three requires native context at fixed evaluation, construction and replay', () => {
  const request = { answers, routingVersion: 3 };
  for (const read of [() => evaluate(request), () => new Workflow(request), () => Workflow.replay(request, [])]) {
    assert.throws(read, /native-context-required/);
  }
});

test('AL-01: malformed and unsupported routing discriminators fail closed', () => {
  for (const routingVersion of [undefined, null, '2', '3', true, 0, 1, 4, 2.5, NaN, Infinity, {}, []]) {
    const request = { answers, routingVersion };
    assert.throws(() => evaluate(request), /routingVersion.*unsupported/);
    assert.throws(() => Workflow.replay(request, []), /routingVersion.*unsupported/);
  }
});

test('AL-01: a pinned request never infers a legacy route from otherwise valid old history', () => {
  const events = [{ kind: 'start', phase: 'mdd-explore' }, { kind: 'result', result: result('mdd-explore') },
    { kind: 'start', phase: 'mdd-plan' }];
  assert.deepEqual(Workflow.replay({ answers }, events).nextAction(), { kind: 'await-result', phase: 'mdd-plan' });
  assert.throws(() => Workflow.replay({ answers, routingVersion: 2 }, events), /Only the current ready phase can start/);
});

test('AL-01: explicit recorded legacy routes keep their fixed tails and discriminator', () => {
  for (const route of [low, ['mdd-explore', ...low], ['mdd-explore', ...high]]) {
    const request = { answers, routingVersion: 2, route };
    const workflow = new Workflow(request);
    for (const phase of route) { workflow.start(phase); workflow.recordResult(result(phase)); }
    assert.deepEqual(workflow.nextAction(), { kind: 'finished' });
    assert.deepEqual(Workflow.recordedRequest(request, workflow), request);
    assert.deepEqual(Workflow.replay(request, workflow.history()).snapshot(), workflow.snapshot());
  }
});

for (const selection of ['low', 'high', 'override', 'manual']) {
  test(`AL-01: fixed replay preserves ${selection} routing and earned Apply progress`, () => {
    const base = { answers: { ...answers, mode: selection === 'override' ? 'interactive' : 'automatic' } };
    const request = { ...base, routingVersion: 2 };
    const workflow = new Workflow(request);
    workflow.start('mdd-explore'); workflow.recordResult(result('mdd-explore'));
    workflow.startRisk();
    workflow.recordRiskResult(selection === 'manual' ? { outcome: 'failed', evidenceSummary: 'Unknown risk.' } :
      { outcome: 'passed', evidenceSummary: 'Grounded risk.', route: selection === 'high' ? 'high' : 'low' });
    if (selection === 'override') workflow.overrideRoute();
    if (selection === 'manual') workflow.chooseManualRoute('low');
    const tail = workflow.snapshot().evaluation.route === 'high' ? high : low;
    for (const phase of tail.slice(0, -2)) {
      if (workflow.nextAction().kind === 'approve') workflow.approve(phase);
      workflow.start(phase);
      workflow.recordResult({ ...result(phase), ...(['mdd-plan', 'mdd-tasks'].includes(phase) ? { applyPlan: [
        { id: 'first', dependsOn: [] }, { id: 'second', dependsOn: ['first'] },
      ] } : {}) });
    }
    if (workflow.nextAction().kind === 'approve') workflow.approve('mdd-apply');
    workflow.start('mdd-apply');
    workflow.recordResult({ ...result('mdd-apply'), completed: ['first'], batchID: 'batch-first' });
    workflow.start('mdd-apply');
    const replayed = Workflow.replay(request, workflow.history());
    assert.deepEqual(replayed.snapshot(), workflow.snapshot());
    assert.deepEqual(replayed.applyProgress().completed, ['first']);
    assert.deepEqual(Workflow.replay(base, workflow.history()).snapshot(), workflow.snapshot(), 'unmarked modern history stays compatible');
    replayed.retry();
    replayed.start('mdd-apply');
    replayed.recordResult({ ...result('mdd-apply'), completed: ['second'], batchID: 'batch-second' });
    assert.equal(replayed.nextAction().phase, 'mdd-verify');
  });
}

for (const [name, request, tail] of [
  ['low', { answers }, low],
  ['high', { answers: { ...answers, certainty: 'not-sure' } }, high],
]) {
  test(`automatic ${name} always explores first, then mdd-risk selects the exact tail`, () => {
    const workflow = new Workflow(request);
    assert.deepEqual(workflow.snapshot().evaluation.phases, ['mdd-explore']);
    assert.equal(workflow.snapshot().evaluation.route, undefined, 'no route before mdd-risk selects one');
    throughRisk(workflow, name);
    assert.deepEqual(workflow.snapshot().evaluation.phases, ['mdd-explore', ...tail]);
    for (const phase of tail) {
      assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase });
      workflow.start(phase);
      assert.deepEqual(workflow.nextAction(), { kind: 'await-result', phase });
      workflow.recordResult(result(phase));
    }
    assert.deepEqual(workflow.nextAction(), { kind: 'finished' });
    assert.deepEqual(workflow.snapshot().results, [result('mdd-explore'), ...tail.map((phase) => result(phase))]);
    rejectsUnchanged(workflow, () => workflow.start(tail[0]));
    rejectsUnchanged(workflow, () => workflow.approve('mdd-verify'));
    rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-verify')));
  });
}

test('no preflight answer predicts a route; only the validated mdd-risk verdict selects one', () => {
  for (const certainty of ['very-sure', 'somewhat-sure', 'not-sure']) {
    for (const route of ['low', 'high']) {
      const workflow = new Workflow({ answers: { ...answers, certainty, summary: 'detailed', mode: 'automatic' } });
      assert.equal(workflow.snapshot().evaluation.route, undefined);
      assert.equal('score' in workflow.snapshot().evaluation, false);
      throughRisk(workflow, route);
      assert.equal(workflow.snapshot().evaluation.route, route);
      assert.deepEqual(workflow.snapshot().evaluation.phases, ['mdd-explore', ...(route === 'low' ? low : high)]);
    }
  }
});

test('failed exploration blocks the route and never dispatches mdd-risk', () => {
  const workflow = new Workflow({ answers });
  workflow.start('mdd-explore');
  workflow.recordResult(result('mdd-explore', 'failed'));
  assert.deepEqual(workflow.nextAction(), { kind: 'blocked', phase: 'mdd-explore' });
  rejectsUnchanged(workflow, () => workflow.startRisk());
  rejectsUnchanged(workflow, () => workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x', route: 'low' }));
});

test('failed or invalid mdd-risk assessment leaves the run blocked without any route', () => {
  const workflow = new Workflow({ answers });
  workflow.start('mdd-explore');
  workflow.recordResult(result('mdd-explore'));
  workflow.startRisk();
  rejectsUnchanged(workflow, () => workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x' }));
  rejectsUnchanged(workflow, () => workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x', route: 'medium' }));
  rejectsUnchanged(workflow, () => workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'x', route: 'low' }));
  workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Risk could not be substantiated.' });
  assert.deepEqual(workflow.nextAction(), { kind: 'blocked-risk' });
  assert.deepEqual(workflow.snapshot().evaluation.phases, ['mdd-explore']);
  rejectsUnchanged(workflow, () => workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x', route: 'low' }));
});

test('retry releases a pending or blocked risk attempt back to execute-risk, never auto-reissuing', () => {
  const workflow = new Workflow({ answers });
  workflow.start('mdd-explore');
  workflow.recordResult(result('mdd-explore'));
  workflow.startRisk();
  workflow.retry();
  assert.deepEqual(workflow.nextAction(), { kind: 'execute-risk' });
  workflow.startRisk();
  workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Unsubstantiated.' });
  workflow.retry();
  assert.deepEqual(workflow.nextAction(), { kind: 'execute-risk' });
});

test('rework returns a failed route to an earlier phase and keeps every recorded result', () => {
  const workflow = new Workflow({ answers: { ...answers, mode: 'interactive' } });
  throughRisk(workflow, 'low');
  assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase: 'mdd-plan' });
  rejectsUnchanged(workflow, () => workflow.rework('mdd-plan'));
  workflow.approve('mdd-plan'); workflow.start('mdd-plan'); workflow.recordResult(result('mdd-plan'));
  workflow.approve('mdd-apply'); workflow.start('mdd-apply'); workflow.recordResult(result('mdd-apply'));
  workflow.approve('mdd-verify'); workflow.start('mdd-verify'); workflow.recordResult(result('mdd-verify', 'failed'));
  rejectsUnchanged(workflow, () => workflow.rework('mdd-verify'));
  rejectsUnchanged(workflow, () => workflow.rework('mdd-tasks'));
  workflow.rework('mdd-apply');
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-apply' });
  workflow.start('mdd-apply'); workflow.recordResult(result('mdd-apply'));
  // Verification after the correction still goes through the ordinary interactive approval.
  assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase: 'mdd-verify' });
  workflow.approve('mdd-verify'); workflow.start('mdd-verify'); workflow.recordResult(result('mdd-verify'));
  assert.deepEqual(workflow.nextAction(), { kind: 'finished' });
  assert.deepEqual(workflow.snapshot().results.map(item => `${item.phase}:${item.outcome}`),
    ['mdd-explore:passed', 'mdd-plan:passed', 'mdd-apply:passed', 'mdd-verify:failed', 'mdd-apply:passed', 'mdd-verify:passed']);
});

test('interactive approvals authorize only the exact next phase, not the whole route', () => {
  const workflow = new Workflow({ answers: { ...answers, mode: 'interactive' } });
  workflow.start('mdd-explore'); workflow.recordResult(result('mdd-explore'));
  workflow.startRisk(); workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x', route: 'low' });
  assert.equal(workflow.snapshot().routeOrigin, 'suggested');
  for (const [index, phase] of low.entries()) {
    assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase });
    rejectsUnchanged(workflow, () => workflow.start(phase));
    if (index > 0) rejectsUnchanged(workflow, () => workflow.approve(low[index - 1]));
    rejectsUnchanged(workflow, () => workflow.recordResult(result(phase)));
    workflow.approve(phase);
    assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase });
    rejectsUnchanged(workflow, () => workflow.approve(phase));
    workflow.start(phase);
    rejectsUnchanged(workflow, () => workflow.approve(phase));
    workflow.recordResult(result(phase));
  }
  assert.deepEqual(workflow.nextAction(), { kind: 'finished' });
});

test('automatic success proceeds on the suggested route with no approval and no override claim', () => {
  const workflow = new Workflow({ answers });
  throughRisk(workflow, 'low');
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: low[0] });
  assert.equal(workflow.snapshot().routeOrigin, 'suggested');
  rejectsUnchanged(workflow, () => workflow.overrideRoute());
});

test('interactive override forces the other route before the first tail phase starts; the verdict stays recorded', () => {
  const workflow = new Workflow({ answers: { ...answers, mode: 'interactive' } });
  throughRisk(workflow, 'low');
  assert.deepEqual(workflow.nextAction(), { kind: 'approve', phase: low[0] });
  rejectsUnchanged(workflow, () => workflow.start(low[0]));
  rejectsUnchanged(workflow, () => workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x', route: 'low' }));
  rejectsUnchanged(workflow, () => workflow.chooseManualRoute('high'));
  workflow.overrideRoute();
  assert.deepEqual(workflow.snapshot().evaluation.phases, ['mdd-explore', ...high]);
  assert.equal(workflow.snapshot().evaluation.route, 'high');
  assert.equal(workflow.snapshot().routeOrigin, 'override');
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: high[0] });
  // The original passed verdict is never discarded or replaced; it cannot be recorded twice,
  // and the full history still names the low route mdd-risk actually assessed.
  rejectsUnchanged(workflow, () => workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x', route: 'high' }));
  assert.deepEqual(workflow.history()[3], { kind: 'risk-result', result: { outcome: 'passed', evidenceSummary: 'Risk fixture.', route: 'low' } });
  rejectsUnchanged(workflow, () => workflow.overrideRoute());
});

test('override is refused once the first tail phase is approved, started or past', () => {
  for (const advance of [
    (workflow) => workflow.approve(low[0]),
    (workflow) => { workflow.approve(low[0]); workflow.start(low[0]); },
    (workflow) => { workflow.approve(low[0]); workflow.start(low[0]); workflow.recordResult(result(low[0])); },
  ]) {
    const workflow = new Workflow({ answers: { ...answers, mode: 'interactive' } });
    throughRisk(workflow, 'low');
    advance(workflow);
    rejectsUnchanged(workflow, () => workflow.overrideRoute());
  }
});

test('blocked risk recovery: retry reuses the existing path, low/high are manual choices with no RiskVerdict', () => {
  const retryWorkflow = new Workflow({ answers });
  retryWorkflow.start('mdd-explore'); retryWorkflow.recordResult(result('mdd-explore'));
  retryWorkflow.startRisk(); retryWorkflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'x' });
  assert.deepEqual(retryWorkflow.nextAction(), { kind: 'blocked-risk' });
  rejectsUnchanged(retryWorkflow, () => retryWorkflow.overrideRoute());
  rejectsUnchanged(retryWorkflow, () => retryWorkflow.chooseManualRoute('medium'));
  retryWorkflow.retry();
  assert.deepEqual(retryWorkflow.nextAction(), { kind: 'execute-risk' });
  assert.equal(retryWorkflow.snapshot().routeOrigin, undefined);

  for (const [mode, route] of [['automatic', 'low'], ['interactive', 'low'], ['automatic', 'high'], ['interactive', 'high']]) {
    const workflow = new Workflow({ answers: { ...answers, mode } });
    workflow.start('mdd-explore'); workflow.recordResult(result('mdd-explore'));
    workflow.startRisk(); workflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Unsubstantiated.' });
    const tail = route === 'low' ? low : high;
    // No fabricated RiskVerdict is ever produced by a manual choice.
    workflow.chooseManualRoute(route);
    assert.deepEqual(workflow.snapshot().evaluation.phases, ['mdd-explore', ...tail]);
    assert.equal(workflow.snapshot().routeOrigin, 'manual');
    assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: tail[0] });
    assert.ok(!workflow.history().some(event => event.kind === 'risk-result' && event.result.outcome === 'passed'));
  }
  // Doing nothing (stop) simply leaves blocked-risk recoverable; no route is invented.
  const stopWorkflow = new Workflow({ answers });
  stopWorkflow.start('mdd-explore'); stopWorkflow.recordResult(result('mdd-explore'));
  stopWorkflow.startRisk(); stopWorkflow.recordRiskResult({ outcome: 'failed', evidenceSummary: 'Unsubstantiated.' });
  assert.deepEqual(stopWorkflow.nextAction(), { kind: 'blocked-risk' });
  assert.deepEqual(stopWorkflow.snapshot().evaluation.phases, ['mdd-explore']);
});

test('route-override and risk-recovery events replay exactly, and forged or contradictory ones are rejected', () => {
  const workflow = new Workflow({ answers: { ...answers, mode: 'interactive' } });
  throughRisk(workflow, 'low');
  workflow.overrideRoute();
  workflow.start(high[0]); workflow.recordResult(result(high[0]));
  const replayed = Workflow.replay({ answers: { ...answers, mode: 'interactive' } }, workflow.history());
  assert.deepEqual(replayed.snapshot(), workflow.snapshot());
  assert.equal(replayed.snapshot().routeOrigin, 'override');

  const prefix = workflow.history().slice(0, 4);
  for (const bad of [
    { kind: 'route-override', extra: true },
    { kind: 'risk-recovery', route: 'medium' },
    { kind: 'risk-recovery' },
  ]) {
    assert.throws(() => Workflow.replay({ answers: { ...answers, mode: 'interactive' } }, [...prefix, bad]), ValidationError);
  }
  // A route-override replayed before any risk verdict exists is contradictory, not authoritative.
  assert.throws(() => Workflow.replay({ answers: { ...answers, mode: 'interactive' } }, [{ kind: 'route-override' }]), ValidationError);
  assert.throws(() => Workflow.replay({ answers }, [{ kind: 'risk-recovery', route: 'low' }]), ValidationError);
});

for (const mode of ['automatic', 'interactive']) {
  for (const failedPhase of low) {
    test(`${mode}: failure in ${failedPhase} blocks permanently, including verify`, () => {
      const workflow = new Workflow({ answers: { ...answers, mode } });
      throughRisk(workflow, 'low');
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
  rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-explore')));
  for (const phase of ['mdd-apply', 'mdd-verify', 'unknown', null, undefined, {}, true]) {
    rejectsUnchanged(workflow, () => workflow.start(phase));
    rejectsUnchanged(workflow, () => workflow.approve(phase));
  }
  workflow.start('mdd-explore');
  for (const phase of ['mdd-explore', ...low]) rejectsUnchanged(workflow, () => workflow.start(phase));
  for (const value of [
    null, [], true, new Date(), {}, result('mdd-apply'), result('unknown'),
    { ...result('mdd-explore'), extra: true }, { ...result('mdd-explore'), [Symbol('extra')]: 1 },
    ...[undefined, null, true, 1, 'success', 'PASSED'].map((outcome) => ({ ...result('mdd-explore'), outcome })),
    ...[undefined, null, true, 1, '', ' \n\t '].map((evidenceSummary) => ({ ...result('mdd-explore'), evidenceSummary })),
  ]) rejectsUnchanged(workflow, () => workflow.recordResult(value));
  workflow.recordResult(result('mdd-explore'));
  rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-explore')));
  workflow.startRisk();
  rejectsUnchanged(workflow, () => workflow.recordResult(result('mdd-explore')));
  for (const value of [
    null, [], true, {}, { outcome: 'passed', evidenceSummary: 'x', extra: true },
    { outcome: 'passed', evidenceSummary: 'x', route: 'medium' },
    { outcome: 'failed', evidenceSummary: 'x', route: 'low' },
    ...[undefined, null, true, 1, '', ' \n\t '].map((evidenceSummary) => ({ outcome: 'passed', evidenceSummary, route: 'low' })),
  ]) rejectsUnchanged(workflow, () => workflow.recordRiskResult(value));
});

test('explicit and profile controllers remain equivalent through execution', () => {
  const direct = new Workflow({ answers });
  const profile = new Workflow({ profile: { answers } });
  for (const workflow of [direct, profile]) throughRisk(workflow, 'high');
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
  checkStatus();
  workflow.start('mdd-explore');
  checkStatus();
  workflow.recordResult(result('mdd-explore'));
  checkStatus();
  workflow.startRisk();
  checkStatus();
  workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'x', route: 'low' });
  for (const phase of low) {
    checkStatus();
    workflow.start(phase);
    checkStatus();
    workflow.recordResult(result(phase));
  }
  checkStatus();
});

test('caller inputs, results and returned snapshots cannot mutate held state', () => {
  const request = { profile: { answers: { ...answers } } };
  const workflow = new Workflow(request);
  const initial = workflow.snapshot();
  request.profile.answers.mode = 'interactive';
  request.profile.answers.certainty = 'not-sure';
  const exposed = workflow.snapshot();
  exposed.answers.mode = 'interactive';
  exposed.evaluation.phases.length = 0;
  exposed.evaluation.route = 'high';
  exposed.evaluation.reasons.length = 0;
  exposed.nextAction.kind = 'finished';
  exposed.results.push(result('mdd-verify'));
  workflow.nextAction().phase = 'mdd-verify';
  assert.deepEqual(workflow.snapshot(), initial);
  workflow.start('mdd-explore');
  const supplied = result('mdd-explore');
  workflow.recordResult(supplied);
  supplied.outcome = 'failed';
  supplied.evidenceSummary = 'Changed';
  workflow.snapshot().results[0].outcome = 'failed';
  assert.deepEqual(workflow.snapshot().results, [result('mdd-explore')]);
  assert.deepEqual(workflow.nextAction(), { kind: 'execute-risk' });
});

test('construction shares strict kernel validation, including incomplete profiles', () => {
  for (const request of [
    undefined, null, [], {}, { answers, profile: { answers } },
    { profile: {} }, { profile: { answers: { mode: 'automatic' } } },
    { profile: { answers, models: {} } }, { answers: { ...answers, mode: true } },
    { answers, extra: true }, { answers, explore: undefined },
    // Scoring was removed; its configuration is refused, never silently ignored.
    { answers, config: { threshold: -1 } }, { answers, config: {} }, { profile: { answers }, config: { threshold: 50 } },
  ]) assert.throws(() => new Workflow(request), ValidationError);
});

test('Apply completes exactly one dependency-ordered deliverable before Verify, with replay', () => {
  const workflow = new Workflow({ answers });
  throughRisk(workflow, 'low');
  workflow.start('mdd-plan');
  workflow.recordResult({ ...result('mdd-plan'), applyPlan: [
    { id: 'first', dependsOn: [] }, { id: 'second', dependsOn: ['first'] },
  ] });
  workflow.start('mdd-apply');
  for (const completed of [[], ['second'], ['first', 'second'], ['invented'], ['first', 'first']]) {
    rejectsUnchanged(workflow, () => workflow.recordResult({ ...result('mdd-apply'), completed, batchID: 'batch-one' }));
  }
  workflow.recordResult({ ...result('mdd-apply'), completed: ['first'], batchID: 'batch-one' });
  assert.deepEqual(workflow.nextAction(), { kind: 'execute', phase: 'mdd-apply' });
  const resumed = Workflow.replay({ answers }, workflow.history());
  assert.deepEqual(resumed.applyProgress(), workflow.applyProgress());
  resumed.start('mdd-apply');
  rejectsUnchanged(resumed, () => resumed.recordResult({ ...result('mdd-apply'), completed: ['first'], batchID: 'batch-two' }));
  resumed.recordResult({ ...result('mdd-apply'), completed: ['second'], batchID: 'batch-two' });
  assert.deepEqual(resumed.nextAction(), { kind: 'execute', phase: 'mdd-verify' });
});

// A run keeps the route it started on. Runs recorded before the mdd-risk stop carry their
// score-routed route and finish on it; runs started now record none and are routed by mdd-risk.
test('replay follows the route a legacy run recorded; a new run records none and enters the risk stop', () => {
  const lowExplore = ['mdd-explore', ...low];
  const events = [{ kind: 'start', phase: 'mdd-explore' }, { kind: 'result', result: result('mdd-explore') },
    { kind: 'start', phase: 'mdd-plan' }];
  // A new run never goes from exploration straight to a tail phase.
  assert.throws(() => Workflow.replay({ answers }, events.slice(0, 2).concat([{ kind: 'risk-start' }, { kind: 'start', phase: 'mdd-plan' }])), ValidationError);
  const recorded = Workflow.replay({ answers, route: lowExplore }, events);
  assert.deepEqual(recorded.snapshot().evaluation.phases, lowExplore);
  assert.deepEqual(recorded.nextAction(), { kind: 'await-result', phase: 'mdd-plan' });
  assert.match(recorded.snapshot().evaluation.reasons.at(-1), /keeps the route it started with/);
  // A legacy record keeps its route through every restart and replays to the same state.
  assert.deepEqual(Workflow.recordedRequest({ answers, route: lowExplore }, recorded), { answers, route: lowExplore });
  // A new run's record is just its request; the replayed risk events select its tail.
  const started = new Workflow({ answers, explore: true });
  const request = Workflow.recordedRequest({ answers, explore: true }, started);
  assert.deepEqual(request, { answers, explore: true });
  assert.deepEqual(Workflow.replay(request, []).snapshot(), started.snapshot());
  assert.deepEqual(started.nextAction(), { kind: 'execute', phase: 'mdd-explore' });
});

test('a record without its route is replayed as a new run, else on the only legacy route its history fits', () => {
  const events = [{ kind: 'start', phase: 'mdd-explore' }, { kind: 'result', result: result('mdd-explore') },
    { kind: 'start', phase: 'mdd-plan' }];
  const legacy = Workflow.replay({ answers }, events);
  assert.deepEqual(legacy.snapshot().evaluation.phases, ['mdd-explore', ...low]);
  assert.deepEqual(legacy.snapshot().results, [result('mdd-explore')]);
  // Exploration alone is a valid new run: it continues to the risk stop, never to a guessed route.
  const fresh = Workflow.replay({ answers }, [{ kind: 'start', phase: 'mdd-explore' }, { kind: 'result', result: result('mdd-explore') }]);
  assert.deepEqual(fresh.nextAction(), { kind: 'execute-risk' });
  // A recorded route is authoritative: it is never swapped for another one that would fit.
  assert.throws(() => Workflow.replay({ answers, route: low }, events), ValidationError);
});

test('a recorded route must be a route the policy can choose', () => {
  for (const route of [[], ['mdd-apply'], ['mdd-plan', 'mdd-verify'], [...low, 'mdd-verify'], 'mdd-plan', null,
    ['mdd-explore', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply']]) {
    assert.throws(() => new Workflow({ answers, route }), ValidationError, JSON.stringify(route));
  }
  assert.deepEqual(new Workflow({ answers, route: ['mdd-explore', ...high] }).snapshot().evaluation.route, 'high');
});

for (const recorded of [true, false]) {
  test(`route-aware replay keeps completed Apply batches after interruption (${recorded ? 'recorded' : 'legacy'} route)`, () => {
    // A run that started on its recorded score-routed route, before the mdd-risk stop existed.
    const workflow = new Workflow({ answers, route: ['mdd-explore', ...low] });
    workflow.start('mdd-explore');
    workflow.recordResult(result('mdd-explore'));
    workflow.start('mdd-plan');
    workflow.recordResult({ ...result('mdd-plan'), applyPlan: [
      { id: 'first', dependsOn: [] }, { id: 'second', dependsOn: ['first'] },
    ] });
    workflow.start('mdd-apply');
    workflow.recordResult({ ...result('mdd-apply'), completed: ['first'], batchID: 'batch-first' });
    workflow.start('mdd-apply');
    const request = recorded ? Workflow.recordedRequest({ answers, route: ['mdd-explore', ...low] }, workflow) : { answers };
    const resumed = Workflow.replay(request, workflow.history());
    assert.deepEqual(resumed.snapshot().evaluation.phases, ['mdd-explore', ...low]);
    assert.deepEqual(resumed.applyProgress(), workflow.applyProgress());
    assert.deepEqual(resumed.nextAction(), { kind: 'await-result', phase: 'mdd-apply' });
    resumed.retry();
    assert.deepEqual(resumed.applyProgress().completed, ['first']);
    resumed.start('mdd-apply');
    rejectsUnchanged(resumed, () => resumed.recordResult({ ...result('mdd-apply'), completed: ['first'], batchID: 'batch-second' }));
    resumed.recordResult({ ...result('mdd-apply'), completed: ['second'], batchID: 'batch-second' });
    assert.deepEqual(resumed.nextAction(), { kind: 'execute', phase: 'mdd-verify' });
    assert.deepEqual(resumed.applyProgress().completed, ['first', 'second']);
  });
}
