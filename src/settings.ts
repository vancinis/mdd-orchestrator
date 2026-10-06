import type { Answers } from './policy.js';
import { parsePartialAnswers } from './preflight.js';
import { LocalFiles } from './local-files.js';
import { objectWithKeys, ValidationError } from './validation.js';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODEL_ROLES = Object.freeze([
  'orchestrator', 'mdd-explore', 'mdd-plan', 'mdd-propose', 'mdd-spec',
  'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify', 'mdd-risk', 'mdd-security',
  'mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix',
] as const);
/**
 * Configurable actors are not necessarily workflow phases. Risk, security and standalone
 * Judgment Day roles are installed and modeled here without expanding routing, phase reports,
 * telemetry phases, or the adapters' phase-instruction/tool policy.
 */
export type ModelRole = typeof MODEL_ROLES[number];
export type NamedProfile = { models: Partial<Record<ModelRole, string>>; answers: Partial<Answers> };
export type EngramSettings = { endpoint: string; project?: string } | { mode: 'local'; binary: string; dataDirectory: string };
export type Settings = {
  version: 1;
  activeProfile: string;
  profiles: Record<string, NamedProfile>;
  engram?: EngramSettings;
  telemetry: { enabled: boolean };
};

export function profileName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ||
      (value === 'prototype' || Object.hasOwn(Object.prototype, value)) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) {
    throw new ValidationError('Profile/project name must be a safe 1–64 character name (letters, digits, underscore, hyphen).');
  }
  return value;
}

export function parseModel(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*(\/[a-zA-Z0-9][a-zA-Z0-9_.:-]*)+(#[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/.test(value)) {
    throw new ValidationError('Model must be provider/model, optionally with a nested model path and a #variant reasoning-effort suffix; blank means inherit in the editor.');
  }
  return value;
}

export function defaultSettings(): Settings {
  return { version: 1, activeProfile: 'default', profiles: { default: { models: {}, answers: {} } }, telemetry: { enabled: true } };
}

export function parseSettings(value: unknown): Settings {
  const input = objectWithKeys(value, 'settings', ['version', 'activeProfile', 'profiles', 'engram', 'telemetry']);
  if (input.version !== 1) throw new ValidationError('settings.version must be 1.');
  const names = typeof input.profiles === 'object' && input.profiles !== null ? Object.keys(input.profiles) : [];
  if (!names.length || names.length > 64) throw new ValidationError('Settings require 1–64 named profiles.');
  names.forEach(profileName);
  const profiles = objectWithKeys(input.profiles, 'profiles', names);
  const result = defaultSettings();
  result.profiles = {};
  for (const name of names) {
    const profile = objectWithKeys(profiles[name], 'profile', ['models', 'answers']);
    const models = objectWithKeys(Object.hasOwn(profile, 'models') ? profile.models : {}, 'models', MODEL_ROLES);
    const parsed: NamedProfile = { models: {}, answers: parsePartialAnswers(Object.hasOwn(profile, 'answers') ? profile.answers : {}) };
    for (const role of MODEL_ROLES) if (Object.hasOwn(models, role)) parsed.models[role] = parseModel(models[role]);
    result.profiles[name] = parsed;
  }
  result.activeProfile = profileName(input.activeProfile);
  if (!Object.hasOwn(result.profiles, result.activeProfile)) throw new ValidationError('Active profile does not exist.');
  if (Object.hasOwn(input, 'telemetry')) {
    const telemetry = objectWithKeys(input.telemetry, 'telemetry', ['enabled']);
    if (typeof telemetry.enabled !== 'boolean') throw new ValidationError('telemetry.enabled must be boolean.');
    result.telemetry.enabled = telemetry.enabled;
  }
  if (Object.hasOwn(input, 'engram')) {
    const engram = objectWithKeys(input.engram, 'engram', ['mode', 'binary', 'dataDirectory', 'endpoint', 'project']);
    if (engram.mode === 'local') {
      objectWithKeys(input.engram, 'local Engram', ['mode', 'binary', 'dataDirectory']);
      for (const field of ['binary', 'dataDirectory'] as const) {
        if (typeof engram[field] !== 'string' || !isAbsolute(engram[field]) || /[\r\n\0]/.test(engram[field])) throw new ValidationError(`Local Engram ${field} must be an absolute path.`);
      }
      result.engram = { mode: 'local', binary: engram.binary as string, dataDirectory: engram.dataDirectory as string };
      return result;
    }
    objectWithKeys(input.engram, 'endpoint Engram', ['endpoint', 'project']);
    if (typeof engram.endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(engram.endpoint) ||
        Number(engram.endpoint.replace(/\/$/, '').split(':').at(-1)) > 65535) {
      throw new ValidationError('Engram endpoint must be an explicit http://127.0.0.1:PORT loopback origin.');
    }
    result.engram = { endpoint: new URL(engram.endpoint).origin, ...(Object.hasOwn(engram, 'project') ? { project: profileName(engram.project) } : {}) };
  }
  return result;
}

const LIMIT = 131072;
export function setupDiagnostic(root: string) {
  const workspaceRoot = resolve(root);
  const configPath = join(workspaceRoot, 'mdd.config.json');
  const command = `node "${fileURLToPath(new URL('./cli.js', import.meta.url))}" config`;
  return { workspaceRoot, configPath, problem: 'invalid-settings', missingFields: [], command,
    action: `Invalid settings at ${configPath}; plugin tools are unavailable. Repair using docs/mdd-config.schema.json, then in ${workspaceRoot} run ${command}, Save, and restart OpenCode. Engram is optional; omit it to keep memory off.` };
}

export function loadSettings(root: string): Settings {
  const text = new LocalFiles(root).read('mdd.config.json', LIMIT);
  if (text === undefined) return defaultSettings();
  let input: unknown;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new ValidationError('mdd.config.json contains malformed JSON.'); }
  return parseSettings(input);
}

export function saveSettings(root: string, value: unknown): Settings {
  const settings = parseSettings(value);
  new LocalFiles(root).update('mdd.config.json', () => `${JSON.stringify(settings, null, 2)}\n`, LIMIT);
  return settings;
}

export type StartupProfile = Readonly<{
  name: string;
  models: Readonly<Partial<Record<ModelRole, string>>>;
  answers: Readonly<Partial<Answers>>;
}>;

/** Capture once at plugin startup. Settings edits take effect after restart. */
export function freezeProfile(value: unknown): StartupProfile {
  const settings = parseSettings(value);
  const profile = settings.profiles[settings.activeProfile]!;
  return Object.freeze({ name: settings.activeProfile, models: Object.freeze(profile.models), answers: Object.freeze(profile.answers) });
}

/** undefined deliberately delegates model selection to the native runtime. */
export function modelFor(profile: StartupProfile, role: ModelRole): string | undefined {
  if (!MODEL_ROLES.includes(role)) throw new ValidationError('Unknown model role.');
  return profile.models[role];
}
