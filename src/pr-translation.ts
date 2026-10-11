import { createHash } from 'node:crypto';

/**
 * A pull request body is read by a reviewer, so it is written in Spanish — but every sentence of
 * substance in it was written by a phase actor, and phase actors report in English by design: an
 * MDD report is read by MDD and by the coordinator before it is read by anyone else. The body was
 * therefore rendered as a Spanish frame wrapped around English prose, which is the one thing it
 * could not be: a reviewer met "Verified the implementation" under "Cambios".
 *
 * The coordinator already translates every other surface the user reads, so it translates these
 * too. What it may not do is *author* them, and a model asked to translate is a model that could
 * quietly improve, expand or invent. So the translation is checked before it is rendered, against
 * the recorded text it claims to be a translation of. The checks here are structural on purpose:
 * they cannot tell whether Spanish prose means what the English meant, and they do not pretend to.
 * What they can prove is that no fact entered or left along the way, which is the failure that
 * would matter — a number that changed, a file that disappeared, a paragraph that grew an opinion.
 */
export type Translatable = { key: string; label: string; source: string };
export type Translation = { key: string; text: string };

/**
 * Distinguishes "the Spanish you sent cannot be used" from every other way drafting can fail. The
 * caller bounds how many times it will ask for a better translation, and a note that quotes the
 * wrong user line must not consume one of those attempts.
 */
export class TranslationError extends Error {
  constructor(message: string) { super(message); this.name = 'TranslationError'; }
}

/** Below this a sentence is too short for length or vocabulary statistics to mean anything. */
const SHORT = 40;
const MIN_RATIO = 0.5;
const MAX_RATIO = 2.5;

/**
 * The parts of a sentence that must survive translation untouched, because they are facts rather
 * than words: quoted code, numbers, dotted or slashed or underscored identifiers, and shouted
 * constants. Plain hyphenated words are deliberately not in here — "read-only" is prose and its
 * Spanish is "de solo lectura", so demanding it verbatim would reject correct work.
 */
const FACTS = /`[^`\n]+`|\b\d[\d.,]*\d\b|\b\d\b|\b[A-Za-z0-9_$]+(?:[./\\_][A-Za-z0-9_$]+)+\b|\b[A-Z]{3,}[A-Z0-9_]*\b(?![a-z])/g;
/**
 * Function words that appear in essentially any Spanish sentence of length. Their absence is the
 * cheapest reliable sign that a string was passed through untranslated, which is the exact defect
 * this module exists to stop, and it catches it even when the English carried no stopword at all.
 */
const SPANISH = /\b(?:de|del|la|el|los|las|un|una|que|para|con|sin|se|en|al|por|su|sus|lo|es|son|desde|cuando|ahora|ya|sobre|entre|cada|todo|toda|más|pero|como)\b/i;
const ENGLISH = /\b(?:the|and|with|without|that|this|from|when|which|should|must|have|has|been|are|were|its|their|into|while|after|before|does|only|each|every|any|all)\b/gi;

function facts(value: string): Set<string> {
  return new Set((value.match(FACTS) ?? []).map(item => item.trim()));
}

/** Two distinct English function words is not proof of English; it is enough to doubt a copy. */
function looksEnglish(value: string): boolean {
  return new Set((value.match(ENGLISH) ?? []).map(word => word.toLowerCase())).size >= 2;
}

/**
 * Binds a set of translations to the exact recorded facts they were produced from. A run that
 * advances between asking for the text and answering with it has changed what the body would say,
 * and prose translated from the older evidence would be applied to newer evidence without anyone
 * noticing. The digest makes that mismatch loud instead of invisible.
 */
export function translationDigest(runID: string, entries: readonly Translatable[]): string {
  const canonical = JSON.stringify([runID, ...entries.map(entry => [entry.key, entry.source])]);
  return createHash('sha256').update(canonical).digest('hex');
}

function problem(entry: Translatable, text: string): string | undefined {
  if (!text.trim()) return 'quedó vacía';
  if (/[\x00-\x1f\x7f]/.test(text)) return 'trae caracteres de control';
  const source = facts(entry.source);
  const translated = facts(text);
  const missing = [...source].filter(item => !translated.has(item));
  const added = [...translated].filter(item => !source.has(item));
  // Named, not counted: a coordinator can only put back a token it can see quoted.
  if (missing.length) return `perdió datos que deben quedar igual: ${missing.slice(0, 6).join(', ')}`;
  if (added.length) return `agregó datos que el texto registrado no tiene: ${added.slice(0, 6).join(', ')}`;
  if (entry.source.length >= SHORT) {
    const ratio = text.length / entry.source.length;
    if (ratio < MIN_RATIO) return 'es demasiado corta para ser una traducción; parece un resumen';
    if (ratio > MAX_RATIO) return 'es demasiado larga para ser una traducción; parece una reescritura';
  }
  if (text.length >= SHORT && !SPANISH.test(text)) return 'no parece estar en español';
  if (text.trim() === entry.source.trim() && looksEnglish(entry.source)) return 'quedó igual que el original en inglés';
  return undefined;
}

/**
 * Text the coordinator writes itself, for a direct edit no phase recorded. With no source to hold
 * it to, only what can be told without one is checked: it is there, it is one line a table cell
 * can carry, and it is Spanish rather than the English the coordinator was just reading.
 */
export function authoredProblem(text: string): string | undefined {
  if (!text.trim()) return 'quedó vacío';
  if (/[\x00-\x1f\x7f]/.test(text)) return 'trae saltos de línea o caracteres de control; tiene que ser una sola línea';
  if (text.length >= SHORT && !SPANISH.test(text)) return 'no parece estar en español';
  return undefined;
}

/**
 * Every requested key, exactly once, each one a plausible translation of the text it answers.
 * All the problems are collected and reported together: a coordinator that learns about one fault
 * per attempt spends the retry budget discovering the next one instead of fixing anything.
 */
export function checkTranslations(entries: readonly Translatable[], value: readonly Translation[]): Map<string, string> {
  const wanted = new Map(entries.map(entry => [entry.key, entry]));
  const given = new Map<string, string>();
  const faults: string[] = [];
  for (const item of value) {
    if (!wanted.has(item.key)) { faults.push(`"${item.key}" no es una de las claves pedidas`); continue; }
    if (given.has(item.key)) { faults.push(`"${item.key}" viene repetida`); continue; }
    given.set(item.key, item.text);
  }
  for (const entry of entries) {
    const text = given.get(entry.key);
    if (text === undefined) { faults.push(`falta "${entry.key}"`); continue; }
    const fault = problem(entry, text);
    if (fault) faults.push(`"${entry.key}" ${fault}`);
  }
  if (faults.length) {
    throw new TranslationError(`La traducción no se pudo usar: ${faults.slice(0, 8).join('; ')}. Traducí al español cada texto tal como está, conservando números, rutas, identificadores y comandos exactamente igual, sin agregar ni quitar nada.`);
  }
  return new Map([...given].map(([key, text]) => [key, text.trim()]));
}
