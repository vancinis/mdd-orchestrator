import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { acceptance, decisions, evidenceID, references, shortText, assertNoTraceSection, checkAccounting } from './acceptance.js';
import type { Acceptance, Decision } from './acceptance.js';
import { applyPlan, taskIDs } from './apply-batches.js';
import { changed, plannedChecks, executed } from './phase-evidence.js';
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
const ASSURANCE = 'Structured parent-reported consistency, not independent execution attestation. Local declared source bytes are bound; whole-worktree diff inventory is a reported observation, not comprehensive attestation.';
type Snapshot = { id: string; sources: { path: string; digest: string | null; content: string | null }[] };
type SourceAssessment = { id: string; paths: string[]; status: 'verified' | 'not-verified' | 'deviation'; assessment: string };
type SemanticAssessment = { status: SourceAssessment['status']; sources: string[]; checks: string[]; assessment: string };
type EvidenceReport = { snapshotID: string; readback: { acceptance: Acceptance; scope: Scope; exclusions: string[]; decisions: Decision[] };
  inventory: { path: string; disposition: 'assignment' | 'unrelated'; reason: string }[];
  exclusions: { exclusion: string; status: SourceAssessment['status']; assessment: string }[];
  sources: SourceAssessment[]; assignments: (SemanticAssessment & { assignmentID: string })[];
  scenarios: (SemanticAssessment & { requirementID: string; scenarioID: string; assignmentID: string })[];
  decisions: (SemanticAssessment & { decisionID: string })[]; checks: ReturnType<typeof executed>;
  checkResults: ReturnType<typeof checkAccounting>['checkResults']; supplementalChecks: ReturnType<typeof checkAccounting>['supplementalChecks']; limits: string[] };

