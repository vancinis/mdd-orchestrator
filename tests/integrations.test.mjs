import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { parse } from 'jsonc-parser';
import { join } from 'node:path';
import { CATALOG, catalogRelease, defaultRun, integrationPaths, readManifest } from '../dist/integration-install.js';
import { installationPaths } from '../dist/installation-paths.js';
import {
  apply, checkInitTarget, doctorSummary, initCodeGraph, inspect, lookupOffer, parseMcpList, probe, reviewOf,
} from '../dist/integrations.js';

const PLATFORM = 'win32-x64';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tool = (snapshot, id) => snapshot.tools.find(t => t.id === id);
const offer = (snapshot, id, kind) => tool(snapshot, id).offers.find(o => o.kind === kind);

function catalogFor(version, archives, format = {}) {
  const catalog = structuredClone(CATALOG);
  for (const id of ['engram', 'codegraph']) {
    catalog[id].version = version;
    if (format[id]) catalog[id].format = format[id];
    for (const key of Object.keys(catalog[id].assets)) {
      catalog[id].assets[key] = { asset: `${id}-${key}.zip`, size: archives[id].length, sha256: sha(archives[id]) };
    }
  }
  return catalog;
}

/** Isolated world: config root, project directory, fake archives, fake fetch/extract/run. */
function world(t, { version = '1.2.3', format, path = [], files = {} } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'mdd-integrations-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home'), config = join(base, 'config'), project = join(base, 'project'), bin = join(base, 'bin');
  for (const dir of [home, config, project, bin]) fs.mkdirSync(dir, { recursive: true });
  for (const name of path) fs.writeFileSync(join(bin, name), 'native');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(join(config, 'opencode', name), content);
  return { base, home, config, project, bin, configFile: join(config, 'opencode', 'opencode.json'), version, format, path };
}

function engine(w, { version = w.version, format = w.format, runResult, onFetch, fail } = {}) {
  const archives = { engram: Buffer.from(`engram-${version}`), codegraph: Buffer.from(`codegraph-${version}`) };
  const catalog = catalogFor(version, archives, format);
  const calls = { fetch: [], run: [], extract: 0 };
  const layout = {
    engram: { 'engram.exe': `ENGRAM-${version}` },
    codegraph: { 'codegraph-win32-x64/node.exe': `NODE-${version}`, 'codegraph-win32-x64/lib/dist/bin/codegraph.js': `JS-${version}` },
  };
  const deps = {
    catalog, platform: 'win32', arch: 'x64', cwd: w.project,
    env: { XDG_CONFIG_HOME: w.config, HOME: w.home, USERPROFILE: w.home, PATH: w.bin, SystemRoot: 'C:\\Windows' },
    id: (() => { let n = 0; return () => `stage${version.replace(/\W/g, '')}${++n}`; })(),
    now: () => new Date('2026-11-14T12:00:00Z'),
    fetch: async (url) => {
      calls.fetch.push(url);
      onFetch?.(url);
      if (fail === 'fetch') return new Response('nope', { status: 404 });
      for (const id of ['engram', 'codegraph']) if (url === catalogRelease(id, PLATFORM, { catalog }).url) return new Response(archives[id]);
      return new Response('missing', { status: 404 });
    },
    extract: (archive, dest) => {
      calls.extract++;
      const id = fs.readFileSync(archive).equals(archives.engram) ? 'engram' : 'codegraph';
      for (const [rel, content] of Object.entries(layout[id])) {
        fs.mkdirSync(join(dest, ...rel.split('/').slice(0, -1)), { recursive: true });
        fs.writeFileSync(join(dest, ...rel.split('/')), content);
      }
    },
    run: (file, args, options) => {
      calls.run.push({ file, args, options });
      if (runResult) return runResult(file, args, options);
      return { status: 0, stdout: file.toLowerCase().includes('engram') ? `engram ${version}\n` : `${version}\n`, stderr: '' };
    },
  };
  return { deps, calls, catalog };
}

const readConfig = w => fs.readFileSync(w.configFile, 'utf8');
const parseServers = w => parse(readConfig(w)).mcp.servers;
const configPaths = w => integrationPaths(installationPaths({ home: w.home, env: { XDG_CONFIG_HOME: w.config } }));

function seedConfig(w, text) {
  fs.mkdirSync(join(w.config, 'opencode'), { recursive: true });
  fs.writeFileSync(w.configFile, text);
}

test('inspect is read-only: absent state, reviewable offers, Context7 remote without update, no subprocess or network', t => {
  const w = world(t);
  const e = engine(w);
  const snapshot = inspect(e.deps);
  assert.deepEqual(snapshot.tools.map(x => [x.id, x.state]), [['context7', 'absent'], ['engram', 'absent'], ['codegraph', 'absent']]);
  assert.deepEqual(tool(snapshot, 'context7').offers.map(o => o.kind), ['configure']);
  assert.deepEqual(tool(snapshot, 'engram').offers.map(o => o.kind), ['install']);
  assert.deepEqual(tool(snapshot, 'codegraph').offers.map(o => o.kind), ['install']);
  assert.equal(tool(snapshot, 'context7').installed.detail, 'servicio remoto · sin versión local');
  for (const x of snapshot.tools) {
    assert.equal(x.connected.value, 'not-tested');
    assert.notEqual(x.usable.value, 'yes');
  }
  assert.equal(tool(snapshot, 'codegraph').usable.value, 'no');
  assert.equal(snapshot.platform, PLATFORM);
  assert.deepEqual(e.calls.fetch, []);
  assert.deepEqual(e.calls.run, []);
  assert.equal(fs.existsSync(join(w.config, 'opencode')), false, 'inspect must not create the config root');
});

