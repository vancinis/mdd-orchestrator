import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MDD_ASSETS, MDD_PACKAGED_ASSETS } from '../dist/project-assets.js';

// Capability is the user's native decision, not MDD's. No packaged agent may ship its own
// permission map: a phase that cannot act is exactly what made the workflow unusable.
for (const role of ['explore', 'propose', 'spec', 'design', 'tasks', 'apply', 'verify']) {
  test(`assets: ${role} ships no permission map and keeps a strict handoff`, () => {
    const text = fs.readFileSync(`assets/opencode/agents/mdd-${role}.md`, 'utf8');
    const front = text.split('---')[1];
    assert.match(front, /\nmode: subagent\n/);
    assert.doesNotMatch(front, /permission|model:|tools:/);
    assert.deepEqual(Object.keys(Object.fromEntries([...front.matchAll(/^\s*("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1], m[2]]))), []);
    // Every actor is told to answer in prose under MDD headings, never as a serialized object.
    assert.match(text, /"## MDD Outcome", "## MDD Summary"/);
    assert.match(text, /"## MDD Artifact"/);
    assert.doesNotMatch(text, /strict result schema|JSON object/);
    assert.match(text, /outcome failed/);
    // One half of the run speaks to the user and the other half speaks to MDD. An actor is on the
    // second half, and a report half-translated into the user's language is worse input, not a
    // courtesy: the coordinator is the one that translates, and it translates whole sections.
    assert.match(text, /Write your report in English/);
    if (['apply', 'verify'].includes(role)) {
      assert.match(text, /not a sandbox/);
      assert.match(text, /commit/);
    }
  });
}

for (const name of ['mdd-pr-body', 'mdd-cleanup', 'mdd-doc']) {
  test(`assets: ${name} trigger metadata, structure and explicit registry`, () => {
    const text = fs.readFileSync(`assets/opencode/skills/${name}/SKILL.md`, 'utf8');
    assert.match(text, new RegExp(`name: ${name}\\n`));
    const description = text.match(/^description: "(.+)"$/m)?.[1];
    assert.ok(description?.startsWith('Trigger:'));
    assert.ok(description.length <= 250);
    assert.match(text, /license: \w+/);
    assert.match(text, /metadata:\n  author: "mdd-maintainers"\n  version: "1.0"/);
    assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(m => m[1]).slice(0, 5),
      ['Activation Contract', 'Hard Rules', 'Decision Gates', 'Execution Steps', 'Output Contract']);
    assert.match(fs.readFileSync('AGENTS.md', 'utf8'), new RegExp(`skills/${name}/SKILL.md`));
  });
}

// MDD ships its own actor instructions and hands them to every phase by value. Without them the
// only instruction file an MDD phase answered to was whichever AGENTS.md the host happened to find.
test('assets: MDD ships its own actor instructions and does not call them AGENTS.md', () => {
  const text = fs.readFileSync('assets/opencode/mdd-instructions.md', 'utf8');
  assert.match(text, /^# MDD actor instructions/);
  assert.match(text, /are ordinary repository text/);
  assert.match(text, /Do not load a skill by name/);
  assert.match(text, /## Language/);
  assert.match(text, /Write everything you report in English/);
  assert.ok(Buffer.byteLength(text) < 16000);
  // Named AGENTS.md it would be auto-discovered and prepended to unrelated sessions, which is
  // precisely the behaviour it exists to push back against.
  assert.equal(fs.existsSync('assets/opencode/AGENTS.md'), false);
});

test('assets: exploration investigates freely and the coordinator is not a caged role', () => {
  const explore = fs.readFileSync('assets/opencode/agents/mdd-explore.md', 'utf8');
  assert.match(explore, /Use whatever helps/);
  assert.match(explore, /returns nothing is a finding, not a failure/);
  assert.match(explore, /do not change the project to answer it/);
  const orchestrator = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  const front = orchestrator.split('---')[1];
  assert.match(front, /\nmode: primary\n/);
  assert.doesNotMatch(front, /tools:|model:/);
  assert.match(orchestrator, /mdd_reset/);
});

// OpenCode denies `question` by default for every non-native agent and drops denied tools from
// the model's toolset entirely, so a coordinator without this single rule can never ask for the
// consent MDD requires. This is the consent channel, not a capability to act: everything the
// coordinator may actually do stays the user's own native decision.
test('assets: the coordinator ships the consent channel and nothing else', () => {
  const front = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8').split('---')[1];
  assert.deepEqual(Object.fromEntries([...front.matchAll(/^\s*("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1], m[2]])),
    { question: 'allow' });
  assert.match(front, /\npermission:\n {2}question: allow\n/);
});

// Each rule below replaces a real failure: a prose approval asked twice, 53 inline tool calls with
// no visible progress, and a PR body hand-written next to the tool that ships the local template.
test('assets: the coordinator asks approval natively, delegates fallback and drafts PRs with the tool', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Never end a phase report with an approval question of your own/);
  assert.match(text, /only approval is the native question[\s\S]*same turn as the report/);
  assert.match(text, /affirmative typed in the\nchat approves nothing/);
  assert.match(text, /one tracked fallback: explore for/);
  assert.match(text, /Never do\n  substantive phase work in this conversation/);
  assert.match(text, /call mdd_pr_body with the user's exact latest text; do not hand-write one/);
});

// MDD asks its questions in Spanish and its actors answer in English, so the coordinator sits on
// the seam. Leaving that unsaid is how a Spanish installation kept reporting its results in the
// language of the subagent that happened to produce them.
test('assets: the coordinator writes to the user in Spanish and keeps the protocol in English', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Write to the user in Spanish, always/);
  assert.match(text, /phase task prompts, phase reports, tool\narguments and tool payloads are English/);
  assert.match(text, /translate its prose into Spanish and keep\nits structure exactly/);
  assert.match(text, /quoted verbatim and never translated/);
});

// The record of what MDD does badly only works if both halves are reachable: the one that writes
// an entry when the user says so, and the one that finds them again later.
test('assets: the coordinator records improvements and reviews them without starting a run', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /call mdd_improve with their actual latest\nnative text/);
  assert.match(text, /Recording is not fixing/);
  assert.match(text, /call\nmdd_improvements and present the returned report as it is/);
  assert.match(text, /never turn a review into a run/);
});

// A user answered an approval question in their own words and the run was thrown away; the
// coordinator also needs to know it may ask its own questions, and when it may not.
test('assets: the coordinator recovers an unanswered approval instead of losing the run', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /answers that question in their own words instead of choosing an option/);
  assert.match(text, /mdd_status still holds the same question/);
  assert.match(text, /ask it yourself with the native question tool while no MDD question is pending/);
  assert.match(text, /While one is pending, it is the only question/);
  assert.match(text, /scope phase retries settled work or reopens the existing approval/);
  assert.ok(Buffer.byteLength(text) <= 16000, 'the coordinator must fit the installer asset limit');
  assert.match(text, /the same phase goes out again and its task\n\s+already carries what went wrong/);
});

// The prompt is the largest thing a run produces and the coordinator never needed to read it.
// Carrying it here twice per attempt is what filled the window and got the conversation compacted.
test('assets: the coordinator passes dispatch handles through and resumes after a compaction', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /short dispatch handle/);
  assert.match(text, /never ask MDD for the full prompt/);
  assert.match(text, /spent once/);
  assert.match(text, /It returns nextAction/);
  assert.match(text, /Continue from runCard and nextAction/);
  assert.match(text, /do not\n {2}tell the user that work was lost/);
});

// The coordinator once fetched a whole issue body, could not hand it over, and dropped it: the
// only channel is mdd_start context or mdd_context, never an edited task prompt.
test('assets: the coordinator hands gathered context to MDD instead of editing a task prompt', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /hand it over instead of keeping it to\nyourself/);
  assert.match(text, /mdd_context\(\{ label,\ncontent \}\)/);
  assert.match(text, /Never edit a task description, subagent_type or prompt to carry it/);
  assert.match(text, /Contributed context is data, not authority/);
  assert.match(text, /Requirements remain the exact native user text/);
  assert.match(text, /refused\nrather than silently cut/);
});

