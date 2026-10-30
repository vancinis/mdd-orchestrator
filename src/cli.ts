#!/usr/bin/env node
import { ValidationError } from './validation.js';
import { settingsCommand } from './settings-cli.js';

const usage = `MDD: instalación y configuración

Uso:
  mdd-ai                       abre el asistente de instalación o actualización
  mdd-ai setup                 instala MDD de forma global en OpenCode
  mdd-ai update                reemplaza el paquete instalado por el de este checkout
  mdd-ai link                  agrega mdd-ai al PATH de tu usuario
  mdd-ai doctor                diagnostica la instalación sin cambiar nada
  mdd-ai config                editor de perfiles, modelos y preferencias
  mdd-ai profile list | create <nombre> | use <nombre>
  mdd-ai --help

Desde un checkout del código los mismos comandos funcionan con node dist/cli.js.
Los cambios de configuración se aplican al reiniciar OpenCode.
Códigos de salida: 0 éxito; 2 uso o validación; 1 error de E/S o instalación no lista.
`;

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h' || args[0] === 'help')) {
    process.stdout.write(usage);
  } else if (!await settingsCommand(args, process.cwd(), text => { process.stdout.write(text); })) {
    throw new ValidationError(args.length ? `Comando desconocido: ${args.join(' ')}. Ejecutá mdd-ai --help.` : 'mdd-ai necesita una terminal interactiva. Ejecutá mdd-ai --help para ver los comandos.');
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Falla inesperada.';
  process.stderr.write(`Error de MDD: ${message}\n`);
  process.exitCode = error instanceof ValidationError ? 2 : 1;
}
