import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as script from '../scripts/release.mjs';
import {
  BASELINE, CHANGELOG_SECTION_MAX, RELEASE_GRAMMAR, changelogSection, channelOf, compareVersions, isEligible,
  parseReleaseTag, resolveChannel, satisfiesEngines,
} from '../dist/versions.js';

const sorted = list => list.map(parseReleaseTag).sort(compareVersions).map(v => v.text);
const permutations = list => list.length <= 1 ? [list] : list.flatMap((item, i) => permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(rest => [item, ...rest]));

const VALID = ['0.2.0', 'v0.2.0', '0.3.0-preview.1', 'v1.0.0', '10.20.30', '0.2.1-preview.0', '1.0.0-preview.10', '0.0.0', '0.1.9'];
const INVALID = ['', 'main', 'HEAD', '0.3', '1.0.0-rc.1', '01.0.0', '1.0.0-preview.01', '1.0.0-preview', '1.0.0-preview.', 'vv1.0.0',
  '1.0.0+build', '1.0.0-preview.1.2', ' 1.0.0', '1.0.0\n', '1.0', 'v', '-1.0.0', '1.0.0-Preview.1', 'refs/tags/v1.0.0', '1.0.0-preview.-1'];

test('BASELINE is the fixed historical commit and is frozen', () => {
  assert.deepEqual({ ...BASELINE }, { version: '0.2.0', commit: '34a93f67ba405aa50850839c7cc3405374e61544' });
  assert.ok(Object.isFrozen(BASELINE));
});

test('parseReleaseTag accepts only X.Y.Z and X.Y.Z-preview.N, with an optional v', () => {
  for (const text of VALID) assert.ok(parseReleaseTag(text), text);
  for (const text of INVALID) assert.equal(parseReleaseTag(text), undefined, JSON.stringify(text));
  assert.deepEqual(parseReleaseTag('v1.2.3-preview.4'), { major: 1, minor: 2, patch: 3, preview: 4, text: '1.2.3-preview.4' });
  assert.equal(parseReleaseTag('1.2.3').preview, null);
});

test('ordering is numeric and independent of input order (preview.10 after preview.9)', () => {
  const expected = ['0.2.0', '0.3.0-preview.1', '0.3.0-preview.2', '0.3.0-preview.9', '0.3.0-preview.10', '0.3.0', '0.3.1-preview.0', '0.10.0', '1.0.0'];
  for (const order of permutations(['0.3.0-preview.10', '0.3.0', '0.3.0-preview.9', '0.2.0', '0.3.0-preview.2'])) {
    assert.deepEqual(sorted(order), ['0.2.0', '0.3.0-preview.2', '0.3.0-preview.9', '0.3.0-preview.10', '0.3.0']);
  }
  assert.deepEqual(sorted([...expected].reverse()), expected);
  assert.equal(compareVersions(parseReleaseTag('0.9.0'), parseReleaseTag('0.10.0')), -1);
  assert.equal(compareVersions(parseReleaseTag('1.0.0'), parseReleaseTag('v1.0.0')), 0);
  assert.equal(compareVersions(parseReleaseTag('1.0.0'), parseReleaseTag('1.0.0-preview.99')), 1);
});

test('ordering is exact above Number.MAX_SAFE_INTEGER and resolution ignores enumeration order (P3)', () => {
  const low = '0.3.0-preview.9007199254740992';
  const high = '0.3.0-preview.9007199254740993';
  const huge = '0.3.0-preview.123456789012345678901234567890';
  assert.equal(compareVersions(parseReleaseTag(low), parseReleaseTag(high)), -1);
  assert.equal(compareVersions(parseReleaseTag(high), parseReleaseTag(low)), 1);
  assert.equal(compareVersions(parseReleaseTag('0.3.9007199254740993'), parseReleaseTag('0.3.9007199254740992')), 1);
  assert.equal(compareVersions(parseReleaseTag(high), parseReleaseTag(high)), 0);
  for (const order of permutations([low, high, huge, '0.3.0-preview.9'])) {
    assert.equal(resolveChannel(order, 'preview')?.text, huge);
    assert.deepEqual(sorted(order), ['0.3.0-preview.9', low, high, huge]);
  }
  for (const order of permutations([low, high])) assert.equal(resolveChannel(order, 'preview')?.text, high);
  for (const [a, b] of [[low, high], [high, huge], ['0.3.9007199254740992', '0.3.9007199254740993']]) {
    assert.equal(Math.sign(script.compareVersions(script.parseVersion(a), script.parseVersion(b))), Math.sign(compareVersions(parseReleaseTag(a), parseReleaseTag(b))));
  }
});

