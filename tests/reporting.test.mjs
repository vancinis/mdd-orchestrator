import assert from 'node:assert/strict';
import test from 'node:test';
import { EVIDENCE_WEIGHTS, emptyEvidence, evidenceCoverage, invalidateEvidence, parseNarrative, renderReport, renderClosure } from '../dist/reporting.js';

const all = { requirements: 'confirmed', plan: 'confirmed', implementation: 'confirmed', checks: 'confirmed' };
const narrative = () => ({
  purpose: 'Invalid input must fail before it reaches persistence.',
  openItems: 'None.',
  learnings: 'The parser already normalized whitespace, so no new trimming was needed.',
  confidence: { level: 'high', reason: 'The scoped parser tests cover every new branch and pass.' },
});
const report = () => ({ phase: 'mdd-apply', summary: 'Implemented the requested scoped change.', how: ['Updated the parser.', 'Ran scoped parser checks.'], status: 'passed', evidence: { ...all }, narrative: narrative() });

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
  assert.match(renderReport('detailed', { ...report(), evidence: failed, status: 'failed' }), /\nEstado\nfallido\n$/);
});

// The frame the user reads is Spanish, like the installer, the config wizard and the preflight.
// The prose inside it is the actor's, in English, and the coordinator translates that part.
test('detailed report shows every narrative section, then Estado, and no evidence coverage', () => {
  assert.equal(renderReport('detailed', report()),
    'Resumen (Implementación)\nImplemented the requested scoped change.\n\n' +
    'Cómo se hizo\n- Updated the parser.\n- Ran scoped parser checks.\n\n' +
    'Propósito\nInvalid input must fail before it reaches persistence.\n\n' +
    'Pendiente o incierto\nNone.\n\n' +
    'Aprendizajes clave\nThe parser already normalized whitespace, so no new trimming was needed.\n\n' +
    'Confianza\nAlta — The scoped parser tests cover every new branch and pass.\n\n' +
    'Estado\ncompletado\n');
  assert.equal(renderReport('detailed', report()), renderReport('detailed', report()));
  assert.doesNotMatch(renderReport('detailed', report()), /Cobertura|cobertura|%/);
});

test('medium shows Resumen/Propósito/Aprendizajes clave; low shows the summary alone', () => {
  assert.equal(renderReport('medium', report()),
    'Resumen (Implementación)\nImplemented the requested scoped change.\n\n' +
    'Propósito\nInvalid input must fail before it reaches persistence.\n\n' +
    'Aprendizajes clave\nThe parser already normalized whitespace, so no new trimming was needed.\n');
  assert.equal(renderReport('low', report()), 'Resumen (Implementación)\nImplemented the requested scoped change.\n');
  const exploration = { phase: 'mdd-explore', summary: 'Identified two unresolved requirements.', how: [], status: 'in-progress', evidence: emptyEvidence() };
  assert.equal(renderReport('low', exploration), 'Resumen (Exploración)\nIdentified two unresolved requirements.\n');
  assert.equal(evidenceCoverage(exploration.evidence), 0);
});

test('a single approach is prose, several are a list', () => {
  assert.match(renderReport('detailed', { ...report(), how: ['Validated at the CLI boundary.'] }), /\nCómo se hizo\nValidated at the CLI boundary\.\n/);
});

test('each confidence level is rendered in Spanish with its reason', () => {
  for (const [level, label] of [['high', 'Alta'], ['medium', 'Media'], ['low', 'Baja']]) {
    const output = renderReport('detailed', { ...report(), narrative: { ...narrative(), confidence: { level, reason: 'Grounded in the checks.' } } });
    assert.match(output, new RegExp(`\\nConfianza\\n${label} — Grounded in the checks\\.\\n`));
  }
});

