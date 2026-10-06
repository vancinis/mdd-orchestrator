import { LocalFiles } from './local-files.js';
import { FAILURE_CLASSES } from './telemetry.js';
import type { FailureClass } from './telemetry.js';
import { PHASES } from './policy.js';
import type { Phase } from './policy.js';
import { objectWithKeys, ValidationError } from './validation.js';

/**
 * What MDD has been told about itself. Telemetry counts what happened and deliberately holds no
 * text, which makes it useless for the one question a harness has to be able to answer: what went
 * wrong here, in words, and what should change because of it. This file is the other half. It
 * holds text on purpose, so it is local, gitignored with the rest of `.mdd/`, and never exported.
 *
 * Two things write here. A failed attempt records itself, because the moment a route breaks is the
 * only moment the reason is still known exactly. And the user records one deliberately, when they
 * say that something was done badly and should not be done that way again. Both end up in the same
 * list, distinguished by `source`, because the review that follows is the same review.
 */
const LIMIT = 512 * 1024;
const MAX_LESSONS = 500;
export const LESSON_TITLE_MAX = 200;
export const LESSON_DETAIL_MAX = 4000;
/** The share of the file a single automatic entry may take before it is cut off at the reason. */
const AUTOMATIC_DETAIL_MAX = 1000;

export const LESSON_SOURCES = Object.freeze(['user', 'failure'] as const);
export type LessonSource = typeof LESSON_SOURCES[number];
export const LESSON_STATES = Object.freeze(['open', 'reviewed', 'applied'] as const);
export type LessonState = typeof LESSON_STATES[number];
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f]/;

export type Lesson = {
  id: string;
  timestamp: number;
  source: LessonSource;
  /** The adapter's failure class for an automatic entry; absent when a person wrote it. */
  kind?: FailureClass;
  phase?: Phase;
  title: string;
  detail: string;
  state: LessonState;
};
export type LessonInput = {
  source: LessonSource; title: string; detail: string;
  kind?: FailureClass; phase?: Phase;
};
export type LessonResult =
  | { ok: true; recorded: Lesson; total: number; pruned: number }
  | { ok: false; diagnostic: 'lessons-unavailable' | 'invalid-lesson' };

function text(value: unknown, subject: string, max: number): string {
  if (typeof value !== 'string') throw new ValidationError(`${subject} must be text.`);
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > max || CONTROL_CHARACTERS.test(trimmed)) {
    throw new ValidationError(`${subject} must be nonempty, within ${max} bytes, and free of terminal control characters.`);
  }
  return trimmed;
}

function clock(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new Error('Invalid clock.');
}

/**
 * Written by this module, so parsing only has to fail closed on a damaged or foreign file. An
 * unreadable line is not skipped: a lessons file that quietly drops half of its entries would be
 * worse than one that reports it cannot be read, because nobody would know what was lost.
 */
function parseLesson(value: unknown): Lesson {
  const input = objectWithKeys(value, 'lesson', ['id', 'timestamp', 'source', 'kind', 'phase', 'title', 'detail', 'state']);
  if (typeof input.id !== 'string' || !/^[0-9a-f]{16}$/.test(input.id)) throw new ValidationError('Invalid lesson identity.');
  if (!Number.isSafeInteger(input.timestamp) || (input.timestamp as number) < 0 || (input.timestamp as number) > 8640000000000000) {
    throw new ValidationError('Invalid lesson timestamp.');
  }
  if (!LESSON_SOURCES.includes(input.source as LessonSource)) throw new ValidationError('Invalid lesson source.');
  if (!LESSON_STATES.includes(input.state as LessonState)) throw new ValidationError('Invalid lesson state.');
  const lesson: Lesson = {
    id: input.id, timestamp: input.timestamp as number, source: input.source as LessonSource,
    title: text(input.title, 'lesson title', LESSON_TITLE_MAX),
    detail: text(input.detail, 'lesson detail', LESSON_DETAIL_MAX),
    state: input.state as LessonState,
  };
  if (Object.hasOwn(input, 'kind')) {
    if (!FAILURE_CLASSES.includes(input.kind as FailureClass)) throw new ValidationError('Invalid lesson failure class.');
    lesson.kind = input.kind as FailureClass;
  }
  if (Object.hasOwn(input, 'phase')) {
    if (!PHASES.includes(input.phase as Phase)) throw new ValidationError('Invalid lesson phase.');
    lesson.phase = input.phase as Phase;
  }
  return lesson;
}

