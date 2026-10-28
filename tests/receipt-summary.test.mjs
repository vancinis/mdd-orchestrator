import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { intentEnvelope, receiptWithSummary } from '../dist/phase-runner.js';

test('a receipt with an ordinary summary carries it verbatim', () => {
  const receipt = { kind: 'agent-evidence', runID: 'r', evidenceSummary: 'Done.' };
  assert.deepEqual(JSON.parse(receiptWithSummary(receipt)), receipt);
});

test('long executed commands are clipped before the summary is given up', () => {
  const probe = `node -e "${'x'.repeat(2000)}"`;
  const evidenceSummary = 'Verification found two gaps.';
  const reportedChecks = [{ command: 'npm test', exit: 0 }, ...Array(20).fill({ command: probe, exit: 0 })];
  const text = receiptWithSummary({ kind: 'agent-evidence', runID: 'r', evidenceSummary, reportedChecks });
  assert.ok(Buffer.byteLength(text) <= 40000);
  const receipt = JSON.parse(text);
  assert.equal(receipt.evidenceSummary, evidenceSummary, 'the summary is what a later session recalls');
  assert.equal(receipt.reportedChecksClipped, true);
  assert.deepEqual(receipt.reportedChecks[0], { command: 'npm test', exit: 0 });
  assert.ok(Buffer.byteLength(receipt.reportedChecks[1].command) <= 500);
  assert.equal(receipt.reportedChecks[1].commandBytes, Buffer.byteLength(probe));
  assert.equal(receipt.reportedChecks[1].commandSha256, createHash('sha256').update(probe).digest('hex'));
});

test('an unbounded summary degrades to its size and digest so the receipt still fits Engram', () => {
  const evidenceSummary = 'é'.repeat(30000);
  const text = receiptWithSummary({ kind: 'agent-evidence', runID: 'r', evidenceSummary });
  assert.ok(Buffer.byteLength(text) <= 40000);
  assert.deepEqual(JSON.parse(text), {
    kind: 'agent-evidence', runID: 'r', evidenceSummaryOmitted: true, evidenceSummaryBytes: 60000,
    evidenceSummarySha256: createHash('sha256').update(evidenceSummary).digest('hex'),
  });
});

// The user's request has no size limit. A 12000-byte cap on it existed only so this receipt would
// fit Engram; the receipt now degrades the request instead, after the context, and never refuses it.
test('regression: a long request degrades to its size and digest in the Engram intent receipt, after the context', () => {
  const requirements = 'Necesito este cambio con todo el detalle que escribí. '.repeat(1000);
  assert.ok(Buffer.byteLength(requirements) > 40000);
  const context = [{ label: 'Notas', content: 'x'.repeat(30000), source: 'coordinator' }];
  const receipt = intentEnvelope({ kind: 'intent', runID: 'r', requirements }, context);
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 40000);
  assert.equal(receipt.contextOmitted, true, 'the context degrades first');
  assert.equal(receipt.requirements, undefined);
  assert.equal(receipt.requirementsOmitted, true);
  assert.equal(receipt.requirementsBytes, Buffer.byteLength(requirements));
  assert.equal(receipt.requirementsSha256, createHash('sha256').update(requirements).digest('hex'));
  // A request that fits once the context degrades keeps its text.
  const fits = 'Un pedido de tamaño normal. '.repeat(600);
  const kept = intentEnvelope({ kind: 'intent', runID: 'r', requirements: fits }, context);
  assert.equal(kept.requirements, fits); assert.equal(kept.contextOmitted, true); assert.equal(kept.requirementsOmitted, undefined);
  assert.deepEqual(intentEnvelope({ kind: 'intent', requirements: 'Breve.' }, []), { kind: 'intent', requirements: 'Breve.' });
});
