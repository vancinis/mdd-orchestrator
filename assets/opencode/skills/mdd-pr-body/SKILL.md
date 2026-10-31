---
name: mdd-pr-body
description: "Trigger: user PR request, pull request body, branch name or commit message. Draft an evidence-backed PR description in Spanish, with Conventional Commits and Conventional Branch naming, without granting commit, push or PR creation authority."
license: MIT
metadata:
  author: "mdd-maintainers"
  version: "2.1"
---

## Activation Contract

Load when the user asks for a PR, a PR body, a branch name or a commit message. Draft only for the
change they mean.

## Sources

| Situation | Where the facts come from |
|---|---|
| There is an MDD run for the change | The run file `.mdd/runs/<id>.md` (request, decisions, plan, verification, limits) and its artifacts, plus `git diff <base>...HEAD --stat` for the file list. |
| Direct edit, no run | `git diff <base>...HEAD` and `git log <base>..HEAD`, where `<base>` is the PR target branch (ask if unclear). |

Read uncommitted changes with `git status` and mention them: they are not part of the PR until
committed.

## Conventions

### Branch names (Conventional Branch)

Format: `<type>/<description>`.

| Type | Use for |
|---|---|
| `feat/` | New behavior or capability. |
| `fix/` | Bug fix that follows the normal release flow. |
| `hotfix/` | Urgent fix for production that cannot wait for the normal flow. |
| `release/` | Release preparation, e.g. `release/v1.2.0`. |
| `chore/` | Everything else: docs, refactor, tests, build, CI, dependencies. |

- `<description>` is lowercase `a-z`, `0-9` and single hyphens, short and specific
  (`feat/pr-branch-conventions`). Dots only in `release/` versions. No leading, trailing or
  repeated hyphens or dots, no spaces, underscores or uppercase.
- An issue or ticket number may lead the description: `fix/issue-42-login-timeout`.
- Pick the type from the dominant intent of the change; it should match the PR title type
  (`feat` → `feat/`, `fix` → `fix/` or `hotfix/`, other commit types → `chore/`).
- If the current branch does not follow this, propose a compliant name. Rename or create branches
  only when the user asks.

### Commit messages and PR title (Conventional Commits 1.0.0)

Format: `<type>(<optional scope>)<optional !>: <description>`, then an optional body and footers
separated by blank lines.

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`,
  `revert`.
- Scope is a short lowercase noun for the area touched (`feat(pr): ...`); omit it when the change
  is broad.
- Description: imperative mood, lowercase start, no trailing period, about 72 characters max for
  the whole header.
- Breaking change: add `!` before the colon and a `BREAKING CHANGE: <what breaks and how to migrate>`
  footer.
- One commit per coherent unit of work. Do not mix unrelated changes in one commit; propose a split
  instead.
- Write messages in the language the repository's recent `git log` uses; default to English.
- The PR title uses the same header format and summarizes the whole PR.
- Never rewrite, amend or squash existing commits unless the user asks. If existing commits do not
  follow the convention, say so and suggest the PR title still does.

## Hard Rules

- Write the body in Spanish: a reviewer reads it. Commands, paths and identifiers stay verbatim.
- Use the template in [assets/template.md](assets/template.md). Keep its seven headings in order and
  write `No aplica.` where nothing applies.
- `Resumen` says what the change delivers and what it enables, not how it was built.
- `Cambios` has one row per changed file with why that file changed. If you do not know why, say
  so in the row; never invent a motive.
- `Verificación` lists only checks that actually ran, with their results, including the ones that
  failed or could not run. Without a run and without checks you ran, say it was not verified.
- `Bloqueos` lists failing checks, open gaps and limits from the run. Never claim readiness that the
  evidence does not support.
- Optional groups `Contexto y decisiones`, `Riesgos y limitaciones` and `Notas para revisión` may
  follow, in that order, only when they have content. Label interpretation as such.
- Never include secrets, private source excerpts or unrelated work.
- Drafting does not authorize creating branches, commit, push or opening the PR. Do those only when
  the user asks, using the drafted title, branch name, messages and body unchanged.

## Output Contract

Print, in this order:

1. `Rama:` the current branch, and a compliant proposal if it does not follow the convention.
2. `Título:` the Conventional Commits PR title.
3. `Commits:` only when there are uncommitted changes or the user asked for messages — the proposed
   commit messages, one fenced block each.
4. The final Markdown body in a single fenced block so the user can copy it.

Then one line saying nothing has been published.
