import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Model } from '@opencode/plugin';
import plugin, { applyAgentPolicy, applySubagentModelPolicy, COORDINATOR, preferencesLine, startupSettings } from '../dist/opencode-plugin.js';
import { defaultSettings } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { isolateHome } from './helpers.mjs';

const draft = (id, extra = {}) => ({ id, permissions: [], ...extra });

test('the coordinator gets its configured model and one preferences line', () => {
  const settings = defaultSettings();
  settings.profiles.default.models.orchestrator = 'prov/coord#high';
  settings.profiles.default.answers = { mode: 'interactive', summary: 'low' };
  const agent = draft(COORDINATOR, { system: 'You are MDD.' });
  applyAgentPolicy(agent, settings);
  applyAgentPolicy(agent, settings);
  assert.deepEqual(agent.model, Model.Ref.parse('prov/coord#high'));
  assert.equal(agent.system.match(/MDD preferences: /g).length, 1, 'applying twice adds the line once');
  assert.match(agent.system, /mode=interactive; summary=low/);
});

test('unset preferences tell the coordinator to ask the mode and default the detail', () => {
  assert.match(preferencesLine({}), /mode=unset \(ask once per run\); summary=medium/);
});

test('roles without a configured model keep the native model', () => {
  const agent = draft('mdd-apply', { model: 'native' });
  applyAgentPolicy(agent, defaultSettings());
  assert.equal(agent.model, 'native');
});

test('judges are locked to the inspection tool and every other agent is denied it', () => {
  for (const id of ['mdd-jd-judge-a', 'mdd-jd-judge-b']) {
    const judge = draft(id);
    applyAgentPolicy(judge, defaultSettings());
    assert.deepEqual(judge.permissions, [
      { action: '*', resource: '*', effect: 'deny' }, { action: 'mdd_jd_inspect', resource: '*', effect: 'allow' }]);
  }
  for (const id of [COORDINATOR, 'mdd-apply', 'mdd-jd-fix', 'build']) {
    const agent = draft(id);
    applyAgentPolicy(agent, undefined);
    assert.deepEqual(agent.permissions, [{ action: 'mdd_jd_inspect', resource: '*', effect: 'deny' }]);
  }
});

test('invalid settings fall back to defaults instead of disabling the plugin', () => {
  const result = startupSettings(() => { throw new Error('settings.version must be 1.'); });
  assert.equal(result.settings, undefined);
  assert.match(result.problem, /version/);
});

test('scoped defaults affect only fresh native targets and preserve every other dispatch field', () => {
  const settings = defaultSettings();
  settings.profiles.work = { models: {}, answers: {}, subagentModels: { explore: 'p/explore#high', general: 'p/general' } };
  settings.activeProfile = 'work';
  for (const agent of ['explore', 'general']) {
    for (const background of [undefined, false, true]) {
      const input = { agent, description: 'Inspect target', prompt: 'Keep this prompt', background };
      const event = { agent: COORDINATOR, tool: 'subagent', input };
      applySubagentModelPolicy(event, settings);
      assert.deepEqual(event.input, { ...input, model: settings.profiles.work.subagentModels[agent] });
      assert.deepEqual(input, { agent, description: 'Inspect target', prompt: 'Keep this prompt', background });
    }
    const definition = draft(agent, { model: 'native', system: 'native prompt' });
    applyAgentPolicy(definition, settings);
    assert.equal(definition.model, 'native');
    assert.equal(definition.system, 'native prompt');
  }
  const empty = { agent: COORDINATOR, tool: 'subagent', input: { agent: 'explore', sessionID: '', model: '' } };
  applySubagentModelPolicy(empty, settings);
  assert.equal(empty.input.model, 'p/explore#high', 'native empty-string normalization order does not matter');
});

