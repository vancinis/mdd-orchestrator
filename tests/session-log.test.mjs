import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { recordSession, readSessions, MAX_SESSIONS } from '../dist/session-log.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome } from './adapter-fixture.mjs';

function fixture(t, { telemetry = true } = {}) {
  isolateHome(t);
  const settings = defaultSettings();
  settings.telemetry.enabled = telemetry;
  saveGlobalSettings(settings);
  const root = mkdtempSync(join(tmpdir(), 'mdd-session-log-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const entry = (sessionID, root) => ({ sessionID, agent: 'mdd-orchestrator', directory: root, worktree: root });
const file = root => join(root, '.mdd', 'sessions.jsonl');

test('session log: the first coordinator call makes the conversation countable', t => {
  const root = fixture(t);
  const result = recordSession(root, entry('ses_one', root), 1000);
  assert.deepEqual(result, { ok: true, enabled: true, recorded: true, count: 1 });
  const [record] = readSessions(root);
  assert.equal(record.sessionID, 'ses_one');
  assert.equal(record.agent, 'mdd-orchestrator');
  assert.equal(record.started, 1000);
  // The ledger directory is never committed by accident, whoever creates it first.
  assert.equal(fs.readFileSync(join(root, '.mdd', '.gitignore'), 'utf8'), '*\n');
});

test('session log: the same conversation is recorded once, keeping its first timestamp', t => {
  const root = fixture(t);
  recordSession(root, entry('ses_one', root), 1000);
  const again = recordSession(root, entry('ses_one', root), 5000);
  assert.deepEqual(again, { ok: true, enabled: true, recorded: false, count: 1 });
  assert.equal(readSessions(root)[0].started, 1000);
  recordSession(root, entry('ses_two', root), 6000);
  assert.deepEqual(readSessions(root).map(item => item.sessionID), ['ses_one', 'ses_two']);
});

// The user's telemetry preference governs every local record MDD keeps, this one included.
test('session log: telemetry off writes nothing at all', t => {
  const root = fixture(t, { telemetry: false });
  assert.deepEqual(recordSession(root, entry('ses_one', root), 1000), { ok: true, enabled: false, recorded: false, count: 0 });
  assert.equal(fs.existsSync(file(root)), false);
  assert.deepEqual(readSessions(root), []);
});

test('session log: an unusable identity is refused instead of written', t => {
  const root = fixture(t);
  for (const bad of [{}, { ...entry('', root) }, { ...entry('ses\nx', root) }, { ...entry('x'.repeat(300), root) }]) {
    assert.deepEqual(recordSession(root, bad, 1000), { ok: false, diagnostic: 'invalid-session' });
  }
  assert.deepEqual(recordSession(root, entry('ses_one', root), -1), { ok: false, diagnostic: 'invalid-session' });
  assert.equal(fs.existsSync(file(root)), false);
});

// One bad row must not stop a workspace from ever recording anything again.
test('session log: a damaged line is dropped, never repaired and never fatal', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.mdd'), { recursive: true });
  writeFileSync(file(root), 'not json\n{"version":1}\n');
  assert.equal(recordSession(root, entry('ses_one', root), 1000).recorded, true);
  assert.deepEqual(readSessions(root).map(item => item.sessionID), ['ses_one']);
});

test('session log: the file is bounded, oldest first', t => {
  const root = fixture(t);
  for (let i = 0; i < MAX_SESSIONS + 5; i++) recordSession(root, entry(`ses_${i}`, root), 1000 + i);
  const records = readSessions(root);
  assert.equal(records.length, MAX_SESSIONS);
  assert.equal(records[0].sessionID, 'ses_5');
  assert.equal(records.at(-1).sessionID, `ses_${MAX_SESSIONS + 4}`);
});

test('session log: an unwritable workspace degrades without throwing', t => {
  const root = fixture(t);
  mkdirSync(join(root, '.mdd'), { recursive: true });
  // A directory where the file belongs is unwritable in exactly the way a hostile checkout is.
  mkdirSync(file(root), { recursive: true });
  assert.deepEqual(recordSession(root, entry('ses_one', root), 1000), { ok: false, diagnostic: 'session-log-unavailable' });
  assert.deepEqual(readSessions(root), []);
});
