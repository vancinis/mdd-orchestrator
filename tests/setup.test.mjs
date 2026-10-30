import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { initProject, LOADER_PATH, LOADER_TEXT, planProject, PRIVATE_IGNORE_PATH, RETIRED_TUI_PLUGIN_SPEC, TUI_CONFIG_PATH, unregisterTuiPlugin } from '../dist/setup.js';
import { doctor, isSupportedNodeVersion } from '../dist/doctor.js';
import { defaultSettings, saveSettings as writeSettings } from '../dist/settings.js';
const saveSettings = (root, value) => writeSettings(join(root, 'mdd'), value);
import { MDD_ASSETS, MDD_CONTRACTS, PACKAGE_ROOT, assetText, installedAsset, installedName } from '../dist/project-assets.js';
import { runConfigUI } from '../dist/config-ui.js';
import { pathToFileURL } from 'node:url';

const link = (target, path) => fs.symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
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
    // The installed package resolves only its declared dependencies: @opencode/plugin and zod.
    const scope = join(root, 'mdd/node_modules/@opencode'); fs.mkdirSync(scope, { recursive: true });
    link(resolve('node_modules/@opencode/plugin'), join(scope, 'plugin'));
    link(resolve('node_modules/zod'), join(root, 'mdd/node_modules/zod'));
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
const composed = name => installedAsset(PACKAGE_ROOT, name).content;
const AGENTS = MDD_ASSETS.filter(name => name.startsWith('assets/opencode/agents/'));

