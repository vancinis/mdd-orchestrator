import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

for (const role of ['propose', 'spec', 'design', 'tasks', 'apply', 'verify']) {
  test(`assets: ${role} uses native least-privilege frontmatter and strict handoff`, () => {
    const text = fs.readFileSync(`assets/opencode/agents/mdd-${role}.md`, 'utf8');
    const front = text.split('---')[1];
    assert.match(front, /\nmode: subagent\n/);
    const rules = Object.fromEntries([...front.matchAll(/^  ("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1].replaceAll('"', ''), m[2]]));
    assert.deepEqual(rules, {
      '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', skill: 'deny',
      ...(role === 'apply' ? { edit: 'ask', bash: 'ask', task: 'deny' } : {}),
      ...(role === 'verify' ? { edit: 'deny', bash: 'ask', task: 'deny' } : {}),
      external_directory: 'deny',
    });
    assert.match(text, /provider-generated strict result schema/);
    assert.match(text, /phase, runID and native callID/);
    assert.match(text, /outcome failed/);
    assert.match(text, /No unsolicited prose/);
    assert.doesNotMatch(front, /model:|tools:/);
    if (['apply', 'verify'].includes(role)) {
      assert.match(text, /not a sandbox/);
      assert.match(text, /[Aa]utomatic/);
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

test('assets: exploration gains only lookup capability and the coordinator only the gate', () => {
  const explore = fs.readFileSync('assets/opencode/agents/mdd-explore.md', 'utf8');
  const front = explore.split('---')[1];
  assert.deepEqual(Object.fromEntries([...front.matchAll(/^  ("\*"|\w+): (allow|ask|deny)$/gm)].map(m => [m[1].replaceAll('"', ''), m[2]])),
    { '*': 'deny', read: 'allow', glob: 'allow', grep: 'allow', skill: 'deny', bash: 'allow', task: 'deny', external_directory: 'deny' });
  assert.match(explore, /gh issue view\|list/);
  assert.match(explore, /refuses anything else, including gh writes/);
  assert.match(explore, /returns nothing is a finding, not a failure/);
  const orchestrator = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  assert.match(orchestrator, /^  bash: allow$/m);
  // Dispatching a phase is not a native decision point; MDD owns preflight and approvals.
  assert.doesNotMatch(orchestrator, /^    mdd-\w+: ask$/m);
  assert.match(orchestrator, /^    mdd-apply: allow$/m);
  assert.match(orchestrator, /^    "\*": deny$/m);
  assert.match(orchestrator, /refuses every other command, including gh writes/);
  assert.match(orchestrator, /reading sources still goes through a task/);
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
