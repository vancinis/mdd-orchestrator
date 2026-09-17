import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EngramHttp } from '../dist/engram-http.js';
import { ManagedMemory } from '../dist/managed-memory.js';
import { NativeIntake } from '../dist/native-intake.js';
import { defaultSettings, parseSettings } from '../dist/settings.js';
import { answers, runtime } from './adapter-fixture.mjs';

function transport(t, fault = '') {
  const binding = { id: runtime.sessionID, project: 'fixture', directory: runtime.directory };
  let session = ['existing', 'conflict', 'ended', 'incomplete'].includes(fault) ? { ...binding } : undefined;
  if (fault === 'conflict') session.project = 'other';
  if (fault === 'ended') session.ended_at = 'yesterday';
  if (fault === 'incomplete') delete session.directory;
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    calls.push([options.method, path]);
    let data;
    let status = 200;
    if (path === '/health') data = fault === 'health' ? {} : { service: 'engram', status: 'ok', version: '0.1.0' };
    else if (path === '/project/current') {
      assert.equal(new URL(url).searchParams.get('cwd'), binding.directory);
      data = { project: binding.project, project_path: binding.directory, cwd: binding.directory, available_projects: [] };
      if (fault === 'ambiguous') { data.error_hint = 'ambiguous'; data.available_projects = ['a', 'b']; }
      if (fault === 'project-root') data.project_path = join(binding.directory, 'child');
      if (fault === 'project-name') data.project = 'other';
    } else if (path === '/sessions') {
      assert.deepEqual(JSON.parse(options.body), binding);
      session = { ...binding, ended_at: null };
      if (fault === 'race') session.project = 'other';
      if (fault === 'ended-race') session.ended_at = 'just-ended';
      if (fault === 'unknown-missing') session = undefined;
      if (fault.startsWith('unknown')) throw new Error('Unknown POST transport outcome');
      data = { id: binding.id, status: 'created' }; status = 201;
    } else if (path === `/sessions/${binding.id}`) { data = session ?? { error: 'session not found' }; status = session ? 200 : 404; }
    else assert.fail(`Unexpected request ${path}`);
    return new Response(JSON.stringify(data), { status });
  });
  return { client: new EngramHttp('http://127.0.0.1:43210', binding), calls };
}

test('unknown missing registration never gets a second create on the same client', async t => {
  const { client, calls } = transport(t, 'unknown-missing');
  await assert.rejects(client.bootstrap());
  await assert.rejects(client.bootstrap(), /no second POST/);
  assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
});

for (const fault of ['', 'existing', 'unknown-success']) test(`opted-in bootstrap exact native registration: ${fault || 'new'}`, async t => {
  const { client, calls } = transport(t, fault);
  await client.bootstrap();
  assert.equal(calls.filter(([method]) => method === 'POST').length, fault === 'existing' ? 0 : 1);
  assert.equal(calls.filter(([, path]) => path.startsWith('/sessions/')).length, fault === 'existing' ? 1 : 2);
  assert.equal(calls.at(-1)[0], 'GET');
});
for (const fault of ['conflict', 'ended', 'incomplete', 'ambiguous', 'project-root', 'project-name', 'health', 'race', 'ended-race', 'unknown-missing']) {
  test(`opted-in bootstrap rejects ${fault} without rebinding or retry`, async t => {
    const { client, calls } = transport(t, fault);
    await assert.rejects(client.bootstrap());
    assert.equal(calls.filter(([method]) => method === 'POST').length, ['race', 'ended-race', 'unknown-missing'].includes(fault) ? 1 : 0);
  });
}

