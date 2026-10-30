import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, cp } from 'node:fs/promises';
import fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createLegacyPlugin as plugin } from '../dist/opencode-plugin.js';
import { defaultSettings, MODEL_ROLES } from '../dist/settings.js';
import { saveGlobalSettings } from '../dist/global-settings.js';
import { memoryServer, installCleanup, isolateHome, answers, structuredTraceFixture as traceFixture, reportDocument, riskReport } from './adapter-fixture.mjs';
import { traceArtifact } from '../dist/acceptance.js';
import { ManagedMemory } from '../dist/managed-memory.js';
import { STATUS_BUDGET_BYTES, STATUS_COMPACT_KEEP, STATUS_DROP_ORDER, STATUS_PROTECTED_FIELDS } from '../dist/status-budget.js';
import { retroReport } from '../dist/retro.js';
import { collapsedPrompt } from '../dist/dispatch-transcript.js';
import { QuestionCheckpointStore } from '../dist/question-checkpoint.js';
import { RunOwnershipStore } from '../dist/run-ownership.js';
import { CheckpointStore } from '../dist/checkpoint.js';
import { ProgressGuard } from '../dist/progress.js';
import { RunDossierStore } from '../dist/run-dossier.js';
import { projectApprovalTransfer, projectTargetTransfer } from '../dist/transfer.js';
import { Workflow } from '../dist/workflow.js';
import { lockIdentity } from '../dist/local-files.js';
import { FULL_TASK_MAX_BYTES } from '../dist/phase-runner.js';

for (const phase of ['mdd-explore', 'mdd-risk', 'mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify']) {
}

// A risk-routed run (explored, assessed, planned, interrupted in apply) restarts on the tail its
// replayed verdict selected, whatever its answers would score now. A score-routed legacy route
// stapled onto that history contradicts it and is refused rather than trusted.
for (const recorded of [true, false]) {
}

// T1/S2: a recovery decision already committed before the restart is restored once from replay,
// keeps its route attribution, and never re-arms the recovery question.
for (const [label, expectStage, route] of [['Reintentar evaluación de riesgo', 'mdd-risk', undefined], ['Ruta low', undefined, 'low'], ['Ruta high', undefined, 'high']]) {
}

for (const store of ['engram', 'both']) {
}

