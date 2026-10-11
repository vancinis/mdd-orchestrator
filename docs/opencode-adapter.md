# Run the main MDD routes in OpenCode

This opt-in adapter targets OpenCode **V2 2.0.22** and preserves the approved low/high main routes.
It uses the native permission-controlled foreground `subagent` tool, not SDK prompting.
When optional Engram memory is enabled, receipts must be read back before dispatch and before recording a result.
Verify reports commands and their outcomes. MDD validates the **consistency of actor-reported
evidence**, not independent execution attestation, semantic correctness or independent review.
Model-backed E2E is pending.

## Structured verification and legacy replay

New runs capture `verificationVersion: 1` before planning. The runner supplies the frozen contract
and held plan to the shared validators; an actor cannot select the legacy contract by omitting
structured fields. The marker survives checkpoints, dossiers, restart and transfer. Report format
instructions select the recorded version, including on resumed runs.

| Field | Version 1 contract |
|---|---|
| `deliverables[].checks` | Nonempty objects `{id, command, requirement, appliesWhen?}`. IDs are globally unique across the plan; `requirement` is `required` or `optional`. Declare conditions before execution. |
| `checks` | Actual executions `{id, command, exit}` in chronological order. Each attempt has its own ID, including repeated commands. `exit` is an integer or `null` for an interrupted execution. |
| Assessment `checks` | Execution IDs, covering every held scenario-step link, step and decision. A verified row cites successful final executions and explains source-based semantic evidence. |
| `verification.checkResults` | Exactly one `{checkID, disposition, executions, reason?, equivalence?}` for each held check. Requiredness and applicability come from the held plan, never from this report. |
| `verification.supplementalChecks` | Additional executions grouped as `{id, requirement, disposition, executions, reason?}`. Every execution is accounted for, including failures. Supplemental entries cannot overlap held evidence or downgrade held checks. |

Disposition rules:

- **passed / failed / ran:** at least one execution, ending in exit 0 / a nonzero exit / null.
- **blocked:** no execution and a reason describing the blocker.
- **not-applicable:** no execution, a condition already held in `appliesWhen`, and a source-based
  reason explaining why it does not apply. Unconditional checks cannot be waived this way.
- **replaced:** an actually executed successful replacement, a reason and an equivalence rationale
  explaining how it covers the held check. Replacement references execution IDs, never another
  replacement disposition. Command equality binds an attempt to a declared check; it does not
  determine whether a check is material.

Every disposition except `passed` requires a reason. Multiple attempts also require a reason.
Preserve failed attempts and their order: the final attempt determines the disposition, and an
earlier green attempt cannot support acceptance after a failed retry. One integration execution
may support multiple held checks, but each must retain the same complete attempt history and
provide equivalence evidence when replacing a different command. Do not invent duplicate executions.

Required applicable failed, interrupted, blocked or missing results cannot earn PASS. Optional
failures remain visible without blocking independently supported semantic acceptance; their failed
executions cannot support verified rows. Supplemental dispositions are `passed`, `failed` or `ran`;
required supplemental failures also prevent PASS. Successful checks alone never replace run-wide
semantic acceptance coverage.

`mdd_check_report` uses the version reported in the document for advisory form checking. It has no
held plan and cannot authenticate requiredness or applicability. The runner checks the same report
against its frozen plan. Neither validates that an actor actually executed a command or that its
source-based applicability/equivalence rationale is true; these remain reported evidence.

**Legacy records have no marker.** They resume the recorded command-based schema, retaining
commands, outcomes and historical matched fields. MDD does not synthesize IDs, requiredness or
execution proof. Status, preserved-run views and PR evidence limits label this weaker evidence.
Mixed versioned/legacy payloads are rejected. Existing PR rendering retains command/exit counts,
failures and reported limits for both contracts.

PR facts carry the recorded verification version. For version 1, verification blockers use the
runner's settled verification result, which includes unresolved required dispositions and semantic
coverage. Optional failures and failed attempts followed by a successful retry remain visible under
`Verificación` without becoming current blockers by themselves. Unresolved required checks and
semantic gaps remain incomplete under `Bloqueos`, even when every recorded execution exited 0.
Unversioned PR facts retain legacy behavior: every nonzero or interrupted execution is a blocker.
Recorded limits, missing implementation evidence and uncertainty continue to be reported separately.

## Continue working after failed verification

A recorded failed Verify stops the current run, not all future work. Nothing continues automatically.
The coordinator interprets the user's request and selects an existing typed action; the runtime
authenticates the exact latest native text without parsing intent or requiring special consent words.

| User intent | Action |
|---|---|
| Correct the same implementation | `mdd_reset({scope:"rework", userText})` returns to Apply with the findings. |
| Retry the checks | `mdd_reset({scope:"phase"})` retries Verify in the same run. |
| Proceed despite the failed checks | `mdd_reset({scope:"continue", runID, userText})` preserves the failed run and releases its active stop. |
| Start a clear new objective | `mdd_start({requirements})` authenticates the latest request, preserves the failed predecessor and applies normal new-task preflight. No manual discard is needed. |

Verify is the last phase in both routes. `continued-with-failed-verification` is **not complete or
PASS**, and bare continuation authorizes no next work. Unclear requested work may need one focused
clarification; an already clear request does not need a new workflow-confirmation ritual.

Continuation requires a matching run ID, unused native message identity, settled checkpoint/progress
and the existing exclusive writer. It cannot release a pending actor, question, intake or transfer,
and never enters stopped-child attestation or aborts a child. Replayed consent cannot retire a later
run. Reported uncertainties remain evidence; they are not automatically new native questions.

Before retiring the parent claim, MDD writes and reads back a parent/run-bound
`.mdd/run-<64-hex>.continued.json` archive and its current dossier index. It records the native request,
message identity, action, timestamp and source checkpoint sequence/digest alongside the failed result.
Archive errors leave the active failed run and ownership intact. Retirement is the final durable
mutation: the original failed checkpoint and settled progress stay data-only behind the existing
retirement marker until a fresh authenticated start clears them. A restart checks their archive binding
and never replays the failed run as successful. Continued records are excluded from active workspace
run listings; the archive remains accessible after the current dossier is replaced by new work.

`mdd_pr_body({runID, userText, ...})` targets that retained failed run explicitly. Its checks and limits
remain visible and `verified` stays false for both version 1 and unversioned legacy evidence; no IDs
or proof are manufactured. This local continuation grants no security review, Judgment Day, commit,
push or publication authority. These tests exercise native host contracts, not live-model behavior.

## Setup

### Visual status

MDD's server reports retain the route/progress/skills frame. The separate V2 CLI plugin observes
correlated native tool-success events and supplies sidebar updates, transition toasts and
best-effort attention. These presentations do not authorize a phase or change its skills.
Set `MDD_ASCII=1` in the server environment for ASCII status reports. CLI sidebar/toast options
are independent, supplied through the plugin's `options.ascii` and `options.toasts`.

