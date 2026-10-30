import { Model, Plugin } from '@opencode/plugin';
import { z } from 'zod';
import { loadGlobalSettings } from './global-settings.js';
import { activeProfile, agentFor, MODEL_ROLES } from './settings.js';
import type { Preferences, Settings } from './settings.js';
import { JD_INSPECT, inspectJudgmentTarget, isJudge } from './judgment-day.js';

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

const inspectInput = z.object({
  operation: z.enum(['tree', 'blob', 'diff']),
  commit: z.string(),
  base: z.string().optional(),
  path: z.string().optional(),
}).strict();

export default Plugin.define({
  id: 'mdd',
  setup: async ctx => {
    const worktree = ctx.location.project.directory;
    const { settings, problem } = startupSettings();
    if (problem) console.error(`MDD: la configuración global no es válida y se usan los valores por defecto: ${problem}`);

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

    const controller = new AbortController();
    const stream = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'agent.updated') await reapply();
        }
      } catch (error) { if (!controller.signal.aborted) console.error('MDD: el flujo de eventos terminó:', error); }
    })();

    return async () => {
      controller.abort();
      await stream;
      await registration.dispose();
    };
  },
});
