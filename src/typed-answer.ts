import type { QuestionEnvelope } from './preflight.js';
import { objectWithKeys, ValidationError } from './validation.js';

/**
 * Reading a person's own words as the answer to an MDD question.
 *
 * The form is how MDD asks, and it stays that way. But a form can be dismissed, interrupted, or
 * answered with a sentence typed into its own text box, and a person who then writes "1. algo
 * seguro 2. engram 3. automático" has answered. Throwing that away and asking again is what made
 * people give up on a run.
 *
 * The coordinator reads the words; this module checks the reading. It never interprets anything
 * itself: every option the coordinator claims has to be written in the user's text, and nothing
 * else on offer for the same question may be, so "no quiero engram, mejor openspec" is ambiguous
 * rather than whichever of the two the model preferred. Case, accents and punctuation are how
 * people type, not what they chose, so they are ignored; the words themselves are not.
 */

/** One answer as the coordinator read it: the offered labels it found, and where it found them. */
export type TypedAnswer = { labels: string[]; quote?: string };

/** What the user wrote that may answer one question, and whether it was written for that question alone. */
export type TypedEvidence = { text: string; own: boolean };

const RECOMMENDED = / \(Recomendada\)$/;
const ANSWER_MAX = 12000;

/** The comparable form of what someone wrote: no case, accents or punctuation, single spaces. */
export function answerWords(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** A recommended clarification option is shown with a suffix nobody types back. */
function spoken(label: string): string {
  return answerWords(label.replace(RECOMMENDED, ''));
}

/** Whole words only: "medio" is not written inside "intermedio". */
function occurrences(words: string): RegExp {
  return new RegExp(`(?<=^| )${words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?= |$)`, 'g');
}

export function mentions(text: string, label: string): boolean {
  const words = spoken(label);
  return !!words && occurrences(words).test(answerWords(text));
}

/**
 * Checks the coordinator's reading of every question against the user's own text and returns the
 * selections exactly as a native answer carries them: one offered label per fixed-choice question,
 * and offered labels or the user's own words for an open one. Any doubt refuses the whole answer;
 * nothing partial is ever returned.
 */
export function typedSelections(args: QuestionEnvelope, openFrom: number, value: unknown, evidence: (index: number) => TypedEvidence): string[][] {
  const questions = args.questions;
  if (!Array.isArray(value) || value.length !== questions.length) {
    throw new ValidationError(`Give exactly one answer per question, in order: this question has ${questions.length}. Nothing was recorded.`);
  }
  return questions.map((question, index) => {
    const at = `Answer ${index + 1} ("${question.header}")`;
    const item = objectWithKeys(value[index], 'typed answer', ['labels', 'quote']);
    if (!Array.isArray(item.labels) || item.labels.some(label => typeof label !== 'string' || !label.trim())) {
      throw new ValidationError(`${at}: labels must be a list of the offered option labels.`);
    }
    if (item.quote !== undefined && (typeof item.quote !== 'string' || Buffer.byteLength(item.quote) > ANSWER_MAX)) {
      throw new ValidationError(`${at}: quote must be the part of the user's text that answers it.`);
    }
    const labels = [...new Set(item.labels as string[])];
    const offered = question.options.map(option => option.label);
    const unknown = labels.find(label => !offered.includes(label));
    if (unknown !== undefined) throw new ValidationError(`${at}: "${unknown}" is not one of its options; use the exact offered label.`);
    const open = index >= openFrom;
    if (!open && labels.length !== 1) throw new ValidationError(`${at}: choose exactly one of its options.`);
    if (open && !question.multiple && labels.length > 1) throw new ValidationError(`${at}: this question takes a single choice.`);
    const source = evidence(index);
    const quote = typeof item.quote === 'string' && answerWords(item.quote) ? item.quote.trim() : undefined;
    if (quote !== undefined && !mentions(source.text, quote)) {
      throw new ValidationError(`${at}: the quote is not part of what the user wrote. Quote their own words.`);
    }
    const said = quote ?? source.text;
    const missing = labels.find(label => !mentions(said, label));
    if (missing !== undefined) {
      throw new ValidationError(`${at}: the user did not write "${missing.replace(RECOMMENDED, '')}". Only an option written in their own words can be recorded; otherwise ask the question again.`);
    }
    if (labels.length) {
      // What they chose is set aside first, so an option contained in a longer one they chose
      // ("API" inside "API REST") is not mistaken for a second answer. A chosen option that is part
      // of the other one stays, or choosing "API" would hide the "API REST" the user wrote.
      const words = answerWords(said);
      const other = offered.find(label => {
        const option = spoken(label);
        if (labels.includes(label) || !option) return false;
        const rest = labels.filter(chosen => !occurrences(spoken(chosen)).test(option))
          .reduce((text, chosen) => text.replace(occurrences(spoken(chosen)), '#'), words);
        return occurrences(option).test(rest);
      });
      if (other !== undefined) {
        throw new ValidationError(`${at}: the user's words also name "${other.replace(RECOMMENDED, '')}", so the choice is ambiguous.${quote === undefined ? ' Quote only the part that answers this question.' : ''} Nothing was recorded; ask the question again if it stays unclear.`);
      }
      return labels;
    }
    if (!open) throw new ValidationError(`${at}: choose exactly one of its options.`);
    // An open question may be answered in the user's own words, or left unanswered.
    if (quote !== undefined) return [quote];
    return source.own && answerWords(source.text) ? [source.text.trim()] : [];
  });
}
