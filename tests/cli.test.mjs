import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { launcherKind, writeLaunchers } from '../dist/command-link.js';
import { installationPaths } from '../dist/installation-paths.js';
import { installManager } from '../dist/version-manager.js';
import { acquireLock, readState, versionPaths, withLock, writeState } from '../dist/version-store.js';
import { installedPackageDigest } from '../dist/version-switch.js';
import { main, makeCtx, managerChecks, mergeDoctor, parseUse } from '../dist/version-cli.js';
import { makeCheckout, makeOrigin, tempDir } from './version-fixtures.mjs';

// No test may reach the registry or the user's npm configuration.
process.env.npm_config_offline = 'true';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function isolated(t) {
  const home = mkdtempSync(join(tmpdir(), 'mdd-cli-home-'));
  const workspace = mkdtempSync(join(tmpdir(), 'mdd-cli-workspace-'));
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(workspace, { recursive: true, force: true }); });
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace, encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home },
    });
    assert.ifError(result.error);
    return result;
  };
  return { home, workspace, run };
}

test('help lists every command and the exit codes', t => {
  const { run } = isolated(t);
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  for (const command of ['setup', 'update', 'link', 'doctor', 'config', 'profile list']) assert.match(result.stdout, new RegExp(`mdd-ai ${command}`));
  assert.match(result.stdout, /Códigos de salida: 0/);
});

test('profile create, use and list change only the global settings file', t => {
  const { home, workspace, run } = isolated(t);
  assert.equal(run('profile', 'create', 'work').status, 0);
  assert.equal(run('profile', 'use', 'default').status, 0);
  const list = run('profile', 'list');
  assert.equal(list.status, 0);
  assert.equal(list.stdout, '* default\n  work\n');
  assert.deepEqual(readdirSync(join(home, 'opencode', 'mdd')), ['mdd.config.json']);
  assert.deepEqual(readdirSync(workspace), []);
});

for (const args of [[], ['--unknown'], ['workers', 'status'], ['telemetry', 'status'], ['retro'], ['--answers', 'x.json'], ['doctor', 'extra'], ['config', 'extra'], ['profile', 'use']]) {
  test(`invalid or retired arguments exit with 2: ${JSON.stringify(args)}`, t => {
    const { run } = isolated(t);
    const result = run(...args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Error de MDD:/);
  });
}

test('doctor prints a JSON report and exits 1 when MDD is not installed', t => {
  const { run } = isolated(t);
  const result = run('doctor');
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, false);
  assert.ok(report.checks.some(check => check.check === 'installed-package' && check.status === 'action'));
});

// ---------------------------------------------------------------- manager router (T10)
// Everything below runs against a temporary home. The origin is a local bare repository, so nothing touches
// the network, the real user home or the real repository's tags. Windows PATH registration is replaced by a spy.

const fixturesRoot = fileURLToPath(new URL('..', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');
const MANAGER_FILES = (paths) => ['entry.mjs', 'current.json'].map(name => join(paths.managerRoot, name));

function managed(t, { origin, devCheckout, active } = {}) {
  const home = tempDir(t, 'mdd-router-home-');
  const paths = installationPaths({ home, env: { XDG_CONFIG_HOME: home } });
  mkdirSync(paths.ownedRoot, { recursive: true });
  installManager(join(fixturesRoot, 'dist'), { revision: 1, version: '0.2.0', source: 'checkout' }, paths);
  writeLaunchers(paths);
  const vp = versionPaths(paths.ownedRoot);
  setState(vp, state => {
    if (origin) state.origin = origin;
    if (devCheckout) state.devCheckout = devCheckout;
    if (active) state.active = active;
  });
  return { home, paths, vp, root: paths.configRoot };
}

function setState(vp, change) {
  withLock(vp, 'test', lock => { const state = readState(vp); change(state); writeState(lock, state); });
}

/** Runs the router in-process with scripted terminal answers; `tty:false` models a pipe. */
async function run(h, args, { lines = [], tty = false, extra = {} } = {}) {
  const out = []; const err = []; const prompts = [];
  const io = { isTTY: tty, read: async prompt => { prompts.push(prompt); return lines.shift(); }, write: text => out.push(text) };
  const code = await main(args, {
    paths: h.paths, io, cwd: h.home, out: text => out.push(text), err: text => err.push(text),
    registerPath: () => assert.fail('the test must never edit a PATH'), ...extra,
  });
  return { code, out: out.join(''), err: err.join(''), prompts };
}

function walkFiles(dir, prefix = '') {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, walkFiles(join(dir, entry.name), rel));
    else out[rel] = sha(readFileSync(join(dir, entry.name)));
  }
  return out;
}

