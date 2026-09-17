import { createInterface } from 'node:readline/promises';
import { ValidationError } from './validation.js';

/** `value` is the stable machine token; `label`/`hint` are display-only Spanish text. */
export type Choice = { value: string; label: string; hint?: string };
export type ConfigIO = {
  isTTY: boolean;
  read(prompt: string): Promise<string | undefined>;
  write(text: string): void;
  /** Present only when the terminal supports raw-mode keys; line input stays the fallback. */
  select?(heading: string, choices: readonly Choice[], initial?: number): Promise<string | undefined>;
};
export class Cancelled extends Error {}

export const CANCEL_TOKEN = ':cancel';
const KEY_HELP = `\u2191\u2193 mover  \u00b7  1-9 elegir  \u00b7  Enter confirma  \u00b7  Esc cancela`;
const LINE_HELP = `número para elegir  \u00b7  Enter confirma la marcada (\u276f)  \u00b7  ${CANCEL_TOKEN} cancela`;
const MIN_RULE = 46;

export function heading(text: string): string {
  return `\n${text}\n${'\u2500'.repeat(Math.max(text.length, MIN_RULE))}\n`;
}

export function rows(items: readonly (readonly [string, string])[]): string {
  if (!items.length) return '';
  const width = Math.max(...items.map(([label]) => label.length));
  return `${items.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join('\n')}\n`;
}

export function note(text: string): string { return `  ${text}\n`; }

export function frame(title: string, choices: readonly Choice[], index: number, help: string, width?: number): string {
  const labels = Math.max(...choices.map(choice => choice.label.length));
  const limit = width !== undefined && width > 24 ? width - 1 : undefined;
  const lines = ['', title, '\u2500'.repeat(Math.max(title.length, MIN_RULE)), help, '',
    ...choices.map((choice, position) =>
      `${position === index ? '\u276f' : ' '} ${position < 9 ? position + 1 : ' '}  ${choice.label.padEnd(labels)}${choice.hint ? `   ${choice.hint}` : ''}`),
    ''];
  return `${lines.map(line => (limit !== undefined && line.length > limit ? `${line.slice(0, limit - 1)}\u2026` : line)).join('\n')}\n`;
}

/**
 * One selection through arrows plus Enter, a direct 1-9 key, or the typed number/token
 * fallback. Cancelling raises Cancelled so callers keep their existing discard paths.
 */
export async function choose(io: ConfigIO, title: string, choices: readonly Choice[],
  options: { initial?: number; unknownCancels?: boolean } = {}): Promise<string> {
  if (!choices.length) throw new ValidationError('No hay opciones disponibles.');
  const initial = Math.min(Math.max(options.initial ?? 0, 0), choices.length - 1);
  if (io.select) {
    const value = await io.select(title, choices, initial);
    if (value === undefined) throw new Cancelled();
    const selected = choices.find(choice => choice.value === value);
    if (!selected) throw new ValidationError('La opción elegida no está en la lista.');
    return selected.value;
  }
  io.write(frame(title, choices, initial, LINE_HELP));
  const answer = await io.read('> ');
  if (answer === undefined) throw new Cancelled();
  const text = answer.trim();
  if (text === CANCEL_TOKEN) throw new Cancelled();
  if (text === '') return choices[initial]!.value;
  const numbered = /^[0-9]+$/.test(text) ? choices[Number(text) - 1] : undefined;
  const named = choices.find(choice => choice.value.toLowerCase() === text.toLowerCase() ||
    choice.label.toLowerCase() === text.toLowerCase());
  const selected = numbered ?? named;
  if (selected) return selected.value;
  if (options.unknownCancels) throw new Cancelled();
  throw new ValidationError(`Elegí una de las ${choices.length} opciones por número o por nombre.`);
}

/**
 * Free text for names, models and endpoints, where a fixed list cannot express the value.
 * The context is written separately so readline only ever renders a one-line prompt.
 */
