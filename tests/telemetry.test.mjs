import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { recordTelemetry, telemetryStatus, clearTelemetry, telemetryReport, RETENTION_MS } from '../dist/telemetry.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome } from './adapter-fixture.mjs';
import { installationPaths } from '../dist/installation-paths.js';

const now = 1800000000000;
function fixture(t) {
  isolateHome(t);
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-telemetry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  saveGlobalSettings(defaultSettings());
  return root;
}
const event = () => ({ timestamp: now, event: 'phase-end', phase: 'mdd-plan', duration: 12, route: 'low', outcome: 'passed' });
const log = root => join(root, '.mdd', 'telemetry.jsonl');
const rollupFile = root => join(root, '.mdd', 'telemetry-rollup.json');
const rollupOf = root => JSON.parse(fs.readFileSync(rollupFile(root), 'utf8'));
const runID = '9f1c2b3a-4d5e-4f60-8a1b-2c3d4e5f6071';
const usage = () => ({ input: 1200, output: 340, reasoning: 20, cacheRead: 90, cacheWrite: 10, cost: 0.0125, messages: 3 });

test('status and clear on absent telemetry do not create files; writes happen only on API use', t => {
  const root = fixture(t);
  assert.deepEqual(telemetryStatus(root, now), { ok: true, enabled: true, count: 0, retentionDays: 30 });
  assert.equal(clearTelemetry(root).ok, true);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.equal(recordTelemetry(root, event(), now).count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(log(root), 'utf8')), event());
  assert.deepEqual(fs.readdirSync(root), ['.mdd']);
  assert.deepEqual(fs.readdirSync(join(root, '.mdd')), ['.gitignore', 'telemetry-rollup.json', 'telemetry.jsonl']);
});

test('retention excludes exact 30-day boundary and prunes on append and status', t => {
  const root = fixture(t);
  const old = { ...event(), timestamp: now - RETENTION_MS };
  assert.equal(recordTelemetry(root, old, old.timestamp).ok, true);
  const recent = { ...event(), timestamp: now - RETENTION_MS + 1 };
  assert.equal(recordTelemetry(root, recent, recent.timestamp).count, 2);
  assert.equal(recordTelemetry(root, event(), now).count, 2);
  const rows = fs.readFileSync(log(root), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.timestamp), [recent.timestamp, now]);
  assert.equal(telemetryStatus(root, now + RETENTION_MS).count, 0);
  assert.equal(fs.existsSync(log(root)), false);
});

test('disable avoids writes and clear deletes even malformed or oversized regular logs', t => {
  const root = fixture(t);
  recordTelemetry(root, event(), now);
  const settings = defaultSettings();
  settings.telemetry.enabled = false;
  saveGlobalSettings(settings);
  const before = fs.readFileSync(log(root), 'utf8');
  assert.deepEqual(recordTelemetry(root, event(), now), { ok: true, enabled: false, count: 0, retentionDays: 30 });
  assert.equal(fs.readFileSync(log(root), 'utf8'), before);
  fs.writeFileSync(log(root), 'x'.repeat(1024 * 1024 + 1));
  assert.equal(clearTelemetry(root).ok, true);
  assert.equal(fs.existsSync(log(root)), false);
  assert.equal(recordTelemetry(root, event(), now).enabled, false);
  assert.equal(fs.existsSync(log(root)), false);
});

for (const [key, value] of Object.entries({ source: 'secret', prompt: 'secret', error: 'secret', path: 'secret', id: 'secret', credentials: 'secret', provider: 'secret', env: 'secret' })) {
  test(`telemetry rejects ${key} and returns no raw data`, t => {
    const root = fixture(t);
    assert.deepEqual(recordTelemetry(root, { ...event(), [key]: value }, now), { ok: false, diagnostic: 'invalid-event' });
    assert.deepEqual(fs.readdirSync(root), []);
  });
}

