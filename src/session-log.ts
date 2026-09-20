import { LocalFiles } from './local-files.js';
import { loadGlobalSettings } from './global-settings.js';
import type { InstallationEnvironment } from './installation-paths.js';
import { ValidationError } from './validation.js';

/**
 * The workspace ledger only ever learned that a conversation existed once that conversation had
 * already produced a phase event. Everything that died earlier — an intake stuck on a question the
 * host never delivered, a preflight nobody could answer, a start refused by a stale marker — left
 * the directory exactly as it found it, so the most expensive failures were also the invisible
 * ones. Worse, a workspace with no `.mdd` at all is indistinguishable from one where MDD was never
 * opened, which is how a forty-minute run in another repository ended up leaving no trace anywhere.
 *
 * This file is that missing first write: one line the moment an MDD coordinator conversation
 * touches this workspace, before any run, preflight or approval exists. It is metadata only —
 * identity, workspace and a timestamp — and it is never read by a run. Nothing here decides
 * anything; it only makes the attempt countable.
 */
export const SESSION_LOG_VERSION = 1;
const LIMIT = 262144;
/**
 * Old rows are dropped rather than allowed to grow the file forever. A workspace where five
 * hundred MDD conversations were opened has long since answered any question the oldest row
 * could, and the rows that matter for a report are the recent ones.
 */
export const MAX_SESSIONS = 500;

export type SessionRecord = {
  version: typeof SESSION_LOG_VERSION;
  sessionID: string;
  agent: string;
  directory: string;
  worktree: string;
  started: number;
};

export type SessionLogResult =
  | { ok: true; enabled: boolean; recorded: boolean; count: number }
  | { ok: false; diagnostic: 'session-log-unavailable' | 'invalid-session' };

const CONTROL = /[\x00-\x1f\x7f]/;

function identity(value: unknown, label: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) {
    throw new ValidationError(`Invalid session ${label}.`);
  }
  return value;
}

/** Written by this module, so parsing only has to fail closed on a damaged or foreign line. */
function parse(value: unknown): SessionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid session record.');
  const input = value as Record<string, unknown>;
  if (input.version !== SESSION_LOG_VERSION || !Number.isSafeInteger(input.started) ||
      (input.started as number) < 0 || (input.started as number) > 8640000000000000) throw new ValidationError('Invalid session record.');
  return {
    version: SESSION_LOG_VERSION,
    sessionID: identity(input.sessionID, 'identity'),
    agent: identity(input.agent, 'agent', 128),
    directory: identity(input.directory, 'directory', 4096),
    worktree: identity(input.worktree, 'worktree', 4096),
    started: input.started as number,
  };
}

/**
 * Records that this conversation opened MDD here, once. A session already on file is left alone:
 * rewriting its row on every tool call would turn a cheap append into a full read-modify-write on
 * the hot path, and the fact worth keeping — that the conversation existed — does not change.
 *
 * Never throws. Instrumentation that can break a run is instrumentation that gets removed, and
 * nothing a coordinator does should fail because a local file could not be written.
 */
export function recordSession(root: string, value: unknown, now = Date.now(), environment?: InstallationEnvironment): SessionLogResult {
  let entry: SessionRecord;
  try {
    if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new ValidationError('Invalid clock.');
    const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    entry = parse({ ...input, version: SESSION_LOG_VERSION, started: now });
  } catch { return { ok: false, diagnostic: 'invalid-session' }; }
  try {
    // The user's telemetry preference governs every local record MDD keeps, this one included.
    // A workspace ledger that ignored "off" would be a different promise than the one on the tin.
    if (!loadGlobalSettings(environment).telemetry.enabled) return { ok: true, enabled: false, recorded: false, count: 0 };
    const files = new LocalFiles(root);
    let recorded = false;
    let count = 0;
    files.update('.mdd/sessions.jsonl', previous => {
      const existing = (previous ?? '').trimEnd();
      const lines = existing === '' ? [] : existing.split('\n');
      const records: SessionRecord[] = [];
      for (const line of lines) {
        // A damaged line is dropped rather than failing the write: one bad row must not stop the
        // workspace from recording anything ever again.
        try { records.push(parse(JSON.parse(line))); } catch { /* ignore */ }
      }
      if (!records.some(item => item.sessionID === entry.sessionID && item.directory === entry.directory)) {
        records.push(entry);
        recorded = true;
      }
      const kept = records.slice(-MAX_SESSIONS);
      count = kept.length;
      return `${kept.map(item => JSON.stringify(item)).join('\n')}\n`;
    }, LIMIT);
    return { ok: true, enabled: true, recorded, count };
  } catch { return { ok: false, diagnostic: 'session-log-unavailable' }; }
}

/** Read-only view for the report. A damaged line is skipped, never repaired: reading never writes. */
export function readSessions(root: string): SessionRecord[] {
  try {
    const text = new LocalFiles(root).read('.mdd/sessions.jsonl', LIMIT);
    if (text === undefined) return [];
    return text.trimEnd().split('\n').flatMap(line => {
      try { return [parse(JSON.parse(line))]; } catch { return []; }
    });
  } catch { return []; }
}
