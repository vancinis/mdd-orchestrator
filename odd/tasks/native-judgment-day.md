# Native Judgment Day

Provide explicitly requested, standalone Judgment Day through MDD's packaged OpenCode actors and skill, with models selectable in `mdd-ai config`.

## Intent and scope

MDD already configures models per actor but lacks Judgment Day actors and native dispatch. Reuse the existing model editor and native task transport; do not introduce a ninth phase, a second workflow engine, or a dependency on Gentle AI.

- Two blind, read-only foreground judges inspect the same immutable committed Git target.
- The parent waits for both results, corroborates severe findings, and requests correction authorization.
- At most two correction/rejudgment rounds; no delivery authority or automatic execution after Verify.
- Preserve active workflow ownership, pending interactions, transfer guards, and normal phase behavior.
- New actors, skill and references are namespaced under MDD; existing configurations remain valid.
- Dirty/untracked target material requires an explicitly authorized immutable snapshot; never silently exclude it.

## Tasks

- [x] JD-1 — Package configurable judge/fix actors and preserve phase-role separation. Model round trips, config editor, schema, installation, assets, telemetry and existing phase membership verified.
- [ ] JD-2 — Enable exact standalone actor dispatch with native read-only inspection and workflow guards. Check parallel judge admission, model policy settling, ownership, phase-result exclusion and adversarial tool/command denial.
- [ ] JD-3 — Package the explicit-request protocol, coordinator routing and usage documentation. Check complete installed skill/reference paths, immutable targets, authorization, round limits and full regression suite.

Each task uses delegated direct execution: preparation requires repository exploration and each work unit touches multiple non-trivial files. One writer works sequentially; the parent owns commits and native review.

## Acceptance and checks

- Existing `mdd-ai config` lists both judges and the fix actor with model/variant inheritance.
- Setup includes all namespaced agents and skill references without overwriting foreign assets.
- Two native foreground judge calls can be admitted before either completes without changing workflow state.
- Judge tools cannot mutate files, delegate, write memory, or execute unrestricted shell commands.
- JD outputs never become MDD phase reports; fix authorization cannot bypass live implementation ownership.
- Test-first policy: deterministic behavior tests observe RED, GREEN, then refactor; passive documents use structural checks. Source: default ODD policy; no configured TDD override found.
- Commands: `npm run typecheck`, `npm run build`, focused `node --import ./tests/isolate-home.mjs --test <task test files>`, `npm test`, `git diff --check`.
- Source-mutating normalization, if applicable, precedes final checks and review freeze.
- Native host smoke is pending unless separately authorized: it starts a service and uses authentication. Mocks alone do not prove live host concurrency.

## Delivery and review

- Branch: `fix-limits` (existing non-default working branch).
- Branch point / initial review boundary: `963895886e5786fb3af62ccb34ada3ecba4a9f51`.
- Forecast: 550–800 authored changed lines, advisory only; never omit tests or compress source to fit.
- User-selected delivery: multiple Conventional Commits on one branch toward main; `single-pr` organization. No push, PR creation, merge or global installation authorized.
- RDD: on, decided by global preference. Native review selects risk and requests candidate-scoped consent where applicable.
- Running authored lines: 0. Commit identities and review outcomes: pending.

## Progress and recovery

JD-1 complete: focused tests observed RED (140 pass / 9 expected failures), GREEN and post-refactor (149 pass / 0 failures); build, typecheck and parent `git diff --check` passed. Native worktree assessment was unassessable because new assets are untracked; do not treat this as low risk. Assess the exact committed work unit next.

Next: commit JD-1, assess its committed candidate, then implement JD-2 with the same bounded writer. The memory service binds this runtime session to project `mdd`, despite the repository detector returning `mdd-orchestrator`; recovery mirrors follow that existing session binding without inventing a session.
