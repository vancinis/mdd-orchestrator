import { objectWithKeys } from './validation.js';
import { shortText } from './acceptance.js';

/** Snapshot builders assign location IDs; this module validates claims, not snapshot provenance. */
export const SECURITY_LAYERS = Object.freeze(['committed', 'index', 'worktree', 'untracked'] as const);
export type SecurityLayer = typeof SECURITY_LAYERS[number];
export type SecurityLocation = {
  locationID: string; layer: SecurityLayer; side: 'before' | 'after';
  path: string; startLine: number; endLine: number;
};
export type SecurityFinding = {
  id: string; severity: 'critical' | 'high' | 'medium' | 'low'; title: string;
  location: SecurityLocation; evidence: string; attackConditions: string;
  impact: string; recommendation: string;
};
export type SecurityCoverage = {
  layer: SecurityLayer; status: 'complete' | 'partial' | 'unavailable';
  inspected: string[]; limitations: string[];
};
export type SecurityAssessment = {
  snapshotID: string; status: 'findings' | 'no-findings' | 'inconclusive';
  coverage: SecurityCoverage[]; limitations: string[]; findings: SecurityFinding[];
};
export const SECURITY_REPORT_KEYS: readonly string[] = Object.freeze(
  ['outcome', 'evidenceSummary', 'how', 'artifact', 'concerns', 'security']);

function choice<T extends string>(value: unknown, label: string, options: readonly T[]): T {
  if (typeof value !== 'string' || !options.includes(value as T)) throw new Error(`${label} must be one of: ${options.join(', ')}.`);
  return value as T;
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`${label} must be a 1–128 character snapshot identifier (letters, digits, underscore, hyphen).`);
  return value;
}
function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} must be an array of at most ${max} entries.`);
  return value;
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not repeat identifiers.`);
}
function limitations(value: unknown, label: string): string[] {
  return list(value, label, 16).map(item => shortText(item, label, 1000));
}
function lineNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('security location lines must be positive safe integers.');
  return value;
}
function coverageItem(value: unknown): SecurityCoverage {
  const input = objectWithKeys(value, 'security coverage', ['layer', 'status', 'inspected', 'limitations']);
  const layer = choice(input.layer, 'security coverage.layer', SECURITY_LAYERS);
  const status = choice(input.status, 'security coverage.status', ['complete', 'partial', 'unavailable'] as const);
  const inspected = list(input.inspected, 'security coverage.inspected', 256).map(item => identifier(item, 'inspected locationID'));
  unique(inspected, 'security coverage.inspected');
  const limits = limitations(input.limitations, 'security coverage.limitations');
  if (status !== 'complete' && !limits.length) throw new Error('Partial or unavailable security coverage requires limitations.');
  if (status === 'unavailable' && inspected.length) throw new Error('Unavailable security coverage cannot claim inspected locations.');
  return { layer, status, inspected, limitations: limits };
}
function location(value: unknown): SecurityLocation {
  const input = objectWithKeys(value, 'security location', ['locationID', 'layer', 'side', 'path', 'startLine', 'endLine']);
  const locationID = identifier(input.locationID, 'security locationID');
  const layer = choice(input.layer, 'security location.layer', SECURITY_LAYERS);
  const side = choice(input.side, 'security location.side', ['before', 'after'] as const);
  if (layer === 'untracked' && side !== 'after') throw new Error('Untracked security locations only have an after side.');
  const path = shortText(input.path, 'security location.path', 1000);
  if (/^[\\/]|[:\\]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('security location.path must be a repository-relative forward-slash path without traversal.');
  }
  const startLine = lineNumber(input.startLine);
  const endLine = lineNumber(input.endLine);
  if (endLine < startLine) throw new Error('security location endLine must not precede startLine.');
  return { locationID, layer, side, path, startLine, endLine };
}
function finding(value: unknown): SecurityFinding {
  const input = objectWithKeys(value, 'security finding',
    ['id', 'severity', 'title', 'location', 'evidence', 'attackConditions', 'impact', 'recommendation']);
  return {
    id: identifier(input.id, 'security finding.id'),
    severity: choice(input.severity, 'security finding.severity', ['critical', 'high', 'medium', 'low'] as const),
    title: shortText(input.title, 'security finding.title', 300), location: location(input.location),
    evidence: shortText(input.evidence, 'security finding.evidence', 2000),
    attackConditions: shortText(input.attackConditions, 'security finding.attackConditions', 2000),
    impact: shortText(input.impact, 'security finding.impact', 2000),
    recommendation: shortText(input.recommendation, 'security finding.recommendation', 2000),
  };
}

