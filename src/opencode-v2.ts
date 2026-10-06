import { Model } from '@opencode/plugin';
import type { Plugin } from '@opencode/plugin';
import type { Plugin as LegacyPlugin, PluginInput } from '@opencode-ai/plugin';
import type { SessionMessageInfo, SessionInfo } from '@opencode/client';
import { z } from 'zod';
import { MODEL_ROLES, modelFor, freezeProfile } from './settings.js';
import { PHASES } from './policy.js';
import { loadGlobalSettings } from './global-settings.js';
import { collapsedPrompt, COLLAPSE_MIN_BYTES } from './dispatch-transcript.js';
import { DISPATCH_HANDLE_PREFIX } from './phase-runner.js';
import { SECURITY_AGENT, SECURITY_RUNTIME_GUARD } from './security-audit.js';
import type { SecurityRuntimeHooks } from './security-audit.js';

const COORDINATOR = 'mdd-orchestrator';
/** Every actor with a configurable model: the eight workflow phases plus `mdd-risk`. */
const MODEL_AGENTS = MODEL_ROLES.filter(role => role !== 'orchestrator');
/**
 * Actors pinned to the phase-actor tool profile: dispatch nothing further, read no skill by
 * name, and may call only `mdd_check_report`. `mdd-risk` gets the same profile as the eight
 * workflow phases even though nothing dispatches it yet in this increment, because when it is
 * dispatched it must already be unable to reach tools no phase actor can reach.
 */
const PINNED_AGENTS = Object.freeze([...PHASES, 'mdd-risk'] as const);
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unknown OpenCode V2 structure.');
  return value as ObjectValue;
}
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.some(item => object(item).type !== 'text' || typeof object(item).text !== 'string'))
    throw new Error('OpenCode V2 result is not complete text content.');
  return content.map(item => object(item).text).join('\n');
}
function taskInput(value: unknown): ObjectValue {
  const input = object(value);
  // A new foreground child is the only dispatch MDD authorizes. Never discard extra capabilities.
  if (Object.keys(input).length !== 3 || !['agent', 'description', 'prompt'].every(key => typeof input[key] === 'string'))
    throw new Error('MDD requires exactly agent, description and prompt for a foreground subagent.');
  return { subagent_type: input.agent, description: input.description, prompt: input.prompt };
}
function nativeTask(value: unknown): ObjectValue {
  const input = object(value);
  return { agent: input.subagent_type, description: input.description, prompt: input.prompt };
}
/** Only protocol fields change; user requirements and recorded artifacts are never rewritten. */
export function v2Payload(text: string): string {
  let value: ObjectValue;
  try { value = object(JSON.parse(text)); } catch { return text; }
  if (value.task) value.task = nativeTask(value.task);
  if (value.nextAction && object(value.nextAction).tool === 'task') {
    const next = object(value.nextAction);
    next.tool = 'subagent';
    if (next.args) next.args = nativeTask(next.args);
    next.why = 'Call the native subagent tool once, foreground, with exactly these three arguments. Pass the dispatch handle unchanged.';
  }
  return JSON.stringify(value);
}
function legacyTool(part: ObjectValue, sessionID: string, messageID: string): ObjectValue {
  const state = object(part.state);
  const metadata = state.metadata ? object(state.metadata) : {};
  const name = part.name === 'subagent' ? 'task' : part.name;
  const original = state.status === 'streaming' ? undefined : object(state.input);
  const input = name === 'task' && original ? (() => {
    const { agent, ...rest } = original;
    return { ...rest, subagent_type: agent };
  })() : state.input;
  let output: string | undefined;
  if (Array.isArray(state.content) && state.content.every(item => object(item).type === 'text')) {
    output = contentText(state.content);
    if (name === 'task' && state.status === 'completed') {
      const match = /^<subagent sessionID="([^"\r\n]+)" state="completed">\r?\n([\s\S]*?)\r?\n<\/subagent>$/.exec(output.trim());
      if (match) output = `<task id="${match[1]}" state="completed">\n<task_result>\n${match[2]}\n</task_result>\n</task>`;
    }
  }
  const time = part.time ? object(part.time) : {};
  return { type: 'tool', tool: name, callID: part.id, sessionID, messageID,
    state: { ...state, input, ...(output === undefined ? {} : { output }),
      metadata: { ...metadata, ...(typeof metadata.sessionID === 'string' ? { sessionId: metadata.sessionID } : {}) },
      time: { start: time.ran ?? time.created, end: time.completed } } };
}
/** Normalize native records for the motor, retaining authored/synthetic provenance and call identity. */
export function legacyHistory(messages: readonly SessionMessageInfo[], session: SessionInfo, worktree: string): ObjectValue[] {
  let directory = session.location.directory;
  const moved = messages.find(message => message.type === 'location-switched');
  if (moved?.type === 'location-switched' && moved.previous) directory = moved.previous.location.directory;
  let userID: string | undefined;
  const result: ObjectValue[] = [];
  for (const message of messages) {
    if (message.type === 'location-switched') {
      if (directory !== message.location.directory) { result.length = 0; userID = undefined; }
      directory = message.location.directory; continue;
    }
    if (!['user', 'assistant', 'synthetic', 'compaction'].includes(message.type)) continue;
    const native = message as unknown as ObjectValue;
    const role = message.type === 'assistant' ? 'assistant' : message.type === 'user' ? 'user' : 'system';
    const info = { ...native, id: message.id, sessionID: session.id, role,
      ...(message.type === 'assistant' ? { parentID: userID, path: { cwd: directory, root: worktree } } : {}),
      ...(message.type === 'compaction' ? { summary: true } : {}) };
    let parts: ObjectValue[];
    if (message.type === 'assistant') {
      parts = message.content.map(part => part.type === 'tool' ? legacyTool(part as unknown as ObjectValue, session.id, message.id)
        : { ...part, sessionID: session.id, messageID: message.id });
    } else if (message.type === 'compaction') parts = [{ type: 'compaction', sessionID: session.id, messageID: message.id }];
    else {
      parts = [{ type: 'text', text: native.text, sessionID: session.id, messageID: message.id,
        ...(message.type === 'synthetic' ? { synthetic: true } : {}) }];
      if (message.type === 'user') userID = message.id;
    }
    result.push({ info, parts });
  }
  return result;
}
function legacyResult(name: string, input: unknown, result: unknown): ObjectValue {
  const native = object(result);
  const output = contentText(native.content);
  if (name === 'subagent') {
    const structured = object(native.output);
    if (structured.status !== 'completed' || typeof structured.sessionID !== 'string' || typeof structured.output !== 'string' ||
      output.trim() !== `<subagent sessionID="${structured.sessionID}" state="completed">\n${structured.output}\n</subagent>`)
      throw new Error('MDD requires a completed foreground subagent result; background execution is not settled.');
    return { title: 'MDD phase', output: `<task id="${structured.sessionID}" state="completed">\n<task_result>\n${structured.output}\n</task_result>\n</task>`,
      metadata: { sessionId: structured.sessionID } };
  }
  const questions = object(input).questions;
  const answers = object(native.output).answers;
  if (!Array.isArray(questions) || !Array.isArray(answers)) throw new Error('Unknown native V2 question answers.');
  return { title: `Asked ${questions.length} question${questions.length > 1 ? 's' : ''}`, output,
    metadata: { answers, truncated: false } };
}

