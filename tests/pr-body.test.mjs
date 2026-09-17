import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPRBody } from '../dist/pr-body.js';

function root(t) { const root = fs.mkdtempSync(join(tmpdir(), 'mdd-pr-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const facts = { runID: 'recorded-run', goal: 'Validate orders before processing.', changes: 'Order validation was implemented.', changedFiles: 2, checks: ['npm test'], verified: true, uncertain: false, limits: [] };
test('PR renderer uses the local template exactly once per section and recorded facts only', t => {
  const result = renderPRBody(root(t), facts, 'Draft the PR body.');
  assert.deepEqual([...result.body.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['Summary', 'Changes', 'Environment variables', 'Follow-ups', 'Blockers', 'Deployment']);
  assert.match(result.body, /2 scoped file/); assert.match(result.body, /npm test; exit 0/);
  assert.match(result.body, /not independent review/); assert.match(result.body, /Unverified: no applicable information/);
  assert.equal(result.publication, 'not-authorized'); assert.match(result.provenance.skill.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.provenance.skill.path, 'assets/opencode/skills/mdd-pr-body/SKILL.md');
});
test('PR draft without changes or successful verification stays explicitly incomplete', t => {
  const result = renderPRBody(root(t), { ...facts, changedFiles: 0, checks: [], verified: false, uncertain: true }, 'Draft only.');
  assert.match(result.body, /No implementation change evidence/); assert.match(result.body, /not fully verified/); assert.match(result.body, /uncertain/);
});
test('PR notes must be exact whole user lines and remain attributed, never invented', t => {
  const path = root(t); const text = 'Draft the body.\nNot applicable.\nDeploy manually after review.';
  const result = renderPRBody(path, facts, text, { environmentVariables: 'Not applicable.', deployment: 'Deploy manually after review.' });
  assert.match(result.body, /## Environment variables\n\nNot applicable\./);
  assert.match(result.body, /User-provided, not independently verified: Deploy manually/);
  assert.throws(() => renderPRBody(path, facts, text, { deployment: 'Deploy manually' }), /complete line/);
});
test('PR output omits credential assignments, raw paths, code excerpts and unsafe command arguments', t => {
  const text = 'API_KEY=do-not-print';
  const result = renderPRBody(root(t), { ...facts, goal: 'Read C:\\private\\source', changes: '`private source excerpt`', checks: ['node test.js --token sensitive'] }, text, { environmentVariables: text });
  assert.doesNotMatch(result.body, /do-not-print|C:\\private|private source excerpt|--token|sensitive\]/);
  assert.match(result.body, /text was omitted/); assert.match(result.body, /command: omitted/);
});
test('PR renderer ignores workspace shadow assets and uses the packaged template', t => {
  const path = root(t); fs.mkdirSync(join(path, '.opencode/skills/mdd-pr-body/assets'), { recursive: true });
  fs.writeFileSync(join(path, '.opencode/skills/mdd-pr-body/assets/template.md'), '## Summary\nOnly one section.');
  assert.equal([...renderPRBody(path, facts, 'Draft.').body.matchAll(/^## /gm)].length, 6);
});
test('recorded text cannot inject extra template headings', t => {
  const result = renderPRBody(root(t), { ...facts, goal: '## Injected heading' }, 'Draft.');
  assert.equal([...result.body.matchAll(/^## /gm)].length, 6);
});
