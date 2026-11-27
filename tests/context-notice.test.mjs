import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import test from 'node:test';
import { contextTokens, createContextWatch, reachesThreshold } from '../dist/context-notice.js';

const coordinator = 'mdd-orchestrator';
const directory = resolve('worktree');
const model = { providerID: 'provider', id: 'first' };
const location = { directory };

function tokens(input) {
  return { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
}

function fixture(overrides) {
  const notices = [];
  const warnings = [];
  const watch = createContextWatch({
    coordinator,
    directory,
    limitFor: async () => 1000,
    inLocation: async () => true,
    notify: async (id, text) => { notices.push({ id, text }); },
    warn: (message) => { warnings.push(message); },
    ...overrides,
  });
  function start({ id = 's1', message = 'm1', agent = coordinator, selected = model } = {}) {
    watch.observe({
      type: 'session.step.started',
      data: { sessionID: id, assistantMessageID: message, agent, model: selected },
    });
  }
  function end(used, { id = 's1', message = 'm1', place = location, finish = 'stop', usage = tokens(used) } = {}) {
    watch.observe({
      type: 'session.step.ended',
      location: place,
      data: { sessionID: id, assistantMessageID: message, finish, tokens: usage },
    });
  }
  function step(used, options) {
    start(options);
    end(used, options);
  }
  function lifecycle(type, id = 's1') {
    watch.observe({ type, location, data: { sessionID: id } });
  }
  return { watch, notices, warnings, start, end, step, lifecycle };
}

test('usage counts input, output and both caches but excludes reasoning', () => {
  assert.equal(contextTokens({ input: 200, output: 40, reasoning: 800, cache: { read: 450, write: 10 } }), 700);
  for (const invalid of [null, {}, tokens(0), tokens(-1), tokens('700'), tokens(Infinity), tokens(NaN),
    { ...tokens(700), cache: { read: 0 } },
    { ...tokens(Number.MAX_VALUE), output: Number.MAX_VALUE }]) {
    assert.equal(contextTokens(invalid), undefined);
  }
  for (const invalid of [undefined, 0, -1, 1.5, Infinity, NaN, '1000']) {
    assert.equal(reachesThreshold(700, invalid), false);
  }
  assert.equal(reachesThreshold(Infinity, 1000), false);
  assert.equal(reachesThreshold(Number.MAX_SAFE_INTEGER * 0.7, Number.MAX_SAFE_INTEGER), false);
});

test('699, 700 and 701 of 1000 independently respect the boundary', async () => {
  for (const [used, expected] of [[699, 0], [700, 1], [701, 1]]) {
    const { watch, notices, step } = fixture();
    step(used);
    await watch.settle();
    assert.equal(notices.length, expected, `at ${used} tokens`);
    if (expected) {
      assert.match(notices[0].text, /70%.*\b\d+ of 1000 tokens/);
      assert.match(notices[0].text, /Finish the current step; do not start another phase or cancel running actors/);
      assert.match(notices[0].text, /## Now.*mirror.*resume phrase/);
      assert.match(notices[0].text, /Without one:.*brief summary.*next step/);
    }
  }
});

test('configured percentages notify only at each crossing', async () => {
  for (const percent of [10, 80, 95]) {
    assert.equal(reachesThreshold(percent * 10 - 1, 1000, percent), false);
    assert.equal(reachesThreshold(percent * 10, 1000, percent), true);
  }
  const f = fixture({ thresholdPercent: 80 });
  for (const used of [799, 800, 801, 799, 800]) f.step(used);
  await f.watch.settle();
  assert.equal(f.notices.length, 2);
  for (const notice of f.notices) assert.match(notice.text, /80%.*800 of 1000 tokens/);
});

test('episodes survive ignorable completions but reset below threshold, after compaction and on a different model', async () => {
  const { watch, notices, step, end, lifecycle } = fixture();
  step(701);
  step(701);
  step(1, { finish: 'error' });
  step(0);
  end(1);
  step(701);
  await watch.settle();
  assert.equal(notices.length, 1);

  step(699);
  step(701);
  lifecycle('session.compaction.ended');
  step(701);
  step(701, { selected: { ...model, providerID: 'another-provider' } });
  await watch.settle();
  assert.equal(notices.length, 4);
});

test('ends require their own session and a pending start; cleanup drops pending steps and episodes', async () => {
  const { watch, notices, start, end, step, lifecycle } = fixture();
  start();
  end(750, { id: 's2' });
  end(700);
  end(750);
  step(700, { id: 's2' });
  start({ message: 'unfinished' });
  lifecycle('session.deleted');
  end(750, { message: 'unfinished' });
  step(700);
  await watch.settle();
  assert.deepEqual(notices.map(({ id, text }) => [id, text.match(/\(\d+/)[0]]), [
    ['s1', '(700'], ['s2', '(700'], ['s1', '(700'],
  ]);
});

test('orchestrator and location checks gate delivery; the fallback runs only when needed', async () => {
  const lookups = [];
  const { watch, notices, step, end } = fixture({
    inLocation: async (id) => { lookups.push(id); return id === 'local'; },
  });
  step(700, { agent: 'mdd-apply', place: null });
  step(700, { place: { directory: `${directory}-other` } });
  end(700);
  step(700, { id: 'foreign', place: null });
  step(700, { id: 'local', place: null });
  const sameDir = process.platform === 'win32' ? directory.toUpperCase().replaceAll('\\', '/') : directory;
  step(700, { id: 'normalized', place: { directory: `${sameDir}${sep}nonexistent${sep}..` } });
  await watch.settle();
  assert.deepEqual(lookups, ['foreign', 'local']);
  assert.deepEqual(notices.map(({ id }) => id), ['local', 'normalized']);
});

test('paired model supplies its own limit; invalid limits warn once and do not fabricate a notice', async () => {
  const large = { ...model, id: 'large' };
  const unavailable = { ...model, id: 'unavailable' };
  let badLimit;
  const { watch, notices, warnings, start, end, step } = fixture({
    limitFor: async ({ id }) => id === large.id ? 2000 : id === unavailable.id ? badLimit : 1000,
  });
  start({ message: 'first' });
  start({ message: 'second', selected: large });
  end(700, { message: 'first' });
  end(701, { message: 'second' });
  await watch.settle();
  step(800, { selected: unavailable });
  await watch.settle();
  badLimit = -1;
  step(800, { selected: unavailable });
  await watch.settle();
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /700 of 1000 tokens/);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no context limit.*provider\/unavailable/i);
});

test('delivery settles in order, warns and retries after rejection, then deduplicates', async () => {
  const { promise: started, resolve: signalStart } = Promise.withResolvers();
  const { promise: first, reject } = Promise.withResolvers();
  const attempts = [];
  const { watch, warnings, step } = fixture({
    notify: async (id, text) => {
      attempts.push({ id, text });
      if (attempts.length === 1) {
        signalStart();
        await first;
      }
    },
  });
  step(701);
  step(702);
  step(703);
  await started;
  assert.equal(attempts.length, 1);
  reject(new Error('unavailable inbox'));
  await watch.settle();
  assert.equal(attempts.length, 2);
  assert.match(attempts[1].text, /702 of 1000 tokens/);
  assert.equal(warnings.length, 1);
});

test('location and limit lookup failures do not poison the queue', async () => {
  let locations = 0;
  let limits = 0;
  const { watch, notices, warnings, step } = fixture({
    inLocation: async () => {
      if (++locations === 1) throw new Error('location unavailable');
      return true;
    },
    limitFor: async () => {
      if (++limits === 1) throw new Error('models unavailable');
      return 1000;
    },
  });
  for (const used of [700, 701, 702]) step(used, { place: null });
  await watch.settle();
  assert.equal(warnings.length, 2);
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /702 of 1000 tokens/);
});