export async function ask(io: ConfigIO, question: string, hint?: string): Promise<string> {
  io.write(`\n${question}\n${'\u2500'.repeat(Math.max(question.length, MIN_RULE))}\n${hint ? `  ${hint}\n` : ''}  ${CANCEL_TOKEN} cancela\n\n`);
  const answer = await io.read('> ');
  if (answer === undefined || answer.trim() === CANCEL_TOKEN) throw new Cancelled();
  return answer.trim();
}

type Key = { kind: 'up' | 'down' | 'enter' | 'cancel' } | { kind: 'digit'; digit: number };
function parseKey(chunk: string): Key | undefined {
  if (chunk === '\x1b[A' || chunk === '\x1bOA') return { kind: 'up' };
  if (chunk === '\x1b[B' || chunk === '\x1bOB') return { kind: 'down' };
  if (chunk === '\r' || chunk === '\n' || chunk === ' ') return { kind: 'enter' };
  if (chunk === '\x1b' || chunk === '\x03' || chunk === '\x04') return { kind: 'cancel' };
  if (/^[1-9]$/.test(chunk)) return { kind: 'digit', digit: Number(chunk) };
  return undefined;
}

type RawInput = Pick<NodeJS.ReadStream, 'on' | 'off' | 'resume' | 'pause' | 'setEncoding'> &
  { isRaw?: boolean; setRawMode(mode: boolean): unknown };
type RawOutput = { write(text: string): unknown; columns?: number };

/** Redraws in place over its own line count; lines are truncated so wrapping cannot desync it. */
export function keypressSelect(input: RawInput, output: RawOutput, title: string,
  choices: readonly Choice[], initial = 0): Promise<string | undefined> {
  let index = Math.min(Math.max(initial, 0), choices.length - 1);
  let drawn = 0;
  const draw = () => {
    if (drawn) output.write(`\x1b[${drawn}A\x1b[0J`);
    const text = frame(title, choices, index, KEY_HELP, output.columns);
    drawn = text.split('\n').length - 1;
    output.write(text);
  };
  const wasRaw = input.isRaw === true;
  input.setEncoding('utf8');
  input.setRawMode(true);
  input.resume();
  output.write('\x1b[?25l');
  draw();
  return new Promise<string | undefined>(resolve => {
    const finish = (value: string | undefined) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\x1b[?25h');
      resolve(value);
    };
    const onData = (chunk: unknown) => {
      const key = parseKey(String(chunk));
      if (!key) return;
      if (key.kind === 'cancel') return finish(undefined);
      if (key.kind === 'enter') return finish(choices[index]!.value);
      if (key.kind === 'digit') {
        const choice = choices[key.digit - 1];
        if (!choice) return;
        index = key.digit - 1;
        draw();
        return finish(choice.value);
      }
      index = key.kind === 'up' ? (index + choices.length - 1) % choices.length : (index + 1) % choices.length;
      draw();
    };
    input.on('data', onData);
  });
}

/** Line input uses a short-lived readline interface so it never competes with raw-mode selection. */
export function createTerminalIO(): { io: ConfigIO; close(): void } {
  const input = process.stdin;
  const output = process.stdout;
  const interactive = !!input.isTTY && !!output.isTTY;
  const raw = interactive && typeof input.setRawMode === 'function';
  let closed = false;
  const io: ConfigIO = {
    isTTY: interactive,
    write: text => { output.write(text); },
    async read(prompt) {
      if (closed) return undefined;
      const terminal = createInterface({ input, output, terminal: true, historySize: 0 });
      const controller = new AbortController();
      terminal.on('SIGINT', () => { closed = true; controller.abort(); });
      try { return await terminal.question(prompt, { signal: controller.signal }); }
      catch { return undefined; }
      finally { terminal.close(); }
    },
    ...(raw ? { select: async (title, choices, start = 0) =>
      closed ? undefined : keypressSelect(input as unknown as RawInput, output, title, choices, start) } : {}),
  };
  return { io, close() { closed = true; } };
}
