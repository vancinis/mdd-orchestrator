import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as checker from '../dist/report-check.js';

const layers = ['committed', 'index', 'worktree', 'untracked'];
const finding = () => ({
  id: 'F1', severity: 'high', title: 'User-controlled SQL reaches a query',
  location: { locationID: 'committed-query-after', layer: 'committed', side: 'after',
    path: 'src/query.ts', startLine: 12, endLine: 14 },
  evidence: 'query concatenates request.query.name into a SELECT expression.',
  attackConditions: 'An unauthenticated client can supply the name query parameter.',
  impact: 'The attacker can read records outside the intended tenant.',
  recommendation: 'Bind the parameter and enforce tenant scope before querying.',
});
const assessment = (overrides = {}) => ({
  snapshotID: 'snapshot-1', status: 'findings',
  coverage: layers.map(layer => ({ layer, status: 'complete',
    inspected: layer === 'committed' ? ['committed-query-after'] : [], limitations: [] })),
  limitations: [], findings: [finding()], ...overrides,
});
const document = (security, outcome = security.status === 'inconclusive' ? 'failed' : 'passed') => [
  '## MDD Outcome', outcome, '## MDD Summary', 'Security assessment of the supplied snapshot.',
  '## MDD How', 'Inspected the supplied source and runtime coverage manifest.',
  '## MDD Artifact', 'A query construction risk was evidenced. This is not a security guarantee.',
  '## MDD Data', '```json', JSON.stringify({ security }), '```',
].join('\n\n');
const check = value => {
  assert.equal(typeof checker.checkSecurityReportForm, 'function', 'standalone security form checker is available');
  return checker.checkSecurityReportForm(document(value));
};

test('security checker returns detailed findings without acceptance or snapshot authenticity', () => {
  const value = assessment();
  const result = check(value);
  assert.equal(result.ok, true);
  assert.deepEqual(result.security, value);
  assert.match(result.note, /form-only/);
  assert.match(result.note, /snapshot.*binding/);
  assert.deepEqual(check(value), result, 'checking has no state');
});

test('security distinguishes no-findings from an incomplete assessment with known findings', () => {
  assert.equal(check(assessment({ status: 'no-findings', findings: [] })).ok, true);
  const coverage = assessment().coverage;
  coverage[2] = { layer: 'worktree', status: 'partial', inspected: [], limitations: ['Byte limit omitted source.'] };
  const partial = check(assessment({ status: 'inconclusive', coverage }));
  assert.equal(partial.ok, true);
  assert.equal(partial.security.findings.length, 1, 'partial inspection preserves known findings');
  assert.equal(check(assessment({ status: 'inconclusive', findings: [], limitations: ['Audit interrupted.'] })).ok, true);
});

test('security findings support each severity and all uniquely identified layer/side locations', () => {
  const findings = layers.map((layer, index) => ({ ...finding(), id: `F${index + 1}`,
    severity: ['critical', 'high', 'medium', 'low'][index],
    location: { ...finding().location, locationID: `${layer}-revision-1-after`, layer } }));
  const coverage = layers.map(layer => ({ layer, status: 'complete',
    inspected: findings.filter(item => item.location.layer === layer).map(item => item.location.locationID), limitations: [] }));
  assert.equal(check(assessment({ findings, coverage })).ok, true);
  findings[0].location.side = 'before';
  assert.equal(check(assessment({ findings, coverage })).ok, true, 'deleted and renamed source can cite the before side');
});

test('security outcome describes inspection completion and never suppresses failed-report data', () => {
  const complete = document(assessment(), 'failed');
  assert.equal(checker.checkSecurityReportForm(complete).ok, false);
  const partial = assessment({ status: 'inconclusive', limitations: ['Context unavailable.'] });
  assert.equal(checker.checkSecurityReportForm(document(partial, 'passed')).ok, false);
  const missingHow = document(assessment()).replace('Inspected the supplied source and runtime coverage manifest.', '');
  assert.equal(checker.checkSecurityReportForm(missingHow).ok, false);
});