test('isEligible excludes unparseable input and anything below the 0.2.0 baseline', () => {
  assert.equal(isEligible(undefined), false);
  assert.equal(isEligible(parseReleaseTag('0.1.9')), false);
  assert.equal(isEligible(parseReleaseTag('0.1.0')), false);
  assert.equal(isEligible(parseReleaseTag('0.2.0-preview.5')), false);
  assert.equal(isEligible(parseReleaseTag('0.2.0')), true);
  assert.equal(isEligible(parseReleaseTag('0.2.1-preview.0')), true);
  assert.equal(isEligible(parseReleaseTag('1.0.0')), true);
  assert.equal(channelOf(parseReleaseTag('1.0.0')), 'stable');
  assert.equal(channelOf(parseReleaseTag('1.0.0-preview.1')), 'preview');
});

test('resolveChannel picks the highest eligible version per channel and never falls back', () => {
  const tags = ['v0.3.0-preview.9', 'v0.1.5', 'v0.3.0-rc.1', 'v0.2.0', 'v0.3.0-preview.10', 'junk', 'v0.2.5', 'v0.2.5-preview.3', 'v0.2.0-preview.1'];
  for (const order of [tags, [...tags].reverse()]) {
    assert.equal(resolveChannel(order, 'stable').text, '0.2.5');
    assert.equal(resolveChannel(order, 'preview').text, '0.3.0-preview.10');
  }
  assert.equal(resolveChannel(['v0.2.0', 'v0.1.0'], 'preview'), undefined);
  assert.equal(resolveChannel(['v0.3.0-preview.1', 'v0.1.0'], 'stable'), undefined);
  assert.equal(resolveChannel([], 'stable'), undefined);
  assert.equal(resolveChannel(['v0.1.9', 'main', 'v1.0.0-rc.1'], 'stable'), undefined);
  assert.equal(resolveChannel([parseReleaseTag('0.4.0'), '0.3.0'], 'stable').text, '0.4.0');
});

test('satisfiesEngines handles the package range and operators', () => {
  const range = '>=24.6.0 <25 || >=26.4.0 <27';
  const cases = [['24.6.0', true], ['24.13.1', true], ['24.5.9', false], ['25.0.0', false], ['25.9.9', false], ['26.3.9', false], ['26.4.0', true], ['26.9.0', true], ['27.0.0', false], ['v26.9.0', true]];
  for (const [node, expected] of cases) assert.equal(satisfiesEngines(range, node), expected, node);
  assert.equal(satisfiesEngines('>24', '24.9.9'), false);
  assert.equal(satisfiesEngines('>24', '25.0.0'), true);
  assert.equal(satisfiesEngines('>24.1.0', '24.1.0'), false);
  assert.equal(satisfiesEngines('>24.1.0', '24.1.1'), true);
  assert.equal(satisfiesEngines('<=24', '24.99.0'), true);
  assert.equal(satisfiesEngines('<=24', '25.0.0'), false);
  assert.equal(satisfiesEngines('<=24.1.0', '24.1.1'), false);
  assert.equal(satisfiesEngines('<24.2', '24.1.9'), true);
  assert.equal(satisfiesEngines('<24.2', '24.2.0'), false);
  assert.equal(satisfiesEngines('=24', '24.5.0'), true);
  assert.equal(satisfiesEngines('24', '25.0.0'), false);
  assert.equal(satisfiesEngines('24.1', '24.1.7'), true);
  assert.equal(satisfiesEngines('24.1', '24.2.0'), false);
  assert.equal(satisfiesEngines('=24.1.2', '24.1.2'), true);
  assert.equal(satisfiesEngines('>= 24.6.0 < 25', '24.7.0'), true);
  assert.equal(satisfiesEngines('>=24', '23.9.9'), false);
});

