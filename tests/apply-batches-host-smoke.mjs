// Real V2 host + native foreground children; scripted local model, not paid-model evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { opencodeBinary } from '../dist/model-catalog.js';
import { defaultSettings } from '../dist/settings.js';
import { reportDocument, traceFixture } from './adapter-fixture.mjs';
import { CheckpointStore } from '../dist/checkpoint.js';
import { PhaseRunner } from '../dist/phase-runner.js';
import { ProgressGuard } from '../dist/progress.js';
import { withNextAction } from '../dist/next-action.js';
import { v2Payload } from '../dist/opencode-v2.js';

const textContent = content => typeof content === 'string' ? content : content.map(part => part.text ?? '').join('\n');

function fixtureProject(project) {
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(join(project, 'check.mjs'), `import assert from 'node:assert/strict';
import fs from 'node:fs';
assert.equal(fs.readFileSync('first.txt', 'utf8'), 'first\\n');
if (process.argv[2] !== 'first') assert.equal(fs.readFileSync('second.txt', 'utf8'), 'second\\n');
`);
}

export function privateEnvironment(root, ambient = process.env) {
  const os = Object.fromEntries(Object.entries(ambient).filter(([name]) =>
    ['path', 'pathext', 'systemroot', 'windir', 'comspec'].includes(name.toLowerCase())));
  return { ...os, HOME: root, USERPROFILE: root, APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'),
    TMP: join(root, 'temp'), TEMP: join(root, 'temp'), TMPDIR: join(root, 'temp'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG_DIR: join(root, 'config', 'opencode'), OPENCODE_CONFIG: join(root, 'project', 'opencode.json') };
}

export class ScriptedProvider {
  constructor(project, scenario) {
    this.project = project;
    this.scenario = scenario;
    this.calls = new Map();
    this.statuses = [];
  }
  respond({ agent, session, body }) {
    const count = (this.calls.get(session) ?? 0) + 1;
    this.calls.set(session, count);
    assert.ok(count <= 16, 'Bounded script exhausted; no retry-until-green loop.');
    const last = body.messages.at(-1);
    if (agent === 'mdd-orchestrator') {
      if (last.role === 'user') return { call: { name: 'mdd_start', input: { requirements: textContent(last.content) } } };
      assert.equal(last.role, 'tool', 'Coordinator must continue from a native tool result.');
      const prior = body.messages.findLast(m => m.role === 'assistant')?.tool_calls?.at(-1)?.function?.name;
      if (['mdd_start', 'subagent'].includes(prior)) return { call: { name: 'mdd_status', input: {} } };
      let status;
      try { status = JSON.parse(textContent(last.content)); } catch {
        return { call: { name: 'mdd_status', input: {} } };
      }
      this.statuses.push(status);
      const action = status.nextAction;
      assert.ok(!status.question, 'Automatic mode unexpectedly requested human approval.');
      assert.ok(!(status.state === 'blocked' && action?.tool === 'subagent'), 'blocked state offered another writer');
      if (status.state === 'complete' || ['blocked', 'await-result'].includes(status.state) || status.rejected) return { text: 'STOP' };
      if (action?.tool === 'question') throw new Error('Unexpected automatic-mode approval.');
      if (action?.tool === 'subagent') {
        assert.deepEqual(Object.keys(action.args).sort(), ['agent', 'description', 'prompt']);
        return { call: { name: action.tool, input: action.args } };
      }
      if (action?.tool === 'mdd_prepare_advance') return { call: { name: action.tool, input: { questions: [] } } };
      throw new Error(`Unexpected coordinator action: ${JSON.stringify(action)}`);
    }
    const base = { evidenceSummary: 'Scripted fixture evidence from the isolated native host.', artifact: 'Checked fixture progress and handoff.' };
    if (agent === 'mdd-plan') {
      const trace = traceFixture('first.txt', 'first');
      trace.deliverables[0].scenarios = ['S1'];
      trace.deliverables[0].check = 'node check.mjs first';
      trace.deliverables.push({ ...trace.deliverables[0], id: 'second', path: 'second.txt', scenarios: ['S2'],
        check: 'node check.mjs second', dependsOn: ['first'] });
      return { text: reportDocument({ ...base, ...trace }) };
    }
    assert.ok(['mdd-apply', 'mdd-verify'].includes(agent), `Unexpected actor ${agent}`);
    const prompt = body.messages.filter(m => m.role === 'user').map(m => textContent(m.content)).join('\n');
    const deliverables = JSON.parse(prompt.match(/^Applicable deliverables: (.*)$/m)?.[1] ?? 'null');
    assert.ok(Array.isArray(deliverables), 'Expanded native dispatch must carry the held deliverables.');
    const step = agent === 'mdd-verify' ? 'verify' : deliverables[0].id;
    assert.equal(deliverables.length, agent === 'mdd-verify' ? 2 : 1);
    if (count === 1) return { call: { name: 'smoke_work', input: { step } } };
    assert.equal(count, 2, 'Each fixture actor calls its checked workload exactly once.');
    assert.equal(last.role, 'tool');
    const check = JSON.parse(textContent(last.content));
    assert.equal(check.exit, 0, last.content);
    if (agent === 'mdd-apply') return { text: reportDocument({ ...base, checks: [check], changes: [`${step}.txt`],
      ...(this.scenario === 'failed' ? { outcome: 'failed' } : { completed: [this.scenario === 'ambiguous' ? 'unknown' : step] }),
      delivered: { what: 'Fixture progress is preserved.', implies: 'The dependent actor can read the prior file.' } }) };
    const assessment = { status: 'verified', checks: [check.command], assessment: 'Actual fixture command confirmed both files and their dependency.' };
    return { text: reportDocument({ ...base, checks: [check], verification: {
      scenarios: ['first', 'second'].map((stepID, i) => ({ requirementID: 'R1', scenarioID: `S${i + 1}`, stepID, ...assessment })),
      steps: ['first', 'second'].map(stepID => ({ stepID, ...assessment })), decisions: [{ decisionID: 'D1', ...assessment }],
      changes: 'Both fixture deliverables are present.', limits: ['Scripted local provider; no external model evaluation.'],
    } }) };
  }
}

export function checkHostEvidence(events, statuses, parent, scenario) {
  const children = events.filter(e => e.kind === 'child');
  assert.deepEqual(children.map(e => e.agent), scenario === 'success'
    ? ['mdd-plan', 'mdd-apply', 'mdd-apply', 'mdd-verify'] : ['mdd-plan', 'mdd-apply']);
  assert.equal(new Set(children.map(e => e.sessionID)).size, children.length, 'Every native actor must be fresh.');
  assert.ok(children.every(e => e.parentID === parent && e.completed), 'Native parent and completed child identities must be observed.');
  assert.ok(statuses.every(s => !s.question), 'No intermediate human approval in automatic mode.');
  if (scenario === 'success') {
    assert.equal(statuses.at(-1).state, 'complete');
    assert.ok(statuses.some(s => s.state === 'ready' && s.phase === 'mdd-apply'));
    assert.ok(statuses.some(s => s.state === 'ready' && s.phase === 'mdd-verify'));
  } else {
    assert.equal(statuses.at(-1).task, undefined, 'Failed/ambiguous batch must not expose a second writer.');
    assert.ok(statuses.at(-1).state === 'blocked' || statuses.at(-1).rejected);
  }
}

// Deterministic transport seam: real motor/checkpoints/files/commands, simulated host inspection
// and child identities. This remains useful when safe native-host admission is unavailable.
export async function runDeterministicSmoke(root, scenario) {
  fixtureProject(root);
  const runtime = { sessionID: 'ses_scripted_fixture', agent: 'mdd-orchestrator', directory: root, worktree: root };
  const checkpoint = new CheckpointStore(root);
  const runner = new PhaseRunner({ parent: async () => {}, result: async (_runtime, _call, _phase, output) => output,
    stopped: async () => true }, { checkpoint, progress: new ProgressGuard(root) });
  await runner.start({ preflight: { answers: { certainty: 'very-sure', artifactStore: 'openspec', mode: 'automatic', summary: 'low' } },
    requirements: 'Implement two dependent checked fixture deliverables.' }, runtime,
  { requirementsConfirmed: true, userMessageID: 'scripted-user' });
  const provider = new ScriptedProvider(root, scenario);
  const events = []; const statuses = [];
  for (let ordinal = 0; ordinal < 5; ordinal++) {
    const status = JSON.parse(v2Payload(JSON.stringify(withNextAction(runner.status(runtime.sessionID)))));
    statuses.push(status);
    const next = provider.respond({ agent: runtime.agent, session: runtime.sessionID,
      body: { messages: [{ role: 'tool', content: JSON.stringify(status) }] } });
    if (next.text === 'STOP') break;
    assert.equal(next.call.name, 'subagent');
    const { agent, description, prompt } = next.call.input;
    const call = { sessionID: runtime.sessionID, callID: `scripted-call-${ordinal}` };
    const args = await runner.before(call, { subagent_type: agent, description, prompt });
    const session = `scripted-child-${ordinal}`;
    const body = { messages: [{ role: 'user', content: args.prompt }] };
    let report = provider.respond({ agent, session, body });
    if (report.call) {
      assert.equal(report.call.name, 'smoke_work');
      const { step } = report.call.input;
      if (step === 'second') assert.equal(fs.readFileSync(join(root, 'first.txt'), 'utf8'), 'first\n');
      if (step !== 'verify') fs.writeFileSync(join(root, `${step}.txt`), `${step}\n`);
      const checked = spawnSync(process.execPath, [join(root, 'check.mjs'), step], { cwd: root,
        env: privateEnvironment(root), encoding: 'utf8', timeout: 5000 });
      assert.equal(checked.status, 0, checked.stderr);
      body.messages.push({ role: 'tool', content: JSON.stringify({ command: `node check.mjs ${step}`, exit: checked.status }) });
      report = provider.respond({ agent, session, body });
    }
    events.push({ kind: 'child', sessionID: session, parentID: runtime.sessionID, agent, completed: true });
    try { await runner.after(call, args, report.text); }
    catch (error) { assert.equal(scenario, 'ambiguous'); assert.match(error.message, /could not read/); }
  }
  checkHostEvidence(events, statuses, runtime.sessionID, scenario);
  assert.deepEqual(checkpoint.read(runtime.sessionID).workflow.applyProgress().completed, scenario === 'success' ? ['first', 'second'] : []);
  assert.equal(fs.existsSync(join(root, 'second.txt')), scenario === 'success');
  return { scenario, status: 'passed', proof: 'deterministic-transport-double/real-motor-files-and-commands' };
}

// This plugin adds only a fixture workload and evidence hooks. MDD's motor and native subagent
// implementations are never replaced. The workload runs real Node checks over private files.
export function fixturePluginSource(project, evidence, endpoint) {
  return `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Model, Provider } from ${JSON.stringify(import.meta.resolve('@opencode/plugin'))};
import { CheckpointStore } from ${JSON.stringify(pathToFileURL(resolve('dist/checkpoint.js')).href)};
export default { id: 'mdd.batch-smoke', async setup(ctx) {
  const log = value => fs.appendFileSync(${JSON.stringify(evidence)}, JSON.stringify(value) + '\\n');
  await ctx.provider.transform(editor => {
    for (const entry of editor.list()) editor.remove(entry.provider.id);
    const id = Provider.ID.make('smoke');
    editor.add({ info: { ...Provider.Info.empty(id), name: 'Private scripted fixture', activation: 'enabled',
      package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: ${JSON.stringify(endpoint + '/v1')} } },
      models: [{ ...Model.Info.default(id, Model.ID.make('fixture')), capabilities: { tools: true, input: ['text'], output: ['text'] } }] });
  });
  await ctx.session.hook('http.request', event => {
    if (!event.request.url.startsWith(${JSON.stringify(endpoint + '/')})) throw new Error('Non-fixture provider request denied.');
    event.request.headers.set('x-smoke-agent', event.agent ?? 'auxiliary');
    event.request.headers.set('x-smoke-session', event.sessionID);
    event.request.headers.set('x-smoke-kind', event.kind);
  });
  await ctx.session.hook('title', event => { event.result = 'Isolated batch fixture'; });
  await ctx.session.hook('retry', event => { event.decision = { retry: false }; });
  const written = new Set();
  await ctx.tool.transform(editor => editor.add({ name: 'smoke_work', description: 'Run the isolated checked fixture workload once.',
    input: { type: 'object', properties: { step: { type: 'string', enum: ['first', 'second', 'verify'] } }, required: ['step'], additionalProperties: false },
    options: { codemode: false }, async execute({ step }, context) {
      if (context.agent !== (step === 'verify' ? 'mdd-verify' : 'mdd-apply')) throw new Error('Fixture actor mismatch.');
      if (written.has(step)) throw new Error('Duplicate fixture writer.');
      written.add(step);
      const project = ${JSON.stringify(project)};
      if (step === 'second' && fs.readFileSync(project + '/first.txt', 'utf8') !== 'first\\n') throw new Error('Missing filesystem handoff.');
      if (step !== 'verify') fs.writeFileSync(project + '/' + step + '.txt', step + '\\n');
      const checked = spawnSync(${JSON.stringify(process.execPath)}, [project + '/check.mjs', step], { cwd: project, env: ${JSON.stringify(privateEnvironment(dirname(project)))}, encoding: 'utf8', timeout: 5000 });
      if (checked.status !== 0) throw new Error('Fixture check failed: ' + checked.stderr);
      log({ kind: 'work', step, sessionID: context.sessionID, exit: checked.status });
      return { content: JSON.stringify({ command: 'node check.mjs ' + step, exit: checked.status }) };
    } }));
  await ctx.tool.hook('execute.after', async event => {
    if (event.tool === 'mdd_status' && event.status === 'completed') {
      const content = event.result.content;
      log({ kind: 'status', value: JSON.parse(typeof content === 'string' ? content : content.map(part => part.text).join('\\n')) });
    }
    if (event.tool === 'subagent' && event.status === 'completed') {
      const result = event.result.output;
      const child = await ctx.session.get({ sessionID: result.sessionID });
      log({ kind: 'child', sessionID: child.id, parentID: child.parentID, agent: child.agent, completed: result.status === 'completed' });
    }
  });
  await ctx.tool.hook('execute.before', event => {
    if (event.tool !== 'subagent') return;
    const saved = new CheckpointStore(${JSON.stringify(project)}).read(event.sessionID);
    log({ kind: 'dispatch', args: event.input, completed: saved.workflow.applyProgress()?.completed ?? [] });
  });
} };
`;
}

export function ancestorConfig(root) {
  for (let directory = dirname(root);; directory = dirname(directory)) {
    for (const name of ['opencode.json', 'opencode.jsonc', '.opencode', 'AGENTS.md']) {
      if (fs.existsSync(join(directory, name))) return join(directory, name);
    }
    if (dirname(directory) === directory) return undefined;
  }
}

export async function scenarioSmoke(binary, root, scenario, {
  createProvider = createServer, writeSetup = fs.writeFileSync, startHost = spawn,
  stopHost = async host => {
    const exited = once(host, 'exit');
    host.kill();
    await Promise.race([exited, delay(10000).then(() => { throw new Error('Private host did not exit.'); })]);
  },
} = {}) {
  const env = privateEnvironment(root);
  const project = join(root, 'project');
  const config = env.OPENCODE_CONFIG_DIR;
  for (const directory of [project, join(config, 'mdd'), join(config, 'plugins'), env.TEMP, env.APPDATA, env.LOCALAPPDATA]) fs.mkdirSync(directory, { recursive: true });
  for (const name of ['agents', 'skills']) fs.cpSync(`assets/opencode/${name}`, join(config, name), { recursive: true });
  const settings = defaultSettings();
  settings.profiles.default.answers = { certainty: 'very-sure', artifactStore: 'openspec', mode: 'automatic', summary: 'low' };
  settings.profiles.default.models = Object.fromEntries(['orchestrator', 'mdd-plan', 'mdd-apply', 'mdd-verify'].map(role => [role, 'smoke/fixture']));
  fs.writeFileSync(join(config, 'mdd', 'mdd.config.json'), JSON.stringify(settings));
  fixtureProject(project);
  const script = new ScriptedProvider(project, scenario);
  let providerError;
  const provider = createProvider(async (req, res) => {
    try {
      if (req.method === 'GET') { res.writeHead(404); res.end(); return; }
      assert.equal(req.url, '/v1/chat/completions');
      let text = '';
      for await (const chunk of req) { text += chunk; assert.ok(text.length < 1024 * 1024); }
      assert.equal(req.headers['x-smoke-kind'], 'primary', 'No auxiliary model calls allowed.');
      const answer = script.respond({ agent: req.headers['x-smoke-agent'], session: req.headers['x-smoke-session'], body: JSON.parse(text) });
      const delta = answer.call ? { tool_calls: [{ index: 0, id: `fixture-${script.calls.size}-${script.calls.get(req.headers['x-smoke-session'])}`,
        type: 'function', function: { name: answer.call.name, arguments: JSON.stringify(answer.call.input) } }] } : { content: answer.text };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [part, finish] of [[{ role: 'assistant', ...delta }, null], [{}, answer.call ? 'tool_calls' : 'stop']]) {
        res.write('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture',
          choices: [{ index: 0, delta: part, finish_reason: finish }] }) + '\n\n');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { providerError = error; res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } })); }
  });
  let host;
  let stdout = ''; let stderr = '';
  try {
    await new Promise((resolve, reject) => {
      provider.once('error', reject);
      provider.listen(0, '127.0.0.1', () => { provider.off('error', reject); resolve(); });
    });
    const endpoint = `http://127.0.0.1:${provider.address().port}`;
    const evidence = join(root, 'evidence.jsonl');
    writeSetup(join(config, 'plugins', 'a-smoke.ts'), fixturePluginSource(project, evidence, endpoint));
    writeSetup(join(config, 'plugins', 'mdd.ts'), `export { default } from ${JSON.stringify(pathToFileURL(resolve('dist/opencode-plugin.js')).href)};\n`);
    // Redirect built-in local discovery to OUR provider, never probe a user's local model service.
    const discovery = Object.fromEntries(['ollama', 'lmstudio', 'vllm'].map(id => [id, { settings: { baseURL: endpoint + '/v1' } }]));
    writeSetup(join(project, 'opencode.json'), JSON.stringify({ model: 'smoke/fixture', snapshots: false, providers: discovery,
      permissions: [{ action: '*', resource: '*', effect: 'deny' },
        ...['mdd_*', 'subagent', 'smoke_work'].map(action => ({ action, resource: '*', effect: 'allow' }))] }));
    writeSetup(join(config, 'opencode.json'), JSON.stringify({ update: 'disable' }));
    host = startHost(binary, ['serve', '--service', '--port', '0'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    host.stdout.on('data', data => { stdout = (stdout + data).slice(-8000); });
    host.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
    const deadline = Date.now() + 60000;
    const registrationPath = join(root, 'state', 'opencode', 'service.json');
    while (!fs.existsSync(registrationPath) && Date.now() < deadline && host.exitCode === null) await delay(100);
    assert.ok(fs.existsSync(registrationPath), `Private host did not register: ${stdout} ${stderr}`);
    const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
    const origin = new URL(registration.url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));
    const headers = { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}`, 'content-type': 'application/json' };
    const api = async (path, body) => {
      const response = await fetch(`${origin.origin}${path}`, { method: body ? 'POST' : 'GET', headers,
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      assert.ok(response.ok, await response.clone().text());
      return response.json();
    };
    const { data: parent } = await api('/api/session', { title: `Batch ${scenario}`, agent: 'mdd-orchestrator',
      model: { providerID: 'smoke', id: 'fixture' }, location: { directory: project } });
    await api(`/api/session/${parent.id}/prompt`, { text: 'Implement two dependent checked fixture deliverables.' });
    let events = []; let statuses = [];
    while (Date.now() < deadline && host.exitCode === null) {
      if (providerError) throw providerError;
      events = fs.existsSync(evidence) ? fs.readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      statuses = events.filter(e => e.kind === 'status').map(e => e.value);
      const final = statuses.at(-1);
      if (final && (final.state === 'complete' || final.state === 'blocked' || final.rejected)) break;
      await delay(100);
    }
    assert.ok(statuses.length, `Native execution produced no status evidence: ${stdout} ${stderr}`);
    // Wait for the parent to settle once; no continuation prompt, permission reply or second writer.
    await api(`/api/experimental/session/${parent.id}/wait`, {});
    events = fs.readFileSync(evidence, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    statuses = events.filter(e => e.kind === 'status').map(e => e.value);
    checkHostEvidence(events, statuses, parent.id, scenario);
    const saved = new CheckpointStore(project).read(parent.id);
    assert.deepEqual(saved.workflow.applyProgress().completed, scenario === 'success' ? ['first', 'second'] : []);
    assert.notEqual(saved.checkpoint.attempt?.state, 'pending');
    const dispatches = events.filter(e => e.kind === 'dispatch');
    assert.equal(dispatches.length, scenario === 'success' ? 4 : 2);
    assert.deepEqual(dispatches.map(e => e.completed), scenario === 'success' ? [[], [], ['first'], ['first', 'second']] : [[], []]);
    assert.deepEqual(dispatches.map(e => e.args), statuses.filter(s => s.nextAction?.tool === 'subagent').map(s => s.nextAction.args),
      'Dispatch only the exact returned action after confirmed prior completion.');
    assert.equal(fs.readFileSync(join(project, 'first.txt'), 'utf8'), 'first\n');
    assert.equal(fs.existsSync(join(project, 'second.txt')), scenario === 'success');
    const work = events.filter(e => e.kind === 'work');
    assert.deepEqual(work.map(e => e.step), scenario === 'success' ? ['first', 'second', 'verify'] : ['first']);
    return { scenario, status: 'passed', proof: 'actual-native-host/scripted-local-provider', children: events.filter(e => e.kind === 'child').length };
  } finally {
    try {
      if (host && host.exitCode === null) await stopHost(host);
    } finally {
      provider.closeAllConnections();
      await new Promise(resolve => provider.close(resolve));
    }
  }
}

export async function runSmoke() {
  const binary = opencodeBinary();
  const temp = process.platform === 'win32' ? join(homedir(), 'AppData', 'Local', 'Temp', 'opencode') : tmpdir();
  assert.ok(fs.existsSync(temp), 'Approved temporary parent must exist.');
  const root = fs.mkdtempSync(join(temp, 'mdd-batch-host-'));
  try {
    const deterministic = [];
    for (const scenario of ['success', 'failed', 'ambiguous']) deterministic.push(await runDeterministicSmoke(join(root, `double-${scenario}`), scenario));
    const unavailable = reason => ({ status: 'unavailable', reason, deterministic, externalModel: 'not-run' });
    if (!binary) return unavailable('No native OpenCode executable on PATH.');
    const ambient = ancestorConfig(root);
    if (ambient) return unavailable(`Ancestor configuration would defeat isolation: ${ambient}`);
    const version = spawnSync(binary, ['--version'], { env: privateEnvironment(root), encoding: 'utf8', timeout: 10000 });
    if (version.status !== 0 || !/v?2\.0\.22\b/.test(version.stdout)) return unavailable('Harness requires installed OpenCode V2 2.0.22; no installs attempted.');
    const scenarios = [];
    for (const scenario of ['success', 'failed', 'ambiguous']) scenarios.push(await scenarioSmoke(binary, join(root, scenario), scenario));
    return { status: 'passed', version: version.stdout.trim(), scenarios, deterministic, externalModel: 'not-run' };
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { console.log(JSON.stringify(await runSmoke(), null, 2)); }
  catch (error) { console.error(`Apply batch host smoke FAILED: ${error.stack}`); process.exitCode = 1; }
}
