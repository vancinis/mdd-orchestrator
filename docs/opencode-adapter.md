# Run the main MDD routes in OpenCode

This opt-in adapter targets OpenCode **V2 2.0.22** and preserves the approved low/high main routes.
It uses the native permission-controlled foreground `subagent` tool, not SDK prompting.
When optional Engram memory is enabled, receipts must be read back before dispatch and before recording a result.
Verify is grounded in actual native command outcomes. This is **execution evidence, not
a guarantee of semantic correctness or independent review**. Model-backed E2E is pending.

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
   argument object covering all and only the missing fields. Submit it once to `question`.
   No typed JSON preflight or model-supplied answer override is accepted.
6. After the question, read `mdd_status`. It returns `nextAction`: the single call to make now,
   with ready-to-dispatch `args` whenever the call is dispatchable as written. Submit exactly the
    returned `task` arguments (`agent`, `description`, `prompt`), once, using native `subagent`
    foreground execution. Do not add `background`, `sessionID`, `model`, or extra keys. The hook
   appends the actual native call ID in place after checking the expected args.
   After the task, call `mdd_status` and present the readable artifact to the user.
   In interactive mode, a passed phase exposes an exact native Proceed/Stop question for
   the next phase. Approval prepares only that phase's task. Automatic mode returns the next
   exact executable task without an approval question. Repeat through final Verify. A rejected
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
- Tools are direct (`codemode: false`). Model context collapses settled phase prompts without
  rewriting persisted native messages or recorded artifacts.

Run `node tests/opencode-v2-host-smoke.mjs` after building for the explicit **2.0.22** host check.
It starts a service in isolated XDG directories, authenticates from that service's registration,
and verifies 15 tools, nine agents, profile variants and phase isolation permissions without
model requests. Contract tests cover intake, grouped questions, foreground Plan/Apply/Verify,
native fallback restrictions, workspace isolation and CLI events. Neither check proves model-backed
end-to-end execution or interactive permission/UI behavior.

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
because no run is recorded there is no coverage, ledger row or `mdd_pr_body` evidence for it.

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
preflight answer, route, score or evidence flag. Provenance is explicit: every entry is recorded
as `source: "coordinator"`, distinct from `provenance.requirements: "native-user"`.

