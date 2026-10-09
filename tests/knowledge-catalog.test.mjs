import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { supplementKnowledge } from '../dist/project-knowledge.js';

const selection = { phase: 'mdd-apply', objective: 'Validate parser boundaries', paths: ['src/a.ts'] };
const entry = (id = 'parser') => ({ id, path: `skills/${id}/SKILL.md`, approved: true,
  phases: ['mdd-apply', 'mdd-explore'], terms: ['parser'], paths: ['src'], tools: ['read', 'grep', 'bash', 'invented', 'mdd_worker_edit'] });
function fixture(t, entries = [entry()]) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'mdd'));
  for (const item of entries) {
    fs.mkdirSync(join(root, item.path, '..'), { recursive: true });
    fs.writeFileSync(join(root, item.path), `---\nname: ${item.id}\n---\nPRIVATE_SKILL_${item.id} parser guidance.`);
  }
  const write = value => fs.writeFileSync(join(root, 'mdd/knowledge.json'), JSON.stringify(value));
  write({ version: 1, skills: entries });
  return { root, write };
}
async function lookup(root, request = selection) {
  const { readKnowledgeCatalog } = await import('../dist/knowledge-catalog.js');
  const metrics = { candidates: 0, freshHits: 0, staleRejects: 0 };
  return { observations: [], skills: readKnowledgeCatalog(root, request, metrics), metrics };
}

test('PK4 catalog routes deterministically by phase, literal objective and path segment', async t => {
  const entries = [entry('zebra'), entry('alpha'), { ...entry('other'), terms: ['billing'] }];
  const f = fixture(t, entries);
  const result = await lookup(f.root);
  assert.deepEqual(result.skills.map(item => item.id), ['alpha', 'zebra']);
  assert.deepEqual(result.metrics, { candidates: 3, freshHits: 2, staleRejects: 0 });
  for (const request of [{ ...selection, phase: 'mdd-verify' }, { ...selection, paths: ['src-other/a.ts'] },
    { ...selection, objective: 'billing alone' }, { ...selection, paths: [] }]) {
    const found = await lookup(f.root, request);
    assert.equal(found.skills.some(item => item.id === 'alpha'), false);
  }
});

test('PK4 combined supplement measures emitted escaped bytes and intersects proven lane tools', async t => {
  const f = fixture(t);
  const request = { ...selection, files: [join(f.root, 'src/a.ts')], availableTools: ['read', 'mdd_worker_edit', 'bash', 'invented'] };
  const found = await lookup(f.root, request);
  let metrics;
  const sent = supplementKnowledge('mandatory', found, request, f.root, 96000, value => { metrics = value; });
  const line = sent.split('\n').find(line => line.startsWith('{'));
  const data = JSON.parse(line);
  assert.deepEqual(data.tools, ['read', 'mdd_worker_edit']);
  assert.ok(data.excerpt.includes('PRIVATE_SKILL_parser'));
  assert.equal(data.path, undefined, 'workers receive excerpts, never an instruction to read an undeclared skill');
  assert.deepEqual(metrics, { candidates: 1, freshHits: 1, staleRejects: 0,
    selectedReferences: [], selectedSkillIDs: ['parser'], selectedBytes: Buffer.byteLength(line + '\n'),
    promptByteDelta: Buffer.byteLength(sent) - Buffer.byteLength('mandatory') });
  const unproven = supplementKnowledge('mandatory', found, selection, f.root, 96000);
  assert.equal(JSON.parse(unproven.split('\n').find(line => line.startsWith('{'))).tools, undefined);
  const explore = { ...request, phase: 'mdd-explore' };
  const readOnly = supplementKnowledge('mandatory', await lookup(f.root, explore), explore, f.root, 96000);
  assert.deepEqual(JSON.parse(readOnly.split('\n').find(line => line.startsWith('{'))).tools, ['read']);
});

test('PK4 zero budget and no selections report zero emitted bytes without trimming mandatory context', async t => {
  const f = fixture(t), found = await lookup(f.root);
  for (const [input, limit] of [[found, 9], [await lookup(f.root, { ...selection, objective: 'billing' }), 96000]]) {
    let metrics;
    assert.equal(supplementKnowledge('mandatory', input, selection, f.root, limit, value => { metrics = value; }), 'mandatory');
    assert.equal(metrics.selectedBytes, 0); assert.equal(metrics.promptByteDelta, 0);
    assert.deepEqual(metrics.selectedSkillIDs, []);
  }
});

