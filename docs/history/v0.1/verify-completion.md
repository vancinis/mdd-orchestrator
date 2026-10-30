# Make Verify finish the runs it can

Raise the share of MDD runs that finish complete. Most stopped runs stop in Verify, and a large part
of those stops were not defects of the change: unobservable environments, checks that already
failed or timed out, decision-link bookkeeping and malformed reports. Borrow gentle-orchestrator's
rules where they fit: correct automatically within a bound, recheck only the findings, and block
only on what the change causes.

Branch: `feat/verify-completion`. Delivery: work-unit commits on the feature branch; push and PR
remain the user's decision. Test runner: `node:test` over `dist/` (`npm test`).

## Problem and evidence

Telemetry and session records from seven repositories (fixed route, version 2):

- Verify attempts: 11 passed, 69 failed and 47 refused as malformed.
- Of the failed Verify results, about half were real defects of the change. The rest: 11 needed an
  environment the workspace does not have (device, staging, live service, real worker), 7 were
  check failures outside the change (timeouts under load, already failing tests, missing
  variables), 6 were coverage bookkeeping and 9 other.
- The most frequent malformed reports were decision links ("D8 is not applicable to its
  scenarios", "the plan omits D4 on R2") and Verify links (invented link, omitted scenario), all of
  which `mdd_check_report` cleared in the actor's session because it checked form alone.
- Every failed Verify stopped for the user, and every correction was followed by a full Verify
  sweep, which turned single failures into chains of five to twenty Verify attempts.
- `mdd-ai retro` counted runs and failures but never said what share finished or why the rest
  stopped.

A second incident joined during the work: in the better-you workspace every approved interactive
version-3 entry failed with "Start does not match the actual native caller message" (OpenCode
2.1.4). OpenCode 2 runs each model step as its own assistant message, so the approval question ran
in a later message than the `mdd_adapt` call, and admission compared the proposing message with the
latest one. It was not caused by the session predating the plugin update.

## Specs

- **S1** Decision links are derived, not refused, in Plan, Tasks, the adaptive continuation and an
  adaptive entry that omits assignment decisions. Scenario coverage, dependencies and IDs are still
  refused.
- **S2** A scenario declared `evidence: "external"` while planning may be verified `external`
  (pending, with what to check and where). It is not a gap, it is listed in closures, ledgers and PR
  bodies, and nothing undeclared can be reclassified.
- **S3** A held check failing for a reason outside the change may be `environmental`: its own
  failing attempts first, then a corroborating execution with a different command. It does not
  block and is always reported.
- **S4** In automatic mode a failed Verify of the implementation goes to one Apply correction pass
  for every finding without stopping; the next Verify rechecks only the findings, keeps and re-binds
  the earlier rows, turns a lost check into a regression, and lists new problems as follow-ups. A
  second pass only after progress. Design or requirements causes, interactive mode, no progress or
  a spent bound stop for the user. `verify.automaticCorrections` 0–2, default 2. Adaptive routes
  publish the same bound as `status.correction`.
- **S5** `mdd_check_report` checks a report's links against what the run holds when the run is at
  that phase, with the runner's validators and wording.
- **S6** `mdd-ai retro` reports the completion rate per route, broken down by the recorded stop
  cause, with corrections and pending items; adaptive runs are counted from their own records.
- **S7** An adaptive operation approved by a native question in a later model step of the same
  turn is admitted; the question's own verified message becomes the caller.

## Tasks

| ID | Specs | Route | Status | Commit |
|---|---|---|---|---|
| T1 Decision links, external scenarios, environmental checks, Verify severity rules | S1–S3 | inline | done | `ba46236` |
| T2 Automatic correction and scoped recheck on the fixed route, setting, telemetry event | S4 | inline | done | `196acc3` |
| T3 Bounded correction published on adaptive routes | S4 | inline | done | `9c2197d` |
| T4 Report check against the held run | S5 | inline | done | `f8bacf9` |
| T5 Completion rate and stop causes in ledger, retro and telemetry report | S6 | inline | done | `8ff816a` |
| T6 OpenCode 2 suite pins the manual stop | S4 | inline | done | `38280fb` |
| T7 Caller rebinding after a native approval | S7 | inline | done | `8d9dc30` |
| T8 Docs: README, adapter guide, configuration, product contract, this record | S1–S7 | inline | done | this commit |

Route: inline. Known files, one coordinator; no unit benefited from a separate writer.
Risk: contracts other parts consume (Verify report schema, ledger rows, status projection,
coordinator instructions) and a consent boundary (T7). Mitigations: every new field is optional
and older records read unchanged; the runner's own validators are reused rather than duplicated;
T7 only rebinds to a message the question inspection already proved is the exact running call.

## Verification

```powershell
npm run build
node --import ./tests/isolate-home.mjs --test tests/acceptance.test.mjs tests/rework-routing.test.mjs tests/report-check.test.mjs tests/run-ledger.test.mjs tests/retro.test.mjs tests/adaptive-public.test.mjs tests/full-native.test.mjs tests/opencode-v2.test.mjs
npm run typecheck
git diff --check
npm test
```

## Log

- **L1** (2026-10-27, user): approved plan items 2–6 ("solo sobre esos hallazgos" for the recheck)
  after running the plugin update for item 1; earlier instruction "avanza automaticamente".
- **L2** (2026-10-27, user): "aprovechemos tambien de solucionar este problema … Start does not
  match the actual native caller message … debemos solucionarlo para todas las nuevas sesiones."
- T1: 797/797 in the affected suites before commit.
- T2: the first wiring made the plugin and runner default to automatic correction and 35 tests that
  pin the manual stop failed; the runner now defaults to the manual path and the plugin passes the
  setting (default 2). Focused suites 587/587, then 808/808 and 719/719 with the new tests.
- T3: 517/517 across the adaptive suites. T4: 523/523. T5: 353/353.
- T7, RED then GREEN: the new regression answers the approval in a new assistant message of the
  same turn. Without the fix it fails with the exact production error ("Start does not match the
  actual native caller message", from `intake` via `#admitAdaptive`); with it, it passes, and the
  adaptive, native-intake, plugin and full-native suites pass (the two failures in that batch were
  T6, fixed by pinning the manual stop).
- Production evidence for T7 read from the local OpenCode 2 database, read-only: session
  `ses_e866cea4cffeoTp8ttwofzd0oP` (better-you), entry proposed in assistant message 2367, approval
  question in message 2374, error recorded on that question part.
- Full run on the finished source (`8d9dc30` plus these docs): `npm test` 2,798 tests, 2,795
  passed, 0 failed, 3 skipped (the usual environmental skips). `npm run typecheck` exit 0.
  `git diff --check` exit 0. Baseline before this work: 2,778 tests, 2,775 passed.
- The independent reviewer subagent could not run earlier in this work (organization
  authentication error); no review findings exist for this change.
- Not yet observed: a live model run through automatic correction or the rebinding. The installed
  plugin changes only after `mdd-ai update` and an OpenCode service restart, which is the user's
  decision.
