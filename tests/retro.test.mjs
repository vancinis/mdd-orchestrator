import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adaptiveCompletionOf, completionOf, renderRetroReport } from '../dist/retro.js';
import { emptyRollup } from '../dist/telemetry.js';

const all = { requirements: 'confirmed', plan: 'confirmed', implementation: 'confirmed', checks: 'confirmed' };
const run = (change = {}) => ({
  version: 1, runID: 'run-one', timestamp: 1789000000000, state: 'complete', directory: '/repo',
  route: ['mdd-plan', 'mdd-apply', 'mdd-verify'], phase: 'mdd-verify', coverage: 100, evidence: { ...all },
  changedFiles: 3, checks: { total: 2, passed: 2, failed: 0 }, concerns: 0,
  goal: 'Validate orders before processing.', limits: [], ...change,
});
function rollup(change = {}) {
  const base = emptyRollup(1789000000000);
  return { ...base, ...change, runs: { ...base.runs, ...(change.runs ?? {}) },
    failures: { ...base.failures, ...(change.failures ?? {}) }, phases: { ...base.phases, ...(change.phases ?? {}) } };
}

test('an empty workspace says so instead of implying a clean record', () => {
  const text = renderRetroReport({ runs: [], runTotal: 0, lessons: [], lessonTotal: 0 });
  assert.match(text, /Todavía no hay nada que revisar/);
  assert.doesNotMatch(text, /Señales/);
});

// A workspace that ran MDD before it kept totals holds events and no aggregate. Reporting that as
// "nothing happened" would be the report being wrong about its own record.
test('loose events with no aggregate are reported as what they are, not as an empty record', () => {
  const text = renderRetroReport({ runs: [], runTotal: 0, lessons: [], lessonTotal: 0, events: 5 });
  assert.match(text, /5 evento\(s\) sueltos en el registro/);
  assert.match(text, /mdd telemetry report/);
  assert.doesNotMatch(text, /nada que revisar/);
});

// The signal that started all of this: runs that begin and never reach any recorded ending.
test('runs that started and never reached an ending are counted as the gap they are', () => {
  const text = renderRetroReport({ runs: [], runTotal: 0, lessons: [], lessonTotal: 0,
    rollup: rollup({ runs: { started: 15, completed: 3, blocked: 1, reset: 2, compacted: 4 } }) });
  assert.match(text, /11 de 15 ejecución\(es\) iniciadas no llegaron a ningún final registrado/);
  assert.match(text, /1 ejecución\(es\) terminaron detenidas sobre 15/);
  assert.match(text, /2 ejecución\(es\) se reiniciaron/);
  assert.match(text, /compactó la conversación del coordinador 4 vez\/veces/);
});

test('the most frequent failure, the most retried phase and the most interrupted one are named', () => {
  const text = renderRetroReport({ runs: [], runTotal: 0, lessons: [], lessonTotal: 0,
    rollup: rollup({
      runs: { started: 4, completed: 4, blocked: 0, reset: 0, compacted: 0 },
      failures: { 'result-malformed': 7, 'result-rejected': 2 },
      phases: {
        'mdd-explore': { starts: 15, passed: 4, failed: 0, blocked: 11, retries: 9, handovers: 0, duration: 0, timed: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, measured: 0, partial: 0 },
        'mdd-plan': { starts: 6, passed: 5, failed: 1, blocked: 0, retries: 1, handovers: 0, duration: 0, timed: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, measured: 0, partial: 0 },
      },
    }) });
  assert.match(text, /El fallo más frecuente es "reporte ilegible": 7 de 9 intento\(s\) fallidos/);
  assert.match(text, /La fase que más se reintentó es mdd-explore: 9 reintento\(s\)/);
  assert.match(text, /La fase que más se cortó es mdd-explore: 11 de 15/);
});

test('the ledger contributes what counters cannot: no-change runs, failed checks and partial coverage', () => {
  const runs = [
    run({ runID: 'a', changedFiles: 0 }),
    run({ runID: 'b', checks: { total: 3, passed: 2, failed: 1 } }),
    run({ runID: 'c', coverage: 65, evidence: { ...all, checks: 'unearned' } }),
  ];
  const text = renderRetroReport({ runs, runTotal: 3, lessons: [], lessonTotal: 0 });
  assert.match(text, /1 de las últimas 3 ejecución\(es\) registradas no cambiaron ningún archivo/);
  assert.match(text, /1 de las últimas 3 ejecución\(es\) registradas terminaron con algún comando de verificación en salida distinta de 0/);
  assert.match(text, /1 ejecución\(es\) se dieron por completas con menos de 100% de cobertura/);
});

// The anchor put a repository's worktrees in one place; this is what that buys a review.
test('runs arriving from several checkouts of the repository are reported as such', () => {
  const text = renderRetroReport({ runTotal: 2, lessons: [], lessonTotal: 0,
    runs: [run({ runID: 'a', directory: '/repo' }), run({ runID: 'b', directory: '/repo-worktrees/issue-354' })] });
  assert.match(text, /vinieron de 2 checkout\(s\) distintos/);
});

