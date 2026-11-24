import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  checkpointText, extractCheckpoint, readRun, resolveActiveRun, runCandidates, runFileTargets,
} from '../dist/run-checkpoint.js';

const A = '20261101-run-a';
const B = '20261102-run-b';
const file = (id) => `.mdd/runs/${id}.md`;
const now = (id) => `## Now\n\n- Next: continue ${id}\n`;
const document = (status, body) => `---\nstatus: ${status} # fixture\n---\n\n# Run\n\n${body}`;
const message = (...content) => ({ role: 'assistant', content });
const call = (name, input) => ({ type: 'tool-call', name, input });
const write = (...ids) => message(...ids.map((id) => call('write', { path: file(id) })));
const activeSummary = checkpointText({ kind: 'run', id: A, others: [] }, { state: 'active', now: now(A) });
const ambiguousSummary = checkpointText({ kind: 'ambiguous', ids: [A, B] });
const history = (entries) => Array.from({ length: 6 }, (_, i) => entries[i] ?? message());

function fixture(t, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdd-checkpoint-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, '.mdd/runs'), { recursive: true });
  for (const [id, text] of Object.entries(files)) fs.writeFileSync(path.join(root, file(id)), text);
  return root;
}

function checkpoint(root, messages) {
  const candidates = runCandidates(messages, root).map((candidate) => ({
    ...candidate, ...readRun(root, candidate.id),
  }));
  const resolution = resolveActiveRun(candidates);
  return [resolution, checkpointText(resolution, candidates.find(({ id }) => id === resolution.id))];
}

for (const [name, entries, statusA, statusB, expected] of [
  ['single write', { 3: write(A) }, 'active', null, { kind: 'run', id: A, others: [] }],
  ['newest active write', { 2: write(A), 5: write(B) }, 'active', 'active', { kind: 'run', id: B, others: [A] }],
  ['newer closed run excluded', { 2: write(A), 5: write(B) }, 'active', 'completed', { kind: 'run', id: A, others: [] }],
  ['both runs closed', { 2: write(A), 5: write(B) }, 'abandoned', 'closed-unverified', { kind: 'none' }],
  ['same-message writes tie', { 5: write(A, B) }, 'active', 'active', { kind: 'ambiguous', ids: [A, B] }],
  ['newest unknown blocks selection', { 2: write(A), 5: write(B) }, 'active', null, { kind: 'ambiguous', ids: [A, B] }],
  ['older unknown does not block selection', { 2: write(B), 5: write(A) }, 'active', null, { kind: 'run', id: A, others: [B] }],
  ['summary text plus a later write B selects only B', {
    0: { role: 'user', content: [{ type: 'text', text: activeSummary }] }, 4: write(B),
  }, 'active', 'active', { kind: 'run', id: B, others: [] }],
]) {
  test(name, (t) => {
    const root = fixture(t, {
      ...(statusA && { [A]: document(statusA, now(A)) }),
      ...(statusB && { [B]: document(statusB, now(B)) }),
    });
    const [resolution, text] = checkpoint(root, history(entries));
    assert.deepEqual(resolution, expected);
    if (expected.kind === 'run') {
      assert.ok(text.includes(now(expected.id)));
      for (const id of expected.others) assert.ok(text.includes(id));
      assert.ok(!text.includes(now(expected.id === A ? B : A)));
    } else if (expected.kind === 'ambiguous') {
      assert.ok(text.startsWith(`MDD candidate runs: ${A}, ${B}\n`));
      assert.ok(!text.includes('- Next:'));
    } else {
      assert.equal(text, undefined);
    }
  });
}

test('marker text never supplies candidates in any message role', (t) => {
  const root = fixture(t, { [A]: document('active', now(A)), [B]: document('active', now(B)) });
  for (const text of [
    activeSummary, ambiguousSummary, `MDD active run: ${B}`,
    `Example:\n\`\`\`md\n${activeSummary}\n\`\`\``, `${activeSummary}\n\n${ambiguousSummary}`,
  ]) {
    for (const role of ['user', 'assistant']) {
      assert.deepEqual(checkpoint(root, [{ role, content: [{ type: 'text', text }] }]), [{ kind: 'none' }, undefined]);
    }
  }
});

test('a supplied summary argument cannot supply candidates', (t) => {
  const root = fixture(t);
  assert.deepEqual(runCandidates([], root, activeSummary), []);
});

test('only direct run-file targets and assistant calls supply write candidates', (t) => {
  const root = fixture(t, { [A]: document('active', now(A)), [B]: document('active', now(B)) });
  for (const name of ['write', 'edit', 'multiedit']) {
    assert.deepEqual(runFileTargets(name, { filePath: path.join(root, file(A)) }, root), [A]);
  }
  for (const name of ['patch', 'apply_patch']) {
    assert.deepEqual(runFileTargets(name, { patchText: [
      '*** Begin Patch', `*** Add File: ${file(A)}`, `*** Update File: ${file(A)}`,
      `*** Move to: ${file(B)}`, `*** Delete File: ${file(B)}`, '*** End Patch',
    ].join('\r\n') }, root), [A, B]);
  }
  for (const target of [
    `../${file(A)}`, `.mdd/runs/${A}/history.md`, '.mdd/runs/not-a-run.md', `${file(A)}:stream`,
  ]) assert.deepEqual(runFileTargets('edit', { path: target }, root), []);
  assert.deepEqual(runCandidates([
    { role: 'tool', content: [call('write', { path: file(B) })] },
    message(call('read', { path: file(B) })),
  ], root), []);
  assert.deepEqual(checkpoint(root, []), [{ kind: 'none' }, undefined]);
  assert.deepEqual(runCandidates([write(A), write(B), write(A)], root)
    .sort((a, b) => a.position - b.position), [{ id: B, position: 1 }, { id: A, position: 2 }]);
});

