import { tool } from '@opencode-ai/plugin';
import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import { isDeepStrictEqual } from 'node:util';
import { boundedText, PhaseRunner } from './phase-runner.js';
import type { Inspect, Runtime } from './phase-runner.js';
import { freezeProfile, setupDiagnostic } from './settings.js';
import { loadGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import { applyModelOverrides } from './native-models.js';
import { NativeIntake } from './native-intake.js';
import type { IntakeInspect } from './native-intake.js';
import { recordTelemetry } from './telemetry.js';
import { ProgressGuard } from './progress.js';
import { renderPRBody } from './pr-body.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unknown OpenCode response structure.');
  return value as Record<string, unknown>;
}

/** MDD tools belong to the MDD coordinator. Other agents share the registry but not this state. */
export const MDD_TOOLS = ['mdd_start', 'mdd_status', 'mdd_phase_result', 'mdd_reset', 'mdd_change_request', 'mdd_contextual_explore', 'mdd_pr_body'] as const;
export const COORDINATOR = 'mdd-orchestrator';
function coordinatorOnly(agent: string, tool: string): void {
  if (agent !== COORDINATOR) {
    throw new Error(`${tool} belongs to the ${COORDINATOR} agent and does nothing here. This session is not an MDD run; continue with your own tools.`);
  }
}
/**
 * Plugin tools are registered once for the whole app, so every agent would otherwise see and be
 * able to call them. Disabling them per agent keeps them out of unrelated tool lists and prompts.
 */
export function restrictTools(config: { agent?: Record<string, Record<string, unknown>> }): void {
  for (const [name, agent] of Object.entries(config.agent ?? {})) {
    if (name === COORDINATOR || !agent || typeof agent !== 'object') continue;
    const tools = { ...(agent.tools as Record<string, boolean> | undefined) };
    for (const tool of MDD_TOOLS) if (tools[tool] === undefined) tools[tool] = false;
    if (tools['mdd_*'] === undefined) tools['mdd_*'] = false;
    agent.tools = tools;
  }
}

/**
 * Inspection bounds are per subject. History stays tied to the requested page size, while
 * agent registries and resolved permission rulesets scale with the user's installed skills
 * and agents, so a history-sized cap would reject ordinary real installations.
 */
export const HISTORY_MAX = 100;
export const AGENTS_MAX = 2000;
export const PERMISSION_MAX = 4000;
export const PARTS_MAX = 1000;

