import { objectWithKeys } from './validation.js';

/**
 * A decision a phase could not make on the user's behalf. Before this field existed a phase that
 * needed one had two choices, both bad: guess and carry on, or write the question into prose the
 * coordinator might or might not notice. Stating it here makes the boundary after the phase a
 * place where the user is actually asked — in either mode — and the answer reaches the next phase.
 *
 * It is written in English, like the rest of the report; the coordinator translates it when it
 * asks the user. It is advisory: it approves nothing and changes no route or score.
 */
export type OpenQuestion = {
  question: string; why: string;
  options: { label: string; description: string; recommended?: true }[];
  multiple?: true; deferrable?: true;
};

export const OPEN_QUESTIONS_MAX = 8;
export const OPEN_QUESTION_OPTIONS_MAX = 6;

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be nonempty text.`);
  return value;
}

function flag(value: unknown, label: string): boolean {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`${label} must be a boolean when present.`);
  return value === true;
}

/** Validates the optional "## MDD Questions" block; absent means none, never an error. */
export function openQuestions(value: unknown): OpenQuestion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('The questions section must hold one fenced JSON array of open questions.');
  if (value.length > OPEN_QUESTIONS_MAX) throw new Error(`Report at most ${OPEN_QUESTIONS_MAX} open questions: only decisions the user must make.`);
  return value.map((raw, index) => {
    const label = `open question ${index + 1}`;
    const item = objectWithKeys(raw, label, ['question', 'why', 'options', 'multiple', 'deferrable']);
    const options = item.options === undefined ? [] : item.options;
    if (!Array.isArray(options) || options.length > OPEN_QUESTION_OPTIONS_MAX) {
      throw new Error(`${label} needs an options array of at most ${OPEN_QUESTION_OPTIONS_MAX} choices; leave it empty for an open-ended answer.`);
    }
    const parsed = options.map((rawOption, optionIndex) => {
      const option = objectWithKeys(rawOption, `${label} option ${optionIndex + 1}`, ['label', 'description', 'recommended']);
      return {
        label: text(option.label, `${label} option label`), description: text(option.description, `${label} option description`),
        ...(flag(option.recommended, `${label} option recommended`) ? { recommended: true as const } : {}),
      };
    });
    if (new Set(parsed.map(option => option.label)).size !== parsed.length) throw new Error(`${label} option labels must be unique.`);
    return {
      question: text(item.question, `${label} question`), why: text(item.why, `${label} why`), options: parsed,
      ...(flag(item.multiple, `${label} multiple`) ? { multiple: true as const } : {}),
      ...(flag(item.deferrable, `${label} deferrable`) ? { deferrable: true as const } : {}),
    };
  });
}
