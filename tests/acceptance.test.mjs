import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptance, decisions, validatePlan, verification } from '../dist/acceptance.js';
import { deliverables } from '../dist/phase-evidence.js';
import { traceFixture } from './adapter-fixture.mjs';

function fixture() {
  const data = traceFixture();
  const accepted = acceptance(data.acceptance);
  const choices = decisions(data.decisions, accepted);
  const steps = deliverables(data.deliverables);
  const assessment = { status: 'verified', checks: ['npm test'], assessment: 'The source and test output support the expected behavior.' };
  const result = { scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: steps[0].id, ...assessment })),
    steps: [{ stepID: steps[0].id, ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }], changes: 'Input validation now follows the plan.', limits: [] };
  const reported = ['npm test'];
  return { data, accepted, choices, steps, result, reported };
}
test('compact acceptance map validates scenario/decision/dependency applicability', () => {
  const f = fixture(); validatePlan(f.accepted, f.choices, f.steps);
  assert.equal(verification(f.result, f.accepted, f.choices, f.steps, f.reported).matched, true);
});
for (const [name, change] of Object.entries({
  'duplicate scenario': data => { data.acceptance.requirements[0].scenarios[1].id = 'S1'; },
  'empty scenario list': data => { data.acceptance.requirements[0].scenarios = []; },
  'unknown decision requirement': data => { data.decisions[0].requirements = ['invented']; },
  'unknown step scenario': data => { data.deliverables[0].scenarios = ['invented']; },
  'omitted accepted scenario': data => { data.deliverables[0].scenarios = ['S1']; },
  'omitted decision': data => { data.deliverables[0].decisions = []; },
  'self dependency': data => { data.deliverables[0].dependsOn = [data.deliverables[0].id]; },
  'null references': data => { data.deliverables[0].decisions = null; },
})) {
  test(`acceptance integrity rejects ${name}`, () => {
    const data = traceFixture(); change(data);
    assert.throws(() => { const accepted = acceptance(data.acceptance); validatePlan(accepted, decisions(data.decisions, accepted), deliverables(data.deliverables)); });
  });
}
for (const [name, change] of Object.entries({
  'missing scenario': result => { result.scenarios.pop(); },
  'duplicate scenario': result => { result.scenarios[1] = result.scenarios[0]; },
  'invented requirement': result => { result.scenarios[0].requirementID = 'invented'; },
  'invented step link': result => { result.scenarios[0].stepID = 'invented'; },
  'missing step': result => { result.steps = []; },
  'missing decision': result => { result.decisions = []; },
  'a check the phase never reported': result => { result.steps[0].checks = ['npm run invented']; },
  'unsupported verified claim': result => { result.steps[0].checks = []; },
  'no semantic assessment': result => { result.scenarios[0].assessment = ''; },
})) {
  test(`verification cannot silently accept ${name}`, () => {
    const f = fixture(); change(f.result);
    assert.throws(() => verification(f.result, f.accepted, f.choices, f.steps, f.reported));
  });
}
test('explicit plan drift and not-verified acceptance remain visible instead of matching', () => {
  const f = fixture();
  f.result.decisions[0].status = 'deviation'; f.result.decisions[0].assessment = 'Validation moved away from the planned boundary.';
  f.result.scenarios[1].status = 'not-verified'; f.result.scenarios[1].checks = [];
  const checked = verification(f.result, f.accepted, f.choices, f.steps, f.reported);
  assert.equal(checked.matched, false);
  assert.equal(checked.decisions[0].assessment, 'Validation moved away from the planned boundary.');
});

test('a compact plan needs no invented decisions, dependencies or extra checks', () => {
  const data = traceFixture(); data.decisions = [];
  delete data.deliverables[0].decisions; delete data.deliverables[0].dependsOn;
  const accepted = acceptance(data.acceptance); const steps = deliverables(data.deliverables);
  validatePlan(accepted, decisions(data.decisions, accepted), steps);
  assert.equal(steps.length, 1); assert.equal(steps[0].check, 'npm test');
  assert.deepEqual(steps[0].decisions, []); assert.deepEqual(steps[0].dependsOn, []);
});
test('known IDs cannot be rewired into an unplanned scenario-step association', () => {
  const f = fixture();
  f.steps[0].scenarios = ['S1'];
  f.steps.push({ ...f.steps[0], id: 'error-handling', scenarios: ['S2'], dependsOn: [f.steps[0].id] });
  validatePlan(f.accepted, f.choices, f.steps);
  f.result.scenarios[0].stepID = 'error-handling';
  assert.throws(() => verification(f.result, f.accepted, f.choices, f.steps, f.reported), /invents/);
});
