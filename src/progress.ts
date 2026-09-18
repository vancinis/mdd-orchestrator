import { createHash } from 'node:crypto';
import { LocalFiles } from './local-files.js';
import { objectWithKeys } from './validation.js';

/**
 * The call ID is optional because a phase the coordinator carries out itself never dispatches a
 * native task. Requiring it here is what let an interrupted inline phase leave no trace at all,
 * so a restarted process reported a conversation that had never started.
 */
export type Progress = { runID: string; callID?: string; state: 'pending' | 'settled' | 'complete'; userMessageID: string };
const LIMIT = 2048;
function parse(value: unknown): Progress {
  const item = objectWithKeys(value, 'progress marker', ['runID', 'callID', 'state', 'userMessageID']);
  if (!['pending', 'settled', 'complete'].includes(String(item.state)) ||
      [item.runID, item.userMessageID, ...(item.callID === undefined ? [] : [item.callID])]
        .some(value => typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))) throw new Error('Invalid progress correlation.');
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
  /** Explicit recovery: a marker never keeps a conversation locked once the user asks to clear it. */
  clear(parent: string): void {
    try { this.#files.remove(this.#name(parent)); }
    catch { throw new Error('The local progress marker could not be cleared. Inspect the .mdd directory.'); }
  }
  write(parent: string, marker: Progress): void {
    try {
      const entry = parse(marker);
      this.#files.update(this.#name(parent), text => { if (text !== undefined) parse(JSON.parse(text)); return JSON.stringify(entry); }, LIMIT);
    } catch { throw new Error('Progress could not be recorded safely. Execution was stopped without retry.'); }
  }
}
