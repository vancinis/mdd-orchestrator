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
    } else if (req.url.startsWith('/search?')) {
      // The real provider answers a search with a JSON array, which is a different shape from
      // every other endpoint here. Recording improvements is the only read that uses it.
      const query = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
      data = writes.map((write, index) => ({ id: index + 1, ...write }))
        .filter(row => (!query.get('type') || row.type === query.get('type')) &&
          (!query.get('project') || row.project === query.get('project')))
        .slice(0, Number(query.get('limit') ?? 20));
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
  certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low',
};
export const runtime = {
  sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: process.cwd(), worktree: process.cwd(),
};
export const call = { sessionID: runtime.sessionID, callID: 'call_one' };
export function request(endpoint, explore = false) {
  return { preflight: { answers, explore }, requirements: 'Plan a safe change to the CLI.', project: 'mdd-test', engramEndpoint: endpoint };
}
/**
 * Renders a phase result in the markdown form actors are actually asked for. Tests drive the
 * contract the product ships, so the structured fields live in one fenced block and the rest is
 * prose, exactly as a real actor writes it.
 */
export function reportDocument(result) {
  const { phase, runID, callID, outcome, evidenceSummary, how, artifact, concerns, ...data } = result;
  return [
    ...(phase ? [`## MDD Phase\n\n${phase}\n`] : []),
    ...(runID ? [`## MDD Run\n\n${runID}\n`] : []),
    `## MDD Outcome\n\n${outcome ?? 'passed'}\n`,
    `## MDD Summary\n\n${evidenceSummary}\n`,
    ...(how ? [`## MDD How\n\n${how}\n`] : []),
    `## MDD Artifact\n\n${artifact}\n`,
    ...(Object.keys(data).length ? [`## MDD Data\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`] : []),
    ...(concerns ? [`## MDD Concerns\n\n\`\`\`json\n${JSON.stringify(concerns)}\n\`\`\`\n`] : []),
  ].join('\n');
}

export const SUMMARY_TEXT = 'Read src/cli.ts; no commands were executed.';
export const ARTIFACT_TEXT = 'Plan: add validation at the CLI boundary. Later run CLI tests. Risk: preserve existing exit codes.';
export function result(status, outcome = 'passed') {
  return reportDocument({
    outcome,
    evidenceSummary: SUMMARY_TEXT,
    artifact: ARTIFACT_TEXT,
    ...(status.phase === 'mdd-plan' ? traceFixture() : status.phase === 'mdd-tasks' ? { deliverables: traceFixture().deliverables } : {}),
  });
}
