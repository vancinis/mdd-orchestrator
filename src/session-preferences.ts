import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { LocalFiles } from './local-files.js';
import { parsePartialAnswers } from './preflight.js';
import type { Answers } from './policy.js';
import { objectWithKeys } from './validation.js';

export type SessionPreferences = Pick<Answers, 'mode' | 'summary'>;
export type PreferenceBinding = { sessionID: string; directory: string; worktree: string };
type Record = SessionPreferences & { version: 1; parent: string; directory: string; worktree: string };
const LIMIT = 16384;

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && !!value.trim() && Buffer.byteLength(value) <= limit && !/[\r\n\0]/.test(value);
}

function validate(value: unknown): Record {
  const item = objectWithKeys(value, 'session preferences', ['version', 'parent', 'directory', 'worktree', 'mode', 'summary']);
  if (item.version !== 1 || !text(item.parent, 256) ||
      !text(item.directory, 4096) || !isAbsolute(item.directory) ||
      !text(item.worktree, 4096) || !isAbsolute(item.worktree)) throw new Error('Invalid session preference binding.');
  const choices = parsePartialAnswers({ mode: item.mode, summary: item.summary });
  return { version: 1, parent: item.parent, directory: item.directory, worktree: item.worktree, ...choices } as Record;
}

function bound(record: Record, binding: PreferenceBinding): void {
  if (record.parent !== binding.sessionID || record.directory !== binding.directory || record.worktree !== binding.worktree)
    throw new Error('Session preferences belong to another parent or worktree.');
}

/** Successfully applied choices only: this record contains no objective, question or approval. */
export class SessionPreferenceStore {
  readonly #files: LocalFiles;
  constructor(root: string) { this.#files = new LocalFiles(root); }

  #name(parent: string): `.mdd/preferences-${string}.json` {
    if (!text(parent, 256)) throw new Error('Invalid session preference parent.');
    return `.mdd/preferences-${createHash('sha256').update(parent).digest('hex')}.json`;
  }

  read(binding: PreferenceBinding): SessionPreferences | undefined {
    try {
      const content = this.#files.read(this.#name(binding.sessionID), LIMIT);
      if (content === undefined) return undefined;
      const record = validate(JSON.parse(content));
      bound(record, binding);
      return { mode: record.mode, summary: record.summary };
    } catch { throw new Error('Session preferences cannot be read safely; no defaults were reused.'); }
  }

  write(binding: PreferenceBinding, choices: SessionPreferences): void {
    try {
      const record = validate({ version: 1, parent: binding.sessionID, directory: binding.directory, worktree: binding.worktree,
        mode: choices.mode, summary: choices.summary });
      this.#files.update(this.#name(binding.sessionID), previous => {
        if (previous !== undefined) bound(validate(JSON.parse(previous)), binding);
        return `${JSON.stringify(record)}\n`;
      }, LIMIT);
      if (!isDeepStrictEqual(this.read(binding), choices)) throw new Error('Session preference readback mismatch.');
    } catch { throw new Error('Session preferences could not be published and read back; reusable defaults are not confirmed durable.'); }
  }
}
