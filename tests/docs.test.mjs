import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const GLOSSARY_TERMS = ['canal', 'stable', 'preview', 'dev', 'versión activa', 'gestor de versiones', 'caché de versiones', 'respaldo'];
const ADRS = [
  'docs/adr/0001-git-tags-and-owned-clone.md',
  'docs/adr/0002-separate-version-manager.md',
  'docs/adr/0003-backup-and-replace-on-switch.md',
  'docs/adr/0004-automatic-releases.md',
];

test('the glossary defines every term with its avoided synonyms', () => {
  const text = read('GLOSSARY.md');
  for (const term of GLOSSARY_TERMS) {
    const match = new RegExp(`^## ${term}\\r?\\n\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
    assert.ok(match, `GLOSSARY.md: missing term "${term}"`);
    assert.match(match[1], /_Evitar_:/, `GLOSSARY.md: "${term}" lacks _Evitar_`);
  }
});

test('the ADRs exist and state context, decision and reason', () => {
  for (const path of ADRS) {
    assert.ok(fs.existsSync(`${root}${path}`), `${path} missing`);
    const text = read(path);
    for (const label of ['**Contexto.**', '**Decisión.**', '**Por qué.**']) assert.ok(text.includes(label), `${path}: missing ${label}`);
  }
});

test('documented commands and flags exist in the CLI sources', () => {
  const versionCli = read('src/version-cli.ts');
  const cli = read('src/cli.ts');
  const release = read('scripts/release.mjs');
  assert.match(versionCli, /--checkout/);
  assert.match(versionCli, /--yes/);
  assert.match(cli + versionCli, /'versions'/);
  assert.match(cli + versionCli, /'use'/);
  for (const flag of ['--bootstrap', '--dry-run', '--yes']) assert.ok(release.includes(flag), `scripts/release.mjs lacks ${flag}`);
  assert.match(read('package.json'), /"release":\s*"node scripts\/release\.mjs"/);

  const docs = read('docs/installation.md') + read('README.md');
  for (const command of ['mdd-ai use', 'mdd-ai versions', '--checkout', '--yes', 'npm run release', '--bootstrap', '--dry-run']) {
    assert.ok(docs.includes(command), `docs do not mention ${command}`);
  }
  // Every `mdd-ai <command>` the docs show must be a command the router knows.
  const known = new Set(['use', 'versions', 'link', 'setup', 'update', 'doctor', 'config', 'profile']);
  for (const [, name] of docs.matchAll(/`mdd-ai ([a-z]+)/g)) assert.ok(known.has(name), `docs mention unknown command mdd-ai ${name}`);
});

test('the documented recovery command matches the manager entry path', () => {
  const paths = read('src/installation-paths.ts');
  assert.match(paths, /managerEntry: join\(managerRoot, 'entry\.mjs'\)/);
  assert.match(paths, /managerRoot = join\(ownedRoot, 'manager'\)/);
  const recovery = 'mdd/manager/entry.mjs" link';
  assert.ok(read('docs/installation.md').includes(recovery), 'installation.md lacks the recovery command');
  assert.ok(read('GLOSSARY.md').includes('mdd/manager/entry.mjs" link'), 'glossary lacks the recovery command');
});

test('user docs describe channels, retention and restart, and no longer say use is unavailable', () => {
  const installation = read('docs/installation.md');
  const readme = read('README.md');
  for (const text of ['stable', 'preview', 'dev', 'adopt', 'últimos 10', '3 previews', 'todas las estables', 'opencode service restart', 'Compatibilidad']) {
    assert.ok(installation.includes(text), `installation.md lacks "${text}"`);
  }
  for (const doc of [installation, readme]) assert.doesNotMatch(doc, /todavía no está disponible/);
  assert.match(read('docs/architecture.md'), /Gestor de versiones/);
  assert.match(readme, /GLOSSARY\.md/);
});

