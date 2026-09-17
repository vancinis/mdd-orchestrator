export const POLICY_VERSION = 'mdd-routing-v1';

export type Answers = {
  certainty: 'very-sure' | 'somewhat-sure' | 'not-sure';
  artifactStore: 'engram' | 'openspec' | 'both' | 'none';
  mode: 'interactive' | 'automatic';
  summary: 'detailed' | 'medium' | 'low';
  complexity: 'very-complex' | 'somewhat-complex' | 'not-complex';
};

export type ScoredField = Exclude<keyof Answers, 'artifactStore'>;
export type Weights = { [Field in ScoredField]: Record<Answers[Field], number> };
export type Config = { threshold: number; weights: Weights };
export type Phase =
  | 'mdd-explore' | 'mdd-plan' | 'mdd-propose' | 'mdd-spec'
  | 'mdd-design' | 'mdd-tasks' | 'mdd-apply' | 'mdd-verify';

export function getDefaultConfig(): Config {
  return {
    threshold: 50,
    weights: {
      certainty: { 'very-sure': 10, 'somewhat-sure': 15, 'not-sure': 25 },
      mode: { interactive: 15, automatic: 5 },
      summary: { detailed: 25, medium: 10, low: 5 },
      complexity: { 'very-complex': 25, 'somewhat-complex': 10, 'not-complex': 0 },
    },
  };
}
