import assert from 'node:assert/strict';
import { structuredTraceFixture, structuredVerificationFixture } from './adapter-fixture.mjs';
import { verifyReport as readVerify } from '../dist/phase-evidence.js';
import { test } from 'node:test';
import { checkReportForm, checkRiskReportForm } from '../dist/report-check.js';
import { reportFormatLines } from '../dist/phase-report.js';
import { riskReportFormatLines } from '../dist/risk.js';
import * as riskReaders from '../dist/risk.js';
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

test('regression: with what the run holds, links are checked with the run\'s own validators before the report is sent', () => {
  const trace = structuredTraceFixture();
  const held = { accepted: trace.acceptance, choices: trace.decisions, planned: trace.deliverables, verificationVersion: 1 };
  const document = value => reportDocument({ evidenceSummary: 'Verified.', artifact: 'Evidence.', ...value });
  const good = structuredVerificationFixture(trace);
  const clean = checkReportForm('mdd-verify', document(good), held);
  assert.deepEqual(clean.problems, []);
  assert.match(clean.note, /including the links against the requirements, decisions and plan this run holds/);
  // The most frequent refusal on arrival: an invented or missing link. Form alone cannot see it.
  const invented = structuredClone(good); invented.verification.scenarios[1].scenarioID = 'S9';
  assert.equal(checkReportForm('mdd-verify', document(invented)).ok, true);
  const refused = checkReportForm('mdd-verify', document(invented), held);
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join(' | '), /invents the link "R1"\/"S9"\/"cli-validation"/);
  assert.match(refused.problems.join(' | '), /omits scenario coverage for S2 on cli-validation/);
  assert.match(refused.note, /in its links to what this run holds/);
  // A recheck after a correction pass covers its findings; the earlier rows are the run's.
  const previous = readVerify(good.checks, good.verification, held).verification;
  previous.scenarios[1] = { ...previous.scenarios[1], status: 'not-verified', checks: [], assessment: 'S2 failed.' };
  previous.matched = false;
  const scoped = structuredClone(good);
  scoped.verification.scenarios = scoped.verification.scenarios.filter(row => row.scenarioID === 'S2');
  scoped.verification.steps = []; scoped.verification.decisions = [];
  assert.deepEqual(checkReportForm('mdd-verify', document(scoped), { ...held, recheck: { findings: ['S2'], previous } }).problems, []);
  assert.equal(checkReportForm('mdd-verify', document(scoped), held).ok, false, 'a full Verify still covers every link');
  // Tasks against the held acceptance: an uncovered scenario is named; a wrong decision link is derived.
  const tasks = deliverables => reportDocument({ evidenceSummary: 'Steps.', artifact: 'Steps.', verificationVersion: 1, deliverables });
  assert.deepEqual(checkReportForm('mdd-tasks', tasks(trace.deliverables.map(step => ({ ...step, decisions: ['D9'] }))), held).problems, []);
  const uncovered = checkReportForm('mdd-tasks', tasks(trace.deliverables.map(step => ({ ...step, scenarios: ['S1'] }))), held);
  assert.match(uncovered.problems.join(' | '), /omits accepted scenario S2/);
  // A correction pass names its findings.
  const apply = reportDocument({ evidenceSummary: 'Corrected.', artifact: 'Correction.', verificationVersion: 1, changes: ['src/cli.ts'], completed: ['cli-validation'], checks: [] });
  assert.match(checkReportForm('mdd-apply', apply, { ...held, findings: ['S2'] }).problems.join(' | '), /must report closure for every Verify finding: S2/);
  // A report under another contract version than the run's is named, as the run would.
  assert.match(checkReportForm('mdd-verify', document(good), { ...held, verificationVersion: undefined }).problems.join(' | '),
    /contradicts the frozen run contract/);
});

test('checking is pure: the same document checks the same way every time', () => {
  const text = planReport({ evidenceSummary: 'x'.repeat(2500) });
  const first = checkReportForm('mdd-plan', text);
  const second = checkReportForm('mdd-plan', text);
  assert.deepEqual(first, second);
});

