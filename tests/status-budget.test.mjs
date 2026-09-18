import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusPayload, STATUS_BUDGET_BYTES, STATUS_DROP_ORDER, STATUS_PROTECTED_FIELDS } from '../dist/status-budget.js';

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
