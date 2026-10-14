# Context handoffs that avoid rediscovery

## Objective and scope

Pass the active checkout explicitly to MDD actors, reuse pertinent observed capability limitations, and make existing evidence handoffs compact and checkable. The session audit found repeated wrong-path lookups and unavailable-index probes; identical source reads alone did not prove waste.

The user approved starting with these two recommendations. Reuse existing coordinator context and artifact prose; do not add a cache, schema, automatic capability detector, or tool prohibition. Preserve independent Apply/Verify inspection, applicable checks, source freshness, permissions, approval, and instructions by value. Standalone observations have no new persistence channel. Dependency preparation is explicitly authorized: locked packages from `https://registry.npmjs.org`, without credentials or install scripts, using isolated configuration/cache. No push, PR, other remote access, or snapshot deletion is authorized.

## Delivery and environment

- Branch: `feat-analisis-mdd`; initial boundary: `683c7452a5e48385669d7bcd4d573a55054322c7`.
- Delivery strategy: `ask-on-risk`; initial forecast was approximately 420 authored changed lines; actual work-unit total is 526 including tracking (318 in CH-1, 208 in CH-2). User selected `stacked-to-main`: future slice 1 is `683c745..4efe877`; slice 2 is `4efe877..646931f`. Only local commits are authorized; no PR publication is authorized. Final tracking-only closure adds six authored lines, for 532 accumulated lines.
- RDD: off, decided by `clone_local`; do not start review or toggle the preference. Assess writer diffs for ordinary verification routing.
- Runtime: Node 26.9.0, npm 11.19.1. Anonymous isolated `npm ci --ignore-scripts --no-audit --no-fund` installed 396 packages; package/lock hashes stayed unchanged and local TypeScript 7.0.2 is available. Tests load `dist`, so rebuild before test execution. No source-mutating normalizer is configured.
- TDD: applicability-based test-first, no configured override found in `mdd.config.json`. Observe RED, GREEN, then refactor with focused tests green.
- Engram mirror: pending because explicit-project saves have returned `session_project_mismatch`. Topic: `odd/context-handoffs/tasks`; locator: `odd/tasks/context-handoffs.md`. Preserve local progress until the mirror is available.

## Tasks

- [x] **CH-1 — Bind actor orientation and reuse scoped capability observations.**
  - Route: delegated direct; preparation and changes span multiple non-trivial source, instruction, test, and documentation files.
  - Add shared prompt data for runtime directory and host worktree in main, risk, and standalone dispatch. Keep both identities distinct and non-overridable by contributed context.
  - Describe pertinent negative-capability observations through existing context: identity, observed failure, fallback, and invalidation conditions. Advisory only; reconsider on restart/environment change or contradictory evidence.
  - Acceptance: expanded dispatch/retry/fallback prompts retain workspace binding; later actors receive scoped observations without new permissions or requirements; budget failures preserve the previous task.
  - Checks: focused `checkout handoff:` tests, build, typecheck, full suite, and `git diff --check`. Native transport fixtures provide runtime-boundary coverage; live model behavior and token savings remain unmeasured.
  - Evidence: after dependency preparation, behavioral RED observed 0 passed/10 failed against old source; GREEN and final focused checks observed 12 passed/0 failed. Build, typecheck, and `git diff --check` pass. Production/instruction/test/docs changes total +261/-7. Writer `npm test` timed out at 300 seconds; one independent bounded run completed in 270 seconds: 1,985 tests, 1,982 passed, 0 failed, 3 skipped (two Windows-privilege symlink tests and managed Engram smoke). Independent focused tests also passed 12/12; no severe candidate findings.
  - Assessment: medium from native `gentle-ai.review-assessment/v1` with the intended untracked document declared (318 authored lines including tracking). RDD stays disabled/unmanaged. Parent spot check `git diff --check` passed; source hashes stayed unchanged during independent verification. Work-unit commit: `4efe877eee20f1c06524cf9c5cf5b95d8649c961`; clean worktree immediately afterward.

- [x] **CH-2 — Make evidence handoffs compact and independently checkable.**
  - Route: delegated direct; instruction, test, and documentation preparation crosses the writer boundary.
  - Use existing prose for finding, source locator, observed basis, freshness conditions, and gaps; retain a useful locator in summaries when needed after compaction. Do not duplicate raw outputs automatically.
  - Planning starts from relevant evidence and closes gaps; Apply/Verify still inspect current source and run applicable checks independently.
  - Acceptance: evidence/limitations reach downstream prompts and declared compaction; stale evidence is not fresh proof; no authority, report schema, or structured coverage changes.
  - Correct only directly related obsolete context-budget/compaction documentation.
  - Checks: focused `evidence handoff:` tests, build, typecheck, full suite, and `git diff --check`. Live actor compliance and token savings remain unmeasured.
  - Evidence: RED 13 passed/4 failed; final GREEN 17 passed/0 failed. Initial full suite had three fallback/reset/strict-argument failures: redundant instruction prose raised serialized tasks above the existing 18,000-byte gate. Removed repeated compaction explanation and added measured-byte assertions without changing budgets or expected semantics. Targeted correction checks passed 9/9. Final build/typecheck/diff check pass; full suite: 1,990 total, 1,987 passed, 0 failed, 3 skipped (same environment skips as CH-1), 265 seconds. Final authored CH-2 diff +184/-12; native assessment medium, RDD disabled/unmanaged; parent diff-check spot check passed. Work-unit commit: `646931fae4ec9e71eededd369001932ae685e693`; clean worktree immediately afterward.

## Verification commands

```powershell
npm run build
node --import ./tests/isolate-home.mjs --test --test-name-pattern='checkout handoff:|evidence handoff:' tests/phase-runner.test.mjs tests/phase-assets.test.mjs tests/full-native.test.mjs
npm run typecheck
git diff --check
npm test
```

## Progress and next step

Both units are verified and committed locally; CH-1 also has independent verification. CH-2's initial regressions were corrected without weakening transport limits or verification. Strategy is stacked PRs toward main; publication remains unauthorized. Next: compare equivalent live tasks to measure rediscovery and token savings, or prepare the recorded PR slices only after explicit publication authorization. Live actor compliance and measured token reduction remain unproven; the Engram topic mirror remains pending.
