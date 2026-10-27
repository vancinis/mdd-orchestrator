import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Workflow, currentGeneration } from '../dist/workflow.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore, sealResumeData, validateCheckpoint } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { completeRemaining, remainingSteps } from '../dist/apply-batches.js';
import { verifyReport } from '../dist/phase-evidence.js';
import { deepestCause, failingRequirements, tracedLinks, verificationFindings } from '../dist/acceptance.js';
import { nextAction } from '../dist/next-action.js';
import { reportDocument, structuredTraceFixture, structuredVerificationFixture, throughRiskStop } from './adapter-fixture.mjs';

// The incident behind these tests: a design declared it could not meet a requirement and still
// passed; Verify failed it three times and recommended design rework, but rework could only return
// to Apply, which split the correction across four scoped actors and moved the same failure one
// fallback deeper each round. Every behavior below answers one link of that chain.

const answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };
const report = data => reportDocument({ evidenceSummary: 'Phase evidence.', artifact: 'Phase artifact.', ...data });
const trace = () => structuredTraceFixture();
const STEP = 'cli-validation';
const FINDINGS = ['S1', 'S2', STEP, 'D1', `${STEP}-check`];

function failedVerify(cause, requirementID = 'R1') {
  const assessment = { status: 'not-verified', checks: [], assessment: 'A failed login still restores after a fresh restart.', ...(cause ? { cause } : {}) };
  return { outcome: 'failed', checks: [], verification: {
    scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID, scenarioID, stepID: STEP, ...assessment })),
    steps: [{ stepID: STEP, ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }],
    changes: 'Correction needed.', limits: [],
    checkResults: [{ checkID: `${STEP}-check`, disposition: 'blocked', executions: [], reason: 'Blocked until the restart failure is closed.' }], supplementalChecks: [],
  } };
}
const closure = (ids = FINDINGS) => ids.map(id => ({ id, status: 'closed', evidence: `Probe for ${id} failed first and passes after the change (exit 0).` }));

async function fixture(t, route = 'low', sessionID = 'ses_rework') {
  const root = mkdtempSync(join(tmpdir(), 'mdd-rework-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = { sessionID, agent: 'mdd-orchestrator', directory: root, worktree: root };
  const durable = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  let runner = new PhaseRunner(inspect, { checkpoint: durable, progress });
  let ordinal = 0;
  const f = {
    root, runtime, durable,
    get runner() { return runner; },
    status: () => runner.status(runtime.sessionID),
    async dispatch() {
      const call = { sessionID: runtime.sessionID, callID: `call-${++ordinal}` };
      return { call, args: await runner.before(call, f.status().task) };
    },
    async finish(data) {
      const { call, args } = await f.dispatch();
      await runner.after(call, args, report(data));
      return { call, args };
    },
    async restart() {
      runner = new PhaseRunner(inspect, { checkpoint: durable, progress });
      return runner.restore(runtime);
    },
    saved: () => durable.read(runtime.sessionID),
  };
  await runner.start({ preflight: { answers }, requirements: 'Keep failed logins signed out across restarts.' }, runtime,
    { requirementsConfirmed: true, userMessageID: 'user-rework' });
  await throughRiskStop(runner, runtime.sessionID, route);
  return f;
}

test('workflow: a Verify rework is one correction pass; replay keeps the older step-by-step form', () => {
  const plan = [{ id: 'first', dependsOn: [] }, { id: 'second', dependsOn: ['first'] }];
  const failedRun = () => {
    const workflow = new Workflow({ answers });
    workflow.start('mdd-explore'); workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored.' });
    workflow.startRisk(); workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Low.', route: 'low' });
    workflow.start('mdd-plan'); workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Planned.', applyPlan: plan });
    for (const [index, id] of ['first', 'second'].entries()) {
      workflow.start('mdd-apply');
      workflow.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'Applied.', batchID: `batch-1-${index}`, completed: [id] });
    }
    workflow.start('mdd-verify'); workflow.recordResult({ phase: 'mdd-verify', outcome: 'failed', evidenceSummary: 'Failed.' });
    return workflow;
  };
  const corrected = failedRun();
  corrected.rework('mdd-apply');
  assert.equal(corrected.correcting(), true);
  assert.deepEqual(remainingSteps(corrected.applyProgress()), ['first', 'second']);
  corrected.start('mdd-apply');
  corrected.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'Corrected.', batchID: 'batch-2-a', completed: ['first', 'second'] });
  assert.equal(corrected.correcting(), false);
  assert.deepEqual(corrected.nextAction(), { kind: 'execute', phase: 'mdd-verify' });
  assert.deepEqual(Workflow.replay({ answers }, corrected.history()).nextAction(), { kind: 'execute', phase: 'mdd-verify' });
  // A history recorded before the correction pass existed completed one step per result.
  const legacy = failedRun();
  legacy.rework('mdd-apply');
  legacy.start('mdd-apply');
  legacy.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'First.', batchID: 'batch-2-a', completed: ['first'] });
  assert.deepEqual(legacy.nextAction(), { kind: 'execute', phase: 'mdd-apply' });
  assert.equal(Workflow.replay({ answers }, legacy.history()).applyProgress().completed.join(), 'first');
  assert.throws(() => completeRemaining({ epoch: 1, planned: plan, completed: [] }, ['second', 'first']), /every remaining deliverable in plan order \(first, second\)/);
  assert.throws(() => completeRemaining({ epoch: 1, planned: plan, completed: [] }, ['first']), /partial correction earns no progress/);
});