test('telemetry validates all allowlists, bounded integers, timestamp, and unknown settings', t => {
  const root = fixture(t);
  for (const change of [{ event: 'custom' }, { phase: 'orchestrator' }, { route: 'custom' }, { outcome: 'custom' },
    { duration: -1 }, { duration: 86400001 }, { duration: 0.1 }, { duration: Infinity },
    { timestamp: now + 1 }, { timestamp: now - RETENTION_MS }, { timestamp: NaN }, { timestamp: 'now' }]) {
    assert.deepEqual(recordTelemetry(root, { ...event(), ...change }, now), { ok: false, diagnostic: 'invalid-event' });
  }
  fs.writeFileSync(installationPaths().settingsPath, '{bad');
  assert.deepEqual(recordTelemetry(root, event(), now), { ok: false, diagnostic: 'telemetry-unavailable' });
  assert.equal(fs.existsSync(log(root)), false);
});

test('malformed log is not overwritten; errors never expose stored data', t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, '.mdd'));
  fs.writeFileSync(log(root), 'sensitive malformed contents');
  assert.deepEqual(recordTelemetry(root, event(), now), { ok: false, diagnostic: 'telemetry-unavailable' });
  assert.deepEqual(telemetryStatus(root, now), { ok: false, diagnostic: 'telemetry-unavailable' });
  assert.equal(fs.readFileSync(log(root), 'utf8'), 'sensitive malformed contents');
  assert.deepEqual(fs.readdirSync(join(root, '.mdd')), ['.gitignore', 'telemetry.jsonl']);
});

test('telemetry atomic failure preserves log bytes and emits bounded diagnostics', t => {
  const root = fixture(t);
  recordTelemetry(root, event(), now);
  const before = fs.readFileSync(log(root), 'utf8');
  const mock = t.mock.method(fs, 'renameSync', () => { throw new Error('secret path and raw error'); });
  assert.deepEqual(recordTelemetry(root, event(), now), { ok: false, diagnostic: 'telemetry-unavailable' });
  mock.mock.restore();
  assert.equal(fs.readFileSync(log(root), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(join(root, '.mdd')), ['.gitignore', 'telemetry-rollup.json', 'telemetry.jsonl']);
});

test('telemetry refuses symlinked directory and never writes/deletes external target', t => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.writeFileSync(join(outside, 'telemetry.jsonl'), 'protected');
  fs.symlinkSync(outside, join(root, '.mdd'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const result of [recordTelemetry(root, event(), now), telemetryStatus(root, now), clearTelemetry(root)]) {
    assert.deepEqual(result, { ok: false, diagnostic: 'telemetry-unavailable' });
  }
  assert.deepEqual(fs.readdirSync(outside), ['telemetry.jsonl']);
  assert.equal(fs.readFileSync(join(outside, 'telemetry.jsonl'), 'utf8'), 'protected');
});

test('local telemetry never calls the network', t => {
  const root = fixture(t);
  const network = t.mock.method(globalThis, 'fetch', () => { throw new Error('No network allowed'); });
  assert.equal(recordTelemetry(root, event(), now).ok, true);
  assert.equal(telemetryStatus(root, now).ok, true);
  assert.equal(telemetryReport(root, now).ok, true);
  assert.equal(clearTelemetry(root).ok, true);
  assert.equal(network.mock.callCount(), 0);
});

test('run identity, attempt, mode, failure and usage are recorded; free text cannot enter through them', t => {
  const root = fixture(t);
  const full = { ...event(), runID, attempt: 2, mode: 'inline', failure: 'result-rejected', usage: usage() };
  assert.equal(recordTelemetry(root, full, now).count, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(log(root), 'utf8')), full);
  for (const change of [{ runID: 'run-1' }, { runID: 'Implement the scoped feature' }, { runID: '' },
    { attempt: -1 }, { attempt: 1.5 }, { attempt: 1001 }, { mode: 'delegated' }, { failure: 'unknown' },
    { usage: { ...usage(), origin: 'secret' } }, { usage: { ...usage(), input: -1 } }, { usage: { ...usage(), cost: 'free' } },
    { usage: { ...usage(), partial: false } }, { usage: 'a lot' }]) {
    assert.deepEqual(recordTelemetry(root, { ...full, ...change }, now), { ok: false, diagnostic: 'invalid-event' });
  }
  assert.equal(fs.readFileSync(log(root), 'utf8').trim().split('\n').length, 1);
});

