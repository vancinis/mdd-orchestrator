import { objectWithKeys } from './validation.js';
import { shortText } from './acceptance.js';

export const CHANGE_CATEGORIES = ['objective', 'integrations', 'sensitive-data', 'permissions'] as const;
export type Concern = { category: typeof CHANGE_CATEGORIES[number]; evidence: string; impact: string };
export function concerns(value: unknown): Concern[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error('Supply at most eight advisory concerns.');
  return value.map(value => {
    const item = objectWithKeys(value, 'concern', ['category', 'evidence', 'impact']);
    if (!CHANGE_CATEGORIES.includes(item.category as Concern['category'])) throw new Error('Unknown material-change category.');
    return { category: item.category as Concern['category'], evidence: shortText(item.evidence, 'concern evidence'), impact: shortText(item.impact, 'concern impact') };
  });
}
