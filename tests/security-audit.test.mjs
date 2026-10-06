import assert from 'node:assert/strict';
import { test } from 'node:test';
import { securityAuditRequest } from '../dist/security-audit.js';

for (const text of ['mdd-security', 'Run mdd-security', 'Please run a security audit of my changes.',
  'Hacé una revisión de seguridad de la implementación.', 'lanza el agente de seguridad',
  'usa mdd-security', 'No hay errores conocidos; hacé una revisión de seguridad.',
  'No hay errores conocidos, hacé una revisión de seguridad.',
  'Quiero que hagamos una revisión de seguridad', 'Can you run a security audit?',
  'Please run mdd-security baseRef=main', 'usa mdd-security baseRef=main']) {
  test(`explicit audit request: ${text}`, () => assert.equal(securityAuditRequest(text), true));
}
for (const text of ['Implement a new mdd-security agent.', 'Configure mdd-security',
  'Explain security audit', 'No ejecutes mdd-security', 'Do not run mdd-security',
  'The docs say "run mdd-security".', '> run mdd-security', '`mdd-security`',
  'Create an agent that runs a security audit.', '¿Qué es una revisión de seguridad?',
  'If I say run mdd-security, what happens?', 'A security audit would be useful.',
  'Example request:\nrun mdd-security', 'Run mdd-security means launching an actor.',
  'Security audit of changes is an example command.', 'Implement the actor; run mdd-security is its alias.',
  'Security audit of changes is our feature title', 'The command is; run mdd-security',
  'The documented usage is:\nrun mdd-security', 'Do not run an audit; run mdd-security is only its alias.',
  'Run mdd-security "this is only a description"', '"Do not" run mdd-security',
  'Run mdd-security; explain the agent.', 'run mdd-security is only its alias',
  'mdd-security?', 'Run mdd-security baseRef="HEAD"', 'Run mdd-security > run mdd-security']) {
  test(`mention is not audit consent: ${text}`, () => assert.equal(securityAuditRequest(text), false));
}
