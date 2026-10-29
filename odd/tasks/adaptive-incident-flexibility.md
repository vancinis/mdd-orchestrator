# Remove adaptive workflow reporting friction

## Objective

Fix the reproducible MDD contract contradictions found in the authorized `Mover-aviso-de-IA` incident without weakening execution boundaries or turning failed checks into success.

## Evidence and scope

- Six of fourteen retained actor receipts failed. Two rejected `delivered`, two supplied only A1 when the remaining plan required A1–A5, one changed held bindings, and one echoed incorrect native identity.
- Adaptive Apply rejects a presentation field accepted by the canonical Apply report reader. Structured planning prompts mix whole-plan obligations with single-assignment wording.
- Preserve held acceptance/source bindings, actor/run/call identity validation, edit scopes, parent-owned command execution and truthful failed-check history.
- The held-binding rejection lacks its original structured payload. The separate tool-input serialization failure is not proven to originate in MDD. Neither warrants weakening a guard.
- Only this MDD source checkout may change. The incident repository, journals, installed package and global configuration stay untouched. No remote operations, publication or live recovery are authorized.

## Task and acceptance criteria

- [ ] **T01 — Remove contradictory adaptive report and prompt contracts.** Reuse canonical report-field handling where appropriate; tolerate supported presentation metadata without granting completion/check authority; give continuation Plan/Tasks explicit whole-remaining-plan scope; make optional identity echoes unnecessary and forbid actors from guessing them. Include named positive and protective regression tests and update affected packaged Apply guidance.
  - Route: delegated direct. Triggers: investigation prepares source edits; multiple nontrivial implementation/test files.
  - Expected behavior: incident-shaped Apply reports with supported presentation fields are accepted; Plan/Tasks prompts do not contradict their held scope; incorrect identity, unauthorized changes, invented checks and altered held semantics remain rejected.
  - TDD: default ODD test-first policy; no explicit project TDD configuration identified. Observe failing deterministic regressions before source edits, then GREEN and refactor.
  - Work-unit commit: `20cb636` (`fix(adaptive): remove contradictory report and planning contracts`) on `investigate-mdd-errors`. Source, tests and packaged guidance committed together; full-suite timing proof remains partial.

## Verification

1. `npm run build`
2. `node --import ./tests/isolate-home.mjs --test --test-name-pattern="incident regression" tests/adaptive-low.test.mjs tests/adaptive-continuation.test.mjs tests/adaptive-native.test.mjs tests/report-check.test.mjs`
3. `node --import ./tests/isolate-home.mjs --test tests/adaptive-low.test.mjs tests/adaptive-continuation.test.mjs tests/adaptive-native.test.mjs tests/report-check.test.mjs`
4. `npm run typecheck`
5. `git diff --check`

RDD is explicitly off for this clone. Native assessment returned `high/unassessable` because this new tracking file was untracked; this was not interpreted as low risk. An independent verifier inspected the implementation and ran the full suite. No native review or consent flow started. Parent reran `npm run typecheck`: exit 0.

## Implementation and test-first evidence

- Added 19 named `incident regression` cases across the four authorized test files before source edits. They target JSON/Markdown `delivered`, actual generated Plan/Tasks prompts covering two unfinished IDs, optional native identity echoes, duplicate/completion validation and forbidden authority claims.
- The initial build/typecheck failed because `tsc` was absent, and both test commands failed missing generated-module imports before assertions. Those infrastructure failures were not RED. Parent then explicitly authorized `npm ci --offline --ignore-scripts --no-audit --no-fund`; it succeeded using the local cache, adding 396 packages without scripts or network fallback. Dependency manifests and lockfile remain unchanged.
- Genuine RED: after building unchanged source successfully, the exact named regression command ran all 19 test cases: 5 passed and 14 failed. JSON/Markdown Apply rejected `delivered`; generated Plan/Tasks scope and identity-omission instructions failed their assertions.
- GREEN: adaptive receipts now reuse the canonical common envelope and Apply field vocabulary; presentation cannot earn completion or check authority. Fixed-route correction/version fields and unknown keys remain excluded. Prompt and packaged Apply guidance agree on optional `delivered` and omitted identity echoes.
- The first implementation pass reached 18/19: the duplicate-completion test expected the wrong diagnostic word. Its assertion was corrected to the unchanged reader's actual `unique planned identifiers` diagnostic; duplicate rejection was preserved. Then 19/19 and the 290-test focused suite passed.
- Refactor while GREEN: Plan/Tasks and Verify now receive separate role-specific guidance. Planning covers every unfinished held ID; Apply owns only the selected assignment; Verify remains read-only against the exact parent history. Added assertions confirm unchanged whole-held planning reads and single-assignment Apply writes. Final reruns below passed.

