import { createHash } from 'node:crypto';
import type { EngramHttp } from './engram-http.js';
import { canonicalNativeText } from './native-text.js';
import { PHASES } from './policy.js';
import type { Phase } from './policy.js';
import { objectWithKeys } from './validation.js';

export type KnowledgeDraft = {
  summary: string;
  body: string;
  applicability: { phases: Phase[]; paths: string[] };
  sources: string[];
};
export type KnowledgeObservation = KnowledgeDraft & {
  version: 1;
  kind: 'mdd-project-knowledge';
  status: 'observation';
  project: string;
  recordedAt: string;
  provenance: { kind: 'coordinator-observation'; sessionID: string; userMessageID: string; assistantMessageID: string; requestDigest: string; observationDigest: string };
};
export type KnowledgeQuery = { query?: string; phase?: Phase; paths?: string[]; limit?: number };
export type KnowledgeSummary = { ref: string; summary: string; status: 'observation'; freshness: 'unverified' };
export const KNOWLEDGE_NOTE = 'Candidate coordinator observations linked to native requests, not user-authored assertions or approval. Declared sources and target-checkout freshness are unverified. No execution authority.';

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new Error(`Invalid knowledge ${name}.`);
  return value;
}

/** References only: PK-1 never opens source files or claims these declarations match the checkout. */
function path(value: unknown): string {
  const result = text(value, 'relative source path', 256);
  if (/[\\:*?"<>|]/.test(result) || result.split('/').some(part => !part || part === '.' || part === '..' ||
      /[\x00-\x20]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))
    throw new Error('Unsafe knowledge relative path.');
  return result;
}

function list<T>(value: unknown, name: string, max: number, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value) || !value.length || value.length > max) throw new Error(`Invalid knowledge ${name}.`);
  const result = value.map(parse);
  if (new Set(result).size !== result.length) throw new Error(`Duplicate knowledge ${name}.`);
  return result;
}

function phase(value: unknown): Phase {
  if (!PHASES.includes(value as Phase)) throw new Error('Invalid knowledge phase.');
  return value as Phase;
}

function draft(value: unknown): KnowledgeDraft {
  const input = objectWithKeys(value, 'knowledge draft', ['summary', 'body', 'applicability', 'sources']);
  const summary = text(input.summary, 'summary', 320);
  const body = text(input.body, 'body', 4096);
  if (/[\r\n]/.test(summary)) throw new Error('Knowledge summary must be a single line.');
  const applies = objectWithKeys(input.applicability, 'knowledge applicability', ['phases', 'paths']);
  return { summary, body, applicability: { phases: list(applies.phases, 'phases', 8, phase), paths: list(applies.paths, 'paths', 16, path) },
    sources: list(input.sources, 'sources', 16, path) };
}

/** Set ordering is not a distinct finding; retries cannot evade the guard by reordering references. */
function observationDigest(value: KnowledgeDraft): string {
  return createHash('sha256').update(JSON.stringify({ summary: value.summary, body: value.body,
    applicability: { phases: [...value.applicability.phases].sort(), paths: [...value.applicability.paths].sort() },
    sources: [...value.sources].sort() })).digest('hex');
}

/** The native request grounds context, not authorship or approval of the coordinator's finding. */
export function parseKnowledgeRequest(value: unknown): { draft: KnowledgeDraft; userText: string; requestDigest: string; observationDigest: string } {
  const input = objectWithKeys(value, 'knowledge recording', ['userText', 'observation']);
  const userText = text(input.userText, 'native request', 12000);
  const observation = draft(input.observation);
  return { draft: observation, userText, requestDigest: createHash('sha256').update(canonicalNativeText(userText)).digest('hex'),
    observationDigest: observationDigest(observation) };
}

