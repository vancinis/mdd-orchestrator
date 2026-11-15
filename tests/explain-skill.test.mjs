import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const DIR = 'assets/opencode/skills/mdd-explain';
const bytes = path => fs.readFileSync(new URL(`../${DIR}/${path}`, import.meta.url));
const read = path => bytes(path).toString('utf8');

const skill = read('SKILL.md');
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill);
const body = skill.slice(frontmatter?.[0].length ?? 0);
const template = read('assets/template.html');
const reference = read('references/authoring.md');

test('SKILL.md has complete single-line frontmatter and a bounded body', () => {
  assert.ok(frontmatter, 'frontmatter block');
  const meta = frontmatter[1];
  assert.match(meta, /^name: mdd-explain$/m);
  assert.match(meta, /^license: MIT$/m);
  assert.match(meta, /^ {2}author: "mdd-maintainers"$/m);
  assert.match(meta, /^ {2}version: "1\.0"$/m);
  const description = /^description: "(Trigger: [^"\n]*)"$/m.exec(meta);
  assert.ok(description, 'quoted single-line description starting with Trigger:');
  assert.ok(description[1].length <= 250, `description length ${description[1].length}`);
  assert.ok(body.length <= 4000, `body length ${body.length}`);
});

test('SKILL.md keeps the style-guide section order', () => {
  const order = ['Activation Contract', 'Hard Rules', 'Decision Gates', 'Execution Steps', 'Output Contract', 'References'];
  const found = [...body.matchAll(/^## (.+)$/gm)].map(m => m[1]);
  assert.deepEqual(found, order);
});

test('SKILL.md states the caller/writer handoff, paths and limits', () => {
  for (const token of [
    'general', '.mdd/artifacts/<topic>/index.html', '.mdd/runs/<run-id>/artifacts/<topic>/index.html',
    '.mdd/runs/<run-id>.md', '-2', 'replace', 'Observado', 'Propuesto', 'Supuesto',
    'git rev-parse', 'assets/template.html', 'delegated: no', 'symlink', 'Spanish',
  ]) assert.ok(skill.includes(token), `SKILL.md mentions ${token}`);
  assert.match(skill, /never delegates again/i);
  assert.match(skill, /Overwrite nothing else/);
  assert.match(skill, /Never edit sources, run files/);
  assert.match(skill, /names that run or clearly means it/);
  assert.match(skill, /rechecks the target right before writing/);
  assert.match(skill, /never write through one/);
  assert.match(skill, /`href` is `#id` or an `https:\/\/` URL you confirmed this session/);
  assert.match(skill, /Existence alone is not enough/);
  assert.match(skill, /verified correction/);
  assert.match(reference, /never invent history/);
  assert.match(reference, /CSP `http-equiv` is fine/);
});

test('SKILL.md references resolve to local files', () => {
  const links = [...skill.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
  assert.ok(links.length >= 2);
  for (const link of links) {
    assert.ok(!/^[a-z]+:/i.test(link), `local link ${link}`);
    assert.ok(fs.existsSync(new URL(`../${DIR}/${link}`, import.meta.url)), `${link} exists`);
  }
});

test('the reference documents the handoff fields, modes and self-check', () => {
  for (const field of ['skill:', 'question:', 'mode:', 'audience:', 'root:', 'output:', 'replace:', 'run:', 'leads:', 'date:']) {
    assert.ok(reference.includes(field), `handoff field ${field}`);
  }
  for (const mode of ['actual', 'propuesta', 'antes-despues']) assert.ok(reference.includes(`\`${mode}\``));
  assert.match(reference, /git show <rev>:<path>/);
});

test('the template is a small offline UTF-8 LF file', () => {
  const raw = bytes('assets/template.html');
  assert.ok(raw.length <= 16384, `size ${raw.length}`);
  assert.notDeepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no BOM');
  assert.ok(!template.includes('\r'), 'LF line endings');
  assert.ok(template.endsWith('\n'));
  assert.doesNotMatch(template, /\uFFFD|Ã³|Ã©|Â¿|â€”/);
});

test('the template has no scripts, links or remote resources', () => {
  assert.ok(template.includes(`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">`));
  assert.doesNotMatch(template, /<(?:script|link|iframe|object|embed)\b/i);
  assert.doesNotMatch(template, /@import|https?:\/\//i);
  for (const m of template.matchAll(/\b(?:href|src)\s*=\s*["']?([^"'\s>]*)/gi)) assert.match(m[1], /^(?:#|data:|\{\{VERIFIED_HTTPS_URL\}\}$)/);
  for (const m of template.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g)) assert.match(m[0], /rel="[^"]*\bnoopener\b[^"]*\bnoreferrer\b[^"]*"/);
  assert.doesNotMatch(template, /javascript:|\bping\s*=|<base\b|http-equiv="refresh"/i);
  for (const m of template.matchAll(/url\(\s*["']?([^"')\s]*)/gi)) assert.match(m[1], /^(?:#|data:)/);
});

test('the template has semantic structure, accessible SVG and Spanish defaults', () => {
  assert.match(template, /^<!doctype html>/i);
  assert.match(template, /<html lang="es">/);
  for (const tag of ['<header', '<nav aria-label="Contenido"', '<main', '<details', '<figure', '<footer']) {
    assert.ok(template.includes(tag), tag);
  }
  assert.match(template, /<svg\b[^>]*role="img"[\s\S]*?<title\b[\s\S]*?<desc\b/);
  for (const id of ['pasos', 'resumen', 'diagrama', 'escenario', 'comparacion', 'detalles', 'incertidumbre', 'fuentes']) {
    assert.ok(template.includes(`id="${id}"`), `#${id}`);
    assert.ok(template.includes(`href="#${id}"`), `nav link to #${id}`);
  }
  for (const label of ['Observado', 'Propuesto', 'Supuesto', 'Fecha', 'Revisión', 'Cambios sin confirmar', 'Ejecución', 'Modo', 'Para']) {
    assert.ok(template.includes(label), label);
  }
  assert.match(template, /\{\{[A-Z0-9_]+\}\}/);
  assert.match(template, /:focus-visible/);
});

// Phone geometry for the one reviewed template layout; this is not a CSS engine. A template is
// supported only if it equals the reviewed template (blob 7dad2f4 from commit 48fabce) except for
// the numeric px `figure svg` max-width: SUPPORTED_LAYOUT is the SHA-256 of that file with only
// that number replaced by `<CAP>`. Any other change (selectors, body font or padding, wrappers,
// inline styles, media rules, SVG attributes) fails as `unsupported layout` instead of being
// ignored. The fixed model of that layout: 390px phone, 1rem body padding per side, main capped at
// 72ch (at least 576px, so it never binds), figure without side margin, border-box SVG with
// width 100% and a 1px border on each side, so labels render at font-size * content / viewBox.
// To change the layout, first review the new geometry against this model and update the model
// and the expected numbers below; only then copy the fingerprint that the unsupported-layout
// message reports for the reviewed file into SUPPORTED_LAYOUT. Never accept it from a mutant.
const PHONE = 390, BODY_PADDING = 2 * 16, MAIN_MIN = 72 * 8, SVG_BORDERS = 2 * 1;
const SUPPORTED_LAYOUT = '09199c26a77203ef142734f94e57d9076b4f31e5b37fb635b2b77c82df358591';
const SVG_CAP = /^(  figure svg \{ display: block; width: 100%; max-width: )(\d{1,4}(?:\.\d{1,4})?)px;/gm;

function phoneGeometry(html) {
  const caps = [...html.matchAll(SVG_CAP)];
  assert.equal(caps.length, 1, 'unsupported layout: exactly one numeric px figure svg max-width expected');
  const fingerprint = createHash('sha256').update(html.replace(SVG_CAP, (_, prefix) => `${prefix}<CAP>;`)).digest('hex');
  assert.equal(fingerprint, SUPPORTED_LAYOUT, `unsupported layout: only the figure svg px cap may differ from the reviewed template (fingerprint ${fingerprint})`);
  const viewBox = /<svg viewBox="0 0 (\d+) (\d+)"/.exec(html);
  const available = Math.min(PHONE - BODY_PADDING, MAIN_MIN);
  const contentWidth = Math.min(available, Number(caps[0][2])) - SVG_BORDERS; // border-box cap
  const [viewBoxWidth, viewBoxHeight] = [Number(viewBox[1]), Number(viewBox[2])];
  const scale = contentWidth / viewBoxWidth; // height: auto keeps the viewBox ratio
  const labels = [...html.matchAll(/<text\b[^>]*\bfont-size="(\d+)"/g)].map(([, size]) => ({ size: Number(size), rendered: Number(size) * scale }));
  assert.equal(labels.length, 3, 'the reviewed diagram has three labels');
  return { available, contentWidth, viewBoxWidth, viewBoxHeight, scale, labels };
}

function assertReadableOnPhone(html) {
  const g = phoneGeometry(html);
  for (const { size, rendered } of g.labels) {
    assert.ok(rendered >= 14, `font-size ${size} renders below 14px: ${rendered.toFixed(2)}px at ${PHONE}px (SVG content ${g.contentWidth}px for viewBox width ${g.viewBoxWidth})`);
  }
  return g;
}

test('the template diagram is a narrow vertical flow that stays readable on phones', () => {
  const g = assertReadableOnPhone(template);
  assert.ok(g.viewBoxWidth <= 400 && g.viewBoxHeight >= g.viewBoxWidth * 0.5, `viewBox ${g.viewBoxWidth}x${g.viewBoxHeight} is narrow and vertical`);
  assert.equal(g.available, 358, '390px minus 1rem body padding on each side');
  assert.equal(g.contentWidth, 356, 'min(358, 360px cap) minus two 1px borders');
  for (const { rendered } of g.labels) assert.ok(Math.abs(rendered - 16 * 356 / 360) < 1e-9, `label ${rendered}px`);
  assert.match(reference, /rendered size/);
  assert.match(reference, /actual content width/);
});

test('the phone readability check rejects a 100px SVG cap', () => {
  const cap = /(figure svg\s*\{[^}]*max-width:\s*)360px/g;
  assert.equal([...template.matchAll(cap)].length, 1, 'the cap appears exactly once');
  const mutant = template.replace(cap, (_, prefix) => `${prefix}100px`);
  assert.ok(!template.includes('max-width: 100px'));
  assert.equal(mutant.replace('max-width: 100px', 'max-width: 360px'), template, 'only the cap changed');
  const g = phoneGeometry(mutant);
  assert.equal(g.contentWidth, 98);
  for (const { rendered } of g.labels) assert.ok(rendered < 14 && Math.abs(rendered - 16 * 98 / 360) < 1e-9, `label ${rendered}px`);
  assert.throws(() => assertReadableOnPhone(mutant), /font-size 16 renders below 14px/);
});

test('the phone readability check rejects every layout change except the modeled SVG cap', () => {
  const mutate = (...pairs) => pairs.reduce((html, [from, to]) => {
    assert.equal(html.split(from).length, 2, `one occurrence of ${from}`);
    return html.replace(from, to);
  }, template);
  for (const [name, html, reason = /unsupported layout: only the figure svg px cap may differ/] of [
    ['ancestor attribute cap', mutate(['</style>', '  [id="diagrama"] { max-width: 100px; }\n</style>'])],
    ['section rule', mutate(['  figure { margin', '  section { padding: 0 6rem; }\n  figure { margin'])],
    ['body padding', mutate(['padding: 1.5rem 1rem 3rem;', 'padding: 1.5rem 6rem 3rem;'])],
    ['body font', mutate(['font: 16px/1.6', 'font: 10px/1.6'])],
    ['root font', mutate(['color-scheme: light;', 'color-scheme: light; font-size: 10px;'])],
    ['phone media rule', mutate(['dl { grid-template-columns: 1fr; } }', 'dl { grid-template-columns: 1fr; } figure { margin: 0 6rem; } }'])],
    ['inline style', mutate(['<section id="diagrama">', '<section id="diagrama" style="max-width: 100px">'])],
    ['wrapper', mutate(['<figure>', '<div class="compare"><figure>'], ['</figure>', '</figure></div>'])],
    ['svg width attribute', mutate(['<svg viewBox=', '<svg width="80" viewBox='])],
    ['wider viewBox', mutate(['viewBox="0 0 360 230"', 'viewBox="0 0 1440 230"'])],
    ['second svg cap', mutate(['</style>', '  figure svg { max-width: 100px; }\n</style>'])],
    ['percent cap', mutate(['max-width: 360px', 'max-width: 50%']), /unsupported layout: exactly one numeric px/],
    ['duplicated cap line', mutate(['  figcaption', template.match(SVG_CAP)[0] + ' }\n  figcaption']), /unsupported layout: exactly one numeric px/],
  ]) assert.throws(() => assertReadableOnPhone(html), reason, name);
});

test('the skill states plain-language, action-guide and link contracts', () => {
  assert.match(skill, /Assume no specialist\s+knowledge/);
  assert.match(skill, /everyday meaning before any identifier/);
  assert.match(skill, /short direct sentences/);
  assert.match(skill, /Research commands are read-only/);
  assert.match(skill, /first action on top; each step gives where, action, visible success and next or stop/);
  assert.match(skill, /No step list/);
  assert.match(skill, /Handoff has `style:`/);
  assert.match(skill, /`target="_blank"` needs `rel="noopener noreferrer"`/);
  assert.match(skill, /Never use credentials in URLs/);
  assert.match(skill, /page reads fully offline/);
  assert.match(skill, /Load nothing remote/);
  assert.match(skill, /links verified/);
  assert.match(skill, /Overwrite nothing else/);
  assert.match(skill, /never delegates again/);
});

const row = (text, name) => {
  const found = text.split('\n').filter(line => line.startsWith(`| ${name} |`));
  assert.equal(found.length, 1, `one table row ${name}`);
  return found[0];
};

test('initialization is a caller-only exception for a new .mdd and keeps existing ignore files', () => {
  assert.match(skill, /sole exception: the caller creates a new `\.mdd\/` with `\.mdd\/\.gitignore` \(`\*`\) before dispatch/);
  assert.match(skill, /1\. \*\*Caller:\*\*[^\n]*Initialize `\.mdd\/` only if new/);
  for (const line of skill.split('\n').filter(l => /\*\*Writer:\*\*/.test(l))) assert.doesNotMatch(line, /gitignore|[Ii]nitiali[sz]e/, line);
  assert.match(skill, /\| No subagent tool \| Do both roles; say so \|/);
  assert.match(skill, /Only a run owner may add one Log line/);

  const caller = row(reference, 'Caller');
  assert.match(caller, /Only when `\.mdd\/` does not exist yet: `\.mdd\/` and `\.mdd\/\.gitignore` containing `\*`/);
  assert.match(caller, /before dispatch/);
  assert.match(caller, /sole exception to the HTML-only rule/);
  assert.match(caller, /Recreate an absent ignore file or change any existing one when `\.mdd\/` already exists/);
  assert.match(caller, /create a run/);
  const writer = row(reference, 'Writer');
  assert.match(writer, /The selected HTML file and the child directories it needs/);
  assert.match(writer, /\| Create or change `\.mdd\/\.gitignore`, run files, sources or configuration; delegate again\. \|/);
  const owner = row(reference, 'Run owner');
  assert.match(owner, /One optional Log line in its own run file/);
  assert.match(owner, /Grant that edit to the writer/);

  assert.match(reference, /neither role creates one/);
  assert.match(reference, /writer that finds `\.mdd\/` missing or uninitialized stops and reports it to the caller; it does not\s+initialize anything itself/);
  assert.match(reference, /Without a subagent tool, the caller initializes first, then writes under the same writer limits/);
  assert.match(reference, /initialization is denied or any existing component is a symlink, stop without writing/);
  assert.match(reference, /4\. Caller only: if `\.mdd\/` is new, create it with `\.mdd\/\.gitignore` containing `\*` before dispatch[\s\S]*?If `\.mdd\/` exists, leave it and every ignore file as they are/);
  assert.ok(reference.indexOf('3. Inspect every existing component') < reference.indexOf('4. Caller only:'), 'components are inspected before initialization');
  assert.doesNotMatch(reference, /^\d\. If `\.mdd\/` is new, create/m, 'no unattributed initialization step');
});

test('the target is a fresh path, an approved exact replacement or a same-request repair', () => {
  assert.match(skill, /Fresh output takes a free `<topic>`, `<topic>-2`, `-3`/);
  assert.match(skill, /`replace: yes` keeps the exact file the user\s+asked to replace/);
  assert.match(skill, /a fix edits this request's own output/);
  assert.match(skill, /send the findings and path to the same writer/);
  assert.match(skill, /\| Unclear consent, ownership or setup \| Stop; report it \|/);

  assert.doesNotMatch(reference, /output: <relative path that does not exist>/);
  assert.match(reference, /^output: <relative target path: free for fresh output, or the exact approved file when replace: yes>$/m);
  assert.match(reference, /^replace: no \| yes$/m);

  const fresh = row(reference, 'Fresh output');
  assert.match(fresh, /Default \(`replace: no`\)/);
  assert.match(fresh, /first free path among `<topic>`, `<topic>-2`, `-3`/);
  assert.match(fresh, /If the recheck finds it taken, move to the next free one/);
  assert.match(fresh, /Report the path actually written/);
  assert.match(fresh, /Never overwrite an existing file/);
  const replacement = row(reference, 'Approved replacement');
  assert.match(replacement, /`replace: yes`: the user explicitly asked to replace that exact file/);
  assert.match(replacement, /That exact path, kept even if it is now absent; never add a suffix/);
  assert.match(replacement, /Grants nothing over sibling or other files/);
  const repair = row(reference, 'Repair');
  assert.match(repair, /findings about this request's output to the same writer/);
  assert.match(repair, /the file the caller wrote for it\), edited in place without renaming or new consent/);
  assert.match(repair, /Only that file\. If its origin cannot be traced to this request, or it changed outside this request, stop and report/);

  assert.match(reference, /Recheck the target and its components immediately before every write,\s+including a replacement or a repair/);
  const denied = /Missing or ambiguous consent, another request's artifact, uncertain ownership, a symlink, a read\s+error or a denied write is never permission to replace: stop and report the gap/;
  assert.match(reference, denied);
  assert.match(reference, /same writer session with the exact output path; it fixes only the file it wrote for this request \(a repair, see Path\), in place, without a new name or new consent/);
});

test('the reference gives checkable plain-language, step, link and review rules', () => {
  for (const token of ['style:', '## Plain language', '## Action guides', '## Links', '## Reader review']) {
    assert.ok(reference.includes(token), token);
  }
  assert.match(reference, /no specialist knowledge/);
  assert.match(reference, /everyday meaning/);
  assert.match(reference, /\*\*where\*\*[\s\S]*\*\*what\*\*[\s\S]*\*\*success signal\*\*[\s\S]*\*\*next\*\*/);
  assert.match(reference, /pure explanation[\s\S]*keep `#pasos` out/);
  assert.match(reference, /Do not invent a step/);
  assert.match(reference, /`javascript:`/);
  assert.match(reference, /noopener[\s\S]*noreferrer/);
  assert.match(reference, /connection and may need access/);
  assert.match(reference, /403, 404 or no access/);
  assert.match(reference, /with every `<details>` closed/);
  assert.match(reference, /same writer session/);
  assert.match(reference, /research is read-only; writing or revising the artifact is allowed/);
});

test('the template has an optional step block with the four fields and plain labels', () => {
  const steps = /<section id="pasos">([\s\S]*?)<\/section>/.exec(template);
  assert.ok(steps, '#pasos section');
  for (const label of ['Primer paso', 'Dónde', 'Qué hacer', 'Listo cuando', 'Después']) assert.ok(steps[1].includes(label), label);
  assert.match(steps[1], /<ol class="steps">/);
  assert.ok(steps[1].indexOf('Listo cuando') < steps[1].indexOf('<details>'), 'success signal is outside details');
  assert.ok(template.indexOf('id="pasos"') < template.indexOf('id="resumen"'), 'steps come before theory');
  assert.match(template, /connection|conexión/);
});

test('generic instructions hardcode no project or platform terms', () => {
  for (const [name, text] of [['SKILL.md', skill], ['authoring.md', reference], ['template.html', template]]) {
    assert.doesNotMatch(text, /payins|\baws\b|github|gitlab|azure|bitbucket/i, name);
  }
});
