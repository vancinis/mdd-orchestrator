import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collapseDispatchPrompts, collapsedPrompt, COLLAPSE_MIN_BYTES } from '../dist/dispatch-transcript.js';
import { DISPATCH_HANDLE_PREFIX } from '../dist/phase-runner.js';

const AGENTS = ['mdd-explore', 'mdd-apply', 'mdd-verify'];
const long = 'x'.repeat(COLLAPSE_MIN_BYTES + 1);
const dispatch = (status, subagent = 'mdd-apply', prompt = long) => ({
  type: 'tool', tool: 'task', callID: 'call', state: { status, input: { description: 'MDD apply phase', subagent_type: subagent, prompt }, output: 'done' },
});
const messages = (...parts) => [{ info: { role: 'assistant' }, parts }];

test('a settled phase dispatch is collapsed and explains itself', () => {
  const list = messages(dispatch('completed'));
  assert.equal(collapseDispatchPrompts(list, AGENTS), 1);
  const prompt = list[0].parts[0].state.input.prompt;
  assert.equal(prompt, collapsedPrompt('mdd-apply', Buffer.byteLength(long)));
  assert.ok(Buffer.byteLength(prompt) < Buffer.byteLength(long));
  assert.match(prompt, /must not be reconstructed/);
  assert.match(prompt, /mdd-apply/);
  // Everything else about the recorded call is untouched.
  assert.equal(list[0].parts[0].state.input.subagent_type, 'mdd-apply');
  assert.equal(list[0].parts[0].state.input.description, 'MDD apply phase');
  assert.equal(list[0].parts[0].state.output, 'done');
  assert.equal(list[0].parts[0].callID, 'call');
});

test('a dispatch still in flight is never touched', () => {
  // The invariant: `PhaseRunner.before` may still compare this one byte for byte.
  for (const status of ['running', 'pending', undefined]) {
    const list = messages(dispatch(status));
    assert.equal(collapseDispatchPrompts(list, AGENTS), 0);
    assert.equal(list[0].parts[0].state.input.prompt, long);
  }
});

test('collapsing replaces the part instead of mutating the record it was handed', () => {
  const part = dispatch('completed');
  const held = part.state.input;
  const list = messages(part);
  collapseDispatchPrompts(list, AGENTS);
  // The host still owns the original objects; only the outgoing copy changed.
  assert.equal(part.state.input.prompt, long);
  assert.equal(held.prompt, long);
  assert.notEqual(list[0].parts[0], part);
});

test('only MDD phase dispatches with a real prompt qualify', () => {
  const short = 'do the thing';
  const cases = [
    ['a task for another agent', dispatch('completed', 'general')],
    ['a prompt small enough to cost nothing', dispatch('completed', 'mdd-apply', short)],
    ['a prompt already carrying a handle', dispatch('completed', 'mdd-apply', `${DISPATCH_HANDLE_PREFIX}${'a'.repeat(COLLAPSE_MIN_BYTES)}`)],
    ['a different tool', { type: 'tool', tool: 'bash', state: { status: 'completed', input: { prompt: long, subagent_type: 'mdd-apply' } } }],
    ['a text part', { type: 'text', text: long }],
  ];
  for (const [name, part] of cases) {
    const list = messages(part);
    assert.equal(collapseDispatchPrompts(list, AGENTS), 0, name);
  }
});

test('every settled dispatch across the conversation is collapsed', () => {
  const list = [
    { info: {}, parts: [dispatch('completed', 'mdd-explore')] },
    { info: {}, parts: [{ type: 'text', text: 'hello' }, dispatch('error', 'mdd-apply')] },
    { info: {}, parts: [dispatch('running', 'mdd-verify')] },
  ];
  assert.equal(collapseDispatchPrompts(list, AGENTS), 2);
  assert.match(list[0].parts[0].state.input.prompt, /mdd-explore/);
  assert.match(list[1].parts[1].state.input.prompt, /mdd-apply/);
  assert.equal(list[2].parts[0].state.input.prompt, long, 'the in-flight one still stands');
});

test('malformed or empty input is survivable, because a transform must never fail a turn', () => {
  for (const value of [undefined, null, 'text', 42, {}, [], [null], [{ parts: null }], [{ parts: [null, 'x', {}] }]]) {
    assert.equal(collapseDispatchPrompts(value, AGENTS), 0);
  }
  assert.equal(collapseDispatchPrompts(messages(dispatch('completed')), []), 0, 'no agents means nothing is MDD\'s to collapse');
});