export function knowledgeObservation(input: KnowledgeDraft, project: string, sessionID: string, userMessageID: string, assistantMessageID: string, requestDigest: string): KnowledgeObservation {
  return parseKnowledgeObservation(JSON.stringify({ ...input, version: 1, kind: 'mdd-project-knowledge', status: 'observation', project,
    recordedAt: new Date().toISOString(), provenance: { kind: 'coordinator-observation', sessionID, userMessageID, assistantMessageID,
      requestDigest, observationDigest: observationDigest(input) } }), project, sessionID);
}

/** Both the provider row and its complete envelope must agree, including original author session. */
export function parseKnowledgeObservation(content: string, project: string, sessionID: string): KnowledgeObservation {
  if (Buffer.byteLength(content) > 16384) throw new Error('Knowledge envelope exceeds 16 KiB.');
  const input = objectWithKeys(JSON.parse(content), 'knowledge observation',
    ['version', 'kind', 'status', 'project', 'recordedAt', 'provenance', 'summary', 'body', 'applicability', 'sources']);
  if (input.version !== 1 || input.kind !== 'mdd-project-knowledge' || input.status !== 'observation' || input.project !== project)
    throw new Error('Knowledge envelope identity mismatch.');
  text(input.project, 'project', 256);
  const recordedAt = text(input.recordedAt, 'timestamp', 24);
  if (!Number.isFinite(Date.parse(recordedAt)) || new Date(recordedAt).toISOString() !== recordedAt) throw new Error('Invalid knowledge timestamp.');
  const source = objectWithKeys(input.provenance, 'knowledge provenance', ['kind', 'sessionID', 'userMessageID', 'assistantMessageID', 'requestDigest', 'observationDigest']);
  if (source.kind !== 'coordinator-observation' || source.sessionID !== sessionID || typeof source.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.requestDigest))
    throw new Error('Knowledge provenance mismatch.');
  const observation = draft({ summary: input.summary, body: input.body, applicability: input.applicability, sources: input.sources });
  const digest = observationDigest(observation);
  if (source.observationDigest !== digest) throw new Error('Knowledge observation digest mismatch.');
  return { ...observation,
    version: 1, kind: 'mdd-project-knowledge', status: 'observation', project, recordedAt,
    provenance: { kind: 'coordinator-observation', sessionID: text(source.sessionID, 'session', 256),
      userMessageID: text(source.userMessageID, 'user message', 256), assistantMessageID: text(source.assistantMessageID, 'assistant message', 256),
      requestDigest: source.requestDigest, observationDigest: digest } };
}

export function parseKnowledgeQuery(value: unknown): KnowledgeQuery {
  const input = objectWithKeys(value, 'knowledge query', ['query', 'phase', 'paths', 'limit']);
  const limit = input.limit === undefined ? 5 : input.limit;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > 10) throw new Error('Knowledge limit must be 1–10.');
  return { limit: limit as number, ...(input.query === undefined ? {} : { query: text(input.query, 'query', 200) }),
    ...(input.phase === undefined ? {} : { phase: phase(input.phase) }),
    ...(input.paths === undefined ? {} : { paths: list(input.paths, 'query paths', 16, path) }) };
}

export function knowledgeSummary(id: number, entry: KnowledgeObservation): KnowledgeSummary {
  return { ref: `engram:${id}`, summary: entry.summary, status: 'observation', freshness: 'unverified' };
}

export async function queryKnowledge(client: EngramHttp, query: KnowledgeQuery): Promise<KnowledgeSummary[]> {
  const found = await client.searchKnowledge(query.query ?? '', query.limit ?? 5);
  const entries: KnowledgeSummary[] = [];
  for (const row of found) {
    let entry: KnowledgeObservation;
    try { entry = parseKnowledgeObservation(row.content, client.project, row.sessionID); } catch { continue; }
    if (query.phase && !entry.applicability.phases.includes(query.phase)) continue;
    if (query.paths && !query.paths.some(target => entry.applicability.paths.some(scope => target === scope || target.startsWith(`${scope}/`)))) continue;
    entries.push(knowledgeSummary(row.id, entry));
  }
  return entries;
}
