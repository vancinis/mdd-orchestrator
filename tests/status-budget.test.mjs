import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusPayload, STATUS_BUDGET_BYTES, STATUS_COMPACT_KEEP, STATUS_DROP_ORDER, STATUS_PROTECTED_FIELDS } from '../dist/status-budget.js';

const filler = size => 'x'.repeat(size);
const base = () => ({
  state: 'ready', phase: 'mdd-apply', runID: 'run', sessionID: 'ses', mode: 'delegate',
  task: { description: 'MDD apply phase', subagent_type: 'mdd-apply', prompt: filler(15000) },
  brief: filler(15000), evidence: { plan: 'confirmed' }, coverage: 65, recoverable: true,
});

test('status budget: a small payload is passed through unchanged and declares no omission', () => {
  const value = { state: 'ready', task: { prompt: 'short' } };
  assert.equal(statusPayload(value), JSON.stringify(value));
});

test('status budget: oversized payloads drop expendable fields in the documented order', () => {
  const value = { ...base(), previousRuns: [{ runID: 'old', artifacts: [{ ref: { digest: filler(4000) } }] }],
    contexts: [{ summary: filler(4000) }], artifacts: [{ ref: { digest: filler(4000) } }],
    artifact: { ref: { digest: 'd' }, content: filler(16000) }, report: filler(4000), workflow: { answers: {} } };
  const text = statusPayload(value);
  assert.ok(Buffer.byteLength(text) <= STATUS_BUDGET_BYTES, `payload was ${Buffer.byteLength(text)} bytes`);
  const payload = JSON.parse(text);
  // Fixed order: superseded history first, the current artifact only once everything cheaper is gone.
  assert.deepEqual(payload.omitted, ['previousRuns', 'contexts', 'artifacts', 'artifact']);
  assert.match(payload.omittedNote, /Nothing was deleted/);
  assert.equal(payload.budget, undefined);
  // The two fields the protocol copies verbatim survive byte for byte.
  assert.deepEqual(payload.task, value.task);
  assert.equal(payload.brief, value.brief);
  assert.equal(payload.workflow.answers.answers, undefined);
  assert.ok(payload.report);
});

test('status budget: a task that cannot fit is reported as an explicit problem, never truncated', () => {
  const task = { description: 'MDD apply phase', subagent_type: 'mdd-apply', prompt: filler(60000) };
  const payload = JSON.parse(statusPayload({ ...base(), task, artifacts: [{ ref: { digest: filler(4000) } }] }));
  assert.deepEqual(payload.task, task, 'the exact task is preserved rather than cut');
  assert.deepEqual(payload.omitted, ['artifacts']);
  assert.equal(payload.budget.limit, STATUS_BUDGET_BYTES);
  assert.equal(payload.budget.taskBytes, Buffer.byteLength(JSON.stringify(task)));
  assert.ok(payload.budget.bytes > STATUS_BUDGET_BYTES);
  assert.match(payload.budget.problem, /Nothing was truncated here/);
  assert.match(payload.budget.problem, /mdd_phase_result/);
});

test('status budget: no protected field is ever droppable', () => {
  for (const key of STATUS_DROP_ORDER) assert.equal(STATUS_PROTECTED_FIELDS.includes(key), false, key);
  // A question is the other field copied verbatim, and it outlives every expendable field.
  const question = { questions: [{ header: 'Aprobación', question: filler(2000) }] };
  const payload = JSON.parse(statusPayload({ ...base(), question, workflow: { results: [filler(30000)] } }));
  assert.deepEqual(payload.question, question);
  assert.ok(payload.omitted.includes('workflow'));
});

test('status budget: non-object payloads are serialized as-is', () => {
  assert.equal(statusPayload('text'), '"text"');
  assert.equal(statusPayload(undefined), 'null');
});