test('workflow: a rework to a planning phase releases the held plan and starts a new generation', () => {
  const workflow = new Workflow({ answers });
  workflow.start('mdd-explore'); workflow.recordResult({ phase: 'mdd-explore', outcome: 'passed', evidenceSummary: 'Explored.' });
  workflow.startRisk(); workflow.recordRiskResult({ outcome: 'passed', evidenceSummary: 'Low.', route: 'low' });
  workflow.start('mdd-plan'); workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Planned.', applyPlan: [{ id: 'first', dependsOn: [] }] });
  workflow.start('mdd-apply'); workflow.recordResult({ phase: 'mdd-apply', outcome: 'passed', evidenceSummary: 'Applied.', batchID: 'batch-1-a', completed: ['first'] });
  workflow.start('mdd-verify'); workflow.recordResult({ phase: 'mdd-verify', outcome: 'failed', evidenceSummary: 'Design gap.' });
  assert.equal(workflow.generation().length, 4);
  workflow.rework('mdd-plan');
  assert.equal(workflow.correcting(), false);
  assert.deepEqual(workflow.applyProgress(), { epoch: 2, planned: [], completed: [] });
  workflow.start('mdd-plan'); workflow.recordResult({ phase: 'mdd-plan', outcome: 'passed', evidenceSummary: 'Replanned.', applyPlan: [{ id: 'other', dependsOn: [] }] });
  assert.deepEqual(workflow.generation().map(result => result.phase), ['mdd-plan']);
  assert.deepEqual(workflow.applyProgress(), { epoch: 3, planned: [{ id: 'other', dependsOn: [] }], completed: [] });
  const replayed = Workflow.replay({ answers }, workflow.history());
  assert.deepEqual(replayed.generation(), workflow.generation());
  // The boundary is visible from results alone, so a preserved dossier reads it the same way.
  assert.deepEqual(currentGeneration(workflow.snapshot().results, workflow.snapshot().evaluation.phases).map(result => result.evidenceSummary), ['Replanned.']);
});

test('verification rows carry a cause only on a gap, and findings are derived from the structured report', () => {
  const held = { accepted: trace().acceptance, choices: trace().decisions, planned: trace().deliverables, verificationVersion: 1 };
  const failed = failedVerify('design');
  const { verification } = verifyReport(failed.checks, failed.verification, held);
  assert.equal(deepestCause(verification), 'design');
  assert.deepEqual(verificationFindings(verification), FINDINGS);
  assert.deepEqual(failingRequirements(verification), ['R1']);
  const passing = structuredVerificationFixture(trace());
  passing.verification.scenarios[0].cause = 'design';
  assert.throws(() => verifyReport(passing.checks, passing.verification, held), /cannot name a cause; only a gap has one/);
  const unknown = failedVerify('luck');
  assert.throws(() => verifyReport(unknown.checks, unknown.verification, held), /unknown cause "luck"/);
  assert.equal(deepestCause(verifyReport(failedVerify().checks, failedVerify().verification, held).verification), 'implementation');
  assert.equal(failingRequirements({ scenarios: 'not rows' }).length, 0);
});