test('install order, registrations, provenance and replay: Context7, Engram, CodeGraph in reviewed dependency order', async t => {
  const w = world(t);
  fs.mkdirSync(join(w.home, '.engram'), { recursive: true });
  fs.writeFileSync(join(w.home, '.engram', 'engram.db'), 'MEMORY');
  fs.mkdirSync(join(w.project, '.codegraph'));
  fs.writeFileSync(join(w.project, '.codegraph', 'codegraph.db'), 'INDEX');
  seedConfig(w, '// my comments\n{\n  "theme": "dark", // keep\n  "mcp": { "servers": {} }\n}\n');
  const e = engine(w);
  const snapshot = inspect(e.deps);
  assert.equal(tool(snapshot, 'codegraph').usable.value, 'unknown', 'file presence does not prove index usability');
  assert.match(tool(snapshot, 'codegraph').usable.detail, /no abierto/);

  const actions = [offer(snapshot, 'codegraph', 'install'), offer(snapshot, 'engram', 'install'), offer(snapshot, 'context7', 'configure')];
  const report = await apply(actions, e.deps);
  assert.deepEqual(report.results.map(r => [r.tool, r.outcome]), [['context7', 'completed'], ['engram', 'completed'], ['codegraph', 'completed']]);
  assert.equal(report.restartNote, undefined, 'new registrations reload without a service restart');
  assert.ok(report.results.every(r => !r.restart));

  const text = readConfig(w);
  assert.match(text, /\/\/ my comments/);
  assert.match(text, /"theme": "dark", \/\/ keep/);
  const servers = parseServers(w);
  assert.deepEqual(servers.context7, { type: 'remote', url: 'https://mcp.context7.com/mcp' });
  const paths = configPaths(w);
  const engramDir = join(paths.root, 'engram', `1.2.3-${sha(Buffer.from('engram-1.2.3')).slice(0, 8)}`);
  assert.deepEqual(servers.engram, { type: 'local', command: [join(engramDir, 'engram.exe'), 'mcp', '--tools=agent'] });
  const cgDir = join(paths.root, 'codegraph', `1.2.3-${sha(Buffer.from('codegraph-1.2.3')).slice(0, 8)}`);
  assert.deepEqual(servers.codegraph.command, [
    join(cgDir, 'node.exe'), '--liftoff-only', '--disable-warning=ExperimentalWarning', join(cgDir, 'lib', 'dist', 'bin', 'codegraph.js'), 'serve', '--mcp',
  ]);
  assert.ok(!servers.codegraph.command.includes('--path'));

  const manifest = readManifest(paths).manifest;
  assert.deepEqual(Object.keys(manifest.tools.engram.versions), ['1.2.3']);
  assert.deepEqual(manifest.tools.engram.registration, { file: 'opencode.json', name: 'engram' });
  // Data and index sentinels are untouched, and nothing leaks into the MDD package/version/backup trees.
  assert.equal(fs.readFileSync(join(w.home, '.engram', 'engram.db'), 'utf8'), 'MEMORY');
  assert.equal(fs.readFileSync(join(w.project, '.codegraph', 'codegraph.db'), 'utf8'), 'INDEX');
  for (const dir of ['versions', 'backups', 'node_modules', 'manager']) assert.equal(fs.existsSync(join(paths.ownedRoot, dir)), false);
  // Only version probes ran; never an `mcp add`, `setup`, `status` or `install`.
  assert.ok(e.calls.run.every(call => !call.args.some(a => ['mcp', 'add', 'setup', 'status', 'install', 'init'].includes(a))));

  // Replay: nothing is offered and an explicit replay reports unchanged without network or writes.
  const after = inspect(e.deps);
  assert.deepEqual(after.tools.map(x => x.state), ['external', 'managed', 'managed']);
  assert.equal(tool(after, 'engram').version, '1.2.3');
  assert.equal(tool(after, 'engram').offers.length, 0);
  const fetches = e.calls.fetch.length, before = readConfig(w);
  const stale = await apply(actions, e.deps);
  assert.deepEqual(stale.results.map(r => r.outcome), ['not-attempted', 'not-attempted', 'not-attempted'], 'an old review never applies to newer state');
  const replay = await apply(actions.map(a => ({ ...a, digests: after.digests })), e.deps);
  assert.deepEqual(replay.results.map(r => r.outcome), ['unchanged', 'unchanged', 'unchanged']);
  assert.equal(replay.restartNote, undefined);
  assert.equal(readConfig(w), before);
  assert.equal(e.calls.fetch.length, fetches);
});

test('a reviewed action whose inputs changed is not attempted and nothing is downloaded or written', async t => {
  const w = world(t);
  seedConfig(w, '{}\n');
  const e = engine(w);
  const snapshot = inspect(e.deps);
  fs.writeFileSync(w.configFile, '{ "theme": "light" }\n');
  const report = await apply([offer(snapshot, 'engram', 'install'), offer(snapshot, 'context7', 'configure')], e.deps);
  assert.deepEqual(report.results.map(r => r.outcome), ['not-attempted', 'not-attempted']);
  assert.match(report.results[0].reason, /Cambió desde la revisión/);
  assert.equal(readConfig(w), '{ "theme": "light" }\n');
  assert.deepEqual(e.calls.fetch, []);
  assert.equal(report.restartNote, undefined);
});