test('each recorded run is listed with its outcome, goal and pending limits', () => {
  const text = renderRetroReport({ runTotal: 1, lessons: [], lessonTotal: 0,
    runs: [run({ state: 'blocked', phase: 'mdd-apply', coverage: 40, changedFiles: 2,
      checks: { total: 1, passed: 0, failed: 1 }, evidence: { ...all, implementation: 'invalidated', checks: 'invalidated' },
      limits: ['Migration behavior is verified by static contract tests.'] })] });
  assert.match(text, /detenida en mdd-apply · 40% de cobertura · 2 archivo\(s\) · 1 chequeo\(s\), 1 con salida distinta de 0/);
  assert.match(text, /Validate orders before processing\./);
  assert.match(text, /Pendiente: Migration behavior is verified by static contract tests\./);
});

test('open improvements are surfaced with their identifiers and never invented', () => {
  const text = renderRetroReport({ runs: [], runTotal: 0, lessonTotal: 3,
    lessons: [{ id: 'abc0000000000001', timestamp: 1789000000000, source: 'user', title: 'El reporte salió en inglés', detail: 'x', state: 'open' }] });
  assert.match(text, /1 automejora\(s\) anotada\(s\) sin revisar, sobre 3 en total/);
  assert.match(text, /\[abc0000000000001\] El reporte salió en inglés/);
});

// The number the Verify changes were made to move, read first, and never without its causes.
test('regression: the completion rate is reported per route and broken down by recorded cause', () => {
  const blocked = (runID, stop) => run({ runID, state: 'blocked', ...(stop ? { stop } : {}), evidence: { ...all, checks: 'invalidated' }, coverage: 65 });
  const runs = [run({ runID: 'a', corrections: 2, pending: 1 }), run({ runID: 'b' }), run({ runID: 'c', corrections: 1 }),
    blocked('d', 'verify-implementation'), blocked('e', 'verify-implementation'), blocked('f', 'report-unreadable'), blocked('g')];
  const completion = completionOf(runs);
  assert.deepEqual(completion, { total: 7, complete: 3, blocked: 4, corrected: 2, corrections: 3, pending: 1,
    causes: { 'verify-implementation': 2, 'report-unreadable': 1, unrecorded: 1 } });
  const adaptive = adaptiveCompletionOf([
    { data: { state: 'completed', repairs: 1, matched: true, report: { scenarios: [{ status: 'external' }], checkResults: [] } } },
    { data: { state: 'closed-unverified', repairs: 2, matched: false, report: { scenarios: [], checkResults: [] } } },
    { data: { state: 'closed-unverified', repairs: 0, matched: false } }, { data: { state: 'await-selection', repairs: 0 } }, null, { data: {} }]);
  assert.deepEqual(adaptive, { closed: 3, verified: 1, unverified: { 'evidence-gaps': 1, 'no-evidence': 1 }, active: 1, repairs: 3, pending: 1 });
  const text = renderRetroReport({ runs, runTotal: 7, lessons: [], lessonTotal: 0, completion, adaptive,
    rollup: rollup({ runs: { started: 9, completed: 3, blocked: 4, reset: 0, corrected: 3, compacted: 0 } }) });
  const section = text.slice(text.indexOf('Finalización'), text.indexOf('Señales'));
  assert.match(section, /Ruta fija: 3 de 7 ejecución\(es\) registradas terminaron completas \(43%\); 4 detenida\(s\)\./);
  assert.match(section, /Detenidas por causa: Verify encontró defectos de la implementación 2, reporte ilegible tras los reintentos 1, sin causa registrada \(filas anteriores a este dato\) 1\./);
  assert.match(section, /2 de las completas pasaron por corrección \(3 pasada\(s\) en total\); 1 quedaron con pendientes externos o ajenos al cambio\./);
  assert.match(section, /Ruta adaptativa: 1 de 3 ejecución\(es\) cerradas terminaron verificadas \(33%\); 2 cerrada\(s\) sin verificar \(con brechas en la evidencia 1, sin evidencia presentada 1\); 1 en curso\./);
  assert.match(section, /La telemetría de la ruta fija cuenta 9 iniciada\(s\), de las que 2 no tienen fila de final registrada, y 3 corrección\(es\) automática\(s\)/);
  assert.match(text, /detenida en mdd-verify \(Verify encontró defectos de la implementación\)/);
  assert.match(text, /completa en mdd-verify · 100% de cobertura · 3 archivo\(s\) · 2 chequeo\(s\), 0 con salida distinta de 0 · 2 corrección\(es\) · 1 pendiente\(s\) externo\(s\)/);
  // Nothing recorded, nothing claimed: the section is simply absent.
  assert.doesNotMatch(renderRetroReport({ runs: [], runTotal: 0, lessons: [], lessonTotal: 1 }), /Finalización/);
});

// Counts are what MDD has. Why eleven explorations stopped is not something it can know.
test('the report states that its numbers describe what happened, not why', () => {
  const text = renderRetroReport({ runs: [run()], runTotal: 1, lessons: [], lessonTotal: 0, rollup: rollup() });
  assert.match(text, /dicen qué pasó, no por qué/);
  assert.match(text, /mdd telemetry report/);
});
