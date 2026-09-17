import type { Phase } from './policy.js';
import { objectWithKeys } from './validation.js';
import { scopedPath, toolTargets } from './phase-policy.js';
import { references, shortText } from './acceptance.js';

export type NativeEvidence = {
  childID: string; readCalls: string[];
  changes: { callID: string; paths: string[] }[];
  checks: { callID: string; command: string; exit: number | null; output: string }[];
};
export type NativeResult = { text: string; evidence: NativeEvidence };
export type Deliverable = { id: string; description: string; path: string; check: string; scenarios: string[]; decisions: string[]; dependsOn: string[] };
function usableCheckOutput(output: string): boolean {
  if (!output.trim() || output.trim() === '(no output)' || /\bno tests? (?:found|ran|executed)\b/i.test(output)) return false;
  const skipped = /\b(?:skipped|skip|todo)\b/i.test(output);
  const passed = /(?:\b[1-9][0-9]* (?:tests? )?passed\b|\bpass(?:ed)?\s*[:=]?\s+[1-9][0-9]*\b)/i.test(output);
  return !skipped || passed;
}
export function deliverables(root: string, value: unknown): Deliverable[] {
  if (!Array.isArray(value) || !value.length || value.length > 32) throw new Error('Planning requires 1–32 explicit deliverables.');
  const ids = new Set<string>();
  return value.map(item => {
    const entry = objectWithKeys(item, 'deliverable', ['id', 'description', 'path', 'check', 'scenarios', 'decisions', 'dependsOn']);
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id) || ids.has(entry.id) || typeof entry.check !== 'string') throw new Error('Invalid or duplicate deliverable.');
    ids.add(entry.id);
    const path = scopedPath(root, entry.path);
    toolTargets(root, 'mdd-verify', 'bash', { command: entry.check });
    return { id: entry.id, description: shortText(entry.description, 'implementation step'), path, check: entry.check,
      scenarios: references(entry.scenarios, 'step scenarios'), decisions: references(Object.hasOwn(entry, 'decisions') ? entry.decisions : [], 'step decisions', true), dependsOn: references(Object.hasOwn(entry, 'dependsOn') ? entry.dependsOn : [], 'step dependencies', true) };
  });
}
export function corroborate(phase: Phase, value: Record<string, unknown>, native: NativeEvidence | undefined, planned: Deliverable[]): { implementation: boolean; checks: boolean } {
  if (phase === 'mdd-apply') {
    const actual = native?.changes ?? [];
    if (!actual.length) {
      if (!native?.readCalls.length || typeof value.noChangeReason !== 'string' || !value.noChangeReason.trim() || value.noChangeReason.length > 2000 ||
          (value.changes !== undefined && (!Array.isArray(value.changes) || value.changes.length))) throw new Error('Apply without actual changes requires an explicit noChangeReason and earns no implementation credit.');
      return { implementation: false, checks: false };
    }
    if (!Array.isArray(value.changes) || value.changes.length !== actual.length || new Set(value.changes).size !== actual.length ||
        value.changes.some(id => !actual.some(change => change.callID === id))) throw new Error('Apply change references do not match actual scoped native edits.');
    return { implementation: true, checks: false };
  }
  if (phase !== 'mdd-verify') return { implementation: false, checks: false };
  const actual = native?.checks ?? [];
  if (!planned.length || !actual.length || !Array.isArray(value.checks) || value.checks.length !== actual.length) throw new Error('Verify requires explicit executed check references and applicable planned checks.');
  const seen = new Set<string>();
  for (const item of value.checks) {
    const check = objectWithKeys(item, 'check reference', ['callID', 'command']);
    const receipt = actual.find(actual => actual.callID === check.callID && actual.command === check.command);
    if (!receipt || seen.has(receipt.callID) || receipt.exit !== 0 || !usableCheckOutput(receipt.output)) throw new Error('Verify check is missing, duplicated, nonzero, interrupted, empty, or skipped-only.');
    seen.add(receipt.callID);
  }
  if (planned.some(plan => !actual.some(check => check.command === plan.check))) throw new Error('Verify omitted an applicable planned command.');
  return { implementation: false, checks: true };
}