test('R03: mixed causes retain semantic precedence and same-requirement semantic rows', () => {
  const checked = failedVerify('verification').verification;
  assert.equal(deepestCause(checked), 'verification');
  assert.deepEqual(failingRequirements(checked), []);
  assert.deepEqual(verificationFindings(checked), FINDINGS);
  for (const cause of ['implementation', 'design', 'requirements']) {
    checked.scenarios[1].cause = cause;
    assert.equal(deepestCause(checked), cause);
    assert.deepEqual(failingRequirements(checked), ['R1']);
  }
  checked.steps[0].cause = 'design';
  checked.decisions[0].cause = 'implementation';
  assert.equal(deepestCause(checked), 'requirements');
});

for (const restored of [false, true]) {
  for (const [before, after] of [['verification', 'verification'], [undefined, 'verification'], ['verification', undefined]]) {
    test(`R03: ${before ?? 'legacy'} to ${after ?? 'legacy'} after passed Apply is not semantic repetition (${restored ? 'restored' : 'fresh'})`, async t => {
      const f = await fixture(t);
      await f.finish(trace());
      await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
      await f.finish(failedVerify(before));
      if (restored) assert.deepEqual(await f.restart(), { restored: true });
      f.runner.reset(f.runtime.sessionID, 'rework');
      const correction = await f.dispatch();
      assert.match(correction.args.prompt, /For semantic defects, first run its saved probe/);
      assert.match(correction.args.prompt, /execution\/evidence-only gaps/);
      assert.match(correction.args.prompt, /noChangeReason/);
      const recovered = { completed: [STEP], noChangeReason: 'Recovered execution evidence without source changes.',
        checks: [{ id: 'recovery', command: 'npm test', exit: 0 }], closure: closure().map(row => ({ ...row, evidence: 'Reran npm test, exit 0; recovered missing execution evidence.' })) };
      await assert.rejects(f.runner.after(correction.call, correction.args, report({ ...recovered,
        closure: recovered.closure.map((row, index) => index ? row : { ...row, status: 'open' }) })), /open|closed/);
      await f.runner.submit({ result: report(recovered) }, f.runtime);
      await f.finish(failedVerify(after));
      const check = () => {
        assert.equal(f.status().state, 'blocked');
        assert.equal(f.status().reworkable, 'mdd-apply');
        assert.doesNotMatch(f.status().reworkReason, /after a correction pass/);
        if (after === 'verification') assert.doesNotMatch(f.status().reworkReason, /gaps to the implementation/);
        assert.match(nextAction(f.status()).why, /scope phase/);
      };
      check();
      validateCheckpoint(f.saved().checkpoint);
      assert.deepEqual(await f.restart(), { restored: true });
      check();
      const checkpoint = f.saved().checkpoint;
      checkpoint.data.verification.scenarios[0].cause = 'unknown';
      checkpoint.dataDigest = sealResumeData(checkpoint.data, checkpoint.runID, checkpoint.parent, checkpoint.events, checkpoint.stable, checkpoint.request);
      assert.throws(() => validateCheckpoint(checkpoint), /unknown cause/);
    });
  }
}

test('R03: required check-only failure does not assert an implementation defect', async t => {
  const f = await fixture(t);
  await f.finish(trace());
  await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
  const failed = structuredVerificationFixture(trace());
  failed.outcome = 'failed';
  failed.verification.checkResults[0] = { checkID: `${STEP}-check`, disposition: 'blocked', executions: [], reason: 'Required environment unavailable.' };
  failed.verification.supplementalChecks = [{ id: 'semantic', requirement: 'optional', disposition: 'passed', executions: [failed.checks[0].id] }];
  await f.finish(failed);
  assert.equal(f.status().state, 'blocked');
  assert.equal(f.status().reworkable, 'mdd-apply');
  assert.doesNotMatch(f.status().reworkReason, /gaps to the implementation/);
  assert.match(f.status().reworkReason, /execution|evidence/);
  assert.deepEqual(await f.restart(), { restored: true });
  assert.doesNotMatch(f.status().reworkReason, /gaps to the implementation/);
});