for (const changed of ['skill', 'catalog']) test(`PK4 final dispatch rejects changed ${changed} bytes`, async t => {
  const f = fixture(t), found = await lookup(f.root);
  fs.appendFileSync(join(f.root, changed === 'skill' ? entry().path : 'mdd/knowledge.json'), '\nchanged');
  let metrics;
  assert.equal(supplementKnowledge('mandatory', found, selection, f.root, 96000, value => { metrics = value; }), 'mandatory');
  assert.equal(metrics.staleRejects, 1); assert.equal(metrics.promptByteDelta, 0);
});

test('PK4 catalog rejects unapproved, private, missing, linked and oversized sources', async t => {
  const f = fixture(t);
  for (const item of [{ ...entry(), approved: false }, { ...entry(), path: '../SKILL.md' },
    { ...entry(), path: '.private/SKILL.md' }, { ...entry(), path: 'secrets/SKILL.md' },
    { ...entry(), path: 'skills/missing/SKILL.md' }, { ...entry(), path: 'skills/parser/README.md' }]) {
    f.write({ version: 1, skills: [item] });
    assert.deepEqual((await lookup(f.root)).skills, []);
  }
  f.write({ version: 1, skills: [entry()] });
  fs.linkSync(join(f.root, entry().path), join(f.root, 'alias'));
  assert.deepEqual((await lookup(f.root)).skills, []);
  fs.unlinkSync(join(f.root, 'alias'));
  fs.writeFileSync(join(f.root, entry().path), 'x'.repeat(65537));
  assert.deepEqual((await lookup(f.root)).skills, []);
});

test('PK4 strict bounded catalog rejects versions, unknown fields, duplicates and overflow', async t => {
  const f = fixture(t);
  for (const value of [{ version: 2, skills: [entry()] }, { version: 1, skills: [entry()], command: 'execute' },
    { version: 1, skills: [entry(), entry()] }, { version: 1, skills: Array.from({ length: 33 }, (_, i) => entry(`skill-${i}`)) }]) {
    f.write(value); assert.deepEqual((await lookup(f.root)).skills, []);
  }
});

test('PK4 catalog and skills reject linked directories and hardlinked catalog files', async t => {
  const f = fixture(t);
  fs.linkSync(join(f.root, 'mdd/knowledge.json'), join(f.root, 'catalog-alias'));
  assert.deepEqual((await lookup(f.root)).skills, []);
  fs.unlinkSync(join(f.root, 'catalog-alias'));
  fs.renameSync(join(f.root, 'skills'), join(f.root, 'real-skills'));
  fs.symlinkSync(join(f.root, 'real-skills'), join(f.root, 'skills'), 'junction');
  assert.deepEqual((await lookup(f.root)).skills, []);
  fs.unlinkSync(join(f.root, 'skills'));
  fs.renameSync(join(f.root, 'real-skills'), join(f.root, 'skills'));
  fs.renameSync(join(f.root, 'mdd'), join(f.root, 'real-catalog'));
  fs.symlinkSync(join(f.root, 'real-catalog'), join(f.root, 'mdd'), 'junction');
  assert.deepEqual((await lookup(f.root)).skills, []);
});

test('PK4 multiple large excerpts obey one encoded budget and explicit truncation', async t => {
  const f = fixture(t, ['alpha', 'beta', 'gamma', 'delta'].map(entry));
  for (const id of ['alpha', 'beta', 'gamma', 'delta']) fs.writeFileSync(join(f.root, entry(id).path),
    `---\nname: ${id}\n---\n` + 'parser é @ guidance. '.repeat(2500));
  const found = await lookup(f.root);
  let metrics;
  const sent = supplementKnowledge('mandatory', found, selection, f.root, 96000, value => { metrics = value; });
  assert.ok(sent.includes('[Excerpt truncated]'));
  assert.equal(metrics.selectedSkillIDs.length, 1);
  assert.ok(metrics.promptByteDelta <= 8192);
  assert.equal(metrics.promptByteDelta, Buffer.byteLength(sent) - 9);
});