Setup merges this entry into global `cli.json`, preserving unrelated plugins and attention settings.
Malformed configs fail before owned assets are written. When only legacy `tui.json(c)` exists,
start V2 once to let OpenCode migrate it before running setup:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["./mdd/node_modules/my-driven-development/dist/opencode-tui.js"]
}
```

The CLI plugin exports `id: "mdd.visual"` and `setup`, appends to `sidebar.content`, and cleans up
its subscription and slot on unload. Renderer failures and failed notifications never affect
the run. OpenCode's `attention.sound` setting controls playback; MDD asks for sound, not a second
desktop notification. Installed-prefix tests exercise real Solid reactivity with JSX creation
stubbed under Node. Interactive rendering and sound playback have not been visually verified.

Run the single [setup wizard](setup.md): `npm run setup` from trusted source, or
`node "<OpenCode root>/mdd/node_modules/my-driven-development/dist/cli.js" setup` from any directory.

1. Use OpenCode **2.0.22** and Node **24.6+ within 24.x, or 26.4+ within 26.x**. Setup offers missing dependencies,
   optional Engram **1.20.0**, global assets and a readiness check in one invocation.
2. After Ready, run `opencode service restart` when no work is in flight, then reopen OpenCode
   in the active project. Reloading configuration or closing only the UI can retain imported
   modules from the previous installation. `<OpenCode root>/plugins/mdd.ts` imports the installed package
   under `<OpenCode root>/mdd/node_modules`; execution workspaces need no installation files.
3. Advanced `mdd config` is optional. Answers may be partial; blank values remain unanswered.
   Explicitly select **mdd-orchestrator**, not the default agent. This
   adapter applies only explicit model overrides from the active global profile at startup.
   Otherwise it preserves native selection. Choose only models you have authorized to use.
4. No manual status/ID registration setup step is required. Opted-in memory resolves and validates
   the project and bootstraps the exact native parent before execution.
5. Supply your requirements as native user text. The orchestrator calls
   `mdd_start({ requirements })` with that exact text, not a rewrite. Starting opts in
   to the workflow; only configured memory stores requirements and compact progress receipts. Complete compatible profile answers
   skip questions; otherwise `mdd_status.question` contains one grouped native question
   argument object covering all and only the missing fields, followed by an optional **Notas**
   question the user answers in their own words. Genuine doubts about the request that the
   coordinator passes as `mdd_start({ requirements, questions })` join that same interaction; with
   a complete profile they are asked alone, before the first phase. Submit it once to `question`.
   No typed JSON preflight or model-supplied answer override is accepted. When the user answers
   in their own words instead, typed inside the form or written in a chat message after the form
   was closed, the coordinator records it with `mdd_answer` and MDD checks it against their text
   (see [Written answers](#written-answers)).
6. After the question, read `mdd_status`. It returns `nextAction`: the single call to make now,
   with ready-to-dispatch `args` whenever the call is dispatchable as written. Submit exactly the
    returned `task` arguments (`agent`, `description`, `prompt`), once, using native `subagent`
    foreground execution. Do not add `background`, `sessionID`, `model`, or extra keys. The hook
   appends the actual native call ID in place after checking the expected args.
   After the task, call `mdd_status` and present the readable artifact to the user. Workflow tools
   (`mdd_start`, `mdd_prepare_advance`, `mdd_revisit`, `mdd_answer`, `mdd_phase_result`,
   `mdd_reset`, `mdd_change_request`, `mdd_context`, `mdd_contextual_explore`) already reply with
   that same status, so the coordinator acts on their reply instead of reading `mdd_status` again;
   it reads status after a native question, a settled task or a tool error.
   In interactive mode, a passed phase exposes an exact native Proceed/Stop question for
   the next phase. Approval prepares only that phase's task. Automatic mode returns the next
   exact executable task without an approval question, unless the phase reported open questions:
   then it stops at review until they are answered. Repeat through final Verify. A rejected
    read-only attempt may become ready again. An uncertain Apply writer never retries automatically.
    Neither mode suppresses native edit/shell permission requests.

The MDD tools are registered for their plugin location but belong to `mdd-orchestrator`. Every
other agent has them disabled in configuration and refused at execution, so an unrelated
agent neither sees nor mutates MDD state.

### V2 host boundary and limits

### Sequential Apply batches

Apply implements **one dependency-ordered planned deliverable per fresh foreground actor**.
After a successful batch, read `mdd_status` and dispatch its next exact task automatically:
nonfinal success remains in Apply; only the final deliverable advances to Verify. In interactive
mode, entering Apply and then Verify retains the ordinary phase approvals; successful batches
within the approved Apply phase need no additional approval. Native edit/shell consent still applies.

- A successful report must name `completed=[assignedStepID]`. Empty, duplicate, unknown,
  already completed or unassigned IDs earn no progress. Failed/partial work earns none.
- Completion is replayed from workflow events, not inferred from artifact prose. Confirmed
  checkpoints precede exposure of the next writer. Settled legacy histories remain readable;
  a newly authorized legacy Apply binds its held plan before dispatch. Explicit rework starts
  a new completion epoch and keeps prior changes as evidence, never as new completion authority.
  A legacy record whose file list was truncated remains readable but cannot dispatch new Apply
  work: inspect the full diff and start a fresh run instead of inventing missing evidence.
- Each batch attempt stores an immutable `apply/<batchID>/apply-progress.md` artifact under
  its run. Checkpoints correlate that identity with its result and retain the full changed-file
  union. Final Verify receives the full plan and all recorded changed files, not only the last batch.
- Failed, interrupted, unknown-termination or ambiguous artifact/checkpoint writes stop continuation.
  Inspect partial changes and request explicit recovery; never automatically retry substantive work.
  Malformed completed reports may still be restated without starting a writer.

Plan and Tasks split large requests into **1–32 bounded coherent deliverables**, ordered by
dependencies. Each must fit a fresh Apply actor with scoped files, its own checks and a handoff;
keep tests/docs with the behavior, not separate file-type slices. Size by implementation and
context risk, not an arbitrary line cap. If one deliverable still cannot be bounded, report that
unresolved limit honestly rather than dropping scope or stretching the contract.

Apply finishes only its assignment, preserves filesystem progress and reports actual checks,
skips and dependency assumptions for the next actor. A large total diff alone is not a stopping
condition. Genuine missing decisions, failed checks, environment failures or uncertain writes
block explicitly; the worker never silently expands scope or invents task IDs. There is no
changed-line controller: an enormous individual assignment, context/provider limits or an external
interruption can still stop an actor. Final Verify always assesses the **full plan**.

#### Reproduce the batch execution evidence

After building, run `node tests/apply-batches-host-smoke.mjs`. It requires no credentials, ambient
session/service, network provider or additional installs. It uses private HOME/config/data/temp
directories and checks for ancestor configuration before launching anything. It never probes or
reuses a user-running host. It starts only its own loopback host/provider when safe admission and
the installed V2 2.0.22 executable are available; otherwise it reports `unavailable`, not PASS.

| Evidence | What it establishes | What it does not establish |
|---|---|---|
| Deterministic transport smoke | Real motor, durable checkpoints, checked files/commands, exact next actions and safe failed/malformed completion fences; host inspection and child identities are test doubles. | Native host behavior or model quality. |
| Native-host branch | When exercised, real foreground child identities, automatic Plan → Apply → Apply → Verify, preserved files and no second writer after failed/ambiguous completion, with a local scripted model and fixture-only workload tool. | External paid-model execution, arbitrary workloads or interactive permission/UI behavior. |

In the T2 verification environment, an ancestor `.opencode` directory prevented safe native-host
admission. The native execution branch remains unverified; deterministic PASS must not be read
as native-host PASS. Failed and malformed completion scenarios are distinct from ambiguous
artifact/checkpoint transport writes, which the motor regressions cover separately. Paid-model
end-to-end execution remains pending.

### V2 translation boundary

`src/opencode-v2.ts` translates V2 records and native `subagent`/`question` results into the
existing motor protocol. The sections below retain internal `task`/`subagent_type` names where
they describe that motor, not arguments to send to V2. The legacy motor remains exported for
regression tests; this is not a claim of maintained V1 host acceptance.

- All host actions stay on the supplied plugin context, including remote or private servers.
  MDD tools require the exact location and project. Moved sessions cannot complete an old dispatch.
- Agent model overrides and isolation permissions are registered again after startup contributions,
  and awaited before a coordinator tool runs. Otherwise later file-agent registration can overwrite them.
- History comes from `session.context`; synthetic records never authorize consent. History before
  a location switch is discarded. The plugin context has no exact-message lookup, so an older
  request absent from effective context cannot authorize restart/transfer recovery.
- Child status is learned from native events. Missing events, a restarted stream, or a closed
  stream mean **unknown**, never idle. Explicit native user recovery remains available; automatic
  recovery cannot assume that an unseen child stopped.
- Tools are direct (`codemode: false`). Model context collapses settled phase prompts and
  superseded status replies without rewriting persisted native messages or recorded artifacts.

Run `node tests/opencode-v2-host-smoke.mjs` after building for the explicit host check; it accepts
any installed OpenCode **>= 2.0.0**.
It starts a service in isolated XDG directories, authenticates from that service's registration,
and verifies the exact MDD tool and agent sets (read from the plugin and the packaged agents, not
counted by hand), profile variants and that only the coordinator can dispatch subagents, without
model requests. Contract tests cover intake, grouped questions, foreground Plan/Apply/Verify,
native fallback restrictions, workspace isolation and CLI events. Neither check proves model-backed
end-to-end execution or interactive permission/UI behavior.

### Bounded worker authority (internal host capability)

**Production supports read-only exploration and formatter-free bounded Apply batches.** The captured
`workers.enabled` preference alone never authorizes concurrent writes. Production supplies
`workerCapability: { phase: 'mdd-explore', readOnly: true, applyEditing: true }` only after registering
the scoped native editing primitive on the V2 host. There is no exact host-version pin: the V2
entrypoint already implies a V2 host, and the fence still fails closed without native progress
binding. The old `{ confined: true }` constructor field remains synthetic-only; production never
enables that unfenced legacy role. Missing durable stores or incomplete scopes also keep dispatch serial.
Capabilities are internal host attestations, never tool arguments or actor-controlled flags.
`runner.workerAssignment({ sessionID, callID })` returns a detached assigned task/scope only for
an admitted pending member. The confinement hook must bind that call to the actual native child,
revalidate filesystem aliases, enforce read/write scope on the registered editor, and refuse uncontrolled
tools before supplying the capability. Status or a prompt claiming a scope is never a fence.

With that explicit capability and checkpoint/ownership/progress stores, independent Apply tasks
may expose `tasks` and `nextAction.calls` (one or two exact native foreground argument objects).
Legacy status still exposes singular `task` and `nextAction.args`. The V2 adapter maps both to
`agent`, `description`, and the unchanged provider-issued dispatch handle. Verify remains singular.

| Boundary | Contract |
|---|---|
| Selection | Complete dependency and read/write declarations; at most two independent ready tasks. Snapshot validation is not an edit fence. |
| Admission | One parent/run reservation for the entire batch; serialized per-run admission and CAS member updates. |
| Result | Exact call and expanded arguments bind the existing sealed Apply report to its assigned task. Changed paths must fit declared writes; `checks=[]`. Actor reports are claims, not independent verification. |
| Completion | Persist each exact successful member report before settlement. After every sibling settles successfully, publish one single-task Apply result per member in held-plan order, with distinct artifact identities, in one durable transition. |
| Failure | Retain successful member reports; block malformed, missing, transport, unknown-liveness, and durability outcomes. Never automatically replay completed tasks. |
| Recovery | Inspect every pending member before release. One running sibling fences the whole batch; explicit recovery retries only unfinished tasks. |
| Restart/transfer | Pending batches never resume or transfer automatically. Settled task evidence travels as checkpoint data; live handles never do. |

Version 3 checkpoints accept optional `workerPolicy` and `workerState` data without changing the
legacy format. Missing captured policy keeps old checkpoints serial, even on a capable host.
Unpublished successful evidence requires confined recovery; it never authorizes replay or advancement
past an uncertain sibling. Published progress permits ordinary single-step serial fallback if later
work is unsafe for concurrency. Complete member reports remain in the checkpoint alongside distinct
Apply artifacts. Explicit Verify rework starts a new implementation pass.
Read-only investigations use the same plural status surfaces and member/owner CAS model, with
separate durable exploration records so contextual work cannot advance or overwrite the main plan.

#### Explicit read-only exploration

Pass `exploration: { workItems: [...] }` to `mdd_start`, or `workItems: [...]` to
`mdd_contextual_explore`. The main route must already begin with `mdd-explore`; metadata never
adds a phase. Exactly two complete independent items qualify. Each names a distinct purpose:

```json
{
  "id": "routing",
  "purpose": "Inspect the existing routing boundary",
  "dependsOn": [],
  "independent": true,
  "complete": true,
  "reads": [{ "root": "/work/project", "files": ["src/router.ts"] }]
}
```

Roots must be existing local absolute paths; file entries are exact existing root-relative files,
not directories, globs, case aliases, links or remote targets. Separate local repository roots are
allowed without moving the native child's project/location. Declarations narrow reads, never
grant user authorization or `external_directory` permission. Shared reads are safe; declared
dependencies or missing independence/scope attestations fall back to one phase actor.

Before every action, a bounded gate binds parent session, assistant message, native call and
admitted owner epoch to the child through `session.tool.progress`. Native child parent/project/
location must match. No role, arrival order, prompt or history reconstruction grants authority.
Only native `read` on a declared file and `grep` with `literal: true` on one declared file pass;
unknown fields, directory reads, glob traversal, writes, edits, patches, shell, execution,
formatting, control, recursive dispatch and custom/MCP tools deny. Nested `AGENTS.md` files that
native read would load must also be declared. A missed binding deadline, conflicting progress,
lost stream or reload refuses action; instructions are not the enforcement boundary.

Member outcomes persist in `.mdd/checkpoint-SHA256("exploration:" + parentID).json` before owner
settlement. Replacing a settled exploration archives its full record under
`.mdd/checkpoint-SHA256("exploration-result:" + explorationID).json`, including member reports
omitted from a size-bounded aggregate. Completion order cannot change the aggregate ordering.
Only all-member success produces one main phase result or one contextual finding. Failures,
transport/unknown outcomes
and persistence faults retain successes and block. Restart never restores live progress authority
or automatically replays a member. Unresolved exploration is data-only: inspect its record and
native children, then use a fresh parent rather than guessing or reconstructing a launch.

#### Formatter-free Apply editing

The adapter automatically exposes `mdd_worker_edit` to an exact live progress-bound Apply child,
never to the parent, manual/unbound/stale/settled/quarantined or read-only children. Actor input carries
no identity, owner, epoch or permission. The host executor derives session identity from its native
tool context; the fence rechecks the exact admission and current batch/member reservation.
Unknown fields and operations fail closed. A request is `{ operations: [...] }`, at most 16 operations
and 256 KiB of serialized input; each operation names one exact root-relative declared write:

| Operation | Required fields |
|---|---|
| Create | `{ path, kind: "create", content }`; target must not exist. |
| Replace | `{ path, kind: "replace", expected, content }`; exact complete current text. |
| Edit | `{ path, kind: "edit", oldString, newString }`; nonempty old text matches exactly once. |
| Delete | `{ path, kind: "delete", expected }`; exact complete current text. |

Only bounded regular UTF-8 text is supported. All paths, aliases, operations and preconditions validate
before any mutation. Case aliases, traversal, absolute targets, links/hardlinks and nonregular files
refuse. Calls serialize per workspace root; the queue rechecks live authority before mutation.
Existing modes, BOM and CRLF conventions are preserved. Verified parent creation is convergent;
replacements publish atomically per file without invoking a shell, native formatter or generic editor.
Detected external drift or publication failure reports retained changes; it never blindly rolls back
over human edits. Multi-file publication is not an all-files filesystem transaction or an OS sandbox.

Scoped native reads/grep revalidate declared reads and writes, including nested `AGENTS.md` reads.
Runtime/config/instruction and hidden-state writes conservatively stay serial because implicit
bootstrap readers and shared effects are not proven by file disjointness. Bootstrap validation scans
bounded local configuration ancestors/global/explicit locations without logging values; file/env
substitutions, instruction declarations, intersecting local path/glob references, opaque JSONC or
project-local plugins refuse batching. This conservative fallback can reject otherwise harmless
configuration rather than guessing its effects. Generic native edit/write/
patch, shell, execution/Code Mode, formatting, controls, recursive agents and other custom/MCP tools
are denied at the pre-action boundary. Native permissions still govern reads and invocation of the
registered tool; its own exact-write fence is the file authority, not builtin editor permission logic.
An unsupported operation must report a blocker for explicit serial handling, not widen tools or
automatically replay retained work. Ordinary serial Apply retains native editing/checks and consent.

#### Pinned progress provenance and native proof

Run
`node tests/opencode-v2-workers-host-smoke.mjs` after building for the explicit local probe.
It loads the actual production V2 plugin on a private **2.0.22** host, drives `mdd_start`,
`mdd_status` and native foreground Plan using a test-owned loopback model fixture, and refuses
a child read with an `execute.before` hook. No external model or ambient credential is used.
Its observed running parent subagent has `metadata: {}` at the first child action. This is
expected, not evidence that native provenance is unavailable. The public ephemeral event
`session.tool.progress` carries the parent `sessionID`, exact `assistantMessageID` and native
call `id`, with the child in `metadata.sessionID`. The native executor awaits progress publication
before prompting the child. The probe verifies the exact native correlation on the real host.
Plugin subscription processing is asynchronous: a production gate must await a bounded trusted
binding, verify child parent/project/location and the admitted owner epoch, and refuse missing,
stale, conflicting or stream-lost evidence. Ephemeral progress is not replayable authority.
Completion's structured `sessionID` is too late for pre-action confinement. Actor names,
arrival order, prompt text and the first pending slot are not trusted substitutes.

The probe checks clean configuration ancestors, redirects local-runtime discovery to its own
fixture, and removes other providers. It cleans up its private host/provider and temporary HOME.
On Windows the per-user temp path may inherit `~/.opencode`; the probe uses a test-owned
system-temp child only after verifying clean ancestors. It must fail rather than load user plugins.

That original probe proves progress provenance and read refusal, not worker overlap. Run
`node tests/opencode-v2-workers-host-smoke.mjs --exploration-workers` for actual production
foreground exploration: main/contextual batches, a two-live-child barrier, reversed completion,
own-scope reads, forbidden-tool refusal, delayed/dropped/conflicting progress, external-directory
permission denial and disabled serial fallback. The fault scenarios wrap only event delivery,
not the production motor or fences.
Synthetic tests separately cover durable failures/restart and alias/schema denial. Exploration alone
does not establish native editing confinement, arbitrary-script sandboxing or Apply overlap.

Run `node tests/opencode-v2-workers-host-smoke.mjs --apply-workers` for the actual production Apply
matrix: main, failure, progress-loss, disabled, dependent, overlap, missing-metadata and implicit
instruction-write fallback. A two-live-child barrier and reversed edits/completion prove overlap,
own-file edits and held-plan-order single-task results. Out-of-scope reads/writes and multi-file requests,
generic editors, shell, execution, custom/MCP/control tools and recursion refuse before target mutation.
The MCP fixture uses the same test-owned loopback listener/token, with a real native initialize/catalog
handshake; its mutation endpoint is never called. No ambient MCP server or credential is contacted.
The actual native HEAD watcher is exercised with identical test-owned HEAD bytes, without changing
refs; 2.0.22 does not watch ordinary edited files. A configured formatter marker remains absent in worker cases;
ordinary serial fallback performs a native edit and still invokes that formatter. Failure/progress
loss preserves the successful sibling's durable evidence and refuses uncertain writes. Unit tests
separately establish create/delete, mode/encoding, linked paths, concurrent requests, external drift,
partial publication and restart/transfer behavior; those are not claimed as actual-host matrix proof.

Run `node tests/opencode-v2-workers-host-smoke.mjs --formatter-boundary` for the explicit
**expected safety RED**, not a passing worker test. Its hostile local model fixture attempts a
native edit of a test-owned file while a deny-all `ctx.shell` hook is installed. On **2.0.22**
the edit completes, the file changes and the test-owned formatter writes its marker, with zero
shell-hook invocations. The native formatter calls `AppProcess.Service.run` directly, not the
shell tool or shell hook. The public plugin context has no formatter gate or per-edit skip option.
The assertion fails and cleanup still removes the private processes and test-owned files.
The scoped worker route therefore denies that generic editor, rather than replacing its executor
or globally disabling formatters. The separately registered primitive has its own native tool
permission and exact-write authority fence. No arbitrary-script sandbox is claimed.

The formatter bypass does not block the mutation-denying read-only exploration fence.
Legacy investigation remains singular and never invents unrelated splits.

If a capable adapter emits plural `tasks`/`nextAction.calls`, submit all exact objects in one
grouped native foreground tool-call message in provider order. Never use a Code Mode
`Promise.all` wrapper (`subagent` is `codemode:false`) or background dispatch. A singular
surface remains one call. Wait for all outcomes before ordered durable publication and the sequential next
phase; successful members cannot be replayed to recover an uncertain sibling.
Separately authorized repositories remain read-only targets without moving the child workspace,
and still require native `external_directory` permission. No remote probe/access is authorized.

### Legacy setup-only recovery

Read `mdd_status`, not `mdd_start`, for status updates. Absent Engram settings are now normal
memory-off operation, not a setup block. Invalid settings still prevent plugin tools from
loading; repair the named file against the schema and restart. No endpoint or project is guessed.

A setup-only stop retains proven original requirements. After saving and restarting,
the coordinator may resubmit exact `pendingStart` arguments when the user continues that
objective. Native history must prove the same parent/workspace and a correlated setup-only
stop before execution. A status request or restart confirmation is not a new implementation goal.

This recovery is a convenience, never the guard. What keeps a start honest is that requirements
must equal an actual native user message of this conversation, proven separately by
`inspector.intake`: an objective may be an earlier message, because a continuation such as
"continue" never replaces the request it continues, while consent for a change still requires the
latest user text. Two messages carrying the same text are refused rather than chosen between. So history
that cannot prove a pending setup means there is none to offer, and the start proceeds on its own
merits: an earlier successful start, a dispatched or reported phase, a reset, a compacted or
unreadable history and a page that does not reach back far enough all simply report no pending
objective. Only two things still interrupt: a conversation that is not this coordinator's, and two
candidates that cannot be told apart, because picking one of those at random is the wrong run.

Treating all of it as a fault instead is what made a start fail once a conversation had done any
real work. The second `mdd_start` in a live session died on an unreadable structure error, which
in turn made `mdd_reset` with `scope: run` promise a restart it could not deliver, and left
abandoning the conversation as the only way to keep working.

For information-only requests such as explaining a project, the coordinator calls
`mdd_contextual_explore` instead of stopping or forcing `mdd_start`. That route is available
with or without an accepted run, so a status block never leaves the conversation without a
read-only answer. A quoted path neither changes the loaded workspace nor authorizes
cross-project access or configuration edits.

A precise, small change the user already spelled out is not a run either, whatever its kind:
text, a style, a value, a prop, a condition, a rename or a configuration key, with its place
either named or findable from the request itself ("change the `/dashboard` title to *Buen día X*"
is one example among many). The coordinator skips `mdd_start`, preflight and every phase: it
locates the target itself with search and read tools and, on one unambiguous match, edits it at
once, including the places that repeat that value (a translation entry, a test asserting it). With no match or several
candidates it asks through the native question tool, listing the `file:line` candidates, instead
of guessing. If the change turns out larger than it was described — new logic, features,
dependencies, data or security — it stops and offers a normal run with the user's own text. It
never does this while a phase task is in flight or an MDD question is pending, and its reply is a
few Spanish lines naming `file:line`, before and after. Native edit permissions still apply, and
because no run is recorded there is no coverage or ledger row for it. Its PR body still comes from
`mdd_pr_body`, with the files read from git instead of a run (see [PR-body drafts](#pr-body-drafts)).

### Complete Spanish clarification conversations

The coordinator always converses in Spanish, including question text, option labels and
descriptions embedded in `mdd_prepare_advance` or native question arguments. Protocol keys,
technical artifacts and phase reports remain English; native user text is preserved verbatim.

Every pending clarification is asked in **one native interaction**, the way preflight is, rather
than one question per round trip. Each question may carry:

| Field | Shown as |
|---|---|
| `header` | Short topic above the question, at most 30 characters; `Detalle` when omitted. |
| `why` | A `Por qué importa: …` line under the question: what depends on the answer. |
| `options` | Zero to six choices; none makes it an open-ended question the user types. |
| `multiple` | The user may pick several choices together. |
| `deferrable` | Adds `Dejar para más adelante`; a later boundary asks it again. |

`Que decida el agente` and free text are always available. An answer left empty stays
unresolved and returns at a later boundary like a deferral. A deferral picked together with real
choices is not a deferral: the choices are the answer.

Questions reach the user at three boundaries:

| Boundary | Source | When |
|---|---|---|
| Start | `mdd_start({ questions })` | Together with preflight, or alone when the profile is complete. |
| After a phase | `## MDD Questions` in the phase report, plus the coordinator's own | Interactive: before the approval. Automatic: only when the phase reported questions; no approval follows. |
| Before dispatch | `mdd_prepare_advance` while a phase is `ready` | Any mode, while no task is in flight. |

