import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Model } from '@opencode/plugin';
import plugin, { applyAgentPolicy, COORDINATOR, preferencesLine, startupSettings } from '../dist/opencode-plugin.js';
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

function host(t) {
  const tools = [];
  const hooks = {};
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
    tool: { transform: async callback => { callback({ add: definition => tools.push(definition) }); return { dispose: async () => {} }; } },
    session: { hook: async (name, callback) => { hooks[name] = callback; } },
    event: { subscribe: ({ signal }) => ({ async *[Symbol.asyncIterator]() {
      yield { type: 'agent.updated' };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    } }) },
  };
  return { ctx, tools, hooks, agents, transforms, disposed: () => disposed };
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