function parseAll(content: string | undefined): Lesson[] {
  if (content === undefined || content === '') return [];
  const lines = content.trimEnd().split('\n');
  if (lines.length > MAX_LESSONS * 2) throw new Error('Invalid local lessons file.');
  return lines.map(line => parseLesson(JSON.parse(line)));
}

function serialize(lessons: readonly Lesson[]): string | undefined {
  return lessons.length ? `${lessons.map(lesson => JSON.stringify(lesson)).join('\n')}\n` : undefined;
}

function identity(now: number, index: number): string {
  // Stable and ordered without a random source: the id only has to name one row of one local file.
  return `${now.toString(16).padStart(12, '0').slice(-12)}${index.toString(16).padStart(4, '0').slice(-4)}`;
}

/**
 * The file is capped, so something has to go when it fills. Entries already reviewed or applied go
 * first, oldest first, because their value has been extracted; only then does an untouched `open`
 * entry fall off. Dropping the newest instead would throw away exactly what was just learned.
 */
function prune(lessons: Lesson[]): { kept: Lesson[]; pruned: number } {
  if (lessons.length <= MAX_LESSONS) return { kept: lessons, pruned: 0 };
  const excess = lessons.length - MAX_LESSONS;
  const expendable = lessons.filter(lesson => lesson.state !== 'open').slice(0, excess);
  const dropped = new Set(expendable.map(lesson => lesson.id));
  let remaining = excess - dropped.size;
  for (const lesson of lessons) {
    if (remaining <= 0) break;
    if (dropped.has(lesson.id)) continue;
    dropped.add(lesson.id);
    remaining -= 1;
  }
  return { kept: lessons.filter(lesson => !dropped.has(lesson.id)), pruned: dropped.size };
}

function parseInput(value: LessonInput, now: number, index: number): Lesson {
  const input = objectWithKeys(value, 'lesson', ['source', 'title', 'detail', 'kind', 'phase']);
  if (!LESSON_SOURCES.includes(input.source as LessonSource)) throw new ValidationError('Invalid lesson source.');
  const source = input.source as LessonSource;
  const lesson: Lesson = {
    id: identity(now, index), timestamp: now, source,
    title: text(input.title, 'lesson title', LESSON_TITLE_MAX),
    detail: text(input.detail, 'lesson detail', source === 'failure' ? AUTOMATIC_DETAIL_MAX : LESSON_DETAIL_MAX),
    state: 'open',
  };
  if (input.kind !== undefined) {
    if (!FAILURE_CLASSES.includes(input.kind as FailureClass)) throw new ValidationError('Invalid lesson failure class.');
    lesson.kind = input.kind as FailureClass;
  }
  if (input.phase !== undefined) {
    if (!PHASES.includes(input.phase as Phase)) throw new ValidationError('Invalid lesson phase.');
    lesson.phase = input.phase as Phase;
  }
  return lesson;
}

/** No background timers, import side effects, network calls, or implicit startup writes. */
export function recordLesson(root: string, value: LessonInput, now = Date.now()): LessonResult {
  let lesson: Lesson;
  try {
    clock(now);
    lesson = parseInput(value, now, 0);
  } catch { return { ok: false, diagnostic: 'invalid-lesson' }; }
  try {
    const files = new LocalFiles(root);
    let total = 0;
    let pruned = 0;
    files.update('.mdd/lessons.jsonl', previous => {
      const existing = parseAll(previous);
      // The index disambiguates two entries written inside the same millisecond, which is ordinary
      // when a failure records itself and the user immediately says something about it.
      const recorded = { ...lesson, id: identity(now, existing.filter(item => item.timestamp === now).length) };
      lesson = recorded;
      const result = prune([...existing, recorded]);
      total = result.kept.length;
      pruned = result.pruned;
      return serialize(result.kept);
    }, LIMIT);
    return { ok: true, recorded: lesson, total, pruned };
  } catch { return { ok: false, diagnostic: 'lessons-unavailable' }; }
}

/**
 * Recording must never be able to stop the work it is describing. A failing route that also failed
 * to write its own lesson is still a failing route, and turning that into a second, louder failure
 * would make the memory feature the reason a run died.
 */
export function recordLessonQuietly(root: string, value: LessonInput, now = Date.now()): void {
  try { recordLesson(root, value, now); } catch { /* A lesson is never worth a route. */ }
}

