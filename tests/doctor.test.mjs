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

test('doctor adds one offline informational integrations check and never starts a subprocess or network call', async t => {
  const home = isolateHome(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('doctor must not contact any service'));
  const trap = { fetch: () => assert.fail('network is forbidden'), run: () => assert.fail('subprocess is forbidden') };
  const read = async () => (await doctor(process.cwd(), trap)).checks.filter(item => item.check === 'integrations');
  const absent = await read();
  assert.equal(absent.length, 1);
  assert.equal(absent[0].status, 'info');
  assert.match(absent[0].message, /Integraciones opcionales: context7 absent; engram \w+; codegraph \w+/);
  // Broken and conflicting global configuration remains informational.
  mkdirSync(join(home, 'opencode'), { recursive: true });
  for (const text of ['{ broken', JSON.stringify({ mcp: { servers: { engram: { type: 'local', command: ['x'] } } } })]) {
    writeFileSync(join(home, 'opencode', 'opencode.json'), text);
    const [check] = await read();
    assert.equal(check.status, 'info');
    assert.match(check.message, /Integraciones opcionales/);
  }
  const result = await doctor(process.cwd(), trap);
  assert.ok(result.checks.every(item => item.check === 'integrations' ? item.status === 'info' : true));
  assert.equal(result.ready, false, 'readiness is decided by the core checks alone');
  assert.equal(result.checks.at(-1).check, 'integrations');
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
