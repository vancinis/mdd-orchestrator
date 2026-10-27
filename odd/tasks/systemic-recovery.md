# Systemic recovery without abandoning conversations

Fix reproducible recovery defects across sessions while retaining authorization, durable-state and required-verification protections. Preserve the existing admission correction and failed execution history.

## Scope and constraints

- Authorized: systemic recovery, truthful failure routing, complete bounded handoffs, coordinator question handling, evidence-based integration execution diagnosis.
- Never edit live journals, discard or transfer the incident, waive required checks, weaken security deadlines or install dependencies. Publication authority is recorded below.
- Preserve existing modifications in adaptive-native.ts, native-intake.ts, phase-runner.ts and adaptive-native.test.mjs.
- Historical no-commit constraints are superseded by the explicit delivery authorization below; commit evidence remains pending parent publication.
- Source changes do not update an already loaded plugin or prove other live conversations recovered.
- Default test-first policy applies: build dist, observe deterministic RED, implement GREEN, then refactor. No project-specific TDD setting was found.

## Tasks

- [ ] R01 Correct repeated-failure routing: require an actual successful corrective Apply between failed Verifies. Preserve semantic design/requirements routing and planning-reset behavior; test restored history.
- [ ] R02 Separate confirmed result persistence from failed successor preparation. Preserve original diagnostic and genuine uncertainty fences; never replay accepted results. Test prompt overflow and persistence faults independently.
- [ ] R03 Distinguish execution/evidence gaps from semantic defects without waiving acceptance. Preserve mixed-cause precedence.
- [ ] R04 Deliver mandatory obligations and multi-file scope completely within bounded handoffs. Never advertise unavailable restored artifacts as retrievable; handle oversize payload without corrupting progress.
- [ ] R05 Correct recovery/question ownership across both hooks, fresh and restored sessions, with replay, active-work and stale-consent negative controls.
- [ ] R06 Diagnostic instrumentation is present; latest merged-main full suite is red (2759 passed, 1 failed, 3 skipped). Packaging timed out at its unchanged deadline. Descendant sampling unavailable; scheduling remains unjustified. Preserve package assertions and Git/CLI bounds; resolve aggregate failures before closure.

## Route and delivery

All tasks use delegated direct implementation: preparation requires code exploration and multiple non-trivial test/source files. One writer at a time. Independent verification applies when native risk is high or unavailable.

Forecast: approximately 900–1600 authored changed lines across the feature, subject to evidence. Approximately 400 lines per task is advisory, never a reason to omit coverage. Current delivery strategy: authorized direct-main commit and push by the parent. No PR planned.

### Superseding delivery authorization

The user explicitly authorized fetching latest main, committing and pushing directly to main through
the configured HTTPS origin, without force. This supersedes earlier no-commit/no-push and pending
authorization statements retained below as historical evidence. The parent owns publication; the
integration delegate may resolve and stage the conflict but must not commit or push.

The parent fast-forwarded main from `e3cdd41` to `23098af` and applied the retained stash
`98a21f155867bb213f78079cd8e5aec71eca5503`. The stash remains retained. Integration preserves
upstream unbounded report prose and adaptive artifacts, together with R01–R06 recovery and identity
protections. Transport/read-page and aggregate durable-record bounds remain distinct from individual
report/artifact size policy. Historical R06 timeout sensitivity and R05 real-host after-hook settlement
remain unresolved evidence boundaries regardless of the merged suite result.

## Verification

R01: `npm run build`; `node --import ./tests/isolate-home.mjs --test tests/rework-routing.test.mjs`; `npm run typecheck`. Tests import dist, so rebuild after source edits.

Later tasks: exact focused commands selected from their affected test files before implementation. Final acceptance requires `node --test tests/adaptive-native.test.mjs`, `npm run typecheck`, `npm run build`, and `npm test`. Historical full-suite deadline failures remain unresolved.

## Evidence and progress

### Latest main integration: resolved conflict, partial verification

Integrated against `23098af` after upstream `997bdd6` removed report-prose caps and `23098af`
removed individual adaptive artifact/report caps. The sole conflict in packaged actor instructions
now preserves both the bound-reader exception and upstream's identifier-validation wording, without
restoring the obsolete report size-limit wording. Inspected auto-merges in `src/acceptance.ts`,
`src/phase-runner.ts`, `tests/acceptance.test.mjs`, `tests/full-native.test.mjs` and the adapter guide:
unbounded prose, adaptive retention/compaction and record-overflow handling coexist with the retained
recovery, required-check, native identity and bounded-reader protections.

No additional production fix or test adjustment was needed. This was a pure conflict-text merge
and documentation clarification, so no meaningful product RED/fix cycle is claimed. The conflict
file was staged individually; the task document remains untracked for the parent's explicit staging.
No commit, push, remote operation, stash removal/reapplication or live runtime operation occurred.

Observed commands, in order, all foreground and after final instruction/adapter-document edits:

| Command | Exact result |
|---|---|
| `npm run build` | Exit 0 |
| `npm run typecheck` | Exit 0 |
| `node --test tests/adaptive-native.test.mjs` | 105 tests, 105 passed, 0 failed/cancelled/skipped; 39768.3205 ms |
| Nine-file command below | 770 tests, 770 passed, 0 failed/cancelled/skipped; 745365.0509 ms |
| `npm test` (exactly once, external timeout 1800000 ms) | Exit 1; 2763 tests, 2759 passed, 1 failed, 3 skipped, 0 cancelled; runner 774160.3056 ms, measured command wall 783162 ms |

```text
node --import ./tests/isolate-home.mjs --test tests/acceptance.test.mjs tests/phase-assets.test.mjs tests/phase-runner.test.mjs tests/checkpoint.test.mjs tests/full-native.test.mjs tests/report-check.test.mjs tests/adaptive-continuation.test.mjs tests/adaptive-low.test.mjs tests/security.test.mjs
```

The failing test is `package dry-run includes runnable build and exact owned assets without private
runtime data` (`tests/pack.test.mjs:22`): `npm pack elapsedMs=30037 code=ETIMEDOUT status=null
signal=SIGTERM`; test duration 30037.9779 ms. The internal 30000 ms deadline and packaging assertions
were unchanged. No aggregate retry or waiver followed. This reproduces timeout sensitivity but
does not establish its cause, stabilization, or a source regression from the merge.

The three skips are `artifacts: rejects a symlink artifact file without modifying its target`
(Windows file-symlink privilege), `symlink content is never followed or emitted` (Windows symlink
privilege unavailable), and `isolated installed Engram managed smoke: bootstrap, reuse, readback,
owned shutdown` (SKIP without a reason in the log). Full logs are retained in the approved temporary
directory as `merged-main-focused-20261027.log` and `merged-main-npm-test-20261027.log`.

R05 real-host rejected-after-hook settlement remains unverified. Source/fixture checks do not
activate the loaded plugin or recover live conversations. The explicit-project Engram save failed
with the known `session_project_mismatch`; no identity guess or retry was attempted. Historical
evidence below remains historical, including earlier green aggregate results and no-publication
authority statements superseded above. `skill_resolution: paths-injected` for all five requested skills.

Final hygiene: `git diff --check` and `git diff --cached --check` passed; `git ls-files -u` returned
no entries, and the source/test/Markdown conflict-marker scan found no matches. No source or test
formatting followed the verification runs; only this evidence record was updated afterward.

### Final integration evidence and remaining limits

After the four compatibility tests were strengthened without production changes, independent `npm test` passed once: 2752 tests, 2749 passed, zero failures/cancellations, three skips, 687.182 s wall time. The skips are two Windows symlink-privilege cases and the installed Engram managed smoke (log labels SKIP without a reason). Local temporary log: `r06-independent-npm-test-20261027-084407.log`. Independent build, typecheck, adaptive-native 105/105 and whitespace checks passed.

The same verifier's earlier required five-file focused command failed: 87 passed, one failed. Packaging exceeded its unchanged 30000 ms deadline (`elapsedMs=30043`, `ETIMEDOUT`, status null, SIGTERM). Its later aggregate pass does not erase that failure or establish stabilization. R06 remains diagnostic instrumentation with unresolved environmental sensitivity, not a completed scheduling repair. Historical test-first RED for the interrupted instrumentation work was not recovered; it is not attested.

One subsequent controlled pair used the identical five-file set, unchanged source/dist/tests/package hashes and internal bounds: serial first passed 88/88 in 75391 ms (whole pack test 26547.6204 ms); default second passed 88/88 in 30792 ms (pack 1810.298 ms). No failures/skips/cancellations in either. Run order, filesystem caching and host load remain uncontrolled; no descendant-resource sampling was obtained. This comparison does not justify a concurrency cap or a new suite scheduler. Local temporary logs: `r06-pair-20261027-085742-serial.log` and matching `-default.log`.