| Required command | Final observed result |
|---|---|
| `npm run build` | Exit 0. |
| Named incident regression command above | Exit 0: 19 passed, 0 failed, 0 skipped. |
| Four-file test command above | Exit 0: 290 passed, 0 failed, 0 skipped. |
| `npm run typecheck` | Exit 0. |
| `git diff --check` | Exit 0: no whitespace errors. |

Protective coverage also passed: `AL-04c: invalid remaining authority pauses the stage`, `AL-04c: forged Verify executions do not grant command authority or closure`, `AL-03: re-preparing unchanged source cannot erase previously reported failed attempts`, and the existing source-drift, required-check and native-edit fences. These are local deterministic runtime harness tests, not live incident recovery or independent provider execution. No incident repository, live journal, installed package or global configuration changed.

## Independent verification and remaining limitation

- Independent diff inspection found no severe candidate-caused issue or weakened protective boundary. All 19 incident regressions passed during the full suite as well.
- `npm test`: exit 1, 2,865 passed, 2 failed, 3 skipped, 2,870 total; duration 686.804 seconds. The two failures were five-second subprocess timeouts in `tests/config-ui.test.mjs:283` and `tests/judgment-day.test.mjs:71`. The three skipped checks remain skipped, not passes.
- One bounded sequential isolation run per failed test passed all assertions, without changing timeouts or retrying the full suite:
  - `node --import ./tests/isolate-home.mjs --test --test-name-pattern="^new command validation and help are deterministic and preserve exit semantics$" tests/config-ui.test.mjs`: exit 0, 1/1 passed, 1.894 seconds.
  - `node --import ./tests/isolate-home.mjs --test --test-name-pattern="^immutable inspection returns committed trees/blobs/diffs, never dirty or untracked source$" tests/judgment-day.test.mjs`: exit 0, 1/1 passed, 2.039 seconds.
- Those test files and direct implementations are unchanged; their built literal local-import closures do not reach the changed runtime modules. The full-suite timeouts were not reproduced in isolation. This does not prove baseline causation or a green full suite.
- Verification remains partial for full-suite timing reliability; T01 stays unchecked rather than claiming all repository checks passed. The focal behavior and protective assertions are verified.

## Delivery and recovery

- Forecast: approximately 120–250 authored changed lines plus this tracking document; advisory, not a hard cap.
- Strategy: `ask-on-risk`; ask about delivery slices if the forecast or measured work exceeds approximately 400 authored lines. No push or PR requested.
- Work-unit boundary: one coherent incident-friction fix, including behavior, tests and packaged guidance.
- Rollback boundary: this task's changes only; no installed/live state is changed.
- Running authored lines: behavior/guidance/tests total 125 additions + 14 deletions = 139 changed lines, plus the tracking document. Generated output is excluded; total remains below the approximately 400-line delivery heuristic.
- RDD: off, decided by clone-local preference; ordinary checks apply, review remains disabled/unmanaged.
- Engram mirror: pending; this worker's required save to the resolved `mdd-orchestrator` project also failed with `session_project_mismatch`. No project switch or invented session was attempted.
- Next step: resolve full-suite timing reliability if a fully green aggregate run is required. Installing this source into the user's active MDD is a separate operation and has not occurred. No push or PR was performed.