for (const [label, mutate] of [
  ['snapshot identity', value => { value.snapshotID = ''; }],
  ['missing committed coverage', value => { value.coverage.shift(); }],
  ['duplicate layer', value => { value.coverage[1].layer = 'committed'; }],
  ['unknown layer', value => { value.coverage[0].layer = 'head'; }],
  ['duplicate inspected identity', value => { value.coverage[0].inspected.push('committed-query-after'); }],
  ['cross-layer duplicate identity', value => { value.coverage[1].inspected.push('committed-query-after'); }],
  ['unavailable with inspected locations', value => { value.status = 'inconclusive'; value.coverage[0].status = 'unavailable'; value.coverage[0].limitations = ['No source.']; }],
  ['unavailable without limitation', value => { value.coverage[0].status = 'unavailable'; }],
  ['partial called findings', value => { value.coverage[0].status = 'partial'; value.coverage[0].limitations = ['Skipped context.']; }],
  ['limitation called complete', value => { value.limitations = ['Context unavailable.']; }],
  ['empty findings status', value => { value.findings = []; }],
  ['nonempty no-findings status', value => { value.status = 'no-findings'; }],
  ['inconclusive without reason', value => { value.status = 'inconclusive'; }],
  ['unsupported severity', value => { value.findings[0].severity = 'warning'; }],
  ['missing evidence', value => { delete value.findings[0].evidence; }],
  ['missing attack conditions', value => { delete value.findings[0].attackConditions; }],
  ['missing impact', value => { delete value.findings[0].impact; }],
  ['missing recommendation', value => { delete value.findings[0].recommendation; }],
  ['unknown delivery authority', value => { value.authorizeFix = true; }],
  ['extra finding key', value => { value.findings[0].confidence = 99; }],
  ['duplicate finding id', value => { value.findings.push(finding()); }],
  ['unknown location field', value => { value.findings[0].location.commit = 'invented'; }],
  ['uninspected location', value => { value.findings[0].location.locationID = 'other'; }],
  ['wrong inspected layer', value => { value.findings[0].location.layer = 'index'; }],
  ['path traversal', value => { value.findings[0].location.path = '../secret'; }],
  ['absolute path', value => { value.findings[0].location.path = 'C:/secret'; }],
  ['invalid side', value => { value.findings[0].location.side = 'live'; }],
  ['untracked before side', value => { value.findings[0].location.layer = 'untracked'; value.findings[0].location.side = 'before'; }],
  ['zero line', value => { value.findings[0].location.startLine = 0; }],
  ['reversed line range', value => { value.findings[0].location.endLine = 11; }],
  ['fractional line', value => { value.findings[0].location.startLine = 12.5; }],
  ['overlong evidence', value => { value.findings[0].evidence = 'x'.repeat(2001); }],
  ['control characters in evidence', value => { value.findings[0].evidence = 'source\u0000text'; }],
  ['oversized finding list', value => { value.findings = Array.from({ length: 33 }, (_, i) => ({ ...finding(), id: `F${i}` })); }],
]) {
  test(`security rejects ${label}`, () => {
    const value = assessment();
    mutate(value);
    const result = check(value);
    assert.equal(result.ok, false, label);
    assert.equal(result.security, undefined, 'invalid data is never returned as an assessment');
  });
}

test('security parser bounds and detaches its nested contract', async () => {
  const { parseSecurityAssessment } = await import('../dist/security.js');
  const input = assessment();
  const parsed = parseSecurityAssessment(input);
  input.coverage[0].inspected.length = 0;
  input.findings[0].location.path = 'mutated.ts';
  assert.equal(parsed.findings[0].location.path, 'src/query.ts');
  assert.equal(parsed.coverage[0].inspected.length, 1);
  assert.throws(() => parseSecurityAssessment({ ...assessment(), findings: Array(33).fill(finding()) }));
});
