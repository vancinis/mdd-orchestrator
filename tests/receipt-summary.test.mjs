import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { receiptWithSummary } from '../dist/phase-runner.js';

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
