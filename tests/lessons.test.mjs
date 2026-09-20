import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearLessons, markLessons, readLessons, recordLesson, recordLessonQuietly, renderLessonsReport } from '../dist/lessons.js';

const now = Date.UTC(2027, 0, 15, 12);
function fixture(t) {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'mdd-lessons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const file = root => join(root, '.mdd/lessons.jsonl');
const user = (title = 'El reporte se presentó en inglés') => ({ source: 'user', title, detail: 'Debía presentarse en español y traducir solo la prosa del subagente.' });

test('a recorded improvement is kept as text, gitignored, and read back newest first', t => {
  const root = fixture(t);
  const first = recordLesson(root, user(), now);
  assert.equal(first.ok, true);
  assert.equal(first.recorded.state, 'open');
  assert.equal(first.recorded.source, 'user');
  assert.match(first.recorded.id, /^[0-9a-f]{16}$/);
  const second = recordLesson(root, { source: 'failure', kind: 'result-rejected', phase: 'mdd-apply', title: 'mdd-apply: attempt 1 of 3 did not complete', detail: 'The dispatched task failed before reporting a result.' }, now + 1000);
  assert.equal(second.ok, true);
  // Two entries, one file, and the whole .mdd directory is already ignored: this holds text, which
  // is exactly why it must not become something a commit can carry out of the workspace.
  assert.equal(fs.readFileSync(file(root), 'utf8').trimEnd().split('\n').length, 2);
  assert.equal(fs.readFileSync(join(root, '.mdd/.gitignore'), 'utf8'), '*\n');
  const read = readLessons(root);
  assert.equal(read.total, 2);
  assert.deepEqual(read.lessons.map(lesson => lesson.source), ['failure', 'user']);
  assert.equal(read.lessons[0].kind, 'result-rejected');
  assert.equal(read.lessons[0].phase, 'mdd-apply');
});

test('two improvements written in the same millisecond keep separate identities', t => {
  const root = fixture(t);
  const first = recordLesson(root, user('Primera'), now);
  const second = recordLesson(root, user('Segunda'), now);
  assert.notEqual(first.recorded.id, second.recorded.id);
  assert.equal(readLessons(root).total, 2);
});

test('an improvement without usable text is refused instead of recorded empty', t => {
  const root = fixture(t);
  for (const invalid of [
    { ...user(), title: '   ' },
    { ...user(), detail: 'x\u001b[31m' },
    { ...user(), title: 'x'.repeat(201) },
    { ...user(), source: 'invented' },
    { ...user(), phase: 'orchestrator' },
    { ...user(), kind: 'not-a-failure-class' },
  ]) {
    assert.deepEqual(recordLesson(root, invalid, now), { ok: false, diagnostic: 'invalid-lesson' });
  }
  assert.equal(fs.existsSync(file(root)), false);
});

// An automatic entry is written from the failure path of a live run. Failing there would turn the
// record of a broken route into a second, louder break.
test('recording quietly never throws, whatever it is handed', t => {
  const root = fixture(t);
  recordLessonQuietly(root, { source: 'failure', title: '', detail: '' }, now);
  recordLessonQuietly(join(root, 'missing', 'deeper'), user(), now);
  recordLessonQuietly(root, user(), now);
  assert.equal(readLessons(root).total, 1);
});

test('filtering answers by text and by state, and marking changes neither the text nor the count', t => {
  const root = fixture(t);
  recordLesson(root, user('El PR quedó en inglés'), now);
  const second = recordLesson(root, { source: 'failure', kind: 'native-error', phase: 'mdd-verify', title: 'mdd-verify: attempt 2 of 3 did not complete', detail: 'The dispatched task failed or was interrupted.' }, now + 1000);
  assert.deepEqual(readLessons(root, { text: 'inglés' }).lessons.map(lesson => lesson.title), ['El PR quedó en inglés']);
  assert.deepEqual(readLessons(root, { text: 'mdd-verify' }).lessons.map(lesson => lesson.kind), ['native-error']);
  assert.equal(readLessons(root, { limit: 1 }).lessons.length, 1);
  const marked = markLessons(root, [second.recorded.id], 'applied');
  assert.deepEqual(marked, { ok: true, updated: [second.recorded.id], unknown: [] });
  assert.deepEqual(readLessons(root, { state: 'applied' }).lessons.map(lesson => lesson.id), [second.recorded.id]);
  assert.equal(readLessons(root, { state: 'open' }).lessons.length, 1);
  // Marking is not deleting: the history is the substrate the next review works from.
  assert.equal(readLessons(root).total, 2);
  assert.deepEqual(markLessons(root, ['0'.repeat(16)], 'reviewed'), { ok: true, updated: [], unknown: ['0'.repeat(16)] });
  assert.deepEqual(markLessons(root, ['not-an-id'], 'reviewed'), { ok: false, diagnostic: 'invalid-lesson' });
});

test('the file is capped, and what has already been reviewed is what falls off first', t => {
  const root = fixture(t);
  const kept = [];
  for (let index = 0; index < 505; index += 1) {
    const recorded = recordLesson(root, user(`Entrada ${index}`), now + index);
    if (index < 5) kept.push(recorded.recorded.id);
  }
  // The five oldest were reviewed, so they are the five that go when the cap is reached.
  markLessons(root, kept, 'reviewed');
  const after = recordLesson(root, user('La que desborda'), now + 10000);
  assert.equal(after.ok, true);
  const read = readLessons(root);
  assert.equal(read.total, 500);
  for (const id of kept) assert.equal(read.lessons.some(lesson => lesson.id === id), false, id);
  assert.equal(read.lessons[0].title, 'La que desborda');
});

test('a damaged improvements file is reported, never silently read as half a list', t => {
  const root = fixture(t);
  recordLesson(root, user(), now);
  fs.appendFileSync(file(root), '{ not this module\u2019s output\n');
  assert.deepEqual(readLessons(root), { ok: false, diagnostic: 'lessons-unavailable' });
});

test('the report is Spanish, names what is still unreviewed, and says so when there is nothing', t => {
  const root = fixture(t);
  assert.match(renderLessonsReport([], 0), /Todavía no hay ninguna anotada/);
  recordLesson(root, user(), now);
  recordLesson(root, { source: 'failure', kind: 'result-malformed', phase: 'mdd-plan', title: 'mdd-plan: attempt 1 of 3 did not complete', detail: 'MDD could not read the report.' }, now + 1000);
  const read = readLessons(root);
  const text = renderLessonsReport(read.lessons, read.total);
  assert.match(text, /Automejoras anotadas de MDD — locales, nunca se exportan/);
  assert.match(text, /2 de 2 anotada\(s\) en este listado; 2 sin revisar/);
  assert.match(text, /pedida por vos/);
  assert.match(text, /fallo registrado · abierta · reporte ilegible · mdd-plan/);
  assert.doesNotMatch(text, /\b(lesson|improvement|open|recorded)\b/i);
});

test('clearing removes the file without touching the rest of the workspace record', t => {
  const root = fixture(t);
  recordLesson(root, user(), now);
  assert.deepEqual(clearLessons(root), { ok: true });
  assert.equal(fs.existsSync(file(root)), false);
  assert.equal(fs.existsSync(join(root, '.mdd/.gitignore')), true);
  assert.deepEqual(readLessons(root), { ok: true, lessons: [], total: 0 });
});