test('init installs only owned assets, preserves user files and is byte-idempotent', t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, 'agents'), { recursive: true }); fs.writeFileSync(join(root, 'agents/custom.md'), 'user actor');
  fs.mkdirSync(join(root, 'skills/custom'), { recursive: true }); fs.writeFileSync(join(root, 'skills/custom/SKILL.md'), 'user skill');
  fs.writeFileSync(join(root, 'AGENTS.md'), 'user instructions'); fs.writeFileSync(join(root, 'opencode.json'), '{"default_agent":"build"}');
  saveSettings(root, defaultSettings()); const before = snapshot(root);
  const first = initProject(root); assert.equal(first.created, MDD_ASSETS.length + 2);
  assert.equal(first.restartRequired, true);
  for (const [path, text] of Object.entries(before)) assert.equal(fs.readFileSync(join(root, path), 'utf8'), text);
  assert.equal(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), LOADER_TEXT);
  assert.equal(fs.readFileSync(join(root, PRIVATE_IGNORE_PATH), 'utf8'), '*\n!.gitignore\n');
  assert.equal(fs.existsSync(join(root, TUI_CONFIG_PATH)), false, 'a fresh install never creates cli.json');
  assert.equal(fs.existsSync(join(root, 'contracts')), false, 'contracts are composed, never installed on their own');
  const manifest = JSON.parse(fs.readFileSync(join(root, 'mdd/setup-assets.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), [...MDD_ASSETS.map(installedName), LOADER_PATH, PRIVATE_IGNORE_PATH].sort());
  const installed = snapshot(root); const second = initProject(root);
  assert.equal(second.created, 0); assert.equal(second.unchanged, first.created); assert.deepEqual(snapshot(root), installed);
});

test('installed agents are composed with their contracts expanded and skills are copied verbatim', t => {
  const root = fixture(t);
  initProject(root);
  for (const name of MDD_ASSETS) {
    const installed = fs.readFileSync(join(root, installedName(name)), 'utf8');
    assert.equal(installed, composed(name), name);
    assert.equal(assetText(root, installedName(name)).digest, installedAsset(PACKAGE_ROOT, name).digest, name);
    if (!name.startsWith('assets/opencode/agents/')) assert.equal(installed, assetText(PACKAGE_ROOT, name).content, name);
  }
  for (const name of AGENTS) assert.doesNotMatch(fs.readFileSync(join(root, installedName(name)), 'utf8'), /mdd:include/, name);
  const contract = name => assetText(PACKAGE_ROOT, `assets/opencode/contracts/${name}.md`).content.trimEnd();
  const orchestrator = fs.readFileSync(join(root, 'agents/mdd-orchestrator.md'), 'utf8');
  assert.ok(orchestrator.includes(contract('workflow')), 'orchestrator embeds the workflow contract');
  assert.ok(orchestrator.includes(contract('run-file')), 'orchestrator embeds the run-file contract');
  assert.match(orchestrator, /# MDD workflow contract/);
  assert.notEqual(orchestrator, assetText(PACKAGE_ROOT, 'assets/opencode/agents/mdd-orchestrator.md').content);
  const plan = fs.readFileSync(join(root, 'agents/mdd-plan.md'), 'utf8');
  assert.ok(plan.includes(contract('actor')), 'actors embed the actor contract');
  assert.doesNotMatch(plan, /# MDD workflow contract/);
  // Every contract is used by at least one agent.
  for (const path of MDD_CONTRACTS) {
    const text = assetText(PACKAGE_ROOT, path).content.trimEnd();
    assert.ok(AGENTS.some(name => composed(name).includes(text)), path);
  }
});

test('regression: installed coordinator keeps Spanish user prose and English artifact boundary', t => {
  const root = fixture(t);
  initProject(root);
  const installed = fs.readFileSync(join(root, 'agents/mdd-orchestrator.md'), 'utf8');
  assert.match(installed, /Talk to the user in Spanish, always, including question text, option labels and descriptions/);
  assert.match(installed, /Write prompts for actors, artifacts and run files in English/);
});

test('installedAsset rejects an unknown contract marker', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-assets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(join(root, 'assets/opencode/agents'), { recursive: true });
  fs.writeFileSync(join(root, 'assets/opencode/agents/mdd-plan.md'), 'x\n<!-- mdd:include contracts/unknown.md -->\n');
  assert.throws(() => installedAsset(root, 'assets/opencode/agents/mdd-plan.md'), /Unknown MDD contract/);
});

test('unregisterTuiPlugin removes only the retired MDD entry and preserves other plugins and keys', () => {
  const original = { $schema: 'https://opencode.ai/v2/cli.json', theme: { name: 'smoke' }, attention: { sound: true, notifications: false },
    plugins: ['other', RETIRED_TUI_PLUGIN_SPEC, { package: 'local.tsx', options: { flag: true } }, { package: RETIRED_TUI_PLUGIN_SPEC, options: {} }] };
  const result = unregisterTuiPlugin(JSON.stringify(original));
  assert.equal(typeof result, 'string');
  assert.ok(result.endsWith('\n'));
  assert.deepEqual(JSON.parse(result), { ...original, plugins: ['other', { package: 'local.tsx', options: { flag: true } }] });
  assert.equal(unregisterTuiPlugin(result), undefined, 'a cleaned file has nothing left to change');
  assert.deepEqual(JSON.parse(unregisterTuiPlugin(JSON.stringify({ plugins: [RETIRED_TUI_PLUGIN_SPEC] }))), { plugins: [] });
});

test('unregisterTuiPlugin leaves configs MDD never touched alone', () => {
  for (const text of [undefined, '{broken', '[]', 'null', '"text"', '{}', '{"plugins":"not-a-list"}',
    JSON.stringify({ plugins: ['other', { package: 'local.tsx' }] }),
    JSON.stringify({ plugins: ['./mdd/node_modules/my-driven-development/dist/other.js'] })]) {
    assert.equal(unregisterTuiPlugin(text), undefined, String(text));
  }
});

test('setup removes the retired sidebar from cli.json and nothing else, then stays idempotent', t => {
  const root = fixture(t);
  const original = { theme: { name: 'smoke' }, attention: { sound: true }, plugins: ['other', RETIRED_TUI_PLUGIN_SPEC, { package: 'local.tsx', options: { flag: true } }] };
  fs.writeFileSync(join(root, TUI_CONFIG_PATH), JSON.stringify(original));
  const plan = planProject(root);
  const entry = plan.find(file => file.name === TUI_CONFIG_PATH);
  assert.equal(entry?.action, 'update');
  assert.equal(plan.length, MDD_ASSETS.length + 3);
  const result = initProject(root);
  assert.equal(result.created, MDD_ASSETS.length + 2, 'cli.json is updated in place, not created');
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(join(root, 'mdd/setup-assets.json'), 'utf8')), TUI_CONFIG_PATH), false, 'cli.json is the user file and never recorded as MDD-owned');
  const firstRun = snapshot(root);
  assert.deepEqual(JSON.parse(fs.readFileSync(join(root, TUI_CONFIG_PATH), 'utf8')), { ...original, plugins: ['other', { package: 'local.tsx', options: { flag: true } }] });
  assert.equal(planProject(root).some(file => file.name === TUI_CONFIG_PATH), false);
  const cleaned = fs.readFileSync(join(root, TUI_CONFIG_PATH), 'utf8');
  assert.equal(initProject(root).created, 0);
  assert.equal(fs.readFileSync(join(root, TUI_CONFIG_PATH), 'utf8'), cleaned);
  assert.deepEqual(snapshot(root), firstRun, 'the second run is byte-identical to the first');
});

