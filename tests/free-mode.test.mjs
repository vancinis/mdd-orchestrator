import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { defaultSettings, freeMode, parseSettings } from '../dist/settings.js';
import { FREE_ACTOR_LINE, STRICT_COORDINATOR } from '../dist/guards.js';
import { mddIssuedTask, pinPhaseAgents, strictCoordinator } from '../dist/opencode-plugin.js';
import { ACTOR_INSTRUCTIONS_MARKER, DISPATCH_HANDLE_PREFIX } from '../dist/phase-runner.js';
import { settingsCommand } from '../dist/settings-cli.js';
import { loadGlobalSettings } from '../dist/global-settings.js';
import { isolateHome } from './adapter-fixture.mjs';

test('guards are off by default, so MDD starts free', () => {
  assert.deepEqual(defaultSettings().guards, { enabled: false });
  assert.equal(freeMode(defaultSettings()), true);
  // A settings file written before the key existed is free too.
  assert.equal(freeMode(parseSettings({ version: 1, activeProfile: 'default', profiles: { default: {} } })), true);
  assert.equal(freeMode(undefined), true);
});

test('guards.enabled is a strict boolean that turns the strict workflow on', () => {
  const base = { version: 1, activeProfile: 'default', profiles: { default: {} } };
  assert.equal(freeMode(parseSettings({ ...base, guards: { enabled: true } })), false);
  assert.equal(freeMode(parseSettings({ ...base, guards: { enabled: false } })), true);
  assert.throws(() => parseSettings({ ...base, guards: { enabled: 'yes' } }), /guards\.enabled must be boolean/);
  assert.throws(() => parseSettings({ ...base, guards: { enabled: true, extra: 1 } }));
});

test('free phase actors keep delegation and skills; strict ones are pinned', () => {
  const free = { agent: { 'mdd-apply': { tools: { bash: true } } } };
  pinPhaseAgents(free, true);
  for (const name of ['mdd-explore', 'mdd-apply', 'mdd-verify', 'mdd-risk']) {
    assert.equal(free.agent[name].tools.task, undefined, name);
    assert.equal(free.agent[name].tools.skill, undefined, name);
    assert.equal(free.agent[name].tools.mdd_check_report, true, name);
  }
  assert.equal(free.agent['mdd-apply'].tools.bash, true);
  const strict = { agent: {} };
  pinPhaseAgents(strict);
  for (const name of ['mdd-explore', 'mdd-apply', 'mdd-verify', 'mdd-risk']) {
    assert.equal(strict.agent[name].tools.task, false, name);
    assert.equal(strict.agent[name].tools.skill, false, name);
  }
  // The explicitly requested security audit keeps its isolation in both modes.
  assert.deepEqual(free.agent['mdd-security'].permission, { '*': 'deny', mdd_check_report: 'allow' });
});

test('strict mode appends its rules to the free coordinator definition exactly once', () => {
  const config = { agent: { 'mdd-orchestrator': { prompt: 'The user decides.' } } };
  strictCoordinator(config);
  strictCoordinator(config);
  const prompt = config.agent['mdd-orchestrator'].prompt;
  assert.ok(prompt.startsWith('The user decides.'));
  assert.equal(prompt.split('STRICT MODE').length, 2);
  assert.match(prompt, /Every fresh implementation, including precise edits, goes through mdd_adapt/);
  // A coordinator the host did not load from its definition is left untouched.
  const bare = { agent: {} };
  strictCoordinator(bare);
  assert.deepEqual(bare, { agent: {} });
});

test('only tasks MDD issued count as MDD dispatches in free mode', () => {
  assert.equal(mddIssuedTask({ subagent_type: 'mdd-apply', description: 'x', prompt: `${DISPATCH_HANDLE_PREFIX}abc` }), true);
  assert.equal(mddIssuedTask({ subagent_type: 'general', description: 'x', prompt: `Phase body\n${ACTOR_INSTRUCTIONS_MARKER}, which govern this phase: {}` }), true);
  assert.equal(mddIssuedTask({ subagent_type: 'general', description: 'x', prompt: 'Initialize the Expo project and add Supabase auth.' }), false);
  // An MDD actor name alone is not an MDD dispatch: the coordinator may use it for its own work.
  assert.equal(mddIssuedTask({ subagent_type: 'mdd-apply', description: 'x', prompt: 'Fix the login screen.' }), false);
  assert.equal(mddIssuedTask(undefined), false);
});

test('shipped coordinator definition is free; the strict rules live in the strict block', async () => {
  const asset = await readFile(new URL('../assets/opencode/agents/mdd-orchestrator.md', import.meta.url), 'utf8');
  assert.match(asset, /^The user decides\./m);
  assert.match(asset, /MDD is a toolkit, not a gate/);
  assert.match(asset, /MDD never refuses them, even while one of\s+its runs is active/);
  assert.doesNotMatch(asset, /Fresh implementation, including precise edits, uses mdd_adapt, never an untracked quick edit/);
  assert.doesNotMatch(asset, /never pick an arbitrary agent from the shared registry/);
  assert.doesNotMatch(asset, /MUST NOT use mdd_adapt/);
  assert.match(STRICT_COORDINATOR, /MUST NOT use mdd_adapt/);
  assert.match(STRICT_COORDINATOR, /Never pick an arbitrary agent from the shared registry/);
});

test('the free actor line is self-contained and leaves the by-value instructions unchanged', async () => {
  const instructions = await readFile(new URL('../assets/opencode/mdd-instructions.md', import.meta.url), 'utf8');
  // Strict prompts carry the same instructions as before; only free prompts gain this one line.
  assert.doesNotMatch(instructions, /MDD guards/);
  assert.ok(FREE_ACTOR_LINE.startsWith('MDD guards: off:'));
  assert.match(FREE_ACTOR_LINE, /are guidance/);
  assert.match(FREE_ACTOR_LINE, /Keep the report format/);
  // It counts against the same handoff budget as the phase's mandatory content.
  assert.ok(Buffer.byteLength(JSON.stringify(FREE_ACTOR_LINE)) <= 400);
});

test('mdd-ai guards switches the global mode and reports it', async t => {
  isolateHome(t);
  let written = '';
  const write = text => { written += text; };
  assert.equal(await settingsCommand(['guards', 'status'], process.cwd(), write), true);
  assert.deepEqual(JSON.parse(written), { enabled: false });
  written = '';
  await settingsCommand(['guards', 'on'], process.cwd(), write);
  assert.equal(loadGlobalSettings().guards.enabled, true);
  assert.match(written, /modo estricto/);
  written = '';
  await settingsCommand(['guards', 'off'], process.cwd(), write);
  assert.equal(loadGlobalSettings().guards.enabled, false);
  assert.match(written, /modo libre/);
  await assert.rejects(settingsCommand(['guards', 'maybe'], process.cwd(), write), /Uso: mdd guards/);
});
