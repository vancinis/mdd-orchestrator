// Pure release-version rules: no I/O. scripts/release.mjs duplicates the grammar and order on purpose
// (a repository script cannot import dist/); tests/versions.test.mjs keeps both in sync.

export const BASELINE = Object.freeze({ version: '0.2.0', commit: '34a93f67ba405aa50850839c7cc3405374e61544' });

/** Release grammar: X.Y.Z or X.Y.Z-preview.N, no leading zeros. Identical to scripts/release.mjs. */
export const RELEASE_GRAMMAR = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.(0|[1-9]\d*))?$/;

export const CHANGELOG_SECTION_MAX = 16 * 1024;

export type Channel = 'stable' | 'preview';

export interface ReleaseVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** `null` for a stable release. */
  readonly preview: number | null;
  /** Version text without the leading `v`. */
  readonly text: string;
}

/** Parses `X.Y.Z[-preview.N]` or the tag form `vX.Y.Z[-preview.N]`; anything else is `undefined`. */
export function parseReleaseTag(text: string): ReleaseVersion | undefined {
  const bare = String(text).replace(/^v/, '');
  const match = RELEASE_GRAMMAR.exec(bare);
  if (!match) return undefined;
  const [, major, minor, patch, preview] = match;
  return {
    major: Number(major), minor: Number(minor), patch: Number(patch),
    preview: preview === undefined ? null : Number(preview), text: bare,
  };
}

/** Numeric SemVer order: a stable release sorts after the previews of its base; `.10` after `.9`. */
export function compareVersions(a: ReleaseVersion, b: ReleaseVersion): number {
  // Exact: identifiers are compared as decimal strings (length, then lexically), never as Numbers,
  // because the grammar allows values above Number.MAX_SAFE_INTEGER.
  const x = identifiers(a);
  const y = identifiers(b);
  for (let index = 0; index < 3; index += 1) {
    const order = compareDecimal(x[index] as string, y[index] as string);
    if (order !== 0) return order;
  }
  if (x[3] === undefined && y[3] === undefined) return 0;
  if (x[3] === undefined) return 1;
  if (y[3] === undefined) return -1;
  return compareDecimal(x[3], y[3]);
}

function identifiers(version: ReleaseVersion): (string | undefined)[] {
  const match = RELEASE_GRAMMAR.exec(String(version.text).replace(/^v/, ''));
  if (!match) throw new TypeError('compareVersions requires parsed release versions');
  return match.slice(1);
}

const compareDecimal = (x: string, y: string): number => (x.length !== y.length ? (x.length < y.length ? -1 : 1) : x === y ? 0 : x < y ? -1 : 1);

export const channelOf = (version: ReleaseVersion): Channel => version.preview === null ? 'stable' : 'preview';

/** Eligible means valid grammar and at or after the 0.2.0 baseline. */
export function isEligible(version: ReleaseVersion | undefined): version is ReleaseVersion {
  const baseline = parseReleaseTag(BASELINE.version);
  return version !== undefined && baseline !== undefined && compareVersions(version, baseline) >= 0;
}

/** Highest eligible version of a channel by SemVer (input order is irrelevant); `undefined` when empty, never another channel. */
export function resolveChannel(versions: readonly (string | ReleaseVersion)[], channel: Channel): ReleaseVersion | undefined {
  let best: ReleaseVersion | undefined;
  for (const item of versions) {
    const version = typeof item === 'string' ? parseReleaseTag(item) : item;
    if (!isEligible(version) || channelOf(version) !== channel) continue;
    if (!best || compareVersions(version, best) > 0) best = version;
  }
  return best;
}

type Triple = readonly [number, number, number];

const compareTriple = (a: Triple, b: Triple): number => {
  for (let index = 0; index < 3; index += 1) {
    const x = a[index] as number;
    const y = b[index] as number;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};

interface PartialVersion { readonly parts: readonly number[] }

function parsePartial(text: string): PartialVersion | undefined {
  const match = /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:\.(0|[1-9]\d*))?$/.exec(text);
  if (!match) return undefined;
  const parts = [match[1], match[2], match[3]].filter((part): part is string => part !== undefined).map(Number);
  return { parts };
}

const padded = (PartialVersion: PartialVersion): Triple => [PartialVersion.parts[0] ?? 0, PartialVersion.parts[1] ?? 0, PartialVersion.parts[2] ?? 0];

/** The first version above every version matching the PartialVersion (`24` → 25.0.0, `24.1` → 24.2.0). */
function upperBound(PartialVersion: PartialVersion): Triple {
  const [a, b, c] = padded(PartialVersion);
  if (PartialVersion.parts.length === 1) return [a + 1, 0, 0];
  if (PartialVersion.parts.length === 2) return [a, b + 1, 0];
  return [a, b, c + 1];
}

function comparatorHolds(operator: string, PartialVersion: PartialVersion, node: Triple): boolean {
  const low = padded(PartialVersion);
  const high = upperBound(PartialVersion);
  switch (operator) {
    case '>=': return compareTriple(node, low) >= 0;
    case '>': return compareTriple(node, high) >= 0;
    case '<': return compareTriple(node, low) < 0;
    case '<=': return compareTriple(node, high) < 0;
    default: return compareTriple(node, low) >= 0 && compareTriple(node, high) < 0;
  }
}

/**
 * Checks a Node `engines` range (`||`, `>=`, `>`, `<=`, `<`, `=`, PartialVersion versions) against a Node version.
 * Anything unparseable, including an unparseable Node version, yields `undefined` (the caller warns).
 */
export function satisfiesEngines(range: string, node: string): boolean | undefined {
  const nodeParts = parsePartial(node.trim());
  if (!nodeParts || nodeParts.parts.length !== 3) return undefined;
  const version = padded(nodeParts);
  const alternatives = String(range).split('||');
  let satisfied = false;
  for (const alternative of alternatives) {
    const tokens = alternative.replace(/(>=|<=|>|<|=)\s+/g, '$1').trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return undefined;
    let holds = true;
    for (const token of tokens) {
      const match = /^(>=|<=|>|<|=)?(.+)$/.exec(token);
      const PartialVersion = match?.[2] === undefined ? undefined : parsePartial(match[2]);
      if (!match || !PartialVersion) return undefined;
      if (!comparatorHolds(match[1] ?? '=', PartialVersion, version)) holds = false;
    }
    if (holds) satisfied = true;
  }
  return satisfied;
}

/**
 * The CHANGELOG section `## [<version>] …` up to the next `## [` heading, with LF line endings, trimmed and capped
 * at 16 KiB (a cut section ends with a truncation note). `undefined` when the version is invalid or has no section.
 */
export function changelogSection(text: string, version: string): string | undefined {
  const parsed = parseReleaseTag(version);
  if (!parsed) return undefined;
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith(`## [${parsed.text}]`));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if ((lines[index] as string).startsWith('## [')) { end = index; break; }
  }
  const section = lines.slice(start, end).join('\n').trim();
  if (section.length <= CHANGELOG_SECTION_MAX) return section;
  return `${section.slice(0, CHANGELOG_SECTION_MAX).trimEnd()}\n\n[… notas truncadas a 16 KiB]`;
}
