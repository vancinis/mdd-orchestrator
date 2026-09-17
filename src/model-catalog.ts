import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { delimiter, join } from 'node:path';

export type ModelCatalog =
  | { status: 'ok'; models: string[] }
  | { status: 'unavailable'; reason: string };

export const MODEL_LIMIT = 2000;
const MODEL_PATTERN = /^[A-Za-z0-9][\w.:-]*(\/[A-Za-z0-9][\w.:-]*)+$/;

/**
 * Resolves the launcher through PATH only; MDD never installs or upgrades OpenCode.
 * Names are searched by priority across the whole PATH, because a shim earlier in PATH
 * must not shadow a real executable later in it: Node cannot spawn .cmd/.ps1 without a
 * shell, and this adapter does not use shell wrappers.
 */
export function opencodeBinary(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const directories = (env.PATH ?? env.Path ?? '').split(delimiter).filter(directory => directory.trim());
  for (const name of platform === 'win32' ? ['opencode.exe'] : ['opencode']) {
    for (const directory of directories) {
      const candidate = join(directory, name);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* Keep scanning PATH. */ }
    }
  }
  return undefined;
}

/**
 * Reads the user's own installed model catalog with one bounded, read-only invocation.
 * Unavailable is a normal outcome: the editor then falls back to unverified free text.
 */
export function listModels(execute = execFileSync, env: NodeJS.ProcessEnv = process.env, platform = process.platform): ModelCatalog {
  const binary = opencodeBinary(env, platform);
  if (!binary) return { status: 'unavailable', reason: 'No se encontró el ejecutable de OpenCode en el PATH.' };
  let output: string;
  try {
    output = String(execute(binary, ['models'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { return { status: 'unavailable', reason: 'OpenCode no pudo listar los modelos disponibles.' }; }
  const models = [...new Set(output.replaceAll(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)
    .map(line => line.trim()).filter(line => MODEL_PATTERN.test(line)))].sort();
  if (!models.length) return { status: 'unavailable', reason: 'La lista de modelos de OpenCode llegó vacía.' };
  if (models.length > MODEL_LIMIT) return { status: 'unavailable', reason: `La lista de modelos supera el límite de ${MODEL_LIMIT}.` };
  return { status: 'ok', models };
}

export function providersOf(models: readonly string[]): string[] {
  return [...new Set(models.map(model => model.slice(0, model.indexOf('/'))))].sort();
}