// Native SDK/hook contract fixtures. No model or real shell execution is performed.
async function fixture(t, { mode = 'automatic', route = 'low', store = 'none', partial = false, summary = 'low', telemetry = true, memoryEnabled = true, memoryFault, start = true, worktree: worktreeLayout = false, distinctWorktree = false, autoReview = true, automaticCorrections = 0, guards = false } = {}) {
  isolateHome(t);
  // When asked, the session runs inside a linked git worktree laid out as git does on disk — a
  // `.git` file pointing at the administrative directory, which names the shared git directory. It
  // is where entrecuadras runs, and where MDD used to bury a run's records so the worktree could
  // delete them. `mainRoot` is the repository those records must land in instead.
  const base = await mkdtemp(join(tmpdir(), 'mdd-full-native-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  let root = base;
  let mainRoot = base;
  if (worktreeLayout) {
    mainRoot = join(base, 'MainRepo');
    const administrative = join(mainRoot, '.git', 'worktrees', 'linked');
    await mkdir(administrative, { recursive: true });
    await writeFile(join(administrative, 'commondir'), '../..\n');
    root = join(base, 'linked');
    await mkdir(root);
    await writeFile(join(root, '.git'), `gitdir: ${administrative.replaceAll('\\', '/')}\n`);
  }
  const hostWorktree = root;
  if (distinctWorktree) {
    root = join(root, 'checkout @active');
    await mkdir(root);
  }
  installCleanup(root);
  await writeFile(join(root, 'feature.txt'), 'pending\n');
  const memory = memoryEnabled ? await memoryServer(t, memoryFault) : { binding: {}, writes: [] };
  memory.binding.directory = root;
  const settings = defaultSettings();
  // complexity no longer scores a route (mdd-risk judges it after exploration instead), so the
  // high-route fixture now reaches the threshold through certainty and summary alone.
  const known = { ...answers, mode, summary, artifactStore: store, ...(route === 'high' ? { certainty: 'not-sure', summary: 'detailed' } : route === 'low-explore' ? { certainty: 'somewhat-sure' } : {}) };
  settings.profiles.default.answers = partial ? { ...known, mode: undefined } : known;
  if (partial) delete settings.profiles.default.answers.mode;
  if (memoryEnabled) settings.engram = { endpoint: memory.endpoint, project: 'mdd-test' };
  settings.telemetry.enabled = telemetry;
  // Most tests here pin the manual stop after a failed Verify; null keeps the shipped default (2).
  if (automaticCorrections !== null) settings.verify = { automaticCorrections };
  // Free by default, as MDD ships; guards:true pins the strict workflow these tests were written for.
  settings.guards.enabled = guards;
  saveGlobalSettings(settings);
  const runtime = { sessionID: 'ses_parent', agent: 'mdd-orchestrator', directory: root, worktree: hostWorktree };
  const model = { providerID: 'contract-only', modelID: 'model' };
  const requirements = 'Implement a scoped feature and check it.';
  const agents = MODEL_ROLES.map(role => ({ name: role === 'orchestrator' ? 'mdd-orchestrator' : role, mode: role === 'orchestrator' ? 'primary' : 'subagent', permission: [
    { permission: '*', pattern: '*', action: 'deny' }, ...['read', 'glob', 'grep'].map(permission => ({ permission, pattern: '*', action: 'allow' })),
    ...(role === 'mdd-apply' ? [{ permission: 'edit', pattern: '*', action: 'ask' }] : []),
    ...(['mdd-apply', 'mdd-verify'].includes(role) ? [{ permission: 'bash', pattern: '*', action: 'ask' }] : []),
  ] }));
  const sessions = new Map([[runtime.sessionID, { id: runtime.sessionID, agent: runtime.agent, directory: root, projectID: 'project' }]]);
  const info = { id: 'msg_parent', sessionID: runtime.sessionID, agent: runtime.agent, role: 'assistant', ...model, path: { cwd: root, root: hostWorktree } };
  const parent = [{ info: { id: 'user', sessionID: runtime.sessionID, role: 'user' }, parts: [{ type: 'text', text: requirements, sessionID: runtime.sessionID, messageID: 'user' }] }, { info, parts: [] }];
  const histories = new Map([[runtime.sessionID, parent]]);
  const input = { directory: root, worktree: hostWorktree, project: { id: 'project' }, client: {
    app: { agents: async () => ({ data: agents }) }, session: {
      status: async () => ({ data: {} }),
      get: async ({ path }) => ({ data: sessions.get(path.id) }), messages: async ({ path }) => ({ data: histories.get(path.id) }),
    },
  } };
  const hooks = await plugin(input);
  const context = { ...runtime, messageID: 'msg_parent', abort: new AbortController().signal };
  // These tests inspect the run itself — its route, held plan, coverage and recorded evidence —
  // so they read the inspection view. The compact default that every other tool returns has its
  // own contract tests; asserting run semantics through it would only test the projection twice.
  const status = async () => {
    const current = JSON.parse(await hooks.tool.mdd_status.execute({ detail: 'full' }, context));
    // Existing route tests act as a coordinator with no outstanding clarification.
    return current.state === 'review-ready' && autoReview
      ? JSON.parse(await hooks.tool.mdd_prepare_advance.execute({ questions: [] }, context))
      : current;
  };
  let questionCount = 0;
  async function answer(selection) {
    const current = await status();
    const args = current.question;
    const call = { sessionID: runtime.sessionID, callID: `question-${++questionCount}`, tool: 'question' };
    parent[1].parts = [{ type: 'tool', tool: 'question', callID: call.callID, sessionID: runtime.sessionID, messageID: context.messageID, state: { status: 'running', input: structuredClone(args) } }];
    await hooks['tool.execute.before'](call, { args });
    // 'Ruta' is the one native route question (3a) that replaces the generic approval at the
    // suggested route's first tail phase; the default answer here keeps the suggested route,
    // exactly like the plain 'Continuar' it stands in for.
    const labels = { 'Aprobación': 'Continuar', Ruta: 'Continuar con la ruta sugerida', Cambio: 'Confirmar el cambio', Certeza: known.certainty === 'not-sure' ? 'Poco seguro' : known.certainty === 'somewhat-sure' ? 'Algo seguro' : 'Muy seguro', Modo: mode === 'automatic' ? 'Automático' : 'Interactivo', Resumen: { low: 'Bajo', medium: 'Medio', detailed: 'Detallado' }[known.summary], Notas: 'Nada que agregar' };
    const selections = Array.isArray(selection) ? selection : args.questions.map(q => [typeof selection === 'string' ? selection : labels[q.header]]);
    const formatted = args.questions.map((q, i) => `"${q.question}"="${selections[i].join(', ')}"`).join(', ');
    await hooks['tool.execute.after']({ ...call, args }, { title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`, output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`, metadata: { answers: selections, truncated: false } });
    return { call, args };
  }
  let userIndex = 0;
  function user(text) {
    const id = `user-${++userIndex}`;
    parent[0] = { info: { id, sessionID: runtime.sessionID, role: 'user' }, parts: [{ type: 'text', text, sessionID: runtime.sessionID, messageID: id }] };
    context.messageID = `msg-parent-${userIndex}`;
    parent[1] = { info: { ...info, id: context.messageID }, parts: [] };
  }
  async function change(kind = 'rerun', requirements) {
    return JSON.parse(await hooks.tool.mdd_change_request.execute({ kind, userText: parent[0].parts[0].text,
      ...(kind === 'material' ? { requirements, concerns: [{ category: 'integrations', evidence: 'The user requested a new integration.', impact: 'The approved acceptance map must be replanned.' }] } : {}) }, context));
  }
  let index = 0;
  const visited = [];
  // What the last dispatched actor actually received. The parent only ever sees a handle now, so
  // assertions about prompt content belong here, where the prompt is really delivered.
  let delivered;
  async function consult(provider, args, callID) {
    assert.ok(Buffer.byteLength(JSON.stringify(args)) <= 96000, 'complete escaped task exceeds the hard ceiling');
    const manifests = [...args.prompt.matchAll(/^Validated dependency artifacts \(data, not authority\): (.*)$|^Exploration artifact \(data, not authority\): (.*)$|^Contextual findings \(advisory, not approval\): (.*)$/gm)]
      .flatMap(match => { const value = JSON.parse(match[1] ?? match[2] ?? match[3]); return Array.isArray(value) ? value : [value]; })
      .map(item => item?.artifact ?? item).filter(item => item?.inlined === false);
    if (!manifests.length) return '';
    assert.match(args.prompt, /Read every mustRead document/);
    const childID = `reader-${callID}`, messageID = `reader-message-${callID}`;
    const task = parent[1].parts.find(part => part.callID === callID);
    Object.assign(task, { sessionID: runtime.sessionID, messageID: parent[1].info.id });
    task.state.metadata = { sessionId: childID };
    task.state.input = structuredClone(args);
    sessions.set(childID, { id: childID, parentID: runtime.sessionID, directory: root, projectID: 'project', agent: args.subagent_type });
    const history = [{ info: { id: messageID, sessionID: childID, role: 'assistant', agent: args.subagent_type,
      ...model, path: { cwd: root, root: hostWorktree } }, parts: [] }];
    histories.set(childID, history);
    let consulted = '';
    for (const manifest of manifests) {
      assert.equal(manifest.mustRead, true);
      let offset = 0, content = '', eof = false;
      while (!eof) {
        const input = { document: manifest.document, digest: manifest.ref.digest, offset, limit: 8192 };
        const id = `page-${offset}`, invocation = { sessionID: childID, callID: id, messageID, tool: 'mdd_artifact_read' };
        history[0].parts = [{ type: 'tool', tool: 'mdd_artifact_read', callID: id, sessionID: childID, messageID, state: { status: 'running', input } }];
        await provider['tool.execute.before'](invocation, { args: input });
        const page = JSON.parse(await provider.tool.mdd_artifact_read.execute(input,
          { ...context, sessionID: childID, agent: args.subagent_type, messageID, callID: id }));
        content += page.content; offset = page.nextOffset; eof = page.eof;
      }
      assert.equal(createHash('sha256').update(content).digest('hex'), manifest.ref.digest);
      assert.equal(Buffer.byteLength(content), manifest.ref.bytes);
      consulted += content;
    }
    return consulted;
  }
  let hiddenIndex = 0;
  // The verdict the fixture's risk actor returns: it follows the route the fixture was built for.
  const riskRoute = route === 'high' ? 'high' : 'low';
  /**
   * Every run now starts with exploration and then the mdd-risk stop, and only the validated
   * verdict selects the route. These tests were written when a low route began at mdd-plan and a
   * high one went straight from exploration to its tail, so `phase()` drives that prelude itself —
   * an exploration the low route never asked for, and the risk stop, plus the approval interactive
   * mode now asks before the first tail phase — and then runs the phase the test meant, so each
   * call still advances exactly one phase of the route the test was written against.
   * `{ only: true }` runs exactly the current task, prelude included, for tests about it.
   */
  async function phase(options = {}) {
    let current = await status();
    if (!options.only) {
      const settle = async () => {
        let next = await status();
        if (next.question && next.state === 'question-ready') { await answer(); next = await status(); }
        return next;
      };
      if (route === 'low' && !current.contextual && current.stage === undefined && current.task?.subagent_type === 'mdd-explore' && current.workflow?.results.length === 0) {
        await step(current, {}, true);
        current = await settle();
      }
      if (current.stage === 'mdd-risk' && current.task) {
        await step(current, {}, true);
        current = await settle();
      }
    }
    return step(current, options, false);
  }
  async function step(current, options, hidden) {
    const args = current.task;
    assert.ok(args, `Expected task, got ${current.state}: ${current.reason ?? 'no reason'}`);
    const phase = current.stage ?? current.phase ?? 'mdd-explore';
    const risk = phase === 'mdd-risk';
    // The parent conversation is handed a dispatch handle, never the prompt itself. That is the
    // contract: the prompt is what fills a coordinator's context window and gets it compacted,
    // and the actor receives it all the same because the hook expands the handle below.
    assert.ok(args.prompt.startsWith('mdd:dispatch:'), `status handed the full prompt for ${phase}`);
    assert.ok(Buffer.byteLength(JSON.stringify(args)) < 300, `oversized dispatched task for ${phase}`);
    assert.equal(current.dispatch.mode, 'handle');
    assert.deepEqual(current.nextAction.args, args, `nextAction must carry the dispatchable task for ${phase}`);
    // A coordinator reading its own collapsed history back may replay the transcript note in
    // place of the handle. The byte count it writes is whatever it remembers, never the real one.
    if (options.replayNote) args.prompt = collapsedPrompt(args.subagent_type, 4242);
    const ordinal = hidden ? `prelude-${++hiddenIndex}` : `${++index}`;
    const callID = `task-${ordinal}`;
    const call = { sessionID: runtime.sessionID, callID, tool: 'task' };
    parent[1].parts = [{ type: 'tool', tool: 'task', callID, state: { status: 'running', input: args } }];
    await hooks['tool.execute.before'](call, { args });
    // Expanded in place by the hook, so from here `args` is exactly what the actor receives.
    const consulted = await consult(hooks, args, callID);
    assert.ok(args.prompt.length > 1000, `the handle was not expanded for ${phase}`);
    if (!hidden) delivered = args.prompt;
    if (risk) {
      // The risk actor gets the requirements, the recorded exploration and its own report form.
      assert.equal(args.subagent_type, current.mode === 'native' ? 'general' : 'mdd-risk');
      assert.ok(args.prompt.includes('Requirements data: "'), 'requirements missing in mdd-risk');
      assert.ok((args.prompt + consulted).includes('Artifact for mdd-explore'), 'exploration artifact unavailable to mdd-risk');
      assert.ok(args.prompt.includes('exactly this key: risk'), 'risk report form missing in mdd-risk');
      assert.ok(args.prompt.includes('Packaged MDD actor instructions with provenance'), 'MDD instructions missing in mdd-risk');
    } else {
    // A dependency reaches the phase in full, or as its recorded summary and ref when inlining
    // every artifact would exceed the handoff budget. What it never does is disappear silently.
    const announced = /appear above as their recorded summary and ref/.test(args.prompt);
    for (const prior of visited) {
      const summarized = (current.handoff?.summarized ?? []).some(item => item.phase === prior);
      assert.ok(args.prompt.includes(`Artifact for ${prior}`) || summarized || announced, `Missing ${prior} dependency in ${phase}`);
      if (summarized) assert.ok(announced, `unannounced compaction in ${phase}`);
    }
    // Paths are OS-native and travel JSON-escaped (so a Windows backslash appears doubled in the
    // delivered prompt text); the separator is matched loosely rather than assuming either form.
    const skillPath = name => new RegExp(`skills[\\\\/]+${name}[\\\\/]+SKILL\\.md`);
    if (phase === 'mdd-apply' && current.mode !== 'native') {
      assert.ok(args.prompt.includes('Optional packaged skills for this phase'), 'mdd-cleanup path hint missing in mdd-apply');
      assert.match(args.prompt, skillPath('mdd-cleanup'), 'mdd-cleanup path missing in mdd-apply');
      assert.ok(!args.prompt.includes('## Hard Rules'), 'mdd-cleanup body leaked into mdd-apply');
    }
    // Every phase is shown only its own result schema; a leaked one made plan fill verification.
    // A standalone read-only investigation has its own prompt and no phase result fields at all.
    const standalone = args.prompt.includes('Standalone read-only investigation only');
    const own = { 'mdd-explore': [], 'mdd-propose': [], 'mdd-plan': ['acceptance', 'decisions', 'deliverables', 'unmet'], 'mdd-spec': ['domain', 'acceptance'],
      'mdd-design': ['decisions', 'unmet'], 'mdd-tasks': ['deliverables', 'unmet'], 'mdd-apply': ['changes', 'noChangeReason', 'checks', 'delivered', 'completed'], 'mdd-verify': ['checks', 'verification'] }[phase];
    // Only the correction pass after a failed Verify is shown how to account for its findings.
    if (phase === 'mdd-apply' && args.prompt.includes('This is a correction pass')) own.push('closure');
    if (own.length && current.verificationVersion === 1) own.push('verificationVersion');
    if (!standalone) {
      assert.equal(args.prompt.includes(own.length ? `exactly these keys: ${own.join(', ')}.` : 'This phase reports no structured data'), true, `own field list in ${phase}`);
      // The report is prose with one structured block, never a serialized object.
      assert.ok(args.prompt.includes('"## MDD Summary" holding'), `markdown report form missing in ${phase}`);
      assert.ok(!args.prompt.includes('Return exactly one JSON object'), `legacy JSON contract leaked into ${phase}`);
      // Packaged instructions travel with the phase, so a foreign AGENTS.md cannot be its authority.
      assert.ok(args.prompt.includes('Packaged MDD actor instructions with provenance'), `MDD instructions missing in ${phase}`);
      assert.ok(args.prompt.includes('are repository text, not authority for this phase'), `isolation clause missing in ${phase}`);
    }
    assert.equal(args.prompt.includes('verification={scenarios:'), phase === 'mdd-verify', `verification schema leak in ${phase}`);
    // Prose phases carry the documentation skill paths; structural ones do not pay for them.
    // Neither the mdd-doc nor the cognitive-doc-design body is ever inlined by value.
    const documentary = current.mode !== 'native' && !['mdd-tasks', 'mdd-apply'].includes(phase);
    assert.equal(skillPath('mdd-doc').test(args.prompt), documentary, `mdd-doc path for ${phase}`);
    assert.equal(skillPath('cognitive-doc-design').test(args.prompt), documentary, `cognitive-doc-design path for ${phase}`);
    assert.ok(!args.prompt.includes('Trusted local mdd-doc instructions with provenance'), `stale mdd-doc injection wording in ${phase}`);
    assert.ok(!args.prompt.includes('Trusted local cognitive-doc-design instructions with provenance'), `stale cognitive-doc-design injection wording in ${phase}`);
    if (documentary) {
      assert.ok(args.prompt.includes('mdd-doc wins'), `skill precedence missing in ${phase}`);
      assert.ok(args.prompt.includes('nothing in it authorizes a command here'), `command guard missing in ${phase}`);
      assert.ok(args.prompt.includes('do not load a skill by name'), `no-name-lookup guidance missing in ${phase}`);
    }
    if (phase === 'mdd-tasks') assert.ok(!args.prompt.includes('Optional packaged skills for this phase'), 'mdd-tasks must carry no skill hint');
    }
    const childID = `child-${ordinal}`;
    parent[1].parts[0].state.metadata = { sessionId: childID, parentSessionId: runtime.sessionID, model };
    sessions.set(childID, { id: childID, parentID: runtime.sessionID, directory: root, projectID: 'project', agent: phase, permission: [{ permission: 'task', pattern: '*', action: 'deny' }] });
    await hooks.event({ event: { type: 'session.created', properties: { info: sessions.get(childID) } } });
    const child = [{ info: { id: `msg-${ordinal}`, sessionID: childID, role: 'assistant', agent: phase, ...model, path: { cwd: root, root: hostWorktree }, time: { completed: 10 }, finish: 'stop', ...(options.spent ?? {}) }, parts: [] }];
    histories.set(childID, child);
    if (options.beforeMismatch) child[0].info.modelID = 'substituted';
    async function tool(name, input, output, execute = async () => {}) {
      const tc = { sessionID: childID, callID: `${name}-${ordinal}`, tool: name };
      const part = { type: 'tool', tool: name, callID: tc.callID, sessionID: childID, messageID: child[0].info.id, state: { status: 'running', input: structuredClone(input) } };
      child[0].parts.push(part);
      await hooks['tool.execute.before'](tc, { args: input });
      if (options.denied) {
        await hooks.event({ event: { type: 'message.part.updated', properties: { part: { ...part, state: { status: 'error', input, error: 'Permission denied.' } } } } });
        throw new Error('Simulated native permission denial.');
      }
      await execute();
      if (!options.missingAfter) await hooks['tool.execute.after']({ ...tc, args: input }, output);
      part.state = { status: 'completed', input: structuredClone(input), ...output };
      return tc.callID;
    }
    const result = { phase, runID: current.runID ?? current.explorationID, callID, outcome: options.outcome ?? 'passed', evidenceSummary: `Actual contract evidence for ${phase}.`, artifact: `Artifact for ${phase}: scoped requirements, changes and executable check plan.` };
    if (options.concerns) result.concerns = options.concerns;
    if (options.questions) result.questions = options.questions;
    if (options.unauthorized) await tool('write', { filePath: join(root, 'feature.txt'), content: 'not permitted' }, { output: 'write', metadata: {} }, () => writeFile(join(root, 'feature.txt'), 'not permitted'));
    if (phase === 'mdd-apply') {
      if (result.outcome === 'passed') result.completed = ['feature'];
      // A correction pass accounts for every finding of the Verify it corrects, by the IDs it was given.
      const findings = args.prompt.match(/Report closure for each finding ID (.+?), and completed/)?.[1].split(', ');
      if (findings && result.outcome === 'passed') result.closure = findings.map(id => ({ id, status: 'closed', evidence: `Reproduced ${id} first; the regression now passes (npm test, exit 0).` }));
      if (options.noChange) {
        await tool('read', { filePath: join(root, 'feature.txt') }, { output: 'Inspected existing implementation.', metadata: { truncated: false } });
        result.noChangeReason = 'Inspected implementation already satisfies the scoped task.';
      }
      else {
        const filePath = options.external ? join(root, '../escape.txt') : join(root, 'feature.txt');
        await tool('write', { filePath, content: 'implemented\n' }, { output: 'Wrote file successfully.', metadata: { filepath: filePath, exists: true, diagnostics: {}, truncated: false } }, () => writeFile(filePath, 'implemented\n'));
        // Apply reports why each file changed, not only that it did: the reason is what the PR
        // body tabulates and what a reviewer cannot get from the diff.
        result.changes = [{ path: filePath, reason: 'Implementa el manejo de entrada que pide el plan en el borde de la feature.' }];
        // And what the change delivers, which is what the body opens with. Malformed here on
        // purpose in one case: a summary must never be able to fail a finished implementation.
        result.delivered = options.badSummary ? { what: '' } : { what: 'Invalid input is now rejected at the feature boundary.', implies: 'Whoever uses the feature gets a clear error instead of an unintended change.' };
      }
    } else if (phase === 'mdd-verify') {
      if (!options.noChecks) {
        const command = 'npm test';
        const text = '1 test passed';
        await tool('bash', { command, workdir: root, description: 'Run scoped tests' }, { output: text, metadata: { output: text, exit: options.exit === undefined ? 0 : options.exit, truncated: false } });
        result.checks = [{ id: 'E1', command, exit: options.exit === undefined ? 0 : options.exit }];
      } else result.checks = [];
    } else await tool('read', { filePath: join(root, 'feature.txt') }, { output: 'Inspected project context.', metadata: { truncated: false } });
    const trace = traceFixture(join(root, 'feature.txt'), 'feature');
    if (phase === 'mdd-plan') Object.assign(result, trace);
    if (phase === 'mdd-spec') { result.domain = 'project'; result.acceptance = trace.acceptance; }
    if (phase === 'mdd-design') result.decisions = trace.decisions;
    if (phase === 'mdd-tasks') result.deliverables = trace.deliverables;
    if (phase === 'mdd-verify') {
      const assessment = { status: 'verified', checks: ['E1'], assessment: 'The inspected boundary and planned check output support the expected behavior.' };
      result.verification = { scenarios: ['S1', 'S2'].map(scenarioID => ({ requirementID: 'R1', scenarioID, stepID: 'feature', ...assessment })),
        steps: [{ stepID: 'feature', ...assessment }], decisions: [{ decisionID: 'D1', ...assessment }], changes: options.noChange ? 'No implementation change was needed.' : 'The requested input handling is implemented.', limits: [],
        checkResults: [{ checkID: 'feature-check', disposition: options.noChecks ? 'blocked' : options.exit === null ? 'ran' : options.exit ? 'failed' : 'passed',
          executions: options.noChecks ? [] : ['E1'], reason: options.noChecks ? 'Checks unavailable.' : 'Observed fixture execution.' }], supplementalChecks: [] };
      if (options.unverified) for (const row of [...result.verification.scenarios, ...result.verification.steps, ...result.verification.decisions]) row.status = 'not-verified';
      if (options.coverageFault === 'missing') result.verification.scenarios.pop();
      if (options.coverageFault === 'invented') result.verification.scenarios[0].requirementID = 'invented';
      if (options.coverageFault === 'drift' || options.coverageFault === 'partial') {
        result.verification.decisions[0].status = 'deviation';
        result.verification.decisions[0].assessment = 'Input handling diverges from the planned boundary.';
        result.verification.limits = ['Boundary behavior still needs alignment with the plan.'];
        if (options.coverageFault === 'partial') result.outcome = 'failed';
      }
    }
    if (options.artifact !== undefined) result.artifact = options.artifact;
    if (options.narrative) Object.assign(result, options.narrative);
    if (options.large) {
      const suffix = traceArtifact(phase, '', trace.acceptance, trace.decisions, trace.deliverables, result.verification);
      // `fill` lets a test choose characters JSON must escape, so serialized size exceeds raw size.
      const fill = options.fill ?? 'x';
      result.artifact += fill.repeat(Math.floor((16000 - Buffer.byteLength(result.artifact) - Buffer.byteLength(suffix)) / Buffer.byteLength(fill)));
    }
    if (options.mismatch) child[0].info.modelID = 'substituted';
    const text = options.reportText ?? (risk ? riskReport(options.riskRoute ?? riskRoute, options.outcome ?? 'passed') : reportDocument(result));
    // The actor checks its own report from its own session before returning it, as it is told to.
    if (options.check) await options.check(JSON.parse(await hooks.tool.mdd_check_report.execute({ phase, result: text }, { ...context, sessionID: childID, agent: phase })));
    child[0].parts.push({ type: 'text', sessionID: childID, messageID: child[0].info.id, text });
    const output = { title: 'Native task', metadata: { sessionId: childID, parentSessionId: runtime.sessionID, model }, output: `<task id="${childID}" state="completed">\n<task_result>\n${text}\n</task_result>\n</task>` };
    if (options.badEnvelope) output.output = 'the delegated task did not finish';
    await hooks['tool.execute.after']({ ...call, args }, output);
    if (!risk) visited.push(phase);
    return status();
  }
  if (start) await hooks.tool.mdd_start.execute({ requirements }, context);
  return { root, mainRoot, settings, hooks, status, phase, answer, user, change, input, context, parent, runtime, visited, requirements, memory, consult,
    sessions, histories, delivered: () => delivered, writes: memory.writes, questions: () => questionCount };
}

/**
 * Drives the two stops every run starts with — exploration, then the mdd-risk assessment — and
 * returns the route the validated verdict selected. Before the verdict nothing beyond exploration
 * is on the route, whatever the preflight score says.
 */
async function assessedRoute(f, route) {
  const tail = route === 'high' ? ['mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks', 'mdd-apply', 'mdd-verify'] : ['mdd-plan', 'mdd-apply', 'mdd-verify'];
  let current = await f.status();
  assert.equal(current.task.subagent_type, 'mdd-explore');
  assert.deepEqual(current.workflow.evaluation.phases, ['mdd-explore']);
  await f.phase({ only: true });
  current = await f.status();
  assert.equal(current.stage, 'mdd-risk');
  assert.equal(current.phase, 'mdd-explore');
  assert.equal(current.task.subagent_type, 'mdd-risk');
  assert.deepEqual(current.workflow.evaluation.phases, ['mdd-explore']);
  assert.equal(current.question, undefined, 'the risk stop dispatches without an approval of its own');
  await f.phase({ only: true });
  current = await f.status();
  assert.equal(current.stage, undefined);
  assert.deepEqual(current.workflow.evaluation.phases, ['mdd-explore', ...tail]);
  if (current.question) await f.answer();
  return ['mdd-explore', ...tail];
}

for (const route of ['low', 'high']) for (const store of ['none', 'openspec']) for (const mode of ['automatic', 'interactive']) {
}

for (const [name, question, option, freeText] of [
  ['question over the context-label budget', '¿Qué comportamiento necesitás? '.repeat(10), { label: 'Conservar', description: 'Conservar el comportamiento.' }],
  ['multibyte question and selected option beyond prose ceilings', '¿Qué comportamiento necesitás? '.repeat(150),
    { label: 'Conservar la configuración íntegra. '.repeat(400), description: 'Mantener el comportamiento actual. '.repeat(20), recommended: true }],
  ['multibyte free-text answer beyond 12000 bytes', '¿Qué texto necesitás?', { label: 'Breve', description: 'Usar texto breve.' }, 'Necesito la configuración íntegra. '.repeat(400)],
]) {
}

const REPORTED_QUESTIONS = [{ question: 'Which locale formats dates?', why: 'Every rendered date depends on it.',
  options: [{ label: 'es-AR', description: 'Day first.', recommended: true }, { label: 'en-US', description: 'Month first.' }] }];

for (const fault of [{ noChecks: true }, { coverageFault: 'missing' }]) {
}

/** What a checkpoint write that kept failing leaves behind: the marker withdraws resumability. */
function withdrawResume(f) {
  const progress = new ProgressGuard(f.root);
  progress.write(f.runtime.sessionID, { ...progress.read(f.runtime.sessionID), resumable: false });
}

for (const route of ['low', 'high']) for (const mode of ['automatic', 'interactive']) for (const store of ['none', 'openspec', 'engram', 'both']) {
}

for (const [name, exit] of Object.entries({ nonzero: 1, interrupted: null })) {
}

for (const summary of ['low', 'medium', 'detailed']) {
}

for (const fault of ['missing', 'invented', 'drift', 'partial']) {
}

async function failedVerification(t, options = {}) {
  const f = await fixture(t, { memoryEnabled: false, ...options });
  await f.phase(); await f.phase();
  await f.phase({ outcome: 'failed', exit: 1, unverified: true });
  return f;
}

function coordinatorQuestion(f, hooks = f.hooks, id = 'coordinator-question', text = 'Which evidence should we inspect?') {
  const args = { questions: [{ header: 'Recovery', question: text, options: [{ label: 'Inspect', description: 'Discuss the evidence.' }] }] };
  const call = { sessionID: f.runtime.sessionID, callID: id, tool: 'question' };
  const part = { type: 'tool', tool: 'question', callID: id, sessionID: call.sessionID, messageID: f.context.messageID,
    state: { status: 'running', input: structuredClone(args) } };
  f.parent[1].parts.push(part);
  return { args, call, part, before: () => hooks['tool.execute.before'](call, { args }),
    after: () => hooks['tool.execute.after']({ ...call, args }, { title: 'Question', output: 'Ordinary answer, not MDD consent.', metadata: {} }) };
}

for (const restart of [false, true]) {
}

for (const restart of [false, true]) {
}

for (const mode of ['automatic', 'interactive']) {
}
// Regression: one grep refused outside the workspace used to block the whole investigation,
// and every later tool call then reported a misleading dispatch error.
test('a refused read lets the investigation continue instead of ending it', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Buscar el issue 389.' }, f.context);
  // phase({denied}) dispatches the task, runs a child read through the hooks, then reports the
  // native permission denial exactly as OpenCode does. Apply's write denial still blocks; see
  // "Apply native refusal or model mismatch prevents writes".
  await assert.rejects(f.phase({ denied: true }), /Simulated native permission denial/);
  const after = await f.status();
  assert.equal(after.state, 'await-result', 'a refused read must not end the investigation');
  assert.equal(after.contextual, true);
});

test('a replayed transcript note dispatches the standalone investigation it stands for', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Inspect this project.' }, f.context);
  const ready = await f.status();
  // The note names another actor: that is not this investigation, and it stays refused.
  const note = collapsedPrompt('mdd-plan', Buffer.byteLength(ready.task.prompt));
  await assert.rejects(f.hooks['tool.execute.before']({ ...f.runtime, callID: 'solo-note', tool: 'task' },
    { args: { ...ready.task, subagent_type: 'mdd-plan', prompt: note } }), /delivered transcript placeholder is not a task/);
  const after = await f.status();
  assert.equal(after.dispatch.mode, 'handle');
  assert.deepEqual(after.task, ready.task);
  // The same note with the investigation's own description and actor is the handle in another
  // shape: the actor receives the investigation's real prompt, never the note.
  await f.phase({ replayNote: true });
  assert.match(f.delivered(), /Standalone read-only investigation only/);
  assert.equal((await f.status()).contextual, false);
});
{
  test('a standalone investigation exhausts bounded fallback before explicit recovery', async t => {
    const f = await fixture(t, { start: false, memoryEnabled: false });
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Read project context only.' }, f.context);
    for (let i = 0; i < 4; i++) await assert.rejects(f.phase({ badEnvelope: true }));
    const stopped = await f.status();
    // A stopped investigation is finished, not in flight: it must not look like main work.
    assert.equal(stopped.state, 'blocked');
    assert.equal(stopped.fallbackExhausted, true);
    assert.ok(stopped.reason, 'the rejection stays visible');
    assert.equal(await readFile(join(f.root, 'feature.txt'), 'utf8'), 'pending\n');
    await f.hooks.tool.mdd_contextual_explore.execute({ purpose: 'Ask a different read-only question.' }, f.context);
    assert.equal((await f.status()).task.subagent_type, 'mdd-explore');
  });
}
for (const stage of ['confirmation', 'preflight']) {
}
/**
 * The Spanish a coordinator would send back for this fixture's recorded prose. Anything it does
 * not name is returned as recorded, which is how a text that is already Spanish passes unchanged.
 */