for (const [label, text] of [['malformed', '{broken'], ['foreign', JSON.stringify({ plugins: ['other'], theme: 'x' })]]) {
  test(`a ${label} cli.json without the MDD entry is left byte-for-byte and does not block setup`, t => {
    const root = fixture(t);
    fs.writeFileSync(join(root, TUI_CONFIG_PATH), text);
    assert.equal(planProject(root).some(file => file.name === TUI_CONFIG_PATH), false);
    assert.equal(initProject(root).created, MDD_ASSETS.length + 2);
    assert.equal(fs.readFileSync(join(root, TUI_CONFIG_PATH), 'utf8'), text);
    assert.equal(fs.readFileSync(join(root, LOADER_PATH), 'utf8'), LOADER_TEXT);
  });
}

test('a tui.json from OpenCode V1 no longer blocks setup and is never touched', t => {
  const root = fixture(t);
  const text = JSON.stringify({ theme: 'user-theme', plugin: ['user-plugin'] });
  fs.writeFileSync(join(root, 'tui.json'), text);
  initProject(root);
  assert.equal(fs.readFileSync(join(root, 'tui.json'), 'utf8'), text);
  assert.equal(fs.existsSync(join(root, TUI_CONFIG_PATH)), false);
});

test('setup migrates a recorded older asset above the packaged size limit without relaxing ownership', t => {
  const root = fixture(t); initProject(root);
  const name = 'agents/mdd-orchestrator.md';
  const legacy = 'x'.repeat(16015);
  fs.writeFileSync(join(root, name), legacy);
  assert.throws(() => initProject(root, true), /refuses to overwrite different content: agents\/mdd-orchestrator.md/);
  assert.equal(fs.readFileSync(join(root, name), 'utf8'), legacy);
  const metadata = join(root, 'mdd/setup-assets.json');
  const manifest = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  manifest[name] = assetText(root, name, 65536).digest;
  fs.writeFileSync(metadata, JSON.stringify(manifest));
  initProject(root, true);
  assert.equal(assetText(root, name).digest, installedAsset(PACKAGE_ROOT, 'assets/opencode/agents/mdd-orchestrator.md').digest);
});

test('update replaces a recorded older composed agent but refuses a user-edited one', t => {
  const root = fixture(t); initProject(root);
  const name = 'agents/mdd-plan.md';
  // A user edit after install: the digest no longer matches the recorded one.
  fs.writeFileSync(join(root, name), 'user edit');
  const before = snapshot(root);
  assert.throws(() => initProject(root, true), /refuses to overwrite different content: agents\/mdd-plan.md/);
  assert.throws(() => initProject(root), /refuses to overwrite/);
  assert.deepEqual(snapshot(root), before);
});

test('init refuses a conflicting owned file before creating other assets', t => {
  const root = fixture(t); const path = join(root, 'agents/mdd-verify.md'); fs.mkdirSync(join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path, 'existing user content'); const before = snapshot(root);
  assert.throws(() => initProject(root), /refuses to overwrite/); assert.deepEqual(snapshot(root), before);
});

test('init installs all namespaced Judgment Day actors as composed and preserves foreign actors', t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, 'agents'));
  fs.writeFileSync(join(root, 'agents/jd-judge-a.md'), 'foreign judge');
  initProject(root);
  for (const role of ['mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix']) {
    const name = `assets/opencode/agents/${role}.md`;
    assert.ok(MDD_ASSETS.includes(name), role);
    assert.equal(fs.readFileSync(join(root, `agents/${role}.md`), 'utf8'), composed(name));
  }
  assert.equal(fs.readFileSync(join(root, 'agents/jd-judge-a.md'), 'utf8'), 'foreign judge');
  assert.equal(initProject(root).created, 0);
});

