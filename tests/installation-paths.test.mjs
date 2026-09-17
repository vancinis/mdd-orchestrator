import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installationPaths } from '../dist/installation-paths.js';
import { loadGlobalSettings, saveGlobalSettings } from '../dist/global-settings.js';
import { defaultSettings, freezeProfile } from '../dist/settings.js';
import { toolTargets } from '../dist/phase-policy.js';

function fixture(t) {
  const parent = tmpdir();
  const root = fs.mkdtempSync(join(parent, 'mdd-global-paths-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  fs.mkdirSync(home);
  const options = { home, env: { XDG_CONFIG_HOME: join(home, 'xdg') } };
  return { root, home, options, paths: installationPaths(options) };
}

test('native-root-xdg-home-and-extra-config-directory-semantics', t => {
  const { root, home, options, paths } = fixture(t);
  assert.equal(paths.configRoot, join(home, 'xdg', 'opencode'));
  assert.equal(paths.ownedRoot, join(paths.configRoot, 'mdd'));
  assert.equal(paths.settingsPath, join(paths.ownedRoot, 'mdd.config.json'));
  assert.equal(paths.installedPackageRoot, join(paths.ownedRoot, 'node_modules', 'my-driven-development'));
  assert.equal(paths.cliPath, join(paths.installedPackageRoot, 'dist', 'cli.js'));
  assert.equal(paths.loaderPath, join(paths.configRoot, 'plugins', 'mdd.ts'));
  assert.equal(paths.manifestPath, join(paths.ownedRoot, 'setup-assets.json'));
  assert.equal(paths.packagesRoot, join(paths.ownedRoot, 'packages'));
  assert.equal(paths.binRoot, join(paths.ownedRoot, 'bin'));
  assert.equal(paths.memoryRoot, join(paths.ownedRoot, 'memory'));
  const unrelated = { APPDATA: join(root, 'appdata'), OPENCODE_TEST_HOME: join(root, 'test-home'), OPENCODE_CONFIG_DIR: join(root, 'extra') };
  assert.deepEqual(installationPaths({ home, env: { ...options.env, ...unrelated } }), paths);
  assert.equal(installationPaths({ home, env: unrelated }).configRoot, join(home, '.config', 'opencode'));
  assert.equal(installationPaths({ home, env: { XDG_CONFIG_HOME: '' } }).configRoot, join(home, '.config', 'opencode'));
  assert.deepEqual(fs.readdirSync(root), ['home']);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('installation paths reject cwd-dependent roots without writing', t => {
  const { home } = fixture(t);
  assert.throws(() => installationPaths({ home: '.', env: {} }), /absolute/);
  assert.throws(() => installationPaths({ home, env: { XDG_CONFIG_HOME: 'relative' } }), /absolute/);
  assert.throws(() => installationPaths({ home, env: { XDG_CONFIG_HOME: `${home}\n` } }), /absolute/);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('global-settings authority ignores workspace configs and freezes shared startup models', t => {
  const { root, options, paths } = fixture(t);
  const workspaces = ['A', 'B'].map(name => join(root, name));
  for (const workspace of workspaces) {
    fs.mkdirSync(workspace);
    fs.writeFileSync(join(workspace, 'mdd.config.json'), `legacy ${workspace}\r\n`);
  }
  assert.deepEqual(loadGlobalSettings(options), defaultSettings());
  assert.equal(fs.existsSync(paths.configRoot), false);
  const settings = defaultSettings();
  settings.profiles.shared = { models: { orchestrator: 'provider/shared' }, answers: {} };
  settings.activeProfile = 'shared';
  settings.telemetry.enabled = false;
  saveGlobalSettings(settings, options);
  const frozen = freezeProfile(loadGlobalSettings(options));
  for (const workspace of workspaces) {
    assert.equal(loadGlobalSettings(options).activeProfile, 'shared');
    assert.equal(fs.readFileSync(join(workspace, 'mdd.config.json'), 'utf8'), `legacy ${workspace}\r\n`);
    assert.deepEqual(fs.readdirSync(workspace), ['mdd.config.json']);
  }
  settings.profiles.shared.models.orchestrator = 'provider/changed';
  saveGlobalSettings(settings, options);
  assert.equal(frozen.models.orchestrator, 'provider/shared');
  assert.equal(loadGlobalSettings(options).profiles.shared.models.orchestrator, 'provider/changed');
  assert.deepEqual(fs.readdirSync(paths.ownedRoot), ['mdd.config.json']);
});

test('global-settings save preserves unrelated native configuration and rejects invalid input before writes', t => {
  const { options, paths } = fixture(t);
  assert.throws(() => saveGlobalSettings({}, options));
  assert.equal(fs.existsSync(paths.configRoot), false);
  fs.mkdirSync(paths.configRoot, { recursive: true });
  const unrelated = { 'opencode.json': '{"default_agent":"build"}\r\n', 'package.json': '{"private":true}\n', 'AGENTS.md': 'Unrelated instructions\n' };
  for (const [name, text] of Object.entries(unrelated)) fs.writeFileSync(join(paths.configRoot, name), text);
  saveGlobalSettings(defaultSettings(), options);
  for (const [name, text] of Object.entries(unrelated)) assert.equal(fs.readFileSync(join(paths.configRoot, name), 'utf8'), text);
  assert.deepEqual(fs.readdirSync(paths.configRoot).sort(), [...Object.keys(unrelated), 'mdd'].sort());
});

test('global-settings API uses one authority from two actual empty process working directories', t => {
  const { root, home, options, paths } = fixture(t);
  const workspaces = ['A', 'B'].map(name => join(root, name));
  for (const workspace of workspaces) fs.mkdirSync(workspace);
  const module = new URL('../dist/global-settings.js', import.meta.url).href;
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: options.env.XDG_CONFIG_HOME, OPENCODE_TEST_HOME: home, OPENCODE_CONFIG_DIR: join(home, 'extra') };
  const run = (cwd, body) => execFileSync(process.execPath, ['--input-type=module', '--eval', `import {loadGlobalSettings,saveGlobalSettings} from ${JSON.stringify(module)}; ${body}`], { cwd, env, encoding: 'utf8', timeout: 10000 });
  for (const workspace of workspaces) assert.equal(JSON.parse(run(workspace, 'console.log(JSON.stringify(loadGlobalSettings()));')).engram, undefined);
  assert.equal(fs.existsSync(paths.configRoot), false);
  run(workspaces[0], `const settings = loadGlobalSettings(); settings.profiles.shared = {models:{orchestrator:'provider/shared'},answers:{}}; settings.activeProfile = 'shared'; saveGlobalSettings(settings);`);
  assert.equal(JSON.parse(run(workspaces[1], 'console.log(JSON.stringify(loadGlobalSettings()));')).activeProfile, 'shared');
  run(workspaces[1], 'const settings = loadGlobalSettings(); settings.telemetry.enabled = false; saveGlobalSettings(settings);');
  assert.equal(JSON.parse(run(workspaces[0], 'console.log(JSON.stringify(loadGlobalSettings()));')).telemetry.enabled, false);
  for (const workspace of workspaces) assert.deepEqual(fs.readdirSync(workspace), []);
  assert.equal(fs.existsSync(env.OPENCODE_CONFIG_DIR), false);
});

test('global-settings reject linked owned roots and hardlinked settings without touching targets', t => {
  const { root, options, paths } = fixture(t);
  const outside = join(root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(paths.configRoot, { recursive: true });
  fs.symlinkSync(outside, paths.ownedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => loadGlobalSettings(options));
  assert.throws(() => saveGlobalSettings(defaultSettings(), options));
  assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(paths.ownedRoot);
  fs.mkdirSync(paths.ownedRoot);
  const target = join(outside, 'protected.json');
  const bytes = JSON.stringify(defaultSettings());
  fs.writeFileSync(target, bytes);
  fs.linkSync(target, paths.settingsPath);
  assert.throws(() => loadGlobalSettings(options));
  assert.throws(() => saveGlobalSettings(defaultSettings(), options));
  assert.equal(fs.readFileSync(target, 'utf8'), bytes);
});

test('global-path resolution does not expand project edit or shell scope', t => {
  const { root, options, paths } = fixture(t);
  const workspace = join(root, 'workspace');
  fs.mkdirSync(workspace);
  saveGlobalSettings(defaultSettings(), options);
  assert.throws(() => toolTargets(workspace, 'mdd-apply', 'write', { filePath: paths.settingsPath }), /outside/);
  assert.throws(() => toolTargets(workspace, 'mdd-apply', 'bash', { command: 'npm test', workdir: paths.ownedRoot }), /outside/);
  assert.deepEqual(fs.readdirSync(workspace), []);
});