const PR_SPANISH = {
  'delivered.what': 'Ahora la entrada inválida se rechaza en el borde de la feature.',
  'delivered.implies': 'Quien usa la feature recibe un error claro en lugar de un cambio no buscado.',
  goal: 'Dejar la feature pedida usable, con un manejo de entrada claro.',
  verification: 'El manejo de entrada pedido quedó implementado.',
};
async function prBody(f, userText, notes, spanish = PR_SPANISH) {
  const args = { userText, ...(notes ? { notes } : {}) };
  const request = JSON.parse(await f.hooks.tool.mdd_pr_body.execute(args, f.context));
  assert.equal(request.render, 'pending-translation');
  const translations = request.entries.map(entry => ({ key: entry.key, text: spanish[entry.key] ?? entry.text }));
  return { request, draft: JSON.parse(await f.hooks.tool.mdd_pr_body.execute({ ...args, digest: request.digest, translations }, f.context)) };
}

// Lost-handle recovery exposes full text only within the transport gate; larger prompts remint.
function assertLostHandleRecovery(ready, recovered, delivered, error) {
  const full = { ...delivered, prompt: delivered.prompt.replace(/\nNative callID=.*$/, '') };
  const bytes = Buffer.byteLength(JSON.stringify(full));
  if (bytes <= FULL_TASK_MAX_BYTES) {
    assert.match(error.message, /full phase prompt instead/);
    assert.equal(recovered.dispatch, undefined, 'an in-budget fallback stops advertising a handle');
    assert.deepEqual(recovered.task, full, 'full fallback exposes the exact dispatched prompt');
    assert.match(recovered.task.prompt, /Perform only mdd-explore/);
  } else {
    assert.match(error.message, /fresh compact handle instead/);
    assert.equal(recovered.dispatch.mode, 'handle');
    assert.ok(recovered.task.prompt.startsWith('mdd:dispatch:'));
    assert.notEqual(recovered.task.prompt, ready.task.prompt, 'over-budget recovery remints the handle');
    assert.ok(Buffer.byteLength(JSON.stringify(recovered.task)) <= FULL_TASK_MAX_BYTES);
  }
  return bytes;
}