Implementation status: R01–R04 passed independent scoped verification; R05 passed scoped authority/adapter checks with native-host rejected-completion settlement still unverified; R06 diagnostics passed but timeout causality/stabilization remains unresolved. No loaded-plugin activation, live-session recovery, commit, push or publication occurred. The user's latest instruction delegates routine technical surface decisions automatically; ask only for a genuine product/authority change, not each necessary file. Next: retain this evidence; host activation/real-host validation and any further measured environment diagnosis are separate from source verification, not grounds to silently waive remaining limits.

R05 independent verification passed its scoped source/fixture checks: six-file aggregate 676 passed, zero failed/skipped/cancelled in 685.735 s; adaptive-native 105 passed in 32.835 s; typecheck exit zero. Parent R05 full-native spot check passed 12/12. No concrete authority bypass or new regression was found. Remaining host evidence boundary: registered V2 tests prove forwarding and refusal, but do not prove native-host settlement after a rejected completion; the race fixture marks its synthetic call errored. This is an unverified preexisting lifecycle boundary, not demonstrated live recovery or an established new defect. No host installation/activation performed. R06 and full integration acceptance remain pending.

R04 independent verification passed: the exact ten-file aggregate (artifacts, opencode-plugin, opencode-v2, phase-runner, checkpoint, full-native, phase-assets, rework-routing, next-action, workers-native) completed foreground in 578922.1937 ms with 782 tests: 781 passed, zero failed/cancelled, one skipped for Windows symlink privilege. Independent typecheck passed; parent artifacts spot check passed 55 with the same one skip. No unresolved severe scoped defect was found in native identity, bounded reads, restored access, worker-lane denial, capability-conditioned omission, transport budgets or contextual evidence persistence. Source/fixture verification does not activate a loaded plugin or recover live conversations. R05/R06 and aggregate systemic acceptance remain pending; commits remain unauthorized.

### R04 omission-policy decision

The user authorized defining a deterministic omission criterion. Read-only design and one independent assumption challenge established that existing producer instructions deliberately place operational responsibilities in artifact prose; structured traceability is not a complete substitute. A versioned second obligations model was considered but is not recommended without evidence of necessity.

Recommended criterion: preserve current operational structures and pinned planning/failure evidence; omit other distinct narrative from the initial prompt only when a verified, execution-bound capability provides its complete retained content. An omission manifest must not claim summary equivalence. Unavailable access means retain the material or refuse preparation truthfully, preserving accepted progress. Access does not prove the actor read the content; consumer obligations and tests must cover consultation and unresolved evidence. This is a proposed new capability, not an existing tool or an implemented fix. Its extension to artifacts/plugin access boundaries requires user approval before implementation. No R04 tests ran during this design; no live records were modified.

R02 independent verification completed after the approved scope extension and settled-call correlation correction. The exact four-file command `node --import ./tests/isolate-home.mjs --test tests/checkpoint.test.mjs tests/full-native.test.mjs tests/next-action.test.mjs tests/rework-routing.test.mjs` passed 272/272 with zero failures, cancellations or skips in 485.91 seconds. An initial independent attempt exceeded its 240-second external deadline; the foreground rerun completed within a 900-second external deadline without changing test-internal limits. Independent `npm run typecheck` passed. Parent spot check of `tests/next-action.test.mjs` passed 19/19 after the final source correction. No concrete scoped defects remained. R02 implementation and scoped verification are complete; commit closure is still unauthorized, and R03–R06 plus full integration acceptance remain pending. No loaded-plugin activation or live-session recovery was performed.

R01 implementation and focused verification are complete; commit closure remains pending explicit authorization. The checkbox remains open for that closure. Root class: C (real bug), repeated-failure lineage incorrectly equated Verify retries with corrective execution. `#reworkPlan` now requires a successful Apply strictly between the two consecutive Verifies, without intervening planning results. No new state, verb or flag was introduced. Existing admission hunks were preserved.

R01 regression evidence:

- `Verify retries without corrective Apply retain implementation routing (fresh)` and `(restored)` exercise different synthetic sessions and changed assessment wording, including settled checkpoint restoration before retry and after the second failure. Both retain Apply routing and reject the false correction-pass explanation.
- `a historical successful correction does not count between later consecutive Verify retries` proves an older correction cannot justify escalation of a newer retry; restoration retains that result.
- `planning rework resets repeated requirement lineage even after a successful new Apply` verifies the generation boundary across restart.
- `explicit requirements cause retains high-route escalation without correction` and `explicit design cause retains high-route escalation without correction` preserve semantic routing across restart.
- Existing `the same requirement failing again after a correction pass recommends redesign instead of another Apply` remains green, including restored-history escalation.

Exact R01 command sequence and observed results (tests import dist):

1. Before production edits: `npm run build` — exit 0. `node --import ./tests/isolate-home.mjs --test tests/rework-routing.test.mjs` — exit 1, 11 passed / 3 failed / 0 skipped. Two failures asserted actual `mdd-plan` versus expected `mdd-apply`; the restored variant initially hit the existing guard `An inline attempt has no child identity` when restarting immediately after phase reset.
2. Adjusted only the regression's restart placement to settled failed-Verify checkpoints, preserving that guard. Still before production edits: `npm run build` — exit 0. `node --import ./tests/isolate-home.mjs --test tests/rework-routing.test.mjs` — exit 1, 11 passed / 3 failed / 0 skipped. All three RED assertions now showed actual `mdd-plan` versus expected `mdd-apply` (fresh retry, restored retry, older-correction isolation).
3. After the production fix: `npm run build` — exit 0. `node --import ./tests/isolate-home.mjs --test tests/rework-routing.test.mjs` — exit 0, 14 passed / 0 failed / 0 skipped. `npm run typecheck` — exit 0. No full suite was run for this slice; no normalization followed final checks.

Delivery is partial at the systemic-task level: only R01 was implemented, expected RED failures are recorded above, and commit closure is pending. Final required R01 checks all passed. No live journal, runtime, configuration, dependency, branch or commit operations were performed. Test-only resets and restarts use isolated synthetic fixtures. Source verification does not prove an already loaded plugin changed.

`skill_resolution: paths-injected` — loaded `~/.agents/skills/systemic-issue-triage/SKILL.md`. Attributable code delta: source +7/-5; tests +79/-2 (six new test cases); task-document evidence +20/-2 against its initial working copy. Total attributable delta: +106/-9 (net +97). Preexisting admission changes and the task document's preexisting untracked content are excluded.

The latest local checkpoint contains revised Spec/Design; historical memory IDs are not authoritative. Do not mutate that checkpoint. The exact historical post-result exception is still unproven.

Engram mirror: attempted for the resolved `mdd-orchestrator` project, but `mem_save` failed with `session_project_mismatch` (server-injected session belongs to `mdd`); no project identity was guessed. Work-unit commits: none. Next: parent review of R01, then separately authorized R02 work.

### R02 investigation: scope blocker

Scope approval: the user selected **Aprobar ampliación** in the parent's choice envelope, authorizing `src/next-action.ts` and `tests/next-action.test.mjs` in addition to the original five surfaces. R02 resumed once under the retained constraints; this supersedes the edit-scope blocker below, not the persistent-overflow limitation.

R02 remains unimplemented. Source inspection found that truthful recovery advice requires an additional edit surface; the bounded writer stopped before production or test changes rather than weakening durability guards.

- `src/phase-runner.ts:3134-3155` confirms that the accepted result checkpoint precedes successor preparation. `#prepare` changes phase and attempt metadata before composing the prompt (`:4457-4477`), and `#degrade` turns any exception after `settledCheckpoint` into uncertainty (`:2510-2517`). This establishes the code path, not the cause of the historical incident.
- `src/next-action.ts:156-158` unconditionally recommends `mdd_reset` with `scope: phase` for blocked runs. `src/phase-runner.ts:3531` explicitly refuses that operation when checkpoint durability is unknown. The action derivation file is outside R02's allowed surfaces; changing diagnostic prose alone cannot correct the derived command.
- `contribute` (`src/phase-runner.ts:2919-2949`) only appends coordinator context. `Workflow.retry` (`src/workflow.ts:263-270`) leaves an already authorized successor unchanged. Neither operation removes a persistent prompt overflow. A recovery contract must distinguish a retry after the preparation cause is corrected from a claim that retry itself fixes the oversized input. General handoff compaction remains R04 scope.

Candidate scope extension: `src/next-action.ts` and its focused tests, to project a truthful inspection/recovery action for confirmed-result preparation failures and genuine durability fences. Within `src/phase-runner.ts`, stage successor preparation before publishing phase metadata, preserve the committed source result and preparation diagnostic, and validate existing reset/restore paths against correlated checkpoint/progress evidence. Do not clear uncertainty flags or replay the accepted result. Persistent overflow remains blocked until its cause is corrected; defining that correction must not silently expand R02 into R04.