test('partial outcome: a binary is installed but the config changed during download, so the registration is not written', async t => {
  const w = world(t);
  seedConfig(w, '{}\n');
  const e = engine(w, { onFetch: () => fs.writeFileSync(w.configFile, '{ "theme": "light" }\n') });
  const snapshot = inspect(e.deps);
  const report = await apply([offer(snapshot, 'engram', 'install')], e.deps);
  const [result] = report.results;
  assert.equal(result.outcome, 'failed');
  assert.match(result.reason, /Cambió desde la revisión/);
  assert.ok(result.effects.some(x => x.includes('Engram 1.2.3')));
  assert.ok(result.residual.some(x => /instalada y sin usar/.test(x)));
  assert.equal(readConfig(w), '{ "theme": "light" }\n');
  const manifest = readManifest(configPaths(w)).manifest;
  assert.ok(manifest.tools.engram.versions['1.2.3']);
  assert.equal(report.restartNote, undefined);
  // The unused install is visible and offers a retry of the config step only.
  const after = inspect(e.deps);
  assert.equal(tool(after, 'engram').state, 'absent');
  assert.match(tool(after, 'engram').installed.detail, /instaladas sin usar: 1\.2\.3/);
  const retry = await apply([offer(after, 'engram', 'install')], e.deps);
  assert.equal(retry.results[0].outcome, 'completed');
  assert.equal(e.calls.extract, 1, 'the retry reuses the intact directory');
});

test('a failed download activates nothing and reports the stage', async t => {
  const w = world(t);
  const e = engine(w, { fail: 'fetch' });
  const report = await apply([offer(inspect(e.deps), 'engram', 'install')], e.deps);
  assert.equal(report.results[0].outcome, 'failed');
  assert.match(report.results[0].reason, /\(download\)/);
  assert.match(report.results[0].reason, /no se activó nada/);
  assert.equal(fs.existsSync(w.configFile), false);
  assert.equal(report.restartNote, undefined);
});

test('update vA to vB changes only the command, keeps other fields and the previous version, and prunes older ones', async t => {
  const w = world(t);
  const a = engine(w, { version: '1.2.3' });
  await apply([offer(inspect(a.deps), 'engram', 'install')], a.deps);
  const servers = parseServers(w);
  servers.engram.enabled = true;
  seedConfig(w, `${JSON.stringify({ mcp: { servers } }, null, 2)}\n`);
  const oldCommand = servers.engram.command;

  const b = engine(w, { version: '1.3.0' });
  const snapshot = inspect(b.deps);
  const update = offer(snapshot, 'engram', 'update');
  assert.ok(update, 'a newer catalog pin with the same format is offered');
  assert.equal(update.release.version, '1.3.0');
  const review = reviewOf(update, b.deps);
  assert.equal(review.configFile, w.configFile);
  assert.match(review.notes.join(' '), /Versión actual: 1\.2\.3; candidata: 1\.3\.0/);
  const report = await apply([update], b.deps);
  assert.equal(report.results[0].outcome, 'completed');
  assert.equal(report.results[0].restart, true);
  assert.match(report.restartNote, /reconectá.*`\/mcps`/);
  assert.doesNotMatch(report.restartNote, /service restart/);
  const next = parseServers(w).engram;
  assert.equal(next.enabled, true);
  assert.notDeepEqual(next.command, oldCommand);
  assert.deepEqual(next.command.slice(1), ['mcp', '--tools=agent']);
  assert.match(next.command[0], /1\.3\.0-/);
  const paths = configPaths(w);
  assert.ok(fs.existsSync(oldCommand[0]), 'the previous version stays usable');
  assert.deepEqual(Object.keys(readManifest(paths).manifest.tools.engram.versions).sort(), ['1.2.3', '1.3.0']);

  // A third version prunes the oldest, retaining the one just replaced.
  const c = engine(w, { version: '1.4.0' });
  const third = await apply([offer(inspect(c.deps), 'engram', 'update')], c.deps);
  assert.equal(third.results[0].outcome, 'completed');
  assert.ok(third.results[0].effects.some(x => /eliminadas: 1\.2\.3/.test(x)));
  assert.deepEqual(Object.keys(readManifest(paths).manifest.tools.engram.versions).sort(), ['1.3.0', '1.4.0']);
  assert.equal(fs.existsSync(oldCommand[0]), false);
});

test('format change blocks the update, and a forced action is not attempted', async t => {
  const w = world(t);
  const a = engine(w);
  await apply([offer(inspect(a.deps), 'codegraph', 'install')], a.deps);
  const b = engine(w, { version: '1.3.0', format: { codegraph: 'codegraph-index-schema:12' } });
  const snapshot = inspect(b.deps);
  assert.equal(offer(snapshot, 'codegraph', 'update'), undefined);
  assert.match(tool(snapshot, 'codegraph').notices.join(' '), /formato del índice|el índice/);
  const forced = { kind: 'update', tool: 'codegraph', release: catalogRelease('codegraph', PLATFORM, b.deps), digests: snapshot.digests };
  const before = readConfig(w);
  const report = await apply([forced], b.deps);
  assert.equal(report.results[0].outcome, 'not-attempted');
  assert.match(report.results[0].reason, /migración/);
  assert.equal(readConfig(w), before);
  assert.deepEqual(b.calls.fetch, []);
});

