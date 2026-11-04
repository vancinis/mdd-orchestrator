#!/usr/bin/env node
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ValidationError } from './validation.js';
import { installationPaths } from './installation-paths.js';
import { settingsCommand } from './settings-cli.js';

const usage = `MDD: instalación y configuración

Uso:
  mdd-ai                       abre el asistente de instalación o actualización
  mdd-ai setup                 instala MDD de forma global en OpenCode
  mdd-ai update                abre el asistente de versiones (desde un checkout: npm run setup -- update)
  mdd-ai versions              lista versiones, identidad activa y canales
  mdd-ai use <destino>         cambia de versión: 0.2.0 | v0.3.0-preview.1 | stable | preview | dev
                               opciones: --checkout <ruta> (solo dev), --yes
  mdd-ai link                  agrega mdd-ai al PATH de tu usuario
  mdd-ai doctor                diagnostica la instalación sin cambiar nada
  mdd-ai config                editor de perfiles, modelos y preferencias
  mdd-ai profile list | create <nombre> | use <nombre>
  mdd-ai --help

Desde un checkout del código los mismos comandos funcionan con node dist/cli.js.
Los cambios de configuración se aplican al reiniciar OpenCode.
Códigos de salida: 0 éxito; 2 uso o validación; 1 error de E/S o instalación no lista.
`;

/** The "use" and "versions" commands belong to the version manager; no package handles them. */
function forwardToManager(args: string[]): void {
  const entry = installationPaths().managerEntry;
  if (!fs.existsSync(entry)) throw new ValidationError('El gestor de versiones no está instalado. Ejecutá npm run setup desde un checkout para instalarlo.');
  process.exitCode = spawnSync(process.execPath, [entry, ...args], { stdio: 'inherit' }).status ?? 1;
}

try {
  const args = process.argv.slice(2);
  if (args[0] === 'use' || args[0] === 'versions') forwardToManager(args);
  else if (args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help')) {
    process.stdout.write(usage);
  } else if (!await settingsCommand(args, process.cwd(), text => { process.stdout.write(text); })) {
    throw new ValidationError(args.length ? `Comando desconocido: ${args.join(' ')}. Ejecutá mdd-ai --help.` : 'mdd-ai necesita una terminal interactiva. Ejecutá mdd-ai --help para ver los comandos.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Falla inesperada.';
  process.stderr.write(`Error de MDD: ${message}\n`);
  process.exitCode = error instanceof ValidationError ? 2 : 1;
}