Observed checks: source exploration and preexisting diff inspection only. No regression was added, no build/test/typecheck command was run, and no runtime recovery was attempted. R01's previously recorded 14-test result is unchanged but was not independently rerun in this investigation. Attributable change: this investigation section only; no production, test or adapter-document hunks. `skill_resolution: paths-injected` for all three requested skill files. Engram save to detected `mdd-orchestrator` failed with `session_project_mismatch`; no session identity was invented.

### R02 implementation and observed verification

R02 implementation is complete within the approved seven surfaces; the checkbox remains open for parent review and retained commit closure. Root class: C, successor preparation exceptions were conflated with uncertain result publication. `PhaseRunner.#advance` now prepares a detached workflow/prompt/worker projection and publishes it only on success. Preparation failure keeps the accepted report/evidence and original diagnostic, without setting durability uncertainty. Restore rebuilds the same boundary. Explicit phase reset checks matching checkpoint sequence, history, attempt and settled progress before preparing only the successor; it neither replays the accepted source nor republishes its result. A persistent failure rejects reset with its diagnostic. Genuine durability faults retain their fences and project inspection rather than an unusable phase-reset command.

Named regression evidence:

- `R02: confirmed Plan survives successor preparation failure (same session)` and `(restart)` prove retained accepted results, no task while blocked, exact-once source publication, rejected duplicate callback, rejection while the preparation cause persists, mismatched-progress refusal, successful preparation after the injected clock fault clears, and another safe restart.
- `R02: Design accepted before Tasks overflow remains committed across restart` exercises actual prompt overflow with local task publication. Both live and restored status preserve the diagnostic and accepted Design, and native phase-reset attempts reject without leaving ownership reserved or changing the checkpoint. This reproduces the failure class, not the unproven historical cause.
- Four `R02: ... uncertainty still fences accepted-result recovery` cases cover checkpoint write/readback and progress write/readback faults. Unknown checkpoint transitions cannot restore; a fresh process may reconcile a confirmed result with its exact progress evidence, without replay. Existing durability tests remain intact; the uncertain-Apply native test also asserts truthful next-action routing.
- Two `tests/next-action.test.mjs` regressions require inspection for uncertain durability and conditional preparation recovery only after correcting the cause.

Exact observed command sequence (all commands foreground; tests import dist):

1. Before production edits, `npm run build` — exit 0. `node --import ./tests/isolate-home.mjs --test tests/checkpoint.test.mjs tests/full-native.test.mjs tests/next-action.test.mjs` — first attempt exceeded the 240-second limit, with no completed result; no matching process remained. The same command with a 900-second limit completed RED: exit 1, 249 passed / 5 failed / 0 skipped, 493.15 seconds. The overflow fixture initially failed at contribution rather than successor preparation.
2. Before production edits, corrected only that fixture's context from 80,000 to 70,000 characters. `node --import ./tests/isolate-home.mjs --test --test-name-pattern="R02:" tests/checkpoint.test.mjs tests/full-native.test.mjs tests/next-action.test.mjs` — exit 1, 0 passed / 5 failed. The local Design result now reached the intended later-transition misclassification; the two runner tests showed the confirmed-checkpoint error and the action tests showed reset instead of inspection.
3. During implementation, one build failed with TS2367 (state narrowing); corrected. Rebuilt successfully. The same targeted R02 command first showed 2 passed / 3 failed because blocked closure rendering rejected retained passed evidence; corrected the projection, rebuilt, then observed 5/5. Added durability/correlation controls and native reset assertions. Rebuilt; `node --import ./tests/isolate-home.mjs --test --test-name-pattern="R02:|audit D4: an uncertain" tests/checkpoint.test.mjs tests/full-native.test.mjs tests/next-action.test.mjs` — exit 0, 10 passed / 0 failed / 0 skipped.
4. Final `npm run build` — exit 0. Exact three-file command from step 1 — exit 0, **258 passed / 0 failed / 0 skipped**, 602.12 seconds. `npm run typecheck` — exit 0. `node --import ./tests/isolate-home.mjs --test tests/rework-routing.test.mjs` — exit 0, **14 passed / 0 failed / 0 skipped**, 10.09 seconds. Scoped `git diff --check` — exit 0. No source/test normalization followed final checks.

Attributable resumed delta, excluding preexisting admission/R01 hunks and the earlier investigation: `src/phase-runner.ts` +49/-8; `src/next-action.ts` +7; `tests/checkpoint.test.mjs` +118; `tests/full-native.test.mjs` +29; `tests/next-action.test.mjs` +19; `docs/opencode-adapter.md` +19. These six files total **+241/-8 (net +233)**; this task document additionally records scope approval and this evidence section. Nine new test cases were added. `skill_resolution: paths-injected` for the three requested skills, retained from the initial investigation.

Delivery remains partial at the systemic-task level: R03–R06, parent review, final aggregate verification and commit authorization remain outstanding. No required final R02 check is failing. Persistent oversize input is not repaired by retry and remains R04's separate handoff concern. No commits, live journal edits, live recovery operations, installs, global configuration changes or loaded-plugin mutations occurred; reset/restart tests used isolated synthetic fixtures. Memory transport remains degraded after the known project mismatch; no write retry or guessed identity was used in this resumed slice.

### R02 bounded correction: restore/live call correlation parity

Parent-authorized independent finding reproduced: a settled progress marker with the correct `attemptID` but an unrelated `callID` was refused by live preparation recovery, yet accepted by restart. The restore correlation guard checked native call identity only for released attempts. `src/phase-runner.ts:1866` now applies the same check to settled attempts, while preserving absent call IDs for inline results. No uncertainty fence was cleared and no new state or recovery verb was added.

The existing same-session and restart preparation regressions in `tests/checkpoint.test.mjs:76-84` now insert the unrelated call into isolated synthetic progress, assert both live reset refusal and `restored: false`, assert no dispatchable task or checkpoint/progress mutation, and then restore the valid fixture marker to exercise successful preparation recovery. Prior admission/R01/R02 hunks remain intact.

Observed foreground verification:

1. Before production edits: `npm run build` — exit 0. `node --import ./tests/isolate-home.mjs --test --test-name-pattern="R02:" tests/checkpoint.test.mjs tests/full-native.test.mjs` — RED, exit 1, **5 passed / 2 failed / 0 skipped**. Both failures showed actual `restored: true` versus expected `false` for the mismatched call.
2. After the one-line production correction: `npm run build` — exit 0. `node --import ./tests/isolate-home.mjs --test tests/checkpoint.test.mjs tests/full-native.test.mjs tests/next-action.test.mjs tests/rework-routing.test.mjs` — GREEN, exit 0, **272 passed / 0 failed / 0 skipped**, 487.41 seconds. The foreground command completed before delivery. `npm run typecheck` — exit 0.

Correction-only delta: source +1/-1, tests +9, plus this evidence section; all other prior changes are excluded. `skill_resolution: paths-injected`, retaining the three previously loaded skill bodies. No source/test normalization followed verification. No live journals, commits or runtime changes occurred. No final required correction check is failing; independent parent review and the remaining systemic tasks are still outstanding.

### R03 implementation and observed verification

R03 implementation and focused verification are complete; parent review and commit closure remain pending. Root class: C, execution/evidence gaps were treated as semantic requirement defects and every correction was instructed to change code. Added only the `verification` finding cause, with precedence requirements > design > implementation > verification; omitted causes retain the historical implementation default. Explicit evidence-only scenario rows are excluded from both sides of repeated semantic comparison, without dropping semantic rows for the same requirement. R01's successful intervening Apply and planning-generation guards remain intact.

Evidence-only and required-check-only failures retain corrective Apply with neutral reasoning and the existing explicit Verify retry option. Runtime correction prose, shipped Apply/Verify instructions, generated schemas and adapter documentation now distinguish semantic reproduce/fix/retest from actual execution/evidence recovery, including `noChangeReason` when appropriate. All findings, required-check blockers, coverage and closure validation remain mandatory. No state, verb, flag, checkpoint field, migration or routing phase was added; checkpoint restoration uses the existing shared parser.

Named regression evidence (20 added cases):

