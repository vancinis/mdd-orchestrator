import assert from 'node:assert/strict';
import { test } from 'node:test';
import { doctor } from '../dist/doctor.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome } from './adapter-fixture.mjs';

for (const configured of [false, true]) test(`PF-3: doctor explains automatic storage without selecting it (configured=${configured})`, async t => {
  isolateHome(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('Non-probing doctor must not activate memory'));
  const settings = defaultSettings();
  settings.profiles.default.answers = { artifactStore: 'both' };
  if (configured) settings.engram = { endpoint: 'http://127.0.0.1:43210' };
  saveGlobalSettings(settings);
  const result = await doctor(process.cwd(), false);
  assert.match(result.checks.find(check => check.check === 'profile').message, /3 campo/);
  const storage = result.checks.find(check => check.check === 'storage');
  assert.ok(storage);
  assert.match(storage.message, configured ? /Engram.*vínculo.*sin respaldo local/ : /local.*\.mdd[\\/]tasks/);
  assert.equal(result.checks.some(check => check.check === 'artifact-choice'), false);
});
