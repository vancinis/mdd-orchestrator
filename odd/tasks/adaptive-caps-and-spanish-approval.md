# Remove the adaptive size caps and ask operation approvals in Spanish

The version-3 adaptive lane no longer refuses or compacts work for its size, and its interactive
operation approval is a Spanish summary instead of the operation's raw JSON in English. A
follow-up removed the cap on the user's request in both routes, the file text from snapshots and
the count caps on contracts, plans, reports and long runs.

## Problem and evidence

Two reports from real use:

1. A `better-you` run in interactive mode asked, three times in one run, "Authorize only this exact
   adaptive operation? Native tool permissions still apply." followed by the whole operation as
   JSON. The contract inside it was English and abbreviated ("Free1 active", "95PNG7TXT",
   "noMarkdown"). The text was hard-coded in `src/adaptive-native.ts`, against the rule in
   `src/preflight.ts` that MDD must not interrogate in another language. The product-question frame
   in `src/adaptive-low.ts` (`Product decision`, `Why:`, `Pause`) was English too.
2. In this repository, a medium-route run whose contract was 13 KB was admitted and then refused
   at its first actor: "Internal actor prompt cannot fit the native dispatch budget." The contract
   could not change after admission, so retrying gave the same refusal.

The caps behind both:

| Cap | Where | What it did |
|---|---|---|
| 24000-byte contract | `adaptive-low.ts`, `adaptive-protocol.ts` | Made coordinators abbreviate what the user reads in the approval. |
| 38000-byte actor prompt | `phase-runner.ts` (adaptive select) | Refused a contract the user had already approved. The prompt never travels through the coordinator: status exposes only the single-use handle. The Plan prompt carries the contract about three times, so a contract over roughly 8 KB was undispatchable in medium. |
| 48000-byte evidence and check history | `adaptive-low.ts`, `adaptive-protocol.ts` | Scaled with the contract and would refuse next. |
| 12000-byte objective | `adaptive-low.ts`, question record | Refused a long request the user had already sent. |
| 16 exclusions, product questions and limits | `adaptive-low.ts`, `adaptive-protocol.ts` | Made coordinators merge or drop real exclusions and limits. |
| 256 KiB per file | `adaptive-low.ts` fingerprints, `worker-edit.ts` | Refused any contract touching an ordinary large file (`src/phase-runner.ts` is 398 KB) and made it impossible for Apply to edit one. |
| 1 MiB snapshot | `adaptive-low.ts` | Refused footprints of a few ordinary source files. |

Verify's prompt also inlined every snapshot file whole. Under the 38000-byte cap that refused any
medium or high Verify with real files; without the cap it would put whole files into the prompt.

## Changes

1. **Caps removed** from the table above. Each validator keeps its form checks (nonempty text, no
   terminal controls, UTF-8, exact scope). What still bounds the lane is the 160000-byte request,
   the 8 MiB lane record and the status budget.
2. **The question record bound** (`QUESTION_CHECKPOINT_BYTES`) is 1 MiB instead of 160000. It is
   the file bound, not a field limit. An adaptive record carries the request up to three times
   (objective, proposed operation and the approval that quotes it).
3. **Adaptive actor prompts** carry every predecessor report whole. `continuationHandoff` and its
   compaction are gone.
4. **Verify** receives snapshot files by path, digest and byte size (`evidenceByReference`) and
   reads them with its scoped read tools. Verify can only be selected on a current snapshot, so the
   bytes it reads match. The lane record keeps the snapshot bytes.
5. **Operation approval** (`operationApprovalEnvelope`) is headed `Aprobación de operación` and
   offers `Aprobar operación`, `Pausar` and `Rechazar`. Its text summarizes the operation by kind:
   - entry: objective, goal, counts, assessment, writable files and exclusions;
   - select: actor, assignment, purpose, repair reference, the files an Apply may change and fresh context;
   - other operations: what they do, with their deciding data.

   The record still binds the exact operation, generation and nonce.
6. **One approval check.** `approvesOperation` accepts `Aprobar operación` and the legacy
   `Approve operation`, which settled receipts still carry, and nothing else. Both the bridge and
   the ownership checks use it. `Pedido anterior` uses the same labels.
7. **Product questions** use `Decisión de producto`, `Por qué importa: ` and a `Pausar` default.
   Restore accepts the current frame or the English one, never a mix. `pausar`, `rechazar` and
   `detener` join `pause`, `decline` and `stop` as unresolved answers.
8. **Coordinator guidance.** The entry guide, the `mdd_adapt` description and `mdd-grill` say to
   write user-visible text in complete Spanish sentences and never compress it to fit.

## Not changed

- The fixed route's soft compaction toward 38000 bytes, which never refuses.
- The 46000-byte status budget, a real host output limit.
- Persistence bounds: checkpoints, the lane record and stores. They do not limit what the user
  writes. They keep a corrupted or runaway file from freezing the OpenCode process that reads it
  on every call.