- `R03: legacy/structured ... accepts evidence cause only on gaps` covers scenarios, steps and decisions, omitted causes, unknown causes and verified-row negative controls.
- `R03: ... after passed Apply is not semantic repetition (fresh/restored)` covers evidence→evidence, omitted semantic→evidence and evidence→omitted semantic. Each exercises checkpoint validation/restoration, rejects an unknown persisted cause after resealing the synthetic checkpoint, rejects open correction closure, and accepts a fully accounted no-source-change recovery report. Existing omitted-cause semantic repetition still escalates after a genuine correction, including restart.
- `R03: mixed causes retain semantic precedence and same-requirement semantic rows` retains semantic rows alongside evidence gaps; `R03: required check-only failure does not assert an implementation defect` exercises fresh and restored neutral routing.
- Required failed, blocked, interrupted and missing checks remain non-passing, and missing step coverage is still rejected. Shipped/runtime instructions and both generated schemas are checked alongside existing asset integrity tests.

Exact foreground commands and results (900,000 ms external timeout; no test-internal deadline changes):

1. Before production edits: `npm run build` — exit 0. `node --import ./tests/isolate-home.mjs --test tests/acceptance.test.mjs tests/rework-routing.test.mjs tests/phase-report.test.mjs tests/phase-assets.test.mjs` — RED, exit 1, **211 passed / 19 failed / 0 skipped**, 14.54 seconds. Failures exposed the unknown cause, false implementation attribution and unconditional source-fix instructions. The missing-check negative control already passed.
2. After implementation and final source/test edits: `npm run build` — exit 0. The exact same four-file command — GREEN, exit 0, **230 passed / 0 failed / 0 skipped**, 17.64 seconds. `npm run typecheck` — exit 0. One recovery fixture was given the execution ID required by its existing structured contract before GREEN. No source/test normalization followed these checks.

Attributable delta excluding all prior admission/R01/R02 hunks: `src/acceptance.ts` +8/-7; `src/phase-runner.ts` +6/-4; `assets/opencode/agents/mdd-apply.md` +5/-3; `assets/opencode/agents/mdd-verify.md` +4/-1; `docs/opencode-adapter.md` +12/-4; `tests/acceptance.test.mjs` +41; `tests/rework-routing.test.mjs` +71/-1; `tests/phase-report.test.mjs` +10; `tests/phase-assets.test.mjs` +13. These nine files total **+170/-20 (net +150)**; this task document additionally records this evidence section.

`skill_resolution: paths-injected` — loaded `~/.agents/skills/systemic-issue-triage/SKILL.md`, `assets/opencode/skills/mdd-doc/SKILL.md`, `assets/opencode/skills/cognitive-doc-design/SKILL.md`, and `~/.config/opencode/skills/skill-creator/SKILL.md`. No skill or registry was edited. Engram detected `mdd-orchestrator`, but the single explicit-project save failed with `session_project_mismatch`; no identity guessing or write retry occurred. The summary tool has no explicit project parameter, so it was not used against the mismatched session.

No final required R03 check is failing. Systemic delivery remains partial: R04–R06, aggregate verification and commit authorization remain outstanding. No full suite, install, commit, push, live-journal mutation, runtime reset, discard, transfer, global configuration change or deadline waiver occurred. All reset/restart fixtures were isolated synthetic sessions. This slice neither solves historical integration timeouts nor proves activation in a loaded plugin or recovery of live conversations.

### R03 independent verification

The parent reports independent verification of the R03 four-file command recorded above: **230 passed / 0 failed**, and `npm run typecheck` passed. This records the supplied independent result; the R04 investigation below did not rerun it. The parent also reports that the user-requested retry of interrupted exploration succeeded; that observation does not establish recovery of other conversations.

### R04 investigation: omission-policy boundary

R04 remains unimplemented. Root class: C, bounded handoff projection currently reduces artifact bodies without establishing that the omitted prose is redundant. The writer stopped at the requested design boundary before production or test edits. Admission/R01/R02/R03 changes are preserved.

- `src/phase-runner.ts:4931-4963` reduces every artifact to its recorded summary, oldest first, eventually including the latest planning and correction artifacts. Summaries remain unbounded in the projection. `:4915` incorrectly promises that nothing is lost and that every reference identifies retrievable complete content; `:1877-1882` explicitly reconstructs non-local history with diagnostic-only, unissued `store: none` references.
- Existing dependency records (`src/checkpoint.ts:70-83`) contain phase, content, digest and optional batch ID, with ordered result summaries held by the workflow. They carry no declaration that a prose obligation was superseded or copied into current planning. `Workflow.rework` (`src/workflow.ts:280-290`) resets the execution plan, but does not establish semantic replacement of every historical constraint. An old summary can contain a unique multi-file target, operational constraint or deferred-check owner even when the current structured IDs validate. This is a source-level counterexample, not an executed regression.
- Exact duplicate material can be reduced safely; distinct historical prose cannot be proved optional solely from age, phase, digest, size or a shorter recorded summary. Pinning active planning and current correction evidence fixes known omissions, but does not by itself justify dropping other unique history. A hash discloses an omission; it does not prove that omission harmless.
- Contextual acceptance has a separate confirmed-result boundary to preserve: `#sideResult` (`src/phase-runner.ts:3897-3918`) appends evidence, restores the main task, and recomposes before checkpointing. An overflow there can prevent accepted contextual evidence from reaching the checkpoint. Transport accounting also needs to cover the actual call-ID suffix and worker assignment after composition, including the exploration-worker path through `src/worker-state.ts:134-167`.

Concrete decision needed before resuming: define an authorized, deterministic criterion that makes **distinct** historical entries optional, or explicitly accept a conservative projection that deduplicates only provably redundant material and refuses when the remaining unique content exceeds the hard bound. No new state, authority field, checkpoint format, arbitrary clipping or silent age-based omission was introduced. This is a policy boundary, not a request to increase the byte limit or change live records.

Observed verification: CodeGraph-first source investigation and the four requested skill files only. No R04 regression, RED/GREEN run, build, aggregate test run or typecheck was performed; R04 has no passing implementation evidence and none of its mandatory coverage is claimed. The requested final verification sequence remains pending implementation. Attributable delta is this task-document addition only; existing source/test hunks are excluded. `skill_resolution: paths-injected` for all four paths listed in the R03 section. No commits, installs, live journals, runtime resets, discard, transfer, global configuration changes or timeout waivers occurred.

Engram detected `mdd-orchestrator`; the single explicit-project discovery save failed with `session_project_mismatch` because the server-injected session belongs to `mdd`. No identity was guessed and no write retry was attempted. The summary tool lacks an explicit project parameter and was not used against that mismatched session.

Documentation hygiene: foreground `git diff --check` passed (exit 0). This is not R04 behavioral verification.

### R04 bounded-access approval and V2 scope boundary

The user selected **1 — Aprobar acceso acotado**, adding `src/artifacts.ts`, `src/opencode-plugin.ts`, `tests/artifacts.test.mjs` and `tests/opencode-plugin.test.mjs` to R04's allowed surfaces. This supersedes the proposed operational-schema extension: no new obligations model, operational IDs or checkpoint migration is authorized. The approved rule is omission from the initial prompt, not semantic deletion: omitted retained bytes must be readable through a bounded, digest-checked provider tied to the exact active native actor/run/attempt. Restored bytes require ordinary validated restore and a new dispatch binding; serialized artifact references remain non-capabilities.

CodeGraph-first inspection found an additional required surface before that reader can be exposed in the supported V2 host:

- `src/opencode-v2.ts:214-218` explicitly denies `mdd_*` to non-coordinator/non-security actors and adds exceptions only for `mdd_check_report` and Apply's `mdd_worker_edit`. Registering `mdd_artifact_read` in the approved legacy motor alone does not make it usable by dispatched V2 phase actors.
- `src/opencode-v2.ts:231-242` owns actual V2 registration and forwards invocation context to the legacy tool; `:246-267` owns the before-hook path. These must be exercised with the new tool's narrow permission exception and exact caller binding, rather than testing only a helper or legacy registration.
- Minimal additional edit surfaces: **`src/opencode-v2.ts` and `tests/opencode-v2.test.mjs`**. Preserve the installed API and existing policy ordering. Scoped workers must continue to refuse this new tool unless separately supported; do not enable omissions for such lanes. No worker-fence relaxation or API migration is proposed.

The writer stopped at this exact edit-scope boundary as instructed. No production changes, new regressions, omissions, build, RED/GREEN tests, aggregate checks or typecheck were performed in this resumed slice. Attributable change: this appended task-document section only. R04 remains unimplemented; its required test-first sequence is pending the two-file scope extension. Prior admission/R01/R02/R03 hunks remain intact. No live records, runtime operations, installation, configuration changes, commits or remote writes occurred.

`skill_resolution: paths-injected` retains the four exact skill files listed above; additionally loaded builtin `opencode` and fetched `https://opencode.ai/v2/docs/build/plugins`. The documented separation between tool registration and permissions agrees with the inspected adapter. Engram's known project/session mismatch was not retried or bypassed.

### R04 slice 1: execution-bound retained artifact reader

