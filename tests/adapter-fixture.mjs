import { createServer } from 'node:http';
import { mkdirSync, copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export function installCleanup(root) {
  // Skills are bundled with the runtime, never installed into the execution workspace.
}

/**
 * Every fixture that writes global settings must isolate its home itself. Relying only on
 * the suite's --import hook lets a single `node --test <file>` invocation overwrite the
 * developer's real ~/.config/opencode/mdd/mdd.config.json.
 */
export function isolateHome(t) {
  const names = ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'APPDATA', 'LOCALAPPDATA'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const root = mkdtempSync(join(tmpdir(), 'mdd-isolated-home-'));
  for (const name of names) process.env[name] = root;
  t.after(() => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

export function traceFixture(path = 'src/cli.ts', stepID = 'cli-validation') {
  return {
    acceptance: { goal: 'Make the requested feature usable with clear input handling.', requirements: [{ id: 'R1', description: 'Handle valid and invalid input predictably.', scenarios: [
      { id: 'S1', given: 'Valid input', when: 'The feature is used', then: 'The requested result is returned' },
      { id: 'S2', given: 'Invalid input', when: 'The feature is used', then: 'A clear error is returned without unintended changes' },
    ] }] },
    decisions: [{ id: 'D1', description: 'Validate input at the feature boundary.', requirements: ['R1'] }],
    deliverables: [{ id: stepID, description: 'Implement and test boundary validation.', path, check: 'npm test', scenarios: ['S1', 'S2'], decisions: ['D1'], dependsOn: [] }],
  };
}

export async function memoryServer(t, change = () => {}) {
  const binding = { id: 'ses_parent', project: 'mdd-test', directory: process.cwd() };
  const writes = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    let status = 200;
    let data = binding;
    if (req.url === '/health') data = { service: 'engram', status: 'ok', version: '0.1.0' };
    if (req.url.startsWith('/project/current?')) data = { project: binding.project, cwd: binding.directory, project_path: binding.directory, available_projects: [] };
    if (req.method === 'POST') {
      writes.push(JSON.parse(text));
      status = 201;
      data = { id: writes.length, status: 'saved' };
    } else if (req.url.startsWith('/observations/')) {
      const id = Number(req.url.split('/').at(-1));
      data = { id, ...writes[id - 1] };
    }
    const reply = { status, data, headers: {} };
    change(req, reply, writes);
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.data));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { endpoint: `http://127.0.0.1:${server.address().port}`, binding, writes };
}

export const answers = {
  certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low', complexity: 'not-complex',
};
export const runtime = {
  sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: process.cwd(), worktree: process.cwd(),
};
export const call = { sessionID: runtime.sessionID, callID: 'call_one' };
export function request(endpoint, explore = false) {
  return { preflight: { answers, explore }, requirements: 'Plan a safe change to the CLI.', project: 'mdd-test', engramEndpoint: endpoint };
}
export function result(status, outcome = 'passed') {
  return JSON.stringify({
    phase: status.phase, runID: status.runID, callID: call.callID, outcome,
    evidenceSummary: 'Read src/cli.ts; no commands were executed.',
    artifact: 'Plan: add validation at the CLI boundary. Later run CLI tests. Risk: preserve existing exit codes.',
    ...(status.phase === 'mdd-plan' ? traceFixture() : status.phase === 'mdd-tasks' ? { deliverables: traceFixture().deliverables } : {}),
  });
}