test('satisfiesEngines reports unparseable ranges or Node versions as undefined', () => {
  for (const range of ['', '   ', '^24.0.0', '~24', '*', 'x', '>=24 ||', '|| >=24', '>=abc', '>=24.6.0-beta', 'latest', '>=1.2.3.4']) {
    assert.equal(satisfiesEngines(range, '24.7.0'), undefined, JSON.stringify(range));
  }
  for (const node of ['', 'abc', '24', '24.7', '24.7.0-nightly']) assert.equal(satisfiesEngines('>=24', node), undefined, JSON.stringify(node));
});

const CHANGELOG = [
  '# Changelog', '', 'preamble', '',
  '## [0.3.0] - 2026-11-20', '', 'Estable', '', '### Funcionalidades', '- **x:** algo (`abc1234`)', '',
  '## [0.3.0-preview.1] - 2026-11-10', '', 'Preview', '',
  '## [0.2.0] - 2026-10-30', '', 'Baseline', '',
].join('\n');

test('changelogSection returns exactly one bounded section', () => {
  const stable = changelogSection(CHANGELOG, '0.3.0');
  assert.match(stable, /^## \[0\.3\.0\] - 2026-11-20\n/);
  assert.match(stable, /algo/);
  assert.doesNotMatch(stable, /preview\.1|Baseline/);
  assert.equal(changelogSection(CHANGELOG, 'v0.3.0-preview.1'), '## [0.3.0-preview.1] - 2026-11-10\n\nPreview');
  assert.equal(changelogSection(CHANGELOG, '0.2.0'), '## [0.2.0] - 2026-10-30\n\nBaseline');
});

test('changelogSection is undefined for missing sections and invalid versions, and handles CRLF', () => {
  assert.equal(changelogSection(CHANGELOG, '0.4.0'), undefined);
  assert.equal(changelogSection(CHANGELOG, '0.3'), undefined);
  assert.equal(changelogSection(CHANGELOG, 'main'), undefined);
  assert.equal(changelogSection('', '0.2.0'), undefined);
  assert.equal(changelogSection('## [0.2.0-preview.1]\nx', '0.2.0'), undefined);
  assert.equal(changelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.2.0'), '## [0.2.0] - 2026-10-30\n\nBaseline');
  assert.equal(changelogSection('## [0.2.0]\nlast line without newline', '0.2.0'), '## [0.2.0]\nlast line without newline');
});

test('changelogSection caps an oversized section at 16 KiB and flags the cut', () => {
  const big = `## [0.5.0] - 2026-12-01\n\n${'x'.repeat(CHANGELOG_SECTION_MAX * 3)}\n\n## [0.4.0] - 2026-11-01\n\nold\n`;
  const section = changelogSection(big, '0.5.0');
  assert.ok(section.length < CHANGELOG_SECTION_MAX + 100);
  assert.ok(section.startsWith('## [0.5.0]'));
  assert.match(section, /notas truncadas/);
  assert.doesNotMatch(section, /old/);
  assert.equal(CHANGELOG_SECTION_MAX, 16384);
});

test('parity: src/versions.ts and scripts/release.mjs share baseline, grammar and order (DD4)', () => {
  assert.deepEqual({ ...script.BASELINE }, { ...BASELINE });
  const scriptText = readFileSync(fileURLToPath(new URL('../scripts/release.mjs', import.meta.url)), 'utf8');
  const declared = /^const GRAMMAR = (\/.*\/);?$/m.exec(scriptText);
  assert.ok(declared, 'GRAMMAR declaration found in scripts/release.mjs');
  assert.equal(declared[1], String(RELEASE_GRAMMAR));

  const corpus = [...VALID, ...INVALID, 'v0.2.0-preview.1', '0.1.0', '2.0.0-preview.2', '0.2.10', '0.2.9', '0.3.0-preview.3', '0.3.0-preview.20'];
  for (const text of corpus) {
    assert.deepEqual(parseReleaseTag(text), script.parseVersion(text), JSON.stringify(text));
  }
  const parsed = corpus.map(parseReleaseTag).filter(Boolean);
  for (const a of parsed) {
    for (const b of parsed) {
      assert.equal(Math.sign(compareVersions(a, b)), Math.sign(script.compareVersions(a, b)), `${a.text} vs ${b.text}`);
    }
  }
  const baseline = script.parseVersion(script.BASELINE.version);
  for (const version of parsed) {
    assert.equal(isEligible(version), script.compareVersions(version, baseline) >= 0, version.text);
  }
});