function entries(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label} requires at most 64 entries.`);
  return Array.from(value);
}
function status(value: unknown): SourceAssessment['status'] {
  if (value !== 'verified' && value !== 'not-verified' && value !== 'deviation') throw new Error('Evidence needs explicit verified/not-verified/deviation status.');
  return value;
}
function exactCoverage(actual: string[], expected: string[], label: string): void {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || expected.some(id => !actual.includes(id)))
    throw new Error(`${label} must cover exactly the held links, without omissions or invented IDs.`);
}

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
  #state: 'await-selection' | 'authorized-actor' | 'await-result' | 'completed' | 'closed-unverified' = 'await-selection';
  #snapshot: Snapshot | undefined;
  #report: EvidenceReport | undefined;
  #matched = false;
  #completion: { outcome: 'verified' | 'unverified'; limits: string[] } | undefined;
  #repairs = 0;
  #invalidatedAssignments: string[] = [];
  #retainedProof: { assignmentID: string; fingerprints: { path: string; digest: string | null }[] }[] = [];
  #priorEvidence: { report: EvidenceReport; invalidatedAssignments: string[] } | undefined;
  #checkHistory: ReturnType<typeof executed> = [];
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
  assertBoundary(handle: string): void {
    if (handle !== this.#handle) throw new Error('Evidence or selection handle is stale or consumed.');
    if (this.#state !== 'await-selection') throw new Error('Evidence requires an actorless nonterminal boundary, not a completed or pending actor.');
  }
  #assertCompleted(): void {
    for (const files of this.#completed.values()) for (const file of files)
      if (fingerprint(this.root, file.path) !== file.digest) throw new Error(`Completed assignment source is stale for ${file.path}.`);
  }
  assertPreparationCurrent(): void {
    this.#assertCompleted(); applyScopeFiles(this.root, this.#contract.scope);
    explorationFiles([{ root: this.root, files: this.#contract.scope.reads }]);
  }
  assertEvidenceCurrent(): void {
    this.#assertCompleted();
    if (!this.#snapshot) throw new Error('Prepare a final source snapshot before checks and evidence submission.');
    applyScopeFiles(this.root, this.#contract.scope);
    for (const file of this.#snapshot.sources)
      if (fingerprint(this.root, file.path) !== file.digest) throw new Error(`Final source snapshot is stale for ${file.path}.`);
  }
  prepareEvidence(handle: string): void {
    this.assertBoundary(handle); this.assertPreparationCurrent();
    let bytes = 0;
    const sources = [...new Set([...this.#contract.scope.reads, ...this.#contract.scope.writes])].map(path => {
      const digest = fingerprint(this.root, path);
      const data = digest === null ? null : readFileSync(resolve(this.root, path));
      bytes += data?.length ?? 0;
      if (bytes > 1024 * 1024) throw new Error('Final source snapshot exceeds the 1 MiB inspection budget.');
      if (data && createHash('sha256').update(data).digest('hex') !== digest || fingerprint(this.root, path) !== digest)
        throw new Error('Final source snapshot changed during inspection.');
      if (data && !Buffer.from(data.toString('utf8'), 'utf8').equals(data)) throw new Error('Final source readback requires UTF-8 source, not lossy binary decoding.');
      return { path, digest, content: data?.toString('utf8') ?? null };
    });
    const drift = this.#snapshot?.sources.filter(previous => sources.find(item => item.path === previous.path)!.digest !== previous.digest).map(item => item.path) ?? [];
    if (this.#report) this.#priorEvidence = { report: structuredClone(this.#report), invalidatedAssignments: drift.length ? this.#contract.assignments.map(item => item.id) : [] };
    if (drift.length) this.#checkHistory = [];
    this.#snapshot = { id: randomUUID(), sources }; this.#report = undefined; this.#matched = false;
    this.#handle = randomUUID();
  }
  submitEvidence(handle: string, value: unknown): void {
    this.assertBoundary(handle); this.assertEvidenceCurrent();
    this.#matched = false;
    const input = objectWithKeys(value, 'adaptive evidence', ['snapshotID', 'readback', 'inventory', 'exclusions', 'sources', 'assignments',
      'scenarios', 'decisions', 'checks', 'checkResults', 'supplementalChecks', 'limits']);
    if (input.snapshotID !== this.#snapshot!.id) throw new Error('Evidence belongs to another prepared snapshot.');
    const readback = objectWithKeys(input.readback, 'parent contract readback', ['acceptance', 'scope', 'exclusions', 'decisions']);
    const expected = { acceptance: this.#contract.acceptance, scope: this.#contract.scope, exclusions: this.#contract.exclusions, decisions: this.#contract.decisions };
    if (!isDeepStrictEqual(readback, expected)) throw new Error('Parent readback must repeat exact held acceptance, scope, exclusions and decisions.');
    const checks = executed(input.checks, 1);
    if (checks.length < this.#checkHistory.length || !isDeepStrictEqual(checks.slice(0, this.#checkHistory.length), this.#checkHistory))
      throw new Error('Evidence must preserve the chronological reported execution history, including failed attempts and retries.');
    if (Buffer.byteLength(JSON.stringify(checks)) > 48000) throw new Error('Adaptive reported executions exceed the bounded evidence budget.');
    // A malformed disposition cannot erase an otherwise readable reported failed attempt.
    this.#checkHistory = structuredClone(checks);
    const accounting = checkAccounting(input, { planned: this.#contract.assignments.map(item => ({ checks: item.obligations.checks })) }, checks);
    for (const held of this.#contract.assignments.flatMap(item => item.obligations.checks)) {
      const result = accounting.checkResults.find(item => item.checkID === held.id)!;
      const replacement = result.disposition === 'replaced' ? checks.find(item => item.id === result.executions.at(-1))!.command : held.command;
      const attempts = checks.filter(item => item.command === held.command || item.command === replacement).map(item => item.id!);
      if (result.executions.length && !isDeepStrictEqual(result.executions, attempts))
        throw new Error(`Held check ${held.id} must retain every reported command attempt; supplemental evidence cannot hide or downgrade a retry.`);
    }
    const inventory = entries(input.inventory, 'final diff inventory').map(value => {
      const item = objectWithKeys(value, 'final diff path', ['path', 'disposition', 'reason']);
      const path = scopePath(item.path);
      if (item.disposition !== 'assignment' && item.disposition !== 'unrelated') throw new Error('Final diff needs assignment/unrelated disposition.');
      if (item.disposition === 'assignment' && !this.#contract.scope.writes.includes(path) ||
          item.disposition === 'unrelated' && this.#contract.scope.writes.includes(path)) throw new Error('Final diff scope claim contradicts held writes.');
      return { path, disposition: item.disposition as 'assignment' | 'unrelated', reason: shortText(item.reason, 'final diff rationale') };
    });
    if (new Set(inventory.map(item => item.path)).size !== inventory.length) throw new Error('Final diff repeats a path.');
    // This is parent readback, never independent discovery of the whole worktree diff.
    const observed = new Set<string>();
    for (const path of this.#contract.scope.writes)
      if (fingerprint(this.root, path) !== this.#contract.context.fingerprints.find(file => file.path === path)!.digest) observed.add(path);
    if ([...observed].some(path => !inventory.some(item => item.path === path && item.disposition === 'assignment')))
      throw new Error('Final diff inventory omits locally changed declared assignment paths.');
    const exclusions = entries(input.exclusions, 'exclusion findings').map(value => {
      const item = objectWithKeys(value, 'exclusion finding', ['exclusion', 'status', 'assessment']);
      return { exclusion: shortText(item.exclusion, 'held exclusion'), status: status(item.status), assessment: shortText(item.assessment, 'exclusion assessment') };
    });
    exactCoverage(exclusions.map(item => item.exclusion), this.#contract.exclusions, 'Exclusion findings');
    const obligations = this.#contract.assignments.flatMap(item => item.obligations.source);
    const sources = entries(input.sources, 'source readback').map(value => {
      const item = objectWithKeys(value, 'source readback', ['id', 'paths', 'status', 'assessment']);
      const id = evidenceID(item.id), obligation = obligations.find(item => item.id === id), targets = paths(item.paths);
      if (!obligation || !isDeepStrictEqual(targets, obligation.paths)) throw new Error('Source readback paths contradict held obligation links.');
      return { id, paths: targets, status: status(item.status), assessment: shortText(item.assessment, 'source readback assessment') };
    });
    exactCoverage(sources.map(item => item.id), obligations.map(item => item.id), 'Source readback');
    const assess = (item: Record<string, unknown>, assignments: Assignment[]): SemanticAssessment => {
      const result = { status: status(item.status), sources: references(item.sources, 'source evidence references', true),
        checks: references(item.checks, 'execution references', true), assessment: shortText(item.assessment, 'semantic source assessment') };
      const allowedSource = assignments.flatMap(item => item.obligations.source.map(item => item.id));
      const allowedExecutions = assignments.flatMap(item => item.obligations.checks.flatMap(check => accounting.checkResults.find(result => result.checkID === check.id)!.executions));
      if (result.sources.some(id => !allowedSource.includes(id)) || result.checks.some(id => !allowedExecutions.includes(id)))
        throw new Error('Semantic assessment cites evidence outside its held assignment links.');
      if (result.status === 'verified' && (!result.sources.length && !result.checks.length ||
          result.sources.some(id => sources.find(item => item.id === id)!.status !== 'verified') || result.checks.some(id => !accounting.usable.includes(id))))
        throw new Error('Verified assessment needs successful final command or separately verified source evidence.');
      return result;
    };
    const assignments = entries(input.assignments, 'assignment coverage').map(value => {
      const item = objectWithKeys(value, 'assignment coverage', ['assignmentID', 'status', 'sources', 'checks', 'assessment']);
      const assignment = this.#contract.assignments.find(assignment => assignment.id === item.assignmentID);
      if (!assignment) throw new Error('Assignment assessment invents a held link.');
      return { assignmentID: assignment.id, ...assess(item, [assignment]) };
    });
    exactCoverage(assignments.map(item => item.assignmentID), this.#contract.assignments.map(item => item.id), 'Assignment coverage');
    const scenarios = entries(input.scenarios, 'scenario coverage').map(value => {
      const item = objectWithKeys(value, 'scenario coverage', ['requirementID', 'scenarioID', 'assignmentID', 'status', 'sources', 'checks', 'assessment']);
      const assignment = this.#contract.assignments.find(assignment => assignment.id === item.assignmentID);
      const requirement = this.#contract.acceptance.requirements.find(requirement => requirement.id === item.requirementID && requirement.scenarios.some(scenario => scenario.id === item.scenarioID));
      if (!assignment || !requirement || !assignment.scenarios.includes(String(item.scenarioID))) throw new Error('Scenario assessment invents a held link.');
      return { requirementID: requirement.id, scenarioID: String(item.scenarioID), assignmentID: assignment.id, ...assess(item, [assignment]) };
    });
    exactCoverage(scenarios.map(item => `${item.assignmentID}/${item.scenarioID}`), this.#contract.assignments.flatMap(item => item.scenarios.map(id => `${item.id}/${id}`)), 'Scenario coverage');
    const choices = entries(input.decisions, 'decision coverage').map(value => {
      const item = objectWithKeys(value, 'decision coverage', ['decisionID', 'status', 'sources', 'checks', 'assessment']);
      const decision = this.#contract.decisions.find(decision => decision.id === item.decisionID);
      if (!decision) throw new Error('Decision assessment invents a held link.');
      return { decisionID: decision.id, ...assess(item, this.#contract.assignments.filter(assignment => assignment.decisions.includes(decision.id))) };
    });
    exactCoverage(choices.map(item => item.decisionID), this.#contract.decisions.map(item => item.id), 'Decision coverage');
    const limits = texts(input.limits, 'evidence limits');
    if (limits.length > 4) throw new Error('Evidence limits require at most four entries.');
    const report: EvidenceReport = { snapshotID: this.#snapshot!.id, readback: structuredClone(expected), inventory, exclusions, sources,
      assignments, scenarios, decisions: choices, checks, checkResults: accounting.checkResults, supplementalChecks: accounting.supplementalChecks, limits };
    if (Buffer.byteLength(JSON.stringify(report)) > 48000) throw new Error('Adaptive evidence exceeds its 48000-byte budget.');
    this.assertEvidenceCurrent(); this.#report = report; this.#checkHistory = structuredClone(checks);
    this.#matched = accounting.complete && [...sources, ...assignments, ...scenarios, ...choices, ...exclusions].every(item => item.status === 'verified');
    this.#handle = randomUUID();
  }
  close(handle: string, outcome: unknown, limits: unknown): void {
    this.assertBoundary(handle);
    if (outcome !== 'verified' && outcome !== 'unverified') throw new Error('Close must explicitly select verified or unverified.');
    const remaining = limits === undefined ? [] : texts(limits, 'manual unverified limits');
    if (outcome === 'verified') {
      this.assertEvidenceCurrent();
      if (!this.#report || !this.#matched || this.#contract.assignments.some(item => !this.#completed.has(item.id)))
        throw new Error('Required evidence and all held acceptance links must be verified before completion.');
      if (remaining.length) throw new Error('Manual unverified limits never earn verified completion.');
    } else {
      if (!remaining.length) throw new Error('Unverified close needs explicit remaining limits.');
      this.#matched = false;
    }
    this.#completion = { outcome, limits: [...(this.#report?.limits ?? []), ...remaining] };
    this.#state = outcome === 'verified' ? 'completed' : 'closed-unverified'; this.#handle = randomUUID();
  }
  select(value: AdaptiveSelection): void {
    if (value.handle !== this.#handle) throw new Error('Selection handle is stale or was consumed.');
    if (this.#state !== 'await-selection') throw new Error('Selection requires an actorless boundary; a task is already authorized or in flight.');
    if (this.#receipts.length >= 64) throw new Error('Volatile receipt budget is exhausted; no automatic closure or escalation.');
    if (this.#contract.productQuestions.length) throw new Error('Unresolved product ambiguity pauses actor selection.');
    const assignment = this.#contract.assignments.find(item => item.id === value.assignmentID);
    if (!assignment) throw new Error('Unknown adaptive assignment.');
    let current = value.context ?? this.#context;
    if (current.technical === 'uncertain' && value.actor !== 'mdd-explore') throw new Error('Uncertain technical context permits only a brief Explore, never writes.');
    if (value.context) this.assertCurrent(this.#contract.scope, current);
    if (value.actor === 'mdd-apply') {
      if (this.#assessment.impact !== 'low') throw new Error('Apply requires low impact independent of complexity or scope size.');
      if (current.dependencies !== 'bounded') throw new Error('Apply requires understood bounded dependencies.');
      const prior = this.#receipts.findLast(receipt => receipt.actor === 'mdd-apply' && receipt.assignmentID === assignment.id);
      if (prior && value.repairOf !== prior.id) throw new Error('A repeated writer requires an explicit repairOf the last actual Apply receipt.');
      if (value.repairOf && !prior) throw new Error('Repair receipt is not an actual Apply attempt.');
      if (this.#completed.has(assignment.id)) {
        const stale = this.#completed.get(assignment.id)!.some(item => fingerprint(this.root, item.path) !== item.digest);
        const failed = this.#report && (this.#report.assignments.find(item => item.assignmentID === assignment.id)!.status !== 'verified' ||
          assignment.obligations.source.some(item => this.#report!.sources.find(source => source.id === item.id)!.status !== 'verified') ||
          assignment.obligations.checks.some(item => !['passed', 'replaced', 'not-applicable'].includes(this.#report!.checkResults.find(check => check.checkID === item.id)!.disposition)) ||
          this.#report.scenarios.some(item => item.assignmentID === assignment.id && item.status !== 'verified') ||
          this.#report.decisions.some(item => assignment.decisions.includes(item.decisionID) && item.status !== 'verified'));
        if (!stale && !failed) throw new Error('Completed Apply cannot repeat without failed or stale evidence requiring explicit repair.');
        if (this.#repairs >= 4) throw new Error('Explicit completed-assignment repair budget is exhausted.');
        // Reinspection only refreshes the authorized footprint; it never grants new paths.
        const refreshed = structuredClone(current);
        for (const path of new Set([...assignment.scope.reads, ...assignment.scope.writes]))
          refreshed.fingerprints.find(item => item.path === path)!.digest = fingerprint(this.root, path);
        this.assertCurrent(assignment.scope, refreshed);
        this.#assertPrerequisites(assignment);
        const invalid = new Set([assignment.id]);
        let count = -1;
        while (count !== invalid.size) {
          count = invalid.size;
          const writes = this.#contract.assignments.filter(item => invalid.has(item.id)).flatMap(item => item.scope.writes);
          for (const item of this.#contract.assignments) if (item.dependsOn.some(id => invalid.has(id)) ||
            [...item.scope.reads, ...item.scope.writes].some(path => writes.includes(path))) invalid.add(item.id);
        }
        if (assignment.dependsOn.some(id => invalid.has(id))) throw new Error('Repair overlaps a prerequisite; explicitly repair the prerequisite first.');
        this.#invalidatedAssignments = [...invalid];
        this.#retainedProof = [...this.#completed].filter(([id]) => !invalid.has(id)).map(([assignmentID, fingerprints]) => ({ assignmentID, fingerprints: structuredClone(fingerprints) }));
        if (this.#report) this.#priorEvidence = { report: structuredClone(this.#report), invalidatedAssignments: [...invalid] };
        for (const id of invalid) this.#completed.delete(id);
        this.#snapshot = undefined; this.#report = undefined; this.#matched = false; this.#checkHistory = []; this.#repairs++;
        current = refreshed;
      }
      this.#assertPrerequisites(assignment);
      this.assertCurrent(assignment.scope, current);
    }
    this.#context = structuredClone(current);
    if (value.actor === 'mdd-apply') { this.#snapshot = undefined; this.#report = undefined; this.#matched = false; this.#checkHistory = []; }
    this.#selection = structuredClone(value); this.#state = 'authorized-actor';
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
          obligations: { source: item.obligations.source.length, checks: item.obligations.checks.length,
            executed: this.#report ? item.obligations.checks.filter(check => this.#report!.checkResults.find(result => result.checkID === check.id)!.executions.length).length : 0 } })),
        ...(this.#contract.productQuestions.length ? { blocked: 'product-ambiguity' } : {}) },
      ...(this.#selection ? { actor: this.#selection.actor, assignmentID: this.#selection.assignmentID } : {}),
      ...(last ? { lastReceipt: { id: last.id, actor: last.actor, assignmentID: last.assignmentID, outcome: last.outcome,
        summary: last.summary, ...(last.failure ? { failure: last.failure } : {}) } } : {}),
      evidence: { matched: this.#matched, assurance: ASSURANCE, invalidatedAssignments: [...this.#invalidatedAssignments],
        retainedAssignments: this.#retainedProof.map(item => item.assignmentID),
        executionHistory: this.#checkHistory.map(({ id, exit }) => ({ id, exit })),
        ...(this.#snapshot ? { snapshot: { id: this.#snapshot.id, paths: this.#snapshot.sources.map(item => item.path) } } : {}),
        ...(this.#report ? { coverage: { sources: this.#report.sources.map(({ id, status }) => ({ id, status })),
          assignments: this.#report.assignments.map(({ assignmentID, status }) => ({ assignmentID, status })),
          scenarios: this.#report.scenarios.map(({ assignmentID, scenarioID, status }) => ({ assignmentID, scenarioID, status })),
          decisions: this.#report.decisions.map(({ decisionID, status }) => ({ decisionID, status })) },
          exclusions: this.#report.exclusions.map(({ exclusion, status }) => ({ exclusion: exclusion.slice(0, 150), status })),
          checkResults: this.#report.checkResults.map(({ checkID, disposition, executions, reason }) => ({ checkID, disposition, executions, ...(reason ? { reason: reason.slice(0, 150) } : {}) })),
          supplementalChecks: this.#report.supplementalChecks.map(({ id, requirement, disposition }) => ({ id, requirement, disposition })),
          limits: [...this.#report.limits] } : {}),
        ...(this.#priorEvidence ? { priorEvidence: { snapshotID: this.#priorEvidence.report.snapshotID,
          invalidatedAssignments: [...this.#priorEvidence.invalidatedAssignments], commandEvidenceInvalidated: this.#priorEvidence.invalidatedAssignments.length > 0,
          checkResults: this.#priorEvidence.report.checkResults.map(({ checkID, disposition }) => ({ checkID, disposition })) } } : {}) },
      ...(this.#completion ? { completion: structuredClone(this.#completion) } : {}),
      reason: this.#completion ? 'Internal closure grants no further actor, review authority, public activation or durable resume.'
        : 'Select the next necessary actor or prepare final evidence internally. No automatic phase, verification, completion, reset or escalation is implied.' };
  }
  /** Explicit bounded internal readback, separate from compact status. No execution authority. */
  evidence() {
    return { ...this.status().evidence,
      ...(this.#snapshot ? { snapshot: structuredClone(this.#snapshot) } : {}),
      ...(this.#report ? { report: structuredClone(this.#report) } : {}),
      retainedSourceProof: structuredClone(this.#retainedProof),
      ...(this.#priorEvidence ? { priorEvidence: structuredClone(this.#priorEvidence) } : {}) };
  }
}