The user approved `src/opencode-v2.ts` and `tests/opencode-v2.test.mjs` and delegated routine technical-scope decisions within R04 ("1 avanxa aitomaticamente no necesitas preguntarme"). The parent retains single-writer surface ownership; routine technical extensions should go to the parent without another user question. No obligations model or checkpoint-schema migration is authorized.

Implemented the prerequisite bounded reader and a narrow operational pinning correction:

- `src/artifacts.ts`: pure retained-content digest verification and 4–8192-byte pages at exact UTF-8 boundaries. Existing instance-issued `ArtifactStore.read` capability checks remain intact.
- `src/phase-runner.ts`: `readArtifact` selects only existing phase-history/contextual artifact bytes, after native caller proof and exact live run/attempt/arguments/workspace/ownership checks. It cannot restore a run, read arbitrary paths, accept serialized refs, or mutate workflow state. Ordinary validated restoration permits access only under a new admitted dispatch.
- `src/opencode-plugin.ts`: `mdd_artifact_read` registration and native before-hook/executor checks. Native records establish child, message, running read call and uniquely matching running parent task. Legacy ToolContext provides message identity but no typed call ID; that path requires one uniquely matching running read in the exact native message. V2 passes its native invocation ID too. Tool inputs contain no caller/run identity.
- `src/opencode-v2.ts`: narrow reader permission exception for phase/native-fallback roles, preserving `mdd_*` control denial and scoped-worker fences. Disposed V2 providers reject captured reader callbacks using the existing lifecycle abort signal.
- Existing summary projections now include `history:N` locators and explicitly disclose absent inline bytes. Removed the false external-retrieval/losslessness promise. Packaged actor instructions and adapter/storage docs explain consultation, unavailable-evidence reporting and the absence of workflow authority.

Test-first evidence (all foreground; external timeout 1,200,000 ms, no internal deadline changes):

1. Before production edits, `npm run build` passed. `node --import ./tests/isolate-home.mjs --test --test-name-pattern="R04:" tests/artifacts.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs tests/phase-runner.test.mjs tests/checkpoint.test.mjs tests/full-native.test.mjs tests/phase-assets.test.mjs` was RED: **3 passed / 6 failed / 0 skipped**, 13.12 seconds. Six new regressions exposed the absent chunk/provider/native-reader APIs and V2 registration; the three passing entries were files without matching tests.
2. During implementation, two builds exposed the installed legacy ToolContext's missing call ID and exact-optional typing; corrected without migrating APIs. The focused command then passed 9/9. Added lifecycle regressions before their fix: the focused command was RED **9 passed / 3 failed**, including two old-provider callback leaks and one fallback fixture whose purported wrong actor was actually the correct `general` actor. Corrected that fixture and fenced disposed callbacks with the existing abort signal.
3. Added the false-retrieval-promise regression before changing that prose: focused RED **11 passed / 1 failed**. Added packaged-reader instruction coverage before editing the asset: `node --import ./tests/isolate-home.mjs --test --test-name-pattern="R04: packaged" tests/phase-assets.test.mjs` was RED **0 passed / 1 failed**.
4. Rebuilt successfully. The exact focused command from step 1 was GREEN **12 passed / 0 failed / 0 skipped**, 7.47 seconds: **11 named R04 regressions**, plus the full-native file with no matching test. Coverage includes exact multibyte reconstruction, invalid ranges/digests, unissued-ref refusal, phase/context reads fresh/restored, parent/sibling/stale/argument/actor spoofing, active-attempt settlement, actual V2 registration/hook/executor paths, fallback, disposal and scoped-worker denial.

R04 remains partial. Apply/Verify now pin the latest Plan/Tasks artifact and subsequent Apply/Verify artifacts. Complete active-prerequisite pinning remains pending, along with provider-gated optional-history summary-to-manifest reduction (including huge summaries and zero-inline pressure), non-omitting unsupported lanes, all escaped prompt/brief/assignment/call-ID bounds and knowledge headroom, quantified irreducible overflow, and contextual accepted-result checkpointing before successor recomposition. Existing compaction is not claimed loss-aware. No loaded plugin or live conversation was repaired.

`skill_resolution: paths-injected` retains all four required exact paths; builtin `opencode` was loaded and its V2 plugin guide fetched. Known Engram identity mismatch was not retried or bypassed. No commits, push, installation, global configuration changes, live-journal writes, runtime reset, discard, transfer or timeout waivers occurred. Tests use isolated synthetic fixtures.

### R04 verification outcome: partial, aggregate remains red

The first nine-file aggregate returned **752 tests: 749 passed, 2 failed, 1 skipped** in 592.52 seconds. Apply's authority assertion still expected pre-R03 wording; it now asserts both semantic edits and evidence-only recovery, preserving R03 production behavior. Restored Verify had summarized the active Plan under the soft budget. The retained-plan regression reproduced RED before the pinning change (**1 passed / 1 failed**, 7.56 seconds). Pinning the plan alone exposed loss of Apply evidence (**13 passed / 1 failed**); the correction now also pins subsequent Apply/Verify artifacts. The original Plan and Apply presence assertions remain intact.

- Extended focus (`R04:|SA-1: composed mdd-apply|a long route compacts` across the seven approved focus files): **14 passed, 0 failed, 0 skipped**, 11.86 seconds.
- Exact required `R04:` focus command above: **12 named tests passed, 0 failed, 0 skipped**, 8.07 seconds. This now includes the strengthened existing restored-Verify test, rather than an unmatched file entry.
- Final `npm run build`: passed, exit 0.
- Required aggregate: `node --import ./tests/isolate-home.mjs --test tests/artifacts.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs tests/phase-runner.test.mjs tests/checkpoint.test.mjs tests/full-native.test.mjs tests/phase-assets.test.mjs tests/rework-routing.test.mjs tests/next-action.test.mjs` returned **752 tests: 750 passed, 1 failed, 1 skipped**, 569.86 seconds.
- Remaining failure: `audit D4: a long reworked route of maximum escaped artifacts plus context still checkpoints and restores`, `tests/full-native.test.mjs`. A focused diagnostic rerun (**0 passed / 1 failed**, 19.49 seconds) confirms successor preparation exceeds the unchanged **96,000-byte combined phase handoff** ceiling after pinning. This is a known regression against that route's completion expectation, not a green delivery. The fixture now includes `status.reason` in its failure message; its completion assertions were not weakened.
- The single skip is `artifacts: rejects a symlink artifact file without modifying its target`: **File symlink creation requires Windows privilege.**
- `npm run typecheck`: passed, exit 0. Final whitespace verification is recorded below.

The original maximum-escaped route remains unresolved. Completing R04 requires reconciling mandatory inline content with the full escaped transport budget and proving retained-progress behavior at irreducible overflow. Repeating a preparation reset does not reduce those bytes. No further full aggregate was run after the diagnostic-only assertion-message change.

Attributable R04 delta, excluding existing admission/R01/R02/R03 work: **+395 / -22 lines across 14 tracked files**, plus this task document's appended R04 slice/evidence sections (from line 176). Source: +129/-12; tests: +215/-9; shipped instructions: +14/-1; reader documentation: +37/-0. Counts use selected zero-context Git hunks in shared files, including only the nine-line R04 addition in `tests/phase-assets.test.mjs`; existing actor changes and all other earlier hunks are excluded. The entire worktree diff is not the R04 delta.

Final whitespace check: `git diff --check` passed (exit 0). Delivery remains partial because the aggregate failure and pending R04 obligations remain open.

### R04 continuation: bounded projection and contextual recovery

The maximum-escaped route now passes its original completion assertions. The final nine-file
aggregate is green. R04 delivery remains partial for the explicit boundary-coverage gaps below;
the earlier aggregate failure and contextual next-action scope blocker are resolved.

Scope extension: the parent authorized `src/next-action.ts` and `tests/next-action.test.mjs`
under the user's automatic technical-scope delegation. The existing allowlist otherwise stayed
unchanged. Accepted contextual evidence before the first main result now receives inspection-first
guidance: present the original diagnostic, correct its cause, and only then explicitly prepare
again. No main result is invented, no automatic reset arguments are issued, and the existing
durability fence takes precedence.

Implemented delivery contract:

- Native-reader-capable phase/Risk/fallback lanes project full retained text to complete summaries
  and then `mustRead` manifests. Huge summaries may reduce to manifests. Consumers must read every
  omitted original to EOF before dependent work; summaries never establish equivalence.
- Requirements, coordinator context, acceptance/decisions, complete operational plans and current
  structured execution/correction facts stay inline. Unsupported and scoped-worker lanes retain
  complete artifact bytes and refuse overflow. No byte ceilings or checkpoint schema changed.