Entries accumulate rather than replace, because useful context also appears after the run starts.
A single entry is bounded to **96,000 UTF-8 bytes** — the same `PHASE_CONTEXT_MAX_BYTES` ceiling
the composed phase prompt is checked against — rather than a smaller aggregate cap: the prompt is
what actually has to stay deliverable, no longer the `task` field of `mdd_status`, since context no
longer travels through status at all. Every contribution therefore trial-composes the current
phase prompt and is refused, unrecorded, if that composed prompt would exceed 96,000 bytes; a
ready phase's prompt is recomposed immediately so `mdd_status` returns the updated task. Delivery
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
| Failure | Infrastructure failures never fabricate phase results. Read-only phases may retry with failure context, then use one tracked native fallback after `DELEGATION_ATTEMPTS` (3). Apply is different: uncertain writes, failed native results or interrupted actors block with pending recovery protection, never automatic redispatch. Unknown child termination remains `await-result`. A malformed completed report permits only bounded report restatement, not substantive work. A reported phase failure blocks until explicit recovery. `mdd_status` never grants approval or dispatches by itself. |
| Recovery | No MDD state is terminal. `mdd_reset` releases the current attempt (`scope: phase`) or forgets the run for this conversation (`scope: run`), clearing the local progress marker. Scope `phase` also covers work waiting on a person rather than on an actor: a run stopped at an approval returns to `await-approval` with that question re-armed, and an intake stopped before any run re-opens its pending question. Neither prepares a phase nobody authorized. When Verify reports failure, status names `reworkable: "mdd-apply"` and `scope: rework` sends the run back to Apply to correct what it found, instead of re-checking the unchanged implementation or filing a material change. It needs `userText`, the user's exact latest message choosing the correction; the failed verification becomes Apply's newest dependency artifact, earlier changes are kept, and Verify follows through the route's ordinary approval. Recorded artifacts, memory and `previousRuns` are never deleted by a reset, and `scope: run` sets the preserved record aside under a discarded name rather than destroying it. |
| Handoff budget | Each phase prompt carries the artifacts it depends on. A seven-phase route holding 16,000-byte artifacts outgrows what a dispatched task can be delivered at, and the phases that paid for it were the last ones. Artifacts are therefore inlined newest-first while the prompt stays within 38000 bytes, the size that still fits inside the 46000-byte payload budget with the rest of the status; older ones travel as their own recorded `evidenceSummary` plus the ref that identifies the complete text in the artifact store. Shedding is ordered and announced in the prompt, and `mdd_status` reports it as `handoff`. Contextual findings are not compacted: they accumulate by the user's own choice, and `PHASE_CONTEXT_MAX_BYTES` (96000) remains the absolute bound that fails explicitly rather than cutting anything. |
| Payload budget | Every MDD tool serializes through `statusPayload`, bounded to 46000 bytes so the host cannot truncate a result and make the exact `task`/`question` uncopyable. Artifact history is reported as refs only (content lives in the artifact store and is already injected into the next phase prompt), and `brief` accompanies only `mode: "inline"`. Over budget, fields are dropped in the fixed order `priorRun, previousRuns, contexts, contextualReport, providedContext, artifacts, artifactAttempts, artifact, concerns, report, planned, decisions, acceptance, verification, workflow` and listed in `omitted`; `task`, `brief`, `question`, `state`, `phase`, `next`, `mode`, `reason`, `runID`, `sessionID`, `runtime`, `questionReceipts`, `recovery`/`pendingStart`, `notice`, `provenance`, `reset`, `evidence`, `coverage` and `recoverable` are never dropped. A task too large to fit is reported in `budget.problem`, never cut. |
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
requires a fresh actual native user message. A material proposal requires new requirements,
backed either by a fresh user message asking for the change — which is enough on its own — or,
when that message was already used, by concerns a phase already recorded. Concerns are optional
supporting evidence otherwise. The tool accepts them as the declared array, as JSON text, or as a
single bare object, because host tool bridges and models deliver all three; every entry is still
validated strictly. No keyword scoring or automatic route replacement occurs.

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
`passed` or `failed`, `## MDD Summary` holds the prose a person reads first, `## MDD Artifact`
holds the deliverable, and `## MDD Data` holds one fenced JSON block for the phases that carry
traceability fields. `## MDD Concerns` is optional. The headings are prefixed so an artifact may
use its own `## Summary` or `## Data` without being cut in half by the envelope carrying it, and
a heading inside a fenced block is content rather than a delimiter. Unprefixed headings are read
for a document that used no prefixed heading anywhere.

Reading is deliberately lenient everywhere leniency cannot change a fact. Prose around the
document is ignored, the legacy whole-message JSON object is still understood, and a field no
phase reports is dropped and named rather than failing the phase. `phase`, `runID` and `callID`
are checked when the actor states them and are never required: the dispatch was already matched
by call ID and by exact task arguments, so stating them can only reject a mismatch, never
authorize one. `mdd_status` returns `resultFormat`, the exact headings for the current phase, as
a protected field, so a phase reported inline is never reported against a remembered shape.

A report MDD cannot read is not a phase that failed. The work it describes is often finished and
already in the working tree, so it costs a restatement rather than an attempt: the text comes
back under `rejected`, the phase becomes the coordinator's to restate through
`mdd_phase_result`, and the telemetry failure class is `result-malformed`, distinct from
`result-rejected`. After `MALFORMED_RESTATEMENTS` (3) consecutive unreadable reports the attempt
is spent normally, because a report nobody can state correctly is no longer only transcription.

`## MDD Data` permits these phase-specific fields:
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
  earns no implementation points. Also `checks: [{ command, exit }]`, the commands Apply reports
  having run. Its own agent definition asks for them, and rejecting the phase for supplying them
  was one of the ways a finished implementation had to be run twice. They are recorded as the
  phase's claim and shown as one; only Verify's checks earn the `checks` evidence flag.
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
checks and material gaps. Checks are recorded with the exit code Verify reported, so a command
that failed is counted apart and named apart instead of disappearing among the successful ones. Low remains concise; medium adds `Cómo`; detailed adds `Estado` and
evidence-coverage `Cobertura`. The frame is rendered in Spanish for the reader while the phase
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
Reports honor low/medium/detailed settings and never take a model-selected percentage.
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

When requested, `mdd_pr_body({ userText, notes?, digest?, translations? })` checks the actual
latest native user text and current parent, then renders the shared local template without
changing workflow, approval, artifacts or memory. It requires a recorded run; it never starts
implementation merely to draft a body. Optional notes contain `environmentVariables`,
`followUps`, and/or `deployment`, each quoting a whole user-provided line. They stay attributed
and unverified. No model-callable parameter can replace recorded changes, checks or completion
evidence.

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
