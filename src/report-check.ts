import { boundedText, nonemptyText } from './phase-runner.js';
import { acceptance, assertNoTraceSection, closure, decisions, linkDecisions, mergeRecheck, OPEN_CLOSURE_PASS, phaseFields, UNMATCHED_PASS, unmet, UNMET_PASS,
  validatePlan, verificationFindings } from './acceptance.js';
import type { Acceptance, Decision, Verification } from './acceptance.js';
import type { Deliverable, VerificationVersion } from './phase-evidence.js';
import { concerns } from './concerns.js';
import { openQuestions } from './open-questions.js';
import { changed, deliverables, executed, verificationVersion, verifyReport } from './phase-evidence.js';
import { narrativeOf, parsePhaseReport, parseRiskReport, parseSecurityReport, reportFormatLines } from './phase-report.js';
import { parseRiskVerdict, riskReportFormatLines, RISK_REPORT_KEYS } from './risk.js';
import type { RiskVerdict } from './risk.js';
import type { Phase } from './policy.js';
import { parseSecurityAssessment, securityReportFormatLines, SECURITY_REPORT_KEYS } from './security.js';
import type { SecurityAssessment } from './security.js';
import { taskIDs } from './apply-batches.js';

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

export type ReportCheck = { ok: boolean; problems: string[]; resultFormat: string[]; note: string; risk?: RiskVerdict };

/**
 * What the run holds for the phase a report answers, when the check is asked from a session MDD
 * dispatched for that phase (or by the coordinator carrying it out). With it the links are checked
 * too, with the run's own validators: a Verify that invented a link or omitted a held scenario used
 * to be cleared here and refused on arrival, and those refusals were the largest share of
 * malformed reports on record. Without it, the check stays about form alone.
 */
export type HeldReportContext = {
  accepted?: Acceptance; choices: Decision[]; planned: Deliverable[]; verificationVersion?: VerificationVersion;
  /** A Verify after a correction pass: the findings it rechecks and the verification it completes. */
  recheck?: { findings: string[]; previous: Verification };
  /** An Apply correction pass: the Verify findings it has to close. */
  findings?: string[];
};

const CLEAN = 'No problem of form was found. This is not an acceptance: it says the document can be read, not that the work is right, and the links between a plan and the requirements it answers are checked against state only the run holds. Report it as you normally would.';
const CLEAN_HELD = 'No problem was found, including the links against the requirements, decisions and plan this run holds. This is not an acceptance: it says the document can be read and its links exist, not that the work is right. Report it as you normally would.';
const FOUND = 'These are problems of form in the document, not in the work it describes. Fix them all and re-check before reporting; nothing has been recorded and no attempt has been spent.';
const FOUND_HELD = 'These are problems in the document or in its links to what this run holds, not in the work it describes. Fix them all and re-check before reporting; nothing has been recorded and no attempt has been spent.';

/** The run's own link checks for one phase, in the run's own words. */
function heldChecks(phase: Phase, fields: Record<string, unknown>, held: HeldReportContext): (() => unknown)[] {
  const passed = fields.outcome === 'passed', version = held.verificationVersion;
  const requireAccepted = (label: string) => { if (!held.accepted) throw new Error(`${label} has no held requirement map.`); return held.accepted; };
  return [
    () => { if (fields.verificationVersion !== undefined && verificationVersion(fields.verificationVersion) !== version)
      throw new Error('Report verification version contradicts the frozen run contract.'); },
    ...(phase === 'mdd-spec' ? [() => { if (fields.domain !== 'project') throw new Error('Specification domain must match the dispatched project storage namespace.'); }] : []),
    ...(passed && phase === 'mdd-plan' ? [() => {
      const accepted = acceptance(fields.acceptance), choices = decisions(fields.decisions, accepted);
      validatePlan(accepted, choices, linkDecisions(accepted, choices, deliverables(fields.deliverables, version)).steps);
    }] : []),
    ...(passed && phase === 'mdd-design' ? [() => decisions(fields.decisions, requireAccepted('Design'))] : []),
    ...(passed && phase === 'mdd-tasks' ? [() => {
      const accepted = requireAccepted('Planning');
      validatePlan(accepted, held.choices, linkDecisions(accepted, held.choices, deliverables(fields.deliverables, version)).steps);
    }] : []),
    ...(['mdd-design', 'mdd-tasks'].includes(phase) && held.accepted ? [() => unmet(fields.unmet, held.accepted)] : []),
    ...(phase === 'mdd-verify' ? [() => {
      const accepted = requireAccepted('Verification');
      const read = verifyReport(fields.checks, fields.verification, { accepted, choices: held.choices, planned: held.planned, verificationVersion: version,
        ...(held.recheck ? { recheck: { findings: held.recheck.findings } } : {}) });
      const checked = held.recheck ? mergeRecheck(held.recheck.previous, read.verification!, read.ran, !!version, held.recheck.findings) : read.verification!;
      if (passed && !checked.matched) throw new Error(held.recheck && read.verification!.matched
        ? `An earlier verified row relied on a check that did not pass in this recheck: ${verificationFindings(checked).join(', ')}. Report outcome failed, or run that check again.`
        : UNMATCHED_PASS);
    }] : []),
    ...(phase === 'mdd-apply' && held.findings?.length && (passed || fields.closure !== undefined) ? [() => {
      if (passed && fields.closure === undefined) throw new Error(`A correction pass must report closure for every Verify finding: ${held.findings!.join(', ')}.`);
      if (closure(fields.closure, held.findings).some(entry => entry.status === 'open') && passed) throw new Error(OPEN_CLOSURE_PASS);
    }] : []),
  ];
}