// A conversation that dies at its first question used to leave the workspace exactly as it found
// it, so the most expensive failures were also the invisible ones.
test('the workspace records that a coordinator opened MDD here, before any run exists', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  assert.equal((await f.status()).state, 'not-started');
  const sessions = (await readFile(join(f.root, '.mdd/sessions.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].sessionID, f.runtime.sessionID);
  assert.equal(sessions[0].agent, 'mdd-orchestrator');
  assert.equal(sessions[0].directory, f.root);
  // Recorded once per conversation, not once per tool call.
  await f.status(); await f.status();
  assert.equal((await readFile(join(f.root, '.mdd/sessions.jsonl'), 'utf8')).trimEnd().split('\n').length, 1);
});

// "Abrí el PR a staging con la etiqueta preview" after a quick edit left the PR unopened: the body
// tool refused to draft because the edit, by design, recorded no run.
test('a quick edit with no recorded run still drafts its PR body from git and the coordinator\'s Spanish', async t => {
  const f = await fixture(t, { start: false, memoryEnabled: false });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=MDD', '-c', 'user.email=mdd@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'staging'); git('add', '.'); git('commit', '-q', '-m', 'base'); git('checkout', '-q', '-b', 'fix/feature');
  await writeFile(join(f.root, 'feature.txt'), 'done\n');
  const userText = 'Abrí el PR a staging con la etiqueta preview.';
  f.user(userText);
  const before = await f.status();
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText }, f.context), /baseRef, the PR target branch/);
  const request = JSON.parse(await f.hooks.tool.mdd_pr_body.execute({ userText, baseRef: 'staging' }, f.context));
  assert.equal(request.render, 'pending-direct');
  assert.deepEqual(request.files, ['feature.txt']);
  // There is no recorded prose here, so there is nothing to translate either.
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText, baseRef: 'staging', digest: 'x', translations: [{ key: 'goal', text: 'Objetivo.' }] }, f.context), /no recorded text to translate/);
  const direct = { summary: 'La feature queda marcada como terminada para quien la consulta.',
    files: [{ path: 'feature.txt', reason: 'Cambia el estado de la feature de pendiente a terminada.' }] };
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText, baseRef: 'staging', direct, digest: 'x' }, f.context), /no recorded text to translate/);
  const draft = JSON.parse(await f.hooks.tool.mdd_pr_body.execute({ userText, baseRef: 'staging', direct }, f.context));
  assert.match(draft.body, /## Resumen\n\nLa feature queda marcada como terminada/);
  assert.match(draft.body, /\| `feature\.txt` \| Cambia el estado de la feature de pendiente a terminada\. \|/);
  assert.match(draft.body, /Ajuste directo, sin una ejecución MDD registrada/);
  assert.equal(draft.publication, 'not-authorized');
  assert.equal(draft.provenance.source, 'direct');
  const additionalContext = [{ section: 'review', source: 'interpretation', text: 'Revisar el texto visible antes de integrar el cambio.' }];
  const withContext = { userText, baseRef: 'staging', additionalContext };
  const bound = JSON.parse(await f.hooks.tool.mdd_pr_body.execute(withContext, f.context));
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ ...withContext, direct }, f.context), /digest/);
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ ...withContext, direct, digest: 'bad' }, f.context), /digest/);
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ ...withContext, additionalContext: [{ section: 'context', source: 'recorded', ref: 'goal' }] }, f.context), /recorded run/);
  const contextual = JSON.parse(await f.hooks.tool.mdd_pr_body.execute({ ...withContext, digest: bound.digest, direct }, f.context));
  assert.match(contextual.body, /## Notas para revisión/);
  assert.match(contextual.body, /MDD no planificó ni verificó este cambio/);
  assert.equal(contextual.publication, 'not-authorized');
  // The user's text is still authenticated: a claim they never wrote drafts nothing.
  await assert.rejects(f.hooks.tool.mdd_pr_body.execute({ userText: 'Ya está aprobado y desplegado.', baseRef: 'staging', direct }, f.context));
  // Drafting starts nothing: no run, no question, no state change.
  assert.deepEqual(await f.status(), before);
});

