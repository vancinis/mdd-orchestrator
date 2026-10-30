import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { ProgressGuard } from '../dist/progress.js';
import { answers, reportDocument, throughRiskStop, structuredTraceFixture } from './adapter-fixture.mjs';

function fixture(t, enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-exploration-workers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['a.txt', 'b.txt']) writeFileSync(join(root, name), name);
  const runtime = { sessionID: 'parent', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const checkpoint = new CheckpointStore(root), ownership = new RunOwnershipStore(root);
  const inspect = { parent: async () => {}, result: async (_r, _c, _p, output) => output, stopped: async () => true };
  const options = { checkpoint, ownership, progress: new ProgressGuard(root), workers: { enabled },
    workerCapability: { phase: 'mdd-explore', readOnly: true } };
  const items = ['a', 'b'].map((name, index) => ({ id: `E${index + 1}`, purpose: `Inspect ${name} independently`,
    dependsOn: [], independent: true, complete: true, reads: [{ root, files: [`${name}.txt`] }] }));
  return { root, runtime, checkpoint, ownership, inspect, options, items, runner: new PhaseRunner(inspect, options) };
}

test('replacing settled exploration archives every complete member report', async t => {
  const f = fixture(t);
  await f.runner.explore({ purpose: 'Inspect both', workItems: f.items }, f.runtime);
  const ready = f.runner.status('parent');
  const calls = ['one', 'two'].map(callID => ({ sessionID: 'parent', callID }));
  const args = await Promise.all(ready.tasks.map((task, index) => f.runner.before(calls[index], task)));
  for (const index of [1, 0]) await f.runner.after(calls[index], args[index], reportDocument({
    evidenceSummary: `Findings ${index}`, artifact: `Complete evidence ${index}: ${'x'.repeat(9000)}` }));
  const old = f.checkpoint.readExploration('parent');
  // No size limit: the aggregate carries both complete member artifacts verbatim.
  for (const index of [0, 1]) assert.ok(JSON.parse(old.aggregate).artifact.includes(`Complete evidence ${index}: ${'x'.repeat(9000)}`));
  await f.runner.explore({ purpose: 'Another investigation', workItems: f.items }, f.runtime);
  const hash = createHash('sha256').update(`exploration-result:${old.id}`).digest('hex');
  const archived = JSON.parse(readFileSync(join(f.root, '.mdd', `checkpoint-${hash}.json`), 'utf8'));
  assert.deepEqual(archived, old);
  assert.deepEqual(archived.workerState.completed.map(member => member.taskID), ['E1', 'E2']);
  assert.notEqual(f.checkpoint.readExploration('parent').id, old.id);
});