test('relative links in the new documents resolve', () => {
  for (const path of ['README.md', 'GLOSSARY.md', 'docs/installation.md', 'docs/architecture.md', ...ADRS]) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const [, target] of read(path).matchAll(/\]\((?!https?:|#)([^)#]+)(?:#[^)]*)?\)/g)) {
      assert.ok(fs.existsSync(new URL(`../${dir}${target}`, import.meta.url)), `${path}: broken link ${target}`);
    }
  }
});

test('G4 the docs describe what the code does: cli.json migration, error 1 exceptions, retention and the probe contract', () => {
  const installation = read('docs/installation.md');
  assert.doesNotMatch(installation, /hace la migración sola/, 'no automatic-migration claim');
  assert.match(installation, /`mdd-ai use` no la toca/, 'use does not touch cli.json');
  for (const text of ['bloqueada', 'confirmado con aviso', 'entradas compiladas completas', 'excepciones', '15 s']) assert.ok(installation.includes(text), `installation.md lacks "${text}"`);
  assert.doesNotMatch(installation, /\(siempre con "No se\s+cambió la instalación activa"\)/, 'error 1 is not always "unchanged"');

  // The permanent probe contract in ADR 0002 names real exports of the sources that implement it.
  const adr = read('docs/adr/0002-separate-version-manager.md');
  const exportsBySource = {
    'src/project-assets.ts': ['MDD_ASSETS', 'installedAsset', 'installedName', 'MDD_PACKAGED_ASSETS'],
    'src/setup.ts': ['LOADER_PATH', 'LOADER_TEXT', 'PRIVATE_IGNORE_PATH', 'PRIVATE_IGNORE_TEXT'],
    'src/settings.ts': ['loadSettings'],
    'src/version-manager.ts': ['MANAGER_REVISION'],
  };
  for (const [source, names] of Object.entries(exportsBySource)) {
    const code = read(source);
    for (const name of names) {
      assert.ok(adr.includes(name), `ADR 0002 lacks the probe export ${name}`);
      assert.match(code, new RegExp(`export (?:const|function|async function) ${name}\\b`), `${source} no longer exports ${name}`);
    }
  }
  for (const op of ['assets', 'packaged', 'config <dir>', 'manager']) assert.ok(adr.includes(`| \`${op}\``), `ADR 0002 lacks the probe operation ${op}`);
  assert.match(adr, /Contrato de sondeo del destino/);
  // The documented doctor bound is the one the code uses.
  assert.match(read('src/version-source.ts'), /DOCTOR_TIMEOUT_MS = 15000/);
});

test('the docs describe run persistence: local or versioned markers and the Engram copy', () => {
  const contract = read('assets/opencode/contracts/run-file.md');
  const docs = read('README.md') + '\n' + read('docs/architecture.md');
  for (const marker of ['# mdd: local', '# mdd: versioned']) {
    assert.ok(contract.includes(marker), `run-file.md lacks "${marker}"`);
    assert.ok(docs.includes(marker), `README or architecture lacks "${marker}"`);
  }
  for (const path of ['README.md', 'docs/architecture.md']) assert.doesNotMatch(read(path), /borrá ese archivo/, `${path} still says to delete the file`);
  assert.match(docs, /Engram/, 'README or architecture mentions Engram');
});

test('ADR 0002 and the architecture describe the setup/update dispatch of D27', () => {
  for (const path of ['docs/adr/0002-separate-version-manager.md', 'docs/architecture.md']) {
    const text = read(path).replace(/\s+/g, ' ');
    assert.match(text, /`setup` y `update` abren primero el asistente/, `${path}: setup/update open the wizard first`);
    assert.match(text, /solo delegan en la versión activa si se conserva la (versión )?actual/, `${path}: delegate only when keeping the version`);
  }
});