test('the rollup accumulates runs, attempts and usage, and outlives the events it came from', t => {
  const root = fixture(t);
  const base = { timestamp: now, runID, mode: 'delegate', route: 'low' };
  for (const row of [
    { ...base, event: 'preflight', outcome: 'passed' },
    { ...base, event: 'phase-start', phase: 'mdd-plan', attempt: 1 },
    { ...base, event: 'phase-end', phase: 'mdd-plan', attempt: 1, outcome: 'blocked', failure: 'result-rejected', duration: 500 },
    { ...base, event: 'retry', phase: 'mdd-plan', attempt: 1, failure: 'result-rejected' },
    { ...base, event: 'phase-start', phase: 'mdd-plan', attempt: 2 },
    { ...base, event: 'phase-end', phase: 'mdd-plan', attempt: 2, outcome: 'passed', duration: 1000, usage: usage() },
    { ...base, event: 'report', outcome: 'passed' },
  ]) assert.equal(recordTelemetry(root, row, now).ok, true, row.event);
  const rollup = rollupOf(root);
  assert.equal(rollup.version, 1);
  assert.equal(rollup.events, 7);
  assert.deepEqual(rollup.runs, { started: 1, completed: 1, blocked: 0, reset: 0 });
  assert.deepEqual(rollup.routes, { low: 1, high: 0 });
  // The retry repeats the class of the attempt it follows and must not be counted as a second one.
  assert.equal(rollup.failures['result-rejected'], 1);
  assert.deepEqual(rollup.phases['mdd-plan'], { starts: 2, passed: 1, failed: 0, blocked: 1, retries: 1, handovers: 0,
    duration: 1500, timed: 2, input: 1200, output: 340, reasoning: 20, cacheRead: 90, cacheWrite: 10, cost: 0.0125, measured: 1, partial: 0 });
  // Events expire; what MDD learned from them does not.
  const later = now + RETENTION_MS;
  assert.equal(telemetryStatus(root, later).count, 0);
  assert.equal(fs.existsSync(log(root)), false);
  const report = telemetryReport(root, later);
  assert.match(report.text, /Runs: 1 started, 1 completed/);
  assert.match(report.text, /0 still inside the 30-day event window/);
  assert.match(report.text, /result-rejected 1/);
  assert.deepEqual(rollupOf(root).phases['mdd-plan'].input, 1200);
});

test('clearing telemetry deletes the rollup with the events it summarizes', t => {
  const root = fixture(t);
  recordTelemetry(root, { ...event(), runID }, now);
  assert.equal(fs.existsSync(rollupFile(root)), true);
  assert.equal(clearTelemetry(root).ok, true);
  assert.deepEqual(fs.readdirSync(join(root, '.mdd')), ['.gitignore']);
  assert.match(telemetryReport(root, now).text, /No runs have been recorded yet/);
});

test('a damaged rollup is reported instead of overwritten, and the event is still recorded', t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, '.mdd'));
  fs.writeFileSync(rollupFile(root), '{ damaged and not this module\u2019s output');
  const result = recordTelemetry(root, event(), now);
  assert.deepEqual(result, { ok: true, enabled: true, count: 1, retentionDays: 30, rollup: 'unavailable' });
  assert.equal(fs.readFileSync(rollupFile(root), 'utf8'), '{ damaged and not this module\u2019s output');
  assert.deepEqual(JSON.parse(fs.readFileSync(log(root), 'utf8')), event());
  assert.deepEqual(telemetryReport(root, now), { ok: false, diagnostic: 'telemetry-unavailable' });
});

