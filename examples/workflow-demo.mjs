import { Workflow } from '../dist/workflow.js';

console.log('Simulation only: no models, dispatch, or independent verification.');
for (const mode of ['automatic', 'interactive']) {
  const workflow = new Workflow({ answers: {
    certainty: 'very-sure', artifactStore: 'none', mode,
    summary: 'low', complexity: 'not-complex',
  } });
  console.log(`\n${mode}`);
  while (true) {
    const action = workflow.nextAction();
    console.log(JSON.stringify(action));
    if (action.kind === 'finished' || action.kind === 'blocked') break;
    if (action.kind === 'approve') {
      console.log(`Simulated explicit approval: ${action.phase}`);
      workflow.approve(action.phase);
    } else if (action.kind === 'execute') {
      workflow.start(action.phase);
    } else {
      workflow.recordResult({ phase: action.phase, outcome: 'passed', evidenceSummary: 'Simulated pass.' });
    }
  }
}
