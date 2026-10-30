import { tool } from '@opencode-ai/plugin';
import type { Plugin, PluginInput } from '@opencode-ai/plugin';
import { Plugin as V2Plugin } from '@opencode/plugin';
import { setupV2 } from './opencode-v2.js';
import { isDeepStrictEqual } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { ACTOR_INSTRUCTIONS_MARKER, boundedText, DISPATCH_HANDLE_PREFIX, movedMessage, nonemptyText, PhaseRunner } from './phase-runner.js';
import { FREE_ADAPT_ROLE, STRICT_ADAPT_ROLE, STRICT_COORDINATOR } from './guards.js';
import type { Inspect, Liveness, Runtime, TaskCall } from './phase-runner.js';
import { DEFAULT_AUTOMATIC_CORRECTIONS, freeMode, freezeProfile, setupDiagnostic } from './settings.js';
import { loadGlobalSettings } from './global-settings.js';
import { installationPaths } from './installation-paths.js';
import { applyModelOverrides } from './native-models.js';
import { NativeIntake } from './native-intake.js';
import { SessionPreferenceStore } from './session-preferences.js';
import type { IntakeInspect } from './native-intake.js';
import { recordTelemetry } from './telemetry.js';
import type { TelemetryUsage } from './telemetry.js';
import { ProgressGuard } from './progress.js';
import { RunDossierStore } from './run-dossier.js';
import { assessTransfer, projectTargetTransfer } from './transfer.js';
import { CheckpointStore, STABLE_CHECKPOINT_VERSION } from './checkpoint.js';
import { QuestionCheckpointStore } from './question-checkpoint.js';
import { RunOwnershipStore } from './run-ownership.js';
import { directPRRequest, prBodyRequest, renderDirectPRBody, renderPRBody } from './pr-body.js';
import { directChanges } from './pr-direct.js';
import { PR_TRANSLATION_LIMIT, TranslationError } from './pr-translation.js';
import { mddDataRoot } from './engram-http.js';
import { AdaptiveStore } from './adaptive-store.js';
import { adaptiveTransferRequest } from './adaptive-transfer.js';
import { completeAdaptiveEntry, decodeAdaptiveRequest } from './adaptive-protocol.js';
import { statusPayload } from './status-budget.js';
import type { StatusView } from './status-budget.js';
import { phaseName } from './phase-assets.js';
import { recordLessonQuietly } from './lessons.js';
import { recordRunQuietly } from './run-ledger.js';
import { workspaceRuns } from './workspace-runs.js';
import { withNextAction } from './next-action.js';
import { collapseDispatchPrompts } from './dispatch-transcript.js';
import { collapseSupersededStatus } from './status-transcript.js';
import { checkReportForm, checkRiskReportForm, checkSecurityReportForm } from './report-check.js';
import type { HeldReportContext } from './report-check.js';
import { SecurityAudit, SECURITY_AGENT, SECURITY_HANDLE_PREFIX, SECURITY_RUNTIME_GUARD } from './security-audit.js';
import type { SecurityInspect, SecurityBinding } from './security-audit.js';
import { CHANGE_CATEGORIES, decodeConcerns } from './concerns.js';
import { authoredNativeText, canonicalNativeText, firstDivergence } from './native-text.js';
import type { Phase } from './policy.js';
import { recordSession } from './session-log.js';
import { staleAssets } from './project-assets.js';
import { visualTitle, presentationSettings } from './visual-ux.js';
import { JD_JUDGES, JD_FIX, JD_INSPECT, isJudge, isJudgmentActor, judgmentTask, inspectJudgmentTarget } from './judgment-day.js';

/**
 * Every MDD tool answers through here, so the derived next call and the payload budget are
 * applied in one place rather than remembered at eight call sites.
 */
function payload(value: unknown, assets?: Record<string, unknown>, view: StatusView = 'compact'): string {
  const status = value && typeof value === 'object' && !Array.isArray(value) && assets ? { ...value, assets } : value;
  return statusPayload(withNextAction(status), view);
}

