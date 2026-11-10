import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';

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
  assert.match(skill, /Never overwrite/);
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

test('the template diagram is a narrow vertical flow that stays readable on phones', () => {
  const svg = /<svg\b[^>]*viewBox="0 0 (\d+) (\d+)"/.exec(template);
  assert.ok(svg, 'svg viewBox');
  const [width, height] = [Number(svg[1]), Number(svg[2])];
  assert.ok(width <= 400 && height >= width * 0.5, `viewBox ${width}x${height} is narrow and vertical`);
  assert.match(template, /figure svg \{[^}]*max-width: \d+px/);
  const sizes = [...template.matchAll(/<text\b[^>]*font-size="(\d+)"/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 0);
  // A 390px viewport leaves about 358px for the SVG, so the scale is at most 358 / width.
  for (const size of sizes) assert.ok(size * Math.min(1, 358 / width) >= 14, `font-size ${size} renders below 14px`);
  assert.match(reference, /rendered size/);
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
  assert.match(skill, /Never overwrite/);
  assert.match(skill, /never delegates again/);
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
