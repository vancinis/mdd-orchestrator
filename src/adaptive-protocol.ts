import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AdaptiveLow, adaptiveContract, ADAPTIVE_EVIDENCE_FIELDS, sourceFingerprints, statusText } from './adaptive-low.js';
import { parseParallelScope } from './worker-batch.js';
import { nativeOperation } from './adaptive-native.js';
import type { AdaptiveNative, NativeOperation } from './adaptive-native.js';
import type { PhaseRunner, Runtime } from './phase-runner.js';
import { openQuestions } from './open-questions.js';
import { STATUS_BUDGET_BYTES } from './status-budget.js';
import { objectWithKeys } from './validation.js';
import { STRUCTURED_FIELD_SCHEMA } from './acceptance.js';
import type { AdaptiveContract, AdaptiveData } from './adaptive-low.js';
import { adaptiveTransferRequest } from './adaptive-transfer.js';

const REQUEST_BYTES = 160000;
const PAGE_CHARS = 6000;
const specs = {
  // The host binds the user message from the actual caller; a supplied messageID is a checked assertion.
  entry: { required: ['contract'], optional: ['messageID', 'questions'] },
  select: { required: ['handle', 'actor', 'assignmentID', 'purpose'], optional: ['context', 'repairOf'] },
  prepare: { required: ['handle'], optional: [] },
  submit: { required: ['handle', 'evidence'], optional: [] },
  close: { required: ['handle', 'outcome'], optional: ['limits'] },
  escalate: { required: ['handle', 'depth', 'rationale', 'assessment', 'context'], optional: [] },
  recover: { required: [], optional: [] },
  transfer: { required: ['sourceSessionID', 'runID', 'operationID', 'messageID'], optional: [] },
  'transfer-recovery': { required: ['sourceSessionID', 'runID', 'operationID', 'messageID', 'action'], optional: [] },
  questions: { required: ['receiptID', 'callID'], optional: [] },
  status: { required: [], optional: [] },
  detail: { required: ['cursor'], optional: [] },
} as const;
type Kind = keyof typeof specs;
type Request = { kind: Kind; args: Record<string, unknown> };
const objectFields = new Set(['contract', 'context', 'assessment', 'evidence']);
const arrayFields = new Set(['questions', 'limits']);
/** Prose arguments: no length limit of their own, only the request's. Every other string is an identity. */
const PROSE_FIELDS = new Set(['purpose', 'rationale']);

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Public entry conveniences, applied before validation. The host fills only what is empty by
 * definition or what it can observe itself: omitted optional lists become empty, and an omitted
 * context.fingerprints becomes the current SHA-256 bytes of the declared footprint (null for a new
 * file). Everything the coordinator supplied is kept as written and validated unchanged; nothing
 * here adds scope, acceptance, identity or consent.
 */
export function completeAdaptiveEntry(value: unknown, root: string): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > REQUEST_BYTES) return value;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return value; }
  if (!plain(parsed) || parsed.kind !== 'entry' || !plain(parsed.args) || !plain(parsed.args.contract)) return value;
  const contract: Record<string, unknown> = { ...parsed.args.contract };
  for (const key of ['exclusions', 'decisions', 'productQuestions']) if (contract[key] === undefined) contract[key] = [];
  // Omitted assignment decisions are derived: a decision applies to an assignment covering a
  // scenario of a requirement it shapes. Supplied links are kept and validated as written.
  const owner = new Map<string, string>();
  const acceptance = contract.acceptance;
  if (plain(acceptance) && Array.isArray(acceptance.requirements)) for (const requirement of acceptance.requirements)
    if (plain(requirement) && typeof requirement.id === 'string' && Array.isArray(requirement.scenarios))
      for (const scenario of requirement.scenarios) if (plain(scenario) && typeof scenario.id === 'string') owner.set(scenario.id, requirement.id);
  const applicable = (scenarios: unknown) => !Array.isArray(scenarios) || !Array.isArray(contract.decisions) ? [] : contract.decisions
    .filter((choice: unknown): choice is Record<string, unknown> => plain(choice) && typeof choice.id === 'string' && Array.isArray(choice.requirements) &&
      (choice.requirements as unknown[]).some(requirement => scenarios.some(id => owner.get(String(id)) === requirement)))
    .map(choice => choice.id as string);
  if (Array.isArray(contract.assignments)) contract.assignments = contract.assignments.map((item: unknown) => {
    if (!plain(item)) return item;
    const assignment: Record<string, unknown> = { ...item };
    if (assignment.decisions === undefined) assignment.decisions = applicable(assignment.scenarios);
    if (assignment.dependsOn === undefined) assignment.dependsOn = [];
    if (plain(assignment.obligations)) {
      const obligations: Record<string, unknown> = { ...assignment.obligations };
      for (const key of ['source', 'checks']) if (obligations[key] === undefined) obligations[key] = [];
      assignment.obligations = obligations;
    }
    return assignment;
  });
  if (plain(contract.context) && contract.context.fingerprints === undefined) {
    const footprint = parseParallelScope(contract.scope);
    if (footprint.complete === true && footprint.reads && footprint.writes)
      contract.context = { ...contract.context, fingerprints: sourceFingerprints(root, { reads: footprint.reads, writes: footprint.writes }) };
  }
  return JSON.stringify({ ...parsed, args: { ...parsed.args, contract } });
}