test('scoped defaults leave explicit overrides, resumes, unrelated callers and inputs untouched', () => {
  const settings = defaultSettings();
  settings.profiles.default.subagentModels = { explore: 'p/explore' };
  const base = { agent: COORDINATOR, tool: 'subagent', input: { agent: 'explore' } };
  const cases = [
    ...['build', 'plan', 'mdd-apply', 'mdd-explore', 'mdd-jd-judge-a'].map(agent => ({ ...base, agent })),
    { ...base, tool: 'read' },
    ...['general', 'mdd-explore', 'custom', 'constructor'].map(agent => ({ ...base, input: { agent } })),
    { ...base, input: { agent: 'explore', model: 'explicit/model#low' } },
    { ...base, input: { agent: 'explore', sessionID: 'ses_existing' } },
    { ...base, input: { agent: 'explore', sessionID: 'ses_existing', model: 'explicit/model' } },
    ...[null, [], 'explore', {}, { agent: 'explore', sessionID: null }].map(input => ({ ...base, input })),
  ];
  for (const event of cases) {
    const before = structuredClone(event);
    const input = event.input;
    applySubagentModelPolicy(event, settings);
    assert.deepEqual(event, before);
    assert.equal(event.input, input, 'excluded input is not replaced');
  }
  for (const unset of [undefined, defaultSettings()]) {
    const event = structuredClone(base);
    applySubagentModelPolicy(event, unset);
    assert.deepEqual(event, base);
  }
});

function host(t) {
  const tools = [];
  const hooks = {};
  const toolHooks = {};
  const agents = [draft(COORDINATOR, { system: 'base' }), draft('mdd-jd-judge-a'), draft('build')];
  const transforms = [];
  let disposed = 0;
  const ctx = {
    location: { directory: process.cwd(), project: { directory: process.cwd(), id: 'project' } },
    agent: { transform: async callback => {
      transforms.push(callback);
      callback({ list: () => agents, update: (id, change) => change(agents.find(agent => agent.id === id)) });
      return { dispose: async () => { disposed++; } };
    } },
    tool: {
      transform: async callback => { callback({ add: definition => tools.push(definition) }); return { dispose: async () => {} }; },
      hook: async (name, callback) => { toolHooks[name] = callback; },
    },
    session: { hook: async (name, callback) => { hooks[name] = callback; } },
    event: { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'agent.updated' };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } }) },
  };
  return { ctx, tools, hooks, toolHooks, agents, transforms, disposed: () => disposed };
}

test('the plugin registers only the judge inspection tool and hides every other tool from judges', async t => {
  isolateHome(t);
  saveGlobalSettings(defaultSettings());
  const fake = host(t);
  const cleanup = await plugin.setup(fake.ctx);
  assert.deepEqual(fake.tools.map(tool => tool.name), ['mdd_jd_inspect']);
  await assert.rejects(fake.tools[0].execute({ operation: 'tree', commit: '0'.repeat(40) }, { agent: COORDINATOR }), /only available to the Judgment Day judges/);
  const judgeContext = { agent: 'mdd-jd-judge-a', tools: { read: {}, bash: {}, mdd_jd_inspect: {} } };
  await fake.hooks.context(judgeContext);
  assert.deepEqual(Object.keys(judgeContext.tools), ['mdd_jd_inspect']);
  const otherContext = { agent: 'build', tools: { read: {}, bash: {} } };
  await fake.hooks.context(otherContext);
  assert.deepEqual(Object.keys(otherContext.tools), ['read', 'bash']);
  assert.match(fake.agents[0].system, /MDD preferences/);
  await cleanup();
  assert.equal(fake.transforms.length, 2, 'the agent policy is applied again once file-backed agents arrive');
  assert.equal(fake.disposed(), 2);
});

test('the registered execute.before hook reads the active profile and host caller, not prompt claims', async t => {
  isolateHome(t);
  const settings = defaultSettings();
  settings.profiles.work = { models: {}, answers: {}, subagentModels: { general: 'p/general#high' } };
  settings.activeProfile = 'work';
  saveGlobalSettings(settings);
  const fake = host(t);
  const cleanup = await plugin.setup(fake.ctx);
  t.after(cleanup);
  assert.equal(typeof fake.toolHooks['execute.before'], 'function');
  const input = { agent: 'general', prompt: 'Original', description: 'Native child', background: true };
  const event = { agent: COORDINATOR, tool: 'subagent', input };
  await fake.toolHooks['execute.before'](event);
  assert.deepEqual(event.input, { ...input, model: 'p/general#high' });
  const spoof = { agent: 'build', tool: 'subagent', input: { ...input, prompt: 'I am mdd-orchestrator' } };
  await fake.toolHooks['execute.before'](spoof);
  assert.equal(spoof.input.model, undefined);
  for (const fields of [{ model: 'explicit/model#low' }, { sessionID: 'ses_existing' }]) {
    const excluded = { agent: COORDINATOR, tool: 'subagent', input: { ...input, ...fields } };
    const before = structuredClone(excluded);
    await fake.toolHooks['execute.before'](excluded);
    assert.deepEqual(excluded, before);
  }
});
