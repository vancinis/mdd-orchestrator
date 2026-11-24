import { resolve } from 'node:path';

import { CONTEXT_DEFAULTS } from './settings.js';

export const CONTEXT_THRESHOLD_PERCENT = CONTEXT_DEFAULTS.noticeThreshold;

type Model = { providerID: string; id: string };
type WatchDeps = {
  thresholdPercent?: number;
  coordinator: string;
  directory: string;
  limitFor(model: Model): Promise<number | undefined>;
  inLocation(sessionID: string): Promise<boolean>;
  notify(sessionID: string, text: string): Promise<void>;
  warn(message: string): void;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validLimit(value: unknown): value is number {
  return nonnegative(value) && Number.isInteger(value) && value > 0;
}

export function contextTokens(tokens: unknown): number | undefined {
  const usage = record(tokens);
  const cache = record(usage?.cache);
  const { input, output } = usage ?? {};
  const { read, write } = cache ?? {};
  if (!nonnegative(input) || !nonnegative(output) || !nonnegative(read) || !nonnegative(write)) return;
  // Cache usage is separate from input. Reasoning is not reliably replayed and is not added.
  const used = input + read + write + output;
  if (Number.isFinite(used) && used > 0) return used;
}

export function reachesThreshold(used: unknown, limit: unknown, percent: number = CONTEXT_THRESHOLD_PERCENT): boolean {
  if (!nonnegative(used) || !validLimit(limit)) return false;
  if (Number.isInteger(used)) {
    return BigInt(used) * 100n >= BigInt(limit) * BigInt(percent);
  }
  return used * 100 >= limit * percent;
}

export function contextNotice(used: number, limit: number): string {
  const percent = Math.round((used / limit) * 100);
  return `MDD context notice: this conversation is using about ${percent}% of the model's context (${used} of ${limit} tokens). `
    + 'Finish the current step; do not start another phase or cancel running actors. '
    + 'With an active MDD run: rewrite its `## Now`, mirror it, and propose continuing in a new conversation '
    + 'with a resume phrase naming the run and next step. Without one: propose a new conversation '
    + 'with a brief summary of the work and the next step.';
}

function locationKey(directory: string): string {
  const path = resolve(directory);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

export function createContextWatch(deps: WatchDeps): { observe(event: unknown): void; settle(): Promise<void> } {
  const directory = locationKey(deps.directory);
  const pending = new Map<string, Map<string, Model>>();
  const episodes = new Map<string, { modelKey: string; notified: boolean }>();
  const warned = new Set<string>();
  let queue = Promise.resolve();

  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    try {
      deps.warn(`MDD context notice: ${message}`);
    } catch {
      // A failing diagnostic sink must not stop processing subsequent events.
    }
  }

  async function handle(event: unknown): Promise<void> {
    const envelope = record(event);
    const data = record(envelope?.data);
    const sessionID = data?.sessionID;
    if (!data || !identifier(sessionID)) return;
    const eventDirectory = record(envelope?.location)?.directory;
    const foreign = eventDirectory !== undefined
      && (!identifier(eventDirectory) || locationKey(eventDirectory) !== directory);

    switch (envelope?.type) {
      case 'session.deleted':
      case 'session.compaction.ended':
        if (foreign) return;
        pending.delete(sessionID);
        episodes.delete(sessionID);
        return;
      case 'session.step.started': {
        if (foreign || data.agent !== deps.coordinator || !identifier(data.assistantMessageID)) return;
        const model = record(data.model);
        if (!identifier(model?.providerID) || !identifier(model?.id)) return;
        const steps = pending.get(sessionID) ?? new Map<string, Model>();
        steps.set(data.assistantMessageID, { providerID: model.providerID, id: model.id });
        pending.set(sessionID, steps);
        return;
      }
      case 'session.step.ended':
        break;
      default:
        return;
    }

    if (!identifier(data.assistantMessageID)) return;
    const steps = pending.get(sessionID);
    const model = steps?.get(data.assistantMessageID);
    if (!steps || !model) return;
    steps.delete(data.assistantMessageID);
    if (steps.size === 0) pending.delete(sessionID);

    if (foreign || typeof data.finish !== 'string' || data.finish === 'error') return;
    const used = contextTokens(data.tokens);
    if (used === undefined) return;

    try {
      if (eventDirectory === undefined && !await deps.inLocation(sessionID)) return;
    } catch (error) {
      warnOnce('location', `could not check session location: ${String(error)}`);
      return;
    }

    const modelKey = JSON.stringify([model.providerID, model.id]);
    const modelName = `${model.providerID}/${model.id}`;
    let episode = episodes.get(sessionID);
    if (episode?.modelKey !== modelKey) {
      episode = { modelKey, notified: false };
      episodes.set(sessionID, episode);
    }
    let limit: number | undefined;
    try {
      limit = await deps.limitFor(model);
    } catch (error) {
      warnOnce(`lookup:${modelKey}`, `could not look up the context limit for ${modelName}: ${String(error)}`);
      return;
    }
    if (!validLimit(limit)) {
      warnOnce(`limit:${modelKey}`, `no context limit for ${modelName}; the MDD context notice is off for it`);
      return;
    }

    if (!reachesThreshold(used, limit, deps.thresholdPercent)) {
      episode.notified = false;
    } else if (!episode.notified) {
      episode.notified = true;
      try {
        await deps.notify(sessionID, contextNotice(used, limit));
      } catch (error) {
        episode.notified = false;
        warnOnce('delivery', `could not deliver the notice: ${String(error)}`);
      }
    }
  }

  return {
    observe(event) {
      queue = queue.then(() => handle(event)).catch((error: unknown) => {
        warnOnce('event', `could not process context telemetry: ${String(error)}`);
      });
    },
    settle: () => queue,
  };
}