/**
 * What to do with evidence that failed for completed work, published next to the repair selectors.
 * The fixed route corrects such a failure by itself in automatic mode; version 3 leaves every
 * selection to the coordinator, so the same bound travels here as data: repair each failing
 * assignment unasked at most `bound` times, re-assess the earlier gaps first, then stop with one
 * decision for the user. Interactive mode, or a bound of 0, always asks.
 */
export function adaptiveCorrection(mode: string | undefined, repairs: readonly { assignmentID: string; used: number }[], bound: number) {
  const within = repairs.filter(item => item.used < bound).map(item => item.assignmentID);
  const automatic = mode === 'automatic' && bound > 0 && within.length > 0;
  return { automatic, bound, repairs: repairs.map(({ assignmentID, used }) => ({ assignmentID, used })),
    instruction: automatic
      ? `Automatic mode: tell the user in a few lines what the evidence found, then select the repair of ${within.join(', ')} without asking (at most ${bound} repair(s) per assignment, and a further one only when the previous repair closed gaps and opened none). After it, prepare and submit evidence that re-assesses the earlier gap rows first; rows of untouched assignments may be restated from the earlier evidence. A gap that needs a different design or requirement is not repaired: stop and ask.`
      : `Present the evidence gaps and let the user choose: repair a listed assignment, or close unverified with every remaining gap as an explicit limit.${mode === 'automatic' && bound > 0 ? ` The automatic bound of ${bound} repair(s) per assignment is spent.` : ''}` };
}

/**
 * The shortest correct way into version 3, carried in the projection that offers entry so a
 * coordinator does not have to page through every definition first. Documentation only: the
 * validators named in `inputRef` remain the authority, and a refusal names what to correct.
 */
export const ENTRY_GUIDE = Object.freeze({
  call: 'mdd_adapt({payload: JSON.stringify({routingVersion:3,kind:"entry",args:{contract}})})',
  objective: 'contract.objective is the exact text of the user request in this conversation, never a summary. Prefer the current turn; an earlier request (for example after "si, confirmo") is confirmed once with a native question.',
  messageID: 'Optional: the host binds the user message that carries the objective. Supply it only to assert that exact ID.',
  defaults: 'exclusions, decisions, productQuestions, assignment decisions/dependsOn and context.fingerprints may be omitted: MDD uses empty lists and records the current SHA-256 bytes of every scope read/write (null for a new file).',
  example: {
    contractVersion: 1, objective: '<exact text of the user request>',
    acceptance: { goal: '<observable outcome>', requirements: [{ id: 'R1', description: '<requirement>',
      scenarios: [{ id: 'S1', given: '<starting state>', when: '<action>', then: '<observable result>' }] }] },
    scope: { complete: true, reads: ['src/existing.ts'], writes: ['src/existing.ts', 'src/new-file.ts'] },
    context: { technical: 'understood', dependencies: 'bounded', reason: '<what you inspected and why it is enough>' },
    assessment: { assessmentVersion: 1, complexity: 'low', impact: 'low' },
    assignments: [{ id: 'A1', description: '<the change>', path: 'src/existing.ts', scenarios: ['S1'],
      scope: { complete: true, reads: ['src/existing.ts'], writes: ['src/existing.ts', 'src/new-file.ts'] },
      obligations: { source: [{ id: 'E1', description: '<what proves it in the source>', paths: ['src/existing.ts'] }],
        checks: [{ id: 'C1', command: '<exact check command>', requirement: 'required' }] } }],
  },
  rules: [
    'Paths are exact root-relative files with forward slashes: no directories, globs or aliases. Writes cannot be hidden, dependency, lock, configuration or agent-instruction files.',
    'Every scenario is covered by at least one assignment; an assignment writes its own path and stays inside the contract scope.',
    'IDs are unique across requirements, scenarios, decisions, assignments and evidence obligations.',
    'Each assignment needs source or check obligations. complexity or impact medium/high freezes the medium/high stages.',
    'Mark a scenario evidence:"external" only when it is observable solely outside this workspace (device, staging/production, live service, real worker or a person); evidence then reports it as external (pending), never as a gap.',
    'Ask productQuestions only for decisions the repository cannot answer. Read inputRef for complete definitions.',
    'The user reads acceptance.goal, exclusions and productQuestions, and a select purpose, escalate rationale and close limits, in the native approval and questions: write them in Spanish, in complete sentences with ordinary spacing and no abbreviations. No field has a size budget of its own, so never compress one to fit.',
  ],
});

