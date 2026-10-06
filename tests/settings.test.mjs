import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { defaultSettings, parseSettings, loadSettings, saveSettings, freezeProfile, modelFor, MODEL_ROLES } from '../dist/settings.js';
import { LocalFiles } from '../dist/local-files.js';

function fixture(t) {
  const root = fs.mkdtempSync(join(tmpdir(), 'mdd-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('absent settings are detached, contain no guessed answers/models, and never write', t => {
  const root = fixture(t);
  const first = loadSettings(root);
  assert.deepEqual(first, defaultSettings());
  assert.deepEqual(first.profiles.default, { models: {}, answers: {} });
  first.profiles.default.answers.mode = 'automatic';
  assert.deepEqual(loadSettings(root), defaultSettings());
  assert.deepEqual(fs.readdirSync(root), []);
});

test('versioned settings round trip, active profile, all roles, nested model paths and startup freeze', t => {
  const root = fixture(t);
  const input = defaultSettings();
  input.profiles.work = { models: Object.fromEntries(MODEL_ROLES.map(role => [role, 'provider/team/model:version'])), answers: { mode: 'interactive' } };
  input.activeProfile = 'work';
  input.engram = { endpoint: 'http://127.0.0.1:7437/', project: 'mdd' };
  const saved = saveSettings(root, input);
  assert.equal(saved.engram.endpoint, 'http://127.0.0.1:7437');
  assert.deepEqual(loadSettings(root), saved);
  const frozen = freezeProfile(saved);
  input.profiles.work.models.orchestrator = 'other/model';
  saved.profiles.work.answers.mode = 'automatic';
  assert.equal(frozen.answers.mode, 'interactive');
  for (const role of MODEL_ROLES) assert.equal(modelFor(frozen, role), 'provider/team/model:version');
  assert.throws(() => { frozen.models.orchestrator = 'other/model'; }, TypeError);
  assert.equal(modelFor(freezeProfile(defaultSettings()), 'mdd-apply'), undefined);
  assert.throws(() => modelFor(frozen, '__proto__'));
  assert.deepEqual(fs.readdirSync(root), ['mdd.config.json']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(join(root, 'mdd.config.json')).mode & 0o777, 0o600);
});

test('Judgment Day roles round trip model variants independently and inherit when omitted', t => {
  const root = fixture(t);
  const roles = ['mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix'];
  for (const role of roles) assert.ok(MODEL_ROLES.includes(role), role);
  const settings = defaultSettings();
  settings.profiles.default.models = {
    orchestrator: 'provider/parent#low',
    'mdd-jd-judge-a': 'provider/team/judge#high',
    'mdd-jd-judge-b': 'other/judge#medium',
    'mdd-jd-fix': 'provider/fix',
  };
  saveSettings(root, settings);
  assert.deepEqual(loadSettings(root), settings);
  const profile = freezeProfile(loadSettings(root));
  for (const role of roles) {
    assert.equal(modelFor(profile, role), settings.profiles.default.models[role]);
    assert.equal(modelFor(freezeProfile(defaultSettings()), role), undefined);
    const inherited = defaultSettings();
    inherited.profiles.default.models.orchestrator = 'provider/parent#low';
    assert.equal(modelFor(freezeProfile(inherited), role), undefined);
    const invalid = structuredClone(settings);
    invalid.profiles.default.models[role] = 'provider/../model';
    assert.throws(() => parseSettings(invalid));
  }
  assert.throws(() => parseSettings({ ...settings, profiles: { default: { models: { 'jd-judge-a': 'p/m' } } } }));
});

const invalid = [
  null, [], {}, { ...defaultSettings(), version: 2 }, { ...defaultSettings(), unknown: 1 },
  { ...defaultSettings(), activeProfile: 'missing' }, { ...defaultSettings(), profiles: {} },
  { ...defaultSettings(), telemetry: { enabled: 'true' } }, { ...defaultSettings(), telemetry: { enabled: true, export: true } },
  { ...defaultSettings(), profiles: { default: { answers: { mode: 'guess' } } } },
  { ...defaultSettings(), profiles: { default: { answers: { extra: true } } } },
  { ...defaultSettings(), profiles: { default: { secret: 'x' } } },
  { ...defaultSettings(), profiles: { default: { models: { wrong: 'provider/model' } } } },
  ...['../escape', 'a/b', 'a\\b', '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'CON', '', 'a'.repeat(65)].map(name => ({ version: 1, activeProfile: name, profiles: { [name]: {} } })),
  ...['model', '/model', 'provider/', 'provider/../model', 'provider//model', 'provider/a b', 'provider/a\n', 'https://secret@host/model'].map(model => ({ ...defaultSettings(), profiles: { default: { models: { orchestrator: model } } } })),
  ...['https://127.0.0.1:7437', 'http://localhost:7437', 'http://127.0.0.1:65536', 'http://127.0.0.1:0', 'http://127.0.0.1:7437/path', 'http://user:secret@127.0.0.1:7437'].map(endpoint => ({ ...defaultSettings(), engram: { endpoint, project: 'mdd' } })),
  { ...defaultSettings(), engram: { endpoint: 'http://127.0.0.1:7437', project: 'mdd', sessionID: 'invented' } },
  Object.assign(Object.create({ hidden: true }), defaultSettings()),
  JSON.parse('{"version":1,"activeProfile":"default","profiles":{"default":{}},"__proto__":{}}'),
];
for (const [index, value] of invalid.entries()) {
  test(`settings reject malformed/unsafe input ${index}`, () => assert.throws(() => parseSettings(value)));
}

test('settings malformed JSON and invalid saves preserve bytes', t => {
  const root = fixture(t);
  const path = join(root, 'mdd.config.json');
  fs.writeFileSync(path, '{');
  assert.throws(() => loadSettings(root), /malformed JSON/);
  assert.throws(() => saveSettings(root, {}));
  assert.equal(fs.readFileSync(path, 'utf8'), '{');
  fs.writeFileSync(path, '\uFEFF' + JSON.stringify(defaultSettings()));
  assert.deepEqual(loadSettings(root), defaultSettings());
});

test('atomic rename failure leaves original bytes and cleans own temporary and lock files', t => {
  const root = fixture(t);
  saveSettings(root, defaultSettings());
  const before = fs.readFileSync(join(root, 'mdd.config.json'), 'utf8');
  const mock = t.mock.method(fs, 'renameSync', () => { throw new Error('simulated atomic rename failure'); });
  const edited = defaultSettings();
  edited.telemetry.enabled = false;
  assert.throws(() => saveSettings(root, edited), /simulated atomic/);
  mock.mock.restore();
  assert.equal(fs.readFileSync(join(root, 'mdd.config.json'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(root), ['mdd.config.json']);
});

test('write lock refuses competing writers without changing their lock or settings', t => {
  const root = fixture(t);
  saveSettings(root, defaultSettings());
  fs.writeFileSync(join(root, 'mdd.config.json.lock'), 'owner');
  assert.throws(() => saveSettings(root, defaultSettings()));
  assert.equal(fs.readFileSync(join(root, 'mdd.config.json.lock'), 'utf8'), 'owner');
  assert.equal(loadSettings(root).telemetry.enabled, true);
});

test('fixed destinations and nonregular config cannot escape the root', t => {
  const root = fixture(t);
  const files = new LocalFiles(root);
  assert.throws(() => files.update('../outside.json', () => '{}', 100));
  fs.mkdirSync(join(root, 'mdd.config.json'));
  assert.throws(() => loadSettings(root));
  assert.throws(() => saveSettings(root, defaultSettings()));
});

test('hardlinked config is rejected for reads and replacement', t => {
  const root = fixture(t);
  const outside = fixture(t);
  const target = join(outside, 'protected');
  fs.writeFileSync(target, JSON.stringify(defaultSettings()));
  fs.linkSync(target, join(root, 'mdd.config.json'));
  assert.throws(() => loadSettings(root));
  assert.throws(() => saveSettings(root, defaultSettings()));
  assert.equal(fs.readFileSync(target, 'utf8'), JSON.stringify(defaultSettings()));
});

test('symlinked project root is refused (junction on Windows)', t => {
  const root = fixture(t);
  const outside = fixture(t);
  const link = join(root, 'linked');
  fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => saveSettings(link, defaultSettings()));
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('documented JSON schema matches supported roles/tokens and the guide example parses', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/mdd-config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.$defs.profile.properties.models.properties), [...MODEL_ROLES]);
  const guide = fs.readFileSync(new URL('../docs/configuration.md', import.meta.url), 'utf8');
  const example = JSON.parse(guide.match(/```json\n([\s\S]*?)\n```/)[1]);
  const parsed = parseSettings(example);
  for (const [field, value] of Object.entries(parsed.profiles.work.answers)) {
    assert.ok(schema.$defs.profile.properties.answers.properties[field].enum.includes(value));
  }
  assert.equal(parsed.activeProfile, 'work');
  assert.deepEqual(schema.required, ['version', 'activeProfile', 'profiles']);
});
