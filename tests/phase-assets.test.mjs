import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

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
test('assets: the coordinator asks approval only natively, tracks inline steps and drafts PRs with the tool', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /Never end a phase report with an approval question of your own/);
  assert.match(text, /only approval is the native question[\s\S]*same turn as the report/);
  assert.match(text, /affirmative typed in the\nchat approves nothing/);
  assert.match(text, /keep the native todo list/);
  assert.match(text, /Do not mirror the MDD phases there/);
  assert.match(text, /Never\nhand-write the body with gh, git or a template of your own/);
});

// A user answered an approval question in their own words and the run was thrown away; the
// coordinator also needs to know it may ask its own questions, and when it may not.
test('assets: the coordinator recovers an unanswered approval instead of losing the run', () => {
  const text = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(text, /answers that question in their own words instead of choosing an option/);
  assert.match(text, /mdd_status still holds the same question/);
  assert.match(text, /ask it yourself with the native question tool while no MDD question is pending/);
  assert.match(text, /While one is pending, it is the only question/);
  assert.match(text, /scope phase[\s\S]*re-opens exactly\nthat question/);
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

test('assets: PR template consistently retains all six sections', () => {
  const text = fs.readFileSync('assets/opencode/skills/mdd-pr-body/assets/template.md', 'utf8');
  assert.deepEqual([...text.matchAll(/^## (.+)$/gm)].map(m => m[1]),
    ['Summary', 'Changes', 'Environment variables', 'Follow-ups', 'Blockers', 'Deployment']);
  assert.equal(text.match(/Not applicable\./g).length, 4);
});
