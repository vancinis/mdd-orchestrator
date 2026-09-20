import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE_WEIGHTS, emptyEvidence, evidenceCoverage, invalidateEvidence, renderReport, renderClosure } from '../dist/reporting.js';

const all = { requirements: 'confirmed', plan: 'confirmed', implementation: 'confirmed', checks: 'confirmed' };
const report = () => ({ phase: 'mdd-apply', summary: 'Implemented the requested scoped change.', how: ['Updated the parser.', 'Ran scoped parser checks.'], status: 'passed', evidence: { ...all } });

test('evidence coverage uses 20/20/25/35 flags, never phase count or model percentage', () => {
  assert.deepEqual(EVIDENCE_WEIGHTS, { requirements: 20, plan: 20, implementation: 25, checks: 35 });
  assert.equal(evidenceCoverage(emptyEvidence()), 0);
  assert.equal(evidenceCoverage(all), 100);
  for (const [flag, weight] of Object.entries(EVIDENCE_WEIGHTS)) {
    assert.equal(evidenceCoverage({ ...emptyEvidence(), [flag]: 'confirmed' }), weight);
    assert.equal(evidenceCoverage({ ...all, [flag]: 'invalidated' }), 100 - weight);
  }
  assert.throws(() => evidenceCoverage({ ...all, confidence: 99 }));
  assert.throws(() => evidenceCoverage({ ...all, checks: true }));
  assert.throws(() => evidenceCoverage({ requirements: 'confirmed' }));
});

test('failure invalidates named affected evidence without mutating caller data', () => {
  const failed = invalidateEvidence(all, ['implementation', 'checks']);
  assert.equal(evidenceCoverage(failed), 40);
  assert.equal(evidenceCoverage(all), 100);
  assert.throws(() => invalidateEvidence(all, []));
  assert.throws(() => invalidateEvidence(all, ['arbitrary']));
  assert.throws(() => renderReport('detailed', { ...report(), status: 'failed' }), /invalidate/);
  assert.match(renderReport('detailed', { ...report(), evidence: failed, status: 'failed' }), /40% de cobertura de evidencia/);
});

// The frame the user reads is Spanish, like the installer, the config wizard and the preflight.
// The prose inside it is the actor's, in English, and the coordinator translates that part.
test('detailed report has deterministic Resumen/Cómo/Estado/Cobertura and explicit coverage label', () => {
  assert.equal(renderReport('detailed', report()),
    'Resumen (Implementación)\nImplemented the requested scoped change.\n\nCómo\n- Updated the parser.\n- Ran scoped parser checks.\n\nEstado\ncompletado\n\nCobertura\n100% de cobertura de evidencia (no es una probabilidad de acierto).\n- requisitos: confirmada (20/20)\n- plan: confirmada (20/20)\n- implementación: confirmada (25/25)\n- chequeos: confirmada (35/35)\n');
  assert.equal(renderReport('detailed', report()), renderReport('detailed', report()));
});

test('medium contains Resumen/Cómo only; low contains actual phase-specific summary only', () => {
  assert.equal(renderReport('medium', report()), 'Resumen (Implementación)\nImplemented the requested scoped change.\n\nCómo\n- Updated the parser.\n- Ran scoped parser checks.\n');
  const exploration = { ...report(), phase: 'mdd-explore', summary: 'Identified two unresolved requirements.', status: 'in-progress', evidence: emptyEvidence() };
  assert.equal(renderReport('low', exploration), 'Resumen (Exploración)\nIdentified two unresolved requirements.\n');
  assert.equal(evidenceCoverage(exploration.evidence), 0);
});

for (const detail of ['low', 'medium', 'detailed']) {
  test(`plain ${detail} closure keeps material gaps visible without routing or receipt details`, () => {
    const output = renderClosure(detail, { goal: 'Accept valid orders and explain invalid ones.', changes: 'Order validation was added.', matched: false,
      checks: ['npm test'], limits: ['Invalid-order behavior remains unverified.'], status: 'blocked', evidence: invalidateEvidence(all, ['implementation', 'checks']) });
    assert.match(output, /Accept valid orders/); assert.match(output, /Sin completar/); assert.match(output, /Invalid-order behavior remains unverified/);
    assert.equal(output.includes('\nCómo\n'), detail !== 'low');
    assert.equal(output.includes('40% de cobertura de evidencia (no es una probabilidad de acierto)'), detail === 'detailed');
    assert.doesNotMatch(output, /mdd-|callID|receipt|100%/);
  });
}

// The frame is the half of the report MDD owns, and it is the half the user reads without anyone
// translating it. A heading that drifts back to English is not a cosmetic regression: it puts the
// coordinator back to deciding which language each section is in, one report at a time.
test('every rendered frame the user reads is Spanish, in all three detail levels', () => {
  for (const detail of ['low', 'medium', 'detailed']) {
    const output = renderReport(detail, report());
    assert.doesNotMatch(output, /^(Summary|How|Status|Confidence)\b/m, detail);
    assert.match(output, /^Resumen \(Implementación\)$/m, detail);
    if (detail !== 'low') assert.match(output, /^Cómo$/m, detail);
    if (detail === 'detailed') {
      assert.match(output, /^Estado\ncompletado$/m);
      assert.match(output, /^Cobertura$/m);
      assert.match(output, /^- requisitos: confirmada/m);
    }
  }
});

test('reports reject unsupported fields/status/phase and terminal escapes', () => {
  for (const change of [{ phase: 'orchestrator' }, { phase: 'bogus' }, { status: 'done' }, { summary: '' }, { how: 'checks' }, { summary: '\x1b[31munsafe' }, { percentage: 50 }]) {
    assert.throws(() => renderReport('low', { ...report(), ...change }));
  }
  assert.throws(() => renderReport('unknown', report()));
});

test('closure refuses a success label or full-confidence display without matched acceptance', () => {
  const input = { goal: 'Deliver the requested outcome.', changes: 'Scoped changes made.', matched: true, checks: ['npm test'], limits: [], status: 'passed', evidence: all };
  for (const change of [{ matched: false }, { checks: [] }, { evidence: { ...all, checks: 'unearned' } }, { status: 'blocked' }]) assert.throws(() => renderClosure('detailed', { ...input, ...change }));
});