- Prompt and brief composition measure the JSON-escaped task envelope and reserve maximum call-ID
  space. Worker assignment suffixes and actual dispatch envelopes are checked; optional knowledge
  uses conservative escaped headroom. Overflow reports measured bytes and excess.
- Contextual evidence checkpoints and settles progress before main preparation. Fresh/restored
  failures retain exact evidence once, reject replay and preserve genuine publication uncertainty.

#### Observed verification

All commands were foreground with 1,200,000 ms external timeout and unchanged internal deadlines.

1. Initial projection/context RED: four new cases failed before implementation. Pre-first-result
   context coverage subsequently exposed two failures in six cases (blocked status rendering and
   restoration). Packaged `mustRead` coverage also failed before its instruction change.
2. Prior continuation aggregate: **761 tests, 758 passed, 2 failed, 1 skipped**, 596.11 seconds.
   `context accumulation is bounded without truncating results or advancing the main workflow`
   incorrectly required overflow within eight contexts; its replacement validates all eight exact
   16,000-byte checkpoint documents and authenticated full consultation. `checkout handoff: retained
   phase and risk briefs compose the same workspace data` matched obsolete composer syntax; it now
   checks the shared data body used by prompt and brief. Focused confirmation: **2/2 passed**.
3. Guidance RED, after successful build and before production fix:
   `node --import ./tests/isolate-home.mjs --test --test-name-pattern="R04: accepted context|R02:" tests/checkpoint.test.mjs tests/next-action.test.mjs`
   returned **13 tests, 10 passed, 3 failed, 0 skipped**, 4.03 seconds. Fresh/restored pre-first-result
   status and the new unit regression returned `mdd_reset` instead of `mdd_status`; R02 controls passed.
4. Final `npm run build`: exit 0. Final aggregate:

   ```text
   node --import ./tests/isolate-home.mjs --test tests/artifacts.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs tests/phase-runner.test.mjs tests/checkpoint.test.mjs tests/full-native.test.mjs tests/phase-assets.test.mjs tests/rework-routing.test.mjs tests/next-action.test.mjs
   ```

   **762 tests, 761 passed, 0 failed, 1 skipped, 0 cancelled**, 579.45 seconds.
   Skip: `artifacts: rejects a symlink artifact file without modifying its target` — Windows file
   symlink creation requires privilege. `npm run typecheck`: exit 0. Final `git diff --check`: exit 0.

#### Requirement-to-evidence map

All named cases below passed in the final aggregate; grouped names denote their fresh/restored or
capability variants, not separate unrun claims.

| Requirement | Named evidence |
|---|---|
| Exact UTF-8 retained pages, digest/range rejection, no minted store authority | `R04: bounded retained bytes reconstruct exact UTF-8 without issuing store capabilities`; `R04: retained byte reads reject digest, boundary and range violations` |
| Fresh binding, native identity, lifecycle and fallback | `R04: retained reader requires a new active binding` (fresh/restored); `R04: native artifact reader verifies actual child tool and parent task identities`; `R04: V2 reader registration, before hook and invocation enforce the active native child` (fresh/restored/fallback) |
| Capability-gated omission, huge summary reduction, escaped call ID and quantified refusal | `R04: projection requires a native reader and preserves exact obligations` (false/true) |
| Full plan/prerequisites and acceptance retained; omitted originals actually consulted | `R04: same-parent restart retains exact obligations and consults full plan bytes for Verify`; `audit D4: a long reworked route of maximum escaped artifacts plus context still checkpoints and restores` |
| Scoped workers retain bytes and deny reader | `R04: V2 scoped workers retain their custom-tool denial for artifact reads`; `R04: V2 contextual workers keep predecessor bytes inline under soft-budget pressure` |
| Context exact-once persistence, pre/post-plan, successful recovery and no replay | `R04: accepted contextual bytes survive failed main preparation without replay` (four fresh/restored, planned=false/true variants); `R04: accumulated contexts remain exact and readable without advancing the main workflow` |
| Genuine uncertainty fences and truthful guidance | `R04: contextual checkpoint uncertainty cannot replay or dispatch`; `R04: contextual progress uncertainty cannot replay or dispatch`; `R04: accepted context before first main result requires inspection and cause correction`; existing R02 persistence/preparation controls |
| Irreducible mandatory overflow preserves accepted progress | `R02: Design accepted before Tasks overflow remains committed across restart` |
| Consumer consultation and shared prompt/brief inputs | `R04: packaged instructions permit bound reads without granting scoped workers or controls`; `checkout handoff: retained phase and risk briefs compose the same workspace data` |
| Optional knowledge and assignment integration | Existing `PK3 V2 plugin injects child-only knowledge at actual ... dispatch` cases and `checkout handoff: ... scoped workers retain distinct workspace identities`; dedicated saturation gaps below |

Remaining coverage gaps: no dedicated adversarial test saturates optional knowledge with worst-case
JSON escaping, or drives an Apply-worker assignment suffix across its exact hard boundary. The
implementation checks both, and aggregate integration paths pass, but those are not equivalent to
boundary regressions. Consequently this report does not claim every promised R04 transport edge
case is verified. Native fixtures prove access/consultation protocol, not real model comprehension
or activation in an already loaded plugin. R05/R06 and full systemic acceptance remain separate.

#### Attributable delta and handoff

R04 selected-hunk delta against the pre-R04 working state, excluding admission/R01/R02/R03:
**+782/-104 across 16 tracked files**, plus task-document additions from line 176 onward. This
supersedes the earlier +395/-22 partial count. Shared R02 reset/status/restore hunks are counted
only for their R04 edits, not their prior implementation.

| Files | Added / removed |
|---|---:|
| `src/phase-runner.ts` | +165/-72 |
| `src/artifacts.ts`, `src/opencode-plugin.ts`, `src/opencode-v2.ts`, `src/next-action.ts` | +94/-6 |
| `tests/artifacts.test.mjs`, `tests/checkpoint.test.mjs`, `tests/full-native.test.mjs`, `tests/next-action.test.mjs` | +256/-16 |
| `tests/opencode-plugin.test.mjs`, `tests/opencode-v2.test.mjs`, `tests/phase-assets.test.mjs`, `tests/phase-runner.test.mjs` | +191/-9 |
| `assets/opencode/mdd-instructions.md`, `docs/artifacts-and-actors.md`, `docs/opencode-adapter.md` | +76/-1 |

No commits, installation, push, live-journal writes or runtime recovery occurred. Known Engram
project/session mismatch remains; no identity guessing or failed-write retry occurred.

Key Learnings:
1. Retention alone does not justify omission: the dispatched lane needs authenticated access and
   an explicit obligation to consult the complete original.
2. Context acceptance is a commit boundary even before any main result exists; guidance must
   reflect that boundary without fabricating workflow success.
3. Escaped transport size must include suffixes and optional additions; normal integration success
   does not replace adversarial boundary coverage.

### R04 adversarial transport coverage: ready for independent verification

Both previously explicit coverage gaps are now closed. R04 implementation and author-run scoped
verification are complete; independent verification and commit closure remain pending. This
supersedes the partial-coverage status above, not the separate R05/R06 or live-activation limits.

The parent authorized `tests/workers-native.test.mjs` solely for the assignment transport boundary.
This continuation changed only that test file, `tests/phase-runner.test.mjs` and this task document.
No production change or additional source authorization was needed.

| Added adversarial case | Observed contract |
|---|---|
| `R04: escaped optional knowledge saturation preserves mandatory bytes and native binding` | Actual dispatched JSON stays within 96,000 bytes with a 256-quote call ID, Unicode, backslash, newline/tab and `@` escaping. Exact requirements/context survive. Larger advisory candidates are excluded while a smaller candidate fits under explicit advisory precedence. Applying the same candidates without transport headroom would exceed 96,000 bytes. A forged actor is rejected before optional lookup. |
| `R04: Apply assignment suffix overflow blocks before publishing worker dispatch` | A successful two-file worker dispatch retains both paths and escaping within the ceiling. Measured suffix pressure then passes initial phase composition but fails specifically at `combined Apply worker handoff`. No task or worker token is exposed; the exact accepted two-file plan, settled checkpoint and idle owner survive. Reusing another run's issued handle fails without changing checkpoint or ownership. |

These are test-only proofs of already-correct checks, so there is no meaningful product RED/fix
cycle to claim. Initial focused attempts were **0 passed / 2 failed**, then **1 passed / 1 failed**:
the knowledge fixture exceeded its own body limit, the initial worker pressure hit the earlier
phase bound, and the revised knowledge pressure allowed no advisory at all. Only test inputs were
calibrated; production guards were not changed or bypassed. The final focused run passed **2/2**,
zero failures/skips, 1.73 seconds.

Observed final commands (foreground, 1,200,000 ms external timeout, internal deadlines unchanged):

