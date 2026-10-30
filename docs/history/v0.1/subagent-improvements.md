# MDD subagent contract improvements

## Objective and authorization

Improve the existing thirteen packaged MDD subagents without adding another orchestration layer. The user approved the per-agent audit recommendations and explicitly selected structured verification, with the additional requirement that a failed verification must not prevent further work when the user explicitly requests continuation or another task.

Verification truth and permission to continue are separate: retain failed or incomplete evidence, never manufacture PASS, and do not waive unrelated ownership, security, publication, or scope restrictions.

## Problem and rationale

- Composed prompts permit source changes during planning and Verify despite role-specific prohibitions.
- Cleanup delivery and concurrency wording disagree with the current runtime.
- Handoffs need clearer evidence, assumptions, coverage gaps, and deferred integration checks.
- Existing verification lacks structured planned-check applicability and dispositions.
- Verify is the final phase of both routes; explicit continuation must reuse existing rework, retry, intake, and retirement mechanisms rather than invent a next phase.
- Security and Judgment Day need clearer inspection-readiness and enforcement-boundary guidance.

## Scope and constraints

- Existing phase prompts, check contracts, report/checkpoint/dossier compatibility, explicit failed-Verify continuation, regression tests, and adapter documentation.
- Preserve independent judges, immutable inspection, worker fences, partial work, exact native user-message proof, and legacy evidence without inventing structured proof.
- No new execution-evidence service, automatic fail-open, broad orchestrator refactor or global installation. After completing SA-1..4, the user explicitly authorized fetching `origin/main`, local integration and normal push to `https://github.com/vancinis/mdd-orchestrator.git` using configured Git authentication. No credential inspection/change, force-push or PR creation.
- RDD is off, decided by clone-local preference. Keep it off; native risk assessment is informational for delegated verification only.
- English technical artifacts; Spanish user conversation.
- One writer at a time, exact task-scoped edit surfaces supplied by the parent.
- Engram project detection and runtime session disagree; local document is authoritative until its complete mirror can be confirmed in the detected project.

## Work units

- [x] **SA-1 — Align phase contracts and evidence handoffs.** Remove contradictory mutation guidance; improve Explore/Risk/Propose/Spec/Design/Plan/Tasks/Apply handoffs; fix cleanup-path delivery, scoped-worker hints, fallback guidance, and stale concurrency wording. Preserve existing envelopes and provenance. Test final composed prompts, contextual exploration, fallback and worker lanes.
  - Route: delegated direct; trigger: multi-file nontrivial changes and preparation for writing.
  - Checks: build; phase-assets, full-native, native-fallback, workers-native, apply-batches tests; typecheck; full suite; diff check.
  - Progress: implementation verified and committed; 17 files, 220 insertions and 27 deletions before tracking changes. Added regressions observed 18/18 RED, then 18/18 GREEN. Five-file focused suite: 292 passed. Build/typecheck/diff check passed.
  - Full suite after user-authorized stale concurrency assertion correction: 1,759 total, 1,756 passed, 0 failed, 3 skipped. Skips: two Windows symlink-privilege cases and optional Engram smoke. No live model smoke.
  - Independent verification: PASS, no actionable findings; 53 tests passed (18 focused, 29 phase-report, 6 singular/context/checker regressions), typecheck/diff check passed. Parent independently reran the 29-test phase-report suite: all passed.
  - Commit: `bc06e3e` (`fix(agents): align phase contracts and evidence handoffs`). Native risk: high/unassessable because the untracked task document needed an inventory declaration; independent verification completed without starting RDD. RDD: disabled/unmanaged.