/** Pure form validation. SEC-3 must bind every claim to the runtime's immutable snapshot. */
export function parseSecurityAssessment(value: unknown): SecurityAssessment {
  const input = objectWithKeys(value, 'security', ['snapshotID', 'status', 'coverage', 'limitations', 'findings']);
  const snapshotID = identifier(input.snapshotID, 'security.snapshotID');
  const status = choice(input.status, 'security.status', ['findings', 'no-findings', 'inconclusive'] as const);
  const coverage = list(input.coverage, 'security.coverage', 4).map(coverageItem);
  unique(coverage.map(item => item.layer), 'security.coverage layers');
  if (coverage.length !== SECURITY_LAYERS.length) throw new Error('security.coverage requires all four layers, even when a layer has no changes.');
  unique(coverage.flatMap(item => item.inspected), 'security.coverage locationIDs');
  const limits = limitations(input.limitations, 'security.limitations');
  const incomplete = limits.length > 0 || coverage.some(item => item.status !== 'complete' || item.limitations.length > 0);
  if (incomplete !== (status === 'inconclusive')) throw new Error('Partial coverage or limitations require security.status inconclusive; inconclusive requires an explicit limitation.');
  const findings = list(input.findings, 'security.findings', 32).map(finding);
  unique(findings.map(item => item.id), 'security finding IDs');
  if (status === 'findings' && !findings.length) throw new Error('security.status findings requires at least one finding.');
  if (status === 'no-findings' && findings.length) throw new Error('security.status no-findings requires an empty findings list.');
  for (const item of findings) {
    if (!coverage.find(entry => entry.layer === item.location.layer)?.inspected.includes(item.location.locationID)) {
      throw new Error('Every security finding must cite an inspected locationID in its reported layer.');
    }
  }
  return { snapshotID, status, coverage, limitations: limits, findings };
}

export const SECURITY_FIELD_SCHEMA = [
  'security={snapshotID,status,coverage:[{layer,status,inspected:[locationID],limitations:[text]}],limitations:[text],findings:[{id,severity,title,location:{locationID,layer,side,path,startLine,endLine},evidence,attackConditions,impact,recommendation}]}. No extra keys.',
  'snapshotID, locationID and finding id: 1–128 letters/digits/underscores/hyphens. Copy snapshot and location IDs from runtime input; never invent them. Coverage has exactly one entry for each committed/index/worktree/untracked layer; status complete/partial/unavailable; at most 256 globally unique inspected locationIDs per layer, no inspected IDs when unavailable.',
  'Copy runtime coverage and omissions, then disclose any additional inspection gaps. Each partial/unavailable layer needs a limitation. Layer and overall limitations: at most 16 nonempty single-line entries each, at most 1000 characters each.',
  'Assessment status: findings (complete with 1–32 findings), no-findings (complete with no findings), inconclusive (any partial coverage or limitation, with 0–32 known findings preserved). Inconclusive requires an explicit limitation; never hide findings because coverage is incomplete.',
  'Finding severity critical/high/medium/low; title at most 300 characters; evidence, attackConditions, impact and recommendation each nonempty single-line text of at most 2000 characters. IDs unique. Ground evidence in supplied source without exposing secrets.',
  'Location side before/after (untracked only after); path repository-relative using forward slashes, at most 1000 characters, no traversal; lines inclusive positive safe integers with endLine >= startLine. locationID must appear under inspected in the same layer. Distinct revisions/sides use distinct runtime locationIDs; final binding validates path, side, lines and evidence.',
].join(' ');

export function securityReportFormatLines(): string[] {
  return [
    'Report this standalone audit in English as Markdown using these exact headings, each once. Total report at most 20000 bytes.',
    '"## MDD Outcome" holding passed for a complete assessment (including findings), failed for inconclusive. This is inspection completion, never code safety or delivery approval.',
    '"## MDD Summary" holding 1–2000 bytes: result and important coverage limitations. A no-findings result is not a claim that code is secure.',
    '"## MDD How" holding 1–2000 bytes: concrete source-grounded inspection method and limits.',
    '"## MDD Artifact" holding 1–16000 bytes: detailed findings, attack conditions, impact, recommended remediation and limitations for the orchestrator. Do not reuse MDD headings inside it.',
    `"## MDD Data" holding one fenced JSON block with exactly the standalone field security. ${SECURITY_FIELD_SCHEMA}`,
    'Never fix source, authorize mdd-apply, advance phases or approve delivery. This form check does not authenticate scope or evidence; final runtime snapshot binding is still required.',
  ];
}
