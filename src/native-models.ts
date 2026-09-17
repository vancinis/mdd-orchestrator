import type { Hooks } from '@opencode-ai/plugin';
import { MODEL_ROLES, modelFor } from './settings.js';
import type { StartupProfile } from './settings.js';

type NativeConfig = Parameters<NonNullable<Hooks['config']>>[0];

/** Applies the configured model for each MDD role. Absent roles keep the user's own selection. */
export function applyModelOverrides(config: NativeConfig, profile: StartupProfile): void {
  for (const role of MODEL_ROLES) {
    const model = modelFor(profile, role);
    if (model === undefined) continue;
    const name = role === 'orchestrator' ? 'mdd-orchestrator' : role;
    config.agent ??= {};
    config.agent[name] = { ...config.agent[name], model };
  }
}
