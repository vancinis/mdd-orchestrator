import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { doctor } from '../dist/doctor.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome } from './helpers.mjs';

test('doctor reports the active profile and preferences without probing anything', async t => {
  isolateHome(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('doctor must not contact any service'));
  const settings = defaultSettings();
  settings.profiles.default.answers = { mode: 'interactive' };
  saveGlobalSettings(settings);
  const result = await doctor(process.cwd());
  const check = result.checks.find(item => item.check === 'settings');
  assert.equal(check.status, 'ok');
  assert.match(check.message, /default/);
  assert.match(check.message, /interactive/);
  assert.equal(result.ready, false, 'nothing is installed in the isolated home');
});

test('doctor names an invalid configuration instead of failing', async t => {
  const home = isolateHome(t);
  mkdirSync(join(home, 'opencode', 'mdd'), { recursive: true });
  writeFileSync(join(home, 'opencode', 'mdd', 'mdd.config.json'), '{"version":2}');
  const result = await doctor(process.cwd());
  const check = result.checks.find(item => item.check === 'settings');
  assert.equal(check.status, 'action');
  assert.match(check.message, /version must be 1/);
});
