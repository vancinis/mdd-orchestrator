import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReportForm, checkRiskReportForm } from '../dist/report-check.js';
import { reportFormatLines } from '../dist/phase-report.js';
import { riskReportFormatLines } from '../dist/risk.js';
import { reportDocument, traceFixture } from './adapter-fixture.mjs';
import * as checker from '../dist/report-check.js';

const planReport = (overrides = {}) => reportDocument({
  outcome: 'passed', evidenceSummary: 'The plan links every accepted scenario to a deliverable.',
  artifact: 'Plan: implement the scoped feature and check it.', ...traceFixture(), ...overrides,
});

test('a readable report checks clean, and says a clean check is not an acceptance', () => {
  const checked = checkReportForm('mdd-plan', planReport());
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.ok, true);
  assert.match(checked.note, /not an acceptance/);
  // The form is handed back either way, so a fix has the shape in front of it.
  assert.deepEqual(checked.resultFormat, reportFormatLines('mdd-plan'));
});

test('summary, how, artifact and the report have no size limit', () => {
  // None of these is bounded, so a large report is never a problem of form.
  const document = reportDocument({
    outcome: 'passed', evidenceSummary: 'x'.repeat(50000), how: 'h'.repeat(50000), artifact: 'y'.repeat(100000),
  });
  assert.ok(Buffer.byteLength(document) > 200000);
  const checked = checkReportForm('mdd-explore', document);
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.ok, true);
});

test('a large plan report passes the form check', () => {
  const checked = checkReportForm('mdd-plan', planReport({ evidenceSummary: 'x'.repeat(10000), artifact: 'y'.repeat(50000) }));
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.ok, true);
});

test('a document with no envelope reports that alone, because nothing below it can be read', () => {
  for (const text of ['', '   ', 'z'.repeat(20001), undefined, 42]) {
    const checked = checkReportForm('mdd-plan', text);
    assert.equal(checked.ok, false);
    assert.equal(checked.problems.length, 1, `one problem for ${typeof text}`);
  }
});

test('an unreadable outcome is named, and quotes what was actually written', () => {
  const checked = checkReportForm('mdd-plan', planReport({ outcome: 'maybe' }));
  assert.equal(checked.ok, false);
  assert.deepEqual(checked.problems, ['The phase report\'s outcome must be exactly "passed" or "failed"; it read "maybe".']);
});

test('phase-specific shape is checked, and only what a document can answer on its own', () => {
  // Tasks must carry deliverables that parse.
  const broken = checkReportForm('mdd-tasks', reportDocument({
    outcome: 'passed', evidenceSummary: 'Steps drafted.', artifact: 'Steps.',
    ...traceFixture(), deliverables: [{ id: 'T1', description: 'x', path: 'src/cli.ts', check: 'npm test', scenarios: [], decisions: [], dependsOn: [] }],
  }));
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some(problem => /scenarios of deliverable T1/.test(problem)));

  // A failed outcome is not asked for the fields a passing one carries.
  const failed = checkReportForm('mdd-tasks', reportDocument({
    outcome: 'failed', evidenceSummary: 'The step list could not be completed.', artifact: 'What blocked it.',
  }));
  assert.deepEqual(failed.problems, []);
});

// The narrative is checked where the actor can still fix it. Leaving a section out is not a
// problem of form: the renderer says it is missing rather than refusing the work.
test('narrative sections are checked for form, never demanded', () => {
  const narrative = { approach: 'Linked every scenario.', purpose: 'Make the plan executable.', openItems: 'None.', learnings: 'None.', confidence: 'High — every link validated.' };
  assert.deepEqual(checkReportForm('mdd-plan', planReport(narrative)).problems, []);
  assert.deepEqual(checkReportForm('mdd-plan', planReport()).problems, []);
  const vague = checkReportForm('mdd-plan', planReport({ ...narrative, confidence: 'Pretty sure it works.' }));
  assert.equal(vague.ok, false);
  assert.ok(vague.problems.some(problem => /exactly one level word, High, Medium or Low/.test(problem)), vague.problems.join(' | '));
  const bare = checkReportForm('mdd-plan', planReport({ ...narrative, confidence: 'Medium' }));
  assert.ok(bare.problems.some(problem => /evidence behind its level/.test(problem)), bare.problems.join(' | '));
});

test('cross-link problems are left to the run, which is the only place that holds the IDs', () => {
  // A plan whose deliverable covers only half the accepted scenarios is readable as a document.
  // `validatePlan` is what rejects it, reporting every broken link at once.
  const data = traceFixture();
  data.deliverables[0].scenarios = ['S1'];
  const checked = checkReportForm('mdd-plan', planReport(data));
  assert.deepEqual(checked.problems, []);
  assert.match(checked.note, /state only the run holds/);
});

