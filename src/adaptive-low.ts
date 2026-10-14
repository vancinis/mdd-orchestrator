import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { acceptance, decisions, evidenceID, references, shortText, assertNoTraceSection } from './acceptance.js';
import type { Acceptance, Decision } from './acceptance.js';
import { applyPlan, taskIDs } from './apply-batches.js';
import { changed, plannedChecks } from './phase-evidence.js';
import type { PlannedCheck } from './phase-evidence.js';
import { parsePhaseReport, parseRiskReport } from './phase-report.js';
import { parseFutureAssessment } from './risk.js';
import type { FutureAssessment } from './risk.js';
import { applyScopeFiles, explorationFiles, parseParallelScope, scopePath } from './worker-batch.js';
import { objectWithKeys } from './validation.js';

export type AdaptiveActor = 'mdd-explore' | 'mdd-risk' | 'mdd-plan' | 'mdd-apply' | 'mdd-verify';
type Scope = { complete: true; reads: string[]; writes: string[] };
type SourceObligation = { id: string; description: string; paths: string[] };
type Assignment = { id: string; description: string; path: string; scenarios: string[]; decisions: string[];
  dependsOn: string[]; scope: Scope; obligations: { source: SourceObligation[]; checks: PlannedCheck[] } };
type Context = { technical: 'understood' | 'uncertain'; dependencies: 'bounded' | 'unknown'; reason: string;
  fingerprints: { path: string; digest: string | null }[] };
export type AdaptiveContract = { contractVersion: 1; objective: string; acceptance: Acceptance; exclusions: string[];
  decisions: Decision[]; productQuestions: string[]; scope: Scope; context: Context; assessment: FutureAssessment;
  assignments: Assignment[] };
export type AdaptiveSelection = { handle: string; actor: AdaptiveActor; assignmentID: string; purpose: string;
  context?: Context; repairOf?: string };
type Receipt = { id: string; actor: AdaptiveActor; assignmentID: string; purpose: string; outcome: 'passed' | 'failed';
  summary: string; artifact?: string; changes?: string[]; assessment?: FutureAssessment; failure?: string };
const ACTORS: readonly AdaptiveActor[] = ['mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-apply', 'mdd-verify'];
const CONTRACT_BYTES = 24000;