for (const store of ['engram', 'both']) test(`off profile transition reasks only incompatible ${store} plus missing fields`, async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Off fetched'));
  const settings = defaultSettings();
  settings.profiles.default.answers = { ...answers, artifactStore: store };
  delete settings.profiles.default.answers.summary;
  const original = structuredClone(settings);
  const gate = new NativeIntake({ status: () => ({ state: 'not-started' }) }, { intake: async () => 'actual-user' }, settings);
  const status = await gate.start({ requirements: 'User request' }, runtime, 'actual-message');
  assert.equal(status.memory, 'off');
  assert.match(status.notice, /requires optional Engram.*profile is unchanged/);
  assert.deepEqual(status.question.questions.map(q => q.header), ['Artifacts', 'Summary']);
  assert.deepEqual(status.question.questions[0].options.map(q => q.label), ['OpenSpec', 'None']);
  assert.deepEqual(settings, original);
});

test('explicit legacy endpoint failure stays enabled and blocks without fallback', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unavailable'); });
  const settings = defaultSettings(); settings.engram = { endpoint: 'http://127.0.0.1:43210', project: 'fixture' };
  const gate = new NativeIntake({ status: () => ({ state: 'not-started' }), block() {} }, { intake: async () => 'actual-user' }, settings);
  await assert.rejects(gate.start({ requirements: 'User request' }, runtime, 'actual-message'), /Unavailable/);
  assert.equal(gate.status(runtime.sessionID).memory, 'enabled');
  assert.equal(gate.status(runtime.sessionID).state, 'blocked');
  assert.deepEqual(parseSettings(settings).engram, settings.engram);
});

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-managed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('managed local variant roundtrips without changing version-1 legacy settings', t => {
  const root = temporary(t);
  const settings = defaultSettings(); settings.engram = { mode: 'local', binary: process.execPath, dataDirectory: join(root, 'memory') };
  assert.deepEqual(parseSettings(settings), settings);
  for (const value of [{ ...settings.engram, endpoint: 'http://127.0.0.1:43210' }, { ...settings.engram, binary: 'engram' }, { ...settings.engram, dataDirectory: 'relative' }]) {
    assert.throws(() => parseSettings({ ...settings, engram: value }));
  }
});