/** Wire identity and consent are deliberately absent. Native host runtime is a separate argument. */
export function decodeAdaptiveRequest(value: unknown): Request {
  if (typeof value !== 'string' || Buffer.byteLength(value) > REQUEST_BYTES) throw new Error('Native protocol requires a bounded JSON string (160000 bytes).');
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('Malformed native protocol JSON.'); }
  const input = objectWithKeys(parsed, 'native protocol request', ['routingVersion', 'kind', 'args']);
  if (input.routingVersion !== 3 || typeof input.kind !== 'string' || !Object.hasOwn(specs, input.kind))
    throw new Error('Native protocol requires routingVersion 3 and a known operation.');
  const kind = input.kind as Kind, spec = specs[kind];
  const args = objectWithKeys(input.args, `native ${kind} arguments`, [...spec.required, ...spec.optional]);
  for (const key of spec.required) if (!Object.hasOwn(args, key)) throw new Error(`Native ${kind} requires ${key}.`);
  for (const [key, value] of Object.entries(args)) {
    if (objectFields.has(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object.`);
    } else if (arrayFields.has(key)) {
      // Product questions are counted by their own validator; closure limits have no entry count.
      if (!Array.isArray(value)) throw new Error(`${key} must be an array.`);
    } else if (PROSE_FIELDS.has(key)) {
      // Read in full by its own validator, which folds line breaks and tabs and names any other control.
      if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} must be nonempty text.`);
    } else if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error(`${key} must be bounded nonempty text without controls.`);
    }
  }
  // The contract and the evidence have no byte budget of their own. A 24000-byte contract and a
  // 48000-byte evidence ceiling made coordinators abbreviate what the user later reads, and the
  // request bound above still applies to both.
  if (kind === 'entry') {
    adaptiveContract(args.contract);
    if (args.questions !== undefined) openQuestions(args.questions);
  }
  if (kind === 'submit') {
    const evidence = objectWithKeys(args.evidence, 'native evidence', ADAPTIVE_EVIDENCE_FIELDS);
    for (const key of ADAPTIVE_EVIDENCE_FIELDS) if (!Object.hasOwn(evidence, key)) throw new Error(`Native evidence requires ${key}.`);
  }
  if (kind === 'close' && (args.outcome !== 'verified' && args.outcome !== 'unverified') ||
      kind === 'escalate' && (args.depth !== 'medium' && args.depth !== 'high') ||
      kind === 'transfer-recovery' && (args.action !== 'finish' && args.action !== 'abort')) throw new Error('Invalid native operation choice.');
  if (args.limits !== undefined && (args.limits as unknown[]).some(value => typeof value !== 'string')) throw new Error('limits requires text entries.');
  // Also rejects non-finite numbers and data outside the existing native operation budget.
  return kind === 'status' || kind === 'detail' ? { kind, args } : nativeOperation({ kind, args }) as Request;
}

