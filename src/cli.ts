#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluate } from './kernel.js';
import { ValidationError } from './validation.js';
import { settingsCommand } from './settings-cli.js';

const usage = `Instalación global de MDD y prueba de ruteo
Las banderas de prueba son una simulación: la CLI no ejecuta ninguna fase.

Uso:
  mdd-ai                      abre el asistente de instalación/actualización
  mdd-ai link                 agrega mdd-ai al PATH de tu usuario
  mdd-ai config | doctor | init | update
  mdd-ai profile list | create <nombre> | use <nombre>
  mdd-ai telemetry status | report | on | off | clear
  mdd-ai lessons report | list [texto] | mark <id> | clear
  node dist/cli.js --answers <archivo.json> [--config <archivo.json>] [--explore]
  node dist/cli.js --profile <archivo.json> [--config <archivo.json>] [--explore]
  node dist/cli.js --help

El comando global se instala como mdd-ai; los mismos comandos funcionan con
node dist/cli.js desde un checkout del código. Setup ofrece agregar su carpeta
al PATH de tu usuario, y nunca edita el PATH de la máquina.

Setup: un único flujo interactivo de instalar, configurar y verificar; memoria
opcional y un Aplicar explícito.
Update: reemplaza un paquete propio desactualizado y sus assets tras el mismo
Aplicar explícito.
Checkout de código: npm run setup (ofrece instalar dependencias y compilar antes
del asistente).
Configuración del proyecto: config abre un editor de terminal avanzado; Guardar
es explícito y Cancelar no escribe nada.
Los perfiles con nombre viven en mdd.config.json, aparte del archivo --profile
que usa la prueba.
Cambiar modelo o perfil requiere reiniciar el entorno nativo. Los modelos que
falten heredan la selección nativa.
La telemetría es solo local, viene activada y guarda 30 días al usar la API.
El reporte de telemetría lee el registro del workspace: tiempo por fase,
reintentos, fallos y tokens.
Las automejoras anotan, con texto, qué salió mal: las escribe cada fase que falla
y también vos cuando pedís que algo quede registrado. Son locales al workspace.

Answers: los cinco campos del preflight. Profile: { "answers": { ... } }.
Config: overrides opcionales de umbral y peso parcial. Ver docs/product-contract.md.
Usá exactamente una fuente. Las rutas son relativas al directorio actual.
Códigos de salida: 0 éxito o ayuda; 2 error de uso, JSON o validación; 1 error de
E/S o falla inesperada.
`;

function parseArguments(args: string[]): Record<string, unknown> {
  const paths = new Map<string, string>();
  let explore = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--explore') {
      if (explore) throw new ValidationError('Opción duplicada: --explore.');
      explore = true;
      continue;
    }
    if (flag !== '--answers' && flag !== '--profile' && flag !== '--config') {
      throw new ValidationError(`Opción desconocida: ${flag}. Ejecutá con --help para ver el uso.`);
    }
    if (paths.has(flag)) throw new ValidationError(`Opción duplicada: ${flag}.`);
    const path = args[++index];
    if (!path || path.startsWith('--')) throw new ValidationError(`${flag} requiere la ruta de un archivo JSON.`);
    paths.set(flag, path);
  }
  if (paths.has('--answers') === paths.has('--profile')) {
    throw new ValidationError('Pasá exactamente una de --answers o --profile.');
  }
  const request: Record<string, unknown> = { explore };
  for (const [flag, path] of paths) {
    const text = readFileSync(path, 'utf8');
    try {
      request[flag.slice(2)] = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new ValidationError(`El archivo ${flag} "${path}" tiene JSON mal formado. Usá JSON UTF-8 válido.`);
    }
  }
  return request;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
  } else if (!await settingsCommand(args, process.cwd(), text => { process.stdout.write(text); })) {
    const result = evaluate(parseArguments(args));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Falla inesperada.';
  process.stderr.write(`Error de MDD: ${message}\n`);
  process.exitCode = error instanceof ValidationError ? 2 : 1;
}