function record(value: unknown, subject = 'response'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Unknown OpenCode ${subject} structure.`);
  return value as Record<string, unknown>;
}

/**
 * The completed-task envelope the host wraps around a subagent's final message. It is matched
 * leniently on purpose: the optional `<summary>` line and trailing whitespace are host-side
 * variations that say nothing about whether the phase did its work, and rejecting the envelope
 * discards a finished phase without ever reading it. Only the shape that identifies a completed
 * task is required; the body is validated separately, where a real problem can be reported.
 */
export const TASK_ENVELOPE = /^<task id="[^"\r\n]*" state="completed">\r?\n(?:<summary>[^\r\n]*<\/summary>\r?\n)?<task_result>\r?\n([\s\S]*?)\r?\n?<\/task_result>\r?\n?<\/task>$/;

/** One advisory concern as the change-request tool advertises it to the model. */
const CONCERN_SCHEMA = tool.schema.object({
  category: tool.schema.enum(CHANGE_CATEGORIES as unknown as [string, ...string[]]),
  evidence: tool.schema.string(),
  impact: tool.schema.string(),
});

/** MDD tools belong to the MDD coordinator. Other agents share the registry but not this state. */
export const MDD_TOOLS = ['mdd_adapt', 'mdd_security', 'mdd_status', 'mdd_reset', 'mdd_contextual_explore', 'mdd_pr_body', 'mdd_improve', 'mdd_improvements', 'mdd_knowledge', 'mdd_knowledge_record'] as const;
/**
 * The one MDD tool that is not the coordinator's alone. It is kept out of `MDD_TOOLS` because
 * that list is what `restrictTools` switches off everywhere else, and this one has to reach the
 * phase actors. It carries no authority to compensate: it reads no run, writes nothing, and
 * answers a question about a document it is handed.
 */
export const CHECK_TOOL = 'mdd_check_report';
export const ARTIFACT_READ_TOOL = 'mdd_artifact_read';
export const COORDINATOR = 'mdd-orchestrator';
/** Translation attempts a single conversation gets per PR body before drafting refuses outright. */
export const PR_TRANSLATION_ATTEMPTS = 3;
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
    if (!isJudge(name)) tools[JD_INSPECT] = false;
    agent.tools = tools;
  }
}

/** Judges get one deliberate exception to MDD isolation, never a phase report/tool profile. */
export function pinJudgmentAgents(config: { agent?: Record<string, Record<string, unknown>> }): void {
  config.agent ??= {};
  for (const name of JD_JUDGES) config.agent[name] = { ...config.agent[name],
    permission: { '*': 'deny', [JD_INSPECT]: 'allow' }, tools: { '*': false, [JD_INSPECT]: true } };
}

/** Only these eight actors belong to workflow dispatch; standalone actors never enter this list. */
export const PHASE_AGENTS: readonly string[] = Object.freeze([
  'mdd-explore', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify',
]);
/**
 * The risk actor. It is not one of `PHASE_AGENTS`: it occupies no stop on the route, but the runner
 * dispatches it after a passed exploration, it shares the phase actors' restricted tool profile
 * and it may submit its report through the same form check.
 */
export const RISK_AGENT = 'mdd-risk';
/** Every actor the runner dispatches: its settled prompts are collapsed and its tasks titled. */
const DISPATCHED_AGENTS: readonly string[] = Object.freeze([...PHASE_AGENTS, RISK_AGENT]);
/** Agents allowed to call `mdd_check_report`: the eight phase actors and the risk actor. */
export const CHECK_AGENTS: readonly string[] = Object.freeze([...PHASE_AGENTS, RISK_AGENT, SECURITY_AGENT]);
/** Agents pinned to the restricted tool profile below: the eight phase actors and the risk actor. */
const PINNED_AGENTS: readonly string[] = Object.freeze([...PHASE_AGENTS, RISK_AGENT]);

/**
 * Closes the other direction. `restrictTools` keeps MDD's tools out of agents that are not MDD's;
 * this keeps agents that are not MDD's out of MDD. A phase actor runs in a shared registry full
 * of other people's agents and skills, and the only thing that used to stop it from reaching for
 * them was a sentence in its prompt asking it not to.
 *
 * `task` goes because a phase actor is the actor: it carries the phase out itself, and anything
 * it delegated would run under instructions MDD never composed. `skill` goes because a phase that
 * wants an applicable packaged skill already has its direct path in the prompt; a name lookup
 * against the shared registry can only find something else. The coordinator keeps both: it
 * dispatches phases, and its own work is not a phase. `mdd-risk` gets the same restricted profile,
 * so dispatching it adds no capability a phase actor does not already have.
 */
export function pinPhaseAgents(config: { agent?: Record<string, Record<string, unknown>> }, free = false): void {
  config.agent ??= {};
  config.agent[SECURITY_AGENT] = { ...config.agent[SECURITY_AGENT],
    permission: { '*': 'deny', [CHECK_TOOL]: 'allow' }, tools: { '*': false, [CHECK_TOOL]: true } };
  for (const name of PINNED_AGENTS) {
    const agent = { ...config.agent[name] };
    // The report checker and execution-bound reader are narrow exceptions after the
    // blanket `mdd_*: false` that `restrictTools` writes, so the explicit entry is what grants
    // it. The checker reads nothing and records nothing; it only tells the actor whether the document it
    // is about to return can be read. That question has to be answerable here, because the
    // session that can still fix the document is gone by the time MDD validates it.
    // With guards off a phase actor keeps delegation and skills like any other agent.
    agent.tools = { ...(agent.tools as Record<string, boolean> | undefined), ...(free ? {} : { task: false, skill: false }),
      [CHECK_TOOL]: true, [ARTIFACT_READ_TOOL]: true };
    config.agent[name] = agent;
  }
  for (const name of ['general', 'explore']) config.agent[name] = { ...config.agent[name],
    tools: { ...(config.agent[name]?.tools as Record<string, boolean> | undefined), [ARTIFACT_READ_TOOL]: true } };
}

/**
 * The coordinator definition on disk is the free one. With guards on, its strict rules are
 * appended here, where the host composes the agent. A coordinator the host did not load from its
 * definition has no prompt to extend and is left as it is.
 */
export function strictCoordinator(config: { agent?: Record<string, Record<string, unknown>> }): void {
  const agent = config.agent?.[COORDINATOR];
  if (agent && typeof agent.prompt === 'string' && !agent.prompt.includes(STRICT_COORDINATOR.trim()))
    config.agent![COORDINATOR] = { ...agent, prompt: agent.prompt + STRICT_COORDINATOR };
}

/**
 * With guards off, the tasks MDD routes through its bookkeeping are only the ones it issued: a
 * dispatch handle (or the transcript note standing in for one), or a full prompt MDD composed,
 * which always carries its by-value actor instructions. Everything else the coordinator wrote.
 */
export function mddIssuedTask(args: unknown): boolean {
  const prompt = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>).prompt : undefined;
  return typeof prompt === 'string' && (prompt.startsWith(DISPATCH_HANDLE_PREFIX) || prompt.includes(ACTOR_INSTRUCTIONS_MARKER));
}

/**
 * Inspection bounds are per subject. HISTORY_MAX is the tail page that correlates the current
 * caller, never a ceiling on the conversation: proofs that span the conversation read all of it
 * (`conversation` in the inspector). Agent registries and resolved permission rulesets scale with
 * the user's installed skills and agents, so a history-sized cap would reject real installations.
 */
export const HISTORY_MAX = 100;
export const AGENTS_MAX = 2000;
export const PERMISSION_MAX = 4000;
export const PARTS_MAX = 1000;
/**
 * A delegated phase is read for its cost, not its content, so this window is about holding a
 * whole actor conversation rather than the tail that identifies a caller.
 */
export const USAGE_MAX = 1000;

/** A reported count, or zero. Anything unreported is flagged by the caller, never invented. */
function metric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function list(value: unknown, subject: string, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`Unknown OpenCode ${subject} structure.`);
  if (value.length > max) throw new Error(`OpenCode ${subject} exceeds the ${max} entry inspection limit.`);
  return value.map(item => record(item, `${subject} entry`));
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

/**
 * How long an idle subagent must have been silent before a task the host still marks running is
 * treated as orphaned. A working child is reported busy for its whole loop — through long commands
 * and permission prompts alike — so this only guards the instant between a dispatch and the loop
 * starting. The user can always release sooner by saying the subagent stopped.
 */
export const ORPHAN_QUIET_MS = 2 * 60_000;

export function createInspector(input: PluginInput, timeout = 5000, now: () => number = Date.now) {
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 5000) throw new Error('Invalid inspection timeout.');
  const session = async (id: string, directory: string) => {
    const response = await readSdk(signal => input.client.session.get({
      path: { id }, query: { directory }, signal, throwOnError: true,
    }), timeout);
    return record(response.data);
  };
  /**
   * The tail page. A full page means the conversation is longer than one page, not that this read
   * failed. Reading the last message of a child only ever needs the tail, so a full page is
   * returned as it is: failing there used to make every MDD tool stop working once a real run had
   * produced a hundred messages, which is an ordinary length for a completed route.
   */
  const messages = async (id: string, directory: string) => {
    const response = await readSdk(signal => input.client.session.messages({
      path: { id }, query: { directory, limit: HISTORY_MAX }, signal, throwOnError: true,
    }), timeout);
    return list(response.data, 'message history', HISTORY_MAX);
  };
  /**
   * The whole readable conversation, for every proof about it: who the user is, which call is
   * being answered, and whether anything is still running. Those proofs used to read the tail page
   * and refuse once it was full, so a conversation past a hundred messages — a few routes' worth —
   * could never prove itself idle again, nor start, transfer or retire another run in it. The host
   * already holds this history; reading all of it is the only way to prove something about all of
   * it. A page that is not full already is the whole conversation, so short ones cost one read.
   */
  const conversation = async (id: string, directory: string) => {
    const tail = await messages(id, directory);
    if (tail.length < HISTORY_MAX) return tail;
    const response = await readSdk(signal => input.client.session.messages({
      path: { id }, query: { directory }, signal, throwOnError: true,
    }), timeout);
    return list(response.data, 'message history', Number.POSITIVE_INFINITY);
  };
  /** The installed SDK exposes GET /session/{id}/message/{messageID}; no tail scan proves an older ID. */
  const exactMessage = async (sessionID: string, messageID: string, directory: string) => {
    try {
      const response = await readSdk(signal => input.client.session.message({
        path: { id: sessionID, messageID }, query: { directory }, signal, throwOnError: true,
      }), timeout);
      const message = record(response.data, 'exact native message');
      const info = record(message.info, 'exact native message info');
      if (info.id !== messageID || info.sessionID !== sessionID) throw new Error('Exact native message identity changed.');
      list(message.parts, 'exact message parts', PARTS_MAX);
      return message;
    } catch { throw new Error('Exact native message lookup is unavailable or malformed. Do not infer the transfer outcome; inspect the native session.'); }
  };
  /**
   * What OpenCode can say about the child of one dispatched task. A child is stopped when it
   * finished its last message and the host reports it idle — or, for a task the host left marked
   * running, when the host has no live loop for the child and it has been silent for a while. That
   * second case is what an interrupted or restarted OpenCode leaves behind: the task part and the
   * child's last message are frozen mid-flight because the process that would have closed them is
   * gone, so waiting for them to close is waiting forever. A child the host reports busy is never
   * stopped, whatever its history looks like.
   */
  const liveness = async (runtime: Runtime, call: { callID: string }, returned?: unknown): Promise<Liveness> => {
    const workerHost = (input as PluginInput & { workerHost?: import('./worker-fence.js').WorkerHost }).workerHost;
    const completed = workerHost?.fence.completedChild(call.callID);
    if (completed && returned !== undefined) {
      const output = record(returned, 'bound worker completion');
      if (record(output.metadata, 'bound worker metadata').sessionId === completed &&
          typeof output.output === 'string' && output.output.startsWith(`<task id="${completed}" state="completed">`) && TASK_ENVELOPE.test(output.output.trim()))
        return { verdict: 'stopped', child: completed, detail: 'The exact progress-bound native child returned its completed foreground result.' };
    }
    const history = await conversation(runtime.sessionID, runtime.directory);
    const matches = history.flatMap(message => list(message.parts, 'message parts', PARTS_MAX))
      .filter(part => part.type === 'tool' && part.tool === 'task' && part.callID === call.callID);
    if (matches.length !== 1) return { verdict: 'unknown', detail: 'The dispatched task is not uniquely visible in the readable parent history.' };
    const state = record(matches[0]!.state, 'task state');
    if (state.status === 'completed' && typeof state.output === 'string' && TASK_ENVELOPE.test(state.output.trim())) return { verdict: 'stopped', detail: 'The task returned its completed result.' };
    const metadata = state.metadata === undefined ? {} : record(state.metadata, 'task metadata');
    const child = typeof metadata.sessionId === 'string' ? metadata.sessionId : undefined;
    if (!child) return { verdict: 'unknown', detail: 'OpenCode recorded no subagent session for this task, so its state cannot be read.' };
    const info = await session(child, runtime.directory);
    if (info.parentID !== runtime.sessionID) return { verdict: 'unknown', detail: 'The recorded subagent session does not belong to this conversation.' };
    const statuses = await readSdk(signal => input.client.session.status({ query: { directory: runtime.directory }, signal, throwOnError: true }), timeout);
    const current = record(statuses.data, 'session statuses')[child];
    const hostState = current === undefined ? 'idle' : String(record(current, 'child status').type);
    if (hostState === 'unknown') return { verdict: 'unknown', child, detail: 'OpenCode has not confirmed the current native child status.' };
    if (hostState !== 'idle') return { verdict: 'running', child, detail: `OpenCode reports subagent session ${child} as ${hostState}.` };
    const last = (await messages(child, runtime.directory)).at(-1);
    const lastInfo = last ? record(last.info, 'child message') : undefined;
    const terminal = !!last && lastInfo!.role === 'assistant' && !!record(lastInfo!.time ?? {}, 'child time').completed &&
      (!!lastInfo!.error || (typeof lastInfo!.finish === 'string' && !['tool-calls', 'unknown'].includes(lastInfo!.finish))) &&
      !list(last.parts, 'child message parts', PARTS_MAX).some(part => part.type === 'tool' && ['pending', 'running'].includes(String(record(part.state, 'child tool state').status)));
    const settled = state.status === 'error' || state.status === 'completed' || returned !== undefined;
    if (terminal && settled) return { verdict: 'stopped', child, detail: `Subagent session ${child} finished its last message and OpenCode reports it idle.` };
    const updated = record(info.time ?? {}, 'child session time').updated;
    const quiet = typeof updated === 'number' ? now() - updated : undefined;
    if (quiet !== undefined && quiet >= ORPHAN_QUIET_MS) {
      return { verdict: 'stopped', child, detail: `OpenCode has no live loop for subagent session ${child} and it has been silent for ${Math.floor(quiet / 60000)} min: it was interrupted or the process running it ended.` };
    }
    return { verdict: 'unknown', child, detail: `OpenCode reports subagent session ${child} idle, but its last activity is too recent to prove it stopped.` };
  };
  const checkWorkspace = (runtime: Runtime) => {
    if (runtime.directory !== input.directory || runtime.worktree !== input.worktree) {
      throw new Error('Runtime workspace differs from the project plugin instance.');
    }
  };
  /**
   * Collects the setup-only starts a history actually proves, keyed by the native user message
   * each one came from. A tool that is not such a start is skipped, because ordinary work is not
   * a fault; a history that cannot be read at all throws, and the caller reports no recovery.
   */
  const setupOnlyStarts = (history: Record<string, unknown>[], runtime: Runtime) => {
    const candidates = new Map<string, { requirements: string; userMessageID: string }>();
    if (history.some(message => record(message.info, 'message').summary === true || list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'compaction'))) throw new Error('Compacted history proves no pending setup.');
    const identities = new Set<string>();
    const calls = new Set<string>();
    for (const message of history) {
      const info = record(message.info, 'message');
      const id = boundedText(info.id, 'history message ID', 256);
      if (identities.has(id) || info.sessionID !== runtime.sessionID || !['user', 'assistant'].includes(String(info.role))) throw new Error('Incomplete or ambiguous native history.');
      identities.add(id);
      if (info.role === 'assistant') {
        const path = record(info.path, 'message path');
        if (info.agent !== 'mdd-orchestrator' || info.error != null || path.cwd !== runtime.directory || path.root !== runtime.worktree) throw new Error('Native workspace or caller changed.');
      }
      for (const part of list(message.parts, 'message parts', PARTS_MAX)) {
        if (!['text', 'reasoning', 'step-start', 'step-finish', 'tool', 'file'].includes(String(part.type))) throw new Error('Unknown history part.');
        if (part.type !== 'tool') continue;
        const callID = boundedText(part.callID, 'historical call ID', 256);
        if (calls.has(callID)) throw new Error('Ambiguous tool call.');
        calls.add(callID);
        if (info.role !== 'assistant' || part.sessionID !== runtime.sessionID || part.messageID !== id) throw new Error('Tool ownership mismatch.');
        const state = record(part.state, 'tool state');
        // A dispatched phase, a reported one or a reset all prove this conversation got past
        // setup, so whatever it was once stuck on is no longer pending. That is not a fault
        // either: there is simply nothing to recover, and holding the coordinator to a stale
        // objective would be worse than offering none.
        if (['task', 'mdd_phase_result', 'mdd_reset'].includes(String(part.tool))) return new Map();
        // An ordinary tool, a start that errored and the current invocation are all just history.
        if (part.tool !== 'mdd_start' || state.status !== 'completed' || typeof state.output !== 'string') continue;
        const time = record(state.time, 'tool time');
        if (!Number.isFinite(time.start) || !Number.isFinite(time.end) || Number(time.end) < Number(time.start) || time.compacted !== undefined) throw new Error('Incomplete or compacted tool result.');
        let output: Record<string, unknown>;
        try { output = record(JSON.parse(boundedText(state.output, 'setup-only output', 96000))); } catch { throw new Error('Unknown start output.'); }
        // A start that reached preflight or a run is a start that worked, which also settles that
        // nothing here is still waiting on setup. Only the setup-only shape carries an objective
        // nobody has been able to act on yet.
        if (output.setupOrigin === undefined && output.pendingStart === undefined && output.setup === undefined) return new Map();
        const origin = record(output.setupOrigin, 'setup origin');
        const start = record(output.pendingStart, 'pending start');
        const setup = record(output.setup, 'setup report');
        const preceding = history.slice(0, history.indexOf(message));
        const latestUser = preceding.findLast(item => record(item.info, 'message').role === 'user');
        const user = preceding.find(item => record(item.info, 'message').role === 'user' && record(item.info, 'message').id === origin.userMessageID);
        if (!user || !latestUser) throw new Error('Missing original native user.');
        const userInfo = record(user.info, 'message');
        const prior = candidates.get(String(userInfo.id));
        const text = list(user.parts, 'message parts', PARTS_MAX).filter(item => item.type === 'text');
        if (output.state !== 'blocked' || output.task !== undefined || output.question !== undefined || !Array.isArray(output.questionReceipts) || output.questionReceipts.length ||
            !['missing-file', 'missing-engram'].includes(String(setup.problem)) || setup.workspaceRoot !== runtime.directory ||
            origin.projectID !== input.project.id || origin.directory !== runtime.directory || origin.worktree !== runtime.worktree || info.parentID !== record(latestUser.info, 'message').id ||
            (user !== latestUser && prior?.requirements !== start.requirements) ||
            !text.length || text.some(item => item.synthetic === true || item.ignored === true || item.sessionID !== runtime.sessionID || item.messageID !== userInfo.id || typeof item.text !== 'string') ||
            text.map(item => item.text).join('\n') !== start.requirements || !isDeepStrictEqual(state.input, start)) throw new Error('Original objective lacks correlated setup-only proof.');
        const requirements = nonemptyText(start.requirements, 'original requirements');
        candidates.set(String(userInfo.id), { requirements, userMessageID: String(userInfo.id) });
      }
    }
    return candidates;
  };
  const securityTaskPart = async (binding: SecurityBinding, call: { callID: string }, childID?: string) => {
    await inspector.parent(binding.runtime);
    const history = await conversation(binding.runtime.sessionID, binding.runtime.directory);
    const latestUser = history.findLast(message => record(message.info).role === 'user');
    if (!latestUser || record(latestUser.info).id !== binding.userMessageID ||
        authoredNativeText(list(latestUser.parts, 'user parts', PARTS_MAX).filter(part => part.type === 'text'), binding.runtime.sessionID, binding.userMessageID) !== binding.userText)
      throw new Error('Security request is stale or changed.');
    const matches = history.flatMap(message => list(message.parts, 'task parts', PARTS_MAX)
      .filter(part => part.type === 'tool' && part.tool === 'task' && part.callID === call.callID)
      .map(part => ({ part, info: record(message.info) })));
    if (matches.length !== 1) throw new Error('Security task identity is ambiguous.');
    const { part, info } = matches[0]!;
    const location = record(info.path);
    const state = record(part.state);
    if (info.role !== 'assistant' || info.agent !== COORDINATOR || info.sessionID !== binding.runtime.sessionID ||
        part.sessionID !== binding.runtime.sessionID || part.messageID !== info.id ||
        location.cwd !== binding.runtime.directory || location.root !== binding.runtime.worktree ||
        !['running', 'completed'].includes(String(state.status)) ||
        (!isDeepStrictEqual(state.input, binding.task) && !isDeepStrictEqual(state.input, binding.full)))
      throw new Error('Security task native caller or arguments differ.');
    if (!childID && record(history.at(-1)!.info).id !== info.id) throw new Error('Security dispatch is not the current native call.');
    if (childID && record(state.metadata ?? {}).sessionId !== childID) throw new Error('Security child does not belong to the exact native task.');
    return state;
  };
  const inspector: Inspect & IntakeInspect & SecurityInspect & {
    nativeActor(sessionID: string, liveAgent?: string): Promise<{ agent: string; session: Record<string, unknown> }>;
    judgeInspection(runtime: Runtime & { messageID: string }, args: unknown): Promise<void>;
  } = {
    async artifactCaller(runtime, args) {
      checkWorkspace(runtime);
      if (!runtime.messageID && !runtime.callID) throw new Error('Retained artifact read needs a native invocation identity.');
      const child = await session(runtime.sessionID, runtime.directory);
      const history = await messages(runtime.sessionID, runtime.directory);
      const latest = history.at(-1);
      const info = record(latest?.info, 'artifact reader caller');
      const location = record(info.path, 'artifact reader location');
      const reads = list(latest?.parts, 'artifact reader parts', PARTS_MAX).filter(part =>
        part.type === 'tool' && part.tool === ARTIFACT_READ_TOOL && record(part.state).status === 'running' &&
        (runtime.callID ? part.callID === runtime.callID : isDeepStrictEqual(record(part.state).input, args)));
      const read = reads[0];
      if (child.id !== runtime.sessionID || typeof child.parentID !== 'string' || child.parentID === child.id ||
          child.directory !== runtime.directory || child.projectID !== input.project.id ||
          (child.agent !== undefined && child.agent !== runtime.agent) ||
          (runtime.messageID !== undefined && info.id !== runtime.messageID) || info.sessionID !== runtime.sessionID || info.role !== 'assistant' || info.agent !== runtime.agent ||
          location.cwd !== runtime.directory || location.root !== runtime.worktree || reads.length !== 1 ||
          read?.sessionID !== runtime.sessionID || read.messageID !== info.id ||
          record(read.state).status !== 'running' || !isDeepStrictEqual(record(read.state).input, args))
        throw new Error('Retained artifact read lacks its exact native child invocation.');
      const parentRuntime = { ...runtime, sessionID: child.parentID, agent: COORDINATOR };
      await inspector.parent(parentRuntime);
      const parents = await messages(child.parentID, runtime.directory);
      const tasks = parents.flatMap(message => list(message.parts, 'artifact parent parts', PARTS_MAX)
        .filter(part => part.type === 'tool' && part.tool === 'task' && record(record(part.state).metadata ?? {}).sessionId === child.id)
        .map(part => ({ part, info: record(message.info) })));
      if (tasks.length !== 1) throw new Error('Retained artifact read has no unique native parent task.');
      const task = tasks[0]!, state = record(task.part.state), path = record(task.info.path);
      const taskArgs = record(state.input);
      if (state.status !== 'running' || task.info.role !== 'assistant' || task.info.agent !== COORDINATOR ||
          task.info.sessionID !== child.parentID || task.part.sessionID !== child.parentID || task.part.messageID !== task.info.id ||
          path.cwd !== runtime.directory || path.root !== runtime.worktree || taskArgs.subagent_type !== runtime.agent ||
          typeof taskArgs.description !== 'string' || typeof taskArgs.prompt !== 'string')
        throw new Error('Retained artifact read parent task is not the active native actor.');
      return { parent: child.parentID, callID: boundedText(task.part.callID, 'artifact parent call ID', 256),
        args: taskArgs as { subagent_type: string; description: string; prompt: string } };
    },
    async securityCaller(runtime, messageID, userText) {
      await inspector.parent(runtime);
      // The latest user turn can sit past the tail page in a long turn; current controls cannot.
      const history = await conversation(runtime.sessionID, runtime.directory);
      const info = record(history.at(-1)?.info);
      const location = record(info.path);
      if (info.id !== messageID || info.role !== 'assistant' || info.agent !== COORDINATOR ||
          info.sessionID !== runtime.sessionID || location.cwd !== runtime.directory || location.root !== runtime.worktree || info.error != null)
        throw new Error('Security intake requires the native coordinator caller.');
      const latestUser = history.findLast(message => record(message.info).role === 'user');
      const user = record(latestUser?.info);
      if (authoredNativeText(list(latestUser?.parts, 'user parts', PARTS_MAX).filter(part => part.type === 'text'), runtime.sessionID, String(user.id)) !== userText ||
          history.slice(-HISTORY_MAX).some(message => list(message.parts, 'native control parts', PARTS_MAX).some(part => part.type === 'tool' &&
            ['task', 'question', 'mdd_transfer', 'mdd_transfer_recover'].includes(String(part.tool)) && ['pending', 'running'].includes(String(record(part.state).status)))))
        throw new Error('Security request differs or a native control is pending.');
    },
    async securitySession(sessionID) {
      const response = await readSdk(signal => input.client.session.get({
        path: { id: sessionID }, query: { directory: input.directory }, signal, throwOnError: true,
      }), timeout);
      // A missing unrelated native record carries no session capability. SDK errors still throw;
      // an active/known security operation treats even this absence as unconfirmed identity.
      if (response.data == null) return { agent: '', ancestors: [], directory: '', worktree: '', security: false };
      const native = record(response.data);
      const ancestors: string[] = [];
      let security = native.agent === SECURITY_AGENT;
      let childID = sessionID;
      let parentID = native.parentID;
      while (!security && typeof parentID === 'string') {
        if (ancestors.length >= 16 || ancestors.includes(parentID) || parentID === sessionID) throw new Error('Security native ancestry cannot be confirmed within its inspection bound.');
        const parent = await session(parentID, input.directory);
        if (parent.id !== parentID) throw new Error('Security native ancestor identity differs.');
        ancestors.push(parentID);
        security = parent.agent === SECURITY_AGENT;
        // Unrelated off-location histories are outside this adapter, not evidence of an audit.
        if (!security && parent.projectID === input.project.id && parent.directory === input.directory) {
          security = (await conversation(parentID, input.directory)).some(message => list(message.parts, 'native parent parts', PARTS_MAX).some(part => {
            if (part.type !== 'tool' || part.tool !== 'task') return false;
            const state = record(part.state);
            return state.input && typeof state.input === 'object' && record(state.input).subagent_type === SECURITY_AGENT &&
              record(state.metadata ?? {}).sessionId === childID;
          }));
        }
        childID = parentID;
        parentID = parent.parentID;
      }
      return { agent: String(native.agent), directory: String(native.directory), worktree: input.worktree,
        security, ancestors,
        ...(typeof native.parentID === 'string' ? { parentID: native.parentID } : {}) };
    },
    async securityChild(binding, childID) {
      await securityTaskPart(binding, { callID: binding.callID! }, childID);
      const child = await session(childID, binding.runtime.directory);
      if (child.id !== childID || child.agent !== SECURITY_AGENT || child.parentID !== binding.runtime.sessionID ||
          child.directory !== binding.runtime.directory || child.projectID !== input.project.id)
        throw new Error('Security child native identity differs.');
    },
    async securityTask(binding, call, completed) {
      await securityTaskPart(binding, call, completed?.childID);
      if (!completed) return;
      await inspector.securityChild(binding, completed.childID);
      const history = await messages(completed.childID, binding.runtime.directory);
      const last = history.at(-1);
      const info = record(last?.info);
      const location = record(info.path);
      const parts = list(last?.parts, 'security final parts', PARTS_MAX);
      if (info.role !== 'assistant' || info.agent !== SECURITY_AGENT || info.sessionID !== completed.childID ||
          info.error != null || !record(info.time).completed || !['stop', 'end-turn'].includes(String(info.finish)) ||
          location.cwd !== binding.runtime.directory || location.root !== binding.runtime.worktree ||
          parts.some(part => part.type === 'tool' && ['pending', 'running'].includes(String(record(part.state).status))) ||
          parts.filter(part => part.type === 'text').some(part => part.synthetic === true || part.ignored === true || part.sessionID !== completed.childID || part.messageID !== info.id) ||
          parts.filter(part => part.type === 'text').map(part => part.text).join('\n') !== completed.report)
        throw new Error('Security result differs from the native terminal child report.');
    },
    async nativeActor(sessionID, liveAgent) {
      const current = await session(sessionID, input.directory);
      const history = await messages(sessionID, input.directory);
      const latest = history.findLast(message => record(message.info, 'message').role === 'assistant');
      const recordedAgent = latest ? record(latest.info, 'message').agent : current.agent;
      // Neither a session switch nor a stale message may relax an already identified judge.
      const agent = isJudge(current.agent) ? current.agent : recordedAgent;
      // V2's native hook identity can precede recorded history; tool arguments are never identity.
      const resolvedAgent = typeof agent === 'string' && agent.trim() ? agent : liveAgent;
      return { session: current, agent: boundedText(resolvedAgent, 'native actor identity', 256) };
    },
    async judgeInspection(runtime, args) {
      checkWorkspace(runtime);
      const actor = await inspector.nativeActor(runtime.sessionID);
      if (!isJudge(runtime.agent) || actor.agent !== runtime.agent || actor.session.id !== runtime.sessionID ||
          actor.session.directory !== runtime.directory || actor.session.projectID !== input.project.id) {
        throw new Error('Immutable inspection belongs only to the exact native judge in this workspace.');
      }
      const history = await messages(runtime.sessionID, runtime.directory);
      const current = history.at(-1);
      const info = record(current?.info, 'judge caller');
      const path = record(info.path, 'judge workspace');
      const calls = list(current?.parts, 'judge tool parts', PARTS_MAX).filter(part => part.type === 'tool' && part.tool === JD_INSPECT &&
        record(part.state, 'judge tool state').status === 'running' && isDeepStrictEqual(record(part.state, 'judge tool state').input, args));
      const part = calls[0];
      const state = part ? record(part.state, 'judge tool state') : {};
      if (calls.length !== 1 || info.id !== runtime.messageID || info.role !== 'assistant' || info.agent !== runtime.agent || info.sessionID !== runtime.sessionID ||
          path.cwd !== runtime.directory || path.root !== runtime.worktree || part?.tool !== JD_INSPECT ||
          part.sessionID !== runtime.sessionID || part.messageID !== info.id || state.status !== 'running' || !isDeepStrictEqual(state.input, args)) {
        throw new Error('Immutable inspection requires the exact current native judge tool call.');
      }
    },
    async transferLiveness(runtime, sourceSessionID, runID, requestDigest, assistantMessageID) {
      await inspector.parent(runtime);
      const statuses = await readSdk(signal => input.client.session.status({ query: { directory: runtime.directory }, signal, throwOnError: true }), timeout);
      const state = record(statuses.data, 'session statuses')[runtime.sessionID];
      if (state !== undefined && record(state, 'target status').type !== 'idle') return 'running';
      const history = assistantMessageID ? [await exactMessage(runtime.sessionID, assistantMessageID, runtime.directory)]
        : await conversation(runtime.sessionID, runtime.directory);
      if (assistantMessageID) {
        const info = record(history[0]!.info, 'transfer assistant message');
        const path = record(info.path, 'transfer assistant path');
        if (info.role !== 'assistant' || info.agent !== COORDINATOR || path.cwd !== runtime.directory || path.root !== runtime.worktree)
          throw new Error('Transfer call was not issued by this native coordinator.');
      }
      const calls = history.flatMap(message => {
        const info = record(message.info, 'transfer assistant message');
        return list(message.parts, 'message parts', PARTS_MAX).filter(part => {
          if (part.type !== 'tool' || part.tool !== 'mdd_transfer') return false;
          const path = record(info.path, 'transfer assistant path');
          if (info.role !== 'assistant' || info.agent !== COORDINATOR || info.sessionID !== runtime.sessionID ||
              path.cwd !== runtime.directory || path.root !== runtime.worktree ||
              part.sessionID !== runtime.sessionID || part.messageID !== info.id ||
              typeof part.callID !== 'string' || !part.callID.trim())
            throw new Error('Native transfer tool call does not belong to this target coordinator message.');
          const args = record(record(part.state, 'transfer call state').input, 'transfer call input');
          return args.sourceSessionID === sourceSessionID && args.runID === runID &&
            typeof args.userText === 'string' && createHash('sha256').update(canonicalNativeText(args.userText)).digest('hex') === requestDigest;
        });
      });
      if (calls.length !== 1) return 'unknown';
      const status = record(calls[0]!.state, 'transfer call state').status;
      return status === 'running' || status === 'pending' ? 'running' :
        status === 'completed' || status === 'error' ? 'stopped' : 'unknown';
    },
    async confirmTransfer(runtime, receipt, runID) {
      await inspector.parent(runtime);
      const message = await exactMessage(runtime.sessionID, receipt.nativeUserMessageID, runtime.directory);
      const info = record(message.info, 'message');
      if (info.role !== 'user' || info.sessionID !== runtime.sessionID || receipt.targetSessionID !== runtime.sessionID)
        throw new Error('Transfer receipt does not belong to this native target.');
      const parts = list(message.parts, 'message parts', PARTS_MAX).filter(part => part.type === 'text');
      const authored = authoredNativeText(parts, runtime.sessionID, receipt.nativeUserMessageID);
      const canonical = authored === undefined ? '' : canonicalNativeText(authored);
      const tokens = canonical.split(/\s+/);
      const checkpoint = new CheckpointStore(mddDataRoot(runtime.directory)).read(runtime.sessionID)?.checkpoint;
      if (createHash('sha256').update(canonical).digest('hex') !== receipt.requestDigest ||
          !tokens.includes(`sourceSessionID=${receipt.sourceSessionID}`) || !tokens.includes(`runID=${runID}`))
        throw new Error('Transfer receipt is not backed by the exact native target request.');
      if (checkpoint?.version === 3 && checkpoint.events.at(-1)?.kind === 'rework' &&
          !tokens.some(token => /^rework[.!?]?$/i.test(token)))
        throw new Error('Target rework lacks an explicit native rework request.');
    },
    async confirmAdaptiveTransfer(runtime, receipt, runID) {
      await inspector.parent(runtime);
      const saved = new AdaptiveStore(mddDataRoot(runtime.directory)).read(runtime.sessionID);
      // Before publication recovery supplies a concrete receipt, but still reads the exact source.
      const source = new AdaptiveStore(mddDataRoot(runtime.directory)).read(receipt.sourceSessionID);
      if (!source || source.runID !== runID || source.directory !== runtime.directory || source.worktree !== runtime.worktree ||
          source.admissionDigest !== receipt.admissionDigest || receipt.targetSessionID !== runtime.sessionID ||
          saved && (saved.runID !== runID || saved.admissionDigest !== receipt.admissionDigest))
        throw new Error('Adaptive transfer objective and exact workspace binding cannot be confirmed.');
      const message = await exactMessage(runtime.sessionID, receipt.nativeUserMessageID, runtime.directory);
      const info = record(message.info, 'adaptive transfer user');
      const authored = authoredNativeText(list(message.parts, 'adaptive transfer parts', PARTS_MAX).filter(part => part.type === 'text'), runtime.sessionID, receipt.nativeUserMessageID);
      const canonical = authored === undefined ? '' : canonicalNativeText(authored);
      if (info.role !== 'user' || info.sessionID !== runtime.sessionID || canonical !== adaptiveTransferRequest(source) ||
          createHash('sha256').update(canonical).digest('hex') !== receipt.requestDigest)
        throw new Error('Adaptive transfer receipt lacks the exact native target-authored unchanged-objective authorization.');
    },
    async confirmAdaptiveAdmission(runtime, userMessageID, objective) {
      await inspector.parent(runtime);
      const message = await exactMessage(runtime.sessionID, userMessageID, runtime.directory), info = record(message.info);
      const authored = authoredNativeText(list(message.parts, 'admission user parts', PARTS_MAX).filter(part => part.type === 'text'), runtime.sessionID, userMessageID);
      if (info.role !== 'user' || authored === undefined || canonicalNativeText(authored) !== canonicalNativeText(objective))
        throw new Error('Archived fresh admission lacks its exact genuine native user request.');
    },
    /**
     * Positive proof that nothing this conversation started is still running. It reads the whole
     * readable conversation, never a page: refusing a full page or a compaction made every
     * conversation past a hundred messages, or summarized once, permanently unable to retire,
     * admit or transfer a run, because the proof could no longer be made at all.
     *
     * A compaction is not a gap in that proof. The host compacts only at a step boundary of this
     * parent, where every earlier call already had its result, and a coordinator dispatch is
     * foreground-only, so its child had returned with it. What can still be live there is exactly
     * what the host reports running, so every session the host reports not idle whose parent is
     * this conversation refuses, whether or not the readable history still names it.
     */
    async adaptiveTransferIdle(runtime, role, settledQuestionCallID) {
      await inspector.parent(runtime);
      const history = await conversation(runtime.sessionID, runtime.directory);
      const statuses = await readSdk(signal => input.client.session.status({ query: { directory: runtime.directory }, signal, throwOnError: true }), timeout);
      const states = record(statuses.data, 'adaptive native statuses');
      if (role === 'source' && states[runtime.sessionID] !== undefined &&
          record(states[runtime.sessionID], 'adaptive source status').type !== 'idle')
        throw new Error('The source native parent is running or unknown, not idle.');
      const named = new Set<string>();
      for (const message of history) for (const part of list(message.parts, 'adaptive native controls', PARTS_MAX)) {
        if (part.type !== 'tool' || !['task', 'question', 'mdd_adapt', 'mdd_transfer', 'mdd_transfer_recover'].includes(String(part.tool))) continue;
        const state = record(part.state, 'adaptive control state'), info = record(message.info, 'adaptive control author');
        if (part.tool === 'mdd_adapt' && role === 'target' && info.id === record(history.at(-1)?.info).id &&
            info.role === 'assistant' && info.sessionID === runtime.sessionID && part.sessionID === runtime.sessionID && part.messageID === info.id) continue;
        if (part.tool === 'question' && part.callID === settledQuestionCallID && info.role === 'assistant' &&
            info.sessionID === runtime.sessionID && part.sessionID === runtime.sessionID && part.messageID === info.id && state.status === 'running') continue;
        if (info.role !== 'assistant' || info.sessionID !== runtime.sessionID || part.sessionID !== runtime.sessionID ||
            part.messageID !== info.id || !['completed', 'error'].includes(String(state.status)))
          throw new Error('Native control is running, unknown or belongs to another parent.');
        if (part.tool !== 'task') continue;
        const childID = record(state.metadata ?? {}, 'adaptive child metadata').sessionId;
        if (typeof childID !== 'string') throw new Error('Native task has an unknown child; transfer cannot infer termination.');
        named.add(childID);
        const child = await session(childID, runtime.directory), childStatus = states[childID];
        if (child.parentID !== runtime.sessionID || child.directory !== runtime.directory ||
            childStatus !== undefined && record(childStatus, 'adaptive child status').type !== 'idle')
          throw new Error('Native child is running, unknown or belongs to another workspace.');
        const last = (await messages(childID, runtime.directory)).at(-1), terminal = record(last?.info, 'adaptive child terminal');
        if (terminal.role !== 'assistant' || !record(terminal.time ?? {}).completed ||
            !terminal.error && !['stop', 'end-turn'].includes(String(terminal.finish)) ||
            list(last?.parts, 'adaptive child parts', PARTS_MAX).some(item => item.type === 'tool' &&
              !['completed', 'error'].includes(String(record(item.state).status))))
          throw new Error('Native child termination is unknown; no age-based transfer release is allowed.');
      }
      for (const [id, value] of Object.entries(states)) {
        if (id === runtime.sessionID || named.has(id) || record(value, 'adaptive native status').type === 'idle') continue;
        if ((await session(id, runtime.directory)).parentID === runtime.sessionID)
          throw new Error('A native child of this conversation is running or unknown; transfer cannot infer termination.');
      }
    },
    /**
     * Recovers the objective of a start that only failed because MDD was not set up yet. That is a
     * narrow, legacy shape: one completed `mdd_start` whose own output says it stopped at setup.
     *
     * Everything else is an ordinary conversation, not a fault. History that carries real work,
     * an earlier successful start, another tool or a compaction simply proves no pending setup,
     * so recovery is unavailable and this returns nothing. It
     * used to throw instead, which made a second `mdd_start` in a working conversation fail with
     * an unreadable message and left `mdd_reset` with scope run promising a restart it could not
     * deliver. Nothing is lost by degrading: the objective of an ordinary start is proven by
     * `intake` against the actual latest native user text, which is the stronger guard anyway.
     */
    async setupPending(runtime, selected, messageID) {
      await inspector.parent(runtime);
      const history = await conversation(runtime.sessionID, runtime.directory);
      if (messageID !== undefined && record(history.at(-1)?.info, 'caller message').id !== messageID) throw new Error('Setup recovery does not match the actual native caller message.');
      let candidates: Map<string, { requirements: string; userMessageID: string }>;
      try { candidates = setupOnlyStarts(history, runtime); } catch { return undefined; }
      const matches = [...candidates.values()].filter(item => selected === undefined || item.requirements === selected);
      if (matches.length === 1) return matches[0];
      if (candidates.size === 1) return [...candidates.values()][0];
      // Real candidates that cannot be told apart are the one case worth interrupting for: picking
      // one of two pending objectives at random is not a degradation, it is the wrong run.
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
      // Uniqueness is only proof across the whole conversation, so that is what is read.
      const history = await conversation(runtime.sessionID, runtime.directory);
      const parts = history.flatMap(message => list(message.parts, 'message parts', PARTS_MAX)
        .filter(part => part.type === 'tool' && part.tool === tool && part.callID === callID)
        .map(part => ({ part, info: record(message.info, 'message') })));
      if (parts.length !== 1) throw new Error('The native question call is not uniquely readable.');
      const { part, info } = parts[0]!;
      const state = record(part.state, 'tool state');
      if (part.sessionID !== runtime.sessionID || part.messageID !== info.id || info.role !== 'assistant' ||
          state.status !== 'running' || !isDeepStrictEqual(state.input, args)) {
        throw new Error('The native question history differs from the exact running call.');
      }
      return boundedText(info.id, 'native question caller message ID', 256);
    },
    /**
     * Proves the text MDD was handed is text the user actually wrote here, and returns the message
     * it came from. Consent still has to be the latest thing they said. An objective does not:
     * interrupting and then writing "continue" buried the real request behind continuation text,
     * and made it unstartable for the rest of the conversation. Reaching an earlier message is
     * still their own words, never the model's, and the fresh-start guard keeps a message that
     * already ran from running again. Identical texts are refused rather than picked between.
     *
     * The whole conversation is read, so neither the latest user turn nor an earlier objective can
     * fall outside it. Recent messages are still searched first, exactly as when only they were
     * readable, and older ones only when nothing recent matches: reaching further back finds the
     * user's request instead of refusing it, without turning a recent unique match ambiguous.
     */
    async intake(runtime, requirements, messageID, scope = 'latest') {
      await inspector.parent(runtime);
      const history = await conversation(runtime.sessionID, runtime.directory);
      const caller = history.at(-1);
      if (!caller || record(caller.info, 'caller message').id !== messageID || record(caller.info, 'caller message').role !== 'assistant') throw new Error('Start does not match the actual native caller message.');
      const isUser = (message: Record<string, unknown>) => record(message.info, 'message').role === 'user';
      const users = history.slice(0, -1).filter(isUser);
      const recentStart = Math.max(0, history.length - HISTORY_MAX);
      const recentUsers = history.slice(recentStart, -1).filter(isUser), olderUsers = history.slice(0, recentStart).filter(isUser);
      if (scope === 'native-current' || scope === 'native-current-objective') {
        const info = record(caller.info), path = record(info.path);
        if (info.sessionID !== runtime.sessionID || info.agent !== COORDINATOR || info.error != null ||
            path.cwd !== runtime.directory || path.root !== runtime.worktree || info.parentID !== record(users.at(-1)?.info).id)
          throw new Error('The current native assistant caller does not belong to this coordinator, workspace and user turn.');
        const question = new QuestionCheckpointStore(mddDataRoot(runtime.directory)).read(runtime.sessionID);
        // Current controls live at the end; the whole-conversation idle proof covers the rest.
        for (const message of history.slice(recentStart)) for (const part of list(message.parts, 'current native controls', PARTS_MAX)) {
          if (part.type !== 'tool' || !['task', 'question', 'mdd_adapt', 'mdd_transfer', 'mdd_transfer_recover'].includes(String(part.tool))) continue;
          const state = record(part.state), author = record(message.info);
          if (!['pending', 'running'].includes(String(state.status))) continue;
          if (part.tool === 'mdd_adapt' && author.id === info.id && author.role === 'assistant' &&
              part.sessionID === runtime.sessionID && part.messageID === info.id) continue;
          const consumedQuestion = part.tool === 'question' && state.status === 'running' && question?.version === 2 &&
            question.state === 'settled' && question.nativeReceipt && question.callID === part.callID &&
            author.role === 'assistant' && author.sessionID === runtime.sessionID && part.sessionID === runtime.sessionID &&
            part.messageID === author.id && isDeepStrictEqual(state.input, question.slot.args);
          if (!consumedQuestion) throw new Error('A current native control remains unsettled; no adaptive admission or transfer is authorized.');
        }
      }
      if (!users.length) throw new Error('No actual native user requirements found.');
      const canonicalRequirements = canonicalNativeText(requirements);
      const matching = (list_: typeof users) => list_.filter(user => {
        const info = record(user.info, 'message');
        if (info.sessionID !== runtime.sessionID) return false;
        const parts = list(user.parts, 'message parts', PARTS_MAX).filter(part => part.type === 'text');
        let candidate: string | undefined;
        try { candidate = authoredNativeText(parts, runtime.sessionID, String(info.id)); } catch { return false; }
        return candidate !== undefined && canonicalNativeText(candidate) === canonicalRequirements;
      });
      // Adaptive entry prefers the current turn; an earlier request ("si, confirmo" after it) is
      // still the user's own words, and the bridge asks fresh native confirmation before admitting it.
      const latest = users.slice(-1), earlier = (list_: typeof users) => list_.filter(user => user !== latest[0]);
      const tiers = scope === 'objective' ? [recentUsers, olderUsers]
        : scope === 'native-current-objective' ? [latest, earlier(recentUsers), earlier(olderUsers)] : [latest];
      let matches: typeof users = [];
      for (const tier of tiers) if (!matches.length) matches = matching(tier);
      if (matches.length > 1) throw new Error('Several native user messages carry exactly this text; ask the user to restate the objective so the run binds to one message.');
      if (!matches.length) {
        // The first offset where the latest authored user text actually differs turns "no match"
        // into something the caller can act on instead of guessing what changed.
        let detail = '';
        const latestUser = users.at(-1);
        if (latestUser) {
          try {
            const info = record(latestUser.info, 'message');
            const parts = list(latestUser.parts, 'message parts', PARTS_MAX).filter(part => part.type === 'text');
            const latestText = authoredNativeText(parts, runtime.sessionID, String(info.id));
            if (latestText !== undefined) {
              const offset = firstDivergence(canonicalNativeText(latestText), canonicalRequirements);
              detail = ` The latest native user text first differs at offset ${offset}.`;
            }
          } catch { /* diagnosis is best-effort; the base error still stands without it. */ }
        }
        throw new Error((scope === 'objective' || scope === 'native-current-objective'
          ? 'Requirements must exactly match an actual native user message in this conversation; do not rewrite or invent them.'
          : 'Requirements must exactly match the latest native user text; do not rewrite or invent them.') + detail);
      }
      return boundedText(record(matches[0]!.info, 'message').id, 'native user message ID', 256);
    },
    /** The user turn the actual running coordinator message answers; read-only, never consent. */
    async currentUser(runtime, callerMessageID) {
      await inspector.parent(runtime);
      // A long turn can push its own user message past the tail page; the conversation still has it.
      const history = await conversation(runtime.sessionID, runtime.directory);
      const caller = history.at(-1);
      if (!caller || record(caller.info, 'caller message').id !== callerMessageID || record(caller.info, 'caller message').role !== 'assistant')
        throw new Error('Start does not match the actual native caller message.');
      const latest = history.slice(0, -1).filter(message => record(message.info, 'message').role === 'user').at(-1);
      if (!latest) throw new Error('No actual native user requirements found.');
      return boundedText(record(latest.info, 'message').id, 'native user message ID', 256);
    },
    /**
     * Proves a written answer is the user's own: exactly their latest message, as they wrote it
     * (host-added parts excluded, like every other proof here), and, when `after` names the calls
     * that showed the question, written after one of them. An answer typed before the user could
     * see the question is not an answer to it, however well its words happen to fit.
     */
    async typed(runtime, text, messageID, after) {
      await inspector.parent(runtime);
      const history = await conversation(runtime.sessionID, runtime.directory);
      const caller = history.at(-1);
      if (!caller || record(caller.info, 'caller message').id !== messageID || record(caller.info, 'caller message').role !== 'assistant')
        throw new Error('The answer does not come from the actual native caller message. Nothing was recorded.');
      let latest = -1;
      for (let index = history.length - 2; index >= 0; index--) if (record(history[index]!.info, 'message').role === 'user') { latest = index; break; }
      const refuse = 'userText must be the user\'s exact latest message in this conversation, unchanged. Nothing was recorded.';
      if (latest < 0) throw new Error(refuse);
      const info = record(history[latest]!.info, 'message');
      let written: string | undefined;
      try { written = authoredNativeText(list(history[latest]!.parts, 'message parts', PARTS_MAX).filter(part => part.type === 'text'), runtime.sessionID, String(info.id)); }
      catch { written = undefined; }
      if (info.sessionID !== runtime.sessionID || written === undefined || canonicalNativeText(written) !== canonicalNativeText(text)) throw new Error(refuse);
      if (after.length && !history.slice(0, latest).some(message => record(message.info, 'message').role === 'assistant' &&
          list(message.parts, 'message parts', PARTS_MAX).some(part => part.type === 'tool' && part.tool === 'question' && after.includes(String(part.callID))))) {
        throw new Error('The user wrote this before the question was shown, or the question is no longer in the readable history. Ask it again with the native question tool. Nothing was recorded.');
      }
      return boundedText(info.id, 'native user message ID', 256);
    },
    async questionInput(call: TaskCall) {
      const history = await conversation(call.sessionID, input.directory);
      const matches = history.flatMap(message => list(message.parts, 'question identity', PARTS_MAX)
        .filter(part => part.type === 'tool' && part.tool === 'question' && part.callID === call.callID)
        .map(part => ({ part, info: record(message.info) })));
      if (matches.length !== 1) throw new Error('Native coordinator question call is not uniquely readable.');
      const { part, info } = matches[0]!, state = record(part.state);
      if (info.role !== 'assistant' || info.sessionID !== call.sessionID || part.sessionID !== call.sessionID || part.messageID !== info.id ||
          !['pending', 'running', 'completed'].includes(String(state.status)))
        throw new Error('Native coordinator question identity differs.');
      return state.input;
    },
    async question(runtime, call, args) {
      if (call.sessionID !== runtime.sessionID) throw new Error('Native question parent mismatch.');
      return inspector.parent(runtime, call.callID, 'question', args);
    },
    /**
     * Returns what the delegated phase actually answered. The result is the actor's report, not
     * a corroborated record: MDD reads the completed task envelope and nothing else.
     */
    async result(_runtime, _call, _phase, raw) {
      const output = record(raw, 'task result');
      const envelope = typeof output.output === 'string' ? output.output : '';
      const match = TASK_ENVELOPE.exec(envelope.trim());
      if (!match) throw new Error('The delegated phase did not return a completed task result.');
      return nonemptyText(match[1], 'delegated phase result');
    },
    async stopped(runtime, call, returned) {
      return (await liveness(runtime, call, returned)).verdict === 'stopped';
    },
    async liveness(runtime, call) {
      return liveness(runtime, call);
    },
    async abort(runtime, child) {
      await readSdk(signal => input.client.session.abort({ path: { id: child }, query: { directory: runtime.directory }, signal, throwOnError: true }), timeout);
    },
    /**
     * What the phase cost, taken from the child session the task envelope already names in its
     * `id`. Reading that session directly is what makes the number the phase's own: enumerating
     * children and guessing which one ran would attribute one actor's spending to another.
     */
    async usage(runtime, raw) {
      const envelope = typeof record(raw, 'task result').output === 'string' ? String(record(raw, 'task result').output) : '';
      // Bounded and safe as a path segment, without assuming the host's identifier format: what
      // proves this is the right session is that its messages say so, not that the id looks right.
      const child = /^<task id="([A-Za-z0-9_-]{1,128})" state="completed">/.exec(envelope)?.[1];
      if (!child) return undefined;
      const response = await readSdk(signal => input.client.session.messages({
        path: { id: child }, query: { directory: runtime.directory, limit: USAGE_MAX }, signal, throwOnError: true,
      }), timeout);
      const history = list(response.data, 'child message history', USAGE_MAX);
      const usage: TelemetryUsage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, messages: 0 };
      // A window this size holds any ordinary phase, so reaching it means only the tail was read
      // and these totals are a floor rather than a measurement.
      let partial = history.length >= USAGE_MAX;
      for (const message of history) {
        const info = record(message.info, 'message');
        if (info.role !== 'assistant' || info.sessionID !== child) continue;
        const tokens = info.tokens as Record<string, unknown> | undefined;
        const time = info.time as Record<string, unknown> | undefined;
        // A host that reports no usage for a message leaves nothing to add up. Counting it as
        // zero would quietly turn silence into a measurement of free work, so it is flagged.
        if ((!tokens || typeof tokens !== 'object') && typeof info.cost !== 'number') { partial = true; continue; }
        const cache = tokens?.cache as Record<string, unknown> | undefined;
        usage.messages += 1;
        usage.input += metric(tokens?.input); usage.output += metric(tokens?.output);
        usage.reasoning += metric(tokens?.reasoning);
        usage.cacheRead += metric(cache?.read); usage.cacheWrite += metric(cache?.write);
        usage.cost += metric(info.cost);
        // Usage is written when a message settles, so one still running has not reported its own.
        if (time?.completed === undefined) partial = true;
      }
      return usage.messages ? { ...usage, ...(partial ? { partial: true as const } : {}) } : undefined;
    },
  };
  return inspector;
}

function explorationWorkItemSchema() {
  return tool.schema.object({ id: tool.schema.string().min(1).max(64), purpose: tool.schema.string().min(1).max(2000),
    dependsOn: tool.schema.array(tool.schema.string()).max(2).optional(), independent: tool.schema.boolean().optional(),
    complete: tool.schema.boolean().optional(), reads: tool.schema.array(tool.schema.object({
      root: tool.schema.string().min(1), files: tool.schema.array(tool.schema.string().min(1)).min(1).max(64),
    })).min(1).max(8).optional() }).strict();
}

/**
 * The coordinator's clarification questions. Every user-visible string is Spanish; structure is
 * validated again inside the intake, so this schema only shapes what the model is offered.
 */
function clarificationsSchema() {
  return tool.schema.array(tool.schema.object({
    question: tool.schema.string().min(1).describe('One direct question, in Spanish. The native form cannot scroll: put the context in why, not here.'),
    header: tool.schema.string().min(1).max(30).optional().describe('Short topic shown above the question, at most 30 characters (for example "Formato de fecha"). Defaults to "Detalle".'),
    why: tool.schema.string().min(1).optional().describe('Why it matters: what depends on the answer, or what the phase found that raised it. Write it in full: MDD shows it in the chat brief (questionBrief) before the form, not in the form.'),
    options: tool.schema.array(tool.schema.object({ label: tool.schema.string().min(1), description: tool.schema.string().min(1), recommended: tool.schema.boolean().optional() })).max(6)
      .describe('Zero to six concrete choices, each with a one-sentence description; leave empty for an open-ended answer the user types. Free text and "Que decida el agente" are always available.'),
    multiple: tool.schema.boolean().optional().describe('True when several options can apply together.'),
    deferrable: tool.schema.boolean().optional().describe('True only when a later phase can safely decide it.'),
  })).max(8);
}

const plugin: Plugin = async input => {
  const workerHost = (input as PluginInput & { workerHost?: import('./worker-fence.js').WorkerHost }).workerHost;
  const inputDirectory = input.directory;
  const inputWorktree = input.worktree;
  const inputProjectID = input.project.id;
  const settings = (() => { try { return loadGlobalSettings(); } catch { throw new Error(setupDiagnostic(installationPaths().ownedRoot).action); } })();
  const profile = freezeProfile(settings);
  /** Guards off (the default): MDD keeps the bookkeeping of what it issued and refuses nothing else. */
  const free = freeMode(settings);
  const inspector = createInspector(input);
  // Everything MDD persists locally is anchored at the repository, not the checkout a run happens
  // in. A linked git worktree is removed as soon as its task is done; anchored there, the dossier
  // and the lessons went with it. For an ordinary checkout this is byte-for-byte today's directory.
  const dataRoot = mddDataRoot(input.directory);
  // Resume checkpoints and durable run ownership are always on. A checkpoint that cannot be
  // written degrades that run to data-only recovery (see PhaseRunner#checkpoint) instead of
  // blocking live work; the progress marker remains the duplicate-dispatch guard either way.
  const checkpoint = new CheckpointStore(dataRoot);
  const ownership = new RunOwnershipStore(dataRoot);
  const dossier = new RunDossierStore(dataRoot);
  const runner = new PhaseRunner(inspector, {
    ...(settings.knowledge.enabled ? { knowledge: (runtime, selection, memory) => intake.resolveKnowledge(selection, runtime, memory) } : {}),
    workers: profile.workers,
    automaticCorrections: settings.verify?.automaticCorrections ?? DEFAULT_AUTOMATIC_CORRECTIONS,
    ...(free ? { free: true } : {}),
    ...(workerHost ? { workerCapability: { phase: 'mdd-explore' as const, readOnly: true as const,
      ...(workerHost.applyEditing ? { applyEditing: true as const } : {}) } } : {}),
    // The runner passes the run's own checkout directory to these callbacks; MDD writes to the
    // shared anchor instead, so a worktree's telemetry and lessons join the repository's own rather
    // than dying with it. Within a session the two are the same checkout, so nothing else shifts.
    telemetry: (_directory, value, now) => recordTelemetry(dataRoot, value, now),
    progress: new ProgressGuard(dataRoot),
    dossier,
    checkpoint, ownership, adaptiveStore: new AdaptiveStore(dataRoot),
    lessons: (_directory, value, now) => recordLessonQuietly(dataRoot, value, now),
    ledger: (_directory, value, now) => recordRunQuietly(dataRoot, value, now),
  });
  const intake = new NativeIntake(runner, inspector, settings, { checkpoint, questions: new QuestionCheckpointStore(dataRoot), ownership,
    preferences: new SessionPreferenceStore(dataRoot) });
  if (workerHost) {
    workerHost.protectedParent = sessionID => runner.scopedWorkers(sessionID);
    workerHost.assignment = (sessionID, callID) => {
      const assignment = runner.workerAssignment({ sessionID, callID });
      return assignment;
    };
  }
  const security = new SecurityAudit(inspector, sessionID => {
    runner.assertStandaloneIdle(sessionID);
    intake.guardSecurity(sessionID);
    if (pendingStandalone(sessionID)) throw new Error('Standalone work is in flight; wait for its settled result before security auditing.');
  });
  /**
   * The workspace only ever learned that MDD had been used here once a phase had already produced
   * a telemetry event, so every conversation that died earlier — at a question the host never
   * delivered, at a stale marker, at setup — left no evidence that it had ever existed. The first
   * coordinator tool call in a conversation is the earliest honest moment to say otherwise, and it
   * is what makes a blocked intake countable instead of merely remembered by the person it blocked.
   *
   * Recorded once per conversation per process: the fact worth keeping does not change, and a
   * read-modify-write on every tool call would put local file IO on the hot path for nothing.
   */
  /**
   * Checked once at startup, because the answer cannot change while this process runs and the
   * cost belongs to loading, not to every tool call. A plugin upgraded next to actor definitions
   * from an older release is the failure this reports: the coordinator reads instructions the
   * adapter no longer speaks, and nothing about the run itself looks wrong.
   */
  const stale = (() => { try { return staleAssets(); } catch { return []; } })();
  const assets = stale.length
    ? { stale, action: 'The installed MDD actor assets differ from the plugin running them, so this conversation may be following instructions this adapter no longer speaks. Run `mdd-ai update` and restart OpenCode. Nothing is blocked: report this to the user once and continue.' }
    : undefined;
  /**
   * One exit for every MDD tool: derived next call, asset warning when there is one, and the
   * budget. The compact view is the default because every tool but `mdd_status` answers a call
   * the coordinator made to *act* — dispatch, reset, report, contribute — and the reference half
   * of a snapshot is not what it acts on. Only an explicit `mdd_status` with detail="full" asks
   * to inspect the run, and only that call pays for the whole thing.
   */
  const reply = (value: unknown, view: StatusView = 'compact'): string => payload(value, assets, view);
  const nativeRuntime = (context: Runtime): Runtime => ({ sessionID: context.sessionID, agent: context.agent,
    directory: context.directory, worktree: context.worktree });
  const adaptiveReply = async (context: Runtime) => {
    const status = record(await intake.adaptiveStatus(nativeRuntime(context)));
    const recorded = status.state === 'not-started' ? workspaceRuns(context, { dossier, checkpoint, progress: new ProgressGuard(dataRoot), ownership }) : [];
    return reply({ ...status, memory: settings.engram ? 'enabled' : 'off', ...(recorded.length ? { workspaceRuns: recorded } : {}) });
  };
  /**
   * `restoreFailed`: the target could not re-confirm its native request or bytes this time. A
   * receipt still proves ownership, but that restore failure is reported, not hidden as confirmed.
   */
  const ambiguousTransfer = (sessionID: string, restoreFailed = false): Record<string, unknown> => {
    try {
      const saved = checkpoint?.read(sessionID)?.checkpoint;
      const claim = ownership?.parentClaim(sessionID);
      const runID = saved?.version === 3 ? saved.runID : claim?.transfer ? claim.runID : undefined;
      if (!runID) return {};
      const owner = ownership?.read(runID);
      // A finished transfer is settled by its self-contained receipt, whatever the target's
      // checkpoint is now (current, a later descendant, degraded, or cleared).
      if (!restoreFailed && owner?.receipt?.targetSessionID === sessionID && owner.ownerSessionID === sessionID && owner.state !== 'transferring' &&
          claim?.runID === runID && !claim.retired)
        return { transfer: { state: 'confirmed', sourceSessionID: owner.receipt.sourceSessionID, operationID: owner.receipt.operationID } };
      if (claim?.transfer || owner?.transfer?.targetSessionID === sessionID || owner?.receipt?.targetSessionID === sessionID) {
        const published = !!saved || !!new ProgressGuard(dataRoot).read(sessionID);
        const stage = owner?.receipt?.targetSessionID === sessionID ? 'finished-unconfirmed' :
          published ? 'published' : owner?.state === 'transferring' ? 'owner-fenced' : 'claim-only';
        return { transfer: { state: 'ambiguous', stage } };
      }
      if (owner?.originSessionID === sessionID && owner.ownerSessionID !== sessionID)
        return { transfer: { state: 'source-retired', targetSessionID: owner.ownerSessionID } };
      if (owner?.state === 'transferring' && owner.ownerSessionID === sessionID)
        return { transfer: { state: 'source-fenced', targetSessionID: owner.transfer?.targetSessionID } };
      return {};
    } catch { return {}; }
  };
  const opened = new Set<string>();
  const nativeChildren = new Set<string>();
  const judgeSessions = new Set<string>();
  const standaloneCalls = new Map<string, { args: NonNullable<ReturnType<typeof judgmentTask>>; settled: boolean }>();
  const standaloneFixes = new Set<string>();
  const standaloneKey = (sessionID: string, callID: string) => JSON.stringify([sessionID, callID]);
  /** Guards off: native calls MDD let run untouched, so their results and errors skip MDD too. */
  const freeCalls = new Set<string>();
  /**
   * A task MDD neither issued nor has to account for: not its dispatch, not a security audit and
   * not a Judgment Day actor, which keep their own exact protocols because they were asked for.
   */
  const foreignTask = (sessionID: string, args: unknown): boolean => {
    const task = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
    return !mddIssuedTask(args) && task.subagent_type !== SECURITY_AGENT && !isJudgmentActor(task.subagent_type) &&
      !(typeof task.prompt === 'string' && task.prompt.startsWith(SECURITY_HANDLE_PREFIX)) && !copiesReadyTask(sessionID, task);
  };
  /**
   * A task with the actor and description of the one MDD holds ready is an attempt to dispatch it
   * whose handle did not survive the copy. It stays MDD's, so the lost-handle recovery can expose
   * the full prompt or remint the handle; running it as the caller's own would leave the run
   * waiting for a dispatch that already went out under a prompt MDD never wrote.
   */
  const copiesReadyTask = (sessionID: string, task: Record<string, unknown>): boolean => {
    let status: { task?: unknown; tasks?: unknown };
    try { status = runner.status(sessionID) as typeof status; } catch { return false; }
    const ready = [status.task, ...(Array.isArray(status.tasks) ? status.tasks : [])];
    return ready.some(item => !!item && typeof item === 'object' && (item as Record<string, unknown>).subagent_type === task.subagent_type &&
      (item as Record<string, unknown>).description === task.description);
  };
  const claimsQuestion = (call: TaskCall, args: unknown): boolean => {
    try { return intake.claimsQuestion(call, args); } catch { return false; }
  };
  const pendingStandalone = (sessionID: string) => [...standaloneCalls].some(([key, call]) =>
    !call.settled && JSON.parse(key)[0] === sessionID);
  const guardStandalone = (sessionID: string, fix: boolean) => {
    runner.guardStandalone(sessionID, fix);
    intake.guardStandalone(sessionID);
  };
  const settleStandalone = (sessionID: string, callID: string): boolean => {
    const key = standaloneKey(sessionID, callID);
    const call = standaloneCalls.get(key);
    if (!call) return false;
    if (call.settled) return true;
    call.settled = true;
    if (call.args.subagent_type === JD_FIX) standaloneFixes.delete(sessionID);
    return true;
  };
  const notify = async (sessionID: string, message: string, variant: 'success' | 'error' | 'info' = 'info'): Promise<void> => {
    if (!presentationSettings().toasts) return;
    try { await input.client.tui.showToast({ body: { message, variant }, query: { directory: input.directory } }); }
    catch { /* A missing TUI must never change the run's outcome. */ }
  };
  /**
   * How many times a conversation may send Spanish that fails its checks before drafting refuses.
   * The point of the bound is that the failure is a model producing text, and a model that failed
   * three times at translating a paragraph is not one attempt away from succeeding at it.
   */
  const translationAttempts = new Map<string, number>();
  const enter = (context: { agent: string; sessionID: string; directory: string; worktree: string }, name: string): void => {
    coordinatorOnly(context.agent, name);
    if (name !== 'mdd_status') security.control(context.sessionID);
    if (standaloneFixes.has(context.sessionID) && !['mdd_status', 'mdd_improve', 'mdd_improvements', 'mdd_pr_body'].includes(name))
      throw new Error('Standalone correction is in flight; wait before changing workflow ownership or interactions.');
    if (pendingStandalone(context.sessionID) && !['mdd_security', 'mdd_status', 'mdd_improve', 'mdd_improvements', 'mdd_pr_body'].includes(name))
      throw new Error('Standalone work is in flight; wait before changing workflow ownership or interactions.');
    // A conversation whose run moved away by a finished transfer can only start over (or read
    // status, or record/list improvements); nothing may act on the run it handed over.
    const moved = runner.movedAway(context.sessionID);
    if (moved && !['mdd_status', 'mdd_reset', 'mdd_improve', 'mdd_improvements'].includes(name))
      throw new Error(movedMessage(moved.runID, moved.targetSessionID));
    // Every coordinator tool (including consent preparation and inline results) must reject a
    // source whose durable owner is no longer idle, before it can mutate local state. Reset and
    // transfer recovery establish their own authority: they exist to resolve a held writer.
    if (!['mdd_adapt', 'mdd_status', 'mdd_reset'].includes(name)) runner.owner(context.sessionID);
    if (opened.has(context.sessionID)) return;
    opened.add(context.sessionID);
    // Never throws, and its result is deliberately unused: instrumentation that can fail a run is
    // instrumentation that ends up being removed.
    recordSession(dataRoot, { sessionID: context.sessionID, agent: context.agent, directory: context.directory, worktree: context.worktree });
  };
  const hooks: Awaited<ReturnType<Plugin>> = {
    config: async config => {
      applyModelOverrides(config, profile);
      restrictTools(config as Parameters<typeof restrictTools>[0]);
      pinPhaseAgents(config as Parameters<typeof pinPhaseAgents>[0], free);
      pinJudgmentAgents(config as Parameters<typeof pinJudgmentAgents>[0]);
      if (!free) strictCoordinator(config as Parameters<typeof strictCoordinator>[0]);
    },
    tool: {
      mdd_adapt: tool({
        description: `Native version-3 implementation entry and guarded adaptive operations: ${free ? FREE_ADAPT_ROLE : STRICT_ADAPT_ROLE}. Supply only a JSON payload {routingVersion:3,kind,args}; write the text the user reads in full Spanish sentences, never compressed. Read status, its entryGuide and its exact operation/input/detail references. Entry needs only the contract: the host binds the user message whose exact text is contract.objective (messageID is an optional assertion) and fills omitted empty lists and source fingerprints. Transfer messageID must identify the current native USER request. No runtime, profile, approval or stopped claims. A refusal names what to correct; fix it and retry instead of switching routes. Low selects actors by need; medium/high require genuine structured stages and Verify. It is the only MDD implementation route.`,
        args: { payload: tool.schema.string().min(1).max(160000) },
        async execute(args, context) {
          enter(context, 'mdd_adapt');
          if (context.abort.aborted) throw new Error('Native adaptive operation aborted.');
          const here = nativeRuntime(context);
          const payload = completeAdaptiveEntry(args.payload, here.directory);
          decodeAdaptiveRequest(payload);
          if (runner.options.adaptiveStore!.occupied(here.sessionID)) await runner.restore(here);
          return reply({ ...record(await intake.adaptiveInternal(payload, here, boundedText(context.messageID, 'actual native assistant caller', 256))),
            memory: settings.engram ? 'enabled' : 'off' });
        },
      }),
      mdd_security: tool({
        description: 'Run a standalone read-only security audit ONLY on an explicit latest native-user audit request. Pass their exact text, not an implementation/configuration/explanation request. Includes committed and all pending implementation layers; returns one single-use foreground task. Never advances workflow or authorizes fixes, review or delivery.',
        args: { userText: tool.schema.string().min(1), baseRef: tool.schema.string().min(1).optional() },
        async execute(args, context) {
          enter(context, 'mdd_security');
          if (context.abort.aborted) throw new Error('Security audit intake aborted.');
          return JSON.stringify(await security.start(args, context, context.messageID));
        },
      }),
      mdd_jd_inspect: tool({
        description: 'Judge-only immutable local Git inspection. Supply a full commit object ID; tree lists committed paths, blob reads an exact committed path, diff compares two full commit IDs. No shell, live source, remote fetch, filters or partial output.',
        args: { operation: tool.schema.enum(['tree', 'blob', 'diff']), commit: tool.schema.string(), base: tool.schema.string().optional(), path: tool.schema.string().optional() },
        async execute(args, context) {
          if (nativeChildren.has(context.sessionID)) throw new Error('A tracked native fallback cannot use judge inspection.');
          await inspector.judgeInspection(context, args);
          return JSON.stringify(await inspectJudgmentTarget(input.worktree, args, context.abort));
        },
      }),
      mdd_pr_body: tool({
        description: 'Draft only a PR body using the exact local skill/template, with or without a recorded MDD run. With a run: two calls, the first returns the recorded text to translate into Spanish and the second, with translations, renders the body. Without one (a direct edit): pass baseRef, the PR target branch; the first call lists the files git says changed and the second, with direct, renders the body from your Spanish summary and per-file reasons. Never commits, pushes or publishes. Optional notes must quote whole lines of the actual latest user text; unknown facts remain unverified.',
        args: {
          userText: tool.schema.string().min(1),
          runID: tool.schema.string().min(1).optional().describe('Optional explicit retained failed-run target after continuation; never uses another run as its evidence.'),
          notes: tool.schema.object({ environmentVariables: tool.schema.string().optional(), followUps: tool.schema.string().optional(), deployment: tool.schema.string().optional() }).optional(),
          additionalContext: tool.schema.array(tool.schema.discriminatedUnion('source', [
            tool.schema.object({ section: tool.schema.enum(['context', 'risks', 'review']), source: tool.schema.literal('recorded'),
              ref: tool.schema.enum(['goal', 'decisions']) }).strict(),
            tool.schema.object({ section: tool.schema.enum(['context', 'risks', 'review']), source: tool.schema.literal('user'),
              text: tool.schema.string().min(1).max(1000) }).strict(),
            tool.schema.object({ section: tool.schema.enum(['context', 'risks', 'review']), source: tool.schema.literal('interpretation'),
              text: tool.schema.string().min(1).max(1000) }).strict(),
          ])).max(24).optional().describe('Optional in-body context, supplied before final rendering and repeated unchanged. Recorded selectors resolve held goal/decisions, never replacement text. User text quotes a complete actual user line; interpretation is Spanish agent synthesis without independent verification. No unobserved test/deployment claims, readiness overrides or publication authority.'),
          digest: tool.schema.string().min(1).optional().describe('The digest the first call returned. Required with translations or direct text with additionalContext; binds source/context metadata and, in direct mode, git target identity/file list, not changed contents.'),
          translations: tool.schema.array(tool.schema.object({ key: tool.schema.string().min(1), text: tool.schema.string().min(1) })).max(PR_TRANSLATION_LIMIT).optional()
            .describe('One Spanish translation per key returned by the first call. Translate only: keep numbers, paths, identifiers and commands exactly, add no fact and drop none.'),
          baseRef: tool.schema.string().min(1).max(200).optional()
            .describe('Only when no MDD run is recorded here: the PR target branch, such as staging or origin/staging. The changed files are read from git against it.'),
          direct: tool.schema.object({
            summary: tool.schema.string().min(1).describe('One Spanish line: what the change delivers and enables, not how it was built.'),
            files: tool.schema.array(tool.schema.object({ path: tool.schema.string().min(1), reason: tool.schema.string().min(1) })).max(128)
              .describe('Exactly one Spanish one-line reason per path the first call listed.'),
          }).optional().describe('Only without a recorded run, after the first call listed the changed files.'),
        },
        async execute(args, context) {
          enter(context, 'mdd_pr_body');
          if (context.abort.aborted) throw new Error('The PR body draft was aborted.');
          const current = runner.recordedPRFacts(context.sessionID, args.runID);
          await inspector.intake(context, nonemptyText(args.userText, 'actual user request'), context.messageID);
          runner.owner(context.sessionID);
          const facts = runner.recordedPRFacts(context.sessionID, args.runID);
          if (facts?.runID !== current?.runID) throw new Error('The current run changed while drafting; no draft was produced.');
          // No run recorded here: a direct edit. Its files come from git, never from the caller.
          if (!facts) {
            if (args.translations || (args.digest && !args.additionalContext?.length)) throw new Error('No MDD run is recorded here, so there is no recorded text to translate. Pass baseRef, then direct with your Spanish summary and reasons.');
            if (!args.baseRef) throw new Error('No MDD run is recorded here, so this body describes a direct edit. Call again with baseRef, the PR target branch (for example staging or origin/staging); the changed files are read from git against it.');
            const changes = await directChanges(context.directory, args.baseRef, context.abort);
            return JSON.stringify(args.direct
              ? renderDirectPRBody(changes, args.direct, args.userText, args.notes, { additionalContext: args.additionalContext, digest: args.digest })
              : directPRRequest(changes, args.additionalContext, args.userText));
          }
          if (args.direct) throw new Error('This conversation has a recorded MDD run, so its body comes from that evidence. Omit direct and translate the recorded text instead.');
          // Asking again for the recorded text is how a stuck translation is restarted, so it
          // clears the budget: the next set is judged on its own, not on what came before it.
          if (!args.translations) { translationAttempts.delete(context.sessionID); return JSON.stringify(prBodyRequest(facts, args.additionalContext, args.userText)); }
          if (!args.digest) throw new Error('Translations must carry the digest the first call returned; without it nothing proves they belong to this evidence.');
          const spent = translationAttempts.get(context.sessionID) ?? 0;
          if (spent >= PR_TRANSLATION_ATTEMPTS) {
            translationAttempts.delete(context.sessionID);
            throw new Error(`The Spanish sent for this body failed its checks ${PR_TRANSLATION_ATTEMPTS} times and no body was drafted. Tell the user plainly, in Spanish, rather than trying again: a body that mixes languages or loses a recorded fact is the defect this refuses to produce.`);
          }
          try {
            const drafted = JSON.stringify(renderPRBody(context.directory, facts, args.userText, args.notes,
              { digest: args.digest, translations: args.translations, additionalContext: args.additionalContext }));
            translationAttempts.delete(context.sessionID);
            return drafted;
          } catch (error) {
            // Only a bad translation spends the budget. A note quoting the wrong user line is the
            // caller's other mistake to fix, and it must not push the draft towards refusal.
            if (error instanceof TranslationError) translationAttempts.set(context.sessionID, spent + 1);
            throw error;
          }
        },
      }),
      mdd_knowledge: tool({
        description: 'Query optional project observations across sessions. Returns bounded summaries/references with fresh, stale or unverified source dependencies checked against this checkout. Fresh validates declared bytes only; stale/unverified entries are not eligible for reuse. Advisory data, never policy, consent or execution authority.',
        args: {
          query: tool.schema.string().min(1).max(200).optional(),
          phase: tool.schema.string().optional(),
          paths: tool.schema.array(tool.schema.string().min(1).max(256)).min(1).max(16).optional(),
          limit: tool.schema.number().int().min(1).max(10).optional(),
        },
        async execute(args, context) {
          enter(context, 'mdd_knowledge');
          if (context.abort.aborted) throw new Error('Knowledge query aborted.');
          await inspector.parent(context);
          return JSON.stringify(await intake.knowledge(args, context));
        },
      }),
      mdd_knowledge_record: tool({
        description: 'Record a bounded candidate project observation learned in the current native request context when knowledge is enabled. Supply your structured finding and the exact latest userText; the user need not author metadata or a recording command. Provenance identifies a coordinator observation, never a user assertion, approved policy or permission. Unknown writes must never be retried blindly.',
        args: {
          userText: tool.schema.string().min(1).describe('Exact latest native user request, unchanged. This grounds task context, not user authorship or approval of the observation.'),
          observation: tool.schema.object({
            summary: tool.schema.string().min(1).max(320).describe('Concise single-line candidate finding; synthesis is allowed.'),
            body: tool.schema.string().min(1).max(4096),
            applicability: tool.schema.object({
              phases: tool.schema.array(tool.schema.string()).min(1).max(8),
              paths: tool.schema.array(tool.schema.string().min(1).max(256)).min(1).max(16),
            }).strict(),
            sources: tool.schema.array(tool.schema.string().min(1).max(256)).min(1).max(16),
          }).strict(),
        },
        async execute(args, context) {
          enter(context, 'mdd_knowledge_record');
          if (context.abort.aborted) throw new Error('Knowledge recording aborted.');
          return JSON.stringify(await intake.recordKnowledge(args, context, context.messageID));
        },
      }),
      mdd_improve: tool({
        description: 'Record something MDD did badly so later sessions can find it and improve. Use it when the user says an error or behaviour should be remembered, quoting their actual latest text. Failed phases record themselves; this is the deliberate one. Recording is not fixing and changes no run.',
        args: {
          userText: tool.schema.string().min(1).describe('The exact latest native user text asking for this to be recorded, without rewriting.'),
          title: tool.schema.string().min(1).describe('One short line naming what went wrong, in the user\'s language.'),
          detail: tool.schema.string().min(1).describe('What happened, what should have happened instead, and anything a later session needs to act on it. Plain text.'),
          phase: tool.schema.string().optional().describe('The MDD phase it concerns, when it concerns one.'),
        },
        async execute(args, context) {
          enter(context, 'mdd_improve');
          if (context.abort.aborted) throw new Error('Recording the improvement was aborted.');
          // The same proof mdd_pr_body requires: an improvement attributed to the user has to be
          // one the user actually asked for, not one the model decided to write down for them.
          await inspector.intake(context, nonemptyText(args.userText, 'actual user request'), context.messageID);
          runner.owner(context.sessionID);
          return reply(await intake.improve({
            title: boundedText(args.title, 'improvement title', 200),
            detail: boundedText(args.detail, 'improvement detail', 4000),
            ...(args.phase === undefined ? {} : { phase: phaseName(args.phase) }),
          }, context));
        },
      }),
      mdd_improvements: tool({
        description: 'List the improvements recorded for MDD in this workspace, and the ones memory holds from other conversations. Read-only: it starts nothing, changes no run and needs no approval. Present the returned report as it is and never invent an entry it does not contain.',
        args: {
          query: tool.schema.string().optional().describe('Optional text to filter by; omit for everything recorded.'),
          state: tool.schema.enum(['open', 'reviewed', 'applied']).optional().describe('Optional lifecycle filter; omit for all of them.'),
          limit: tool.schema.number().int().min(1).max(50).optional().describe('How many to return, newest first. Defaults to everything recorded.'),
        },
        async execute(args, context) {
          enter(context, 'mdd_improvements');
          if (context.abort.aborted) throw new Error('Reading the improvements was aborted.');
          return reply(await intake.improvements({
            ...(args.query === undefined ? {} : { text: boundedText(args.query, 'improvement query', 200) }),
            ...(args.state === undefined ? {} : { state: args.state }),
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          }, context));
        },
      }),
      mdd_check_report: tool({
        description: 'Check that the phase report you are about to return can be read, before you return it. Answers about form — required sections and field types — and, while your run is at this phase, about the links to the requirements, decisions, plan and findings it holds, with the same rules the run applies on arrival. It records nothing: no attempt is spent, no run changes, and a clean answer is not an acceptance. Use it once your report is written; if it names problems, fix them all and check again. This is the only MDD tool a phase actor may call.',
        args: {
          phase: tool.schema.enum(CHECK_AGENTS as unknown as [string, ...string[]]).describe('The phase this report answers, exactly as it appears in your prompt.'),
          result: tool.schema.string().min(1).describe('The full report markdown you intend to return, exactly as you would return it.'),
        },
        async execute(args, context) {
          if (context.agent === SECURITY_AGENT || args.phase === SECURITY_AGENT) {
            await security.enforce(context.sessionID, CHECK_TOOL, args, context.agent);
            if (context.agent !== SECURITY_AGENT) throw new Error('Only a bound native security child may check a security report.');
            const checked = checkSecurityReportForm(args.result);
            return statusPayload({ ok: checked.ok, problems: checked.ok ? [] : ['Standalone security report form is invalid; use the supplied bounded schema.'],
              resultFormat: checked.resultFormat, note: checked.note });
          }
          // Phase actors and the coordinator carrying a phase itself; nobody else has a report.
          if (context.agent !== COORDINATOR && !CHECK_AGENTS.includes(context.agent)) {
            throw new Error(`${CHECK_TOOL} belongs to MDD phase actors and the ${COORDINATOR} agent. This session is not carrying out an MDD phase; continue with your own tools.`);
          }
          if (args.phase === RISK_AGENT) return statusPayload(checkRiskReportForm(args.result));
          // A dispatched actor answers to the run in its parent conversation; the coordinator carrying
          // a phase answers to its own. When that run is at this phase, the links are checked too,
          // with the run's own validators. Any lookup failure leaves the check about form alone.
          let held: HeldReportContext | undefined;
          try {
            const owner = context.agent === COORDINATOR ? context.sessionID : (await inspector.nativeActor(context.sessionID, context.agent)).session.parentID;
            if (typeof owner === 'string') held = runner.reportContext(owner, args.phase as Phase);
          } catch { held = undefined; }
          return statusPayload(checkReportForm(args.phase as Phase, args.result, held));
        },
      }),
      mdd_status: tool({
        description: 'Read this actual parent session MDD state; never retries, resets, or approves a phase. Read it after a native question, a settled task or a tool error; every other workflow tool already replies with this same status, so do not read it right after one. Returns the compact view: the state machine, the next call, the task to dispatch, the report form when a report is yours to restate, and any rejected report waiting to be restated. Reference material is left out and listed in omitted, because every reply stays in this conversation and is re-read on each later turn. With no run here, workspaceRuns lists earlier runs recorded by other conversations in this workspace and how each resumes: read it before a fresh mdd_adapt entry. Pass detail="full" only when you actually have to inspect the held acceptance map, decisions, plan, concerns, artifacts or run history — a full snapshot is re-read on every later turn of this conversation. Pass detail="rejected" when rejected.textOmitted says a rejected report was too large to ship with the rest: it returns that report alone, with its reason and resultFormat.',
        args: { detail: tool.schema.enum(['compact', 'full', 'rejected']).optional().describe('compact (default) returns protocol fields and what the next call needs; full adds the held workflow snapshot, acceptance, decisions, plan, concerns, artifacts and previous runs; rejected returns only the rejected report waiting to be restated, its reason and the report form.') },
        async execute(args, context) {
          enter(context, 'mdd_status');
          const moved = runner.movedAway(context.sessionID);
          if (moved) return reply({ state: 'transferred', sessionID: context.sessionID, task: undefined, question: undefined,
            transfer: { state: 'source-retired', targetSessionID: moved.targetSessionID, runID: moved.runID },
            reason: movedMessage(moved.runID, moved.targetSessionID) }, args.detail ?? 'compact');
          let resumed: Awaited<ReturnType<typeof runner.restore>>;
          try { resumed = await runner.restore(nativeRuntime(context), project => intake.boundRunMemory(context, project)); }
          catch { return reply({ state: 'recovery-blocked', sessionID: context.sessionID, task: undefined, ...ambiguousTransfer(context.sessionID, true),
            reason: 'Durable run owner cannot be confirmed for this parent; no task or question was exposed.' }, args.detail ?? 'compact'); }
          try { if (resumed.restored) intake.recover(context); }
          catch { return reply({ state: 'recovery-blocked', sessionID: context.sessionID, task: undefined,
            reason: 'Native question recovery could not be confirmed; do not ask, approve or dispatch. Inspect local question and checkpoint files.' }, args.detail ?? 'compact'); }
          const status = record(intake.status(context.sessionID), 'status');
          let adaptiveRecord: ReturnType<AdaptiveStore['read']>;
          try { adaptiveRecord = runner.options.adaptiveStore!.read(context.sessionID); }
          catch { return reply({ state: 'recovery-blocked', reason: 'Adaptive journal cannot be read safely; no run may start or dispatch.' }); }
          if (adaptiveRecord && resumed.reason && adaptiveRecord.data.state !== 'await-result' && !adaptiveRecord.transfer)
            return reply({ lane: 'adaptive-native', routingVersion: 3, registration: 'active', state: 'recovery-blocked', reason: resumed.reason,
              operations: [], details: {}, assurance: 'Unconfirmed publication grants no execution authority.' });
          if (adaptiveRecord || status.lane === 'adaptive-low-internal') return adaptiveReply(context);
          let targetCheckpointPresent = true;
          try { targetCheckpointPresent = !!checkpoint?.read(context.sessionID); }
          catch { /* A corrupt checkpoint must keep the restore failure, not look like an empty target. */ }
          if (!resumed.restored && !targetCheckpointPresent && status.state === 'not-started' && (ambiguousTransfer(context.sessionID).transfer as { state?: string } | undefined)?.state === 'ambiguous')
            return reply({ ...status, state: 'recovery-blocked', task: undefined, question: undefined,
              next: { kind: 'wait' }, ...ambiguousTransfer(context.sessionID),
              reason: 'A target transfer claim is unresolved. Inspect the exact source owner and target publication; do not start or dispatch.' }, args.detail ?? 'compact');
          if (resumed.reason) {
            let operationReason: string | undefined;
            try { operationReason = runner.operationCrash(context.sessionID); }
            catch { /* The checkpoint failure already blocks restoration; do not hide it. */ }
            // A pending child is where the user asks whether it still runs: say what OpenCode sees.
            let seen = {};
            try { const probe = await runner.probe(context.sessionID, context); if (probe) seen = { liveness: probe }; }
            catch { /* Status never fails because a probe did. */ }
            return reply({ ...status, state: 'recovery-blocked', task: undefined, ...ambiguousTransfer(context.sessionID, true), ...seen,
              next: { kind: 'wait' }, reason: operationReason ?? resumed.reason }, args.detail ?? 'compact');
          }
          let recovery = {};
          // A live intake in this session is the answer: probing native history there could only
          // report an unrecoverable objective for a run that is healthy and waiting for an answer.
          const live = status.question !== undefined || status.next !== undefined;
          if (!live && runner.status(context.sessionID).state === 'not-started' && !status.pendingStart) {
            try {
              const pending = await inspector.setupPending!(context);
              if (pending) recovery = { pendingStart: { requirements: pending.requirements } };
            } catch { recovery = { recovery: 'unavailable', reason: 'The original objective cannot be recovered safely from native history. Restate it in a fresh parent; do not resume uncertain execution.' }; }
          }
          // Work that never reported is where the user asks "is it still running?", so status
          // answers with what OpenCode actually says instead of leaving it to be guessed.
          let liveness = {};
          if (['recovery-blocked', 'await-result'].includes(String(status.state))) {
            try { const seen = await runner.probe(context.sessionID, context); if (seen) liveness = { liveness: seen }; }
            catch { /* Status never fails because a probe did. */ }
          }
          // With no run here, the question worth answering before any start is whether this
          // workspace already holds the work being asked for. Only an idle conversation pays for
          // the listing; a live run never re-reads other conversations' records on every turn.
          let recorded = {};
          if (['not-started', 'recoverable'].includes(String(status.state)) && !live) {
            const runs = workspaceRuns(context, { dossier, checkpoint, progress: new ProgressGuard(dataRoot), ownership });
            if (runs.length) recorded = { workspaceRuns: runs };
          }
          let native = {};
          if (status.state === 'not-started' && !targetCheckpointPresent && !status.pendingStart &&
              !('pendingStart' in recovery) && !('recovery' in recovery)) {
            try { native = record(await intake.adaptiveStatus(nativeRuntime(context))); }
            catch { return reply({ state: 'recovery-blocked', reason: 'Current native parent cannot be confirmed; no entry or dispatch was exposed.' }); }
          }
          return reply({
            ...status, ...native, ...recovery, ...liveness, ...recorded,
            ...(() => { const receipt = runner.owner(context.sessionID)?.receipt;
              return receipt ? { transfer: { state: 'confirmed', sourceSessionID: receipt.sourceSessionID, operationID: receipt.operationID } } : ambiguousTransfer(context.sessionID); })(),
            runtime: { sessionID: context.sessionID, directory: context.directory, worktree: context.worktree, agent: context.agent },
          }, args.detail ?? 'compact');
        },
      }),
      mdd_reset: tool({
        description: 'Release stopped MDD work in this conversation. Scope phase retries; scope rework returns a recorded failed Verify, design or tasks to an earlier phase (status.reworkTargets, recommended status.reworkable); scope continue preserves a durably settled failed Verify and retires its active stop without PASS, a next phase, or permission for new work; scope run discards the active run. Rework and continue require exact latest userText; continue also requires the failed runID. A clear fresh objective uses a new mdd_adapt entry. Continue never attests a child stopped and cannot release pending actors, questions or transfers. For other scopes, interrupted-child recovery requires actual latest user text saying the child stopped; native liveness still applies.',
        args: {
          scope: tool.schema.enum(['phase', 'run', 'rework', 'continue']).describe('phase retries; rework sends a failed Verify, design or tasks back to an earlier phase; continue archives settled failed Verify and frees this conversation without PASS or next work; run discards run state.'),
          phase: tool.schema.enum(['mdd-apply', 'mdd-plan', 'mdd-spec', 'mdd-design']).optional().describe('Only for scope rework: the phase the user chose from status.reworkTargets. Omitted, a failed Verify returns to mdd-apply and a failed design or tasks to status.reworkable.'),
          runID: tool.schema.string().min(1).optional().describe('Required for continue: the exact failed runID from status.'),
          userText: tool.schema.string().min(1).optional().describe('Required for rework or continue: the exact latest native request choosing that action. Continuation is not stopped-child attestation. For other scopes, provide only when the user says an interrupted subagent stopped. Never rewrite it.'),
        },
        async execute(args, context) {
          enter(context, 'mdd_reset');
          if (args.scope === 'continue') {
            if (context.abort.aborted || !args.runID || !args.userText) throw new Error('Continue requires runID and the exact latest native userText; nothing was released.');
            intake.assertContinuationIdle(context.sessionID);
            // A request to proceed is never stopped-child attestation. Do not enter recovery,
            // abort a child, release a question, or take over a crashed operation on this path.
            runner.authorizeReset(context.sessionID, false);
            return runner.withReset(context.sessionID, async () => {
              const userMessageID = await inspector.intake(context, nonemptyText(args.userText, 'continuation request'), context.messageID);
              if (context.abort.aborted || !userMessageID) throw new Error('The continuation request could not be confirmed.');
              await runner.restore(context, project => intake.boundRunMemory(context, project));
              return reply(intake.reset(context, 'continue', { runID: args.runID!, userMessageID, userText: args.userText!, kind: 'continue' }));
            });
          }
          const discard = args.scope === 'run';
          // The run left for another conversation: only freeing this one is meaningful here, and it
          // needs no attestation because nothing of that run can be touched from this side.
          const moved = runner.movedAway(context.sessionID);
          if (moved) {
            if (!discard) throw new Error(movedMessage(moved.runID, moved.targetSessionID));
            const preserved = runner.retireMovedAway(context.sessionID);
            intake.forgetMovedAway(context.sessionID);
            return reply({ ...record(intake.status(context.sessionID), 'status'),
              reset: { scope: 'run', movedTo: moved.targetSessionID, ...(preserved ? { preserved } : {}) } });
          }
          if (discard && ownership?.parentClaim(context.sessionID)?.transfer &&
              ownership.read(ownership.parentClaim(context.sessionID)!.runID)?.receipt?.targetSessionID === context.sessionID &&
              args.userText === undefined)
            throw new Error('Discarding a transferred target requires the exact latest native user request in userText. The source will not be reactivated.');
          if (args.scope === 'rework' && args.userText === undefined) throw new Error('Rework changes the route, so it needs the user\'s own word: pass userText with their exact latest message asking to fix what verification found. Nothing was changed.');
          if (args.phase !== undefined && args.scope !== 'rework') throw new Error('phase names a rework target and is accepted only with scope rework. Nothing was changed.');
          let attested = false;
          if (args.userText !== undefined) {
            if (context.abort.aborted) throw new Error('The reset was aborted.');
            // The same proof mdd_improve and change requests require: the user's word releases a
            // subagent, or sends a run back to Apply, only when it is the user's actual latest
            // message, never the model's summary.
            try { await inspector.intake(context, nonemptyText(args.userText, 'user confirmation'), context.messageID); }
            catch { throw new Error('userText must be the user\'s exact latest message in this conversation, unchanged. Nothing was released.'); }
            // A request to correct the implementation says nothing about a subagent having stopped.
            attested = args.scope !== 'rework';
          }
          // Which held writer this reset has to account for: a checkpointed pending child, a
          // native question, or otherwise a reservation whose process died without releasing it.
          const pendingTask = !!runner.pendingOwner(context.sessionID);
          const pendingQuestion = !pendingTask && intake.pendingQuestionOwner(context.sessionID);
          const crash = pendingTask || pendingQuestion ? undefined : runner.crashedOperation(context.sessionID);
          if (crash) {
            if (!attested) throw new Error(`${crash.message} To release it, pass userText with the user's exact latest message confirming that nothing is still running. Nothing was changed.`);
            if (!crash.unchanged && !discard) throw new Error(`${crash.message} Because its checkpoint changed, only a run discard is allowed (scope run): the run's evidence is set aside, never replayed. Nothing was changed.`);
            runner.releaseCrashedOperation(context.sessionID, crash.owner);
          }
          if (!pendingTask && !pendingQuestion) runner.authorizeReset(context.sessionID, discard);
          return runner.withReset(context.sessionID, async resetCallID => {
          const questionReleased = intake.releasePendingQuestion(context.sessionID, attested, resetCallID);
          const seen = await runner.confirmStopped(context.sessionID, context, attested, resetCallID);
          if (!seen || seen.verdict === 'stopped' || (attested && seen.verdict !== 'running')) runner.authorizeReset(context.sessionID, discard);
          if (!discard) await runner.restore(context, project => intake.boundRunMemory(context, project));
          try {
            if (questionReleased) intake.recover(context);
            const reset = record(intake.reset(context, args.scope, undefined, args.phase as Phase | undefined), 'reset');
            const reviewing = questionReleased && args.scope === 'phase' && record(intake.status(context.sessionID), 'status').state === 'review-ready';
            const ready = reviewing ? record(intake.prepareAdvance({ questions: [] }, context), 'question recovery') : reset;
            return reply({ ...ready, ...(seen ? { liveness: seen } : {}) });
          }
          catch (error) {
            if (!seen || seen.verdict === 'stopped') throw error;
            throw new Error(`${error instanceof Error ? error.message : 'Reset was refused.'} What OpenCode reports: ${seen.detail}`);
          }
          }, discard);
        },
      }),
      mdd_artifact_read: tool({
        description: 'Read a bounded UTF-8 page of retained history for this exact active dispatched child. Document is history:N or context:N (zero-based); digest must match the retained artifact. No file paths, serialized refs or caller identities are accepted. This grants no workflow control.',
        args: { document: tool.schema.string(), digest: tool.schema.string(), offset: tool.schema.number().int().min(0),
          limit: tool.schema.number().int().min(4).max(8192) },
        async execute(args, context) {
          await security.enforce(context.sessionID, ARTIFACT_READ_TOOL, args, context.agent);
          if (context.abort.aborted) throw new Error('Retained artifact read requires a live native invocation.');
          const callID = (context as typeof context & { callID?: string }).callID;
          const chunk = await runner.readArtifact(args, { ...nativeRuntime(context), messageID: context.messageID, ...(callID ? { callID } : {}) });
          if (context.abort.aborted) throw new Error('Retained artifact read was aborted.');
          return JSON.stringify(chunk);
        },
      }),
      mdd_contextual_explore: tool({
        description: 'Request one useful read-only investigation, with or without an accepted run. Use it for information-only questions instead of stopping. Never starts implementation and never changes the main route, answers or pending approval. Returns exact native task arguments through status.',
        args: { purpose: tool.schema.string().min(1), workItems: tool.schema.array(explorationWorkItemSchema()).max(2).optional() },
        async execute(args, context) {
          enter(context, 'mdd_contextual_explore');
          if (context.abort.aborted) throw new Error('Contextual exploration was aborted.');
          return reply(await intake.explore(args, context));
        },
      }),
    },
    // Normal actors retain native tool decisions. Standalone judges have an immutable-only
    // boundary; phase tasks and consent questions keep their existing workflow observation.
    'tool.execute.before': async (input, output) => {
      await security.enforce(input.sessionID, input.tool, output.args);
      if (!free && nativeChildren.has(input.sessionID) && (['task', 'skill', CHECK_TOOL].includes(input.tool) || input.tool.startsWith('mdd_') && !['mdd_worker_edit', ARTIFACT_READ_TOOL].includes(input.tool))) {
        throw new Error('A tracked native fallback must work directly and return its report to the parent. Recursive orchestration, skill loading, and MDD tools are not allowed.');
      }
      // V2 supplies the live hook actor before its assistant history necessarily catches up.
      const liveAgent = (input as typeof input & { agent?: string }).agent;
      const actor = await inspector.nativeActor(input.sessionID, liveAgent);
      if (input.tool === ARTIFACT_READ_TOOL) {
        if (liveAgent !== undefined && liveAgent !== actor.agent) throw new Error('Retained artifact read native actor differs.');
        const messageID = (input as typeof input & { messageID?: string }).messageID;
        await runner.readArtifact(output.args, { sessionID: input.sessionID, agent: actor.agent, directory: inputDirectory,
          worktree: inputWorktree, ...(messageID ? { messageID } : {}), callID: input.callID });
        return;
      }
      if (isJudge(actor.agent) || isJudge(liveAgent)) judgeSessions.add(input.sessionID);
      if (judgeSessions.has(input.sessionID)) {
        if (input.tool !== JD_INSPECT) throw new Error('A judge may use only immutable Git inspection; live reads, shell, delegation, memory and other tools are denied.');
        return;
      }
      if (actor.agent === JD_FIX || liveAgent === JD_FIX) {
        const parent = actor.session.parentID;
        if (typeof parent !== 'string') throw new Error('Standalone correction requires its native parent.');
        guardStandalone(parent, true);
        if (!standaloneFixes.has(parent) || actor.session.directory !== inputDirectory || actor.session.projectID !== inputProjectID)
          throw new Error('Standalone correction requires an admitted native fix task in this workspace.');
        if (!['read', 'glob', 'grep', 'edit', 'write', 'apply_patch', 'bash'].includes(input.tool))
          throw new Error('The bounded fix actor cannot delegate, write memory or invoke unrelated tools.');
        return;
      }
      // Guards off: a task or question MDD did not issue is the caller's own. It runs untouched,
      // whatever MDD is holding in this conversation, and its result never reaches MDD either.
      if (free && (input.tool === 'task' ? foreignTask(input.sessionID, output.args)
        : input.tool === 'question' && !claimsQuestion(input, output.args))) {
        freeCalls.add(standaloneKey(input.sessionID, input.callID));
        return;
      }
      if (standaloneFixes.has(input.sessionID) && ['task', 'question'].includes(input.tool))
        throw new Error('Standalone correction is in flight; wait for its result.');
      if (input.tool === 'question') {
        security.control(input.sessionID);
        if (pendingStandalone(input.sessionID)) throw new Error('Standalone work is in flight; wait before another native interaction.');
        return intake.beforeQuestion(input, output.args);
      }
      if (input.tool !== 'task') return;
      const auditTask = output.args as { subagent_type?: unknown; prompt?: unknown };
      if (security.pending(input.sessionID) || auditTask?.subagent_type === SECURITY_AGENT ||
          (typeof auditTask?.prompt === 'string' && auditTask.prompt.startsWith(SECURITY_HANDLE_PREFIX))) {
        Object.assign(output.args, await security.before(input, output.args));
        return;
      }
      const standalone = judgmentTask(output.args);
      if (pendingStandalone(input.sessionID) && (!standalone || standalone.subagent_type === JD_FIX))
        throw new Error('Standalone work is in flight; wait before another actor or correction.');
      if (standalone) {
        guardStandalone(input.sessionID, standalone.subagent_type === JD_FIX);
        await inspector.parent({ sessionID: input.sessionID, directory: inputDirectory, worktree: inputWorktree, agent: COORDINATOR });
        guardStandalone(input.sessionID, standalone.subagent_type === JD_FIX);
        if (standalone.subagent_type === JD_FIX && pendingStandalone(input.sessionID))
          throw new Error('Standalone work is in flight; wait before correction.');
        if (standaloneFixes.has(input.sessionID)) throw new Error('Standalone correction is in flight; wait for its result.');
        boundedText(input.callID, 'native callID', 256);
        const key = standaloneKey(input.sessionID, input.callID);
        if (standaloneCalls.has(key)) throw new Error('Standalone native call ID already admitted.');
        standaloneCalls.set(key, { args: { ...standalone }, settled: false });
        if (standalone.subagent_type === JD_FIX) standaloneFixes.add(input.sessionID);
        return;
      }
      // An MDD conversation dispatches MDD phases. Reaching past them into the shared registry is
      // refused here rather than discouraged in a prompt, because the agent that answers an
      // unrelated name runs under instructions MDD never wrote and reports evidence MDD cannot
      // account for. Conversations MDD is not running are untouched: this only speaks for its own.
      // Exact runner-issued arguments authorize a fallback, never the native agent name alone.
      runner.owner(input.sessionID);
      intake.guardTask(input.sessionID);
      await runner.before(input, output.args, args => {
        const assignment = workerHost?.assignment?.(input.sessionID, input.callID);
        if (assignment && workerHost) {
          const messageID = (input as typeof input & { messageID?: string }).messageID;
          if (!messageID) throw new Error('Native worker needs its exact assistant message identity.');
          workerHost.fence.admit(input.sessionID, messageID, input.callID, assignment, () => {
            try {
              const current = workerHost.assignment?.(input.sessionID, input.callID);
              return !!current && isDeepStrictEqual(current, assignment);
            } catch { return false; }
          });
        }
        Object.assign(output.args, args);
      });
    },
    'tool.execute.after': async (input, output) => {
      if (freeCalls.delete(standaloneKey(input.sessionID, input.callID))) return;
      const standalone = standaloneCalls.get(standaloneKey(input.sessionID, input.callID));
      if (input.tool === 'task' && (standalone || judgmentTask(input.args))) {
        if (!standalone || !isDeepStrictEqual(standalone.args, input.args)) throw new Error('Standalone result does not match its admitted native task.');
        if (standalone.settled) return;
        try { guardStandalone(input.sessionID, standalone.args.subagent_type === JD_FIX); }
        finally { settleStandalone(input.sessionID, input.callID); }
        return;
      }
      if (input.tool === 'question') {
        security.control(input.sessionID);
        if (pendingStandalone(input.sessionID) || standaloneFixes.has(input.sessionID))
          throw new Error('Standalone work is in flight; wait before another native interaction.');
        await intake.afterQuestion(input, input.args, output);
      }
      if (input.tool === 'task') {
        const auditTask = input.args as { subagent_type?: unknown; prompt?: unknown };
        if (security.ownsCall(input) || auditTask?.subagent_type === SECURITY_AGENT ||
            (typeof auditTask?.prompt === 'string' && auditTask.prompt.startsWith(SECURITY_HANDLE_PREFIX))) {
          const result = await security.after(input, input.args, output);
          output.title = 'MDD security assessment';
          output.output = JSON.stringify(result);
          output.metadata = {};
          Object.assign(output, { attachments: [] });
          return;
        }
        runner.owner(input.sessionID, input.callID);
        try {
          const previousState = runner.status(input.sessionID).state;
          // A rejected report (malformed, exhausted, or otherwise) may still have settled the
          // workflow at a state with its own native recovery, such as blocked-risk after an
          // exhausted mdd-risk fallback; that recovery is armed here too, not only on success.
          try { await runner.after(input, input.args, output); }
          catch (error) { intake.storageFailed(input.sessionID); throw error; }
          finally { try { intake.phaseRecorded(input.sessionID); } catch { /* best effort re-arm; the original outcome still propagates. */ } }
          const current = runner.status(input.sessionID);
          if ('lane' in current && current.lane === 'adaptive-low-internal') {
            const record = runner.options.adaptiveStore!.read(input.sessionID)!;
            output.output = await adaptiveReply({ sessionID: input.sessionID, agent: COORDINATOR,
              directory: record.directory, worktree: record.worktree });
            output.metadata = {};
          }
          const phase = typeof input.args === 'object' && input.args !== null && 'subagent_type' in input.args &&
            DISPATCHED_AGENTS.includes(String(input.args.subagent_type)) ? input.args.subagent_type as Phase | typeof RISK_AGENT : undefined;
          if (phase) {
            output.title = visualTitle(phase, presentationSettings().ascii);
            const state = current.state;
            if (state !== previousState && (state === 'complete' || state === 'blocked' || state === 'await-approval'))
              await notify(input.sessionID, `MDD ${state === 'complete' ? 'complete' : state === 'blocked' ? 'needs attention' : 'awaiting approval'}`, state === 'complete' ? 'success' : state === 'blocked' ? 'error' : 'info');
          }
        } finally { workerHost?.fence.settle(input.callID); runner.releaseSettled(input.sessionID, input.callID); }
      }
    },
    // The handle keeps the phase prompt out of the message the coordinator writes; this keeps it
    // out of every message the coordinator reads afterwards. See src/dispatch-transcript.ts for
    // why both halves are needed, and why only settled dispatches are touched.
    'experimental.chat.messages.transform': async (_input, output) => {
      try { collapseDispatchPrompts(output.messages, DISPATCHED_AGENTS, (sessionID, callID, args) => runner.ownsNativePrompt(sessionID, callID, args)); }
      // A transcript optimization that can fail a turn is worse than the tokens it saves.
      catch { /* the untouched messages are still correct, only larger */ }
      // Status replies a later one replaced; see src/status-transcript.ts.
      try { collapseSupersededStatus(output.messages); }
      catch { /* the untouched messages are still correct, only larger */ }
    },
    event: async ({ event }) => {
      if (event.type === 'session.created') {
        const child = event.properties.info;
        if (child.parentID && runner.nativePending(child.parentID)) nativeChildren.add(child.id);
        if (isJudge((child as unknown as Record<string, unknown>).agent)) judgeSessions.add(child.id);
      }
      if (event.type === 'server.instance.disposed' && event.properties.directory === input.directory) { await intake.close(); return; }
      // The host replaced this conversation with a summary. MDD's own state is untouched, because
      // none of it was ever kept in the transcript; the coordinator's memory of the protocol is
      // not so lucky. Recording it is what lets the next status restate the run instead of
      // letting a model reconstruct it from a summary that was never written for that purpose.
      if (event.type === 'session.compacted') { runner.owner(event.properties.sessionID); runner.compacted(event.properties.sessionID); return; }
      if (event.type !== 'message.part.updated') return;
      const part = event.properties.part;
      if (part.type === 'tool' && ['task', 'question'].includes(part.tool) && part.state.status === 'error' &&
          freeCalls.delete(standaloneKey(part.sessionID, part.callID))) return;
      if (part.type === 'tool' && part.tool === 'task' && part.state.status === 'error') {
        if (security.failed(part)) return;
        if (settleStandalone(part.sessionID, part.callID)) return;
        runner.owner(part.sessionID, part.callID);
        await runner.nativeError(part.sessionID, part.callID);
        runner.releaseSettled(part.sessionID, part.callID);
      }
      if (part.type === 'tool' && part.tool === 'question' && part.state.status === 'error') { runner.owner(part.sessionID, part.callID); intake.nativeError(part); }
    },
  };
  // Tools are created once at plugin startup. A scoped lease wraps their entire execution,
  // including native inspection and persistence awaits, rather than only checking entry/exit.
  // Status and pure report checks do not mutate run authority; reset has its own pending-child
  // recovery path and cannot acquire an idle lease over an already reserved child.
  // Read-only tools (status, improvement listing, PR drafting, recording a lesson in the local
  // lessons file) never write a checkpoint, so they never hold the durable writer. Transfer and
  // its recovery manage their own fenced reservations.
  for (const name of MDD_TOOLS) {
    if (['mdd_adapt', 'mdd_security', 'mdd_status', 'mdd_reset', 'mdd_improvements', 'mdd_improve', 'mdd_pr_body'].includes(name)) continue;
    const registered = hooks.tool![name]!;
    const execute = registered.execute;
    registered.execute = (async (args: never, context: { sessionID: string }) =>
      runner.withOperation(context.sessionID, name, () => execute(args, context as never))) as typeof execute;
  }
  // Share only provenance enforcement with the V2 adapter, before its location/role exits.
  Object.assign(hooks, { [SECURITY_RUNTIME_GUARD]: (sessionID: string, name: string, args: unknown, agent?: string) =>
    security.enforce(sessionID, name, args, agent) });
  return hooks;
};

/** Internal legacy motor entrypoint retained for contract regression tests. */
export const createLegacyPlugin = plugin;
export default {
  ...V2Plugin.define({ id: 'mdd', setup: context => setupV2(context, plugin) }),
  server: plugin,
};