- [x] **SA-2 — Add structured verification with legacy compatibility.** Version new-run contracts before planning; identify planned checks, requiredness/applicability, execution evidence and dispositions; reject inconsistent or incomplete required check accounting without treating optional failures as mandatory. Preserve legacy contracts during resume and distinguish their evidence strength. Preserve the marker across checkpoints/dossiers/transfer.
  - Route: delegated direct; trigger: schema/runtime changes across multiple nontrivial files.
  - Acceptance: unique IDs, exactly one disposition per held check, honest execution references, required failure/omission cannot pass, justified conditional non-applicability and replacements, optional failures visible, supplemental failures accounted for, repeated commands distinguishable, legacy replay, downgrade rejection, restart/transfer persistence.
  - Checks: build; acceptance, report-check, phase-runner, checkpoint, run-dossier, transfer, full-native, pr-body and phase-assets tests; typecheck; full suite; diff check.
  - Scope: user approved additional version-specific schema and fixture surfaces in `src/phase-report.ts`, `tests/phase-report.test.mjs`, `tests/apply-batches.test.mjs`, `tests/worker-state.test.mjs`, and `tests/opencode-v2.test.mjs`. An interrupted writer resumed from preserved partial tests at the user's request. Fresh fixtures are explicit; no production conversion fabricates legacy proof.
  - Implementation checkpoint: `verificationVersion: 1` introduced; absent marker remains legacy. Initial meaningful RED: 19 acceptance failures and 1 checkpoint failure. Completed writer candidate: 26 files +767/-81; build/typecheck/diff check passed, 730 focused tests passed, full suite 1,795 total with 1,792 passed/0 failed/3 expected skips.
  - Independent verification found and the writer corrected one medium reporting defect: structured PR blockers now use the validated verdict rather than every historical nonzero exit; optional/recovered failures remain visible as evidence. Explicit legacy behavior retained. Correction RED: 4 failing regressions; GREEN: 7 regression cases, 211 focused tests; final full suite 1,802 total, 1,799 passed/0 failed/3 expected skips. Build/typecheck/diff check passed.
  - Independent recheck: PASS, 118 tests plus 6 runner-to-renderer probes passed, including required blocked/interrupted/failed checks and semantic gaps. Parent reran the 118-test PR/acceptance suite: passed. No live-model or independent execution/applicability attestation claimed.
  - Additional surfaces approved: user selected `Autorizar ambos archivos` for `tests/apply-batches-host-smoke.mjs:79–106` and `tests/opencode-v2-workers-host-smoke.mjs:69–71`, which construct fresh-run legacy fixtures and need explicit structured IDs/reports. Preserve legacy coverage; no production auto-conversion.
  - Commit: `e7d6590` (`feat(verify): validate structured checks and preserve legacy evidence`). Final unit: 27 files +858/-83 (941 authored lines excluding tracking), a coherent schema/replay/fixture compatibility change above the advisory task heuristic. Native risk: medium (`executable_change`), reassessed after correction; RDD remains disabled/unmanaged, no review lifecycle started.
- [x] **SA-3 — Permit explicit continuation after failed Verify.** Reuse rework/retry; add narrowly scoped continuation of a settled failed verification and allow a fresh explicit task through existing intake. Preserve failed-run evidence and continuation provenance before releasing active ownership. Never manufacture workflow success.
  - Route: delegated direct; trigger: native-intake, lifecycle persistence and authorization changes.
  - Acceptance: explicit rework/retry/continue/new task; no implicit continuation; exact current native user-message proof; stale/replayed requests cannot release later work; pending child/question/transfer remains protected; failed archive preserves ownership; continuation is never stopped-child attestation; failure remains visible after restart and in retained/PR evidence.
  - Checks: build; native-intake, opencode-plugin, next-action, workflow, phase-runner, full-native, checkpoint, run-dossier and pr-body tests; typecheck; full suite; diff check.
  - Progress: writer completed 12 files +621/-25; initial RED 7 regressions; final 640 focused passed, full suite 1,823 total/1,820 passed/0 failed/3 expected skips, build/typecheck/diff check passed. User approved the narrow `src/local-files.ts` `.continued.json` destination extension; fixed-path/link protections preserved.
  - Independent check found and the writer corrected a high restart replay defect: continuation now checks validated persisted consumed IDs as well as live consent and archives their union, without reviving historical question receipts. Two new tests observed RED, then three replay/retention cases GREEN. Final writer checks: 305 focused tests passed; full suite 1,825 total, 1,822 passed/0 failed/3 expected skips; build/typecheck/diff check passed.
  - Independent recheck: PASS, 27 matching tests and 3 restart/receipt-isolation probes passed. Parent reran typecheck successfully. Actual API: `mdd_reset({scope:"continue",runID,userText})`; fresh authenticated `mdd_start` can proceed after settled failed Verify; optional `mdd_pr_body.runID` retrieves retained failure evidence. Failure remains false/blocked in historical records.
  - Commit: `d2a4402` (`feat(workflow): allow explicit continuation after failed verification`). Final unit: 12 files +652/-25 (677 authored lines), including durable archival and replay safety tests. Native risk: medium (`executable_change`), reassessed after correction; independent verification completed. RDD: disabled/unmanaged.
