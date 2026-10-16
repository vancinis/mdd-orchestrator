import { CORRECTION_FIELDS, PHASE_RESULT_FIELDS, FIELD_SCHEMA, STRUCTURED_FIELD_SCHEMA } from './acceptance.js';
import { verificationVersion, type VerificationVersion } from './phase-evidence.js';
import type { Phase } from './policy.js';
import { parseNarrative } from './reporting.js';
import type { Narrative } from './reporting.js';

/**
 * How a phase answers. A phase report is a short markdown document a person can read, not a
 * serialized object: the summary and the artifact are the work, and they are prose because that
 * is what they were always meant to be. Only the traceability fields a phase genuinely carries
 * stay structured, in one fenced block of their own, because MDD validates them link by link and
 * ambiguity there is not a stylistic question.
 *
 * The previous contract demanded that the actor's entire final message be a single JSON object.
 * One sentence of ordinary prose around it, one stray key, one code fence in the wrong place, and
 * a finished phase was discarded whole. This format is parsed leniently in every place where
 * leniency cannot change a fact, and strictly in the few places where it can.
 */

/**
 * A report whose form could not be read, as opposed to a phase that reported failure. The work a
 * malformed report describes may be finished and already on disk, so this is not an outcome: it
 * is a transcription problem, and MDD hands the text back to be restated rather than spending an
 * attempt and asking for the work again.
 */
/**
 * How many times a phase may restate a report MDD could not read before the attempt is spent.
 * Restating costs a message; re-running a phase costs the phase, so the first few are free.
 */
export const MALFORMED_RESTATEMENTS = 3;

export class MalformedReport extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedReport';
  }
}

/** Headings MDD reads. Everything else in the document belongs to the section it sits in. */
const SECTIONS = ['outcome', 'summary', 'how', 'purpose', 'openItems', 'learnings', 'confidence', 'artifact', 'data', 'concerns', 'questions', 'phase', 'run'] as const;
type Section = typeof SECTIONS[number];
/** The prose sections a phase report carries beside its summary, under the field each is read into. */
const NARRATIVE = ['purpose', 'openItems', 'learnings', 'confidence'] as const;
const REQUIRED: readonly Section[] = ['outcome', 'summary', 'artifact'];
/**
 * The canonical headings carry the `MDD` prefix precisely so an artifact may hold its own
 * `## Summary` or `## Data` without colliding with the envelope that carries it. Unprefixed
 * headings still work, but only for a document that used no prefixed heading at all, so a
 * well-formed report can never be split by its own contents.
 */
const PREFIX = 'mdd ';
const ALIASES: Record<string, Section> = {
  outcome: 'outcome', summary: 'summary', artifact: 'artifact',
  // A phase reports "Approach"; "How" is the heading the risk and security reports still use and
  // the one phase reports used before, so both name the same section and cannot appear together.
  approach: 'how', how: 'how',
  purpose: 'purpose', 'open items': 'openItems', learnings: 'learnings', 'key learnings': 'learnings', confidence: 'confidence',
  data: 'data', concerns: 'concerns', phase: 'phase',
  questions: 'questions', 'open questions': 'questions',
  run: 'run', runid: 'run', 'run id': 'run',
  'evidence summary': 'summary',
};
const HEADING = /^#{1,6}[ \t]+(.+?)[ \t]*:?[ \t]*$/;
const FENCE = /^[ \t]*(?:```|~~~)/;
const EMPHASIS = /[*_`]/g;

function sectionOf(line: string, prefixed: boolean): Section | undefined {
  const heading = HEADING.exec(line);
  if (!heading) return undefined;
  const name = heading[1]!.replace(EMPHASIS, '').trim().toLowerCase();
  if (prefixed) return name.startsWith(PREFIX) ? ALIASES[name.slice(PREFIX.length).trim()] : undefined;
  return ALIASES[name.startsWith(PREFIX) ? name.slice(PREFIX.length).trim() : name];
}

/**
 * Splits the document into its named sections. A heading inside a fenced block is content, never
 * a delimiter, so an artifact may quote this very format without being cut in half by it.
 */
function sections(text: string): Map<Section, string> | undefined {
  const lines = text.split(/\r?\n/);
  const scan = (prefixed: boolean) => {
    const found = new Map<Section, string[]>();
    const duplicates: Section[] = [];
    let current: Section | undefined;
    let fenced = false;
    for (const line of lines) {
      if (FENCE.test(line)) fenced = !fenced;
      const section = fenced ? undefined : sectionOf(line, prefixed);
      if (section === undefined) { current !== undefined && found.get(current)!.push(line); continue; }
      if (found.has(section)) duplicates.push(section);
      found.set(section, []);
      current = section;
    }
    return { found, duplicates };
  };
  // A document that names even one prefixed heading is read as prefixed throughout: that is what
  // keeps an artifact's own `## Summary` out of the envelope's namespace.
  const prefixed = lines.some(line => sectionOf(line, true) !== undefined);
  const { found, duplicates } = scan(prefixed);
  if (duplicates.length) {
    throw new MalformedReport(`The phase report repeats the ${duplicates.map(name => `"${prefixed ? 'MDD ' : ''}${name}"`).join(' and ')} heading. Use each MDD heading exactly once; headings inside the artifact must not reuse those names.`);
  }
  if (!REQUIRED.every(name => found.has(name))) return undefined;
  return new Map([...found].map(([name, body]) => [name, body.join('\n').trim()]));
}

