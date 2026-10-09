import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { EngramHttp } from './engram-http.js';
import type { KnowledgeCache } from './knowledge-cache.js';
import { canonicalNativeText } from './native-text.js';
import { PHASES } from './policy.js';
import type { Phase } from './policy.js';
import { objectWithKeys } from './validation.js';
import { scopedPath } from './safe-paths.js';

export type KnowledgeDraft = {
  summary: string;
  body: string;
  applicability: { phases: Phase[]; paths: string[] };
  sources: string[];
};
export type KnowledgeDependency = { path: string; digest: string };
export type KnowledgeObservation = KnowledgeDraft & {
  kind: 'mdd-project-knowledge';
  status: 'observation';
  project: string;
  recordedAt: string;
  provenance: { kind: 'coordinator-observation'; sessionID: string; userMessageID: string; assistantMessageID: string; requestDigest: string; observationDigest: string };
} & ({ version: 1; dependencies?: never } | { version: 2; dependencies: KnowledgeDependency[] });
export type KnowledgeQuery = { query?: string; phase?: Phase; paths?: string[]; limit?: number };
export type KnowledgeFreshness = 'fresh' | 'stale' | 'unverified';
export type KnowledgeSummary = { ref: string; summary: string; status: 'observation'; freshness: KnowledgeFreshness };
export const KNOWLEDGE_NOTE = 'Candidate coordinator observations, not user-authored assertions or approval. Fresh means only declared dependency bytes match this checkout now; stale/unverified entries are not eligible for reuse. No execution authority.';
const SOURCE_BYTES = 256 * 1024;
const TOTAL_SOURCE_BYTES = 1024 * 1024;

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))
    throw new Error(`Invalid knowledge ${name}.`);
  return value;
}

/** Shared lexical check for exact relative references and applicability scopes. */
function path(value: unknown): string {
  const result = text(value, 'relative source path', 256);
  if (/[\\:*?"<>|]/.test(result) || result.split('/').some(part => !part || part === '.' || part === '..' ||
      /[\x00-\x20]|[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)))
    throw new Error('Unsafe knowledge relative path.');
  return result;
}

function sourcePath(value: unknown): string {
  const result = path(value);
  if (result.includes('~') || result.split('/').some(part => part.startsWith('.') ||
      /(?:^|[._-])(?:credentials?|secrets?|passwords?|tokens?|id_rsa|id_ed25519|id_dsa|id_ecdsa|private[-_]?key)(?:[._-]|$)/i.test(part)) ||
      /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(result)) throw new Error('Private knowledge source paths are forbidden.');
  return result;
}

function sameFile(a: fs.Stats, b: fs.Stats): boolean {
  return b.isFile() && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Hash bounded descriptors, never follow links, and reject observable identity/byte races. */
export function captureKnowledgeDependencies(directory: string, sources: readonly string[]): KnowledgeDependency[] {
  const names = list(sources, 'source dependencies', 16, sourcePath);
  let total = 0;
  return names.map(name => {
    const file = scopedPath(directory, name);
    const before = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!before) {
      if (fs.lstatSync(scopedPath(directory, name), { throwIfNoEntry: false })) throw new Error('Knowledge source changed during capture.');
      return { path: name, digest: 'missing' };
    }
    if (!before.isFile() || before.nlink !== 1 || before.size > SOURCE_BYTES || total + before.size > TOTAL_SOURCE_BYTES)
      throw new Error('Knowledge source is unsafe or exceeds the 256 KiB/file or 1 MiB total limit.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      // Recheck the full ancestor chain and descriptor before reading any source bytes.
      const opened = fs.lstatSync(scopedPath(directory, name));
      if (!sameFile(before, opened) || !sameFile(before, fs.fstatSync(fd))) throw new Error('Knowledge source identity changed.');
      const bytes = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size !== before.size || !sameFile(before, fs.fstatSync(fd)) || !sameFile(before, fs.lstatSync(scopedPath(directory, name))))
        throw new Error('Knowledge source changed during capture.');
      total += size;
      return { path: name, digest: createHash('sha256').update(bytes.subarray(0, size)).digest('hex') };
    } finally { fs.closeSync(fd); }
  });
}

