import assert from 'node:assert/strict';
import { test } from 'node:test';
import { phaseVisual, visualTitle, presentationSettings } from '../dist/visual-ux.js';
import { injectedSkillNames } from '../dist/phase-assets.js';
import tui from '../dist/opencode-tui.js';
import { registerPhaseSidebar, MDD_SIDEBAR_ORDER } from '../dist/tui-sidebar.js';

test('progress follows route and recorded outcomes, not inferred completion', () => {
  const status = { phase: 'mdd-apply', state: 'ready', workflow: {
    evaluation: { route: 'low', phases: ['mdd-explore', 'mdd-plan', 'mdd-apply', 'mdd-verify'] },
    results: [{ phase: 'mdd-explore', outcome: 'passed' }, { phase: 'mdd-plan', outcome: 'failed' }],
  } };
  const view = phaseVisual(status, true);
  assert.equal(view.route, 'low');
  assert.equal(view.progress, '[x] explore  [!] plan  [>] apply  [ ] verify');
  assert.deepEqual(view.skills, ['mdd-cleanup']);
  assert.match(visualTitle('mdd-apply', true), /mdd-cleanup/);
  assert.equal(phaseVisual({ state: 'not-started' }), undefined);
  assert.deepEqual(injectedSkillNames('mdd-tasks'), []);
  assert.equal(visualTitle('mdd-tasks').includes(' · '), false);
});

test('presentation settings default to emoji/toasts and allow explicit ASCII/toast opt-outs', () => {
  assert.deepEqual(presentationSettings({}), { ascii: false, toasts: true });
  assert.deepEqual(presentationSettings({ MDD_ASCII: '1', MDD_TOASTS: '0' }), { ascii: true, toasts: false });
  assert.deepEqual(presentationSettings({ MDD_ASCII: 'true', MDD_TOASTS: 'false' }), { ascii: false, toasts: true });
});

test('TUI module has separate identity, mdd KV and gated attention', async () => {
  assert.equal(tui.id, 'mdd.visual');
  assert.equal('server' in tui, false);
  const handlers = new Map(); const notices = []; const keys = [];
  await tui.tui({ kv: { get: (_, fallback) => fallback, set: (...args) => keys.push(args) }, tuiConfig: { attention: { enabled: true } }, event: { on: (type, fn) => { handlers.set(type, fn); return () => handlers.delete(type); } },
    lifecycle: { onDispose() {} }, attention: { notify: async value => notices.push(value) } });
  assert.equal(keys[0][0], 'mdd.sidebarAvailable');
  const send = (tool, state, sessionID = 'parent') => handlers.get('message.part.updated')({ properties: {
    part: { type: 'tool', tool, sessionID, state: { status: 'completed', output: JSON.stringify(state) } },
  } });
  send('other', { state: 'blocked' });
  const workflow = { evaluation: { route: 'low', phases: ['mdd-apply', 'mdd-verify'] }, results: [] };
  send('mdd_start', { phase: 'mdd-apply', state: 'ready', workflow });
  send('mdd_status', { phase: 'mdd-apply', state: 'await-approval', workflow });
  send('mdd_status', { phase: 'mdd-apply', state: 'await-approval', workflow });
  send('mdd_status', { phase: 'mdd-verify', state: 'complete', workflow });
  await Promise.resolve();
  assert.deepEqual(notices.map(x => x.sound.name), ['question', 'done']);
  assert.ok(notices.every(x => x.notification === false));
});

