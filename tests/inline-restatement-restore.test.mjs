import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PhaseRunner } from '../dist/phase-runner.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { reportDocument, riskReport, structuredTraceFixture, structuredVerificationFixture, SUMMARY_TEXT, ARTIFACT_TEXT, throughRiskStop } from './adapter-fixture.mjs';

// A refused report is restated by the coordinator (mdd_phase_result), which records it as an
// inline attempt. When that restated result advanced the route with no approval in between
// (automatic mode, the next Apply batch, the route mdd-risk selected), the next phase was readied
// before the progress marker settled, and readying it switched the run back to delegation. The
// marker then named the previous delegated call instead of the inline attempt the checkpoint
// recorded, and every restart refused the run: "Checkpoint and progress correlation disagree".

const report = data => reportDocument({ evidenceSummary: 'Scoped evidence.', artifact: 'Scoped artifact.', ...data });
const STEP = 'cli-validation';

async function fixture(t, { store = 'none', mode = 'automatic' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-inline-restore-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = { sessionID: 'ses_inline', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const durable = new CheckpointStore(root);
  const progress = new ProgressGuard(root);
  const inspect = { parent: async () => {}, result: async (_runtime, _call, _phase, output) => output, stopped: async () => true };
  let runner = new PhaseRunner(inspect, { checkpoint: durable, progress });
  let ordinal = 0;
  const f = {
    runtime, progress, durable,
    get runner() { return runner; },
    status: () => runner.status(runtime.sessionID),
    async dispatch() {
      const call = { sessionID: runtime.sessionID, callID: `call-${++ordinal}` };
      return { call, args: await runner.before(call, f.status().task) };
    },
    async finish(text) {
      const { call, args } = await f.dispatch();
      await runner.after(call, args, text);
    },
    async refuseThenRestate(refused, restated) {
      const { call, args } = await f.dispatch();
      await assert.rejects(runner.after(call, args, refused), /could not read/);
      assert.equal(f.status().state, 'ready');
      await runner.submit({ result: restated }, runtime);
    },
    async restart() {
      runner = new PhaseRunner(inspect, { checkpoint: durable, progress });
      return runner.restore(runtime);
    },
  };
  await runner.start({ preflight: { answers: { certainty: 'very-sure', artifactStore: store, mode, summary: 'low' } }, requirements: 'Validate CLI input.' },
    runtime, { requirementsConfirmed: true, userMessageID: 'user-inline' });
  return f;
}

for (const store of ['none', 'local']) {
  test(`${store}: an Apply result restated inline that advances the route survives restart`, async t => {
    const f = await fixture(t, { store });
    await throughRiskStop(f.runner, f.runtime.sessionID, 'low');
    await f.finish(report(structuredTraceFixture()));
    // The first report omits its completion, so it is refused for its wording and restated.
    await f.refuseThenRestate(report({ changes: ['src/cli.ts'] }), report({ completed: [STEP], changes: ['src/cli.ts'] }));
    const advanced = f.status();
    assert.equal(advanced.phase, 'mdd-verify'); assert.equal(advanced.state, 'ready');
    const saved = f.durable.read(f.runtime.sessionID).checkpoint;
    const marker = f.progress.read(f.runtime.sessionID);
    assert.equal(marker.attemptID, saved.attempt.id, 'the marker names the inline attempt the checkpoint settled');
    assert.equal(marker.callID, undefined, 'an inline attempt has no native call to name');
    assert.deepEqual(await f.restart(), { restored: true });
    const restored = f.status();
    assert.equal(restored.phase, 'mdd-verify'); assert.equal(restored.state, 'ready');
    await f.finish(report(structuredVerificationFixture()));
    assert.equal(f.status().state, 'complete');
  });
}

test('a risk report restated inline that selects the route survives restart', async t => {
  const f = await fixture(t);
  await f.finish(reportDocument({ evidenceSummary: SUMMARY_TEXT, artifact: ARTIFACT_TEXT }));
  await f.refuseThenRestate('nothing readable here', riskReport('low'));
  assert.equal(f.status().phase, 'mdd-plan'); assert.equal(f.status().state, 'ready');
  assert.deepEqual(await f.restart(), { restored: true });
  assert.equal(f.status().phase, 'mdd-plan'); assert.equal(f.status().state, 'ready');
});

test('a restated result that stops at an approval still restores, as it did before', async t => {
  const f = await fixture(t, { mode: 'interactive' });
  await throughRiskStop(f.runner, f.runtime.sessionID, 'low');
  await f.finish(report(structuredTraceFixture()));
  f.runner.approveNative(f.runtime.sessionID, 'mdd-apply');
  await f.refuseThenRestate(report({ changes: ['src/cli.ts'] }), report({ completed: [STEP], changes: ['src/cli.ts'] }));
  assert.equal(f.status().state, 'await-approval');
  assert.deepEqual(await f.restart(), { restored: true });
  assert.equal(f.status().state, 'await-approval');
});
