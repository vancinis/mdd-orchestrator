# my-driven-development (MDD)

**OpenCode V2: targets 2.0.22, with a native plugin entrypoint, foreground `subagent` dispatch and global `cli.json` UI registration. Model-backed end-to-end validation is still pending.** The original proof flags remain a dry run. Native runs preserve protected preflight/approval, tracked native fallback, optional bound Engram receipts, artifact handoff, and reported Verify checks. See [OpenCode setup and limits](docs/opencode-adapter.md).

Installation, named-profile commands, the explicit-save editor and doctor now use one global
OpenCode installation. **The native plugin reads global settings only; telemetry preference is
global and event files remain workspace-local.** Installation readiness is not model-backed
workflow acceptance. Packaged cleanup and PR-body assets no longer depend
on workspace copies. Start with [global setup](docs/setup.md). The [configuration guide](docs/configuration.md)
describes the shared runtime settings; model-backed E2E and final review remain separate.

## Product priorities

1. Start with a useful design or plan.
2. Verify the implementation against **both requirements and plan**.
3. Treat time and quality as joint constraints on both routes; avoid unnecessary process.
4. Keep user-facing summaries simple, regardless of technical complexity.
5. Help the user get from the current state to the requested outcome.

An approved plan continues without redundant process prompts in automatic mode. Explicit
interactive mode, native permissions, scope safety and review boundaries remain intact.
Fresh native implementation uses `mdd_adapt`, including precise edits. Low holds a compact
acceptance/scope/evidence contract and selects only the next necessary actor; Plan and Verify
are optional. Medium uses structured Plan/Apply/Verify; high uses
Propose/Spec/Design/Tasks/Apply/Verify. Parent checks remain subject to native permissions.
Configured interactive/automatic mode is preserved; unset mode asks only mode. Historical runs
and explicit `mdd_start` retain the fixed Explore/Risk low-or-high compatibility workflow.

Read `mdd_status` for exact operations and paged input/detail references. Version 3 is native-only:
the CLI and fixed `Workflow` cannot fabricate its runtime context. Terminal runs can be replaced
in the same parent after a genuine fresh user turn: immutable archival readback and exact ownership
CAS precede replacement. Uncertain publication stays fenced until exact cold reconciliation.
Structured reported evidence is not independent command attestation or proof of correctness.

## Set up MDD

If upgrading from V1 and only `tui.json(c)` exists, start OpenCode V2 once so it migrates terminal
preferences to `cli.json` before running MDD setup. MDD does not perform or bypass that migration.

Run **`npm run setup`** in the trusted source checkout, even without a build. It offers missing
dependencies/build with separate consent, then one wizard in Spanish with four numbered steps:
global destination, optional memory, review, apply/check. Its lists take the arrow keys plus
Enter or a direct option number. It installs into `$XDG_CONFIG_HOME/opencode/mdd`, or
`~/.config/opencode/mdd` when XDG is unset, never into the active workspace.
Installing also writes an `mdd-ai` launcher into MDD's own `bin` folder. Installing never edits
your environment: run **`node "<OpenCode root>/mdd/node_modules/my-driven-development/dist/cli.js" link`**
once to append only that folder to your **user** PATH, and afterwards **`mdd-ai`** opens the same
install/update wizard from any directory. Without `link`, every command still works through its
absolute path.
Fresh memory defaults off; compatible Engram is reused only if selected, never reinstalled.
To deploy later changes, build and run **`mdd-ai update`** from the source checkout: it reviews the
outdated owned package and replaces it under the same explicit Apply, without touching settings,
memory or unrelated agents. See [setup and installer safety](docs/setup.md). No model,
default-agent change or publication is implied. Advanced `mdd-ai config` and read-only
`mdd-ai doctor` remain optional controls.

## Standalone Judgment Day

In `mdd-orchestrator`, request: **"Run judgment-day on the complete committed change from
<base commit> to <target commit>, including its tests and relevant dependencies."**
`judgment day` and `judment-day` are also accepted explicit request spellings; ordinary review
and completed Verify do not trigger it. The packaged `mdd-judgment-day` skill coordinates two
blind foreground judges without adding a workflow phase or requiring RDD.

