import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { initProject, LOADER_PATH, LOADER_TEXT, PRIVATE_IGNORE_PATH } from '../dist/setup.js';
import { doctor } from '../dist/doctor.js';
import { defaultSettings, saveSettings as writeSettings, setupDiagnostic } from '../dist/settings.js';
const saveSettings = (root, value) => writeSettings(join(root, 'mdd'), value);
import { MDD_ASSETS } from '../dist/project-assets.js';
import { runConfigUI } from '../dist/config-ui.js';
import { pathToFileURL } from 'node:url';

function fixture(t, installed = true) {
  const home = fs.mkdtempSync(join(tmpdir(), 'mdd-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = home;
  const root = join(home, 'opencode'); fs.mkdirSync(root);
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'target-fixture', private: true, type: 'module' }));
  if (installed) {
    fs.mkdirSync(join(root, 'mdd')); fs.writeFileSync(join(root, 'mdd/package.json'), '{"private":true}');
    const pkg = join(root, 'mdd/node_modules/my-driven-development'); fs.mkdirSync(pkg, { recursive: true });
    fs.cpSync('dist', join(pkg, 'dist'), { recursive: true }); fs.copyFileSync('package.json', join(pkg, 'package.json'));
    fs.cpSync('assets', join(pkg, 'assets'), { recursive: true });
    const scope = join(root, 'mdd/node_modules/@opencode-ai'); fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(resolve('node_modules/@opencode-ai/plugin'), join(scope, 'plugin'), process.platform === 'win32' ? 'junction' : 'dir');
  }
  return root;
}
function snapshot(root) {
  const result = {};
  const visit = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) visit(path); else result[path.slice(root.length)] = fs.readFileSync(path, 'utf8');
  } };
  visit(root); return result;
}
test('init installs only owned assets, preserves user files and is byte-idempotent', t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, 'agents'), { recursive: true }); fs.writeFileSync(join(root, 'agents/custom.md'), 'user actor');
  fs.mkdirSync(join(root, 'skills/custom'), { recursive: true }); fs.writeFileSync(join(root, 'skills/custom/SKILL.md'), 'user skill');
  fs.writeFileSync(join(root, 'AGENTS.md'), 'user instructions'); fs.writeFileSync(join(root, 'opencode.json'), '{"default_agent":"build"}');
  saveSettings(root, defaultSettings()); const before = snapshot(root);
  const first = initProject(root); assert.equal(first.created, MDD_ASSETS.length + 2);
  for (const [path, text] of Object.entries(before)) assert.equal(fs.readFileSync(join(root, path), 'utf8'), text);
  assert.equal(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), LOADER_TEXT);
  assert.equal(fs.readFileSync(join(root, PRIVATE_IGNORE_PATH), 'utf8'), '*\n!.gitignore\n');
  const installed = snapshot(root); const second = initProject(root);
  assert.equal(second.created, 0); assert.equal(second.unchanged, first.created); assert.deepEqual(snapshot(root), installed);
});
test('init refuses a conflicting owned file before creating other assets', t => {
  const root = fixture(t); const path = join(root, 'agents/mdd-verify.md'); fs.mkdirSync(join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path, 'existing user content'); const before = snapshot(root);
  assert.throws(() => initProject(root), /refuses to overwrite/); assert.deepEqual(snapshot(root), before);
});
test('init refuses linked target directories without writing outside the target', t => {
  const root = fixture(t); const outside = fixture(t, false);
  fs.symlinkSync(outside, join(root, 'agents'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = snapshot(outside); assert.throws(() => initProject(root)); assert.deepEqual(snapshot(outside), before);
});
test('init requires a locally installed built package and never installs dependencies itself', t => {
  const root = fixture(t, false); const before = snapshot(root);
  assert.throws(() => initProject(root), /Run mdd setup/); assert.deepEqual(snapshot(root), before);
});
test('doctor reports missing setup read-only without creating settings or metadata', async t => {
  const root = fixture(t, false); const before = snapshot(root);
  const report = await doctor(root);
  assert.equal(report.ready, false); assert.deepEqual(snapshot(root), before);
  assert.ok(report.checks.some(check => check.check === 'engram' && check.status === 'ok' && check.message.includes('apagada')));
  assert.ok(report.checks.some(check => check.check === 'installed-package' && check.status === 'action'));
});

test('invalid-settings diagnostics distinguish source and installed consumer without requiring memory', t => {
  const root = fixture(t);
  const absent = setupDiagnostic(root);
  assert.equal(absent.problem, 'invalid-settings');
  assert.equal(absent.command, `node "${resolve('dist/cli.js')}" config`);
  saveSettings(root, defaultSettings());
  assert.match(setupDiagnostic(root).action, /Engram is optional/);
  assert.equal(setupDiagnostic(process.cwd()).command, `node "${resolve('dist/cli.js')}" config`);
  assert.equal(setupDiagnostic(root).problem, 'invalid-settings');
});

test('printed source and installed config commands reach the editor; isolated Save supplies missing fields', async t => {
  const root = fixture(t);
  // Run the actual printed command without a TTY: the editor must refuse, not write.
  const execute = command => spawnSync(process.execPath, [command.match(/^node "(.+)" config$/)[1], 'config'], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, npm_config_offline: 'true', npm_config_cache: join(root, 'npm-cache') } });
  const installed = execute(setupDiagnostic(root, defaultSettings()).command);
  assert.equal(installed.status, 2, installed.stderr);
  assert.match(installed.stderr, /terminal interactiva/);
  fs.cpSync('dist', join(root, 'dist'), { recursive: true });
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'isolated-source', type: 'module', scripts: { mdd: 'node dist/cli.js' } }));
  const source = execute(setupDiagnostic(process.cwd(), defaultSettings()).command);
  assert.equal(source.status, 2, source.stderr);
  assert.match(source.stderr, /terminal interactiva/);
  assert.equal(fs.existsSync(join(root, 'mdd.config.json')), false);
  const installedUI = await import(pathToFileURL(join(root, 'mdd/node_modules/my-driven-development/dist/config-ui.js')).href);
  for (const editor of [runConfigUI, installedUI.runConfigUI]) {
    const lines = ['4', '1', 'http://127.0.0.1:43210', '6'];
    assert.equal(await editor(root, { isTTY: true, read: async () => lines.shift(), write() {} }), 'saved');
    const saved = JSON.parse(fs.readFileSync(join(root, 'mdd/mdd.config.json'), 'utf8'));
    assert.deepEqual(saved.engram, { endpoint: 'http://127.0.0.1:43210' });
    fs.unlinkSync(join(root, 'mdd/mdd.config.json'));
  }
});
test('doctor probes only configured loopback health with GET and never registers sessions', async t => {
  const root = fixture(t); initProject(root);
  const requests = [];
  const server = createServer((req, res) => { requests.push([req.method, req.url]); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ status: 'ok', service: 'engram', version: '0.1.0' })); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const settings = defaultSettings(); settings.engram = { endpoint: `http://127.0.0.1:${server.address().port}`, project: 'fixture' }; saveSettings(root, settings);
  const before = snapshot(root); const report = await doctor(root);
  assert.equal(report.ready, true, JSON.stringify(report)); assert.deepEqual(requests, [['GET', '/health']]); assert.deepEqual(snapshot(root), before);
  assert.ok(report.checks.some(check => check.check === 'native-binding' && check.message.includes('la conversación real')));
});
test('doctor does not echo malformed configuration or raw transport details', async t => {
  const root = fixture(t); initProject(root); fs.writeFileSync(join(root, 'mdd/mdd.config.json'), '{"secret":"do-not-print"');
  const before = snapshot(root); const report = await doctor(root);
  assert.equal(report.ready, false); assert.ok(!JSON.stringify(report).includes('do-not-print')); assert.deepEqual(snapshot(root), before);
});
test('CLI init and doctor use fake global roots and reject retired target arguments', t => {
  const root = fixture(t); const cli = resolve('dist/cli.js');
  const init = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' }); assert.equal(init.status, 0, init.stderr);
  const report = spawnSync(process.execPath, [cli, 'doctor'], { cwd: root, encoding: 'utf8' }); assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).ready, true);
  const usage = spawnSync(process.execPath, [cli, 'init', '--force'], { encoding: 'utf8' }); assert.equal(usage.status, 2);
  const retired = spawnSync(process.execPath, [cli, 'setup', root], { encoding: 'utf8' }); assert.equal(retired.status, 2); assert.match(retired.stderr, /Los directorios de destino ya no existen/);
});
for (const fault of ['redirect', 'oversized', 'wrong-service']) {
  test(`doctor rejects ${fault} health without following it or exposing response data`, async t => {
    const root = fixture(t); initProject(root);
    const requests = [];
    const server = createServer((req, res) => {
      requests.push(req.url);
      if (fault === 'redirect') { res.writeHead(302, { location: '/secret-path' }); res.end(); }
      else res.end(fault === 'oversized' ? 'x'.repeat(9000) : JSON.stringify({ status: 'ok', service: 'other', secret: 'do-not-print' }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
    const settings = defaultSettings(); settings.engram = { endpoint: `http://127.0.0.1:${server.address().port}`, project: 'fixture' }; saveSettings(root, settings);
    const report = await doctor(root); assert.equal(report.ready, false); assert.deepEqual(requests, ['/health']);
    assert.doesNotMatch(JSON.stringify(report), /do-not-print|secret-path/);
  });
}
test('init refuses hardlinked owned files without replacement', t => {
  const root = fixture(t); const shared = join(root, 'shared.md'); fs.writeFileSync(shared, 'existing');
  fs.mkdirSync(join(root, 'agents'), { recursive: true }); fs.linkSync(shared, join(root, 'agents/mdd-plan.md'));
  assert.throws(() => initProject(root)); assert.equal(fs.readFileSync(shared, 'utf8'), 'existing');
});
test('doctor bounds an unresponsive health endpoint without retrying', async t => {
  const root = fixture(t); initProject(root); let requests = 0;
  const server = createServer(() => { requests++; });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const settings = defaultSettings(); settings.engram = { endpoint: `http://127.0.0.1:${server.address().port}`, project: 'fixture' }; saveSettings(root, settings);
  const start = Date.now(); const report = await doctor(root);
  assert.equal(report.ready, false); assert.equal(requests, 1); assert.ok(Date.now() - start < 5000);
});