1. `npm run build` — exit 0, before the targeted tests.
2. `node --import ./tests/isolate-home.mjs --test --test-name-pattern="R04: escaped optional|R04: Apply assignment" tests/phase-runner.test.mjs tests/workers-native.test.mjs` — final **2 passed / 0 failed / 0 skipped**.
3. Final ten-file aggregate:

   ```text
   node --import ./tests/isolate-home.mjs --test tests/artifacts.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs tests/phase-runner.test.mjs tests/checkpoint.test.mjs tests/full-native.test.mjs tests/phase-assets.test.mjs tests/rework-routing.test.mjs tests/next-action.test.mjs tests/workers-native.test.mjs
   ```

   **782 tests: 781 passed, 0 failed, 1 skipped, 0 cancelled**, 597.98 seconds. The only skip remains
   `artifacts: rejects a symlink artifact file without modifying its target` (Windows symlink privilege).
   All prior named R04 coverage and the unchanged maximum-escaped-route completion assertions pass.
4. `npm run typecheck` — exit 0. Final `git diff --check` — exit 0.

Continuation delta: **+101/-1 test lines** (`tests/phase-runner.test.mjs` +45/-0;
`tests/workers-native.test.mjs` +56/-1), plus this documentation. Cumulative attributable R04 delta:
**+883/-105 across 17 tracked files**, plus task-document additions, excluding earlier admission and
R01/R02/R03 work. The requirement-to-evidence table above plus these two cases accounts for all
claimed R04 requirements; no known promised R04 coverage remains pending. The Windows-only skip,
real model comprehension and already-loaded plugin activation remain explicit evidence limits.

`skill_resolution: paths-injected` — retained `assets/opencode/skills/mdd-doc/SKILL.md` and
`assets/opencode/skills/cognitive-doc-design/SKILL.md`, the previously loaded R04 skill context,
and `work-unit-commits`. No new agent dispatch or skill edits. Engram's known project/session
mismatch was not retried or bypassed. No commits, installs, pushes, live journal changes or plugin
activation occurred.

Key Learnings:
1. A transport saturation test must prove the unbounded candidate really would overflow, not just
   assert that a small output fits.
2. Assignment overflow must be isolated from earlier phase composition to prove the suffix guard.
3. Fixture-construction failures are not product RED evidence; distinguish them explicitly.

### R05 implementation and observed verification

R05 implementation and author-run scoped verification are complete. Independent parent review,
R06, aggregate systemic acceptance and commit closure remain pending. Root class: C, ownership was
mistaken for both question ownership and idleness. Restored settled failed-Verify runs legitimately
have no intake; conversely, an owner can retain an active held-here writer reservation.

The shared `NativeIntake` coordinator-question guard runs in both hooks after adaptive processing,
moved-away checks and owner validation. It compares registered and durable retained envelopes,
current/consumed/retired call identities and actual native input, without wording heuristics.
Read-only runner facts exclude active actors, contextual operations, pending/uncertain progress,
unresolved ownership/transfer claims and writer reservations. Pending intake and durable prepared,
pending or answered questions remain exclusive. Eligibility is rechecked after asynchronous native
inspection and again on completion. Generic success returns without interpreting an answer as
consent, publishing a receipt, contributing context, changing a plan or dispatching work.

Legacy completion also rechecks standalone/security exclusion. V2 continues forwarding through the
same motor and its existing transport normalization; its completion refusals remain exceptions.
Exact owned consent and the settled version-2 native-receipt exception were not relaxed. Active
adaptive runs remain refused; an already-rejected pre-admission attempt without durable occupancy
does not become pending work merely because its bridge status is blocked.

#### Tests and observed checks

Seventeen named R05 cases cover real legacy/V2 orchestration through failed Verify, fresh/restored
idle questions in three languages, unchanged checkpoint/plan/receipt/ownership projections, no-run
passthrough, held-here actor reservations, activation between hooks, contextual work, pending intake,
all three unresolved durable-question states, changed callbacks, retained stale envelopes, retired
calls, pending progress, native-input mismatch and foreign-parent refusal. Existing exact consent,
single-use, native freshness and active/closed-adaptive controls passed in the aggregate. Synthetic
fixture hosts explicitly settle their native parts; no undocumented host settlement is claimed.

All commands ran foreground with a 1,200,000 ms external timeout and unchanged internal deadlines.

1. Before production edits, `npm run build` passed. The required six-file `R05:` focus command
   returned **11 entries: 5 passed / 6 failed**. Two early runs included invalid V2 Verify fixture
   reports; after correcting only those reports, the third run retained the same counts with real
   failures: both adapters rejected ordinary completion fresh and ordinary admission restored;
   V2 accepted an active-owner question; the legacy race refusal had the old ownership diagnostic.
2. Initial implementation built after adding a missing type import, then passed **11/11** focus
   entries. Added durability/identity controls and shipped-instruction coverage; the latter observed
   RED before its prose change (**15 passed / 1 failed**). One later fixture skipped the legal pending
   transition before answered publication; corrected the fixture without changing the store guard.
3. First required aggregate: **676 tests, 672 passed / 4 failed**, 752.89 seconds. Three failures were
   diagnostic expectations; one exposed the overly broad adaptive `busy` classification after a
   rejected old objective. The guard now checks actual pending bridge states plus durable/runner
   facts; the active-adaptive test still requires refusal with the new idle diagnostic.
4. Final `npm run build`: exit 0. Exact aggregate:

   ```text
   node --import ./tests/isolate-home.mjs --test tests/native-intake.test.mjs tests/full-native.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs tests/adaptive-public.test.mjs tests/phase-assets.test.mjs
   ```

   **676 passed / 0 failed / 0 cancelled / 0 skipped**, 733.66 seconds.
5. `node --test tests/adaptive-native.test.mjs`: **105 passed / 0 failed / 0 skipped**, 58.62 seconds.
   `npm run typecheck`: exit 0. After correcting one documentation indentation space, the exact
   six-file command above with `--test-name-pattern="R05:"` passed **20/20 entries**: seventeen named
   regressions and three unmatched-file entries, 26.82 seconds. Final `git diff --check`: exit 0.
   No source/test normalization followed these checks.

Attributable delta against a saved pre-R05 working-copy baseline, excluding admission/R01-R04:
**+310/-12 across nine tracked files**, plus this task-document section. `src/native-intake.ts`
+38/-9; `src/phase-runner.ts` +17; `src/opencode-plugin.ts` +19/-2;
`tests/full-native.test.mjs` +121; `tests/opencode-v2.test.mjs` +86;
`tests/adaptive-public.test.mjs` +1/-1; `tests/phase-assets.test.mjs` +8;
`assets/opencode/agents/mdd-orchestrator.md` +7; `docs/opencode-adapter.md` +13.

`skill_resolution: paths-injected` for the four exact requested skills. Engram detected
`mdd-orchestrator`, but the explicit-project save failed with `session_project_mismatch`; no retry,
guessed identity or projectless summary write was used. No commits, pushes, installations, global
configuration changes, live-journal edits or live recovery operations occurred. Source/fixture
verification does not activate an already loaded plugin or repair a live conversation.

Key Learnings:
1. Valid durable ownership does not prove an idle writer.
2. Settled failed Verify can restore without reconstructing native intake.
3. Retained question identities remain replay fences after their answers settle.
4. Completion must recheck activity because admission cannot freeze later work.

### R06 resumed: diagnostics verified, integration acceptance remains red

The interrupted delegate had already written all four diagnostic surfaces and completed one
measured `npm test`. Recovery inspected the working diff and retained temporary evidence before
execution; **no second full suite was run**. Admission/R01-R05 hunks remain intact. Root class E:
historical subprocess failure mechanisms remain unproven; the generic immutable Git refusal hid
useful failure classes. This diagnostic slice closes no stabilization issue.

#### Implemented scope

- `src/judgment-day.ts` retains the refusal prefix, fail-closed behavior, 5-second deadline and
  128-KiB limit. Its message and sanitized error cause retain classification and monotonic elapsed
  milliseconds for cancellation, timeout, output overflow, ordinary process failure and invalid
  decoding. Raw subprocess errors, streams, arguments, environment and paths are not forwarded.
- `tests/judgment-day.test.mjs` injects deterministic subprocess faults through the existing Node
  builtin, restores it in `finally`, checks unchanged bounds and cause privacy, and strengthens
  actual Git failure/overflow/decode assertions. No production API was added.
- Pack and config-UI fixtures report bounded elapsed/error-code/status/signal metadata on subprocess
  failure. Exact package contents/privacy assertions and expected CLI exit semantics are preserved.
  Pack retains 30 seconds; config UI retains 5 seconds. Three named R06 regression tests were added.