Use existing **`mdd-ai config` → Modelos** for `mdd-jd-judge-a`, `mdd-jd-judge-b` and `mdd-jd-fix`,
save and restart OpenCode. Existing consent-driven setup/update installs the skill and reference;
see [setup](docs/setup.md) and [Judgment Day configuration](docs/configuration.md#standalone-judgment-day-model-roles).

Dirty/untracked target material needs separately authorized committed snapshotting; it is never
quietly excluded. Judges inspect committed Git objects only, with no live reads, shell or tests.
Malformed, partial or unavailable inspection cannot produce APPROVED. Confirmed introduced severe
defects require explicit bounded correction consent, permit at most two rounds and respect active
workflow ownership. Functional verification is separate; no verdict grants receipt or delivery
authority. Model-backed native-host smoke remains unverified.

## Run the proof (development)

Use Node.js **24.6+ within 24.x, or 26.4+ within 26.x** and npm. From this directory, run these commands individually in PowerShell; continue only when the preceding command succeeds:

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
node dist/cli.js --answers examples/answers.json
```

`npm test` builds the TypeScript source and runs the native Node test suite. To build without running tests, use `npm run build`.

The example validates the answers and prints the first phase, `mdd-explore`; nothing is scored, and the route is selected later by `mdd-risk`. Output is JSON containing `policyVersion`, `phases` and explanatory `reasons`.

### Profiles

```powershell
# Same result as the explicit answers above; no prompts.
node dist/cli.js --profile examples/profile.json

node dist/cli.js --help
```

`--explore` is still accepted for saved invocations but no longer changes the first phase, and
`--config` is refused: there are no weights or threshold left to configure.

Quote paths containing spaces, for example `--answers "C:\work items\answers.json"`. Files use UTF-8 JSON; a leading UTF-8 BOM is accepted for PowerShell compatibility. Relative paths resolve from the current working directory. The proof flags have file inputs only, not inline JSON or stdin.

Supply **exactly one** of `--answers` and `--profile`. Repeated flags, unknown arguments, malformed JSON and incomplete answers fail rather than selecting hidden defaults. `--help` must appear alone. Read `$LASTEXITCODE` immediately after a command to inspect its result:

| Exit code | Meaning |
|---|---|
| `0` | Decision printed, or help displayed. |
| `2` | Invalid CLI arguments, JSON, answers or profile. |
| `1` | File I/O or unexpected failure. |

Errors go to stderr; no decision JSON is emitted on failure. A proof `--profile` file is only `{ "answers": { ...all four fields... } }` (a legacy `complexity` field is accepted and ignored); named profiles are managed separately through `config` or `profile` commands and are not sessions.

## Policy at a glance

- No score: every run starts with exactly one `mdd-explore`, then `mdd-risk` selects the route.
- Low: `mdd-explore`, `mdd-plan`, `mdd-apply`, `mdd-verify`.
- High: `mdd-explore`, `mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify`.
- The certainty answer reaches `mdd-risk` as the user's statement of how clear the requirements are; it is weighed, never obeyed. (The legacy `complexity` preflight field is accepted but ignored.)
- New native runs use configured, validated Engram automatically; with memory off they preserve complete task evidence locally. Storage is not a preflight question. Configured Engram failures block without local fallback.

See the [product contract](docs/product-contract.md) for every stable input token, validation constraint, kernel API, and deferred product requirement.

## In-memory lifecycle

After building, run `node examples/workflow-demo.mjs` to see automatic advancement and phase-scoped interactive approvals. **All results and approvals in this demo are simulated**, not model execution or independent verification.

```javascript
import { Workflow } from './dist/workflow.js';
import answers from './examples/answers.json' with { type: 'json' };

const workflow = new Workflow({ profile: { answers } });
const action = workflow.nextAction(); // { kind: 'execute', phase: 'mdd-plan' }
workflow.start(action.phase);
workflow.recordResult({
  phase: action.phase, outcome: 'passed', evidenceSummary: 'Simulated evidence only.',
});
console.log(workflow.snapshot()); // Captured answers/evaluation, nextAction, results.
```

`Workflow` accepts the same request as `evaluate`. Its first phase is ready immediately. `nextAction()` returns `execute`, `approve`, `await-result`, or `blocked` with the exact phase, or `finished` without one. Reads do not advance state. Interactive callers must use `approve(phase)` for each pending phase; automatic mode makes the next phase ready without approval. Neither mode dispatches it automatically. A recorded failed result stops the route; `retry()` releases an attempt that never produced a recorded result so the same phase can run again.

Preflight reuse and state inspection work only within the live controller. New requirements need a new controller. The controller itself holds no persistence, contextual rerouting or substantive-change detection; `Workflow.replay` rebuilds one only from validated events. Adapters must eventually enforce real phase evidence; this proof only validates caller-supplied result structure.

### Resuming after a restart, or in a new conversation

The OpenCode adapter checkpoints every settled step of a run. After OpenCode restarts, ask for the status in the same conversation and the run continues where it settled: a ready phase can be dispatched again, a pending approval is asked again, and nothing that was in flight is replayed — if a subagent or question was interrupted, MDD waits until OpenCode confirms it stopped or you say so yourself (`mdd_reset` with your own message). Unconfirmed local task publication blocks advancement and automatic retry; retained evidence does not become approval.

To continue a run in a **new conversation**, read `mdd_status` in the old one for its `sessionID` and `runID`, then write in the new conversation something like `Continue sourceSessionID=<sessionID> runID=<runID> here.` The coordinator transfers the run with `mdd_transfer`: the old conversation is fenced, the evidence moves, and any approval is asked again. An interrupted transfer is resolved with `mdd_transfer_recover` on your explicit request. See [the adapter guide](docs/opencode-adapter.md#restart-resume).

## Implementation boundaries

| Area | Current state |
|---|---|
| Kernel | Pure validated evaluation; no clocks, randomness, model inference, I/O, or confidence reporting. |
| CLI/setup | One consent-driven setup TUI, source bootstrap, trusted local package installation, optional pinned Windows memory installer, owned-asset updates, read-only doctor and advanced editor; proof flags unchanged. |
| Foundations | Frozen models/profile/Engram settings, phase reports whose detail level selects which narrative sections are shown, and allowlisted local runtime telemetry. |
| Lifecycle | Private in-memory state, isolated snapshots, exact phase/result/approval boundaries; no dispatch. No state is terminal: a failed attempt returns its phase to ready, one retry stays with the same actor before the coordinator takes over, an unlisted answer leaves its question open, and `mdd_reset` always has an exit, including re-opening a pending approval. |
| OpenCode adapter | Requirements-only native intake; exact questions/approvals; all eight phases by delegation or carried out inline by the coordinator; bounded dependency handoff; reported change/check evidence; selected artifact storage and general receipts. |
| Tests | Native Node tests, CLI subprocesses, real loopback HTTP transport, and explicitly mocked SDK contract tests. No paid agent E2E execution. |
| Changes and context | Fresh implementation and precise edits use the version-3 native contract. Unknown context may use read-only contextual Explore before immutable admission. Existing fixed runs retain native-confirmed re-preflight; contextual exploration never grants implementation authority. |
| PR body | A coordinator tool uses the exact packaged skill/template and current recorded facts, or, for a quick edit with no run, the files git lists against the PR target branch plus the coordinator's own Spanish reasons, stated as unverified by MDD. Unknowns remain unverified; no branch/commit/push/PR creation authority. |
| Validation boundary | Contract suites and model-free startup checks do not prove real model output quality or permission UI behavior. User-authorized model-backed E2E/final review remains pending. |
| Deliberately unsupported | Resuming a run after process loss and exactly-once guarantees (its evidence is preserved and reported as read-only data instead), delivery/publication automation, and non-OpenCode provider adapters. |

The adapter selects new-run storage from MDD's frozen `engram` settings, not ambient MCP tools
or deprecated profile storage answers. Omit `engram` to keep memory off: no HTTP, service startup
or session registration occurs. Complete local artifacts and progress then live under the
repository anchor at `.mdd/tasks/<safe-objective-slug>-<run-UUID>/`. Inspect
`mdd_status.storage.backend` and `storage.taskDirectory` for the actual backend/location.
Existing Engram/OpenSpec/Both/None/local runs keep their pinned backend on restart and transfer;
there is no migration. General Engram receipts contain a bounded summary and artifact reference, not the
full artifact. Only a final successful Verify reaches `complete`. Evidence flags describe what
each phase reported, not independent proof, and coverage is not correctness probability.

Opted-in memory automatically resolves the project and registers the actual native parent.
Endpoint-only settings are supported; the deprecated project field is ignored with a notice,
never used to bind another workspace. A managed-local variant lazily starts an
already approved installed binary. No installation or upgrade is performed by the adapter.
The unified TUI configures this once globally; see [optional memory](docs/configuration.md#optional-memory).

Implementation is direct, without SDD phases/artifacts, global OpenCode changes, commits, or PRs. The foundation work initialized a local CodeGraph index for inspection. Dependencies are local; the adapter pins the runtime package `@opencode-ai/plugin@1.18.31`.

## Verification and review

Functional tests and independent review are separate evidence. Historically, the installed release accepted the first kernel candidate's file selection, after which the user chose to skip that candidate's review. The earlier selection-format blocker is no longer applicable. That history does not establish a review verdict for this lifecycle increment.
