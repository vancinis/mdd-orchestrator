// Explicit host check: node tests/opencode-v2-host-smoke.mjs. No model requests or global writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { opencodeBinary } from '../dist/model-catalog.js';
import { defaultSettings } from '../dist/settings.js';

const binary = opencodeBinary();
const pluginEntry = resolve(process.argv[2] ?? 'dist/opencode-plugin.js');
assert.ok(binary, 'A native OpenCode V2 executable must be available on PATH.');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000 });
assert.match(version.stdout, /v?2\.0\.22\b/);
const root = fs.mkdtempSync(join(tmpdir(), 'mdd-v2-host-'));
let host;
let hostEnv;
try {
  const project = join(root, 'project');
  const config = join(root, 'config', 'opencode');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(join(config, 'mdd'), { recursive: true });
  for (const name of ['agents', 'skills']) fs.cpSync(`assets/opencode/${name}`, join(config, name), { recursive: true });
  const settings = defaultSettings();
  settings.profiles.default.models['mdd-plan'] = 'openai/test-model#high';
  fs.writeFileSync(join(config, 'mdd', 'mdd.config.json'), JSON.stringify(settings));
  const evidence = join(root, 'evidence.json');
  fs.mkdirSync(join(config, 'plugins'), { recursive: true });
  fs.writeFileSync(join(config, 'plugins', 'mdd.ts'), `export { default } from ${JSON.stringify(pathToFileURL(pluginEntry).href)};\n`);
  const entry = join(config, 'plugins', 'smoke.ts');
  fs.writeFileSync(entry, `import fs from 'node:fs';
export default { id: 'mdd.host-smoke', async setup(ctx) {
  const controller = new AbortController();
  const write = async () => {
    const tools = await ctx.tool.list();
    const mddTools = tools.filter(tool => tool.id.startsWith('mdd_'));
    if (mddTools.length === 15) fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({
      tools: mddTools.map(tool => ({ id: tool.id, codemode: tool.options?.codemode })),
    }));
  };
  await write();
  const events = (async () => {
    for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
      if (event.type === 'agent.updated') await write();
    }
  })();
  return async () => { controller.abort(); await events; };
} };
`);
  fs.writeFileSync(join(project, 'opencode.json'), '{}');
  // Do not inherit credentials, database overrides or host configuration from the invoking session.
  const osEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    ['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp'].includes(name.toLowerCase())));
  hostEnv = { ...osEnv, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
      OPENCODE_CONFIG_DIR: config, OPENCODE_CONFIG: join(project, 'opencode.json') };
  host = spawn(binary, ['serve', '--service', '--port', '0'], {
    cwd: project, env: hostEnv,
  });
  let stdout = ''; let stderr = '';
  host.stdout.on('data', data => { stdout += data; });
  host.stderr.on('data', data => { stderr += data; });
  const deadline = Date.now() + 60000;
  const registrationPath = join(root, 'state', 'opencode', 'service.json');
  while (!fs.existsSync(registrationPath) && Date.now() < deadline && host.exitCode === null) await delay(100);
  assert.ok(fs.existsSync(registrationPath), `Private host did not register: ${stdout} ${stderr}`);
  const registration = JSON.parse(fs.readFileSync(registrationPath, 'utf8'));
  const url = registration.url;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString('base64')}` };
  let catalog;
  while (!fs.existsSync(evidence) && Date.now() < deadline && host.exitCode === null) {
    const response = await fetch(`${url}/api/agent?location[directory]=${encodeURIComponent(project)}`, { headers });
    assert.ok(response.ok, await response.text());
    catalog = JSON.stringify((await (await fetch(`${url}/api/plugin?location[directory]=${encodeURIComponent(project)}`, { headers })).json()).data.filter(plugin => plugin.source.type !== 'builtin'));
    await delay(100);
  }
  assert.ok(fs.existsSync(evidence), `The real host must run MDD setup. ${catalog} ${(await (await fetch(`${url}/api/config?location[directory]=${encodeURIComponent(project)}`, { headers })).text())} ${stdout} ${stderr}`);
  const checked = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  do {
    const { data: agents } = await (await fetch(`${url}/api/agent?location[directory]=${encodeURIComponent(project)}`, { headers })).json();
    checked.agents = agents.filter(agent => agent.id.startsWith('mdd-'));
    if (checked.agents.length === 9 && checked.agents.find(agent => agent.id === 'mdd-plan').model?.variant === 'high') break;
    await delay(100);
  } while (Date.now() < deadline);
  const plugins = (await (await fetch(`${url}/api/plugin?location[directory]=${encodeURIComponent(project)}`, { headers })).json()).data;
  assert.equal(plugins.find(plugin => plugin.id === 'mdd')?.state.status, 'active', JSON.stringify(plugins.filter(plugin => plugin.source.type !== 'builtin')));
  assert.equal(checked.tools.length, 15);
  assert.ok(checked.tools.every(tool => tool.codemode === false));
  assert.equal(checked.agents.length, 9);
  assert.deepEqual(checked.agents.find(agent => agent.id === 'mdd-plan').model, { providerID: 'openai', id: 'test-model', variant: 'high' });
  assert.ok(checked.agents.filter(agent => agent.id !== 'mdd-orchestrator').every(agent =>
    agent.permissions.some(rule => rule.action === 'subagent' && rule.effect === 'deny')));
  console.log(`OpenCode V2 host smoke passed (${version.stdout.trim()}): 15 tools, 9 agents; isolated config, no model requests.`);
} finally {
  if (host && host.exitCode === null) {
    const exited = once(host, 'exit');
    spawnSync(binary, ['service', 'stop'], { env: hostEnv, encoding: 'utf8', timeout: 15000 });
    host.kill(); await exited;
  }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch (error) { console.warn(`Could not remove isolated smoke directory: ${error.code}`); }
}
