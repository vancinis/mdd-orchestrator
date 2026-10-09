import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePhaseReport, reportFormatLines, MalformedReport, MALFORMED_RESTATEMENTS } from '../dist/phase-report.js';
import { TASK_ENVELOPE } from '../dist/opencode-plugin.js';
import * as reports from '../dist/phase-report.js';

const document = [
  '## MDD Outcome', '', 'passed', '',
  '## MDD Summary', '', 'Implemented the boundary check and ran the scoped tests.', '',
  '## MDD Artifact', '', 'Changed src/cli.ts to validate input before dispatch.', '',
].join('\n');

test('standalone security parsing reuses the envelope without adding phase fields', () => {
  assert.equal(typeof reports.parseSecurityReport, 'function');
  const data = `${document}\n## MDD Data\n\n\`\`\`json\n{"security":{"snapshotID":"one"}}\n\`\`\`\n`;
  assert.deepEqual(reports.parseSecurityReport(data).security, { snapshotID: 'one' });
  for (const extra of ['outcome', 'checks', 'risk']) {
    assert.throws(() => reports.parseSecurityReport(data.replace('"security":', `"${extra}":"failed","security":`)),
      /exactly.*security/);
  }
});

test('a phase report is prose under MDD headings', () => {
  const result = parsePhaseReport(document, 'mdd-explore');
  assert.equal(result.outcome, 'passed');
  assert.equal(result.evidenceSummary, 'Implemented the boundary check and ran the scoped tests.');
  assert.equal(result.artifact, 'Changed src/cli.ts to validate input before dispatch.');
});

// The whole point of the change: an actor that writes normally is understood. A finished phase
// used to be discarded because the model said "here you go" before its JSON object.
test('prose around the document changes nothing', () => {
  const framed = `Sure — here is the report.\n\n${document}\n\nLet me know if you want more detail.`;
  assert.equal(parsePhaseReport(framed, 'mdd-explore').outcome, 'passed');
});

test('emphasis, trailing colons and a stray period on the outcome are read, not refused', () => {
  const noisy = document.replace('## MDD Outcome', '### **MDD Outcome**:').replace('\npassed\n', '\n`passed`.\n');
  assert.equal(parsePhaseReport(noisy, 'mdd-explore').outcome, 'passed');
});