/** What a switch may change, minus volatile fields (timestamps, backup names, tarball digests). */
function view(h) {
  const files = {};
  for (const dir of ['agents', 'skills', 'plugins']) for (const [rel, digest] of Object.entries(walkFiles(join(h.root, dir)))) files[`${dir}/${rel}`] = digest;
  const read = path => (existsSync(path) ? sha(readFileSync(path)) : 'absent');
  const { active } = readState(h.vp);
  return {
    files,
    ledger: read(h.paths.manifestPath),
    config: read(h.paths.settingsPath),
    active: active && { kind: active.kind, version: active.version, commit: active.commit, channel: active.channel, selectedAs: active.selectedAs },
    packageJson: existsSync(join(h.paths.installedPackageRoot, 'package.json')) ? sha(readFileSync(join(h.paths.installedPackageRoot, 'package.json'))) : 'absent',
  };
}

const STATE_BYTES = h => (existsSync(h.vp.statePath) ? readFileSync(h.vp.statePath, 'utf8') : '');
const REAL = { realPackage: true, files: { '.gitignore': '/dist\n/node_modules\n' } };

function walkText(dir, prefix = '') {
  const found = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(found, walkText(join(dir, entry.name), rel));
    else found[rel] = readFileSync(join(dir, entry.name), 'utf8');
  }
  return found;
}
/** The repository's compiled probe-contract modules and real assets as plain files for a checkout fixture. */
function realFiles() {
  const files = { '.gitignore': '/dist\n/node_modules\n' };
  for (const name of ['project-assets', 'settings', 'setup', 'safe-paths', 'local-files', 'validation']) files['vendor/dist/' + name + '.js'] = readFileSync(join(fixturesRoot, 'dist', name + '.js'), 'utf8');
  for (const [rel, text] of Object.entries(walkText(join(fixturesRoot, 'assets', 'opencode')))) files['assets/opencode/' + rel] = text;
  return files;
}

let origin;
before(() => {
  const cleanups = [];
  origin = makeOrigin({ after: work => cleanups.push(work) }, [
    { version: '0.3.0', marker: '0.3.0', changelog: '# Changelog\n\n## [0.3.0] - 2026-11-20\n\n- nota-estable-0.3.0\n', ...REAL },
    { version: '0.4.0-preview.1', marker: 'p1', changelog: '# Changelog\n\n## [0.4.0-preview.1] - 2026-11-21\n\n- nota-preview-1\n\n## [0.3.0] - 2026-11-20\n\n- nota-estable-0.3.0\n', ...REAL },
  ]);
  origin.cleanups = cleanups;
});
after(() => { for (const work of origin?.cleanups?.reverse() ?? []) { try { work(); } catch { /* best effort */ } } });

test('help lists use and versions next to the retained commands', t => {
  const { run: spawned } = isolated(t);
  const result = spawned('--help');
  assert.match(result.stdout, /mdd-ai use <destino>/);
  assert.match(result.stdout, /mdd-ai versions/);
});

