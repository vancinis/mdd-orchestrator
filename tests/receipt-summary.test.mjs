import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { receiptWithSummary } from '../dist/phase-runner.js';

test('a receipt with an ordinary summary carries it verbatim', () => {
  const receipt = { kind: 'agent-evidence', runID: 'r', evidenceSummary: 'Done.' };
  assert.deepEqual(JSON.parse(receiptWithSummary(receipt)), receipt);
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
