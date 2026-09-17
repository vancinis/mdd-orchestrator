#!/usr/bin/env node
import fs from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const cli = join(root, 'dist/cli.js');
export function needsPreparation(directory) {
  if (!fs.existsSync(join(directory, 'dist/cli.js')) || !fs.existsSync(join(directory, 'node_modules/@opencode-ai/plugin/dist/index.js'))) return true;
  const source = join(directory, 'src');
  if (!fs.existsSync(source)) return false;
  return fs.readdirSync(source, { recursive: true, withFileTypes: true }).some(entry => {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return false;
    const input = join(entry.parentPath, entry.name);
    const output = join(directory, 'dist', relative(source, input).replace(/\.ts$/, '.js'));
    return !fs.existsSync(output) || fs.statSync(input).mtimeMs > fs.statSync(output).mtimeMs;
  });
}
const NO_TERMINAL = 'La preparación del código fuente necesita una terminal interactiva para aprobar la instalación de dependencias y el build. No se hizo ningún cambio.';
export async function prepareSource(directory, io, execute = spawnSync, npmPath = process.env.npm_execpath ?? join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')) {
  if (!io.isTTY) throw new Error(NO_TERMINAL);
  const answer = await io.read([
    '', `MDD · Preparación del código fuente`, '─'.repeat(46),
    `  Carpeta  ${directory}`,
    '  Paso 1   Instalar dependencias fijadas con npm ci --ignore-scripts (usa red o caché)',
    '  Paso 2   Compilar el TypeScript local confiable',
    '  Nota     No se hace ningún cambio global.',
    '', '  Escribí apply para continuar; Enter cancela.', '> ',
  ].join('\n'));
  if (answer !== 'apply') return false;
  if (!fs.existsSync(npmPath)) throw new Error('No se encontró el CLI de npm. Ejecutá npm run setup con la instalación soportada de Node/npm.');
  for (const command of [['ci', '--ignore-scripts', '--no-audit', '--no-fund'], ['run', 'build', '--ignore-scripts']]) {
    const result = execute(process.execPath, [npmPath, ...command], { cwd: directory, stdio: 'inherit', timeout: 180000 });
    if (result.status !== 0) throw new Error('Falló la preparación del código fuente; no se aplicó la instalación.');
  }
  return true;
}

if (process.argv[1] && resolveEntry(process.argv[1]) === fileURLToPath(import.meta.url)) {
try {
  const forwarded = args.length && ['config', 'profile', 'telemetry', 'doctor', 'init', 'setup', 'update', '--help', '--answers', '--profile'].includes(args[0]) ? args : ['setup', ...args];
  if (['setup', 'update', 'init', 'doctor'].includes(forwarded[0]) && forwarded.length > 1) throw new Error(`Usage: mdd ${forwarded[0]}. Target directories are retired; installation is global.`);
  if (args.includes('--help') && !fs.existsSync(cli)) {
    console.log('MDD setup: npm run setup\nInstalación global interactiva y con consentimiento explícito. La preparación del código fuente se aprueba por separado. Engram es opcional. --help no hace ningún cambio.');
  } else {
    const missing = !args.includes('--help') && needsPreparation(root);
    if (missing) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(NO_TERMINAL);
      const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
      const controller = new AbortController();
      terminal.on('SIGINT', () => controller.abort()); terminal.on('close', () => controller.abort());
      let prepared;
      try { prepared = await prepareSource(root, { isTTY: true, read: async prompt => {
        try { return await terminal.question(prompt, { signal: controller.signal }); } catch { return undefined; }
      } }); } finally { terminal.close(); }
      if (!prepared) { console.log('Cancelado. No se hizo ningún cambio.'); process.exit(0); }
    }
    const child = spawnSync(process.execPath, [cli, ...forwarded], { cwd: process.cwd(), stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
  }
} catch (error) { console.error(`MDD error: ${error.message}`); process.exitCode = 1; }
}

function resolveEntry(path) { try { return fs.realpathSync(path); } catch { return path; } }