test('the report reads the local ledger only, and says so when telemetry is off', t => {
  const root = fixture(t);
  assert.match(telemetryReport(root, now).text, /No runs have been recorded yet/);
  recordTelemetry(root, { ...event(), runID, usage: usage() }, now);
  const text = telemetryReport(root, now).text;
  assert.match(text, /local only, never exported/);
  assert.match(text, /^plan\s+0\s+1\s+0\s+0\s+0\s+0s\s+1\.2k\s+340\s+100\s+0\.0125$/m);
  assert.match(text, /Usage measured for 1 of 0 phase run\(s\)/);
  // A log written before this workspace kept totals is still evidence, and reading it must not
  // rebuild anything: the report is the one command that only ever reads.
  fs.rmSync(rollupFile(root));
  assert.match(telemetryReport(root, now).text, /No totals have been kept in this workspace yet, and 1 event\(s\)/);
  assert.equal(fs.existsSync(rollupFile(root)), false);
  const settings = defaultSettings();
  settings.telemetry.enabled = false;
  saveGlobalSettings(settings);
  assert.match(telemetryReport(root, now).text, /Telemetry is currently off/);
});

test('row bounds prune oldest insertion and oversized storage fails without overwrite', t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, '.mdd'));
  const rows = Array.from({ length: 5000 }, (_, index) => JSON.stringify({ timestamp: now - 5000 + index, event: 'preflight' }));
  fs.writeFileSync(log(root), rows.join('\n') + '\n');
  assert.equal(recordTelemetry(root, event(), now).count, 5000);
  const retained = fs.readFileSync(log(root), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(retained[0].timestamp, now - 4999);
  assert.deepEqual(retained.at(-1), event());
  const oversized = 'x'.repeat(1024 * 1024 + 1);
  fs.writeFileSync(log(root), oversized);
  assert.deepEqual(recordTelemetry(root, event(), now), { ok: false, diagnostic: 'telemetry-unavailable' });
  assert.equal(fs.readFileSync(log(root), 'utf8'), oversized);
});

test('hardlinked telemetry and competing locks cannot overwrite external or owned bytes', t => {
  const root = fixture(t);
  const outside = fixture(t);
  fs.mkdirSync(join(root, '.mdd'));
  const target = join(outside, 'protected');
  fs.writeFileSync(target, JSON.stringify(event()) + '\n');
  fs.linkSync(target, log(root));
  assert.deepEqual(recordTelemetry(root, event(), now), { ok: false, diagnostic: 'telemetry-unavailable' });
  assert.deepEqual(clearTelemetry(root), { ok: false, diagnostic: 'telemetry-unavailable' });
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(event()) + '\n');
  fs.unlinkSync(log(root));
  fs.writeFileSync(log(root) + '.lock', 'other writer');
  assert.deepEqual(recordTelemetry(root, event(), now), { ok: false, diagnostic: 'telemetry-unavailable' });
  assert.equal(fs.readFileSync(log(root) + '.lock', 'utf8'), 'other writer');
  assert.equal(fs.existsSync(log(root)), false);
});

test('global telemetry preference with injected XDG keeps events and clear local to each workspace', t => {
  const a = fixture(t), b = fixture(t), home = fixture(t);
  const environment = { home, env: { XDG_CONFIG_HOME: home } };
  fs.writeFileSync(join(a, 'mdd.config.json'), '{invalid legacy settings');
  const before = fs.readFileSync(join(a, 'mdd.config.json'));
  assert.equal(recordTelemetry(a, event(), now, environment).count, 1);
  assert.equal(recordTelemetry(b, event(), now, environment).count, 1);
  const settings = defaultSettings(); settings.telemetry.enabled = false;
  saveGlobalSettings(settings, environment);
  for (const root of [a, b]) assert.equal(recordTelemetry(root, event(), now, environment).enabled, false);
  assert.equal(clearTelemetry(a, environment).count, 0);
  assert.equal(telemetryStatus(b, now, environment).count, 1);
  assert.equal(fs.existsSync(log(a)), false);
  assert.equal(fs.readFileSync(join(a, '.mdd/.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(fs.readFileSync(join(a, 'mdd.config.json')), before);
  assert.equal(fs.existsSync(join(home, 'opencode/mdd/.mdd')), false);
});
