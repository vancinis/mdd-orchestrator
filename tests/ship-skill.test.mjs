import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const skillPath = new URL('../assets/opencode/skills/mdd-ship/SKILL.md', import.meta.url);
const commandPath = new URL('../assets/opencode/commands/ship.md', import.meta.url);

function readAsset(path) {
  const raw = fs.readFileSync(path);
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
  // Match BOM, CR, replacement characters and common ANSI/CP850 mojibake.
  assert.doesNotMatch(text, /[\uFEFF\r\uFFFD]|\u00C3[\u00B3\u00A9]|\u00C2\u00BF|\u00E2\u20AC\u201D|\u251C[\u2502\u00ED]|\u00D4\u00C7\u00F6/, path.pathname);
  assert.ok(text.endsWith('\n'), 'trailing LF');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(frontmatter, 'frontmatter block');
  return { meta: frontmatter[1], body: text.slice(frontmatter[0].length) };
}

test('mdd-ship has complete metadata and is hidden from model auto-invocation', () => {
  const { meta, body } = readAsset(skillPath);
  assert.match(meta, /^name: mdd-ship$/m);
  assert.match(meta, /^license: MIT$/m);
  assert.match(meta, /^metadata:\n(?: {2}[^\n]+\n)* {2}opencode\/autoinvoke: false$/m);
  assert.match(meta, /^ {2}author: "mdd-maintainers"$/m);
  assert.match(meta, /^ {2}version: "1\.2"$/m);
  assert.doesNotMatch(meta, /disable-model-invocation/);
  assert.match(meta, /^description: "Trigger: \/ship[^"\n]{1,235}"$/m);
  assert.ok(body.length <= 5000, `body length ${body.length}`);
  assert.deepEqual([...body.matchAll(/^## (.+)$/gm)].map(([, heading]) => heading), [
    'Activation Contract', 'Hard Rules', 'Decision Gates', 'Execution Steps', 'Output Contract', 'References',
  ]);
});

test('mdd-ship bounds CI corrections and reuses the existing drafting conventions', () => {
  const { body } = readAsset(skillPath);
  assert.match(body, /At most 3 correction rounds/i);
  assert.match(body, /Drafting with `mdd-pr-body` alone authorizes nothing/);
  for (const token of [
    'gh auth status', 'git commit -F', 'git push -u origin', 'gh pr create',
    '--body-file', 'gh pr edit', 'gh pr checks <pr> --watch', 'gh run view <id> --log-failed',
  ]) assert.ok(body.includes(token), token);
  for (const rule of [
    /Never use `--no-verify`/, /Never skip, disable or delete tests or checks/,
    /Never force push/, /Never merge/, /Never commit secrets/,
  ]) assert.match(body, rule);
  assert.doesNotMatch(body, /`hotfix\/`|BREAKING CHANGE/);

  const links = [...body.matchAll(/\]\(([^)]+)\)/g)].map(([, link]) => link);
  for (const link of ['../mdd-pr-body/SKILL.md', '../mdd-pr-body/assets/template.md']) {
    assert.ok(links.includes(link), `links to ${link}`);
  }
  for (const link of links) {
    assert.doesNotMatch(link, /^(?:[a-z]+:|\/)/i);
    assert.ok(fs.statSync(new URL(link, skillPath)).isFile(), `${link} resolves to a file`);
  }
});

test('mdd-ship branches from the selected base even with a clean tree', () => {
  const { body } = readAsset(skillPath);
  assert.match(body, /^\| Current branch is the selected base \(even with a clean tree\) \| Create a compliant branch from current HEAD\. \|$/m);
  assert.match(body, /^3\. If on the selected base, create a compliant branch from current HEAD\b/m);
});

test('mdd-ship guards both pushes and pins their destination instead of using push mappings', () => {
  const { body } = readAsset(skillPath);
  const guardedPush = /confirm(?:ing)? `<branch>` is not the selected base[\s\S]*?`git push -u origin <branch>:refs\/heads\/<branch>`/i;
  for (const step of [6, 8]) {
    const text = new RegExp(`^${step}\\. [\\s\\S]*?(?=^${step + 1}\\. )`, 'm').exec(body)?.[0];
    assert.ok(text, `step ${step} exists`);
    assert.match(text, guardedPush, `step ${step} confirms the branch before an explicit push`);
  }
  assert.doesNotMatch(body, /git push -u origin <branch>(?!:refs\/heads\/<branch>)/);
  assert.match(body, /never rely on `push\.default` or `remote\.<name>\.push` mappings/i);
});

test('mdd-ship honors and reports an explicit base override for an existing PR', () => {
  const { body } = readAsset(skillPath);
  assert.match(body, /explicitly requested base, else the existing PR base, else `gh repo view --json defaultBranchRef`/);
  assert.match(body, /[Ii]f an explicit base differs from the existing PR base,\s+retarget with `gh pr edit <pr> --base <base>` and report the retarget/);
});

test('mdd-ship reports only checks awaited after the last PR mutation', () => {
  const { body } = readAsset(skillPath);
  assert.match(body, /Finish all pushes and PR body\/base edits before the final `gh pr checks <pr> --watch`/);
  assert.match(body, /If you edit after a wait, run `gh pr checks <pr> --watch` again before reporting;\s+this is not a correction round/);
  assert.match(body, /Report only the status from a wait that started after the last mutation/);
});

test('/ship explicitly authorizes the current change and stops if the skill cannot load', () => {
  const { meta, body } = readAsset(commandPath);
  assert.equal(meta, 'description: "Publica el cambio actual: rama, commits, push, PR y checks en verde"');
  assert.match(body, /skill `mdd-ship` with the skill tool \(exact ID `mdd-ship`\)/);
  assert.match(body, /follow it for the current\s+change/);
  assert.match(body, /the user's explicit request/);
  assert.match(body, /If the skill cannot be loaded, stop[\s\S]*?do not ship without it/);
  assert.match(body, /data, not extra permission/);
  assert.equal([...body.matchAll(/\$ARGUMENTS/g)].length, 1);
  assert.doesNotMatch(body, /!`/);
});