export async function setupV2(ctx: Plugin.Context, createMotor: LegacyPlugin): Promise<Plugin.Cleanup> {
  const directory = ctx.location.directory;
  const worktree = ctx.location.project.directory;
  const statuses = new Map<string, { type: string }>();
  const seen = new Set<string>();
  const controller = new AbortController();
  const history = async (id: string, signal?: AbortSignal) => {
    const options = signal ? { signal } : undefined;
    const session = await ctx.session.get({ sessionID: id }, options);
    const messages = await ctx.session.context({ sessionID: id }, options);
    if (session.location.directory !== directory || session.projectID !== ctx.location.project.id)
      throw new Error('Native session moved outside this MDD location.');
    return legacyHistory(messages, session, worktree);
  };
  // A small protocol adapter, not an HTTP client: calls stay on this exact host (including remote/standalone servers).
  const input = {
    directory, worktree, project: { id: ctx.location.project.id },
    client: { session: {
      get: async (options: { path: { id: string }; signal: AbortSignal }) => {
        seen.add(options.path.id);
        const session = await ctx.session.get({ sessionID: options.path.id }, { signal: options.signal });
        return { data: { ...session, directory: session.location.directory } };
      },
      messages: async (options: { path: { id: string }; query: { limit: number }; signal: AbortSignal }) =>
        ({ data: (await history(options.path.id, options.signal)).slice(-options.query.limit) }),
      message: async (options: { path: { id: string; messageID: string }; signal: AbortSignal }) => {
        const matches = (await history(options.path.id, options.signal)).filter(message => object(message.info).id === options.path.messageID);
        if (matches.length !== 1) throw new Error('Exact native message is unavailable in the V2 context.');
        return { data: matches[0] };
      },
      status: async () => ({ data: Object.fromEntries([...seen].map(id => [id, statuses.get(id) ?? { type: 'unknown' }])) }),
      abort: async (options: { path: { id: string }; signal: AbortSignal }) => {
        await ctx.session.interrupt({ sessionID: options.path.id, resume: false }, { signal: options.signal });
        return { data: true };
      },
    } },
  } as unknown as PluginInput;
  const hooks = await createMotor(input);
  const securityGuard = (hooks as SecurityRuntimeHooks)[SECURITY_RUNTIME_GUARD];
  const enforceSecurity = async (sessionID: string, name: string, args: unknown, agent: string): Promise<boolean> => {
    if (!securityGuard) {
      if (agent === SECURITY_AGENT) throw new Error('Security runtime provenance guard is unavailable.');
      return false;
    }
    const bound = await securityGuard(sessionID, name, args, agent);
    if (bound && agent !== SECURITY_AGENT) throw new Error('Security native actor attribution differs.');
    return bound;
  };
  const profile = freezeProfile(loadGlobalSettings());
  const agentPolicy: Parameters<typeof ctx.agent.transform>[0] = editor => {
    for (const agent of editor.list()) editor.update(String(agent.id), draft => {
      const id = String(draft.id);
      const role = id === COORDINATOR ? 'orchestrator' : MODEL_AGENTS.includes(id as typeof MODEL_AGENTS[number]) ? id as typeof MODEL_AGENTS[number] : undefined;
      const selected = role ? modelFor(profile, role) : undefined;
      if (selected) draft.model = Model.Ref.parse(selected);
      if (id === SECURITY_AGENT) draft.permissions.push(
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'mdd_check_report', resource: '*', effect: 'allow' });
      if (id !== COORDINATOR && id !== SECURITY_AGENT) draft.permissions.push({ action: 'mdd_*', resource: '*', effect: 'deny' });
      if (PINNED_AGENTS.includes(id as typeof PINNED_AGENTS[number])) draft.permissions.push(
        { action: 'subagent', resource: '*', effect: 'deny' }, { action: 'skill', resource: '*', effect: 'deny' },
        { action: 'mdd_check_report', resource: '*', effect: 'allow' });
    });
  };
  let agentRegistration = await ctx.agent.transform(agentPolicy);
  let settledPolicy: Promise<void> | undefined;
  // File-backed agents are contributed by a later built-in plugin. Re-register once after
  // startup batching, and await the same boundary before any coordinator operation can dispatch.
  const settleAgentPolicy = () => settledPolicy ??= (async () => {
    await agentRegistration.dispose();
    agentRegistration = await ctx.agent.transform(agentPolicy);
  })();
  await ctx.tool.transform(editor => {
    for (const [name, definition] of Object.entries(hooks.tool ?? {})) editor.add({
      name, description: definition.description, input: z.object(definition.args), options: { codemode: false },
      async execute(args, context) {
        await enforceSecurity(context.sessionID, name, args, context.agent);
        await settleAgentPolicy();
        const session = await ctx.session.get({ sessionID: context.sessionID }, { signal: context.signal });
        if (session.location.directory !== directory || session.projectID !== ctx.location.project.id)
          throw new Error('Native MDD tool context differs from its plugin location.');
        const output = await definition.execute(args, { ...context, callID: context.id, abort: context.signal, directory, worktree } as never);
        return { content: v2Payload(typeof output === 'string' ? output : output.output) };
      },
    });
  });
  await ctx.tool.hook('execute.before', async event => {
    const call = { sessionID: event.sessionID, callID: event.id, tool: event.tool === 'subagent' ? 'task' : event.tool };
    await enforceSecurity(event.sessionID, call.tool, event.input, event.agent);
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (session.location.directory !== directory || session.projectID !== ctx.location.project.id) {
      if (event.agent === SECURITY_AGENT || session.agent === SECURITY_AGENT) throw new Error('Security session left its bound workspace.');
      return;
    }
    if (event.agent === SECURITY_AGENT || session.agent === SECURITY_AGENT) {
      if (event.agent !== SECURITY_AGENT || session.agent !== SECURITY_AGENT) throw new Error('Security native actor attribution differs.');
    }
    if (session.parentID) await hooks.event?.({ event: { type: 'session.created', properties: { info: session } } } as never);
    if (event.tool === 'subagent' && event.agent === COORDINATOR) {
      const args = taskInput(event.input);
      await hooks['tool.execute.before']?.(call, { args });
      event.input = nativeTask(args);
    } else await hooks['tool.execute.before']?.(call, { args: event.input });
  });
  await ctx.tool.hook('execute.after', async event => {
    if (!['subagent', 'question'].includes(event.tool)) return;
    const session = await ctx.session.get({ sessionID: event.sessionID });
    if (session.location.directory !== directory || session.projectID !== ctx.location.project.id) return;
    const call = { sessionID: event.sessionID, callID: event.id, tool: event.tool === 'subagent' ? 'task' : event.tool };
    if (event.status === 'error') {
      await hooks.event?.({ event: { type: 'message.part.updated', properties: { part: {
        type: 'tool', tool: call.tool, sessionID: call.sessionID, callID: call.callID, state: { status: 'error' },
      } } } } as never);
      return;
    }
    if (event.tool === 'subagent' && event.agent !== COORDINATOR) return;
    const audit = event.tool === 'subagent' && object(event.input).agent === SECURITY_AGENT;
    let result: ObjectValue;
    try { result = legacyResult(event.tool, event.input, event.result); }
    catch (error) { if (!audit) throw error; result = {}; }
    await hooks['tool.execute.after']?.({ ...call, args: event.tool === 'subagent' ? taskInput(event.input) : event.input }, result as never);
    if (audit || result.title === 'MDD security assessment') event.result = { content: String(result.output), output: { status: 'completed', output: String(result.output) } };
  });
  const stream = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.location && event.location.directory !== directory) continue;
        if (event.type === 'agent.updated') await settleAgentPolicy();
        if (event.type === 'session.status') statuses.set(event.data.sessionID, event.data.status);
        if (event.type === 'session.created') await hooks.event?.({ event: { type: 'session.created', properties: {
          info: { ...event.data, id: event.data.sessionID },
        } } } as never);
        if (event.type === 'session.compaction.ended') await hooks.event?.({ event: {
          type: 'session.compacted', properties: { sessionID: event.data.sessionID },
        } } as never);
        if (event.type === 'session.tool.failed') {
          const message = (await history(event.data.sessionID)).find(message => object(message.info).id === event.data.assistantMessageID);
          const parts = message?.parts;
          const part = Array.isArray(parts) ? parts.find(part => object(part).callID === event.data.id) : undefined;
          if (part) await hooks.event?.({ event: { type: 'message.part.updated', properties: { part } } } as never);
        }
      }
    } catch (error) { if (!controller.signal.aborted) console.error('MDD native event stream ended:', error); }
    finally { statuses.clear(); }
  })();
  // V2 supplies model messages, not durable parts. Only settled tool calls with matching results are collapsed.
  await ctx.session.hook('context', async event => {
    if (!event.sessionID && event.agent === SECURITY_AGENT) throw new Error('Security context has no native session identity.');
    if (event.sessionID && await enforceSecurity(event.sessionID, 'mdd_check_report', { phase: SECURITY_AGENT, result: '' }, event.agent)) {
      event.tools = Object.fromEntries(Object.entries(event.tools).filter(([name]) => name === 'mdd_check_report'));
      return;
    }
    if (event.agent !== COORDINATOR) return;
    const results = new Set(event.messages.flatMap(message => message.content.flatMap(part => part.type === 'tool-result' ? [part.id] : [])));
    event.messages = event.messages.map(message => {
      if (message.role !== 'assistant') return message;
      return { ...message, content: message.content.map(part => {
        if (part.type !== 'tool-call' || part.name !== 'subagent' || !results.has(part.id)) return part;
        const args = object(part.input);
        if (typeof args.prompt !== 'string' || typeof args.agent !== 'string' || !PHASES.includes(args.agent as typeof PHASES[number]) ||
          args.prompt.startsWith(DISPATCH_HANDLE_PREFIX) || Buffer.byteLength(args.prompt) <= COLLAPSE_MIN_BYTES) return part;
        return { ...part, input: { ...args, prompt: collapsedPrompt(args.agent, Buffer.byteLength(args.prompt)) } };
      }) };
    });
  });
  return async () => {
    controller.abort();
    await stream;
    await agentRegistration.dispose();
    seen.clear();
    await hooks.event?.({ event: { type: 'server.instance.disposed', properties: { directory } } } as never);
  };
}