test('a Verify gap attributed to the design recommends returning to planning, and that rework plans again', async t => {
  const f = await fixture(t);
  await f.finish(trace());
  const verify = await f.finish({ completed: [STEP], changes: ['src/session.ts'] }).then(() => f.dispatch());
  assert.match(verify.args.prompt, /^Save each reproduction probe you write in ".*probes.*" \(gitignored MDD data\) and cite its path and command\.$/m);
  await f.runner.after(verify.call, verify.args, report(failedVerify('design')));
  const blocked = f.status();
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.reworkable, 'mdd-plan');
  assert.deepEqual(blocked.reworkTargets, ['mdd-apply', 'mdd-plan']);
  assert.match(blocked.reworkReason, /held design/);
  assert.match(nextAction(blocked).why, /MDD recommends mdd-plan/);
  assert.match(nextAction(blocked).why, /phase set to their choice \(mdd-apply, mdd-plan\)/);
  assert.throws(() => f.runner.reset(f.runtime.sessionID, 'rework', undefined, 'mdd-spec'), /can return to mdd-apply, mdd-plan; mdd-spec is not one of them/);
  assert.throws(() => f.runner.reset(f.runtime.sessionID, 'phase', undefined, 'mdd-plan'), /Only scope rework names a target phase/);
  assert.equal(f.status().state, 'blocked');
  f.runner.reset(f.runtime.sessionID, 'rework', undefined, 'mdd-plan');
  const replanning = f.status();
  assert.equal(replanning.phase, 'mdd-plan'); assert.equal(replanning.state, 'ready');
  assert.deepEqual(replanning.planned, []); assert.equal(replanning.verification, undefined);
  assert.deepEqual(replanning.rework, { after: 'mdd-verify', target: 'mdd-plan', summary: 'Phase evidence.' });
  assert.equal(replanning.evidence.plan, 'invalidated');
  // The released state is a valid checkpoint: the failed Verify stays in history, unanswered by a plan.
  validateCheckpoint(f.saved().checkpoint);
  assert.deepEqual(await f.restart(), { restored: true });
  const plan = await f.finish(trace());
  assert.match(plan.args.prompt, /This route is being reworked: mdd-verify reported failure and the user sent it back to mdd-plan/);
  const apply = await f.dispatch();
  assert.equal(apply.args.description, `MDD apply ${STEP}`);
  assert.match(apply.args.prompt, /This plan replaces one whose implementation failed verification/);
  assert.doesNotMatch(apply.args.prompt, /This is a correction pass/);
  await f.runner.after(apply.call, apply.args, report({ completed: [STEP], changes: ['src/session.ts'] }));
  assert.equal(f.status().rework, undefined);
  await f.finish(structuredVerificationFixture(trace()));
  const done = f.status();
  assert.equal(done.state, 'complete');
  assert.deepEqual(done.workflow.results.map(item => `${item.phase}:${item.outcome}`),
    ['mdd-explore:passed', 'mdd-plan:passed', 'mdd-apply:passed', 'mdd-verify:failed', 'mdd-plan:passed', 'mdd-apply:passed', 'mdd-verify:passed']);
});

test('the same requirement failing again after a correction pass recommends redesign instead of another Apply', async t => {
  const f = await fixture(t);
  await f.finish(trace());
  await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
  await f.finish(failedVerify());
  const first = f.status();
  assert.equal(first.reworkable, 'mdd-apply');
  assert.match(first.reworkReason, /implementation/);
  f.runner.reset(f.runtime.sessionID, 'rework');
  const correction = await f.dispatch();
  assert.equal(correction.args.description, 'MDD apply correction');
  assert.match(correction.args.prompt, /first run its saved probe or turn it into a regression test and observe it fail/);
  assert.match(correction.args.prompt, new RegExp(`Report closure for each finding ID ${FINDINGS.join(', ')}`));
  await f.runner.after(correction.call, correction.args, report({ completed: [STEP], changes: ['src/session.ts'], closure: closure() }));
  // The correction's links name how each finding was closed, for the Verify that follows.
  assert.deepEqual(tracedLinks(f.saved().checkpoint.data.dependencies.at(-1).content).closure.map(entry => entry.id), FINDINGS);
  await f.finish(failedVerify());
  const again = f.status();
  assert.equal(again.reworkable, 'mdd-plan');
  assert.match(again.reworkReason, /Requirement\(s\) R1 failed verification again after a correction pass/);
  assert.deepEqual(await f.restart(), { restored: true });
  assert.equal(f.status().reworkable, 'mdd-plan', 'the recommendation is derived from recorded artifacts, so it survives restart');
  // A gap Verify attributes to the requirements themselves recommends revising them.
  const requirements = await fixture(t);
  await requirements.finish(trace());
  await requirements.finish({ completed: [STEP], changes: ['src/session.ts'] });
  await requirements.finish(failedVerify('requirements'));
  assert.equal(requirements.status().reworkable, 'mdd-plan');
  assert.match(requirements.status().reworkReason, /requirements themselves/);
});

