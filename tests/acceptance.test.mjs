import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptance, decisions, validatePlan, verification, MAX_REPORTED_PROBLEMS } from '../dist/acceptance.js';
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
test('a plan with one problem is rejected in exactly the words it always was', () => {
  const data = traceFixture();
  data.deliverables[0].decisions = [];
  const accepted = acceptance(data.acceptance);
  assert.throws(
    () => validatePlan(accepted, decisions(data.decisions, accepted), deliverables(data.deliverables)),
    error => {
      assert.match(error.message, /^Plan omits decision D1 on requirement R1: /);
      assert.equal(error.message.includes('problem(s)'), false, 'a single problem is not wrapped in a list');
      return true;
    });
});

test('a plan with several problems reports them together instead of one per round trip', () => {
  // The observed failure this replaces: three rewrites of the whole plan, one per unlinked ID.
  const data = traceFixture();
  data.deliverables[0].scenarios = ['S1'];
  data.deliverables[0].decisions = [];
  const accepted = acceptance(data.acceptance);
  assert.throws(
    () => validatePlan(accepted, decisions(data.decisions, accepted), deliverables(data.deliverables)),
    error => {
      assert.match(error.message, /problem\(s\)/);
      assert.match(error.message, /Fix them together and restate the report once/);
      assert.match(error.message, /\(1\) /);
      assert.match(error.message, /\(2\) /);
      // Both are actually named, so the actor can remap every ID in one pass.
      assert.match(error.message, /omits accepted scenario S2/);
      assert.match(error.message, /omits decision D1/);
      return true;
    });
});

test('a plan with more problems than fit is bounded and says so', () => {
  const data = traceFixture();
  const requirement = data.acceptance.requirements[0];
  requirement.scenarios = Array.from({ length: MAX_REPORTED_PROBLEMS + 3 }, (_, index) => ({
    id: `S${index + 1}`, given: 'given', when: 'when', then: 'then',
  }));
  // Nothing covers any of them, so every scenario is its own omission.
  data.deliverables = [{ ...data.deliverables[0], scenarios: ['S1'], decisions: [], dependsOn: [] }];
  const accepted = acceptance(data.acceptance);
  assert.throws(
    () => validatePlan(accepted, decisions(data.decisions, accepted), deliverables(data.deliverables)),
    error => {
      assert.match(error.message, new RegExp(`\\(${MAX_REPORTED_PROBLEMS}\\) `));
      assert.equal(error.message.includes(`(${MAX_REPORTED_PROBLEMS + 1}) `), false, 'the list is capped');
      assert.match(error.message, /more of the same kind/);
      return true;
    });
});

test('verification coverage gaps are reported together', () => {
  // Two deliverables, one scenario each, so scenario coverage can be complete while the step and
  // decision cross-checks below it both fail — which is where one-at-a-time rejection used to bite.
  const data = traceFixture();
  data.deliverables = [
    { ...data.deliverables[0], id: 'T1', scenarios: ['S1'], decisions: ['D1'], dependsOn: [] },
    { ...data.deliverables[0], id: 'T2', scenarios: ['S2'], decisions: ['D1'], dependsOn: ['T1'] },
  ];
  const accepted = acceptance(data.acceptance);
  const choices = decisions(data.decisions, accepted);
  const steps = deliverables(data.deliverables);
  validatePlan(accepted, choices, steps);
  const assessment = { status: 'verified', checks: ['npm test'], assessment: 'The source and test output support the expected behavior.' };
  const result = {
    scenarios: [{ requirementID: 'R1', scenarioID: 'S1', stepID: 'T1', ...assessment },
      { requirementID: 'R1', scenarioID: 'S2', stepID: 'T2', ...assessment }],
    steps: [{ stepID: 'T1', ...assessment }], decisions: [],
    changes: 'Input validation now follows the plan.', limits: [],
  };
  assert.throws(
    () => verification(result, accepted, choices, steps, ['npm test']),
    error => {
      assert.match(error.message, /problem\(s\)/);
      assert.match(error.message, /omits coverage of planned deliverable T2/);
      assert.match(error.message, /omits coverage of plan decision D1/);
      return true;
    });
});

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

test('complete parallel metadata survives normalization and held-plan JSON reconstruction', () => {
  const f = fixture();
  const parallel = { complete: true, reads: ['src/shared.ts'], writes: ['src/cli.ts', 'tests/cli.test.mjs'] };
  f.data.deliverables[0].parallel = parallel;
  const steps = deliverables(f.data.deliverables);
  validatePlan(f.accepted, f.choices, steps);
  assert.deepEqual(steps[0].parallel, parallel);
  assert.deepEqual(deliverables(JSON.parse(JSON.stringify(steps))), steps);
  parallel.writes.push('package-lock.json');
  assert.equal(steps[0].parallel.writes.length, 2, 'scope arrays are detached');
});

test('omitted dependency declaration cannot become an opt-in through normalized empty dependencies', () => {
  const f = fixture();
  delete f.data.deliverables[0].dependsOn;
  f.data.deliverables[0].parallel = { complete: true, reads: [], writes: ['src/cli.ts'] };
  const steps = deliverables(f.data.deliverables);
  validatePlan(f.accepted, f.choices, steps);
  assert.deepEqual(steps[0].dependsOn, []);
  assert.equal(steps[0].parallel, undefined);
  assert.equal(deliverables(JSON.parse(JSON.stringify(steps)))[0].parallel, undefined);
});

for (const parallel of [{}, { complete: false }, { complete: true, reads: [] }, { complete: true, reads: [], writes: [] }]) {
  test(`valid incomplete footprint remains accepted: ${JSON.stringify(parallel)}`, () => {
    const f = fixture(); f.data.deliverables[0].parallel = parallel;
    const steps = deliverables(f.data.deliverables);
    validatePlan(f.accepted, f.choices, steps);
    assert.deepEqual(steps[0].parallel, parallel);
  });
}

for (const parallel of [null, [], true, { complete: 'true' }, { extra: true }, { reads: null },
  { writes: [42] }, { reads: new Array(1) }, { writes: Array.from({ length: 65 }, (_, index) => `src/${index}.ts`) },
  { reads: ['src/a.ts', 'src/a.ts'] }, { writes: ['src/A.ts', 'src/a.ts'] }]) {
  test(`malformed parallel metadata is rejected: ${JSON.stringify(parallel)}`, () => {
    const f = fixture(); f.data.deliverables[0].parallel = parallel;
    assert.throws(() => deliverables(f.data.deliverables), /parallel|scope/);
    delete f.data.deliverables[0].dependsOn;
    assert.throws(() => deliverables(f.data.deliverables), /parallel|scope/, 'fallback never hides malformed metadata');
  });
}

for (const path of ['../outside', 'src/../a.ts', '/absolute', 'C:/absolute', 'src\\a.ts', 'src//a.ts',
  './a.ts', 'src/', 'src/*.ts', 'src/[a].ts', 'src/{a,b}', 'a?.ts', 'a:stream', 'a. ', 'a.', 'NUL.txt', 'a\u0000',
  'src/SHORT~1.ts', 'src/\u00e9.ts']) {
  test(`parallel scope rejects noncanonical path ${JSON.stringify(path)}`, () => {
    const f = fixture(); f.data.deliverables[0].parallel = { complete: true, reads: [], writes: [path] };
    assert.throws(() => deliverables(f.data.deliverables), /scope/);
  });
}
