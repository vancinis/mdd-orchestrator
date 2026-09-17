import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ask, Cancelled, choose, frame, keypressSelect, rows } from '../dist/tui.js';

const CHOICES = [
  { value: 'uno', label: 'Primera', hint: 'la de arriba' },
  { value: 'dos', label: 'Segunda', hint: 'la del medio' },
  { value: 'tres', label: 'Tercera', hint: 'la de abajo' },
];

function terminal(columns = 80) {
  const handlers = new Set();
  const written = [];
  const input = {
    isRaw: false,
    setRawMode(mode) { input.isRaw = mode; },
    setEncoding() {}, resume() {}, pause() {},
    on(event, handler) { if (event === 'data') handlers.add(handler); },
    off(event, handler) { if (event === 'data') handlers.delete(handler); },
  };
  return { input, output: { columns, write: text => written.push(text) }, written,
    send: chunk => { for (const handler of [...handlers]) handler(chunk); },
    listeners: () => handlers.size };
}

function scripted(lines) {
  const prompts = [];
  const written = [];
  return { prompts, written,
    io: { isTTY: true, write: text => written.push(text), read: async prompt => { prompts.push(prompt); return lines.shift(); } } };
}

test('arrows move and Enter confirms, wrapping around both ends', async () => {
  for (const [keys, expected] of [[['\x1b[B'], 'dos'], [['\x1b[B', '\x1b[B'], 'tres'],
    [['\x1b[A'], 'tres'], [['\x1b[B', '\x1b[A'], 'uno'], [['\x1bOB'], 'dos'], [['\x1bOA'], 'tres']]) {
    const t = terminal();
    const pending = keypressSelect(t.input, t.output, 'Elegí', CHOICES);
    for (const key of keys) t.send(key);
    t.send('\r');
    assert.equal(await pending, expected);
  }
});

test('a direct 1-9 key selects immediately; out-of-range and unknown keys are ignored', async () => {
  const t = terminal();
  const pending = keypressSelect(t.input, t.output, 'Elegí', CHOICES);
  t.send('9'); t.send('x'); t.send('\x1b[C');
  t.send('3');
  assert.equal(await pending, 'tres');
  assert.equal(t.written.join('').includes('\u276f 3'), true);
});

test('Esc, Ctrl+C and Ctrl+D cancel without selecting', async () => {
  for (const key of ['\x1b', '\x03', '\x04']) {
    const t = terminal();
    const pending = keypressSelect(t.input, t.output, 'Elegí', CHOICES);
    t.send(key);
    assert.equal(await pending, undefined);
  }
});

test('raw mode, cursor and the data listener are restored on both exits', async () => {
  for (const key of ['\r', '\x1b']) {
    const t = terminal();
    const pending = keypressSelect(t.input, t.output, 'Elegí', CHOICES);
    assert.equal(t.input.isRaw, true);
    assert.equal(t.listeners(), 1);
    assert.equal(t.written.join('').includes('\x1b[?25l'), true);
    t.send(key);
    await pending;
    assert.equal(t.input.isRaw, false);
    assert.equal(t.listeners(), 0);
    assert.equal(t.written.join('').endsWith('\x1b[?25h'), true);
  }
});

test('each redraw rewinds exactly the previously drawn line count', async () => {
  const t = terminal();
  const pending = keypressSelect(t.input, t.output, 'Elegí', CHOICES);
  const lines = t.written[t.written.length - 1].split('\n').length - 1;
  t.send('\x1b[B');
  assert.equal(t.written.includes(`\x1b[${lines}A\x1b[0J`), true);
  t.send('\r');
  await pending;
});

test('narrow terminals truncate instead of wrapping and desyncing the redraw', () => {
  const narrow = frame('Título', CHOICES, 0, 'ayuda', 28);
  for (const line of narrow.split('\n')) assert.ok(line.length <= 27, line);
  assert.ok(narrow.includes('\u2026'));
  assert.ok(frame('Título', CHOICES, 0, 'ayuda').includes('la del medio'));
});

test('line fallback accepts a number, a token, a label and Enter for the marked option', async () => {
  for (const [line, expected] of [['2', 'dos'], ['tres', 'tres'], ['Primera', 'uno'], ['', 'dos'], ['  3  ', 'tres']]) {
    const script = scripted([line]);
    assert.equal(await choose(script.io, 'Elegí', CHOICES, { initial: 1 }), expected);
    assert.equal(script.prompts.length, 1);
  }
});

test('line fallback marks the initial option and lists every choice with its number', async () => {
  const script = scripted(['1']);
  await choose(script.io, 'Elegí', CHOICES, { initial: 2 });
  const text = script.written.join('');
  assert.match(text, /\u276f 3 {2}Tercera/);
  assert.match(text, /^ {2}1 {2}Primera/m);
  assert.match(text, /:cancel cancela/);
});

test('cancel token and end of input raise Cancelled; unknown input stays actionable', async () => {
  await assert.rejects(choose(scripted([':cancel']).io, 'Elegí', CHOICES), Cancelled);
  await assert.rejects(choose(scripted([]).io, 'Elegí', CHOICES), Cancelled);
  await assert.rejects(choose(scripted(['nope']).io, 'Elegí', CHOICES), /3 opciones/);
  await assert.rejects(choose(scripted(['nope']).io, 'Elegí', CHOICES, { unknownCancels: true }), Cancelled);
  await assert.rejects(ask(scripted([':cancel']).io, 'Nombre'), Cancelled);
  await assert.rejects(ask(scripted([]).io, 'Nombre'), Cancelled);
});

test('a provided select capability replaces line input and rejects values outside the list', async () => {
  const calls = [];
  const io = { isTTY: true, write() {}, read: async () => assert.fail('select must not read a line'),
    select: async (title, choices, initial) => { calls.push({ title, count: choices.length, initial }); return 'dos'; } };
  assert.equal(await choose(io, 'Elegí', CHOICES, { initial: 5 }), 'dos');
  assert.deepEqual(calls, [{ title: 'Elegí', count: 3, initial: 2 }]);
  const forged = { ...io, select: async () => 'inventada' };
  await assert.rejects(choose(forged, 'Elegí', CHOICES), /no está en la lista/);
  const cancelled = { ...io, select: async () => undefined };
  await assert.rejects(choose(cancelled, 'Elegí', CHOICES), Cancelled);
});

test('rows aligns labels and tolerates an empty list', () => {
  assert.equal(rows([]), '');
  assert.equal(rows([['a', '1'], ['bbb', '2']]), '  a    1\n  bbb  2\n');
});
