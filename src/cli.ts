#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { evaluate } from './kernel.js';
import { ValidationError } from './validation.js';
import { settingsCommand } from './settings-cli.js';

const usage = `MDD global setup and routing proof
Proof flags are a dry run; no phases are executed by the CLI.

Usage:
  mdd-ai                      open the install/update wizard
  mdd-ai link                 put mdd-ai on your user PATH
  mdd-ai config | doctor | init | update
  mdd-ai profile list | create <name> | use <name>
  mdd-ai telemetry status | report | on | off | clear
  node dist/cli.js --answers <file.json> [--config <file.json>] [--explore]
  node dist/cli.js --profile <file.json> [--config <file.json>] [--explore]
  node dist/cli.js --help

The global command is installed as mdd-ai; the same commands work through
node dist/cli.js from a source checkout. Setup offers to add its folder to
your user PATH, and never edits the machine PATH.

Setup: one interactive install/configure/check flow; optional Engram; explicit Apply.
Update: replaces an outdated owned package and its assets after the same explicit Apply.
Source checkout: npm run setup (offers missing dependencies/build before the wizard).
Project settings: config opens an advanced terminal editor; Save is explicit, Cancel writes nothing.
Named profiles live in mdd.config.json, separate from the proof's --profile file.
Model/profile changes require native runtime restart. Missing models inherit native selection.
Telemetry is local-only, enabled by default, with 30-day retention on API use.
Telemetry report reads the workspace ledger: phase time, retries, failures and tokens.

Answers: all five preflight fields. Profile: { "answers": { ... } }.
Config: optional threshold and partial weight overrides. See docs/product-contract.md.
Use exactly one source. Paths are relative to the current working directory.
Exit codes: 0 success/help; 2 usage, JSON, or validation error; 1 file I/O or unexpected failure.
`;

function parseArguments(args: string[]): Record<string, unknown> {
  const paths = new Map<string, string>();
  let explore = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--explore') {
      if (explore) throw new ValidationError('Duplicate option: --explore.');
      explore = true;
      continue;
    }
    if (flag !== '--answers' && flag !== '--profile' && flag !== '--config') {
      throw new ValidationError(`Unknown option: ${flag}. Run with --help for usage.`);
    }
    if (paths.has(flag)) throw new ValidationError(`Duplicate option: ${flag}.`);
    const path = args[++index];
    if (!path || path.startsWith('--')) throw new ValidationError(`${flag} requires a JSON file path.`);
    paths.set(flag, path);
  }
  if (paths.has('--answers') === paths.has('--profile')) {
    throw new ValidationError('Supply exactly one of --answers or --profile.');
  }
  const request: Record<string, unknown> = { explore };
  for (const [flag, path] of paths) {
    const text = readFileSync(path, 'utf8');
    try {
      request[flag.slice(2)] = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      throw new ValidationError(`${flag} file "${path}" contains malformed JSON. Use valid UTF-8 JSON.`);
    }
  }
  return request;
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage);
  } else if (!await settingsCommand(args, process.cwd(), text => { process.stdout.write(text); })) {
    const result = evaluate(parseArguments(args));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unexpected failure.';
  process.stderr.write(`MDD error: ${message}\n`);
  process.exitCode = error instanceof ValidationError ? 2 : 1;
}