test('init refuses foreign content at each namespaced Judgment Day destination without partial writes', t => {
  for (const role of ['mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix']) {
    const root = fixture(t);
    fs.mkdirSync(join(root, 'agents'));
    fs.writeFileSync(join(root, `agents/${role}.md`), 'foreign content');
    const before = snapshot(root);
    assert.throws(() => initProject(root), /refuses to overwrite/);
    assert.deepEqual(snapshot(root), before);
  }
});

test('init installs the complete Judgment Day skill/reference pair and keeps unrelated shared skills', t => {
  const root = fixture(t);
  fs.mkdirSync(join(root, 'skills/judgment-day'), { recursive: true });
  fs.writeFileSync(join(root, 'skills/judgment-day/SKILL.md'), 'foreign standalone skill');
  initProject(root);
  for (const file of ['SKILL.md', 'references/prompts-and-formats.md']) {
    const source = `assets/opencode/skills/mdd-judgment-day/${file}`;
    assert.ok(MDD_ASSETS.includes(source));
    assert.equal(fs.readFileSync(join(root, `skills/mdd-judgment-day/${file}`), 'utf8'), fs.readFileSync(source, 'utf8'));
  }
  const before = snapshot(root);
  assert.equal(initProject(root).created, 0); assert.deepEqual(snapshot(root), before);
  assert.equal(fs.readFileSync(join(root, 'skills/judgment-day/SKILL.md'), 'utf8'), 'foreign standalone skill');
});

for (const file of ['SKILL.md', 'references/prompts-and-formats.md']) {
  test(`init preserves foreign Judgment Day ${file} before any partial installation`, t => {
    const root = fixture(t); const path = join(root, `skills/mdd-judgment-day/${file}`);
    fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, 'foreign content');
    const before = snapshot(root);
    assert.throws(() => initProject(root), /refuses to overwrite/); assert.deepEqual(snapshot(root), before);
  });
}

// An installation from before the question session has neither mdd-grill file. Updating must add
// both and replace the recorded older coordinator without touching a user's own grilling skills.
test('update from a release without mdd-grill adds the skill pair and keeps the user grilling skills', t => {
  const root = fixture(t);
  const foreign = ['skills/grilling/SKILL.md', 'skills/grill-me/SKILL.md', 'skills/grill-with-docs/SKILL.md'];
  for (const name of foreign) { fs.mkdirSync(join(root, name, '..'), { recursive: true }); fs.writeFileSync(join(root, name), `foreign ${name}`); }
  initProject(root);
  const grill = ['skills/mdd-grill/SKILL.md', 'skills/mdd-grill/NOTICE'];
  const ledger = join(root, 'mdd/setup-assets.json'), manifest = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  for (const name of grill) { fs.rmSync(join(root, name)); delete manifest[name]; }
  fs.rmdirSync(join(root, 'skills/mdd-grill'));
  const older = '---\nmode: primary\n---\n\nAn older coordinator without the question session.\n';
  fs.writeFileSync(join(root, 'agents/mdd-orchestrator.md'), older);
  manifest['agents/mdd-orchestrator.md'] = assetText(root, 'agents/mdd-orchestrator.md').digest;
  fs.writeFileSync(ledger, JSON.stringify(manifest));
  const result = initProject(root, true);
  assert.equal(result.created, grill.length);
  for (const name of grill) assert.equal(fs.readFileSync(join(root, name), 'utf8'), fs.readFileSync(`assets/opencode/${name}`, 'utf8'), name);
  assert.equal(fs.readFileSync(join(root, 'agents/mdd-orchestrator.md'), 'utf8'), composed('assets/opencode/agents/mdd-orchestrator.md'));
  for (const name of foreign) assert.equal(fs.readFileSync(join(root, name), 'utf8'), `foreign ${name}`, name);
  const recorded = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  for (const name of grill) assert.equal(recorded[name], assetText(root, name).digest, name);
  assert.ok(Buffer.byteLength(fs.readFileSync(ledger)) < 16384, 'the ledger stays inside its read bound');
  assert.equal(initProject(root, true).created, 0);
});

for (const file of ['SKILL.md', 'NOTICE']) {
  test(`init preserves a foreign mdd-grill ${file} before any partial installation`, t => {
    const root = fixture(t); const path = join(root, `skills/mdd-grill/${file}`);
    fs.mkdirSync(join(path, '..'), { recursive: true }); fs.writeFileSync(path, 'foreign content');
    const before = snapshot(root);
    assert.throws(() => initProject(root), /refuses to overwrite different content: skills\/mdd-grill/);
    assert.deepEqual(snapshot(root), before);
  });
}