test('TUI tolerates missing attention, catches failed delivery and releases its event subscription', async () => {
  for (const attention of [undefined, { notify: () => Promise.reject(new Error('notification failed')) },
    { notify: () => { throw new Error('notification unavailable'); } }]) {
    const handlers = new Map(); const disposers = []; let removed = 0;
    await tui.tui({ kv: { get: (_, fallback) => fallback, set() {} },
      event: { on(type, fn) { handlers.set(type, fn); return () => { removed++; handlers.delete(type); }; } },
      lifecycle: { onDispose(fn) { disposers.push(fn); } },
      ...(attention ? { attention } : {}),
    });
    const handler = handlers.get('message.part.updated');
    assert.equal(typeof handler, 'function');
    handler({ properties: { part: { type: 'tool', tool: 'mdd_status', sessionID: 'parent',
      state: { status: 'completed', output: JSON.stringify({ phase: 'mdd-verify', state: 'complete', workflow: { evaluation: { phases: ['mdd-verify'] } } }) } } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposers.length, 1);
    disposers[0]();
    assert.equal(removed, 1);
    assert.equal(handlers.size, 0);
  }
});

test('attention ignores historical, unrelated and malformed status and respects opt-in', async () => {
  for (const enabled of [false, true]) {
    let handler; let dispose; const notices = [];
    await tui.tui({ kv: { get: (_, fallback) => fallback, set() {} },
      tuiConfig: { attention: { enabled } },
      event: { on(_type, callback) { handler = callback; return () => {}; } },
      lifecycle: { onDispose(callback) { dispose = callback; } },
      attention: { notify(value) { notices.push(value); return Promise.resolve(); } },
    });
    const send = (tool, value, sessionID = 'parent') => handler({ properties: { part: { type: 'tool', tool, sessionID,
      state: { status: 'completed', output: JSON.stringify(value) } } } });
    const workflow = { evaluation: { route: 'low', phases: ['mdd-plan'] }, results: [] };
    send('mdd_status', { phase: 'mdd-plan', state: 'blocked', workflow }); // Initial replay is not a transition.
    send('mdd_status', { phase: 'mdd-plan', state: 'ready', workflow });
    send('mdd_status', { phase: 'mdd-plan', state: 'blocked' }); // Invalid output must not replace status.
    send('other', { phase: 'mdd-plan', state: 'blocked', workflow });
    send('mdd_status', { phase: 'mdd-plan', state: 'blocked', workflow });
    await Promise.resolve();
    assert.equal(notices.length, enabled ? 1 : 0);
    dispose();
    send('mdd_status', { phase: 'mdd-plan', state: 'complete', workflow });
    await Promise.resolve();
    assert.equal(notices.length, enabled ? 1 : 0);
  }
});

test('sidebar slot renders only a recorded route and refreshes on status updates', () => {
  let slot; let refresh;
  const statuses = new Map();
  const jsx = (tag, props) => ({ tag, props });
  const update = registerPhaseSidebar({ slots: { register(value) { slot = value; return 'mdd.visual:sidebar'; } } },
    jsx, initial => { let value = initial; return [() => value, fn => { value = fn(value); refresh = value; }]; }, statuses, () => true);
  assert.equal(slot.order, MDD_SIDEBAR_ORDER);
  const render = session_id => slot.slots.sidebar_content({}, { session_id })();
  assert.equal(render('unrelated'), null);
  statuses.set('parent', { phase: 'mdd-tasks', state: 'ready', workflow: {
    evaluation: { route: 'high', phases: ['mdd-plan', 'mdd-tasks', 'mdd-apply'] }, results: [{ phase: 'mdd-plan', outcome: 'passed' }],
  } });
  update('parent'); assert.equal(refresh, 1);
  const view = render('parent');
  assert.equal(view.tag, 'box');
  assert.deepEqual(view.props.children.map(child => child.props.children),
    ['MDD · high route', '[x] plan', '[>] tasks', '[ ] apply', 'Skills: none']);
});

test('real Solid signal rerenders a previously empty sidebar slot after a valid status', async () => {
  // Node's default Solid export is SSR-only; the TUI renderer uses the client runtime.
  const { createRoot, createSignal, createRenderEffect } = await import('solid-js/dist/solid.js');
  let slot;
  const statuses = new Map(); const snapshots = [];
  const jsx = (tag, props) => ({ tag, props });
  const update = registerPhaseSidebar({ slots: { register(value) { slot = value; return 'mdd.visual:sidebar'; } } }, jsx, createSignal, statuses, () => true);
  const dispose = createRoot(dispose => {
    const content = slot.slots.sidebar_content({}, { session_id: 'parent' });
    createRenderEffect(() => snapshots.push(content()));
    return dispose;
  });
  assert.deepEqual(snapshots, [null]);
  statuses.set('parent', { phase: 'mdd-plan', state: 'ready', workflow: { evaluation: { route: 'low', phases: ['mdd-plan'] }, results: [] } });
  update('parent');
  assert.equal(snapshots.at(-1)?.props.children[1].props.children, '[>] plan');
  dispose();
});
