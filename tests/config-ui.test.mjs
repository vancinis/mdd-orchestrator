import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
// Menu: 1 Perfiles, 2 Modelos, 3 Preferencias, 4 Guardar y salir, 5 Cancelar.
const SAVE = '4';
const CANCEL = '5';
// The models menu reads the user's installed catalog; tests inject it for determinism.
const noVariants = () => ({ status: 'unavailable', reason: 'variantes no disponibles en el test' });
const noCatalog = { models: () => ({ status: 'unavailable', reason: 'catálogo no disponible en el test' }), variants: noVariants };
const catalog = (models, variants = {}) => ({ models: () => ({ status: 'ok', models }), variants: () => ({ status: 'ok', variants }) });
const sample = ['openai/gpt-a', 'openai/gpt-b', 'zai/glm-1'];

function assertSpawn(result, started) {
  const token = value => typeof value === 'string' && /^[A-Z_0-9]{1,40}$/.test(value) ? value : null;
  const diagnostic = `config UI elapsedMs=${Math.round(performance.now() - started)} code=${token(result.error?.code)} status=${Number.isInteger(result.status) ? result.status : null} signal=${token(result.signal)}`;
  assert.ok(!result.error && result.signal === null, diagnostic);
}

test('R06: config UI failures report bounded subprocess metadata', () => {
  const result = { status: null, signal: 'SIGTERM', error: Object.assign(new Error('PRIVATE'), { code: 'ETIMEDOUT' }) };
  assert.throws(() => assertSpawn(result, performance.now()), error => {
    assert.match(error.message, /elapsedMs=\d+ code=ETIMEDOUT status=null signal=SIGTERM/);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
});

function invoke(root, ...args) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assertSpawn(result, started);
  return result;
}

test('the main menu offers only profiles, models, preferences, save and cancel', async t => {
  const root = fixture(t);
  const script = scripted([CANCEL]);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'cancelled');
  const text = script.output.join('');
  for (const [index, label] of ['Perfiles', 'Modelos', 'Preferencias', 'Guardar y salir', 'Cancelar'].entries()) {
    assert.match(text, new RegExp(`^.\\s${index + 1}\\s{2}${label}`, 'm'), label);
  }
  assert.doesNotMatch(text, /Engram|Telemetr|Workers|memoria|certeza/i);
  assert.deepEqual(readdirSync(root), []);
});

test('scripted terminal creates profile, edits every model and both preferences, and saves', async t => {
  const root = fixture(t);
  const script = scripted(['1', '1', 'work', '2', ...MODEL_ROLES.map(() => 'provider/team/model'),
    '3', '2', '1', SAVE]);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  const settings = loadSettings(root);
  assert.equal(settings.activeProfile, 'work');
  assert.deepEqual(settings.profiles.work.models, Object.fromEntries(MODEL_ROLES.map(role => [role, 'provider/team/model'])));
  assert.deepEqual(settings.profiles.work.answers, { mode: 'interactive', summary: 'low' });
  assert.deepEqual(settings.profiles.default, { models: {}, answers: {} });
  assert.deepEqual(Object.keys(settings).sort(), ['activeProfile', 'profiles', 'version']);
  assert.match(script.output.join(''), /Modo de avance {2}\(1\/2\)/);
  assert.match(script.output.join(''), /Nivel de detalle de los reportes {2}\(2\/2\)/);
  assert.match(script.output.join(''), /Reiniciá OpenCode/);
  assert.deepEqual(readdirSync(root), ['mdd.config.json']);
});

test('terminal edits existing profile, clears a model and a preference, and switches active profile', async t => {
  const root = fixture(t);
  await runConfigUI(root, scripted(['1', '1', 'work', '2', ...MODEL_ROLES.map(() => 'p/m'), '3', '2', '1', SAVE]).io, noCatalog);
  // Models: clear orchestrator, keep the rest. Preferences: clear mode, keep summary with Enter.
  await runConfigUI(root, scripted(['2', '-', ...MODEL_ROLES.slice(1).map(() => ''), '3', '3', '', '1', '2', 'default', SAVE]).io, noCatalog);
  const settings = loadSettings(root);
  assert.equal(settings.activeProfile, 'default');
  assert.equal(settings.profiles.work.models.orchestrator, undefined);
  assert.equal(settings.profiles.work.models['mdd-verify'], 'p/m');
  assert.deepEqual(settings.profiles.work.answers, { summary: 'low' });
});