test('checking is pure: the same document checks the same way every time', () => {
  const text = planReport({ evidenceSummary: 'x'.repeat(2500) });
  const first = checkReportForm('mdd-plan', text);
  const second = checkReportForm('mdd-plan', text);
  assert.deepEqual(first, second);
});

test('Apply report form requires exactly one stable completed ID without claiming to validate assignment', () => {
  const data = { changes: ['src/first.ts'] };
  for (const completed of [undefined, [], ['first', 'second'], ['first', 'first'], ['bad/id']]) {
    assert.equal(checkReportForm('mdd-apply', reportDocument({ evidenceSummary: 'Implemented.', artifact: 'Batch.', ...data, completed })).ok, false);
  }
  assert.equal(checkReportForm('mdd-apply', reportDocument({ evidenceSummary: 'Implemented.', artifact: 'Batch.', ...data, completed: ['first'] })).ok, true);
});

const verifyReport = (overrides = {}, data = {}) => {
  const assessment = { status: 'verified', checks: ['npm test'], assessment: 'Source and focused checks support the plan.' };
  return reportDocument({
    outcome: 'passed', evidenceSummary: 'Every planned link was checked against source.', artifact: 'Verification of the plan.',
    checks: [{ command: 'npm test', exit: 0 }],
    verification: {
      scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: 'cli-validation', ...assessment })),
      steps: [{ stepID: 'cli-validation', ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }],
      changes: 'Input validation follows the plan.', limits: [], ...data,
    },
    ...overrides,
  });
};

test('a readable Verify report checks clean, whatever the length of its commands', () => {
  const probe = `node -e "${'console.log(1);'.repeat(80)}"`;
  const checked = checkReportForm('mdd-verify', verifyReport({ checks: [{ command: 'npm test', exit: 0 }, { command: probe, exit: 0 }] }));
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.ok, true);
});

test('a failed Verify report is checked exactly as the run will read it', () => {
  // The observed miss: this check skipped `checks` on a failed Verify and cleared a report that
  // the run then refused, at the one moment the actor could still have fixed it.
  const checked = checkReportForm('mdd-verify', verifyReport(
    { outcome: 'failed', checks: [{ command: 'npm test', exit: 0 }, { command: 'npm run\nlint', exit: 1 }] },
    { limits: ['one', 'two', 'three', 'four', 'five'] }));
  assert.equal(checked.ok, false);
  assert.equal(checked.problems.length, 1, 'one rejection carrying every problem');
  assert.match(checked.problems[0], /2 problem\(s\)/);
  assert.match(checked.problems[0], /checks\[1\]\.command .* control character U\+000A/);
  assert.match(checked.problems[0], /this report lists 5/);

  const missing = checkReportForm('mdd-verify', reportDocument({ outcome: 'failed', evidenceSummary: 'Could not verify.', artifact: 'Blocked.' }));
  assert.equal(missing.ok, false, 'the run requires verification on every outcome, so the check does too');
  assert.ok(missing.problems.some(problem => /verification must be an object/.test(problem)), missing.problems.join(' | '));
});

test('a passed Verify report whose own assessments do not match is caught before it is sent', () => {
  const checked = checkReportForm('mdd-verify', verifyReport({}, { decisions: [{ decisionID: 'D1', status: 'deviation', checks: [], assessment: 'Validation moved.' }] }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /claiming a match the assessments do not support/.test(problem)));
});

const riskVerdict = (overrides = {}) => ({
  route: 'high', complexity: 'high',
  reason: 'The change touches authentication middleware shared by every route.',
  evidence: [{ source: 'mdd-explore finding 2', finding: 'auth.ts is imported by all route handlers' }],
  risks: [{ description: 'A regression here locks out every user.', evidence: 'auth.ts has no dedicated tests', mitigation: 'Add a regression test before merging.' }],
  ...overrides,
});

const riskReport = (overrides = {}) => reportDocument({
  outcome: 'passed', evidenceSummary: 'High complexity; recommend the high route.',
  how: 'auth.ts is imported by every route handler, so the exploration finding grounds a high route.',
  artifact: 'Touches shared authentication middleware with no dedicated tests.',
  risk: riskVerdict(overrides.risk), ...overrides,
});

test('a grounded risk report checks clean, names risk as the only data field, and exposes the parsed verdict', () => {
  const checked = checkRiskReportForm(riskReport());
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.ok, true);
  assert.match(checked.note, /not an acceptance/);
  assert.deepEqual(checked.resultFormat, riskReportFormatLines());
  // The verdict a caller would otherwise have to re-parse out of the same document.
  assert.deepEqual(checked.risk, riskVerdict());
});

