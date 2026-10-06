import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { MDD_ASSETS, MDD_PACKAGED_ASSETS } from '../dist/project-assets.js';

test('package dry-run includes runnable build and exact owned assets without private runtime data', () => {
  const output = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32' ? ['/d', '/s', '/c', 'npm pack --dry-run --json --ignore-scripts'] : ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, npm_config_update_notifier: 'false' },
  });
  assert.equal(output.status, 0, output.stderr);
  const files = JSON.parse(output.stdout)[0].files.map(file => file.path);
  for (const role of ['mdd-jd-judge-a', 'mdd-jd-judge-b', 'mdd-jd-fix']) {
    const file = `assets/opencode/agents/${role}.md`;
    assert.ok(MDD_ASSETS.includes(file), file);
    assert.ok(files.includes(file), file);
  }
  for (const suffix of ['SKILL.md', 'references/prompts-and-formats.md']) {
    const file = `assets/opencode/skills/mdd-judgment-day/${suffix}`;
    assert.ok(MDD_ASSETS.includes(file), file); assert.ok(files.includes(file), file);
  }
  const setupScripts = ['scripts/setup.mjs', 'scripts/extract-engram.ps1'];
  for (const file of [...MDD_PACKAGED_ASSETS, ...setupScripts, 'dist/cli.js', 'dist/opencode-plugin.js', 'dist/setup.js', 'dist/setup-ui.js', 'dist/engram-install.js', 'dist/doctor.js', 'package.json', 'README.md']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => file === 'package.json' || file === 'README.md' || MDD_PACKAGED_ASSETS.includes(file) || setupScripts.includes(file) || /^dist\/[^/]+\.(?:js|d\.ts)$/.test(file) || /^docs\/[^/]+\.md$/.test(file) || file === 'docs/mdd-config.schema.json'));
  assert.ok(files.every(file => !/node_modules|\.mdd\/|mdd\.config\.json|\.env|^tests\/|^src\//.test(file)));
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.bin.mdd, 'dist/cli.js'); assert.equal(pkg.exports['./opencode-plugin'], './dist/opencode-plugin.js');
  assert.ok(fs.readFileSync('dist/cli.js', 'utf8').startsWith('#!/usr/bin/env node\n'));
});