export function knowledgeFreshness(entry: KnowledgeObservation, directory: string): KnowledgeFreshness {
  if (entry.version === 1) return 'unverified';
  try {
    const current = captureKnowledgeDependencies(directory, entry.sources);
    return current.every(item => entry.dependencies.some(old => old.path === item.path && old.digest === item.digest)) ? 'fresh' : 'stale';
  } catch { return 'stale'; }
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
function observationDigest(value: KnowledgeDraft, dependencies?: KnowledgeDependency[]): string {
  return createHash('sha256').update(JSON.stringify({ summary: value.summary, body: value.body,
    applicability: { phases: [...value.applicability.phases].sort(), paths: [...value.applicability.paths].sort() },
    sources: [...value.sources].sort(), ...(dependencies ? { dependencies: [...dependencies].sort((a, b) => a.path.localeCompare(b.path)) } : {}) })).digest('hex');
}

/** The native request grounds context, not authorship or approval of the coordinator's finding. */
export function parseKnowledgeRequest(value: unknown): { draft: KnowledgeDraft; userText: string; requestDigest: string; observationDigest: string } {
  const input = objectWithKeys(value, 'knowledge recording', ['userText', 'observation']);
  const userText = text(input.userText, 'native request', 12000);
  const observation = draft(input.observation);
  return { draft: observation, userText, requestDigest: createHash('sha256').update(canonicalNativeText(userText)).digest('hex'),
    observationDigest: observationDigest(observation) };
}

export function knowledgeObservation(input: KnowledgeDraft, project: string, sessionID: string, userMessageID: string, assistantMessageID: string, requestDigest: string, dependencies?: KnowledgeDependency[]): KnowledgeObservation {
  return parseKnowledgeObservation(JSON.stringify({ ...input, version: dependencies ? 2 : 1, ...(dependencies ? { dependencies } : {}), kind: 'mdd-project-knowledge', status: 'observation', project,
    recordedAt: new Date().toISOString(), provenance: { kind: 'coordinator-observation', sessionID, userMessageID, assistantMessageID,
      requestDigest, observationDigest: observationDigest(input, dependencies) } }), project, sessionID);
}

/** Both the provider row and its complete envelope must agree, including original author session. */
export function parseKnowledgeObservation(content: string, project: string, sessionID: string, decoded?: unknown): KnowledgeObservation {
  if (Buffer.byteLength(content) > 16384) throw new Error('Knowledge envelope exceeds 16 KiB.');
  // A materialized disk cache can avoid decoding canonical JSON again, but never substitute data.
  if (decoded !== undefined && JSON.stringify(decoded) !== content) throw new Error('Cached knowledge differs from canonical bytes.');
  const input = objectWithKeys(decoded === undefined ? JSON.parse(content) : decoded, 'knowledge observation',
    ['version', 'kind', 'status', 'project', 'recordedAt', 'provenance', 'summary', 'body', 'applicability', 'sources', 'dependencies']);
  if (![1, 2].includes(input.version as number) || input.kind !== 'mdd-project-knowledge' || input.status !== 'observation' || input.project !== project)
    throw new Error('Knowledge envelope identity mismatch.');
  text(input.project, 'project', 256);
  const recordedAt = text(input.recordedAt, 'timestamp', 24);
  if (!Number.isFinite(Date.parse(recordedAt)) || new Date(recordedAt).toISOString() !== recordedAt) throw new Error('Invalid knowledge timestamp.');
  const source = objectWithKeys(input.provenance, 'knowledge provenance', ['kind', 'sessionID', 'userMessageID', 'assistantMessageID', 'requestDigest', 'observationDigest']);
  if (source.kind !== 'coordinator-observation' || source.sessionID !== sessionID || typeof source.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.requestDigest))
    throw new Error('Knowledge provenance mismatch.');
  const observation = draft({ summary: input.summary, body: input.body, applicability: input.applicability, sources: input.sources });
  let dependencies: KnowledgeDependency[] | undefined;
  if (input.version === 2) {
    dependencies = list(input.dependencies, 'dependencies', 16, value => {
      const item = objectWithKeys(value, 'knowledge dependency', ['path', 'digest']);
      if (typeof item.digest !== 'string' || !/^(?:missing|[a-f0-9]{64})$/.test(item.digest)) throw new Error('Invalid knowledge source digest.');
      return { path: sourcePath(item.path), digest: item.digest };
    });
    if (dependencies.length !== observation.sources.length || new Set(dependencies.map(item => item.path)).size !== dependencies.length ||
        !observation.sources.every(name => dependencies!.some(item => item.path === name))) throw new Error('Knowledge dependencies must cover exactly the declared sources.');
  } else if (Object.hasOwn(input, 'dependencies')) throw new Error('Legacy knowledge cannot claim captured dependencies.');
  const digest = observationDigest(observation, dependencies);
  if (source.observationDigest !== digest) throw new Error('Knowledge observation digest mismatch.');
  return { ...observation,
    ...(dependencies ? { version: 2 as const, dependencies } : { version: 1 as const }), kind: 'mdd-project-knowledge', status: 'observation', project, recordedAt,
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

export function knowledgeSummary(id: number, entry: KnowledgeObservation, freshness: KnowledgeFreshness = 'unverified'): KnowledgeSummary {
  return { ref: `engram:${id}`, summary: entry.summary, status: 'observation', freshness };
}

export async function queryKnowledge(client: EngramHttp, query: KnowledgeQuery, directory: string, cache?: KnowledgeCache): Promise<KnowledgeSummary[]> {
  const found = await client.searchKnowledge(query.query ?? '', query.limit ?? 5);
  const entries: KnowledgeSummary[] = [];
  for (const row of found) {
    let entry: KnowledgeObservation;
    try { entry = cache ? cache.resolve(row, client.project) : parseKnowledgeObservation(row.content, client.project, row.sessionID); } catch { continue; }
    if (query.phase && !entry.applicability.phases.includes(query.phase)) continue;
    if (query.paths && !query.paths.some(target => entry.applicability.paths.some(scope => target === scope || target.startsWith(`${scope}/`)))) continue;
    entries.push(knowledgeSummary(row.id, entry, knowledgeFreshness(entry, directory)));
  }
  return entries;
}