test('SA-2: form checker reads structured execution references and refuses marked legacy downgrade', () => {
  const data = structuredVerificationFixture();
  const document = value => reportDocument({ evidenceSummary: 'Verified.', artifact: 'Evidence.', ...value });
  assert.equal(checkReportForm('mdd-verify', document(data)).ok, true);
  const missing = structuredClone(data); delete missing.checks[0].id;
  assert.equal(checkReportForm('mdd-verify', document(missing)).ok, false);
  const unknown = structuredClone(data); unknown.verification.checkResults[0].executions = ['unknown'];
  assert.equal(checkReportForm('mdd-verify', document(unknown)).ok, false);
  assert.equal(checkReportForm('mdd-verify', verifyReport({ verificationVersion: 1 })).ok, false);
  assert.equal(checkReportForm('mdd-verify', document({ ...data, verificationVersion: 2 })).ok, false);
});

test('SA-2: form-only applicability is advisory and runner-held requirements remain authoritative', () => {
  const trace = structuredTraceFixture(); const data = structuredVerificationFixture(trace);
  data.verification.checkResults[0] = { checkID: 'cli-validation-check', disposition: 'not-applicable', executions: [], reason: 'Actor claims this environment does not need the planned check.' };
  data.verification.supplementalChecks = [{ id: 'probe', requirement: 'optional', disposition: 'passed', executions: ['E1'] }];
  const checked = checkReportForm('mdd-verify', reportDocument({ evidenceSummary: 'Checked form.', artifact: 'Applicability claim.', ...data }));
  assert.equal(checked.ok, true);
  assert.match(checked.note, /not an acceptance/);
  assert.throws(() => readVerify(data.checks, data.verification, { accepted: trace.acceptance, choices: trace.decisions,
    planned: trace.deliverables, verificationVersion: 1 }), /unconditional/);
});

// One assigned step, or every remaining one in a correction pass: which applies is held by the run,
// so the form check accepts stable distinct IDs and leaves the assignment to it.
test('Apply report form requires stable distinct completed IDs without claiming to validate assignment', () => {
  const data = { changes: ['src/first.ts'] };
  for (const completed of [undefined, [], ['first', 'first'], ['bad/id']]) {
    assert.equal(checkReportForm('mdd-apply', reportDocument({ evidenceSummary: 'Implemented.', artifact: 'Batch.', ...data, completed })).ok, false);
  }
  for (const completed of [['first'], ['first', 'second']])
    assert.equal(checkReportForm('mdd-apply', reportDocument({ evidenceSummary: 'Implemented.', artifact: 'Batch.', ...data, completed })).ok, true);
});

test('a planning report cannot pass while naming an unmet requirement, and a correction cannot pass with an open finding', () => {
  const missing = [{ requirementID: 'R1', reason: 'A late confirmed write can still restore after every cleanup fails.' }];
  for (const phase of ['mdd-design', 'mdd-tasks']) {
    const passed = checkReportForm(phase, reportDocument({ evidenceSummary: 'Designed.', artifact: 'Design.', decisions: [], deliverables: [], unmet: missing }));
    assert.equal(passed.ok, false); assert.ok(passed.problems.some(problem => /leaves held requirements unmet cannot pass/.test(problem)));
    const failed = checkReportForm(phase, reportDocument({ outcome: 'failed', evidenceSummary: 'Cannot design it.', artifact: 'Design gap.', unmet: missing }));
    assert.equal(failed.ok, true);
    assert.equal(checkReportForm(phase, reportDocument({ outcome: 'failed', evidenceSummary: 'Cannot.', artifact: 'Gap.', unmet: [{ requirementID: 'R1' }] })).ok, false);
  }
  const apply = { evidenceSummary: 'Corrected.', artifact: 'Correction.', changes: ['src/first.ts'], completed: ['first'] };
  const open = checkReportForm('mdd-apply', reportDocument({ ...apply, closure: [{ id: 'S1', status: 'open', evidence: 'Probe still restores the session.' }] }));
  assert.equal(open.ok, false); assert.ok(open.problems.some(problem => /leaves a Verify finding open cannot pass/.test(problem)));
  assert.equal(checkReportForm('mdd-apply', reportDocument({ ...apply, closure: [{ id: 'S1', status: 'closed', evidence: 'Probe E6 failed before, passes after (exit 0).' }] })).ok, true);
  assert.equal(checkReportForm('mdd-apply', reportDocument({ ...apply, outcome: 'failed', completed: [], closure: [{ id: 'S1', status: 'open', evidence: 'Needs a design change.' }] })).ok, true);
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

test('a Verify report with long, many and multi-line limits and assessments checks clean', () => {
  const long = 'The probe covered the boundary but not the retry path, which needs a live service. '.repeat(10).trim();
  const assessment = { status: 'verified', checks: ['npm test'], assessment: `${long}\nSecond paragraph of the same assessment.` };
  const checked = checkReportForm('mdd-verify', verifyReport({}, {
    scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: 'cli-validation', ...assessment })),
    steps: [{ stepID: 'cli-validation', ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }],
    changes: `${long}\n\t${long}`, limits: Array.from({ length: 9 }, (_, index) => `Limit ${index + 1}:\n${long}`) }));
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.ok, true);
});