test('tampered binary and user-edited registration are never updated', async t => {
  const w = world(t);
  const a = engine(w);
  await apply([offer(inspect(a.deps), 'engram', 'install')], a.deps);
  const exe = parseServers(w).engram.command[0];
  const b = engine(w, { version: '1.3.0' });
  const update = offer(inspect(b.deps), 'engram', 'update');
  assert.ok(update);

  fs.writeFileSync(exe, 'TAMPERED');
  const tampered = inspect(b.deps);
  assert.equal(tool(tampered, 'engram').installed.value, 'no');
  assert.equal(offer(tampered, 'engram', 'update'), undefined);
  const forced = await apply([update], b.deps);
  assert.equal(forced.results[0].outcome, 'not-attempted');
  assert.match(forced.results[0].reason, /alterada|incompleta/);
  fs.writeFileSync(exe, 'ENGRAM-1.2.3');

  const servers = parseServers(w);
  servers.engram.command.push('--extra');
  seedConfig(w, `${JSON.stringify({ mcp: { servers } }, null, 2)}\n`);
  const edited = inspect(b.deps);
  assert.equal(tool(edited, 'engram').state, 'external');
  assert.equal(tool(edited, 'engram').offers.length, 0);
  const refused = await apply([{ ...update, digests: edited.digests }], b.deps);
  assert.equal(refused.results[0].outcome, 'not-attempted');
  assert.match(refused.results[0].reason, /no es una instalación gestionada|externo/);
  assert.deepEqual(b.calls.fetch, []);
});

test('external registrations keep their ownership: reuse, disabled and conflicting entries are never rewritten', async t => {
  const w = world(t);
  seedConfig(w, JSON.stringify({ mcp: { servers: {
    engram: { type: 'local', command: ['C:\\tools\\engram.exe', 'mcp'] },
    codegraph: { type: 'local', command: ['other-tool', 'serve'] },
    context7: { type: 'remote', url: 'https://mcp.context7.com/mcp', enabled: false },
  } } }, null, 2));
  const before = readConfig(w);
  const e = engine(w);
  const snapshot = inspect(e.deps);
  assert.equal(tool(snapshot, 'engram').state, 'external');
  assert.equal(tool(snapshot, 'engram').offers.length, 0);
  assert.equal(tool(snapshot, 'codegraph').state, 'conflict');
  assert.equal(tool(snapshot, 'codegraph').offers.length, 0);
  assert.equal(tool(snapshot, 'context7').state, 'disabled');
  assert.equal(tool(snapshot, 'context7').offers.length, 0);
  assert.equal(readConfig(w), before);
  assert.deepEqual(e.calls.run, []);
});

test('register-external adds a native executable after a version check and records no ownership', async t => {
  const w = world(t, { path: ['engram.exe'] });
  const e = engine(w);
  const snapshot = inspect(e.deps);
  const register = offer(snapshot, 'engram', 'register-external');
  assert.ok(register);
  assert.equal(register.executable, join(w.bin, 'engram.exe'));
  assert.equal(offer(snapshot, 'codegraph', 'register-external'), undefined);
  const report = await apply([register], e.deps);
  assert.equal(report.results[0].outcome, 'completed');
  assert.deepEqual(parseServers(w).engram, { type: 'local', command: [join(w.bin, 'engram.exe'), 'mcp', '--tools=agent'] });
  assert.equal(readManifest(configPaths(w)).manifest.tools.engram, undefined);
  assert.equal(tool(inspect(e.deps), 'engram').state, 'external');
  assert.equal(e.calls.run.length, 1);
  assert.deepEqual(e.calls.run[0].args, ['version']);

  const refused = engine(world(t, { path: ['engram.exe'] }), { runResult: () => ({ status: 1, stdout: '', stderr: '' }) });
  const w2 = refused.deps.cwd.replace(/project$/, '');
  const snap2 = inspect(refused.deps);
  const out = await apply([offer(snap2, 'engram', 'register-external')], refused.deps);
  assert.equal(out.results[0].outcome, 'not-attempted');
  assert.equal(fs.existsSync(join(w2, 'config', 'opencode', 'opencode.json')), false);
});

test('an unsafe global config blocks every write and the bytes stay untouched', async t => {
  const w = world(t);
  seedConfig(w, '{ "mcp": { "servers": { "a": 1 }, "servers": {} } }');
  const before = readConfig(w);
  const e = engine(w);
  const snapshot = inspect(e.deps);
  assert.deepEqual(snapshot.tools.map(x => x.state), ['unknown', 'unknown', 'unknown']);
  assert.ok(snapshot.blockers.length > 0);
  assert.ok(snapshot.tools.every(x => x.offers.length === 0));
  const forced = await apply([{ kind: 'configure', tool: 'context7', digests: snapshot.digests }], e.deps);
  assert.equal(forced.results[0].outcome, 'not-attempted');
  assert.equal(readConfig(w), before);
});