test('the package CLI forwards use and versions to the manager entry, and says so when it is not installed', t => {
  const { home, run: spawned } = isolated(t);
  const missing = spawned('versions');
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /gestor de versiones no está instalado/);
  assert.equal(missing.stdout, '');
  const paths = installationPaths({ home, env: { XDG_CONFIG_HOME: home } });
  installManager(join(fixturesRoot, 'dist'), { revision: 1, version: '0.2.0', source: 'checkout' }, paths);
  const listed = spawned('versions');
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /MDD · Versiones/);
  assert.match(listed.stdout, /revisión 1/);
  const usage = spawned('use');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Uso: mdd-ai use/);
});

test('use argument errors are usage errors (exit 2) and change nothing', async t => {
  const h = managed(t, { origin: origin.url });
  const before = STATE_BYTES(h);
  for (const args of [['use'], ['use', 'bogus'], ['use', 'stable', 'extra'], ['use', 'stable', '--checkout', '/x'], ['use', 'dev', '--wat'], ['use', 'dev', '--checkout'], ['use', 'v0.1.0'], ['versions', 'x'], ['doctor', 'extra']]) {
    const result = await run(h, args);
    assert.equal(result.code, 2, JSON.stringify(args) + result.err);
    assert.match(result.err, /^Error de MDD:/);
  }
  assert.equal(STATE_BYTES(h), before);
  assert.deepEqual(parseUse(['dev', '--checkout', '/tmp/x', '--yes']), { target: 'dev', checkout: '/tmp/x', yes: true });
  assert.deepEqual(parseUse(['v0.3.0-preview.1']), { target: 'v0.3.0-preview.1', checkout: undefined, yes: false });
});

test('S14 versions: identity, channels, first-seen recording and no installation change', async t => {
  const h = managed(t, { origin: origin.url });
  const result = await run(h, ['versions']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Gestor de versiones\s+revisión 1/);
  assert.match(result.out, /Activa\s+sin identificar/);
  assert.match(result.out, /stable → 0\.3\.0 · preview → 0\.4\.0-preview\.1/);
  assert.match(result.out, /0\.3\.0\s+estable\s+[0-9a-f]{7}\s+sin compilar/);
  assert.match(result.out, /0\.4\.0-preview\.1\s+preview/);
  assert.match(result.out, /no sigue el canal/);
  assert.deepEqual(Object.keys(readState(h.vp).releases).sort(), ['0.3.0', '0.4.0-preview.1']);
  assert.equal(existsSync(h.paths.installedPackageRoot), false);
  // Without an origin the listing says why instead of inventing "nothing newer".
  const bare = managed(t);
  const none = await run(bare, ['versions']);
  assert.equal(none.code, 0);
  assert.match(none.out, /No hay un origen registrado/);
});

test('versions while another operation holds the lock lists read-only and records nothing', async t => {
  const h = managed(t, { origin: origin.url });
  const lock = acquireLock(h.vp, 'otro-comando');
  try {
    const result = await run(h, ['versions']);
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /Otra operación de MDD está en curso/);
    assert.deepEqual(readState(h.vp).releases, {});
    const use = await run(h, ['use', 'stable', '--yes']);
    assert.equal(use.code, 1);
    assert.match(use.err, /Otra operación de MDD está en curso/);
  } finally { lock.release(); }
});

test('use needs --yes without a terminal and refuses before any work', async t => {
  const h = managed(t, { origin: origin.url });
  const before = STATE_BYTES(h);
  const result = await run(h, ['use', 'preview']);
  assert.equal(result.code, 2);
  assert.match(result.err, /--yes/);
  assert.equal(STATE_BYTES(h), before);
  assert.equal(existsSync(join(h.vp.versionsRoot, 'cache')), false);
});

