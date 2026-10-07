import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Runtime, TaskCall } from './phase-runner.js';
import type { IntakeInspect } from './native-intake.js';
import { mddInstructions, packagedSkillPath } from './phase-assets.js';
import { captureSecuritySnapshot, securitySnapshotPrompt, checkBoundSecurityReport } from './security-snapshot.js';
import type { SecuritySnapshot } from './security-snapshot.js';
import { securityReportFormatLines } from './security.js';

export const SECURITY_AGENT = 'mdd-security';
export const SECURITY_HANDLE_PREFIX = 'mdd:security:';
/** Internal adapter capability, never registered as a model-callable tool. */
export const SECURITY_RUNTIME_GUARD = Symbol('mdd-security-runtime-guard');
export type SecurityRuntimeHooks = {
  [SECURITY_RUNTIME_GUARD]?: (sessionID: string, tool: string, args: unknown, claimedAgent?: string) => Promise<boolean>;
};
type TaskArgs = { subagent_type: string; description: string; prompt: string };
export type SecurityBinding = { runtime: Runtime; userText: string; userMessageID: string; task: TaskArgs; full: TaskArgs; callID?: string; childID?: string };
export type SecurityInspect = Pick<IntakeInspect, 'intake'> & {
  securityCaller(runtime: Runtime, messageID: string, userText: string): Promise<void>;
  securityTask(binding: SecurityBinding, call: TaskCall, completed?: { childID: string; report: string }): Promise<void>;
  securitySession(sessionID: string): Promise<{ agent: string; parentID?: string; ancestors: string[]; directory: string; worktree: string; security: boolean }>;
  securityChild(binding: SecurityBinding, childID: string): Promise<void>;
};
type Operation = SecurityBinding & { snapshot?: SecuritySnapshot; state: 'capturing' | 'ready' | 'dispatching' | 'running' | 'checking' };
const REFUSAL = 'Security audit refused: requires a fresh explicit latest native-user request, an idle owned coordinator, a trustworthy bounded snapshot and exact dispatch binding. No audit, retry, fix or workflow change was authorized.';
const INVALID = { state: 'security-invalid', status: 'inconclusive', reason: 'Security result rejected: native binding, snapshot evidence or report form was not confirmed. No source or rejected report is echoed. No automatic retry or fix is authorized.' };

/** A closed whole-message speech act. Never strip quotes or extract a permissive clause. */
export function securityAuditRequest(text: string): boolean {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 12000) return false;
  const message = text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const noun = '(?:mdd-security|revision de seguridad|auditoria de seguridad|security audit|agente de seguridad|security agent)';
  const action = '(?:run|launch|use|perform|do|execute|hace|haz|realiza|ejecuta|lanza|usa|corre|solicito|quiero(?: que (?:hagamos|hagas))?|i want)';
  const request = `(?:(?:can|could|would) you\\s+)?${action}\\s+(?:(?:una?|a|the|el|la)\\s+)?${noun}`;
  const scope = '(?:\\s+(?:(?:of|on) (?:my|the|these|our) (?:changes|implementation)|de (?:la|esta|mi|nuestra) implementacion))?';
  const baseline = '(?:\\s+baseref=[a-z0-9][a-z0-9._/-]{0,199})?';
  // This exact non-negating context is supported; arbitrary composites require restatement.
  const context = '(?:no hay errores conocidos[,;]\\s*)?';
  const courtesy = '(?:(?:please|por favor),?\\s+)?';
  return new RegExp(`^${context}${courtesy}(?:${noun}${scope}${baseline}[.!]?|${request}${scope}${baseline}[.!?]?)$`).test(message);
}

function instructions(): string {
  const actor = fs.readFileSync(fileURLToPath(new URL('../assets/opencode/agents/mdd-security.md', import.meta.url)), 'utf8');
  if (Buffer.byteLength(actor) > 16000 || !actor.startsWith('---')) throw new Error('Invalid packaged security actor.');
  const byValue = (name: string, content: string) => `Packaged ${name} (sha256=${createHash('sha256').update(content).digest('hex')}):\n${content}`;
  return [byValue(SECURITY_AGENT, actor), byValue('MDD actor instructions', mddInstructions().content),
    ...(['mdd-doc', 'cognitive-doc-design'] as const).map(name => byValue(name, fs.readFileSync(packagedSkillPath(name), 'utf8'))),
    ...securityReportFormatLines(), 'Use only mdd_check_report with phase="mdd-security" for pure form checking. Return the full detailed artifact and structured findings.'].join('\n\n');
}