- Host form limits: the 30-character question header, eight questions and six options per form.
- 16 operations per `mdd_worker_edit` call; the actor makes another call.
- The fixed route's user-text cap and the count caps were removed in the follow-up below.

## Follow-up: the user's request, snapshots and count caps

1. **The user's request has no size limit.** The 12000-byte cap is gone from every site that
   repeated it: `mdd_start`, change requests, written answers, transfer and recovery requests,
   knowledge recording, typed answers, the checkpoint, the question record and the run dossier.
   It existed only so the Engram intent receipt would fit. Engram truncates silently past 50000
   characters, and MDD keeps its own 40000-byte margin, which is unchanged. `intentEnvelope` now
   degrades in two steps:
   - first the coordinator's context, as before;
   - then, if the receipt still does not fit, the request, to `requirementsOmitted`,
     `requirementsBytes` and `requirementsSha256`.

   The whole request stays in the local checkpoint and run record, which are what restore reads.
   The preserved-run view in status, which has its own 30000-byte share, shows the request's
   opening with its size and digest once nothing else is left to shed.
2. **Snapshots keep no file text.** Each prepared file is recorded by path, SHA-256 digest and byte
   size. Keeping the text put one copy of the whole footprint in the lane record per snapshot:
   current, prior and every archived one. With the 1 MiB snapshot cap gone, a few large files
   could fill the 8 MiB record, and every call re-read and re-hashed all of it. The files stay on
   disk and the digest proves they did not change. Two things are given up:
   - the exact bytes of a prepared file can no longer be read through the snapshot detail; the
     coordinator and actors read the file itself;
   - an archived snapshot keeps only the digest of a file that later drifted, not its old text.

   The UTF-8 requirement at preparation is gone with the text it protected. Records written
   before this, with `content`, restore unchanged, and a text that contradicts its digest is
   still refused.
3. **Count caps removed**:
   - in the contract: 64 requirements, scenarios and decisions, 32 assignments, 64
     scenario-to-assignment links, 32 source obligations and 64 obligation IDs, 64 paths per
     scope, obligation or read target, and 128 policy sources;
   - in plans: 32 deliverables and 32 checks per deliverable, 64 checks per plan;
   - in reports: 32 executed commands and 64 changed paths;
   - per run: 64 receipts, 64 native calls, 64 archived evidence snapshots, 64 continuation
     reports, 64 native approvals, 64 retired question calls and 256 archived runs per
     conversation.

   Without the count caps, a closure can carry more limits than status can show inline, so its
   projection now moves them behind a paged reference, as evidence already did. The input
   documentation, the Plan and Tasks prompts, the adapter guide and the README limits table no
   longer advertise the removed counts.

## Verification

```powershell
npm run build
node --import ./tests/isolate-home.mjs --test tests/adaptive-native.test.mjs tests/adaptive-public.test.mjs tests/adaptive-protocol.test.mjs tests/run-ownership.test.mjs tests/adaptive-low.test.mjs tests/adaptive-continuation.test.mjs tests/adaptive-store.test.mjs tests/phase-assets.test.mjs tests/worker-edit.test.mjs
npm run typecheck
git diff --check
npm test
```

## Progress

- Baseline before changes: the nine suites above passed 565/565.
- After the changes: 611/611. New regressions cover:
  - a long objective, 20 exclusions and a contract over 24 KB admitted;
  - evidence over 48 KB accepted;
  - a 340 KB file fingerprinted and edited;
  - reports over the old dispatch budget reaching Tasks whole;
  - Verify naming snapshot files by digest;
  - the Spanish entry and select approvals;
  - the legacy approval token;
  - the Spanish product frame and a legacy-frame restore.
- `npm run typecheck` exit 0. `git diff --check` exit 0.
- Full suite: `npm test` ran 2,805 tests. 2,801 passed, 1 failed and 3 were skipped, the same
  environmental skips as earlier runs. The failure was `question-checkpoint.test.mjs`, which
  asserted that a 160 KB answer exceeded the old 160000-byte record bound. It now asserts that the
  answer is accepted and that a record past `QUESTION_CHECKPOINT_BYTES` is still refused. That
  file then passed 23/23.
- Follow-up: 17 affected suites passed 971/971, including the acceptance, checkpoint, native
  intake, question checkpoint, run dossier, receipt summary, apply batches and worker batch
  suites. New regressions cover:
  - a fixed run from a request over 12 KB, checkpointed whole and restored;
  - the Engram intent receipt degrading the request after the context;
  - the preserved-run view clipping a long request with its digest;
  - snapshots without file text, and a legacy snapshot with text restoring;
  - a contract with 70 scenarios, 40 assignments and 140 files admitted interactively;
  - 70 native approvals, retired calls and native calls kept;
  - 70 changed paths, 40 executed commands, 40 deliverables and 40 checks per deliverable read.
- Full suite after the follow-up: `npm test` ran 2,812 tests. 2,809 passed, 0 failed and 3 were
  skipped, the same environmental skips as before. `npm run typecheck` exit 0. `git diff --check`
  exit 0.