// ---------------------------------------------------------------------------------------------
// CodeGraph init
// ---------------------------------------------------------------------------------------------

let gitOk = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitOk = false; }

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe', encoding: 'utf8' });
}

function repo(w, name = 'repo') {
  const root = join(w.base, name);
  fs.mkdirSync(root);
  git(root, 'init', '-q');
  fs.writeFileSync(join(root, 'a.txt'), 'a');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  return fs.realpathSync(root);
}

/** Real git, fake CodeGraph. */
function initEngine(w, { codegraph } = {}) {
  const e = engine(w, {
    runResult: (file, args, options) => {
      if (/git(\.exe)?$/i.test(file)) return defaultRun(file, args, options);
      if (args.includes('init')) return codegraph(file, args, options);
      return { status: 0, stdout: '1.2.3\n', stderr: '' };
    },
  });
  e.deps.env = { ...process.env, ...e.deps.env, PATH: `${w.bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}` };
  e.deps.platform = process.platform;
  e.deps.arch = process.arch;
  return e;
}

const hostPlatform = () => `${process.platform}-${process.arch}`;

test('init: exact Git root and worktree are accepted; subdirectory, non-repo and prior index are refused', { skip: !gitOk || hostPlatform() !== PLATFORM }, t => {
  const w = world(t);
  const root = repo(w);
  const e = initEngine(w);
  const ok = checkInitTarget(root, e.deps);
  assert.equal(ok.ok.root, root);
  assert.equal(ok.ok.dotGit, 'dir');
  assert.deepEqual(ok.ok.entries, []);

  fs.mkdirSync(join(root, 'sub'));
  assert.match(checkInitTarget(join(root, 'sub'), e.deps).refused, /no es la raíz del repositorio/);
  const plain = join(w.base, 'plain');
  fs.mkdirSync(plain);
  assert.match(checkInitTarget(plain, e.deps).refused, /repositorio Git/);
  assert.match(checkInitTarget(join(w.base, 'missing'), e.deps).refused, /no existe/);
  assert.match(checkInitTarget(w.home, { ...e.deps, env: { ...e.deps.env, HOME: w.home } }).refused, /personal|repositorio/);

  const worktree = join(w.base, 'wt');
  git(root, 'worktree', 'add', '-q', worktree, '-b', 'wt');
  const wt = checkInitTarget(worktree, e.deps);
  assert.equal(wt.ok.dotGit, 'file');
  assert.equal(wt.ok.root, fs.realpathSync(worktree));

  assert.match(checkInitTarget(root, { ...e.deps, env: { ...e.deps.env, CODEGRAPH_DIR: 'x' } }).refused, /CODEGRAPH_DIR/);
  assert.match(checkInitTarget(root, { ...e.deps, env: { ...e.deps.env, CODEGRAPH_NO_WATCH: '1' } }).refused, /CODEGRAPH_NO_WATCH/);
  fs.mkdirSync(join(root, '.codegraph-wsl'));
  assert.match(checkInitTarget(root, e.deps).refused, /\.codegraph-wsl/);
  assert.deepEqual(fs.readdirSync(root).filter(n => n.startsWith('.codegraph')), ['.codegraph-wsl']);
});

