import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runSetupUI, installLocalPackage, pruneOwnedPackages, reconcileOwnedPackage, KEPT_PACKAGES } from '../dist/setup-ui.js';
import { initProject, packageState, planProject, LOADER_PATH, RETIRED_TUI_PLUGIN_SPEC, TUI_CONFIG_PATH } from '../dist/setup.js';
import { MDD_ASSETS, MDD_PACKAGED_ASSETS, PACKAGE_ROOT, installedAsset, installedName } from '../dist/project-assets.js';
import { loadSettings as readSettings, saveSettings as writeSettings, defaultSettings } from '../dist/settings.js';
const loadSettings = root => readSettings(join(root, 'mdd'));
const saveSettings = (root, value) => writeSettings(join(root, 'mdd'), value);
import { doctor } from '../dist/doctor.js';
import { needsPreparation, prepareSource } from '../scripts/setup.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const link = (target, path) => fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
function fixture(t, installed = true) {
  const home = fs.mkdtempSync(join(tmpdir(), 'mdd-wizard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home;
  const root = join(home, 'opencode'); fs.mkdirSync(root);
  fs.writeFileSync(join(root, 'package.json'), '{"name":"consumer","private":true,"type":"module"}\n');
  if (installed) seedPackage(root);
  return root;
}
function seedPackage(root) {
  root = join(root, 'mdd'); fs.mkdirSync(root, { recursive: true }); fs.writeFileSync(join(root, 'package.json'), '{"private":true}');
  const pkg = join(root, 'node_modules/my-driven-development'); fs.mkdirSync(pkg, { recursive: true });
  fs.cpSync('dist', join(pkg, 'dist'), { recursive: true }); fs.copyFileSync('package.json', join(pkg, 'package.json'));
  fs.cpSync('assets', join(pkg, 'assets'), { recursive: true });
  // A reinstall only replaces the MDD package; its declared dependencies stay in place.
  const scope = join(root, 'node_modules/@opencode'); fs.mkdirSync(scope, { recursive: true });
  if (!fs.existsSync(join(scope, 'plugin'))) link(resolve('node_modules/@opencode/plugin'), join(scope, 'plugin'));
  if (!fs.existsSync(join(root, 'node_modules/zod'))) link(resolve('node_modules/zod'), join(root, 'node_modules/zod'));
}
function ui(lines) {
  const output = []; const prompts = [];
  return { isTTY: true, read: async prompt => { prompts.push(prompt); return lines.shift(); }, write: text => output.push(text), output, prompts };
}
// Setup never edits the user's PATH; only `mdd-ai link` does.
const noInstall = {
  installPackage: () => { throw new Error('Unexpected package install'); },
  registerPath: () => { throw new Error('Setup must not register PATH'); },
};

test('installer sources, packaged assets and setup docs are normalized UTF-8', () => {
  const sources = fs.readdirSync('src').filter(name => name.endsWith('.ts')).map(name => `src/${name}`);
  assert.ok(sources.includes('src/setup-ui.ts'));
  for (const name of [...MDD_PACKAGED_ASSETS, 'README.md', 'docs/installation.md', 'AGENTS.md', 'package.json',
    ...sources, 'scripts/setup.mjs', 'tests/setup-ui.test.mjs']) {
    const bytes = fs.readFileSync(name); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf', name);
    assert.equal(text.replace(/\r\n/g, '\n').includes('\r'), false, name); assert.ok(text.endsWith('\n'), name);
  }
});

test('one wizard invocation asks once, runs three steps and is ready with no dependency install', async t => {
  const root = fixture(t); const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, noInstall), 'ready');
  assert.deepEqual(loadSettings(root).profiles.default, { models: {}, answers: {} });
  const text = io.output.join('');
  assert.match(text, /Paso 1\/3 · Instalación global[\s\S]*Paso 2\/3 · Revisión de cambios[\s\S]*Paso 3\/3 · Aplicar y verificar[\s\S]*Listo/);
  assert.doesNotMatch(text, /Paso 4|Memoria|Engram/);
  assert.match(text, /opencode service restart/);
  assert.match(text, /puede interrumpir ejecuciones activas/);
  assert.equal(io.prompts.length, 1);
  assert.match(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), /my-driven-development\/dist\/opencode-plugin.js/);
  for (const name of MDD_ASSETS) assert.equal(fs.readFileSync(join(root, installedName(name)), 'utf8'), installedAsset(PACKAGE_ROOT, name).content, name);
  assert.doesNotMatch(fs.readFileSync(join(root, 'agents/mdd-orchestrator.md'), 'utf8'), /mdd:include/);
  // The launcher lives in MDD's own folder; the PATH is left alone.
  assert.ok(fs.existsSync(join(root, 'mdd/bin/mdd-ai.cmd')));
  assert.ok(fs.existsSync(join(root, 'mdd/bin/mdd-ai')));
  assert.match(text, /link/);
});