// These are input documentation, not another validator. The held model remains the semantic
// authority; references disclose complete nested keys without protecting an unlimited status blob.
function inputContracts(contract?: AdaptiveContract, data?: AdaptiveData) {
  // Prose has no length limit; line breaks and tabs fold into spaces, other controls are refused.
  const text = { type: 'string', minLength: 1, controls: 'line breaks and tabs fold into spaces' };
  const identity = { type: 'string', minLength: 1, controls: false };
  const ref = (name: string) => ({ definition: name });
  // Lists have no entry count of their own, except what one native question form can show: at most
  // eight product questions of at most six options each.
  const list = (items: unknown, minItems = 0, maxItems?: number) => ({ type: 'array', items, minItems, ...(maxItems === undefined ? {} : { maxItems }) });
  const prose = list(text);
  const object = (required: Record<string, unknown>, optional: Record<string, unknown> = {}) => ({ type: 'object',
    required: Object.keys(required), optional: Object.keys(optional), additionalProperties: false, properties: { ...required, ...optional } });
  const choice = (...values: unknown[]) => ({ enum: values });
  const ids = list(ref('id'));
  const semantic = { status: ref('evidenceStatus'), sources: ids, checks: ids, assessment: text };
  const dispositions = { disposition: choice('passed', 'failed', 'ran', 'blocked', 'not-applicable', 'replaced'), executions: ids };
  const definitions = {
    id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,64}$' },
    path: { type: 'string', minLength: 1, maxLength: 400, format: 'canonical exact root-relative ASCII file path; existing alias/credential exclusions apply' },
    handle: { ...identity, maxLength: 200 }, nativeID: { ...identity, maxLength: 256 }, receiptID: { ...identity, maxLength: 100 },
    scope: object({ complete: { const: true }, reads: list(ref('path')), writes: list(ref('path')) }),
    fingerprint: object({ path: ref('path'), digest: { type: ['string', 'null'], pattern: '^[a-f0-9]{64}$' } }),
    context: object({ technical: choice('understood', 'uncertain'), dependencies: choice('bounded', 'unknown'), reason: text,
      fingerprints: list(ref('fingerprint')) }),
    assessment: object({ assessmentVersion: { const: 1 }, complexity: choice('low', 'medium', 'high'), impact: choice('low', 'medium', 'high') }),
    scenario: object({ id: ref('id'), given: text, when: text, then: text }, { evidence: { const: 'external', format: 'only observable outside this workspace: device, staging/production, live service, real worker or a person' } }),
    requirement: object({ id: ref('id'), description: text, scenarios: list(ref('scenario'), 1) }),
    acceptance: object({ goal: text, requirements: list(ref('requirement'), 1) }),
    decision: object({ id: ref('id'), description: text, requirements: { ...ids, minItems: 1 } }),
    plannedCheck: object({ id: ref('id'), command: { ...identity, maxLength: 'request byte budget' }, requirement: choice('required', 'optional') }, { appliesWhen: text }),
    sourceObligation: object({ id: ref('id'), description: text, paths: list(ref('path'), 1) }),
    obligations: object({ source: list(ref('sourceObligation')), checks: list(ref('plannedCheck')) }),
    assignment: object({ id: ref('id'), description: text, path: ref('path'), scenarios: { ...ids, minItems: 1 }, decisions: ids,
      dependsOn: ids, scope: ref('scope'), obligations: ref('obligations') }),
    contract: object({ contractVersion: { const: 1 }, objective: { type: 'string', minLength: 1, format: 'exact native objective' },
      acceptance: ref('acceptance'), exclusions: prose, decisions: list(ref('decision')), productQuestions: list(text, 0, 8),
      scope: ref('scope'), context: ref('context'), assessment: ref('assessment'), assignments: list(ref('assignment'), 1) }),
    questionOption: object({ label: { type: 'string', minLength: 1 }, description: { type: 'string', minLength: 1 } }, { recommended: { type: 'boolean' } }),
    productQuestion: object({ question: { type: 'string', minLength: 1 }, why: { type: 'string', minLength: 1 } },
      { options: list(ref('questionOption'), 0, 6), multiple: { type: 'boolean' }, deferrable: { type: 'boolean' } }),
    evidenceStatus: { ...choice('verified', 'not-verified', 'deviation', 'external'), format: 'external only on a scenario row the held acceptance declares external; it is pending, not verified' },
    readback: object({ acceptance: ref('acceptance'), scope: ref('scope'), exclusions: prose, decisions: list(ref('decision')) }),
    inventory: object({ path: ref('path'), disposition: choice('assignment', 'unrelated'), reason: text }),
    exclusionEvidence: object({ exclusion: text, status: ref('evidenceStatus'), assessment: text }),
    sourceEvidence: object({ id: ref('id'), paths: list(ref('path'), 1), status: ref('evidenceStatus'), assessment: text }),
    assignmentEvidence: object({ assignmentID: ref('id'), ...semantic }),
    scenarioEvidence: object({ requirementID: ref('id'), scenarioID: ref('id'), assignmentID: ref('id'), ...semantic }),
    decisionEvidence: object({ decisionID: ref('id'), ...semantic }),
    execution: object({ id: ref('id'), command: { ...identity, maxLength: 'request byte budget' }, exit: { type: ['integer', 'null'] } }),
    checkResult: object({ checkID: ref('id'), ...dispositions }, { reason: text, equivalence: text }),
    supplementalCheck: object({ id: ref('id'), requirement: choice('required', 'optional'), ...dispositions,
      disposition: choice('passed', 'failed', 'ran') }, { reason: text, equivalence: text }),
    evidence: object({ snapshotID: ref('receiptID'), readback: ref('readback'), inventory: list(ref('inventory')), exclusions: list(ref('exclusionEvidence')),
      sources: list(ref('sourceEvidence')), assignments: list(ref('assignmentEvidence')), scenarios: list(ref('scenarioEvidence')), decisions: list(ref('decisionEvidence')),
      checks: list(ref('execution')), checkResults: list(ref('checkResult')), supplementalChecks: list(ref('supplementalCheck')), limits: prose }),
  };
  const fields: Record<string, unknown> = { contract: ref('contract'), messageID: ref('nativeID'), questions: list(ref('productQuestion'), 0, 8),
    handle: ref('handle'), actor: choice('mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-apply', 'mdd-verify', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks'),
    assignmentID: ref('id'), purpose: text, context: ref('context'), repairOf: ref('receiptID'), evidence: ref('evidence'),
    outcome: choice('verified', 'unverified'), limits: prose, depth: choice('medium', 'high'), rationale: text, assessment: ref('assessment'),
    sourceSessionID: ref('nativeID'), runID: ref('nativeID'), operationID: ref('nativeID'), action: choice('finish', 'abort'),
    receiptID: ref('receiptID'), callID: ref('nativeID'), cursor: { ...identity, maxLength: 256, format: 'issued document ID plus validated page offset' } };
  const operations = Object.fromEntries(Object.entries(specs).map(([kind, spec]) => [kind,
    object(Object.fromEntries(spec.required.map(key => [key, fields[key]])), Object.fromEntries(spec.optional.map(key => [key, fields[key]])))]));
  return { routingVersion: 3, maxRequestBytes: REQUEST_BYTES, envelope: object({ routingVersion: { const: 3 }, kind: { enum: Object.keys(specs) }, args: { operation: 'kind' } }),
    operations, definitions, rules: { validation: 'Existing adaptiveContract, held AdaptiveLow and native ownership validators remain authoritative.',
      checks: STRUCTURED_FIELD_SCHEMA.checks, accounting: STRUCTURED_FIELD_SCHEMA.verification,
      repair: 'repairOf must be the latest actual Apply receipt for that assignment; only failed or stale evidence permits completed repair.',
      authorization: 'Host-injected native coordinator runtime only. No answer, approval, stopped flag, capability, runtime or agent identity is a request field.' },
    bindings: contract ? { readback: { acceptance: contract.acceptance, scope: contract.scope, exclusions: contract.exclusions, decisions: contract.decisions },
      assignments: contract.assignments, sources: contract.assignments.flatMap(item => item.obligations.source.map(source => ({ ...source, assignmentID: item.id })))
        .map(({ id, paths, assignmentID }) => ({ id, paths, assignmentID })),
      scenarios: contract.assignments.flatMap(item => item.scenarios.map(scenarioID => ({ requirementID: contract.acceptance.requirements.find(requirement =>
        requirement.scenarios.some(scenario => scenario.id === scenarioID))!.id, scenarioID, assignmentID: item.id }))),
      snapshotID: data?.snapshot?.id, commandHistory: data?.checkHistory ?? [] } : undefined };
}