function list(value: unknown, subject: string, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Unknown OpenCode ${subject} structure.`);
  if (value.length > max) throw new Error(`OpenCode ${subject} exceeds the ${max} entry inspection limit.`);
  return value.map(record);
}

async function readSdk<T>(operation: (signal: AbortSignal) => Promise<T>, timeout: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('OpenCode inspection timed out.')); }, timeout);
      }),
    ]);
  } finally { controller.abort(); clearTimeout(timer); }
}

export function createInspector(input: PluginInput, timeout = 5000): Inspect & IntakeInspect {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) throw new Error('Invalid inspection timeout.');
  const session = async (id: string, directory: string) => {
    const response = await readSdk(signal => input.client.session.get({
      path: { id }, query: { directory }, signal, throwOnError: true,
    }), timeout);
    return record(response.data);
  };
  const messages = async (id: string, directory: string) => {
    const response = await readSdk(signal => input.client.session.messages({
      path: { id }, query: { directory, limit: 100 }, signal, throwOnError: true,
    }), timeout);
    const history = list(response.data, 'message history', HISTORY_MAX);
    if (history.length === HISTORY_MAX) throw new Error('History reaches inspection limit; completeness is uncertain.');
    return history;
  };
  const checkWorkspace = (runtime: Runtime) => {
    if (runtime.directory !== input.directory || runtime.worktree !== input.worktree) {
      throw new Error('Runtime workspace differs from the project plugin instance.');
    }
  };
  const inspector: Inspect & IntakeInspect = {
    async setupPending(runtime, selected, messageID) {
      await inspector.parent(runtime);
      const history = await messages(runtime.sessionID, runtime.directory);
      if (messageID !== undefined && record(history.at(-1)?.info).id !== messageID) throw new Error('Setup recovery does not match the actual native caller message.');
      if (history.some(message => record(message.info).summary === true || list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'compaction'))) throw new Error('Setup recovery unavailable: compacted history.');
      if (!history.some(message => list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'tool' && part.tool === 'mdd_start' && !(message === history.at(-1) && record(part.state).status === 'running')))) return undefined;
      const candidates = new Map<string, { requirements: string; userMessageID: string }>();
      const identities = new Set<string>();
      const calls = new Set<string>();
      for (const message of history) {
        const info = record(message.info);
        const id = boundedText(info.id, 'history message ID', 256);
        if (identities.has(id) || info.sessionID !== runtime.sessionID || !['user', 'assistant'].includes(String(info.role))) throw new Error('Setup recovery unavailable: incomplete or ambiguous native history. Restate the original objective in a fresh parent.');
        identities.add(id);
        if (info.role === 'assistant') {
          const path = record(info.path);
          if (info.agent !== 'mdd-orchestrator' || info.error != null || path.cwd !== runtime.directory || path.root !== runtime.worktree) throw new Error('Setup recovery unavailable: native workspace or caller changed.');
        }
        for (const part of list(message.parts, 'message parts', PARTS_MAX)) {
          if (!['text', 'reasoning', 'step-start', 'step-finish', 'tool', 'file'].includes(String(part.type))) throw new Error('Setup recovery unavailable: unknown history part.');
          if (part.type !== 'tool') continue;
          const callID = boundedText(part.callID, 'historical call ID', 256);
          if (calls.has(callID)) throw new Error('Setup recovery unavailable: ambiguous tool call.');
          calls.add(callID);
          if (info.role !== 'assistant' || part.sessionID !== runtime.sessionID || part.messageID !== id) throw new Error('Setup recovery unavailable: tool ownership mismatch.');
          const state = record(part.state);
          if (part.tool === 'mdd_status') continue;
          // The current invocation is not historical evidence or permission to resume.
          if (message === history.at(-1) && part.tool === 'mdd_start' && state.status === 'running') continue;
          if (part.tool !== 'mdd_start' || state.status !== 'completed' || typeof state.output !== 'string') throw new Error('Setup recovery unavailable: earlier execution or unknown start outcome. Restate the original objective in a fresh parent; do not resume uncertain work.');
          const time = record(state.time);
          if (!Number.isFinite(time.start) || !Number.isFinite(time.end) || Number(time.end) < Number(time.start) || time.compacted !== undefined) throw new Error('Setup recovery unavailable: incomplete or compacted tool result.');
          let output: Record<string, unknown>;
          try { output = record(JSON.parse(boundedText(state.output, 'setup-only output', 96000))); } catch { throw new Error('Setup recovery unavailable: unknown start output.'); }
          const origin = record(output.setupOrigin);
          const start = record(output.pendingStart);
          const setup = record(output.setup);
          const preceding = history.slice(0, history.indexOf(message));
          const latestUser = preceding.findLast(item => record(item.info).role === 'user');
          const user = preceding.find(item => record(item.info).role === 'user' && record(item.info).id === origin.userMessageID);
          if (!user) throw new Error('Setup recovery unavailable: missing original native user.');
          const userInfo = record(user.info);
          const prior = candidates.get(String(userInfo.id));
          const text = list(user.parts, 'message parts', PARTS_MAX).filter(item => item.type === 'text');
          if (output.state !== 'blocked' || output.task !== undefined || output.question !== undefined || !Array.isArray(output.questionReceipts) || output.questionReceipts.length ||
              !['missing-file', 'missing-engram'].includes(String(setup.problem)) || setup.workspaceRoot !== runtime.directory ||
              origin.projectID !== input.project.id || origin.directory !== runtime.directory || origin.worktree !== runtime.worktree || info.parentID !== record(latestUser?.info).id ||
              (user !== latestUser && prior?.requirements !== start.requirements) ||
              !text.length || text.some(item => item.synthetic === true || item.ignored === true || item.sessionID !== runtime.sessionID || item.messageID !== userInfo.id || typeof item.text !== 'string') ||
              text.map(item => item.text).join('\n') !== start.requirements || !isDeepStrictEqual(state.input, start)) throw new Error('Setup recovery unavailable: original objective lacks correlated setup-only proof.');
          const requirements = boundedText(start.requirements, 'original requirements', 12000);
          candidates.set(String(userInfo.id), { requirements, userMessageID: String(userInfo.id) });
        }
      }
      const matches = [...candidates.values()].filter(item => selected === undefined || item.requirements === selected);
      if (matches.length === 1) return matches[0];
      if (candidates.size === 1) return [...candidates.values()][0];
      if (candidates.size) throw new Error('Setup recovery needs the original objective: select the exact native setup-failed requirements; history is ambiguous.');
      return undefined;
    },
    /**
     * Confirms who is running MDD and, for a native question, that the pending call is the exact
     * one the user is answering. Consent still needs correlation; ordinary work does not.
     */
    async parent(runtime, callID, tool = 'task', args) {
      checkWorkspace(runtime);
      const parent = await session(runtime.sessionID, runtime.directory);
      if (parent.id !== runtime.sessionID || parent.parentID != null || parent.directory !== runtime.directory ||
          parent.projectID !== input.project.id || parent.agent !== COORDINATOR) {
        throw new Error(`MDD runs in a top-level ${COORDINATOR} conversation in this workspace.`);
      }
      if (tool !== 'question' || callID === undefined) return;
      const history = await messages(runtime.sessionID, runtime.directory);
      const parts = history.flatMap(message => list(message.parts, 'message parts', PARTS_MAX)
        .filter(part => part.type === 'tool' && part.tool === tool && part.callID === callID)
        .map(part => ({ part, info: record(message.info) })));
      if (parts.length !== 1) throw new Error('The native question call is not uniquely readable.');
      const { part, info } = parts[0]!;
      const state = record(part.state);
      if (part.sessionID !== runtime.sessionID || part.messageID !== info.id || info.role !== 'assistant' ||
          state.status !== 'running' || !isDeepStrictEqual(state.input, args)) {
        throw new Error('The native question history differs from the exact running call.');
      }
    },
    async intake(runtime, requirements, messageID) {
      await inspector.parent(runtime);
      const history = await messages(runtime.sessionID, runtime.directory);
      const caller = history.at(-1);
      if (!caller || record(caller.info).id !== messageID || record(caller.info).role !== 'assistant') throw new Error('Start does not match the actual native caller message.');
      const user = history.slice(0, -1).findLast(message => record(message.info).role === 'user');
      if (!user || record(user.info).sessionID !== runtime.sessionID) throw new Error('No actual native user requirements found.');
      const info = record(user.info);
      const parts = list(user.parts, 'message parts', PARTS_MAX).filter(part => part.type === 'text');
      if (!parts.length || parts.some(part => part.synthetic === true || part.ignored === true ||
          part.sessionID !== runtime.sessionID || part.messageID !== info.id || typeof part.text !== 'string') ||
          parts.map(part => part.text).join('\n') !== requirements) {
        throw new Error('Requirements must exactly match the latest native user text; do not rewrite or invent them.');
      }
      return boundedText(info.id, 'native user message ID', 256);
    },
    async question(runtime, call, args) {
      if (call.sessionID !== runtime.sessionID) throw new Error('Native question parent mismatch.');
      await inspector.parent(runtime, call.callID, 'question', args);
    },
    /**
     * Returns what the delegated phase actually answered. The result is the actor's report, not
     * a corroborated record: MDD reads the completed task envelope and nothing else.
     */
    async result(_runtime, _call, _phase, raw) {
      const output = record(raw);
      const envelope = typeof output.output === 'string' ? output.output : '';
      const match = /^<task id="[^"]*" state="completed">\r?\n<task_result>\r?\n([\s\S]*)\r?\n<\/task_result>\r?\n<\/task>$/.exec(envelope);
      if (!match) throw new Error('The delegated phase did not return a completed task result.');
      return boundedText(match[1], 'delegated phase result', 20000);
    },
  };
  return inspector;
}

const plugin: Plugin = async input => {
  const settings = (() => { try { return loadGlobalSettings(); } catch { throw new Error(setupDiagnostic(installationPaths().ownedRoot).action); } })();
  const profile = freezeProfile(settings);
  const inspector = createInspector(input);
  const runner = new PhaseRunner(inspector, { telemetry: recordTelemetry, progress: new ProgressGuard(input.directory) });
  const intake = new NativeIntake(runner, inspector, settings);
  return {
    config: async config => { applyModelOverrides(config, profile); restrictTools(config as Parameters<typeof restrictTools>[0]); },
    tool: {
      mdd_pr_body: tool({
        description: 'Draft only a PR body using the exact local skill/template and recorded current-run evidence. Never commits, pushes or publishes. Optional notes must quote whole lines of the actual latest user text; unknown facts remain unverified.',
        args: { userText: tool.schema.string().min(1), notes: tool.schema.object({ environmentVariables: tool.schema.string().optional(), followUps: tool.schema.string().optional(), deployment: tool.schema.string().optional() }).optional() },
        async execute(args, context) {
          coordinatorOnly(context.agent, 'mdd_pr_body');
          if (context.abort.aborted) throw new Error('The PR body draft was aborted.');
          const current = runner.prFacts(context.sessionID);
          await inspector.intake(context, boundedText(args.userText, 'actual user request', 12000), context.messageID);
          const facts = runner.prFacts(context.sessionID);
          if (facts.runID !== current.runID) throw new Error('The current run changed while drafting; no draft was produced.');
          return JSON.stringify(renderPRBody(context.directory, facts, args.userText, args.notes));
        },
      }),
      mdd_start: tool({
        description: 'Start implementation with exact latest native user text, or exact pendingStart requirements proven by legacy setup-only history. Never pass continuation/status text as a new objective. Optional Engram memory bootstraps the actual native parent only when enabled.',
        args: {
          requirements: tool.schema.string().min(1).describe('Exact latest native user text or authenticated pendingStart requirements, without rewriting. Never substitute continuation text for a pending objective.'),
        },
        async execute(args, context) {
          coordinatorOnly(context.agent, 'mdd_start');
          if (context.abort.aborted) throw new Error('MDD start was aborted.');
          const status = record(await intake.start(args, context, context.messageID));
          if (status.setupOrigin) status.setupOrigin = { ...record(status.setupOrigin), projectID: input.project.id };
          return JSON.stringify(status);
        },
      }),
      mdd_status: tool({
        description: 'Read this actual parent session MDD state; never retries, resets, or approves a phase.',
        args: {},
        async execute(_args, context) {
          coordinatorOnly(context.agent, 'mdd_status');
          const status = record(intake.status(context.sessionID));
          let recovery = {};
          if (runner.status(context.sessionID).state === 'not-started' && !status.pendingStart) {
            try {
              const pending = await inspector.setupPending!(context);
              if (pending) recovery = { pendingStart: { requirements: pending.requirements } };
            } catch { recovery = { recovery: 'unavailable', reason: 'The original objective cannot be recovered safely from native history. Restate it in a fresh parent; do not resume uncertain execution.' }; }
          }
          return JSON.stringify({
            ...status, ...recovery,
            runtime: { sessionID: context.sessionID, directory: context.directory, worktree: context.worktree, agent: context.agent },
          });
        },
      }),
      mdd_change_request: tool({
        description: 'Request an explicit preflight rerun from fresh native user text, or propose a material change backed by a new user request or recorded concern. Keeps the current run until native confirmation and grouped preflight. Never use for ordinary plan choices or continuation.',
        args: { kind: tool.schema.enum(['rerun', 'material']), userText: tool.schema.string().min(1), requirements: tool.schema.string().optional(), concerns: tool.schema.unknown().optional() },
        async execute(args, context) {
          coordinatorOnly(context.agent, 'mdd_change_request');
          if (context.abort.aborted) throw new Error('Change request was aborted.');
          return JSON.stringify(await intake.changeRequest(args, context, context.messageID));
        },
      }),
      mdd_phase_result: tool({
        description: 'Report a phase you carried out yourself, instead of delegating it. Same result object a delegated phase returns, without a callID. Use it when delegation failed or when doing the work directly is simply the better route.',
        args: { result: tool.schema.unknown().describe('The phase result object, or its exact JSON text: phase, runID, outcome, evidenceSummary, artifact and the fields this phase requires.') },
        async execute(args, context) {
          coordinatorOnly(context.agent, 'mdd_phase_result');
          if (context.abort.aborted) throw new Error('The phase report was aborted.');
          return JSON.stringify(await intake.submit(args, context));
        },
      }),
      mdd_reset: tool({
        description: 'Release stopped MDD work in this conversation. Scope phase makes the current phase runnable again; scope run forgets the run so a new objective can start here. Recorded artifacts and memory are never deleted.',
        args: { scope: tool.schema.enum(['phase', 'run']).describe('phase releases the current attempt; run discards the run state for this conversation.') },
        async execute(args, context) {
          coordinatorOnly(context.agent, 'mdd_reset');
          return JSON.stringify(intake.reset(context, args.scope));
        },
      }),
      mdd_contextual_explore: tool({
        description: 'Request one useful read-only investigation, with or without an accepted run. Use it for information-only questions instead of stopping. Never starts implementation and never changes the main route, answers or pending approval. Returns exact native task arguments through status.',
        args: { purpose: tool.schema.string().min(1) },
        async execute(args, context) {
          coordinatorOnly(context.agent, 'mdd_contextual_explore');
          if (context.abort.aborted) throw new Error('Contextual exploration was aborted.');
          return JSON.stringify(await intake.explore(args, context));
        },
      }),
    },
    // Actors work with their own tools under native permissions. MDD only observes the two calls
    // that carry its own state: the phase task and the consent question.
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'question') return intake.beforeQuestion(input, output.args);
      if (input.tool !== 'task') return;
      intake.guardTask(input.sessionID);
      const args = await runner.before(input, output.args);
      if (args) Object.assign(output.args, args);
    },
    'tool.execute.after': async (input, output) => {
      if (input.tool === 'question') await intake.afterQuestion(input, input.args, output);
      if (input.tool === 'task') {
        await runner.after(input, input.args, output);
        intake.phaseRecorded(input.sessionID);
      }
    },
    event: async ({ event }) => {
      if (event.type === 'server.instance.disposed' && event.properties.directory === input.directory) { await intake.close(); return; }
      if (event.type !== 'message.part.updated') return;
      const part = event.properties.part;
      if (part.type === 'tool' && part.tool === 'task' && part.state.status === 'error') {
        runner.nativeError(part.sessionID, part.callID);
      }
      if (part.type === 'tool' && part.tool === 'question' && part.state.status === 'error') intake.nativeError(part);
    },
  };
};

export default plugin;