test('injected command plan and launcher writer are used and the PATH is never registered', async t => {
  const root = fixture(t); const calls = [];
  const plan = { binRoot: join(root, 'mdd/bin'), onPath: true, windows: true, files: [{ name: 'mdd-ai.cmd', path: join(root, 'mdd/bin/mdd-ai.cmd'), action: 'create' }], manual: 'manual' };
  const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, { ...noInstall, commandPlan: () => { calls.push('plan'); return plan; }, writeLaunchers: paths => { calls.push(['write', paths.binRoot]); return []; } }), 'ready');
  assert.deepEqual(calls.filter(call => Array.isArray(call)), [['write', join(root, 'mdd/bin')]]);
  assert.ok(calls.filter(call => call === 'plan').length >= 2);
  const text = io.output.join('');
  assert.match(text, /mdd-ai ya está en tu PATH/);
  assert.match(text, /create\s+.*mdd-ai\.cmd/);
  assert.equal(fs.existsSync(join(root, 'mdd/bin')), false, 'the injected writer replaced the real one');
});

for (const lines of [[], [':cancel'], [''], ['no'], ['2']]) {
  test(`cancel/EOF/decline writes nothing: ${JSON.stringify(lines)}`, async t => {
    const root = fixture(t); const before = fs.readdirSync(root);
    const io = ui([...lines]);
    assert.equal(await runSetupUI(root, io, noInstall), 'cancelled');
    assert.deepEqual(fs.readdirSync(root), before);
    assert.equal(fs.existsSync(join(root, LOADER_PATH)), false);
    assert.match(io.output.join(''), /Cancelado/);
  });
}
test('non-TTY setup refuses before any effect', async t => {
  const root = fixture(t); const io = { ...ui([]), isTTY: false };
  await assert.rejects(runSetupUI(root, io, { commandPlan: () => { throw new Error('probe'); }, installPackage: () => { throw new Error('install'); } }), /terminal interactiva/);
  assert.deepEqual(io.output, []);
  for (const command of ['setup', 'update']) {
    const cli = spawnSync(process.execPath, [resolve('dist/cli.js'), command], { encoding: 'utf8' });
    assert.equal(cli.status, 2); assert.match(cli.stderr, /terminal interactiva/);
  }
});
test('existing settings, including retired keys, stay byte-identical and doctor failure is reported', async t => {
  const root = fixture(t);
  const path = join(root, 'mdd/mdd.config.json');
  const text = `${JSON.stringify({ ...defaultSettings(), engram: { endpoint: 'http://127.0.0.1:54321', project: 'legacy' }, telemetry: { enabled: false } }, null, '\t')}\r\n`;
  fs.writeFileSync(path, text);
  const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, { ...noInstall, check: async () => ({ ready: false, scope: 'global-installation-only', checks: [{ status: 'action', check: 'loader', message: 'Unavailable' }] }) }), 'issues');
  assert.equal(fs.readFileSync(path, 'utf8'), text);
  assert.match(io.output.join(''), /Quedan cosas por resolver[\s\S]*loader\s+Unavailable/);
  assert.doesNotMatch(io.output.join(''), /opencode service restart/);
});
test('setup never contacts the network', async t => {
  const root = fixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('setup must not fetch'));
  assert.equal(await runSetupUI(root, ui(['apply']), noInstall), 'ready');
});
test('package reuse checks runtime modules, not only an unchanged plugin entrypoint', async t => {
  const root = fixture(t);
  assert.equal(packageState(root).state, 'matching');
  fs.appendFileSync(join(root, 'mdd/node_modules/my-driven-development/dist/safe-paths.js'), '\n// stale runtime\n');
  const state = packageState(root);
  assert.equal(state.state, 'outdated');
  assert.notEqual(state.installed.digest, state.source.digest);
  const io = ui([':cancel']);
  assert.equal(await runSetupUI(root, io, noInstall), 'cancelled');
  assert.match(io.output.join(''), /desactualizado/);
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), false);
});
test('package reuse also checks the packaged contracts', t => {
  const root = fixture(t);
  fs.appendFileSync(join(root, 'mdd/node_modules/my-driven-development/assets/opencode/contracts/workflow.md'), '\nstale\n');
  assert.equal(packageState(root).state, 'outdated');
});
test('mdd update reviews, reconciles and reinstalls an outdated owned package without touching settings', async t => {
  const root = fixture(t);
  const owned = join(root, 'mdd');
  const stale = `my-driven-development-${'a'.repeat(64)}.tgz`;
  fs.mkdirSync(join(owned, 'packages'), { recursive: true });
  fs.writeFileSync(join(owned, 'packages', stale), 'stale tarball');
  fs.writeFileSync(join(owned, 'package.json'), JSON.stringify({ private: true, devDependencies: { 'my-driven-development': `file:packages/${stale}` } }));
  const settings = defaultSettings(); settings.profiles.default.answers = { mode: 'automatic' };
  saveSettings(root, settings);
  const config = fs.readFileSync(join(owned, 'mdd.config.json'), 'utf8');
  fs.appendFileSync(join(owned, 'node_modules/my-driven-development/dist/safe-paths.js'), '\n// stale runtime\n');
  const io = ui(['apply']);
  let installs = 0;
  assert.equal(await runSetupUI(root, io, { ...noInstall, installPackage: target => { assert.equal(target, root); installs++; seedPackage(root); } }, { mode: 'update' }), 'ready');
  assert.equal(installs, 1);
  assert.equal(io.prompts.length, 1);
  assert.match(io.output.join(''), /Paso 1\/3 · Instalación existente[\s\S]*Paso 2\/3[\s\S]*Paso 3\/3/);
  assert.match(io.output.join(''), /Actualizar el paquete MDD instalado/);
  assert.equal(packageState(root).state, 'matching');
  assert.equal(fs.readFileSync(join(owned, 'mdd.config.json'), 'utf8'), config);
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), true);
  // The referenced stale tarball is kept until a newer one replaces the reference.
  assert.equal(fs.existsSync(join(owned, 'packages', stale)), true);
});
test('update refuses without an installed package and writes nothing', async t => {
  const root = fixture(t, false);
  const before = fs.readdirSync(root);
  const io = ui(['apply']);
  await assert.rejects(runSetupUI(root, io, noInstall, { mode: 'update' }), /mdd setup/);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(io.prompts.length, 0);
});
test('update of a matching package reports that everything is up to date', async t => {
  const root = fixture(t); initProject(root, true);
  const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, noInstall, { mode: 'update' }), 'ready');
  assert.match(io.output.join(''), /al día: coincide con el paquete de origen/);
});
test('leftover or unsupported owned package is refused by both setup and update', async t => {
  const root = fixture(t, false);
  const owned = join(root, 'mdd'); fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(join(owned, 'package.json'), JSON.stringify({ private: true, devDependencies: { 'my-driven-development': 'file:packages/old.tgz' } }));
  assert.equal(packageState(root).state, 'foreign');
  await assert.rejects(runSetupUI(root, ui(['apply']), noInstall), /broken or unsupported/);
  await assert.rejects(runSetupUI(root, ui(['apply']), noInstall, { mode: 'update' }), /broken or unsupported/);
  assert.throws(() => reconcileOwnedPackage(root), /outdated/);
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), false);
});
test('reconcile removes only the owned package and its dependency entry', async t => {
  const root = fixture(t);
  const owned = join(root, 'mdd');
  fs.writeFileSync(join(owned, 'package.json'), JSON.stringify({ private: true, devDependencies: { 'my-driven-development': 'file:packages/x.tgz', other: '1.0.0' } }));
  assert.throws(() => reconcileOwnedPackage(root), /outdated/);
  fs.appendFileSync(join(owned, 'node_modules/my-driven-development/dist/safe-paths.js'), '\n// stale runtime\n');
  reconcileOwnedPackage(root);
  assert.equal(fs.existsSync(join(owned, 'node_modules/my-driven-development')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(owned, 'package.json'), 'utf8')), { private: true, devDependencies: { other: '1.0.0' } });
  assert.equal(fs.existsSync(join(owned, 'node_modules/@opencode/plugin')), true);
  assert.equal(fs.existsSync(join(owned, 'node_modules/zod')), true);
  assert.equal(packageState(root).state, 'absent');
});
test('package pruning keeps the referenced tarball and the newest builds', t => {
  const root = fixture(t, false);
  const owned = join(root, 'mdd');
  fs.mkdirSync(join(owned, 'packages'), { recursive: true });
  const names = Array.from({ length: 6 }, (_, index) => `my-driven-development-${index.toString(16).repeat(64)}.tgz`);
  names.forEach((name, index) => {
    const path = join(owned, 'packages', name);
    fs.writeFileSync(path, 'tarball');
    fs.utimesSync(path, 1000 + index, 1000 + index);
  });
  fs.writeFileSync(join(owned, 'packages', 'unrelated.txt'), 'keep me');
  fs.writeFileSync(join(owned, 'package.json'), JSON.stringify({ private: true, devDependencies: { 'my-driven-development': `file:packages/${names[0]}` } }));
  assert.deepEqual(pruneOwnedPackages(root).sort(), [names[1], names[2]].sort());
  assert.deepEqual(fs.readdirSync(join(owned, 'packages')).sort(),
    ['unrelated.txt', names[0], ...names.slice(3)].sort());
  assert.equal(KEPT_PACKAGES, 3);
  assert.deepEqual(pruneOwnedPackages(root), []);
  assert.deepEqual(pruneOwnedPackages(fixture(t, false)), [], 'no packages directory');
});
test('consumer package install is explicitly reviewed and uses the existing init/doctor boundary', async t => {
  const root = fixture(t, false); const io = ui(['apply']); let calls = 0;
  assert.equal(await runSetupUI(root, io, { ...noInstall, installPackage: target => { assert.equal(target, root); calls++; seedPackage(root); } }), 'ready');
  assert.equal(calls, 1); assert.match(io.output.join(''), /--ignore-scripts/);
  const report = await doctor(root);
  assert.equal(report.ready, true, JSON.stringify(report, null, 2));
  assert.ok(fs.existsSync(join(root, 'mdd/mdd.config.json')), 'a fresh install saves default settings');
});
test('wizard has no target prompt and does not change process cwd', async t => {
  fixture(t); const cwd = process.cwd();
  const io = ui(['apply']);
  assert.equal(await runSetupUI(cwd, io, noInstall), 'ready');
  assert.ok(io.prompts.every(prompt => !prompt.includes('Workspace')));
  assert.match(io.output.join(''), /no se modifica/);
  assert.equal(process.cwd(), cwd);
});
test('conflicts preflight before any prompt, dependency install or write', async t => {
  const root = fixture(t, false); const target = join(root, installedName(MDD_ASSETS[0])); fs.mkdirSync(resolve(target, '..'), { recursive: true }); fs.writeFileSync(target, 'user edited');
  const io = ui(['apply']);
  await assert.rejects(runSetupUI(root, io, noInstall), /refuses to overwrite.*mdd-orchestrator/);
  assert.equal(io.prompts.length, 0);
  assert.equal(fs.readFileSync(target, 'utf8'), 'user edited'); assert.equal(fs.existsSync(join(root, 'mdd')), false);
});
test('owned updates require exact previously recorded content; later user edits are protected', t => {
  const root = fixture(t); initProject(root);
  const name = installedName(MDD_ASSETS[0]); const path = join(root, name); const ledger = join(root, 'mdd/setup-assets.json');
  const manifest = JSON.parse(fs.readFileSync(ledger, 'utf8')); const old = 'previous bundled actor\n';
  fs.writeFileSync(path, old); manifest[name] = hash(old); fs.writeFileSync(ledger, JSON.stringify(manifest));
  assert.equal(planProject(root, true).find(file => file.name === name).action, 'update');
  assert.throws(() => initProject(root), /refuses to overwrite/);
  initProject(root, true); assert.equal(fs.readFileSync(path, 'utf8'), installedAsset(PACKAGE_ROOT, MDD_ASSETS[0]).content);
  fs.writeFileSync(path, 'user edit'); assert.throws(() => planProject(root, true), /refuses to overwrite/);
  assert.equal(fs.readFileSync(path, 'utf8'), 'user edit');
});
test('setup reviews and removes only the retired sidebar entry from cli.json', async t => {
  const root = fixture(t);
  const original = { theme: 'mine', plugins: ['other', RETIRED_TUI_PLUGIN_SPEC] };
  fs.writeFileSync(join(root, TUI_CONFIG_PATH), JSON.stringify(original));
  const cancel = ui([':cancel']);
  assert.equal(await runSetupUI(root, cancel, noInstall), 'cancelled');
  assert.match(cancel.output.join(''), /update\s+cli\.json/);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, TUI_CONFIG_PATH), 'utf8')), original);
  assert.equal(await runSetupUI(root, ui(['apply']), noInstall), 'ready');
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, TUI_CONFIG_PATH), 'utf8')), { theme: 'mine', plugins: ['other'] });
  const again = ui([':cancel']);
  await runSetupUI(root, again, noInstall);
  assert.doesNotMatch(again.output.join(''), /cli\.json/);
});
test('a second setup run of a matching install has nothing to apply', async t => {
  const root = fixture(t);
  assert.equal(await runSetupUI(root, ui(['apply']), noInstall), 'ready');
  const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, noInstall), 'ready');
  assert.match(io.output.join(''), /Todo está al día/);
});
test('source checkout ships assets without an auto-discovered MDD loader', () => {
  assert.equal(fs.existsSync('.opencode/plugins/mdd.ts'), false);
  for (const name of MDD_PACKAGED_ASSETS) {
    assert.ok(fs.existsSync(name), name);
    assert.equal(fs.existsSync(name.replace('assets/opencode/', '.opencode/')), false);
  }
  assert.equal(fs.existsSync('dist/engram-install.js'), false);
});
test('source bootstrap without dist supports help and non-TTY rejection without changes', t => {
  const root = fixture(t, false); fs.mkdirSync(join(root, 'scripts')); fs.copyFileSync('scripts/setup.mjs', join(root, 'scripts/setup.mjs'));
  const command = args => spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  const help = command(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /npm run setup/);
  const result = command([]); assert.equal(result.status, 1); assert.match(result.stderr, /terminal interactiva/);
  for (const name of ['setup', 'update', 'doctor', 'link']) {
    const extra = command([name, 'extra']); assert.equal(extra.status, 1); assert.match(extra.stderr, new RegExp(`Uso: mdd-ai ${name}`));
  }
  assert.deepEqual(fs.readdirSync(root).sort(), ['package.json', 'scripts']);
});
test('source launcher forwards only the retained commands to the built CLI', t => {
  const root = fixture(t, false);
  const script = resolve('scripts/setup.mjs');
  const run = args => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
  const help = run(['--help']); assert.equal(help.status, 0, help.stderr); assert.match(help.stdout, /mdd-ai profile list/);
  const list = run(['profile', 'list']); assert.equal(list.status, 0, list.stderr); assert.equal(list.stdout, '* default\n');
  const report = run(['doctor']); assert.equal(report.status, 1); assert.equal(JSON.parse(report.stdout).ready, false);
  // Anything else is routed to setup, which needs a terminal.
  for (const retired of [['init'], ['telemetry', 'status'], ['workers']]) {
    const result = run(retired); assert.notEqual(result.status, 0, retired.join(' '));
  }
  assert.deepEqual(fs.readdirSync(root), ['package.json']);
});
test('source preparation offers one consent before mocked dependency install/build and stops on failure', async t => {
  const root = fixture(t, false); const calls = [];
  const execute = (binary, args, options) => { calls.push({ binary, args, options }); return { status: 0 }; };
  await assert.rejects(prepareSource(root, { ...ui(['apply']), isTTY: false }, execute, process.execPath), /terminal interactiva/);
  assert.equal(await prepareSource(root, ui(['no']), execute, process.execPath), false); assert.equal(calls.length, 0);
  assert.equal(await prepareSource(root, ui([]), execute, process.execPath), false); assert.equal(calls.length, 0);
  assert.equal(await prepareSource(root, ui(['apply']), execute, process.execPath), true); assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.args.includes('--ignore-scripts') && call.options.cwd === root));
  assert.equal(calls[0].args[1], 'ci'); assert.equal(calls[1].args[2], 'build');
  await assert.rejects(prepareSource(root, ui(['apply']), () => ({ status: 1 }), process.execPath), /Falló la preparación/);
  await assert.rejects(prepareSource(root, ui(['apply']), execute, join(root, 'missing-npm.js')), /CLI de npm/);
});
test('needsPreparation requires the build and the pinned plugin dependency', t => {
  const root = fixture(t, false);
  assert.equal(needsPreparation(root), true);
  fs.mkdirSync(join(root, 'dist')); fs.writeFileSync(join(root, 'dist/cli.js'), '');
  assert.equal(needsPreparation(root), true, 'missing @opencode/plugin');
  fs.mkdirSync(join(root, 'node_modules/@opencode/plugin/dist/promise'), { recursive: true });
  fs.writeFileSync(join(root, 'node_modules/@opencode/plugin/dist/promise/index.js'), '');
  assert.equal(needsPreparation(root), false, 'no src means nothing to rebuild');
  fs.mkdirSync(join(root, 'src')); fs.writeFileSync(join(root, 'src/extra.ts'), '');
  assert.equal(needsPreparation(root), true, 'a source without output');
});
test('source first run without dist builds locally and reaches the same wizard in isolation', async t => {
  const root = fixture(t, false);
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) fs.copyFileSync(name, join(root, name));
  for (const name of ['src', 'node_modules']) fs.cpSync(name, join(root, name), { recursive: true });
  for (const name of MDD_PACKAGED_ASSETS) { fs.mkdirSync(resolve(join(root, name), '..'), { recursive: true }); fs.copyFileSync(name, join(root, name)); }
  assert.equal(fs.existsSync(join(root, 'dist')), false); assert.equal(needsPreparation(root), true);
  const env = { ...process.env, npm_config_offline: 'true', npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'empty.npmrc'), npm_config_update_notifier: 'false' };
  let installs = 0;
  assert.equal(await prepareSource(root, ui(['apply']), (binary, args, options) => {
    if (args[1] === 'ci') { installs++; return { status: 0 }; } // Dependency installation is mocked; cached dependencies were preseeded.
    return spawnSync(binary, args, { ...options, env, stdio: 'pipe', encoding: 'utf8' });
  }), true);
  assert.equal(installs, 1); assert.equal(fs.existsSync(join(root, 'dist/cli.js')), true);
  assert.equal(needsPreparation(root), false);
  const isolated = await import(pathToFileURL(join(root, 'dist/setup-ui.js')));
  assert.equal(await isolated.runSetupUI(root, ui(['apply']), { ...noInstall, installPackage: seedPackage }), 'ready');
});
test('package installer packs local source and installs the artifact without scripts or globals', t => {
  const root = fixture(t, false); const calls = [];
  installLocalPackage(root, (binary, args, options) => {
    calls.push({ binary, args, options });
    if (args[1] === 'pack') fs.writeFileSync(join(args.at(-1), 'my-driven-development-0.1.0.tgz'), 'mock local tarball');
    return args[1] === 'pack' ? '[{"filename":"my-driven-development-0.1.0.tgz"}]' : '';
  });
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.binary === process.execPath && call.args.includes('--ignore-scripts')));
  assert.ok(calls[1].args.includes('--save-dev')); assert.equal(calls[1].options.cwd, join(root, 'mdd'));
  assert.ok(!calls.some(call => call.args.includes('-g')));
  const artifact = `my-driven-development-${hash('mock local tarball')}.tgz`;
  assert.ok(calls[1].args.some(arg => arg.endsWith(artifact)));
  assert.ok(fs.existsSync(join(root, 'mdd/packages', artifact)));
  assert.throws(() => installLocalPackage(root, () => '[{"filename":"../evil.tgz"}]'), /Unexpected local package output/);
});
test('real offline global install applies once from cwd A and installed wizard reuses it from cwd B', async t => {
  const root = fixture(t, false);
  const owned = join(root, 'mdd'); fs.mkdirSync(owned);
  const home = resolve(root, '..');
  const a = join(home, 'workspace A'); const b = join(home, 'workspace B'); fs.mkdirSync(a); fs.mkdirSync(b);
  const legacy = '{"legacy":"keep bytes"}\r\n'; fs.writeFileSync(join(a, 'mdd.config.json'), legacy);
  fs.writeFileSync(join(root, 'opencode.jsonc'), '// user configuration\n{"default_agent":"build","provider":{"custom":{"name":"keep"}}}');
  fs.writeFileSync(join(root, 'opencode.json'), '{"default_agent":"plan","provider":{"other":{"name":"unchanged"}}}\r\n');
  fs.writeFileSync(join(root, 'package-lock.json'), '{"name":"unrelated","lockfileVersion":3}\r\n');
  fs.mkdirSync(join(root, 'agents')); fs.writeFileSync(join(root, 'agents/custom.md'), 'user actor');
  const untouched = ['package.json', 'package-lock.json', 'opencode.json', 'opencode.jsonc', 'agents/custom.md'].map(name => [name, fs.readFileSync(join(root, name), 'utf8')]);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  delete pkg.exports; delete pkg.bin; delete pkg.scripts; pkg.name = 'isolated-consumer';
  fs.writeFileSync(join(owned, 'package.json'), JSON.stringify(pkg));
  fs.copyFileSync('package-lock.json', join(owned, 'package-lock.json'));
  fs.cpSync('node_modules', join(owned, 'node_modules'), { recursive: true });
  const env = { ...process.env, npm_config_offline: 'true', npm_config_cache: join(root, 'npm-cache'), npm_config_userconfig: join(root, 'empty.npmrc'), npm_config_update_notifier: 'false' };
  let installs = 0;
  const originalCwd = process.cwd();
  try {
    process.chdir(a);
    assert.equal(await runSetupUI(process.cwd(), ui(['apply']), { ...noInstall, installPackage: target => {
      installs++; installLocalPackage(target, (binary, args, options) => execFileSync(binary, args, { ...options, env }));
    } }), 'ready');
  } finally { process.chdir(originalCwd); }
  const installedUI = pathToFileURL(join(owned, 'node_modules/my-driven-development/dist/setup-ui.js')).href;
  const repeat = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {runSetupUI} = await import(${JSON.stringify(installedUI)});
    const answers = ['apply'];
    const result = await runSetupUI(process.cwd(), {isTTY:true, read:async()=>answers.shift(), write(){}}, {
      installPackage:()=>{throw new Error('must not reinstall')}, registerPath:()=>{throw new Error('must not register PATH')}
    }); if(result !== 'ready') process.exit(1);
  `], { cwd: b, env, encoding: 'utf8' });
  assert.equal(repeat.status, 0, repeat.stderr); assert.equal(installs, 1);
  for (const [name, text] of untouched) assert.equal(fs.readFileSync(join(root, name), 'utf8'), text);
  assert.deepEqual(fs.readdirSync(a), ['mdd.config.json']); assert.equal(fs.readFileSync(join(a, 'mdd.config.json'), 'utf8'), legacy);
  assert.deepEqual(fs.readdirSync(b), []);
  for (const name of MDD_ASSETS) assert.equal(fs.readFileSync(join(root, installedName(name)), 'utf8'), installedAsset(PACKAGE_ROOT, name).content, name);
  const cli = join(owned, 'node_modules/my-driven-development/dist/cli.js');
  const create = spawnSync(process.execPath, [cli, 'profile', 'create', 'shared'], { cwd: a, env, encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const list = spawnSync(process.execPath, [cli, 'profile', 'list'], { cwd: b, env, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr); assert.match(list.stdout, /\* shared/);
  const report = spawnSync(process.execPath, [cli, 'doctor'], { cwd: b, env, encoding: 'utf8' });
  assert.equal(report.status, 0, report.stdout + report.stderr); assert.equal(JSON.parse(report.stdout).ready, true);
  assert.deepEqual(fs.readdirSync(a), ['mdd.config.json']); assert.deepEqual(fs.readdirSync(b), []);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('my-driven-development/opencode-plugin'))"], { cwd: owned, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pathToFileURL(join(owned, 'node_modules/my-driven-development/dist/opencode-plugin.js')).href);
  const dependency = JSON.parse(fs.readFileSync(join(owned, 'package.json'))).devDependencies['my-driven-development'];
  assert.equal(dependency.startsWith('file:packages/'), true);
  assert.equal(fs.existsSync(join(owned, dependency.slice(5))), true);
  const loader = importLoader(root);
  assert.equal(loader.status, 0, loader.stderr);
});
test('absent global directory stays absent after preview cancellation, even with a workspace config', async t => {
  const root = fixture(t, false); fs.rmSync(root, { recursive: true });
  const workspace = join(resolve(root, '..'), 'workspace'); fs.mkdirSync(workspace);
  const text = '{"engram":{"endpoint":"http://127.0.0.1:12345","project":"legacy"}}\r\n';
  fs.writeFileSync(join(workspace, 'mdd.config.json'), text);
  const io = ui([':cancel']);
  assert.equal(await runSetupUI(workspace, io, noInstall), 'cancelled');
  assert.equal(fs.existsSync(root), false); assert.equal(fs.readFileSync(join(workspace, 'mdd.config.json'), 'utf8'), text);
  assert.match(io.output.join(''), /create\s+agents\/mdd-orchestrator\.md/);
});
for (const loader of ["export { default } from 'my-driven-development/opencode-plugin';\n", "export { default } from '../../dist/opencode-plugin.js';\n"]) {
  test(`global known loader migration requires Apply: ${loader.trim()}`, async t => {
    const root = fixture(t); fs.mkdirSync(join(root, 'plugins')); fs.writeFileSync(join(root, LOADER_PATH), loader);
    assert.equal(await runSetupUI(root, ui([':cancel']), noInstall), 'cancelled');
    assert.equal(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), loader);
    assert.equal(await runSetupUI(root, ui(['apply']), noInstall), 'ready');
    assert.match(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), /\.\.\/mdd\/node_modules/);
  });
}
test('an unknown loader is refused before review', async t => {
  const root = fixture(t); fs.mkdirSync(join(root, 'plugins')); fs.writeFileSync(join(root, LOADER_PATH), 'export default {};\n');
  const io = ui(['apply']);
  await assert.rejects(runSetupUI(root, io, noInstall), /refuses to overwrite different content: plugins\/mdd\.ts/);
  assert.equal(io.prompts.length, 0);
  assert.equal(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), 'export default {};\n');
});
function importLoader(root) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `const plugin = await import(${JSON.stringify(pathToFileURL(join(root, LOADER_PATH)).href)}); if (plugin.default.id !== 'mdd' || typeof plugin.default.setup !== 'function') process.exit(1);`], { encoding: 'utf8' });
}
