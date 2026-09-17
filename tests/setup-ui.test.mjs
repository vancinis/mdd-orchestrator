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
import { packageState } from '../dist/setup.js';
import { detectEngram, downloadRelease, engramOffer, installEngram, extractWindowsBinary, RELEASE_HASHES } from '../dist/engram-install.js';
import { initProject, planProject, LOADER_PATH } from '../dist/setup.js';
import { MDD_ASSETS } from '../dist/project-assets.js';
import { loadSettings as readSettings, saveSettings as writeSettings, defaultSettings } from '../dist/settings.js';
const loadSettings = root => readSettings(join(root, 'mdd'));
const saveSettings = (root, value) => writeSettings(join(root, 'mdd'), value);
import { doctor } from '../dist/doctor.js';
import { needsPreparation, prepareSource } from '../scripts/setup.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
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
  const scope = join(root, 'node_modules/@opencode-ai'); fs.mkdirSync(scope, { recursive: true });
  // A reinstall only replaces the MDD package; unrelated dependencies stay in place.
  if (!fs.existsSync(join(scope, 'plugin'))) fs.symlinkSync(resolve('node_modules/@opencode-ai/plugin'), join(scope, 'plugin'), process.platform === 'win32' ? 'junction' : 'dir');
}
function ui(lines) {
  const output = []; const prompts = [];
  return { isTTY: true, read: async prompt => { prompts.push(prompt); return lines.shift(); }, write: text => output.push(text), output, prompts };
}
const noMemory = { detect: () => ({ status: 'not-found' }), installMemory: () => { throw new Error('Unexpected download'); }, installPackage: () => { throw new Error('Unexpected package install'); } };

test('installer sources, packaged assets and setup docs are normalized UTF-8', () => {
  for (const name of [...MDD_ASSETS, 'README.md', 'docs/setup.md', 'AGENTS.md', 'package.json',
    ...['setup', 'setup-ui', 'engram-install', 'project-assets', 'safe-paths', 'command-link', 'pr-body', 'doctor', 'settings', 'settings-cli', 'config-ui', 'tui', 'model-catalog', 'cli', 'local-files'].map(name => `src/${name}.ts`),
    'scripts/setup.mjs', 'scripts/extract-engram.ps1', 'tests/setup-ui.test.mjs']) {
    const bytes = fs.readFileSync(name); const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf', name);
    assert.equal(text.replace(/\r\n/g, '\n').includes('\r'), false, name); assert.ok(text.endsWith('\n'), name);
  }
});