test('init runs only the reviewed exact root with the managed launcher, telemetry off, and reports the result unverified', { skip: !gitOk || hostPlatform() !== PLATFORM }, async t => {
  const w = world(t);
  const root = repo(w);
  const e = initEngine(w, {
    codegraph: (file, args, options) => {
      fs.mkdirSync(join(options.cwd, '.codegraph'));
      fs.writeFileSync(join(options.cwd, '.codegraph', 'codegraph.db'), 'DB');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const target = checkInitTarget(root, e.deps).ok;
  // No CodeGraph yet: not attempted, nothing executed.
  const none = await initCodeGraph(target, e.deps);
  assert.equal(none.outcome, 'not-attempted');
  assert.equal(e.calls.run.filter(c => c.args.includes('init')).length, 0);

  // The init is bound to the install queued with it; without that dependency it is stale, not re-selected.
  const queuedInstall = offer(inspect(e.deps), 'codegraph', 'install');
  const bound = checkInitTarget(root, e.deps, queuedInstall).ok;
  assert.equal(bound.launcher.origin, 'queued-install');
  assert.ok(reviewOf({ kind: 'init', tool: 'codegraph', target: bound }, e.deps).command.includes('--liftoff-only'));
  const alone = await apply([{ kind: 'init', tool: 'codegraph', target: bound }], e.deps);
  assert.equal(alone.results[0].outcome, 'not-attempted');
  assert.equal(e.calls.run.filter(c => c.args.includes('init')).length, 0);

  const report = await apply([{ kind: 'init', tool: 'codegraph', target: bound }, queuedInstall], e.deps);
  assert.deepEqual(report.results.map(r => [r.kind, r.outcome]), [['install', 'completed'], ['init', 'completed']]);
  const call = e.calls.run.find(c => c.args.includes('init'));
  assert.deepEqual(call.args.slice(-3), ['init', root, '--yes']);
  assert.ok(call.args.includes('--liftoff-only'));
  assert.ok(call.file.endsWith('node.exe'));
  assert.equal(call.options.cwd, root);
  assert.equal(call.options.env.CODEGRAPH_TELEMETRY, '0');
  assert.equal(call.options.stdio, 'inherit');
  assert.ok(!call.args.includes('--path'));
  assert.match(report.results[1].reason, /no verificado/);
  assert.ok(report.results[1].effects.some(x => x.includes('.codegraph')));
  assert.ok(e.calls.run.every(c => !c.args.includes('status')));
  assert.equal(fs.readFileSync(join(root, '.codegraph', 'codegraph.db'), 'utf8'), 'DB');
});

test('init is revalidated: a changed target is refused, a failed run lists partial artifacts without cleanup, and a failed install skips it', { skip: !gitOk || hostPlatform() !== PLATFORM }, async t => {
  const w = world(t);
  const root = repo(w);
  const e = initEngine(w, {
    codegraph: (file, args, options) => {
      fs.mkdirSync(join(options.cwd, '.codegraph'));
      fs.writeFileSync(join(options.cwd, '.codegraph', 'errors.log'), 'boom');
      return { status: 1, stdout: '', stderr: '' };
    },
  });
  await apply([offer(inspect(e.deps), 'codegraph', 'install')], e.deps);
  const target = checkInitTarget(root, e.deps).ok;

  fs.writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n');
  const stale = await initCodeGraph(target, e.deps);
  assert.equal(stale.outcome, 'not-attempted');
  assert.match(stale.reason, /Cambió desde la revisión/);
  assert.equal(fs.existsSync(join(root, '.codegraph')), false);

  const fresh = checkInitTarget(root, e.deps).ok;
  const failed = await initCodeGraph(fresh, e.deps);
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.reason, /no limpia, repara ni reintenta/);
  assert.ok(failed.residual.some(x => x.includes('.codegraph')));
  assert.equal(fs.existsSync(join(root, '.codegraph', 'errors.log')), true, 'partial artifacts are left alone');
  assert.equal(e.calls.run.filter(c => c.args.includes('init')).length, 1, 'never retried');

  const bare = world(t);
  const bareRepo = repo(bare);
  const broken = initEngine(bare);
  const missing = engine(bare, { fail: 'fetch' });
  const skipped = await apply([
    { kind: 'init', tool: 'codegraph', target: checkInitTarget(bareRepo, broken.deps).ok },
    offer(inspect(missing.deps), 'codegraph', 'install'),
  ], { ...broken.deps, fetch: missing.deps.fetch });
  assert.deepEqual(skipped.results.map(r => [r.kind, r.outcome]), [['install', 'failed'], ['init', 'not-attempted']]);
  assert.equal(fs.existsSync(join(bareRepo, '.codegraph')), false);
});

// ---------------------------------------------------------------------------------------------
// Correction round C1: blockers, init launcher binding, native external init, previous-launch retention
// ---------------------------------------------------------------------------------------------

test('environment-dependent configuration blocks managed updates at offer, Apply and without downloading', async t => {
  const w = world(t);
  const a = engine(w, { version: '1.2.3' });
  await apply([offer(inspect(a.deps), 'engram', 'install')], a.deps);
  const before = readConfig(w);
  const b = engine(w, { version: '1.3.0' });
  const reviewed = offer(inspect(b.deps), 'engram', 'update');
  assert.ok(reviewed);

  b.deps.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: { servers: { engram: { type: 'local', command: ['external-engram', 'mcp'] } } } });
  const snapshot = inspect(b.deps);
  assert.match(snapshot.blockers.join(' '), /OPENCODE_CONFIG_CONTENT/);
  assert.equal(offer(snapshot, 'engram', 'update'), undefined);
  assert.match(tool(snapshot, 'engram').notices.join(' '), /OPENCODE_CONFIG_CONTENT/);
  assert.match((await lookupOffer('engram', b.deps)).rejected, /OPENCODE_CONFIG_CONTENT/);
  const forced = await apply([reviewed, { ...reviewed, digests: snapshot.digests }], b.deps);
  assert.deepEqual(forced.results.map(r => r.outcome), ['not-attempted', 'not-attempted']);
  assert.equal(readConfig(w), before);
  assert.deepEqual(b.calls.fetch, []);
});

test('an update override that appears during staging is caught by the commit-time blocker check', async t => {
  const w = world(t);
  const a = engine(w, { version: '1.2.3' });
  await apply([offer(inspect(a.deps), 'engram', 'install')], a.deps);
  const before = readConfig(w);
  const b = engine(w, { version: '1.3.0', onFetch: () => { b.deps.env.OPENCODE_CONFIG = join(w.base, 'other.json'); } });
  const report = await apply([offer(inspect(b.deps), 'engram', 'update')], b.deps);
  assert.equal(report.results[0].outcome, 'failed');
  assert.match(report.results[0].reason, /OPENCODE_CONFIG/);
  assert.equal(readConfig(w), before, 'the registration still launches the previous version');
});

const registerCodegraph = (w, command) => seedConfig(w, JSON.stringify({ mcp: { servers: { codegraph: { type: 'local', command } } } }));
const initCalls = e => e.calls.run.filter(c => c.args.includes('init'));
const fakeIndex = (file, args, options) => {
  fs.mkdirSync(join(options.cwd, '.codegraph'));
  fs.writeFileSync(join(options.cwd, '.codegraph', 'codegraph.db'), 'DB');
  return { status: 0, stdout: '', stderr: '' };
};