A phase reports decisions only the user can make under the optional `## MDD Questions` section:
an English JSON array of up to eight `{question, why, options, multiple?, deferrable?}`. MDD keeps
them as `openQuestions` in status and in the checkpoint until the coordinator submits them,
translated, with `mdd_prepare_advance`; a restart in between still asks them.

Clarification questions, option labels/descriptions and free-text answers have no individual
prose byte ceilings. The adapter carries every answer of one interaction in a single context
entry under the stable `Clarification` label, including deferred answers and their unresolved
status. Durable question records and reconstructed phase prompts preserve those strings without
truncation. Clarification answers do not authorize a phase: approval is still a separate native
interaction.

Nonempty string validation, choice counts, unique/reserved labels, exact native output matching
and parent/call correlation still apply. Aggregate safety bounds also remain: the question record
is at most 160000 bytes, and the combined phase handoff at most 96000 bytes. Oversized payloads
fail explicitly rather than being shortened or treated as a reason to silently re-ask.

### Bootstrap the actual parent

Only when memory is enabled, MDD checks health and `GET /project/current?cwd=<native-root>`.
It validates the resolved project/root, including HTTP-200 error hints and ambiguity, and
preserves an explicit legacy project only when it matches. The provider resolves a project at its
repository root, so the native root binds when it is that root, a directory inside it, or a linked
worktree of the same repository — MDD proves the worktree link by reading `.git` and `commondir`
itself. A project root below the native root, or one with no such relation, is still refused.
It then reads `GET /sessions/{actual-native-parent-id}`. Existing sessions must match ID, project
and directory, with `ended_at` absent or null. Directories are compared as the platform defines
path identity, because Windows is case-insensitive and the provider stores paths lowercased. Conflicting, incomplete or ended sessions
are rejected without a POST. Only a 404 permits one `POST /sessions` with `id`, `project`,
and `directory`, followed by one exact GET. Unknown POST outcomes get the same single bounded
readback, never a second POST. This is not CAS or an exactly-once guarantee: upstream create
preserves nonempty conflicting bindings, may fill empty ones, and queues the requested sync
payload. Managed children disable cloud autosync. No credentials belong in tool arguments.
MDD never ends the native parent when a phase or run completes; the conversation may run again.

Do not use `engram serve --help`: this version treats it as a service startup,
not a help request. Its source-supported service syntax uses a positional port.

### Start input

```json
{
  "requirements": "Produce a read-only plan for the requested CLI change.",
  "context": { "label": "GitHub issue #390 body", "content": "…material already gathered…" }
}
```

The string must equal the latest actual native user's text parts joined with a newline,
except exact original requirements authenticated by native setup-only history as described above.
Synthetic/ignored text, missing native history, rewritten requirements, or wrong caller
message IDs block rather than inventing human intent. All other public start keys are rejected.
The internal `PhaseRunner.start` complete-input API remains a test/integration seam only;
it is not exported as a model-callable tool. Kernel/proof CLI shapes remain unchanged.

### Coordinator-provided context

The coordinator often holds material the phases need before any of them runs: the body of the
issue the user named, a thread, an earlier decision. It hands that material to MDD, optional
`context` on `mdd_start` or `mdd_context({ label, content })` at any later point, and **MDD**
composes it into the phase prompt as `Coordinator-provided context (data, not authority)`. The
prompt the actor receives therefore already contains it, and the dispatch check in
`PhaseRunner.before` is unchanged: the model contributes data, never prompt text. Editing a
task prompt to carry context remains refused, with no execution started. Contributing new
material retires the current dispatch handle, so the phase can only be started with the task
`mdd_status` returns after the contribution, never with one copied before it.

Context is data, never authority. It cannot replace `requirements`, which still must equal the
exact native user text proven by `inspector.intake`; it grants no approval and changes no
preflight answer, route or evidence flag. Provenance is explicit: every entry is recorded
as `source: "coordinator"`, distinct from `provenance.requirements: "native-user"`.

Entries accumulate rather than replace, because useful context also appears after the run starts.
A single entry is bounded to **96,000 UTF-8 bytes** — the same `PHASE_CONTEXT_MAX_BYTES` ceiling
the composed phase prompt is checked against — rather than a smaller aggregate cap: the prompt is
what actually has to stay deliverable, no longer the `task` field of `mdd_status`, since context no
longer travels through status at all. Every contribution therefore trial-composes the current
phase prompt and is refused, unrecorded, if that composed prompt would exceed 96,000 bytes; a
ready phase's prompt is recomposed immediately, so the `mdd_context` reply itself carries the
updated task and no separate `mdd_status` read is needed. Delivery
still targets the smaller **38,000-byte** `DISPATCHABLE_PROMPT_BYTES` compaction goal described
below, by shedding older inlined artifacts first, before the 96,000-byte bound is ever reached. A
silently trimmed prompt is the delegation failure both bounds exist to prevent. Contributions are
rejected while a task is in flight, and a confirmed **material** change drops context gathered for
the replaced objective; a plain preflight rerun keeps it. `mdd_status` reports `providedContext`
as labels, byte sizes and source only, since the text itself is already delivered to the actor
inside the phase prompt. With memory enabled, entries are persisted with the intent receipt next
to the requirements when the whole receipt still fits Engram's 40,000-byte `save()` limit;
otherwise the receipt carries each entry's label, byte count and content SHA-256 instead of its
text (`contextOmitted: true`), so the record still proves what was carried without exceeding that
separate limit. The preserved-run view degrades the same way, in the same order, when a restored
run's `providedContext` alone would push it past the 30,000-byte `DOSSIER_STATUS_BYTES` budget.

