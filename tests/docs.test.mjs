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
];

test('the glossary defines every term with its avoided synonyms', () => {
  const text = read('GLOSSARY.md');
  for (const term of GLOSSARY_TERMS) {
    const match = new RegExp(`^## ${term}\\r?\\n\\r?\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text);
    assert.ok(match, `GLOSSARY.md: missing term "${term}"`);
    assert.match(match[1], /_Evitar_:/, `GLOSSARY.md: "${term}" lacks _Evitar_`);
  }
});

test('the three ADRs exist and state context, decision and reason', () => {
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
