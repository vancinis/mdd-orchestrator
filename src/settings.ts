import { LocalFiles } from './local-files.js';
import { objectWithKeys, ValidationError } from './validation.js';

/** Installed MDD agents with per-profile models. `orchestrator` maps to `mdd-orchestrator`. */
export const MODEL_ROLES = Object.freeze([
  'orchestrator', 'mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-propose', 'mdd-spec',
  'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify', 'mdd-security',
  'mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix',
] as const);
export type ModelRole = typeof MODEL_ROLES[number];
export const NATIVE_SUBAGENTS = Object.freeze(['explore', 'general'] as const);
export type NativeSubagent = typeof NATIVE_SUBAGENTS[number];

export const MODES = Object.freeze(['automatic', 'interactive'] as const);
export const SUMMARIES = Object.freeze(['low', 'medium', 'detailed'] as const);
/** Preferences the orchestrator reads from its prompt. Unset values are asked or defaulted there. */
export type Mode = typeof MODES[number];
export type Summary = typeof SUMMARIES[number];
export type Preferences = { mode?: Mode; summary?: Summary };
export type NamedProfile = {
  models: Partial<Record<ModelRole, string>>;
  answers: Preferences;
  subagentModels?: Partial<Record<NativeSubagent, string>>;
};
export type Settings = { version: 1; activeProfile: string; profiles: Record<string, NamedProfile> };

/**
 * Keys earlier MDD versions wrote. They are accepted and dropped, so upgrading never refuses a
 * configuration that used to be valid.
 */
const RETIRED_SETTINGS = ['engram', 'telemetry', 'workers', 'knowledge', 'guards', 'verify'];
const RETIRED_ANSWERS = ['certainty', 'artifactStore', 'complexity'];

export function profileName(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value) ||
      (value === 'prototype' || Object.hasOwn(Object.prototype, value)) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(value)) {
    throw new ValidationError('Profile name must be a safe 1–64 character name (letters, digits, underscore, hyphen).');
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

export function parsePreferences(value: unknown): Preferences {
  const input = objectWithKeys(value, 'answers', ['mode', 'summary', ...RETIRED_ANSWERS]);
  const result: Preferences = {};
  if (input.mode !== undefined) {
    if (!MODES.includes(input.mode as never)) throw new ValidationError(`answers.mode must be one of: ${MODES.join(', ')}.`);
    result.mode = input.mode as Mode;
  }
  if (input.summary !== undefined) {
    if (!SUMMARIES.includes(input.summary as never)) throw new ValidationError(`answers.summary must be one of: ${SUMMARIES.join(', ')}.`);
    result.summary = input.summary as Summary;
  }
  return result;
}

export function defaultSettings(): Settings {
  return { version: 1, activeProfile: 'default', profiles: { default: { models: {}, answers: {} } } };
}

export function parseSettings(value: unknown): Settings {
  const input = objectWithKeys(value, 'settings', ['version', 'activeProfile', 'profiles', ...RETIRED_SETTINGS]);
  if (input.version !== 1) throw new ValidationError('settings.version must be 1.');
  const names = typeof input.profiles === 'object' && input.profiles !== null ? Object.keys(input.profiles) : [];
  if (!names.length || names.length > 64) throw new ValidationError('Settings require 1–64 named profiles.');
  names.forEach(profileName);
  const profiles = objectWithKeys(input.profiles, 'profiles', names);
  const result: Settings = { version: 1, activeProfile: profileName(input.activeProfile), profiles: {} };
  for (const name of names) {
    const profile = objectWithKeys(profiles[name], 'profile', ['models', 'answers', 'subagentModels']);
    const models = objectWithKeys(profile.models ?? {}, 'models', MODEL_ROLES);
    const parsed: NamedProfile = { models: {}, answers: parsePreferences(profile.answers ?? {}) };
    for (const role of MODEL_ROLES) if (Object.hasOwn(models, role)) parsed.models[role] = parseModel(models[role]);
    if (profile.subagentModels !== undefined) {
      const subagents = objectWithKeys(profile.subagentModels, 'subagentModels', NATIVE_SUBAGENTS);
      parsed.subagentModels = {};
      for (const agent of NATIVE_SUBAGENTS)
        if (Object.hasOwn(subagents, agent)) parsed.subagentModels[agent] = parseModel(subagents[agent]);
    }
    result.profiles[name] = parsed;
  }
  if (!Object.hasOwn(result.profiles, result.activeProfile)) throw new ValidationError('Active profile does not exist.');
  return result;
}

const LIMIT = 131072;
export const SETTINGS_FILE = 'mdd.config.json';

export function loadSettings(root: string): Settings {
  const text = new LocalFiles(root).read(SETTINGS_FILE, LIMIT);
  if (text === undefined) return defaultSettings();
  let input: unknown;
  try { input = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new ValidationError(`${SETTINGS_FILE} contains malformed JSON.`); }
  return parseSettings(input);
}

export function saveSettings(root: string, value: unknown): Settings {
  const settings = parseSettings(value);
  new LocalFiles(root).update(SETTINGS_FILE, () => `${JSON.stringify(settings, null, 2)}\n`, LIMIT);
  return settings;
}

export function activeProfile(settings: Settings): NamedProfile {
  return settings.profiles[settings.activeProfile]!;
}

/** The agent ID a model role configures. */
export function agentFor(role: ModelRole): string {
  return role === 'orchestrator' ? 'mdd-orchestrator' : role;
}