for (const restored of [false, true]) {
  test(`Verify retries without corrective Apply retain implementation routing (${restored ? 'restored' : 'fresh'})`, async t => {
    const f = await fixture(t, 'low', restored ? 'ses_retry_restored' : 'ses_retry_fresh');
    await f.finish(trace());
    await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
    await f.finish(failedVerify());
    if (restored) assert.deepEqual(await f.restart(), { restored: true });
    // Retry the failed phase, not a user-authorized corrective Apply.
    f.runner.reset(f.runtime.sessionID, 'phase');
    const retry = failedVerify();
    retry.verification.scenarios.forEach(row => { row.assessment = 'The new process still accepts a previously rejected session.'; });
    await f.finish({ ...retry, evidenceSummary: 'Independent verification still finds R1 unmet.' });
    const assertRetry = () => {
      const status = f.status();
      assert.equal(status.state, 'blocked');
      assert.equal(status.reworkable, 'mdd-apply');
      assert.deepEqual(status.reworkTargets, ['mdd-apply', 'mdd-plan']);
      assert.doesNotMatch(status.reworkReason, /after a correction pass/);
      assert.deepEqual(status.workflow.results.slice(-2).map(result => `${result.phase}:${result.outcome}`),
        ['mdd-verify:failed', 'mdd-verify:failed']);
    };
    assertRetry();
    validateCheckpoint(f.saved().checkpoint);
    assert.deepEqual(await f.restart(), { restored: true });
    assertRetry();
  });
}

test('a historical successful correction does not count between later consecutive Verify retries', async t => {
  const f = await fixture(t, 'low', 'ses_correction_then_retry');
  await f.finish(trace());
  await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
  await f.finish(failedVerify());
  f.runner.reset(f.runtime.sessionID, 'rework');
  await f.finish({ completed: [STEP], changes: ['src/session.ts'], closure: closure() });
  assert.deepEqual(await f.restart(), { restored: true });
  await f.finish(failedVerify());
  assert.equal(f.status().reworkable, 'mdd-plan');
  f.runner.reset(f.runtime.sessionID, 'phase');
  await f.finish(failedVerify());
  assert.equal(f.status().reworkable, 'mdd-apply');
  assert.doesNotMatch(f.status().reworkReason, /after a correction pass/);
  assert.deepEqual(await f.restart(), { restored: true });
  assert.equal(f.status().reworkable, 'mdd-apply');
});

test('planning rework resets repeated requirement lineage even after a successful new Apply', async t => {
  const f = await fixture(t, 'low', 'ses_replanned_lineage');
  await f.finish(trace());
  await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
  await f.finish(failedVerify());
  f.runner.reset(f.runtime.sessionID, 'rework', undefined, 'mdd-plan');
  await f.finish(trace());
  await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
  assert.deepEqual(await f.restart(), { restored: true });
  await f.finish(failedVerify());
  assert.equal(f.status().reworkable, 'mdd-apply');
  assert.doesNotMatch(f.status().reworkReason, /after a correction pass/);
  assert.deepEqual(await f.restart(), { restored: true });
  assert.equal(f.status().reworkable, 'mdd-apply');
});

for (const [cause, target] of [['requirements', 'mdd-spec'], ['design', 'mdd-design']]) {
  test(`explicit ${cause} cause retains high-route escalation without correction`, async t => {
    const f = await fixture(t, 'high', `ses_explicit_${cause}`);
    await f.finish({});
    await f.finish({ domain: 'project', acceptance: trace().acceptance });
    await f.finish({ decisions: trace().decisions });
    await f.finish({ deliverables: trace().deliverables });
    await f.finish({ completed: [STEP], changes: ['src/session.ts'] });
    await f.finish(failedVerify(cause));
    assert.equal(f.status().reworkable, target);
    assert.deepEqual(await f.restart(), { restored: true });
    assert.equal(f.status().reworkable, target);
  });
}

