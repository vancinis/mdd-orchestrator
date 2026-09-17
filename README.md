# my-driven-development (MDD)

**Status: complete main low/high route execution is implemented and contract-tested in the opt-in OpenCode adapter. Model-backed end-to-end validation is still pending.** The original proof flags remain a dry run. Native runs use protected preflight/approval, delegation with an inline fallback, bound Engram receipts, artifact handoff, and reported Verify checks. See [OpenCode setup and limits](docs/opencode-adapter.md).

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
Low uses one compact plan, not extra phases or mandatory design paperwork. Existing weights
and the high-route threshold of 50 are unchanged; style-weight tuning is future work, not a
reason to stop an approved plan.

## Set up MDD

Run **`npm run setup`** in the trusted source checkout, even without a build. It offers missing
dependencies/build with separate consent, then one wizard in Spanish with four numbered steps:
global destination, optional memory, review, apply/check. Its lists take the arrow keys plus
Enter or a direct option number. It installs into `$XDG_CONFIG_HOME/opencode/mdd`, or
`~/.config/opencode/mdd` when XDG is unset, never into the active workspace.
After installation, use `node "<OpenCode root>/mdd/node_modules/my-driven-development/dist/cli.js" setup`
from any directory (or `mdd setup` if that executable is already on your PATH; setup does not edit PATH).
Fresh memory defaults off; compatible Engram is reused only if selected, never reinstalled.
To deploy later changes, build and run **`mdd update`** from the source checkout: it reviews the
outdated owned package and replaces it under the same explicit Apply, without touching settings,
memory or unrelated agents. See [setup and installer safety](docs/setup.md). No model,
default-agent change or publication is implied. Advanced `mdd config` and read-only `mdd doctor`
remain optional controls.

## Run the proof (development)

Use Node.js **24.6 or later in the 24.x series** and npm. From this directory, run these commands individually in PowerShell; continue only when the preceding command succeeds:

```powershell
npm ci --ignore-scripts
npm run typecheck
npm test
node dist/cli.js --answers examples/answers.json
```

`npm test` builds the TypeScript source and runs the native Node test suite. To build without running tests, use `npm run build`.

The example scores **20 points** and selects `low` with `mdd-plan → mdd-apply → mdd-verify`. Output is JSON containing `policyVersion`, `score`, `threshold`, `route`, `phases`, individual `contributions`, and explanatory `reasons`.

### Profiles, overrides, and exploration

```powershell
# Same result as the explicit answers above; no prompts.
node dist/cli.js --profile examples/profile.json

# Override one weight: score 50 equals the threshold, so the route is high.
node dist/cli.js --answers examples/answers.json --config examples/config.json

# Request exploration for otherwise clear low-route work.
node dist/cli.js --answers examples/answers.json --explore

node dist/cli.js --help
```

Quote paths containing spaces, for example `--answers "C:\work items\answers.json"`. Files use UTF-8 JSON; a leading UTF-8 BOM is accepted for PowerShell compatibility. Relative paths resolve from the current working directory. The proof flags have file inputs only, not inline JSON or stdin.

Supply **exactly one** of `--answers` and `--profile`. Repeated flags, unknown arguments, malformed JSON, incomplete answers, and invalid configuration fail rather than selecting hidden defaults. `--help` must appear alone. Read `$LASTEXITCODE` immediately after a command to inspect its result:

| Exit code | Meaning |
|---|---|
| `0` | Decision printed, or help displayed. |
| `2` | Invalid CLI arguments, JSON, answers, profile, or configuration. |
| `1` | File I/O or unexpected failure. |

Errors go to stderr; no decision JSON is emitted on failure. A proof `--profile` file is only `{ "answers": { ...all five fields... } }`; named profiles are managed separately through `config` or `profile` commands and are not sessions.

## Policy at a glance

- Default score range: **20–90 points**, not probability or confidence.
- High route: score **≥ 50** by default; threshold and weights are configurable.
- Low: optional `mdd-explore`, then `mdd-plan`, `mdd-apply`, `mdd-verify`.
- High: `mdd-explore`, `mdd-propose`, `mdd-spec`, `mdd-design`, `mdd-tasks`, `mdd-apply`, `mdd-verify`.
- Low requires exploration if certainty is not `very-sure` **or** complexity is not `not-complex`. Explicit exploration can also be requested. High always contains exactly one explore.
- Artifact storage never contributes points. Engram installation and use are optional. With memory off, choose OpenSpec or live-only `none`; Engram and Both require an opted-in backend.

See the [product contract](docs/product-contract.md) for every stable input token, score, validation constraint, kernel API, and deferred product requirement.

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

Preflight reuse and state inspection work only within the live controller. New requirements need a new controller. There is no persistence, crash recovery, contextual rerouting, or substantive-change detection. Adapters must eventually enforce real phase evidence; this proof only validates caller-supplied result structure.

## Implementation boundaries

| Area | Current state |
|---|---|
| Kernel | Pure validated evaluation; no clocks, randomness, model inference, I/O, or confidence reporting. |
| CLI/setup | One consent-driven setup TUI, source bootstrap, trusted local package installation, optional pinned Windows memory installer, owned-asset updates, read-only doctor and advanced editor; proof flags unchanged. |
| Foundations | Frozen models/profile/Engram settings, phase-specific coverage reports, and allowlisted local runtime telemetry. |
| Lifecycle | Private in-memory state, isolated snapshots, exact phase/result/approval boundaries; no dispatch. No state is terminal: a failed attempt returns its phase to ready and `mdd_reset` always has an exit. |
| OpenCode adapter | Requirements-only native intake; exact questions/approvals; all eight phases by delegation or carried out inline by the coordinator; bounded dependency handoff; reported change/check evidence; selected artifact storage and general receipts. |
| Tests | Native Node tests, CLI subprocesses, real loopback HTTP transport, and explicitly mocked SDK contract tests. No paid agent E2E execution. |
| Changes and context | Native-confirmed re-preflight creates a new planned run without erasing old evidence; idle contextual exploration leaves the main workflow/approval unchanged. |
| PR body | A coordinator tool uses the exact packaged skill/template and current recorded facts. Unknowns remain unverified; no branch/commit/push/PR creation authority. |
| Validation boundary | Contract suites and model-free startup checks do not prove real model output quality or permission UI behavior. User-authorized model-backed E2E/final review remains pending. |
| Deliberately unsupported | Automatic crash recovery/exactly-once guarantees, delivery/publication automation, and non-OpenCode provider adapters. |

The adapter uses Engram as optional general memory independently of artifact storage. Omit
`engram` settings to keep memory off: no HTTP, service startup or session registration occurs.
Native validation and local progress protection still run. Every
phase writes dedicated artifacts only to the selected backend; `openspec` or `both`
explicitly creates the documented OpenSpec paths. `none` retains full artifact text only
in live state. General receipts contain a bounded summary and artifact reference, not the
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