test('preferences set mode and summary, Enter keeps the current values, and Sin fijar clears them', async t => {
  const root = fixture(t);
  const set = scripted(['3', '1', '3', SAVE]);
  assert.equal(await runConfigUI(root, set.io, noCatalog), 'saved');
  assert.deepEqual(loadSettings(root).profiles.default.answers, { mode: 'automatic', summary: 'detailed' });
  assert.match(set.output.join(''), /Sin fijar/);

  const keep = scripted(['3', '', '', SAVE]);
  assert.equal(await runConfigUI(root, keep.io, noCatalog), 'saved');
  assert.deepEqual(loadSettings(root).profiles.default.answers, { mode: 'automatic', summary: 'detailed' });
  const shown = keep.output.join('');
  assert.match(shown, /Modo\s+Automático/);
  assert.match(shown, /Detalle\s+Detallado/);
  assert.match(shown, /❯ 1 {2}Automático/);
  assert.match(shown, /❯ 3 {2}Detallado/);

  const clear = scripted(['3', 'Sin fijar', '4', SAVE]);
  assert.equal(await runConfigUI(root, clear.io, noCatalog), 'saved');
  assert.deepEqual(loadSettings(root).profiles.default.answers, {});
  const reopened = scripted([CANCEL]);
  await runConfigUI(root, reopened.io, noCatalog);
  assert.match(reopened.output.join(''), /Modo\s+Sin fijar/);
  assert.match(reopened.output.join(''), /Detalle\s+Sin fijar/);
});

test('preference edits are drafts: cancel and EOF leave the saved bytes untouched', async t => {
  const root = fixture(t);
  await runConfigUI(root, scripted(['3', '2', '2', SAVE]).io, noCatalog);
  const before = readFileSync(join(root, 'mdd.config.json'), 'utf8');
  for (const exit of [[CANCEL], []]) {
    assert.equal(await runConfigUI(root, scripted(['3', '1', '3', ...exit]).io, noCatalog), 'cancelled');
    assert.equal(readFileSync(join(root, 'mdd.config.json'), 'utf8'), before);
  }
});

test('retired settings keys are accepted on load and dropped on the next save', async t => {
  const root = fixture(t);
  writeFileSync(join(root, 'mdd.config.json'), JSON.stringify({
    version: 1, activeProfile: 'default',
    profiles: { default: { models: {}, answers: { artifactStore: 'both', certainty: 'very-sure', complexity: 'high', mode: 'automatic' } } },
    engram: { endpoint: 'http://127.0.0.1:7437' }, telemetry: { enabled: false }, workers: { enabled: true },
  }));
  const script = scripted([SAVE]);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  const saved = JSON.parse(readFileSync(join(root, 'mdd.config.json'), 'utf8'));
  assert.deepEqual(saved, { version: 1, activeProfile: 'default', profiles: { default: { models: {}, answers: { mode: 'automatic' } } } });
  assert.match(script.output.join(''), /Modo\s+Automático/);
});

test('cancel and EOF discard all draft edits, both absent and existing settings', async t => {
  const root = fixture(t);
  assert.equal(await runConfigUI(root, scripted(['1', '1', 'discard', ':cancel']).io), 'cancelled');
  assert.deepEqual(readdirSync(root), []);
  assert.equal(await runConfigUI(root, scripted(['1', '1', 'discard']).io), 'cancelled');
  assert.deepEqual(readdirSync(root), []);
  await runConfigUI(root, scripted([SAVE]).io);
  const before = readFileSync(join(root, 'mdd.config.json'), 'utf8');
  assert.equal(await runConfigUI(root, scripted(['1', '1', 'discard', CANCEL]).io), 'cancelled');
  assert.equal(readFileSync(join(root, 'mdd.config.json'), 'utf8'), before);
});

test('invalid edits are actionable; unset preferences stay unset on Enter', async t => {
  const root = fixture(t);
  const script = scripted(['1', '1', '../bad', '3', '', '', SAVE]);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  assert.match(script.output.join(''), /safe/);
  assert.deepEqual(loadSettings(root).profiles.default.answers, {});
  assert.deepEqual(Object.keys(loadSettings(root).profiles), ['default']);
});