/** The first fenced block of a section, or the whole body when the actor omitted the fence. */
function fenced(body: string): string {
  const block = /(?:^|\n)[ \t]*(?:```|~~~)[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*(?:```|~~~)[ \t]*(?:\n|$)/.exec(body);
  return (block ? block[1]! : body).trim();
}

function outcomeOf(body: string): 'passed' | 'failed' {
  const word = body.replace(EMPHASIS, '').trim().split(/[\s.,;:]+/)[0]?.toLowerCase();
  if (word !== 'passed' && word !== 'failed') {
    throw new MalformedReport(`The phase report's outcome must be exactly "passed" or "failed"; it read ${JSON.stringify(body.slice(0, 64))}.`);
  }
  return word;
}

/**
 * Reads the level the actor gave its confidence and the reason it gave for it. Strict, because a
 * level is a claim the user reads: guessing "high" out of "highly uncertain" would invert it.
 */
export function parseConfidence(value: unknown): { level: 'high' | 'medium' | 'low'; reason: string } {
  const match = typeof value === 'string'
    ? /^[\s*_`]*(high|medium|low)\b[*_`]*(?:[ \t]+confidence\b)?[*_`]*[ \t]*[-—–:.,;]*\s*([\s\S]*)$/i.exec(value)
    : null;
  if (!match) {
    throw new MalformedReport(`The confidence section must start with exactly one level word, High, Medium or Low; it read ${JSON.stringify(String(value).slice(0, 64))}.`);
  }
  const reason = match[2]!.trim();
  if (!reason) throw new MalformedReport('The confidence section must give the evidence behind its level, not the level alone.');
  return { level: match[1]!.toLowerCase() as 'high' | 'medium' | 'low', reason };
}

/**
 * The narrative sections of a parsed phase report, validated exactly as the renderer will read
 * them, so a section that cannot be shown is named back to its writer instead of failing later.
 * Absent sections stay absent: the renderer says so, and nothing here writes one on their behalf.
 */
export function narrativeOf(fields: Record<string, unknown>): Narrative {
  const prose = (key: 'purpose' | 'openItems' | 'learnings', label: string) => {
    const value = fields[key];
    if (value === undefined) return {};
    if (typeof value !== 'string' || !value.trim()) throw new MalformedReport(`The ${label} section must be nonempty prose.`);
    return { [key]: value };
  };
  try {
    return parseNarrative({ ...prose('purpose', 'purpose'), ...prose('openItems', 'open items'), ...prose('learnings', 'learnings'),
      ...(fields.confidence !== undefined ? { confidence: parseConfidence(fields.confidence) } : {}) });
  } catch (error) {
    if (error instanceof MalformedReport) throw error;
    throw new MalformedReport(`A narrative section could not be presented: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function structured(body: string, label: string): unknown {
  const text = fenced(body);
  if (!text) return undefined;
  try { return JSON.parse(text); }
  catch { throw new MalformedReport(`The ${label} section must hold one fenced JSON block. It did not parse as JSON: ${JSON.stringify(text.slice(0, 120))}.`); }
}

/**
 * Reads a phase report in either shape and returns the flat record the rest of MDD already works
 * with. Prose is preferred and JSON is still accepted, so an actor that answers the old way is
 * understood rather than failed: this parser only ever decides what was reported, never whether
 * the report is allowed, and every field it produces is validated downstream exactly as before.
 */
export function parsePhaseReport(text: string, phase: Phase): Record<string, unknown> {
  return parseReportSections(text, PHASE_RESULT_FIELDS[phase].length > 0);
}

/**
 * Parses the risk actor's report. It shares the same envelope and section-splitting rules as a
 * phase report — this is still "## MDD Outcome", "## MDD Summary" and the rest — but `mdd-risk`
 * is not a `Phase`, so this is kept apart from `parsePhaseReport` rather than widening that
 * function (or `PHASE_RESULT_FIELDS`) to accept an actor that occupies no stop on the route.
 */
export function parseRiskReport(text: string): Record<string, unknown> {
  return parseReportSections(text, true);
}

/** Standalone security data cannot overwrite the shared envelope or masquerade as phase data. */
export function parseSecurityReport(text: string): Record<string, unknown> {
  return parseReportSections(text, true, 'security');
}

function parseReportSections(text: string, hasFields: boolean, standaloneField?: string): Record<string, unknown> {
  const parts = sections(text);
  if (!parts) {
    const json = jsonDocument(text);
    if (json) return json;
    throw new MalformedReport(`The phase report needs the headings "## MDD Outcome", "## MDD Summary" and "## MDD Artifact"${hasFields ? ', plus "## MDD Data" with this phase\'s fields' : ''}. Report prose under those headings; a bare JSON object is also accepted.`);
  }
  const result: Record<string, unknown> = {
    outcome: outcomeOf(parts.get('outcome')!),
    evidenceSummary: parts.get('summary')!,
    artifact: parts.get('artifact')!,
  };
  if (parts.has('how')) result.how = parts.get('how')!;
  for (const name of NARRATIVE) if (parts.has(name)) result[name] = parts.get(name)!;
  const binding = parts.get('phase');
  const run = parts.get('run');
  if (binding) result.phase = binding.replace(EMPHASIS, '').trim();
  if (run) result.runID = run.replace(EMPHASIS, '').trim();
  const concerns = parts.has('concerns') ? structured(parts.get('concerns')!, 'concerns') : undefined;
  if (concerns !== undefined) result.concerns = concerns;
  const questions = parts.has('questions') ? structured(parts.get('questions')!, 'questions') : undefined;
  if (questions !== undefined) result.questions = questions;
  const data = parts.has('data') ? structured(parts.get('data')!, 'data') : undefined;
  if (data !== undefined) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new MalformedReport('The data section must hold one JSON object whose keys are this phase\'s fields.');
    if (standaloneField && (Object.keys(data).length !== 1 || !Object.hasOwn(data, standaloneField))) {
      throw new MalformedReport(`The data section must hold exactly the standalone field ${standaloneField}.`);
    }
    for (const [key, value] of Object.entries(data)) result[key] = value;
  }
  return result;
}

/** The legacy shape: the whole message is one JSON object, optionally inside a single fence. */
function jsonDocument(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const body = /^(?:```|~~~)[A-Za-z]*\r?\n([\s\S]*?)\r?\n?(?:```|~~~)$/.exec(trimmed)?.[1]?.trim() ?? trimmed;
  if (!body.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** The instructions an actor is given for this phase, in the order the document is written. */
export function reportFormatLines(phase: Phase, version?: VerificationVersion, correction = false): string[] {
  verificationVersion(version);
  const fields = [...PHASE_RESULT_FIELDS[phase], ...(correction && phase === 'mdd-apply' ? CORRECTION_FIELDS : []),
    ...(version && PHASE_RESULT_FIELDS[phase].length ? ['verificationVersion'] : [])];
  return [
    'Report this phase as a short markdown document, not as a JSON object. Use these exact headings, each once:',
    '"## MDD Outcome" holding exactly passed or failed.',
    '"## MDD Summary" holding plain prose a person reads first: what you did and what came of it, in a short paragraph. No call IDs, routing details or confidence statements.',
    '"## MDD Approach" holding how you carried out the work: the concrete changes, decisions or investigation steps, and the source-grounded reason for each. Do not repeat the summary or list commands; if a reason is unknown, say so instead of inventing one.',
    '"## MDD Purpose" holding why this work was done: the problem it addresses and how it advances the user objective.',
    '"## MDD Open Items" holding what remains uncertain or still to be done, each with its impact. Write "None." when nothing remains; never leave an open item out to make the work look finished.',
    '"## MDD Learnings" holding the key points learned that matter to the user or to later phases: facts about the code, constraints, surprises, options rejected and why. Write "None." when nothing notable was learned.',
    '"## MDD Confidence" starting with exactly one level word, High, Medium or Low, for how confident you are that this result is the best one achievable for the objective, followed by the evidence that supports that level and what would raise it. A level, never a percentage.',
    'Write every one of these prose sections in every report. The user\'s chosen report detail decides which of them they are shown, not which of them you write: the rest is shown when they ask for more.',
    `"## MDD Artifact" holding the actual deliverable of this phase, in ordinary markdown. ${fields.length ? 'MDD appends its own links section to this text. ' : ''}Headings inside it must not reuse an "MDD ..." name.`,
    ...(fields.length
      ? [`"## MDD Data" holding ONE fenced json block with exactly these keys: ${fields.join(', ')}. No other key is accepted.`,
         ...fields.map(field => `  ${(version ? STRUCTURED_FIELD_SCHEMA[field] : undefined) ?? FIELD_SCHEMA[field]!}`)]
      : [`This phase reports no structured data, so omit "## MDD Data" entirely.`]),
    'Optional "## MDD Concerns" holding a fenced json array of at most eight {category,evidence,impact} entries, category objective/integrations/sensitive-data/permissions. Advisory only: concerns never change the route or the evidence and never request governance for ordinary implementation choices.',
    'Optional "## MDD Questions" holding a fenced json array of at most eight {question,why,options:[{label,description,recommended?}],multiple?,deferrable?} entries: decisions only the user can make that the work genuinely needs, instead of guessing them. "why" states what depends on the answer. Leave options empty for an open-ended answer; set multiple when several options can apply together, and deferrable only when a later phase can safely decide. Never ask what reading the request or the repository answers, and never ask for approval. The coordinator asks the user and hands the answers to the next phase.',
    'Write nothing outside these headings. Prose around them is ignored, but anything you need MDD to record belongs under a heading.',
  ];
}