test('init approval is bound to the reviewed external launcher: replacing it after review runs nothing', { skip: !gitOk || hostPlatform() !== PLATFORM }, async t => {
  const w = world(t);
  const root = repo(w);
  const [one, two] = ['one', 'two'].map(name => join(w.bin, name, 'codegraph.exe'));
  for (const file of [one, two]) { fs.mkdirSync(join(file, '..')); fs.writeFileSync(file, 'native'); }
  registerCodegraph(w, [one, 'serve', '--mcp']);
  const e = initEngine(w, { codegraph: fakeIndex });
  const target = checkInitTarget(root, e.deps).ok;
  assert.equal(target.launcher.origin, 'registered-external');
  const review = reviewOf({ kind: 'init', tool: 'codegraph', target }, e.deps);
  assert.deepEqual(review.command, [one, 'init', root, '--yes']);
  assert.match(review.notes.join(' '), /externo registrado/);

  registerCodegraph(w, [two, 'serve', '--mcp']);
  const stale = await apply([{ kind: 'init', tool: 'codegraph', target }], e.deps);
  assert.equal(stale.results[0].outcome, 'not-attempted');
  assert.match(stale.results[0].reason, /Cambi/);
  assert.equal(initCalls(e).length, 0);

  // Same registration but a replaced file is also a change.
  const again = checkInitTarget(root, e.deps).ok;
  fs.writeFileSync(two, 'native but different size');
  assert.equal((await apply([{ kind: 'init', tool: 'codegraph', target: again }], e.deps)).results[0].outcome, 'not-attempted');
  assert.equal(initCalls(e).length, 0);
  const fresh = checkInitTarget(root, e.deps).ok;
  assert.equal((await apply([{ kind: 'init', tool: 'codegraph', target: fresh }], e.deps)).results[0].outcome, 'completed');
  assert.equal(initCalls(e)[0].file, two);
});

test('an unrelated config change by the same Apply does not invalidate a reviewed external init', { skip: !gitOk || hostPlatform() !== PLATFORM }, async t => {
  const w = world(t, { path: ['codegraph.exe'] });
  const root = repo(w);
  registerCodegraph(w, ['codegraph', 'serve', '--mcp']);
  const e = initEngine(w, { codegraph: fakeIndex });
  const target = checkInitTarget(root, e.deps).ok;
  const report = await apply([{ kind: 'init', tool: 'codegraph', target }, offer(inspect(e.deps), 'context7', 'configure')], e.deps);
  assert.deepEqual(report.results.map(r => [r.kind, r.outcome]), [['configure', 'completed'], ['init', 'completed']]);
});

test('init uses an ordinary native external CodeGraph from PATH, never an npm shim or an override-dependent registration', { skip: !gitOk || hostPlatform() !== PLATFORM }, async t => {
  const w = world(t, { path: ['codegraph.exe'] });
  const root = repo(w);
  registerCodegraph(w, ['codegraph', 'serve', '--mcp']);
  const e = initEngine(w, { codegraph: fakeIndex });
  assert.equal(tool(inspect(e.deps), 'codegraph').state, 'external');
  const target = checkInitTarget(root, e.deps).ok;
  assert.deepEqual(target.launcher.command, [join(w.bin, 'codegraph.exe')]);
  const report = await apply([{ kind: 'init', tool: 'codegraph', target }], e.deps);
  assert.equal(report.results[0].outcome, 'completed');
  assert.deepEqual(initCalls(e)[0].args, ['init', root, '--yes']);
  assert.equal(initCalls(e)[0].file, join(w.bin, 'codegraph.exe'));

  // npm-style shims are not native executables: nothing is resolved or run.
  const shim = world(t);
  const shimRoot = repo(shim);
  fs.writeFileSync(join(shim.bin, 'codegraph.cmd'), '@echo off');
  registerCodegraph(shim, ['codegraph', 'serve', '--mcp']);
  const s = initEngine(shim, { codegraph: fakeIndex });
  const shimTarget = checkInitTarget(shimRoot, s.deps).ok;
  assert.equal(shimTarget.launcher, null);
  assert.equal((await apply([{ kind: 'init', tool: 'codegraph', target: shimTarget }], s.deps)).results[0].outcome, 'not-attempted');
  assert.equal(initCalls(s).length, 0);

  // Uncertain effective configuration resolves no launcher.
  fs.rmSync(join(root, '.codegraph'), { recursive: true });
  e.deps.env.OPENCODE_CONFIG_CONTENT = '{}';
  assert.equal(checkInitTarget(root, e.deps).ok.launcher, null);
});

test('update retention keeps the actual previous launch even after a failed unused candidate', async t => {
  const w = world(t);
  const a = engine(w, { version: '1.2.3' });
  await apply([offer(inspect(a.deps), 'engram', 'install')], a.deps);
  const previous = parseServers(w).engram.command[0];

  const b = engine(w, { version: '1.3.0', onFetch: () => {
    const servers = parseServers(w);
    fs.writeFileSync(w.configFile, JSON.stringify({ theme: 'changed during download', mcp: { servers } }));
  } });
  const failed = await apply([offer(inspect(b.deps), 'engram', 'update')], b.deps);
  assert.equal(failed.results[0].outcome, 'failed');
  assert.equal(parseServers(w).engram.command[0], previous);

  const c = engine(w, { version: '1.4.0' });
  const report = await apply([offer(inspect(c.deps), 'engram', 'update')], c.deps);
  assert.equal(report.results[0].outcome, 'completed');
  assert.equal(fs.existsSync(previous), true, 'the version the registration launched before the update is retained');
  assert.ok(!report.results[0].effects.some(x => /eliminadas: .*1\.2\.3/.test(x)));
  assert.deepEqual(Object.keys(readManifest(configPaths(w)).manifest.tools.engram.versions).sort(), ['1.2.3', '1.4.0']);
});