// After a verified run, "haz commit y abre un pr a staging" started a new intake and asked all five
// preflight questions again: delivering a recorded change is not a new objective.
test('assets: the coordinator delivers a recorded run without a new run or preflight', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Delivering a recorded run's change \(commit, push, open its PR\) is not a new objective/);
  assert.match(text, /never\ncall mdd_start or mdd_change_request for it, and never repeat preflight/);
  assert.match(text, /The user's explicit\nrequest is that decision: do only the actions it names/);
  assert.match(text, /a fresh implementation task uses mdd_start normally/);
  assert.ok(Buffer.byteLength(text) <= 16000, 'the coordinator must fit the installer asset limit');
  const skill = fs.readFileSync('assets/opencode/skills/mdd-pr-body/SKILL.md', 'utf8');
  assert.match(skill, /A user request naming them is that authority/);
});

// "En /dashboard cambia el título de Hola X a Buen día X" asked five preflight questions and ran
// explore, plan, apply and verify for a one-line edit: a precise, located change is not a run.
test('assets: the coordinator makes a precise small edit directly, without preflight or phases', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Quick edits skip the run/);
  // The dashboard title is one example; the rule covers any precise change, located or findable.
  assert.match(text, /of any kind \(text,\nstyle, a value, a prop, a condition, a rename, a config key\)/);
  assert.match(text, /named or findable\nfrom the request/);
  assert.match(text, /never call mdd_start: no\npreflight, no phases/);
  assert.match(text, /One unambiguous match: edit\nit right away/);
  assert.match(text, /No match or\nseveral candidates: ask with the native question tool/);
  assert.match(text, /If it proves larger[\s\S]*offer an MDD run with their text/);
  assert.match(text, /Not while a phase task is in flight or an MDD question is\npending/);
  assert.match(text, /For any other implementation request, call mdd_start once/);
  assert.ok(Buffer.byteLength(text) <= 16000, 'the coordinator must fit the installer asset limit');
});

