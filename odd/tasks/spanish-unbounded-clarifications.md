# Preserve complete Spanish clarification conversations

Remove arbitrary clarification text ceilings and require Spanish user-facing MDD questions, without weakening consent or changing English technical artifacts.

## Problem and authorized scope

Clarification questions are copied into 200-byte context labels, so an accepted native answer can fail during contribution. Separate runtime and durable field limits reject longer prose. English tool-argument instructions conflict with the Spanish conversational contract.

Change clarification validation, context contribution, durable round trips, shipped coordinator instructions, tool guidance, regression tests, and relevant documentation. Preserve types, nonempty values, option uniqueness/counts, exact answer matching, native ownership and approval checks, and genuine aggregate storage/transport bounds. No global installation, push, PR, or unrelated limit removal.

## Work unit

- [x] T1 — Deliver complete Spanish clarification conversations: observed failing regressions, removed arbitrary prose caps, preserved exact question and answer as context content under a short label, clarified the Spanish conversational exception, updated docs, and verified the full suite.
  - Route: delegated direct; multi-file implementation and reading that prepares writes require one bounded writer.
  - Acceptance: long multibyte questions/options/answers round-trip without truncation or rejected answers; real-runner contribution succeeds; approval stays separate; shipped/installed coordinator and tool instructions require Spanish visible text; technical artifact language stays English.
  - TDD: default applicable test-first policy; no configured override found. Named regressions must demonstrate observed RED before source changes, then GREEN.
  - Checks: `npm run build`; `node --import ./tests/isolate-home.mjs --test --test-name-pattern="regression: clarification" tests/full-native.test.mjs tests/native-intake.test.mjs tests/question-checkpoint.test.mjs tests/phase-assets.test.mjs tests/setup.test.mjs`; `npm run typecheck`; `npm test`; `git diff --check`.
  - Runtime proof: real runner with isolated mocked native host and durable storage; live model behavior is not deterministic proof.
  - Rollback boundary: clarification validators/context and Spanish conversational instructions with their tests/docs; no unrelated runtime policy changes.
  - Commit: `16ffba6` on existing `fix-limits` feature branch; `fix(mdd): preserve complete Spanish clarification conversations`, no AI attribution.

## Delivery and progress

- Branch point / first review boundary: `57b0857c9374204dd2ddfc745f62b229107a5f10`.
- Delivery strategy: ask-on-risk; forecast 220–360 authored changed lines, generated files excluded. Ask once before committing if actual count exceeds approximately 400.
- RDD: on, decided by global; native assessment and candidate consent remain separate.
- Baseline: clean worktree; Node 26.9.0 supported. `npm ci` completed without manifest/lock changes; reported 9 existing dependency audit vulnerabilities, not remediated in this scope.
- Observed RED: named regressions failed 7/8 before source changes, including the real 200-byte context-label rejection, question/answer field ceilings, durable roundtrip, and missing language guidance.
- Observed GREEN: named regressions passed 8/8; parent independently reran the exact named command and observed 8/8 passing. Build, typecheck, and `git diff --check` passed.
- Full suite: 1042 tests, 1040 passed, 0 failed, 2 skipped. Windows artifact symlink test requires unavailable privileges; installed Engram managed smoke requires `MDD_SMOKE_ENGRAM`.
- Functional proof: exact multibyte question/option/answer content survives durable settlement, restart, and real reconstructed phase dispatch; phase approval remains separate. Live model language compliance not exercised.
- Work-unit authored count: +215/-30 (245 lines), including tracking; below forecast threshold. Final normalization completed before functional checks.
- Review: initial current-worktree assessment was unassessable because the tracking document was untracked; no low-risk inference. Native committed-range assessment of `16ffba6` returned medium, `review_due: false`, `under_budget`. No candidate consent or receipt review started; this slice remains under budget, not approved.
- Commit identity: `16ffba6`; completion evidence recorded in the following tracking-only commit.
- Engram mirror: #6790 under authoritative session project `mdd`; detected repository project is `mdd-orchestrator`. Full document mirrored and read back by parent.
- Next step: local implementation complete. Global installation update, push, and PR remain separate user decisions; none performed. Dependency audit remediation and the two skipped environmental checks remain outside current proof.
