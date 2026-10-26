# Stop refusing reports over the length of their prose

Report prose has no per-field length limit. Line breaks and tabs fold into spaces instead of being
refused, and Verify lists every material limit instead of four at most.

## Problem and evidence

A finished `mdd-design` report came back unread:

> MDD could not read the mdd-design report, so no attempt was spent and nothing was re-run: decision
> D16 description "Extends D13 with matrix items N01-N20, each named by scenario ID…" is 653
> characters, above its 500-character limit. To fix it, shorten it.

`shortText` (`src/acceptance.ts`) defaulted to a 500-character cap. Similar caps of 250–2000
characters were applied to every prose field a phase reports: the acceptance goal (300), requirement
description and given/when/then, decisions, unmet reasons, closure evidence, check reasons and
equivalence, deliverable descriptions, `appliesWhen`, verification assessments, `changes` and
`limits` (250 each, four at most), `changes[].reason`, `noChangeReason` (2000), `delivered` (400/300),
concerns, the risk verdict (300–2000), security findings and limitations (300–2000), and the
adaptive contract, receipts and evidence. The same fields refused any line break or tab. None of
these caps protected anything. The bounds that do protect something are aggregate, and they still
apply: the composed phase prompt (96 KB, compacted toward 38 KB), the adaptive contract (24 KB) and
evidence (48 KB), the security assessment (20 KB), the checkpoint (16 MB) and the status budget.

## Changes

1. **`reportText`** replaces `shortText` for every report prose field. It has no length limit. It
   folds line breaks and tabs, with the spaces around them, into one space. It still refuses the
   control characters a terminal acts on (NUL, ESC, …), and names each one by code point and
   position.
2. **`summaryText`** is for adaptive receipt summaries. It keeps their line breaks, because a
   restored continuation compares the stored summary with the accepted report byte for byte.
3. **`shortText` now requires its bound** and is used only for exact one-line values: commands,
   identities MDD handed out, paths, and the security `evidence` quote, which is matched against
   one source line as written. It has no length limit there either.
4. **Verify `limits`** are no longer capped at four. They keep the 64-entry list bound. In the
   adaptive lane the evidence limits cap is now 16, the list bound, and the closure accepts 32.
5. **The checkpoint** accepts a changed-file reason of any length, matching the validator, so a
   recorded run stays resumable.
6. **Adaptive status projections** show `lastReceipt.summary` and the evidence and closure limits
   up to 500 characters each, because those fields are protected from the status budget. The
   stored data and the evidence readback keep them whole.
7. **The adaptive protocol** no longer caps `purpose`/`rationale` at 2000 characters. Its input
   documentation no longer advertises `maxLength: 500`, the 300-character goal or four limits.
8. **Prompts and docs.** The Verify schema says "limits lists each material limit as its own
   entry", which is shorter than before, so the Verify prompt does not grow. The security schema,
   `mdd-instructions.md`, `docs/opencode-adapter.md` and `docs/configuration.md` no longer describe
   the removed caps.

Not changed: identifier formats (1–64), paths (400/1000), the user's request text (12000 bytes),
list counts (64 entries, 32 deliverables/checks, 8 concerns/questions), the adaptive artifact
(12000 bytes) and every aggregate byte budget.

## Verification

```powershell
npm run build
node --import ./tests/isolate-home.mjs --test --test-name-pattern="regression: a design|regression: adaptive prose|report prose|long, many and multi-line|security prose has no length|risk and concern prose|a Verify report is refused once|checked exactly as the run" tests/acceptance.test.mjs tests/report-check.test.mjs tests/security.test.mjs tests/adaptive-low.test.mjs tests/full-native.test.mjs
npm run typecheck
git diff --check
npm test
```

## Progress

- Baseline before changes: `npm test` 2,628 tests, 2,625 passed, 0 failed, 3 skipped.
- Observed RED: the original source was stashed and rebuilt, then the new and updated tests were
  run against it, and six failed. The end-to-end route reproduced the reported failure: "MDD could
  not read the mdd-spec report, so no attempt was spent… is 803 characters, above its
  500-character limit". The others failed on the 300-character goal, the 1000-character security
  limitation, "Summarize material limits in at most four concise items", and the missing
  `reportText` export.
- GREEN: the targeted suites passed 431/431, and the end-to-end regression passed.
  `npm run typecheck` exit 0. `git diff --check` exit 0.
- First full run after the change: 2,637 tests, 2,629 passed, 5 failed, 3 skipped. All five were
  timeouts under load (`spawnSync ETIMEDOUT`, the 5-second git inspection limit, a git read
  timeout) in the CLI, judgment-day, opencode-v2, pr-direct and security-snapshot suites. Re-run in
  isolation, those files passed 175/175, with 1 skipped.
- Second full run: 2,637 tests, 2,633 passed, 1 failed, 3 skipped. The failure was `pack.test.mjs`,
  where `npm pack` hit its 30-second spawn timeout. That test passed in the first full run and
  again in isolation (1/1). Every test passed in at least one full run, and every failure was a
  timeout in a test this change does not touch.
- New tests: a 653+ character decision is held whole; prose has no length limit anywhere a phase
  writes it; folding and terminal-control refusal; long, many and multi-line Verify prose checks
  clean; risk and concern prose; security prose with the exact evidence quote; the adaptive lane
  through receipts, evidence and a cold restore; the fixed high route from spec to verify with a
  restart.