test('automatic release docs describe the real engine, the policy and the rollout state without claiming it is live', () => {
  const flat = path => read(path).replace(/\s+/g, ' ');
  const installation = flat('docs/installation.md');
  const adr = flat('docs/adr/0004-automatic-releases.md');
  const auto = read('scripts/release-auto.mjs');

  // The documented CLI is the real one: plan and publish, no invented subcommand.
  assert.match(auto, /command !== 'plan' && command !== 'publish'/);
  for (const flag of ['--repo', '--run-id', '--attempt']) assert.ok(auto.includes(flag), `scripts/release-auto.mjs lacks ${flag}`);
  assert.ok(installation.includes('node scripts/release-auto.mjs plan'));
  assert.ok(installation.includes('node scripts/release-auto.mjs publish'));
  assert.doesNotMatch(read('docs/installation.md') + read('README.md') + read('docs/architecture.md') + read('docs/adr/0004-automatic-releases.md'), /release-auto\.mjs reconcile/);
  // The real-origin publish command appears once, in the operator section, and never in a fenced example.
  const publishMentions = read('docs/installation.md').match(/release-auto\.mjs publish/g) ?? [];
  assert.equal(publishMentions.length, 1, 'publish is shown exactly once');
  assert.doesNotMatch(read('docs/installation.md'), /```[^`]*release-auto\.mjs publish[^`]*```/);
  assert.match(installation, /workflow_dispatch/);
  assert.match(installation, /No lo uses para pruebas locales/);

  // Policy and behavior.
  for (const text of [
    'lista para revisión', 'mismo repositorio', 'reabrirla', 'base `main`', 'major', 'minor', 'patch', 'docs', 'chore',
    'merge commit o squash', 'rebase deshabilitada', 'anotada', 'inmutables', 'nunca se mueve ni se borra', 'No se hace push a ninguna rama', 'orden de fuente',
    'cierran en falso', 'release-skip/<sha-completo>', 'Solo el propietario', 'git tag -n', 'git for-each-ref', 'mdd-ai use v0.5.0',
    'global', 'v0.4.0-preview.1', 'desactualizados', 'solo lectura', 'no ejecuta nada del candidato', 'stable** y para **preview',
    'La primera PR que agrega la automatización no tiene preview', 'externa y posterior',
  ]) assert.ok(installation.includes(text), `installation.md lacks "${text}"`);
  // The manual fallback keeps its documented no-push flags.
  for (const text of ['Nunca hace push', '--dry-run', '--yes', '--bootstrap', 'acumulativo']) assert.ok(installation.includes(text), `installation.md lacks "${text}"`);

  // Rollout rulesets: `v*` creatable by Actions and owner; `release-skip/*` owner-only, never Actions; both immutable.
  const bootstrap = installation.slice(installation.indexOf('### Activación y bootstrap'), installation.indexOf('## Configuración'));
  const rulesetItem = prefix => {
    const start = bootstrap.indexOf(prefix);
    assert.ok(start >= 0, `bootstrap lacks the ${prefix} ruleset item`);
    const next = bootstrap.indexOf(' - ', start + prefix.length);
    return bootstrap.slice(start, next < 0 ? undefined : next);
  };
  const versionRule = rulesetItem('Etiquetas de versión `v*`');
  const skipRule = rulesetItem('Marcadores `release-skip/*`');
  assert.match(versionRule, /el actor de Actions y el propietario/);
  assert.match(versionRule, /nadie las actualiza ni las borra/);
  assert.doesNotMatch(versionRule, /release-skip/);
  assert.match(skipRule, /únicamente el propietario/);
  assert.match(skipRule, /Actions nunca/);
  assert.match(skipRule, /inmutables/);
  assert.match(skipRule, /no en la identidad del autor de la etiqueta/);
  assert.doesNotMatch(skipRule, /actor de Actions y el propietario/);
  // The two rulesets are never granted together in one instruction.
  assert.doesNotMatch(bootstrap, /`v\*` y `release-skip\/\*`|`release-skip\/\*` y `v\*`/);
  // The manual changelog base comes from the off-main published tag, not from main.
  const manual = installation.slice(installation.indexOf('### Release manual tras releases automáticos'), installation.indexOf('## Releases automáticos'));
  assert.match(manual, /última etiqueta publicada, que aporta las entradas automáticas y está fuera de `main`/);
  assert.doesNotMatch(manual, /ya existente en `main`/);

  // Corrected contracts: remote-verified tags, run_number rotation, pinned workflow, exact-source recovery.
  for (const [name, text] of [['installation.md', installation], ['ADR 0004', adr]]) {
    assert.match(text, /verificad[ao]s en el remoto/, `${name}: remote-verified tags`);
    assert.match(text, /run_number/, `${name}: run_number rotation`);
    assert.match(text, /workflow_sha/, `${name}: pinned workflow revision`);
    assert.match(text, /actions: read/, `${name}: prepare actions: read`);
    assert.match(text, /\bno(\*\*)? hace pasar/, `${name}: later fix does not unblock the old source`);
    assert.match(text, /omit\w+ explícitamente|omitir explícitamente/, `${name}: explicit owner skip`);
    assert.doesNotMatch(text, /omite automáticamente (la|una) fuente|se desbloquea sola/, `${name}: no automatic skip`);
  }
  assert.match(installation, /\*\*no se mueve ni se borra\*\*/);
  assert.match(installation, /misma ejecución usa el mismo número y no se crea ninguna cola nueva/);
  assert.match(installation, /nunca autoriza una etiqueta/);
  assert.doesNotMatch(installation, /manual de abajo/);

  // Not-yet-live wording and no claim of live success anywhere in the user docs.
  assert.match(installation, /solo empieza a actuar cuando se fusiona en `main`/);
  assert.match(installation, /no hay publicación automática/);
  for (const path of ['docs/installation.md', 'README.md', 'docs/architecture.md', 'docs/adr/0004-automatic-releases.md']) {
    assert.doesNotMatch(read(path), /ya (está|esta) (activ|desplegad|funcionando)|se publicó automáticamente|verificado en vivo|ejecución real exitosa/i, `${path}: claims live success`);
  }
  assert.match(flat('README.md'), /se activa solo tras fusionarlo/);
  assert.match(flat('docs/architecture.md'), /Se activa únicamente tras fusionarlo/);

  // ADR 0004 and the pointer from ADR 0001.
  for (const text of ['**Contexto.**', '**Decisión.**', '**Por qué.**', 'etiquetas anotadas', 'no hace push a ninguna rama', 'solo lectura', 'release-skip/<sha>', 'no afirma que ya esté desplegado']) {
    assert.ok(adr.includes(text), `ADR 0004 lacks "${text}"`);
  }
  assert.ok(read('docs/adr/0001-git-tags-and-owned-clone.md').includes('(0004-automatic-releases.md)'), 'ADR 0001 lacks the pointer to ADR 0004');
  assert.ok(read('README.md').includes('docs/adr/0004-automatic-releases.md'));
  assert.ok(read('docs/architecture.md').includes('adr/0004-automatic-releases.md'));
});

test('user docs and AGENTS.md describe explicit mdd-explain usage and its artifact paths', () => {
  const inventory = ['README.md', 'docs/installation.md', 'docs/architecture.md', 'AGENTS.md'];
  for (const path of inventory) assert.ok(read(path).includes('mdd-explain'), `${path} lacks mdd-explain`);
  const readme = read('README.md').replace(/\s+/g, ' ');
  const architecture = read('docs/architecture.md').replace(/\s+/g, ' ');
  for (const [name, text] of [['README.md', readme], ['docs/architecture.md', architecture]]) {
    assert.ok(text.includes('.mdd/artifacts/<tema>/index.html'), `${name} lacks the standalone path`);
    assert.ok(text.includes('.mdd/runs/<id>/artifacts/<tema>/index.html'), `${name} lacks the run-associated path`);
  }
  assert.match(readme, /`general`/);
  assert.match(readme, /No abre una ejecución\. Una explicación común sigue en el chat/);
  assert.match(architecture, /no abre una ejecución/);
  assert.match(architecture, /no la fuente de verdad/);
  assert.match(read('AGENTS.md'), /ordinary explanations stay in chat/);
});