test('init refuses linked target directories without writing outside the target', t => {
  const root = fixture(t); const outside = fixture(t, false);
  link(outside, join(root, 'agents'));
  const before = snapshot(outside); assert.throws(() => initProject(root)); assert.deepEqual(snapshot(outside), before);
});
test('init requires a locally installed built package and never installs dependencies itself', t => {
  const root = fixture(t, false); const before = snapshot(root);
  assert.throws(() => initProject(root), /Run mdd setup/); assert.deepEqual(snapshot(root), before);
});
test('init refuses hardlinked owned files without replacement', t => {
  const root = fixture(t); const shared = join(root, 'shared.md'); fs.writeFileSync(shared, 'existing');
  fs.mkdirSync(join(root, 'agents'), { recursive: true }); fs.linkSync(shared, join(root, 'agents/mdd-plan.md'));
  assert.throws(() => initProject(root)); assert.equal(fs.readFileSync(shared, 'utf8'), 'existing');
});

test('doctor reports missing setup read-only without creating settings or metadata', async t => {
  const root = fixture(t, false); const before = snapshot(root);
  const report = await doctor(root);
  assert.equal(report.ready, false); assert.deepEqual(snapshot(root), before);
  assert.equal(report.scope, 'global-installation-only');
  assert.ok(report.checks.some(check => check.check === 'installed-package' && check.status === 'action'));
  assert.ok(report.checks.some(check => check.check === 'agents-and-skills' && check.status === 'action'));
  assert.ok(report.checks.some(check => check.check === 'settings' && check.status === 'ok'));
  assert.equal(fs.existsSync(join(root, 'mdd')), false);
});

test('doctor is ready after install, runs only the retained checks and changes nothing', async t => {
  const root = fixture(t); initProject(root);
  const before = snapshot(root); const report = await doctor(root);
  assert.equal(report.ready, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.checks.map(check => check.check),
    ['workspace', 'node', 'installed-package', 'build', 'dependencies', 'agents-and-skills', 'loader', 'package-freshness', 'settings']);
  assert.ok(report.checks.every(check => check.status !== 'action'));
  assert.equal(report.checks.find(check => check.check === 'package-freshness').status, 'ok');
  assert.match(report.checks.find(check => check.check === 'settings').message, /Perfil activo .default./);
  assert.doesNotMatch(JSON.stringify(report), /engram|preflight|telemetr|storage/i);
  assert.deepEqual(snapshot(root), before);
});

test('doctor reports the active preferences from the global settings', async t => {
  const root = fixture(t); initProject(root);
  const settings = defaultSettings(); settings.profiles.default.answers = { mode: 'automatic', summary: 'detailed' }; saveSettings(root, settings);
  const report = await doctor(root);
  assert.equal(report.ready, true);
  assert.match(report.checks.find(check => check.check === 'settings').message, /Modo: automatic\. Detalle: detailed\./);
});

test('doctor flags a hand-edited installed agent, a raw uncomposed agent and a missing loader', async t => {
  const root = fixture(t); initProject(root);
  const agent = join(root, 'agents/mdd-plan.md');
  fs.writeFileSync(agent, `${fs.readFileSync(agent, 'utf8')}\nuser edit\n`);
  let report = await doctor(root);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.check === 'agents-and-skills').status, 'action');
  // The raw asset with its include markers is not what MDD installs.
  fs.writeFileSync(agent, assetText(PACKAGE_ROOT, 'assets/opencode/agents/mdd-plan.md').content);
  report = await doctor(root);
  assert.equal(report.checks.find(check => check.check === 'agents-and-skills').status, 'action');
  fs.writeFileSync(agent, composed('assets/opencode/agents/mdd-plan.md'));
  fs.rmSync(join(root, LOADER_PATH));
  report = await doctor(root);
  assert.equal(report.checks.find(check => check.check === 'agents-and-skills').status, 'ok');
  assert.equal(report.checks.find(check => check.check === 'loader').status, 'action');
  assert.equal(report.ready, false);
});

