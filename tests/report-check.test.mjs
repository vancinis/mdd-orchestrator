import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReportForm } from '../dist/report-check.js';
import { reportFormatLines } from '../dist/phase-report.js';
import { reportDocument, traceFixture } from './adapter-fixture.mjs';

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

test('an oversized summary and an oversized artifact are reported together, not one per try', () => {
  // The exact loop this exists to end: on the observed run each of these cost a full round trip.
  // Both overshoot their own limit while the document stays inside the 20,000-byte envelope, so
  // the two field problems are what there is to report.
  const document = reportDocument({
    outcome: 'passed', evidenceSummary: 'x'.repeat(2100), artifact: 'y'.repeat(16100),
  });
  assert.ok(Buffer.byteLength(document) < 20000, 'the envelope must not be the problem here');
  const checked = checkReportForm('mdd-explore', document);
  assert.equal(checked.ok, false);
  assert.equal(checked.problems.length, 2);
  assert.ok(checked.problems.some(problem => /summary must be nonempty text of at most 2000 bytes/.test(problem)));
  assert.ok(checked.problems.some(problem => /artifact must be nonempty text of at most 16000 bytes/.test(problem)));
  assert.match(checked.note, /not in the work it describes/);
});

test('a document over the envelope reports that alone, even when fields are wrong too', () => {
  // Nothing inside can be trusted to be read out of a document MDD will refuse whole, and piling
  // field complaints on top would bury the one that has to be fixed first.
  const checked = checkReportForm('mdd-plan', planReport({
    evidenceSummary: 'x'.repeat(2500), artifact: 'y'.repeat(16500),
  }));
  assert.deepEqual(checked.problems, ['phase report must be nonempty text of at most 20000 bytes.']);
});

test('the wording matches what the real validation would say, so a fix transfers', () => {
  // A report MDD rejects must be rejected here in the same words, or checking it teaches nothing.
  const checked = checkReportForm('mdd-plan', planReport({ evidenceSummary: 'x'.repeat(2500) }));
  assert.deepEqual(checked.problems, ['summary must be nonempty text of at most 2000 bytes.']);
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
