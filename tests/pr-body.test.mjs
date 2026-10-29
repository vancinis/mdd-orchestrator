import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { directPRRequest, prBodyRequest, renderDirectPRBody, renderPRBody, translatable } from '../dist/pr-body.js';
import { checkTranslations, translationDigest } from '../dist/pr-translation.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { answers, reportDocument, structuredTraceFixture, structuredVerificationFixture, throughRiskStop } from './adapter-fixture.mjs';

function root(t) { const root = fs.mkdtempSync(join(tmpdir(), 'mdd-pr-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const files = [
  { path: 'src/orders/validate.ts', reason: 'Rejects the order when the total is missing, which is the case the requirement describes.' },
  { path: 'tests/orders.test.ts', reason: 'Covers the invalid order with a case of its own.' },
];
const facts = {
  runID: 'recorded-run', goal: 'Validate orders before processing.',
  delivered: { what: 'Orders are now rejected when they carry no total.', implies: 'Whoever sells can no longer create an order that cannot be charged.' },
  verification: 'Checked the implementation without modifying application sources.',
  changedFiles: 2, files, checks: [{ command: 'npm test', exit: 0 }], verified: true, uncertain: false, limits: [],
};

/**
 * The Spanish the coordinator would send back. Written here as a fixture so every test renders a
 * body the same way a real draft does: through the two calls, never around them.
 */
const SPANISH = {
  goal: 'Validá las órdenes antes de procesarlas.',
  'delivered.what': 'Ahora se rechazan las órdenes que no traen total.',
  'delivered.implies': 'Quien vende ya no puede crear una orden que después no se pueda cobrar.',
  'file.0': 'Rechaza la orden cuando le falta el total, que es el caso que describe el requisito.',
  'file.1': 'Cubre la orden inválida con un caso propio.',
  verification: 'Se revisó la implementación sin modificar fuentes de la aplicación.',
};
function translateWith(current, overrides = {}) {
  const spanish = { ...SPANISH, ...overrides };
  return translatable(current).map(entry => ({ key: entry.key, text: spanish[entry.key] ?? entry.source }));
}
function draft(path, current = facts, { userText = 'Redactá el cuerpo del PR.', notes, overrides, digest } = {}) {
  return renderPRBody(path, current, userText, notes, {
    digest: digest ?? translationDigest(current.runID, translatable(current)),
    translations: translateWith(current, overrides),
  });
}

test('PR renderer uses the local template exactly once per section and recorded facts only', t => {
  const result = draft(root(t));
  assert.deepEqual([...result.body.matchAll(/^## (.+)$/gm)].map(match => match[1]),
    ['Resumen', 'Cambios', 'Verificación', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue']);
  assert.match(result.body, /npm test/);
  assert.match(result.body, /no una revisión independiente/);
  // A note the user never mentioned is not missing evidence, it is an inapplicable section, and
  // the template, the skill and the docs all answer that with the same two words.
  assert.match(result.body, /## Variables de entorno\n\nNo aplica\./);
  assert.equal(result.publication, 'not-authorized'); assert.match(result.provenance.skill.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.provenance.skill.path, 'assets/opencode/skills/mdd-pr-body/SKILL.md');
  // The body is rendered here from recorded facts, so it travels with an explicit instruction not
  // to be rewritten: a coordinator that paraphrases it can only move it away from the template.
  assert.equal(result.render, 'final');
  assert.match(result.instruction, /verbatim/);
});

// The reviewer opens the PR asking what the change does, not how it was built. The summary that
// used to lead the body was the recorded goal — the outcome someone asked for, in English.
test('the summary says what was delivered and what it enables, in Spanish, without mechanics', t => {
  const result = draft(root(t));
  assert.match(result.body, /^## Resumen\n\nAhora se rechazan las órdenes que no traen total\.\n\nQuien vende ya no puede crear una orden/m);
  assert.doesNotMatch(result.body.split('## Cambios')[0], /validate\.ts|Validate orders before processing/);
});

test('a run whose apply recorded no summary falls back to the goal and says so', t => {
  const bare = { ...facts, delivered: undefined };
  const result = draft(root(t), bare);
  assert.match(result.body, /## Resumen\n\nValidá las órdenes antes de procesarlas\./);
  assert.match(result.body, /No se registró un resumen del cambio/);
});

// A reviewer opens the PR already holding the list of paths. What they cannot reconstruct is why
// each file had to change, so that is what the section leads with.
test('changed files are reported as one table row each, with the reason that file changed', t => {
  const result = draft(root(t));
  assert.match(result.body, /\| Archivo \| Por qué cambió \|/);
  assert.match(result.body, /\| `src\/orders\/validate\.ts` \| Rechaza la orden cuando le falta el total[^|]+\|/);
  assert.match(result.body, /\| `tests\/orders\.test\.ts` \| Cubre la orden inválida con un caso propio\. \|/);
});

test('a file reported without a reason says so instead of being given an invented one', t => {
  const result = draft(root(t), { ...facts, changedFiles: 1, files: [{ path: 'src/orders/validate.ts' }] });
  assert.match(result.body, /\| `src\/orders\/validate\.ts` \| Sin motivo registrado; revisá el diff\. \|/);
});

// A reason carrying a pipe or a newline used to end the row halfway through and shift every cell
// after it, which is a broken table presented as evidence.
test('a reason containing a pipe or a line break cannot break the table that holds it', t => {
  const current = { ...facts, changedFiles: 1, files: [{ path: 'src/a.ts', reason: 'Accepts a or b, and c.' }] };
  const result = draft(root(t), current, { overrides: { 'file.0': 'Acepta a | b y también c.' } });
  const row = result.body.split('\n').find(line => line.includes('src/a.ts'));
  // Two cells: the escaped pipe inside the reason is content, not a column boundary.
  assert.equal(row.split(/(?<!\\)\|/).length, 4, row);
  assert.match(row, /Acepta a \\\| b y también c\./);
});

// The verification phase describes what it found, which is not what the change is. Printed under
// Cambios it read as a denial of the table of modified files directly above it.
test('verification prose and check evidence live under Verificación, never under Cambios', t => {
  const result = draft(root(t));
  const [, , cambios, verificacion] = result.body.split(/^## /m).map(section => section.trim());
  assert.match(cambios, /^Cambios/);
  assert.doesNotMatch(cambios, /Se revisó la implementación|Comandos registrados/);
  assert.match(verificacion, /Se revisó la implementación sin modificar fuentes/);
  assert.match(verificacion, /Comandos registrados: 1 en total, 1 con salida 0\./);
});

test('SA-2: PR renderer retains repeated structured command exits and evidence limits', t => {
  const current = { ...facts, checks: [{ id: 'E1', command: 'npm test', exit: 1 }, { id: 'E2', command: 'npm test', exit: 0 }],
    limits: ['Retried after the external fixture service recovered.'] };
  const result = draft(root(t), current, { overrides: { 'limit.0': 'Se repitió la prueba después de que se recuperó el servicio externo.' } });
  assert.match(result.body, /2 en total, 1 con salida 0/);
  assert.match(result.body, /npm test/);
  assert.match(result.body, /salida 1/);
  assert.match(result.body, /Se repitió la prueba después de que se recuperó el servicio externo/);
});

for (const scenario of ['optional-failure', 'recovered-required', 'unresolved-required', 'blocked-required', 'required-supplemental', 'semantic-gap']) {
  test(`SA-2 reporting: runner-to-renderer classifies ${scenario} without losing evidence`, async t => {
    const path = root(t);
    const runtime = { sessionID: 'pr-reporting', agent: 'mdd-orchestrator', directory: path, worktree: path };
    const runner = new PhaseRunner({ parent: async () => {}, result: async (_r, _c, _p, output) => output });
    await runner.start({ preflight: { answers }, requirements: facts.goal }, runtime,
      { requirementsConfirmed: true, userMessageID: 'pr-request' });
    await throughRiskStop(runner, runtime.sessionID);
    const trace = structuredTraceFixture(files[0].path, 'orders');
    trace.acceptance.goal = facts.goal;
    if (scenario === 'optional-failure') trace.deliverables[0].checks[0].requirement = 'optional';
    const settle = async (callID, data) => {
      const call = { sessionID: runtime.sessionID, callID };
      await runner.after(call, await runner.before(call, runner.status(runtime.sessionID).task),
        reportDocument({ evidenceSummary: 'Recorded scoped evidence.', artifact: 'Checked the planned boundary.', ...data }));
    };
    await settle('plan', trace);
    await settle('apply', { completed: ['orders'], changes: files, delivered: facts.delivered });
    const data = structuredVerificationFixture(trace);
    data.verification.changes = facts.verification;
    const result = data.verification.checkResults[0];
    if (scenario === 'semantic-gap') {
      data.verification.steps[0].status = 'not-verified';
      data.verification.steps[0].assessment = 'Command succeeded but source behavior is not established.';
    } else if (scenario === 'required-supplemental') {
      data.checks.push({ id: 'E2', command: 'npm run integration', exit: 1 });
      data.verification.supplementalChecks = [{ id: 'integration', requirement: 'required', disposition: 'failed', executions: ['E2'], reason: 'Integration behavior failed.' }];
    } else {
      data.checks[0].exit = 1;
      data.checks.push({ id: 'E2', command: scenario === 'recovered-required' ? 'npm test' : 'npm run semantic-check', exit: 0 });
      for (const row of [...data.verification.scenarios, ...data.verification.steps, ...data.verification.decisions]) row.checks = ['E2'];
      if (scenario === 'recovered-required') {
        result.executions = ['E1', 'E2'];
        result.reason = 'Retried after the external test service recovered.';
      } else {
        result.disposition = scenario === 'blocked-required' ? 'blocked' : 'failed';
        result.reason = 'The planned check could not establish the required behavior.';
        if (scenario === 'blocked-required') { data.checks.shift(); result.executions = []; }
        data.verification.supplementalChecks = [{ id: 'semantic', requirement: 'optional', disposition: 'passed', executions: ['E2'] }];
      }
    }
    const complete = ['optional-failure', 'recovered-required'].includes(scenario);
    await settle('verify', { ...data, outcome: complete ? 'passed' : 'failed' });
    assert.equal(runner.status(runtime.sessionID).state, complete ? 'complete' : 'blocked');
    const projected = runner.prFacts(runtime.sessionID);
    assert.equal(projected.verificationVersion, 1);
    assert.equal(projected.verified, complete);
    assert.deepEqual(projected.checks, data.checks, 'PR projection retains all reported executions, including failures');
    const rendered = draft(path, projected).body;
    const verification = rendered.split('## Verificación\n\n')[1].split('\n## Variables de entorno')[0];
    const blockers = rendered.split('## Bloqueos\n\n')[1].split('\n## Despliegue')[0].trim();
    if (data.checks.some(check => check.exit === 1)) {
      assert.match(verification, /Con salida distinta de 0:/);
      assert.match(verification, /salida 1/);
      assert.match(verification, /2 en total, 1 con salida 0 y 1 con salida distinta de 0/);
    }
    if (complete) assert.equal(blockers, 'No aplica.', 'resolved or optional failures are evidence, not current blockers');
    else {
      assert.notEqual(blockers, 'No aplica.', 'unresolved required checks and semantic gaps remain blockers');
      assert.match(verification, /no están verificados del todo/);
    }
  });
}

test('SA-2 reporting: unversioned PR facts keep legacy nonzero-exit blockers', t => {
  const legacy = { ...facts, checks: [{ command: 'npm test', exit: 1 }, { command: 'npm test', exit: 0 }] };
  const body = draft(root(t), legacy).body;
  assert.match(body.split('## Bloqueos')[1], /1 comando\(s\) de verificación terminaron con salida distinta de 0/);
  assert.match(body.split('## Verificación')[1], /2 en total, 1 con salida 0 y 1 con salida distinta de 0/);
});

// Six identical redaction lines is what the reviewer actually got, one per command that carried an
// argument. Counted once and named where they can be named, the same evidence costs three lines.
test('checks are aggregated once, naming what can be shown and counting what cannot', t => {
  const current = { ...facts, checks: [
    { command: 'pnpm run lint:check', exit: 0 }, { command: 'pnpm test -- src/orders', exit: 0 },
    { command: 'npx tsc --noEmit', exit: 0 }, { command: 'pnpm test -- src/orders', exit: 0 },
    { command: 'node scripts/private.js --token sensitive', exit: 0 },
  ] };
  const result = draft(root(t), current);
  assert.match(result.body, /- Comandos registrados: 5 en total, 5 con salida 0\./);
  // Deduplicated: the same command run twice is one fact, not two lines.
  assert.match(result.body, /- Con salida 0: `pnpm run lint:check`, `pnpm test -- src\/orders`, `npx tsc --noEmit`\./);
  assert.match(result.body, /- Se omiten 1 comando\(s\) para no exponer argumentos ni rutas/);
  assert.doesNotMatch(result.body, /--token|sensitive/);
  assert.equal(result.body.match(/Se omiten/g).length, 1);
});

// Keeping only the successful commands showed the reviewer a greener run than the one that ran.
test('a check that exited nonzero is named, counted apart and blocks', t => {
  const current = { ...facts, verified: false, checks: [
    { command: 'npm test', exit: 0 }, { command: 'pnpm run build', exit: 1 }, { command: 'pnpm run e2e', exit: null },
  ] };
  const result = draft(root(t), current);
  assert.match(result.body, /- Comandos registrados: 3 en total, 1 con salida 0 y 2 con salida distinta de 0\./);
  assert.match(result.body, /- Con salida distinta de 0: `pnpm run build` \(salida 1\), `pnpm run e2e` \(sin salida registrada\)\./);
  assert.match(result.body, /- 2 comando\(s\) de verificación terminaron con salida distinta de 0\./);
});

test('the body carries no draft-only notice, while the caller still gets the authority fact', t => {
  const result = draft(root(t));
  assert.doesNotMatch(result.body, /borrador|Draft only|no fue publicado|Nothing was committed/i);
  assert.equal(result.publication, 'not-authorized');
});

test('an ordinary summary is not mistaken for a credential and survives intact', t => {
  // `/i` on the assignment pattern matched prose like "count = 5" and replaced the whole summary.
  const current = { ...facts, delivered: { ...facts.delivered, what: 'Rejects the order when count = 5 or the total is negative.' } };
  const result = draft(root(t), current, { overrides: { 'delivered.what': 'Rechaza la orden cuando count = 5 o el total es negativo.' } });
  assert.match(result.body, /count = 5/);
  assert.doesNotMatch(result.body, /se omitió texto sensible/);
});

test('PR draft without changes or successful verification stays explicitly incomplete', t => {
  const result = draft(root(t), { ...facts, changedFiles: 0, files: [], checks: [], verified: false, uncertain: true });
  assert.match(result.body, /No se registró ningún cambio de implementación/);
  assert.match(result.body, /no están verificados del todo/);
  assert.match(result.body, /inciertas/);
  assert.match(result.body, /- No se registró evidencia de comandos de verificación\./);
  // With nothing changed there is nothing to tabulate, and an empty table is not evidence.
  assert.doesNotMatch(result.body, /\| Archivo \|/);
});

test('PR notes must be exact whole user lines and remain attributed, never invented', t => {
  const path = root(t); const text = 'Redactá el cuerpo.\nNo aplica.\nDesplegar a mano después de revisar.';
  const result = draft(path, facts, { userText: text, notes: { environmentVariables: 'No aplica.', deployment: 'Desplegar a mano después de revisar.' } });
  assert.match(result.body, /## Variables de entorno\n\nNo aplica\./);
  assert.match(result.body, /Lo aportó el usuario, sin verificación independiente: Desplegar a mano/);
  assert.throws(() => draft(path, facts, { userText: text, notes: { deployment: 'Desplegar a mano' } }), /complete line/);
});

test('PR output omits credential assignments, raw paths, code excerpts and unsafe command arguments', t => {
  const text = 'API_KEY=do-not-print';
  // Unsafe text reaches the body the only way it can: recorded by a phase and faithfully
  // translated. The renderer, not the translation check, is what must refuse to print it.
  const current = { ...facts, delivered: { ...facts.delivered, what: 'Reads C:\\private\\source' },
    verification: '`private source excerpt`', checks: [{ command: 'node test.js --token sensitive', exit: 0 }] };
  const result = draft(root(t), current, { userText: text, notes: { environmentVariables: text },
    overrides: { 'delivered.what': 'Lee C:\\private\\source', verification: '`private source excerpt`' } });
  assert.doesNotMatch(result.body, /do-not-print|C:\\private|private source excerpt|--token|sensitive\]/);
  assert.match(result.body, /se omitió texto sensible/);
  assert.match(result.body, /- Se omiten 1 comando\(s\) para no exponer argumentos ni rutas/);
});

// A path is attacker-adjacent data too: it reaches a table cell and must not carry a secret there.
test('an unsafe changed path is redacted in its own row instead of printed', t => {
  const current = { ...facts, changedFiles: 1, files: [{ path: 'C:\\private\\source.ts', reason: 'API_KEY=do-not-print' }] };
  const result = draft(root(t), current, { overrides: { 'file.0': 'API_KEY=do-not-print' } });
  assert.doesNotMatch(result.body, /C:\\private|do-not-print/);
  assert.match(result.body, /se omitió texto sensible/);
});

test('PR renderer ignores workspace shadow assets and uses the packaged template', t => {
  const path = root(t); fs.mkdirSync(join(path, '.opencode/skills/mdd-pr-body/assets'), { recursive: true });
  fs.writeFileSync(join(path, '.opencode/skills/mdd-pr-body/assets/template.md'), '## Resumen\nOnly one section.');
  assert.equal([...draft(path).body.matchAll(/^## /gm)].length, 7);
});

test('recorded text cannot inject extra template headings', t => {
  const result = draft(root(t), facts, { overrides: { 'delivered.what': '## Encabezado inyectado para el lector' } });
  assert.equal([...result.body.matchAll(/^## /gm)].length, 7);
});

// The first call hands over the recorded prose and nothing else: a body built from it would be
// the English-inside-Spanish draft this whole path exists to stop producing.
test('the first call returns the recorded text to translate, with no body', t => {
  const request = prBodyRequest(facts);
  assert.equal(request.render, 'pending-translation');
  assert.equal(request.body, undefined);
  assert.equal(request.publication, 'not-authorized');
  assert.deepEqual(request.entries.map(entry => entry.key), ['delivered.what', 'delivered.implies', 'file.0', 'file.1', 'verification']);
  assert.equal(request.entries[0].text, facts.delivered.what);
  assert.equal(request.digest, translationDigest(facts.runID, translatable(facts)));
});

test('a translation made from evidence that has since changed is refused, not rendered', t => {
  const path = root(t);
  assert.throws(() => draft(path, facts, { digest: translationDigest('other-run', translatable(facts)) }), /no corresponde a la evidencia registrada/);
  // Same run, one more changed file: the digest moved because what the body would say moved.
  const moved = { ...facts, changedFiles: 3, files: [...files, { path: 'src/orders/total.ts', reason: 'Computes the total.' }] };
  assert.notEqual(translationDigest(facts.runID, translatable(facts)), translationDigest(moved.runID, translatable(moved)));
});

test('a translation that loses, invents or skips a recorded fact is refused with every fault named', t => {
  const entries = [
    { key: 'a', label: 'A', source: 'Rejects the order when the total is missing in src/orders/validate.ts.' },
    { key: 'b', label: 'B', source: 'ESLint exits 0 but reports 254 existing warnings.' },
  ];
  // Faithful: the path and the numbers survive, the prose is Spanish.
  assert.doesNotThrow(() => checkTranslations(entries, [
    { key: 'a', text: 'Rechaza la orden cuando falta el total en src/orders/validate.ts.' },
    { key: 'b', text: 'ESLint termina en 0 pero informa 254 advertencias existentes.' },
  ]));
  const faults = [
    [[{ key: 'a', text: 'Rechaza la orden cuando falta el total.' }, { key: 'b', text: 'ESLint termina en 0 pero informa 254 advertencias.' }], /perdió datos.*validate\.ts/],
    [[{ key: 'a', text: 'Rechaza la orden cuando falta el total en src/orders/validate.ts.' }, { key: 'b', text: 'ESLint termina en 0 pero informa 254 advertencias y 3 errores.' }], /agregó datos/],
    [[{ key: 'a', text: 'Rechaza la orden cuando falta el total en src/orders/validate.ts.' }], /falta "b"/],
    [[{ key: 'a', text: 'Rechaza la orden cuando falta el total en src/orders/validate.ts.' }, { key: 'b', text: 'ESLint exits 0 but reports 254 existing warnings.' }], /no parece estar en español/],
  ];
  for (const [translations, expected] of faults) assert.throws(() => checkTranslations(entries, translations), expected);
  // Every fault in one message: a caller that learns one per attempt never spends the last one fixing.
  assert.throws(() => checkTranslations(entries, [{ key: 'c', text: 'Sobra.' }]), /"c" no es una de las claves pedidas.*falta "a".*falta "b"/s);
});

test('a translation has no size limit of its own', () => {
  // Far past the former 2000-character cap; only its proportion to the source is still checked.
  const entries = [{ key: 'a', label: 'A', source: 'Rejects the order when the total is missing. '.repeat(100) }];
  const text = 'Rechaza la orden cuando falta el total. '.repeat(100);
  assert.ok(text.length > 2000);
  assert.equal(checkTranslations(entries, [{ key: 'a', text }]).get('a'), text.trim());
});

// A quick edit records no run, and its PR to staging was left unopened because the body tool
// refused to draft without one. Git lists the files; the coordinator only says why each changed.
const changes = { baseRef: 'origin/staging', baseCommit: 'a'.repeat(40), files: ['src/dashboard/title.ts', 'tests/dashboard.test.ts'] };
const direct = {
  summary: 'El título del dashboard ahora saluda con Buen día en lugar de Hola.',
  files: [
    { path: 'src/dashboard/title.ts', reason: 'Cambia el texto del título que ve quien entra al dashboard.' },
    { path: 'tests/dashboard.test.ts', reason: 'Actualiza la prueba que comprueba el texto del título.' },
  ],
};

test('a direct edit asks for its summary and reasons over exactly the files git listed', () => {
  const request = directPRRequest(changes);
  assert.equal(request.render, 'pending-direct');
  assert.equal(request.source, 'direct');
  assert.equal(request.baseRef, 'origin/staging');
  assert.deepEqual(request.files, changes.files);
  assert.equal(request.publication, 'not-authorized');
  assert.match(request.instruction, /never claim tests, checks or deployments/);
});

test('a direct edit renders the same seven sections and says MDD did not verify it', () => {
  const result = renderDirectPRBody(changes, direct, 'Abrí el PR a staging.');
  assert.deepEqual([...result.body.matchAll(/^## (.+)$/gm)].map(match => match[1]),
    ['Resumen', 'Cambios', 'Verificación', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue']);
  assert.match(result.body, /^## Resumen\n\nEl título del dashboard ahora saluda con Buen día/m);
  assert.match(result.body, /\| `src\/dashboard\/title\.ts` \| Cambia el texto del título que ve quien entra al dashboard\. \|/);
  assert.match(result.body, /\| `tests\/dashboard\.test\.ts` \| Actualiza la prueba/);
  const verification = result.body.split('## Verificación\n\n')[1].split('\n## ')[0];
  assert.match(verification, /Ajuste directo, sin una ejecución MDD registrada/);
  assert.match(verification, /no registró comandos de verificación/);
  assert.doesNotMatch(verification, /Comandos registrados/);
  // Not a blocker by itself: a small edit made on request is ordinary work.
  assert.match(result.body, /## Bloqueos\n\nNo aplica\./);
  assert.equal(result.render, 'final');
  assert.equal(result.publication, 'not-authorized');
  assert.deepEqual({ source: result.provenance.source, baseRef: result.provenance.baseRef }, { source: 'direct', baseRef: 'origin/staging' });
  assert.match(result.provenance.template.digest, /^[a-f0-9]{64}$/);
});

test('a direct edit cannot leave out, add or repeat a file, and its prose must be one Spanish line', () => {
  const [first, second] = direct.files;
  const faults = [
    [{ ...direct, files: [first] }, /falta el motivo de "tests\/dashboard\.test\.ts"/],
    [{ ...direct, files: [...direct.files, { path: 'src/other.ts', reason: 'Otro archivo que no cambió.' }] }, /"src\/other\.ts" no cambió contra origin\/staging/],
    [{ ...direct, files: [first, first, second] }, /viene repetido/],
    [{ ...direct, summary: 'The dashboard title now greets with Buen día instead of Hola.' }, /el resumen no parece estar en español/],
    [{ ...direct, files: [first, { ...second, reason: 'Actualiza la prueba\ndel título.' }] }, /tiene que ser una sola línea/],
  ];
  for (const [text, expected] of faults) assert.throws(() => renderDirectPRBody(changes, text, 'Abrí el PR.'), expected);
  assert.throws(() => renderDirectPRBody(changes, { ...direct, extra: 'x' }, 'Abrí el PR.'), /unknown/);
});

test('a direct edit keeps the user notes rule and the renderer safety filter', () => {
  const userText = 'Abrí el PR a staging.\nDesplegar a mano después de revisar.';
  const result = renderDirectPRBody(changes, { ...direct, summary: 'Lee C:\\private\\source para mostrar el título.' }, userText,
    { deployment: 'Desplegar a mano después de revisar.' });
  assert.match(result.body, /Lo aportó el usuario, sin verificación independiente: Desplegar a mano/);
  assert.doesNotMatch(result.body, /C:\\private/);
  assert.match(result.body, /se omitió texto sensible/);
  assert.throws(() => renderDirectPRBody(changes, direct, userText, { deployment: 'Desplegar a mano' }), /complete line/);
});

test('a translation that is really a rewrite or a summary is refused', t => {
  const entries = [{ key: 'a', label: 'A', source: 'Rejects the order when the total is missing, which is the case the requirement describes.' }];
  assert.throws(() => checkTranslations(entries, [{ key: 'a', text: 'La rechaza.' }]), /demasiado corta/);
  assert.throws(() => checkTranslations(entries, [{ key: 'a', text: `Rechaza la orden cuando falta el total, que es el caso que describe el requisito. ${'Y además conviene aclarar mucho más de lo que el texto decía. '.repeat(4)}` }]), /demasiado larga/);
});

const contextFacts = { ...facts, decisions: [{ id: 'D1', description: 'Keep validation at the order boundary.' }] };
const contextText = 'Draft the PR.\nRevisar primero el borde de entrada.';
const context = [
  { section: 'review', source: 'user', text: 'Revisar primero el borde de entrada.' },
  { section: 'risks', source: 'interpretation', text: 'El alcance no incluye la migración de órdenes existentes.' },
  { section: 'context', source: 'recorded', ref: 'goal' },
  { section: 'context', source: 'recorded', ref: 'decisions' },
  { section: 'review', source: 'interpretation', text: 'Conviene leer la validación antes de revisar las pruebas.' },
];
function contextDraft(t, additionalContext = context, current = contextFacts, request = prBodyRequest(current, additionalContext, contextText)) {
  const translations = request.entries.map(entry => ({ key: entry.key, text: {
    ...SPANISH, 'context.2.goal': SPANISH.goal,
    'context.3.decision.0': 'Mantener la validación en el borde de la orden.',
  }[entry.key] ?? entry.text }));
  return renderPRBody(root(t), current, contextText, {}, { digest: request.digest, translations, additionalContext });
}

test('optional PR context keeps legacy bytes and digest representation when absent or empty', t => {
  const request = prBodyRequest(facts);
  const legacyDigest = createHash('sha256').update(JSON.stringify([facts.runID, ...translatable(facts).map(entry => [entry.key, entry.source])])).digest('hex');
  assert.equal(request.digest, legacyDigest);
  assert.deepEqual(prBodyRequest(facts, [], contextText), request);
  assert.equal(contextDraft(t, [], facts).body, draft(root(t)).body);
  assert.equal(Object.hasOwn(request, 'additionalContext'), false);
  assert.equal(directPRRequest(changes).digest, undefined);
  assert.deepEqual(directPRRequest(changes, [], contextText), directPRRequest(changes));
  assert.equal(renderDirectPRBody(changes, direct, contextText, {}, { additionalContext: [] }).body,
    renderDirectPRBody(changes, direct, contextText).body);
});

test('optional PR context translates held prose and groups attributed content in fixed order', t => {
  const request = prBodyRequest(contextFacts, context, contextText);
  assert.deepEqual(request.additionalContext.map(entry => entry.source), context.map(entry => entry.source));
  assert.equal(request.entries.at(-2).text, facts.goal);
  assert.equal(request.entries.at(-1).text, contextFacts.decisions[0].description);
  assert.equal(request.additionalContext[3].items[0].id, 'D1');
  assert.equal(request.entries.some(entry => entry.text === context[0].text), false, 'user Spanish is not translated');
  const result = contextDraft(t);
  assert.deepEqual([...result.body.matchAll(/^## (.+)$/gm)].map(match => match[1]), [
    'Resumen', 'Cambios', 'Verificación', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue',
    'Contexto y decisiones', 'Riesgos y limitaciones', 'Notas para revisión',
  ]);
  assert.match(result.body, /Contexto registrado por actores, sin verificación independiente:.*Validá/s);
  assert.match(result.body, /D1: Mantener la validación en el borde de la orden/);
  assert.match(result.body, /Lo aportó el usuario, sin verificación independiente: Revisar primero/);
  assert.match(result.body, /Interpretación del agente, sin verificación independiente: El alcance/);
  assert.ok(result.body.indexOf(context[0].text) < result.body.indexOf(context[4].text), 'order is stable inside a group');
  assert.equal(result.body.split('## Contexto y decisiones')[0], draft(root(t)).body + '\n');
  assert.equal(result.publication, 'not-authorized');
  assert.deepEqual(result.provenance.additionalContext, request.additionalContext);
  assert.match(result.instruction, /verbatim/);
});

test('optional PR context binds source, section, text, held IDs and descriptions to translations', t => {
  const request = prBodyRequest(contextFacts, context, contextText);
  const mutations = [
    context.map((entry, i) => i === 1 ? { ...entry, section: 'review' } : entry),
    context.map((entry, i) => i === 0 ? { ...entry, source: 'interpretation' } : entry),
    context.map((entry, i) => i === 1 ? { ...entry, text: 'El alcance se limita a la entrada.' } : entry),
    context.map((entry, i) => i === 2 ? { ...entry, ref: 'decisions' } : entry),
    [...context].reverse(),
    context.slice(1), [],
  ];
  for (const changed of mutations) assert.throws(() => contextDraft(t, changed, contextFacts, request), /no corresponde/);
  for (const decision of [{ id: 'D2', description: contextFacts.decisions[0].description }, { id: 'D1', description: 'Use a different boundary.' }]) {
    assert.throws(() => contextDraft(t, context, { ...contextFacts, decisions: [decision] }, request), /no corresponde/);
  }
  assert.throws(() => contextDraft(t, context, { ...contextFacts, goal: 'A different goal.' }, request), /no corresponde/);
});

test('optional PR context rejects fabricated recorded selectors and unknown fields', () => {
  for (const entry of [
    { section: 'custom', source: 'recorded', ref: 'goal' },
    { section: 'context', source: 'recorded', ref: 'checks' },
    { section: 'context', source: 'recorded', ref: 'goal', text: 'Replacement.' },
    { section: 'review', source: 'interpretation', text: 'Para revisar.', ref: 'goal' },
    { section: 'review', source: 'actor', text: 'Para revisar.' },
  ]) assert.throws(() => prBodyRequest(contextFacts, [entry], contextText), /unknown|section|source|ref/);
  assert.throws(() => prBodyRequest(facts, [{ section: 'context', source: 'recorded', ref: 'decisions' }]), /No recorded decisions/);
});

test('optional PR context bounds caller entries, authored prose and expanded translations', () => {
  const entry = { section: 'review', source: 'interpretation', text: 'Para revisar.' };
  assert.doesNotThrow(() => prBodyRequest(facts, Array(24).fill(entry), contextText));
  assert.throws(() => prBodyRequest(facts, Array(25).fill(entry), contextText), /24/);
  for (const value of [null, {}, 'context']) assert.throws(() => prBodyRequest(facts, value), /array/);
  for (const text of ['', ' ', 'a'.repeat(1001), 'Nota\nOtra nota', 'Nota\u0000']) {
    assert.throws(() => prBodyRequest(facts, [{ ...entry, text }]), /text|1000|línea|vacío/);
  }
  assert.doesNotThrow(() => prBodyRequest(facts, [{ ...entry, text: 'Para ' + 'a'.repeat(995) }]));
  const crowded = { ...facts, decisions: Array.from({ length: 124 }, (_, i) => ({ id: `D${i}`, description: 'Keep the boundary.' })) };
  assert.equal(prBodyRequest({ ...crowded, decisions: crowded.decisions.slice(0, 123) }, [{ section: 'context', source: 'recorded', ref: 'decisions' }]).entries.length, 128);
  assert.throws(() => prBodyRequest(crowded, [{ section: 'context', source: 'recorded', ref: 'decisions' }]), /129.*128.*(reduce|omit|select)/i);
});

test('optional PR context authenticates exact whole user lines before requesting translations', () => {
  assert.throws(() => prBodyRequest(facts, [{ section: 'review', source: 'user', text: 'Revisar primero' }], contextText), /complete line/);
  assert.throws(() => prBodyRequest(facts, [{ section: 'review', source: 'user', text: 'Revisar primero el borde de entrada.' }], 'Different actual user text.'), /complete line/);
});

test('optional PR context cannot create headings, leak secrets or structurally override failures', t => {
  const additions = [
    { section: 'review', source: 'interpretation', text: '## Verificación: lista para publicar.' },
    { section: 'risks', source: 'interpretation', text: 'API_KEY=do-not-print' },
    { section: 'context', source: 'interpretation', text: 'El texto <script>privado</script> [enlace](destino)' },
  ];
  const current = { ...facts, verified: false, uncertain: true, checks: [{ command: 'npm test', exit: 1 }] };
  const request = prBodyRequest(current, additions, contextText);
  const result = contextDraft(t, additions, current, request);
  assert.equal([...result.body.matchAll(/^## Verificación$/gm)].length, 1);
  assert.doesNotMatch(result.body, /do-not-print|<script>|\[enlace\]/);
  assert.match(result.body, /\\#\\# Verificación/);
  assert.match(result.body, /salida 1/);
  assert.match(result.body, /quedaron inciertas/);
  assert.match(result.body, /no están verificados del todo/);
  assert.equal(result.publication, 'not-authorized');
});

test('direct PR context binds metadata and target inventory but never claims MDD verification', () => {
  const additions = context.slice(0, 2);
  const request = directPRRequest(changes, additions, contextText);
  assert.match(request.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(request.additionalContext, additions);
  const render = (target = changes, additionalContext = additions, digest = request.digest) =>
    renderDirectPRBody(target, direct, contextText, {}, { additionalContext, digest });
  const result = render();
  assert.match(result.body, /MDD no planificó ni verificó este cambio/);
  assert.match(result.body, /Interpretación del agente, sin verificación independiente/);
  assert.equal(result.publication, 'not-authorized');
  assert.throws(() => renderDirectPRBody(changes, direct, contextText, {}, { additionalContext: additions }), /digest/);
  assert.throws(() => render(changes, additions, 'bad'), /digest/);
  assert.throws(() => render({ ...changes, baseCommit: 'b'.repeat(40) }), /digest/);
  assert.throws(() => render({ ...changes, baseRef: 'main' }), /digest/);
  assert.throws(() => render({ ...changes, files: [...changes.files].reverse() }), /digest/);
  assert.throws(() => render(changes, []), /digest/);
  assert.throws(() => render(changes, [{ ...additions[1], section: 'review' }]), /digest/);
  assert.throws(() => render(changes, [{ ...additions[0], source: 'interpretation' }, additions[1]]), /digest/);
  assert.throws(() => render(changes, [additions[0], { ...additions[1], text: 'El alcance se limita al texto visible.' }]), /digest/);
  assert.throws(() => directPRRequest(changes, [{ section: 'context', source: 'recorded', ref: 'goal' }]), /recorded run/);
});
