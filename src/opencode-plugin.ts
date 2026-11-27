import { Model, Plugin } from '@opencode/plugin';
import { resolve } from 'node:path';
import { z } from 'zod';
import { loadGlobalSettings } from './global-settings.js';
import { activeProfile, agentFor, contextSettings, MODEL_ROLES } from './settings.js';
import type { Preferences, Settings } from './settings.js';
import { JD_INSPECT, inspectJudgmentTarget, isJudge } from './judgment-day.js';
import { createContextWatch } from './context-notice.js';
import { checkpointText, readRun, resolveActiveRun, runCandidates } from './run-checkpoint.js';

export const COORDINATOR = 'mdd-orchestrator';

/**
 * The line appended to the coordinator's prompt so it knows the user's configured preferences.
 * Unset values are left for the coordinator to ask (mode) or default (summary).
 */
export function preferencesLine(answers: Preferences): string {
  return `\n\nMDD preferences: mode=${answers.mode ?? 'unset (ask once per run)'}; summary=${answers.summary ?? 'medium'}.\n`;
}

/** Settings are read once at startup; an invalid file falls back to defaults instead of disabling MDD. */
export function startupSettings(load: () => Settings = loadGlobalSettings): { settings: Settings | undefined; problem?: string } {
  try { return { settings: load() }; }
  catch (error) { return { settings: undefined, problem: error instanceof Error ? error.message : String(error) }; }
}

type Draft = {
  id: unknown;
  model?: unknown;
  system?: unknown;
  permissions: { action: string; resource: string; effect: 'allow' | 'deny' | 'ask' }[];
};

/**
 * Everything the plugin changes about agents, as one pure function so it can be tested without a
 * host: the configured model per role, the preferences line on the coordinator, and the judges'
 * lockdown to the one inspection tool. Other agents only lose access to that tool.
 */
export function applyAgentPolicy(draft: Draft, settings: Settings | undefined): void {
  const id = String(draft.id);
  if (settings) {
    const profile = activeProfile(settings);
    const role = MODEL_ROLES.find(candidate => agentFor(candidate) === id);
    const model = role ? profile.models[role] : undefined;
    if (model) draft.model = Model.Ref.parse(model);
    if (id === COORDINATOR && typeof draft.system === 'string' && !draft.system.includes('\nMDD preferences: '))
      draft.system += preferencesLine(profile.answers);
  }
  if (isJudge(id)) draft.permissions.push(
    { action: '*', resource: '*', effect: 'deny' }, { action: JD_INSPECT, resource: '*', effect: 'allow' });
  else draft.permissions.push({ action: JD_INSPECT, resource: '*', effect: 'deny' });
}

/** Default only fresh native children; never change agent definitions or resumed child models. */
export function applySubagentModelPolicy(event: { readonly agent: string; readonly tool: string; input: unknown }, settings: Settings | undefined): void {
  if (!settings || event.agent !== COORDINATOR || event.tool !== 'subagent' ||
      typeof event.input !== 'object' || event.input === null || Array.isArray(event.input)) return;
  const input = event.input as Record<string, unknown>;
  if (input.agent !== 'explore' && input.agent !== 'general') return;
  // Native OpenCode normalizes empty optional strings to omission in its own before hook.
  if ((input.model !== undefined && input.model !== '') ||
      (input.sessionID !== undefined && input.sessionID !== '')) return;
  const model = activeProfile(settings).subagentModels?.[input.agent];
  if (model) event.input = { ...input, model };
}

const inspectInput = z.object({
  operation: z.enum(['tree', 'blob', 'diff']),
  commit: z.string(),
  base: z.string().optional(),
  path: z.string().optional(),
}).strict();

function locationKey(directory: string): string {
  const path = resolve(directory);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}

const modelKey = (model: { providerID: string; id: string }) => JSON.stringify([model.providerID, model.id]);
const validLimit = (limit: number) => Number.isSafeInteger(limit) && limit > 0;

