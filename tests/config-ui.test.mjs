import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { runConfigUI } from '../dist/config-ui.js';
import { loadSettings, MODEL_ROLES } from '../dist/settings.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mdd-ui-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  process.env.HOME = process.env.USERPROFILE = process.env.XDG_CONFIG_HOME = root;
  const owned = join(root, 'opencode/mdd'); mkdirSync(owned, { recursive: true });
  return owned;
}
function scripted(lines, isTTY = true) {
  const prompts = [];
  const output = [];
  return { prompts, output, io: { isTTY, write: text => output.push(text), read: async prompt => { prompts.push(prompt); return lines.shift(); } } };
}
// The models menu reads the user's installed catalog; tests inject it for determinism.
const noVariants = () => ({ status: 'unavailable', reason: 'variantes no disponibles en el test' });
const noCatalog = { models: () => ({ status: 'unavailable', reason: 'catálogo no disponible en el test' }), variants: noVariants };
const catalog = (models, variants = {}) => ({ models: () => ({ status: 'ok', models }), variants: provider => ({ status: 'ok', variants }) });
const sample = ['openai/gpt-a', 'openai/gpt-b', 'zai/glm-1'];

function invoke(root, ...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('scripted terminal creates profile, edits every model and preflight field, Engram setup and saves', async t => {
  const root = fixture(t);
  const script = scripted(['1', '1', 'work', '2', ...MODEL_ROLES.map(() => 'provider/team/model'),
    '3', '1', '4', '1', '3', '3', '4', '1', 'http://127.0.0.1:7437', '5', '2', '6']);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  const settings = loadSettings(root);
  assert.equal(settings.activeProfile, 'work');
  assert.deepEqual(settings.profiles.work.models, Object.fromEntries(MODEL_ROLES.map(role => [role, 'provider/team/model'])));
  assert.deepEqual(settings.profiles.work.answers, { certainty: 'very-sure', artifactStore: 'none', mode: 'interactive', summary: 'low', complexity: 'not-complex' });
  assert.deepEqual(settings.engram, { endpoint: 'http://127.0.0.1:7437' });
  assert.equal(settings.telemetry.enabled, false);
  assert.match(script.output.join(''), /Reiniciá OpenCode/);
  assert.deepEqual(readdirSync(root), ['mdd.config.json']);
});

test('terminal edits existing profile, clears answers/models and switches active profile', async t => {
  const root = fixture(t);
  await runConfigUI(root, scripted(['1', '1', 'work', '2', ...MODEL_ROLES.map(() => 'p/m'), '3', '1', '4', '1', '3', '3', '6']).io, noCatalog);
  await runConfigUI(root, scripted(['2', '-', ...MODEL_ROLES.slice(1).map(() => ''), '3', '4', '', '', '', '', '1', '2', 'default', '6']).io, noCatalog);
  const settings = loadSettings(root);
  assert.equal(settings.activeProfile, 'default');
  assert.equal(settings.profiles.work.models.orchestrator, undefined);
  assert.equal(settings.profiles.work.models['mdd-verify'], 'p/m');
  assert.equal(settings.profiles.work.answers.certainty, undefined);
  assert.equal(settings.profiles.work.answers.mode, 'interactive');
});

test('cancel and EOF discard all draft edits, both absent and existing settings', async t => {
  const root = fixture(t);
  assert.equal(await runConfigUI(root, scripted(['1', '1', 'discard', ':cancel']).io), 'cancelled');
  assert.deepEqual(readdirSync(root), []);
  assert.equal(await runConfigUI(root, scripted(['1', '1', 'discard']).io), 'cancelled');
  assert.deepEqual(readdirSync(root), []);
  await runConfigUI(root, scripted(['6']).io);
  const before = readFileSync(join(root, 'mdd.config.json'), 'utf8');
  await runConfigUI(root, scripted(['1', '1', 'discard', '7']).io);
  assert.equal(readFileSync(join(root, 'mdd.config.json'), 'utf8'), before);
});

test('invalid edits are actionable; partial answers stay unanswered on Enter', async t => {
  const root = fixture(t);
  const script = scripted(['1', '1', '../bad', '3', '', '', '', '', '', '6']);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  assert.match(script.output.join(''), /safe/);
  assert.deepEqual(loadSettings(root).profiles.default.answers, {});
});

// Regression: a well-formed but nonexistent model such as global/shared passes the format
// check and then makes OpenCode discard the whole agent at startup.
test('models are picked from the installed catalog by provider, never typed blind', async t => {
  const root = fixture(t);
  const script = scripted(['2', '2', '1', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  assert.equal(await runConfigUI(root, script.io, catalog(sample)), 'saved');
  assert.deepEqual(loadSettings(root).profiles.default.models, { orchestrator: 'openai/gpt-a' });
  const text = script.output.join('');
  assert.match(text, /3 modelos disponibles en 2 proveedores/);
  assert.match(text, /^ {2}2 {2}openai/m);
  assert.match(text, /^❯ 1 {2}Mantener lo actual/m);
  assert.doesNotMatch(text, /formato proveedor\/modelo/);
});

test('an existing override can be kept or inherited, and an unknown one is flagged', async t => {
  const root = fixture(t);
  await runConfigUI(root, scripted(['2', '2', '2', ...MODEL_ROLES.slice(1).map(() => ''), '6']).io, catalog(sample));
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-b');
  const keep = scripted(['2', ...MODEL_ROLES.map(() => ''), '6']);
  await runConfigUI(root, keep.io, catalog(sample));
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-b');
  assert.match(keep.output.join(''), /❯ 1 {2}Mantener lo actual\s+openai\/gpt-b/);
  const stale = scripted(['2', ...MODEL_ROLES.map(() => ''), '6']);
  await runConfigUI(root, stale.io, catalog(['zai/glm-1']));
  assert.match(stale.output.join(''), /Atención: orchestrator=openai\/gpt-b no está entre los modelos instalados/);
  const inherit = scripted(['2', '2', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  await runConfigUI(root, inherit.io, catalog(sample));
  assert.deepEqual(loadSettings(root).profiles.default.models, {});
});

test('effort is optional: a model with variants offers a default plus each variant, appended as #variant', async t => {
  const root = fixture(t);
  const withEffort = catalog(sample, { 'openai/gpt-a': ['high', 'low'] });
  // modelos -> orchestrator: openai -> gpt-a -> effort 'high' (2nd variant option, after the default entry).
  const script = scripted(['2', '2', '1', '2', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  assert.equal(await runConfigUI(root, script.io, withEffort), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
  assert.match(script.output.join(''), /Esfuerzo \(opcional\) para openai\/gpt-a/);
  assert.match(script.output.join(''), /Por defecto del modelo/);
});

test('effort can be left at the model default, and a model without variants skips the step', async t => {
  const withEffort = catalog(sample, { 'openai/gpt-a': ['high', 'low'] });
  const rootDefault = fixture(t);
  const skipEffort = scripted(['2', '2', '1', '1', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  assert.equal(await runConfigUI(rootDefault, skipEffort.io, withEffort), 'saved');
  assert.equal(loadSettings(rootDefault).profiles.default.models.orchestrator, 'openai/gpt-a');
  const rootNoVariant = fixture(t);
  const noEffortModel = scripted(['2', '2', '2', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  assert.equal(await runConfigUI(rootNoVariant, noEffortModel.io, withEffort), 'saved');
  assert.equal(loadSettings(rootNoVariant).profiles.default.models.orchestrator, 'openai/gpt-b');
  assert.doesNotMatch(noEffortModel.output.join(''), /Esfuerzo/);
});

test('an existing #variant override is preread as current model and effort, and stays marked actual', async t => {
  const root = fixture(t);
  const withEffort = catalog(sample, { 'openai/gpt-a': ['high', 'low'] });
  await runConfigUI(root, scripted(['2', '2', '1', '2', ...MODEL_ROLES.slice(1).map(() => ''), '6']).io, withEffort);
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
  const reopen = scripted(['2', ...MODEL_ROLES.map(() => ''), '6']);
  await runConfigUI(root, reopen.io, withEffort);
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
  assert.match(reopen.output.join(''), /❯ 1 {2}Mantener lo actual\s+openai\/gpt-a#high/);
});

test('a provider whose variant catalog is unavailable still saves the bare model, with a warning', async t => {
  const root = fixture(t);
  const brokenVariants = { models: () => ({ status: 'ok', models: sample }), variants: () => ({ status: 'unavailable', reason: 'sin red en el test' }) };
  const script = scripted(['2', '2', '1', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  assert.equal(await runConfigUI(root, script.io, brokenVariants), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a');
  assert.match(script.output.join(''), /No se pudieron consultar los niveles de esfuerzo de openai: sin red en el test/);
});

test('an unavailable catalog falls back to free text and says the value is unverified', async t => {
  const root = fixture(t);
  const script = scripted(['2', 'openai/gpt-a', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a');
  assert.match(script.output.join(''), /no se pueden verificar/);
  assert.match(script.output.join(''), /descarte el agente al arrancar/);
  assert.match(script.output.join(''), /formato proveedor\/modelo\[#esfuerzo\]/);
});

test('the free-text fallback accepts a typed #variant suffix directly', async t => {
  const root = fixture(t);
  const script = scripted(['2', 'openai/gpt-a#high', ...MODEL_ROLES.slice(1).map(() => ''), '6']);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
});

test('nonTTY terminal and CLI reject immediately without reading input or writing settings', async t => {
  const root = fixture(t);
  const script = scripted(['6'], false);
  await assert.rejects(runConfigUI(root, script.io), /terminal interactiva/);
  assert.deepEqual(script.prompts, []);
  const result = invoke(root, 'config');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /terminal interactiva/);
  assert.deepEqual(readdirSync(root), []);
});

test('isolated CLI smoke: profile create/use/list and telemetry on/off/status/clear', t => {
  const root = fixture(t);
  assert.equal(invoke(root, 'profile', 'list').stdout, '* default\n');
  assert.deepEqual(readdirSync(root), []);
  assert.equal(invoke(root, 'profile', 'create', 'work').status, 0);
  assert.equal(invoke(root, 'profile', 'list').stdout, '  default\n* work\n');
  assert.equal(invoke(root, 'profile', 'use', 'default').status, 0);
  assert.equal(invoke(root, 'telemetry', 'off').status, 0);
  assert.equal(JSON.parse(invoke(root, 'telemetry', 'status').stdout).enabled, false);
  assert.equal(invoke(root, 'telemetry', 'on').status, 0);
  assert.equal(JSON.parse(invoke(root, 'telemetry', 'clear').stdout).count, 0);
  assert.equal(loadSettings(root).activeProfile, 'default');
  assert.deepEqual(loadSettings(root).profiles.work.answers, {});
  assert.deepEqual(readdirSync(root), ['mdd.config.json']);
});

test('new command validation and help are deterministic and preserve exit semantics', t => {
  const root = fixture(t);
  for (const args of [['profile'], ['profile', 'use', 'missing'], ['profile', 'create', '../bad'], ['profile', 'list', 'extra'],
    ['telemetry'], ['telemetry', 'export'], ['telemetry', 'off', 'extra'], ['config', 'extra'], ['profile', '--help']]) {
    const result = invoke(root, ...args);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
  }
  const first = invoke(root, '--help');
  assert.equal(first.status, 0);
  assert.equal(first.stdout, invoke(root, '--help').stdout);
  assert.match(first.stdout, /simulación: la CLI no ejecuta ninguna fase/);
  assert.match(first.stdout, /profile list/);
  assert.match(first.stdout, /Códigos de salida: 0/);
  assert.deepEqual(readdirSync(root), []);
});
