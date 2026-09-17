import { createHash } from 'node:crypto';
import { LocalFiles } from './local-files.js';
import { objectWithKeys } from './validation.js';

export type Progress = { runID: string; callID: string; state: 'pending' | 'settled' | 'complete'; userMessageID: string };
const LIMIT = 2048;
function parse(value: unknown): Progress {
  const item = objectWithKeys(value, 'progress marker', ['runID', 'callID', 'state', 'userMessageID']);
  if (!['pending', 'settled', 'complete'].includes(String(item.state)) ||
      [item.runID, item.callID, item.userMessageID].some(value => typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))) throw new Error('Invalid progress correlation.');
  return item as Progress;
}
export class ProgressGuard {
  readonly #files: LocalFiles;
  constructor(root: string) { this.#files = new LocalFiles(root); }
  #name(parent: string): `.mdd/progress-${string}.json` { return `.mdd/progress-${createHash('sha256').update(parent).digest('hex')}.json`; }
  read(parent: string): Progress | undefined {
    try { const text = this.#files.read(this.#name(parent), LIMIT); return text === undefined ? undefined : parse(JSON.parse(text)); }
    catch { throw new Error('Progress cannot be read safely. Do not retry prior work; inspect the local progress file.'); }
  }
  write(parent: string, marker: Progress): void {
    try {
      const entry = parse(marker);
      this.#files.update(this.#name(parent), text => { if (text !== undefined) parse(JSON.parse(text)); return JSON.stringify(entry); }, LIMIT);
    } catch { throw new Error('Progress could not be recorded safely. Execution was stopped without retry.'); }
  }
}