### Dispatch handles: the prompt never enters the parent conversation

A phase prompt used to be written into the coordinator's conversation twice per attempt: once as
the `task` object `mdd_status` returned, and again as the arguments the coordinator copied
verbatim into the native task tool. Both copies stay in the transcript and are re-sent on every
later turn, so a seven-phase route spent hundreds of kilobytes of the coordinator's own context
on text it never had to read. That is what filled the window and triggered host compaction, which
then cost the coordinator the protocol state it was holding.

`mdd_status` now returns the same three task fields with the prompt replaced by a single-use
handle, `mdd:dispatch:<uuid>`, alongside a `dispatch` note explaining it. `PhaseRunner.before`
swaps in the real prompt inside the hook, at the same point where it already rewrites the
arguments to carry the callID, so the actor receives exactly what it received before. The handle
is reminted whenever the prompt changes — a new phase, a retry carrying the previous failure,
contributed context, a restored plan after an investigation — so a stale one can never start a
phase it was not composed for.

It is also the stronger guard. The old contract compared a multi-kilobyte object the model had
retyped, so drift was indistinguishable from tampering; a token minted by MDD and bound to one
ready phase cannot be edited into something else, and a prompt the coordinator composed itself can
no longer reach an actor at all.

The fallback is deliberate and narrow. A dispatch whose prompt is neither the handle nor the real
text is the one failure that says the handle did not travel, and that run returns the full prompt
from then on, exactly as before. Any other mismatch — extra arguments, a substituted
`subagent_type` — is the coordinator composing instead of copying; the refusal is the whole fix,
and the handle stays.

One replayed shape is accepted as the handle. Settled dispatches are collapsed in the transcript
(see below) into a fixed note, `mdd:dispatch:delivered [MDD phase prompt for <actor>, <n> bytes.
…]`, and a model reading its own history back tends to reproduce that note as the next task's
prompt instead of the handle status just returned: on one observed run eleven consecutive
dispatches arrived that way while the handle was reminted twice, leaving the run correct and
undispatchable. So `PhaseRunner.before` treats the note as the handle when `description` and
`subagent_type` are exactly those of the ready task. Nothing new is authorized by that: the note
cannot carry a composed prompt, the actor receives the run's own ready prompt, and a note naming
another phase or actor, or arriving with extra arguments, is still refused.

### Superseded status replies: only the latest one is re-read

Handles kept phase prompts out of the transcript; status replies kept piling up in it. Every
workflow tool answers with the run's current status, and each answer replaces the one before it,
yet the host replays all of them on every later model call. On fifteen recorded coordinator
conversations (1,174 model calls), `mdd_status` replies alone were 44% of everything re-sent to
the model and the other workflow replies another 15%; the compact view made each snapshot
smaller but could not stop them from accumulating.

So the same transform that collapses settled dispatches (V1 `experimental.chat.messages.transform`,
V2 session `context` hook) replaces every status reply that a later one superseded with a fixed
placeholder: `{"superseded":"<tool>","state":…,"phase":…,"note":…}`
(`src/status-transcript.ts`). The rules:

- Only a completed reply of a workflow tool that parses as a status (a JSON object with `state`)
  supersedes or is superseded. Errors, running calls and other tools' outputs — a PR body, an
  improvement report, a knowledge record — do neither, so a failed call never hides the last
  status that succeeded.
- The latest status reply is never touched.
- A placeholder depends only on the reply it replaces, so once written it is byte-stable on every
  later call and the provider's prefix cache keeps hitting; each reply costs one cache miss, once.
- A placeholder carries no task, question, handle or next action, so a spent handle or an answered
  question can no longer be copied back out of the history.
- While a restatement is pending and the latest reply had to leave `rejected.text` out, the most
  recent reply still carrying that same text stays whole.
- Persisted messages are never rewritten; only what is sent to the model changes. The TUI sidebar
  reads its own host events and is unaffected.

The compact view itself also stopped repeating what never changes: `omittedNote` and the
`dispatch` note are one sentence each, `workflow.evaluation.reasons` (the same policy prose in
every run) is left out, `risk` keeps its evidence and risks only until a phase after exploration
has been recorded, and `resultFormat` ships only when a report is the coordinator's own to write.
`detail="full"` still returns all of it.

### Native consent contract

`NativeIntake` owns only intake and question slots; `PhaseRunner` retains the single
`Workflow`. Settings are captured once, and accepted preflight is reused through the run.
The gate reserves each question synchronously before asynchronous inspection, binds its
exact arguments and native parent/call identity, and consumes only actual question-tool
`metadata.answers`. Ordered labels must match the advertised choices exactly; arbitrary
text, extra selections, and reordered answers fail. The readable wrapper is checked against
metadata, never parsed as user consent.

OpenCode 1.18.31 invokes the after hook before recording completed tool history. Both gate
inspections therefore require the uniquely matching **running** question part and exact
input, plus the actual orchestrator/workspace/model binding. Native truncation metadata must
say `false`. MDD exposes no free approval setter or event injection endpoint and never invokes
SDK question replies on the user's behalf. Model strings alone cannot set consent. Native
question replies arrive through OpenCode's service; that local service and installed plugins
remain trusted infrastructure, not a cryptographic proof of who operated the UI.

`mdd_status` returns the exact `question` or executable `task`, provenance only after accepted
intake, and retained `questionReceipts`. `await-answer` means wait, never reprompt. Errors,
changed/stale/duplicate callbacks, or a task before consent block the intake. A dismissed or
interrupted form records nothing: a phase approval, clarification or route question pauses the
run, a preflight or risk recovery stops it, and a change confirmation keeps the current plan. A
stopped preflight also releases its durable intake claim, so a fresh start after a restart is not
refused by a question that already ended. `Stop` records refusal without fabricating a failed phase
result. A missed after hook remains pending; no automated recovery is attempted. Unrelated
sessions remain unaffected.

### Written answers

The form is how MDD asks, and it stays the main channel. A person who answers in their own words
anyway has still answered, and throwing that away used to cost whole runs: an interrupted preflight
answered as "1. algo seguro 2. engram 3. automatico 4. medio 5. nada que agregar." could only be
restarted from scratch. `mdd_answer({ userText?, answers })` records such an answer for every
question kind, with the same transitions, receipts and records as a native callback. The
coordinator reads the words; MDD checks the reading and records nothing unless every check passes.

| Check | Rule |
|---|---|
| Which question | The pending MDD question, or the one whose form was just closed without an answer (paused approval, clarification or route; stopped preflight or risk recovery). A closed change confirmation already kept the plan and has nothing left to confirm. |
| Whose words | In the form: the text the user typed into that question's own box, kept from the native callback while the same question stays open. In the chat: `userText` must be exactly the user's latest message (host-added parts excluded), unused by MDD, and written after a native call showed this exact question. A preflight only has to be past the request that started it, which MDD already marks as used. |
| What they chose | One entry per question, in order: `labels` are exact offered labels, `quote` the part of the text that answers that question. Each label must be written in the quote, ignoring case, accents and punctuation, on whole words. No other option of the same question may be written there, after setting aside the chosen ones, so "no quiero engram, mejor openspec" is ambiguous. A fixed-choice question takes exactly one label; an open one may take its options, the quoted words, or nothing. |
| Record | The answer is persisted `pending`, `answered` and `settled` exactly like a native one, under a fresh `typed-<uuid>` call ID. The receipt carries `typed: { source: "form" \| "chat", userMessageID? }`; a chat message is then marked used. An accepted preflight reports provenance `typed-answer`. |

This widens who may answer, not what an answer may do: the coordinator cannot supply text the user
did not write, and an option the user did not write cannot be recorded. An answer whose words name
no offered option is still refused; the coordinator responds to them and asks the form again.

## On-demand security audit

Ask the coordinator **“security audit”**, **“Run mdd-security”**, **“revisión de seguridad”**,
**“lanza el agente de seguridad”**, or **“usa mdd-security”**. This optional actor runs only on
an authenticated explicit latest native-user request. Creating, configuring, explaining, quoting,
or negating a request does not launch it. No workflow, automatic verification, review or delivery
step launches it. Choose the `mdd-security` model in `mdd-ai config`; an unset override preserves
native inheritance. Settings are frozen at plugin startup, so restart after configuration changes.

Consent recognition uses a closed whole-message grammar, not a keyword or an extracted clause.
For example, **“Quiero que hagamos una revisión de seguridad”** and **“Please run a security audit
of my changes”** are requests. A feature title, documented command, quoted prompt, negation or
composite description is not. Unknown complex wording requires a clear standalone restatement,
such as **“Run mdd-security”**; the adapter never removes quoted data to manufacture permission.
An exact non-negating lead-in, “No hay errores conocidos,” is supported, not arbitrary context.

The coordinator calls `mdd_security({ userText, baseRef? })`, passing the user's exact text.
The tool returns one single-use foreground task. Never add a model, background execution,
child-session reuse or other arguments. Another pending actor, native question or control transfer
blocks admission; the audit never clears those interactions to run. Restart invalidates its pending
authorization. The main workflow and its approval/evidence state remain unchanged.

| Boundary | What the audit actually receives |
|---|---|
| Implementation scope | Every committed change since the baseline, plus staged, unstaged and nonignored untracked changes; layers remain separate even when later changes cancel earlier ones. |
| Baseline | A unique verified local merge-base with an established default target. An inferred baseline equal to HEAD refuses. If unclear, select the actual implementation baseline and request `Run mdd-security baseRef=<ref>`; the tool argument must match that user-supplied token. It must resolve locally to an ancestor of HEAD. No remote fetch or invented HEAD-only scope. |
| Input bounds | Frozen adapter-owned changed ranges and nearby context, up to 24,000 snapshot bytes and 38,000 composed prompt bytes, with inventory/file/read/time ceilings. Oversized or race-detected input refuses visibly, never silently audits a subset. |
| Runtime tools | Only the pure standalone `mdd_check_report` form checker. Native provenance checks run before context/tool actor and workspace exits; known audit children and descendants remain fenced after completion or identity/location changes. Insufficient identity refuses, rather than exposing tools. Shell, live file reads/writes, network/MCP, delegation, skills, questions and coordination are prohibited. Packaged actor/documentation instructions arrive by value. |
| Coverage gaps | Ignored files, binary/link/submodule source and unrelated dependencies are outside supplied coverage; only touched ranges and nearby context are available. Secret redaction is heuristic. Report coverage and limitations explicitly. |

The returned report includes the full artifact and structured severity, location, source evidence,
attack conditions, impact and recommendation. Final native-child, snapshot, coverage and literal
changed-line evidence checks are independent of the actor's form checker. Rejected reports are
not echoed; errors do not expose captured source or credentials. Status distinguishes `findings`,
`no-findings` and `inconclusive`; no findings never certifies the implementation secure. Refusal,
invalid results and incomplete coverage end only this audit, without retries or workflow resets.
Findings are advisory: the coordinator presents them and waits for **separate user authorization
for corrections through `mdd-apply`**. Nothing grants fix, commit, publication or delivery authority.

Redaction alone does not prove credential exposure. An exposure finding needs supporting unredacted,
runtime-bound evidence; hidden values and heuristic markers cannot supply it. When redaction or access
limits prevent assessment, the actor reports the affected scope and unresolved question as inconclusive,
retains independently grounded findings and never claims to have inspected omitted material. This does
not authorize reconstruction of secrets or wider live access; snapshot/findings binding still applies.

## Judgment Day readiness and correction limits

**Parent readiness before paired dispatch** is part of the existing immutable-target freeze protocol
in [the packaged parent reference](../assets/opencode/skills/mdd-judgment-day/references/prompts-and-formats.md).
Before either initial review or scoped rejudgment, the parent confirms exact local full commit objects,
supported requested paths and all existing relevant source sides (base for deletions, target for
additions, both for changed files). Already authorized read-only capabilities must establish required
blob/text availability and known blob/diff/tree output bounds: 128 KiB and five seconds per command.
Size checks cannot guarantee completion within the timeout. Missing objects, binary/invalid UTF-8
material, unsupported paths or oversized output require a scoped limitation, not partial inspection,
guessed content or predictably unable judge launches. Readiness permits no fetch, snapshot creation
or execution of target code. The parent cannot call judge-only `mdd_jd_inspect`.