function texts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${label} requires at most 16 entries.`);
  return Array.from(value, item => shortText(item, label));
}
function objective(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 12000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new Error('Native objective requires exact nonempty text of at most 12000 bytes without terminal controls.');
  return value;
}
function scope(value: unknown): Scope {
  const parsed = parseParallelScope(value);
  if (parsed.complete !== true || !parsed.reads || !parsed.writes) throw new Error('Adaptive scope requires a complete exact read/write footprint.');
  return parsed as Scope;
}
function paths(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 64) throw new Error('Source evidence requires 1–64 exact paths.');
  const result = Array.from(value, scopePath);
  if (new Set(result.map(path => path.toLowerCase())).size !== result.length) throw new Error('Source evidence repeats paths.');
  return result;
}
function context(value: unknown, footprint: Scope): Context {
  const input = objectWithKeys(value, 'adaptive context', ['technical', 'dependencies', 'reason', 'fingerprints']);
  if ((input.technical !== 'understood' && input.technical !== 'uncertain') || (input.dependencies !== 'bounded' && input.dependencies !== 'unknown'))
    throw new Error('Adaptive context needs explicit technical clarity and dependency understanding.');
  const expected = [...new Set([...footprint.reads, ...footprint.writes])];
  if (!Array.isArray(input.fingerprints) || input.fingerprints.length !== expected.length) throw new Error('Source fingerprints must cover the exact contract footprint.');
  const fingerprints = Array.from(input.fingerprints, value => {
    const item = objectWithKeys(value, 'source fingerprint', ['path', 'digest']);
    const path = scopePath(item.path);
    if (!expected.includes(path) || item.digest !== null && (typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest)))
      throw new Error('Invalid source fingerprint path or digest.');
    return { path, digest: item.digest as string | null };
  });
  if (new Set(fingerprints.map(item => item.path)).size !== expected.length) throw new Error('Source fingerprints repeat a path.');
  return { technical: input.technical, dependencies: input.dependencies,
    reason: shortText(input.reason, 'source context rationale'), fingerprints };
}

/** Reconstruct validated data, including own non-enumerable fields, before any native await. */
export function adaptiveContract(value: unknown): AdaptiveContract {
  const input = objectWithKeys(value, 'adaptive contract', ['contractVersion', 'objective', 'acceptance', 'exclusions', 'decisions',
    'productQuestions', 'scope', 'context', 'assessment', 'assignments']);
  if (input.contractVersion !== 1) throw new Error('Adaptive contractVersion must be integer 1.');
  const accepted = acceptance(input.acceptance), choices = decisions(input.decisions, accepted), footprint = scope(input.scope);
  if (!footprint.writes.length) throw new Error('Adaptive contract requires a declared bounded assignment write scope.');
  if (!Array.isArray(input.assignments) || !input.assignments.length || input.assignments.length > 32) throw new Error('Adaptive contract requires 1–32 assignments.');
  const ids = new Set<string>(), obligations = new Set<string>();
  for (const item of accepted.requirements) { ids.add(item.id); item.scenarios.forEach(scenario => ids.add(scenario.id)); }
  for (const choice of choices) {
    if (ids.has(choice.id)) throw new Error('Adaptive IDs must be globally unique.');
    ids.add(choice.id);
  }
  const scenarioIDs = accepted.requirements.flatMap(item => item.scenarios.map(scenario => scenario.id));
  const assignments = Array.from(input.assignments, value => {
    const item = objectWithKeys(value, 'adaptive assignment', ['id', 'description', 'path', 'scenarios', 'decisions', 'dependsOn', 'scope', 'obligations']);
    const id = evidenceID(item.id, 'assignment ID'), own = scope(item.scope), path = scopePath(item.path);
    if (ids.has(id)) throw new Error('Adaptive IDs must be globally unique.');
    ids.add(id);
    if (!own.writes.length || !own.writes.includes(path) || own.reads.some(path => ![...footprint.reads, ...footprint.writes].includes(path)) ||
        own.writes.some(path => !footprint.writes.includes(path))) throw new Error('Assignment scope exceeds its contract or omits its implementation target.');
    const scenarios = references(item.scenarios, 'assignment scenarios'), linked = references(item.decisions, 'assignment decisions', true);
    if (scenarios.some(id => !scenarioIDs.includes(id)) || linked.some(id => !choices.some(choice => choice.id === id))) throw new Error('Assignment references unknown acceptance or decision IDs.');
    for (const id of linked) {
      const choice = choices.find(choice => choice.id === id)!;
      if (!accepted.requirements.some(requirement => choice.requirements.includes(requirement.id) && requirement.scenarios.some(scenario => scenarios.includes(scenario.id))))
        throw new Error('Assignment decision is not applicable to its scenarios.');
    }
    const evidence = objectWithKeys(item.obligations, 'evidence obligations', ['source', 'checks']);
    if (!Array.isArray(evidence.source) || evidence.source.length > 32 || !Array.isArray(evidence.checks)) throw new Error('Invalid evidence obligations.');
    const checks = evidence.checks.length ? plannedChecks(evidence.checks, obligations) : [];
    const source = Array.from(evidence.source, value => {
      const entry = objectWithKeys(value, 'source obligation', ['id', 'description', 'paths']);
      const id = evidenceID(entry.id, 'source obligation ID'), targets = paths(entry.paths);
      if (obligations.has(id)) throw new Error('Evidence obligation ID is used more than once.');
      obligations.add(id);
      if (obligations.size > 64 || targets.some(path => ![...own.reads, ...own.writes].includes(path))) throw new Error('Source obligation exceeds its assignment scope or evidence budget.');
      return { id, description: shortText(entry.description, 'source obligation'), paths: targets };
    });
    if (!source.length && !checks.length) throw new Error('Each assignment requires source or real command evidence obligations.');
    return { id, description: shortText(item.description, 'assignment description'), path, scenarios, decisions: linked,
      dependsOn: taskIDs(item.dependsOn), scope: own, obligations: { source, checks } };
  });
  applyPlan(assignments.map(({ id, dependsOn }) => ({ id, dependsOn })));
  if (assignments.reduce((count, item) => count + item.scenarios.length, 0) > 64) throw new Error('Adaptive contract exceeds 64 scenario-to-assignment links.');
  if (scenarioIDs.some(id => !assignments.some(item => item.scenarios.includes(id))) || choices.some(choice =>
    choice.requirements.some(id => !assignments.some(item => item.decisions.includes(choice.id) &&
      accepted.requirements.find(requirement => requirement.id === id)!.scenarios.some(scenario => item.scenarios.includes(scenario.id))))))
    throw new Error('Adaptive contract omits acceptance or applicable decision coverage.');
  for (const id of obligations) if (ids.has(id)) throw new Error('Adaptive IDs must be globally unique.');
  const result: AdaptiveContract = { contractVersion: 1, objective: objective(input.objective),
    acceptance: accepted, exclusions: texts(input.exclusions, 'exclusions'), decisions: choices,
    productQuestions: texts(input.productQuestions, 'product questions'), scope: footprint,
    context: context(input.context, footprint), assessment: parseFutureAssessment(input.assessment), assignments };
  if (Buffer.byteLength(JSON.stringify(result)) > CONTRACT_BYTES) throw new Error('Adaptive contract exceeds its compact 24000-byte budget.');
  return result;
}

export function adaptiveSelection(value: unknown, contract: AdaptiveContract): AdaptiveSelection {
  const input = objectWithKeys(value, 'adaptive selection', ['handle', 'actor', 'assignmentID', 'purpose', 'context', 'repairOf']);
  if (!ACTORS.includes(input.actor as AdaptiveActor)) throw new Error('Select only Explore, Risk, Plan, Apply or Verify.');
  return { handle: shortText(input.handle, 'selection handle', 200), actor: input.actor as AdaptiveActor,
    assignmentID: evidenceID(input.assignmentID, 'assignment ID'), purpose: shortText(input.purpose, 'actor purpose'),
    ...(input.context !== undefined ? { context: context(input.context, contract.scope) } : {}),
    ...(input.repairOf !== undefined ? { repairOf: shortText(input.repairOf, 'repair receipt', 100) } : {}) };
}

/** File evidence is read locally under existing exact-file alias checks; credentials are excluded. */
function fingerprint(root: string, path: string): string | null {
  if (/(?:^|\/)(?:\.[^/]+|[^/]*(?:credential|secret|token|password)[^/]*|id_rsa|id_ed25519)(?:\/|$)/i.test(path))
    throw new Error('Credential or hidden source evidence is not admitted.');
  const absolute = resolve(root, path), stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat) return null;
  explorationFiles([{ root, files: [path] }]);
  if (stat.size > 256 * 1024) throw new Error('Source fingerprint exceeds the bounded file inspection budget.');
  const bytes = readFileSync(absolute), after = lstatSync(absolute);
  if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== after.size || bytes.length !== stat.size ||
      stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || !after.isFile() || after.isSymbolicLink() || after.nlink !== 1)
    throw new Error('Source changed during fingerprint inspection.');
  return createHash('sha256').update(bytes).digest('hex');
}

/** Process-local actor receipts, not a Workflow, a Plan artifact, or resumable execution authority. */
export class AdaptiveLow {
  readonly #contract: AdaptiveContract;
  readonly #receipts: Receipt[] = [];
  readonly #completed = new Map<string, { path: string; digest: string | null }[]>();
  #context: Context;
  #assessment: FutureAssessment;
  #state: 'await-selection' | 'authorized-actor' | 'await-result' = 'await-selection';
  #selection: AdaptiveSelection | undefined;
  #handle = randomUUID();
  constructor(value: unknown, readonly root: string) {
    this.#contract = adaptiveContract(value); this.#context = this.#contract.context; this.#assessment = this.#contract.assessment;
    applyScopeFiles(root, this.#contract.scope); this.assertCurrent();
  }
  get state() { return this.#state; }
  contract(): AdaptiveContract { return structuredClone({ ...this.#contract, context: this.#context, assessment: this.#assessment }); }
  selection(): AdaptiveSelection | undefined { return structuredClone(this.#selection); }
  assignment(): Assignment | undefined { return structuredClone(this.#contract.assignments.find(item => item.id === this.#selection?.assignmentID)); }
  readFiles(): string[] {
    const own = this.assignment()!.scope;
    const files = [...new Set([...own.reads, ...own.writes])].filter(path => lstatSync(resolve(this.root, path), { throwIfNoEntry: false }));
    explorationFiles([{ root: this.root, files }]);
    return files;
  }
  assertCurrent(footprint = this.#contract.scope, evidence = this.#context): void {
    applyScopeFiles(this.root, footprint);
    for (const path of new Set([...footprint.reads, ...footprint.writes])) {
      if (footprint.reads.includes(path)) explorationFiles([{ root: this.root, files: [path] }]);
      if (fingerprint(this.root, path) !== evidence.fingerprints.find(item => item.path === path)?.digest)
        throw new Error(`Source fingerprint is stale for ${path}; inspect current source context before Apply.`);
    }
  }
  #assertPrerequisites(assignment: Assignment): void {
    if (assignment.dependsOn.some(id => !this.#completed.has(id))) throw new Error('Apply prerequisites have not completed.');
    for (const id of assignment.dependsOn) for (const item of this.#completed.get(id)!)
      if (fingerprint(this.root, item.path) !== item.digest) throw new Error('Completed prerequisite source is stale.');
  }
  select(value: AdaptiveSelection): void {
    if (value.handle !== this.#handle) throw new Error('Selection handle is stale or was consumed.');
    if (this.#state !== 'await-selection') throw new Error('Selection requires an actorless boundary; a task is already authorized or in flight.');
    if (this.#receipts.length >= 64) throw new Error('Volatile receipt budget is exhausted; no automatic closure or escalation.');
    if (this.#contract.productQuestions.length) throw new Error('Unresolved product ambiguity pauses actor selection.');
    const assignment = this.#contract.assignments.find(item => item.id === value.assignmentID);
    if (!assignment) throw new Error('Unknown adaptive assignment.');
    const current = value.context ?? this.#context;
    if (current.technical === 'uncertain' && value.actor !== 'mdd-explore') throw new Error('Uncertain technical context permits only a brief Explore, never writes.');
    if (value.context) this.assertCurrent(this.#contract.scope, current);
    if (value.actor === 'mdd-apply') {
      if (this.#assessment.impact !== 'low') throw new Error('Apply requires low impact independent of complexity or scope size.');
      if (current.dependencies !== 'bounded') throw new Error('Apply requires understood bounded dependencies.');
      if (this.#completed.has(assignment.id)) throw new Error('Completed Apply cannot be automatically repeated.');
      this.#assertPrerequisites(assignment);
      const prior = this.#receipts.findLast(receipt => receipt.actor === 'mdd-apply' && receipt.assignmentID === assignment.id);
      if (prior && value.repairOf !== prior.id) throw new Error('A repeated writer requires an explicit repairOf the last actual Apply receipt.');
      if (value.repairOf && !prior) throw new Error('Repair receipt is not an actual Apply attempt.');
      this.assertCurrent(assignment.scope, current);
    }
    this.#context = structuredClone(current); this.#selection = structuredClone(value); this.#state = 'authorized-actor';
  }
  assertReady(): void {
    if (this.#state !== 'authorized-actor') throw new Error('Adaptive actor is not ready.');
    if (this.#selection!.actor === 'mdd-apply') {
      const assignment = this.assignment()!;
      this.#assertPrerequisites(assignment); this.assertCurrent(assignment.scope);
    }
  }
  begin(): void {
    this.assertReady();
    this.#state = 'await-result';
  }
  cancelAuthorization(): void {
    if (this.#state !== 'authorized-actor') throw new Error('An executed actor cannot be cancelled as an unstarted selection.');
    this.#selection = undefined; this.#handle = randomUUID(); this.#state = 'await-selection';
  }
  settle(text: string | undefined, runID: string, callID: string, failure?: string): void {
    if (this.#state !== 'await-result') throw new Error('Receipt does not match an active adaptive dispatch.');
    const selected = this.#selection!, assignment = this.assignment()!;
    let receipt: Receipt = { id: randomUUID(), actor: selected.actor, assignmentID: assignment.id, purpose: selected.purpose,
      outcome: 'failed', summary: 'The actual actor did not produce an accepted receipt.' };
    try {
      if (failure || text === undefined) throw new Error(failure ?? 'Native result inspection failed.');
      const fields = selected.actor === 'mdd-risk' ? parseRiskReport(text) : parsePhaseReport(text, selected.actor);
      const input = objectWithKeys(fields, 'adaptive actor receipt', ['outcome', 'evidenceSummary', 'artifact', 'phase', 'runID', 'callID',
        'how', 'purpose', 'openItems', 'learnings', 'confidence', ...(selected.actor === 'mdd-apply' ? ['completed', 'changes', 'noChangeReason', 'checks'] : []),
        ...(selected.actor === 'mdd-risk' ? ['assessment'] : [])]);
      if (input.phase !== undefined && input.phase !== selected.actor || input.runID !== undefined && input.runID !== runID ||
          input.callID !== undefined && input.callID !== callID) throw new Error('Receipt is bound to another actor, run or native call.');
      if (input.outcome !== 'passed' && input.outcome !== 'failed') throw new Error('Receipt outcome must be passed or failed.');
      const artifact = typeof input.artifact === 'string' && input.artifact.trim() && Buffer.byteLength(input.artifact) <= 12000 ? input.artifact : undefined;
      if (!artifact) throw new Error('Receipt requires a bounded actual artifact.');
      assertNoTraceSection(artifact);
      receipt = { ...receipt, outcome: input.outcome, summary: shortText(input.evidenceSummary, 'actor summary'), artifact };
      if (selected.actor === 'mdd-risk') {
        receipt.assessment = parseFutureAssessment(input.assessment);
        if (input.outcome === 'passed') this.#assessment = receipt.assessment;
      }
      if (selected.actor === 'mdd-apply') {
        if (input.checks !== undefined && (!Array.isArray(input.checks) || input.checks.length)) throw new Error('Scoped Apply cannot execute commands or claim check results.');
        const files = changed(input.changes, input.noChangeReason);
        if (files.paths.some(path => !assignment.scope.writes.includes(scopePath(path)))) throw new Error('Reported changes exceed the assigned writes.');
        receipt.changes = files.paths;
        const completed = taskIDs(input.completed);
        if (input.outcome === 'passed' && (completed.length !== 1 || completed[0] !== assignment.id) || input.outcome === 'failed' && completed.length)
          throw new Error('Apply must complete exactly its assigned ID on success, and none on failure.');
        if (input.outcome === 'passed') this.#completed.set(assignment.id,
          [...new Set([...assignment.scope.reads, ...assignment.scope.writes])].map(path => ({ path,
            // Outputs use their settled bytes; unchanged eligibility inputs retain admission evidence.
            digest: assignment.scope.writes.includes(path) ? fingerprint(this.root, path)
              : this.#context.fingerprints.find(item => item.path === path)!.digest })));
      }
    } catch (error) {
      receipt = { ...receipt, outcome: 'failed', failure: String(error instanceof Error ? error.message : error).slice(0, 500) };
    }
    this.#receipts.push(receipt); this.#selection = undefined; this.#handle = randomUUID(); this.#state = 'await-selection';
  }
  status() {
    const last = this.#receipts.at(-1);
    return { lane: 'adaptive-low-internal' as const, state: this.#state, volatile: true,
      selection: { ...(this.#state === 'await-selection' ? { handle: this.#handle } : {}), actors: [...ACTORS],
        completed: [...this.#completed.keys()], receipts: this.#receipts.length,
        context: { technical: this.#context.technical, dependencies: this.#context.dependencies, ...this.#assessment },
        assignments: this.#contract.assignments.map(item => ({ id: item.id, description: item.description.slice(0, 150),
          prerequisitesComplete: item.dependsOn.every(id => this.#completed.has(id)),
          obligations: { source: item.obligations.source.length, checks: item.obligations.checks.length, executed: 0 } })),
        ...(this.#contract.productQuestions.length ? { blocked: 'product-ambiguity' } : {}) },
      ...(this.#selection ? { actor: this.#selection.actor, assignmentID: this.#selection.assignmentID } : {}),
      ...(last ? { lastReceipt: { id: last.id, actor: last.actor, assignmentID: last.assignmentID, outcome: last.outcome,
        summary: last.summary, ...(last.failure ? { failure: last.failure } : {}) } } : {}),
      reason: 'Select the next necessary actor internally. No automatic phase, verification, completion, reset or escalation is implied.' };
  }
}