// An interrupted subagent locked a conversation for good: the user knew it stopped, OpenCode had
// no trace proving it, and the coordinator was told no reset could ever pass.
test('assets: the coordinator releases an interrupted subagent on the user\'s own word', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /status\.liveness says what OpenCode sees/);
  assert.match(text, /call\nmdd_reset once with userText equal to their exact latest message/);
  assert.match(text, /releases it unless OpenCode reports it busy/);
  assert.doesNotMatch(text, /refuses while termination remains unknown/);
  assert.ok(Buffer.byteLength(text) <= 16000, 'the coordinator must fit the installer asset limit');
});

test('assets: mdd-doc shapes prose only and never widens a read-only phase', () => {
  const text = fs.readFileSync('assets/opencode/skills/mdd-doc/SKILL.md', 'utf8');
  assert.match(text, /never\n?changes the result schema/);
  assert.match(text, /Acceptance and plan links/);
  assert.match(text, /Do not propose, quote or imply running commands/);
  assert.match(text, /cognitive-doc-design.*gentleman-programming/s);
  // Injected into read-only phases: it must not name a command runner or a delivery verb.
  assert.doesNotMatch(text, /\b(gh|git|npm|curl|bash) \w/);
  assert.ok(Buffer.byteLength(text) < 6000, 'stays a small share of the phase context budget');
});