type Document = { id: string; text: string };
type Held = { stamp: string; runtime: Runtime; documents: Map<string, Document> };
type Snapshot = ReturnType<PhaseRunner['adaptiveProtocolSnapshotInternal']> & ReturnType<AdaptiveNative['readbackInternal']>;

/** Versioned native projection. Host caller identity is separate from JSON and policy authority. */
export class AdaptiveProtocol {
  readonly #held = new Map<string, Held>();
  constructor(readonly runner: PhaseRunner, readonly native: AdaptiveNative) {}

  #snapshot(runtime: Runtime): Snapshot {
    return { ...this.runner.adaptiveProtocolSnapshotInternal(runtime), ...this.native.readbackInternal(runtime) };
  }
  async #read(runtime: Runtime): Promise<Snapshot> {
    const before = this.#snapshot(runtime);
    await this.runner.inspect.parent(runtime);
    const after = this.#snapshot(runtime);
    if (!isDeepStrictEqual(before, after)) throw new Error('Native protocol read generation changed during inspection.');
    return after;
  }
  #stamp(snapshot: Snapshot): string { return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'); }
  #reference(held: Held, name: string, value: unknown) {
    const text = JSON.stringify(value), previous = held.documents.get(name);
    const document = previous?.text === text ? previous : { id: randomUUID(), text };
    held.documents.set(name, document);
    return { kind: 'detail', args: { cursor: `${document.id}:0` }, encoding: 'json-text-pages', bytes: Buffer.byteLength(text) };
  }
  #page(cursor: string, runtime: Runtime, snapshot: Snapshot, publicAdapter = false): Record<string, unknown> {
    const held = this.#held.get(runtime.sessionID), [id, offsetText, extra] = cursor.split(':');
    const document = held && [...held.documents.values()].find(item => item.id === id), offset = Number(offsetText);
    if (!held || !isDeepStrictEqual(held.runtime, runtime) || held.stamp !== this.#stamp(snapshot) || !document || extra !== undefined ||
        !/^(0|[1-9][0-9]*)$/.test(offsetText ?? '') || !Number.isSafeInteger(offset) || offset % PAGE_CHARS || offset >= document.text.length)
      throw new Error('Invalid, stale or cross-parent detail cursor. Read current status for fresh references.');
    const end = Math.min(offset + PAGE_CHARS, document.text.length);
    return { routingVersion: 3, registration: publicAdapter ? 'active' : 'inactive', encoding: 'json-text-pages', text: document.text.slice(offset, end),
      ...(end < document.text.length ? { nextCursor: `${id}:${end}` } : {}) };
  }
  async run(value: unknown, hostRuntime: Runtime, callerMessageID?: string, publicAdapter = !!callerMessageID): Promise<unknown> {
    const request = decodeAdaptiveRequest(value), runtime = { ...hostRuntime };
    if (runtime.agent !== 'mdd-orchestrator') throw new Error('Only the native coordinator may use this protocol.');
    if (request.kind === 'detail') return this.#page(String(request.args.cursor), runtime, await this.#read(runtime), publicAdapter);
    if (request.kind !== 'status') {
      // Validate using the actual held model on an isolated copy, before any policy question/write.
      this.runner.validateAdaptiveProtocolInternal(request as NativeOperation, runtime);
      const before = await this.#read(runtime);
      const continuation = before.status.continuation as Record<string, unknown> | undefined;
      if (request.kind === 'select' && request.args.actor === 'mdd-apply' && request.args.repairOf !== undefined &&
          continuation?.next === 'mdd-verify' && before.model?.data.completed.some(item => item.assignmentID === request.args.assignmentID) &&
          request.args.context === undefined) throw new Error('Published continuation repair requires explicit current declared-source context.');
      await this.native.run(request, runtime, callerMessageID);
    }
    return this.#project(runtime, await this.#read(runtime), publicAdapter);
  }
  #project(runtime: Runtime, snapshot: Snapshot, publicAdapter = false): Record<string, unknown> {
    const stamp = this.#stamp(snapshot), old = this.#held.get(runtime.sessionID);
    const held: Held = old?.stamp === stamp && isDeepStrictEqual(old.runtime, runtime) ? old : { stamp, runtime, documents: new Map() };
    this.#held.set(runtime.sessionID, held);
    const status = snapshot.native ?? snapshot.status, record = snapshot.record ?? snapshot.sourceRecord ?? snapshot.recoveryRecord;
    const data = record?.data, model = snapshot.model;
    const state = String(status.state), selection = snapshot.status.selection as Record<string, unknown> | undefined;
    const continuation = snapshot.status.continuation as Record<string, unknown> | undefined;
    const policy = status.nativePolicy as { answers?: { mode?: string } } | undefined;
    const handle = typeof selection?.handle === 'string' ? selection.handle : undefined;
    const contract = model?.contract ?? data?.contract;
    const ids = contract?.assignments.map(item => item.id) ?? [];
    const sources = snapshot.sources ?? snapshot.generation?.sources;
    const snapshotCurrent = !!data?.snapshot && data.snapshot.sources.every(file => sources?.some(current => current.path === file.path && current.digest === file.digest));
    const staleAssignments = data?.completed.filter(item => item.fingerprints.some(file =>
      !sources?.some(current => current.path === file.path && current.digest === file.digest))).map(item => item.assignmentID) ?? [];
    const matched = data?.matched === true && snapshotCurrent && !staleAssignments.length;
    const operations: Record<string, unknown>[] = [];
    const inputRef = this.#reference(held, 'inputs', inputContracts(contract, data));
    const operation = (kind: Kind, selectors: Record<string, unknown> = {}) => operations.push({ kind,
      required: [...specs[kind].required], optional: [...specs[kind].optional], inputRef, ...selectors });
    const details: Record<string, unknown> = { inputs: inputRef };
    if (snapshot.record) details.journal = this.#reference(held, 'journal', snapshot.record);
    if (model) details.held = this.#reference(held, 'held', model);
    if (contract) details.contract = this.#reference(held, 'contract', contract);
    if (publicAdapter && snapshot.record && snapshot.owner?.ownerSessionID === runtime.sessionID &&
        ['await-selection', 'completed', 'closed-unverified'].includes(state)) details.transfer = this.#reference(held, 'transfer', {
      sourceSessionID: runtime.sessionID, runID: snapshot.record.runID, nativeRequest: adaptiveTransferRequest(snapshot.record),
      instruction: 'The target conversation must receive this exact genuine native user request. Its messageID and actual host caller are independently inspected; source IDs alone grant nothing.' });
    if (data?.snapshot) details.snapshot = this.#reference(held, 'snapshot', data.snapshot);
    if (snapshot.sourceRecord ?? snapshot.recoveryRecord) details.sourceJournal = this.#reference(held, 'sourceJournal', snapshot.sourceRecord ?? snapshot.recoveryRecord);
    const mode = policy?.answers?.mode ?? record?.nativePolicy?.answers.mode ?? this.native.profile.answers.mode;
    const projection: Record<string, unknown> = { lane: publicAdapter ? 'adaptive-native' : 'adaptive-native-protocol-internal', routingVersion: 3, registration: publicAdapter ? 'active' : 'inactive',
      protocol: publicAdapter ? 'mdd_adapt({payload: JSON.stringify({routingVersion:3,kind,args})})' : 'NativeIntake.adaptiveInternal JSON string; future public adapter is not registered.',
      state, route: data?.continuation?.depth ?? 'low', ...(mode ? { mode } : {}),
      ...(record ? { runID: record.runID, generation: record.sequence } : {}),
      ...(handle ? { handle } : {}), operations, details,
      assurance: 'Structured parent-reported consistency, not independent execution attestation.' };
    if (status.question) {
      const question = status.question;
      if (Buffer.byteLength(JSON.stringify(question)) <= 16000) projection.question = question;
      else projection.questionRef = this.#reference(held, 'question', question);
      if (snapshot.proposal) projection.proposedOperation = this.#reference(held, 'operation', snapshot.proposal);
      projection.next = { native: 'question', source: projection.question ? 'question' : 'questionRef', exact: true };
    } else if (status.task) {
      projection.task = status.task; projection.next = { native: 'task', source: 'task', exact: true };
    } else if (state === 'await-selection' && handle) {
      const pending = snapshot.status.productQuestions as { receiptID: string; callID: string } | undefined;
      if (pending) operation('questions', { ids: { receiptID: pending.receiptID, callID: pending.callID } });
      else {
        const actor = continuation ? continuation.next ? [continuation.next] : [] : ['mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-apply', 'mdd-verify'];
        const repairs = ids.flatMap(assignmentID => {
          const receipt = data?.receipts.findLast(item => item.actor === 'mdd-apply' && item.assignmentID === assignmentID);
          return receipt ? [{ assignmentID, receiptID: receipt.id }] : [];
        });
        if (actor.length && !(continuation?.next === 'mdd-verify' && !matched)) operation('select', { ids: { handle, actor, assignmentID: ids,
          repairOf: repairs.map(item => item.receiptID) }, repairs,
          condition: 'Assignment readiness, scope, current proof and frozen-stage validators still apply; repairs require failed or stale evidence.' });
        // Evidence that failed for a completed assignment: what can be repaired, and how many repairs
        // each assignment already had, so automatic mode can correct within its bound unasked.
        const failedEvidence = !!model && !matched && (continuation ? continuation.next === 'mdd-verify' : !!data?.report);
        let eligible: ReturnType<AdaptiveLow['repairCandidates']>;
        if (failedEvidence) {
          if (continuation) eligible = AdaptiveLow.restore(model!.data, runtime.directory, false).repairCandidates();
          else try { eligible = AdaptiveLow.restore(model!.data, runtime.directory, false).repairCandidates(); } catch { eligible = undefined; }
        }
        if (continuation && eligible?.repairs.length) operation('select', { variant: 'repair', required: [...specs.select.required, 'repairOf', 'context'], optional: [],
          ids: { handle, actor: ['mdd-apply'], assignmentID: eligible.repairs.map(item => item.assignmentID), repairOf: eligible.repairs.map(item => item.repairOf) },
          repairs: eligible.repairs.map(({ assignmentID, repairOf }) => ({ assignmentID, repairOf })), contextRef: this.#reference(held, 'repairContext', { required: ['technical', 'dependencies', 'reason', 'fingerprints'],
            current: eligible.current, reason: 'Supply the coordinator explanation of actual current declared-source inspection; fingerprints must match these held current bytes.' }),
          condition: 'Only a listed assignment/repairOf pair may be repaired with explicit current context. Unrelated completed writers remain closed; refreshed parent evidence and a new structured Verify are required.' });
        if (eligible?.repairs.length) projection.correction = adaptiveCorrection(mode, eligible.repairs,
          Math.min(2, Math.max(0, Math.trunc(this.runner.options.automaticCorrections ?? 0))));
        const planning = continuation && ['mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks'].includes(String(continuation.next));
        if (!planning) operation('prepare', { ids: { handle } });
        if (!planning && data?.snapshot && snapshotCurrent) operation('submit', { ids: { handle, snapshotID: data.snapshot.id }, input: 'evidence: exact held readback and complete linked coverage; read inputRef and details.held.' });
        const verified = matched && ids.every(id => data?.completed.some(item => item.assignmentID === id)) && (!continuation || !continuation.next);
        operation('close', { ids: { handle, outcome: verified ? ['verified', 'unverified'] : ['unverified'] },
          condition: 'Unverified closure requires explicit remaining limits; it never earns verified completion.' });
        if (!continuation) operation('escalate', { ids: { handle, depth: ['medium', 'high'] } });
        const repairAvailable = operations.some(item => item.kind === 'select' && item.variant === 'repair');
        const desired = repairAvailable ? 'select' : verified ? 'close' : continuation && (!continuation.next || continuation.next === 'mdd-verify')
          ? snapshotCurrent ? 'submit' : 'prepare' : 'select';
        projection.next = { internal: operations.find(item => item.kind === desired)?.kind ?? operations[0]?.kind,
          ...(repairAvailable ? { variant: 'repair' } : {}), inputContract: 'operations', automatic: false };
      }
      projection.next ??= { internal: operations[0]?.kind, inputContract: 'operations', automatic: false };
    } else if (state === 'not-started' || publicAdapter && ['completed', 'closed-unverified'].includes(state)) {
      operation('entry'); operation('transfer', { runtime: 'target native parent; sourceSessionID/runID must identify held source authority' });
      if (publicAdapter) projection.entryGuide = ENTRY_GUIDE;
    }
    else if (['await-result', 'recovery-blocked'].includes(state)) {
      operation('recover', { binding: { runID: record?.runID, callID: record?.attempt?.callID },
        condition: 'Actual native stopped-child inspection is required; caller flags and abort acknowledgments never release ownership.' });
      projection.next = { internal: 'recover', inputContract: 'operations', automatic: false };
    }
    if (snapshot.proposal && ['transfer', 'transfer-recovery'].includes(snapshot.proposal.kind) && state === 'blocked') {
      const { sourceSessionID, runID, operationID } = snapshot.proposal.args;
      operation('transfer-recovery', { ids: { sourceSessionID, runID, operationID, action: snapshot.recoveryActions ?? ['finish', 'abort'] },
        input: 'Fresh exact target-native message and, in interactive mode, a fresh actual native approval are required.' });
    }
    if (snapshot.recovery && !operations.some(item => item.kind === 'transfer-recovery')) {
      operation('transfer-recovery', { ids: { ...snapshot.recovery, action: snapshot.recoveryActions ?? ['finish', 'abort'] },
        input: 'Data-only interrupted publication; obtain a fresh exact target-native recovery request. No task or selection handle is restored.' });
    }
    if (operations.some(item => item.kind === 'transfer-recovery')) projection.next = { internal: 'transfer-recovery', inputContract: 'operations', automatic: false };
    if (data?.receipts.length) {
      const receipt = data.receipts.at(-1)!;
      projection.lastReceipt = { id: receipt.id, callID: receipt.callID, actor: receipt.actor, assignmentID: receipt.assignmentID, outcome: receipt.outcome };
    }
    if (continuation) projection.continuation = { depth: continuation.depth, next: continuation.next, revision: continuation.revision };
    if (data?.completion) projection.completion = { outcome: data.completion.outcome, limits: data.completion.limits.map(statusText) };
    if (data) projection.evidence = { matched, recordedMatch: data.matched, snapshotID: data.snapshot?.id, snapshotCurrent,
      gaps: { missingReport: !data.report, staleAssignments, invalidatedAssignments: data.invalidatedAssignments,
        unfinishedAssignments: ids.filter(id => !data.completed.some(item => item.assignmentID === id)),
        sources: data.report?.sources.filter(item => item.status !== 'verified').map(item => item.id) ?? [],
        assignments: data.report?.assignments.filter(item => item.status !== 'verified').map(item => item.assignmentID) ?? [],
        scenarios: data.report?.scenarios.filter(item => item.status !== 'verified' && item.status !== 'external').map(({ requirementID, scenarioID, assignmentID }) => ({ requirementID, scenarioID, assignmentID })) ?? [],
        externalPending: data.report?.scenarios.filter(item => item.status === 'external').map(({ scenarioID, assignmentID, assessment }) => ({ scenarioID, assignmentID, check: statusText(assessment) })) ?? [],
        decisions: data.report?.decisions.filter(item => item.status !== 'verified').map(item => item.decisionID) ?? [],
        checks: data.report?.checkResults.filter(item => !['passed', 'replaced', 'not-applicable', 'environmental'].includes(item.disposition))
          .map(({ checkID, disposition }) => ({ checkID, disposition })) ?? [] },
      completeCoverage: details.held };
    if (state === 'await-contract') {
      operation('entry'); projection.clarification = 'Read held native answers in details.policy; rebuild without expanding original authority.';
      if (publicAdapter) projection.entryGuide = ENTRY_GUIDE;
    }
    if (snapshot.native) details.policy = this.#reference(held, 'policy', snapshot.native);
    operation('status'); operation('detail');
    if (publicAdapter && projection.next && typeof projection.next === 'object') {
      const { internal, ...next } = projection.next as Record<string, unknown>;
      projection.next = { ...next, ...(internal ? { operation: internal } : {}) };
    }
    // Leave room for nextAction and asset metadata before protecting exact descriptors.
    const budget = STATUS_BUDGET_BYTES - (publicAdapter ? 5000 : 0);
    if (Buffer.byteLength(JSON.stringify(projection)) > budget) {
      if (projection.task && !publicAdapter) { projection.taskRef = this.#reference(held, 'task', projection.task); delete projection.task;
        projection.next = { native: 'task', source: 'taskRef', exact: true }; }
      if (Buffer.byteLength(JSON.stringify(projection)) > budget) {
        projection.operationsRef = this.#reference(held, 'operations', operations); delete projection.operations;
        if (projection.next && typeof projection.next === 'object') projection.next = { ...projection.next, inputContract: 'operationsRef' };
      }
      if (Buffer.byteLength(JSON.stringify(projection)) > budget && projection.evidence) {
        projection.evidenceRef = this.#reference(held, 'evidence', projection.evidence);
        projection.evidence = { matched, snapshotID: data?.snapshot?.id, snapshotCurrent, completeReadback: projection.evidenceRef };
      }
      // Closure limits have no entry count, so a closure with many of them travels like evidence:
      // its outcome inline, every limit whole behind a paged reference.
      if (Buffer.byteLength(JSON.stringify(projection)) > budget && data?.completion) {
        projection.completion = { outcome: data.completion.outcome, limits: data.completion.limits.length,
          limitsRef: this.#reference(held, 'completion', data.completion) };
      }
      if (Buffer.byteLength(JSON.stringify(projection)) > budget) throw new Error('Native protocol descriptor exceeds its bounded status budget.');
    }
    return projection;
  }
}