Readiness is not inspection evidence or approval. The dispatch hook has no structured target input;
these instructions add no manifest or runtime readiness gate. Both judges retain identical criteria
and independently inspect immutable material. Residual failures remain incomplete/unavailable with
exact limitations and only successful reads recorded; an empty findings list cannot imply completion.

For JD Fix, native hooks check admission, ownership, workspace and one active correction writer,
and restrict tool categories under native permissions. Explicit correction consent, confirmed severe
ledger IDs, exact allowed edit paths and the two-round budget remain parent/actor protocol obligations,
not mechanically validated from the prompt. Tool admission is not a path sandbox or correction consent.
The parent supplies and tracks those constraints; the actor blocks ambiguous or conflicting authority.
Structural instruction assertions and immutable-tool regressions verify contracts, not live-model behavior.

## Safety and storage boundaries

| Boundary | Behavior |
|---|---|
| Dispatch | One live run per actual parent. Synchronous reservation precedes asynchronous persistence. A task that arrives while one is already running is refused without touching it; any other unexpected task ends the attempt and returns the phase to `ready`. |
| Capabilities | Ordinary serial phase actors ship no permission map; the user's native permissions decide what they may do. The coordinator adds only `question: allow`, the consent channel OpenCode otherwise denies it. Scoped workers are the explicit exception: the [bounded worker fence](#bounded-worker-authority-internal-host-capability) restricts tools and paths, and Apply uses only the formatter-free `mdd_worker_edit` primitive. |
| Correlation | Confirms the conversation is a top-level `mdd-orchestrator` session in this workspace, and that a native question is the exact running call being answered. Phase results are bound by phase, runID and, when delegated, callID. |
| Models | Configured per role through the startup profile and applied to the agent config. Runtime model identity is not policed. |
| Consent | Complete startup profile or exact correlated native preflight answers; later interactive Proceed/Stop applies only to the currently waiting phase. No repeat preflight or implicit approval. An answer that names nothing on offer selects nothing: the user wrote their own words, or a host reordered the result, and MDD cannot tell those apart. Neither is consent, so the receipt is recorded as cancelled and the same question stays open to be asked again. When those words do name an option, the coordinator records them with `mdd_answer`, checked against the text the user actually typed ([Written answers](#written-answers)). A question MDD did not compose is the coordinator's own and touches no MDD state, except while an MDD question is pending, when it is the only question that may run. |
| Persistence | HTTP only to a literal IPv4 loopback origin, no credentials/path/query/redirects, no retries. Each HTTP/SDK read has a maximum five-second timeout. HTTP responses are bounded to 128 KiB. |
| Failure | Infrastructure failures never fabricate phase results. Read-only phases may retry with failure context, then use one tracked native fallback after `DELEGATION_ATTEMPTS` (3). Apply is different: uncertain writes, failed native results or interrupted actors block with pending recovery protection, never automatic redispatch. Unknown child termination remains `await-result`. A malformed completed report permits only bounded report restatement, not substantive work. A reported phase failure blocks until explicit recovery. `mdd_status` never grants approval or dispatches by itself. |
| Recovery | No MDD state is terminal. `mdd_reset` releases the current attempt (`scope: phase`) or forgets the run for this conversation (`scope: run`), clearing the local progress marker. Scope `phase` also covers work waiting on a person rather than on an actor: a run stopped at an approval returns to `await-approval` with that question re-armed, and an intake stopped before any run re-opens its pending question. Neither prepares a phase nobody authorized. When Verify reports failure, status names `reworkable: "mdd-apply"` and `scope: rework` sends the run back to Apply to correct what it found, instead of re-checking the unchanged implementation or filing a material change. It needs `userText`, the user's exact latest message choosing the correction; the failed verification becomes Apply's newest dependency artifact, earlier changes are kept, and Verify follows through the route's ordinary approval. Recorded artifacts, memory and `previousRuns` are never deleted by a reset, and `scope: run` sets the preserved record aside under a discarded name rather than destroying it. |
| Handoff budget | Each phase prompt carries the artifacts it depends on. A seven-phase route holding large artifacts outgrows what a dispatched task can be delivered at, and the phases that paid for it were the last ones. Artifacts are therefore inlined newest-first while the prompt stays within 38000 bytes, the size that still fits inside the 46000-byte payload budget with the rest of the status; older ones travel as their own recorded `evidenceSummary` plus the ref that identifies the complete text in the artifact store. Shedding is ordered and announced in the prompt, and `mdd_status` reports it as `handoff`. Contextual findings are not compacted: they accumulate by the user's own choice, and `PHASE_CONTEXT_MAX_BYTES` (96000) remains the absolute bound that fails explicitly rather than cutting anything. |
| Payload budget | Every MDD tool serializes through `statusPayload`, bounded to 46000 bytes so the host cannot truncate a result and make the exact `task`/`question` uncopyable. Artifact history is reported as refs only (content lives in the artifact store and is already injected into the next phase prompt), and `brief` accompanies only `mode: "inline"`. Over budget, fields are dropped in the fixed order `priorRun, previousRuns, workspaceRuns, contexts, contextualReport, providedContext, artifacts, artifactAttempts, artifact, concerns, expandedReport, report, visual, planned, decisions, acceptance, verification, handoff, workflow, rejected` and listed in `omitted`. `rejected` goes last and never whole: only its text is shed (`rejected.text` in `omitted`), leaving `reason`, `restatementsLeft`, `textOmitted` and `textBytes`, and `mdd_status` with `detail="rejected"` returns that report alone with its reason and `resultFormat`; `task`, `brief`, `question`, `state`, `phase`, `next`, `mode`, `reason`, `runID`, `sessionID`, `runtime`, `questionReceipts`, `recovery`/`pendingStart`, `notice`, `provenance`, `reset`, `evidence`, `coverage` and `recoverable` are never dropped. A task too large to fit is reported in `budget.problem`, never cut. |
| Next phase | Successful nonfinal Apply batches prepare the next assigned Apply task after durable completion. Final Apply advances to Verify through ordinary automatic/interactive semantics. Only final corroborated Verify returns `complete`. |
| Other sessions | Unrelated tasks outside MDD are untouched. `mdd-*` native tasks are rejected unless they exactly match a registered parent run or an issued read-only investigation. |

With optional memory enabled, each phase writes two project-scoped Engram observations using type `workflow`, no topic-key upsert:

- **Intent:** original requirements, run ID, call ID, phase, resolved preflight
  answers, evaluation, and started workflow snapshot.
- **Result:** run/call/phase binding, outcome, bounded evidence summary, artifact
  reference, selected `artifactStore`, `storage: general-workflow-context-only`,
  and `independentVerification: false`.

Both observations also carry their Engram title, project, and actual parent
session ID. Returned observation ID and all submitted fields must match the
readback. Requirements are limited to 12,000 bytes; the evidence summary, how, artifact
content and the phase result have no size limit. A result receipt whose summary would exceed
Engram's 40,000-byte receipt limit carries the summary's byte count and SHA-256 instead of its
text; the complete summary stays in the workflow record. Full artifact text is not copied into general
receipts. One ArtifactStore per run handles `none`, `engram`, `openspec`, or `both`;
see [storage paths and partial-failure semantics](artifacts-and-actors.md). Dedicated
artifact save/readback must succeed before the general result receipt and workflow record.
`mdd_status` includes live artifact content/references, evidence flags, coverage and the
current report. Partial writes expose attempted backend references and block without retry
or rollback. Local telemetry records only allowlisted lifecycle metadata.

## Phase execution and evidence

### Changing the task without changing conversations

Ask naturally to rerun preflight or describe a material objective/integration/data/permission
change. The coordinator uses `mdd_change_request`, not a user-written JSON form. A rerun
requires a fresh actual native user message. A material proposal requires new requirements,
backed either by a fresh user message asking for the change — which is enough on its own — or,
when that message was already used, by concerns a phase already recorded. Concerns are optional
supporting evidence otherwise. The tool accepts them as the declared array, as JSON text, or as a
single bare object, because host tool bridges and models deliver all three; every entry is still
validated strictly. No keyword scoring or automatic route replacement occurs.

The existing native gate shows one exact confirmation. Keeping the current plan or dismissing
the change leaves its answers, artifacts and pending approval unchanged. Words typed into the
form instead keep the confirmation open, unchanged, until the user chooses; when they name one
of its options, `mdd_answer` records it. Confirmation leads
to **one grouped question containing every preflight field and the optional note**, even with a complete profile. Only
accepted answers create the new planned run. Prior runs remain in `previousRuns` for live
inspection; no artifact or general-memory record is deleted. Identical proposals are not
repeatedly presented without a new user request. Ordinary implementation choices and automatic
phase progression never initiate this path.

A known failed phase can be explicitly replanned after its result and persistence are
confirmed. Only a task that is actually running postpones a change request; a stopped or
failed run is always changeable, and `mdd_reset` releases a dispatch that never reported.
Harmless incorrect task/question parameters are rejected before effects without poisoning a
ready plan. A completed run accepts a fresh next task through normal `mdd_start`, using the
startup profile without an additional change confirmation. Delivering the recorded change —
committing it, pushing it, opening its PR — is not such a task: the coordinator never calls
`mdd_start` or `mdd_change_request` for it and never repeats preflight. The user's explicit request
is the separate decision drafting lacks; the coordinator performs only the actions it names with
git/gh, passes the rendered `mdd_pr_body` output unchanged, and native permissions still apply. Permissions/models are not widened
by confirming a material change.

### Contextual exploration

`mdd_contextual_explore({ purpose })` requests one useful read-only task. When an idle run
exists it binds to that run: it uses the same native task, model, capability and Engram
readback checks, each result has its own `explorationID` and artifact namespace, and main
answers, acceptance map, phase index, evidence coverage and pending approval are unchanged.

`contexts`, `contextualReport` and advisory `concerns` expose the result. Findings accompany
later main-phase prompts within the existing context budget. A known failed exploration is
reported without fabricating a failed main phase; an uncertain side outcome stops further
execution. No background task, resume parameter, concurrent side task or approval shortcut
is supported. Concerns have only `{ category, evidence, impact }`, where category is objective,
integrations, sensitive-data or permissions; they are never score or permission overrides.

### Standalone read-only investigation

The same tool answers information-only requests when no run exists, so the coordinator is
never forced to stop or to start implementation to inspect the project. That standalone route
keeps the native task, child-session, model, capability and result-binding checks, and drops
everything an accepted run owns: no preflight, no approval, no workflow, no evidence
coverage, no artifact store, no Engram receipt and no `.mdd` progress marker. It therefore
neither creates nor resumes resumable work, and a later `mdd_start` in the same conversation
proceeds normally.

`mdd_status` returns `contextual: true`, `explorationID` and the exact `mdd-explore` task
while it is ready, then `contextualReport` plus bounded `contexts` (the four most recent
findings) once it settles. One investigation runs at a time; a second request while one is in
flight is rejected, and a blocked one may be requested again without touching any main route.
A pending native question also defers it, because that question is already waiting for the
user. A conversation waiting for recovery still answers read-only questions.

All prior validated artifact contents and references are handed to each subsequent phase.
High-route specification/design/tasks receive the actual earlier proposal and specification,
not just summaries. Native `mdd-spec` results use the dispatched `domain: "project"`
storage namespace; this does not infer the project's architectural bounded contexts.
The total serialized prompt budget is **96,000 UTF-8 bytes**; exceeding it blocks explicitly
instead of truncating dependencies. Artifacts are saved/read back before result recording;
held verified content supplies subsequent handoffs, including `none`.

| Actor | Capability |
|---|---|
| Ordinary serial phase actor | Whatever the phase needs. Phase actors ship no permission map, so the user's own OpenCode permissions decide. Scoped workers instead follow the [bounded worker fence](#bounded-worker-authority-internal-host-capability), with formatter-free `mdd_worker_edit` as Apply's only editing primitive. |
| Coordinator | The same, plus its MDD tools and `question`. It ships exactly one rule, `question: allow`, because OpenCode denies that tool for non-native agents and hides denied tools from the model; without it no preflight or approval can be asked. It may delegate a phase or carry it out itself. |

For ordinary serial execution, MDD does not police tools, commands or paths. It used to: an allowlist per phase, a command
denylist, root-scoped path checks and resolved-permission validation of every agent. That
stopped unsafe work only in theory, while in practice it stopped ordinary work, and each
check was one more way for a run to die with no way back. Capability is a native decision,
and the permission prompt is where the user makes it.

Scoped workers are the explicit bounded exception: their worker fence checks live authority,
tools and declared paths, and Apply edits only through the formatter-free `mdd_worker_edit`
primitive. This is not an arbitrary-script sandbox; scoped workers cannot execute scripts.

**Shell executes real project code, not a sandbox.** A project script can have side effects;
the native permission request is the moment to assess that. Indirect behaviour is never
semantically certified by MDD.

Native skill loading still yields to packaged instructions, but the skill body itself is never
injected by value: the phase prompt names the applicable packaged skill by its direct absolute
path, one line, no content and no digest, so a same-named global skill cannot be reached by name
and a phase actor that finds the path useful reads it with its own read tool. Apply is offered
`mdd-cleanup/SKILL.md`. Explore, Plan, Propose, Spec, Design and Verify are offered
`mdd-doc/SKILL.md` and `cognitive-doc-design/SKILL.md`; Tasks and Apply carry structure rather
than narrative and are offered no documentation skill. Standalone investigation is offered the
same documentation paths. The `mdd_pr_body` tool reads the fixed packaged PR skill/template with
path/digest provenance; no name-based skill lookup occurs there either.

### Delegation and the inline route

Delegation is the default: `mdd_status` returns the exact `task` for the phase actor, and
`mode` is `delegate`. It is a preference, not a cage. Each phase is delegated up to
`DELEGATION_ATTEMPTS` (3) times; `attempts` counts the failed tries at the phase running now and
`attemptsLeft` reports what remains. A failure below the threshold keeps `mode: "delegate"` and
rewrites the task to carry what went wrong. Once the dispatches are gone, the phase returns to
`ready` with `mode: "inline"` and a `brief` holding the same instructions.
The coordinator then carries the phase out with its own tools and reports it through
`mdd_phase_result({ result })`, which takes the same result object without a `callID`.
Both routes share one contract and one recording path, so artifacts, memory, evidence and the
workflow do not depend on which one produced the result.

Attempts belong to the phase that spent them, so reaching the next phase resets `attempts` to 0
and `mode` to `delegate` with the full count restored; `runAttempts` keeps the run-wide total for
anyone reading the ledger. Counting them per run instead meant one phase that needed three tries
sent every later phase inline on its first failure, which spent exactly the coordinator context
delegation exists to protect. A handed-back phase may still be delegated again by choice, and
`mdd_reset` with scope `phase` restores the three dispatches.

A phase answers with a short markdown document, not a serialized object. `## MDD Outcome` holds
`passed` or `failed`, `## MDD Summary` holds the prose a person reads first, `## MDD Approach`,
`## MDD Purpose`, `## MDD Open Items`, `## MDD Learnings` and `## MDD Confidence` hold the rest
of the narrative the user may be shown, `## MDD Artifact` holds the deliverable, and
`## MDD Data` holds one fenced JSON block for the phases that carry traceability fields.
`## MDD Concerns` and `## MDD Questions` are optional. The narrative sections are written whatever report detail the user
chose and are not required to parse; one an actor leaves out is shown as missing. Confidence must
start with High, Medium or Low and give its reason, or the report is returned to be restated.
`## MDD How`, the heading phases used before and the one risk and security reports still use,
names the same section as `## MDD Approach`. The headings are prefixed so an artifact may
use its own `## Summary` or `## Data` without being cut in half by the envelope carrying it, and
a heading inside a fenced block is content rather than a delimiter. Unprefixed headings are read
for a document that used no prefixed heading anywhere.

Reading is deliberately lenient everywhere leniency cannot change a fact. Prose around the
document is ignored, the legacy whole-message JSON object is still understood, and a field no
phase reports is dropped and named rather than failing the phase. `phase`, `runID` and `callID`
are checked when the actor states them and are never required: the dispatch was already matched
by call ID and by exact task arguments, so stating them can only reject a mismatch, never
authorize one. Whenever a report is the coordinator's own to write — a rejected report waiting to
be restated, or a phase carried inline — `mdd_status` returns `resultFormat`, the exact headings
for that phase, as a protected field, so it is never reported against a remembered shape. A
delegated task omits it: the actor's own prompt already carries the form.

A report MDD cannot read is not a phase that failed. The work it describes is often finished and
already in the working tree, so it costs a restatement rather than an attempt: the text comes
back under `rejected`, the phase becomes the coordinator's to restate through
`mdd_phase_result`, and the telemetry failure class is `result-malformed`, distinct from
`result-rejected`. After `MALFORMED_RESTATEMENTS` (3) consecutive unreadable reports the attempt
is spent normally, because a report nobody can state correctly is no longer only transcription.
A rejection names every independent problem at once, each by its position and the rule it broke
(`checks[9].command "node -e …" is 1019 characters…`), so one restatement can fix them all; a
payload too small to carry the text alongside the run sheds only `rejected.text`, and
`mdd_status` with `detail="rejected"` returns it alone.

`## MDD Data` permits these phase-specific fields:
- Plan: `acceptance`, `decisions`, and nonempty `deliverables`. The same single plan artifact
  contains the concise narrative and the adapter-appended canonical acceptance/step map.
- Spec: `acceptance: { goal, requirements: [{ id, description, scenarios: [{ id, given, when, then }] }] }`.
- Design: `decisions: [{ id, description, requirements: [requirementID] }]`; empty is valid when
  no relevant decision needs tracking. Requirement/scenario IDs cannot be replaced here.
- Plan/Tasks: `deliverables: [{ id, description, path, check, scenarios, decisions?, dependsOn?, parallel? }]`.
  Scenario references are required; optional decision/dependency lists default to empty only
  when omitted. Every held scenario and relevant decision requirement must map to a step.
  Dependencies refer to earlier steps. Paths and commands retain existing scope checks.
- Spec: `domain: "project"`, matching the dispatched storage namespace.
- Apply: `changes`, the file paths the phase changed. Alternatively `noChangeReason`, which
  earns no implementation points. Also `checks: [{ command, exit }]`, the commands Apply reports
  having run. Its own agent definition asks for them, and rejecting the phase for supplying them
  was one of the ways a finished implementation had to be run twice. They are recorded as the
  phase's claim and shown as one; only Verify's checks earn the `checks` evidence flag.
- Verify: `checks: [{ command, exit }]`, the commands the phase reports having run. `exit` is
  an integer, or `null` when the command did not finish. A command has no length limit but must
  be one line, with no control characters. MDD records the claim as a claim: it never re-runs
  the command and an exit code is not a semantic certificate.

Verify also requires `verification: { scenarios, steps, decisions, changes, limits }`:
- Scenario rows name `requirementID`, `scenarioID`, `stepID`; step rows name `stepID`;
  decision rows name `decisionID`. Every held link/step/decision appears exactly once.
- Each row has `status: verified | not-verified | deviation`, `checks: [command]`, and a
  concise source-based `assessment`. The report must agree with itself: a row may only cite a
  command the same phase reported running, and a `verified` row may not rest on a check that
  did not pass. That consistency is the honesty MDD can offer without re-running anything.
- `changes` is a plain-language interpretation; `limits` contains up to four material notes.
  `mdd_check_report` reads `checks` and `verification` on every Verify outcome, as the run does;
  only which links exist is left to the run, which holds the plan.
  A passed outcome with missing coverage or any not-verified/deviation row blocks; an explicit
  failed outcome with complete partial coverage remains failed and visible. No extra check
  commands or user approval questions are introduced to satisfy this map.

### Optional task footprints: eligibility only

**Bounded concurrency is active and defaults on.** On capable hosts, at most two confined
independent exploration or Apply workers run with complete scopes and dependency declarations.
Unknown, incomplete or unsafe work remains serial. Apply workers publish strict single-task
results in held-plan order only after all siblings settle successfully; Verify remains singular.
Plan/Tasks footprints describe eligibility, not authority: this metadata grants neither tool
permissions nor file ownership, and eligibility is not an edit-boundary fence. See the
[bounded worker authority contract](#bounded-worker-authority-internal-host-capability).

```json
{
  "dependsOn": [],
  "parallel": {
    "complete": true,
    "reads": ["src/shared.ts"],
    "writes": ["src/feature.ts", "tests/feature.test.mjs", "docs/feature.md"]
  }
}
```

`complete: true` attests that both arrays enumerate **every** file read/written, including
shared outputs, tests, documentation and lockfiles. Explicit `dependsOn` must name every
task, code and data prerequisite; use `[]` only when there are none. The existing `path`
field stays descriptive and never substitutes for these scopes.

| Metadata or evidence | Conservative outcome |
|---|---|
| Legacy plan, omitted `dependsOn`, missing arrays/attestation, `complete: false`, or empty Apply writes | Sequential; omitted dependencies discard parallel metadata before normalization/reconstruction. |
| Malformed fields, duplicate/case-alias paths, traversal, absolute paths, globs or ambiguous separators | Report rejected, even without dependency opt-in. |
| Unknown dependency, damaged completion list, or completion without its prerequisites | No candidates; never treat the claim as proof. |
| Directory, symlink/junction, hard-link, disk case alias, or unverified filesystem parent | That item cannot join a pair; if first ready, run it sequentially. |

Scopes use portable ASCII exact root-relative file paths with `/` separators, not directory
patterns; reserved device names, trailing dots/spaces and short-name `~` aliases are rejected.
New files/parents are allowed only below verified real ancestors. Selection preserves plan
order, caps a batch at two, and requires completed dependencies plus no write/write or
write/read intersection (including parent/child and case aliases). Shared reads alone are
safe. Tests/builds/shell commands are not authorized to overlap by this metadata. Filesystem
checks are a snapshot: future dispatch must revalidate and enforce scopes at the native boundary.

`mdd_status` exposes detached `acceptance`, `decisions`, `planned` and `verification` for
drilldown. Terminal `report` leads with the goal, recorded changes, requirement/plan match,
checks and material gaps. Checks are recorded with the exit code Verify reported, so a command
that failed is counted apart and named apart instead of disappearing among the successful ones. Low remains the `Resumen`; medium adds `Propósito`, `Aprendizajes clave` and the
`Verificación` block; detailed adds `Cómo se hizo`, `Pendiente o incierto`, `Confianza` and
`Estado`, taken from Verify's own report. The frame is rendered in Spanish for the reader while the phase
prose inside it arrives in English and is translated by the coordinator, section for section.
Default reports omit internal routing, calls and receipts.
The map and assessments are agent interpretations of the user request, not a parser's proof
of semantic correctness. Code checks reference integrity and native execution evidence.
`verification.matched` describes the assessment map; successful route completion additionally
requires the native execution, persistence and other existing safety checks to pass.

Coverage is **20** accepted native requirements/profile intake + **20** validated Plan/Tasks
deliverables + **25** reported implementation changes + **35** reported Verify checks that
passed. The flags describe what each phase reported, not independent proof. Other phases earn
no automatic points. A recorded failure withdraws affected evidence; an attempt that never
completed withdraws nothing, because it claimed nothing.
Coverage decides whether a run may close as complete and is reported by `mdd_status`; it is not
rendered in reports. Reports honor low/medium/detailed settings and never take a model-selected
percentage: the actor's confidence is a High/Medium/Low level with its reason.
Telemetry supports off/delete and retains 30 days locally. Diagnostics are bounded, and
telemetry failure does not alter phase outcomes. Status reads do not append telemetry.

Every event of a run carries that run's identity, the attempt it belongs to and whether the
phase was delegated or carried out inline, and an ended attempt also carries the adapter's own
failure class. What a delegated phase cost is read from the child session the completed task
envelope names in its `id`, which is the only attribution MDD can make without guessing: no
child enumeration, no correlation heuristic, and nothing recorded when the envelope names no
session. Counters that survive the 30-day window live in a separate fixed-key rollup; both are
local, workspace-scoped and never exported. See [configuration](configuration.md#local-telemetry-telemetryts).

## Verification and limitations

`npm test` includes the original 83 routing/CLI/workflow tests and additional
real-loopback HTTP and explicitly labeled SDK/hook **contract tests**. Faked
SDK metadata is not a model execution claim. `npm run typecheck` checks MDD's V2 host
adapter and the motor's internal legacy hook types. Source checks stay strict; `skipLibCheck`
skips released dependency declarations that conflict with `exactOptionalPropertyTypes`.

Isolated service checks have verified Engram session/observation readbacks and
binding rejection with cloud autosync off, plus actual OpenCode/Bun project
plugin loading, agent registration, custom tool IDs, and unchanged default
agent with zero model calls. An initial 15-second OpenCode load probe timed out;
a fresh isolated probe with a 60-second bound succeeded. Each probe terminated
only its owned processes and removed its temporary database/config directory.

**Not tested:** paid or free model-backed native task execution, end-to-end
assistant output compliance, interactive permission UI, or coexistence with
arbitrary third-party plugins. Those plugins and the local OpenCode/Engram
services remain trusted infrastructure; model prose cannot update this gate.

The historical cold probes timed out during agent discovery. A later bounded, model-free
probe with real dependencies preseeded in both isolated config directories verified OpenCode
1.18.31 health, nine actors/model/permission profiles, change/context tools, and unchanged
default build. Cleanup completed in 14.865 seconds total. Preparation was a material
differentiator; the historical cause was not proven. Do not assume root node_modules alone
guarantees offline startup. See [setup prerequisites](setup.md#startup-dependencies-are-a-prerequisite).

## Recorded improvements

`mdd_improve({ userText, title, detail, phase? })` records something MDD did badly. `userText`
goes through the same `inspector.intake` check `mdd_pr_body` uses, so an entry attributed to the
user is one the user actually asked for. `mdd_improvements({ query?, state?, limit? })` reads
them back and returns a rendered Spanish report the coordinator presents as it is. Both are
read/write against the local record only: they start nothing, change no run, alter no approval,
and are refused for any agent other than the coordinator.

Failed attempts record themselves. `PhaseRunner` writes an entry from its degrade path for every
ended attempt of the main route — never for a contextual investigation, which costs the plan
nothing and teaches nothing — carrying the adapter's own failure class, the phase and the exact
reason, plus a distinct title when the attempt was the one that exhausted delegation. That write
is best-effort and swallowed: a route that just broke must not break a second time because its
own record could not be written. See [recorded improvements](configuration.md#recorded-improvements-lessonsts)
for the file format, the retention rule and the optional memory index.

## PR-body drafts

When requested, `mdd_pr_body({ userText, notes?, digest?, translations?, baseRef?, direct? })`
checks the actual latest native user text and current parent, then renders the shared local
template without changing workflow, approval, artifacts or memory. It drafts with or without a
recorded run, and it never starts implementation merely to draft a body. Optional notes contain
`environmentVariables`, `followUps`, and/or `deployment`, each quoting a whole user-provided line.
They stay attributed and unverified. No model-callable parameter can replace recorded changes,
checks or completion evidence.

Without a recorded run — a quick edit, typically — there is no recorded
prose to translate and no check to report, but git still knows which files changed. The first call
takes `baseRef`, the PR target branch, and returns `render: 'pending-direct'` with the files that
differ between its merge base and the working tree: committed, staged, unstaged and untracked
alike. `origin/<baseRef>` is preferred over a local branch of the same name, because a stale local
copy would sweep work other people already merged into the table. The second call adds `direct`:
a Spanish one-line summary and exactly one Spanish one-line reason per listed path. A missing,
extra or repeated path is refused, as is text that is empty, multi-line or not Spanish. The body
then says under `Verificación` that it is a direct edit MDD neither planned nor verified, that the
files come from git and the prose from the coordinator; it records no command and invents none.
That alone is not a blocker, since a small edit made on request is ordinary work. Git is called
with the user's global configuration, so their global ignore file applies, but with external diff,
textconv, fsmonitor, the pager, prompts and lazy fetch switched off. `direct` is refused when a run
is recorded, and translations are refused when none is.

Drafting takes two calls, because every sentence of substance in a body was written by a phase
actor in English and a body is read by a reviewer in Spanish. Rendering the recorded prose as it
was recorded is what produced Spanish headings over English paragraphs. The first call returns
`render: 'pending-translation'` with one keyed entry per recorded string and a digest over them;
the second returns the rendered body. The coordinator translates — it does not author — and the
translations are checked before anything is rendered: every key exactly once, numbers, paths,
identifiers, quoted code and command names preserved verbatim and none invented, a length within
half to two and a half times the source, and Spanish function words in any entry long enough for
their absence to mean something. The digest binds the set to the evidence it came from, so a run
that advanced mid-draft is refused rather than described with older prose. The checks are
structural: they cannot tell whether the Spanish means what the English meant, and they do not
claim to. A conversation gets `PR_TRANSLATION_ATTEMPTS` rejected sets before drafting refuses
outright; asking again for the recorded text restarts it. `provenance.translated` names the keys
that reached the reviewer through a translation.

The seven sections always remain Resumen / Cambios / Verificación / Variables de entorno /
Seguimiento / Bloqueos / Despliegue. `Resumen` is Apply's `delivered` summary — what the change
makes possible and what it implies — and falls back to the recorded goal, saying so, when Apply
recorded none; it never describes how the work was done, because the table below it already does.
`Cambios` is one table row per changed file, holding the reason the apply phase recorded
for that file; a file reported without one says so rather than being given an invented motive,
and a reason containing a pipe or a newline is escaped instead of breaking the row.
`Verificación` holds the verification state, Verify's own account of what it found, and the check
evidence aggregated into counts: total, exited zero, exited nonzero, and how many commands could
not be printed. It is aggregated because one line per command produced six identical redaction
notices in a real body, which reads as a malfunction and tells the reviewer nothing. A command is
printed only when it is a plain package-manager invocation whose whole string survives the safety
filter, so arguments are allowed as a shape and never as trust. The body
carries no draft-only notice: publication authority is reported to the caller as
`publication: not-authorized`, which is who can act on it, and repeating it at the top of every
body spent the reviewer's attention on MDD's permissions instead of on the change. Missing
optional facts are explicitly unverified; an explicit user
`No aplica.` line is retained. Obvious credential assignments, paths and code excerpts
are omitted. This is not a
general secret scanner or a fresh Git diff review. Inspect the draft before publication.
The tool returns `publication: not-authorized`; it does not create branches, commits or PRs.

There is no automatic crash recovery or exactly-once guarantee. Before intent persistence,
the adapter writes `.mdd/progress-<SHA256(parentID)>.json`: only run ID, call ID, last native
user-message ID and pending/settled/complete state. The 2 KiB marker uses existing atomic,
root-confined storage and is Git-ignored. It contains no prompts, source, paths or approvals.
Confirmation of phase/side results settles it; final main completion marks it complete.

A run is never reconstructed automatically after process loss. Only a marker still `pending`,
an attempt that never reported an outcome, holds the conversation: status reports it as
`recovery-blocked` with `recoverable: true`, read-only investigation keeps working, and
`mdd_reset` releases it in place once the child is known to have stopped. Settled or complete markers leave the conversation free for
new work; only reusing the same native user message is refused, so nothing is silently
replayed. Other parent IDs use independent marker files, so an old pending or corrupt marker
never blocks unrelated conversations.
The marker remains a replay guard and an authorization source for nothing at all. It is not the
workflow ledger either; that role belongs to the separate run dossier described next.

#### Knowing whether a subagent stopped

A dispatch that never reported holds the conversation until MDD knows its subagent is no longer
writing. The inspector reads OpenCode's own account of that subagent and returns a `liveness`
verdict, which `mdd_status` reports for `recovery-blocked` and `await-result` states:

- `stopped` — the task returned; or the subagent finished its last message and OpenCode reports it
  idle; or OpenCode has no live loop for it and it has been silent for `ORPHAN_QUIET_MS` (2 min).
  The last case is what an interrupted or restarted OpenCode leaves behind: the parent task part
  stays `running` and the subagent's last message stays open forever, because the process that
  would have closed them is gone. `mdd_reset` releases a `stopped` child on its own.
- `running` — OpenCode reports the subagent `busy` or `retry`. Nothing overrules this.
- `unknown` — OpenCode kept no usable trace, such as a task with no recorded subagent session, or
  activity too recent to call silence.

For `unknown`, the user who interrupted the subagent is the one who knows. `mdd_reset({ scope,
userText })` takes their exact latest native message, proven the same way `mdd_improve` proves
one. MDD then asks OpenCode to abort that subagent session, reads liveness again, and releases
the attempt unless OpenCode now reports it busy. The release is recorded as the user's, and the
blocked reason says partial changes may remain and must be inspected. A paraphrase or an older
message is refused and releases nothing. Scope `phase` keeps the run and makes the phase
runnable again; scope `run` discards it. Both keep the evidence.

### Where `.mdd` lives

Everything the adapter persists locally — this progress marker, the run dossier, the run ledger,
the session ledger, telemetry and the lessons file — is anchored at the **repository**, not the
checkout a run happens in. A linked git worktree is deleted the moment its task is done, and anchoring the records
inside it deleted them too: the dossier a later run could have restarted from, and the lessons a
repository was meant to accumulate across every one of its worktrees, both vanished with the
worktree that produced them, which is why a repository could ship many MDD runs and still hold no
`.mdd` at all. The adapter resolves the anchor by reading git's own layout — a worktree's `.git`
file names an administrative directory whose `commondir` names the shared git directory, whose
parent is the repository — the same read that proves a worktree belongs to a memory project. For an
ordinary checkout, a subdirectory of one, or a directory that is not a git repository, the anchor
is that directory unchanged, so nothing about the single-checkout case moves. Records from
concurrent worktrees of one repository share the anchor safely: per-run files are keyed by
`SHA256(parentID)`, and the append-only ledgers serialize through the existing lock. The readers
resolve the same anchor, so `mdd_improvements` and the `lessons`/`telemetry` CLI commands run from
inside a worktree report the repository's records rather than an empty local directory.

### Finished runs (`.mdd/runs.jsonl`)

The dossier below keeps one slot per conversation and is replaced by that conversation's next
objective, so a repository could run MDD for months and hold no evidence that any of it happened.
When a run reaches `complete` or `blocked` the adapter appends a compact row — outcome, route,
phase reached, coverage, changed-file count, check totals with failures counted apart, concerns,
the recorded goal and up to four verification limits. A run that reaches a further state replaces
its own row, so one run is one row. It is bounded to 200 rows, holds no artifacts, prompts or
source, and is written best-effort: a row is never worth a route. `mdd retro` reads it together
with the accumulated counters and the unreviewed improvements.

### Preserved runs (`.mdd/run-<SHA256(parentID)>.json`)

Run state used to live only in memory while artifacts were persisted elsewhere, so an
interrupted phase destroyed the index that made those artifacts reachable: exploration, plan and
acceptance map were on disk and unfindable at the same time. After every *committed* transition
— never during a `persisting-*` step — the adapter writes a dossier holding the run identity and
parent, requirements, coordinator-provided context, answers, route, phase reached, last settled
state, workflow results, evidence, acceptance, decisions, plan, verification, executed checks,
changed-file count, concerns, artifacts **with their content**, contextual findings, consumed
call IDs, question receipts, used message IDs, proposals and a timestamp. A failed dossier write
degrades to a visible `dossierDiagnostic`; it never re-blocks a run that already finished.

Deliberately absent: the `Workflow` instance (its internal state encodes live authority, so only
results and answers are kept as data), transient states, in-flight `callID`/`dispatchedArgs`,
`args`/`brief` (recomputable from the phase prompts), the memory and artifact clients
(rebuildable from settings), timings, superseded runs, and standalone investigation, which by
contract leaves no local trace of any kind. Engram is not the primary home: memory is optional,
`save()` stops at 40000 bytes, and there is no per-session search — without an observation ID
held locally nothing can be found, which is the exact circle that caused the loss.

### Restart resume

Every settled transition also writes a resume checkpoint (`.mdd/checkpoint-<SHA256(parentID)>.json`):
the workflow events, the dependency artifact bytes, the held plan and evidence, and the runner's
settled state, sealed by a digest. After OpenCode restarts, the first `mdd_status` in the same
conversation validates that checkpoint against the progress marker and the durable run owner and,
when everything agrees, restores the run exactly where it settled: a ready phase is dispatchable
again (with a fresh dispatch handle), an awaiting approval is asked again as a *new* native
question, and a finished run reports `complete`. Nothing is ever replayed: a phase whose child
never reported stays `recovery-blocked` until OpenCode confirms it stopped or the user says so in
their own latest message (`mdd_reset` with `userText`), and a question or coordinator operation that
died holding the run's writer is released the same way. A complete run closes itself when the
user starts a new objective in that conversation; its record is set aside, not deleted.

Releasing an interrupted attempt keeps the run. `nextAction` for `recovery-blocked` is
`mdd_reset` with `scope: 'phase'` — with the user's `userText` unless OpenCode already reports
the subagent `stopped`, and no reset at all while it reports it `running` — so "it was
interrupted, continue" readies the interrupted phase again with every completed phase kept and no
new preflight. `scope: 'run'` is the fallback only when MDD refuses the phase reset because the
run cannot be restored.

A run keeps the route it started with. The checkpoint's request records the evaluated phases
(`request.route`), and replay follows them rather than re-evaluating the answers under the current
routing policy, which may route the same answers differently (complexity stopped scoring, for
example). A recorded route must be one the policy can choose. A checkpoint written before routes
were recorded is replayed under the current policy and, when its history does not fit that
route, on the one known route its history fits; when more than one fits, it stays unreadable.

Outside Apply boundaries, a checkpoint storage fault may be retried and degrade to data-only:
the progress marker records `resumable: false` and the stale checkpoint is withdrawn. Transitions
within or into Apply instead write a pending transition fence before attempting the checkpoint.
An unknown checkpoint outcome blocks without retry or degradation to a live writer; the fence
prevents restart from reissuing an older ready task. A confirmed result checkpoint is required
before the next batch is exposed. Conflicting writers always fail closed.

**When the checkpoint cannot be used, the run is data only.** After dying mid-`mdd-apply` with no
usable checkpoint MDD does not know what reached the working tree, so restoring a controller would
fake a continuity that does not exist. With no live run, `mdd_status` reports
`state: 'recoverable'`, `recovery: 'data-only'` and a `priorRun` marked `capability: 'data-only'`,
plus `limits` stating plainly that the working tree may hold partial changes MDD never recorded and
must be inspected with `git status`/`git diff`, that no approval survived, and that any task still
running will never report. The way forward is `mdd_start` with the original objective as actual
new native user text — which still requires a fresh preflight — or `mdd_reset` with `scope: run`,
which discards the record.

### Continuing a run in a new conversation

**Finding it first.** With no run active, `mdd_status` adds `workspaceRuns`: up to six runs other
conversations recorded in this workspace, newest first, read from their `.mdd/run-*.json` records.
Each row is `capability: 'data-only'` and names `runID`, `sessionID`, the clipped `requirements`
and `goal`, the labels of the context it was given, the phases that passed, the last result, its
record `file`, and `resume`:

| `resume` | Meaning |
|---|---|
| `transfer` | Settled where a transfer projects and its owner is idle: this conversation can take it over once the user's own message names `sourceSessionID=<id> runID=<id>`. |
| `transfer-rework` | The same after a failed verification; that message must also say `rework`. |
| `source-conversation` | It goes on only where it lives (for example `mdd_reset` scope phase there for a blocked phase), or its evidence seeds a new run started with new consent. |
| `finished` | It completed; new work is a new objective. |

The hint is the transfer projection's own answer, not a copy of its rules, so `transfer` is a
promise `mdd_transfer` keeps. Left out: this conversation's own record (that is `priorRun`),
records with no phase result or investigation, set-aside (`.discarded.json`) records, and a run
that moved, whose old copy is not where it lives. The rows authorize nothing; a conversation with
its own run never reads them. The coordinator reads them, together with project memory when
memory tools are available, before `mdd_start`: a request that continues recorded work is not a
new objective. This exists because "Continúa el issue #433" once started a second run from that
bare sentence while the run that had already planned the issue sat blocked one file away.

A run belongs to the conversation that owns it, but it can be moved:

1. In the old conversation, `mdd_status` shows `sessionID` (under `runtime`) and `runID`.
2. In a new conversation, the user asks to continue it and names both, for example
   `Continue sourceSessionID=ses_abc123 runID=6f1e… here.` The coordinator calls `mdd_transfer`
   with that exact message.
3. MDD verifies the old run is settled (no child or question in flight), fences the old
   conversation, publishes a projection of the checkpoint into the new one bound to that exact
   message, and records a receipt. Any approval is asked again in the new conversation; old consent
   is never reused, and the old conversation can no longer dispatch.

The receipt is written only after both checkpoints were proven correlated, under the owner lock,
and from then on it is self-contained: the target's ownership is confirmed from the owner record
and its own claim, not from checkpoint bytes. A later checkpoint, a degraded (non-resumable) one,
or none at all never breaks it — the target keeps working live, and after a restart it is either
resumed (bytes must descend from the published target) or shown as data only and can be discarded
with `mdd_reset` scope run and the user's exact message. The source conversation, meanwhile,
reports `state: 'transferred'`; any late callback, approval or dispatch there is refused, and the
user can start a new objective in it (the old claim is retired automatically) or free it with
`mdd_reset` scope run. Neither touches the transferred run.

A run can move again (A → B → C). The new receipt supersedes the previous one when the new
transfer finishes, and the owner keeps the list of every former owner: A and B stay fenced for
good, B is fenced from the moment the new transfer begins, and a conversation that only holds a
pending claim is reported as an ambiguous claim, never as one the run moved away from.

If a transfer is interrupted, `mdd_status` in the new conversation reports it as ambiguous with its
`operationID`. The user then asks to recover it, naming `sourceSessionID`, `runID` and
`operationID` and saying it stopped, and the coordinator calls `mdd_transfer_recover`:
`release-claim` frees a claim that fenced nothing, `abort-fenced` returns the run to the old
conversation (removing published target bytes only when they are exactly the transfer projection),
and `finish-published` completes a published transfer, regenerating its deterministic progress
marker if the crash lost it. A finished transfer never revives the old conversation.

### Durable ownership and locks

The durable owner (`.mdd/owner-*.json`, `.mdd/parent-owner-*.json`) fences every writer: one
process at a time holds a run's writer for a native task, a question or a coordinator operation.
Read-only tools (`mdd_status`, `mdd_improvements`, `mdd_pr_body`, `mdd_improve`,
`mdd_check_report`) never take it. Lock files name their holder (pid, host, platform — WSL told
apart from Windows — boot time or Linux boot ID, and a nonce). On the same host and platform, a
lock from a previous boot is reclaimed (its pid may belong to an unrelated process now), and one
from this boot only when the OS says its pid does not exist; locks from another machine or with
an incomplete identity are never reclaimed, and no lock is reclaimed by age alone. Reclaim runs
under an exclusive slot named for the dead holder, so racing reclaimers can never remove a lock a
live writer has just taken; a slot orphaned by a reclaimer that died is reclaimed by the same
rule, and a slot that cannot be removed is reported instead of ignored. Finishing and aborting a transfer both decide and mutate
while holding the owner lock, so an abort can never delete bytes a concurrent finish vouched for. Readers see the last committed record while a writer holds the lock,
because every replacement is an atomic rename; transient Windows sharing errors on rename or unlock
are retried a bounded number of times.

A `pending` marker takes precedence over a dossier, because it is the more restrictive of the
two: it reports an attempt of unknown outcome and must gate a start, while a dossier reports only
finished evidence and gates nothing. The preserved run still rides along in that payload. A
dossier therefore never blocks `mdd_start`; restarting with fresh consent is the whole point.
Phase approvals are never restored, and `questionReceipts` appear only under `priorRun` as
history, never in the live intake's receipts, where their call IDs are anti-reuse guards.
`usedMessages`, `proposed` and consumed call IDs *are* restored, because those guards can only
ever refuse a replay, never authorize anything. `evidence.requirements: 'confirmed'` is not
restored. Live-only `none` artifacts are retained in the dossier as content, so their text now
survives process loss even though they still have no dedicated store record.

`mdd_reset` with `scope: run` frees the conversation, which requires the record to leave the
place `mdd_status` reads — not that its content be destroyed. It is moved to
`.mdd/run-<SHA256(parentID)>.discarded.json` with a `discardedAt` stamp, the returned
`reset.preserved` names that file and the run it held, and nothing reports a set-aside run as
recoverable. One slot per conversation: a later discard replaces it, so the directory does not
grow with every reset. A record that cannot be read or copied never holds up the reset; the live
file is removed regardless, and nothing then claims anything was preserved. Deleting the evidence
outright is a different decision from starting something else, and is left to the user.

### Host compaction (`session.compacted`)

MDD keeps no state in the transcript, so a host compaction costs the run nothing. What it costs is
the coordinator's own memory of the protocol: which phase it is on, whether it already dispatched
one, what has already been recorded. The plugin subscribes to `session.compacted`, counts it in
the ledger, and from then on `mdd_status` carries `compacted` and a `runCard` — the objective, the
route, the current phase, the phases already recorded, and a plain statement that they must not be
run again. The card is a description read from MDD's own state, never a capability: it approves
nothing, restores nothing and changes no route. Combined with `nextAction`, a compacted
conversation has two small fields to read instead of a summary to reinterpret. A compaction in a
conversation MDD is not running is ignored.

### Stale installed assets

Setup already refuses to install a package that does not match its assets. Nothing checked the
other direction while a run was live, so an upgraded plugin sitting next to an agent definition
from an older release produced a coordinator reading instructions the adapter no longer speaks —
a failure whose only symptom is a run behaving oddly for reasons nobody can see. At startup the
plugin compares the digest of each installed actor asset against the one in the package running
it, once, and every MDD tool payload then carries `assets: { stale, action }` naming the files and
pointing at `mdd-ai update`. Only a file that exists and differs is reported: an absent one proves
nothing, since running from source is ordinary and installing is setup's job. Nothing is blocked;
the check reports and the user decides.

### Derived next action

Every MDD tool answers through one payload helper that attaches `nextAction`: the single call to
make now, derived from the state it travels with. It carries `args` only when the call is
dispatchable exactly as written — a question envelope, a ready task, a reset scope, a pending
objective's requirements — and otherwise names the tool and states what has to be composed, since
inventing arguments on the user's behalf is the one thing it must never do. Priority is protocol,
not preference: a pending question outranks everything because it is the only thing the user can
act on; a rejected report outranks a ready task because the work behind it is already done;
inline mode outranks delegation because reaching it means delegation already had both turns. It is
derived, never authoritative: it grants no permission, and every guard that refused a call before
refuses it still. Its purpose is to stop the coordinator from re-deriving a state machine from
prose on every turn, which is what the two worst recorded sessions turned out to be.

Lock files (`<path>.lock`) are cooperation hints only; atomicity comes from the temp-file rename.
A process killed mid-write leaves its `wx` lock behind, which would otherwise make every later
write to that name fail with `EEXIST` permanently. A lock untouched for 60 seconds is therefore
reclaimed, since no local write here takes anywhere near that long.

Inspection bounds are per subject, because they measure unrelated things. Message history stays
at the requested 100-message page. Reaching that limit no longer fails: a conversation longer
than one page is what a finished route looks like, and refusing to read it stopped intake,
approvals and the PR-body tool exactly when a run had produced the most. What a full page cannot
do is prove something about the whole conversation, so the two readings that need that say so
themselves. Setup recovery reports no pending objective rather than guessing at one, and question
consent accepts only the running call of the current message, which is a tighter correlation than
the full scan it replaces. Correlating the actual caller and the latest native user text is
unaffected either way, because both live at the tail. Agent registries
(2,000), resolved permission rulesets (4,000) and message parts (1,000) are sized for real
installations, where many agents and skill directories routinely resolve to well over a hundred
entries each. Every overflow names its own subject, so a bound that is reached is diagnosable
instead of being reported as a history problem.

Rollback boundary: remove the MDD plugin loader and native modules/actor assets with their
integration tests and pinned plugin dependency. Core CLI, routing kernel, Workflow and
standalone configuration/artifact/reporting APIs remain independent. Reverting only the
main-route increment must keep runner, native tool/evidence policy, actor permissions and
their contract tests together; do not leave a widened actor with an older dispatcher.

## Compatibility sources

- OpenCode [configuration schema](https://opencode.ai/config.json).
- OpenCode 1.18.31 [native task implementation](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/task.ts)
  and [tool hook execution](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/tools.ts).
- OpenCode 1.18.31 [native shell exit metadata](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/shell.ts)
  and [compatibility bash tool ID](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/shell/id.ts).
- OpenCode 1.18.31 [question result metadata](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/question.ts),
  [native question service](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/question/index.ts),
  [truncation wrapper](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/tool/tool.ts), and
  [running/completed history lifecycle](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/session/processor.ts).
- Engram 1.20.0 [HTTP handlers](https://github.com/Gentleman-Programming/engram/blob/v1.20.0/internal/server/server.go)
  and [session/observation storage](https://github.com/Gentleman-Programming/engram/blob/v1.20.0/internal/store/store.go).
- Installed `@opencode-ai/plugin@1.18.31` and `@opencode-ai/sdk@1.18.31`
  declarations. Current runtime agent fields absent from legacy SDK types are
  decoded and checked explicitly, not cast to invented v2 client methods.
