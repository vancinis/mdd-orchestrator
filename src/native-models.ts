import type { Hooks } from '@opencode-ai/plugin';
import { MODEL_ROLES, modelFor, parseModel } from './settings.js';
import type { StartupProfile } from './settings.js';

type NativeConfig = Parameters<NonNullable<Hooks['config']>>[0];
type Agent = Record<string, unknown>;
type Binding = { parent: string; agents: ReadonlyMap<string, string | undefined> };

export function applyModelOverrides(config: NativeConfig, profile: StartupProfile): void {
  for (const role of MODEL_ROLES) {
    const model = modelFor(profile, role);
    if (model === undefined) continue;
    const name = role === 'orchestrator' ? 'mdd-orchestrator' : role;
    config.agent ??= {};
    config.agent[name] = { ...config.agent[name], model };
  }
}

export function nativeModel(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Missing native model identity.');
  const { providerID, modelID } = value as Record<string, unknown>;
  if (typeof providerID !== 'string' || providerID.includes('/') || typeof modelID !== 'string') {
    throw new Error('Invalid native model identity.');
  }
  return parseModel(`${providerID}/${modelID}`);
}

export class NativeModels {
  readonly #bindings = new Map<string, Binding>();
  constructor(readonly profile: StartupProfile) {}

  bind(sessionID: string, agents: Agent[], parent: unknown): void {
    const current = this.#agents(agents);
    const actual = nativeModel(parent);
    const explicit = modelFor(this.profile, 'orchestrator');
    if (explicit !== undefined && explicit !== actual) throw new Error('Orchestrator model differs from the startup profile.');
    const previous = this.#bindings.get(sessionID);
    if (previous) {
      this.check(sessionID, agents);
      if (previous.parent !== actual) throw new Error('Native parent model changed during the run; restart in a new parent.');
      return;
    }
    this.#bindings.set(sessionID, { parent: actual, agents: current });
  }

  check(sessionID: string, agents: Agent[]): void {
    const binding = this.#binding(sessionID);
    const current = this.#agents(agents);
    for (const [name, model] of binding.agents) {
      if (current.get(name) !== model) throw new Error('Resolved native agent model changed during the run.');
    }
  }

  expected(sessionID: string, phase: string): string {
    const binding = this.#binding(sessionID);
    if (!binding.agents.has(phase) || phase === 'mdd-orchestrator') throw new Error('Unknown native phase model.');
    return binding.agents.get(phase) ?? binding.parent;
  }

  #binding(sessionID: string): Binding {
    const binding = this.#bindings.get(sessionID);
    if (!binding) throw new Error('Native models were not bound before dispatch.');
    return binding;
  }

  #agents(agents: Agent[]): ReadonlyMap<string, string | undefined> {
    const models = new Map<string, string | undefined>();
    for (const role of MODEL_ROLES) {
      const name = role === 'orchestrator' ? 'mdd-orchestrator' : role;
      const matches = agents.filter(agent => agent.name === name);
      if (matches.length !== 1 || matches[0]!.mode !== (role === 'orchestrator' ? 'primary' : 'subagent')) {
        throw new Error('An MDD agent is missing, duplicated, or has changed mode.');
      }
      const value = matches[0]!.model;
      const model = value === undefined ? undefined : nativeModel(value);
      const explicit = modelFor(this.profile, role);
      if (explicit !== undefined && explicit !== model) throw new Error('Resolved agent model differs from the startup profile.');
      models.set(name, model);
    }
    return models;
  }
}