export function checkReportForm(phase: Phase, text: unknown, held?: HeldReportContext): ReportCheck {
  let resultFormat = reportFormatLines(phase);
  const done = (problems: string[]): ReportCheck =>
    ({ ok: !problems.length, problems, resultFormat, note: problems.length ? held ? FOUND_HELD : FOUND : held ? CLEAN_HELD : CLEAN });

  // The envelope first, and alone: nothing below can be read out of a document that has none, so
  // reporting those failures too would only bury the one that has to be fixed first.
  const envelope = collect([() => nonemptyText(text, 'phase report')]);
  if (envelope.length) return done(envelope);

  let fields: Record<string, unknown>;
  try { fields = phaseFields(phase, parsePhaseReport(text as string, phase)).fields; }
  catch (error) { return done([error instanceof Error ? error.message : 'The phase report could not be parsed.']); }

  let version;
  try {
    version = verificationVersion(fields.verificationVersion);
    // A held run reads the report under its own frozen contract, so the form it shows is that one.
    resultFormat = reportFormatLines(phase, held ? held.verificationVersion : version, phase === 'mdd-apply' && !!held?.findings?.length);
  }
  catch (error) { return done([String(error)]); }
  if (held) version = held.verificationVersion;

  const outcome = fields.outcome;
  const passed = outcome === 'passed';
  return done(collect([
    () => { if (outcome !== 'passed' && outcome !== 'failed') throw new Error('The phase report must state outcome passed or failed.'); },
    () => nonemptyText(fields.evidenceSummary, 'summary'),
    () => narrativeOf(fields),
    () => assertNoTraceSection(nonemptyText(fields.artifact, 'artifact')),
    () => concerns(fields.concerns),
    () => openQuestions(fields.questions),
    // Phase-specific shape. Only what a document can answer on its own: `decisions`, and the
    // links in `verification`, are left to the run, because both are checked against IDs it holds.
    ...(phase === 'mdd-spec' ? [() => boundedText(fields.domain, 'spec domain', 64)] : []),
    ...(passed && (phase === 'mdd-plan' || phase === 'mdd-spec') ? [() => acceptance(fields.acceptance)] : []),
    ...(passed && (phase === 'mdd-plan' || phase === 'mdd-tasks') ? [() => deliverables(fields.deliverables, version)] : []),
    ...(passed && phase === 'mdd-apply' ? [() => changed(fields.changes, fields.noChangeReason), () => {
      // One assigned task, or every remaining one in a correction pass: which applies is the run's to judge.
      if (!taskIDs(fields.completed).length) throw new Error('Successful Apply must name its completed task.');
    }, () => executed(fields.checks, version)] : []),
    ...(['mdd-plan', 'mdd-design', 'mdd-tasks'].includes(phase) ? [() => {
      if (unmet(fields.unmet).length && passed) throw new Error(UNMET_PASS);
    }] : []),
    ...(phase === 'mdd-apply' && fields.closure !== undefined ? [() => {
      if (closure(fields.closure).some(entry => entry.status === 'open') && passed) throw new Error(OPEN_CLOSURE_PASS);
    }] : []),
    // Verify's checks and verification are read on every outcome, exactly as the run reads them. A
    // check that skipped them on a failed Verify once cleared a report the run then refused, so
    // the actor was told it was fine at the one moment it could still have fixed it. Which links
    // exist is the run's to judge; everything the document says about itself is checked here.
    ...(phase === 'mdd-verify' && !held ? [() => {
      const { verification } = verifyReport(fields.checks, fields.verification, undefined, version);
      if (passed && verification && !verification.matched) throw new Error(UNMATCHED_PASS);
    }] : []),
    ...(held ? heldChecks(phase, fields, held) : []),
  ]));
}

