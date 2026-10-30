# Short native questions, with the detail in the chat

Every MDD question that carried its context inside the native form now asks a short question in
the form and publishes the context separately, as `questionBrief`. The coordinator writes that
text in the chat, as it is, right before it calls the native `question` tool.

## Problem and evidence

In interactive mode the user could not read the approvals. `operationApprovalEnvelope` put the
whole operation summary into the question text: the exact request, the goal, the counts, the
assessment, every writable file and every exclusion. Since the request lost its size cap, that text
had no bound. The coordinator could not shorten it, because MDD only accepts the exact envelope it
issued.

OpenCode's form cannot show long text (checked in the `dev` branch of `anomalyco/opencode`):

| Client | File | What happens to a long question |
|---|---|---|
| TUI | `packages/tui/src/routes/session/form.tsx` | The question is a plain `<text>`; only the review tab scrolls, so text that does not fit is cut. |
| Desktop and web | `packages/app/src/session/requests/session-question-dock.tsx`, `packages/session-ui/src/components/question-prompt.css` | The options get only the height the question leaves, and the question frame clips (`overflow: clip`). |

The schema itself asks for a header of at most 30 characters and option labels of one to five words.

The fixed route already worked this way for phase approvals: the report goes to the chat and the
approval is one short sentence.

## Questions changed

| Question | Builder | Moved to the brief |
|---|---|---|
| Operation approval (v3, interactive) | `operationApprovalEnvelope` | Every detail of the operation; the form keeps its one-line headline. |
| Earlier request (v3) | `earlierObjectiveEnvelope` | The quoted earlier request. |
| Product decision (v3) | `adaptiveQuestionsEnvelope` | `Por qué importa` of every question. |
| Clarification and preflight doubts (fixed) | `clarificationPrompt` | `Por qué importa` of every question. |
| Route (fixed) | `routeEnvelope` | The risk verdict and its reason. |
| Risk recovery (fixed) | `riskRecoveryEnvelope` | Why the assessment could not choose a route. |
| Change (fixed) | `changeRequest` | The proposed requirements and the advisory evidence. |
| Grill rounds and the coordinator's own questions | `mdd-grill`, `mdd-orchestrator` | Guidance only: context in the chat, a short question in the form. |

Mode, preflight fields, the preflight note and the phase approval were already short and are
unchanged.

## Changes

1. **Brief next to the envelope.** Each builder returns its short envelope and, when there is
   context, a Spanish Markdown brief. The brief is stored in the question record's slot
   (`slot.brief`), so a restored or re-presented question keeps it, and it is bound by the same
   record transitions as the envelope.
2. **Status.** The fixed and adaptive status publish `questionBrief` while the question is ready.
   The v3 projection ships it inline up to 12000 bytes and otherwise as `questionBriefRef`, a
   paged detail reference like `questionRef`. Both are protected status fields.
3. **Next action.** `nextAction.why` tells the coordinator to write the brief in the chat first,
   as it is, and then ask the exact envelope.
4. **Guidance.** `mdd-orchestrator`, `mdd-grill`, the entry guide, the `mdd_prepare_advance`
   descriptions and the adapter guide say: one direct question in the form, its context in `why` or
   in the chat, never in the form.
5. **Compatibility.** Product answers recomputed on restore accept the new short frame, the
   earlier Spanish frame with `Por qué importa` inside the question, and the English frame. Records
   written before this change have no brief and still carry their long question; they are asked
   exactly as they were issued.

## Not changed

- What a question authorizes: labels, answer tokens, nonces, generations and the exact-envelope
  check are unchanged.
- MDD does not verify that the coordinator wrote the brief. The user chose the instruction as the
  guarantee.
- The visible nonce tags (`[MDD adaptive …]`, `[MDD clarification …]`, `[MDD intake …]`) remain:
  they keep identical envelopes distinguishable.

## Verification

```powershell
npm run build
node --import ./tests/isolate-home.mjs --test tests/adaptive-native.test.mjs tests/adaptive-public.test.mjs tests/adaptive-protocol.test.mjs tests/adaptive-low.test.mjs tests/adaptive-store.test.mjs tests/adaptive-transfer.test.mjs tests/native-intake.test.mjs tests/full-native.test.mjs tests/question-checkpoint.test.mjs tests/session-preferences.test.mjs tests/next-action.test.mjs tests/status-budget.test.mjs tests/run-ownership.test.mjs tests/typed-answer.test.mjs tests/preflight.test.mjs tests/opencode-plugin.test.mjs tests/phase-assets.test.mjs
npm run typecheck
git diff --check
npm test
```

## Progress

- Baseline before changes: the 17 suites above passed 1171/1171.
- First run after the changes: 9 failures in 8 tests, every one asserting text that moved from the
  form to the brief. They now assert the brief and that the form stays short.
- New regressions cover:
  - the entry and select approvals: one-sentence form, Markdown brief, brief kept in the record;
  - a brief past its inline share, paged whole as `questionBriefRef`;
  - product questions without the why, and restore of the earlier Spanish and English frames;
  - the earlier-request quote, the route reason, the risk-recovery diagnostic, the change
    requirements and its advisory evidence, each in the brief;
  - `nextAction` writing the brief first, inline or by reference;
  - `slot.brief` validation, and an issued question unable to change its brief.
- After the fixes: the 17 suites passed 1174/1174. `npm run typecheck` exit 0. `git diff --check`
  exit 0.
- Full suite: `npm test` ran 2,815 tests. 2,811 passed, 1 failed and 3 were skipped, the same
  environmental skips as earlier runs. The failure was `pack.test.mjs`: `npm pack --dry-run` hit
  its 30-second timeout under the load of the full run (`ETIMEDOUT`). Run alone, that file passed
  2/2, with `dist/question-brief.js` in the package.
