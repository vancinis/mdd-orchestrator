import { boundedText } from './phase-runner.js';
import { acceptance, assertNoTraceSection, phaseFields } from './acceptance.js';
import { concerns } from './concerns.js';
import { changed, deliverables, executed } from './phase-evidence.js';
import { parsePhaseReport, reportFormatLines } from './phase-report.js';
import type { Phase } from './policy.js';

/**
 * Lets the actor that wrote a report find out whether MDD can read it, before it stops running.
 *
 * A report is validated in `tool.execute.after`, which is the one moment when the actor that
 * produced it no longer exists. So a rejected report went to the coordinator to be restated,
 * and the coordinator paid for it twice: the whole document arrived in its context to be read,
 * and the whole document left it again to be re-sent. On one observed run that loop was the
 * single most expensive thing in the conversation.
 *
 * The cheapest place to fix a report is the session that is still writing it, so this is offered
 * there. Of the rejections seen on that run, six of eight were questions of form alone — a
 * summary over its limit, an artifact over its limit, a field that must be plain text. None of
 * them needs the run, which is what makes this a pure function of the phase and the document and
 * lets it run in the actor's own session, where a rewrite costs nothing anyone else pays for.
 *
 * What it deliberately does not do is judge the work. It cannot say whether an artifact is any
 * good, and it cannot check the links between a plan and the requirements it answers, because
 * those live in state only the parent holds. `validatePlan` reports all of those together
 * instead, so the cross-link case is one correction rather than one per round trip.
 *
 * It is advisory in the strict sense: it records nothing, changes no run, spends no attempt, and
 * a clean result is not an acceptance. The real check still runs when the report arrives.
 */

/** Ordered, deduplicated problems. Same wording the real validation would use, so a fix transfers. */
function collect(checks: readonly (() => unknown)[]): string[] {
  const problems: string[] = [];
  for (const check of checks) {
    try { check(); }
    catch (error) {
      const message = error instanceof Error ? error.message : 'This part of the report could not be read.';
      if (!problems.includes(message)) problems.push(message);
    }
  }
  return problems;
}

export type ReportCheck = { ok: boolean; problems: string[]; resultFormat: string[]; note: string };

const CLEAN = 'No problem of form was found. This is not an acceptance: it says the document can be read, not that the work is right, and the links between a plan and the requirements it answers are checked against state only the run holds. Report it as you normally would.';
const FOUND = 'These are problems of form in the document, not in the work it describes. Fix them all and re-check before reporting; nothing has been recorded and no attempt has been spent.';

export function checkReportForm(phase: Phase, text: unknown): ReportCheck {
  const resultFormat = reportFormatLines(phase);
  const done = (problems: string[]): ReportCheck =>
    ({ ok: !problems.length, problems, resultFormat, note: problems.length ? FOUND : CLEAN });

  // The envelope first, and alone: nothing below can be read out of a document that has none, so
  // reporting those failures too would only bury the one that has to be fixed first.
  const envelope = collect([() => boundedText(text, 'phase report', 20000)]);
  if (envelope.length) return done(envelope);

  let fields: Record<string, unknown>;
  try { fields = phaseFields(phase, parsePhaseReport(text as string, phase)).fields; }
  catch (error) { return done([error instanceof Error ? error.message : 'The phase report could not be parsed.']); }

  const outcome = fields.outcome;
  const passed = outcome === 'passed';
  return done(collect([
    () => { if (outcome !== 'passed' && outcome !== 'failed') throw new Error('The phase report must state outcome passed or failed.'); },
    () => boundedText(fields.evidenceSummary, 'summary', 2000),
    () => assertNoTraceSection(boundedText(fields.artifact, 'artifact', 16000)),
    () => concerns(fields.concerns),
    // Phase-specific shape. Only what a document can answer on its own: `decisions` and
    // `verification` are left to the run, because both are checked against IDs it holds.
    ...(phase === 'mdd-spec' ? [() => boundedText(fields.domain, 'spec domain', 64)] : []),
    ...(passed && (phase === 'mdd-plan' || phase === 'mdd-spec') ? [() => acceptance(fields.acceptance)] : []),
    ...(passed && (phase === 'mdd-plan' || phase === 'mdd-tasks') ? [() => deliverables(fields.deliverables)] : []),
    ...(passed && phase === 'mdd-apply' ? [() => changed(fields.changes, fields.noChangeReason)] : []),
    ...(passed && (phase === 'mdd-apply' || phase === 'mdd-verify') ? [() => executed(fields.checks)] : []),
  ]));
}
