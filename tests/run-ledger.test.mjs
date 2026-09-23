import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearRuns, MAX_RUNS, readRuns, recordRun, recordRunQuietly } from '../dist/run-ledger.js';

function root(t) {
  const path = fs.mkdtempSync(join(tmpdir(), 'mdd-runs-'));
  t.after(() => fs.rmSync(path, { recursive: true, force: true }));
  return path;
}

const all = { requirements: 'confirmed', plan: 'confirmed', implementation: 'confirmed', checks: 'confirmed' };
const entry = (change = {}) => ({
  runID: 'run-one', state: 'complete', directory: '/repo/linked', route: ['mdd-plan', 'mdd-apply', 'mdd-verify'],
  phase: 'mdd-verify', evidence: { ...all }, changedFiles: 3, checks: { total: 2, passed: 2, failed: 0 },
  concerns: 0, goal: 'Validate orders before processing.', limits: [], ...change,
});

test('a finished run is recorded with its outcome, coverage and checks', t => {
  const path = root(t);
  const recorded = recordRun(path, entry(), 1000);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.total, 1);
  assert.equal(recorded.recorded.coverage, 100);
  assert.equal(recorded.recorded.timestamp, 1000);
  const read = readRuns(path);
  assert.equal(read.total, 1);
  assert.deepEqual(read.runs[0].route, ['mdd-plan', 'mdd-apply', 'mdd-verify']);
  assert.equal(read.runs[0].goal, 'Validate orders before processing.');
});

// A run that was blocked and later finished is one run that finished. Appending both would make a
// repository look like it did twice the work and abandoned half of it.
test('a run that reaches a further state replaces its own row instead of adding one', t => {
  const path = root(t);
  recordRun(path, entry({ state: 'blocked', phase: 'mdd-apply', changedFiles: 0, evidence: { ...all, checks: 'unearned' } }), 1000);
  recordRun(path, entry(), 2000);
  const read = readRuns(path);
  assert.equal(read.total, 1);
  assert.equal(read.runs[0].state, 'complete');
  assert.equal(read.runs[0].timestamp, 2000);
  // A different run is a different row.
  recordRun(path, entry({ runID: 'run-two' }), 3000);
  assert.equal(readRuns(path).total, 2);
});

test('runs are read newest first and can be limited', t => {
  const path = root(t);
  for (let index = 0; index < 5; index++) recordRun(path, entry({ runID: `run-${index}` }), 1000 + index);
  const read = readRuns(path, { limit: 2 });
  assert.equal(read.total, 5);
  assert.deepEqual(read.runs.map(run => run.runID), ['run-4', 'run-3']);
});

test('the ledger is bounded, dropping the oldest rows rather than growing forever', t => {
  const path = root(t);
  for (let index = 0; index < MAX_RUNS + 3; index++) recordRun(path, entry({ runID: `run-${index}` }), 1000 + index);
  const read = readRuns(path);
  assert.equal(read.total, MAX_RUNS);
  assert.equal(read.runs[0].runID, `run-${MAX_RUNS + 2}`);
  assert.equal(read.runs.at(-1).runID, 'run-3');
});

test('an invalid row is refused without touching the file, and recording never throws', t => {
  const path = root(t);
  recordRun(path, entry(), 1000);
  for (const change of [{ state: 'ready' }, { phase: 'orchestrator' }, { changedFiles: -1 }, { runID: '' },
    { evidence: { requirements: 'confirmed' } }, { route: ['nonsense'] }]) {
    assert.equal(recordRun(path, entry(change), 2000).ok, false, JSON.stringify(change));
  }
  assert.equal(readRuns(path).total, 1);
  // The quiet variant is what a run calls, and it swallows everything.
  assert.doesNotThrow(() => recordRunQuietly(path, entry({ state: 'ready' }), 2000));
  assert.doesNotThrow(() => recordRunQuietly('\0invalid', entry(), 2000));
});

// Oversize prose is trimmed rather than refused: losing the record that a run happened at all,
// because its goal was long, would trade the fact for the footnote.
test('an overlong goal or limit is trimmed, and the run is still recorded', t => {
  const path = root(t);
  const recorded = recordRun(path, entry({ goal: 'x'.repeat(400), limits: ['y'.repeat(400), 'z', 'z', 'z', 'z'] }), 1000);
  assert.equal(recorded.ok, true);
  assert.equal(recorded.recorded.goal.length, 300);
  // At most four limits are kept, so one verbose run cannot crowd out the rest of the ledger.
  assert.equal(recorded.recorded.limits.length, 4);
  assert.equal(recorded.recorded.limits[0].length, 300);
});

test('a damaged ledger reads as unavailable instead of throwing, and clearing restores it', t => {
  const path = root(t);
  recordRun(path, entry(), 1000);
  fs.writeFileSync(join(path, '.mdd/runs.jsonl'), 'not json\n');
  assert.equal(readRuns(path).ok, false);
  assert.equal(clearRuns(path).ok, true);
  assert.deepEqual(readRuns(path), { ok: true, runs: [], total: 0 });
});
