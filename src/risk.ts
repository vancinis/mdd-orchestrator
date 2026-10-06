import { objectWithKeys } from './validation.js';
import { shortText } from './acceptance.js';

/**
 * The risk actor's one authoritative structured field. It is deliberately not shaped into
 * `PHASE_RESULT_FIELDS`: `mdd-risk` assesses complexity and risk, it does not occupy a stop on
 * the route, and nothing here is a routing decision — a later run owns using `route` to pick
 * low or high. This is only the grounded verdict and its evidence.
 */
export type RiskEvidence = { source: string; finding: string };
export type RiskItem = { description: string; evidence: string; mitigation: string };
export type RiskVerdict = {
  route: 'low' | 'high';
  complexity: 'low' | 'high';
  reason: string;
  evidence: RiskEvidence[];
  risks: RiskItem[];
  risksJustification?: string;
};

/**
 * The envelope keys a risk report may legitimately carry: the shared envelope fields every report
 * has, plus the one structured field `mdd-risk` reports. Anything else is rejected rather than
 * silently dropped — unlike a phase's `phaseFields`, which tolerates an unrecognized key because
 * discarding it would discard genuine phase work, this is the only validator a risk report passes
 * through in this increment, so a stray key here would otherwise reach nobody.
 */
export const RISK_REPORT_KEYS: readonly string[] = Object.freeze(
  ['phase', 'runID', 'callID', 'outcome', 'evidenceSummary', 'how', 'artifact', 'concerns', 'risk']);

function evidenceItem(value: unknown, index: number): RiskEvidence {
  const input = objectWithKeys(value, `risk evidence[${index}]`, ['source', 'finding']);
  return {
    source: shortText(input.source, `risk evidence[${index}] source`, 300),
    finding: shortText(input.finding, `risk evidence[${index}] finding`, 500),
  };
}

function riskItem(value: unknown, index: number): RiskItem {
  const input = objectWithKeys(value, `risk[${index}]`, ['description', 'evidence', 'mitigation']);
  return {
    description: shortText(input.description, `risk[${index}] description`, 500),
    evidence: shortText(input.evidence, `risk[${index}] evidence`, 500),
    mitigation: shortText(input.mitigation, `risk[${index}] mitigation`, 500),
  };
}

/**
 * Validates the one structured verdict a risk report carries. `route` and `complexity` must
 * agree: nothing here reconciles a route that disagrees with the complexity it was explained by,
 * because that disagreement is exactly the contradiction R3/S6 asks to be rejected, not resolved.
 * An empty `risks` list is accepted at either route — a low-risk finding, or a high one that
 * explains why no concrete risk was evidenced — but only when `risksJustification` states that
 * explicitly; an empty list with no justification is rejected rather than accepted as if nothing
 * needed explaining. Every risk that is reported must carry its own evidence and mitigation; a
 * risk without a mitigation is rejected rather than accepted silently.
 */
export function parseRiskVerdict(value: unknown): RiskVerdict {
  const input = objectWithKeys(value, 'risk', ['route', 'complexity', 'reason', 'evidence', 'risks', 'risksJustification']);
  if (input.route !== 'low' && input.route !== 'high') throw new Error('risk.route must be exactly "low" or "high".');
  if (input.complexity !== 'low' && input.complexity !== 'high') throw new Error('risk.complexity must be exactly "low" or "high".');
  if (input.route !== input.complexity) throw new Error(`risk.route (${input.route}) and risk.complexity (${input.complexity}) must agree; they describe the same assessment.`);
  const reason = shortText(input.reason, 'risk.reason', 2000);
  if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 32) throw new Error('risk.evidence requires 1–32 attributable {source,finding} entries.');
  const evidence = input.evidence.map((item, index) => evidenceItem(item, index));
  if (!Array.isArray(input.risks) || input.risks.length > 32) throw new Error('risk.risks must be an array of at most 32 entries; an empty list is accepted only when risksJustification explicitly states why no concrete risk was evidenced.');
  const risks = input.risks.map((item, index) => riskItem(item, index));
  if (risks.length === 0) {
    const risksJustification = shortText(input.risksJustification, 'risk.risksJustification', 1000);
    return { route: input.route, complexity: input.complexity, reason, evidence, risks, risksJustification };
  }
  if (input.risksJustification !== undefined) throw new Error('risk.risksJustification is only accepted when risks is empty; a reported risk already carries its own evidence.');
  return { route: input.route, complexity: input.complexity, reason, evidence, risks };
}

export const RISK_FIELD_SCHEMA = 'risk={route,complexity,reason,evidence:[{source,finding}],risks:[{description,evidence,mitigation}],risksJustification?}. route and complexity must be exactly "low" or "high" and must agree. evidence needs at least one attributable {source,finding}. risks may be empty only when risksJustification explicitly states why no concrete risk was evidenced; every reported risk needs its own evidence and mitigation, and risksJustification is rejected when risks is nonempty.';

/** The instructions the risk actor is given, mirroring a phase's report-format instructions. */
export function riskReportFormatLines(): string[] {
  return [
    'Report this assessment as a short markdown document, not as a JSON object. Use these exact headings, each once:',
    '"## MDD Outcome" holding exactly passed or failed. Use failed when the request and exploration findings cannot substantiate a grounded route; do not invent evidence or risk to avoid it.',
    '"## MDD Summary" holding 1–2000 bytes of plain prose a person reads first: the complexity judgment and the recommended route, in one short paragraph.',
    '"## MDD How" holding a distinct, source-grounded explanation of why this route follows from the request and the exploration findings. If the cause is uncertain, state that explicitly.',
    '"## MDD Artifact" holding 1–16000 bytes of the actual assessment in ordinary markdown: concrete risks, precautions and mitigations where evidenced, or an explicit statement that none was evidenced. Headings inside it must not reuse an "MDD ..." name.',
    `"## MDD Data" holding ONE fenced json block with exactly this key: risk. ${RISK_FIELD_SCHEMA}`,
    'Optional "## MDD Concerns" holding a fenced json array of at most eight {category,evidence,impact} entries, category objective/integrations/sensitive-data/permissions.',
    'Write nothing outside these headings. Prose around them is ignored, but anything you need MDD to record belongs under a heading.',
  ];
}