/** Process-local capabilities. Restart never reconstructs an authorization from transcript JSON. */
export class SecurityAudit {
  readonly #operations = new Map<string, Operation>();
  readonly #used = new Set<string>();
  readonly #calls = new Set<string>();
  readonly #children = new Set<string>();
  constructor(readonly inspect: SecurityInspect, readonly guard: (sessionID: string) => void) {}

  pending(sessionID: string): boolean { return this.#operations.has(sessionID); }
  ownsCall(call: TaskCall): boolean { return this.#operations.get(call.sessionID)?.callID === call.callID; }
  control(sessionID: string): void {
    if (this.pending(sessionID)) throw new Error('A standalone security audit is pending; no other actor, question or workflow control may run.');
  }
  async start(args: { userText: string; baseRef?: string | undefined }, runtime: Runtime, messageID: string): Promise<unknown> {
    this.control(runtime.sessionID);
    const operation: Operation = { runtime: { ...runtime }, userText: args.userText, userMessageID: '',
      task: { subagent_type: SECURITY_AGENT, description: 'Audit implementation security', prompt: SECURITY_HANDLE_PREFIX + randomUUID() },
      full: { subagent_type: SECURITY_AGENT, description: 'Audit implementation security', prompt: '' }, state: 'capturing' };
    this.#operations.set(runtime.sessionID, operation);
    let stage = 'authorization';
    try {
      if (runtime.agent !== 'mdd-orchestrator' || !securityAuditRequest(args.userText)) throw new Error(REFUSAL);
      const bases = [...args.userText.matchAll(/\bbaseRef=([A-Za-z0-9][A-Za-z0-9._/-]{0,199})(?=[.!]?$)/g)].map(match => match[1]);
      if ((args.baseRef === undefined && bases.length) || (args.baseRef !== undefined && (bases.length !== 1 || bases[0] !== args.baseRef))) throw new Error(REFUSAL);
      this.guard(runtime.sessionID);
      await this.inspect.securityCaller(runtime, messageID, args.userText);
      const userID = await this.inspect.intake(runtime, args.userText, messageID, 'latest');
      if (typeof userID !== 'string' || this.#used.has(`${runtime.sessionID}:${userID}`)) throw new Error(REFUSAL);
      operation.userMessageID = userID;
      this.#used.add(`${runtime.sessionID}:${userID}`);
      this.guard(runtime.sessionID);
      stage = 'snapshot';
      operation.snapshot = captureSecuritySnapshot({ root: runtime.directory, ...(args.baseRef === undefined ? {} : { baseRef: args.baseRef }) });
      operation.full.prompt = securitySnapshotPrompt(operation.snapshot, instructions());
      operation.state = 'ready';
      return { state: 'security-ready', task: { ...operation.task },
        nextAction: { tool: 'task', args: { ...operation.task }, why: 'Dispatch this single-use standalone audit once, foreground; no model or extra arguments.' },
        coverage: operation.snapshot.coverage, limitations: operation.snapshot.limitations,
        note: 'Audit findings never authorize fixes, workflow advancement, review or delivery.' };
    } catch (error) {
      this.#operations.delete(runtime.sessionID);
      return { state: 'security-refused', status: 'inconclusive', reason: REFUSAL,
        diagnostic: stage !== 'snapshot' ? 'authorization-or-state' : /limit|exceeded/i.test(error instanceof Error ? error.message : '') ? 'snapshot-limit' : 'snapshot-unavailable',
        action: 'Resolve pending interactions or restate an explicit audit request. If the local baseline or size is ambiguous, supply a user-selected baseRef; no partial scope was dispatched.' };
    }
  }
  async before(call: TaskCall, args: unknown): Promise<TaskArgs> {
    const operation = this.#operations.get(call.sessionID);
    if (!operation || operation.state !== 'ready' || !isDeepStrictEqual(args, operation.task) || this.#calls.has(call.callID) ||
        typeof call.callID !== 'string' || !call.callID.trim() || call.callID.length > 256) {
      throw new Error('Security dispatch is unbound, altered, stale or already consumed.');
    }
    operation.state = 'dispatching';
    operation.callID = call.callID;
    this.#calls.add(call.callID);
    try {
      this.guard(call.sessionID);
      await this.inspect.securityTask(operation, call);
      if (this.#operations.get(call.sessionID) !== operation) throw new Error(REFUSAL);
      operation.state = 'running';
      return { ...operation.full };
    } catch {
      this.#operations.delete(call.sessionID);
      throw new Error('Security dispatch native provenance was not confirmed. No retry was authorized.');
    }
  }
  async enforce(sessionID: string, tool: string, args: unknown, claimedAgent?: string): Promise<boolean> {
    let native: Awaited<ReturnType<SecurityInspect['securitySession']>>;
    try { native = await this.inspect.securitySession(sessionID); }
    catch { throw new Error('Security native provenance cannot be confirmed.'); }
    if (!native.agent) {
      if (this.#operations.size || this.#children.has(sessionID) || claimedAgent === SECURITY_AGENT) throw new Error('Security native session identity is unavailable.');
      return false;
    }
    const operation = native.parentID ? this.#operations.get(native.parentID) : undefined;
    const known = this.#children.has(sessionID) || native.ancestors.some(id => this.#children.has(id));
    if (known) this.#children.add(sessionID);
    if (native.agent !== SECURITY_AGENT && !native.security && !operation && !known && claimedAgent !== SECURITY_AGENT) return false;
    if (!operation || operation.state !== 'running' || native.agent !== SECURITY_AGENT ||
        (claimedAgent !== undefined && claimedAgent !== SECURITY_AGENT) ||
        native.directory !== operation.runtime.directory || native.worktree !== operation.runtime.worktree ||
        (operation.childID !== undefined && operation.childID !== sessionID)) throw new Error('Security child is unbound or its native identity changed.');
    await this.inspect.securityChild(operation, sessionID);
    if (this.#operations.get(operation.runtime.sessionID) !== operation || operation.state !== 'running') throw new Error('Security operation settled during child inspection.');
    operation.childID = sessionID;
    this.#children.add(sessionID);
    if (tool !== 'mdd_check_report' || !args || typeof args !== 'object' || Array.isArray(args) ||
        Object.keys(args).length !== 2 || (args as Record<string, unknown>).phase !== SECURITY_AGENT ||
        typeof (args as Record<string, unknown>).result !== 'string') throw new Error('Security actor may use only its pure standalone mdd_check_report form checker.');
    return true;
  }
  async after(call: TaskCall, args: unknown, output: unknown): Promise<unknown> {
    const operation = this.#operations.get(call.sessionID);
    if (!operation || operation.state !== 'running' || operation.callID !== call.callID) return { ...INVALID };
    if (!isDeepStrictEqual(args, operation.full)) { this.#operations.delete(call.sessionID); return { ...INVALID }; }
    operation.state = 'checking';
    try {
      const raw = output as { output?: unknown; metadata?: { sessionId?: unknown } };
      if (typeof raw?.output !== 'string' || Buffer.byteLength(raw.output) > 24000) throw new Error('Security result envelope exceeds its bound.');
      const match = typeof raw?.output === 'string' && /^<task id="([A-Za-z0-9_-]{1,128})" state="completed">\r?\n(?:<summary>[^\r\n]*<\/summary>\r?\n)?<task_result>\r?\n([\s\S]*?)\r?\n?<\/task_result>\r?\n?<\/task>$/.exec(raw.output.trim());
      if (!match || raw.metadata?.sessionId !== match[1] || (operation.childID && operation.childID !== match[1])) throw new Error('Unbound result.');
      this.guard(call.sessionID);
      await this.inspect.securityTask(operation, call, { childID: match[1]!, report: match[2]! });
      this.#children.add(match[1]!);
      if (this.#operations.get(call.sessionID) !== operation) throw new Error('Security operation became stale.');
      const checked = checkBoundSecurityReport(operation.snapshot!, match[2]);
      if (!checked.ok || !checked.security) return { ...INVALID };
      return { state: 'security-complete', status: checked.security.status, security: checked.security, report: match[2],
        note: 'Present the findings, coverage and limitations. This is not a safety guarantee. Wait for separate user authorization before mdd-apply; no workflow, review or delivery authority changed.' };
    } catch { return { ...INVALID }; }
    finally { this.#operations.delete(call.sessionID); }
  }
  failed(call: TaskCall): boolean {
    if (!this.ownsCall(call)) return false;
    this.#operations.delete(call.sessionID);
    return true;
  }
}
