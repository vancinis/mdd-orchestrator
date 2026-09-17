import { tool } from '@opencode-ai/plugin';
import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import { isDeepStrictEqual } from 'node:util';
import { boundedText, PhaseRunner } from './phase-runner.js';
import type { Inspect, Runtime } from './phase-runner.js';
import { defaultSettings, freezeProfile, setupDiagnostic } from './settings.js';
import { loadGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import type { StartupProfile } from './settings.js';
import { applyModelOverrides, nativeModel, NativeModels } from './native-models.js';
import { NativeIntake } from './native-intake.js';
import type { IntakeInspect } from './native-intake.js';
import { phaseName, phasePermissions, allowedTool, assertGithubLookup, READ_TOOLS } from './phase-policy.js';
import { NativeTools } from './native-tools.js';
import { MODEL_ROLES } from './settings.js';
import type { Phase } from './policy.js';
import type { TaskCall } from './phase-runner.js';
import { recordTelemetry } from './telemetry.js';
import { ProgressGuard } from './progress.js';
import { renderPRBody } from './pr-body.js';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unknown OpenCode response structure.');
  return value as Record<string, unknown>;
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

/** An absent session-level overlay means no extra rules; agent rules are still checked. */
function overlay(value: unknown, subject: string): Record<string, unknown>[] {
  return value === undefined || value === null ? [] : list(value, subject, PERMISSION_MAX);
}

type ChildInspect = {
  beforeChild(call: TaskCall, phase: Phase, tool: string, args: unknown, pending: (parent: string, phase: Phase) => { runtime: Runtime; call: TaskCall; checks: string[] }): Promise<void>;
  afterChild(call: TaskCall, tool: string, args: unknown, output: unknown): void;
};

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

export function createInspector(input: PluginInput, timeout = 5000, profile: StartupProfile = freezeProfile(defaultSettings())): Inspect & IntakeInspect & ChildInspect {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) throw new Error('Invalid inspection timeout.');
  const models = new NativeModels(profile);
  const nativeTools = new NativeTools();
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
  const checkAgents = async () => {
    const response = await readSdk(signal => input.client.app.agents({
      query: { directory: input.directory }, signal, throwOnError: true,
    }), timeout);
    const agents = list(response.data, 'agent registry', AGENTS_MAX);
    for (const name of MODEL_ROLES.filter(role => role !== 'orchestrator')) {
      const agent = agents.find(item => item.name === name);
      if (!agent || agent.mode !== 'subagent') throw new Error('MDD read-only agent is missing or has changed mode.');
      phasePermissions(name, list(agent.permission, `${name} permission rules`, PERMISSION_MAX));
    }
    return agents;
  };
  const inspector: Inspect & IntakeInspect & ChildInspect = {
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
    async beforeChild(call, phase, tool, args, pending) {
      const child = await session(call.sessionID, input.directory);
      const parentID = boundedText(child.parentID, 'native child parent', 256);
      const bound = pending(parentID, phase);
      if (!allowedTool(phase, tool)) throw new Error('MDD read-only or phase capability denies this tool.');
      if (phase === 'mdd-verify' && tool === 'bash' && !bound.checks.includes(String(record(args).command))) throw new Error('Verify may execute only exact applicable planned commands.');
      checkWorkspace(bound.runtime);
      if (child.id !== call.sessionID || child.agent !== phase || child.directory !== input.directory || child.projectID !== input.project.id) throw new Error('Child tool session binding mismatch.');
      const agents = await checkAgents();
      models.check(parentID, agents);
      phasePermissions(phase, [...list(agents.find(agent => agent.name === phase)?.permission, `${phase} permission rules`, PERMISSION_MAX), ...overlay(child.permission, 'child session permission rules')]);
      const history = await messages(parentID, input.directory);
      const matches = history.flatMap(message => list(message.parts, 'message parts', PARTS_MAX)).filter(part => part.type === 'tool' && part.tool === 'task' && part.callID === bound.call.callID);
      if (matches.length !== 1 || record(matches[0]!.state).status !== 'running' || record(record(matches[0]!.state).metadata).sessionId !== call.sessionID) throw new Error('Child tool is not bound to the live parent native task metadata.');
      const taskMetadata = record(record(matches[0]!.state).metadata);
      if (taskMetadata.parentSessionId !== parentID || taskMetadata.background !== undefined || taskMetadata.jobId !== undefined || nativeModel(taskMetadata.model) !== models.expected(parentID, phase)) throw new Error('Child task metadata is not the expected foreground/model binding.');
      const childHistory = await messages(call.sessionID, input.directory);
      const callers = childHistory.filter(message => list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'tool' && part.callID === call.callID));
      if (callers.length !== 1) throw new Error('Native child invocation is not uniquely readable.');
      const caller = record(callers[0]!.info);
      const location = record(caller.path);
      const parts = list(callers[0]!.parts, 'message parts', PARTS_MAX).filter(part => part.type === 'tool' && part.callID === call.callID);
      if (parts.length !== 1 || caller.role !== 'assistant' || caller.sessionID !== call.sessionID || caller.agent !== phase || caller.error != null ||
          nativeModel(caller) !== models.expected(parentID, phase) || location.cwd !== input.directory || location.root !== input.worktree) throw new Error('Native child caller identity/model/workspace mismatch.');
      const part = parts[0]!;
      const state = record(part.state);
      if (part.tool !== tool || part.sessionID !== call.sessionID || part.messageID !== caller.id || state.status !== 'running' || !isDeepStrictEqual(state.input, args)) throw new Error('Child native invocation input mismatch.');
      nativeTools.before(call.sessionID, call.callID, input.directory, phase, tool, record(args));
    },
    afterChild(call, tool, args, output) { nativeTools.after(call.sessionID, call.callID, tool, args, record(output)); },
    async parent(runtime, callID, tool = 'task', args) {
      checkWorkspace(runtime);
      const agents = await checkAgents();
      const parent = await session(runtime.sessionID, runtime.directory);
      if (parent.id !== runtime.sessionID || parent.parentID != null || parent.directory !== runtime.directory ||
          parent.projectID !== input.project.id || parent.agent !== 'mdd-orchestrator') {
        throw new Error('Actual OpenCode parent session is not the designated project orchestrator.');
      }
      const history = await messages(runtime.sessionID, runtime.directory);
      const matches = callID === undefined
        ? history.filter(message => record(message.info).role === 'assistant').slice(-1)
        : history.filter(message => list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'tool' && part.callID === callID && part.tool === tool));
      if (matches.length !== 1) throw new Error('Native parent task call is not uniquely readable.');
      const info = record(matches[0]!.info);
      const path = record(info.path);
      if (info.role !== 'assistant' || info.sessionID !== runtime.sessionID || info.agent !== 'mdd-orchestrator' ||
          path.cwd !== runtime.directory || path.root !== runtime.worktree || info.error != null) {
        throw new Error('Native caller identity or workspace mismatch.');
      }
      models.bind(runtime.sessionID, agents, info);
      if (tool === 'question') {
        const parts = list(matches[0]!.parts, 'message parts', PARTS_MAX).filter(part => part.type === 'tool' && part.callID === callID && part.tool === tool);
        if (parts.length !== 1) throw new Error('Native question call is not unique.');
        const part = parts[0]!;
        const state = record(part.state);
        if (part.sessionID !== runtime.sessionID || part.messageID !== info.id || state.status !== 'running' || !isDeepStrictEqual(state.input, args)) {
          throw new Error('Native question history differs from the exact running call.');
        }
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
    async result(runtime, call, phase, raw) {
      checkWorkspace(runtime);
      const agents = await checkAgents();
      models.check(runtime.sessionID, agents);
      const expectedModel = models.expected(runtime.sessionID, phase);
      const output = record(raw);
      const metadata = record(output.metadata);
      if (nativeModel(metadata.model) !== expectedModel) throw new Error('Native task metadata model mismatch.');
      const childID = boundedText(metadata.sessionId, 'child session ID', 256);
      if (metadata.parentSessionId !== call.sessionID || metadata.background !== undefined || metadata.jobId !== undefined) {
        throw new Error('Native task metadata is not a correlated foreground result.');
      }
      const child = await session(childID, runtime.directory);
      if (child.id !== childID || child.parentID !== runtime.sessionID || child.directory !== runtime.directory ||
          child.projectID !== input.project.id || child.agent !== phase) throw new Error('Child session binding mismatch.');
      phasePermissions(phaseName(phase), [...list(agents.find(agent => agent.name === phase)?.permission, `${phase} permission rules`, PERMISSION_MAX), ...overlay(child.permission, 'child session permission rules')]);
      const history = await messages(childID, runtime.directory);
      for (const message of history) {
        const info = record(message.info);
        if (info.sessionID !== childID || (info.role !== 'user' && info.role !== 'assistant') ||
            (info.role === 'assistant' && (info.error != null || info.agent !== phase || nativeModel(info) !== expectedModel)) ||
            list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'tool' &&
              (!allowedTool(phaseName(phase), String(part.tool)) || record(part.state).status !== 'completed'))) {
          throw new Error('Child history contains failed, unauthorized, or unknown execution evidence.');
        }
        if (info.role === 'assistant') {
          const location = record(info.path);
          if (location.cwd !== runtime.directory || location.root !== runtime.worktree) throw new Error('Child assistant workspace changed.');
        }
        if (list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'tool' && (part.sessionID !== childID || part.messageID !== info.id))) throw new Error('Child tool part ownership mismatch.');
      }
      const last = history.at(-1);
      if (!last) throw new Error('Child history is empty.');
      const info = record(last.info);
      const path = record(info.path);
      const time = record(info.time);
      if (info.role !== 'assistant' || info.sessionID !== childID || info.agent !== phase || info.error != null ||
          info.finish !== 'stop' || typeof time.completed !== 'number' || !Number.isFinite(time.completed) ||
          path.cwd !== runtime.directory || path.root !== runtime.worktree) throw new Error('Child has no successful final assistant response.');
      const parts = list(last.parts, 'message parts', PARTS_MAX);
      if (parts.some(part => !['text', 'reasoning', 'step-start', 'step-finish', 'tool'].includes(String(part.type)) ||
          part.sessionID !== childID || part.messageID !== info.id ||
          (part.type === 'tool' && record(part.state).status !== 'completed'))) throw new Error('Child result contains failed or unknown parts.');
      const textPart = parts.findLast(part => part.type === 'text');
      if (!textPart || textPart.synthetic === true || textPart.ignored === true) throw new Error('Missing actual assistant text.');
      const text = boundedText(textPart.text, 'child result', 20000);
      const expected = `<task id="${childID}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>`;
      if (output.output !== expected) throw new Error('Native task output differs from the actual child response.');
      const tools = history.flatMap(message => list(message.parts, 'message parts', PARTS_MAX)).filter(part => part.type === 'tool');
      return { text, evidence: nativeTools.evidence(childID, tools) };
    },
  };
  return inspector;
}

