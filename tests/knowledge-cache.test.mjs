import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { knowledgeObservation, parseKnowledgeObservation } from '../dist/project-knowledge.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-knowledge-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function row(id, body = 'Canonical body', summary = 'Candidate summary') {
  const content = JSON.stringify({ ...knowledgeObservation({ summary, body, sources: ['src/a.ts'],
    applicability: { phases: ['mdd-apply'], paths: ['src'] } }, 'project', 'ses_original', 'msg_user', 'msg_assistant', 'a'.repeat(64)), recordedAt: '2026-10-09T00:00:00.000Z' });
  return { id, sessionID: 'ses_original', content };
}

test('cache reuses parsed envelopes only with complete matching canonical bytes and preserves detachment', async t => {
  const { KnowledgeCache } = await import('../dist/knowledge-cache.js');
  const root = fixture(t);
  let parses = 0;
  const cache = new KnowledgeCache(root, (...args) => { parses++; return parseKnowledgeObservation(...args); });
  const canonical = row(1);
  const first = cache.resolve(canonical, 'project');
  first.body = 'caller mutation';
  assert.equal(cache.resolve(canonical, 'project').body, 'Canonical body');
  assert.equal(parses, 1, 'warm identical canonical reads avoid repeated envelope parsing/normalization');
  assert.equal(cache.resolve(row(1, 'Updated canonical body'), 'project').body, 'Updated canonical body');
  assert.equal(parses, 2, 'changed canonical bytes require validation');
  assert.throws(() => cache.resolve(canonical, 'foreign'));
  assert.throws(() => cache.resolve({ ...canonical, content: '{' }, 'project'));
  const restarted = new KnowledgeCache(root, (...args) => {
    assert.ok(args[3], 'persisted materialization avoids decoding canonical JSON again');
    return parseKnowledgeObservation(...args);
  });
  assert.equal(restarted.resolve(row(1, 'Updated canonical body'), 'project').body, 'Updated canonical body');
});

test('forged disk materialization cannot substitute for complete canonical content', async t => {
  const { KnowledgeCache } = await import('../dist/knowledge-cache.js');
  const root = fixture(t);
  new KnowledgeCache(root).resolve(row(1), 'project');
  const file = join(root, '.mdd/knowledge-cache.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.entries[0].observation.body = 'forged cache claim';
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(new KnowledgeCache(root).resolve(row(1), 'project').body, 'Canonical body');
  assert.throws(() => parseKnowledgeObservation(row(1).content, 'project', 'ses_original', saved.entries[0].observation), /canonical bytes/);
});

test('cache enforces both 100-entry and serialized 512 KiB budgets with deterministic eviction', async t => {
  const { KnowledgeCache } = await import('../dist/knowledge-cache.js');
  const root = fixture(t);
  const cache = new KnowledgeCache(root);
  const file = join(root, '.mdd/knowledge-cache.json');
  for (let id = 1; id <= 101; id++) cache.resolve(row(id), 'project');
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.entries.length, 100);
  assert.equal(saved.entries.some(item => item.id === 1), false);
  for (let id = 102; id <= 180; id++) cache.resolve(row(id, 'x' + '\t'.repeat(4095)), 'project');
  assert.ok(fs.statSync(file).size <= 524288);
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(saved.entries.length < 100, 'escaped body bytes and envelope metadata spend the physical budget');
  assert.equal(saved.entries.at(-1).id, 180);
  assert.throws(() => cache.resolve(row(181, 'x'.repeat(4097)), 'project'));
});

test('cache corruption, oversized storage and deletion rebuild from canonical content without failing queries', async t => {
  const { KnowledgeCache } = await import('../dist/knowledge-cache.js');
  const root = fixture(t);
  fs.mkdirSync(join(root, '.mdd'));
  const file = join(root, '.mdd/knowledge-cache.json');
  for (const corrupt of ['{', JSON.stringify({ version: 99, entries: [] }), 'x'.repeat(524289)]) {
    fs.writeFileSync(file, corrupt);
    assert.equal(new KnowledgeCache(root).resolve(row(1), 'project').body, 'Canonical body');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  }
  fs.unlinkSync(file);
  assert.equal(new KnowledgeCache(root).resolve(row(1), 'project').summary, 'Candidate summary');
  assert.ok(fs.existsSync(file));
});

test('cache refuses linked storage without changing its target and remains optional', async t => {
  const { KnowledgeCache } = await import('../dist/knowledge-cache.js');
  const root = fixture(t);
  const outside = fixture(t);
  const target = join(outside, 'knowledge-cache.json');
  fs.writeFileSync(target, 'private target');
  fs.symlinkSync(outside, join(root, '.mdd'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(new KnowledgeCache(root).resolve(row(1), 'project').body, 'Canonical body');
  assert.equal(fs.readFileSync(target, 'utf8'), 'private target');
});