export function readLessons(root: string, query?: { text?: string; state?: LessonState; limit?: number }): { ok: true; lessons: Lesson[]; total: number } | { ok: false; diagnostic: 'lessons-unavailable' } {
  try {
    const lessons = parseAll(new LocalFiles(root).read('.mdd/lessons.jsonl', LIMIT));
    const needle = query?.text?.trim().toLowerCase();
    const matched = lessons.filter(lesson =>
      (query?.state === undefined || lesson.state === query.state) &&
      (!needle || `${lesson.title}\n${lesson.detail}\n${lesson.kind ?? ''}\n${lesson.phase ?? ''}`.toLowerCase().includes(needle)));
    const limit = query?.limit ?? matched.length;
    if (!Number.isInteger(limit) || limit < 0) throw new ValidationError('Invalid lesson limit.');
    // Newest first: a review starts from what just happened, not from what happened in March.
    return { ok: true, lessons: matched.slice(-limit).reverse(), total: lessons.length };
  } catch { return { ok: false, diagnostic: 'lessons-unavailable' }; }
}

/** Moves entries between open, reviewed and applied. Unknown ids are reported, never invented. */
export function markLessons(root: string, ids: readonly string[], state: LessonState, now = Date.now()): { ok: true; updated: string[]; unknown: string[] } | { ok: false; diagnostic: 'lessons-unavailable' | 'invalid-lesson' } {
  try {
    clock(now);
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_LESSONS) throw new ValidationError('Name the lessons to mark.');
    if (!LESSON_STATES.includes(state)) throw new ValidationError('Invalid lesson state.');
    for (const id of ids) if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) throw new ValidationError('Invalid lesson identity.');
  } catch { return { ok: false, diagnostic: 'invalid-lesson' }; }
  try {
    const files = new LocalFiles(root);
    const updated: string[] = [];
    files.update('.mdd/lessons.jsonl', previous => {
      const lessons = parseAll(previous);
      for (const lesson of lessons) {
        if (!ids.includes(lesson.id) || lesson.state === state) continue;
        lesson.state = state;
        updated.push(lesson.id);
      }
      return serialize(lessons);
    }, LIMIT);
    return { ok: true, updated, unknown: ids.filter(id => !updated.includes(id)) };
  } catch { return { ok: false, diagnostic: 'lessons-unavailable' }; }
}

export function clearLessons(root: string): { ok: true } | { ok: false; diagnostic: 'lessons-unavailable' } {
  try { new LocalFiles(root).remove('.mdd/lessons.jsonl'); return { ok: true }; }
  catch { return { ok: false, diagnostic: 'lessons-unavailable' }; }
}

const SOURCE_LABELS: Record<LessonSource, string> = { user: 'pedida por vos', failure: 'fallo registrado' };
const STATE_LABELS: Record<LessonState, string> = { open: 'abierta', reviewed: 'revisada', applied: 'aplicada' };
const KIND_LABELS: Record<FailureClass, string> = {
  'phase-failed': 'la fase falló', 'result-rejected': 'resultado rechazado',
  'result-malformed': 'reporte ilegible', 'dispatch-mismatch': 'despacho no coincidente',
  'native-error': 'error nativo', 'route-blocked': 'ruta detenida', stopped: 'detenido',
};

/**
 * The reader of MDD's own lessons. Everything here is arithmetic and formatting over what was
 * recorded: nothing is summarized by a model, because a review whose input was already
 * paraphrased is a review of the paraphrase.
 */
export function renderLessonsReport(lessons: readonly Lesson[], total: number): string {
  const lines = ['Automejoras anotadas de MDD — locales, nunca se exportan.'];
  if (!total) {
    lines.push('Todavía no hay ninguna anotada en este workspace. Se anotan solas cuando una fase falla, y podés pedir una explícitamente diciendo qué salió mal.');
    return `${lines.join('\n')}\n`;
  }
  const open = lessons.filter(lesson => lesson.state === 'open').length;
  lines.push(`${lessons.length} de ${total} anotada(s) en este listado; ${open} sin revisar.`, '');
  for (const lesson of lessons) {
    const date = new Date(lesson.timestamp).toISOString().slice(0, 10);
    const tags = [SOURCE_LABELS[lesson.source], STATE_LABELS[lesson.state],
      ...(lesson.kind ? [KIND_LABELS[lesson.kind]] : []), ...(lesson.phase ? [lesson.phase] : [])];
    lines.push(`[${lesson.id}] ${date} · ${tags.join(' · ')}`, lesson.title, lesson.detail, '');
  }
  lines.push('Para trabajar sobre una, pedí el análisis nombrando su identificador. Marcarlas como revisadas o aplicadas no las borra: el historial es lo que hace que la próxima revisión valga algo.');
  return `${lines.join('\n')}\n`;
}
