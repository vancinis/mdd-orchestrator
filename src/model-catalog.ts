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

export type VariantCatalog =
  | { status: 'ok'; variants: Record<string, string[]> }
  | { status: 'unavailable'; reason: string };

const PROVIDER_PATTERN = /^[A-Za-z0-9][\w.-]*$/;

/**
 * Reads the reasoning-effort variants declared per model, for one provider, from the same
 * V2 API catalog OpenCode itself resolves selectors against. Variants are optional per
 * model; an empty map is a normal outcome, not an error.
 */
export function listVariants(provider: string, execute = execFileSync, env: NodeJS.ProcessEnv = process.env, platform = process.platform): VariantCatalog {
  if (!PROVIDER_PATTERN.test(provider)) return { status: 'unavailable', reason: 'Proveedor inválido.' };
  const binary = opencodeBinary(env, platform);
  if (!binary) return { status: 'unavailable', reason: 'No se encontró el ejecutable de OpenCode en el PATH.' };
  let output: string;
  try {
    output = String(execute(binary, ['api', 'model.list'], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch { return { status: 'unavailable', reason: 'OpenCode no pudo listar los niveles de esfuerzo.' }; }
  try {
    const parsed: unknown = JSON.parse(output);
    const models = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? (parsed as { data?: unknown }).data : undefined;
    if (!Array.isArray(models) || models.length > MODEL_LIMIT) throw new Error();
    const variants: Record<string, string[]> = {};
    for (const model of models) {
      if (!model || typeof model !== 'object' || model.providerID !== provider || typeof model.id !== 'string') continue;
      const key = `${provider}/${model.id}`;
      if (!MODEL_PATTERN.test(key) || !Array.isArray(model.variants)) throw new Error();
      if (model.variants.some((variant: unknown) => !variant || typeof variant !== 'object' || typeof (variant as { id?: unknown }).id !== 'string')) throw new Error();
      variants[key] = [...new Set<string>(model.variants.map((variant: { id: string }) => variant.id))].sort();
    }
    return { status: 'ok', variants };
  } catch {
    if (output.trimStart().startsWith('{') || output.trimStart().startsWith('['))
      return { status: 'unavailable', reason: 'El catálogo de modelos de OpenCode V2 no tiene el formato esperado.' };
  }
  const lines = output.replaceAll(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
  const variants: Record<string, string[]> = {};
  // Each model is printed as a header line, then a pretty-printed JSON object whose own
  // closing brace sits at column 0 like the header, which is what bounds one block here.
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index]!.trim();
    if (!MODEL_PATTERN.test(header) || lines[index + 1] !== '{') continue;
    let end = index + 1;
    while (end < lines.length && lines[end] !== '}') end++;
    if (end >= lines.length) break;
    try {
      const parsed: unknown = JSON.parse(lines.slice(index + 1, end + 1).join('\n'));
      const declared = parsed && typeof parsed === 'object' ? (parsed as { variants?: unknown }).variants : undefined;
      variants[header] = declared && typeof declared === 'object' ? Object.keys(declared).sort() : [];
    } catch { /* Skip a block this build cannot parse; other models stay usable. */ }
    index = end;
  }
  return { status: 'ok', variants };
}