- [x] **SA-4 — Clarify Security/Judgment Day readiness and limits.** Strengthen existing parent immutable-target readiness protocol before paired dispatch; preserve identical independent judges; explain redaction-induced uncertainty and JD Fix protocol-vs-runtime boundaries. No new runtime lifecycle or permission expansion.
  - Route: delegated direct; trigger: coordinated multi-file agent/skill contract changes.
  - Checks: build; phase-assets, judgment-day, security-snapshot and opencode-plugin tests; typecheck; full suite; diff check.
  - Results: 5 structural assertions RED, then 5 GREEN. Build/typecheck/diff check passed. Focused suite: 227 total, 226 passed/0 failed/1 expected Windows skip. Final full suite: 1,830 total, 1,827 passed/0 failed/3 expected skips. Parent reran the complete 227-test focused suite with identical result.
  - Independent verification: PASS; 5 SA-4 assertions, typecheck/diff check and structural comparison with actual immutable-inspection/security/admission code passed. No live Security/JD execution, model-obedience proof or native approval claimed. Metadata/paths unchanged; registry entries remain valid.
  - Commit: `10f06bb` (`fix(audit): clarify immutable readiness and evidence limits`). Unit: 8 files +155/-2 (157 authored lines). Native risk: high (`security` hot path); independent verification completed with RDD disabled/unmanaged.
- [x] **SA-5 — Integrate current main and publish the combined result.** User requested direct push to main and explicitly selected `Autorizar publicación`, permitting configured-Git fetch, local integration, checks and normal push only to the named origin repository.
  - Route: delegated direct; trigger: two textual conflicts and coordinated semantic integration across runtime/tests. Parent owns all remote operations and final merge commit/push; one bounded writer integrates locally.
  - Boundaries: local `4b7bb54`, fetched main `8d329dd52d72c7f8eba9b2f148a50b4e8103b005`, common base `1f4b700223b906a816d20d935edba837aecb49f7`. Five commits each side; incoming work adds project-knowledge capture/cache/routing/context delivery.
  - Acceptance: combine cache and continued-run fixed-path allowances; retain structured-fixture import with incoming memory server; assign unique check IDs in new-run knowledge fixtures; preserve absent packaged skill hints in restricted workers while delivering advisory catalog excerpts; preserve knowledge freshness/reservation/diagnostics isolation across explicit continuation; no verification/ownership/privacy regressions.
  - Checks: build/typecheck; focused knowledge/runtime/native/checkpoint/dossier/worker/acceptance/PR suites; full `npm test`; conflict-marker/diff checks; independent integration verification; parent spot check; normal push and exact remote-result readback. No package/lock changes expected.
  - Progress: pinned main integrated locally; both textual conflicts resolved preserving both features. Explicit fixture/unique-ID/scoped-hint corrections plus a continuation/fresh-start knowledge-isolation regression were added. No extra production fix required. Incoming project-knowledge tracking matches pinned main exactly; manifests/lock unchanged.
  - Evidence: semantic RED 9/142 failed, then targeted GREEN 55 passed. Build/typecheck and focused 766 tests passed. Combined full suite: 1,943 total, 1,940 passed/0 failed/3 expected skips. Independent integration verification: PASS, 206 actual tests passed and all six overlapping files checked against both parents. Parent spot-checked archive/replay ordering and reran typecheck; staged/working diff checks passed, no unmerged entries/markers.
  - Scope: 26 incoming paths staged, +2,652/-39 against the feature HEAD; hand edits limited to conflict composition and +61/-2 semantic test adaptations. Native risk medium; independent check completed. No live-host/model proof claimed.
  - Commit/publication: merge `4af3c3cf120cad3d797ef9542c99cf8f5dbc887f` preserves parents `4b7bb54` and `8d329dd`. Normal push to `origin/main` succeeded (`8d329dd..4af3c3c`); subsequent remote readback confirmed the exact full merge identity. No force, credential changes, PR or global installation. RDD stayed disabled/unmanaged.