const plugin: Plugin = async input => {
  const settings = (() => { try { return loadGlobalSettings(); } catch { throw new Error(setupDiagnostic(installationPaths().ownedRoot).action); } })();
  const profile = freezeProfile(settings);
  const inspector = createInspector(input, 5000, profile);
  const runner = new PhaseRunner(inspector, { telemetry: recordTelemetry, progress: new ProgressGuard(input.directory) });
  const intake = new NativeIntake(runner, inspector, settings);
  const childSessions = new Map<string, Phase>();
  const childParents = new Map<string, string>();
  const coordinatorSessions = new Set<string>();
  // The tool hooks shadow the plugin input, so the workspace root is captured here.
  const workspace = input.directory;
  return {
    config: async config => { applyModelOverrides(config, profile); },
    'chat.message': async (input, output) => {
      if (MODEL_ROLES.includes(output.message.agent as Phase) && output.message.agent !== 'orchestrator') childSessions.set(input.sessionID, phaseName(output.message.agent));
      if (output.message.agent === 'mdd-orchestrator') coordinatorSessions.add(input.sessionID);
    },
    tool: {
      mdd_pr_body: tool({
        description: 'Draft only a PR body using the exact local skill/template and recorded current-run evidence. Never commits, pushes or publishes. Optional notes must quote whole lines of the actual latest user text; unknown facts remain unverified.',
        args: { userText: tool.schema.string().min(1), notes: tool.schema.object({ environmentVariables: tool.schema.string().optional(), followUps: tool.schema.string().optional(), deployment: tool.schema.string().optional() }).optional() },
        async execute(args, context) {
          if (context.agent !== 'mdd-orchestrator' || context.abort.aborted) throw new Error('Only the active coordinator may draft the current run.');
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
          if (context.abort.aborted) throw new Error('Change request was aborted.');
          return JSON.stringify(await intake.changeRequest(args, context, context.messageID));
        },
      }),
      mdd_contextual_explore: tool({
        description: 'Request one useful read-only investigation, with or without an accepted run. Use it for information-only questions instead of stopping. Never starts implementation and never changes the main route, answers or pending approval. Returns exact native task arguments through status.',
        args: { purpose: tool.schema.string().min(1) },
        async execute(args, context) {
          if (context.abort.aborted) throw new Error('Contextual exploration was aborted.');
          return JSON.stringify(await intake.explore(args, context));
        },
      }),
    },
    'tool.execute.before': async (input, output) => {
      const phase = childSessions.get(input.sessionID);
      if (phase) {
        try {
          await inspector.beforeChild(input, phase, input.tool, output.args, (parent, phase) => { childParents.set(input.sessionID, parent); return runner.pending(parent, phase); });
        } catch (error) {
          const parent = childParents.get(input.sessionID);
          if (parent) runner.block(parent, 'Child capability or invocation evidence was rejected.');
          throw error;
        }
        return;
      }
      if (input.tool === 'question') return intake.beforeQuestion(input, output.args);
      // The coordinator session never reaches beforeChild, so its only command capability is
      // gated here. Unrelated sessions stay untouched.
      if (input.tool === 'bash' && coordinatorSessions.has(input.sessionID)) {
        return assertGithubLookup(workspace, record(output.args));
      }
      if (input.tool !== 'task') return;
      intake.guardTask(input.sessionID);
      const args = await runner.before(input, output.args);
      if (args) Object.assign(output.args, args);
    },
    'tool.execute.after': async (input, output) => {
      if (childSessions.has(input.sessionID)) {
        try { inspector.afterChild(input, input.tool, input.args, output); }
        catch (error) { const parent = childParents.get(input.sessionID); if (parent) runner.block(parent, 'Child result evidence was rejected.'); throw error; }
        return;
      }
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
      // A refused or failed read yields no evidence and cannot mutate the workspace, so the
      // actor may simply try another path. Only tools that can have side effects, or whose
      // partial execution is unknowable, invalidate the dispatch.
      if (part.type === 'tool' && part.state.status === 'error' && !READ_TOOLS.includes(String(part.tool))) {
        const parent = childParents.get(part.sessionID);
        if (parent) runner.block(parent, 'A native child tool failed or was interrupted.');
      }
      if (part.type === 'tool' && part.tool === 'task' && part.state.status === 'error') {
        runner.nativeError(part.sessionID, part.callID);
      }
      if (part.type === 'tool' && part.tool === 'question' && part.state.status === 'error') intake.nativeError(part);
    },
  };
};

export default plugin;
