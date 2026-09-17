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
    assert.match(text, /phase, runID and native callID/);
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

test('assets: exploration investigates freely and the coordinator is not a caged role', () => {
  const explore = fs.readFileSync('assets/opencode/agents/mdd-explore.md', 'utf8');
  assert.match(explore, /Use whatever helps/);
  assert.match(explore, /returns nothing is a finding, not a failure/);
  assert.match(explore, /do not change the project to answer it/);
  const orchestrator = fs.readFileSync('assets/opencode/agents/mdd-orchestrator.md', 'utf8');
  const front = orchestrator.split('---')[1];
  assert.match(front, /\nmode: primary\n/);
  assert.doesNotMatch(front, /permission|tools:/);
  assert.match(orchestrator, /mdd_reset/);
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