// A section the actor left out of the report it wrote is said to be missing, so "nothing pending"
// is never inferred from silence. A report no actor wrote has no narrative to be missing from.
test('a written report shows its missing sections; a placeholder shows only what it holds', () => {
  const sparse = renderReport('detailed', { ...report(), how: [], narrative: { purpose: 'Keep invalid input out.' } });
  for (const heading of ['Cómo se hizo', 'Pendiente o incierto', 'Aprendizajes clave', 'Confianza']) {
    assert.match(sparse, new RegExp(`\\n${heading}\\nEl agente no lo informó\\.\\n`), heading);
  }
  assert.match(sparse, /\nPropósito\nKeep invalid input out\.\n/);
  const placeholder = { phase: 'mdd-plan', summary: 'Listo para planificación.', how: [], status: 'in-progress', evidence: emptyEvidence() };
  assert.equal(renderReport('detailed', placeholder), 'Resumen (Planificación)\nListo para planificación.\n\nEstado\nen curso\n');
  assert.equal(renderReport('medium', placeholder), 'Resumen (Planificación)\nListo para planificación.\n');
  const risk = { ...placeholder, phase: 'mdd-explore', how: ['The exploration shows a contained change.'], status: 'passed' };
  assert.equal(renderReport('detailed', risk), 'Resumen (Exploración)\nListo para planificación.\n\nCómo se hizo\nThe exploration shows a contained change.\n\nEstado\ncompletado\n');
});

for (const detail of ['low', 'medium', 'detailed']) {
  test(`plain ${detail} closure keeps material gaps visible without routing or receipt details`, () => {
    const output = renderClosure(detail, { goal: 'Accept valid orders and explain invalid ones.', changes: 'Order validation was added.', matched: false,
      checks: [{ command: 'npm test', exit: 0 }], limits: ['Invalid-order behavior remains unverified.'], status: 'blocked', evidence: invalidateEvidence(all, ['implementation', 'checks']) });
    assert.match(output, /Accept valid orders/); assert.match(output, /Sin completar/); assert.match(output, /Invalid-order behavior remains unverified/);
    assert.equal(output.includes('\nVerificación\n'), detail !== 'low');
    assert.equal(output.includes('\nEstado\ndetenido\n'), detail === 'detailed');
    assert.doesNotMatch(output, /Cobertura|cobertura|Cómo se hizo/);
    assert.doesNotMatch(output, /mdd-|callID|receipt|100%/);
  });
}

// The frame is the half of the report MDD owns, and it is the half the user reads without anyone
// translating it. A heading that drifts back to English is not a cosmetic regression: it puts the
// coordinator back to deciding which language each section is in, one report at a time.
test('every rendered frame the user reads is Spanish, in all three detail levels', () => {
  for (const detail of ['low', 'medium', 'detailed']) {
    const output = renderReport(detail, report());
    assert.doesNotMatch(output, /^(Summary|How|Approach|Purpose|Open Items|Learnings|Status|Confidence)\b/m, detail);
    assert.match(output, /^Resumen \(Implementación\)$/m, detail);
    if (detail !== 'low') {
      assert.match(output, /^Propósito$/m, detail);
      assert.match(output, /^Aprendizajes clave$/m, detail);
    }
    if (detail === 'detailed') {
      assert.match(output, /^Cómo se hizo$/m);
      assert.match(output, /^Pendiente o incierto$/m);
      assert.match(output, /^Confianza\nAlta — /m);
      assert.match(output, /^Estado\ncompletado$/m);
    }
  }
});

test('reports reject unsupported fields/status/phase, malformed narratives and terminal escapes', () => {
  for (const change of [{ phase: 'orchestrator' }, { phase: 'bogus' }, { status: 'done' }, { summary: '' }, { how: 'checks' }, { summary: '\x1b[31munsafe' }, { percentage: 50 },
    { narrative: { purpose: '' } }, { narrative: { learnings: '\x1b[31munsafe' } }, { narrative: { extra: 'x' } },
    { narrative: { confidence: { level: 'certain', reason: 'x' } } }, { narrative: { confidence: { level: 'high' } } },
    { narrative: { confidence: { level: 'high', reason: 'x', percentage: 90 } } }, { narrative: 'prose' }]) {
    assert.throws(() => renderReport('low', { ...report(), ...change }), undefined, JSON.stringify(change));
  }
  assert.throws(() => renderReport('unknown', report()));
  assert.deepEqual(parseNarrative(narrative()), narrative());
  assert.deepEqual(parseNarrative({}), {});
});

