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
- No new execution-evidence service, automatic fail-open, broad orchestrator refactor, remote operation, push, PR, merge, or global installation.
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
  - Progress: user selected `Autorizar los cinco archivos`, explicitly approving these additional required surfaces: `src/phase-report.ts` (central version-specific schema instructions), `tests/phase-report.test.mjs` (new/legacy prompt coverage), `tests/apply-batches.test.mjs`, `tests/worker-state.test.mjs`, and `tests/opencode-v2.test.mjs` (explicit fresh-run structured fixtures and globally unique check IDs). The resumed writer hit a usage limit after adding 111 lines in `tests/acceptance.test.mjs`; no production changes or completed RED/GREEN evidence were returned. User explicitly requested resumption; preserve and inspect those tests before continuing. Do not fabricate compatibility through blanket fixture conversion.
  - Implementation checkpoint: `verificationVersion: 1` introduced; absent marker remains legacy. Initial meaningful RED: 19 acceptance failures and 1 checkpoint failure. Completed writer candidate: 26 files +767/-81; build/typecheck/diff check passed, 730 focused tests passed, full suite 1,795 total with 1,792 passed/0 failed/3 expected skips.
  - Independent verification found and the writer corrected one medium reporting defect: structured PR blockers now use the validated verdict rather than every historical nonzero exit; optional/recovered failures remain visible as evidence. Explicit legacy behavior retained. Correction RED: 4 failing regressions; GREEN: 7 regression cases, 211 focused tests; final full suite 1,802 total, 1,799 passed/0 failed/3 expected skips. Build/typecheck/diff check passed.
  - Independent recheck: PASS, 118 tests plus 6 runner-to-renderer probes passed, including required blocked/interrupted/failed checks and semantic gaps. Parent reran the 118-test PR/acceptance suite: passed. No live-model or independent execution/applicability attestation claimed.
  - Additional surfaces approved: user selected `Autorizar ambos archivos` for `tests/apply-batches-host-smoke.mjs:79–106` and `tests/opencode-v2-workers-host-smoke.mjs:69–71`, which construct fresh-run legacy fixtures and need explicit structured IDs/reports. Preserve legacy coverage; no production auto-conversion.
  - Commit: verified work-unit commit being recorded. Final unit: 27 files +858/-83 (941 authored lines excluding tracking), a coherent schema/replay/fixture compatibility change above the advisory task heuristic. Native risk: medium (`executable_change`), reassessed after correction; RDD remains disabled/unmanaged, no review lifecycle started.
- [ ] **SA-3 — Permit explicit continuation after failed Verify.** Reuse rework/retry; add narrowly scoped continuation of a settled failed verification and allow a fresh explicit task through existing intake. Preserve failed-run evidence and continuation provenance before releasing active ownership. Never manufacture workflow success.
  - Route: delegated direct; trigger: native-intake, lifecycle persistence and authorization changes.
  - Acceptance: explicit rework/retry/continue/new task; no implicit continuation; exact current native user-message proof; stale/replayed requests cannot release later work; pending child/question/transfer remains protected; failed archive preserves ownership; continuation is never stopped-child attestation; failure remains visible after restart and in retained/PR evidence.
  - Checks: build; native-intake, opencode-plugin, next-action, workflow, phase-runner, full-native, checkpoint, run-dossier and pr-body tests; typecheck; full suite; diff check.
  - Commit: pending. Native risk: pending. RDD: disabled/unmanaged.
- [ ] **SA-4 — Clarify Security/Judgment Day readiness and limits.** Strengthen existing parent immutable-target readiness protocol before paired dispatch; preserve identical independent judges; explain redaction-induced uncertainty and JD Fix protocol-vs-runtime boundaries. No new runtime lifecycle or permission expansion.
  - Route: delegated direct; trigger: coordinated multi-file agent/skill contract changes.
  - Checks: build; phase-assets, judgment-day, security-snapshot and opencode-plugin tests; typecheck; full suite; diff check.
  - Commit: pending. Native risk: pending. RDD: disabled/unmanaged.

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
- Strategy: `ask-on-risk`; user selected `Integración conjunta (Recommended)`, binding chain strategy to `feature-branch-chain`. Keep local work-unit commit boundaries on the integration branch; prepare child/tracker PRs only after separate publication authorization. Do not deliver structured Verify to main before explicit continuation is ready.
- Four coherent work units; schema compatibility may naturally exceed the per-task heuristic. Keep related behavior, tests, and docs together rather than splitting artificially or compressing code.
- Running authored changes excluding tracking/generated files: 247 committed. First local slice: `1f4b700..bc06e3e` (SA-1). Remaining slice/commit boundaries: pending.
- Push, PR creation and merge remain separate user decisions.

## Progress and recovery

- Exploration complete; branch initially clean and dependencies/compiled output absent.
- Offline installation completed successfully from the local cache: 396 packages installed, lifecycle scripts disabled, no network fallback.
- Authorized local preparation: `npm ci --offline --ignore-scripts --no-audit --no-fund --cache C:/Users/vanci/AppData/Local/npm-cache`. Do not fall back to network access on failure.
- Parent spot-checked composed mutation guidance and native reset attestation guards.
- Feature mirror: complete write attempted under `odd/subagent-improvements/tasks`, rejected with `session_project_mismatch`; pending in the detected project. Do not invent or rebind a session identity. Local document preserves progress.
- Next step: record SA-2 commit identity, then implement SA-3 explicit continuation and SA-4 under the selected joint-integration strategy. Explicit failed-Verify continuation is not implemented yet.
