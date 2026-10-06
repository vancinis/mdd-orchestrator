import type { Answers } from './policy.js';
import { preflight } from './kernel.js';
import { objectWithKeys, parseAnswers, ValidationError } from './validation.js';

export const ANSWER_FIELDS = Object.freeze(['certainty', 'artifactStore', 'mode', 'summary'] as const);
// Accepted on input for backward compatibility with saved profiles and kernel callers, but never
// asked and never scored: mdd-risk now judges complexity, after exploration, not this intake.
const LEGACY_FIELDS = Object.freeze(['complexity'] as const);
type Field = keyof Answers;
type Choice = { label: string; description: string; token: string };
/**
 * User-facing text is Spanish, like the installer and the config wizard: MDD must not install in
 * one language and interrogate in another. Labels are also the native answer tokens, so every
 * label comparison elsewhere reads them from here instead of repeating a literal.
 */
const fields: Record<Field, { header: string; question: string; choices: Choice[] }> = {
  certainty: { header: 'Certeza', question: '¿Qué tan claros están los requisitos?', choices: [
    { label: 'Muy seguro', token: 'very-sure', description: 'Los requisitos están claros y confirmados.' },
    { label: 'Algo seguro', token: 'somewhat-sure', description: 'Algunos requisitos necesitan aclaración.' },
    { label: 'Poco seguro', token: 'not-sure', description: 'Conviene explorar los requisitos antes de planificar.' },
  ] },
  artifactStore: { header: 'Artefactos', question: '¿Dónde se guardan los artefactos del flujo? La memoria opcional se configura por separado.', choices: [
    { label: 'Engram', token: 'engram', description: 'Guardar los artefactos del flujo en Engram.' },
    { label: 'OpenSpec', token: 'openspec', description: 'Guardar los artefactos en archivos OpenSpec del proyecto.' },
    { label: 'Ambos', token: 'both', description: 'Guardar los artefactos en los dos lugares.' },
    { label: 'Ninguno', token: 'none', description: 'Mantener los artefactos solo durante la ejecución, sin persistencia dedicada.' },
  ] },
  mode: { header: 'Modo', question: '¿Cómo se aprueban las fases posteriores? Enviar el preflight autoriza la primera fase.', choices: [
    { label: 'Interactivo', token: 'interactive', description: 'Aprobar cada fase posterior una por una.' },
    { label: 'Automático', token: 'automatic', description: 'Continuar las fases posteriores sin aprobación individual.' },
  ] },
  summary: { header: 'Resumen', question: '¿Cuánto detalle querés en los reportes?', choices: [
    { label: 'Detallado', token: 'detailed', description: 'Resumen, cómo se hizo, estado y cobertura de evidencia.' },
    { label: 'Medio', token: 'medium', description: 'Resumen y cómo se realizó el trabajo.' },
    { label: 'Bajo', token: 'low', description: 'Un resumen corto del trabajo de la fase actual.' },
  ] },
};

export type QuestionEnvelope = { questions: {
  header: string; question: string; options: { label: string; description: string }[]; multiple: false;
}[] };

export function parsePartialAnswers(value: unknown): Partial<Answers> {
  const input = objectWithKeys(value, 'answers', [...ANSWER_FIELDS, ...LEGACY_FIELDS]);
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