test('a low-complexity risk report with no evidenced risk is accepted when explicitly justified', () => {
  const checked = checkRiskReportForm(riskReport({
    risk: riskVerdict({ route: 'low', complexity: 'low', risks: [],
      reason: 'The change is a local rename with no external callers.',
      risksJustification: 'No shared code path was found to carry any risk.' }),
  }));
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.risk.risksJustification, 'No shared code path was found to carry any risk.');
});

test('an empty risk list with no justification is rejected rather than silently accepted', () => {
  const checked = checkRiskReportForm(riskReport({
    risk: riskVerdict({ route: 'low', complexity: 'low', risks: [],
      reason: 'The change is a local rename with no external callers.' }),
  }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /risksJustification/.test(problem)));
});

test('a risksJustification on a nonempty risk list is rejected: it only explains an empty one', () => {
  const checked = checkRiskReportForm(riskReport({
    risk: riskVerdict({ risksJustification: 'This should not be here.' }),
  }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /only accepted when risks is empty/.test(problem)));
});

test('a failed outcome reports uncertainty without needing a risk verdict', () => {
  const checked = checkRiskReportForm(reportDocument({
    outcome: 'failed', evidenceSummary: 'Exploration found nothing touching this area.',
    how: 'Findings from mdd-explore do not reach the area the request describes.',
    artifact: 'Cannot substantiate a route; findings do not reach the changed code.',
  }));
  assert.deepEqual(checked.problems, []);
});

test('a risk report missing the required explanation is rejected', () => {
  const checked = checkRiskReportForm(reportDocument({
    outcome: 'passed', evidenceSummary: 'High complexity; recommend the high route.',
    artifact: 'Touches shared authentication middleware with no dedicated tests.',
    risk: riskVerdict(),
  }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /how must be nonempty text/.test(problem)));
});

test('a risk report data block carrying an extra key is rejected', () => {
  const checked = checkRiskReportForm(riskReport({ unexpected: 'not part of the risk schema' }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /unknown key\(s\): unexpected/.test(problem)));
});

test('a route that disagrees with its stated complexity is rejected', () => {
  const checked = checkRiskReportForm(riskReport({ risk: riskVerdict({ route: 'high', complexity: 'low' }) }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /must agree/.test(problem)));
});

test('an unknown route is rejected', () => {
  const checked = checkRiskReportForm(riskReport({ risk: riskVerdict({ route: 'medium', complexity: 'medium' }) }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /route must be exactly/.test(problem)));
});

test('evidence must be attributable: an empty evidence list is rejected', () => {
  const checked = checkRiskReportForm(riskReport({ risk: riskVerdict({ evidence: [] }) }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /evidence requires/.test(problem)));
});

test('a reported risk missing its mitigation is rejected rather than silently accepted', () => {
  const checked = checkRiskReportForm(riskReport({
    risk: riskVerdict({ risks: [{ description: 'A regression could lock out users.', evidence: 'no dedicated tests', mitigation: '' }] }),
  }));
  assert.equal(checked.ok, false);
  assert.ok(checked.problems.some(problem => /mitigation/.test(problem)));
});

test('a malformed risk envelope is rejected the same way a malformed phase report is', () => {
  for (const text of ['', '   ', 'z'.repeat(20001), undefined, 42]) {
    const checked = checkRiskReportForm(text);
    assert.equal(checked.ok, false);
    assert.equal(checked.problems.length, 1, `one problem for ${typeof text}`);
  }
});

test('security checker rejects missing data even on failure and rejects envelope authority fields', () => {
  assert.equal(typeof checker.checkSecurityReportForm, 'function');
  for (const outcome of ['passed', 'failed']) {
    const result = checker.checkSecurityReportForm(reportDocument({ outcome, evidenceSummary: 'Unknown coverage.',
      how: 'No snapshot was supplied.', artifact: 'Cannot inspect source.' }));
    assert.equal(result.ok, false);
    assert.ok(result.problems.some(problem => /security/.test(problem)));
  }
  const extra = checker.checkSecurityReportForm(JSON.stringify({ outcome: 'failed', evidenceSummary: 'Unknown.',
    how: 'No source.', artifact: 'Incomplete.', phase: 'mdd-apply', security: {} }));
  assert.equal(extra.ok, false);
  assert.ok(extra.problems.some(problem => /phase/.test(problem)));
  for (const text of ['', ' ', 'x'.repeat(20001), undefined, 42]) {
    assert.equal(checker.checkSecurityReportForm(text).ok, false);
  }
});
