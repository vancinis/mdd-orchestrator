import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { audit, classifyRunPath, openAuditDb, parseArgs } from '../scripts/context-audit.mjs';

const dir = mkdtempSync(join(tmpdir(), 'context-audit-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const path = join(dir, 'fixture.db');
const cutoff = 1792800000000;
const root = '.mdd/runs/20261123-example';
const output = 'ñ—😀';
const privateText = 'private fixture body';
const tool = (name, input = {}, text = '') => ({
  type: 'tool', name, state: { input, content: [{ text }] },
});
const read = (path, text = output) => tool('read', { path }, text);
const messages = [
  ['assistant', { content: [tool('subagent'), read(`${root}/01-explore.md`)] }],
  ['assistant', { content: [tool('subagent')] }],
  ['user', { text: output }],
  ['assistant', { content: [
    read(`${root}/01-explore.md`), tool('subagent'), tool('shell'),
    read(`${root}/01-explore.md`), read(`${root}.md`),
    read(`${root}/i2-next/100-apply.md`), read(`${root}/history.md`),
    read(`${root}/evidence/probe.log`, privateText),
  ] }],
  ['compaction', { status: 'completed', summary: output }],
];

{
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE session_v2(id, parent_id, agent, time_created);
           CREATE TABLE session_message(session_id, type, seq, data);`);
  const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?)');
  const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  function seed(id, count, rows = [], { parent = null, agent = 'mdd-orchestrator', time = cutoff + 1 } = {}) {
    session.run(id, parent, agent, time);
    for (let i = 0; i < count; i++) {
      const [type, data] = rows[i] ?? ['user', {}];
      message.run(id, type, i, typeof data === 'string' ? data : JSON.stringify(data));
    }
  }
  seed('s39', 39);
  seed('s40', 40, messages);
  seed('s119', 119);
  seed('s120', 120, [
    ...messages,
    ['synthetic', { text: output, metadata: { source: 'subagent' } }],
    ['system', { text: output }],
    ['assistant', { content: [
      tool('execute', { code: 'mem_save' }, output),
      tool('execute', { code: 'mem_search' }, output),
      tool('write', { path: `${root}.md` }, output),
      tool('write', { path: `${root}/01-explore.md` }, output),
      tool('read', { path: 'src/main.ts' }, output),
      tool('unknown', {}, output),
    ] }],
  ]);
  seed('child', 120, [], { parent: 's120' });
  seed('other', 120, [], { agent: 'mdd-apply' });
  seed('legacy', 120, [['assistant', { content: [tool('mdd_status')] }]]);
  seed('legacy-adapt', 120, [['assistant', { content: [tool('mdd_adapt')] }]]);
  seed('boundary', 120, [], { time: cutoff });
  seed('later', 40, [], { time: cutoff + 2 });
  seed('broken', 2, [['user', '{broken'], ['user', { text: output }]]);
  const artifactPath = `${root}/01-explore.md`;
  const mixedRead = read(artifactPath);
  mixedRead.state.content = [{ text: 'ñ' }, { type: 'image' }, { text: '—😀' }];
  seed('broken-tool-output', 6, [
    ['assistant', { content: [mixedRead] }],
    ...[{}, ['fake'], 12, false, null].map(text => ['assistant', {
      content: [read(artifactPath, text), read(artifactPath, 'also skipped')],
    }]),
  ]);
  const malformed = [
    ...[false, 0, '', null].flatMap(content => [
      ['assistant', { content }],
      ['assistant', { content: [{ ...read(artifactPath), state: { input: { path: artifactPath }, content } }] }],
    ]),
    ['synthetic', { text: 0 }],
    ['user', { text: {} }],
    ['system', { text: false }],
    ['compaction', { status: 'completed', summary: [] }],
    ['assistant', { content: [{ type: 'text', text: 42 }] }],
    ['assistant', { content: [tool('read', { path: [artifactPath] }, output)] }],
  ];
  seed('broken-shapes', malformed.length + 2, [
    ...malformed,
    ['assistant', { content: [read(artifactPath), { type: 'tool', name: 'read', state: { input: { path: `${root}.md` } } }] }],
    ['synthetic', { text: '' }],
  ]);
  db.exec('COMMIT');
  db.close();
}

function measure(...args) {
  const options = parseArgs(['--db', path, ...args]);
  const db = openAuditDb(options.db);
  try {
    return audit(db, options);
  } finally {
    db.close();
  }
}

test('historical cohorts preserve thresholds, time boundary, root, agent and legacy differences', () => {
  const { views } = measure('--until', String(cutoff + 1));
  assert.deepEqual(views.agg.cohort.ids, ['s119', 's120', 's40']);
  assert.deepEqual(views.ctx2.cohort.ids, ['legacy', 'legacy-adapt', 's120']);
  assert.equal(views.agg.cohort.baseline, true);
  assert.equal(measure('--min-messages', '39').views.agg.cohort.baseline, false);
  assert.ok(measure('--min-messages', '39').views.agg.cohort.ids.includes('s39'));
});

test('historical metrics use UTF-16 units and the prior tool with user reset', () => {
  const result = measure('--until', String(cutoff + 1));
  const { agg, ctx2, layout } = result.views;
  assert.equal(result.units, 'utf16-code-units');
  assert.deepEqual(agg.artifactReads, {
    count: 6, afterSubagent: 8, other: 16, afterSubagentShare: 1 / 3, byKind: { explore: 24 },
  });
  assert.deepEqual(agg.runFileReads, { count: 2, volume: 8 });
  assert.deepEqual(agg.runsPerSession, { 0: 1, 1: 2, 2: 0, 3: 0, '4+': 0 });
  assert.deepEqual(agg.completedCompactions, [
    { id: 's120', count: 1, runs: 1, messages: 120 },
    { id: 's40', count: 1, runs: 1, messages: 40 },
  ]);
  for (const [bucket, kind, input] of [
    ['mdd-bookkeeping', 'engram-save', { code: 'mem_save' }],
    ['mdd-bookkeeping', 'engram-read', { code: 'mem_search' }],
    ['mdd-bookkeeping', 'write-run-file', { path: `${root}.md` }],
    ['mdd-bookkeeping', 'write-artifact', { path: `${root}/01-explore.md` }],
    ['direct-work', 'read-source', { path: 'src/main.ts' }],
  ]) {
    assert.deepEqual(ctx2.subBuckets[`${bucket}/${kind}`], { count: 1, volume: JSON.stringify(input).length + 4 });
  }
  assert.deepEqual(ctx2.subBuckets['conversation/compaction-summary'], { count: 1, volume: 4 });
  assert.deepEqual(ctx2.subBuckets['actor-report/subagent-notice'], { count: 1, volume: 4 });
  assert.deepEqual(ctx2.subBuckets['host-overhead/system-notice'], { count: 1, volume: 4 });
  assert.deepEqual(ctx2.subBuckets['other/tool:mdd_status'], { count: 1, volume: 2 });
  assert.equal(ctx2.total, Object.values(ctx2.subBuckets).reduce((n, v) => n + v.volume, 0));
  assert.equal(ctx2.buckets['mdd-bookkeeping'].share, ctx2.buckets['mdd-bookkeeping'].volume / ctx2.total);
  assert.deepEqual(layout.artifactByIteration.I2, { count: 2, volume: 8 });
  assert.equal(layout.reads.history.count, 2);
  assert.equal(layout.reads.evidence.count, 2);
  assert.match(layout.label, /not a historical baseline/);
  assert.ok(!JSON.stringify(result).includes(privateText));
});

test('current layout separates run files, legacy and iteration artifacts, history and evidence', () => {
  for (const [relative, kind, iteration, actor] of [
    [`${root}.md`, 'run-file'],
    [`${root}/01-explore.md`, 'artifact', 'I1', 'explore'],
    [`${root}/i2-next/100-apply-T2.md`, 'artifact', 'I2', 'apply'],
    [`${root}/08a-apply.md`, 'artifact', 'I1', 'apply'],
    [`${root}/history.md`, 'history'],
    [`${root}/evidence/01-probe.md`, 'evidence'],
    [`${root}/notes.md`, 'other-mdd'],
  ]) {
    for (const file of [relative, `C:\\repo\\${relative.replaceAll('/', '\\')}`]) {
      const actual = classifyRunPath(file);
      assert.equal(actual.kind, kind, file);
      if (iteration) assert.equal(actual.iteration, iteration, file);
      if (actor) assert.equal(actual.actor, actor, file);
    }
  }
  assert.equal(classifyRunPath('src/runs/example.md'), null);
  assert.equal(classifyRunPath('not.mdd/runs/example.md'), null);
});

test('empty cohorts report zeros, null shares and DB-only limits', () => {
  const { views, limits } = measure('--since', String(cutoff + 100));
  assert.equal(views.agg.artifactReads.count, 0);
  assert.equal(views.agg.artifactReads.afterSubagentShare, null);
  assert.equal(views.ctx2.total, 0);
  assert.equal(views.ctx2.buckets['mdd-bookkeeping'].share, null);
  assert.match(JSON.stringify(limits), /filesystem metrics.*unavailable/i);
});

test('non-string tool output skips the entire malformed message in every view', () => {
  const manifest = join(dir, 'broken-tool-output.txt');
  writeFileSync(manifest, 'broken-tool-output\n');
  const { provenance, views } = measure('--sessions-file', manifest, '--min-messages', '0');
  assert.equal(provenance.complete, false);
  assert.equal(provenance.skipped, 5);
  assert.equal(views.agg.artifactReads.count, 1);
  assert.deepEqual(views.agg.artifactReads.byKind, { explore: 4 });
  assert.deepEqual(views.layout.reads.artifact, { count: 1, volume: 4 });
  assert.deepEqual(views.ctx2.subBuckets['mdd-bookkeeping/read-artifact'], {
    count: 1, volume: JSON.stringify({ path: `${root}/01-explore.md` }).length + 4,
  });
});

test('malformed containers and measured text fields do not contribute counts or volume', () => {
  const manifest = join(dir, 'broken-shapes.txt');
  writeFileSync(manifest, 'broken-shapes\n');
  const { provenance, views } = measure('--sessions-file', manifest, '--min-messages', '0');
  assert.equal(provenance.complete, false);
  assert.deepEqual(views.layout.reads.artifact, { count: 1, volume: 4 });
  assert.deepEqual(views.layout.reads['run-file'], { count: 1, volume: 0 });
  assert.equal(views.agg.artifactReads.count, 1);
  assert.deepEqual(views.agg.completedCompactions, []);
  assert.deepEqual(views.ctx2.subBuckets, {
    'mdd-bookkeeping/read-artifact': { count: 1, volume: JSON.stringify({ path: `${root}/01-explore.md` }).length + 4 },
    'mdd-bookkeeping/read-run-file': { count: 1, volume: JSON.stringify({ path: `${root}.md` }).length },
    'other/synthetic': { count: 1, volume: 0 },
  });
  assert.equal(provenance.skipped, 14);
});

const script = fileURLToPath(new URL('../scripts/context-audit.mjs', import.meta.url));
function cli(db, ...args) {
  const result = spawnSync(process.execPath, [script, '--db', db, ...args], { encoding: 'utf8' });
  assert.ifError(result.error);
  return result;
}
test('real CLI failures, partial results and frozen repeats leave databases untouched', () => {
  function assertFatal(result, diagnostic) {
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, diagnostic);
  }
  function snapshot(file) {
    return { bytes: readFileSync(file), mtime: statSync(file).mtimeMs };
  }
  const original = snapshot(path);
  const missing = join(dir, 'missing.db');
  assertFatal(cli(missing), /database/i);
  assert.throws(() => statSync(missing), { code: 'ENOENT' });
  const unsupported = join(dir, 'unsupported.db');
  const db = new DatabaseSync(unsupported);
  db.exec('CREATE TABLE session_v2(id, parent_id, agent);');
  db.close();
  const bad = snapshot(unsupported);
  assertFatal(cli(unsupported), /unsupported schema.*time_created/i);
  assert.deepEqual(snapshot(unsupported), bad);
  assertFatal(cli(path, '--view', 'invalid'), /--view/);
  assertFatal(cli(path, '--min-messages', '1.5'), /--min-messages/);

  const manifest = join(dir, 'sessions.txt');
  writeFileSync(manifest, 'unknown\n');
  assertFatal(cli(path, '--sessions-file', manifest), /unknown session/i);
  writeFileSync(manifest, 'broken\n');
  const partial = cli(path, '--sessions-file', manifest, '--min-messages', '0');
  assert.equal(partial.status, 1, partial.stderr);
  assert.match(partial.stderr, /skipped 1/i);
  const report = JSON.parse(partial.stdout);
  assert.equal(report.provenance.complete, false);
  assert.equal(report.provenance.skipped, 1);
  assert.equal(report.views.ctx2.total, 4);

  writeFileSync(manifest, JSON.stringify(['s120', 's40']));
  function frozen() {
    const result = cli(path, '--sessions-file', manifest, '--until', String(cutoff + 1));
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes(privateText));
    const report = JSON.parse(result.stdout);
    delete report.provenance.generatedAt;
    return report;
  }
  const first = frozen();
  assert.deepEqual(first.views.agg.cohort.ids, ['s120', 's40']);
  assert.deepEqual(first.views.ctx2.cohort.ids, ['s120']);
  assert.deepEqual(frozen(), first);
  assert.deepEqual(snapshot(path), original);
});