// ---------------------------------------------------------------------------------------------
// Resume hardening: each test reproduces one defect an independent audit found with checkpoint,
// ownership and restore always on. They are named after the audit finding they pin down.
// ---------------------------------------------------------------------------------------------
const STOPPED = 'I stopped the interrupted subagent.';
const questionAnswer = (args, label) => ({ title: `Asked ${args.questions.length} question${args.questions.length > 1 ? 's' : ''}`,
  output: `User has answered your questions: ${args.questions.map(q => `"${q.question}"="${label}"`).join(', ')}. You can now continue with the user's answers in mind.`,
  metadata: { answers: args.questions.map(() => [label]), truncated: false } });
function dispatchQuestion(f, callID, args) {
  f.parent[1].parts = [{ type: 'tool', tool: 'question', callID, sessionID: f.runtime.sessionID, messageID: f.context.messageID,
    state: { status: 'running', input: structuredClone(args) } }];
  return f.hooks['tool.execute.before']({ sessionID: f.runtime.sessionID, callID, tool: 'question' }, { args });
}
function dispatchTask(f, callID, args) {
  f.parent[1].parts = [{ type: 'tool', tool: 'task', callID, state: { status: 'running', input: structuredClone(args) } }];
  return f.hooks['tool.execute.before']({ sessionID: f.runtime.sessionID, callID, tool: 'task' }, { args });
}