## Verification policy

No configured TDD override was found. For meaningful deterministic behavior changes, observe RED with regression tests before production changes, then GREEN and refactor with tests green. Missing dependencies or compilation failure is not RED. Passive instruction improvements use structural and composed-prompt assertions.

Exact command pattern:

```text
npm run build
node --import ./tests/isolate-home.mjs --test <the task's named tests/*.test.mjs files>
npm run typecheck
npm test
git diff --check
```

No repository formatter script exists. Preserve UTF-8 without BOM, LF, and final newline in edited files; do not renormalize unrelated files. Run all source-mutating normalization before final functional checks.

RDD-off delegated work requires native risk assessment and proportional independent verification; unassessable/high requires a separate read-only verifier. Parent reruns one reported command before delivery.

## Delivery strategy and budget

- Branch: `feat-subagentes-improvements`.
- Initial boundary: `1f4b700223b906a816d20d935edba837aecb49f7`.
- Forecast: approximately 1,170–1,890 authored changed lines, excluding generated output and this tracking file.
- Initial strategy: `ask-on-risk` with user-selected `feature-branch-chain`/joint integration. SA-1..4 remain separate local work units. The user's later direct-main push request and explicit publication authorization override PR delivery planning: integrate all completed work with fetched main and publish together by normal push; no PRs. Structured Verify and explicit continuation stay together.
- Four coherent work units; schema compatibility may naturally exceed the per-task heuristic. Keep related behavior, tests, and docs together rather than splitting artificially or compressing code.
- Observed authored work-unit changes excluding tracking/generated files: 2,022 committed; net branch diff: 49 files +1,883/-135. Local slices: `1f4b700..bc06e3e` (SA-1), `bc06e3e..e7d6590` (SA-2), `e7d6590..d2a4402` (SA-3), `d2a4402..10f06bb` (SA-4). SA-2/SA-3 exceed the review-size heuristic because schema compatibility and durable continuation/replay tests are coherent units; reassess PR slicing/size exception only if publication is later authorized. Final count exceeds the original upper forecast by 132 lines because necessary compatibility and replay-regression coverage was retained.
- Current user authorization permits local integration and normal push to the named origin main through configured Git authentication. PR creation and any force operation remain unauthorized.

## Progress and recovery

- Exploration complete; branch initially clean and dependencies/compiled output absent.
- Offline installation completed successfully from the local cache: 396 packages installed, lifecycle scripts disabled, no network fallback.
- Authorized local preparation: `npm ci --offline --ignore-scripts --no-audit --no-fund --cache C:/Users/vanci/AppData/Local/npm-cache`. Do not fall back to network access on failure.
- Parent spot-checked composed mutation guidance and native reset attestation guards.
- Feature mirror: complete write attempted under `odd/subagent-improvements/tasks`, rejected with `session_project_mismatch`; pending in the detected project. Do not invent or rebind a session identity. Local document preserves progress.
- SA-1..4 are implemented, independently checked and committed locally. Their final required automated checks have no failures; expected full-suite skips are two Windows symlink-privilege cases and optional installed Engram smoke. No live-model smoke, live Security/JD review or global installation performed.
- SA-5 integration and source publication are complete. This final passive tracking update records the confirmed result; no implementation or publication decision remains. Global installation was not requested. Named Engram topic mirror remains pending because of the recorded project/session mismatch and current degraded availability; local tracking and session summaries retain recovery context.
