// Default: pinned native-boundary probe only. --exploration-workers proves production overlap.
// Test-owned loopback provider, isolated HOME, no external model or user credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { opencodeBinary } from '../dist/model-catalog.js';
import { defaultSettings } from '../dist/settings.js';
import { reportDocument } from './adapter-fixture.mjs';

const formatterBoundary = process.argv.includes('--formatter-boundary');
const explorationWorkers = process.argv.includes('--exploration-workers');
const nativeCase = process.argv.find(arg => arg.startsWith('--native-case='))?.split('=')[1];
assert.ok(process.argv.slice(2).every(arg => ['--formatter-boundary', '--exploration-workers'].includes(arg) || arg.startsWith('--native-case=')), 'Unknown probe argument.');
if (explorationWorkers && !nativeCase) {
  for (const scenario of ['main', 'contextual', 'delayed', 'dropped', 'conflicting', 'external-denied', 'disabled']) {
    const result = spawnSync(process.execPath, [process.argv[1], '--exploration-workers', `--native-case=${scenario}`],
      { stdio: 'inherit', timeout: 180000 });
    assert.ifError(result.error); assert.equal(result.status, 0, `Native ${scenario} proof failed.`);
  }
  console.log('Production native exploration scenarios passed. Apply concurrency is not enabled.');
  process.exit(0);
}
const binary = opencodeBinary();
assert.ok(binary, 'Pinned native executable is required.');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.ifError(version.error);
assert.match(version.stdout, /v?2\.0\.22\b/);
// The approved per-user temp directory inherits ~/.opencode on this machine.
// Use a test-owned system-temp child only where ancestor discovery is clean.
const base = process.platform === 'win32' ? join(process.env.SystemRoot, 'Temp') : tmpdir();
const root = fs.mkdtempSync(join(base, 'mdd-workers-contract-'));
const project = join(root, 'project');
const reference = join(root, 'reference-repository');
const config = join(root, 'config', 'opencode');
const evidence = join(root, 'evidence.jsonl');
const formattedFile = join(project, 'target.mdd-fixture');
const formatterScript = join(root, 'formatter-fixture.cjs');
const formatterMarker = join(root, 'formatter-executed.json');
const secret = randomUUID();
const stages = new Map();
const requests = [];
let host; let hostEnv; let stdout = ''; let stderr = '';
let fixtureError;
const live = new Map();
let releaseBoth, releaseFirst, releaseProgress;
const bothLive = new Promise(resolve => { releaseBoth = resolve; });
const secondSettled = new Promise(resolve => { releaseFirst = resolve; });
const childRequested = new Promise(resolve => { releaseProgress = resolve; });
const independentItems = ['a', 'b'].map((name, index) => ({ id: `E${index + 1}`, purpose: `Inspect ${name} independently`,
  dependsOn: [], independent: true, complete: true, reads: [{ root: index ? reference : project, files: [`${name}.txt`] }] }));