/**
 * Checks the risk actor's report. Kept apart from `checkReportForm` rather than widening it with
 * a `Phase | 'mdd-risk'` parameter, because `mdd-risk` carries one structured field — the grounded
 * route/complexity verdict — not a phase's `PHASE_RESULT_FIELDS` shape, and accepting it here is
 * only a form check: it never approves a route or records anything.
 *
 * Unlike `checkReportForm`, this is the only validator a risk report passes through in this
 * increment — later runs add routing, but nothing downstream re-checks the report's shape — so
 * it is deliberately stricter than the phase checker in three ways: the explanation under
 * "## MDD How" is required rather than optional, the data block may hold no key beyond `risk`,
 * and, when the report passes, the parsed `RiskVerdict` is returned alongside the check so a
 * caller never has to re-parse a document that was just validated.
 */
export function checkRiskReportForm(text: unknown): ReportCheck {
  const resultFormat = riskReportFormatLines();
  const done = (problems: string[], risk?: RiskVerdict): ReportCheck =>
    ({ ok: !problems.length, problems, resultFormat, note: problems.length ? FOUND : CLEAN, ...(risk ? { risk } : {}) });

  const envelope = collect([() => nonemptyText(text, 'risk report')]);
  if (envelope.length) return done(envelope);

  let fields: Record<string, unknown>;
  try { fields = parseRiskReport(text as string); }
  catch (error) { return done([error instanceof Error ? error.message : 'The risk report could not be parsed.']); }

  const extraKeys = Object.keys(fields).filter(key => !RISK_REPORT_KEYS.includes(key));
  const outcome = fields.outcome;
  const passed = outcome === 'passed';
  let verdict: RiskVerdict | undefined;
  const problems = collect([
    () => { if (outcome !== 'passed' && outcome !== 'failed') throw new Error('The risk report must state outcome passed or failed.'); },
    () => nonemptyText(fields.evidenceSummary, 'summary'),
    // Required on every report, passed or failed: the actor's own format instructions list
    // "## MDD How" unconditionally, and a failure that gives no reason is as unreadable as one
    // that is missing the required explanation of a passing assessment.
    () => nonemptyText(fields.how, 'how'),
    () => assertNoTraceSection(nonemptyText(fields.artifact, 'artifact')),
    () => concerns(fields.concerns),
    () => { if (extraKeys.length) throw new Error(`risk report data holds unknown key(s): ${extraKeys.join(', ')}. Only "risk" is accepted.`); },
    // A failed outcome is uncertainty reported honestly; it is not required to carry a verdict
    // it could not substantiate. A passed outcome must carry one that is internally consistent.
    ...(passed ? [() => { verdict = parseRiskVerdict(fields.risk); }] : []),
  ]);
  return done(problems, passed ? verdict : undefined);
}

export type SecurityReportCheck = Omit<ReportCheck, 'risk'> & { security?: SecurityAssessment };

/** Advisory only; no dispatch, evidence authentication, state mutation or delivery authority. */
export function checkSecurityReportForm(text: unknown): SecurityReportCheck {
  const resultFormat = securityReportFormatLines();
  const done = (problems: string[], security?: SecurityAssessment): SecurityReportCheck => ({
    ok: !problems.length, problems, resultFormat,
    note: problems.length ? FOUND : 'Security form-only check passed. Runtime snapshot and evidence binding remain required; this is not acceptance, a security guarantee, authorization to fix, or delivery approval.',
    ...(!problems.length && security ? { security } : {}),
  });
  const envelope = collect([() => nonemptyText(text, 'security report')]);
  if (envelope.length) return done(envelope);
  let fields: Record<string, unknown>;
  try { fields = parseSecurityReport(text as string); }
  catch (error) { return done([error instanceof Error ? error.message : 'The security report could not be parsed.']); }
  let security: SecurityAssessment | undefined;
  const problems = collect([
    () => { const extra = Object.keys(fields).filter(key => !SECURITY_REPORT_KEYS.includes(key));
      if (extra.length) throw new Error(`security report holds unknown key(s): ${extra.join(', ')}. Only the standalone security field is accepted as data.`); },
    () => nonemptyText(fields.evidenceSummary, 'summary'),
    () => nonemptyText(fields.how, 'how'),
    () => assertNoTraceSection(nonemptyText(fields.artifact, 'artifact')),
    () => concerns(fields.concerns),
    () => {
      security = parseSecurityAssessment(fields.security);
      const expected = security.status === 'inconclusive' ? 'failed' : 'passed';
      if (fields.outcome !== expected) throw new Error(`security report outcome must be ${expected} for status ${security.status}; outcome describes inspection, not code safety.`);
    },
  ]);
  return done(problems, security);
}
