import type { Hooks } from '@opencode-ai/plugin';
import { MODEL_ROLES, modelFor } from './settings.js';
import type { StartupProfile } from './settings.js';

type NativeConfig = Parameters<NonNullable<Hooks['config']>>[0];

/**
 * Applies the configured model for each MDD role. Absent roles keep the user's own selection.
 * The stored `provider/model#variant` form carries the reasoning effort, but the runtime resolves
 * an agent's effort from a separate `variant` field and reads `model` as a whole identifier, so a
 * forwarded suffix becomes an unknown model. The suffix is split here rather than passed through.
 */
export function applyModelOverrides(config: NativeConfig, profile: StartupProfile): void {
  for (const role of MODEL_ROLES) {
    const selected = modelFor(profile, role);
    if (selected === undefined) continue;
    const separator = selected.indexOf('#');
    const model = separator === -1 ? selected : selected.slice(0, separator);
    const name = role === 'orchestrator' ? 'mdd-orchestrator' : role;
    config.agent ??= {};
    const agent: Record<string, unknown> = { ...config.agent[name], model };
    // An effort the user chose for their own model does not describe the model MDD selects here.
    if (separator === -1) delete agent.variant;
    else agent.variant = selected.slice(separator + 1);
    config.agent[name] = agent;
  }
}
