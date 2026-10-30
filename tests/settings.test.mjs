import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { activeProfile, agentFor, defaultSettings, parseSettings, loadSettings, saveSettings, MODEL_ROLES, MODES, SUMMARIES } from '../dist/settings.js';
import { LocalFiles } from '../dist/local-files.js';
import { runConfigUI } from '../dist/config-ui.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('absent settings are the defaults and reading never writes', t => {
  const root = fixture(t);
  const first = loadSettings(root);
  assert.deepEqual(first, defaultSettings());
  assert.deepEqual(first.profiles.default, { models: {}, answers: {} });
  first.profiles.default.answers.mode = 'automatic';
  assert.deepEqual(loadSettings(root), defaultSettings());
  assert.deepEqual(fs.readdirSync(root), []);
});

test('settings round trip profiles, every model role, nested model paths and preferences', t => {
  const root = fixture(t);
  const input = defaultSettings();
  input.profiles.work = { models: Object.fromEntries(MODEL_ROLES.map(role => [role, 'provider/team/model:version#high'])), answers: { mode: 'interactive', summary: 'detailed' } };
  input.activeProfile = 'work';
  const saved = saveSettings(root, input);
  assert.deepEqual(loadSettings(root), saved);
  assert.equal(activeProfile(saved).answers.mode, 'interactive');
  assert.deepEqual(fs.readdirSync(root), ['mdd.config.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(join(root, 'mdd.config.json')).mode & 0o777, 0o600);
});

test('every model role maps to an installed agent', () => {
  assert.equal(agentFor('orchestrator'), 'mdd-orchestrator');
  for (const role of MODEL_ROLES.filter(role => role !== 'orchestrator')) assert.equal(agentFor(role), role);
  for (const role of ['mdd-risk', 'mdd-security', 'mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix']) assert.ok(MODEL_ROLES.includes(role), role);
});

test('optional native subagent models round trip independently from installed roles', t => {
  const root = fixture(t);
  const settings = defaultSettings();
  settings.profiles.work = { models: { orchestrator: 'p/coordinator' }, answers: { mode: 'automatic' },
    subagentModels: { explore: 'provider/team/model#high', general: 'p/general' } };
  settings.activeProfile = 'work';
  assert.deepEqual(saveSettings(root, settings), settings);
  assert.deepEqual(loadSettings(root), settings);
  assert.deepEqual(activeProfile(loadSettings(root)).subagentModels, settings.profiles.work.subagentModels);
  assert.equal(loadSettings(root).profiles.default.subagentModels, undefined);
  assert.ok(!MODEL_ROLES.includes('explore') && !MODEL_ROLES.includes('general'));
});

test('native subagent model maps reject unknown targets and invalid model references', () => {
  for (const subagentModels of [{ build: 'p/m' }, { 'mdd-explore': 'p/m' }, { explore: 'model' },
    { general: '' }, { explore: null }, [], null]) {
    const settings = defaultSettings();
    settings.profiles.default.subagentModels = subagentModels;
    assert.throws(() => parseSettings(settings));
  }
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/mdd-config.schema.json', import.meta.url), 'utf8'));
  const map = schema.$defs.profile.properties.subagentModels;
  assert.deepEqual(Object.keys(map.properties), ['explore', 'general']);
  assert.equal(map.additionalProperties, false);
  for (const entry of Object.values(map.properties)) assert.deepEqual(entry, { $ref: '#/$defs/model' });
});

test('settings written by earlier versions still load: retired keys are accepted and dropped', t => {
  const legacy = {
    version: 1, activeProfile: 'default',
    profiles: { default: { models: { 'mdd-apply': 'p/m' }, answers: { certainty: 'very-sure', artifactStore: 'local', complexity: 'low', mode: 'automatic', summary: 'low' } } },
    engram: { endpoint: 'http://127.0.0.1:7437' }, telemetry: { enabled: false }, workers: { enabled: true },
    knowledge: { enabled: true }, guards: { enabled: false }, verify: { automaticCorrections: 2 },
  };
  const parsed = parseSettings(legacy);
  assert.deepEqual(parsed, { version: 1, activeProfile: 'default', profiles: { default: { models: { 'mdd-apply': 'p/m' }, answers: { mode: 'automatic', summary: 'low' } } } });
  const root = fixture(t);
  const text = `${JSON.stringify(legacy, null, '\t')}\r\n`;
  fs.writeFileSync(join(root, 'mdd.config.json'), text);
  assert.deepEqual(loadSettings(root), parsed);
  assert.equal(fs.readFileSync(join(root, 'mdd.config.json'), 'utf8'), text, 'loading never rewrites the file');
});

const invalid = [
  null, [], {}, { ...defaultSettings(), version: 2 }, { ...defaultSettings(), unknown: 1 },
  { ...defaultSettings(), activeProfile: 'missing' }, { ...defaultSettings(), profiles: {} },
  { ...defaultSettings(), profiles: { default: { answers: { mode: 'guess' } } } },
  { ...defaultSettings(), profiles: { default: { answers: { summary: 'huge' } } } },
  { ...defaultSettings(), profiles: { default: { answers: { extra: true } } } },
  { ...defaultSettings(), profiles: { default: { secret: 'x' } } },
  { ...defaultSettings(), profiles: { default: { models: { wrong: 'provider/model' } } } },
  ...['../escape', 'a/b', 'a\\b', '__proto__', 'constructor', 'prototype', 'toString', 'CON', '', 'a'.repeat(65)].map(name => ({ version: 1, activeProfile: name, profiles: { [name]: {} } })),
  ...['model', '/model', 'provider/', 'provider/../model', 'provider//model', 'provider/a b', 'provider/a\n', 'https://secret@host/model'].map(model => ({ ...defaultSettings(), profiles: { default: { models: { orchestrator: model } } } })),
  Object.assign(Object.create({ hidden: true }), defaultSettings()),
];
for (const [index, value] of invalid.entries()) {
  test(`settings reject malformed or unsafe input ${index}`, () => assert.throws(() => parseSettings(value)));
}

test('preferences accept exactly the documented values', () => {
  for (const mode of MODES) assert.equal(parseSettings({ ...defaultSettings(), profiles: { default: { answers: { mode } } } }).profiles.default.answers.mode, mode);
  for (const summary of SUMMARIES) assert.equal(parseSettings({ ...defaultSettings(), profiles: { default: { answers: { summary } } } }).profiles.default.answers.summary, summary);
});

test('malformed JSON and invalid saves preserve the file bytes', t => {
  const root = fixture(t);
  const path = join(root, 'mdd.config.json');
  fs.writeFileSync(path, '{');
  assert.throws(() => loadSettings(root), /malformed JSON/);
  assert.throws(() => saveSettings(root, {}));
  assert.equal(fs.readFileSync(path, 'utf8'), '{');
  fs.writeFileSync(path, '\uFEFF' + JSON.stringify(defaultSettings()));
  assert.deepEqual(loadSettings(root), defaultSettings());
});

test('a failed atomic rename leaves the original bytes and cleans temporary and lock files', t => {
  const root = fixture(t);
  saveSettings(root, defaultSettings());
  const before = fs.readFileSync(join(root, 'mdd.config.json'), 'utf8');
  const mock = t.mock.method(fs, 'renameSync', () => { throw new Error('simulated atomic rename failure'); });
  const edited = defaultSettings();
  edited.profiles.default.answers.mode = 'interactive';
  assert.throws(() => saveSettings(root, edited), /simulated atomic/);
  mock.mock.restore();
  assert.equal(fs.readFileSync(join(root, 'mdd.config.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root), ['mdd.config.json']);
});

test('a held write lock refuses a competing writer without touching the lock or the settings', t => {
  const root = fixture(t);
  saveSettings(root, defaultSettings());
  fs.writeFileSync(join(root, 'mdd.config.json.lock'), 'owner');
  assert.throws(() => saveSettings(root, defaultSettings()));
  assert.equal(fs.readFileSync(join(root, 'mdd.config.json.lock'), 'utf8'), 'owner');
});

test('fixed destinations and nonregular or hardlinked config cannot escape the root', t => {
  const root = fixture(t);
  assert.throws(() => new LocalFiles(root).update('../outside.json', () => '{}', 100));
  fs.mkdirSync(join(root, 'mdd.config.json'));
  assert.throws(() => loadSettings(root));
  const other = fixture(t);
  const outside = fixture(t);
  const target = join(outside, 'protected');
  fs.writeFileSync(target, JSON.stringify(defaultSettings()));
  fs.linkSync(target, join(other, 'mdd.config.json'));
  assert.throws(() => loadSettings(other));
  assert.throws(() => saveSettings(other, defaultSettings()));
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(defaultSettings()));
});

test('the documented JSON schema matches the supported roles and preferences', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/mdd-config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.$defs.profile.properties.models.properties), [...MODEL_ROLES]);
  assert.deepEqual(schema.$defs.profile.properties.answers.properties.mode.enum, [...MODES]);
  assert.deepEqual(schema.$defs.profile.properties.answers.properties.summary.enum, [...SUMMARIES]);
  assert.deepEqual(schema.required, ['version', 'activeProfile', 'profiles']);
});

test('the editor sets a model and the preferences of the active profile', async t => {
  const root = fixture(t);
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  t.after(() => { process.env.XDG_CONFIG_HOME = previous; });
  const owned = join(root, 'opencode/mdd');
  fs.mkdirSync(owned, { recursive: true });
  // Menu: 2 = models (typed by hand, offline), 3 = preferences (interactive, detailed), 4 = save.
  const answers = ['2', ...MODEL_ROLES.map(role => role === 'mdd-security' ? 'provider/security#high' : ''), '3', '2', '3', '4'];
  let output = '';
  await runConfigUI(root, { isTTY: true, read: async () => answers.shift(), write: text => { output += text; } },
    { models: () => ({ status: 'unavailable', reason: 'Offline deterministic test.' }),
      variants: () => { throw new Error('Offline tests never query variants.'); } });
  assert.match(output, /mdd-security/);
  const saved = loadSettings(owned).profiles.default;
  assert.equal(saved.models['mdd-security'], 'provider/security#high');
  assert.deepEqual(saved.answers, { mode: 'interactive', summary: 'detailed' });
});
