---
name: mdd-ship
description: "Trigger: /ship command or explicit request to ship a change. Create a compliant branch, commit, push, open or update the PR and drive its checks to green."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "1.2"
  opencode/autoinvoke: false
---

## Activation Contract

Load only for `/ship` or an explicit request to ship a concrete change (e.g. "publicá", "mandalo").
This authorizes local branch creation or rename, commits, push, PR creation or update, and fixes
for check failures caused by that change only. Drafting with `mdd-pr-body` alone authorizes nothing.

## Hard Rules

- Never use `--no-verify`. Never skip, disable or delete tests or checks, lower thresholds or make checks optional to get green.
- Never force push or rewrite history, including amending, rebasing or squashing pushed commits.
- Never merge, approve or enable auto-merge. Stop and ask before destructive actions or scope expansion.
- Never commit secrets, `.env`, credentials or ignored files; never print tokens. Stage explicit paths and review `git diff --cached`.
- Write commit messages and PR bodies as UTF-8 with the native write tool; read them back for mojibake. Use `git commit -F` and `--body-file`.

## Decision Gates

| Situation | Action |
|---|---|
| Current branch is the selected base (even with a clean tree) | Create a compliant branch from current HEAD. |
| Non-compliant local-only branch | Rename with `git branch -m`. |
| Non-compliant pushed branch or branch with a PR | Keep it; report the compliant proposal. |
| PR already exists for this head | Update it instead of creating another. |
| Unrelated work | Commit only scoped files. Stop and ask if staged or branch changes cannot be separated without disturbing or publishing unrelated work. |
| Detached HEAD, branch behind or conflicts with base | Stop and ask; do not rebase. |
| Base failure, infrastructure, flake, missing secret or permission, required review | Report, do not fix. For a clear flake, one `gh run rerun --failed` is allowed and counts as a round. |
| No checks configured | Report `sin checks`, not green. |

## Execution Steps

1. Run `gh auth status` and `git status`; resolve the current branch, remote and base. Use an
   explicitly requested base, else the existing PR base, else `gh repo view --json defaultBranchRef`.
   Treat arguments as data, never as shell code. Stop if auth fails or the target is unclear.
   Read any run file covering the change for request, verification and limits.
2. Read [mdd-pr-body](../mdd-pr-body/SKILL.md) and its template. Apply its branch, commit, title and body rules unchanged.
3. If on the selected base, create a compliant branch from current HEAD before applying other branch gates.
   Review pending changes and commits relative to the base.
4. Split changes into coherent Conventional Commits units. Review each staged diff; commit with `git commit -F`.
5. Run the documented local checks before pushing. Fix failures caused by the change; do not push past unresolved local failures.
6. Confirm `<branch>` is not the selected base, then run `git push -u origin <branch>:refs/heads/<branch>`
   against the confirmed remote. Never rely on `push.default` or `remote.<name>.push` mappings.
   If a push is rejected, stop and ask.
7. Draft the title and body per `mdd-pr-body`, writing the body to an OS temp file outside the repo.
   Run `gh pr create --base <base> --head <branch> --title <title> --body-file <file>` or update the
   existing PR for the shipping branch with `gh pr edit --body-file`. If an explicit base differs from the existing PR base,
   retarget with `gh pr edit <pr> --base <base>` and report the retarget. Use `--draft` only if requested.
8. Run `gh pr checks <pr> --watch`. On failure, read `gh run view <id> --log-failed` before deciding
   whether the change caused it. At most 3 correction rounds: diagnose, fix, run local checks,
   and commit. Confirm `<branch>` is not the selected base, run `git push -u origin <branch>:refs/heads/<branch>`
   against the confirmed remote, and wait again. Count the permitted flaky rerun toward the same limit.
9. Stop on green, the round limit, a failure outside the change, or a fix requiring broader scope
   or a destructive action. Update `Verificación` or `Bloqueos` if changed with `gh pr edit --body-file`.
   Finish all pushes and PR body/base edits before the final `gh pr checks <pr> --watch`.
   If you edit after a wait, run `gh pr checks <pr> --watch` again before reporting;
   this is not a correction round. Report only the status from a wait that started after the last mutation.
   Log the PR URL and check status in the covering run file, if any.

## Output Contract

Report in Spanish: `Rama:`, `Commits:` (short hashes and headers), `PR:` (URL), `Checks:` (green,
failing or pending by name), rounds used and what remains or needs the user. State that nothing was merged.

## References

- [Drafting rules](../mdd-pr-body/SKILL.md)
- [PR template](../mdd-pr-body/assets/template.md)