test('doctor flags a missing plugin dependency', async t => {
  const root = fixture(t); initProject(root);
  fs.rmSync(join(root, 'mdd/node_modules/@opencode/plugin'), { recursive: true, force: true });
  const report = await doctor(root);
  assert.equal(report.ready, false);
  assert.equal(report.checks.find(check => check.check === 'dependencies').status, 'action');
});

test('doctor does not echo malformed configuration', async t => {
  const root = fixture(t); initProject(root); fs.writeFileSync(join(root, 'mdd/mdd.config.json'), '{"secret":"do-not-print"');
  const before = snapshot(root); const report = await doctor(root);
  assert.equal(report.ready, false); assert.ok(!JSON.stringify(report).includes('do-not-print')); assert.deepEqual(snapshot(root), before);
  assert.equal(report.checks.find(check => check.check === 'settings').status, 'action');
});

test('doctor accepts settings with retired keys and reports them ready', async t => {
  const root = fixture(t); initProject(root);
  fs.writeFileSync(join(root, 'mdd/mdd.config.json'), JSON.stringify({ ...defaultSettings(), engram: { endpoint: 'http://127.0.0.1:7437' }, telemetry: { enabled: true }, workers: { enabled: false } }));
  const report = await doctor(root);
  assert.equal(report.ready, true, JSON.stringify(report));
});

test('installed and source config editors refuse without a TTY and save preferences with one', async t => {
  const root = fixture(t);
  const installedCli = join(root, 'mdd/node_modules/my-driven-development/dist/cli.js');
  for (const cli of [installedCli, resolve('dist/cli.js')]) {
    const result = spawnSync(process.execPath, [cli, 'config'], { cwd: root, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /terminal interactiva/);
  }
  assert.equal(fs.existsSync(join(root, 'mdd/mdd.config.json')), false);
  const installedUI = await import(pathToFileURL(join(root, 'mdd/node_modules/my-driven-development/dist/config-ui.js')).href);
  for (const editor of [runConfigUI, installedUI.runConfigUI]) {
    const lines = ['3', '1', '2', '4'];
    assert.equal(await editor(root, { isTTY: true, read: async () => lines.shift(), write() {} }), 'saved');
    const saved = JSON.parse(fs.readFileSync(join(root, 'mdd/mdd.config.json'), 'utf8'));
    assert.deepEqual(saved.profiles.default.answers, { mode: 'automatic', summary: 'medium' });
    fs.unlinkSync(join(root, 'mdd/mdd.config.json'));
  }
});

test('CLI doctor uses fake global roots; retired init and target arguments are rejected', t => {
  const root = fixture(t); initProject(root); const cli = resolve('dist/cli.js');
  const report = spawnSync(process.execPath, [cli, 'doctor'], { cwd: root, encoding: 'utf8' }); assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).ready, true);
  const init = spawnSync(process.execPath, [cli, 'init'], { cwd: root, encoding: 'utf8' }); assert.equal(init.status, 2);
  assert.match(init.stderr, /Comando desconocido: init/);
  const extra = spawnSync(process.execPath, [cli, 'doctor', 'extra'], { cwd: root, encoding: 'utf8' }); assert.equal(extra.status, 2);
  const retired = spawnSync(process.execPath, [cli, 'setup', root], { encoding: 'utf8' }); assert.equal(retired.status, 2); assert.match(retired.stderr, /Uso: mdd-ai setup/);
  const missing = fixture(t, false);
  const notReady = spawnSync(process.execPath, [cli, 'doctor'], { cwd: missing, encoding: 'utf8', env: { ...process.env, HOME: join(missing, '..'), USERPROFILE: join(missing, '..'), XDG_CONFIG_HOME: join(missing, '..') } });
  assert.equal(notReady.status, 1);
  assert.equal(JSON.parse(notReady.stdout).ready, false);
});

test('supported Node version boundaries accept 24.6+/24.x and 26.4+/26.x and reject the rest', () => {
  assert.equal(isSupportedNodeVersion('24.6.0'), true);
  assert.equal(isSupportedNodeVersion('24.13.4'), true);
  assert.equal(isSupportedNodeVersion('26.4.0'), true);
  assert.equal(isSupportedNodeVersion('26.9.0'), true);
  assert.equal(isSupportedNodeVersion('24.5.9'), false);
  assert.equal(isSupportedNodeVersion('25.0.0'), false);
  assert.equal(isSupportedNodeVersion('26.3.9'), false);
});
