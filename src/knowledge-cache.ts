import { LocalFiles } from './local-files.js';
import { parseKnowledgeObservation } from './project-knowledge.js';
import type { KnowledgeObservation } from './project-knowledge.js';
import { objectWithKeys } from './validation.js';

const NAME = '.mdd/knowledge-cache.json';
const BYTES = 512 * 1024;
const ENTRIES = 100;
type Canonical = { id: number; sessionID: string; content: string };
type Row = Canonical & { project: string; decoded: unknown };
type Cached = Row & { parsed?: KnowledgeObservation };
const key = (row: Pick<Row, 'project' | 'id'>) => JSON.stringify([row.project, row.id]);
const serialize = (rows: Row[]) => JSON.stringify({ version: 1, entries: rows.map(({ id, project, sessionID, decoded }) => ({ id, project, sessionID, observation: decoded })) });

function decode(source: string | undefined): Row[] {
  if (source === undefined) return [];
  try {
    if (Buffer.byteLength(source) > BYTES) return [];
    const value = objectWithKeys(JSON.parse(source), 'knowledge cache', ['version', 'entries']);
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > ENTRIES) return [];
    const rows = value.entries.map(value => {
      const row = objectWithKeys(value, 'knowledge cache row', ['id', 'project', 'sessionID', 'observation']);
      const observation = row.observation as Record<string, unknown> | null;
      const content = JSON.stringify(row.observation);
      if (!Number.isSafeInteger(row.id) || (row.id as number) < 1 ||
          typeof row.project !== 'string' || !row.project.trim() || Buffer.byteLength(row.project) > 256 ||
          typeof row.sessionID !== 'string' || !row.sessionID.trim() || Buffer.byteLength(row.sessionID) > 256 ||
          !observation || typeof observation !== 'object' || Array.isArray(observation) ||
          typeof observation.body !== 'string' || Buffer.byteLength(observation.body) > 4096 ||
          typeof content !== 'string' || Buffer.byteLength(content) > 16384) throw new Error('Invalid cache row.');
      return { id: row.id as number, project: row.project, sessionID: row.sessionID, content, decoded: row.observation };
    });
    return new Set(rows.map(key)).size === rows.length ? rows : [];
  } catch { return []; }
}

function bounded<T extends Row>(rows: T[]): T[] {
  const kept = rows.slice(-ENTRIES);
  while (kept.length && Buffer.byteLength(serialize(kept)) > BYTES) kept.shift();
  return kept;
}

/**
 * Rebuildable parsing cache, not an offline reader. Each resolve requires the entire canonical
 * observation freshly fetched by EngramHttp. Disk materialization avoids decoding that JSON again;
 * exact content equality with a warm entry also reuses validated normalization and digest checks.
 * Source bytes and canonical provider identity/deletion checks are never cached here.
 */
export class KnowledgeCache {
  readonly #files: LocalFiles;
  #loaded = false;
  #rows = new Map<string, Cached>();
  constructor(root: string, readonly parse = parseKnowledgeObservation) { this.#files = new LocalFiles(root); }

  #load(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    try { this.#rows = new Map(decode(this.#files.read(NAME, BYTES)).map(row => [key(row), row])); }
    catch {
      // Only this disposable fixed destination can be removed; LocalFiles still refuses links.
      try { this.#files.remove(NAME); } catch { /* Unsafe or unwritable storage remains untouched. */ }
    }
  }

  resolve(canonical: Canonical, project: string): KnowledgeObservation {
    this.#load();
    const row = { ...canonical, project };
    if (!Number.isSafeInteger(row.id) || row.id < 1) throw new Error('Invalid canonical knowledge reference.');
    const old = this.#rows.get(key(row));
    if (old?.sessionID === row.sessionID && old.content === row.content && old.parsed) return structuredClone(old.parsed);
    // Disk rows are untrusted. Full canonical byte equality precedes today's structural validator.
    const parsed = this.parse(row.content, project, row.sessionID,
      old?.sessionID === row.sessionID && old.content === row.content ? old.decoded : undefined);
    const materialized = { ...row, decoded: parsed };
    this.#rows.delete(key(row));
    this.#rows.set(key(row), { ...materialized, parsed });
    this.#rows = new Map(bounded([...this.#rows.values()]).map(item => [key(item), item]));
    try {
      this.#files.update(NAME, previous => {
        // Merge under LocalFiles' lock instead of losing another checkout's newly cached entries.
        const merged = bounded([...decode(previous).filter(item => key(item) !== key(row)), materialized]);
        return serialize(merged);
      }, BYTES);
    } catch { /* A cache write never changes a canonical result or a run. */ }
    return structuredClone(parsed);
  }
}
