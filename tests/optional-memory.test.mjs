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

for (const fault of ['conflict', 'ended', 'incomplete', 'ambiguous', 'project-root', 'health', 'race', 'ended-race', 'unknown-missing']) {
}

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-managed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/**
 * A repository with a linked worktree, written as git lays it out on disk: the worktree's `.git`
 * is a file pointing at the administrative directory, which names the shared git directory.
 */
function repository(t) {
  const root = temporary(t);
  const main = join(root, 'MainRepo');
  const administrative = join(main, '.git', 'worktrees', 'linked');
  mkdirSync(administrative, { recursive: true });
  writeFileSync(join(administrative, 'commondir'), '../..\n');
  const worktree = join(root, 'linked');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), `gitdir: ${administrative.replaceAll('\\', '/')}\n`);
  const stranger = join(root, 'OtherRepo');
  mkdirSync(join(stranger, '.git'), { recursive: true });
  mkdirSync(join(root, 'unrelated'));
  mkdirSync(join(main, 'packages', 'api'), { recursive: true });
  return { root, main, worktree, stranger };
}

function boundProject(t, { directory, projectPath, sessionDirectory }) {
  const binding = { id: 'ses_parent', project: '', directory };
  t.mock.method(globalThis, 'fetch', async address => {
    const url = new URL(address);
    const data = url.pathname === '/health' ? { service: 'engram', status: 'ok' }
      : url.pathname === '/project/current'
        ? { project: 'mainrepo', cwd: url.searchParams.get('cwd'), project_path: projectPath, available_projects: null, project_source: 'git_root' }
        : { id: binding.id, project: 'mainrepo', directory: sessionDirectory ?? directory, ownership_mode: 'shared' };
    return new Response(JSON.stringify(data), { status: 200 });
  });
  return new EngramHttp('http://127.0.0.1:43210', binding);
}

// Engram resolves a project at its repository root, so a linked worktree and a subdirectory are
// ordinary native roots that belong to it. Requiring an identical path blocked both of them.
for (const place of ['project root', 'subdirectory', 'linked worktree']) {
  test(`opted-in bootstrap binds a native root that is the ${place} of the resolved project`, async t => {
    const { main, worktree } = repository(t);
    const directory = place === 'subdirectory' ? join(main, 'packages', 'api') : place === 'linked worktree' ? worktree : main;
    const client = boundProject(t, { directory, projectPath: main });
    await client.bootstrap();
    assert.equal(client.project, 'mainrepo');
  });
}

for (const [name, select] of Object.entries({
  'an unrelated sibling directory': ({ root, main }) => ({ directory: join(root, 'unrelated'), projectPath: main }),
  'a project root below the native root': ({ main }) => ({ directory: main, projectPath: join(main, 'packages') }),
  'a worktree of another repository': ({ worktree, stranger }) => ({ directory: worktree, projectPath: stranger }),
  'a project root on no shared path at all': ({ root, worktree }) => ({ directory: worktree, projectPath: join(root, 'absent') }),
})) {
  test(`opted-in bootstrap still refuses ${name}`, async t => {
    const client = boundProject(t, select(repository(t)));
    await assert.rejects(client.bootstrap(), /not part of the resolved project/);
  });
}

// Engram lowercases the directory it stores, so comparing the exact strings rejected the session
// MDD had just registered. Path identity is compared the way the platform actually defines it.
test('opted-in bootstrap accepts the platform path identity of the session Engram stored', async t => {
  const { main } = repository(t);
  const client = boundProject(t, { directory: main, projectPath: main, sessionDirectory: main.toLowerCase() });
  if (process.platform === 'win32') await client.bootstrap();
  else await assert.rejects(client.bootstrap(), /binding mismatch/);
});

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
