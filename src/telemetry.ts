import { LocalFiles } from './local-files.js';
import { loadGlobalSettings } from './global-settings.js';
import type { InstallationEnvironment } from './installation-paths.js';
import { MODEL_ROLES } from './settings.js';
import type { Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const LIMIT = 1024 * 1024;
const MAX_EVENTS = 5000;
export type TelemetryEvent = {
  timestamp: number;
  event: 'preflight' | 'phase-start' | 'phase-end' | 'approval' | 'report';
  phase?: Phase;
  duration?: number;
  route?: 'low' | 'high';
  outcome?: 'passed' | 'failed' | 'blocked' | 'cancelled';
};
export type TelemetryResult =
  | { ok: true; enabled: boolean; count: number; retentionDays: 30 }
  | { ok: false; diagnostic: 'telemetry-unavailable' | 'invalid-event' };

function parseEvent(value: unknown): TelemetryEvent {
  const input = objectWithKeys(value, 'event', ['timestamp', 'event', 'phase', 'duration', 'route', 'outcome']);
  if (!Number.isSafeInteger(input.timestamp) || (input.timestamp as number) < 0 || (input.timestamp as number) > 8640000000000000 ||
      !['preflight', 'phase-start', 'phase-end', 'approval', 'report'].includes(input.event as string)) {
    throw new ValidationError('Invalid telemetry event.');
  }
  const result: TelemetryEvent = { timestamp: input.timestamp as number, event: input.event as TelemetryEvent['event'] };
  if (Object.hasOwn(input, 'phase')) {
    if (!MODEL_ROLES.includes(input.phase as Phase) || input.phase === 'orchestrator') throw new ValidationError('Invalid phase.');
    result.phase = input.phase as Phase;
  }
  if (Object.hasOwn(input, 'duration')) {
    if (!Number.isSafeInteger(input.duration) || (input.duration as number) < 0 || (input.duration as number) > 86400000) {
      throw new ValidationError('Invalid duration.');
    }
    result.duration = input.duration as number;
  }
  if (Object.hasOwn(input, 'route')) {
    if (input.route !== 'low' && input.route !== 'high') throw new ValidationError('Invalid route.');
    result.route = input.route;
  }
  if (Object.hasOwn(input, 'outcome')) {
    if (!['passed', 'failed', 'blocked', 'cancelled'].includes(input.outcome as string)) throw new ValidationError('Invalid outcome.');
    result.outcome = input.outcome as TelemetryEvent['outcome'] & string;
  }
  return result;
}

function retained(text: string | undefined, now: number): TelemetryEvent[] {
  if (text === undefined || text === '') return [];
  const lines = text.trimEnd().split('\n');
  if (lines.length > MAX_EVENTS) throw new Error('Invalid local telemetry.');
  return lines.map(line => parseEvent(JSON.parse(line))).filter(event => event.timestamp > now - RETENTION_MS && event.timestamp <= now);
}

function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error('Invalid clock.');
}

function success(enabled: boolean, count: number): TelemetryResult {
  return { ok: true, enabled, count, retentionDays: 30 };
}

/** No background timers, import side effects, network calls, or implicit startup writes. */
export function recordTelemetry(root: string, value: unknown, now = Date.now(), environment?: InstallationEnvironment): TelemetryResult {
  let event: TelemetryEvent;
  try {
    clock(now);
    event = parseEvent(value);
    if (event.timestamp > now || event.timestamp <= now - RETENTION_MS) throw new Error('Out of retention window.');
  } catch { return { ok: false, diagnostic: 'invalid-event' }; }
  try {
    if (!loadGlobalSettings(environment).telemetry.enabled) return success(false, 0);
    let count = 0;
    new LocalFiles(root).update('.mdd/telemetry.jsonl', previous => {
      const events = [...retained(previous, now), event].slice(-MAX_EVENTS);
      count = events.length;
      return `${events.map(item => JSON.stringify(item)).join('\n')}\n`;
    }, LIMIT);
    return success(true, count);
  } catch { return { ok: false, diagnostic: 'telemetry-unavailable' }; }
}

/** Status prunes expired rows only when an existing file needs pruning. */
export function telemetryStatus(root: string, now = Date.now(), environment?: InstallationEnvironment): TelemetryResult {
  try {
    clock(now);
    const enabled = loadGlobalSettings(environment).telemetry.enabled;
    const files = new LocalFiles(root);
    const previous = files.read('.mdd/telemetry.jsonl', LIMIT);
    let events = retained(previous, now);
    const serialize = (items: TelemetryEvent[]) => items.length ? `${items.map(item => JSON.stringify(item)).join('\n')}\n` : undefined;
    if (previous !== undefined && previous !== serialize(events)) {
      files.update('.mdd/telemetry.jsonl', current => {
        events = retained(current, now);
        return serialize(events);
      }, LIMIT);
    }
    return success(enabled, events.length);
  } catch { return { ok: false, diagnostic: 'telemetry-unavailable' }; }
}

export function clearTelemetry(root: string, environment?: InstallationEnvironment): TelemetryResult {
  try {
    const enabled = loadGlobalSettings(environment).telemetry.enabled;
    const files = new LocalFiles(root);
    files.remove('.mdd/telemetry.jsonl');
    return success(enabled, 0);
  } catch { return { ok: false, diagnostic: 'telemetry-unavailable' }; }
}