test('S1/S2/S14/S32/S35 use 0.3.0: notes and identity before preparation, backup, restart line, then "ya activa"', async t => {
  const h = managed(t, { origin: origin.url });
  const result = await run(h, ['use', '0.3.0', '--yes']);
  assert.equal(result.code, 0, result.err + result.out);
  const text = result.out;
  const order = ['Destino', 'nota-estable-0.3.0', 'Preparando la versión elegida', 'Revisión del cambio', 'Listo: 0.3.0 activa'].map(marker => text.indexOf(marker));
  assert.ok(order.every(index => index >= 0), `missing marker: ${JSON.stringify(order)}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'notes and identity come before preparation and activation');
  assert.match(text, /opencode service restart/);
  assert.match(text, /puede tener cargados los módulos/);
  const backup = /Respaldo {5}(\S.*)/.exec(text.slice(text.indexOf('Listo:')))[1].trim();
  assert.ok(existsSync(backup), 'the printed backup path exists');
  const { active } = readState(h.vp);
  assert.equal(active.version, '0.3.0');
  assert.equal(active.commit, origin.commits['0.3.0']);
  assert.equal(active.provenance, 'installed');
  assert.ok(existsSync(join(h.root, 'plugins', 'mdd.ts')));
  assert.equal(launcherKind(readFileSync(join(h.paths.binRoot, 'mdd-ai'), 'utf8')), 'manager');
  // Same identity again: nothing changes.
  const before = { view: view(h), state: STATE_BYTES(h) };
  const again = await run(h, ['use', 'stable', '--yes']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /ya activa; no se cambió nada/);
  assert.doesNotMatch(again.out, /Listo:/);
  assert.deepEqual(view(h), before.view);
  assert.equal(STATE_BYTES(h), before.state);
});

test('S31 the wizard and the CLI select equivalently; cancel and decline leave the installation unchanged', async t => {
  const cli = managed(t, { origin: origin.url });
  assert.equal((await run(cli, ['use', '0.3.0', '--yes'])).code, 0);
  const wizard = managed(t, { origin: origin.url });
  // The cache is portable; the wizard installation reuses the build instead of repeating it.
  cpSync(join(cli.vp.versionsRoot, 'cache'), join(wizard.vp.versionsRoot, 'cache'), { recursive: true });
  const picked = await run(wizard, [], { tty: true, lines: ['3', '2', 'apply'] });
  assert.equal(picked.code, 0, picked.err + picked.out);
  assert.match(picked.out, /Elegir versión[\s\S]*Notas de versión[\s\S]*Revisión del cambio[\s\S]*Listo: 0\.3\.0 activa/);
  assert.deepEqual(view(wizard), view(cli));

  const idle = managed(t, { origin: origin.url });
  cpSync(join(cli.vp.versionsRoot, 'cache'), join(idle.vp.versionsRoot, 'cache'), { recursive: true });
  const base = view(idle);
  const cancelled = await run(idle, ['setup'], { tty: true, lines: [':cancel'] });
  assert.equal(cancelled.code, 0);
  assert.match(cancelled.out, /Cancelado\. No se cambió nada/);
  const declined = await run(idle, ['update'], { tty: true, lines: ['3', '2', 'no'] });
  assert.equal(declined.code, 0, declined.err);
  assert.match(declined.out, /Cancelado\. No se cambió nada/);
  assert.doesNotMatch(declined.out, /Listo:/);
  assert.deepEqual(view(idle), base);
  assert.equal(readState(idle.vp).active, null);
});

test('the wizard needs a terminal, and Conservar delegates the active setup then restores routing', async t => {
  const h = managed(t, { origin: origin.url, active: { kind: 'release', version: '0.3.0', commit: 'a'.repeat(40), channel: 'stable', provenance: 'installed', selectedAs: '0.3.0' } });
  const piped = await run(h, ['setup']);
  assert.equal(piped.code, 2);
  assert.match(piped.err, /terminal interactiva/);
  const calls = [];
  const delegate = async (args, options) => {
    calls.push({ args, capture: options.capture });
    // The historical wizard rewrites the launchers before failing (S18).
    for (const name of ['mdd-ai.cmd', 'mdd-ai']) writeFileSync(join(h.paths.binRoot, name), `node "x/node_modules/my-driven-development/dist/cli.js" %*\n`);
    return { code: 3, stdout: '' };
  };
  const kept = await run(h, ['update'], { tty: true, lines: ['1'], extra: { delegate } });
  assert.equal(kept.code, 3);
  assert.deepEqual(calls, [{ args: ['update'], capture: false }]);
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(h.paths.binRoot, name), 'utf8')), 'manager', name);
  assert.equal(existsSync(h.vp.lockPath), false, 'the lock is released');
});

test('S18 delegation: the active CLI result is returned and routing is re-asserted after every delegated command', async t => {
  const h = managed(t);
  const rewrite = (code) => async args => {
    for (const name of ['mdd-ai.cmd', 'mdd-ai']) writeFileSync(join(h.paths.binRoot, name), 'node "x/node_modules/my-driven-development/dist/cli.js" %*\n');
    return { code, stdout: JSON.stringify(args) };
  };
  for (const [args, code] of [[['profile', 'list'], 0], [['profile', 'create', 'w'], 4], [['config'], 5], [['bogus'], 2]]) {
    const result = await run(h, args, { extra: { delegate: rewrite(code) } });
    assert.equal(result.code, code, JSON.stringify(args));
    for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(h.paths.binRoot, name), 'utf8')), 'manager', `${args[0]} ${name}`);
  }
  // Mutating delegated commands take the lock: a competing operation makes them refuse without running the child.
  const lock = acquireLock(h.vp, 'use');
  try {
    let ran = false;
    const result = await run(h, ['profile', 'use', 'w'], { extra: { delegate: async () => { ran = true; return { code: 0, stdout: '' }; } } });
    assert.equal(result.code, 1);
    assert.match(result.err, /Otra operación de MDD está en curso/);
    assert.equal(ran, false);
  } finally { lock.release(); }
});

test('real delegation: profile list reaches the active package CLI and a missing CLI is reported', async t => {
  const h = managed(t);
  const none = await run(h, ['profile', 'list']);
  assert.equal(none.code, 1);
  assert.match(none.err, /No hay una versión activa utilizable/);
  mkdirSync(join(h.paths.installedPackageRoot, 'dist'), { recursive: true });
  writeFileSync(join(h.paths.installedPackageRoot, 'dist', 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)), process.cwd()); process.exitCode = 7;\n');
  const some = spawnSync(process.execPath, [h.paths.managerEntry, 'profile', 'list'], {
    cwd: h.home, encoding: 'utf8', env: { ...process.env, HOME: h.home, USERPROFILE: h.home, XDG_CONFIG_HOME: h.home },
  });
  assert.equal(some.status, 7, some.stderr);
  assert.match(some.stdout, /\["profile","list"\]/);
});

test('S8 doctor: the active doctor is merged with manager checks, newer versions are only reported and nothing switches', async t => {
  const h = managed(t, { origin: origin.url, active: { kind: 'release', version: '0.3.0', commit: origin.commits['0.3.0'], channel: 'stable', provenance: 'installed', selectedAs: '0.3.0' } });
  mkdirSync(join(h.paths.installedPackageRoot), { recursive: true });
  const child = { ready: true, scope: 'global-installation-only', checks: [{ check: 'node', status: 'ok', message: 'Node ok' }] };
  const delegate = async (args, options) => { assert.deepEqual(args, ['doctor']); assert.equal(options.capture, true); return { code: 0, stdout: JSON.stringify(child) }; };
  // The recorded package digest is unknown to this fixture, so first record the digest of the (empty) installed package.
  setState(h.vp, state => { state.active.packageDigest = installedPackageDigest(h.paths); });
  const before = { state: STATE_BYTES(h), view: view(h) };
  const result = await run(h, ['doctor'], { extra: { delegate } });
  assert.equal(result.code, 0, result.err + result.out);
  const report = JSON.parse(result.out);
  assert.deepEqual(report.checks.map(item => item.check), ['node', 'version-manager', 'active-version', 'available-versions']);
  assert.equal(report.ready, true);
  assert.equal(report.checks.find(item => item.check === 'active-version').status, 'ok');
  assert.match(report.checks.find(item => item.check === 'available-versions').message, /Hay versiones más nuevas: preview 0\.4\.0-preview\.1\. Para cambiar: mdd-ai use stable \| preview\. No se instala nada automáticamente/);
  assert.equal(STATE_BYTES(h), before.state, 'doctor never writes state.json');
  assert.deepEqual(view(h), before.view);
  assert.equal(readState(h.vp).active.version, '0.3.0');
});

test('doctor actions: external change, incomplete journal and a missing active CLI make the report not ready', async t => {
  const h = managed(t, { origin: origin.url, active: { kind: 'release', version: '0.3.0', commit: origin.commits['0.3.0'], channel: 'stable', provenance: 'installed', packageDigest: 'f'.repeat(64) } });
  const ok = { ready: true, scope: 'global-installation-only', checks: [] };
  const delegate = async () => ({ code: 0, stdout: JSON.stringify(ok) });
  const drift = await run(h, ['doctor'], { extra: { delegate } });
  assert.equal(drift.code, 1);
  const driftCheck = JSON.parse(drift.out).checks.find(item => item.check === 'active-version');
  assert.equal(driftCheck.status, 'action');
  assert.match(driftCheck.message, /external-change/);
  // Unparseable child output is passed through; the manager report goes to stderr.
  const odd = await run(h, ['doctor'], { extra: { delegate: async () => ({ code: 1, stdout: 'texto libre\n' }) } });
  assert.equal(odd.out, 'texto libre\n');
  assert.match(odd.err, /version-manager/);
  // No active CLI at all.
  const bare = managed(t);
  const missing = await run(bare, ['doctor']);
  assert.equal(missing.code, 1);
  const merged = JSON.parse(missing.out);
  assert.equal(merged.ready, false);
  assert.ok(merged.checks.some(item => item.check === 'active-cli' && item.status === 'action'));
  assert.match(merged.checks.find(item => item.check === 'available-versions').message, /No hay un origen registrado/);
  // Pure merge: ready needs the child AND no manager action.
  assert.equal(mergeDoctor({ ready: true, scope: 's', checks: [] }, [{ check: 'a', status: 'info', message: 'm' }]).ready, true);
  assert.equal(mergeDoctor({ ready: true, scope: 's', checks: [] }, [{ check: 'a', status: 'action', message: 'm' }]).ready, false);
  assert.equal(mergeDoctor({ ready: false, scope: 's', checks: [] }, []).ready, false);
});

test('S16/S36 a moved tag and an unreachable origin refuse selection without changing anything', async t => {
  const local = makeOrigin(t, [{ version: '0.3.0', marker: 'orig', ...REAL }]);
  const h = managed(t, { origin: local.url });
  assert.equal((await run(h, ['versions'])).code, 0);
  assert.ok(readState(h.vp).releases['0.3.0']);
  const original = local.commits['0.3.0'];
  local.moveTag('0.3.0', REAL);
  const before = { state: STATE_BYTES(h), view: view(h) };
  const exact = await run(h, ['use', '0.3.0', '--yes']);
  assert.equal(exact.code, 2);
  assert.match(exact.err, /cambió de commit/);
  const alias = await run(h, ['use', 'stable', '--yes']);
  assert.equal(alias.code, 2, 'a conflicted top candidate is refused, not replaced');
  const listing = await run(h, ['versions']);
  assert.match(listing.out, /No seleccionables\s+v0\.3\.0 \(la etiqueta cambió de commit/);
  assert.equal(readState(h.vp).releases['0.3.0'].commit, original, 'the recorded identity is never rewritten');
  assert.equal(STATE_BYTES(h), before.state);
  assert.deepEqual(view(h), before.view);
  // Restoring the tag clears the conflict, then losing the origin is disclosed instead of "no news".
  local.retag('0.3.0', original);
  assert.equal((await run(h, ['versions'])).code, 0);
  local.remove();
  const stale = await run(h, ['use', 'stable', '--yes']);
  assert.equal(stale.code, 1);
  assert.match(stale.err, /datos frescos/);
  const offline = await run(h, ['versions']);
  assert.match(offline.out, /sin conexión: datos del/);
  assert.doesNotMatch(offline.out, /al día/i);
  assert.equal(readState(h.vp).active, null);
});

test('S29/S30/R14 dev: identity with the dirty flag, tags untouched, actionable refusals and the restart reminder', async t => {
  const checkout = makeCheckout(t, { version: '0.5.0', marker: 'dev', files: realFiles() });
  const h = managed(t, { devCheckout: checkout.dir });
  const tags = checkout.tags();
  const clean = await run(h, ['use', 'dev', '--yes']);
  assert.equal(clean.code, 0, clean.err + clean.out);
  assert.match(clean.out, /compila en el checkout/);
  assert.match(clean.out, /dev: sin notas de versión/);
  assert.match(clean.out, /Listo: 0\.5\.0 activa \(dev · [0-9a-f]{7}\)/);
  assert.match(clean.out, /opencode service restart/);
  let { active } = readState(h.vp);
  assert.deepEqual([active.kind, active.version, active.commit, active.dirty], ['dev', '0.5.0', checkout.head(), false]);
  assert.match((await run(h, ['versions'])).out, /dev 0\.5\.0 · [0-9a-f]{7}/);
  checkout.makeDirty();
  const dirty = await run(h, ['use', 'dev', '--yes']);
  assert.equal(dirty.code, 0, dirty.err);
  ({ active } = readState(h.vp));
  assert.equal(active.dirty, true);
  assert.match((await run(h, ['versions'])).out, /con cambios locales/);
  assert.equal(checkout.tags(), tags, 'the manager never creates or moves tags');

  const before = { state: STATE_BYTES(h), view: view(h) };
  const refusals = [
    [['use', 'dev', '--checkout', join(h.home, 'missing'), '--yes'], /No existe el directorio/, 1],
    [['use', 'dev', '--checkout', 'relative/path', '--yes'], /No existe el directorio/, 1],
    [['use', 'dev', '--checkout', h.home, '--yes'], /package\.json legible|no es un repositorio/, 1],
  ];
  for (const [args, pattern, code] of refusals) {
    const result = await run(h, args);
    assert.equal(result.code, code, JSON.stringify(args) + result.out);
    assert.match(result.err, pattern);
    assert.doesNotMatch(result.out, /Listo:/);
  }
  assert.equal(STATE_BYTES(h), before.state);
  assert.deepEqual(view(h), before.view);
  const unset = managed(t);
  const none = await run(unset, ['use', 'dev', '--yes']);
  assert.equal(none.code, 2);
  assert.match(none.err, /No hay un checkout dev configurado/);
});

test('G3 doctor deadline: a hanging origin is reported as stale within the 15 s doctor bound (not 60 s) and nothing changes', async t => {
  const sockets = new Set();
  const server = createServer(socket => { socket.unref(); sockets.add(socket); socket.on('error', () => {}); });
  server.unref();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const closeServer = () => { for (const socket of sockets) socket.destroy(); server.close(); };
  t.after(closeServer);
  const h = managed(t, { origin: `https://127.0.0.1:${server.address().port}/hang.git` });
  const before = { state: STATE_BYTES(h), view: view(h) };
  const started = Date.now();
  const checks = managerChecks(makeCtx({ paths: h.paths, cwd: h.home }));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 10000, `the check really waited on the origin (${elapsed} ms)`);
  assert.ok(elapsed < 30000, `doctor stayed within its 15 s bound, not the 60 s fetch bound (${elapsed} ms)`);
  const available = checks.find(item => item.check === 'available-versions');
  assert.equal(available.status, 'info');
  assert.match(available.message, /No se pudo consultar el origen/);
  assert.match(available.message, /puede haber versiones más nuevas/);
  assert.equal(STATE_BYTES(h), before.state, 'doctor records nothing');
  assert.deepEqual(view(h), before.view, 'doctor changes no installed file');
  // Let the abandoned transport helper exit before the fixture directory is removed (Windows).
  await new Promise(resolve => setTimeout(resolve, 500));
  closeServer();
  await new Promise(resolve => setTimeout(resolve, 2500));
});
test('S29 dev round trips: dev -> stable -> dev and dev -> exact preview -> dev restore the same package, assets, config and identity', async t => {
  const checkout = makeCheckout(t, { version: '0.5.0', marker: 'dev', files: realFiles() });
  const h = managed(t, { origin: origin.url, devCheckout: checkout.dir });
  const tags = checkout.tags();
  const step = async (args, expected) => {
    const result = await run(h, args);
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.err}${result.out}`);
    assert.match(result.out, new RegExp(`Listo: ${expected.replace(/[.-]/g, '\\$&')} activa`));
    assert.equal(launcherKind(readFileSync(join(h.paths.binRoot, 'mdd-ai'), 'utf8')), 'manager');
    return view(h);
  };

  const dev = await step(['use', 'dev', '--yes'], '0.5.0');
  assert.equal(dev.active.kind, 'dev');
  const stable = await step(['use', 'stable', '--yes'], '0.3.0');
  assert.deepEqual([stable.active.kind, stable.active.version, stable.active.commit, stable.active.selectedAs], ['release', '0.3.0', origin.commits['0.3.0'], 'stable']);
  assert.notEqual(stable.packageJson, dev.packageJson, 'the package really changed');
  const backToDev = await step(['use', 'dev', '--yes'], '0.5.0');
  assert.deepEqual(backToDev, dev, 'dev -> stable -> dev restores package, assets, ledger, config and identity');

  const preview = await step(['use', '0.4.0-preview.1', '--yes'], '0.4.0-preview.1');
  assert.deepEqual([preview.active.kind, preview.active.version, preview.active.commit], ['release', '0.4.0-preview.1', origin.commits['0.4.0-preview.1']]);
  assert.notEqual(preview.packageJson, dev.packageJson);
  const again = await step(['use', 'dev', '--yes'], '0.5.0');
  assert.deepEqual(again, dev, 'dev -> exact preview -> dev restores the same installation');
  assert.equal(checkout.tags(), tags, 'tags of the checkout are untouched across the round trips');
  assert.equal(readState(h.vp).active.dirty, false);
});
test('link re-asserts routing through the manager and never edits the PATH without the spy', async t => {
  const h = managed(t);
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) writeFileSync(join(h.paths.binRoot, name), 'node "x/node_modules/my-driven-development/dist/cli.js" %*\n');
  const registered = [];
  const result = await run(h, ['link'], { extra: { registerPath: binRoot => { registered.push(binRoot); return 'manual'; } } });
  assert.equal(result.code, 0, result.err);
  for (const name of ['mdd-ai.cmd', 'mdd-ai']) assert.equal(launcherKind(readFileSync(join(h.paths.binRoot, name), 'utf8')), 'manager');
  assert.deepEqual(registered, [h.paths.binRoot], result.out);
  assert.match(result.out, /Lanzador instalado en/);
  assert.equal((await run(h, ['link', 'extra'])).code, 2);
  // The manager files were not rewritten by the launcher repair.
  assert.ok(MANAGER_FILES(h.paths).every(path => existsSync(path)));
});
