# Route Verify failures to where they can be closed

## Problem and evidence

Run `e98bf034-1f5f-4bb3-a12c-08e520fd9a81` (`entrecuadras-mobile`, deliveries M3 session persistence) ended blocked after three Verify failures on the same requirement, DSP-R01. The recorded run file shows the chain:

- mdd-design passed while its artifact said "This is not fixed by the proposed protocol" and recorded DSP-D10 ("Residual R1 remains … verification cannot claim full DSP-R01"). The objective concern saying so was advisory only and could not stop the route.
- Verify #1 recommended "implementation **and design** rework". `#reworkTarget` could only return `mdd-apply`, and the correction prompt told Apply the user "chose to fix the implementation".
- Each rework replayed TSK-01…TSK-04 as separate actors. The vault actor could not reproduce Verify's ad-hoc probe ("closed the nearest case I could build"); the regression test came later, from another actor.
- Each Apply pass added one fallback (delete → demote → revocation marker) and each Verify found the next layer. Apply summaries reported `passed` while their own artifacts left DSP-R01 open.

The acceptance itself combined bounded completion (DSP-R03), "never restorable once reported failed" (DSP-R01) and a failure model where every write may land late and every cleanup may fail. No client-only fallback satisfies all three; the conflict needed a design or requirements decision.

## Changes

1. **Unmet requirements stop planning.** `unmet=[{requirementID,reason}]` on Plan, Design and Tasks; a passing report that names one is refused (`UNMET_PASS`). The failed phase offers rework to Spec (from Design) or Design/Spec (from Tasks) only when it named unmet requirements.
2. **Rework can return to planning.** `mdd_reset({scope:"rework", phase})` accepts `mdd-apply`, `mdd-design`, `mdd-spec` (high) or `mdd-plan` (low). A planning rework releases the held plan, verification and executed checks (and decisions for Spec), withdraws plan/implementation/check evidence and binds an empty Apply plan for the next epoch. Checkpoints and dossiers validate against `currentGeneration` (results since that rework).
3. **Verify attributes gaps and repeated failures recommend redesign.** Optional `cause` on not-verified/deviation rows. Status reports `reworkTargets`, `reworkable` (recommended), `reworkFrom` and `reworkReason`; a requirement failing again after a correction pass recommends Design/Plan. Without `phase`, rework after Verify still returns to Apply.
4. **Probes are executable.** Verify is given `.mdd/probes/<runID>/` under MDD's gitignored data root and told to save each probe there with its exact command.
5. **The Apply correction is one pass.** After a Verify rework, one actor (never workers) owns every remaining deliverable and completes them together in plan order (`completeRemaining`). Older step-by-step histories still replay.
6. **Closure is accounted for.** The correction pass must report `closure=[{id,status,evidence}]` for every structured finding of the failed Verify; an open entry cannot pass (`OPEN_CLOSURE_PASS`). Closure and unmet are appended to the artifact's links section.

## Verification

```powershell
npm run build
node --import ./tests/isolate-home.mjs --test tests/rework-routing.test.mjs tests/apply-batches.test.mjs tests/report-check.test.mjs tests/next-action.test.mjs tests/phase-report.test.mjs tests/phase-runner.test.mjs tests/full-native.test.mjs
npm run typecheck
git diff --check
npm test
```

Results are recorded under Progress.

## Limits

- Live actor compliance is unmeasured: the prompts ask Verify to classify causes and save probes, and Apply to reproduce before fixing; MDD validates structure, not that the probe really failed first.
- `cause` is optional and defaults to implementation; the repeated-failure rule compares requirement IDs from the previous Verify artifact's links section.
- Transfer of a reworked run keeps its existing Apply-only target rework.

## Follow-up: restated results that advance the route could not be restored

First reported here as local-store only; that was wrong. It affected every store.

- Symptom: after a refused report was restated with `mdd_phase_result` and the restated result advanced the route with no approval in between (automatic mode, next Apply batch, the route mdd-risk selected), any restart returned `restored: false` ("Checkpoint or progress cannot be validated for this parent").
- Cause (instrumented restore): `Checkpoint and progress correlation disagree`. The checkpoint settled the inline attempt (`attempt.id` = the restatement's UUID), but the progress marker settled with `callID` of the earlier delegated call and no `attemptID`. `#record`/`#recordRisk` ready the next phase (`#advance` → `#prepare`, which resets `mode` to `delegate`) before the final `#mark`, and `#mark` derived "inline" from the run's current mode.
- Fix: `#record` and `#recordRisk` capture whether their own attempt is inline before readying the next phase and pass it to `#mark`, whose `inline` parameter now defaults to the old derivation.
- Evidence: new `tests/inline-restatement-restore.test.mjs` — RED 1 passed / 3 failed (Apply restatement in `none` and `local`, risk restatement; the approval-stop control passed) on the unfixed source; GREEN 4/4. The apply-batches correction test now restarts after an inline restatement in the local store again.
- Final after the follow-up: `npm run typecheck` exit 0; `git diff --check` exit 0; `npm test` 2,093 tests, 2,090 passed, 0 failed, 3 skipped.

## Progress

- Dependencies: absent at start; `npm ci --ignore-scripts --no-audit --no-fund` installed 396 locked packages without manifest changes.
- Baseline before changes: `npm test` 2,080 tests, 2,077 passed, 0 failed, 3 skipped.
- Updated expectations that pinned the old behavior: Apply/plan/design/tasks key lists, the form check that refused more than one completed ID, and the rework test that completed one step per pass.
- New `tests/rework-routing.test.mjs` (9 tests): correction-pass workflow and legacy replay, planning rework and generations, verification causes and findings, design-cause and repeated-failure recommendations, unmet design → spec rework through restart, design failure without unmet, next action.
- One intermediate full run had a single `setup-ui` failure ("source first run without dist…") while sources were being edited mid-run; it passed in isolation and in the final run.
- Final: `npm run typecheck` exit 0; `git diff --check` exit 0; `npm test` 2,089 tests, 2,086 passed, 0 failed, 3 skipped (same environment skips as baseline).
- Delivery: the routing changes and this restore fix are separate commits; each passed the full suite on its own tree (2,086 and 2,090 passed, 0 failed). Integration with `origin/main` and publication follow.