#### Recovered full-suite evidence

`npm test` (unchanged script: build, then isolated `tests/*.test.mjs`) completed with **exit 1**:
**2751 tests, 2744 passed, 4 failed, 0 cancelled, 3 skipped**, runner duration **753137.8791 ms**.
The saved measurement records wall time **755563.0865 ms**. Full output is retained at
`r06-npm-test-20261027-073552.log` (local temporary log);
the adjacent `.log.measurement.json` records command, exit, elapsed time and sampling availability.
The wrapper source and external timeout configuration were not recovered, so their implementation
cannot be independently attested. Sampling explicitly reports unavailable; there is no measured
descendant peak or CPU-delta claim.

Every observed failure:

| File / test | Observed failure |
|---|---|
| `apply-batches.test.mjs:361`, compacted repeated Apply artifacts keep their own batch summaries, not the first phase summary | `TypeError`: undefined `summary`, assertion site line 368 |
| `apply-batches.test.mjs:471`, legacy truncated file evidence stays readable but cannot become a new Apply writer | Expected false, actual true, line 481 |
| `question-checkpoint.test.mjs`, PF-3 historical storage-containing **pending** preflight stays frozen across restart until explicit discard | Native question callback has no current issued question; no answer was accepted, line 34 |
| Same file, PF-3 historical storage-containing **answered** preflight stays frozen across restart until explicit discard | Same refusal and assertion site |

Every skip: artifact symlink rejection (Windows file-symlink privilege); symlink content is never
followed or emitted (Windows symlink privilege unavailable); isolated installed Engram managed
smoke (log says `SKIP`, with no more specific reason). Pack, config-UI smoke and immutable Git
inspection passed in the aggregate; no new subprocess failure metadata was emitted by those tests.

#### Resume verification and evidence gaps

Prior RED/focused-GREEN transcripts were not recovered. Existing code timestamps precede the
measured full-suite log, whose output includes all three R06 regressions. This does **not** prove
test-first ordering; no RED history is fabricated and existing implementation was not rolled back
to manufacture it. Resume changed only this task document.

After clean `git diff --check`, with no source/test normalization required, foreground checks:

1. `npm run build`: exit 0.
2. `node --import ./tests/isolate-home.mjs --test tests/judgment-day.test.mjs tests/pack.test.mjs tests/config-ui.test.mjs`:
   exit 0, **29 passed, 0 failed/cancelled/skipped**, **23994.8558 ms**.
3. `node --test tests/adaptive-native.test.mjs`: exit 0, **105 passed, 0 failed/cancelled/skipped**,
   **43074.4737 ms**.
4. `npm run typecheck`: exit 0. Final `git diff --check`: exit 0.

Recovered R06 code delta: **+95/-9 (net +86)** across four files: judgment source +12/-2,
judgment tests +49/-4, config-UI tests +17/-2, pack tests +17/-1. This excludes all prior
admission/R01-R05 changes and this document's R06 evidence addition.

Next: independently triage the four aggregate failures in their owning recovery slices. No
scheduler cap or timeout increase is justified by this run. The supplied Node 26.9.0 / 24-core
parallelism / 23 default test-file-slot context does not measure nested compiler/npm/Git load.
Private npm caches do not establish a writable collision, and the earlier 26-test comparison was
not a reproduction. A future bounded scheduling comparison needs attributable descendant evidence
and an explicit hypothesis; the current failures are not evidence of contention. No stabilization
or live-conversation recovery is claimed, and focused passes do not replace aggregate acceptance.

`skill_resolution: paths-injected`: loaded the injected systemic-issue-triage skill and repository
`assets/opencode/skills/mdd-doc/SKILL.md` and `assets/opencode/skills/cognitive-doc-design/SKILL.md`.
Engram resolved `mdd-orchestrator`; one explicit-project save returned `session_project_mismatch`.
No retry, guessed identity or projectless summary write was used. No commits, pushes, scheduler
changes, separate installs, global configuration changes or live runtime operations occurred.

Key Learnings:
1. A transport interruption can leave completed test evidence behind.
2. Sanitized subprocess classifications preserve useful diagnostics without raw output.
3. Four aggregate failures remain despite green diagnostic-focused checks.
4. Missing descendant measurements cannot establish resource contention.

### Bounded integration correction: four superseded test premises

The four failures are resolved in the scoped integration suite with test-only changes. Classification:
**A: 4; B/C/D/E: 0**. No product safety failure was demonstrated. R04 capability-conditioned omission,
R02 read-only restoration after successor preparation failure, and R05 explicit callback refusal
supersede the old premises; none permits lost evidence or stale execution authority.

| Original failure / superseding control | Named evidence |
|---|---|
| Apply summary assumed omission without a reader | `repeated Apply artifacts retain batch-specific evidence and exact originals (native reader=true)` binds the synthetic inspector to the actual dispatched task, selects dependencies by distinct batch IDs, checks their own summaries, reads both originals through EOF, and verifies exact bytes and SHA-256. |
| Companion capability-negative control | The same named case with `native reader=false` requires both exact originals inline. Both variants retain the exact full deliverables, required check IDs and changed-file union. |
| Legacy restore assumed readable evidence must fail restoration | `legacy truncated file evidence stays readable but cannot become a new Apply writer` requires successful restoration with blocked incomplete-evidence status, no task or invented batch plan/completion, unchanged checkpoint/history, 65 reported files and exactly 64 retained paths. Phase reset refuses; another restart remains read-only. |
| Historical pending and answered callbacks assumed silent no-op | Both `PF-3: historical storage-containing ... preflight stays frozen across restart until explicit discard` cases require explicit refusal for exact old call/args, changed args with old call, and old args with a new unissued call. Frozen records, no workflow and zero approvals remain mandatory. After synthetic discard, field order/storage assertions remain; all three stale callbacks leave the fresh pending record unchanged, and only its newly issued correlated answer starts and settles intake. |

Existing prepared/pending restart, answered-unapplied approval, receipt, native identity, durability,
required-check and writer-fence tests remain intact and passed in the aggregate. No protection was
relaxed to accept the new expectations. Synthetic reader inspection is a runner-level fixture;
actual legacy/V2 native inspector coverage is provided by the existing aggregate tests.

Observed foreground commands (1,200,000 ms timeout; unchanged internal deadlines):

1. `npm run build`: exit 0, before any expectation edits.
2. `node --import ./tests/isolate-home.mjs --test tests/apply-batches.test.mjs tests/question-checkpoint.test.mjs`:
   baseline **58 tests, 54 passed, 4 failed, 0 skipped/cancelled**, 31758.7095 ms. All four matched
   the retained R06 raw log: undefined summary, restored true versus false, and two explicit
   no-current-issued-question refusals. This is observed baseline RED, not a manufactured product defect.
3. First strengthened run: **59 tests, 57 passed, 2 failed**, 31624.2544 ms. Both failures were
   diagnostic-regex mismatches: stale callbacks during fresh intake correctly refused as already
   pending. Corrected that regex to the actual refusal; no safety assertion or source changed.
4. Exact two-file command repeated: **59 passed, 0 failed/skipped/cancelled**, 35318.1296 ms.
5. `node --import ./tests/isolate-home.mjs --test tests/apply-batches.test.mjs tests/question-checkpoint.test.mjs tests/native-intake.test.mjs tests/artifacts.test.mjs tests/phase-runner.test.mjs tests/checkpoint.test.mjs tests/full-native.test.mjs tests/opencode-plugin.test.mjs tests/opencode-v2.test.mjs`:
   **823 tests, 822 passed, 0 failed/cancelled, 1 skipped**, 613905.5963 ms. The skip is the existing
   artifact symlink test requiring Windows privilege. Local full output: `sh_17d55b8ab0019pLcoq1Q67AT50.out`.
6. `npm run typecheck`: exit 0. Final `git diff --check`: exit 0.

Attributable test delta: **+94/-18 (net +76)**: apply-batches +68/-13, question-checkpoint +26/-5;
one added test case. This appended evidence section is additional. All prior admission/R01-R06
hunks were preserved; no production source, normalization, commits, installs or live runtime/journal
operations occurred. Full `npm test` was not rerun: independent parent review and separately
authorized full-suite acceptance remain pending. Scoped delivery is green, not systemic closure.

`skill_resolution: paths-injected` — loaded the requested systemic-issue-triage file and repository
`mdd-doc` and `cognitive-doc-design` paths. Engram resolved `mdd-orchestrator`; the documented
project/session mismatch was not retried, guessed around, or bypassed with a projectless summary.

Key Learnings:
1. Successful restoration retains evidence without granting execution authority.
2. Omission tests need a bound reader and complete original reconstruction.
3. Stale callback refusal must preserve the fresh question's usable correlation.