// ---------------------------------------------------------------------------------------------
// Probe, doctor and boundaries
// ---------------------------------------------------------------------------------------------

test('the explicit probe reports connection statuses by name and leaves unknown output as unknown', async t => {
  const w = world(t, { path: ['opencode.exe'] });
  seedConfig(w, JSON.stringify({ mcp: { servers: {
    context7: { type: 'remote', url: 'https://mcp.context7.com/mcp' },
    engram: { type: 'local', command: [join(w.bin, 'engram.exe'), 'mcp', '--tools=agent'] },
  } } }));
  fs.writeFileSync(join(w.bin, 'engram.exe'), 'x');
  const list = '\x1b[32m✓\x1b[0m context7 connected\n● engram needs authentication\n';
  const e = engine(w, { runResult: (file, args) => (file.endsWith('opencode.exe') ? { status: 0, stdout: list, stderr: '' } : { status: 0, stdout: 'engram 3.7.2\n', stderr: '' }) });
  const report = await probe(e.deps);
  assert.match(report.disclosure, /iniciar el servicio de OpenCode/);
  assert.equal(report.tools.context7.connected.status, 'connected');
  assert.equal(report.tools.engram.connected.status, 'needs-auth');
  assert.equal(report.tools.codegraph.connected.status, 'unknown');
  assert.equal(report.tools.engram.version.detail, 'engram 3.7.2');
  assert.equal(report.tools.engram.usable.value, 'unknown');
  assert.equal(report.tools.codegraph.usable.value, 'no');
  const mcp = e.calls.run.find(c => c.file.endsWith('opencode.exe'));
  assert.deepEqual(mcp.args, ['mcp', 'list']);
  assert.ok(mcp.options.timeout <= 30000);
  assert.ok(e.calls.run.every(c => !c.args.includes('status')));
  const version = e.calls.run.find(c => c.file.endsWith('engram.exe'));
  assert.deepEqual(version.args, ['version']);
  assert.equal(version.options.env.HOME, version.options.cwd);

  const garbled = engine(w, { runResult: () => ({ status: 0, stdout: 'garbage', stderr: '' }) });
  assert.equal((await probe(garbled.deps)).tools.context7.connected.status, 'unknown');
  const failing = engine(w, { runResult: (file) => (file.endsWith('opencode.exe') ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: '', stderr: '' }) });
  const failed = await probe(failing.deps);
  assert.match(failed.opencode.detail, /desconocida/);
  const absent = engine(world(t));
  const none = await probe(absent.deps);
  assert.equal(none.opencode.ran, false);
  assert.deepEqual(absent.calls.run, []);
  assert.equal(parseMcpList('engram disabled\ncontext7 failed', { context7: 'context7', engram: 'engram', codegraph: 'codegraph' }).engram, 'disabled');
});

test('doctorSummary is offline and informational even with broken, conflicting or absent state', t => {
  const w = world(t);
  const trap = engine(w);
  trap.deps.fetch = () => { throw new Error('network is forbidden'); };
  trap.deps.run = () => { throw new Error('subprocess is forbidden'); };
  for (const text of [undefined, '{ broken', JSON.stringify({ mcp: { servers: { engram: { type: 'local', command: ['x'] } } } })]) {
    if (text !== undefined) seedConfig(w, text);
    const summary = doctorSummary(trap.deps);
    assert.equal(summary.check, 'integrations');
    assert.equal(summary.status, 'info');
    assert.match(summary.message, /Integraciones opcionales/);
    assert.doesNotMatch(summary.message, /telemetr/i);
    assert.equal(summary.tools.length, 3);
  }
  assert.equal(doctorSummary({ ...trap.deps, env: { XDG_CONFIG_HOME: 'relative' } }).status, 'info');
});

test('reviewOf shows the exact destination, command, integrity and cautions of each action', t => {
  const w = world(t);
  const e = engine(w);
  const snapshot = inspect(e.deps);
  const review = reviewOf(offer(snapshot, 'engram', 'install'), e.deps);
  assert.equal(review.version, '1.2.3');
  assert.match(review.source, /^https:\/\/github\.com\//);
  assert.equal(review.sha256, sha(Buffer.from('engram-1.2.3')));
  assert.deepEqual(review.command.slice(1), ['mcp', '--tools=agent']);
  assert.ok(review.command[0].startsWith(review.destination));
  assert.ok(review.notes.some(n => /~\/\.engram/.test(n)));
  assert.match(reviewOf(offer(snapshot, 'context7', 'configure'), e.deps).notes.join(' '), /remoto/);
  assert.match(reviewOf({ kind: 'init', tool: 'codegraph', target: { root: w.project, top: w.project, dotGit: 'dir', entries: [], hooks: [] } }, e.deps).notes.join(' '), /no se puede deshacer/);
});
