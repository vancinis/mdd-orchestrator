import { createHash } from 'node:crypto';
import { PHASES, type Phase } from './policy.js';
import { objectWithKeys } from './validation.js';
import { readKnowledgeSource, sourcePath, type KnowledgeCounts, type KnowledgeSelection } from './project-knowledge.js';

const CATALOG = 'mdd/knowledge.json';
const CATALOG_BYTES = 32768, SKILL_BYTES = 65536, EXCERPT_BYTES = 4096;
type CatalogEntry = { id: string; path: string; approved: true; phases: Phase[]; terms: string[]; paths: string[]; tools: string[] };
export type CatalogSkill = CatalogEntry & { excerpt: string; catalogDigest: string; sourceDigest: string };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function strings(value: unknown, max: number, valid: (item: string) => boolean): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !valid(item)) || new Set(value).size !== value.length)
    throw new Error('Invalid bounded catalog list.');
  return value;
}
function parse(bytes: Buffer): CatalogEntry[] {
  const value = objectWithKeys(JSON.parse(bytes.toString('utf8')), 'knowledge catalog', ['version', 'skills']);
  if (value.version !== 1 || !Array.isArray(value.skills) || value.skills.length > 32) throw new Error('Invalid catalog version or size.');
  const entries = value.skills.map(raw => {
    const item = objectWithKeys(raw, 'catalog skill', ['id', 'path', 'approved', 'phases', 'terms', 'paths', 'tools']);
    if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(item.id) || item.approved !== true) throw new Error('Catalog approval required.');
    const path = sourcePath(item.path);
    if (!/(^|\/)SKILL\.md$/.test(path)) throw new Error('Catalog requires an exact SKILL.md reference.');
    const phases = strings(item.phases, 8, phase => PHASES.includes(phase as Phase)) as Phase[];
    const terms = strings(item.terms, 8, term => /^[a-z0-9][a-z0-9 -]{0,63}$/.test(term) && term === term.trim());
    const paths = strings(item.paths, 16, path => sourcePath(path) === path);
    const tools = strings(item.tools ?? [], 16, tool => /^[a-z][a-z0-9_-]{0,63}$/.test(tool));
    if (!phases.length || !terms.length) throw new Error('Catalog phase and literal objective terms required.');
    return { id: item.id, path, approved: true as const, phases, terms, paths, tools };
  });
  if (new Set(entries.map(item => item.id)).size !== entries.length || new Set(entries.map(item => item.path)).size !== entries.length)
    throw new Error('Duplicate catalog skill.');
  return entries;
}
function applies(item: CatalogEntry, selection: KnowledgeSelection): boolean {
  return item.phases.includes(selection.phase) && item.terms.some(term => selection.objective.toLowerCase().includes(term)) &&
    (!item.paths.length || selection.paths.some(path => item.paths.some(prefix => path === prefix || path.startsWith(`${prefix}/`))));
}

/** Optional explicit local policy only. Never discover other files or turn it into permissions. */
export function readKnowledgeCatalog(directory: string, selection: KnowledgeSelection, metrics: KnowledgeCounts): CatalogSkill[] {
  let bytes: Buffer, entries: CatalogEntry[];
  try {
    const read = readKnowledgeSource(directory, CATALOG, CATALOG_BYTES);
    if (!read) return [];
    bytes = read; entries = parse(bytes);
  } catch { return []; }
  metrics.candidates += entries.length;
  const result: CatalogSkill[] = [];
  for (const entry of entries) {
    if (!applies(entry, selection)) continue;
    try {
      const source = readKnowledgeSource(directory, entry.path, SKILL_BYTES);
      if (!source) throw new Error('Missing catalog skill.');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
      const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
      if (!front?.[1]!.split(/\r?\n/).includes(`name: ${entry.id}`) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw new Error('Invalid skill text.');
      // A UTF-8 boundary and explicit truncation marker keep large approved skills bounded.
      let excerpt = source.subarray(0, EXCERPT_BYTES).toString('utf8').replace(/\ufffd$/, '');
      if (source.length > EXCERPT_BYTES) excerpt += '\n[Excerpt truncated]';
      result.push({ ...entry, excerpt, catalogDigest: digest(bytes), sourceDigest: digest(source) });
      metrics.freshHits++;
    } catch { metrics.staleRejects++; }
  }
  return result.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function catalogSkillFresh(skill: CatalogSkill, selection: KnowledgeSelection, directory: string): boolean {
  try {
    const catalog = readKnowledgeSource(directory, CATALOG, CATALOG_BYTES);
    const source = readKnowledgeSource(directory, skill.path, SKILL_BYTES);
    return applies(skill, selection) && !!catalog && !!source && digest(catalog) === skill.catalogDigest && digest(source) === skill.sourceDigest;
  } catch { return false; }
}