test('closure refuses a success label or full-confidence display without matched acceptance', () => {
  const input = { goal: 'Deliver the requested outcome.', changes: 'Scoped changes made.', matched: true, checks: [{ command: 'npm test', exit: 0 }], limits: [], status: 'passed', evidence: all };
  for (const change of [{ matched: false }, { checks: [] }, { evidence: { ...all, checks: 'unearned' } }, { status: 'blocked' }]) assert.throws(() => renderClosure('detailed', { ...input, ...change }));
});

// A closure that counts a failed command among the successful ones tells the user the run went
// better than it did. The exit code is the whole point of recording the command.
test('closure counts and names the checks that exited nonzero', () => {
  const output = renderClosure('medium', { goal: 'Deliver the requested outcome.', changes: 'Scoped changes made.', matched: false,
    checks: [{ command: 'npm test', exit: 0 }, { command: 'npm run lint', exit: 1 }, { command: 'npm run build', exit: null }],
    limits: [], status: 'blocked', evidence: invalidateEvidence(all, ['checks']) });
  assert.match(output, /Verificación\n- npm test: salida 0/);
  assert.match(output, /salida 0 \(informada; no demuestra por sí sola el comportamiento\)/);
  assert.match(output, /npm run lint: salida 1 \(no confirma el resultado\)/);
  assert.match(output, /npm run build: salida desconocida \(no confirma el resultado\)/);
  assert.doesNotMatch(output.split('Verificación')[0], /npm (test|run)/);
});

test('closure does not invent a cause or claim checks when verification never ran', () => {
  const input = { goal: 'Deliver the requested outcome.', changes: 'The implementation is not verified; its effect is unknown.', matched: false,
    checks: [], limits: ['The planned build could not run; its impact remains unknown.'], status: 'blocked', evidence: invalidateEvidence(all, ['checks']) };
  const output = renderClosure('detailed', input);
  assert.doesNotMatch(output, /Cómo se hizo|Propósito/);
  assert.match(output, /Verificación\nNo se informaron comprobaciones ejecutadas/);
  assert.match(output, /planned build could not run/);
  // Verify wrote a report but left its approach out: that is shown, not filled in.
  assert.match(renderClosure('detailed', { ...input, narrative: { purpose: 'Confirm the build.' } }), /Cómo se hizo\nEl agente no lo informó\./);
});

test('detailed closure carries Verify\'s narrative, then verification, then status', () => {
  const output = renderClosure('detailed', { goal: 'Validate orders.', changes: 'Invalid orders are rejected.',
    how: ['Validation is at the boundary because malformed orders must not reach persistence.'], narrative: narrative(), matched: true,
    checks: [{ command: 'npm test', exit: 0 }], limits: [], status: 'passed', evidence: all });
  assert.match(output, /^Resumen\nValidate orders\. Invalid orders are rejected\.[\s\S]*\nCómo se hizo\nValidation is at the boundary because malformed orders must not reach persistence\.\n\nPropósito\n[\s\S]*\nPendiente o incierto\nNone\.\n\nAprendizajes clave\n[\s\S]*\nConfianza\nAlta — [\s\S]*\n\nVerificación\n- npm test[\s\S]*\n\nEstado\ncompletado\n$/);
  assert.equal(output.split('Invalid orders are rejected.').length, 2);
  assert.equal(output.split('Validation is at the boundary').length, 2);
  assert.doesNotMatch(output, /Cobertura|100%/);
  const medium = renderClosure('medium', { goal: 'Validate orders.', changes: 'Invalid orders are rejected.', narrative: narrative(), matched: true,
    checks: [{ command: 'npm test', exit: 0 }], limits: [], status: 'passed', evidence: all });
  assert.match(medium, /^Resumen\n[\s\S]*\n\nPropósito\n[\s\S]*\n\nAprendizajes clave\n[\s\S]*\n\nVerificación\n- npm test[^\n]*\n$/);
});