test('creating a duplicate profile is reported and the draft continues', async t => {
  const root = fixture(t);
  const script = scripted(['1', '1', 'default', SAVE]);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  assert.match(script.output.join(''), /Ese perfil ya existe/);
  assert.deepEqual(Object.keys(loadSettings(root).profiles), ['default']);
});

// Regression: a well-formed but nonexistent model such as global/shared passes the format
// check and then makes OpenCode discard the whole agent at startup.
test('models are picked from the installed catalog by provider, never typed blind', async t => {
  const root = fixture(t);
  const script = scripted(['2', '2', '1', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
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
  await runConfigUI(root, scripted(['2', '2', '2', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]).io, catalog(sample));
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-b');
  const keep = scripted(['2', ...MODEL_ROLES.map(() => ''), SAVE]);
  await runConfigUI(root, keep.io, catalog(sample));
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-b');
  assert.match(keep.output.join(''), /❯ 1 {2}Mantener lo actual\s+openai\/gpt-b/);
  const stale = scripted(['2', ...MODEL_ROLES.map(() => ''), SAVE]);
  await runConfigUI(root, stale.io, catalog(['zai/glm-1']));
  assert.match(stale.output.join(''), /Atención: orchestrator=openai\/gpt-b no está entre los modelos instalados/);
  const inherit = scripted(['2', '2', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
  await runConfigUI(root, inherit.io, catalog(sample));
  assert.deepEqual(loadSettings(root).profiles.default.models, {});
});

test('effort is optional: a model with variants offers a default plus each variant, appended as #variant', async t => {
  const root = fixture(t);
  const withEffort = catalog(sample, { 'openai/gpt-a': ['high', 'low'] });
  // modelos -> orchestrator: openai -> gpt-a -> effort 'high' (2nd variant option, after the default entry).
  const script = scripted(['2', '2', '1', '2', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
  assert.equal(await runConfigUI(root, script.io, withEffort), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
  assert.match(script.output.join(''), /Esfuerzo \(opcional\) para openai\/gpt-a/);
  assert.match(script.output.join(''), /Por defecto del modelo/);
});

test('effort can be left at the model default, and a model without variants skips the step', async t => {
  const withEffort = catalog(sample, { 'openai/gpt-a': ['high', 'low'] });
  const rootDefault = fixture(t);
  const skipEffort = scripted(['2', '2', '1', '1', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
  assert.equal(await runConfigUI(rootDefault, skipEffort.io, withEffort), 'saved');
  assert.equal(loadSettings(rootDefault).profiles.default.models.orchestrator, 'openai/gpt-a');
  const rootNoVariant = fixture(t);
  const noEffortModel = scripted(['2', '2', '2', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
  assert.equal(await runConfigUI(rootNoVariant, noEffortModel.io, withEffort), 'saved');
  assert.equal(loadSettings(rootNoVariant).profiles.default.models.orchestrator, 'openai/gpt-b');
  assert.doesNotMatch(noEffortModel.output.join(''), /Esfuerzo/);
});

test('an existing #variant override is preread as current model and effort, and stays marked actual', async t => {
  const root = fixture(t);
  const withEffort = catalog(sample, { 'openai/gpt-a': ['high', 'low'] });
  await runConfigUI(root, scripted(['2', '2', '1', '2', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]).io, withEffort);
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
  const reopen = scripted(['2', ...MODEL_ROLES.map(() => ''), SAVE]);
  await runConfigUI(root, reopen.io, withEffort);
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
  assert.match(reopen.output.join(''), /❯ 1 {2}Mantener lo actual\s+openai\/gpt-a#high/);
});

test('a provider whose variant catalog is unavailable still saves the bare model, with a warning', async t => {
  const root = fixture(t);
  const brokenVariants = { models: () => ({ status: 'ok', models: sample }), variants: () => ({ status: 'unavailable', reason: 'sin red en el test' }) };
  const script = scripted(['2', '2', '1', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
  assert.equal(await runConfigUI(root, script.io, brokenVariants), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a');
  assert.match(script.output.join(''), /No se pudieron consultar los niveles de esfuerzo de openai: sin red en el test/);
});

test('an unavailable catalog falls back to free text and says the value is unverified', async t => {
  const root = fixture(t);
  const script = scripted(['2', 'openai/gpt-a', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a');
  assert.match(script.output.join(''), /no se pueden verificar/);
  assert.match(script.output.join(''), /descarte el agente al arrancar/);
  assert.match(script.output.join(''), /formato proveedor\/modelo\[#esfuerzo\]/);
});

test('the free-text fallback accepts a typed #variant suffix directly', async t => {
  const root = fixture(t);
  const script = scripted(['2', 'openai/gpt-a#high', ...MODEL_ROLES.slice(1).map(() => ''), SAVE]);
  assert.equal(await runConfigUI(root, script.io, noCatalog), 'saved');
  assert.equal(loadSettings(root).profiles.default.models.orchestrator, 'openai/gpt-a#high');
});

test('Judgment Day model editor selects variants, preserves and clears each independent role', async t => {
  const root = fixture(t);
  const roles = ['mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix'];
  for (const role of roles) assert.ok(MODEL_ROLES.includes(role), role);
  const choices = MODEL_ROLES.flatMap(role => roles.includes(role) ? ['2', '1', '2'] : ['']);
  const withEffort = catalog(sample, { 'openai/gpt-a': ['high'] });
  const choose = scripted(['2', ...choices, SAVE]);
  assert.equal(await runConfigUI(root, choose.io, withEffort), 'saved');
  const expected = Object.fromEntries(roles.map(role => [role, 'openai/gpt-a#high']));
  assert.deepEqual(loadSettings(root).profiles.default.models, expected);
  for (const role of roles) assert.ok(choose.output.join('').includes(role), role);
  assert.equal(await runConfigUI(root, scripted(['2', ...MODEL_ROLES.map(() => ''), SAVE]).io, withEffort), 'saved');
  assert.deepEqual(loadSettings(root).profiles.default.models, expected);
  const clear = MODEL_ROLES.map(role => roles.includes(role) ? '2' : '');
  assert.equal(await runConfigUI(root, scripted(['2', ...clear, SAVE]).io, withEffort), 'saved');
  assert.deepEqual(loadSettings(root).profiles.default.models, {});
});

test('nonTTY terminal and CLI reject immediately without reading input or writing settings', async t => {
  const root = fixture(t);
  const script = scripted([SAVE], false);
  await assert.rejects(runConfigUI(root, script.io), /terminal interactiva/);
  assert.deepEqual(script.prompts, []);
  const result = invoke(root, 'config');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /terminal interactiva/);
  assert.deepEqual(readdirSync(root), []);
});

test('isolated CLI smoke: profile create/use/list', t => {
  const root = fixture(t);
  assert.equal(invoke(root, 'profile', 'list').stdout, '* default\n');
  assert.deepEqual(readdirSync(root), []);
  assert.equal(invoke(root, 'profile', 'create', 'work').status, 0);
  assert.equal(invoke(root, 'profile', 'list').stdout, '  default\n* work\n');
  assert.equal(invoke(root, 'profile', 'use', 'default').status, 0);
  assert.equal(loadSettings(root).activeProfile, 'default');
  assert.deepEqual(loadSettings(root).profiles.work, { models: {}, answers: {} });
  assert.deepEqual(readdirSync(root), ['mdd.config.json']);
});

test('command validation and help are deterministic and preserve exit semantics', t => {
  const root = fixture(t);
  for (const args of [['profile'], ['profile', 'use', 'missing'], ['profile', 'create', '../bad'], ['profile', 'list', 'extra'],
    ['config', 'extra'], ['profile', '--help'],
    // Retired commands are now unknown.
    ['telemetry', 'status'], ['workers'], ['guards'], ['lessons'], ['retro'], ['init']]) {
    const result = invoke(root, ...args);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.equal(result.stdout, '');
  }
  const first = invoke(root, '--help');
  assert.equal(first.status, 0);
  assert.equal(first.stdout, invoke(root, '--help').stdout);
  assert.match(first.stdout, /mdd-ai config/);
  assert.match(first.stdout, /profile list/);
  assert.match(first.stdout, /Códigos de salida: 0/);
  assert.doesNotMatch(first.stdout, /telemetry|workers|init|lessons|retro/);
  assert.deepEqual(readdirSync(root), []);
});
