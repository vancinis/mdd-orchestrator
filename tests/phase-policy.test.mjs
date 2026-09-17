import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { phasePermissions, toolTargets, fileDigest, cleanupInstructions, docInstructions, assertGithubLookup, allowedTool } from '../dist/phase-policy.js';

const rules = [{ permission: '*', pattern: '*', action: 'deny' }, { permission: 'read', pattern: '*', action: 'allow' }];
function root(t) { const path = mkdtempSync(join(tmpdir(), 'mdd-policy-')); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }
test('capability policy requires native ask for Apply and Verify; never shell allow', () => {
  phasePermissions('mdd-apply', [...rules, { permission: 'edit', pattern: '*', action: 'ask' }, { permission: 'bash', pattern: '*', action: 'ask' }]);
  phasePermissions('mdd-verify', [...rules, { permission: 'bash', pattern: '*', action: 'ask' }]);
  // Lookup-only Explore may skip native consent; actors that run project code may not.
  const shellAllow = [...rules, { permission: 'bash', pattern: '*', action: 'allow' }];
  phasePermissions('mdd-explore', shellAllow);
  for (const phase of ['mdd-plan', 'mdd-apply', 'mdd-verify']) assert.throws(() => phasePermissions(phase, shellAllow));
  assert.throws(() => phasePermissions('mdd-verify', [...rules, { permission: 'edit', pattern: '*', action: 'ask' }]));
  assert.throws(() => phasePermissions('mdd-plan', [...rules, { permission: 'skill', pattern: '*', action: 'allow' }]));
});
test('native edit and patch targets remain scoped; Verify cannot edit', t => {
  const path = root(t);
  assert.deepEqual(toolTargets(path, 'mdd-apply', 'write', { filePath: 'new.ts' }), [join(path, 'new.ts')]);
  for (const filePath of ['../escape', '.git/config', '.opencode/agents/override.md', 'mdd.config.json', 'NUL', 'file:stream']) assert.throws(() => toolTargets(path, 'mdd-apply', 'edit', { filePath }));
  assert.throws(() => toolTargets(path, 'mdd-verify', 'apply_patch', { patchText: '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch' }));
  assert.throws(() => toolTargets(path, 'mdd-apply', 'apply_patch', { patchText: '*** Begin Patch\n*** Update File: a\n*** Move to: ../escape\n*** End Patch' }));
});
test('native command guard rejects delivery/composition/external workdir but does not execute commands', t => {
  const path = root(t);
  assert.deepEqual(toolTargets(path, 'mdd-verify', 'bash', { command: 'npm test', workdir: path }), []);
  for (const command of ['git commit -m x', 'git push', 'gh pr create', 'npm run publish', 'npm test; git push', 'bash script.sh', 'curl example.com', 'npm install lodash', 'npx unknown-tool', 'Invoke-WebRequest example.com', 'cd ..', 'echo $(pwd)']) assert.throws(() => toolTargets(path, 'mdd-apply', 'bash', { command }));
  assert.throws(() => toolTargets(path, 'mdd-verify', 'bash', { command: 'npm test', workdir: '..' }));
});
test('read-only GitHub lookups are allowlisted by subcommand', t => {
  const path = root(t);
  for (const command of ['gh issue view 389', 'gh issue list --limit 5', 'gh pr view 12 --comments',
    'gh pr diff 12', 'gh repo view --json name', 'gh search issues 389', 'gh pr list']) {
    assert.deepEqual(toolTargets(path, 'mdd-explore', 'bash', { command, workdir: path }), [], command);
    assert.deepEqual(toolTargets(path, 'mdd-apply', 'bash', { command }), [], command);
  }
  for (const command of ['gh issue create --title x', 'gh issue comment 1 --body x', 'gh pr merge 3',
    'gh pr create', 'gh repo delete', 'gh api /user', 'gh auth token', 'gh issue view 1 -X POST',
    'gh issue view 1 --method DELETE', 'gh issue view 1 -F body=x', 'gh alias set x y']) {
    assert.throws(() => toolTargets(path, 'mdd-explore', 'bash', { command }), command);
  }
  // Exploration runs lookups only; project code stays out of its reach but not Verify's.
  for (const command of ['npm test', 'node script.js', 'git status']) {
    assert.throws(() => toolTargets(path, 'mdd-explore', 'bash', { command }), /read-only GitHub lookups/, command);
    assert.deepEqual(toolTargets(path, 'mdd-verify', 'bash', { command, workdir: path }), [], command);
  }
  for (const command of ['gh issue view 1; rm -rf .', 'gh issue view $(whoami)', 'gh issue view 1 | sh']) {
    assert.throws(() => toolTargets(path, 'mdd-explore', 'bash', { command }), command);
  }
});
test('the coordinator gate shares the same allowlist and refuses everything else', t => {
  const path = root(t);
  assertGithubLookup(path, { command: 'gh issue view 389', workdir: path });
  assertGithubLookup(path, { command: 'gh pr list' });
  for (const command of ['npm test', 'git status', 'gh issue create', 'gh api /user', 'gh issue view 1 -X POST']) {
    assert.throws(() => assertGithubLookup(path, { command }), command);
  }
  assert.throws(() => assertGithubLookup(path, { command: 'gh issue view 1', workdir: '..' }));
  for (const phase of ['mdd-explore', 'mdd-apply', 'mdd-verify']) assert.equal(allowedTool(phase, 'bash'), true, phase);
  for (const phase of ['mdd-plan', 'mdd-propose', 'mdd-spec', 'mdd-design', 'mdd-tasks']) assert.equal(allowedTool(phase, 'bash'), false, phase);
  assert.equal(allowedTool('mdd-explore', 'write'), false);
});
test('local cleanup injection includes exact content and digest without native skill capabilities', t => {
  const path = root(t);
  const dir = join(path, '.opencode/skills/mdd-cleanup'); mkdirSync(dir, { recursive: true });
  const content = '---\nname: mdd-cleanup\n---\nPreserve scope.\n'; writeFileSync(join(dir, 'SKILL.md'), content);
  const skill = cleanupInstructions(path);
   assert.equal(skill.content, readFileSync('assets/opencode/skills/mdd-cleanup/SKILL.md', 'utf8')); assert.equal(skill.digest, fileDigest(skill.path));
  assert.throws(() => toolTargets(path, 'mdd-plan', 'skill', { name: 'mdd-cleanup' }));
});
test('local doc injection uses the packaged file, not a same-named global skill', t => {
  const path = root(t);
  const dir = join(path, '.opencode/skills/mdd-doc'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: mdd-doc\n---\nShadowed instructions.\n');
  const skill = docInstructions(path);
  assert.equal(skill.content, readFileSync('assets/opencode/skills/mdd-doc/SKILL.md', 'utf8'));
  assert.doesNotMatch(skill.content, /Shadowed instructions/);
  assert.equal(skill.digest, fileDigest(skill.path));
  assert.match(skill.path, /assets[\\/]opencode[\\/]skills[\\/]mdd-doc[\\/]SKILL\.md$/);
  assert.throws(() => toolTargets(path, 'mdd-plan', 'skill', { name: 'mdd-doc' }));
});