export default Plugin.define({
  id: 'mdd',
  setup: async ctx => {
    const worktree = ctx.location.project.directory;
    const { directory } = ctx.location;
    const { settings, problem } = startupSettings();
    const context = contextSettings(settings && activeProfile(settings));
    if (problem) console.error(`MDD: la configuración global no es válida y se usan los valores por defecto: ${problem}`);

    await ctx.tool.hook('execute.before', event => applySubagentModelPolicy(event, settings));

    const policy: Parameters<typeof ctx.agent.transform>[0] = editor => {
      for (const agent of editor.list()) editor.update(String(agent.id), draft => applyAgentPolicy(draft as unknown as Draft, settings));
    };
    let registration = await ctx.agent.transform(policy);
    // File-backed agents arrive after plugins start. Apply the policy again once they do.
    let reapplied = false;
    const reapply = async () => {
      if (reapplied) return;
      reapplied = true;
      await registration.dispose();
      registration = await ctx.agent.transform(policy);
    };

    await ctx.tool.transform(editor => editor.add({
      name: JD_INSPECT,
      description: 'Judge-only immutable local Git inspection for Judgment Day. Supply a full commit object ID; tree lists committed paths, blob reads an exact committed path, diff compares two full commit IDs. No shell, live source, remote fetch or partial output.',
      input: inspectInput,
      options: { codemode: false },
      async execute(args, context) {
        if (!isJudge(context.agent)) throw new Error(`${JD_INSPECT} is only available to the Judgment Day judges.`);
        return { content: JSON.stringify(await inspectJudgmentTarget(worktree, args, context.signal)) };
      },
    }));

    // A judge sees only its inspection tool, whatever else the host would offer it.
    await ctx.session.hook('context', async event => {
      if (!isJudge(event.agent)) return;
      for (const name of Object.keys(event.tools)) if (name !== JD_INSPECT) delete event.tools[name];
    });

    const location = locationKey(directory);
    const sessionInLocation = async (sessionID: string) => {
      const session = await ctx.session.get({ sessionID });
      return locationKey(session.location.directory) === location;
    };
    const sessionLocations = new Map<string, Promise<boolean>>();
    const limits = new Map<string, number>();
    let catalogLoaded = false;
    const refreshLimits = async () => {
      const { data } = await ctx.model.list({ location: { directory } });
      limits.clear();
      for (const model of data) {
        const { context, input = context } = model.limit;
        if (validLimit(context) && validLimit(input)) limits.set(modelKey(model), Math.min(context, input));
      }
      catalogLoaded = true;
    };
    const watch = context.notice ? createContextWatch({
      coordinator: COORDINATOR,
      directory,
      thresholdPercent: context.noticeThreshold,
      async limitFor(model) {
        if (!catalogLoaded) await refreshLimits();
        const key = modelKey(model);
        if (!limits.has(key)) await refreshLimits();
        return limits.get(key);
      },
      async inLocation(sessionID) {
        const lookup = sessionLocations.get(sessionID) ?? sessionInLocation(sessionID);
        sessionLocations.set(sessionID, lookup);
        try {
          const matches = await lookup;
          return matches && sessionLocations.get(sessionID) === lookup;
        } catch (error) {
          if (sessionLocations.get(sessionID) === lookup) sessionLocations.delete(sessionID);
          throw error;
        }
      },
      async notify(sessionID, text) {
        await ctx.session.synthetic({
          sessionID, text, description: 'MDD context notice',
          metadata: { source: 'mdd', notice: 'context' }, delivery: 'steer', resume: false,
        });
      },
      warn: message => console.error(message),
    }) : undefined;

    if (context.checkpoint) await ctx.session.hook('compaction', async event => {
      if (event.agent !== COORDINATOR || event.result !== undefined) return;
      try {
        const candidates = runCandidates(event.messages, directory);
        if (!candidates.length || !await sessionInLocation(event.sessionID)) return;
        const runs = candidates.map(candidate => ({ ...candidate, ...readRun(directory, candidate.id) }));
        const resolution = resolveActiveRun(runs);
        const text = checkpointText(resolution, resolution.kind === 'run' ? runs.find(run => run.id === resolution.id) : undefined);
        if (text !== undefined) event.system.push({ type: 'text', text });
      } catch (error) {
        console.error('MDD: could not prepare the run checkpoint:', error);
      }
    });

    const controller = new AbortController();
    const stream = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'session.deleted' || event.type === 'session.moved') sessionLocations.delete(event.data.sessionID);
          watch?.observe(event);
          if (event.type === 'agent.updated') await reapply();
        }
      } catch (error) { if (!controller.signal.aborted) console.error('MDD: el flujo de eventos terminó:', error); }
    })();

    return async () => {
      controller.abort();
      await stream;
      await watch?.settle();
      await registration.dispose();
    };
  },
});
