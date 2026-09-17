# Run the main MDD routes in OpenCode

This opt-in project adapter executes the complete approved low/high main routes.
It uses the native permission-controlled `task` tool, not SDK prompting.
When optional Engram memory is enabled, receipts must be read back before dispatch and before recording a result.
Verify is grounded in actual native command outcomes. This is **execution evidence, not
a guarantee of semantic correctness or independent review**. Model-backed E2E is pending.

## Setup

Run the single [setup wizard](setup.md): `npm run setup` from trusted source, or
`node "<OpenCode root>/mdd/node_modules/my-driven-development/dist/cli.js" setup` from any directory.

1. Use OpenCode **1.18.31** and Node **24.15+ within 24.x**. Setup offers missing dependencies,
   optional Engram **1.20.0**, global assets and a readiness check in one invocation.
2. After Ready, quit and restart OpenCode in the active project. Configuration and plugin loading
   are startup-time operations. `<OpenCode root>/plugins/mdd.ts` imports the installed package
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
   argument object covering all and only the missing fields. Submit it once to `question`.
   No typed JSON preflight or model-supplied answer override is accepted.
6. After the question, read `mdd_status`. Submit exactly the returned `task` arguments, once, using the native task
   tool. Do not add `background`, `task_id`, `command`, or extra keys. The hook
   appends the actual native call ID in place after checking the expected args.
   After the task, call `mdd_status` and present the readable artifact to the user.
   In interactive mode, a passed phase exposes an exact native Proceed/Stop question for
   the next phase. Approval prepares only that phase's task. Automatic mode returns the next
   exact executable task without an approval question. Repeat through final Verify. A rejected
   attempt is not the end: the phase becomes ready again, so run it once more or carry it out
   directly. Neither mode suppresses native edit/bash permission requests.

The MDD tools are registered once for the whole app but belong to `mdd-orchestrator`. Every
other agent has them disabled in configuration and refused at execution, so an unrelated
agent neither sees nor mutates MDD state.

### Legacy setup-only recovery

Read `mdd_status`, not `mdd_start`, for status updates. Absent Engram settings are now normal
memory-off operation, not a setup block. Invalid settings still prevent plugin tools from
loading; repair the named file against the schema and restart. No endpoint or project is guessed.

A setup-only stop retains proven original requirements. After saving and restarting,
the coordinator may resubmit exact `pendingStart` arguments when the user continues that
objective. Native history must prove the same parent/workspace and a correlated setup-only
stop before execution. Legacy errors, incomplete/ambiguous history or uncertain execution
do not grant recovery: restate the original objective in a fresh parent, without resuming
uncertain work. A status request or restart confirmation is not a new implementation goal.

For information-only requests such as explaining a project, the coordinator calls
`mdd_contextual_explore` instead of stopping or forcing `mdd_start`. That route is available
with or without an accepted run, so a status block never leaves the conversation without a
read-only answer. A quoted path neither changes the loaded workspace nor authorizes
cross-project access or configuration edits.

### Bootstrap the actual parent