// An artifact is markdown. It may carry its own headings, and a report must not be cut in half by
// the deliverable it is carrying, which is exactly why the canonical headings are prefixed.
test('an artifact may hold its own Summary and Data headings', () => {
  const withHeadings = document.replace('Changed src/cli.ts to validate input before dispatch.',
    '## Summary\n\nThe boundary now rejects empty input.\n\n## Data\n\n```json\n{"unrelated": true}\n```');
  const result = parsePhaseReport(withHeadings, 'mdd-explore');
  assert.match(result.artifact, /^## Summary/);
  assert.match(result.artifact, /"unrelated": true/);
  assert.equal(result.acceptance, undefined, 'an artifact heading is content, never an envelope section');
});

test('a fenced block hides headings from the parser', () => {
  const quoted = document.replace('Changed src/cli.ts to validate input before dispatch.',
    '````\n## MDD Summary\n\nthis is an example, not a section\n````');
  assert.match(parsePhaseReport(quoted, 'mdd-explore').artifact, /this is an example/);
});

test('unprefixed headings work for a document that used no prefixed heading', () => {
  assert.equal(parsePhaseReport(document.replaceAll('## MDD ', '## '), 'mdd-explore').outcome, 'passed');
});

test('structured data travels in one fenced block and merges into the result', () => {
  const withData = `${document}\n## MDD Data\n\n\`\`\`json\n{"deliverables": [{"id": "one"}]}\n\`\`\`\n`;
  assert.deepEqual(parsePhaseReport(withData, 'mdd-tasks').deliverables, [{ id: 'one' }]);
});

test('an unfenced data block is still read', () => {
  const withData = `${document}\n## MDD Data\n\n{"deliverables": []}\n`;
  assert.deepEqual(parsePhaseReport(withData, 'mdd-tasks').deliverables, []);
});

test('concerns stay advisory and optional', () => {
  const withConcerns = `${document}\n## MDD Concerns\n\n\`\`\`json\n[{"category": "objective", "evidence": "a", "impact": "b"}]\n\`\`\`\n`;
  assert.equal(parsePhaseReport(withConcerns, 'mdd-explore').concerns.length, 1);
  assert.equal(parsePhaseReport(document, 'mdd-explore').concerns, undefined);
});

test('the legacy JSON object is still understood', () => {
  const legacy = JSON.stringify({ outcome: 'failed', evidenceSummary: 'x', artifact: 'y' });
  assert.equal(parsePhaseReport(legacy, 'mdd-explore').outcome, 'failed');
  assert.equal(parsePhaseReport(`\`\`\`json\n${legacy}\n\`\`\``, 'mdd-explore').outcome, 'failed');
});

for (const [label, text] of [
  ['no headings at all', 'I finished the work.'],
  ['a missing artifact', '## MDD Outcome\n\npassed\n\n## MDD Summary\n\nDone.\n'],
  ['an outcome that is neither passed nor failed', document.replace('\npassed\n', '\nmostly\n')],
  ['a repeated heading', `${document}\n## MDD Summary\n\nagain\n`],
  ['data that is not JSON', `${document}\n## MDD Data\n\n\`\`\`json\n{nope}\n\`\`\`\n`],
  ['data that is not an object', `${document}\n## MDD Data\n\n\`\`\`json\n[1,2]\n\`\`\`\n`],
]) {
  test(`an unreadable report is named as one: ${label}`, () => {
    assert.throws(() => parsePhaseReport(text, 'mdd-tasks'), MalformedReport);
  });
}

const narrated = document.replace('## MDD Artifact', [
  '## MDD Approach', '', 'Validated at the CLI boundary because input enters there.', '',
  '## MDD Purpose', '', 'Invalid input must fail before dispatch.', '',
  '## MDD Open Items', '', 'None.', '',
  '## MDD Learnings', '', '- The parser already trims input.', '- Exit codes are part of the contract.', '',
  '## MDD Confidence', '', '**High** — every new branch has a passing test.', '',
  '## MDD Artifact',
].join('\n'));

test('the narrative sections are read under their own headings', () => {
  const result = parsePhaseReport(narrated, 'mdd-explore');
  assert.equal(result.how, 'Validated at the CLI boundary because input enters there.');
  assert.equal(result.purpose, 'Invalid input must fail before dispatch.');
  assert.equal(result.openItems, 'None.');
  assert.equal(result.learnings, '- The parser already trims input.\n- Exit codes are part of the contract.');
  assert.equal(result.confidence, '**High** — every new branch has a passing test.');
  assert.equal(result.artifact, 'Changed src/cli.ts to validate input before dispatch.');
  assert.deepEqual(reports.narrativeOf(result), {
    purpose: 'Invalid input must fail before dispatch.', openItems: 'None.',
    learnings: '- The parser already trims input.\n- Exit codes are part of the contract.',
    confidence: { level: 'high', reason: 'every new branch has a passing test.' },
  });
  // Nothing is written on the actor's behalf: an absent section stays absent.
  assert.deepEqual(reports.narrativeOf(parsePhaseReport(document, 'mdd-explore')), {});
});

test('"How" is still the approach, and the two cannot both appear', () => {
  assert.equal(parsePhaseReport(document.replace('## MDD Artifact', '## MDD How\n\nOld heading.\n\n## MDD Artifact'), 'mdd-explore').how, 'Old heading.');
  assert.throws(() => parsePhaseReport(narrated.replace('## MDD Artifact', '## MDD How\n\nAgain.\n\n## MDD Artifact'), 'mdd-explore'), MalformedReport);
});

test('confidence is a level word followed by its reason', () => {
  for (const [text, level, reason] of [
    ['High — all checks pass.', 'high', 'all checks pass.'],
    ['**Medium**: two scenarios were not run.', 'medium', 'two scenarios were not run.'],
    ['low confidence. The build could not run.', 'low', 'The build could not run.'],
    ['MEDIUM\n\nThe plan depends on an unconfirmed API.', 'medium', 'The plan depends on an unconfirmed API.'],
  ]) assert.deepEqual(reports.parseConfidence(text), { level, reason }, text);
  // A level guessed out of a longer word would invert the claim; a level alone explains nothing.
  for (const text of ['Highly uncertain about the API.', '90% — tests pass.', 'Confident.', 'High', '**Low**', '', undefined, 3]) {
    assert.throws(() => reports.parseConfidence(text), MalformedReport, String(text));
  }
  assert.throws(() => reports.narrativeOf({ confidence: 'Very high, it works.' }), MalformedReport);
  assert.throws(() => reports.narrativeOf({ purpose: '   ' }), MalformedReport);
});

test('the form asks for every narrative section and a level, never a percentage', () => {
  for (const phase of ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify']) {
    const form = reportFormatLines(phase).join('\n');
    for (const heading of ['Summary', 'Approach', 'Purpose', 'Open Items', 'Learnings', 'Confidence']) assert.match(form, new RegExp(`"## MDD ${heading}"`), heading);
    assert.doesNotMatch(form, /"## MDD How"/);
    assert.match(form, /High, Medium or Low/);
    assert.match(form, /never a percentage/);
    assert.match(form, /Write every one of these prose sections in every report/);
  }
});

test('the form an actor is shown names only its own fields', () => {
  assert.match(reportFormatLines('mdd-verify').join('\n'), /exactly these keys: checks, verification\./);
  assert.match(reportFormatLines('mdd-apply').join('\n'), /exactly these keys: changes, noChangeReason, checks, delivered, completed\./);
  assert.match(reportFormatLines('mdd-explore').join('\n'), /omit "## MDD Data" entirely/);
  assert.doesNotMatch(reportFormatLines('mdd-plan').join('\n'), /verification=/);
  for (const phase of ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify']) {
    assert.doesNotMatch(reportFormatLines(phase).join('\n'), /Return exactly one JSON object/);
  }
});

test('Plan and Tasks describe optional complete scopes with runtime capability and independence checks', () => {
  for (const phase of ['mdd-plan', 'mdd-tasks']) {
    const form = reportFormatLines(phase).join('\n');
    assert.match(form, /parallel\?/);
    assert.match(form, /complete:true/);
    assert.match(form, /explicit dependsOn/);
    assert.match(form, /runtime selects eligible worker batches under its capability and independence checks/);
  }
  assert.doesNotMatch(reportFormatLines('mdd-explore').join('\n'), /parallel\?/);
});

test('restatements are bounded rather than unlimited', () => {
  assert.ok(MALFORMED_RESTATEMENTS >= 1 && MALFORMED_RESTATEMENTS <= 5);
});

// The host wraps a finished task in an envelope whose exact shape is not MDD's to dictate. A
// completed phase was discarded because of an optional summary line it never read.
for (const [label, envelope] of [
  ['the plain form', '<task id="ses_1" state="completed">\n<task_result>\nbody\n</task_result>\n</task>'],
  ['an optional summary line', '<task id="ses_1" state="completed">\n<summary>Did the thing</summary>\n<task_result>\nbody\n</task_result>\n</task>'],
  ['trailing whitespace', '<task id="ses_1" state="completed">\n<task_result>\nbody\n</task_result>\n</task>\n\n'],
  ['carriage returns', '<task id="ses_1" state="completed">\r\n<task_result>\r\nbody\r\n</task_result>\r\n</task>'],
]) {
  test(`the completed-task envelope is read with ${label}`, () => {
    assert.equal(TASK_ENVELOPE.exec(envelope.trim())?.[1], 'body');
  });
}

test('an unfinished task is still not a result', () => {
  assert.equal(TASK_ENVELOPE.test('<task id="ses_1" state="running">\n<task_result>\nbody\n</task_result>\n</task>'), false);
  assert.equal(TASK_ENVELOPE.test('the delegated task did not finish'), false);
});