test('one wizard invocation skips optional memory and is ready with no dependency install', async t => {
  const root = fixture(t); const io = ui(['', 'apply']);
  assert.equal(await runSetupUI(root, io, noMemory), 'ready');
  assert.equal(loadSettings(root).engram, undefined);
  assert.deepEqual(loadSettings(root).profiles.default, { models: {}, answers: {} });
  assert.match(io.output.join(''), /Paso 1\/4[\s\S]*Paso 2\/4[\s\S]*Paso 3\/4[\s\S]*Paso 4\/4[\s\S]*Listo/);
  assert.equal(io.prompts.length, 2);
  assert.match(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), /my-driven-development\/dist\/opencode-plugin.js/);
});
test('found Engram is optional and reuse performs zero downloads or executions', async t => {
  const root = fixture(t); const binary = join(root, 'existing.exe'); fs.writeFileSync(binary, 'mock');
  const deps = { ...noMemory, detect: () => ({ status: 'compatible', version: '1.20.0', binary }) };
  assert.equal(await runSetupUI(root, ui(['use', 'apply']), deps), 'ready');
  assert.deepEqual(loadSettings(root).engram, { mode: 'local', binary, dataDirectory: join(root, 'mdd/memory') });
  assert.equal(fs.existsSync(join(root, 'mdd/memory')), false);
  assert.equal(await runSetupUI(root, ui(['off', 'apply']), deps), 'ready');
  assert.equal(loadSettings(root).engram, undefined); assert.equal(fs.readFileSync(binary, 'utf8'), 'mock');
});
for (const lines of [[], [':cancel'], ['', ':cancel'], ['', 'no'], ['install', ':cancel']]) {
  test(`cancel/EOF/decline writes nothing: ${JSON.stringify(lines)}`, async t => {
    const root = fixture(t); const before = fs.readdirSync(root);
    assert.equal(await runSetupUI(root, ui([...lines]), noMemory), 'cancelled');
    assert.deepEqual(fs.readdirSync(root), before);
  });
}
test('non-TTY setup refuses before detection or effects', async t => {
  const root = fixture(t); const io = { ...ui([]), isTTY: false };
  await assert.rejects(runSetupUI(root, io, { detect: () => { throw new Error('probe'); } }), /terminal interactiva/);
  const cli = spawnSync(process.execPath, [resolve('dist/cli.js'), 'setup'], { encoding: 'utf8' });
  assert.equal(cli.status, 2); assert.match(cli.stderr, /terminal interactiva/);
});
test('legacy opt-in config stays byte-identical and doctor failure never silently disables it', async t => {
  const root = fixture(t); const settings = defaultSettings(); settings.engram = { endpoint: 'http://127.0.0.1:54321', project: 'legacy' };
  saveSettings(root, settings); const before = fs.readFileSync(join(root, 'mdd/mdd.config.json'), 'utf8');
  const io = ui(['', 'apply']);
  assert.equal(await runSetupUI(root, io, { ...noMemory, check: async () => ({ ready: false, checks: [{ status: 'action', check: 'engram', message: 'Unavailable' }] }) }), 'issues');
  assert.equal(fs.readFileSync(join(root, 'mdd/mdd.config.json'), 'utf8'), before);
  assert.doesNotMatch(io.output.join(''), /Cerrá y reiniciá OpenCode/);
});
test('wizard preserves global endpoint opt-in without contacting the memory service', async t => {
  const root = fixture(t); const settings = defaultSettings();
  settings.engram = { endpoint: 'http://127.0.0.1:12345', project: 'explicit' }; saveSettings(root, settings);
  const original = globalThis.fetch; globalThis.fetch = () => assert.fail('wizard must not contact memory');
  try { assert.equal(await runSetupUI(root, ui(['', 'apply']), noMemory), 'ready'); }
  finally { globalThis.fetch = original; }
  assert.deepEqual(loadSettings(root).engram, settings.engram);
});
test('package reuse checks runtime modules, not only an unchanged plugin entrypoint', async t => {
  const root = fixture(t);
  assert.equal(packageState(root).state, 'matching');
  fs.appendFileSync(join(root, 'mdd/node_modules/my-driven-development/dist/safe-paths.js'), '\n// stale runtime\n');
  const state = packageState(root);
  assert.equal(state.state, 'outdated');
  assert.notEqual(state.installed.digest, state.source.digest);
  const io = ui(['', ':cancel']);
  assert.equal(await runSetupUI(root, io, noMemory), 'cancelled');
  assert.match(io.output.join(''), /desactualizado/);
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), false);
});
test('mdd update reviews, reconciles and reinstalls an outdated owned package without touching settings', async t => {
  const root = fixture(t);
  const owned = join(root, 'mdd');
  const stale = `my-driven-development-${'a'.repeat(64)}.tgz`;
  fs.mkdirSync(join(owned, 'packages'), { recursive: true });
  fs.writeFileSync(join(owned, 'packages', stale), 'stale tarball');
  fs.writeFileSync(join(owned, 'package.json'), JSON.stringify({ private: true, devDependencies: { 'my-driven-development': `file:packages/${stale}` } }));
  const settings = defaultSettings(); settings.engram = { endpoint: 'http://127.0.0.1:12345', project: 'keep' };
  saveSettings(root, settings);
  const config = fs.readFileSync(join(owned, 'mdd.config.json'), 'utf8');
  fs.appendFileSync(join(owned, 'node_modules/my-driven-development/dist/safe-paths.js'), '\n// stale runtime\n');
  const io = ui(['apply']);
  let installs = 0;
  assert.equal(await runSetupUI(root, io, { ...noMemory, installPackage: target => { assert.equal(target, root); installs++; seedPackage(root); } }, { mode: 'update' }), 'ready');
  assert.equal(installs, 1);
  assert.equal(io.prompts.length, 1, 'update must not ask the memory question');
  assert.match(io.output.join(''), /Paso 1\/3[\s\S]*Paso 2\/3[\s\S]*Paso 3\/3/);
  assert.match(io.output.join(''), /Actualizar el paquete MDD instalado/);
  assert.equal(packageState(root).state, 'matching');
  assert.equal(fs.readFileSync(join(owned, 'mdd.config.json'), 'utf8'), config);
  assert.deepEqual(loadSettings(root).engram, settings.engram);
  assert.equal(fs.existsSync(join(root, LOADER_PATH)), true);
});
test('update refuses without an installed package and never asks for memory', async t => {
  const root = fixture(t, false);
  const before = fs.readdirSync(root);
  const io = ui(['apply']);
  await assert.rejects(runSetupUI(root, io, { ...noMemory, detect: () => assert.fail('update must not probe memory') }, { mode: 'update' }), /mdd setup/);
  assert.deepEqual(fs.readdirSync(root), before);
  assert.equal(io.prompts.length, 0);
});
test('leftover or unsupported owned package is refused by both setup and update', async t => {
  const root = fixture(t, false);
  const owned = join(root, 'mdd'); fs.mkdirSync(owned, { recursive: true });
  fs.writeFileSync(join(owned, 'package.json'), JSON.stringify({ private: true, devDependencies: { 'my-driven-development': 'file:packages/old.tgz' } }));
  assert.equal(packageState(root).state, 'foreign');
  await assert.rejects(runSetupUI(root, ui(['', 'apply']), noMemory), /broken or unsupported/);
  await assert.rejects(runSetupUI(root, ui(['apply']), noMemory, { mode: 'update' }), /broken or unsupported/);
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
  assert.equal(fs.existsSync(join(owned, 'node_modules/@opencode-ai/plugin')), true);
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
});
test('consumer package install is explicitly reviewed and uses the existing init/doctor boundary', async t => {
  const root = fixture(t, false); const io = ui(['', 'apply']); let calls = 0;
  assert.equal(await runSetupUI(root, io, { ...noMemory, installPackage: target => { assert.equal(target, root); calls++; seedPackage(root); } }), 'ready');
  assert.equal(calls, 1); assert.match(io.output.join(''), /--ignore-scripts/);
  assert.equal((await doctor(root)).ready, true);
});
test('wizard has no target prompt and does not change process cwd', async t => {
  const root = fixture(t); const cwd = process.cwd();
  const io = ui(['', 'apply']);
  assert.equal(await runSetupUI(cwd, io, noMemory), 'ready');
  assert.ok(io.prompts.every(prompt => !prompt.includes('Workspace')));
  assert.equal(process.cwd(), cwd);
});
test('conflicts preflight before detection, dependency installs or writes', async t => {
  const root = fixture(t, false); const target = join(root, MDD_ASSETS[0].replace('assets/opencode/', '')); fs.mkdirSync(resolve(target, '..'), { recursive: true }); fs.writeFileSync(target, 'user edited');
  await assert.rejects(runSetupUI(root, ui(['']), { detect: () => { throw new Error('should not detect'); } }), /refuses to overwrite.*mdd-orchestrator/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'user edited'); assert.equal(fs.existsSync(join(root, '.mdd')), false);
});
test('owned updates require exact previously recorded content; later user edits are protected', t => {
  const root = fixture(t); initProject(root);
  const name = MDD_ASSETS[0].replace('assets/opencode/', ''); const path = join(root, name); const ledger = join(root, 'mdd/setup-assets.json');
  const manifest = JSON.parse(fs.readFileSync(ledger, 'utf8')); const old = 'previous bundled actor\n';
  fs.writeFileSync(path, old); manifest[name] = hash(old); fs.writeFileSync(ledger, JSON.stringify(manifest));
  assert.equal(planProject(root, true).find(file => file.name === name).action, 'update');
  assert.throws(() => initProject(root), /refuses to overwrite/);
  initProject(root, true); assert.equal(fs.readFileSync(path, 'utf8'), fs.readFileSync(MDD_ASSETS[0], 'utf8'));
  fs.writeFileSync(path, 'user edit'); assert.throws(() => planProject(root, true), /refuses to overwrite/);
  assert.equal(fs.readFileSync(path, 'utf8'), 'user edit');
});
test('source checkout ships assets without an auto-discovered MDD loader', () => {
  assert.equal(fs.existsSync('.opencode/plugins/mdd.ts'), false);
  for (const name of MDD_ASSETS) {
    assert.ok(fs.existsSync(name));
    assert.equal(fs.existsSync(name.replace('assets/opencode/', '.opencode/')), false);
  }
});
test('source bootstrap without dist supports help and non-TTY rejection without changes', t => {
  const root = fixture(t, false); fs.mkdirSync(join(root, 'scripts')); fs.copyFileSync('scripts/setup.mjs', join(root, 'scripts/setup.mjs'));
  const command = args => spawnSync(process.execPath, [join(root, 'scripts/setup.mjs'), ...args], { cwd: root, encoding: 'utf8' });
  const help = command(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /npm run setup/);
  const result = command([]); assert.equal(result.status, 1); assert.match(result.stderr, /terminal interactiva/);
  assert.deepEqual(fs.readdirSync(root).sort(), ['package.json', 'scripts']);
});
test('source preparation offers one consent before mocked dependency install/build and stops on failure', async t => {
  const root = fixture(t, false); const calls = [];
  const execute = (binary, args, options) => { calls.push({ binary, args, options }); return { status: 0 }; };
  assert.equal(await prepareSource(root, ui(['no']), execute, process.execPath), false); assert.equal(calls.length, 0);
  assert.equal(await prepareSource(root, ui(['apply']), execute, process.execPath), true); assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.args.includes('--ignore-scripts') && call.options.cwd === root));
  assert.equal(calls[0].args[1], 'ci'); assert.equal(calls[1].args[2], 'build');
  await assert.rejects(prepareSource(root, ui(['apply']), () => ({ status: 1 }), process.execPath), /Falló la preparación/);
});
test('source first run without dist builds locally and reaches the same wizard in isolation', async t => {
  const root = fixture(t, false);
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) fs.copyFileSync(name, join(root, name));
  for (const name of ['src', 'node_modules']) fs.cpSync(name, join(root, name), { recursive: true });
  for (const name of MDD_ASSETS) { fs.mkdirSync(resolve(join(root, name), '..'), { recursive: true }); fs.copyFileSync(name, join(root, name)); }
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
  assert.equal(await isolated.runSetupUI(root, ui(['', 'apply']), { ...noMemory, installPackage: seedPackage }), 'ready');
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
    assert.equal(await runSetupUI(process.cwd(), ui(['', 'apply']), { ...noMemory, installPackage: target => {
      installs++; installLocalPackage(target, (binary, args, options) => execFileSync(binary, args, { ...options, env }));
    } }), 'ready');
  } finally { process.chdir(originalCwd); }
  const installedUI = pathToFileURL(join(owned, 'node_modules/my-driven-development/dist/setup-ui.js')).href;
  const repeat = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const {runSetupUI} = await import(${JSON.stringify(installedUI)});
    const answers = ['', 'apply'];
    const result = await runSetupUI(process.cwd(), {isTTY:true, read:async()=>answers.shift(), write(){}}, {
      detect:()=>({status:'not-found'}), installPackage:()=>{throw new Error('must not reinstall')}, installMemory:()=>{throw new Error('must not download')}
    }); if(result !== 'ready') process.exit(1);
  `], { cwd: b, env, encoding: 'utf8' });
  assert.equal(repeat.status, 0, repeat.stderr); assert.equal(installs, 1);
  for (const [name, text] of untouched) assert.equal(fs.readFileSync(join(root, name), 'utf8'), text);
  assert.deepEqual(fs.readdirSync(a), ['mdd.config.json']); assert.equal(fs.readFileSync(join(a, 'mdd.config.json'), 'utf8'), legacy);
  assert.deepEqual(fs.readdirSync(b), []);
  const cli = join(owned, 'node_modules/my-driven-development/dist/cli.js');
  const create = spawnSync(process.execPath, [cli, 'profile', 'create', 'shared'], { cwd: a, env, encoding: 'utf8' });
  assert.equal(create.status, 0, create.stderr);
  const list = spawnSync(process.execPath, [cli, 'profile', 'list'], { cwd: b, env, encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr); assert.match(list.stdout, /\* shared/);
  assert.deepEqual(fs.readdirSync(a), ['mdd.config.json']); assert.deepEqual(fs.readdirSync(b), []);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "console.log(import.meta.resolve('my-driven-development/opencode-plugin'))"], { cwd: owned, encoding: 'utf8', env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), pathToFileURL(join(owned, 'node_modules/my-driven-development/dist/opencode-plugin.js')).href);
  const dependency = JSON.parse(fs.readFileSync(join(owned, 'package.json'))).devDependencies['my-driven-development'];
  assert.equal(dependency.startsWith('file:packages/'), true);
  assert.equal(fs.existsSync(join(owned, dependency.slice(5))), true);
  const loader = awaitImportLoader(root);
  assert.equal(loader.status, 0, loader.stderr);
});
test('absent global directory stays absent after preview cancellation, even with source opt-in', async t => {
  const root = fixture(t, false); fs.rmSync(root, { recursive: true });
  const workspace = join(resolve(root, '..'), 'workspace'); fs.mkdirSync(workspace);
  const text = '{"engram":{"endpoint":"http://127.0.0.1:12345","project":"legacy"}}\r\n';
  fs.writeFileSync(join(workspace, 'mdd.config.json'), text);
  const io = ui(['', ':cancel']);
  assert.equal(await runSetupUI(workspace, io, noMemory), 'cancelled');
  assert.equal(fs.existsSync(root), false); assert.equal(fs.readFileSync(join(workspace, 'mdd.config.json'), 'utf8'), text);
  assert.match(io.output.join(''), /Memoria\s+apagada/);
});
for (const loader of ["export { default } from 'my-driven-development/opencode-plugin';\n", "export { default } from '../../dist/opencode-plugin.js';\n"]) {
  test(`global known loader migration requires Apply: ${loader.trim()}`, async t => {
    const root = fixture(t); fs.mkdirSync(join(root, 'plugins')); fs.writeFileSync(join(root, LOADER_PATH), loader);
    assert.equal(await runSetupUI(root, ui(['', ':cancel']), noMemory), 'cancelled');
    assert.equal(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), loader);
    assert.equal(await runSetupUI(root, ui(['', 'apply']), noMemory), 'ready');
    assert.match(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), /\.\.\/mdd\/node_modules/);
  });
}
test('doctor checks managed binary/data without autostart and keeps enabled failures honest', async t => {
  const root = fixture(t); initProject(root); const settings = defaultSettings();
  settings.engram = { mode: 'local', binary: join(root, 'missing.exe'), dataDirectory: join(root, '.mdd/memory') }; saveSettings(root, settings);
  const report = await doctor(root); assert.equal(report.ready, false);
  assert.ok(report.checks.some(check => check.check === 'engram' && check.status === 'action'));
  assert.equal(fs.existsSync(settings.engram.dataDirectory), false);
});
test('detection resolves PATH first and isolates bounded version execution without inherited secrets', t => {
  const root = fixture(t, false); const exe = join(root, 'engram.exe'); fs.writeFileSync(exe, 'mock'); let calls = 0;
  const detection = detectEngram({ path: root, platform: 'win32', temporary: root, execute: (file, args, options) => {
    calls++; assert.equal(file, fs.realpathSync(exe)); assert.deepEqual(args, ['version']);
    assert.equal(options.timeout, 5000); assert.equal(options.maxBuffer, 8192);
    assert.equal(options.env.GH_TOKEN, undefined); assert.equal(options.env.PATH, undefined);
    assert.equal(options.env.HTTPS_PROXY, 'http://127.0.0.1:9'); assert.equal(options.env.NO_PROXY, '');
    assert.ok(fs.existsSync(join(options.cwd, 'engram.db'))); return 'engram version 1.20.0\n';
  } });
  assert.equal(detection.status, 'compatible'); assert.equal(calls, 1); assert.ok(!fs.readdirSync(root).some(name => name.startsWith('mdd-engram-probe')));
  assert.equal(detectEngram({ path: '', execute: () => { throw new Error('unexpected'); } }).status, 'not-found');
  assert.equal(detectEngram({ binary: exe, execute: () => 'engram version 1.19.0\n' }).status, 'incompatible');
  assert.equal(detectEngram({ binary: exe, execute: () => { throw new Error('timeout'); } }).status, 'broken');
});
test('release downloader rejects untrusted redirects, unbounded redirects and oversized responses', async () => {
  let calls = 0;
  await assert.rejects(downloadRelease('https://evil.test/x', 16, async () => { calls++; }), /Untrusted/); assert.equal(calls, 0);
  await assert.rejects(downloadRelease('https://github.com/x', 16, async () => new Response('', { status: 302, headers: { location: 'http://evil.test/x' } })), /Untrusted/);
  await assert.rejects(downloadRelease('https://github.com/x', 16, async () => new Response('', { status: 302, headers: { location: '/again' } })), /Too many/);
  await assert.rejects(downloadRelease('https://github.com/x', 16, async () => new Response('x'.repeat(17))), /size limit/);
  const bytes = await downloadRelease('https://github.com/x', 16, async (url, options) => {
    assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    return url.includes('github.com') ? new Response('', { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/blob' } }) : new Response('ok');
  }); assert.equal(bytes.toString(), 'ok');
});

// Stored ZIP fixture writer: production parsing/extraction is exclusively .NET ZipArchive.
function zip(entries) {
  const local = []; const central = []; let offset = 0;
  for (const { name, content = 'mock executable', attrs = 0, size } of entries) {
    const data = Buffer.from(content); const filename = Buffer.from(name); let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } crc = (crc ^ 0xffffffff) >>> 0;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt32LE(crc, 14); head.writeUInt32LE(data.length, 18); head.writeUInt32LE(size ?? data.length, 22); head.writeUInt16LE(filename.length, 26);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x0314, 4); cd.writeUInt16LE(20, 6); cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(size ?? data.length, 24); cd.writeUInt16LE(filename.length, 28); cd.writeUInt32LE(attrs >>> 0, 38); cd.writeUInt32LE(offset, 42);
    local.push(head, filename, data); central.push(cd, filename); offset += head.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function mockRelease(root, archive = zip([{ name: 'engram.exe' }, { name: 'LICENSE' }])) {
  const offer = engramOffer(root, 'win32', 'x64'); const sums = Buffer.from(`${hash(archive)}  ${offer.name}\n`); const calls = [];
  return { calls, options: { platform: 'win32', arch: 'x64', hashes: { archive: hash(archive), checksums: hash(sums) }, download: async url => { calls.push(url); return url.endsWith('checksums.txt') ? sums : archive; } } };
}
test('pinned Windows assets and API digest provenance are stable; unsupported OS is explicit', t => {
  const root = fixture(t, false);
  assert.match(engramOffer(root, 'win32', 'x64').url, /engram_1\.20\.0_windows_amd64.zip$/);
  assert.match(engramOffer(root, 'win32', 'arm64').url, /windows_arm64.zip$/);
  assert.equal(RELEASE_HASHES.x64, 'c945c47d58367f943642cb8451fa45f208174407839f1dda33a975a05d6e465b');
  assert.throws(() => engramOffer(root, 'linux', 'x64'), /Windows/);
});
test('mock installer verifies both hashes before extraction and exclusively publishes the binary', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t, false); const mock = mockRelease(root);
  const binary = await installEngram(root, mock.options);
  assert.equal(fs.readFileSync(binary, 'utf8'), 'mock executable'); assert.equal(mock.calls.length, 2);
  await assert.rejects(installEngram(root, mock.options), /already exists/); assert.equal(mock.calls.length, 2);
  const second = fixture(t, false); const bad = mockRelease(second); bad.options.hashes.archive = '0'.repeat(64);
  await assert.rejects(installEngram(second, { ...bad.options, extract: () => assert.fail('must not extract') }), /checksums/);
  const third = mockRelease(second); third.options.hashes.checksums = '0'.repeat(64);
  await assert.rejects(installEngram(second, third.options), /digest mismatch/);
  const fourth = mockRelease(second); const original = fourth.options.download;
  fourth.options.download = async url => url.endsWith('.zip') ? Buffer.from('tampered') : original(url);
  await assert.rejects(installEngram(second, { ...fourth.options, extract: () => assert.fail('must not extract') }), /archive digest mismatch/);
  assert.equal(fs.existsSync(join(second, '.mdd')), false);
});
for (const entries of [
  [{ name: '../engram.exe' }], [{ name: 'C:\\engram.exe' }], [{ name: 'engram.exe:stream' }],
  [{ name: 'engram.exe' }, { name: 'ENGRAM.EXE' }], [{ name: 'engram.exe', attrs: 0xa000 << 16 }],
  [{ name: 'engram.exe', size: 67108865 }], [{ name: 'engram.exe', attrs: 0x10 }],
  [{ name: 'engram.exe', content: '' }], Array.from({ length: 33 }, (_, i) => ({ name: `file${i}` })),
]) {
  test(`Windows parser rejects hostile ZIP ${entries[0].name}/${entries[0].attrs ?? entries[0].size ?? entries.length}`, { skip: process.platform !== 'win32' }, async t => {
    const root = fixture(t, false); const mock = mockRelease(root, zip(entries));
    await assert.rejects(installEngram(root, mock.options)); assert.equal(fs.existsSync(join(root, '.mdd')), false);
  });
}
test('Windows extraction never overwrites an existing destination', { skip: process.platform !== 'win32' }, t => {
  const root = fixture(t, false); const archive = join(root, 'fixture.zip'); const dest = join(root, 'engram.exe');
  fs.writeFileSync(archive, zip([{ name: 'engram.exe' }])); fs.writeFileSync(dest, 'existing');
  assert.throws(() => extractWindowsBinary(archive, dest)); assert.equal(fs.readFileSync(dest, 'utf8'), 'existing');
});
test('single invocation optional install uses mocked release only after explicit review', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t); const mock = mockRelease(join(root, 'mdd')); const io = ui(['install', 'apply']);
  assert.equal(await runSetupUI(root, io, { ...noMemory, installMemory: target => installEngram(target, mock.options) }), 'ready');
  assert.match(io.output.join(''), /proveedor Gentleman-Programming/); assert.equal(mock.calls.length, 2);
  assert.equal(loadSettings(root).engram.binary, engramOffer(join(root, 'mdd')).binary);
});
test('incompatible existing Engram is retained when a separate pinned install is explicitly selected', { skip: process.platform !== 'win32' }, async t => {
  const root = fixture(t); const old = join(root, 'old-engram.exe'); fs.writeFileSync(old, 'existing 1.19');
  const mock = mockRelease(join(root, 'mdd')); const io = ui(['install', 'apply']);
  assert.equal(await runSetupUI(root, io, {
    ...noMemory, detect: () => ({ status: 'incompatible', version: '1.19.0', binary: old }),
    installMemory: target => installEngram(target, mock.options),
  }), 'ready');
  assert.equal(fs.readFileSync(old, 'utf8'), 'existing 1.19');
  assert.notEqual(loadSettings(root).engram.binary, old);
  assert.match(io.output.join(''), /No se reemplaza ningún Engram existente/);
});
test('linked installer parent is refused before any download or external write', async t => {
  const root = fixture(t, false); const outside = fixture(t, false); const before = fs.readdirSync(outside);
  fs.symlinkSync(outside, join(root, 'bin'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installEngram(root, { platform: 'win32', arch: 'x64', download: () => assert.fail('must not download') }), /Linked/);
  assert.deepEqual(fs.readdirSync(outside), before);
});
function awaitImportLoader(root) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `const plugin = await import(${JSON.stringify(pathToFileURL(join(root, LOADER_PATH)).href)}); if (typeof plugin.default !== 'function') process.exit(1);`], { encoding: 'utf8' });
}