test('compact view: reference material is shed while the protocol survives byte for byte', () => {
  const value = {
    ...base(), acceptance: { goal: filler(3000) }, decisions: [{ id: 'D1', description: filler(2000) }],
    planned: [{ id: 'T1', description: filler(2000) }], concerns: [{ evidence: filler(2000) }],
    verification: { changes: filler(1000) }, artifact: { ref: { digest: 'd' }, content: filler(4000) },
    previousRuns: [{ runID: 'old' }], report: 'Resumen\n', artifacts: [{ ref: { digest: 'd' } }],
  };
  const payload = JSON.parse(statusPayload(value, 'compact'));
  // Everything droppable that is not explicitly kept goes, and says so.
  for (const key of STATUS_DROP_ORDER) {
    if (STATUS_COMPACT_KEEP.includes(key) || value[key] === undefined) continue;
    assert.equal(payload[key], undefined, key);
    assert.ok(payload.omitted.includes(key), key);
  }
  for (const key of STATUS_COMPACT_KEEP) {
    if (value[key] === undefined) continue;
    assert.deepEqual(payload[key], value[key], `${key} is kept in the compact view`);
  }
  // The task is copied verbatim by the coordinator, so the projection never touches it.
  assert.deepEqual(payload.task, value.task);
  // The brief is the phase prompt again: named and sized here, fetched with detail="full".
  assert.equal(payload.brief, undefined);
  assert.equal(payload.briefBytes, Buffer.byteLength(value.brief));
  assert.ok(payload.omitted.includes('brief'));
  assert.match(payload.omittedNote, /Nothing was deleted/);
  assert.match(payload.omittedNote, /detail="full"/);
});

test('compact view: a brief small enough to cost less than its pointer is kept', () => {
  const brief = 'Carry out the phase and report it.';
  const payload = JSON.parse(statusPayload({ ...base(), brief, acceptance: { goal: filler(3000) } }, 'compact'));
  assert.equal(payload.brief, brief);
  assert.equal(payload.briefBytes, undefined);
  assert.equal(payload.omitted.includes('brief'), false);
});

test('compact view: recorded progress keeps its phases and drops only the prose', () => {
  const results = [
    { phase: 'mdd-plan', outcome: 'passed', evidenceSummary: filler(5000) },
    { phase: 'mdd-apply', outcome: 'failed', evidenceSummary: filler(5000) },
  ];
  const payload = JSON.parse(statusPayload({ ...base(), workflow: { answers: { mode: 'automatic' }, results } }, 'compact'));
  assert.deepEqual(payload.workflow.results, [
    { phase: 'mdd-plan', outcome: 'passed' }, { phase: 'mdd-apply', outcome: 'failed' },
  ]);
  assert.deepEqual(payload.workflow.answers, { mode: 'automatic' });
  assert.ok(payload.omitted.includes('workflow.results[].evidenceSummary'));
});

test('compact view: a run with nothing to shed is never made larger by the note', () => {
  // Declaring an omission costs more than this payload could save, so the whole thing is returned.
  const value = { ...base(), brief: 'Carry out the phase.', report: 'Resumen\n', concerns: [{ evidence: 'short' }] };
  const compact = statusPayload(value, 'compact');
  assert.equal(compact, JSON.stringify(value));
  assert.ok(Buffer.byteLength(compact) <= Buffer.byteLength(statusPayload(value, 'full')));
});

test('compact view: the budget still applies after the projection', () => {
  const value = { ...base(), rejected: { reason: 'r', text: filler(40000) }, acceptance: { goal: filler(5000) } };
  const text = statusPayload(value, 'compact');
  assert.ok(Buffer.byteLength(text) <= STATUS_BUDGET_BYTES, `payload was ${Buffer.byteLength(text)} bytes`);
  const payload = JSON.parse(text);
  // `acceptance` goes with the projection; `rejected` is kept by the compact view but is still
  // droppable, so budget pressure sheds it exactly as it would in the full view.
  assert.ok(payload.omitted.includes('acceptance'));
  assert.ok(payload.omitted.includes('rejected'));
  assert.deepEqual(payload.task, value.task);
});

test('compact view: the default for statusPayload stays full, so callers opt in', () => {
  // Enough reference material that shedding it beats the cost of declaring the omission.
  const value = { ...base(), acceptance: { goal: filler(3000) } };
  assert.equal(statusPayload(value), JSON.stringify(value), 'full is the default and passes the payload through');
  const compact = JSON.parse(statusPayload(value, 'compact'));
  assert.equal(compact.acceptance, undefined);
  assert.deepEqual(compact.omitted, ['acceptance', 'brief']);
});
