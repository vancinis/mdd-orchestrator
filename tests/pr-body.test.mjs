import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderPRBody } from '../dist/pr-body.js';

function root(t) { const root = fs.mkdtempSync(join(tmpdir(), 'mdd-pr-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
const files = [
  { path: 'src/orders/validate.ts', reason: 'Rechaza el pedido cuando falta el total, que es el caso que el requisito describe.' },
  { path: 'tests/orders.test.ts', reason: 'Cubre el pedido inválido con un caso propio.' },
];
const facts = { runID: 'recorded-run', goal: 'Validate orders before processing.', changes: 'Order validation was implemented.', changedFiles: 2, files, checks: ['npm test'], verified: true, uncertain: false, limits: [] };

test('PR renderer uses the local template exactly once per section and recorded facts only', t => {
  const result = renderPRBody(root(t), facts, 'Redactá el cuerpo del PR.');
  assert.deepEqual([...result.body.matchAll(/^## (.+)$/gm)].map(match => match[1]), ['Resumen', 'Cambios', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue']);
  assert.match(result.body, /npm test; salida 0/);
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

// A reviewer opens the PR already holding the list of paths. What they cannot reconstruct is why
// each file had to change, so that is what the section leads with.
test('changed files are reported as one table row each, with the reason that file changed', t => {
  const result = renderPRBody(root(t), facts, 'Redactá el cuerpo del PR.');
  assert.match(result.body, /\| Archivo \| Por qué cambió \|/);
  assert.match(result.body, /\| `src\/orders\/validate\.ts` \| Rechaza el pedido cuando falta el total[^|]+\|/);
  assert.match(result.body, /\| `tests\/orders\.test\.ts` \| Cubre el pedido inválido con un caso propio\. \|/);
});

test('a file reported without a reason says so instead of being given an invented one', t => {
  const result = renderPRBody(root(t), { ...facts, changedFiles: 1, files: [{ path: 'src/orders/validate.ts' }] }, 'Redactá.');
  assert.match(result.body, /\| `src\/orders\/validate\.ts` \| Sin motivo registrado; revisá el diff\. \|/);
});

// A reason carrying a pipe or a newline used to end the row halfway through and shift every cell
// after it, which is a broken table presented as evidence.
test('a reason containing a pipe or a line break cannot break the table that holds it', t => {
  const result = renderPRBody(root(t), { ...facts, changedFiles: 1, files: [{ path: 'src/a.ts', reason: 'Acepta a | b\ny también c.' }] }, 'Redactá.');
  const row = result.body.split('\n').find(line => line.includes('src/a.ts'));
  // Two cells: the escaped pipe inside the reason is content, not a column boundary.
  assert.equal(row.split(/(?<!\\)\|/).length, 4, row);
  assert.match(row, /Acepta a \\\| b y también c\./);
});

// The notice at the top of every body told the reviewer about MDD's permissions rather than about
// the change. Publication authority is reported to the caller, which is who can act on it.
test('the body carries no draft-only notice, while the caller still gets the authority fact', t => {
  const result = renderPRBody(root(t), facts, 'Redactá.');
  assert.doesNotMatch(result.body, /borrador|Draft only|no fue publicado|Nothing was committed/i);
  assert.match(result.body, /^## Resumen\n\nValidate orders before processing\./m);
  assert.equal(result.publication, 'not-authorized');
});

test('an ordinary goal is not mistaken for a credential and survives intact', t => {
  // `/i` on the assignment pattern matched prose like "count = 5" and replaced the whole summary.
  const result = renderPRBody(root(t), { ...facts, goal: 'Reject an order when count = 5 or the total is negative.' }, 'Redactá.');
  assert.match(result.body, /count = 5/);
  assert.doesNotMatch(result.body, /se omitió texto sensible/);
});

test('an oversize goal is shortened rather than discarded', t => {
  const result = renderPRBody(root(t), { ...facts, goal: `Validate orders. ${'detail '.repeat(300)}` }, 'Redactá.');
  assert.match(result.body, /Validate orders\./);
  assert.match(result.body, /\(recortado\)/);
});

test('PR draft without changes or successful verification stays explicitly incomplete', t => {
  const result = renderPRBody(root(t), { ...facts, changedFiles: 0, files: [], checks: [], verified: false, uncertain: true }, 'Redactá.');
  assert.match(result.body, /No se registró ningún cambio de implementación/);
  assert.match(result.body, /no están verificados del todo/);
  assert.match(result.body, /inciertas/);
  // With nothing changed there is nothing to tabulate, and an empty table is not evidence.
  assert.doesNotMatch(result.body, /\| Archivo \|/);
});

test('PR notes must be exact whole user lines and remain attributed, never invented', t => {
  const path = root(t); const text = 'Redactá el cuerpo.\nNo aplica.\nDesplegar a mano después de revisar.';
  const result = renderPRBody(path, facts, text, { environmentVariables: 'No aplica.', deployment: 'Desplegar a mano después de revisar.' });
  assert.match(result.body, /## Variables de entorno\n\nNo aplica\./);
  assert.match(result.body, /Lo aportó el usuario, sin verificación independiente: Desplegar a mano/);
  assert.throws(() => renderPRBody(path, facts, text, { deployment: 'Desplegar a mano' }), /complete line/);
});

test('PR output omits credential assignments, raw paths, code excerpts and unsafe command arguments', t => {
  const text = 'API_KEY=do-not-print';
  const result = renderPRBody(root(t), { ...facts, goal: 'Read C:\\private\\source', changes: '`private source excerpt`', checks: ['node test.js --token sensitive'] }, text, { environmentVariables: text });
  assert.doesNotMatch(result.body, /do-not-print|C:\\private|private source excerpt|--token|sensitive\]/);
  assert.match(result.body, /se omitió texto sensible/);
  assert.match(result.body, /se omite para no exponer argumentos ni rutas/);
});

// A path is attacker-adjacent data too: it reaches a table cell and must not carry a secret there.
test('an unsafe changed path is redacted in its own row instead of printed', t => {
  const result = renderPRBody(root(t), { ...facts, changedFiles: 1, files: [{ path: 'C:\\private\\source.ts', reason: 'API_KEY=do-not-print' }] }, 'Redactá.');
  assert.doesNotMatch(result.body, /C:\\private|do-not-print/);
  assert.match(result.body, /se omitió texto sensible/);
});

test('PR renderer ignores workspace shadow assets and uses the packaged template', t => {
  const path = root(t); fs.mkdirSync(join(path, '.opencode/skills/mdd-pr-body/assets'), { recursive: true });
  fs.writeFileSync(join(path, '.opencode/skills/mdd-pr-body/assets/template.md'), '## Resumen\nOnly one section.');
  assert.equal([...renderPRBody(path, facts, 'Redactá.').body.matchAll(/^## /gm)].length, 6);
});

test('recorded text cannot inject extra template headings', t => {
  const result = renderPRBody(root(t), { ...facts, goal: '## Injected heading' }, 'Redactá.');
  assert.equal([...result.body.matchAll(/^## /gm)].length, 6);
});
