import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptance, decisions, shortText, validatePlan, verification, MAX_REPORTED_PROBLEMS } from '../dist/acceptance.js';
import { deliverables, executed, verifyReport } from '../dist/phase-evidence.js';
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

test('one-line text names the rule it broke, where, and on what value', () => {
  assert.throws(() => shortText(undefined, 'what changed'), { message: 'what changed is missing.' });
  assert.throws(() => shortText(42, 'what changed'), { message: 'what changed must be text; it read "42".' });
  assert.throws(() => shortText('   ', 'what changed'), { message: 'what changed is empty; give nonempty text.' });
  assert.throws(() => shortText('npm test\nnpm run lint', 'checks[3].command', Infinity), error => {
    assert.match(error.message, /^checks\[3\]\.command "npm test\\nnpm run lint" contains the control character U\+000A \(a line break\) at character 9\./);
    assert.match(error.message, /keep it on one line/);
    assert.equal(error.message.includes('limit'), false, 'an unbounded field never mentions a length limit');
    return true;
  });
  assert.throws(() => shortText('x'.repeat(260), 'remaining limit 2', 250), error => {
    assert.match(error.message, /^remaining limit 2 "x{64}…" is 260 characters, above its 250-character limit\. To fix it, shorten it\.$/);
    assert.equal(error.message.includes('control'), false, 'a length problem is not reported as a control character');
    return true;
  });
  assert.equal(shortText('  npm test  ', 'command', Infinity), 'npm test');
});

test('an executed command has no length limit and can still be cited exactly', () => {
  const f = fixture();
  const probe = `node -e "${'console.log(1);'.repeat(80)}"`;
  assert.ok(probe.length > 1000);
  f.result.steps[0].checks = [probe];
  const read = verifyReport([{ command: 'npm test', exit: 0 }, { command: probe, exit: 0 }], f.result, { accepted: f.accepted, choices: f.choices, planned: f.steps });
  assert.equal(read.ran[1].command, probe);
  assert.deepEqual(read.verification.steps[0].checks, [probe]);
  assert.equal(read.verification.matched, true);
  const planned = deliverables(f.data.deliverables.map(step => ({ ...step, check: probe })));
  assert.equal(planned[0].check, probe, 'a planned check command is not length-limited either');
});

test('executed checks name every malformed entry by its position', () => {
  assert.throws(() => executed([{ command: 'npm test', exit: 0 }, { command: 'a\tb', exit: 0 }, { command: '', exit: 1.5 }]), error => {
    assert.match(error.message, /The executed checks has 3 problem\(s\)/);
    assert.match(error.message, /checks\[1\]\.command "a\\tb" contains the control character U\+0009 \(a tab\) at character 2/);
    assert.match(error.message, /checks\[2\]\.exit must be an integer exit code/);
    assert.match(error.message, /checks\[2\]\.command is empty/);
    return true;
  });
  assert.throws(() => executed(Array(33).fill({ command: 'npm test', exit: 0 })), /at most 32 entries; this report lists 33/);
});

test('a Verify report is refused once, for its checks and its verification together', () => {
  // The observed failure: a rejected command was fixed and re-sent, only to be refused again for a
  // fifth limit that had been in the same report the whole time.
  const f = fixture();
  f.result.limits = ['one', 'two', 'three', 'four', 'five'];
  f.result.scenarios[0].assessment = '';
  assert.throws(() => verifyReport([{ command: 'npm test', exit: 0 }, { command: 'npm run\nlint', exit: 0 }], f.result,
    { accepted: f.accepted, choices: f.choices, planned: f.steps }), error => {
    assert.match(error.message, /The verification report has 3 problem\(s\)/);
    assert.match(error.message, /\(1\) checks\[1\]\.command "npm run\\nlint" contains the control character U\+000A/);
    assert.match(error.message, /source-based assessment of scenario S1 on deliverable cli-validation is empty/);
    assert.match(error.message, /at most four concise items; this report lists 5/);
    // A malformed assessment still covers its link, so the same mistake is not also an omission.
    assert.equal(error.message.includes('omits'), false);
    return true;
  });
});

test('a malformed checks list is reported once, not again for every assessment citing it', () => {
  const f = fixture();
  assert.throws(() => verifyReport('npm test', f.result, { accepted: f.accepted, choices: f.choices, planned: f.steps }), error => {
    assert.equal(error.message, 'Report executed checks as a list of at most 32 entries.');
    return true;
  });
});

test('without a held plan, verification is checked for its own consistency only', () => {
  const f = fixture();
  // Links the run would call invented are not this check's to judge.
  f.result.scenarios[0].stepID = 'unknown-step';
  assert.equal(verifyReport([{ command: 'npm test', exit: 0 }], f.result).verification.matched, true);
  f.result.steps[0].checks = ['npm run never-reported'];
  assert.throws(() => verifyReport([{ command: 'npm test', exit: 0 }], f.result), /did not report running/);
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