test('a failed Verify report is checked exactly as the run will read it', () => {
  // The observed miss: this check skipped `checks` on a failed Verify and cleared a report that
  // the run then refused, at the one moment the actor could still have fixed it.
  const checked = checkReportForm('mdd-verify', verifyReport(
    { outcome: 'failed', checks: [{ command: 'npm test', exit: 0 }, { command: 'npm run\nlint', exit: 1 }] },
    { limits: ['one', 'two', 'three', 'four', 'five'], changes: 'Input validation \u001b[1mfollows the plan.' }));
  assert.equal(checked.ok, false);
  assert.equal(checked.problems.length, 1, 'one rejection carrying every problem');
  assert.match(checked.problems[0], /2 problem\(s\)/);
  assert.match(checked.problems[0], /checks\[1\]\.command .* control character U\+000A/);
  assert.match(checked.problems[0], /what changed .* control character U\+001B/);
  assert.equal(checked.problems[0].includes('limit'), false, 'five limits are five limits, not a problem');

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

test('AL-01: future assessment independently accepts high impact with low complexity without routing', () => {
  assert.equal(typeof riskReaders.parseFutureAssessment, 'function');
  for (const complexity of ['low', 'medium', 'high']) {
    for (const impact of ['low', 'medium', 'high']) {
      const value = { assessmentVersion: 1, complexity, impact };
      const before = structuredClone(value);
      const parsed = riskReaders.parseFutureAssessment(value);
      assert.deepEqual(parsed, before);
      parsed.impact = 'changed';
      assert.deepEqual(value, before, 'the reader does not expose input state');
      assert.equal(Object.hasOwn(parsed, 'route'), false, 'assessment grants no route or execution');
    }
  }
});

test('AL-01: the future assessment reader validates its own version and level vocabulary', () => {
  assert.equal(typeof riskReaders.parseFutureAssessment, 'function');
  const value = { assessmentVersion: 1, complexity: 'low', impact: 'high' };
  for (const assessmentVersion of [undefined, null, '1', 0, 2]) {
    assert.throws(() => riskReaders.parseFutureAssessment({ ...value, assessmentVersion }), /assessmentVersion/);
  }
  for (const field of ['complexity', 'impact']) {
    for (const level of [undefined, null, 'LOW', 'unknown', 1]) {
      assert.throws(() => riskReaders.parseFutureAssessment({ ...value, [field]: level }), new RegExp(field));
    }
  }
  for (const input of [null, [], { ...value, route: 'low' }, { ...value, extra: true }]) {
    assert.throws(() => riskReaders.parseFutureAssessment(input));
  }
});

test('risk and concern prose has no length limit and folds line breaks', () => {
  const long = 'The middleware is shared by every route, so one mistake reaches every user at once. '.repeat(30).trim();
  assert.ok(long.length > 2000);
  const parsed = riskReaders.parseRiskVerdict(riskVerdict({ reason: `${long}\n${long}`,
    evidence: [{ source: `mdd-explore finding 2: ${long}`, finding: long }],
    risks: [{ description: long, evidence: long, mitigation: `Add a regression test.\n\tThen merge.` }] }));
  assert.equal(parsed.reason, `${long} ${long}`);
  assert.equal(parsed.risks[0].mitigation, 'Add a regression test. Then merge.');
  assert.equal(riskReaders.parseRiskVerdict(riskVerdict({ risks: [], risksJustification: long })).risksJustification, long);
  const concerned = checkReportForm('mdd-plan', planReport({ concerns: [{ category: 'integrations', evidence: long, impact: `${long}\n${long}` }] }));
  assert.deepEqual(concerned.problems, []);
});

test('AL-01: future assessment values do not widen the current Risk report contract', () => {
  for (const risk of [riskVerdict({ route: 'high', complexity: 'low' }), riskVerdict({ route: 'medium', complexity: 'medium' }),
    riskVerdict({ impact: 'high' }), { assessmentVersion: 1, complexity: 'low', impact: 'high' }]) {
    assert.throws(() => riskReaders.parseRiskVerdict(risk));
    assert.equal(checkRiskReportForm(riskReport({ risk })).ok, false);
  }
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