test('managed service is lazy, reuses only owned process, sanitizes env and closes once', async t => {
  const root = temporary(t); const dataDirectory = join(root, 'memory');
  let spawns = 0; let kills = 0;
  const child = new EventEmitter(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
  child.kill = () => { kills++; child.signalCode = 'SIGTERM'; queueMicrotask(() => child.emit('exit')); return true; };
  const service = new ManagedMemory({ mode: 'local', binary: process.execPath, dataDirectory }, {
    port: async () => 43210,
    spawn(binary, args, options) {
      spawns++;
      assert.equal(binary, process.execPath); assert.deepEqual(args, ['serve', '43210']);
      assert.equal(options.env.ENGRAM_CLOUD_AUTOSYNC, '0');
      assert.equal(options.env.HOME, dataDirectory);
      assert.equal(options.env.ENGRAM_CLOUD_TOKEN, undefined);
      assert.equal(options.env.ENGRAM_HTTP_TOKEN, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(readFileSync(join(dataDirectory, 'engram.db')).length, 0);
      queueMicrotask(() => child.stderr.write('[engram] HTTP server listening on 127.0.0.1:43210\n'));
      return child;
    },
  });
  assert.equal(existsSync(dataDirectory), false);
  assert.equal(spawns, 0);
  const [a, b] = await Promise.all([service.endpoint(), service.endpoint()]);
  assert.equal(a, b); assert.equal(spawns, 1);
  await service.close(); await service.close(); assert.equal(kills, 1);
  await assert.rejects(service.endpoint(), /closed/);
});

test('managed service never accepts an unrelated listener when its process exits', async t => {
  const root = temporary(t); let kills = 0;
  const child = new EventEmitter(); child.stderr = new PassThrough(); child.exitCode = null; child.signalCode = null;
  child.kill = () => { kills++; return true; };
  t.mock.method(globalThis, 'fetch', () => assert.fail('Must not probe an unrelated listener'));
  const service = new ManagedMemory({ mode: 'local', binary: process.execPath, dataDirectory: join(root, 'memory') }, {
    port: async () => 43210, spawn() { queueMicrotask(() => { child.exitCode = 1; child.emit('exit'); }); return child; },
  });
  await assert.rejects(service.endpoint(), /exited/);
  assert.equal(kills, 0);
});

for (const mode of ['endpoint', 'legacy', 'managed']) test(`global ${mode} memory resolves two roots and binds distinct actual parents`, async t => {
  const root = temporary(t), a = join(root, 'a'), b = join(root, 'b');
  mkdirSync(a); mkdirSync(b);
  const sessions = new Map(), calls = [];
  t.mock.method(globalThis, 'fetch', async (address, options) => {
    const url = new URL(address); calls.push(url.pathname);
    let data, status = 200;
    if (url.pathname === '/health') data = { service: 'engram', status: 'ok' };
    else if (url.pathname === '/project/current') {
      const cwd = url.searchParams.get('cwd'); assert.ok([a, b].includes(cwd));
      data = { cwd, project_path: cwd, project: cwd === a ? 'resolved-a' : 'resolved-b' };
    } else if (url.pathname === '/sessions') {
      data = JSON.parse(options.body); sessions.set(data.id, data); status = 201;
    } else if (url.pathname.startsWith('/sessions/')) {
      data = sessions.get(url.pathname.slice('/sessions/'.length));
      if (!data) { status = 404; data = { error: 'session not found' }; }
    } else assert.fail('Unexpected memory operation');
    return new Response(JSON.stringify(data), { status });
  });
  let endpoints = 0;
  if (mode === 'managed') t.mock.method(ManagedMemory.prototype, 'endpoint', async () => { endpoints++; return 'http://127.0.0.1:43210'; });
  const settings = defaultSettings();
  settings.engram = mode === 'managed' ? { mode: 'local', binary: process.execPath, dataDirectory: join(root, 'memory') }
    : { endpoint: 'http://127.0.0.1:43210', ...(mode === 'legacy' ? { project: 'resolved-a' } : {}) };
  const original = structuredClone(settings);
  for (const [directory, sessionID] of [[a, 'actual-parent-a'], [b, 'actual-parent-b']]) {
    const gate = new NativeIntake({ status: () => ({ state: 'not-started' }) }, { intake: async () => 'actual-user' }, settings);
    const result = await gate.start({ requirements: 'Actual request' }, { ...runtime, directory, worktree: directory, sessionID }, 'actual-message');
    if (mode === 'legacy') assert.match(result.notice, /deprecated.*ignored/);
    await gate.close();
  }
  assert.deepEqual([...sessions.values()], [
    { id: 'actual-parent-a', project: 'resolved-a', directory: a },
    { id: 'actual-parent-b', project: 'resolved-b', directory: b },
  ]);
  assert.equal(endpoints, mode === 'managed' ? 2 : 0);
  assert.deepEqual(settings, original);
  assert.equal(calls.filter(path => path === '/sessions').length, 2);
});

test('isolated installed Engram managed smoke: bootstrap, reuse, readback, owned shutdown', { skip: !process.env.MDD_SMOKE_ENGRAM }, async t => {
  const root = mkdtempSync(join(process.platform === 'win32' ? join(tmpdir(), 'opencode') : tmpdir(), 'mdd-managed-smoke-'));
  mkdirSync(join(root, '.engram'));
  writeFileSync(join(root, '.engram/config.json'), JSON.stringify({ project_name: 'mdd-isolated-managed-smoke' }));
  const service = new ManagedMemory({ mode: 'local', binary: process.env.MDD_SMOKE_ENGRAM, dataDirectory: join(root, '.mdd/memory') });
  t.after(async () => { await service.close(); rmSync(root, { recursive: true, force: true }); });
  const endpoint = await service.endpoint();
  const client = new EngramHttp(endpoint, { id: 'isolated-native-contract-parent', project: '', directory: root });
  await client.bootstrap();
  assert.equal(client.project, 'mdd-isolated-managed-smoke');
  assert.ok(await client.save('Isolated managed smoke', 'Model-free transport verification only.') > 0);
  assert.equal(await service.endpoint(), endpoint);
  await client.bootstrap();
  await service.close();
  await assert.rejects(fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(1000) }));
});
