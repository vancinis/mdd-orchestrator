import type { Answers } from './policy.js';
import { preflight } from './kernel.js';
import { objectWithKeys, parseAnswers, ValidationError } from './validation.js';

export const ANSWER_FIELDS = Object.freeze(['certainty', 'artifactStore', 'mode', 'summary', 'complexity'] as const);
type Field = keyof Answers;
type Choice = { label: string; description: string; token: string };
const fields: Record<Field, { header: string; question: string; choices: Choice[] }> = {
  certainty: { header: 'Certainty', question: 'How certain are the requirements?', choices: [
    { label: 'Very sure', token: 'very-sure', description: 'Requirements are clear and confirmed.' },
    { label: 'Somewhat sure', token: 'somewhat-sure', description: 'Some requirements need clarification.' },
    { label: 'Not sure', token: 'not-sure', description: 'Explore the requirements before planning.' },
  ] },
  artifactStore: { header: 'Artifacts', question: 'Where should workflow artifacts be stored? Optional memory is configured separately.', choices: [
    { label: 'Engram', token: 'engram', description: 'Store workflow artifacts in Engram.' },
    { label: 'OpenSpec', token: 'openspec', description: 'Store workflow artifacts in project OpenSpec files.' },
    { label: 'Both', token: 'both', description: 'Store artifacts in both locations.' },
    { label: 'None', token: 'none', description: 'Keep artifacts only in the live run, without dedicated persistence.' },
  ] },
  mode: { header: 'Mode', question: 'How should later phases be approved? Submitting preflight authorizes the first phase.', choices: [
    { label: 'Interactive', token: 'interactive', description: 'Approve each later phase individually.' },
    { label: 'Automatic', token: 'automatic', description: 'Continue later phases without individual approval.' },
  ] },
  summary: { header: 'Summary', question: 'How much reporting detail do you want?', choices: [
    { label: 'Detailed', token: 'detailed', description: 'Summary, how, status, and evidence coverage.' },
    { label: 'Medium', token: 'medium', description: 'Summary and how the work was performed.' },
    { label: 'Low', token: 'low', description: 'A short summary of work performed in the current phase.' },
  ] },
  complexity: { header: 'Complexity', question: 'How complex is the requested work?', choices: [
    { label: 'Very complex', token: 'very-complex', description: 'Substantial scope or technical complexity.' },
    { label: 'Somewhat complex', token: 'somewhat-complex', description: 'Some scope or technical complexity.' },
    { label: 'Not complex', token: 'not-complex', description: 'Small, straightforward work.' },
  ] },
};

export type QuestionEnvelope = { questions: {
  header: string; question: string; options: { label: string; description: string }[]; multiple: false;
}[] };

export function parsePartialAnswers(value: unknown): Partial<Answers> {
  const input = objectWithKeys(value, 'answers', ANSWER_FIELDS);
  const result: Record<string, string> = {};
  for (const key of ANSWER_FIELDS) {
    if (!Object.hasOwn(input, key)) continue;
    if (!fields[key].choices.some(choice => choice.token === input[key])) {
      throw new ValidationError(`Invalid answers.${key}. Select an explicit supported value.`);
    }
    result[key] = input[key] as string;
  }
  return result as Partial<Answers>;
}

export function questionEnvelope(known: unknown = {}, memoryEnabled = true): QuestionEnvelope {
  const answers = parsePartialAnswers(known);
  return { questions: ANSWER_FIELDS.filter(key => !Object.hasOwn(answers, key)).map(key => ({
    header: fields[key].header, question: fields[key].question, multiple: false,
    options: fields[key].choices.filter(choice => key !== 'artifactStore' || memoryEnabled || ['openspec', 'none'].includes(choice.token)).map(({ label, description }) => ({ label, description })),
  })) };
}

export function answerFromLabel<FieldName extends Field>(field: FieldName, label: unknown): Answers[FieldName] {
  if (!ANSWER_FIELDS.includes(field)) throw new ValidationError('Unknown preflight field.');
  const matches = fields[field].choices.filter(choice => choice.label === label);
  if (matches.length !== 1) throw new ValidationError(`Invalid or ambiguous label for ${field}.`);
  return matches[0]!.token as Answers[FieldName];
}

/** Native answers are ordered arrays of selected labels, one label per missing field. */
export function answersFromLabels(known: unknown, selections: unknown): Answers {
  const answers = parsePartialAnswers(known);
  const missing = ANSWER_FIELDS.filter(key => !Object.hasOwn(answers, key));
  if (!Array.isArray(selections) || selections.length !== missing.length) {
    throw new ValidationError('Supply exactly one ordered answer for every missing question.');
  }
  missing.forEach((key, index) => {
    const selected: unknown = selections[index];
    if (!Array.isArray(selected) || selected.length !== 1 || typeof selected[0] !== 'string') {
      throw new ValidationError('Each question requires exactly one answer label.');
    }
    Object.assign(answers, { [key]: answerFromLabel(key, selected[0]) });
  });
  return parseAnswers(answers);
}

export function resolvePreflight(known: unknown, selections: unknown, explore = false): ReturnType<typeof preflight> {
  return preflight({ answers: answersFromLabels(known, selections), explore });
}