test('a design that cannot meet a held requirement fails before implementation and can send the route back to spec', async t => {
  const f = await fixture(t, 'high');
  const { acceptance } = trace();
  await f.finish({});
  await f.finish({ domain: 'project', acceptance });
  const missing = [{ requirementID: 'R1', reason: 'A confirmed write can land after failure and restore once every cleanup fails.' }];
  const design = await f.dispatch();
  assert.match(design.args.prompt, /if no design within scope satisfies one, report outcome failed with unmet/);
  await assert.rejects(f.runner.after(design.call, design.args, report({ decisions: trace().decisions, unmet: missing })), /leaves held requirements unmet cannot pass/);
  await assert.rejects(f.runner.submit({ result: report({ outcome: 'failed', unmet: [{ requirementID: 'R9', reason: 'Unknown.' }] }) }, f.runtime), /R9 is not a held requirement/);
  await f.runner.submit({ result: report({ outcome: 'failed', unmet: missing }) }, f.runtime);
  const blocked = f.status();
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.phase, 'mdd-design');
  assert.equal(blocked.reworkable, 'mdd-spec'); assert.deepEqual(blocked.reworkTargets, ['mdd-spec']); assert.equal(blocked.reworkFrom, 'mdd-design');
  assert.match(nextAction(blocked).why, /named the held requirements it cannot satisfy/);
  assert.match(nextAction(blocked).why, /explicit exclusion/);
  assert.doesNotMatch(nextAction(blocked).why, /scope continue/);
  assert.deepEqual(tracedLinks(f.saved().checkpoint.data.dependencies.at(-1).content).unmet, missing);
  // Continuation without PASS belongs to a failed Verify alone.
  assert.equal(f.runner.failedVerification(f.runtime.sessionID), undefined);
  f.runner.reset(f.runtime.sessionID, 'rework');
  const respec = f.status();
  assert.equal(respec.phase, 'mdd-spec'); assert.equal(respec.state, 'ready');
  assert.deepEqual(respec.decisions, []);
  assert.deepEqual(respec.rework, { after: 'mdd-design', target: 'mdd-spec', summary: 'Phase evidence.' });
  assert.deepEqual(await f.restart(), { restored: true });
  const spec = await f.dispatch();
  assert.match(spec.args.prompt, /the user sent it back to mdd-spec/);
  assert.match(spec.args.prompt, /a revised acceptance names each changed or excluded requirement and why/);
  const revised = structuredClone(acceptance);
  revised.requirements[0].description = 'Handle valid and invalid input predictably; a late write after every cleanup fails is an explicit, documented exclusion.';
  await f.runner.after(spec.call, spec.args, report({ domain: 'project', acceptance: revised }));
  const redesign = await f.finish({ decisions: trace().decisions });
  assert.match(redesign.args.prompt, /the user sent it back to mdd-spec/);
  await f.finish({ deliverables: trace().deliverables });
  const apply = await f.dispatch();
  assert.doesNotMatch(apply.args.prompt, /This plan replaces one whose implementation failed/);
  await f.runner.after(apply.call, apply.args, report({ completed: [STEP], changes: ['src/session.ts'] }));
  await f.finish(structuredVerificationFixture(trace()));
  assert.equal(f.status().state, 'complete');
});

test('a design that fails without naming an unmet requirement is retried where it failed, not reworked', async t => {
  const f = await fixture(t, 'high');
  await f.finish({});
  await f.finish({ domain: 'project', acceptance: trace().acceptance });
  await f.finish({ outcome: 'failed', evidenceSummary: 'The repository could not be read.' });
  const blocked = f.status();
  assert.equal(blocked.state, 'blocked'); assert.equal(blocked.phase, 'mdd-design');
  assert.equal(blocked.reworkable, undefined);
  assert.throws(() => f.runner.reset(f.runtime.sessionID, 'rework'), /Use scope phase to run the current phase again/);
  assert.deepEqual(nextAction(blocked).args, { scope: 'phase' });
});

test('next action: a failed planning phase offers the earlier phase, not continuation', () => {
  const action = nextAction({ state: 'blocked', reworkable: 'mdd-spec', reworkTargets: ['mdd-spec'], reworkFrom: 'mdd-design', reworkReason: 'R1 cannot be met.' });
  assert.equal(action.tool, 'mdd_reset'); assert.equal(action.args, undefined);
  assert.match(action.why, /phase set to their choice \(mdd-spec\)/);
  assert.match(action.why, /scope phase retries mdd-design/);
  assert.doesNotMatch(action.why, /scope continue/);
});
