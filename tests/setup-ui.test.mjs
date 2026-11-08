import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { runSetupUI } from '../dist/setup-ui.js';
import { initProject, packageState, planProject, LOADER_PATH, RETIRED_TUI_PLUGIN_SPEC, TUI_CONFIG_PATH } from '../dist/setup.js';
import { MDD_ASSETS, MDD_PACKAGED_ASSETS, PACKAGE_ROOT, installedAsset, installedName } from '../dist/project-assets.js';
import { loadSettings as readSettings, saveSettings as writeSettings, defaultSettings } from '../dist/settings.js';
const loadSettings = root => readSettings(join(root, 'mdd'));
const saveSettings = (root, value) => writeSettings(join(root, 'mdd'), value);
import { doctor } from '../dist/doctor.js';
import { installationPaths } from '../dist/installation-paths.js';
import { launcherKind } from '../dist/command-link.js';
import { MANAGER_REVISION, readCurrent } from '../dist/version-manager.js';
import { readState, versionPaths } from '../dist/version-store.js';
import { BASELINE } from '../dist/versions.js';
import { needsPreparation, prepareSource } from '../scripts/setup.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Adoption accepts only the 0.2.0 baseline, while the seeded install copies the checkout's own version.
const pinVersion = (file, version) =>
  fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version }, null, 2)}\n`);
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
  // These tests exercise the installed (repair) path; the checkout bootstrap has its own tests below.
  fromCheckout: () => false,
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
  await assert.rejects(runSetupUI(root, io, { commandPlan: () => { throw new Error('probe'); }, handoff: () => { throw new Error('handoff'); } }), /terminal interactiva/);
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
  // Setup repairs the active package; it never replaces a package that differs (that is a version switch).
  const io = ui(['apply']);
  await assert.rejects(runSetupUI(root, io, noInstall), /mdd-ai use/);
  assert.equal(io.prompts.length, 0);
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), false);
});
test('package reuse also checks the packaged contracts', t => {
  const root = fixture(t);
  fs.appendFileSync(join(root, 'mdd/node_modules/my-driven-development/assets/opencode/contracts/workflow.md'), '\nstale\n');
  assert.equal(packageState(root).state, 'outdated');
});
test('update refuses without an installed package and writes nothing', async t => {
  const root = fixture(t, false);
  const before = fs.readdirSync(root);
  const io = ui(['apply']);
  await assert.rejects(runSetupUI(root, io, noInstall, { mode: 'update' }), /npm run setup/);
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
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), false);
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
  seedPackage(root);
  assert.equal(await isolated.runSetupUI(root, ui(['apply']), noInstall), 'ready');
});
test('checkout bootstrap cancellation leaves an absent global directory absent, even with a workspace config', async t => {
  const root = fixture(t, false); fs.rmSync(root, { recursive: true });
  const workspace = join(resolve(root, '..'), 'workspace'); fs.mkdirSync(workspace);
  const text = '{"engram":{"endpoint":"http://127.0.0.1:12345","project":"legacy"}}\r\n';
  fs.writeFileSync(join(workspace, 'mdd.config.json'), text);
  const io = ui([':cancel']);
  assert.equal(await runSetupUI(workspace, io, { handoff: () => assert.fail('no hand-off after cancel') }), 'cancelled');
  assert.equal(fs.existsSync(root), false); assert.equal(fs.readFileSync(join(workspace, 'mdd.config.json'), 'utf8'), text);
  assert.match(io.output.join(''), /Gestor de versiones[\s\S]*instalar el gestor/);
  assert.match(io.output.join(''), /Cancelado/);
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

// ---------------------------------------------------------------- checkout bootstrap (DD17, D23)

const stateOf = () => readState(versionPaths(installationPaths().ownedRoot));
function bootstrap(extra = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      handoff: (entry, args) => { calls.push({ entry, args }); return 0; },
      // Local stand-in for git show of the baseline: the checkout's own files are what the seeded install was copied from.
      readBaselineFile: path => { try { return fs.readFileSync(join(PACKAGE_ROOT, path)); } catch { return undefined; } },
      ...extra,
    },
  };
}
const agentName = () => installedName(MDD_ASSETS.find(name => name.includes('/agents/')));

test('checkout setup installs the manager, records the checkout and hands off without activating any package', async t => {
  const root = fixture(t, false);
  t.mock.method(globalThis, 'fetch', () => assert.fail('the bootstrap must not use the network'));
  const { calls, deps } = bootstrap();
  const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, deps), 'ready');
  const paths = installationPaths();
  assert.equal(readCurrent(paths).revision, MANAGER_REVISION);
  assert.ok(fs.existsSync(paths.managerEntry));
  for (const name of ['mdd-ai', 'mdd-ai.cmd']) assert.equal(launcherKind(fs.readFileSync(join(paths.binRoot, name), 'utf8')), 'manager', name);
  const state = stateOf();
  assert.equal(state.devCheckout, resolve(PACKAGE_ROOT));
  assert.equal(state.active, null);
  assert.equal(fs.existsSync(paths.installedPackageRoot), false, 'no package is activated by the bootstrap');
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), false);
  assert.deepEqual(calls, [{ entry: paths.managerEntry, args: ['setup', '--checkout', resolve(PACKAGE_ROOT)] }]);
  assert.equal(io.prompts.length, 1);
  const text = io.output.join('');
  assert.match(text, /Paso 1\/3[\s\S]*Paso 2\/3[\s\S]*Paso 3\/3/);
  assert.match(text, /adopción\s+no hay instalación previa/);
  assert.doesNotMatch(text, /opencode service restart/);
});

test('checkout update hands the same mode to the manager wizard and a non-zero hand-off is reported as issues', async t => {
  const root = fixture(t, false);
  const { calls, deps } = bootstrap({ handoff: (entry, args) => { calls_.push(args); return 1; } });
  const calls_ = [];
  assert.equal(await runSetupUI(root, ui(['apply']), deps, { mode: 'update' }), 'issues');
  assert.deepEqual(calls_, [['update', '--checkout', resolve(PACKAGE_ROOT)]]);
  assert.deepEqual(calls, []);
});

test('checkout setup adopts an existing 0.2.0 installation (D23): hand edits and config stay, edits are listed', async t => {
  const root = fixture(t); initProject(root, true);
  const agent = join(root, agentName());
  fs.appendFileSync(agent, '\nmy local note\n');
  const edited = fs.readFileSync(agent, 'utf8');
  const config = `${JSON.stringify(defaultSettings(), null, 2)}\n`;
  fs.writeFileSync(join(root, 'mdd/mdd.config.json'), config);
  const pkgFile = join(root, 'mdd/node_modules/my-driven-development/package.json');
  pinVersion(pkgFile, BASELINE.version);
  const packageBefore = fs.readFileSync(pkgFile, 'utf8');
  const { calls, deps } = bootstrap();
  const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, deps), 'ready');
  const state = stateOf();
  assert.equal(state.active.provenance, 'adopted');
  assert.equal(state.active.version, '0.2.0');
  assert.equal(state.active.channel, 'stable');
  assert.notEqual(state.active.kind, 'dev');
  assert.deepEqual(state.active.editedAssets, [agentName()]);
  assert.equal(state.adoption.status, 'adopted');
  assert.match(io.output.join(''), /estable 0\.2\.0 \(adoptada\)/);
  assert.match(io.output.join(''), new RegExp(agentName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.readFileSync(agent, 'utf8'), edited);
  assert.equal(fs.readFileSync(join(root, 'mdd/mdd.config.json'), 'utf8'), config);
  assert.equal(fs.readFileSync(pkgFile, 'utf8'), packageBefore);
  assert.equal(calls.length, 1);
  // Repeat: everything is current, so no consent is asked and no state is rewritten.
  const stateBytes = fs.readFileSync(versionPaths(installationPaths().ownedRoot).statePath, 'utf8');
  const again = ui([]);
  assert.equal(await runSetupUI(root, again, deps), 'ready');
  assert.equal(again.prompts.length, 0);
  assert.equal(fs.readFileSync(versionPaths(installationPaths().ownedRoot).statePath, 'utf8'), stateBytes);
  assert.equal(calls.length, 2);
});

test('adoption is refused with guidance for a different version or a packaged-content difference, and is re-evaluated later', async t => {
  const root = fixture(t);
  const pkgFile = join(root, 'mdd/node_modules/my-driven-development/package.json');
  pinVersion(pkgFile, BASELINE.version);
  const original = fs.readFileSync(pkgFile, 'utf8');
  pinVersion(pkgFile, '0.2.1');
  const { deps } = bootstrap();
  const io = ui(['apply']);
  assert.equal(await runSetupUI(root, io, deps), 'ready');
  let state = stateOf();
  assert.equal(state.active, null);
  assert.equal(state.adoption.status, 'refused');
  assert.match(state.adoption.reason, /0\.2\.1/);
  assert.match(state.adoption.reason, /mdd-ai use 0\.2\.0/);
  assert.ok(readCurrent(installationPaths()), 'the manager is installed even when adoption is refused');
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), false, 'nothing else was written');
  // A packaged-content difference is refused too.
  fs.writeFileSync(pkgFile, original);
  const differing = MDD_PACKAGED_ASSETS[0];
  const differ = bootstrap({ readBaselineFile: path => (path === differing ? Buffer.from('different baseline bytes') : fs.readFileSync(join(PACKAGE_ROOT, path))) });
  assert.equal(await runSetupUI(root, ui(['apply']), differ.deps), 'ready');
  state = stateOf();
  assert.equal(state.active, null);
  assert.match(state.adoption.reason, /difieren de la línea base/);
  assert.match(state.adoption.reason, new RegExp(differing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The refusal is re-evaluated on the next run and can now succeed.
  assert.equal(await runSetupUI(root, ui(['apply']), bootstrap().deps), 'ready');
  assert.equal(stateOf().active.provenance, 'adopted');
});

test('leftovers that do not resolve are never adopted', async t => {
  const root = fixture(t, false);
  fs.mkdirSync(join(root, 'mdd'), { recursive: true });
  fs.writeFileSync(join(root, 'mdd/package.json'), JSON.stringify({ private: true, devDependencies: { 'my-driven-development': 'file:packages/old.tgz' } }));
  assert.equal(await runSetupUI(root, ui(['apply']), bootstrap().deps), 'ready');
  const state = stateOf();
  assert.equal(state.active, null);
  assert.match(state.adoption.reason, /Hay restos de un paquete MDD/);
});