for (const size of [6_001, 32_000, 32_001]) {
  test(`Now at ${size} characters is whole or explicitly omitted`, (t) => {
    const section = `## Now\n${'x'.repeat(size - 8)}!`;
    assert.equal(section.length, size);
    const root = fixture(t, { [A]: document('active', section) });
    const [resolution, text] = checkpoint(root, [write(A)]);
    assert.equal(resolution.kind, 'run');
    if (size <= 32_000) {
      assert.ok(text.includes(section));
    } else {
      assert.match(text, /32001 characters.*reread/);
      assert.ok(!text.includes('xxxxxxxx'));
    }
  });
}

test('parses the actual T1 template, preserving section bytes and rereading changed disk state', (t) => {
  const contract = fs.readFileSync(new URL('../assets/opencode/contracts/run-file.md', import.meta.url), 'utf8');
  const template = contract.match(/```markdown\r?\n([\s\S]*?)\r?\n```/)[1].replace(/\r?\n/g, '\r\n');
  const section = template.slice(template.indexOf('## Now'), template.indexOf('## Request'));
  assert.deepEqual(extractCheckpoint(template), { status: 'active', now: section });
  const root = fixture(t, { [A]: template });
  assert.ok(checkpoint(root, [write(A)])[1].includes(section));
  const updated = template.replace('- Blockers: None.', '- Blockers: Awaiting confirmation.');
  fs.writeFileSync(path.join(root, file(A)), updated);
  const [, text] = checkpoint(root, [write(A)]);
  assert.ok(text.includes('- Blockers: Awaiting confirmation.'));
  assert.ok(!text.includes('- Blockers: None.'));
  assert.ok(!text.includes('## Request'));
  assert.equal(fs.readFileSync(path.join(root, file(A)), 'utf8'), updated);
});

test('legacy, missing, and malformed runs do not invent Now or status', (t) => {
  const root = fixture(t, { [A]: document('active', '## Request\nstatus: completed\n') });
  assert.match(checkpoint(root, [write(A)])[1], /has no `## Now`/);
  assert.match(checkpoint(root, [write(B)])[1], /MDD active run: .*run-b[\s\S]*reread/);
  fs.writeFileSync(path.join(root, file(A)), '# Run\nstatus: active\n## Now\n- Next: not trusted\n');
  const [resolution, text] = checkpoint(root, [write(A)]);
  assert.equal(resolution.kind, 'unreadable');
  assert.ok(!text.includes('- Next:'));
  assert.equal(readRun(root, '../other').state, 'unknown');
});

test('file read bound is inclusive and an oversized file yields only a reread marker', (t) => {
  const start = document('active', `${now(A)}\n## Log\n`);
  const within = start + 'x'.repeat(4 * 1024 * 1024 - Buffer.byteLength(start));
  const root = fixture(t, { [A]: within });
  assert.ok(checkpoint(root, [write(A)])[1].includes(now(A)));
  fs.appendFileSync(path.join(root, file(A)), 'a');
  const [resolution, text] = checkpoint(root, [write(A)]);
  assert.equal(resolution.kind, 'unreadable');
  assert.match(text, /4 MiB.*reread/);
  assert.ok(!text.includes('- Next:'));
});

test('symlink run files cannot supply checkpoint text', (t) => {
  const root = fixture(t, { [B]: document('active', now(B)) });
  try {
    fs.symlinkSync(path.join(root, file(B)), path.join(root, file(A)), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`cannot create symlink: ${error.code}`);
      return;
    }
    throw error;
  }
  const [resolution, text] = checkpoint(root, [write(A)]);
  assert.equal(resolution.kind, 'unreadable');
  assert.match(text, /reread/);
  assert.ok(!text.includes('- Next:'));
});

test('hard-linked files and nonregular run paths are rejected', (t) => {
  const root = fixture(t, { [B]: document('active', now(B)) });
  const target = path.join(root, file(A));
  fs.linkSync(path.join(root, file(B)), target);
  assert.equal(checkpoint(root, [write(A)])[0].kind, 'unreadable');
  fs.unlinkSync(target);
  fs.mkdirSync(target);
  assert.equal(checkpoint(root, [write(A)])[0].kind, 'unreadable');
});

test('a linked run directory cannot supply checkpoint text', (t) => {
  const source = fixture(t, { [A]: document('active', now(A)) });
  const root = fixture(t);
  const runs = path.join(root, '.mdd/runs');
  fs.rmdirSync(runs);
  try {
    fs.symlinkSync(path.join(source, '.mdd/runs'), runs, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) {
      t.skip(`cannot create directory link: ${error.code}`);
      return;
    }
    throw error;
  }
  const [resolution, text] = checkpoint(root, [write(A)]);
  assert.equal(resolution.kind, 'unreadable');
  assert.ok(!text.includes('- Next:'));
});