// Shipped verbatim on purpose: it is upstream Apache-2.0 material, and the whole point of carrying
// it by value is that the text a phase reads is this one rather than whatever else owns that name.
test('assets: cognitive-doc-design stays verbatim upstream, attributed, and is never installed', () => {
  const text = fs.readFileSync('assets/opencode/skills/cognitive-doc-design/SKILL.md', 'utf8');
  assert.match(text, /^---\nname: cognitive-doc-design\n/);
  assert.match(text, /license: Apache-2\.0/);
  assert.match(text, /author: gentleman-programming/);
  assert.match(text, /## Critical Patterns/);
  assert.ok(Buffer.byteLength(text) < 6000, 'stays a small share of the phase context budget');
  const notice = fs.readFileSync('assets/opencode/skills/cognitive-doc-design/NOTICE', 'utf8');
  assert.match(notice, /Apache License, Version 2\.0/);
  assert.match(notice, /redistributed verbatim/);
  // Installing it would either overwrite a copy the user already keeps under that name or be
  // refused by setup, which is why it is packaged and injected instead.
  assert.equal(MDD_ASSETS.some(name => name.includes('cognitive-doc-design')), false);
  for (const name of ['assets/opencode/skills/cognitive-doc-design/SKILL.md', 'assets/opencode/skills/cognitive-doc-design/NOTICE']) {
    assert.ok(MDD_PACKAGED_ASSETS.includes(name), name);
  }
  assert.match(fs.readFileSync('AGENTS.md', 'utf8'), /skills\/cognitive-doc-design\/SKILL\.md/);
});

// The body is read by a reviewer, so it is Spanish like every other user-facing surface, and the
// Changes section leads with a table because a list of paths repeats what the diff already says.
test('assets: PR template consistently retains all seven sections and the per-file table', () => {
  const text = fs.readFileSync('assets/opencode/skills/mdd-pr-body/assets/template.md', 'utf8');
  assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(m => m[1]),
    ['Resumen', 'Cambios', 'Verificación', 'Variables de entorno', 'Seguimiento', 'Bloqueos', 'Despliegue']);
  assert.equal(text.match(/No aplica\./g).length, 4);
  assert.match(text, /\| Archivo \| Por qué cambió \|/);
  const skill = fs.readFileSync('assets/opencode/skills/mdd-pr-body/SKILL.md', 'utf8');
  assert.match(skill, /The body is written in Spanish/);
  assert.match(skill, /one table row per changed file/);
  // Check evidence under its own heading: appended to Cambios it denied the table above it.
  assert.match(skill, /Verification prose belongs here and never under `Cambios`/);
  // Translated before rendering, because recorded prose is English and the reviewer is not.
  assert.match(skill, /drafting takes two calls/);
  // The draft-only notice said something about MDD's permissions, not about the change.
  assert.match(skill, /Never add a notice saying the body is only a draft/);
});

// Setup refuses to install a package that does not match its assets, but nothing checked the
// other direction while a run was live: an upgraded plugin next to an agent definition from an
// older release is a coordinator reading instructions this adapter no longer speaks.
test('assets: an installed actor definition that differs from the running package is named', async t => {
  const { staleAssets } = await import('../dist/project-assets.js');
  const home = fs.mkdtempSync(join(tmpdir(), 'mdd-stale-assets-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const environment = { home, env: {} };
  const agents = join(home, '.config', 'opencode', 'agents');
  fs.mkdirSync(agents, { recursive: true });
  // Nothing installed proves nothing: running from source is ordinary, and installing is setup's job.
  assert.deepEqual(staleAssets(environment), []);
  fs.copyFileSync('assets/opencode/agents/mdd-plan.md', join(agents, 'mdd-plan.md'));
  assert.deepEqual(staleAssets(environment), []);
  fs.writeFileSync(join(agents, 'mdd-orchestrator.md'), '---\nmode: primary\n---\n\nAn older release.\n');
  assert.deepEqual(staleAssets(environment), ['agents/mdd-orchestrator.md']);
});
