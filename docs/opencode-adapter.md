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
stop before execution. A status request or restart confirmation is not a new implementation goal.

This recovery is a convenience, never the guard. What keeps a start honest is that requirements
must equal the actual latest native user text, proven separately by `inspector.intake`. So history
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
task returned by `mdd_status` therefore already contains it, and the byte-for-byte dispatch check
in `PhaseRunner.before` is unchanged: the model contributes data, never prompt text. Editing a
task prompt to carry context remains refused, with no execution started.

Context is data, never authority. It cannot replace `requirements`, which still must equal the
exact native user text proven by `inspector.intake`; it grants no approval and changes no
preflight answer, route, score or evidence flag. Provenance is explicit: every entry is recorded
as `source: "coordinator"`, distinct from `provenance.requirements: "native-user"`.

Entries accumulate rather than replace, because useful context also appears after the run starts.
Their combined size is bounded to **8,000 UTF-8 bytes**, well inside the 46,000-byte payload
budget even though the text is JSON-encoded twice on the way into `task`. An over-budget
contribution is refused with the held and attempted sizes, and nothing is recorded or truncated:
a silently trimmed prompt is the delegation failure this bound exists to prevent. Contributions
are rejected while a task is in flight, and a confirmed **material** change drops context
gathered for the replaced objective; a plain preflight rerun keeps it. `mdd_status` reports
`providedContext` as labels, byte sizes and source only, since the text itself is already visible
in the phase prompt. With memory enabled, the entries are persisted with the intent receipt next
to the requirements, so the recorded objective is not merely the sentence that pointed at it.

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
| Capabilities | Not MDD's concern. Phase actors ship no permission map; the user's native permissions decide what any actor may do. The coordinator adds only `question: allow`, the consent channel OpenCode otherwise denies it. |
| Correlation | Confirms the conversation is a top-level `mdd-orchestrator` session in this workspace, and that a native question is the exact running call being answered. Phase results are bound by phase, runID and, when delegated, callID. |
| Models | Configured per role through the startup profile and applied to the agent config. Runtime model identity is not policed. |
| Consent | Complete startup profile or exact correlated native preflight answers; later interactive Proceed/Stop applies only to the currently waiting phase. No repeat preflight or implicit approval. An answer that names nothing on offer selects nothing: the user wrote their own words, or a host reordered the result, and MDD cannot tell those apart. Neither is consent, so the receipt is recorded as cancelled and the same question stays open to be asked again. A question MDD did not compose is the coordinator's own and touches no MDD state, except while an MDD question is pending, when it is the only question that may run. |
| Persistence | HTTP only to a literal IPv4 loopback origin, no credentials/path/query/redirects, no retries. Each HTTP/SDK read has a maximum five-second timeout. HTTP responses are bounded to 128 KiB. |
| Failure | Infrastructure failures do not fabricate failed phase results. A rejected dispatch, result, capability or persistence ends that attempt: the phase returns to `ready`, the attempt counter increases, and the run stops being uncertain, so delegating again, taking the phase over directly, replanning or resetting all stay available. The first failure keeps `mode: "delegate"` and rewrites the phase task to carry what went wrong, so the retry is a different attempt rather than the same one; the second sets `mode: "inline"` and hands the phase to the coordinator, because retrying forever against one failure is not resilience and handing it over immediately spends the context that delegation exists to protect. A failed read-only investigation leaves the main plan's task, mode and attempts untouched. A missing after-hook leaves `await-result` until a matching native error releases it. `mdd_status` never grants approval or dispatches by itself. |
| Recovery | No MDD state is terminal. `mdd_reset` releases the current attempt (`scope: phase`) or forgets the run for this conversation (`scope: run`), clearing the local progress marker. Scope `phase` also covers work waiting on a person rather than on an actor: a run stopped at an approval returns to `await-approval` with that question re-armed, and an intake stopped before any run re-opens its pending question. Neither prepares a phase nobody authorized. Recorded artifacts, memory and `previousRuns` are never deleted by a reset, and `scope: run` sets the preserved record aside under a discarded name rather than destroying it. |
| Payload budget | Every MDD tool serializes through `statusPayload`, bounded to 46000 bytes so the host cannot truncate a result and make the exact `task`/`question` uncopyable. Artifact history is reported as refs only (content lives in the artifact store and is already injected into the next phase prompt), and `brief` accompanies only `mode: "inline"`. Over budget, fields are dropped in the fixed order `priorRun, previousRuns, contexts, contextualReport, providedContext, artifacts, artifactAttempts, artifact, concerns, report, planned, decisions, acceptance, verification, workflow` and listed in `omitted`; `task`, `brief`, `question`, `state`, `phase`, `next`, `mode`, `reason`, `runID`, `sessionID`, `runtime`, `questionReceipts`, `recovery`/`pendingStart`, `notice`, `provenance`, `reset`, `evidence`, `coverage` and `recoverable` are never dropped. A task too large to fit is reported in `budget.problem`, never cut. |
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
| Every phase actor | Whatever the phase needs. Phase actors ship no permission map, so the user's own OpenCode permissions decide. |
| Coordinator | The same, plus its MDD tools and `question`. It ships exactly one rule, `question: allow`, because OpenCode denies that tool for non-native agents and hides denied tools from the model; without it no preflight or approval can be asked. It may delegate a phase or carry it out itself. |

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
The marker remains a replay guard and an authorization source for nothing at all. It is not the
workflow ledger either; that role belongs to the separate run dossier described next.

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

**The run is not resumed, by design.** After dying mid-`mdd-apply` MDD does not know what reached
the working tree, so restoring a controller would fake a continuity that does not exist. With no
live run, `mdd_status` reports `state: 'recoverable'`, `recovery: 'data-only'` and a `priorRun`
marked `capability: 'data-only'`, plus `limits` stating plainly that the working tree may hold
partial changes MDD never recorded and must be inspected with `git status`/`git diff`, that no
approval survived, and that any task still running will never report. The way forward is
`mdd_start` with the original objective as actual new native user text — which still requires a
fresh preflight — or `mdd_reset` with `scope: run`, which discards the record.

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
