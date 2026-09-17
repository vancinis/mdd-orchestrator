import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyModelOverrides, NativeModels, nativeModel } from '../dist/native-models.js';
import { defaultSettings, freezeProfile, MODEL_ROLES } from '../dist/settings.js';

const parent = { providerID: 'native', modelID: 'parent' };
function profile(models = {}) {
  const settings = defaultSettings();
  settings.profiles.default.models = models;
  return freezeProfile(settings);
}
function agents() {
  return MODEL_ROLES.map(role => ({
    name: role === 'orchestrator' ? 'mdd-orchestrator' : role,
    mode: role === 'orchestrator' ? 'primary' : 'subagent',
  }));
}

test('model config contract: no overrides is an exact no-op, including absent agents', () => {
  for (const config of [{}, { default_agent: 'build', model: 'native/default', permission: 'ask', agent: { build: { model: 'native/build' } } }]) {
    const before = structuredClone(config);
    applyModelOverrides(config, profile());
    assert.deepEqual(config, before);
  }
});

test('model config contract: explicit nine-role mappings preserve all non-model settings', () => {
  const config = { default_agent: 'build', model: 'native/default', permission: 'ask', agent: { build: { prompt: 'unchanged' }, 'mdd-apply': { permission: { edit: 'ask' }, prompt: 'keep' } } };
  const overrides = Object.fromEntries(MODEL_ROLES.map(role => [role, `selected/team/${role}`]));
  applyModelOverrides(config, profile(overrides));
  assert.equal(config.default_agent, 'build');
  assert.equal(config.model, 'native/default');
  assert.equal(config.permission, 'ask');
  assert.deepEqual(config.agent.build, { prompt: 'unchanged' });
  assert.deepEqual(config.agent['mdd-apply'], { permission: { edit: 'ask' }, prompt: 'keep', model: 'selected/team/mdd-apply' });
  for (const role of MODEL_ROLES) assert.equal(config.agent[role === 'orchestrator' ? 'mdd-orchestrator' : role].model, overrides[role]);
});

test('native model binding: inherit actual parent or existing native phase model, never copy override', () => {
  const list = agents();
  list.find(a => a.name === 'mdd-plan').model = { providerID: 'native', modelID: 'team/planner' };
  const models = new NativeModels(profile());
  models.bind('parent', list, parent);
  assert.equal(models.expected('parent', 'mdd-plan'), 'native/team/planner');
  assert.equal(models.expected('parent', 'mdd-explore'), 'native/parent');
  models.check('parent', structuredClone(list));
  list.find(a => a.name === 'mdd-plan').model.modelID = 'changed';
  assert.throws(() => models.check('parent', list), /changed/);
});

test('native model binding: exact explicit model is required at resolution and execution', () => {
  const models = new NativeModels(profile({ orchestrator: 'native/parent', 'mdd-plan': 'native/planner' }));
  const list = agents();
  assert.throws(() => models.bind('parent', list, parent), /startup profile/);
  list.find(a => a.name === 'mdd-orchestrator').model = parent;
  list.find(a => a.name === 'mdd-plan').model = { providerID: 'native', modelID: 'planner' };
  assert.throws(() => models.bind('parent', list, { ...parent, modelID: 'other' }), /startup profile/);
  models.bind('parent', list, parent);
  assert.equal(models.expected('parent', 'mdd-plan'), 'native/planner');
  assert.equal(models.expected('parent', 'mdd-explore'), 'native/parent');
});

test('native model binding: freeze parent selection and separate parent sessions', () => {
  const models = new NativeModels(profile());
  models.bind('one', agents(), parent);
  assert.throws(() => models.bind('one', agents(), { ...parent, modelID: 'other' }), /changed/);
  models.bind('two', agents(), { ...parent, modelID: 'other' });
  assert.equal(models.expected('one', 'mdd-plan'), 'native/parent');
  assert.equal(models.expected('two', 'mdd-plan'), 'native/other');
  assert.throws(() => models.expected('missing', 'mdd-plan'), /before dispatch/);
  assert.throws(() => models.expected('one', 'general'), /Unknown/);
});

for (const [name, change] of Object.entries({
  missing: list => list.pop(), duplicate: list => list.push(list[0]),
  mode: list => { list[0].mode = 'all'; },
  model: list => { list[0].model = {}; },
})) {
  test(`native model binding: reject ${name} agent data`, () => {
    const list = agents(); change(list);
    assert.throws(() => new NativeModels(profile()).bind('parent', list, parent));
  });
}

for (const value of [undefined, null, {}, [], { providerID: 'a/b', modelID: 'c' }, { providerID: 'a', modelID: '' }]) {
  test(`native model identity: reject ${JSON.stringify(value)}`, () => assert.throws(() => nativeModel(value)));
}
