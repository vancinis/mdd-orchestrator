import { isDeepStrictEqual } from 'node:util';
import type { Phase } from './policy.js';
import type { NativeEvidence } from './phase-evidence.js';
import { fileDigest, scopedPath, toolTargets, READ_TOOLS, LOOKUP_ONLY_PHASES } from './phase-policy.js';

type Admission = { root: string; phase: Phase; tool: string; args: unknown; before: Map<string, string>; result?: { output: unknown; metadata: unknown }; changed: string[]; projectRead: boolean };
export class NativeTools {
  readonly #calls = new Map<string, Admission>();
  before(sessionID: string, callID: string, root: string, phase: Phase, tool: string, args: Record<string, unknown>): void {
    const key = `${sessionID}/${callID}`;
    if (!callID || this.#calls.has(key)) throw new Error('Duplicate child tool invocation.');
    const targets = toolTargets(root, phase, tool, args);
    let projectRead = false;
    if (READ_TOOLS.includes(tool)) {
      try { scopedPath(root, tool === 'read' ? args.filePath : args.path ?? root, tool !== 'read'); projectRead = true; }
      catch { /* Native external-directory policy still controls tool-output reads. */ }
    }
    this.#calls.set(key, { root, phase, tool, args: structuredClone(args), before: new Map(targets.map(path => [path, fileDigest(path)])), changed: [], projectRead });
  }
  after(sessionID: string, callID: string, tool: string, args: unknown, output: { output?: unknown; metadata?: unknown }): void {
    const entry = this.#calls.get(`${sessionID}/${callID}`);
    if (!entry || entry.result || entry.tool !== tool || !isDeepStrictEqual(args, entry.args)) throw new Error('Child tool result lacks exact invocation provenance.');
    if (typeof output.output !== 'string' || !output.metadata || typeof output.metadata !== 'object') throw new Error('Unknown native child tool output.');
    if (Buffer.byteLength(JSON.stringify(output)) > 200000) throw new Error('Native tool result exceeds the evidence budget.');
    if (tool === 'bash') {
      const meta = output.metadata as Record<string, unknown>;
      // A lookup that finds nothing is an answer, not corrupted evidence. Phases whose bash
      // output is a check still require a clean exit.
      const lookup = LOOKUP_ONLY_PHASES.includes(entry.phase);
      if (meta.truncated !== false || typeof meta.output !== 'string' ||
          (lookup ? !Number.isInteger(meta.exit) : meta.exit !== 0)) {
        throw new Error('Native command failed, was interrupted, or has incomplete exit evidence.');
      }
    }
    for (const [path, before] of entry.before) {
      scopedPath(entry.root, path);
      if (fileDigest(path) !== before) entry.changed.push(path);
    }
    entry.result = structuredClone({ output: output.output, metadata: output.metadata });
  }
  evidence(sessionID: string, parts: Record<string, unknown>[]): NativeEvidence {
    const result: NativeEvidence = { childID: sessionID, readCalls: [], changes: [], checks: [] };
    const originals = new Map<string, string>();
    for (const [key, entry] of this.#calls) if (key.startsWith(`${sessionID}/`)) {
      for (const [path, digest] of entry.before) { scopedPath(entry.root, path); if (!originals.has(path)) originals.set(path, digest); }
    }
    const netChanges = new Set([...originals].filter(([path, digest]) => fileDigest(path) !== digest).map(([path]) => path));
    const seen = new Set<string>();
    for (const part of parts) {
      const callID = part.callID;
      if (typeof callID !== 'string' || seen.has(callID)) throw new Error('Missing or duplicate child tool call identity.');
      seen.add(callID);
      const entry = this.#calls.get(`${sessionID}/${callID}`);
      const state = part.state as Record<string, unknown>;
      if (!entry?.result || entry.tool !== part.tool || !state || state.status !== 'completed' ||
          !isDeepStrictEqual(state.input, entry.args) || !isDeepStrictEqual({ output: state.output, metadata: state.metadata }, entry.result)) {
        throw new Error('Native child history is not corroborated by the admitted invocation/result.');
      }
      if (entry.projectRead) result.readCalls.push(callID);
      const changed = entry.changed.filter(path => netChanges.has(path));
      if (changed.length) result.changes.push({ callID, paths: changed });
      if (entry.tool === 'bash') {
        const meta = state.metadata as Record<string, unknown>;
        if ((meta.exit !== null && !Number.isInteger(meta.exit)) || meta.truncated !== false || typeof meta.output !== 'string' || typeof state.output !== 'string') throw new Error('Native bash has missing, unknown or truncated exit evidence.');
        result.checks.push({ callID, command: (entry.args as { command: string }).command, exit: meta.exit as number | null, output: state.output });
      }
    }
    for (const [key, entry] of this.#calls) {
      if (key.startsWith(`${sessionID}/`) && (!entry.result || !seen.has(key.slice(sessionID.length + 1)))) throw new Error('Child history omits an admitted native tool execution.');
    }
    return result;
  }
}