Only when memory is enabled, MDD checks health and `GET /project/current?cwd=<native-root>`.
It validates the resolved project/root, including HTTP-200 error hints and ambiguity, and
preserves an explicit legacy project only when it matches. It then reads
`GET /sessions/{actual-native-parent-id}`. Existing sessions must match ID, project and
directory exactly, with `ended_at` absent or null. Conflicting, incomplete or ended sessions
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
  "requirements": "Produce a read-only plan for the requested CLI change."
}
```

The string must equal the latest actual native user's text parts joined with a newline,
except exact original requirements authenticated by native setup-only history as described above.
Synthetic/ignored text, missing native history, rewritten requirements, or wrong caller
message IDs block rather than inventing human intent. All other public start keys are rejected.
The internal `PhaseRunner.start` complete-input API remains a test/integration seam only;
it is not exported as a model-callable tool. Kernel/proof CLI shapes remain unchanged.

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
intake, and retained `questionReceipts`. `await-answer` means wait, never reprompt. Dismissal,
errors, changed/stale/duplicate callbacks, or a task before consent block the intake. `Stop`
records refusal without fabricating a failed phase result. A missed after hook remains
pending; no automated recovery is attempted. Unrelated sessions remain unaffected.

## Safety and storage boundaries

| Boundary | Behavior |
|---|---|
| Dispatch | One live run per actual parent. Synchronous reservation precedes asynchronous persistence. A task that arrives while one is already running is refused without touching it; any other unexpected task ends the attempt and returns the phase to `ready`. |
| Capabilities | Not MDD's concern. Packaged agents ship no permission map; the user's native permissions decide what any actor may do. |
| Correlation | Confirms the conversation is a top-level `mdd-orchestrator` session in this workspace, and that a native question is the exact running call being answered. Phase results are bound by phase, runID and, when delegated, callID. |
| Models | Configured per role through the startup profile and applied to the agent config. Runtime model identity is not policed. |
| Consent | Complete startup profile or exact correlated native preflight answers; later interactive Proceed/Stop applies only to the currently waiting phase. No repeat preflight or implicit approval. |
| Persistence | HTTP only to a literal IPv4 loopback origin, no credentials/path/query/redirects, no retries. Each HTTP/SDK read has a maximum five-second timeout. HTTP responses are bounded to 128 KiB. |
| Failure | Infrastructure failures do not fabricate failed phase results. A rejected dispatch, result, capability or persistence ends that attempt: the phase returns to `ready`, the attempt counter increases, and the run stops being uncertain, so delegating again, taking the phase over directly, replanning or resetting all stay available. A missing after-hook leaves `await-result` until a matching native error releases it. `mdd_status` never grants approval or dispatches by itself. |
| Recovery | No MDD state is terminal. `mdd_reset` releases the current attempt (`scope: phase`) or forgets the run for this conversation (`scope: run`), clearing the local progress marker. Recorded artifacts, memory and `previousRuns` are never deleted by a reset. |
| Next phase | Automatic success prepares only the next phase. Interactive success waits for exact native approval. Only final corroborated Verify returns `complete`. |
| Other sessions | Unrelated tasks outside MDD are untouched. `mdd-*` native tasks are rejected unless they exactly match a registered parent run or an issued read-only investigation. |

With optional memory enabled, each phase writes two project-scoped Engram observations using type `workflow`, no topic-key upsert:

- **Intent:** original requirements, run ID, call ID, phase, resolved preflight
  answers, evaluation, and started workflow snapshot.
- **Result:** run/call/phase binding, outcome, bounded evidence summary, artifact
  reference, selected `artifactStore`, `storage: general-workflow-context-only`,
  and `independentVerification: false`.

Both observations also carry their Engram title, project, and actual parent
session ID. Returned observation ID and all submitted fields must match the
readback. Requirements are limited to 12,000 bytes, evidence to 2,000, artifact
content to 16,000, and result JSON to 20,000. Full artifact text is not copied into general
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
requires a fresh actual native user message. A material proposal requires new requirements
and advisory evidence, backed by a fresh user message or a concern already recorded by a
phase. No keyword scoring or automatic route replacement occurs.

The existing native gate shows one exact confirmation. Keeping the current plan or dismissing
the change leaves its answers, artifacts and pending approval unchanged. Confirmation leads
to **one grouped question containing all five fields**, even with a complete profile. Only
accepted answers create the new planned run. Prior runs remain in `previousRuns` for live
inspection; no artifact or general-memory record is deleted. Identical proposals are not
repeatedly presented without a new user request. Ordinary implementation choices and automatic
phase progression never initiate this path.

A known failed phase can be explicitly replanned after its result and persistence are
confirmed. Only a task that is actually running postpones a change request; a stopped or
failed run is always changeable, and `mdd_reset` releases a dispatch that never reported.
Harmless incorrect task/question parameters are rejected before effects without poisoning a
ready plan. A completed run accepts a fresh next task through normal `mdd_start`, using the
startup profile without an additional change confirmation. Permissions/models are not widened
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
| Every phase actor | Whatever the phase needs. Packaged agents ship no permission map, so the user's own OpenCode permissions decide. |
| Coordinator | The same, plus its MDD tools and `question`. It may delegate a phase or carry it out itself. |

MDD no longer polices tools, commands or paths. It used to: an allowlist per phase, a command
denylist, root-scoped path checks and resolved-permission validation of every agent. That
stopped unsafe work only in theory, while in practice it stopped ordinary work, and each
check was one more way for a run to die with no way back. Capability is a native decision,
and the permission prompt is where the user makes it.

**Shell executes real project code, not a sandbox.** A project script can have side effects;
the native permission request is the moment to assess that. Indirect behaviour is never
semantically certified by MDD.

Native skill loading still yields to packaged instructions: skill text, path and digest are
injected before dispatch so a same-named global skill cannot shadow them. Apply receives
`mdd-cleanup/SKILL.md`. Explore, Plan, Propose, Spec, Design and Verify receive
`mdd-doc/SKILL.md`, which shapes only the readable `artifact` prose and costs about 3.9% of
the phase context budget; Tasks and Apply carry structure rather than narrative and do not
pay for it. Standalone investigation receives it too. The `mdd_pr_body` tool reads the fixed
packaged PR skill/template with path/digest provenance; no name-based skill lookup occurs.

### Delegation and the inline route

Delegation is the default: `mdd_status` returns the exact `task` for the phase actor, and
`mode` is `delegate`. It is a preference, not a cage. When an attempt does not complete, the
phase returns to `ready` with `mode: "inline"` and a `brief` holding the same instructions.
The coordinator then carries the phase out with its own tools and reports it through
`mdd_phase_result({ result })`, which takes the same result object without a `callID`.
Both routes share one contract and one recording path, so artifacts, memory, evidence and the
workflow do not depend on which one produced the result. The next phase starts from
delegation again, and delegating a handed-back phase a second time stays allowed.

Strict result JSON retains phase/runID/callID/outcome/evidenceSummary/artifact and permits
these phase-specific fields:
- Plan: `acceptance`, `decisions`, and nonempty `deliverables`. The same single plan artifact
  contains the concise narrative and the adapter-appended canonical acceptance/step map.
- Spec: `acceptance: { goal, requirements: [{ id, description, scenarios: [{ id, given, when, then }] }] }`.
- Design: `decisions: [{ id, description, requirements: [requirementID] }]`; empty is valid when
  no relevant decision needs tracking. Requirement/scenario IDs cannot be replaced here.
- Plan/Tasks: `deliverables: [{ id, description, path, check, scenarios, decisions?, dependsOn? }]`.
  Scenario references are required; optional decision/dependency lists default to empty only
  when omitted. Every held scenario and relevant decision requirement must map to a step.
  Dependencies refer to earlier steps. Paths and commands retain existing scope checks.
- Spec: `domain: "project"`, matching the dispatched storage namespace.
- Apply: `changes`, the file paths the phase changed. Alternatively `noChangeReason`, which
  earns no implementation points.
- Verify: `checks: [{ command, exit }]`, the commands the phase reports having run. `exit` is
  an integer, or `null` when the command did not finish. MDD records the claim as a claim: it
  never re-runs the command and an exit code is not a semantic certificate.

Verify also requires `verification: { scenarios, steps, decisions, changes, limits }`:
- Scenario rows name `requirementID`, `scenarioID`, `stepID`; step rows name `stepID`;
  decision rows name `decisionID`. Every held link/step/decision appears exactly once.
- Each row has `status: verified | not-verified | deviation`, `checks: [command]`, and a
  concise source-based `assessment`. The report must agree with itself: a row may only cite a
  command the same phase reported running, and a `verified` row may not rest on a check that
  did not pass. That consistency is the honesty MDD can offer without re-running anything.
- `changes` is a plain-language interpretation; `limits` contains up to four material notes.
  A passed outcome with missing coverage or any not-verified/deviation row blocks; an explicit
  failed outcome with complete partial coverage remains failed and visible. No extra check
  commands or user approval questions are introduced to satisfy this map.

`mdd_status` exposes detached `acceptance`, `decisions`, `planned` and `verification` for
drilldown. Terminal `report` leads with the goal, recorded changes, requirement/plan match,
checks and material gaps. Low remains concise; medium adds How; detailed adds Status and
evidence-coverage Confidence. Default reports omit internal routing, calls and receipts.
The map and assessments are agent interpretations of the user request, not a parser's proof
of semantic correctness. Code checks reference integrity and native execution evidence.
`verification.matched` describes the assessment map; successful route completion additionally
requires the native execution, persistence and other existing safety checks to pass.

Coverage is **20** accepted native requirements/profile intake + **20** validated Plan/Tasks
deliverables + **25** reported implementation changes + **35** reported Verify checks that
passed. The flags describe what each phase reported, not independent proof. Other phases earn
no automatic points. A recorded failure withdraws affected evidence; an attempt that never
completed withdraws nothing, because it claimed nothing.
Reports honor low/medium/detailed settings and never take a model-selected percentage.
Telemetry supports off/delete and retains 30 days locally. Diagnostics are bounded, and
telemetry failure does not alter phase outcomes. Status reads do not append telemetry.

## Verification and limitations

`npm test` includes the original 83 routing/CLI/workflow tests and additional
real-loopback HTTP and explicitly labeled SDK/hook **contract tests**. Faked
SDK metadata is not a model execution claim. `npm run typecheck` checks the
installed v1 nested `path`/`query` SDK calls and plugin hook types.

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

## PR-body drafts

When requested, `mdd_pr_body({ userText, notes? })` checks the actual latest native user text
and current parent, then renders the shared local template without changing workflow,
approval, artifacts or memory. It requires a recorded run; it never starts implementation
merely to draft a body. Optional notes contain `environmentVariables`, `followUps`, and/or
`deployment`, each quoting a whole user-provided line. They stay attributed and unverified.
No model-callable parameter can replace recorded changes, checks or completion evidence.

The six sections always remain Summary / Changes / Environment variables / Follow-ups /
Blockers / Deployment. Missing optional facts are explicitly unverified; an explicit user
`Not applicable.` line is retained. Obvious credential assignments, paths and code excerpts
are omitted; only conservative simple check commands are shown exactly. This is not a
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
`mdd_reset` releases it in place. Settled or complete markers leave the conversation free for
new work; only reusing the same native user message is refused, so nothing is silently
replayed. Other parent IDs use independent marker files, so an old pending or corrupt marker
never blocks unrelated conversations.
The marker is a replay guard, not a second workflow ledger or authorization source. Live-only
`none` artifacts cannot be recovered after process loss; persisted artifacts/memory remain.

Inspection bounds are per subject, because they measure unrelated things. Message history stays
at the requested 100-message page and still fails closed at that limit. Agent registries
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