const scopedFile = item => join(item === 'a' ? project : reference, `${item}.txt`);
const provider = http.createServer(async (req, res) => {
  try {
    if (req.url === '/fixture/requested') {
      await childRequested; res.writeHead(204).end(); return;
    }
    if (req.url === '/fixture/settled') {
      releaseFirst(); res.writeHead(204).end(); return;
    }
    if (!req.url.startsWith('/v1/')) { res.writeHead(404).end(); return; }
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const session = req.headers['x-fixture-session'];
    assert.equal(typeof session, 'string');
    const step = stages.get(session) ?? 0;
    stages.set(session, step + 1);
    requests.push({ session, step, input });
    const role = req.headers['x-fixture-agent'];
    let calls; let text = 'Boundary probe complete.';
    if (explorationWorkers && role === 'mdd-orchestrator' && step === 0) {
      calls = nativeCase === 'contextual' ? [{ name: 'mdd_contextual_explore', arguments: { purpose: 'Inspect both independently', workItems: independentItems } }]
        : [{ name: 'mdd_start', arguments: { requirements: 'Explore both independent components.', exploration: { workItems: independentItems } } }];
    } else if (explorationWorkers && role === 'mdd-orchestrator' && step === 2) {
      const output = input.messages.filter(message => message.role === 'tool').at(-1)?.content;
      const ready = JSON.parse(typeof output === 'string' ? output : output.map(part => part.text).join(''));
      if (nativeCase === 'disabled') {
        assert.equal(ready.tasks, undefined); assert.equal(ready.task.agent, 'mdd-explore');
        calls = [{ name: 'subagent', arguments: ready.task }];
      } else {
        assert.equal(ready.tasks?.length, 2, JSON.stringify(ready));
        calls = ready.tasks.map(task => ({ name: 'subagent', arguments: task }));
      }
    } else if (explorationWorkers && role === 'mdd-explore') {
      const authored = JSON.stringify(input.messages);
      const item = authored.includes('Inspect a independently') ? 'a' : 'b';
      if (step === 0) {
        live.set(item, session); releaseProgress();
        if (live.size === 2 || nativeCase === 'disabled') releaseBoth();
        await bothLive;
        // The second member settles before the first even starts its own read. Both native
        // children and exact admitted calls are live together at this deterministic barrier.
        if (item === 'a' && nativeCase !== 'disabled') await secondSettled;
        calls = [{ name: 'read', arguments: { path: scopedFile(item) } }];
      } else if (nativeCase !== 'disabled' && step <= 9) {
        const hostile = [
          { name: 'read', arguments: { path: scopedFile(item === 'a' ? 'b' : 'a') } },
          { name: 'write', arguments: { path: formattedFile, content: 'unsafe' } },
          { name: 'edit', arguments: { path: formattedFile, oldString: 'before', newString: 'unsafe' } },
          { name: 'patch', arguments: { patchText: `*** Begin Patch\n*** Update File: ${formattedFile}\n@@\n-before\n+unsafe\n*** End Patch` } },
          { name: 'shell', arguments: { command: 'echo TEST_OWNED_FORBIDDEN_SHELL' } },
          { name: 'subagent', arguments: { agent: 'mdd-explore', description: 'Forbidden recursion', prompt: 'Read a' } },
          { name: 'uncontrolled', arguments: {} },
          { name: 'opencode_session_list', arguments: {} },
          { name: 'execute', arguments: { code: 'return 1' } },
        ];
        calls = [hostile[step - 1]];
      } else text = reportDocument({ outcome: ['dropped', 'conflicting'].includes(nativeCase) || nativeCase === 'external-denied' && item === 'b' ? 'failed' : 'passed',
        evidenceSummary: `Inspected ${item} component`, artifact: `Read-only findings for ${item} component.` });
    } else if (role === 'mdd-orchestrator' && step === 0) {
      calls = [{ name: 'mdd_start', arguments: { requirements: 'Implement the contract probe.' } }];
    } else if (role === 'mdd-orchestrator' && step === 1) {
      calls = [{ name: 'mdd_status', arguments: {} }];
    } else if (role === 'mdd-orchestrator' && step === 2) {
      const output = input.messages.filter(message => message.role === 'tool').at(-1)?.content;
      const ready = JSON.parse(typeof output === 'string' ? output : output.map(part => part.text).join(''));
      assert.equal(ready.task?.agent, 'mdd-plan', JSON.stringify(input.messages.filter(message => message.role === 'tool')));
      calls = [{ name: 'subagent', arguments: ready.task }];
    } else if (role === 'mdd-plan' && step === 0) {
      calls = [{ name: 'read', arguments: { path: join(project, 'denied.txt') } }];
    } else if (formatterBoundary && role === 'mdd-plan' && step === 1) {
      // Deliberately hostile fixture output, confined to test-owned paths only.
      calls = [{ name: 'edit', arguments: { path: formattedFile, oldString: 'before', newString: 'after' } }];
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const delta = calls ? { tool_calls: calls.map((call, index) => ({ index, id: `fixture-${role}-${step}-${index}`,
      type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : { content: text };
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'boundary',
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', model: 'boundary',
      choices: [{ index: 0, delta: {}, finish_reason: calls ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } catch (error) { fixtureError = error; res.writeHead(500).end('Fixture refused unexpected request.'); }
});

try {
  fs.mkdirSync(project);
  fs.mkdirSync(reference);
  // Prevent discovery of unrelated ancestor configuration and plugins.
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    for (const file of ['opencode.json', 'opencode.jsonc', '.opencode'])
      assert.equal(fs.existsSync(join(ancestor, file)), false, `Unisolated ancestor: ${ancestor}/${file}`);
    if (dirname(ancestor) === ancestor) break;
  }
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  fs.mkdirSync(join(config, 'plugins'), { recursive: true });
  fs.mkdirSync(join(config, 'mdd'));
  fs.cpSync('assets/opencode/agents', join(config, 'agents'), { recursive: true });
  const settings = defaultSettings();
  settings.profiles.default.answers = { certainty: 'very-sure', artifactStore: 'none', mode: 'automatic', summary: 'low' };
  if (explorationWorkers) settings.profiles.default.answers.certainty = 'not-sure';
  if (nativeCase === 'disabled') settings.workers.enabled = false;
  for (const agent of ['orchestrator', 'mdd-plan', 'mdd-explore']) settings.profiles.default.models[agent] = 'fixture/boundary';
  fs.writeFileSync(join(config, 'mdd', 'mdd.config.json'), JSON.stringify(settings));
  fs.writeFileSync(join(project, 'denied.txt'), 'TEST_OWNED_DENIED_READ_SENTINEL');
  fs.writeFileSync(formattedFile, 'before\n');
  for (const name of ['a', 'b']) fs.writeFileSync(scopedFile(name), `OWN_${name.toUpperCase()}_READ_SENTINEL`);
  fs.writeFileSync(formatterScript, `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(formatterMarker)}, JSON.stringify({file:process.argv[2]}));\n`);
  fs.writeFileSync(join(config, 'opencode.json'), JSON.stringify({ update: 'disable' }));
  fs.writeFileSync(join(project, 'opencode.json'), JSON.stringify({
    model: 'fixture/boundary', default_agent: 'mdd-orchestrator', lsp: false, snapshots: false,
    formatter: formatterBoundary ? { fixture: { command: [process.execPath, formatterScript, '$FILE'], extensions: ['.mdd-fixture'] } } : false,
    permissions: [{ action: '*', resource: '*', effect: 'allow' },
      ...(nativeCase === 'external-denied' ? [{ action: 'external_directory', resource: '*', effect: 'deny' }] : [])],
    providers: {
      fixture: { env: ['MDD_FIXTURE_KEY'], package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `${origin}/v1` }, models: { boundary: { capabilities: { tools: true }, limit: { context: 128000, output: 4096 } } } },
      // Automatic local runtime discovery must never access an existing user service.
      ollama: { settings: { baseURL: `${origin}/disabled/ollama/v1` } },
      lmstudio: { settings: { baseURL: `${origin}/disabled/lmstudio/v1` } },
      vllm: { settings: { baseURL: `${origin}/disabled/vllm/v1` } },
    },
  }));
  fs.writeFileSync(join(config, 'plugins', 'mdd.ts'), explorationWorkers ?
    `import production from ${JSON.stringify(pathToFileURL(resolve('dist/opencode-plugin.js')).href)};
export default { id: production.id, setup(ctx) {
  const events = ctx.event;
  return production.setup({ ...ctx, event: { ...events, async *subscribe(options) {
    for await (const event of events.subscribe(options)) {
      if (event.type === 'session.tool.progress' && event.data.metadata?.status === 'running') {
        if (${JSON.stringify(nativeCase)} === 'dropped') continue;
        if (${JSON.stringify(nativeCase)} === 'delayed') {
          await fetch(${JSON.stringify(origin + '/fixture/requested')});
        }
        if (${JSON.stringify(nativeCase)} === 'conflicting') {
          yield event;
          yield { ...event, data: { ...event.data, metadata: { ...event.data.metadata, sessionID: 'unrelated-child' } } };
          continue;
        }
      }
      yield event;
    }
  } } });
} };\n` : `export { default } from ${JSON.stringify(pathToFileURL(resolve('dist/opencode-plugin.js')).href)};\n`);
  fs.writeFileSync(join(config, 'plugins', 'probe.ts'), `import fs from 'node:fs';
export default { id: 'mdd.worker-boundary-probe', async setup(ctx) {
  const record = item => fs.appendFileSync(${JSON.stringify(evidence)}, JSON.stringify(item) + '\\n');
  const controller = new AbortController();
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === 'session.tool.progress') record({ boundary: 'progress', data: event.data });
      if (${explorationWorkers} && ['session.tool.success', 'session.tool.failed'].includes(event.type)) {
        record({ boundary: 'durable-native-outcome', type: event.type, data: event.data });
        if (event.data.id === 'fixture-mdd-orchestrator-2-1') await fetch(${JSON.stringify(origin + '/fixture/settled')}, { method: 'POST' });
      }
    }
  })();
  await ctx.shell.hook('create.before', () => {
    record({ boundary: 'shell-refused' });
    throw new Error('TEST_BOUNDARY_ALL_SHELL_DENIED');
  });
  if (${explorationWorkers}) await ctx.tool.transform(editor => editor.add({ name: 'uncontrolled', description: 'Test-owned hostile custom tool',
    input: { type: 'object', properties: {}, additionalProperties: false }, options: { codemode: false },
    execute: async () => { record({ boundary: 'CUSTOM_EXECUTED' }); return { content: 'unsafe' }; } }));
  await ctx.provider.transform(editor => {
    for (const { provider } of editor.list()) if (provider.id !== 'fixture') editor.remove(provider.id);
  });
  await ctx.session.hook('title', event => { event.result = 'Worker boundary probe'; });
  await ctx.session.hook('http.request', event => {
    if (!event.request.url.startsWith(${JSON.stringify(origin + '/v1/')})) throw new Error('Non-fixture model refused.');
    event.request.headers.set('x-fixture-session', event.sessionID);
    event.request.headers.set('x-fixture-agent', event.agent);
  });
  await ctx.tool.hook('execute.before', async event => {
    if (event.tool !== 'read') return;
    const child = await ctx.session.get({ sessionID: event.sessionID });
    const parent = child.parentID ? await ctx.session.context({ sessionID: child.parentID }) : [];
    const messages = await ctx.session.context({ sessionID: child.id });
    record({ boundary: 'before-read', sessionID: child.id, parentID: child.parentID, childMetadata: child.metadata,
      childRecords: messages.map(({ text, content, ...header }) => header),
      calls: parent.filter(message => message.type === 'assistant').flatMap(message =>
        message.content.filter(part => part.type === 'tool' && part.name === 'subagent')) });
    if (!${explorationWorkers}) throw new Error('TEST_BOUNDARY_READ_DENIED');
  });
  await ctx.tool.hook('execute.after', async event => {
    if (event.tool === 'read') record({ boundary: 'after-read', status: event.status,
      ...(event.status === 'completed' ? { result: event.result } : { error: event.error }) });
    if (event.tool === 'edit') record({ boundary: 'after-edit', status: event.status });
    if (${explorationWorkers}) record({ boundary: 'native-outcome', tool: event.tool, sessionID: event.sessionID,
      status: event.status, input: event.input, ...(event.status === 'completed' ? { result: event.result } : { error: event.error }) });
    if (${explorationWorkers} && event.tool === 'subagent') {
      const childID = event.status === 'completed' ? event.result.output?.sessionID : undefined;
      const child = childID ? await ctx.session.context({ sessionID: childID }) : [];
      if (JSON.stringify(child).includes('Inspect b independently') || ${JSON.stringify(nativeCase)} === 'disabled')
        await fetch(${JSON.stringify(origin + '/fixture/settled')}, { method: 'POST' });
    }
  });
  return async () => { controller.abort(); await events; };
} };\n`);
  const osEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp'].includes(name.toLowerCase())));
  hostEnv = { ...osEnv, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
    OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: join(project, 'opencode.json'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true', MDD_FIXTURE_KEY: secret };
  host = spawn(binary, ['serve', '--service', '--port', '0'], { cwd: project, env: hostEnv });
  host.stdout.on('data', data => { stdout += data; });
  host.stderr.on('data', data => { stderr += data; });
  const deadline = Date.now() + 90000;
  const registrationPath = join(root, 'state', 'opencode', 'service.json');
  while (!fs.existsSync(registrationPath) && Date.now() < deadline && host.exitCode === null) await delay(100);
  assert.ok(fs.existsSync(registrationPath), `Private host failed: ${stdout} ${stderr}`);
  const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  assert.equal(new URL(registration.url).hostname, '127.0.0.1');
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}`, 'Content-Type': 'application/json' };
  const api = async (path, body) => {
    const response = await fetch(`${registration.url}${path}`, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
    assert.ok(response.ok, await response.clone().text());
    return response.status === 204 ? undefined : response.json();
  };
  let agents; let plugins;
  do {
    ({ data: agents } = await api(`/api/agent?location[directory]=${encodeURIComponent(project)}`));
    ({ data: plugins } = await api(`/api/plugin?location[directory]=${encodeURIComponent(project)}`));
    if (agents.find(agent => agent.id === 'mdd-orchestrator') && plugins.find(plugin => plugin.id === 'mdd.worker-boundary-probe')?.state.status === 'active') break;
    await delay(100);
  } while (Date.now() < deadline);
  assert.ok(agents.find(agent => agent.id === 'mdd-orchestrator'), JSON.stringify(plugins));
  assert.equal(plugins.find(plugin => plugin.id === 'mdd')?.state.status, 'active');
  const { data: session } = await api('/api/session', { location: { directory: project }, title: 'Contract probe' });
  await api(`/api/session/${session.id}/agent`, { agent: 'mdd-orchestrator' });
  await api(`/api/session/${session.id}/prompt`, { text: explorationWorkers ? 'Explore both independent components.' : 'Implement the contract probe.' });
  // Poll only host lifecycle evidence; worker scheduling must use barriers, not time delays.
  let records = [];
  while (Date.now() < deadline && !fixtureError) {
    if (fs.existsSync(evidence)) records = fs.readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    if (explorationWorkers) {
      const settled = records.filter(item => item.boundary === 'durable-native-outcome' && item.data.sessionID === session.id &&
        item.data.id.startsWith('fixture-mdd-orchestrator-2-'));
      if (settled.length === (nativeCase === 'disabled' ? 1 : 2)) break;
      await delay(100); continue;
    }
    const child = records.find(item => item.boundary === 'before-read');
    const progress = records.find(item => item.boundary === 'progress' && item.data.metadata?.sessionID === child?.sessionID);
    const editDone = !formatterBoundary || records.some(item => item.boundary === 'after-edit');
    if (child && progress && editDone && stages.get(child.sessionID) >= (formatterBoundary ? 3 : 2)) break;
    await delay(100);
  }
  assert.ifError(fixtureError);
  if (explorationWorkers) {
    const settled = records.filter(item => item.boundary === 'durable-native-outcome' && item.data.sessionID === session.id &&
      item.data.id.startsWith('fixture-mdd-orchestrator-2-'));
    assert.equal(settled.length, nativeCase === 'disabled' ? 1 : 2,
      `Native batch did not settle: ${JSON.stringify({ requests: requests.map(({session,step}) => ({session,step})),
        errors: records.filter(item => item.type === 'session.tool.failed').map(item => item.data.error) })} ${stdout} ${stderr}`);
    assert.equal(live.size, nativeCase === 'disabled' ? 1 : 2);
    assert.ok(records.every(item => item.boundary !== 'CUSTOM_EXECUTED' && item.boundary !== 'shell-refused'));
    assert.equal(fs.readFileSync(formattedFile, 'utf8'), 'before\n');
    const histories = await Promise.all([...live.values()].map(async id => ({ id, data: (await api(`/api/session/${id}/context`)).data })));
    const toolParts = histories.flatMap(({ id, data }) => data.filter(message => message.type === 'assistant').flatMap(message =>
      message.content.filter(part => part.type === 'tool').map(part => ({ sessionID: id, tool: part.name, status: part.state.status,
        input: part.state.input, error: part.state.error, result: part.state.content }))));
    const reads = toolParts.filter(item => item.tool === 'read');
    if (nativeCase === 'disabled') assert.equal(reads[0].status, 'completed');
    else {
      assert.equal(reads.length, 4);
      const ownReads = reads.filter(item => basenameFixture(item.input.path) === `${[...live].find(([, id]) => id === item.sessionID)?.[0]}.txt`);
      assert.equal(ownReads.length, 2);
      assert.ok(ownReads.every(item => item.status === (['dropped', 'conflicting'].includes(nativeCase) ||
        nativeCase === 'external-denied' && item.sessionID === live.get('b') ? 'error' : 'completed')));
      assert.ok(reads.filter(item => !ownReads.includes(item)).every(item => item.status === 'error'));
      const denied = toolParts.filter(item => item.tool !== 'read');
      assert.equal(denied.length, 16);
      assert.ok(denied.every(item => item.status === 'error' && /Read-only worker/.test(item.error.message)));
      const originalProgress = records.filter(item => item.boundary === 'progress' && item.data.sessionID === session.id && item.data.metadata?.status === 'running');
      assert.equal(originalProgress.length, 2);
      assert.equal(new Set(originalProgress.map(item => item.data.id)).size, 2);
      assert.equal(settled[0].data.id, 'fixture-mdd-orchestrator-2-1');
    }
    const checkpointFiles = fs.readdirSync(join(project, '.mdd')).filter(name => name.startsWith('checkpoint-')).map(name => JSON.parse(fs.readFileSync(join(project, '.mdd', name), 'utf8')));
    const lane = checkpointFiles.find(record => record.items);
    if (nativeCase !== 'disabled') assert.equal(lane.state, ['dropped', 'conflicting', 'external-denied'].includes(nativeCase) ? 'blocked' : 'settled');
    console.log(JSON.stringify({ host: version.stdout.trim(), productionPlugin: 'active', nativeCase, liveNativeChildren: live.size,
      completionOrder: settled.map(item => item.data.id), productionConcurrency: nativeCase === 'disabled' ? 'SERIAL FALLBACK' : 'ACTUAL FOREGROUND CHILDREN',
      confinement: nativeCase === 'disabled'
        ? 'one singular native child completed a successful read; forbidden-tool confinement not exercised'
        : 'native hooks refused out-of-scope reads, mutation, shell, control, recursion and custom tools' }));
  } else {
  const before = records.find(item => item.boundary === 'before-read');
  assert.ok(before, `Native boundary was not reached. Requests: ${JSON.stringify(requests.map(({ session, step, input }) => ({ session, step, tools: input.tools?.map(tool => tool.function?.name) })))} ${stdout} ${stderr}`);
  const { data: childContext } = await api(`/api/session/${before.sessionID}/context`);
  const read = childContext.filter(message => message.type === 'assistant').flatMap(message => message.content)
    .find(part => part.type === 'tool' && part.name === 'read');
  assert.ok(read, 'Read refusal must be present in native history.');
  const matches = before.calls.filter(call => call.state.metadata?.sessionID === before.sessionID);
  const progress = records.filter(item => item.boundary === 'progress' && item.data.sessionID === before.parentID &&
    item.data.metadata?.sessionID === before.sessionID);
  assert.equal(progress.length, 1, 'The native subagent must publish one exact child-running progress event.');
  assert.equal(progress[0].data.id, before.calls[0].id);
  const { data: parentContext } = await api(`/api/session/${before.parentID}/context`);
  const parentMessage = parentContext.find(message => message.id === progress[0].data.assistantMessageID);
  assert.ok(parentMessage?.content.some(part => part.type === 'tool' && part.id === progress[0].data.id));
  console.log(JSON.stringify({ host: version.stdout.trim(), productionPlugin: 'active',
    exactRunningChildLinks: matches.length, childMetadata: before.childMetadata, childRecords: before.childRecords,
    runningCalls: before.calls.map(call => ({ id: call.id, status: call.state.status, metadata: call.state.metadata })),
    exactNativeProgress: progress[0].data, refusalOutcome: read.state.status, nativeResult: read.state,
    formatterBoundary: formatterBoundary ? { executed: fs.existsSync(formatterMarker), shellHooks: records.filter(item => item.boundary === 'shell-refused').length,
      file: fs.readFileSync(formattedFile, 'utf8'), edit: records.find(item => item.boundary === 'after-edit') } : 'NOT EXERCISED',
    productionConcurrency: 'NOT ENABLED OR PROVEN' }, null, 2));
  assert.equal(read.state.status, 'error', 'A thrown execute.before fence must refuse the native read.');
  assert.equal(read.state.error.message, 'TEST_BOUNDARY_READ_DENIED');
  assert.equal(matches.length, 0, 'Running transcript metadata remains empty; use native ephemeral progress instead.');
  if (formatterBoundary) assert.equal(fs.existsSync(formatterMarker), false,
    'PW-4 native edit safety RED: a configured formatter executed despite the deny-all shell hook.');
  console.log('Pinned native boundary probe passed; this is not MDD parallel-dispatch proof.');
  }
} finally {
  if (host && host.exitCode === null) {
    const exited = once(host, 'exit');
    // Stop only the service registered under this test-owned HOME.
    spawnSync(binary, ['service', 'stop'], { env: hostEnv, encoding: 'utf8', timeout: 15000 });
    host.kill(); await Promise.race([exited, delay(10000).then(() => { throw new Error('Test-owned host teardown timed out.'); })]);
  }
  provider.closeAllConnections();
  await new Promise(resolve => provider.close(resolve));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function basenameFixture(path) { return path.replaceAll('\\', '/').split('/').at(-1); }
